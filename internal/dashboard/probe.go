package dashboard

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"
)

// This file is a temporary diagnostic. It answers one question for the demo:
// when the redundant/non-SARGable region query is sent through the Quentra
// gateway, what SQL does the backend SQL Server actually receive? The rewritten
// text lives in SQL Server's own DMVs for the backend session behind the proxy
// connection, so nothing here is hand-authored — every string comes from the
// engine. Once we confirm which capture method returns the clean rewritten form,
// that method gets wired into QueryDetails and this file is removed.

// mostRecentTextSQL returns the text of the last request executed on a session.
// It must be read from a DIFFERENT connection than the one that ran the target
// query: a session's most_recent_sql_handle is overwritten by whatever it runs
// next, so reading it in the same session captures this SELECT instead.
const mostRecentTextSQL = `SELECT t.text
FROM sys.dm_exec_connections c
CROSS APPLY sys.dm_exec_sql_text(c.most_recent_sql_handle) t
WHERE c.session_id = @spid`

// inputBufferSQL returns the raw input buffer (the submitted batch or RPC) for a
// session — closer to the wire than the compiled statement text, so a rewritten
// sp_executesql RPC shows up with its parameter list intact.
const inputBufferSQL = `SELECT event_info FROM sys.dm_exec_input_buffer(@spid, 0)`

// captureAttempt records one capture method and whatever it returned.
type captureAttempt struct {
	Method string `json:"method"`
	Text   string `json:"text,omitempty"`
	Err    string `json:"error,omitempty"`
}

// routeCapture is the set of capture attempts for one route (direct/quentra).
type routeCapture struct {
	Route       string           `json:"route"`
	BackendSPID int              `json:"backendSpid"`
	Attempts    []captureAttempt `json:"attempts"`
}

// CaptureProbeResult is the full probe payload: what the client handed the
// driver, plus what SQL Server actually received on each route.
type CaptureProbeResult struct {
	Region     string         `json:"region"`
	ClientSent string         `json:"clientSent"`
	Routes     []routeCapture `json:"routes"`
}

// ProbeRewrite runs the region query on both routes and captures the SQL the
// backend session actually executed, using several DMV methods so we can see
// which one surfaces the clean rewritten form.
func (r *SQLRepository) ProbeRewrite(ctx context.Context, region string) (CaptureProbeResult, error) {
	if r.direct == nil || r.quentra == nil {
		return CaptureProbeResult{}, fmt.Errorf("both direct and quentra pools are required for the capture probe")
	}
	if strings.TrimSpace(region) == "" {
		region = "Marmara"
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	return CaptureProbeResult{
		Region:     region,
		ClientSent: regionCityQuery(region),
		Routes: []routeCapture{
			r.captureRoute(ctx, r.direct, "direct", region),
			r.captureRoute(ctx, r.quentra, "quentra", region),
		},
	}, nil
}

// captureRoute runs the region query once on the given pool, then reads back the
// SQL the backend session executed. Cross-session reads happen first (while the
// target connection is idle); the same-session read is done last because it
// overwrites the target session's most_recent handle with its own text.
func (r *SQLRepository) captureRoute(ctx context.Context, pool *sql.DB, route, region string) routeCapture {
	out := routeCapture{Route: route}

	conn, err := pool.Conn(ctx)
	if err != nil {
		out.Attempts = append(out.Attempts, captureAttempt{Method: "open-conn", Err: err.Error()})
		return out
	}
	defer conn.Close()

	if err := conn.QueryRowContext(ctx, "SELECT @@SPID").Scan(&out.BackendSPID); err != nil {
		out.Attempts = append(out.Attempts, captureAttempt{Method: "read-spid", Err: err.Error()})
		return out
	}
	if err := runRegionCityQuery(ctx, conn, region); err != nil {
		out.Attempts = append(out.Attempts, captureAttempt{Method: "run-query", Err: err.Error()})
		return out
	}

	out.Attempts = append(out.Attempts, r.crossSessionCaptures(ctx, out.BackendSPID)...)
	out.Attempts = append(out.Attempts, capture("same-session:most_recent_sql_handle",
		conn.QueryRowContext(ctx, mostRecentTextSQL, sql.Named("spid", out.BackendSPID))))
	return out
}

// crossSessionCaptures reads the target session's last executed SQL from a
// separate direct connection, so the read does not disturb the target session.
func (r *SQLRepository) crossSessionCaptures(ctx context.Context, spid int) []captureAttempt {
	reader, err := r.direct.Conn(ctx)
	if err != nil {
		return []captureAttempt{{Method: "cross-session:open-reader", Err: err.Error()}}
	}
	defer reader.Close()

	return []captureAttempt{
		capture("cross-session:most_recent_sql_handle",
			reader.QueryRowContext(ctx, mostRecentTextSQL, sql.Named("spid", spid))),
		capture("cross-session:input_buffer",
			reader.QueryRowContext(ctx, inputBufferSQL, sql.Named("spid", spid))),
	}
}

// capture scans a single-column text row into a labelled attempt, recording the
// error instead of the text when the read fails. sql_text can be NULL (evicted
// plan), which surfaces as an empty Text rather than an error.
func capture(method string, row *sql.Row) captureAttempt {
	var s sql.NullString
	if err := row.Scan(&s); err != nil {
		return captureAttempt{Method: method, Err: err.Error()}
	}
	return captureAttempt{Method: method, Text: s.String}
}
