// Package hospital runs the REAL workload behind the hospital remote-support
// data-masking demo.
//
// A software vendor's support engineer is connected to a live hospital
// database. The workload continuously performs the support screen's patient
// lookup and sends the IDENTICAL parameterized query down two routes:
//
//   - direct: straight to SQL Server — what a privileged (DBA) session sees.
//   - quentra: through the Quentra gateway (:14330) — what the support
//     engineer's session sees.
//
// Both result rows are exposed verbatim in State(). While no masking rule is
// configured on the gateway the two rows are identical; the moment a rule is
// enabled the quentra row comes back masked and the UI diverges — honestly,
// because the demo only ever renders what each route actually returned.
package hospital

import (
	"context"
	"database/sql"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"log/slog"

	_ "github.com/microsoft/go-mssqldb"

	"supermarketsim/internal/config"
	"supermarketsim/internal/sqlcapture"
)

const (
	queryTimeout = 8 * time.Second
	// pacing keeps the lookup stream at a screen-watchable rhythm; the load on
	// SQL Server is negligible either way.
	pacing   = 1400 * time.Millisecond
	feedSize = 10
)

// Row is one patient record exactly as a route returned it.
type Row struct {
	ID       int    `json:"id"`
	Ad       string `json:"ad"`
	Soyad    string `json:"soyad"`
	TCKN     string `json:"tckn"`
	Telefon  string `json:"telefon"`
	KanGrubu string `json:"kanGrubu"`
	Adres    string `json:"adres"`
	Tani     string `json:"tani"`
}

// LookupEvent is one completed A/B lookup, shown in the live feed. NameOpen is
// the direct route's (unmasked) name, NameSeen what the quentra route returned.
type LookupEvent struct {
	ID        int     `json:"id"`
	NameOpen  string  `json:"nameOpen"`
	NameSeen  string  `json:"nameSeen"`
	Masked    bool    `json:"masked"`
	DirectMs  float64 `json:"directMs"`
	QuentraMs float64 `json:"quentraMs"`
	At        int64   `json:"at"`
}

// Metrics is the JSON snapshot served to the UI. Real.
type Metrics struct {
	Mode        string `json:"mode"` // presentation role: baseline | quentra | dba
	Running     bool   `json:"running"`
	Provisioned bool   `json:"provisioned"`
	GatewayUp   bool   `json:"gatewayUp"`

	QueriesTotal  int64   `json:"queriesTotal"`
	Errors        int64   `json:"errors"`
	QueriesPerSec float64 `json:"queriesPerSec"`
	DirectMs      float64 `json:"directMs"`
	QuentraMs     float64 `json:"quentraMs"`
	DirectAvgMs   float64 `json:"directAvgMs"`
	QuentraAvgMs  float64 `json:"quentraAvgMs"`

	// Masked reports whether the two routes currently return DIFFERENT data for
	// the same query — true only when the gateway really masked something.
	Masked       bool     `json:"masked"`
	MaskedFields []string `json:"maskedFields"`

	// The latest lookup's result set per route, verbatim.
	DirectRows  []Row `json:"directRows"`
	QuentraRows []Row `json:"quentraRows"`

	// The exact SQL each route's backend session executed (DMV capture while
	// running; the static statement when idle). Identical by construction — the
	// demo's whole message.
	DirectSQL  string `json:"directSql"`
	QuentraSQL string `json:"quentraSql"`

	Recent     []LookupEvent `json:"recent"`
	LastError  string        `json:"lastError"`
	LastSample int64         `json:"lastSample"`
}

// Manager owns the two pools, the lookup worker and the sampler.
type Manager struct {
	cfg *config.Config
	log *slog.Logger

	db *sql.DB // direct route
	gw *sql.DB // through the Quentra gateway; nil when the gateway is down

	mode        atomic.Value // "baseline" | "quentra" | "dba"
	running     atomic.Bool
	provisioned atomic.Bool
	gatewayUp   atomic.Bool

	total  atomic.Int64
	errors atomic.Int64

	dirLastNs atomic.Int64
	qnLastNs  atomic.Int64
	dirSumNs  atomic.Int64
	dirCount  atomic.Int64
	qnSumNs   atomic.Int64
	qnCount   atomic.Int64

	rowMu       sync.RWMutex
	directRows  []Row
	quentraRows []Row

	errMu   sync.RWMutex
	lastErr string

	feedMu sync.Mutex
	feed   []LookupEvent

	mu      sync.RWMutex
	metrics Metrics

	// capCache holds the SQL each route's backend session actually executed,
	// captured from SQL Server's DMVs and refreshed at most once per interval.
	capCache *sqlcapture.Cache

	chMu   sync.Mutex
	stopCh chan struct{}
	wg     sync.WaitGroup

	next atomic.Int64 // round-robin patient id
}

// NewManager creates an un-provisioned manager. Call Provision then Start.
func NewManager(cfg *config.Config, log *slog.Logger) *Manager {
	m := &Manager{cfg: cfg, log: log, stopCh: make(chan struct{})}
	m.mode.Store("quentra")
	m.metrics = Metrics{Mode: "quentra"}
	m.capCache = sqlcapture.NewCache(30 * time.Second)
	return m
}

func (m *Manager) modeStr() string {
	v, _ := m.mode.Load().(string)
	if v == "" {
		return "quentra"
	}
	return v
}

// SetMode stores the page's presentation role. The workload itself always runs
// both routes; the role only selects which screen the UI foregrounds, and is
// kept server-side so every open browser shows the same story.
func (m *Manager) SetMode(mode string) {
	switch mode {
	case "baseline", "off", "none":
		m.mode.Store("baseline")
	case "quentra", "support", "destek":
		m.mode.Store("quentra")
	case "dba", "admin":
		m.mode.Store("dba")
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
	out.GatewayUp = m.gatewayUp.Load()
	out.QueriesTotal = m.total.Load()
	out.Errors = m.errors.Load()
	out.DirectMs = round2(float64(m.dirLastNs.Load()) / 1e6)
	out.QuentraMs = round2(float64(m.qnLastNs.Load()) / 1e6)
	if n := m.dirCount.Load(); n > 0 {
		out.DirectAvgMs = round2(float64(m.dirSumNs.Load()) / float64(n) / 1e6)
	}
	if n := m.qnCount.Load(); n > 0 {
		out.QuentraAvgMs = round2(float64(m.qnSumNs.Load()) / float64(n) / 1e6)
	}

	m.rowMu.RLock()
	out.DirectRows = append([]Row(nil), m.directRows...)
	out.QuentraRows = append([]Row(nil), m.quentraRows...)
	m.rowMu.RUnlock()
	out.Masked, out.MaskedFields = diffRowSets(out.DirectRows, out.QuentraRows)

	out.DirectSQL, out.QuentraSQL = m.displaySQL()

	m.errMu.RLock()
	out.LastError = m.lastErr
	m.errMu.RUnlock()
	m.feedMu.Lock()
	out.Recent = append([]LookupEvent(nil), m.feed...)
	m.feedMu.Unlock()
	return out
}

// diffRowSets compares the two routes' result sets field by field; any
// difference is a mask applied in flight, because both sets came from the same
// query on the same table.
func diffRowSets(d, q []Row) (bool, []string) {
	n := len(d)
	if len(q) < n {
		n = len(q)
	}
	seen := map[string]bool{}
	var fields []string
	add := func(name string) {
		if !seen[name] {
			seen[name] = true
			fields = append(fields, name)
		}
	}
	for i := 0; i < n; i++ {
		if d[i].ID != q[i].ID {
			continue
		}
		pairs := [][3]string{
			{"ad", d[i].Ad, q[i].Ad},
			{"soyad", d[i].Soyad, q[i].Soyad},
			{"tckn", d[i].TCKN, q[i].TCKN},
			{"telefon", d[i].Telefon, q[i].Telefon},
			{"kanGrubu", d[i].KanGrubu, q[i].KanGrubu},
			{"adres", d[i].Adres, q[i].Adres},
			{"tani", d[i].Tani, q[i].Tani},
		}
		for _, p := range pairs {
			if strings.TrimSpace(p[1]) != strings.TrimSpace(p[2]) {
				add(p[0])
			}
		}
	}
	return len(fields) > 0, fields
}

// displaySQL reports what each route's backend session ACTUALLY executed
// (DMV capture) while running, falling back to the static statement when idle.
// Identical text on both sides is the expected, honest result.
func (m *Manager) displaySQL() (string, string) {
	if m.running.Load() && m.db != nil {
		id := int(m.next.Load()*5)%PatientCount + 1
		run := func(ctx context.Context, conn *sql.Conn) error {
			rows, err := conn.QueryContext(ctx, patientQuery, sql.Named("id", id))
			if err != nil {
				return err
			}
			defer rows.Close()
			for rows.Next() {
			}
			return rows.Err()
		}
		if d, q, ok := m.capCache.Get(m.db, m.gw, "patient", run); ok {
			return d, q
		}
	}
	return patientQuery, patientQuery
}

// Provision creates the disposable database, table and seed rows.
func (m *Manager) Provision(ctx context.Context) error {
	master, err := sql.Open("sqlserver", m.cfg.DSNFor("master", config.AppSetup))
	if err != nil {
		return err
	}
	if _, err := master.ExecContext(ctx,
		`IF DB_ID(N'`+DBName+`') IS NULL CREATE DATABASE [`+DBName+`];`); err != nil {
		_ = master.Close()
		return err
	}
	_ = master.Close()

	pool, err := sql.Open("sqlserver", m.cfg.DSNFor(DBName, config.AppHospital))
	if err != nil {
		return err
	}
	pool.SetMaxOpenConns(4)
	pool.SetMaxIdleConns(2)
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
	var n int64
	if err := m.db.QueryRowContext(ctx, countSQL).Scan(&n); err != nil {
		return err
	}

	// Second pool through the Quentra gateway (:14330). Best-effort with
	// fallback to direct, matching the other live workloads.
	if gw, err := sql.Open("sqlserver", m.cfg.QuentraDSNFor(DBName, config.AppHospital)); err == nil {
		gw.SetMaxOpenConns(4)
		gw.SetMaxIdleConns(2)
		gw.SetConnMaxLifetime(30 * time.Minute)
		gctx, gcancel := context.WithTimeout(ctx, 10*time.Second)
		if perr := gw.PingContext(gctx); perr == nil {
			m.gw = gw
			m.gatewayUp.Store(true)
		} else {
			_ = gw.Close()
			m.log.Warn("quentra gateway unreachable; hospital support route uses direct", "error", perr.Error())
		}
		gcancel()
	}

	m.provisioned.Store(true)
	return nil
}

// quentraPool returns the gateway pool, falling back to direct when it is down.
func (m *Manager) quentraPool() *sql.DB {
	if m.gw != nil {
		return m.gw
	}
	return m.db
}

// Start launches the worker and sampler. Safe to call after Pause.
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

	m.wg.Add(2)
	go m.worker(stop)
	go m.sampler(stop)
}

// Pause halts the workers but keeps the pools open.
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

// worker performs the A/B patient lookup: the SAME parameterized query goes to
// the direct route first, then through the gateway.
func (m *Manager) worker(stop <-chan struct{}) {
	defer m.wg.Done()
	for {
		select {
		case <-stop:
			return
		default:
		}

		// Stride 5 so successive lookups page through different patient windows.
		id := int(m.next.Add(1)*5)%PatientCount + 1

		dRows, dDur, dErr := m.lookup(m.db, id)
		qRows, qDur, qErr := m.lookup(m.quentraPool(), id)
		m.total.Add(1)

		if dErr != nil || qErr != nil {
			m.errors.Add(1)
			err := dErr
			if err == nil {
				err = qErr
			}
			m.errMu.Lock()
			m.lastErr = err.Error()
			m.errMu.Unlock()
			m.sleep(stop, pacing)
			continue
		}

		m.dirLastNs.Store(dDur.Nanoseconds())
		m.qnLastNs.Store(qDur.Nanoseconds())
		m.dirSumNs.Add(dDur.Nanoseconds())
		m.dirCount.Add(1)
		m.qnSumNs.Add(qDur.Nanoseconds())
		m.qnCount.Add(1)

		m.rowMu.Lock()
		m.directRows, m.quentraRows = dRows, qRows
		m.rowMu.Unlock()

		masked, _ := diffRowSets(dRows, qRows)
		ev := LookupEvent{
			ID:       id,
			DirectMs: round2(float64(dDur.Nanoseconds()) / 1e6), QuentraMs: round2(float64(qDur.Nanoseconds()) / 1e6),
			Masked: masked,
			At:     time.Now().UnixMilli(),
		}
		if len(dRows) > 0 {
			ev.NameOpen = strings.TrimSpace(dRows[0].Ad + " " + dRows[0].Soyad)
		}
		if len(qRows) > 0 {
			ev.NameSeen = strings.TrimSpace(qRows[0].Ad + " " + qRows[0].Soyad)
		}
		m.feedMu.Lock()
		m.feed = append([]LookupEvent{ev}, m.feed...)
		if len(m.feed) > feedSize {
			m.feed = m.feed[:feedSize]
		}
		m.feedMu.Unlock()

		m.sleep(stop, pacing)
	}
}

func (m *Manager) lookup(pool *sql.DB, id int) ([]Row, time.Duration, error) {
	ctx, cancel := context.WithTimeout(context.Background(), queryTimeout)
	defer cancel()
	start := time.Now()
	rows, err := pool.QueryContext(ctx, patientQuery, sql.Named("id", id))
	if err != nil {
		return nil, time.Since(start), err
	}
	defer rows.Close()
	var out []Row
	for rows.Next() {
		var r Row
		if err := rows.Scan(&r.ID, &r.Ad, &r.Soyad, &r.TCKN, &r.Telefon, &r.KanGrubu, &r.Adres, &r.Tani); err != nil {
			return out, time.Since(start), err
		}
		out = append(out, r)
	}
	return out, time.Since(start), rows.Err()
}

func (m *Manager) sleep(stop <-chan struct{}, d time.Duration) {
	select {
	case <-stop:
	case <-time.After(d):
	}
}

// sampler folds per-second rates into the snapshot.
func (m *Manager) sampler(stop <-chan struct{}) {
	defer m.wg.Done()
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	lastTotal := m.total.Load()
	last := time.Now()
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
			m.mu.Lock()
			m.metrics.QueriesPerSec = round1(qps)
			m.metrics.LastSample = now.UnixMilli()
			m.mu.Unlock()
		}
	}
}

func round1(v float64) float64 { return float64(int64(v*10+0.5)) / 10 }
func round2(v float64) float64 { return float64(int64(v*100+0.5)) / 100 }
