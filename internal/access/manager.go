// Package access runs the REAL "last movement" workload behind the turnstile
// and factory-turnstile demo pages. It queries the pre-existing TIGERMARKET ERP
// database for the most recent stock movement of a random key — the direct
// analogue of a turnstile asking "what was this person's last access event?".
//
// Two modes are executed and measured for real:
//
//   - "baseline": the key is concatenated into the statement text with a unique
//     marker, so every query is a new single-use plan (plan-cache bloat,
//     constant compilations).
//   - "quentra":  the identical lookup, parameterized, so one plan is compiled
//     and reused.
//
// Plan-cache counts, compilations/sec and latency are sampled from SQL Server
// DMVs, so the UI shows measured numbers.
package access

import (
	"context"
	"database/sql"
	"math/rand"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"log/slog"

	_ "github.com/microsoft/go-mssqldb"

	"supermarketsim/internal/config"
)

const (
	workerCount  = 6
	queryTimeout = 8 * time.Second
	feedSize     = 12
)

// MovementEvent is one measured last-movement lookup, shown in the live feed.
type MovementEvent struct {
	Key    int     `json:"key"`
	Mode   string  `json:"mode"`
	Ms     float64 `json:"ms"`
	Ref    int64   `json:"ref"`
	At     int64   `json:"at"`
}

// Metrics is the JSON snapshot served to the turnstile/factory UIs. Real.
type Metrics struct {
	Mode        string `json:"mode"`
	Running     bool   `json:"running"`
	Provisioned bool   `json:"provisioned"`

	QueriesTotal  int64   `json:"queriesTotal"`
	QueriesPerSec float64 `json:"queriesPerSec"`
	AvgMs         float64 `json:"avgMs"`
	LastMs        float64 `json:"lastMs"`
	Errors        int64   `json:"errors"`

	RefAvgMs     float64 `json:"refAvgMs"`
	QuentraAvgMs float64 `json:"quentraAvgMs"`
	RefRuns      int64   `json:"refRuns"`
	QuentraRuns  int64   `json:"quentraRuns"`

	SingleUsePlans     int64   `json:"singleUsePlans"`
	TotalPlans         int64   `json:"totalPlans"`
	PlanCacheMB        float64 `json:"planCacheMB"`
	CompilationsPerSec float64 `json:"compilationsPerSec"`
	BatchPerSec        float64 `json:"batchPerSec"`
	SQLCpuPct          int     `json:"sqlCpuPct"`

	LastKey int   `json:"lastKey"`
	LastRef int64 `json:"lastRef"`

	// Connection proof + the exact SQL each path sends.
	GatewayUp  bool   `json:"gatewayUp"`
	DirectSQL  string `json:"directSql"`
	QuentraSQL string `json:"quentraSql"`

	Recent     []MovementEvent `json:"recent"`
	LastError  string          `json:"lastError"`
	LastSample int64           `json:"lastSample"`
}

// Manager owns the TIGERMARKET pool, the query workers and the sampler.
type Manager struct {
	cfg *config.Config
	log *slog.Logger

	db *sql.DB
	// gw reaches the SAME database through the Quentra gateway (:14330); the
	// quentra path travels this pool. nil when the gateway was unreachable.
	gw *sql.DB

	mode        atomic.Value // "baseline" | "quentra" | "auto"
	running     atomic.Bool
	provisioned atomic.Bool
	gatewayUp   atomic.Bool

	total    atomic.Int64
	errors   atomic.Int64
	latSumNs atomic.Int64
	latCount atomic.Int64
	lastLat  atomic.Int64
	lastKey  atomic.Int64
	lastRef  atomic.Int64

	refSumNs  atomic.Int64
	refCount  atomic.Int64
	quenSumNs atomic.Int64
	quenCount atomic.Int64

	errMu   sync.RWMutex
	lastErr string

	feedMu sync.Mutex
	feed   []MovementEvent

	mu      sync.RWMutex
	metrics Metrics

	cpuPrevMs int64
	cpuPrevAt time.Time

	chMu   sync.Mutex
	stopCh chan struct{}
	wg     sync.WaitGroup
}

// NewManager creates an un-provisioned manager. Call Provision then Start.
func NewManager(cfg *config.Config, log *slog.Logger) *Manager {
	m := &Manager{cfg: cfg, log: log, stopCh: make(chan struct{})}
	m.mode.Store("baseline")
	m.metrics = Metrics{Mode: "baseline"}
	return m
}

func (m *Manager) modeStr() string {
	v, _ := m.mode.Load().(string)
	if v == "" {
		return "baseline"
	}
	return v
}

// SetMode selects the query path. "auto" alternates so both bars move.
func (m *Manager) SetMode(mode string) {
	switch strings.ToLower(mode) {
	case "baseline", "reference", "direct", "temel":
		m.mode.Store("baseline")
	case "quentra":
		m.mode.Store("quentra")
	case "auto":
		m.mode.Store("auto")
	}
}

// State returns the latest snapshot merged with live counters.
func (m *Manager) State() Metrics {
	m.mu.RLock()
	out := m.metrics
	m.mu.RUnlock()
	out.Mode = m.modeStr()
	out.Running = m.running.Load()
	out.Provisioned = m.provisioned.Load()
	out.QueriesTotal = m.total.Load()
	out.Errors = m.errors.Load()
	out.LastKey = int(m.lastKey.Load())
	out.LastRef = m.lastRef.Load()
	key := out.LastKey
	if key == 0 {
		key = keyMin
	}
	out.GatewayUp = m.gatewayUp.Load()
	out.DirectSQL = directDisplaySQL(key)
	out.QuentraSQL = quentraDisplaySQL()
	m.errMu.RLock()
	out.LastError = m.lastErr
	m.errMu.RUnlock()
	m.feedMu.Lock()
	out.Recent = append([]MovementEvent(nil), m.feed...)
	m.feedMu.Unlock()
	return out
}

// Provision opens the pool and verifies the movement table is reachable.
// Nothing is created — the ERP data already exists.
func (m *Manager) Provision(ctx context.Context) error {
	pool, err := sql.Open("sqlserver", m.cfg.DSNFor(DBName, config.AppAccess))
	if err != nil {
		return err
	}
	pool.SetMaxOpenConns(workerCount + 4)
	pool.SetMaxIdleConns(workerCount)
	pool.SetConnMaxLifetime(30 * time.Minute)
	if err := pool.PingContext(ctx); err != nil {
		_ = pool.Close()
		return err
	}
	m.db = pool

	var n int
	if err := m.db.QueryRowContext(ctx,
		`SELECT CASE WHEN OBJECT_ID('`+movementTable+`') IS NULL THEN 0 ELSE 1 END`).Scan(&n); err != nil {
		return err
	}
	if n != 1 {
		return errTableMissing
	}

	// Second pool through the Quentra gateway (:14330). Best-effort.
	if gw, err := sql.Open("sqlserver", m.cfg.QuentraDSNFor(DBName, config.AppAccess)); err == nil {
		gw.SetMaxOpenConns(workerCount + 4)
		gw.SetMaxIdleConns(workerCount)
		gw.SetConnMaxLifetime(30 * time.Minute)
		gctx, gcancel := context.WithTimeout(ctx, 10*time.Second)
		if perr := gw.PingContext(gctx); perr == nil {
			m.gw = gw
			m.gatewayUp.Store(true)
		} else {
			_ = gw.Close()
			m.log.Warn("quentra gateway unreachable; access quentra path uses direct", "error", perr.Error())
		}
		gcancel()
	}

	m.provisioned.Store(true)
	return nil
}

// quentraPool returns the gateway pool for the quentra path, falling back to
// the direct pool when the gateway is down.
func (m *Manager) quentraPool() *sql.DB {
	if m.gw != nil {
		return m.gw
	}
	return m.db
}

type tableMissingErr struct{}

func (tableMissingErr) Error() string { return movementTable + " not found in " + DBName }

var errTableMissing = tableMissingErr{}

// Start launches the workers and sampler. Safe to call after Pause.
func (m *Manager) Start() {
	if !m.provisioned.Load() || m.db == nil {
		return
	}
	if m.running.Swap(true) {
		return
	}
	m.chMu.Lock()
	m.stopCh = make(chan struct{})
	stop := m.stopCh
	m.chMu.Unlock()

	for i := 0; i < workerCount; i++ {
		m.wg.Add(1)
		go m.worker(i, stop)
	}
	m.wg.Add(1)
	go m.sampler(stop)
}

// Pause halts the workers but keeps the pool open.
func (m *Manager) Pause() {
	if !m.running.Swap(false) {
		return
	}
	m.chMu.Lock()
	if m.stopCh != nil {
		close(m.stopCh)
	}
	m.chMu.Unlock()
	m.wg.Wait()
}

// Stop halts the workload and closes both pools. Called on shutdown.
func (m *Manager) Stop() {
	m.Pause()
	if m.gw != nil {
		_ = m.gw.Close()
	}
	if m.db != nil {
		_ = m.db.Close()
	}
}

func (m *Manager) pathFor(iter int) string {
	mode := m.modeStr()
	if mode == "auto" {
		if iter%2 == 0 {
			return "baseline"
		}
		return "quentra"
	}
	return mode
}

func (m *Manager) worker(id int, stop <-chan struct{}) {
	defer m.wg.Done()
	rng := rand.New(rand.NewSource(time.Now().UnixNano() + int64(id)*7919))
	iter := id
	for {
		select {
		case <-stop:
			return
		default:
		}
		iter++

		key := keyMin + rng.Intn(keyMax-keyMin+1)
		path := m.pathFor(iter)

		ctx, cancel := context.WithTimeout(context.Background(), queryTimeout)
		start := time.Now()
		var (
			ref            int64
			date           sql.NullTime
			amount, price  sql.NullFloat64
			trcode         sql.NullInt64
			err            error
		)
		if path == "quentra" {
			// Parameterized lookup routed through the Quentra gateway (:14330).
			err = m.quentraPool().QueryRowContext(ctx, quentraSQL, sql.Named("key", key)).
				Scan(&ref, &date, &amount, &price, &trcode)
		} else {
			// Ad-hoc concatenated lookup straight to SQL Server.
			err = m.db.QueryRowContext(ctx, baselineSQL(key, time.Now().UnixNano())).
				Scan(&ref, &date, &amount, &price, &trcode)
		}
		dur := time.Since(start)
		cancel()

		// No row for this key is not an error — it just means "no movement".
		if err == sql.ErrNoRows {
			err = nil
			ref = 0
		}
		if err != nil {
			m.errors.Add(1)
			m.errMu.Lock()
			m.lastErr = err.Error()
			m.errMu.Unlock()
			if n := m.errors.Load(); n == 1 || n%50 == 0 {
				m.log.Warn("access query failed", "count", n, "path", path, "error", err.Error())
			}
			m.sleep(stop, 300*time.Millisecond)
			continue
		}
		m.record(path, dur, key, ref)
		m.sleep(stop, 60*time.Millisecond)
	}
}

func (m *Manager) record(path string, dur time.Duration, key int, ref int64) {
	ns := dur.Nanoseconds()
	m.total.Add(1)
	m.latSumNs.Add(ns)
	m.latCount.Add(1)
	m.lastLat.Store(ns)
	m.lastKey.Store(int64(key))
	m.lastRef.Store(ref)
	if path == "quentra" {
		m.quenSumNs.Add(ns)
		m.quenCount.Add(1)
	} else {
		m.refSumNs.Add(ns)
		m.refCount.Add(1)
	}
	ev := MovementEvent{Key: key, Mode: path, Ms: round1(float64(ns) / 1e6), Ref: ref, At: time.Now().UnixMilli()}
	m.feedMu.Lock()
	m.feed = append([]MovementEvent{ev}, m.feed...)
	if len(m.feed) > feedSize {
		m.feed = m.feed[:feedSize]
	}
	m.feedMu.Unlock()
}

func (m *Manager) sleep(stop <-chan struct{}, d time.Duration) {
	select {
	case <-stop:
	case <-time.After(d):
	}
}

func (m *Manager) sampler(stop <-chan struct{}) {
	defer m.wg.Done()
	tick := time.NewTicker(time.Second)
	defer tick.Stop()

	lastTotal := m.total.Load()
	last := time.Now()
	comp0, batch0, have := m.perfCounters()

	for {
		select {
		case <-stop:
			return
		case now := <-tick.C:
			elapsed := now.Sub(last).Seconds()
			if elapsed <= 0 {
				elapsed = 1
			}
			last = now

			tot := m.total.Load()
			qps := float64(tot-lastTotal) / elapsed
			lastTotal = tot

			sum := m.latSumNs.Swap(0)
			cnt := m.latCount.Swap(0)
			avgMs := 0.0
			if cnt > 0 {
				avgMs = float64(sum) / float64(cnt) / 1e6
			}

			single, total, mb := m.planCache()
			comp, batch, ok := m.perfCounters()
			var compSec, batchSec float64
			if ok && have {
				compSec = float64(comp-comp0) / elapsed
				batchSec = float64(batch-batch0) / elapsed
			}
			if ok {
				comp0, batch0, have = comp, batch, true
			}

			snap := Metrics{
				QueriesPerSec:      round1(qps),
				AvgMs:              round2(avgMs),
				LastMs:             round2(float64(m.lastLat.Load()) / 1e6),
				RefAvgMs:           round2(avgOf(m.refSumNs.Load(), m.refCount.Load())),
				QuentraAvgMs:       round2(avgOf(m.quenSumNs.Load(), m.quenCount.Load())),
				RefRuns:            m.refCount.Load(),
				QuentraRuns:        m.quenCount.Load(),
				SingleUsePlans:     single,
				TotalPlans:         total,
				PlanCacheMB:        round1(mb),
				CompilationsPerSec: round1(compSec),
				BatchPerSec:        round1(batchSec),
				SQLCpuPct:          m.sqlCPU(),
				LastSample:         now.UnixMilli(),
			}
			m.mu.Lock()
			m.metrics = snap
			m.mu.Unlock()
		}
	}
}

func (m *Manager) planCache() (single, total int64, mb float64) {
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	_ = m.db.QueryRowContext(ctx, planCacheSQL).Scan(&single, &total, &mb)
	return
}

func (m *Manager) perfCounters() (comp, batch int64, ok bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	rows, err := m.db.QueryContext(ctx, perfCountersSQL)
	if err != nil {
		return 0, 0, false
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		var val int64
		if err := rows.Scan(&name, &val); err != nil {
			return 0, 0, false
		}
		switch strings.TrimSpace(name) {
		case "SQL Compilations/sec":
			comp = val
		case "Batch Requests/sec":
			batch = val
		}
	}
	return comp, batch, rows.Err() == nil
}

func (m *Manager) sqlCPU() int {
	const q = `SELECT ISNULL(SUM(total_cpu_usage_ms),0), COUNT(*)
		FROM sys.dm_os_schedulers WHERE status='VISIBLE ONLINE' AND is_online=1`
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	var cpuMs, sched int64
	if err := m.db.QueryRowContext(ctx, q).Scan(&cpuMs, &sched); err != nil {
		return 0
	}
	now := time.Now()
	if sched < 1 {
		sched = 1
	}
	prevMs, prevAt := m.cpuPrevMs, m.cpuPrevAt
	m.cpuPrevMs, m.cpuPrevAt = cpuMs, now
	if prevAt.IsZero() || cpuMs < prevMs {
		return 0
	}
	el := now.Sub(prevAt).Milliseconds()
	if el <= 0 {
		return 0
	}
	pct := float64(cpuMs-prevMs) / float64(el) / float64(sched) * 100
	if pct < 0 {
		pct = 0
	}
	if pct > 100 {
		pct = 100
	}
	return int(pct + 0.5)
}

func avgOf(sumNs, count int64) float64 {
	if count == 0 {
		return 0
	}
	return float64(sumNs) / float64(count) / 1e6
}

func round1(v float64) float64 { return float64(int64(v*10+0.5)) / 10 }
func round2(v float64) float64 { return float64(int64(v*100+0.5)) / 100 }
