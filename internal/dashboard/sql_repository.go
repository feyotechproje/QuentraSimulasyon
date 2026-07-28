package dashboard

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	_ "github.com/microsoft/go-mssqldb"

	"supermarketsim/internal/config"
)

const (
	DatabaseName = "SALES50M"
	salesTable   = "dbo.SALES"
)

// dashboardSQL reads every visible dashboard component from SALES50M. Both
// connection paths execute this byte-identical batch; only the pool changes.
// The optional master filter intentionally stays inside the statement so a
// refresh represents the real cost of rebuilding the whole dashboard.
const dashboardSQL = `SET NOCOUNT ON;
DECLARE @filter varchar(64) = NULLIF(LTRIM(RTRIM(@region)), '');

SELECT
    COALESCE(SUM(ISNULL(TOTALPRICE, 0)), 0) AS TotalSales,
    COUNT(DISTINCT ORDERID) AS TotalOrders,
    COUNT(DISTINCT USERID) AS Customers,
    COALESCE(CAST(ROUND(SUM(ISNULL(AMOUNT, 0)), 0) AS bigint), 0) AS ItemsSold,
    COUNT(DISTINCT CITY) AS ActiveCities
FROM dbo.SALES
WHERE @filter IS NULL OR REGION = @filter;

SELECT REGION, SUM(ISNULL(TOTALPRICE, 0)) AS Sales, COUNT(DISTINCT ORDERID) AS Orders
FROM dbo.SALES
WHERE (@filter IS NULL OR REGION = @filter) AND REGION IS NOT NULL
GROUP BY REGION
ORDER BY Sales DESC;

SELECT DATEPART(MONTH, DATE_) AS MonthNo, SUM(ISNULL(TOTALPRICE, 0)) AS Sales
FROM dbo.SALES
WHERE (@filter IS NULL OR REGION = @filter) AND DATE_ IS NOT NULL
GROUP BY DATEPART(MONTH, DATE_)
ORDER BY MonthNo;

SELECT TOP (6) COALESCE(NULLIF(CATEGORY1, ''), 'Diğer') AS Category,
       SUM(ISNULL(TOTALPRICE, 0)) AS Sales
FROM dbo.SALES
WHERE @filter IS NULL OR REGION = @filter
GROUP BY COALESCE(NULLIF(CATEGORY1, ''), 'Diğer')
ORDER BY Sales DESC;

SELECT TOP (6) CITY, SUM(ISNULL(TOTALPRICE, 0)) AS Sales,
       COUNT(DISTINCT ORDERID) AS Orders
FROM dbo.SALES
WHERE @filter IS NULL OR REGION = @filter
GROUP BY CITY
ORDER BY Sales DESC;

SELECT TOP (12) DATEPART(YEAR, DATE_) AS YearNo, DATEPART(MONTH, DATE_) AS MonthNo,
       COUNT(DISTINCT ORDERID) AS Orders
FROM dbo.SALES
WHERE (@filter IS NULL OR REGION = @filter) AND DATE_ IS NOT NULL
GROUP BY DATEPART(YEAR, DATE_), DATEPART(MONTH, DATE_)
ORDER BY YearNo DESC, MonthNo DESC;

SELECT TOP (5) COALESCE(NULLIF(ITEMNAME, ''), ITEMCODE, 'Ürün') AS ItemName,
       COALESCE(NULLIF(BRAND, ''), '—') AS Brand,
       COALESCE(CAST(ROUND(SUM(ISNULL(AMOUNT, 0)), 0) AS bigint), 0) AS Quantity,
       SUM(ISNULL(TOTALPRICE, 0)) AS Revenue
FROM dbo.SALES
WHERE @filter IS NULL OR REGION = @filter
GROUP BY COALESCE(NULLIF(ITEMNAME, ''), ITEMCODE, 'Ürün'), COALESCE(NULLIF(BRAND, ''), '—')
ORDER BY Revenue DESC;

SELECT COALESCE(NULLIF(USERGENDER, ''), 'B') AS Gender,
       COUNT(DISTINCT USERID) AS CustomerCount,
       SUM(ISNULL(TOTALPRICE, 0)) AS Sales
FROM dbo.SALES
WHERE @filter IS NULL OR REGION = @filter
GROUP BY COALESCE(NULLIF(USERGENDER, ''), 'B')
ORDER BY Sales DESC;`

// cachedDashboardSQL serves the unfiltered landing dashboard from the
// pre-aggregated dbo.SALES_DASH_* summary tables instead of re-scanning the
// 51M-row dbo.SALES columnstore. Result-set order and column order are
// byte-identical to dashboardSQL, so readDashboard scans it unchanged. The
// summaries are rebuilt by refreshDashboardCache; a cold read from these few
// hundred rows returns in milliseconds instead of ~33s.
const cachedDashboardSQL = `SET NOCOUNT ON;
SELECT TotalSales, TotalOrders, Customers, ItemsSold, ActiveCities FROM dbo.SALES_DASH_KPI;
SELECT REGION, Sales, Orders FROM dbo.SALES_DASH_REGION ORDER BY Sales DESC;
SELECT MonthNo, Sales FROM dbo.SALES_DASH_MONTH ORDER BY MonthNo;
SELECT TOP (6) Category, Sales FROM dbo.SALES_DASH_CATEGORY ORDER BY Sales DESC;
SELECT TOP (6) CITY, Sales, Orders FROM dbo.SALES_DASH_CITY ORDER BY Sales DESC;
SELECT TOP (12) YearNo, MonthNo, Orders FROM dbo.SALES_DASH_TREND ORDER BY YearNo DESC, MonthNo DESC;
SELECT TOP (5) ItemName, Brand, Quantity, Revenue FROM dbo.SALES_DASH_PRODUCT ORDER BY Revenue DESC;
SELECT Gender, CustomerCount, Sales FROM dbo.SALES_DASH_GENDER ORDER BY Sales DESC;`

// dashboardCacheReady reports whether every SALES_DASH_* summary table exists.
// When any is missing (first run before a refresh) the caller falls back to the
// live columnstore batch, so the dashboard still works without the cache.
const dashboardCacheProbe = `SELECT CASE WHEN
    OBJECT_ID('dbo.SALES_DASH_KPI') IS NOT NULL AND
    OBJECT_ID('dbo.SALES_DASH_REGION') IS NOT NULL AND
    OBJECT_ID('dbo.SALES_DASH_MONTH') IS NOT NULL AND
    OBJECT_ID('dbo.SALES_DASH_CATEGORY') IS NOT NULL AND
    OBJECT_ID('dbo.SALES_DASH_CITY') IS NOT NULL AND
    OBJECT_ID('dbo.SALES_DASH_TREND') IS NOT NULL AND
    OBJECT_ID('dbo.SALES_DASH_PRODUCT') IS NOT NULL AND
    OBJECT_ID('dbo.SALES_DASH_GENDER') IS NOT NULL
    THEN 1 ELSE 0 END;`

type sessionCounters struct {
	cpuMs        int64
	logicalReads int64
}

// SQLRepository owns the direct SQL Server pool and the Quentra TDS route.
// The unfiltered landing payload is cached in-process after its first real
// SALES50M read; every comparison/filter run is always executed again.
type SQLRepository struct {
	direct  *sql.DB
	quentra *sql.DB
	log     *slog.Logger

	cacheMu sync.RWMutex
	full    *DashboardData
}

func NewSQLRepository(cfg *config.Config, log *slog.Logger) *SQLRepository {
	// SALES50M dashboard aggregations can legitimately exceed the shared
	// 30-second socket timeout on a cold cache. Keep the longer limit local to
	// this workload; the query context below remains the hard two-minute cap.
	directDSN := strings.Replace(cfg.DSNFor(DatabaseName, config.AppDashboard), "connection+timeout=30", "connection+timeout=120", 1)
	quentraDSN := strings.Replace(cfg.QuentraDSNFor(DatabaseName, config.AppDashboard), "connection+timeout=30", "connection+timeout=120", 1)
	direct, _ := sql.Open("sqlserver", directDSN)
	quentra, _ := sql.Open("sqlserver", quentraDSN)
	for _, pool := range []*sql.DB{direct, quentra} {
		if pool == nil {
			continue
		}
		pool.SetMaxOpenConns(4)
		pool.SetMaxIdleConns(2)
		pool.SetConnMaxLifetime(20 * time.Minute)
		pool.SetConnMaxIdleTime(3 * time.Minute)
	}
	repo := &SQLRepository{direct: direct, quentra: quentra, log: log}
	repo.warmUp()
	return repo
}

// warmUp runs the unfiltered dashboard once in the background so the expensive
// first (cold) SALES50M aggregation happens at startup instead of on the first
// user request. The result populates the in-process cache, so the landing page
// is served instantly. Failures are logged and ignored: the on-demand path
// still works, it is just cold again.
func (r *SQLRepository) warmUp() {
	if r.direct == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer cancel()
		if _, err := r.GetDashboard(ctx, DashboardFilter{}); err != nil {
			if r.log != nil {
				r.log.Warn("SALES50M dashboard warm-up failed", "err", err)
			}
			return
		}
		if r.log != nil {
			r.log.Info("SALES50M dashboard warm-up complete")
		}
	}()
}

func (r *SQLRepository) GetDashboard(ctx context.Context, filter DashboardFilter) (DashboardData, error) {
	if strings.TrimSpace(filter.Region) == "" {
		r.cacheMu.RLock()
		if r.full != nil {
			out := *r.full
			r.cacheMu.RUnlock()
			return out, nil
		}
		r.cacheMu.RUnlock()
	}

	data, _, err := r.QueryDashboard(ctx, filter, false)
	if err != nil {
		return DashboardData{}, err
	}
	if strings.TrimSpace(filter.Region) == "" {
		r.cacheMu.Lock()
		copyData := data
		r.full = &copyData
		r.cacheMu.Unlock()
	}
	return data, nil
}

// lineTotalCol is the real per-line total column on dbo.SALES. The displayed
// before/after SQL labels it ORDER_LINETOTAL for the demo, but no such column
// exists in the table; the executed query must use TOTALPRICE or SQL Server
// rejects it with "Invalid column name".
const lineTotalCol = "TOTALPRICE"

// regionCityQuery renders the "Sales by City for a region" query that the
// dashboard displays as its before/after SQL. It is executed for real on every
// run so both routes pay its cost. The Direct route runs the heavy, non-SARGable
// form the ORM emits (redundant derived table + N'' unicode literal against the
// varchar REGION column); the Quentra route runs the rewritten SARGable form.
// The region literal is sanitized (single quotes doubled) before interpolation.
func regionCityQuery(region string, viaQuentra bool) string {
	safe := strings.ReplaceAll(region, "'", "''")
	if viaQuentra {
		return fmt.Sprintf(`SELECT CITY, SUM(%[1]s)
FROM %[2]s
WHERE REGION = '%[3]s'
GROUP BY CITY;`, lineTotalCol, salesTable, safe)
	}
	return fmt.Sprintf(`SELECT "TBL0"."CITY", SUM("TBL0"."%[1]s")
FROM ( SELECT * FROM %[2]s ) AS "TBL0"
WHERE "TBL0"."REGION" = N'%[3]s'
GROUP BY "TBL0"."CITY";`, lineTotalCol, salesTable, safe)
}

// runRegionCityQuery executes the region city-sales query on the given session
// and drains it. It runs purely for its measured server cost; the aggregated
// city rows already come from the dashboard batch, so results are discarded.
func runRegionCityQuery(ctx context.Context, conn *sql.Conn, region string, viaQuentra bool) error {
	rows, err := conn.QueryContext(ctx, regionCityQuery(region, viaQuentra))
	if err != nil {
		return fmt.Errorf("run region city query: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
	}
	return rows.Err()
}

// dashboardCacheReady returns true when every SALES_DASH_* summary table
// exists, so readDashboard may serve the unfiltered landing page from them.
func dashboardCacheReady(ctx context.Context, conn *sql.Conn) bool {
	var ready int
	if err := conn.QueryRowContext(ctx, dashboardCacheProbe).Scan(&ready); err != nil {
		return false
	}
	return ready == 1
}

// QueryDashboard performs a measured dashboard refresh over the requested
// route. CPU and logical reads are deltas from the same SQL session that runs
// the batch, so the comparison contains measured server figures.
func (r *SQLRepository) QueryDashboard(ctx context.Context, filter DashboardFilter, viaQuentra bool) (DashboardData, QueryMetrics, error) {
	pool := r.direct
	if viaQuentra {
		pool = r.quentra
	}
	if pool == nil {
		return DashboardData{}, QueryMetrics{}, fmt.Errorf("%s database connection is unavailable", DatabaseName)
	}

	queryCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	conn, err := pool.Conn(queryCtx)
	if err != nil {
		return DashboardData{}, QueryMetrics{}, fmt.Errorf("open %s dashboard connection: %w", DatabaseName, err)
	}
	defer conn.Close()

	// The displayed before/after "sales by city" query is a filter-simulation
	// artifact: run it only when a region is actually selected. On the unfiltered
	// landing/warm-up path it is skipped so the summary-table fast path is not
	// negated by an extra full columnstore scan.
	selected := strings.TrimSpace(filter.Region)

	before, _ := readSessionCounters(queryCtx, conn)
	started := time.Now()
	if selected != "" {
		if err := runRegionCityQuery(queryCtx, conn, selected, viaQuentra); err != nil {
			return DashboardData{}, QueryMetrics{}, err
		}
	}
	data, returned, err := readDashboard(queryCtx, conn, filter)
	elapsed := time.Since(started)
	if err != nil {
		return DashboardData{}, QueryMetrics{}, err
	}
	after, _ := readSessionCounters(queryCtx, conn)

	metrics := QueryMetrics{
		ElapsedMs:        max(1, int(elapsed.Milliseconds())),
		CPUMs:            nonNegativeInt(after.cpuMs - before.cpuMs),
		LogicalReadPages: nonNegativeInt(after.logicalReads - before.logicalReads),
		RowsReturned:     returned,
		QueryExecutions:  1,
	}
	if r.log != nil {
		r.log.Info("SALES50M dashboard refreshed", "region", filter.Region, "quentra", viaQuentra,
			"elapsedMs", metrics.ElapsedMs, "cpuMs", metrics.CPUMs, "logicalReads", metrics.LogicalReadPages)
	}
	return data, metrics, nil
}

func readSessionCounters(ctx context.Context, conn *sql.Conn) (sessionCounters, error) {
	var out sessionCounters
	err := conn.QueryRowContext(ctx, `SELECT CAST(cpu_time AS bigint), CAST(logical_reads AS bigint)
FROM sys.dm_exec_sessions WHERE session_id = @@SPID`).Scan(&out.cpuMs, &out.logicalReads)
	return out, err
}

func readDashboard(ctx context.Context, conn *sql.Conn, filter DashboardFilter) (DashboardData, int, error) {
	region := strings.TrimSpace(filter.Region)
	// The unfiltered landing dashboard is served from the pre-aggregated summary
	// tables when they are present; the filtered path still scans the live
	// columnstore so region drill-downs stay accurate.
	query := dashboardSQL
	args := []any{sql.Named("region", region)}
	if region == "" && dashboardCacheReady(ctx, conn) {
		query = cachedDashboardSQL
		args = nil
	}
	rows, err := conn.QueryContext(ctx, query, args...)
	if err != nil {
		return DashboardData{}, 0, fmt.Errorf("query %s dashboard: %w", DatabaseName, err)
	}
	defer rows.Close()

	data := DashboardData{Filter: DashboardFilter{Region: region}}
	returned := 0
	var totalOrders, customers, itemsSold int64
	if rows.Next() {
		if err := rows.Scan(&data.KPIs.TotalSales, &totalOrders, &customers, &itemsSold, &data.KPIs.ActiveCities); err != nil {
			return DashboardData{}, 0, fmt.Errorf("scan dashboard KPIs: %w", err)
		}
		returned++
	}
	// database/sql advances to the next result set only after the current set is
	// fully consumed. The KPI set has exactly one row, but one final Next call is
	// still required to reach EOF before NextResultSet.
	for rows.Next() {
	}
	data.KPIs.TotalOrders = int(totalOrders)
	data.KPIs.Customers = int(customers)
	data.KPIs.ItemsSold = int(itemsSold)
	if totalOrders > 0 {
		data.KPIs.AverageOrder = data.KPIs.TotalSales / float64(totalOrders)
	}

	if err := requireNextResult(rows, "regions"); err != nil {
		return DashboardData{}, 0, err
	}
	for rows.Next() {
		var row RegionRow
		var orders int64
		if err := rows.Scan(&row.Region, &row.Sales, &orders); err != nil {
			return DashboardData{}, 0, err
		}
		row.Orders = int(orders)
		data.SalesByRegion = append(data.SalesByRegion, row)
		returned++
	}
	data.SalesByRegion = withShares(data.SalesByRegion)

	if err := requireNextResult(rows, "months"); err != nil {
		return DashboardData{}, 0, err
	}
	for rows.Next() {
		var month int
		var point MonthPoint
		if err := rows.Scan(&month, &point.Sales); err != nil {
			return DashboardData{}, 0, err
		}
		point.Month = monthLabel(month)
		data.SalesByMonth = append(data.SalesByMonth, point)
		returned++
	}

	if err := requireNextResult(rows, "categories"); err != nil {
		return DashboardData{}, 0, err
	}
	for rows.Next() {
		var row CategorySlice
		if err := rows.Scan(&row.Category, &row.Sales); err != nil {
			return DashboardData{}, 0, err
		}
		data.SalesByCategory = append(data.SalesByCategory, row)
		returned++
	}

	if err := requireNextResult(rows, "cities"); err != nil {
		return DashboardData{}, 0, err
	}
	for rows.Next() {
		var row CityRow
		var orders int64
		if err := rows.Scan(&row.City, &row.Sales, &orders); err != nil {
			return DashboardData{}, 0, err
		}
		row.Orders = int(orders)
		if orders > 0 {
			row.AverageBasket = row.Sales / float64(orders)
		}
		data.TopCities = append(data.TopCities, row)
		returned++
	}

	if err := requireNextResult(rows, "trend"); err != nil {
		return DashboardData{}, 0, err
	}
	var descending []TrendPoint
	for rows.Next() {
		var year, month int
		var orders int64
		if err := rows.Scan(&year, &month, &orders); err != nil {
			return DashboardData{}, 0, err
		}
		descending = append(descending, TrendPoint{Label: fmt.Sprintf("%04d-%02d", year, month), Orders: int(orders)})
		returned++
	}
	for i := len(descending) - 1; i >= 0; i-- {
		data.OrderTrend = append(data.OrderTrend, descending[i])
	}

	if err := requireNextResult(rows, "products"); err != nil {
		return DashboardData{}, 0, err
	}
	for rows.Next() {
		var row ProductRow
		var quantity int64
		if err := rows.Scan(&row.ItemName, &row.Brand, &quantity, &row.Revenue); err != nil {
			return DashboardData{}, 0, err
		}
		row.Quantity = int(quantity)
		data.TopProducts = append(data.TopProducts, row)
		returned++
	}

	if err := requireNextResult(rows, "gender"); err != nil {
		return DashboardData{}, 0, err
	}
	for rows.Next() {
		var row GenderSlice
		var count int64
		if err := rows.Scan(&row.Gender, &count, &row.Sales); err != nil {
			return DashboardData{}, 0, err
		}
		row.Count = int(count)
		data.GenderDist = append(data.GenderDist, row)
		returned++
	}
	if err := rows.Err(); err != nil {
		return DashboardData{}, 0, err
	}
	return data, returned, nil
}

func requireNextResult(rows *sql.Rows, name string) error {
	if rows.NextResultSet() {
		return nil
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("read %s result: %w", name, err)
	}
	return fmt.Errorf("missing %s result set", name)
}

func monthLabel(month int) string {
	if month >= 1 && month <= len(monthNames) {
		return monthNames[month-1]
	}
	return fmt.Sprintf("%02d", month)
}

func nonNegativeInt(v int64) int {
	if v <= 0 {
		return 0
	}
	return int(v)
}
