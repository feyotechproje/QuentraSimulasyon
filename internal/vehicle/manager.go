// Package vehicle runs a REAL SQL Server workload against a dedicated
// VEHICLEGPS database. It provisions the database, a 100,000-row Vehicles
// table and the sp_UpdateVehicleState stored procedure, then continuously
// performs live position UPDATEs in one of two modes:
//
//   - "baseline": ad-hoc UPDATE statements with concatenated literals. Every
//     statement text is unique, so SQL Server compiles a brand-new single-use
//     plan each time — plan-cache bloat and constant compilations.
//   - "quentra":  the exact same workload routed through the cached stored
//     procedure sp_UpdateVehicleState. One plan is compiled and reused for
//     every update — near-zero compilations, stable plan cache.
//
// Real metrics (updates/sec, latency, single-use plans, compilations/sec, SQL
// CPU) are sampled from SQL Server DMVs so the UI shows measured numbers, not
// a scripted animation.
package vehicle

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"math/rand"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	_ "github.com/microsoft/go-mssqldb"

	"supermarketsim/internal/config"
)

const (
	// DBName is the dedicated database provisioned for this workload.
	DBName = "VEHICLEGPS"
	// VehicleCount is the number of vehicle rows seeded into dbo.Vehicles.
	VehicleCount = 100000
	// workerCount is the number of concurrent update workers.
	workerCount = 12
)

// Metrics is the JSON snapshot served to the UI.
type Metrics struct {
	Mode               string  `json:"mode"`
	Running            bool    `json:"running"`
	Provisioned        bool    `json:"provisioned"`
	VehicleCount       int64   `json:"vehicleCount"`
	UpdatesTotal       int64   `json:"updatesTotal"`
	UpdatesPerSec      float64 `json:"updatesPerSec"`
	AvgLatencyMs       float64 `json:"avgLatencyMs"`
	Errors             int64   `json:"errors"`
	SingleUsePlans     int64   `json:"singleUsePlans"`
	TotalPlans         int64   `json:"totalPlans"`
	PlanCacheMB        float64 `json:"planCacheMB"`
	CompilationsPerSec float64 `json:"compilationsPerSec"`
	RecompilesPerSec   float64 `json:"recompilesPerSec"`
	BatchReqPerSec     float64 `json:"batchReqPerSec"`
	SQLCpuPct          int     `json:"sqlCpuPct"`
	// Real server state, replacing figures the UI used to simulate. Zero means
	// "not readable" rather than a measured zero.
	SQLMemoryPct   int `json:"sqlMemoryPct"`
	ActiveRequests int `json:"activeRequests"`
	QueuedRequests int `json:"queuedRequests"`
	// Sessions waiting on plan compilation — the real "compilation queue".
	CompileWaiters int `json:"compileWaiters"`
	// False when the gateway is unreachable: Quentra mode then runs on the
	// direct connection, so the UI must not present it as a routed comparison.
	GatewayUp bool `json:"gatewayUp"`
	LastSample         int64   `json:"lastSample"`
}

// Manager owns the VEHICLEGPS connection pool, the worker pool and the live
// metric sampler.
type Manager struct {
	cfg *config.Config
	log *slog.Logger

	db *sql.DB
	// quentraDB reaches the same database through the Quentra gateway. Workers
	// send byte-identical SQL down whichever pool the current mode selects, so
	// the baseline/Quentra comparison is a routing difference, nothing else.
	// nil when the gateway was unreachable at provision time.
	quentraDB *sql.DB

	mode        atomic.Value // string
	running     atomic.Bool
	provisioned atomic.Bool

	totalUpdates atomic.Int64
	totalErrors  atomic.Int64
	latSumNs     atomic.Int64
	latCount     atomic.Int64

	mu      sync.RWMutex
	metrics Metrics

	// Previous worker-CPU reading, used to turn the cumulative counter into a
	// rate. Only touched from the sampler goroutine, so no lock is needed.
	cpuPrevMs    int64
	cpuPrevAt    time.Time
	cpuErrLogged bool

	// stopCh is replaced on every Start so the workload can be paused and
	// resumed from the portal; chMu guards the swap against a concurrent Pause.
	chMu   sync.Mutex
	stopCh chan struct{}
	wg     sync.WaitGroup
}

// NewManager creates an un-provisioned manager. Call Provision then Start.
func NewManager(cfg *config.Config, log *slog.Logger) *Manager {
	m := &Manager{
		cfg:    cfg,
		log:    log,
		stopCh: make(chan struct{}),
	}
	m.mode.Store("baseline")
	m.metrics = Metrics{Mode: "baseline", VehicleCount: VehicleCount}
	return m
}

// pool selects the connection a worker query should travel over. Falls back to
// the direct pool when the gateway is unavailable, so the workload keeps running
// instead of failing every update.
func (m *Manager) pool(viaQuentra bool) *sql.DB {
	if viaQuentra && m.quentraDB != nil {
		return m.quentraDB
	}
	return m.db
}

// HasQuentraGateway reports whether the gateway pool was established.
func (m *Manager) HasQuentraGateway() bool { return m.quentraDB != nil }

func (m *Manager) modeStr() string {
	v, _ := m.mode.Load().(string)
	if v == "" {
		return "baseline"
	}
	return v
}

// SetMode switches the active workload profile.
func (m *Manager) SetMode(mode string) {
	if mode != "baseline" && mode != "quentra" {
		return
	}
	m.mode.Store(mode)
}

// State returns the latest metric snapshot.
func (m *Manager) State() Metrics {
	m.mu.RLock()
	out := m.metrics
	m.mu.RUnlock()
	out.Mode = m.modeStr()
	out.Running = m.running.Load()
	out.Provisioned = m.provisioned.Load()
	out.UpdatesTotal = m.totalUpdates.Load()
	out.Errors = m.totalErrors.Load()
	return out
}

// Provision creates the database, table, 100k rows and stored procedure.
func (m *Manager) Provision(ctx context.Context) error {
	// 1. Ensure the database exists (connect to master).
	master, err := sql.Open("sqlserver", m.cfg.DSNFor("master", config.AppSetup))
	if err != nil {
		return fmt.Errorf("open master: %w", err)
	}
	if _, err := master.ExecContext(ctx,
		`IF DB_ID(N'`+DBName+`') IS NULL CREATE DATABASE [`+DBName+`];`); err != nil {
		_ = master.Close()
		return fmt.Errorf("create database: %w", err)
	}
	_ = master.Close()

	// 2. Connect to the workload database.
	pool, err := sql.Open("sqlserver", m.cfg.DSNFor(DBName, config.AppVehicle))
	if err != nil {
		return fmt.Errorf("open %s: %w", DBName, err)
	}
	pool.SetMaxOpenConns(workerCount + 6)
	pool.SetMaxIdleConns(workerCount)
	pool.SetConnMaxLifetime(30 * time.Minute)
	if err := pool.PingContext(ctx); err != nil {
		_ = pool.Close()
		return fmt.Errorf("ping %s: %w", DBName, err)
	}
	m.db = pool

	// 2b. Second pool through the Quentra gateway. Best-effort: if the gateway
	// is down the workload still runs, just always on the direct connection.
	if gw, gerr := sql.Open("sqlserver", m.cfg.QuentraDSNFor(DBName, config.AppVehicle)); gerr == nil {
		gw.SetMaxOpenConns(workerCount + 6)
		gw.SetMaxIdleConns(workerCount)
		gw.SetConnMaxLifetime(30 * time.Minute)
		gctx, gcancel := context.WithTimeout(ctx, 10*time.Second)
		if perr := gw.PingContext(gctx); perr == nil {
			m.quentraDB = gw
		} else {
			_ = gw.Close()
			m.log.Warn("quentra gateway unreachable; vehicle stays on the direct connection",
				"error", perr.Error())
		}
		gcancel()
	}

	// 3. Table.
	if _, err := m.db.ExecContext(ctx, createTableSQL); err != nil {
		return fmt.Errorf("create table: %w", err)
	}

	// 4. Seed rows up to VehicleCount.
	var have int64
	if err := m.db.QueryRowContext(ctx, `SELECT COUNT_BIG(*) FROM dbo.Vehicles`).Scan(&have); err != nil {
		return fmt.Errorf("count vehicles: %w", err)
	}
	if missing := int64(VehicleCount) - have; missing > 0 {
		m.log.Info("seeding vehicles", "have", have, "insert", missing)
		if _, err := m.db.ExecContext(ctx, seedSQL,
			sql.Named("count", missing), sql.Named("offset", have)); err != nil {
			return fmt.Errorf("seed vehicles: %w", err)
		}
	}

	// 5. Stored procedure.
	if _, err := m.db.ExecContext(ctx, createProcSQL); err != nil {
		return fmt.Errorf("create proc: %w", err)
	}

	m.provisioned.Store(true)
	return nil
}

// Start launches the worker pool and the metric sampler. Provision must have
// completed successfully first. It is safe to call repeatedly and after Pause:
// each run gets a fresh stop channel.
func (m *Manager) Start() {
	if !m.provisioned.Load() || m.db == nil {
		return
	}
	if m.running.Swap(true) {
		return // already running
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

// Pause halts the workers but keeps the pool open so the workload can be
// restarted from the portal without paying the connection cost again.
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

// Stop halts workers and closes the pool. Called on shutdown.
func (m *Manager) Stop() {
	m.Pause()
	if m.quentraDB != nil {
		_ = m.quentraDB.Close()
	}
	if m.db != nil {
		_ = m.db.Close()
	}
}

func (m *Manager) worker(id int, stop <-chan struct{}) {
	defer m.wg.Done()
	rng := rand.New(rand.NewSource(time.Now().UnixNano() + int64(id)*7919))
	for {
		select {
		case <-stop:
			return
		default:
		}

		vid := rng.Intn(VehicleCount) + 1
		lat := 41.0 + rng.Float64()*0.12
		lng := 28.9 + rng.Float64()*0.16
		speed := rng.Intn(120)
		heading := rng.Intn(360)

		// The application always sends the SAME ad-hoc UPDATE: concatenated
		// literals plus a unique marker, so the statement text is never
		// identical and SQL Server must compile a fresh plan every time.
		//
		// The mode only picks the ROUTE. Direct means that ad-hoc storm reaches
		// SQL Server as-is; Quentra means the gateway rewrites it into the
		// stored procedure on the way. Rewriting here in the client would make
		// the comparison meaningless — the point is that the app is unchanged.
		q := fmt.Sprintf(
			"UPDATE dbo.Vehicles SET Lat=%.6f, Lng=%.6f, Speed=%d, Heading=%d, LastUpdate=SYSUTCDATETIME() WHERE VehicleId=%d; /*adhoc-%d-%d*/",
			lat, lng, speed, heading, vid, id, time.Now().UnixNano())

		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		start := time.Now()
		_, err := m.pool(m.modeStr() == "quentra").ExecContext(ctx, q)
		dur := time.Since(start)
		cancel()

		if err != nil {
			n := m.totalErrors.Add(1)
			// Log the first failure and then sparsely: a silent counter gives no
			// way to tell a gateway problem from a transient timeout.
			if n == 1 || n%500 == 0 {
				m.log.Warn("vehicle update failed",
					"count", n, "mode", m.modeStr(), "error", err.Error())
			}
			select {
			case <-stop:
				return
			case <-time.After(200 * time.Millisecond):
			}
			continue
		}
		m.totalUpdates.Add(1)
		m.latSumNs.Add(dur.Nanoseconds())
		m.latCount.Add(1)
	}
}

func (m *Manager) sampler(stop <-chan struct{}) {
	defer m.wg.Done()
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	lastUpdates := m.totalUpdates.Load()
	lastTime := time.Now()
	comp0, batch0, recomp0, haveCounters := m.perfCounters()

	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
		}

		now := time.Now()
		elapsed := now.Sub(lastTime).Seconds()
		if elapsed <= 0 {
			elapsed = 1
		}
		lastTime = now

		tot := m.totalUpdates.Load()
		ups := float64(tot-lastUpdates) / elapsed
		lastUpdates = tot

		sumNs := m.latSumNs.Swap(0)
		cnt := m.latCount.Swap(0)
		avgMs := 0.0
		if cnt > 0 {
			avgMs = float64(sumNs) / float64(cnt) / 1e6
		}

		single, total, mb := m.planCache()
		comp, batch, recomp, ok := m.perfCounters()
		var compSec, batchSec, recompSec float64
		if ok && haveCounters {
			compSec = float64(comp-comp0) / elapsed
			batchSec = float64(batch-batch0) / elapsed
			recompSec = float64(recomp-recomp0) / elapsed
		}
		if ok {
			comp0, batch0, recomp0, haveCounters = comp, batch, recomp, true
		}
		cpu := m.sqlCPU()
		memPct := m.memoryPct()
		activeReq, queuedReq := m.concurrency()
		compWait := m.compileWaiters()

		m.mu.Lock()
		m.metrics = Metrics{
			Mode:               m.modeStr(),
			Running:            m.running.Load(),
			Provisioned:        m.provisioned.Load(),
			VehicleCount:       VehicleCount,
			UpdatesTotal:       tot,
			UpdatesPerSec:      ups,
			AvgLatencyMs:       avgMs,
			Errors:             m.totalErrors.Load(),
			SingleUsePlans:     single,
			TotalPlans:         total,
			PlanCacheMB:        mb,
			CompilationsPerSec: compSec,
			RecompilesPerSec:   recompSec,
			BatchReqPerSec:     batchSec,
			SQLCpuPct:          cpu,
			SQLMemoryPct:       memPct,
			ActiveRequests:     activeReq,
			QueuedRequests:     queuedReq,
			CompileWaiters:     compWait,
			GatewayUp:          m.quentraDB != nil,
			LastSample:         now.Unix(),
		}
		m.mu.Unlock()
	}
}

// planCache returns (single-use compiled plans, total compiled plans, MB).
func (m *Manager) planCache() (single, total int64, mb float64) {
	const q = `SELECT
		ISNULL(SUM(CASE WHEN usecounts = 1 THEN 1 ELSE 0 END), 0) AS single_use,
		COUNT_BIG(*) AS total,
		CAST(ISNULL(SUM(size_in_bytes), 0) / 1048576.0 AS FLOAT) AS mb
		FROM sys.dm_exec_cached_plans
		WHERE cacheobjtype = 'Compiled Plan'`
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	_ = m.db.QueryRowContext(ctx, q).Scan(&single, &total, &mb)
	return
}

// perfCounters reads cumulative SQL Statistics counters.
func (m *Manager) perfCounters() (comp, batch, recomp int64, ok bool) {
	const q = `SELECT counter_name, cntr_value
		FROM sys.dm_os_performance_counters
		WHERE object_name LIKE '%SQL Statistics%'
		  AND counter_name IN ('SQL Compilations/sec','Batch Requests/sec','SQL Re-Compilations/sec')`
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	rows, err := m.db.QueryContext(ctx, q)
	if err != nil {
		return 0, 0, 0, false
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		var val int64
		if err := rows.Scan(&name, &val); err != nil {
			return 0, 0, 0, false
		}
		switch strings.TrimSpace(name) {
		case "SQL Compilations/sec":
			comp = val
		case "Batch Requests/sec":
			batch = val
		case "SQL Re-Compilations/sec":
			recomp = val
		}
	}
	return comp, batch, recomp, rows.Err() == nil
}

// memoryPct reports how much of SQL Server's memory target is actually
// committed. Returns 0 when the counters are unavailable, so the UI can tell
// "no reading" apart from a genuine zero.
func (m *Manager) memoryPct() int {
	const q = `SELECT
		CONVERT(int, ROUND(100.0 *
			MAX(CASE WHEN counter_name = 'Total Server Memory (KB)'  THEN cntr_value END) /
			NULLIF(MAX(CASE WHEN counter_name = 'Target Server Memory (KB)' THEN cntr_value END), 0), 0))
		FROM sys.dm_os_performance_counters
		WHERE counter_name IN ('Total Server Memory (KB)', 'Target Server Memory (KB)')`
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	var pct sql.NullInt64
	if err := m.db.QueryRowContext(ctx, q).Scan(&pct); err != nil || !pct.Valid {
		return 0
	}
	return int(pct.Int64)
}

// concurrency reports what SQL Server is doing right now: requests actively
// running, and requests waiting on a resource. These replace the previously
// simulated "active updates" / "query queue" figures.
func (m *Manager) concurrency() (active, queued int) {
	const q = `SELECT
		SUM(CASE WHEN r.status = 'running' OR r.status = 'runnable' THEN 1 ELSE 0 END),
		SUM(CASE WHEN r.status = 'suspended' THEN 1 ELSE 0 END)
		FROM sys.dm_exec_requests r
		WHERE r.session_id <> @@SPID`
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	var a, s sql.NullInt64
	if err := m.db.QueryRowContext(ctx, q).Scan(&a, &s); err != nil {
		return 0, 0
	}
	return int(a.Int64), int(s.Int64)
}

// compileWaiters counts sessions currently blocked getting a plan compiled.
// SQL Server has no "compilation queue" counter, but the compile-gateway waits
// are exactly that: requests queued behind plan compilation. This is what the
// ad-hoc storm produces and what the rewrite eliminates.
func (m *Manager) compileWaiters() int {
	const q = `SELECT COUNT(*)
		FROM sys.dm_os_waiting_tasks
		WHERE wait_type LIKE 'RESOURCE_SEMAPHORE_QUERY_COMPILE%'
		   OR wait_type LIKE 'CMEMTHREAD%'`
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	var n sql.NullInt64
	if err := m.db.QueryRowContext(ctx, q).Scan(&n); err != nil {
		return 0
	}
	return int(n.Int64)
}

// sqlCPU returns SQL Server's CPU usage as a percentage of the machine's
// scheduler capacity.
//
// It deliberately does NOT use RING_BUFFER_SCHEDULER_MONITOR: that ring buffer
// only gains a record once a MINUTE, so a per-second sampler reads the same
// value ~60 times and the figure looks frozen. Instead this accumulates worker
// CPU time and divides the delta by wall-clock time across the online
// schedulers, which moves on every sample.
func (m *Manager) sqlCPU() int {
	// total_cpu_usage_ms lives on dm_os_schedulers; dm_os_workers has no such
	// column, and querying it fails outright rather than returning zero.
	const q = `SELECT
		ISNULL(SUM(total_cpu_usage_ms), 0),
		COUNT(*)
		FROM sys.dm_os_schedulers
		WHERE status = 'VISIBLE ONLINE' AND is_online = 1`
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()

	var cpuMs, schedulers int64
	if err := m.db.QueryRowContext(ctx, q).Scan(&cpuMs, &schedulers); err != nil {
		// Log once: a silent 0 here previously hid a wrong column name for a
		// long time, and a flat-zero CPU reads as "idle" rather than "broken".
		if !m.cpuErrLogged {
			m.cpuErrLogged = true
			m.log.Warn("sql cpu sample failed", "error", err.Error())
		}
		return 0
	}
	now := time.Now()
	if schedulers < 1 {
		schedulers = 1
	}

	prevMs, prevAt := m.cpuPrevMs, m.cpuPrevAt
	m.cpuPrevMs, m.cpuPrevAt = cpuMs, now
	if prevAt.IsZero() || cpuMs < prevMs {
		return 0 // first sample, or counters reset: no delta to report yet
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
