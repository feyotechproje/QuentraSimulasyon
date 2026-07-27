// Package reportcache runs the REAL heavy-report workload behind the
// report-cache-simulation demo page.
//
// A single stored procedure — QUENTRA_RETAIL.dbo.SP_REPORT_CACHE_EXAMPLE — is
// the "one heavy report every user runs". It is executed over two connection
// pools that differ ONLY in where they connect:
//
//   - "baseline": straight to SQL Server (DB_SERVER:DB_PORT). Every request is
//     a real execution; nothing is cached on the way.
//   - "quentra":  through the Quentra gateway (QUENTRA_SERVER:QUENTRA_PORT).
//     Quentra decides whether to serve the result from its cache. This process
//     does not cache anything itself — it only sends the request and measures
//     the wall-clock time, so whatever the UI shows is what actually happened.
//
// Because both pools run the identical statement against the identical data,
// the difference in measured latency is attributable to the gateway.
package reportcache

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
	// DBName is the existing database that owns the report procedure. Unlike
	// the vehicle/production workloads this package provisions nothing — the
	// procedure and its data already exist.
	DBName = "QUENTRA_RETAIL"

	// ProcName is the heavy aggregate report driven by this workload.
	ProcName = "QUENTRA_RETAIL.dbo.SP_REPORT_CACHE_EXAMPLE"

	// execSQL is the statement sent down both paths, byte-for-byte identical so
	// the gateway sees exactly the text a real client would send.
	execSQL = "EXEC " + ProcName

	// workerCount is how many concurrent "users" request the report.
	workerCount = 4

	// queryTimeout bounds a single report execution.
	queryTimeout = 120 * time.Second

	// pacing between requests per worker, so a live demo does not saturate the
	// server while still keeping the animation fed.
	pacing = 250 * time.Millisecond
)

// Metrics is the JSON snapshot served to the UI. All timings are REAL measured
// values; nothing here is synthesized.
type Metrics struct {
	Mode        string `json:"mode"`
	Running     bool   `json:"running"`
	Provisioned bool   `json:"provisioned"`

	// Connection targets, surfaced so the UI can prove which path it is on.
	DirectTarget  string `json:"directTarget"`
	QuentraTarget string `json:"quentraTarget"`
	DirectUp      bool   `json:"directUp"`
	QuentraUp     bool   `json:"quentraUp"`

	RequestsTotal  int64   `json:"requestsTotal"`
	RequestsPerSec float64 `json:"requestsPerSec"`
	AvgLatencyMs   float64 `json:"avgLatencyMs"`
	LastLatencyMs  float64 `json:"lastLatencyMs"`
	MinLatencyMs   float64 `json:"minLatencyMs"`
	MaxLatencyMs   float64 `json:"maxLatencyMs"`
	RowsReturned   int64   `json:"rowsReturned"`
	Errors         int64   `json:"errors"`
	LastError      string  `json:"lastError"`

	// Per-path running averages, so both bars can be shown side by side even
	// though only one path is active at a time.
	BaselineAvgMs float64 `json:"baselineAvgMs"`
	QuentraAvgMs  float64 `json:"quentraAvgMs"`
	BaselineRuns  int64   `json:"baselineRuns"`
	QuentraRuns   int64   `json:"quentraRuns"`

	// Real machine/instance load. HostCpuPct is the whole box; SQLCpuPct is the
	// SQL Server process alone. MetricSource names where they came from ("sql"
	// or "windows") so the UI can say so instead of implying a single origin.
	SQLCpuPct    int    `json:"sqlCpuPct"`
	HostCpuPct   int    `json:"hostCpuPct"`
	MemUsedPct   int    `json:"memUsedPct"`
	DiskPct      int    `json:"diskPct"`
	BatchPerSec  int    `json:"batchPerSec"`
	MetricSource string `json:"metricSource"`
	LastSample   int64  `json:"lastSample"`
}

// Manager owns both connection pools and the live metric sampler.
type Manager struct {
	cfg *config.Config
	log *slog.Logger

	direct  *sql.DB // straight to SQL Server
	quentra *sql.DB // through the Quentra gateway

	mode        atomic.Value // string: "baseline" | "quentra"
	running     atomic.Bool
	provisioned atomic.Bool
	directUp    atomic.Bool
	quentraUp   atomic.Bool

	totalRequests atomic.Int64
	totalErrors   atomic.Int64
	totalRows     atomic.Int64
	latSumNs      atomic.Int64
	latCount      atomic.Int64
	lastLatNs     atomic.Int64
	minLatNs      atomic.Int64
	maxLatNs      atomic.Int64

	baseSumNs atomic.Int64
	baseCount atomic.Int64
	quenSumNs atomic.Int64
	quenCount atomic.Int64

	// Previous reading of the cumulative Batch Requests/sec counter, so the
	// sampler can turn it into a rate.
	lastBatchVal atomic.Int64
	lastBatchAt  atomic.Int64

	// Last good host sample. Collection is throttled and can fail, so the
	// sampler reuses this rather than emitting zeros that would read as
	// "the server went idle".
	hostMu   sync.RWMutex
	lastHost hostSample

	errMu   sync.RWMutex
	lastErr string

	mu      sync.RWMutex
	metrics Metrics

	// stopCh is replaced on every Start so the workload can be paused and
	// resumed; chMu guards the swap against a concurrent Pause.
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

// SetMode switches which connection path the workload uses.
func (m *Manager) SetMode(mode string) {
	if mode != "baseline" && mode != "quentra" {
		return
	}
	m.mode.Store(mode)
}

// ResetStats clears the measurement batch without dropping the pools, so the
// UI can start a clean comparison run.
func (m *Manager) ResetStats() {
	m.totalRequests.Store(0)
	m.totalErrors.Store(0)
	m.totalRows.Store(0)
	m.latSumNs.Store(0)
	m.latCount.Store(0)
	m.lastLatNs.Store(0)
	m.minLatNs.Store(0)
	m.maxLatNs.Store(0)
	m.baseSumNs.Store(0)
	m.baseCount.Store(0)
	m.quenSumNs.Store(0)
	m.quenCount.Store(0)
	m.errMu.Lock()
	m.lastErr = ""
	m.errMu.Unlock()
}

// State returns the latest metric snapshot.
func (m *Manager) State() Metrics {
	m.mu.RLock()
	out := m.metrics
	m.mu.RUnlock()
	out.Mode = m.modeStr()
	out.Running = m.running.Load()
	out.Provisioned = m.provisioned.Load()
	out.DirectUp = m.directUp.Load()
	out.QuentraUp = m.quentraUp.Load()
	out.DirectTarget = hostPort(m.cfg.DBServer, m.cfg.DBPort)
	out.QuentraTarget = hostPort(m.cfg.QuentraServer, m.cfg.QuentraPort)
	out.RequestsTotal = m.totalRequests.Load()
	out.Errors = m.totalErrors.Load()
	out.RowsReturned = m.totalRows.Load()
	m.errMu.RLock()
	out.LastError = m.lastErr
	m.errMu.RUnlock()
	return out
}

func hostPort(server, port string) string {
	if port == "" {
		return server
	}
	return server + ":" + port
}

// Provision opens both pools and verifies the report procedure is reachable.
// A failure on the Quentra path is NOT fatal: the baseline path can still run
// and the UI reports the gateway as down.
func (m *Manager) Provision(ctx context.Context) error {
	direct, err := open(m.cfg.DSNFor(DBName, config.AppReportCache))
	if err != nil {
		return err
	}
	if err := direct.PingContext(ctx); err != nil {
		_ = direct.Close()
		return err
	}
	m.direct = direct
	m.directUp.Store(true)

	// Gateway is best-effort — it may not be running.
	if gw, err := open(m.cfg.QuentraDSNFor(DBName, config.AppReportCache)); err == nil {
		if err := gw.PingContext(ctx); err == nil {
			m.quentra = gw
			m.quentraUp.Store(true)
		} else {
			_ = gw.Close()
			m.log.Warn("quentra gateway unreachable; live mode limited to baseline",
				"target", hostPort(m.cfg.QuentraServer, m.cfg.QuentraPort), "error", err.Error())
		}
	}

	// Verify the procedure exists before advertising the workload as ready.
	var ok int
	const q = `SELECT CASE WHEN OBJECT_ID('dbo.SP_REPORT_CACHE_EXAMPLE','P') IS NULL THEN 0 ELSE 1 END`
	if err := m.direct.QueryRowContext(ctx, q).Scan(&ok); err != nil {
		return err
	}
	if ok != 1 {
		m.log.Error("report procedure missing", "proc", ProcName)
		return errProcMissing
	}

	m.provisioned.Store(true)
	return nil
}

func open(dsn string) (*sql.DB, error) {
	pool, err := sql.Open("sqlserver", dsn)
	if err != nil {
		return nil, err
	}
	pool.SetMaxOpenConns(workerCount + 2)
	pool.SetMaxIdleConns(workerCount)
	pool.SetConnMaxLifetime(30 * time.Minute)
	return pool, nil
}

type procMissingErr struct{}

func (procMissingErr) Error() string { return "stored procedure " + ProcName + " not found" }

var errProcMissing = procMissingErr{}

// Start launches the workers and the sampler. It is safe to call repeatedly and
// after Pause: each run gets a fresh stop channel.
func (m *Manager) Start() {
	if !m.provisioned.Load() || m.direct == nil {
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

// Pause halts the workers but keeps both pools open so live mode can resume
// without paying the connection cost again.
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
	if m.direct != nil {
		_ = m.direct.Close()
	}
	if m.quentra != nil {
		_ = m.quentra.Close()
	}
}

// poolFor returns the pool matching the active mode. When the gateway is down
// the baseline pool is used so the demo degrades instead of erroring out.
func (m *Manager) poolFor(mode string) (*sql.DB, string) {
	if mode == "quentra" && m.quentra != nil {
		return m.quentra, "quentra"
	}
	return m.direct, "baseline"
}

func (m *Manager) worker(id int, stop <-chan struct{}) {
	defer m.wg.Done()
	for {
		select {
		case <-stop:
			return
		default:
		}

		mode := m.modeStr()
		pool, used := m.poolFor(mode)
		if pool == nil {
			m.sleep(stop, pacing)
			continue
		}

		ctx, cancel := context.WithTimeout(context.Background(), queryTimeout)
		start := time.Now()
		rows, err := pool.QueryContext(ctx, execSQL)
		var n int64
		if err == nil {
			// Drain the result set: the transfer cost is part of what a real
			// report request pays, so it must be inside the measurement.
			for rows.Next() {
				n++
			}
			err = rows.Err()
			rows.Close()
		}
		dur := time.Since(start)
		cancel()

		if err != nil {
			m.totalErrors.Add(1)
			m.errMu.Lock()
			m.lastErr = err.Error()
			m.errMu.Unlock()
			// The gateway is a separate process and can disappear mid-session.
			// Mark it down so poolFor falls back to the direct connection and
			// the UI can say why, instead of failing every request forever.
			if used == "quentra" {
				m.quentraUp.Store(false)
			}
			m.sleep(stop, 500*time.Millisecond)
			continue
		}

		m.record(used, dur, n)
		m.sleep(stop, pacing)
	}
}

// record folds one measured execution into the counters.
func (m *Manager) record(path string, dur time.Duration, rows int64) {
	ns := dur.Nanoseconds()
	m.totalRequests.Add(1)
	m.totalRows.Add(rows)
	m.latSumNs.Add(ns)
	m.latCount.Add(1)
	m.lastLatNs.Store(ns)

	for {
		cur := m.minLatNs.Load()
		if cur != 0 && cur <= ns {
			break
		}
		if m.minLatNs.CompareAndSwap(cur, ns) {
			break
		}
	}
	for {
		cur := m.maxLatNs.Load()
		if cur >= ns {
			break
		}
		if m.maxLatNs.CompareAndSwap(cur, ns) {
			break
		}
	}

	if path == "quentra" {
		m.quenSumNs.Add(ns)
		m.quenCount.Add(1)
	} else {
		m.baseSumNs.Add(ns)
		m.baseCount.Add(1)
	}
}

func (m *Manager) sleep(stop <-chan struct{}, d time.Duration) {
	select {
	case <-stop:
	case <-time.After(d):
	}
}

// sampler rebuilds the metric snapshot once per second.
func (m *Manager) sampler(stop <-chan struct{}) {
	defer m.wg.Done()
	tick := time.NewTicker(time.Second)
	defer tick.Stop()

	lastReq := m.totalRequests.Load()
	last := time.Now()
	probe := 0

	for {
		select {
		case <-stop:
			return
		case now := <-tick.C:
			elapsed := now.Sub(last).Seconds()
			last = now

			req := m.totalRequests.Load()
			rps := 0.0
			if elapsed > 0 {
				rps = float64(req-lastReq) / elapsed
			}
			lastReq = req

			// Interval average: swap the accumulators so each sample reports the
			// latency of the last second rather than an all-time mean.
			sum := m.latSumNs.Swap(0)
			cnt := m.latCount.Swap(0)
			avgMs := 0.0
			if cnt > 0 {
				avgMs = float64(sum) / float64(cnt) / 1e6
			}

			// Re-probe the gateway every few seconds: it is an independent
			// process, so it can come back after having gone away.
			probe++
			if probe%5 == 0 {
				m.probeQuentra()
			}

			// Host metrics every other tick: the WMI fallback spawns a process,
			// which is far too costly to run at the 1s sampler rate.
			if probe%2 == 0 {
				m.refreshHostMetrics()
			}
			host := m.hostSnapshot()

			snap := Metrics{
				RequestsPerSec: rps,
				AvgLatencyMs:   round1(avgMs),
				LastLatencyMs:  round1(float64(m.lastLatNs.Load()) / 1e6),
				MinLatencyMs:   round1(float64(m.minLatNs.Load()) / 1e6),
				MaxLatencyMs:   round1(float64(m.maxLatNs.Load()) / 1e6),
				BaselineAvgMs:  round1(avgOf(m.baseSumNs.Load(), m.baseCount.Load())),
				QuentraAvgMs:   round1(avgOf(m.quenSumNs.Load(), m.quenCount.Load())),
				BaselineRuns:   m.baseCount.Load(),
				QuentraRuns:    m.quenCount.Load(),
				SQLCpuPct:      maxInt(host.SQLCPUPct, 0),
				HostCpuPct:     maxInt(host.HostCPUPct, 0),
				MemUsedPct:     maxInt(host.MemUsedPct, 0),
				DiskPct:        maxInt(host.DiskPct, 0),
				BatchPerSec:    maxInt(host.BatchPerSec, 0),
				MetricSource:   host.Source,
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

func round1(v float64) float64 {
	return float64(int64(v*10+0.5)) / 10
}

// probeQuentra pings the gateway pool and refreshes the quentraUp flag, so a
// gateway that restarts is picked up again without restarting this process.
func (m *Manager) probeQuentra() {
	if m.quentra == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	m.quentraUp.Store(m.quentra.PingContext(ctx) == nil)
}

// SQL CPU now comes from collectHostMetrics in hostmetrics.go, which reads the
// same ring buffer plus memory/disk and falls back to Windows counters.
