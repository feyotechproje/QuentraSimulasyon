package fulltext

// SQL text and provisioning statements for the FullText / NGram search workload.
//
// The scenario runs against the pre-existing CRM2.dbo.CUSTOMERS table (~5M
// rows). There is NO index on NAMESURNAME, so the "reference" path — a
// leading-wildcard LIKE — must scan the whole table every time (measured ~1s,
// several CPU-seconds). The "quentra" path uses a real full-text index and
// CONTAINS, which seeks instead of scanning. Both queries are executed for
// real and timed; nothing here is synthesized.

const (
	// DBName is the existing database queried by this workload. Nothing is
	// created except the full-text catalog/index needed for the fast path.
	DBName = "CRM2"

	// searchTable / searchColumn are what the workload searches.
	searchTable  = "dbo.CUSTOMERS"
	searchColumn = "NAMESURNAME"

	// ftCatalog is the full-text catalog created for the accelerated path.
	ftCatalog = "QuentraFtCatalog"

	// keyIndex is the unique single-column index full-text needs as its key.
	keyIndex = "PK_CUSTOMERS"

	// referenceSQL is the baseline: a leading-wildcard LIKE. Un-indexable, so
	// SQL Server scans all rows. @term is the search fragment.
	referenceSQL = `SELECT TOP (50) ID, NAMESURNAME, CITY
FROM dbo.CUSTOMERS
WHERE NAMESURNAME LIKE '%' + @term + '%'`

	// quentraSQL is the accelerated path: full-text CONTAINS over the same
	// column, backed by ftCatalog. @term is a prefix search string ("KAYA*").
	quentraSQL = `SELECT TOP (50) ID, NAMESURNAME, CITY
FROM dbo.CUSTOMERS
WHERE CONTAINS(NAMESURNAME, @term)`

	// countSQL reports the table size once, so the UI can show how many
	// documents the reference scan has to walk.
	countSQL = `SELECT COUNT_BIG(*) FROM dbo.CUSTOMERS`
)

// searchTerms are real surname fragments present in the data. Searching these
// returns genuine matches on both paths so the timing comparison is fair.
var searchTerms = []string{
	"KAYA", "YILMAZ", "DEMIR", "CELIK", "SAHIN", "YILDIZ", "YILDIRIM",
	"OZTURK", "AYDIN", "OZDEMIR", "ARSLAN", "DOGAN", "KILIC", "ASLAN",
	"CETIN", "KARA", "KOC", "KURT", "OZKAN", "SIMSEK", "POLAT", "KAYGISIZ",
	"BULUT", "KAPLAN", "GUNES", "BOZKURT", "AKSOY", "TURAN", "TASKIN",
}

// containsArg turns a plain fragment into a CONTAINS prefix search string.
// CONTAINS wants a quoted prefix term, e.g. '"KAYA*"'.
func containsArg(term string) string { return `"` + term + `*"` }

// directDisplaySQL / quentraDisplaySQL return the exact statements each path
// sends, with the current term substituted, for the UI's "gönderilen sorgu"
// panel: the leading-wildcard scan on the direct link vs the full-text lookup
// routed through Quentra.
func directDisplaySQL(term string) string {
	return "SELECT TOP 50 ID, NAMESURNAME, CITY\nFROM dbo.CUSTOMERS\nWHERE NAMESURNAME LIKE '%" + term + "%'"
}

func quentraDisplaySQL(term string) string {
	return "SELECT TOP 50 ID, NAMESURNAME, CITY\nFROM dbo.CUSTOMERS\nWHERE CONTAINS(NAMESURNAME, '\"" + term + "*\"')"
}

// provisionStmts are run in order at startup. Each is idempotent: the catalog
// and index are only created when missing, so restarts are cheap and the ~5M
// row table is never rebuilt. Full-text population then runs in the background.
var provisionStmts = []string{
	// 1. Full-text catalog.
	`IF NOT EXISTS (SELECT 1 FROM sys.fulltext_catalogs WHERE name = '` + ftCatalog + `')
		CREATE FULLTEXT CATALOG ` + ftCatalog + `;`,
	// 2. Full-text index on the searched column, keyed by the primary key.
	`IF NOT EXISTS (SELECT 1 FROM sys.fulltext_indexes WHERE object_id = OBJECT_ID('` + searchTable + `'))
		CREATE FULLTEXT INDEX ON ` + searchTable + ` (` + searchColumn + `)
		KEY INDEX ` + keyIndex + ` ON ` + ftCatalog + ` WITH CHANGE_TRACKING AUTO;`,
}

// ftReadySQL reports whether the full-text index has finished its initial
// population. 0 = still building (the accelerated path returns partial results
// until it completes), non-zero = ready.
const ftReadySQL = `SELECT ISNULL(FULLTEXTCATALOGPROPERTY('` + ftCatalog + `','ItemCount'),0)`
