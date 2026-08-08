package access

import (
	"context"
	"database/sql"
	"fmt"
	"hash/fnv"
	"math/rand"
	"strings"
	"time"

	"supermarketsim/internal/sqlcapture"
)

// Card-check API (POST /api/access/check): one REAL last-movement lookup for
// one specific card read on the simulation floor. Unlike the background
// workload — which is ambience — this is the live proof: the statement carries
// the check's traceId in its marker comment, the backend text is captured
// cross-session from SQL Server's DMVs, and the turnstile decision is derived
// from the row that came back. Nothing here is synthesized.

// CheckRequest identifies one card read on the simulation floor.
type CheckRequest struct {
	EmployeeID  string `json:"employeeId"`
	TurnstileID string `json:"turnstileId"`
	// Route is "direct" (baseline bank) or "quentra" (gateway bank).
	Route string `json:"route"`
}

// CheckResult is the endpoint's answer. The three SQL texts separate what the
// application SENT from what SQL Server RECEIVED on each route, all tied to
// one traceId so the UI can prove they came from the same card read.
type CheckResult struct {
	TraceID   string `json:"traceId"`
	Source    string `json:"source"` // always "live"
	Route     string `json:"route"`
	GatewayUp bool   `json:"gatewayUp"`
	Key       int    `json:"key"`

	ApplicationSQL    string `json:"applicationSql"`
	DirectBackendSQL  string `json:"directBackendSql,omitempty"`
	QuentraBackendSQL string `json:"quentraBackendSql,omitempty"`
	RuleMatched       bool   `json:"ruleMatched"`
	InputTransport    string `json:"inputTransport"`
	OutputTransport   string `json:"outputTransport"`

	// ElapsedMs is the requested route's own query time (what the KPI uses);
	// DirectMs/QuentraMs report both legs when both were run.
	ElapsedMs float64 `json:"elapsedMs"`
	DirectMs  float64 `json:"directMs,omitempty"`
	QuentraMs float64 `json:"quentraMs,omitempty"`

	LastMovement string `json:"lastMovement"` // ENTRY | EXIT | NONE
	LastRef      int64  `json:"lastRef,omitempty"`
	Decision     string `json:"decision"` // ENTRY_APPROVED | ACCESS_DENIED | MANUAL_REVIEW
	Reason       string `json:"reason"`
	Evidence     string `json:"evidence"` // "measured" | "unavailable" | "error"
	Error        string `json:"error,omitempty"`
}

// legResult is one route's measured execution of the application statement.
type legResult struct {
	backendSQL string
	ms         float64
	ref        int64
	trcode     sql.NullInt64
	noRow      bool
	err        error
}

// Check runs the bad application statement for one card read and derives the
// turnstile decision from the real row. In "quentra" route the statement goes
// ONLY through the gateway — when the gateway is down the check fails honestly
// with MANUAL_REVIEW instead of silently falling back to the direct
// connection and pretending it travelled through Quentra.
func (m *Manager) Check(ctx context.Context, req CheckRequest) CheckResult {
	route := "direct"
	if strings.EqualFold(req.Route, "quentra") {
		route = "quentra"
	}
	res := CheckResult{
		TraceID:        newTraceID(),
		Source:         "live",
		Route:          route,
		GatewayUp:      m.gatewayUp.Load() && m.gw != nil,
		InputTransport: "SQLBatch",
		// Until a rewrite is observed the backend transport is the same batch.
		OutputTransport: "SQLBatch",
		LastMovement:    "NONE",
	}

	if !m.provisioned.Load() || m.db == nil {
		res.Decision = "MANUAL_REVIEW"
		res.Reason = "Movement query failed"
		res.Evidence = "unavailable"
		res.Error = "access workload sağlanmadı (TIGERMARKET erişilemiyor)"
		return res
	}

	res.Key = keyForEmployee(req.EmployeeID)
	res.ApplicationSQL = applicationSQL(res.Key, res.TraceID)

	// Live-proof rule: the quentra route NEVER falls back to the direct
	// connection. A down gateway is reported as exactly that.
	if route == "quentra" && !res.GatewayUp {
		res.Decision = "MANUAL_REVIEW"
		res.Reason = "Quentra gateway unreachable"
		res.Evidence = "unavailable"
		res.Error = "Quentra gateway (:14330) erişilemiyor"
		return res
	}

	ctx, cancel := context.WithTimeout(ctx, queryTimeout)
	defer cancel()

	// Direct leg always runs: it is the "what did SQL Server receive without
	// Quentra" half of the comparison, same traceId, same statement text.
	direct := m.runCheckLeg(ctx, m.db, res.ApplicationSQL)
	res.DirectBackendSQL = direct.backendSQL
	res.DirectMs = direct.ms

	var quentra legResult
	if res.GatewayUp {
		quentra = m.runCheckLeg(ctx, m.gw, res.ApplicationSQL)
		res.QuentraBackendSQL = quentra.backendSQL
		res.QuentraMs = quentra.ms
		// A rule matched only if the gateway leg's captured text differs from
		// the direct leg's — measured, never assumed.
		res.RuleMatched = sqlDiffers(direct.backendSQL, quentra.backendSQL)
		if res.RuleMatched && looksLikeRPC(quentra.backendSQL) {
			res.OutputTransport = "RPC"
		}
	}

	// The decision comes from the REQUESTED route's own result.
	leg := direct
	if route == "quentra" {
		leg = quentra
	}
	res.ElapsedMs = leg.ms

	switch {
	case leg.err != nil:
		res.Decision = "MANUAL_REVIEW"
		res.Reason = "Movement query failed"
		res.Evidence = "error"
		res.Error = leg.err.Error()
	case leg.noRow:
		res.Decision = "MANUAL_REVIEW"
		res.Reason = "No previous movement found"
		res.Evidence = "measured"
	default:
		res.LastRef = leg.ref
		res.LastMovement = movementFromTRCODE(leg.trcode)
		res.Evidence = "measured"
		if res.LastMovement == "EXIT" {
			res.Decision = "ENTRY_APPROVED"
			res.Reason = "Last movement EXIT"
		} else {
			res.Decision = "ACCESS_DENIED"
			res.Reason = "Previous movement already ENTRY"
		}
	}

	// Live-check counters for the shared live card, plus the movement feed so
	// the card's feed shows floor-driven checks too.
	m.checkTotal.Add(1)
	if res.RuleMatched {
		m.checkRewrites.Add(1)
	}
	m.lastTrace.Store(res.TraceID)
	m.lastCheckNs.Store(int64(res.ElapsedMs * 1e6))
	if leg.err == nil {
		path := "baseline"
		if route == "quentra" {
			path = "quentra"
		}
		m.record(path, time.Duration(res.ElapsedMs*float64(time.Millisecond)), res.Key, leg.ref)
	}
	return res
}

// runCheckLeg executes the application statement on one route and captures the
// text that route's backend session ACTUALLY ran, read cross-session from a
// different connection (the direct pool) per sqlcapture's one rule.
func (m *Manager) runCheckLeg(ctx context.Context, pool *sql.DB, appSQL string) legResult {
	var out legResult
	conn, err := pool.Conn(ctx)
	if err != nil {
		out.err = err
		return out
	}
	defer conn.Close()

	spid, err := sqlcapture.BackendSPID(ctx, conn)
	if err != nil {
		out.err = err
		return out
	}

	var (
		date sql.NullTime
		amt  sql.NullFloat64
		prc  sql.NullFloat64
	)
	start := time.Now()
	err = conn.QueryRowContext(ctx, appSQL).Scan(&out.ref, &date, &amt, &prc, &out.trcode)
	out.ms = float64(time.Since(start).Nanoseconds()) / 1e6
	if err == sql.ErrNoRows {
		out.noRow = true
	} else if err != nil {
		out.err = err
		return out
	}

	// Capture what this backend session executed for the statement above. The
	// reader is always the direct pool — a different connection, so the read
	// cannot capture itself. Best-effort: a failed capture leaves the field
	// empty rather than failing the check.
	if text, cerr := sqlcapture.LastStatement(ctx, m.db, spid); cerr == nil {
		out.backendSQL = text
	}
	return out
}

// movementFromTRCODE maps the stock-transaction type to the turnstile analogy:
// slips that move stock OUT of the warehouse read as an EXIT movement, slips
// that bring stock IN read as ENTRY. Deterministic and derived from the real
// row — the same key always yields the same decision until new ERP data lands.
// (Logo TRCODE'ları: 6 alım iade, 7-8 satış, 9 konsinye çıkış, 11 fire,
// 12 sarf, 51 sayım eksiği → stok ÇIKIŞI.)
func movementFromTRCODE(trcode sql.NullInt64) string {
	if !trcode.Valid {
		return "NONE"
	}
	switch trcode.Int64 {
	case 6, 7, 8, 9, 11, 12, 51:
		return "EXIT"
	default:
		return "ENTRY"
	}
}

// keyForEmployee maps a floor employee id (e.g. "EMP-11042") to a stable
// STOCKREF in the data's real key range, so the same badge always asks about
// the same movement history.
func keyForEmployee(id string) int {
	if id == "" {
		return keyMin + rand.Intn(keyMax-keyMin+1)
	}
	h := fnv.New32a()
	_, _ = h.Write([]byte(id))
	return keyMin + int(h.Sum32()%uint32(keyMax-keyMin+1))
}

// looksLikeRPC reports whether a captured backend text is a parameterized RPC
// (sp_executesql-style) rather than an ad-hoc batch: the DMV text of such
// statements starts with the parameter declaration list.
func looksLikeRPC(text string) bool {
	t := strings.TrimSpace(text)
	return strings.HasPrefix(t, "(") || strings.Contains(strings.ToUpper(t), "SP_EXECUTESQL")
}

func newTraceID() string {
	return fmt.Sprintf("ACC-%06X", rand.Int63n(0x1000000))
}
