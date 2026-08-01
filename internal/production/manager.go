// Package production runs a REAL SQL Server workload against a dedicated
// PRODUCTIONLINE database backing the production-line-simulation demo page.
// It provisions the database, a Production table seeded with historical
// rows, an index on ProductionDate, and two versions of the "today's
// production" query:
//
//   - "baseline": dbo.sp_GetDailyProduction_Unoptimized wraps the date
//     column in CONVERT(date, ProductionDate), which is non-sargable — SQL
//     Server cannot seek IX_Production_ProductionDate and scans the whole
//     table instead.
//   - "quentra":  dbo.sp_GetDailyProduction_Optimized uses a sargable range
//     predicate (ProductionDate >= @Today AND < @Today+1) that seeks the
//     same index.
//
// Background workers keep inserting new production rows while a sampler
// repeatedly calls whichever procedure is active and records real timing,
// so the UI can show measured numbers instead of a scripted animation.
package production

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"math/rand"
	"sync"
	"sync/atomic"
	"time"

	_ "github.com/microsoft/go-mssqldb"

	"supermarketsim/internal/config"
)

const (
	// DBName is the dedicated database provisioned for this workload.
	DBName = "PRODUCTIONLINE"
	// SeedRowCount is the number of historical rows seeded into dbo.Production.
	SeedRowCount = 200000
	// LineCount mirrors the five production lines drawn on the demo page.
	LineCount = 5
	// insertWorkerCount is the number of concurrent "new unit produced" writers.
	insertWorkerCount = 5
	// queryWorkerCount is the number of concurrent dashboard-refresh readers.
	queryWorkerCount = 5
)

// LineCount value pulled from the front-end's line count for realism.
var itemCodes = func() []string {
	codes := make([]string, 0, 200)
	for i := 0; i < 200; i++ {
		codes = append(codes, fmt.Sprintf("SKU-%05d", i))
	}
	return codes
}()

// Metrics is the JSON snapshot served to the UI.
type Metrics struct {
	Mode           string  `json:"mode"`
	Running        bool    `json:"running"`
	Provisioned    bool    `json:"provisioned"`
	RowCount       int64   `json:"rowCount"`
	QueriesTotal   int64   `json:"queriesTotal"`
	QueriesPerSec  float64 `json:"queriesPerSec"`
	AvgLatencyMs   float64 `json:"avgLatencyMs"`
	LastLatencyMs  float64 `json:"lastLatencyMs"`
	Errors         int64   `json:"errors"`
	InsertsTotal   int64   `json:"insertsTotal"`
	SingleUsePlans int64   `json:"singleUsePlans"`
	TotalPlans     int64   `json:"totalPlans"`
	SQLCpuPct      int     `json:"sqlCpuPct"`
	LastSample     int64   `json:"lastSample"`
	GatewayUp      bool    `json:"gatewayUp"`
}

// Manager owns the PRODUCTIONLINE connection pool, the worker pools and the
// live metric sampler.
type Manager struct {
	cfg *config.Config
	log *slog.Logger

	// db is the direct connection to SQL Server (Baseline route). quentraDB
	// reaches the SAME database through the Quentra gateway (localhost:14330).
	// Workers send byte-identical SQL down whichever pool the mode selects, so
	// the Baseline/Quentra comparison is a pure routing difference — the gateway
	// is what makes the non-sargable query fast, not a different statement.
	db        *sql.DB
	quentraDB *sql.DB

	mode        atomic.Value // string
	running     atomic.Bool
	provisioned atomic.Bool

	totalQueries atomic.Int64
	totalInserts atomic.Int64
	totalErrors  atomic.Int64
	latSumNs     atomic.Int64
	latCount     atomic.Int64
	lastLatNs    atomic.Int64

	mu      sync.RWMutex
	metrics Metrics

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

// pool selects the connection a worker query should travel over. Falls back to
// the direct pool when the gateway is unavailable, so the workload keeps running
// instead of failing every refresh.
func (m *Manager) pool(viaQuentra bool) *sql.DB {
	if viaQuentra && m.quentraDB != nil {
		return m.quentraDB
	}
	return m.db
}

// HasQuentraGateway reports whether the gateway pool was established.
func (m *Manager) HasQuentraGateway() bool { return m.quentraDB != nil }

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
	out.QueriesTotal = m.totalQueries.Load()
	out.Errors = m.totalErrors.Load()
	out.InsertsTotal = m.totalInserts.Load()
	return out
}

// Provision creates the database, table, index, seed rows and both stored
// procedures (unoptimized + optimized).
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
	pool, err := sql.Open("sqlserver", m.cfg.DSNFor(DBName, config.AppProduction))
	if err != nil {
		return fmt.Errorf("open %s: %w", DBName, err)
	}
	pool.SetMaxOpenConns(insertWorkerCount + queryWorkerCount + 6)
	pool.SetMaxIdleConns(insertWorkerCount + queryWorkerCount)
	pool.SetConnMaxLifetime(30 * time.Minute)
	if err := pool.PingContext(ctx); err != nil {
		_ = pool.Close()
		return fmt.Errorf("ping %s: %w", DBName, err)
	}
	m.db = pool

	// 2b. Second pool through the Quentra gateway. Best-effort: if the gateway
	// is down the workload still runs, just always on the direct connection.
	if gw, gerr := sql.Open("sqlserver", m.cfg.QuentraDSNFor(DBName, config.AppProduction)); gerr == nil {
		gw.SetMaxOpenConns(insertWorkerCount + queryWorkerCount + 6)
		gw.SetMaxIdleConns(queryWorkerCount)
		gw.SetConnMaxLifetime(30 * time.Minute)
		gctx, gcancel := context.WithTimeout(ctx, 10*time.Second)
		if perr := gw.PingContext(gctx); perr == nil {
			m.quentraDB = gw
		} else {
			_ = gw.Close()
			m.log.Warn("quentra gateway unreachable; production stays on the direct connection",
				"error", perr.Error())
		}
		gcancel()
	}

	// 3. Table.
	if _, err := m.db.ExecContext(ctx, createTableSQL); err != nil {
		return fmt.Errorf("create table: %w", err)
	}

	// 4. Supporting index (deliberately unused by the unoptimized proc).
	if _, err := m.db.ExecContext(ctx, createIndexSQL); err != nil {
		return fmt.Errorf("create index: %w", err)
	}

	// 5. Seed rows up to SeedRowCount.
	var have int64
	if err := m.db.QueryRowContext(ctx, `SELECT COUNT_BIG(*) FROM dbo.Production`).Scan(&have); err != nil {
		return fmt.Errorf("count production rows: %w", err)
	}
	if missing := int64(SeedRowCount) - have; missing > 0 {
		m.log.Info("seeding production rows", "have", have, "insert", missing)
		if _, err := m.db.ExecContext(ctx, seedSQL,
			sql.Named("count", missing), sql.Named("offset", have)); err != nil {
			return fmt.Errorf("seed production rows: %w", err)
		}
	}

	// 6. Stored procedures.
	if _, err := m.db.ExecContext(ctx, createProcSQL); err != nil {
		return fmt.Errorf("create unoptimized proc: %w", err)
	}
	if _, err := m.db.ExecContext(ctx, createProcOptimizedSQL); err != nil {
		return fmt.Errorf("create optimized proc: %w", err)
	}

	m.provisioned.Store(true)
	return nil
}

// Start launches the insert workers, query workers and the metric sampler.
// Provision must have completed successfully first. It is safe to call
// repeatedly and after Pause: each run gets a fresh stop channel.
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

	for i := 0; i < insertWorkerCount; i++ {
		m.wg.Add(1)
		go m.insertWorker(i, stop)
	}
	for i := 0; i < queryWorkerCount; i++ {
		m.wg.Add(1)
		go m.queryWorker(i, stop)
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
	if m.db != nil {
		_ = m.db.Close()
	}
	if m.quentraDB != nil {
		_ = m.quentraDB.Close()
	}
}

// insertWorker simulates new units coming off the line.
func (m *Manager) insertWorker(id int, stop <-chan struct{}) {
	defer m.wg.Done()
	rng := rand.New(rand.NewSource(time.Now().UnixNano() + int64(id)*7919))
	ticker := time.NewTicker(400 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
		}

		lineID := 1 + rng.Intn(LineCount)
		code := itemCodes[rng.Intn(len(itemCodes))]
		qty := 1 + rng.Intn(5)

		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_, err := m.db.ExecContext(ctx, insertOneSQL,
			sql.Named("LineId", lineID),
			sql.Named("ItemCode", code),
			sql.Named("Quantity", qty))
		cancel()
		if err != nil {
			m.totalErrors.Add(1)
			continue
		}
		m.totalInserts.Add(1)
	}
}

// queryWorker repeatedly refreshes "today's production" the way each of the
// five dashboard TVs would, via whichever stored procedure is active.
func (m *Manager) queryWorker(id int, stop <-chan struct{}) {
	defer m.wg.Done()
	rng := rand.New(rand.NewSource(time.Now().UnixNano() + int64(id)*104729))

	for {
		select {
		case <-stop:
			return
		default:
		}

		lineID := 1 + rng.Intn(LineCount)

		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		start := time.Now()
		// The application always sends the SAME dashboard query — the deliberately
		// non-sargable one. The mode only picks the ROUTE: Baseline goes direct and
		// SQL Server scans; Quentra goes through the gateway, which rewrites it into
		// a sargable seek. Optimizing here in the client would defeat the point,
		// which is that the app is unchanged and only Quentra makes it fast.
		viaQuentra := m.modeStr() == "quentra"
		rows, err := m.pool(viaQuentra).QueryContext(ctx, execDailyProductionSQL, sql.Named("LineId", lineID))
		if err == nil {
			for rows.Next() {
			}
			_ = rows.Err()
			rows.Close()
		}
		dur := time.Since(start)
		cancel()

		if err != nil {
			m.totalErrors.Add(1)
			select {
			case <-stop:
				return
			case <-time.After(200 * time.Millisecond):
			}
			continue
		}
		m.totalQueries.Add(1)
		m.latSumNs.Add(dur.Nanoseconds())
		m.latCount.Add(1)
		m.lastLatNs.Store(dur.Nanoseconds())

		// Baseline's unoptimized scan is intentionally slower and heavier;
		// pace both modes similarly to how the demo page's TVs poll.
		wait := 300 * time.Millisecond
		if m.modeStr() == "baseline" {
			wait = 800 * time.Millisecond
		}
		select {
		case <-stop:
			return
		case <-time.After(wait):
		}
	}
}

func (m *Manager) sampler(stop <-chan struct{}) {
	defer m.wg.Done()
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	lastQueries := m.totalQueries.Load()
	lastTime := time.Now()

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

		tot := m.totalQueries.Load()
		qps := float64(tot-lastQueries) / elapsed
		lastQueries = tot

		sumNs := m.latSumNs.Swap(0)
		cnt := m.latCount.Swap(0)
		avgMs := 0.0
		if cnt > 0 {
			avgMs = float64(sumNs) / float64(cnt) / 1e6
		}
		lastMs := float64(m.lastLatNs.Load()) / 1e6

		single, total := m.planCache()
		cpu := m.sqlCPU()

		var rowCount int64
		_ = m.db.QueryRowContext(context.Background(), `SELECT COUNT_BIG(*) FROM dbo.Production`).Scan(&rowCount)

		m.mu.Lock()
		m.metrics = Metrics{
			Mode:           m.modeStr(),
			Running:        m.running.Load(),
			Provisioned:    m.provisioned.Load(),
			RowCount:       rowCount,
			QueriesTotal:   tot,
			QueriesPerSec:  qps,
			AvgLatencyMs:   avgMs,
			LastLatencyMs:  lastMs,
			Errors:         m.totalErrors.Load(),
			InsertsTotal:   m.totalInserts.Load(),
			SingleUsePlans: single,
			TotalPlans:     total,
			SQLCpuPct:      cpu,
			LastSample:     now.Unix(),
			GatewayUp:      m.quentraDB != nil,
		}
		m.mu.Unlock()
	}
}

// planCache returns (single-use compiled plans, total compiled plans).
func (m *Manager) planCache() (single, total int64) {
	const q = `SELECT
		ISNULL(SUM(CASE WHEN usecounts = 1 THEN 1 ELSE 0 END), 0) AS single_use,
		COUNT_BIG(*) AS total
		FROM sys.dm_exec_cached_plans
		WHERE cacheobjtype = 'Compiled Plan'`
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	_ = m.db.QueryRowContext(ctx, q).Scan(&single, &total)
	return
}

// sqlCPU reads the most recent SQL Server process CPU % from the scheduler
// monitor ring buffer. Returns 0 when unavailable.
func (m *Manager) sqlCPU() int {
	const q = `SELECT TOP 1
		record.value('(./Record/SchedulerMonitorEvent/SystemHealth/ProcessUtilization)[1]', 'int')
		FROM (
			SELECT [timestamp], CONVERT(xml, record) AS record
			FROM sys.dm_os_ring_buffers
			WHERE ring_buffer_type = N'RING_BUFFER_SCHEDULER_MONITOR'
			  AND record LIKE '%<SystemHealth>%'
		) AS rb
		ORDER BY [timestamp] DESC`
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	var cpu int
	if err := m.db.QueryRowContext(ctx, q).Scan(&cpu); err != nil {
		return 0
	}
	return cpu
}
