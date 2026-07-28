package access

import "fmt"

// SQL for the turnstile / factory "last movement" workload. It runs against the
// pre-existing TIGERMARKET ERP database, treating each stock-transaction line
// as an access "movement": the demo asks "what was the most recent movement for
// key N?" — exactly the turnstile's "son hareket sorgusu".
//
// The table is heavily indexed, so a single lookup is already fast. The lesson
// is therefore the plan-cache one: the baseline concatenates the key (and a
// unique marker) into the statement text, so SQL Server compiles a brand-new
// single-use plan for every query; the Quentra path parameterizes it, so one
// plan is compiled and reused. Both are executed and measured for real.

const (
	// DBName is the existing ERP database queried by this workload.
	DBName = "TIGERMARKET"

	// movementTable is the stock-transaction line table used as the movement log.
	movementTable = "dbo.LG_117_01_STLINE"

	// keyMin / keyMax bound the STOCKREF values seen in the data, so random keys
	// hit real rows.
	keyMin = 2
	keyMax = 23604

	// quentraSQL is the parameterized last-movement lookup: one reusable plan.
	quentraSQL = `SELECT TOP (1) LOGICALREF, DATE_, AMOUNT, PRICE, TRCODE
FROM dbo.LG_117_01_STLINE
WHERE STOCKREF = @key
ORDER BY DATE_ DESC`

	// planCacheSQL reads single-use vs total compiled plans and cache size.
	planCacheSQL = `SELECT
		ISNULL(SUM(CASE WHEN usecounts = 1 THEN 1 ELSE 0 END),0),
		COUNT_BIG(*),
		CAST(ISNULL(SUM(size_in_bytes),0)/1048576.0 AS FLOAT)
	FROM sys.dm_exec_cached_plans
	WHERE cacheobjtype = 'Compiled Plan'`

	// perfCountersSQL reads cumulative compilation / batch counters.
	perfCountersSQL = `SELECT counter_name, cntr_value
		FROM sys.dm_os_performance_counters
		WHERE object_name LIKE '%SQL Statistics%'
		  AND counter_name IN ('SQL Compilations/sec','Batch Requests/sec')`
)

// baselineSQL builds the ad-hoc statement: the key is concatenated in and a
// unique marker guarantees the statement text is never identical, forcing a
// fresh plan every time — the plan-cache bloat the demo shows.
func baselineSQL(key int, marker int64) string {
	return fmt.Sprintf(
		"SELECT TOP (1) LOGICALREF, DATE_, AMOUNT, PRICE, TRCODE FROM dbo.LG_117_01_STLINE WHERE STOCKREF = %d ORDER BY DATE_ DESC; /*adhoc-%d*/",
		key, marker)
}

// directDisplaySQL / quentraDisplaySQL return the exact statements each path
// sends, for the UI's "gönderilen sorgu" panel: the ad-hoc concatenated lookup
// on the direct link vs the parameterized one routed through Quentra.
func directDisplaySQL(key int) string {
	return fmt.Sprintf("SELECT TOP 1 LOGICALREF, DATE_, AMOUNT, PRICE, TRCODE\nFROM dbo.LG_117_01_STLINE\nWHERE STOCKREF = %d          -- literal, her sorgu yeni plan\nORDER BY DATE_ DESC;", key)
}

func quentraDisplaySQL() string {
	return "EXEC sp_executesql\n  N'SELECT TOP 1 LOGICALREF, DATE_, AMOUNT, PRICE, TRCODE\n    FROM dbo.LG_117_01_STLINE\n    WHERE STOCKREF = @key ORDER BY DATE_ DESC',\n  N'@key int', @key = ?   -- parametreli, tek plan"
}
