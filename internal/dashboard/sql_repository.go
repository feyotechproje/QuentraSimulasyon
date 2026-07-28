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
DECLARE @filter nvarchar(64) = NULLIF(LTRIM(RTRIM(@region)), N'');

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
	direct, _ := sql.Open("sqlserver", cfg.DSNFor(DatabaseName, config.AppDashboard))
	quentra, _ := sql.Open("sqlserver", cfg.QuentraDSNFor(DatabaseName, config.AppDashboard))
	for _, pool := range []*sql.DB{direct, quentra} {
		if pool == nil {
			continue
		}
		pool.SetMaxOpenConns(4)
		pool.SetMaxIdleConns(2)
		pool.SetConnMaxLifetime(20 * time.Minute)
		pool.SetConnMaxIdleTime(3 * time.Minute)
	}
	return &SQLRepository{direct: direct, quentra: quentra, log: log}
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

	before, _ := readSessionCounters(queryCtx, conn)
	started := time.Now()
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
	rows, err := conn.QueryContext(ctx, dashboardSQL, sql.Named("region", region))
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
