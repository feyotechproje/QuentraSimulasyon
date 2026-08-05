// Package aiguard runs the REAL workload behind the AI Guard prompt-injection
// defense demo.
//
// The scenario: a corporate AI assistant answers employees' natural-language
// questions by retrieving support tickets and summarizing them. An attacker has
// planted instructions inside a ticket body. That row is not an SQL injection —
// it is ordinary text — so nothing on the request side objects to it. The
// hijack happens when the row lands in the model's context.
//
// Both ends of that chain cross the gateway, and the demo shows both:
//
//   - "baseline": the retrieval query goes straight to SQL Server, the poisoned
//     row reaches the model verbatim, and whatever the hijacked assistant asks
//     for next is executed. The leak is measured, not asserted.
//   - "quentra": the identical query travels the gateway (:14330). Planted
//     instructions are neutralized in the response with the field's length
//     preserved, and any out-of-scope statement the assistant still produces is
//     refused at the gate.
//
// HONESTY: the demo distinguishes a quarantine performed BY the gateway from
// one performed by this simulator. Both routes run the same query; if the
// gateway route comes back with different bytes than the direct route, Quentra
// really transformed the response and the UI reports "ölçüldü". When the two
// agree, no gateway rule is configured, this package applies the transform
// itself and the UI says so. See quarantineSource.
package aiguard

import (
	"context"
	"database/sql"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"log/slog"

	_ "github.com/microsoft/go-mssqldb"

	"supermarketsim/internal/config"
)

const (
	queryTimeout = 10 * time.Second
	askTimeout   = 60 * time.Second
	// pacing keeps the ambient retrieval stream at a watchable rhythm. The
	// background worker never calls the model — only SQL — so leaving the page
	// running costs nothing at the provider.
	pacing   = 2200 * time.Millisecond
	feedSize = 12
	// exfilRowCap bounds how much a demonstrated leak actually reads.
	exfilRowCap = 5000
)

// Quarantine provenance.
const (
	QuarantineNone      = "none"
	QuarantineGateway   = "gateway"
	QuarantineSimulated = "simulated"
)

// RowFinding is the scan verdict for one retrieved row, with the text before
// and after so the UI can show the transform rather than claim it.
type RowFinding struct {
	ID       int      `json:"id"`
	Musteri  string   `json:"musteri"`
	Konu     string   `json:"konu"`
	Durum    string   `json:"durum"`
	Kanal    string   `json:"kanal"`
	Poisoned bool     `json:"poisoned"`
	Before   string   `json:"before"`
	After    string   `json:"after"`
	Boundary int      `json:"boundary"`
	Signals  []Signal `json:"signals"`
}

// AskEvent is one completed assistant turn, shown in the live feed.
type AskEvent struct {
	Question    string `json:"question"`
	Mode        string `json:"mode"`
	Poisoned    int    `json:"poisoned"`
	Hijacked    bool   `json:"hijacked"`
	Blocked     bool   `json:"blocked"`
	Neutralized bool   `json:"neutralized"`
	Leaked      int64  `json:"leaked"`
	Prevented   int64  `json:"prevented"`
	Source      string `json:"source"`
	Ms          int64  `json:"ms"`
	At          int64  `json:"at"`
}

// AskResult is the full record of one turn — every stage, so the UI can render
// the chain instead of a verdict.
type AskResult struct {
	Mode            string `json:"mode"`
	Question        string `json:"question"`
	Route           string `json:"route"`
	GatewayUp       bool   `json:"gatewayUp"`
	RetrieveSQL     string `json:"retrieveSql"`
	RetrieveMs      int64  `json:"retrieveMs"`
	RetrievalKind   string `json:"retrievalKind"`
	RetrievalTerm   string `json:"retrievalTerm,omitempty"`
	RetrievalStatus string `json:"retrievalStatus,omitempty"`
	RetrievedRows   int    `json:"retrievedRows"`

	Findings    []RowFinding `json:"findings"`
	ContextRows []ContextRow `json:"contextRows"`

	QuarantineSource string `json:"quarantineSource"`
	PoisonedRows     int    `json:"poisonedRows"`
	CleanRows        int    `json:"cleanRows"`
	QuarantinedRunes int    `json:"quarantinedRunes"`
	LengthPreserved  bool   `json:"lengthPreserved"`

	Assistant AssistantReply `json:"assistant"`
	Action    ActionVerdict  `json:"action"`
	Hijacked  bool           `json:"hijacked"`
	Blocked   bool           `json:"blocked"`
	Executed  bool           `json:"executed"`
	// Neutralized marks a layer-1 save: a payload really was present, the
	// response-side transform really ran, and the model consequently never
	// produced a hostile action. Without this the primary defense would look
	// like an uneventful turn, because the thing it prevents is the thing that
	// then does not happen.
	Neutralized bool `json:"neutralized"`
	// ExecNote explains why a hijacked action produced no measured leak, so an
	// empty figure reads as a reason rather than a zero.
	ExecNote string `json:"execNote,omitempty"`

	LeakedRecords    int64 `json:"leakedRecords"`
	PreventedRecords int64 `json:"preventedRecords"`

	TotalMs int64  `json:"totalMs"`
	Error   string `json:"error,omitempty"`
}

// Metrics is the JSON snapshot served to the UI. Real.
type Metrics struct {
	Mode        string `json:"mode"`
	Running     bool   `json:"running"`
	Provisioned bool   `json:"provisioned"`
	GatewayUp   bool   `json:"gatewayUp"`

	LLMLive  bool   `json:"llmLive"`
	LLMModel string `json:"llmModel"`

	Asks             int64 `json:"asks"`
	RetrievalTurns   int64 `json:"retrievalTurns"`
	PoisonedRowsSeen int64 `json:"poisonedRowsSeen"`
	QuarantinedRows  int64 `json:"quarantinedRows"`
	CleanRowsPassed  int64 `json:"cleanRowsPassed"`
	Hijacks          int64 `json:"hijacks"`
	BlockedActions   int64 `json:"blockedActions"`
	LeakedRecords    int64 `json:"leakedRecords"`
	PreventedRecords int64 `json:"preventedRecords"`
	Errors           int64 `json:"errors"`

	CustomerRows int64 `json:"customerRows"`
	TicketRows   int64 `json:"ticketRows"`

	RetrieveMs float64 `json:"retrieveMs"`
	ScanMs     float64 `json:"scanMs"`

	// QuarantineSource is the provenance of the most recent transform, so the
	// UI never claims the gateway did something this process did.
	QuarantineSource string `json:"quarantineSource"`

	RetrieveSQL string       `json:"retrieveSql"`
	Findings    []RowFinding `json:"findings"`
	Recent      []AskEvent   `json:"recent"`
	LastAsk     *AskResult   `json:"lastAsk,omitempty"`
	LastError   string       `json:"lastError"`
	LastSample  int64        `json:"lastSample"`
}

// Manager owns both pools, the ambient retrieval worker and the assistant.
type Manager struct {
	cfg       *config.Config
	log       *slog.Logger
	assistant *Assistant

	db *sql.DB // direct route
	gw *sql.DB // through the Quentra gateway; nil when the gateway is down

	mode        atomic.Value // "baseline" | "quentra"
	running     atomic.Bool
	provisioned atomic.Bool
	gatewayUp   atomic.Bool

	asks             atomic.Int64
	retrievalTurns   atomic.Int64
	poisonedRowsSeen atomic.Int64
	quarantinedRows  atomic.Int64
	cleanRowsPassed  atomic.Int64
	hijacks          atomic.Int64
	blockedActions   atomic.Int64
	leakedRecords    atomic.Int64
	preventedRecords atomic.Int64
	errors           atomic.Int64

	customerRows atomic.Int64
	ticketRows   atomic.Int64

	retrieveNs atomic.Int64
	scanNs     atomic.Int64

	mu         sync.RWMutex
	findings   []RowFinding
	lastAsk    *AskResult
	lastErr    string
	quarantine string

	feedMu sync.Mutex
	feed   []AskEvent

	chMu   sync.Mutex
	stopCh chan struct{}
	wg     sync.WaitGroup
}

// NewManager creates an un-provisioned manager. Call Provision then Start.
func NewManager(cfg *config.Config, log *slog.Logger) *Manager {
	m := &Manager{cfg: cfg, log: log, assistant: NewAssistant(cfg), stopCh: make(chan struct{})}
	m.mode.Store("quentra") // default: shield ON, so an idle demo is not "leaking"
	m.quarantine = QuarantineNone
	return m
}

func (m *Manager) modeStr() string {
	v, _ := m.mode.Load().(string)
	if v == "" {
		return "quentra"
	}
	return v
}

// SetMode maps the page's toggle onto the two states.
func (m *Manager) SetMode(mode string) {
	switch mode {
	case "off", "baseline", "unprotected", "koruma-kapali":
		m.mode.Store("baseline")
	case "on", "quentra", "protected", "active":
		m.mode.Store("quentra")
	}
}

// State returns the latest snapshot merged with live counters.
func (m *Manager) State() Metrics {
	out := Metrics{
		Mode:        m.modeStr(),
		Running:     m.running.Load(),
		Provisioned: m.provisioned.Load(),
		GatewayUp:   m.gatewayUp.Load(),
		LLMLive:     m.assistant.Live(),
		LLMModel:    m.assistant.Model(),
		RetrieveSQL: retrieveSQL,

		Asks:             m.asks.Load(),
		RetrievalTurns:   m.retrievalTurns.Load(),
		PoisonedRowsSeen: m.poisonedRowsSeen.Load(),
		QuarantinedRows:  m.quarantinedRows.Load(),
		CleanRowsPassed:  m.cleanRowsPassed.Load(),
		Hijacks:          m.hijacks.Load(),
		BlockedActions:   m.blockedActions.Load(),
		LeakedRecords:    m.leakedRecords.Load(),
		PreventedRecords: m.preventedRecords.Load(),
		Errors:           m.errors.Load(),
		CustomerRows:     m.customerRows.Load(),
		TicketRows:       m.ticketRows.Load(),
		RetrieveMs:       round2(float64(m.retrieveNs.Load()) / 1e6),
		ScanMs:           round2(float64(m.scanNs.Load()) / 1e6),
		LastSample:       time.Now().UnixMilli(),
	}
	m.mu.RLock()
	out.Findings = append([]RowFinding(nil), m.findings...)
	out.LastAsk = m.lastAsk
	out.LastError = m.lastErr
	out.QuarantineSource = m.quarantine
	m.mu.RUnlock()
	m.feedMu.Lock()
	out.Recent = append([]AskEvent(nil), m.feed...)
	m.feedMu.Unlock()
	return out
}

// Provision creates the disposable database, tables and seed rows.
func (m *Manager) Provision(ctx context.Context) error {
	master, err := sql.Open("sqlserver", m.cfg.DSNFor("master", config.AppSetup))
	if err != nil {
		return err
	}
	if _, err := master.ExecContext(ctx,
		`IF DB_ID(N'`+DBName+`') IS NULL CREATE DATABASE [`+DBName+`];`); err != nil {
		_ = master.Close()
		return err
	}
	_ = master.Close()

	pool, err := sql.Open("sqlserver", m.cfg.DSNFor(DBName, config.AppAIGuard))
	if err != nil {
		return err
	}
	pool.SetMaxOpenConns(6)
	pool.SetMaxIdleConns(3)
	pool.SetConnMaxLifetime(30 * time.Minute)
	if err := pool.PingContext(ctx); err != nil {
		_ = pool.Close()
		return err
	}
	m.db = pool

	for _, stmt := range provisionStmts {
		if _, err := m.db.ExecContext(ctx, stmt); err != nil {
			return err
		}
	}

	// Seed the tickets only when the table is empty, so a re-run never stacks
	// duplicate payloads on top of the existing corpus.
	var tickets int64
	if err := m.db.QueryRowContext(ctx, countTicketsSQL).Scan(&tickets); err != nil {
		return err
	}
	if tickets == 0 {
		for _, t := range seedTickets {
			if _, err := m.db.ExecContext(ctx, insertTicketSQL,
				sql.Named("musteri", t.Musteri), sql.Named("kanal", t.Kanal),
				sql.Named("durum", t.Durum), sql.Named("konu", t.Konu),
				sql.Named("mesaj", t.Mesaj)); err != nil {
				return err
			}
		}
		if err := m.db.QueryRowContext(ctx, countTicketsSQL).Scan(&tickets); err != nil {
			return err
		}
	}
	m.ticketRows.Store(tickets)

	var customers int64
	if err := m.db.QueryRowContext(ctx, countCustomersSQL).Scan(&customers); err != nil {
		return err
	}
	m.customerRows.Store(customers)

	// Second pool through the Quentra gateway. Best-effort: with the gateway
	// down the protected route falls back to direct and the UI says so rather
	// than pretending traffic crossed a proxy that is not there.
	if gw, err := sql.Open("sqlserver", m.cfg.QuentraDSNFor(DBName, config.AppAIGuard)); err == nil {
		gw.SetMaxOpenConns(6)
		gw.SetMaxIdleConns(3)
		gw.SetConnMaxLifetime(30 * time.Minute)
		gctx, gcancel := context.WithTimeout(ctx, 10*time.Second)
		if perr := gw.PingContext(gctx); perr == nil {
			m.gw = gw
			m.gatewayUp.Store(true)
		} else {
			_ = gw.Close()
			m.log.Warn("quentra gateway unreachable; aiguard protected route uses direct", "error", perr.Error())
		}
		gcancel()
	}

	m.provisioned.Store(true)
	return nil
}

func (m *Manager) quentraPool() *sql.DB {
	if m.gw != nil {
		return m.gw
	}
	return m.db
}

func (m *Manager) routePool() (*sql.DB, string) {
	if m.modeStr() == "quentra" {
		return m.quentraPool(), "quentra"
	}
	return m.db, "direct"
}

// Start launches the ambient retrieval worker. Safe to call after Pause.
func (m *Manager) Start() {
	if !m.provisioned.Load() || m.db == nil {
		return
	}
	if m.running.Swap(true) {
		return
	}
	m.chMu.Lock()
	m.stopCh = make(chan struct{})
	stop := m.stopCh
	m.chMu.Unlock()

	m.wg.Add(1)
	go m.worker(stop)
}

// Pause halts the worker but keeps the pools open.
func (m *Manager) Pause() {
	if !m.running.Swap(false) {
		return
	}
	m.chMu.Lock()
	if m.stopCh != nil {
		close(m.stopCh)
	}
	m.chMu.Unlock()
	m.wg.Wait()
}

// Stop halts the workload and closes both pools. Called on shutdown.
func (m *Manager) Stop() {
	m.Pause()
	if m.gw != nil {
		_ = m.gw.Close()
	}
	if m.db != nil {
		_ = m.db.Close()
	}
}

// worker keeps the retrieval query flowing so the page shows live data without
// spending model calls. It performs stages 1 and 2 only.
func (m *Manager) worker(stop <-chan struct{}) {
	defer m.wg.Done()
	for {
		select {
		case <-stop:
			return
		default:
		}
		if _, _, err := m.retrieveAndScan(context.Background(), retrievalPlan{Kind: retrievalBroad, Status: "açık"}); err != nil {
			m.errors.Add(1)
			m.setErr(err.Error())
		}
		m.retrievalTurns.Add(1)
		m.sleep(stop, pacing)
	}
}

// retrieveAndScan runs stage 1 (the legitimate query, on the mode's route) and
// stage 2 (the response-side transform), and records what each produced.
func (m *Manager) retrieveAndScan(ctx context.Context, plan retrievalPlan) ([]RowFinding, []ContextRow, error) {
	pool, route := m.routePool()

	qctx, cancel := context.WithTimeout(ctx, queryTimeout)
	defer cancel()

	start := time.Now()
	rows, err := m.fetch(qctx, pool, plan)
	m.retrieveNs.Store(time.Since(start).Nanoseconds())
	if err != nil {
		return nil, nil, err
	}

	// When the protected route is in play, run the identical query on the
	// direct route too. Divergence between the two is the only honest evidence
	// that the gateway itself transformed the response.
	var direct []ContextRow
	if route == "quentra" && m.gw != nil {
		dctx, dcancel := context.WithTimeout(ctx, queryTimeout)
		direct, _ = m.fetch(dctx, m.db, plan)
		dcancel()
	}

	scanStart := time.Now()
	findings, ctxRows, source := m.applyGuard(rows, direct, route)
	m.scanNs.Store(time.Since(scanStart).Nanoseconds())

	poisoned, clean := 0, 0
	for _, f := range findings {
		if f.Poisoned {
			poisoned++
		} else {
			clean++
		}
	}
	m.poisonedRowsSeen.Add(int64(poisoned))
	m.cleanRowsPassed.Add(int64(clean))
	if source != QuarantineNone {
		m.quarantinedRows.Add(int64(poisoned))
	}

	m.mu.Lock()
	m.findings = findings
	m.quarantine = source
	m.mu.Unlock()

	return findings, ctxRows, nil
}

// applyGuard decides what the model is allowed to see, and reports where the
// decision came from.
func (m *Manager) applyGuard(rows, direct []ContextRow, route string) ([]RowFinding, []ContextRow, string) {
	source := QuarantineNone
	if route == "quentra" {
		source = QuarantineSimulated
		// If the gateway already rewrote the response, the two routes disagree
		// and there is nothing left for this process to do.
		if len(direct) == len(rows) && len(rows) > 0 && diverged(rows, direct) {
			source = QuarantineGateway
		}
	}

	findings := make([]RowFinding, 0, len(rows))
	ctxRows := make([]ContextRow, 0, len(rows))
	hasPoison := false

	for i, r := range rows {
		original := r.Mesaj
		if source == QuarantineGateway && i < len(direct) && direct[i].ID == r.ID {
			// The unprotected text is what the direct route returned; the
			// gateway's version is already in r. Only pair rows that are
			// genuinely the same record — never by position alone.
			original = direct[i].Mesaj
		}

		verdict := Scan(original)
		hasPoison = hasPoison || verdict.Poisoned
		f := RowFinding{
			ID: r.ID, Musteri: r.Musteri, Konu: r.Konu,
			Durum: r.Durum, Kanal: r.Kanal,
			Poisoned: verdict.Poisoned, Before: original,
			Boundary: verdict.Boundary, Signals: verdict.Signals,
		}

		out := r
		switch source {
		case QuarantineGateway:
			// Show exactly what came off the wire — no local edit.
			f.After = r.Mesaj
		case QuarantineSimulated:
			out.Mesaj = verdict.Clean
			f.After = verdict.Clean
		default:
			f.After = original
			out.Mesaj = original
		}

		findings = append(findings, f)
		ctxRows = append(ctxRows, out)
	}
	// A protected route with only ordinary records did not perform a
	// quarantine. Reporting "simulated" here made clean questions look like an
	// injection incident even though no detector fired.
	if !hasPoison {
		source = QuarantineNone
	}
	return findings, ctxRows, source
}

func diverged(a, b []ContextRow) bool {
	for i := range a {
		if a[i].ID == b[i].ID && a[i].Mesaj != b[i].Mesaj {
			return true
		}
	}
	return false
}

func (m *Manager) fetch(ctx context.Context, pool *sql.DB, plan retrievalPlan) ([]ContextRow, error) {
	// A non-support question intentionally creates an empty RAG window. The
	// sentinel cannot occur in the seeded corpus, while keeping the SQL shape
	// and route identical for direct/gateway comparison.
	search := ""
	if plan.Kind == retrievalNone {
		search = "%__AIGUARD_NO_RELEVANT_CONTEXT__%"
	} else if plan.Term != "" {
		search = "%" + plan.Term + "%"
	}
	rows, err := pool.QueryContext(ctx, retrieveSQL,
		sql.Named("top", retrieveLimit), sql.Named("durum", plan.Status), sql.Named("arama", search))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []ContextRow
	for rows.Next() {
		var r ContextRow
		if err := rows.Scan(&r.ID, &r.Musteri, &r.Kanal, &r.Durum, &r.Konu, &r.Mesaj); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// ---------------------------------------------------------------- the turn ---

// Ask runs one full assistant turn: retrieve, guard, model, gate, execute.
func (m *Manager) Ask(ctx context.Context, question string) AskResult {
	if !m.provisioned.Load() || m.db == nil {
		return AskResult{Error: "AIGUARD veritabanı henüz hazır değil"}
	}
	if strings.TrimSpace(question) == "" {
		return AskResult{Error: "soru boş olamaz"}
	}

	turnStart := time.Now()
	mode := m.modeStr()
	_, route := m.routePool()
	plan := planRetrieval(question)

	res := AskResult{
		Mode: mode, Question: question, Route: route,
		GatewayUp: m.gatewayUp.Load(), RetrieveSQL: retrieveSQL,
		RetrievalKind: plan.Kind, RetrievalTerm: plan.Term, RetrievalStatus: plan.Status,
	}

	actx, cancel := context.WithTimeout(ctx, askTimeout)
	defer cancel()

	retrieveStart := time.Now()
	findings, ctxRows, err := m.retrieveAndScan(actx, plan)
	res.RetrieveMs = time.Since(retrieveStart).Milliseconds()
	if err != nil {
		m.errors.Add(1)
		m.setErr(err.Error())
		res.Error = err.Error()
		return res
	}

	res.Findings = findings
	res.ContextRows = ctxRows
	res.RetrievedRows = len(ctxRows)
	m.mu.RLock()
	res.QuarantineSource = m.quarantine
	m.mu.RUnlock()

	for _, f := range findings {
		if f.Poisoned {
			res.PoisonedRows++
			res.QuarantinedRunes += len([]rune(f.Before)) - commonPrefixRunes(f.Before, f.After)
		} else {
			res.CleanRows++
		}
	}
	res.LengthPreserved = lengthPreserved(findings)

	// Stage 3: the model.
	m.asks.Add(1)
	res.Assistant = m.assistant.Ask(actx, question, ctxRows)
	if res.Assistant.Err != "" {
		m.setErr(res.Assistant.Err)
	}

	// Stage 4: the gate.
	res.Action = ClassifyAction(res.Assistant.FollowupSQL)
	res.Hijacked = res.Action.Kind == ActionExfil || res.Action.Kind == ActionDestructive
	if res.Hijacked {
		m.hijacks.Add(1)
	}

	// Stage 5: what actually happens to that action.
	switch {
	case !res.Hijacked:
		// Nothing to stop.
	case mode == "quentra":
		res.Blocked = true
		m.blockedActions.Add(1)
		res.PreventedRecords = m.reachableRecords(actx, res.Assistant.FollowupSQL)
		m.preventedRecords.Add(res.PreventedRecords)
	case res.Action.Kind == ActionExfil && safeToExecute(res.Assistant.FollowupSQL):
		// Unprotected path, read-only statement: run it for real against the
		// synthetic table so the leak is a measured row count, not a claim.
		n, execErr := m.runExfil(actx, res.Assistant.FollowupSQL)
		if execErr != nil {
			m.errors.Add(1)
			m.setErr(execErr.Error())
			res.Error = execErr.Error()
			res.ExecNote = "sorgu çalıştırılamadı"
		} else {
			res.Executed = true
			res.LeakedRecords = n
			m.leakedRecords.Add(n)
		}

	default:
		// Destructive, or something the safety belt refuses to hand to the
		// server. It is classified and counted as a hijack, but nothing runs —
		// and the leak counter stays at zero rather than inventing a number for
		// an action that never happened.
		res.ExecNote = "yıkıcı ifade — simülasyon güvenliği gereği çalıştırılmadı"
	}

	res.Neutralized = res.PoisonedRows > 0 &&
		res.QuarantineSource != QuarantineNone && !res.Hijacked
	res.TotalMs = time.Since(turnStart).Milliseconds()

	ev := AskEvent{
		Question: trimQ(question), Mode: mode, Poisoned: res.PoisonedRows,
		Hijacked: res.Hijacked, Blocked: res.Blocked, Neutralized: res.Neutralized,
		Leaked: res.LeakedRecords, Prevented: res.PreventedRecords,
		Source: res.Assistant.Source, Ms: res.TotalMs, At: time.Now().UnixMilli(),
	}
	m.feedMu.Lock()
	m.feed = append([]AskEvent{ev}, m.feed...)
	if len(m.feed) > feedSize {
		m.feed = m.feed[:feedSize]
	}
	m.feedMu.Unlock()

	snapshot := res
	m.mu.Lock()
	m.lastAsk = &snapshot
	m.mu.Unlock()

	return res
}

// safeToExecute is this simulator's own safety belt, NOT part of the defense
// being demonstrated: it refuses to hand a model-authored statement to the
// server unless it is a single read-only SELECT confined to the disposable
// AIGUARD tables. The demo's argument is about the gate in ClassifyAction; this
// check exists so a creative model can never damage the environment.
var (
	singleSelectRE = regexp.MustCompile(`(?is)^\s*select\b[^;]*;?\s*$`)
	agTableRE      = regexp.MustCompile(`(?i)\bfrom\s+(\[?dbo\]?\.)?\[?ag_(tickets|customers)\]?\b`)
)

func safeToExecute(stmt string) bool {
	s := strings.TrimSpace(stmt)
	if s == "" || !singleSelectRE.MatchString(s) {
		return false
	}
	if destructiveRE.MatchString(s) {
		return false
	}
	return agTableRE.MatchString(s)
}

// runExfil executes the hijacked read and returns how many records it yielded.
func (m *Manager) runExfil(ctx context.Context, stmt string) (int64, error) {
	qctx, cancel := context.WithTimeout(ctx, queryTimeout)
	defer cancel()

	rows, err := m.db.QueryContext(qctx, stmt)
	if err != nil {
		return 0, err
	}
	defer rows.Close()

	var n int64
	for rows.Next() && n < exfilRowCap {
		n++
	}
	return n, rows.Err()
}

// reachableRecords reports how many records the refused statement would have
// reached. When the target cannot be determined the answer is zero, never a
// guess — an unmeasurable prevention counts as nothing prevented.
func (m *Manager) reachableRecords(ctx context.Context, stmt string) int64 {
	if !customersRE.MatchString(stmt) {
		return 0
	}
	qctx, cancel := context.WithTimeout(ctx, queryTimeout)
	defer cancel()
	var n int64
	if err := m.db.QueryRowContext(qctx, countCustomersSQL).Scan(&n); err != nil {
		return 0
	}
	m.customerRows.Store(n)
	return n
}

// lengthPreserved verifies the transform kept every field's width — the
// constraint that lets a live gateway rewrite a response without corrupting the
// client's buffers. Reported, not assumed.
func lengthPreserved(findings []RowFinding) bool {
	for _, f := range findings {
		if !f.Poisoned {
			continue
		}
		if len([]rune(f.Before)) != len([]rune(f.After)) {
			return false
		}
	}
	return true
}

func commonPrefixRunes(a, b string) int {
	ra, rb := []rune(a), []rune(b)
	n := 0
	for n < len(ra) && n < len(rb) && ra[n] == rb[n] {
		n++
	}
	return n
}

func (m *Manager) setErr(msg string) {
	m.mu.Lock()
	m.lastErr = msg
	m.mu.Unlock()
}

func (m *Manager) sleep(stop <-chan struct{}, d time.Duration) {
	select {
	case <-stop:
	case <-time.After(d):
	}
}

func trimQ(s string) string {
	s = strings.TrimSpace(s)
	if len([]rune(s)) > 70 {
		return string([]rune(s)[:70]) + "…"
	}
	return s
}

func round2(v float64) float64 { return float64(int64(v*100+0.5)) / 100 }
