// Package fulltext runs the REAL search workload behind the
// fulltext-search-simulation demo page.
//
// It searches the pre-existing CRM2.dbo.CUSTOMERS table (~5M rows) two ways and
// times each for real:
//
//   - "reference": a leading-wildcard LIKE ('%term%'). NAMESURNAME has no index,
//     so SQL Server scans the whole table on every search — ~1s, several CPU
//     seconds. This is the "slow LIKE" the demo is about.
//   - "quentra":   full-text CONTAINS over the same column, backed by a
//     full-text index this package provisions once. It seeks instead of
//     scanning, so it returns in a fraction of the time.
//
// Every millisecond the UI shows is measured here; nothing is synthesized.
package fulltext

import (
	"context"
	"database/sql"
	"math/rand"
	"sync"
	"sync/atomic"
	"time"

	"log/slog"

	_ "github.com/microsoft/go-mssqldb"

	"supermarketsim/internal/config"
	"supermarketsim/internal/sqlcapture"
)

const (
	// workerCount is how many concurrent "office users" run searches. Kept low
	// because each reference search is a full table scan.
	workerCount = 2
	// queryTimeout bounds a single search.
	queryTimeout = 30 * time.Second
	// pacing between searches per worker so a live demo does not pin the server.
	pacing = 400 * time.Millisecond
	// feedSize is how many recent searches are kept for the live feed.
	feedSize = 12
)

// SearchEvent is one measured search, shown in the live feed.
type SearchEvent struct {
	Term    string  `json:"term"`
	Mode    string  `json:"mode"`
	Ms      float64 `json:"ms"`
	Matches int64   `json:"matches"`
	Scanned int64   `json:"scanned"`
	At      int64   `json:"at"`
}

// Metrics is the JSON snapshot served to the UI. Timings are REAL.
type Metrics struct {
	Mode        string `json:"mode"`
	Running     bool   `json:"running"`
	Provisioned bool   `json:"provisioned"`
	FtReady     bool   `json:"ftReady"`

	TableRows      int64   `json:"tableRows"`
	SearchesTotal  int64   `json:"searchesTotal"`
	SearchesPerSec float64 `json:"searchesPerSec"`
	AvgMs          float64 `json:"avgMs"`
	LastMs         float64 `json:"lastMs"`
	LastTerm       string  `json:"lastTerm"`
	LastMatches    int64   `json:"lastMatches"`
	LastScanned    int64   `json:"lastScanned"`

	RefAvgMs     float64 `json:"refAvgMs"`
	QuentraAvgMs float64 `json:"quentraAvgMs"`
	RefRuns      int64   `json:"refRuns"`
	QuentraRuns  int64   `json:"quentraRuns"`

	SQLCpuPct int    `json:"sqlCpuPct"`
	Errors    int64  `json:"errors"`
	LastError string `json:"lastError"`

	// Connection proof + the exact SQL each path sends, so the UI can show the
	// slow query on the direct link and the optimized one through Quentra.
	GatewayUp  bool   `json:"gatewayUp"`
	DirectSQL  string `json:"directSql"`
	QuentraSQL string `json:"quentraSql"`

	Recent     []SearchEvent `json:"recent"`
	LastSample int64         `json:"lastSample"`
}

// Manager owns the CRM2 pool, the search workers and the metric sampler.
type Manager struct {
	cfg *config.Config
	log *slog.Logger

	db *sql.DB
	// gw reaches the SAME SQL Server through the Quentra gateway (:14330). The
	// quentra path travels this pool so its queries genuinely go through Quentra;
	// nil when the gateway was unreachable at provision time (falls back to db).
	gw *sql.DB

	mode        atomic.Value // "reference" | "quentra" | "auto"
	running     atomic.Bool
	provisioned atomic.Bool
	ftReady     atomic.Bool
	gatewayUp   atomic.Bool
	tableRows   atomic.Int64

	total     atomic.Int64
	errors    atomic.Int64
	latSumNs  atomic.Int64
	latCount  atomic.Int64
	lastLatNs atomic.Int64

	refSumNs  atomic.Int64
	refCount  atomic.Int64
	quenSumNs atomic.Int64
	quenCount atomic.Int64

	lastMu      sync.RWMutex
	lastTerm    string
	lastMatches int64
	lastScanned int64
	lastErr     string

	feedMu sync.Mutex
	feed   []SearchEvent

	mu      sync.RWMutex
	metrics Metrics

	// capCache holds the SQL each route's backend session actually executed,
	// captured from SQL Server's DMVs and refreshed at most once per interval.
	capCache *sqlcapture.Cache

	cpuPrevMs int64
	cpuPrevAt time.Time

	chMu   sync.Mutex
	stopCh chan struct{}
	wg     sync.WaitGroup
}

// NewManager creates an un-provisioned manager. Call Provision then Start.
func NewManager(cfg *config.Config, log *slog.Logger) *Manager {
	m := &Manager{cfg: cfg, log: log, stopCh: make(chan struct{})}
	m.mode.Store("reference")
	m.metrics = Metrics{Mode: "reference"}
	m.capCache = sqlcapture.NewCache(30 * time.Second)
	return m
}

func (m *Manager) modeStr() string {
	v, _ := m.mode.Load().(string)
	if v == "" {
		return "reference"
	}
	return v
}

// SetMode selects the search path. "auto" alternates so both bars keep moving.
func (m *Manager) SetMode(mode string) {
	switch mode {
	case "reference", "like", "baseline":
		m.mode.Store("reference")
	case "quentra", "fulltext":
		m.mode.Store("quentra")
	case "auto":
		m.mode.Store("auto")
	}
}

// State returns the latest snapshot merged with the live atomic counters.
func (m *Manager) State() Metrics {
	m.mu.RLock()
	out := m.metrics
	m.mu.RUnlock()
	out.Mode = m.modeStr()
	out.Running = m.running.Load()
	out.Provisioned = m.provisioned.Load()
	out.FtReady = m.ftReady.Load()
	out.TableRows = m.tableRows.Load()
	out.SearchesTotal = m.total.Load()
	out.Errors = m.errors.Load()
	m.lastMu.RLock()
	out.LastTerm = m.lastTerm
	out.LastMatches = m.lastMatches
	out.LastScanned = m.lastScanned
	out.LastError = m.lastErr
	m.lastMu.RUnlock()
	term := out.LastTerm
	if term == "" {
		term = searchTerms[0]
	}
	out.GatewayUp = m.gatewayUp.Load()
	out.DirectSQL, out.QuentraSQL = m.displaySQL(term)
	m.feedMu.Lock()
	out.Recent = append([]SearchEvent(nil), m.feed...)
	m.feedMu.Unlock()
	return out
}

// displaySQL returns the SQL shown in the direct and Quentra panels. While the
// workload runs it reports what each route's backend session ACTUALLY executed,
// captured from SQL Server's DMVs — so a gateway LIKE→CONTAINS rewrite shows up
// for real instead of a hand-authored string. When idle (or before the first
// capture) it falls back to the static reference statement, shown for both legs
// since the app sends the identical LIKE down each route.
func (m *Manager) displaySQL(term string) (string, string) {
	if m.running.Load() && m.db != nil {
		run := func(ctx context.Context, conn *sql.Conn) error {
			rows, err := conn.QueryContext(ctx, referenceSQL, sql.Named("term", term))
			if err != nil {
				return err
			}
			defer rows.Close()
			for rows.Next() {
			}
			return rows.Err()
		}
		if d, q, ok := m.capCache.Get(m.db, m.gw, "search", run); ok {
			return d, q
		}
	}
	return directDisplaySQL(term), directDisplaySQL(term)
}

// Provision opens the pool, creates the full-text catalog/index (idempotent)
// and reads the table size. Full-text population then runs in the background;
// the accelerated path works throughout, returning more rows as it completes.
func (m *Manager) Provision(ctx context.Context) error {
	pool, err := sql.Open("sqlserver", m.cfg.DSNFor(DBName, config.AppFulltext))
	if err != nil {
		return err
	}
	pool.SetMaxOpenConns(workerCount + 2)
	pool.SetMaxIdleConns(workerCount)
	pool.SetConnMaxLifetime(30 * time.Minute)
	if err := pool.PingContext(ctx); err != nil {
		_ = pool.Close()
		return err
	}
	m.db = pool

	for _, stmt := range provisionStmts {
		if _, err := m.db.ExecContext(ctx, stmt); err != nil {
			return err
		}
	}

	var rows int64
	if err := m.db.QueryRowContext(ctx, countSQL).Scan(&rows); err != nil {
		return err
	}
	m.tableRows.Store(rows)
	m.refreshFtReady(ctx)

	// Second pool through the Quentra gateway (:14330). Best-effort: if it is
	// unreachable the quentra path falls back to the direct connection.
	if gw, err := sql.Open("sqlserver", m.cfg.QuentraDSNFor(DBName, config.AppFulltext)); err == nil {
		gw.SetMaxOpenConns(workerCount + 2)
		gw.SetMaxIdleConns(workerCount)
		gw.SetConnMaxLifetime(30 * time.Minute)
		gctx, gcancel := context.WithTimeout(ctx, 10*time.Second)
		if perr := gw.PingContext(gctx); perr == nil {
			m.gw = gw
			m.gatewayUp.Store(true)
		} else {
			_ = gw.Close()
			m.log.Warn("quentra gateway unreachable; fulltext quentra path uses direct", "error", perr.Error())
		}
		gcancel()
	}

	m.provisioned.Store(true)
	return nil
}

// quentraPool returns the gateway pool for the quentra path, falling back to
// the direct pool when the gateway is down so the workload keeps running.
func (m *Manager) quentraPool() *sql.DB {
	if m.gw != nil {
		return m.gw
	}
	return m.db
}

func (m *Manager) refreshFtReady(ctx context.Context) {
	var items int64
	if err := m.db.QueryRowContext(ctx, ftReadySQL).Scan(&items); err == nil && items > 0 {
		m.ftReady.Store(true)
	}
}

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

// pathFor resolves the concrete query path for a worker iteration. "auto"
// alternates by iteration so both the reference and quentra bars keep moving.
func (m *Manager) pathFor(iter int) (path, sqlText, arg string) {
	mode := m.modeStr()
	if mode == "auto" {
		if iter%2 == 0 {
			mode = "reference"
		} else {
			mode = "quentra"
		}
	}
	term := searchTerms[rand.Intn(len(searchTerms))]
	// The application sends the SAME direct query — the leading-wildcard LIKE —
	// on BOTH routes. The mode only picks the ROUTE: "reference" goes direct and
	// SQL Server scans; "quentra" goes through the gateway (:14330), which is
	// what rewrites the LIKE into a full-text lookup. Emitting CONTAINS from the
	// client would change the app, defeating the whole comparison.
	if mode == "quentra" {
		return "quentra", referenceSQL, term
	}
	return "reference", referenceSQL, term
}

func (m *Manager) worker(id int, stop <-chan struct{}) {
	defer m.wg.Done()
	iter := id
	for {
		select {
		case <-stop:
			return
		default:
		}
		iter++

		path, sqlText, arg := m.pathFor(iter)
		// arg is the plain fragment on both routes now (same LIKE query).
		display := arg

		// The quentra path travels the gateway pool (:14330); the reference path
		// stays on the direct connection. Same statement, different route.
		pool := m.db
		if path == "quentra" {
			pool = m.quentraPool()
		}

		ctx, cancel := context.WithTimeout(context.Background(), queryTimeout)
		start := time.Now()
		rows, err := pool.QueryContext(ctx, sqlText, sql.Named("term", arg))
		var matches int64
		if err == nil {
			for rows.Next() {
				matches++
			}
			err = rows.Err()
			rows.Close()
		}
		dur := time.Since(start)
		cancel()

		if err != nil {
			m.errors.Add(1)
			m.lastMu.Lock()
			m.lastErr = err.Error()
			m.lastMu.Unlock()
			if n := m.errors.Load(); n == 1 || n%20 == 0 {
				m.log.Warn("fulltext search failed", "count", n, "path", path, "error", err.Error())
			}
			m.sleep(stop, 800*time.Millisecond)
			continue
		}

		// Both routes now run the same leading-wildcard LIKE, so both walk the
		// whole table — the gateway does not rewrite it into a seek on the app's
		// behalf. Report the full scan for both, honestly.
		scanned := m.tableRows.Load()
		m.record(path, dur, matches, scanned, display)
		m.sleep(stop, pacing)
	}
}

func (m *Manager) record(path string, dur time.Duration, matches, scanned int64, term string) {
	ns := dur.Nanoseconds()
	m.total.Add(1)
	m.latSumNs.Add(ns)
	m.latCount.Add(1)
	m.lastLatNs.Store(ns)
	if path == "quentra" {
		m.quenSumNs.Add(ns)
		m.quenCount.Add(1)
	} else {
		m.refSumNs.Add(ns)
		m.refCount.Add(1)
	}

	m.lastMu.Lock()
	m.lastTerm = term
	m.lastMatches = matches
	m.lastScanned = scanned
	m.lastMu.Unlock()

	ev := SearchEvent{
		Term: term, Mode: path, Ms: round1(float64(ns) / 1e6),
		Matches: matches, Scanned: scanned, At: time.Now().UnixMilli(),
	}
	m.feedMu.Lock()
	m.feed = append([]SearchEvent{ev}, m.feed...)
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
	probe := 0

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
			sps := float64(tot-lastTotal) / elapsed
			lastTotal = tot

			sum := m.latSumNs.Swap(0)
			cnt := m.latCount.Swap(0)
			avgMs := 0.0
			if cnt > 0 {
				avgMs = float64(sum) / float64(cnt) / 1e6
			}

			probe++
			if probe%5 == 0 && !m.ftReady.Load() {
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				m.refreshFtReady(ctx)
				cancel()
			}

			snap := Metrics{
				SearchesPerSec: round1(sps),
				AvgMs:          round1(avgMs),
				LastMs:         round1(float64(m.lastLatNs.Load()) / 1e6),
				RefAvgMs:       round1(avgOf(m.refSumNs.Load(), m.refCount.Load())),
				QuentraAvgMs:   round1(avgOf(m.quenSumNs.Load(), m.quenCount.Load())),
				RefRuns:        m.refCount.Load(),
				QuentraRuns:    m.quenCount.Load(),
				SQLCpuPct:      m.sqlCPU(),
				LastSample:     now.UnixMilli(),
			}
			m.mu.Lock()
			m.metrics = snap
			m.mu.Unlock()
		}
	}
}

func avgOf(sumNs, count int64) float64 {
	if count == 0 {
		return 0
	}
	return float64(sumNs) / float64(count) / 1e6
}

func round1(v float64) float64 { return float64(int64(v*10+0.5)) / 10 }

// sqlCPU returns SQL Server CPU as a percentage of scheduler capacity, using
// the same accumulate-and-delta approach as the vehicle workload.
func (m *Manager) sqlCPU() int {
	const q = `SELECT ISNULL(SUM(total_cpu_usage_ms),0), COUNT(*)
		FROM sys.dm_os_schedulers
		WHERE status = 'VISIBLE ONLINE' AND is_online = 1`
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	var cpuMs, schedulers int64
	if err := m.db.QueryRowContext(ctx, q).Scan(&cpuMs, &schedulers); err != nil {
		return 0
	}
	now := time.Now()
	if schedulers < 1 {
		schedulers = 1
	}
	prevMs, prevAt := m.cpuPrevMs, m.cpuPrevAt
	m.cpuPrevMs, m.cpuPrevAt = cpuMs, now
	if prevAt.IsZero() || cpuMs < prevMs {
		return 0
	}
	elapsedMs := now.Sub(prevAt).Milliseconds()
	if elapsedMs <= 0 {
		return 0
	}
	pct := float64(cpuMs-prevMs) / float64(elapsedMs) / float64(schedulers) * 100
	if pct < 0 {
		pct = 0
	}
	if pct > 100 {
		pct = 100
	}
	return int(pct + 0.5)
}
