package keybreaker

import "regexp"

// SQL and payloads for the Key Breaker SQL-injection defense workload.
//
// SAFETY: the workload runs against a dedicated, disposable KEYBREAKER database
// with a fake KB_ACCOUNTS table. Only read-only login-check SELECTs are ever
// executed. Destructive payloads (DROP/DELETE/EXEC/xp_/…) are classified and
// counted but NEVER executed — running them proves nothing extra and would be
// dangerous. Read-oriented injections (tautology / UNION / comment) ARE run for
// real against the disposable table, so the breaches the UI shows are measured.

const (
	// DBName is the disposable database this workload provisions and owns.
	DBName = "KEYBREAKER"

	// seedRows is how many fake accounts are seeded into KB_ACCOUNTS.
	seedRows = 64
)

// provisionStmts create and seed the disposable target. Idempotent.
var provisionStmts = []string{
	`IF OBJECT_ID('dbo.KB_ACCOUNTS','U') IS NULL
	CREATE TABLE dbo.KB_ACCOUNTS(
		ID       INT IDENTITY(1,1) PRIMARY KEY,
		USERNAME VARCHAR(40) NOT NULL,
		PASSWORD VARCHAR(40) NOT NULL,
		ROLE     VARCHAR(20) NOT NULL
	);`,
	`IF NOT EXISTS (SELECT 1 FROM dbo.KB_ACCOUNTS)
	INSERT INTO dbo.KB_ACCOUNTS(USERNAME,PASSWORD,ROLE)
	SELECT TOP (` + itoa(seedRows) + `)
		'user' + RIGHT('000'+CAST(ROW_NUMBER() OVER(ORDER BY (SELECT NULL)) AS VARCHAR(4)),4),
		'Pw!' + CAST(ABS(CHECKSUM(NEWID()))%9000+1000 AS VARCHAR(8)),
		CASE WHEN ROW_NUMBER() OVER(ORDER BY (SELECT NULL))=1 THEN 'admin' ELSE 'user' END
	FROM sys.all_objects;`,
	// A known admin row with a fixed credential, so the "legit" path succeeds.
	`IF NOT EXISTS (SELECT 1 FROM dbo.KB_ACCOUNTS WHERE USERNAME='mkaya')
	INSERT INTO dbo.KB_ACCOUNTS(USERNAME,PASSWORD,ROLE) VALUES('mkaya','Sifre123','admin');`,
}

// countSQL verifies the seed.
const countSQL = `SELECT COUNT_BIG(*) FROM dbo.KB_ACCOUNTS`

// attackKind classifies a payload.
type attackKind string

const (
	kindLegit       attackKind = "legit"
	kindTautology   attackKind = "tautology"
	kindUnion       attackKind = "union"
	kindComment     attackKind = "comment"
	kindDestructive attackKind = "destructive"
)

// payload is one login attempt: username/password plus its true nature.
type payload struct {
	User string
	Pass string
	Kind attackKind
	// Label is the short human-readable attack name shown in the UI.
	Label string
}

// payloads mixes legitimate logins with classic injections. Read-oriented
// attacks are executed for real; destructive ones are only ever classified.
var payloads = []payload{
	{User: "mkaya", Pass: "Sifre123", Kind: kindLegit, Label: "Geçerli giriş"},
	{User: "user0007", Pass: "wrongpw", Kind: kindLegit, Label: "Hatalı parola"},
	{User: "' OR '1'='1' --", Pass: "x", Kind: kindTautology, Label: "Totoloji enjeksiyonu"},
	{User: "admin' --", Pass: "x", Kind: kindComment, Label: "Yorum ile atlatma"},
	{User: "' OR 1=1 --", Pass: "x", Kind: kindTautology, Label: "OR 1=1 atlatma"},
	{User: "' UNION SELECT ID,USERNAME,PASSWORD FROM dbo.KB_ACCOUNTS --", Pass: "x", Kind: kindUnion, Label: "UNION ile sızdırma"},
	{User: "'; DROP TABLE KB_ACCOUNTS; --", Pass: "x", Kind: kindDestructive, Label: "Komut çalıştırma"},
	{User: "'; EXEC xp_cmdshell 'dir'; --", Pass: "x", Kind: kindDestructive, Label: "xp_cmdshell"},
}

// vulnerableSQL builds the classic string-concatenated login check. It returns
// (ID, USERNAME, ROLE) so a UNION injection can line up its columns.
func vulnerableSQL(user, pass string) string {
	return "SELECT TOP 5 ID, USERNAME, ROLE FROM dbo.KB_ACCOUNTS WHERE USERNAME='" +
		user + "' AND PASSWORD='" + pass + "'"
}

// safeSQL is the parameterized login check the Quentra path runs for legit input.
const safeSQL = `SELECT TOP 5 ID, USERNAME, ROLE FROM dbo.KB_ACCOUNTS
WHERE USERNAME=@u AND PASSWORD=@p`

// injectionRE is the Quentra shield's detector: any match is treated as an
// attack and blocked before it reaches SQL Server. Case-insensitive.
var injectionRE = regexp.MustCompile(
	`(?i)(--|;|/\*|\bor\b\s+['"\d]|\bunion\b|\bdrop\b|\bdelete\b|\bupdate\b|\binsert\b|\bexec\b|xp_|\bshutdown\b|\btruncate\b|1\s*=\s*1|'\s*=\s*')`)

// destructiveRE marks payloads that must never be executed, even with the shield
// off, so the demo can classify them without running them.
var destructiveRE = regexp.MustCompile(
	`(?i)(\bdrop\b|\bdelete\b|\bupdate\b|\binsert\b|\bexec\b|xp_|\bshutdown\b|\btruncate\b|\balter\b|\bmerge\b|\bgrant\b)`)

func isMalicious(user, pass string) bool {
	return injectionRE.MatchString(user) || injectionRE.MatchString(pass)
}

func isDestructive(user, pass string) bool {
	return destructiveRE.MatchString(user) || destructiveRE.MatchString(pass)
}

// itoa avoids importing strconv just for the seed template.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}
