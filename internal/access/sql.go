package access

import "fmt"

// SQL for the turnstile / factory "last movement" workload. It runs against the
// pre-existing TIGERMARKET ERP database, treating each stock-transaction line
// as an access "movement": the demo asks "what was the most recent movement for
// key N?" — exactly the turnstile's "son hareket sorgusu".
//
// Query model: the APPLICATION always sends the same BAD statement — the key
// (and a unique marker) concatenated into the text, so SQL Server compiles a
// brand-new single-use plan for every execution. Both routes carry that same
// bad statement:
//
//   - direct  → straight to SQL Server (:1433): no one rewrites it, the plan
//     cache bloats, compilations stay high.
//   - quentra → through the Quentra gateway (:14330): the gateway rewrites the
//     statement ONLY when a matching rule is configured. What SQL Server
//     actually received on each route is captured from its DMVs — the demo
//     never fabricates a rewrite the gateway didn't perform.
// quentraSQL below is the TARGET form a rewrite rule should produce, kept for
// the UI's reference panel.

const (
	// DBName is the existing ERP database queried by this workload.
	DBName = "TIGERMARKET"

	// movementTable is the stock-transaction line table used as the movement log.
	movementTable = "dbo.LG_117_01_STLINE"

	// keyMin / keyMax bound the STOCKREF values seen in the data, so random keys
	// hit real rows.
	keyMin = 2
	keyMax = 23604

	// quentraSQL is the parameterized last-movement lookup: the TARGET statement
	// a Quentra rewrite rule should produce (one reusable plan). Shown as the
	// reference "hedef" text; the gateway itself decides what actually runs.
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

// applicationSQL builds the statement the APPLICATION sends on BOTH routes: the
// key is concatenated in as a literal and the marker comment guarantees the
// text is never identical, forcing a fresh single-use plan on every execution.
// For card checks the marker is the traceId, so the captured backend text can
// be tied to one specific card read.
func applicationSQL(key int, marker string) string {
	return fmt.Sprintf(
		"SELECT TOP (1) LOGICALREF, DATE_, AMOUNT, PRICE, TRCODE FROM dbo.LG_117_01_STLINE WHERE STOCKREF = %d ORDER BY DATE_ DESC; /*%s*/",
		key, marker)
}

// directDisplaySQL / quentraDisplaySQL are the static fallbacks for the UI's
// "gönderilen sorgu" panel, used before the first DMV capture lands. Both
// routes carry the SAME bad application statement; the Quentra block only
// differs if the gateway's rewrite rule actually fired (which the capture
// shows for real).
func directDisplaySQL() string {
	return "SELECT TOP 1 LOGICALREF, DATE_, AMOUNT, PRICE, TRCODE\nFROM dbo.LG_117_01_STLINE\nWHERE STOCKREF = 12345          -- literal anahtar, her sorgu yeni plan\nORDER BY DATE_ DESC; /*ACC-XXXXXX*/   -- direkt bağlantı (:1433)"
}

func quentraDisplaySQL() string {
	return "SELECT TOP 1 LOGICALREF, DATE_, AMOUNT, PRICE, TRCODE\nFROM dbo.LG_117_01_STLINE\nWHERE STOCKREF = 12345          -- AYNI kötü sorgu Quentra'ya gönderilir\nORDER BY DATE_ DESC; /*ACC-XXXXXX*/   -- Quentra geçidi (:14330), kural varsa yeniden yazar"
}
