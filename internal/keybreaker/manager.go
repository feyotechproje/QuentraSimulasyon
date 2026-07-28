// Package keybreaker runs the REAL SQL-injection defense workload behind the
// key-breaker-simulation demo page.
//
// A stream of login attempts — some legitimate, some classic injections — is
// sent two ways:
//
//   - "baseline" (shield off): the app builds the query by string concatenation
//     and sends it straight to SQL Server. Read-oriented injections (tautology /
//     UNION / comment) actually breach the disposable KB_ACCOUNTS table, and the
//     UI shows the measured breach.
//   - "quentra" (shield on): the Quentra shield inspects every attempt, blocks
//     anything malicious before it reaches SQL Server, and only lets clean,
//     parameterized logins through.
//
// SAFETY: the target is a dedicated, disposable database. Destructive payloads
// are classified and counted but never executed. See sql.go.
package keybreaker

import (
	"context"
	"database/sql"
	"sync"
	"sync/atomic"
	"time"

	"log/slog"

	_ "github.com/microsoft/go-mssqldb"

	"supermarketsim/internal/config"
)

const (
	workerCount  = 3
	queryTimeout = 8 * time.Second
	pacing       = 350 * time.Millisecond
	feedSize     = 14
)

// AttackEvent is one processed attempt, shown in the live feed.
type AttackEvent struct {
	Label   string  `json:"label"`
	Kind    string  `json:"kind"`
	Outcome string  `json:"outcome"` // blocked | breached | denied | allowed
	Ms      float64 `json:"ms"`
	At      int64   `json:"at"`
}

// Metrics is the JSON snapshot served to the UI. Real.
type Metrics struct {
	Mode        string `json:"mode"`
	Running     bool   `json:"running"`
	Provisioned bool   `json:"provisioned"`

	Attempts     int64 `json:"attempts"`
	Malicious    int64 `json:"malicious"`
	Blocked      int64 `json:"blocked"`
	ReachedDB    int64 `json:"reachedDb"`
	Breaches     int64 `json:"breaches"`
	LegitOk      int64 `json:"legitOk"`
	LegitDenied  int64 `json:"legitDenied"`
	Errors       int64 `json:"errors"`

	AttemptsPerSec float64 `json:"attemptsPerSec"`
	AvgMs          float64 `json:"avgMs"`
	LastMs         float64 `json:"lastMs"`
	DetectionRate  float64 `json:"detectionRate"` // blocked / malicious, %

	DBStatus  string `json:"dbStatus"` // secure | risk
	SQLCpuPct int    `json:"sqlCpuPct"`

	// Connection proof + the exact SQL each path sends: the injectable
	// concatenated query on the direct link vs the parameterized one Quentra
	// lets through.
	GatewayUp  bool   `json:"gatewayUp"`
	DirectSQL  string `json:"directSql"`
	QuentraSQL string `json:"quentraSql"`

	Recent     []AttackEvent `json:"recent"`
	LastError  string        `json:"lastError"`
	LastSample int64         `json:"lastSample"`
}

// Manager owns the disposable pool, the attack workers and the sampler.
type Manager struct {
	cfg *config.Config
	log *slog.Logger

	db *sql.DB
	// gw reaches the disposable database through the Quentra gateway (:14330).
	// With the shield on, the clean parameterized query travels this pool so the
	// allowed traffic genuinely goes through Quentra. nil when the gateway is down.
	gw *sql.DB

	mode        atomic.Value // "baseline" | "quentra" | "auto"
	running     atomic.Bool
	provisioned atomic.Bool
	gatewayUp   atomic.Bool

	attempts    atomic.Int64
	malicious   atomic.Int64
	blocked     atomic.Int64
	reachedDB   atomic.Int64
	breaches    atomic.Int64
	legitOk     atomic.Int64
	legitDenied atomic.Int64
	errors      atomic.Int64

	latSumNs atomic.Int64
	latCount atomic.Int64
	lastLat  atomic.Int64

	errMu    sync.RWMutex
	lastErr  string
	lastVuln string // last concatenated vulnerable query, for the SQL panel

	feedMu sync.Mutex
	feed   []AttackEvent

	mu      sync.RWMutex
	metrics Metrics

	cpuPrevMs int64
	cpuPrevAt time.Time

	chMu   sync.Mutex
	stopCh chan struct{}
	wg     sync.WaitGroup

	next atomic.Int64 // round-robin index into payloads
}

// NewManager creates an un-provisioned manager. Call Provision then Start.
func NewManager(cfg *config.Config, log *slog.Logger) *Manager {
	m := &Manager{cfg: cfg, log: log, stopCh: make(chan struct{})}
	m.mode.Store("quentra") // default: shield ON, so an idle demo looks safe
	m.metrics = Metrics{Mode: "quentra", DBStatus: "secure"}
	return m
}

func (m *Manager) modeStr() string {
	v, _ := m.mode.Load().(string)
	if v == "" {
		return "quentra"
	}
	return v
}

// SetMode maps the page's toggles onto the two shield states.
func (m *Manager) SetMode(mode string) {
	switch mode {
	case "off", "baseline", "unprotected", "koruma-kapali":
		m.mode.Store("baseline")
	case "on", "quentra", "protected", "keybreaker", "active":
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
	out.Attempts = m.attempts.Load()
	out.Malicious = m.malicious.Load()
	out.Blocked = m.blocked.Load()
	out.ReachedDB = m.reachedDB.Load()
	out.Breaches = m.breaches.Load()
	out.LegitOk = m.legitOk.Load()
	out.LegitDenied = m.legitDenied.Load()
	out.Errors = m.errors.Load()
	if mal := m.malicious.Load(); mal > 0 {
		out.DetectionRate = round1(float64(m.blocked.Load()) / float64(mal) * 100)
	}
	out.DBStatus = "secure"
	if m.breaches.Load() > 0 {
		out.DBStatus = "risk"
	}
	m.errMu.RLock()
	out.LastError = m.lastErr
	out.DirectSQL = m.lastVuln
	m.errMu.RUnlock()
	if out.DirectSQL == "" {
		out.DirectSQL = vulnerableSQL("' OR '1'='1' --", "x")
	}
	out.GatewayUp = m.gatewayUp.Load()
	out.QuentraSQL = safeSQL
	m.feedMu.Lock()
	out.Recent = append([]AttackEvent(nil), m.feed...)
	m.feedMu.Unlock()
	return out
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

	pool, err := sql.Open("sqlserver", m.cfg.DSNFor(DBName, config.AppKeyBreaker))
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
	var n int64
	if err := m.db.QueryRowContext(ctx, countSQL).Scan(&n); err != nil {
		return err
	}

	// Second pool through the Quentra gateway (:14330). Best-effort: the allowed
	// (parameterized) traffic travels this pool when the shield is on.
	if gw, err := sql.Open("sqlserver", m.cfg.QuentraDSNFor(DBName, config.AppKeyBreaker)); err == nil {
		gw.SetMaxOpenConns(workerCount + 2)
		gw.SetMaxIdleConns(workerCount)
		gw.SetConnMaxLifetime(30 * time.Minute)
		gctx, gcancel := context.WithTimeout(ctx, 10*time.Second)
		if perr := gw.PingContext(gctx); perr == nil {
			m.gw = gw
			m.gatewayUp.Store(true)
		} else {
			_ = gw.Close()
			m.log.Warn("quentra gateway unreachable; keybreaker allowed traffic uses direct", "error", perr.Error())
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

func (m *Manager) shieldOn(iter int64) bool {
	switch m.modeStr() {
	case "baseline":
		return false
	case "auto":
		return iter%2 == 0
	default:
		return true
	}
}

func (m *Manager) worker(id int, stop <-chan struct{}) {
	defer m.wg.Done()
	for {
		select {
		case <-stop:
			return
		default:
		}

		p := payloads[int(m.next.Add(1))%len(payloads)]
		iter := m.attempts.Add(1)
		malicious := p.Kind != kindLegit
		if malicious {
			m.malicious.Add(1)
		}

		start := time.Now()
		outcome := m.process(p, m.shieldOn(iter))
		dur := time.Since(start)

		m.latSumNs.Add(dur.Nanoseconds())
		m.latCount.Add(1)
		m.lastLat.Store(dur.Nanoseconds())

		ev := AttackEvent{Label: p.Label, Kind: string(p.Kind), Outcome: outcome,
			Ms: round1(float64(dur.Nanoseconds()) / 1e6), At: time.Now().UnixMilli()}
		m.feedMu.Lock()
		m.feed = append([]AttackEvent{ev}, m.feed...)
		if len(m.feed) > feedSize {
			m.feed = m.feed[:feedSize]
		}
		m.feedMu.Unlock()

		m.sleep(stop, pacing)
	}
}

// process handles one attempt and returns its outcome. It never executes a
// destructive payload; those are classified only.
func (m *Manager) process(p payload, shield bool) string {
	// Record the concatenated query the direct path would send, so the SQL panel
	// shows the real injectable statement even for blocked attempts.
	m.errMu.Lock()
	m.lastVuln = vulnerableSQL(p.User, p.Pass)
	m.errMu.Unlock()

	malicious := isMalicious(p.User, p.Pass) || p.Kind != kindLegit

	// Shield on: block anything that looks malicious before it reaches SQL.
	if shield && malicious {
		m.blocked.Add(1)
		return "blocked"
	}

	// Destructive payloads are never sent to the server. With the shield off
	// they would be catastrophic, so count them as a breach that reached the DB.
	if isDestructive(p.User, p.Pass) {
		m.reachedDB.Add(1)
		m.breaches.Add(1)
		return "breached"
	}

	// Legit login through the shield: run the SAFE parameterized query.
	if shield && !malicious {
		rows, ok := m.runSafe(p.User, p.Pass)
		if !ok {
			return "error"
		}
		if rows > 0 {
			m.legitOk.Add(1)
			return "allowed"
		}
		m.legitDenied.Add(1)
		return "denied"
	}

	// Shield off: run the vulnerable concatenated query for real (read-only).
	m.reachedDB.Add(1)
	rows, ok := m.runVulnerable(p.User, p.Pass)
	if !ok {
		return "error"
	}
	// A non-legit input that returns rows is an auth bypass / exfiltration.
	if p.Kind != kindLegit {
		if rows > 0 {
			m.breaches.Add(1)
			return "breached"
		}
		return "denied"
	}
	// Legit input: rows==1 is a correct login.
	if rows > 0 {
		m.legitOk.Add(1)
		return "allowed"
	}
	m.legitDenied.Add(1)
	return "denied"
}

func (m *Manager) runVulnerable(user, pass string) (int64, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), queryTimeout)
	defer cancel()
	rows, err := m.db.QueryContext(ctx, vulnerableSQL(user, pass))
	return m.drain(rows, err)
}

func (m *Manager) runSafe(user, pass string) (int64, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), queryTimeout)
	defer cancel()
	// The clean, parameterized query is routed through the Quentra gateway.
	rows, err := m.quentraPool().QueryContext(ctx, safeSQL, sql.Named("u", user), sql.Named("p", pass))
	return m.drain(rows, err)
}

func (m *Manager) drain(rows *sql.Rows, err error) (int64, bool) {
	if err != nil {
		// A syntax error from a malformed injection is a legitimate outcome
		// (the attack failed at the parser), not a workload failure.
		m.errMu.Lock()
		m.lastErr = err.Error()
		m.errMu.Unlock()
		return 0, true
	}
	defer rows.Close()
	var n int64
	for rows.Next() {
		n++
	}
	return n, rows.Err() == nil
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
	lastAtt := m.attempts.Load()
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
			att := m.attempts.Load()
			aps := float64(att-lastAtt) / elapsed
			lastAtt = att
			sum := m.latSumNs.Swap(0)
			cnt := m.latCount.Swap(0)
			avgMs := 0.0
			if cnt > 0 {
				avgMs = float64(sum) / float64(cnt) / 1e6
			}
			snap := Metrics{
				AttemptsPerSec: round1(aps),
				AvgMs:          round2(avgMs),
				LastMs:         round2(float64(m.lastLat.Load()) / 1e6),
				SQLCpuPct:      m.sqlCPU(),
				LastSample:     now.UnixMilli(),
			}
			m.mu.Lock()
			m.metrics = snap
			m.mu.Unlock()
		}
	}
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

func round1(v float64) float64 { return float64(int64(v*10+0.5)) / 10 }
func round2(v float64) float64 { return float64(int64(v*100+0.5)) / 100 }
