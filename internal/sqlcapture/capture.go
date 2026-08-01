// Package sqlcapture reads the SQL a backend SQL Server session actually
// executed, straight from the engine's own DMVs. It is how the demos show the
// REAL query the Quentra gateway forwarded (rewritten when a rule matches),
// instead of a hand-authored "rewritten" string that SQL Server never sees.
//
// The one rule that makes this correct: a session's most_recent_sql_handle is
// overwritten by whatever that session runs next, so it must be read from a
// DIFFERENT connection than the one that ran the target query — otherwise the
// read captures itself. Every helper here honours that by taking a separate
// reader pool.
package sqlcapture

import (
	"context"
	"database/sql"
)

// lastStatementSQL returns the text of the most recent statement executed on a
// given session id. Read it from a reader connection while the target session
// is idle.
const lastStatementSQL = `SELECT t.text
FROM sys.dm_exec_connections c
CROSS APPLY sys.dm_exec_sql_text(c.most_recent_sql_handle) t
WHERE c.session_id = @spid`

// BackendSPID returns the SQL Server session id behind conn. It must be called
// BEFORE running the target query: @@SPID is stable for the connection's whole
// life, but this call itself becomes the connection's most-recent statement, so
// running it after the target query would hide it.
func BackendSPID(ctx context.Context, conn *sql.Conn) (int, error) {
	var spid int
	err := conn.QueryRowContext(ctx, "SELECT @@SPID").Scan(&spid)
	return spid, err
}

// LastStatement returns the text of the most recent statement the given backend
// session executed, read via reader — which MUST be a different pool/connection
// than the one that ran the query. An empty string with a nil error means the
// text was unavailable (e.g. the plan was evicted between run and read).
func LastStatement(ctx context.Context, reader *sql.DB, spid int) (string, error) {
	var text sql.NullString
	if err := reader.QueryRowContext(ctx, lastStatementSQL, sql.Named("spid", spid)).Scan(&text); err != nil {
		return "", err
	}
	return text.String, nil
}

// Captured runs fn on a dedicated connection from target, then returns the SQL
// the backend actually executed for it, read cross-session via reader. Pass the
// Quentra pool as target and the direct pool as reader to surface a gateway
// rewrite; pass the direct pool as both to capture the verbatim original.
//
// reader must not be the same *sql.Conn as target uses; passing the same *sql.DB
// is fine because a second connection is drawn from the pool for the read.
func Captured(ctx context.Context, target, reader *sql.DB, fn func(ctx context.Context, conn *sql.Conn) error) (string, error) {
	conn, err := target.Conn(ctx)
	if err != nil {
		return "", err
	}
	defer conn.Close()

	spid, err := BackendSPID(ctx, conn)
	if err != nil {
		return "", err
	}
	if err := fn(ctx, conn); err != nil {
		return "", err
	}
	return LastStatement(ctx, reader, spid)
}
