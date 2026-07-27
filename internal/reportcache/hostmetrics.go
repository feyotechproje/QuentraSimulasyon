package reportcache

import (
	"context"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// hostSample is one reading of the machine/instance load shown on the demo's
// "SQL LOAD" gauges. Every field is a real measurement; a field left at -1 is
// "not available from this source" and the caller keeps the previous value
// rather than drawing a fabricated number.
type hostSample struct {
	SQLCPUPct   int // CPU consumed by the SQL Server process
	HostCPUPct  int // CPU across the whole machine (SQL + everything else)
	MemUsedPct  int
	DiskPct     int // read/write pressure, normalized to 0..100
	BatchPerSec int
	Source      string // "sql" | "windows" | "" (nothing available)
}

// collectHostMetrics gathers live load metrics, preferring SQL Server's own
// DMVs and falling back to Windows performance counters.
//
// SQL is preferred because these gauges sit beside SQL latency numbers: the
// instance's own view of CPU and memory is what explains those latencies. The
// Windows counters describe the whole box, which is the right answer only when
// the DMVs are unreadable (restricted login, or the gateway host is not the
// SQL host).
func (m *Manager) collectHostMetrics() hostSample {
	s := hostSample{SQLCPUPct: -1, HostCPUPct: -1, MemUsedPct: -1, DiskPct: -1, BatchPerSec: -1}

	if m.sqlHostMetrics(&s) {
		s.Source = "sql"
		// Memory is the one value the ring buffer does not carry; fill just that
		// gap from Windows rather than discarding the whole SQL sample.
		if s.MemUsedPct < 0 {
			if w := windowsMetrics(); w.MemUsedPct >= 0 {
				s.MemUsedPct = w.MemUsedPct
			}
		}
		return s
	}

	w := windowsMetrics()
	if w.HostCPUPct >= 0 || w.MemUsedPct >= 0 {
		w.Source = "windows"
		return w
	}
	return s
}

// sqlHostMetrics fills the sample from SQL Server DMVs. Reports whether the
// instance answered at all, so the caller knows to fall back.
//
// Each DMV is queried independently: a login permitted to read the ring buffer
// but not the performance counters should still yield CPU rather than nothing.
func (m *Manager) sqlHostMetrics(s *hostSample) bool {
	if m.direct == nil {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()

	// CPU: the scheduler-monitor ring buffer reports SQL's own utilization and
	// the idle share in the same record, so total host CPU comes free.
	const cpuQ = `SELECT TOP 1
			record.value('(./Record/SchedulerMonitorEvent/SystemHealth/ProcessUtilization)[1]','int'),
			record.value('(./Record/SchedulerMonitorEvent/SystemHealth/SystemIdle)[1]','int')
		FROM (
			SELECT timestamp, CONVERT(xml, record) AS record
			FROM sys.dm_os_ring_buffers
			WHERE ring_buffer_type = N'RING_BUFFER_SCHEDULER_MONITOR'
			  AND record LIKE '%<SystemHealth>%'
		) AS x
		ORDER BY timestamp DESC`

	ok := false
	var sqlCPU, idle int
	if err := m.direct.QueryRowContext(ctx, cpuQ).Scan(&sqlCPU, &idle); err == nil {
		s.SQLCPUPct = clampPct(sqlCPU)
		s.HostCPUPct = clampPct(100 - idle)
		ok = true
	}

	// Memory: buffer pool actually committed against its target. This is the
	// number that moves when a heavy report churns the cache.
	const memQ = `SELECT CONVERT(int,
			100.0 * (SELECT CONVERT(bigint, cntr_value) FROM sys.dm_os_performance_counters
			         WHERE counter_name = 'Total Server Memory (KB)')
			      / NULLIF((SELECT CONVERT(bigint, cntr_value) FROM sys.dm_os_performance_counters
			         WHERE counter_name = 'Target Server Memory (KB)'), 0))`
	var mem int
	if err := m.direct.QueryRowContext(ctx, memQ).Scan(&mem); err == nil {
		s.MemUsedPct = clampPct(mem)
		ok = true
	}

	// Disk: pending IO across all files. Normalized because the raw count has no
	// natural ceiling; what the gauge needs to show is pressure, not a rate.
	const diskQ = `SELECT ISNULL(SUM(io_pending), 0) FROM sys.dm_io_pending_io_requests`
	var pending int
	if err := m.direct.QueryRowContext(ctx, diskQ).Scan(&pending); err == nil {
		s.DiskPct = clampPct(pending * 5)
		ok = true
	}

	// Batch requests/sec is a cumulative counter; the caller turns successive
	// readings into a rate.
	const batchQ = `SELECT CONVERT(bigint, cntr_value) FROM sys.dm_os_performance_counters
		WHERE counter_name = 'Batch Requests/sec'`
	var batch int64
	if err := m.direct.QueryRowContext(ctx, batchQ).Scan(&batch); err == nil {
		s.BatchPerSec = int(m.batchRate(batch))
		ok = true
	}

	return ok
}

// batchRate converts the cumulative Batch Requests/sec counter into a per-second
// rate using the previous reading. The first call has no baseline and returns 0.
func (m *Manager) batchRate(total int64) float64 {
	now := time.Now()
	prev := m.lastBatchVal.Swap(total)
	prevAt := m.lastBatchAt.Swap(now.UnixMilli())
	if prev == 0 || prevAt == 0 {
		return 0
	}
	elapsed := float64(now.UnixMilli()-prevAt) / 1000
	if elapsed <= 0 {
		return 0
	}
	d := float64(total - prev)
	if d < 0 {
		return 0 // counter reset (instance restart)
	}
	return d / elapsed
}

// windowsMetrics reads whole-machine counters via WMI. Used when the SQL DMVs
// are unavailable, and to fill in memory when the ring buffer alone answered.
//
// Returns -1 fields on any failure — a demo must never invent load figures, and
// the sampler keeps the last good sample instead.
func windowsMetrics() hostSample {
	s := hostSample{SQLCPUPct: -1, HostCPUPct: -1, MemUsedPct: -1, DiskPct: -1, BatchPerSec: -1}
	if runtime.GOOS != "windows" {
		return s
	}

	// One PowerShell invocation for all counters: spawning a process per gauge
	// would cost more than the numbers are worth at a 1s sample interval.
	const ps = `$os = Get-CimInstance Win32_OperatingSystem;` +
		`$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average;` +
		`$mem = 100 - [math]::Round(($os.FreePhysicalMemory / $os.TotalVisibleMemorySize) * 100);` +
		`$disk = (Get-CimInstance Win32_PerfFormattedData_PerfDisk_LogicalDisk | ` +
		`Where-Object { $_.Name -eq '_Total' } | Select-Object -First 1).PercentDiskTime;` +
		`Write-Output "$cpu|$mem|$disk"`

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps)
	out, err := cmd.Output()
	if err != nil {
		return s
	}

	parts := strings.Split(strings.TrimSpace(string(out)), "|")
	if len(parts) != 3 {
		return s
	}
	if v, err := strconv.Atoi(strings.TrimSpace(parts[0])); err == nil {
		s.HostCPUPct = clampPct(v)
	}
	if v, err := strconv.Atoi(strings.TrimSpace(parts[1])); err == nil {
		s.MemUsedPct = clampPct(v)
	}
	if v, err := strconv.Atoi(strings.TrimSpace(parts[2])); err == nil {
		s.DiskPct = clampPct(v)
	}
	return s
}

// refreshHostMetrics collects a fresh sample and keeps it, merging field-wise
// so a source that answered last tick but not this one does not blank a gauge.
func (m *Manager) refreshHostMetrics() {
	s := m.collectHostMetrics()

	m.hostMu.Lock()
	defer m.hostMu.Unlock()
	prev := m.lastHost
	if s.SQLCPUPct < 0 {
		s.SQLCPUPct = prev.SQLCPUPct
	}
	if s.HostCPUPct < 0 {
		s.HostCPUPct = prev.HostCPUPct
	}
	if s.MemUsedPct < 0 {
		s.MemUsedPct = prev.MemUsedPct
	}
	if s.DiskPct < 0 {
		s.DiskPct = prev.DiskPct
	}
	if s.BatchPerSec < 0 {
		s.BatchPerSec = prev.BatchPerSec
	}
	if s.Source == "" {
		s.Source = prev.Source
	}
	m.lastHost = s
}

// hostSnapshot returns the last collected sample.
func (m *Manager) hostSnapshot() hostSample {
	m.hostMu.RLock()
	defer m.hostMu.RUnlock()
	return m.lastHost
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func clampPct(v int) int {
	if v < 0 {
		return 0
	}
	if v > 100 {
		return 100
	}
	return v
}
