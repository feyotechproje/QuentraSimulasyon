package config

import (
	"bufio"
	"fmt"
	"net/url"
	"os"
	"strings"
)

// Config holds runtime configuration loaded from environment variables.
// Secrets (password) are never written to logs or serialized to the UI.
type Config struct {
	DBServer         string
	DBDatabase       string
	DBUser           string
	DBPassword       string
	DBPort           string
	DBEncrypt        string // "disable", "false", "true"
	DBTrustServerCrt bool
	HTTPAddr         string

	// Quentra gateway. The gateway speaks the TDS protocol and proxies to the
	// same SQL Server, so the credentials are shared; only the host/port differ.
	// Live demos connect through it to let Quentra serve cached results.
	QuentraServer string
	QuentraPort   string
}

// Load reads configuration from the process environment, optionally seeded
// from a ".env" file in the working directory (does not override real env vars).
func Load() *Config {
	loadDotEnv(".env")

	c := &Config{
		DBServer:         getEnv("DB_SERVER", "localhost"),
		DBDatabase:       getEnv("DB_DATABASE", "QUENTRA_RETAIL"),
		DBUser:           getEnv("DB_USER", "sa"),
		DBPassword:       os.Getenv("DB_PASSWORD"),
		DBPort:           getEnv("DB_PORT", ""),
		DBEncrypt:        getEnv("DB_ENCRYPT", "disable"),
		DBTrustServerCrt: strings.EqualFold(getEnv("DB_TRUST_SERVER_CERT", "true"), "true"),
		HTTPAddr:         getEnv("HTTP_ADDR", ":8080"),
		QuentraServer:    getEnv("QUENTRA_SERVER", getEnv("DB_SERVER", "localhost")),
		QuentraPort:      getEnv("QUENTRA_PORT", "14330"),
	}
	return c
}

// Application names reported to SQL Server, one per workload. They land in
// sys.dm_exec_sessions.program_name, so a DBA watching the instance can tell
// which simulation opened a connection — and, because the gateway variants are
// distinct names, whether it arrived direct or through Quentra. Keep these
// stable: they are what any session-level filter or Extended Event trace keys
// on. The two-part shape is deliberate — "QuentraSim-<workload>" so every
// session from this process still groups under a common prefix.
const (
	AppRetail      = "QuentraSim-Retail"      // register/checkout simulation
	AppReportCache = "QuentraSim-ReportCache" // heavy-report cache demo
	AppProduction  = "QuentraSim-ProductionLine" // production-line simulation
	AppVehicle     = "QuentraSim-VehicleGPS"  // vehicle-tracking simulation
	AppSetup       = "QuentraSim-Setup"       // provisioning against master

	// quentraSuffix marks a connection that travels through the gateway rather
	// than hitting SQL Server directly. Appended to the workload's own name so
	// the two legs of an A/B comparison are separable in a trace.
	quentraSuffix = "-Quentra"
)

// DSN builds a SQL Server connection string (URL form) for the retail
// simulation. SQL Authentication is used because the QUENTRA_RETAIL deployment
// exposes a SQL login.
func (c *Config) DSN() string {
	return c.DSNFor(c.DBDatabase, AppRetail)
}

// DSNFor builds a connection string for an arbitrary database on the same
// server using the same credentials/encryption settings. appName identifies the
// calling workload; pass one of the App* constants.
func (c *Config) DSNFor(database, appName string) string {
	return c.dsn(c.DBServer, c.DBPort, database, appName)
}

// QuentraDSNFor builds a connection string that reaches the same database
// *through the Quentra gateway* instead of talking to SQL Server directly.
// Credentials are identical; only the host/port change, so the two DSNs form a
// like-for-like A/B pair for measuring what the gateway's cache is doing.
//
// The app name gets the gateway suffix so both legs stay distinguishable
// server-side even though they run the identical statement.
func (c *Config) QuentraDSNFor(database, appName string) string {
	return c.dsn(c.QuentraServer, c.QuentraPort, database, appName+quentraSuffix)
}

func (c *Config) dsn(server, port, database, appName string) string {
	query := url.Values{}
	query.Add("database", database)
	query.Add("app name", appName)
	query.Add("encrypt", c.DBEncrypt)
	if c.DBTrustServerCrt {
		query.Add("TrustServerCertificate", "true")
	}
	query.Add("connection timeout", "30")

	host := server
	if port != "" {
		host = fmt.Sprintf("%s:%s", server, port)
	}

	u := &url.URL{
		Scheme:   "sqlserver",
		User:     url.UserPassword(c.DBUser, c.DBPassword),
		Host:     host,
		RawQuery: query.Encode(),
	}
	return u.String()
}

// SafeSummary returns a connection description with no secret material,
// safe for logs and the UI.
func (c *Config) SafeSummary() string {
	return fmt.Sprintf("server=%s database=%s user=%s encrypt=%s",
		c.DBServer, c.DBDatabase, c.DBUser, c.DBEncrypt)
}

func getEnv(key, def string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return def
}

// loadDotEnv performs a minimal .env parse. Existing environment variables win.
func loadDotEnv(path string) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		eq := strings.IndexByte(line, '=')
		if eq < 0 {
			continue
		}
		key := strings.TrimSpace(line[:eq])
		val := strings.TrimSpace(line[eq+1:])
		val = strings.Trim(val, `"'`)
		if _, exists := os.LookupEnv(key); !exists {
			_ = os.Setenv(key, val)
		}
	}
}
