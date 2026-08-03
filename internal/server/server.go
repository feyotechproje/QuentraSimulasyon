package server

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"supermarketsim/internal/access"
	"supermarketsim/internal/config"
	"supermarketsim/internal/dashboard"
	"supermarketsim/internal/db"
	"supermarketsim/internal/fulltext"
	"supermarketsim/internal/keybreaker"
	"supermarketsim/internal/production"
	"supermarketsim/internal/reportcache"
	"supermarketsim/internal/sim"
	"supermarketsim/internal/vehicle"
)

//go:embed web
var webFS embed.FS

// Server wires HTTP routes to the simulation engine and SSE hub.
type Server struct {
	engine      *sim.Engine
	hub         *sim.Hub
	store       *db.Store
	vehicle     *vehicle.Manager
	production  *production.Manager
	reportCache *reportcache.Manager
	fulltext    *fulltext.Manager
	keyBreaker  *keybreaker.Manager
	access      *access.Manager
	cfg         *config.Config
	log         *slog.Logger
}

// New creates the HTTP server.
func New(engine *sim.Engine, hub *sim.Hub, store *db.Store, veh *vehicle.Manager, prod *production.Manager, rc *reportcache.Manager, ft *fulltext.Manager, kb *keybreaker.Manager, acc *access.Manager, cfg *config.Config, log *slog.Logger) *Server {
	return &Server{engine: engine, hub: hub, store: store, vehicle: veh, production: prod, reportCache: rc, fulltext: ft, keyBreaker: kb, access: acc, cfg: cfg, log: log}
}

// Handler builds the router.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	// Static UI.
	sub, _ := fs.Sub(webFS, "web")
	mux.Handle("GET /", http.FileServer(http.FS(sub)))

	// State + settings.
	mux.HandleFunc("GET /api/state", s.handleState)
	mux.HandleFunc("GET /api/settings", s.handleGetSettings)
	mux.HandleFunc("POST /api/settings", s.handleSetSettings)
	mux.HandleFunc("POST /api/env-check", s.handleEnvCheck)

	// Lifecycle controls.
	mux.HandleFunc("POST /api/start", s.wrap(func() error { return s.engine.Start() }))
	mux.HandleFunc("POST /api/pause", s.wrap(func() error { return s.engine.Pause() }))
	mux.HandleFunc("POST /api/resume", s.wrap(func() error { return s.engine.Resume() }))
	mux.HandleFunc("POST /api/stop", s.wrap(func() error { return s.engine.Stop() }))
	mux.HandleFunc("POST /api/reset", s.wrap(func() error { return s.engine.Reset() }))
	mux.HandleFunc("POST /api/add-customer", s.wrap(func() error { return s.engine.AddCustomer() }))

	// Retail stock-lookup scenario (direct connection vs Quentra rewrite).
	mux.HandleFunc("GET /api/stock-mode", s.handleGetStockMode)
	mux.HandleFunc("POST /api/stock-mode", s.handleSetStockMode)

	// Register controls.
	mux.HandleFunc("POST /api/open-register", s.handleRegister(true))
	mux.HandleFunc("POST /api/close-register", s.handleRegister(false))
	mux.HandleFunc("POST /api/retry", s.handleRetry)

	// Real-time stream.
	mux.HandleFunc("GET /api/events", s.handleEvents)

	// Portal run/stop controls. No workload runs at boot; each is started
	// explicitly from the home page (or its own simulation page) so idle SQL
	// Server traffic stops when nothing is being demoed.
	mux.HandleFunc("GET /api/workloads", s.handleWorkloadList)
	mux.HandleFunc("POST /api/workloads/{id}/start", s.handleWorkloadAction(true))
	mux.HandleFunc("POST /api/workloads/{id}/stop", s.handleWorkloadAction(false))

	// Quentra Dashboard Performance Lab (demo dashboard endpoints).
	dashboard.NewHandler(s.cfg, s.log).Register(mux)

	// Vehicle tracking real-DB workload endpoints.
	mux.HandleFunc("GET /api/vehicle/state", s.handleVehicleState)
	mux.HandleFunc("POST /api/vehicle/mode", s.handleVehicleMode)

	// Production line real-DB workload endpoints.
	mux.HandleFunc("GET /api/production/state", s.handleProductionState)
	mux.HandleFunc("POST /api/production/mode", s.handleProductionMode)

	// Report cache real-DB workload endpoints (live mode of the report-cache sim).
	mux.HandleFunc("GET /api/reportcache/state", s.handleReportCacheState)
	mux.HandleFunc("POST /api/reportcache/mode", s.handleReportCacheMode)
	mux.HandleFunc("POST /api/reportcache/reset", s.handleReportCacheReset)

	// FullText / NGram search real-DB workload endpoints (CRM2 customer search).
	mux.HandleFunc("GET /api/fulltext/state", s.handleLiveState(func() any { return s.fulltextState() }))
	mux.HandleFunc("POST /api/fulltext/mode", s.handleFulltextMode)

	// Key Breaker SQL-injection defense real workload endpoints.
	mux.HandleFunc("GET /api/keybreaker/state", s.handleLiveState(func() any { return s.keyBreakerState() }))
	mux.HandleFunc("POST /api/keybreaker/mode", s.handleKeyBreakerMode)

	// Turnstile / factory access "last movement" real-DB workload endpoints.
	mux.HandleFunc("GET /api/access/state", s.handleLiveState(func() any { return s.accessState() }))
	mux.HandleFunc("POST /api/access/mode", s.handleAccessMode)

	return withCORS(mux)
}

func (s *Server) handleState(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"settings": s.engine.Settings(),
		"snapshot": s.engine.BuildSnapshot(),
		"state":    s.engine.State(),
	})
}

func (s *Server) handleGetSettings(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.engine.Settings())
}

func (s *Server) handleSetSettings(w http.ResponseWriter, r *http.Request) {
	var in sim.Settings
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if err := s.engine.Configure(in); err != nil {
		writeErr(w, http.StatusConflict, err)
		return
	}
	writeJSON(w, http.StatusOK, s.engine.Settings())
}

// stockModePayload describes the current scenario plus the exact SQL executed on
// each side of the Quentra rewrite, so the UI can show a grounded before/after.
func (s *Server) stockModePayload(ctx context.Context) map[string]any {
	st := s.engine.Settings()
	out := map[string]any{
		"mode":           st.StockMode(), // off|baseline|quentra
		"stockLookup":    st.StockLookup,
		"quentraRewrite": st.QuentraRewrite,
	}
	if s.store != nil {
		// Baseline is the exact statement the application sends; the direct route
		// never rewrites, so the static form already is the real one.
		out["baselineSQL"] = s.store.ItemScanSQL(false)
		// Quentra side: the statement SQL Server actually received through the
		// gateway, captured from its DMVs — the real rewrite when a rule matched,
		// the unchanged statement when none did. Never the hand-authored rewrite,
		// so the panel cannot claim a rewrite that did not happen.
		qSQL, qRewritten := s.capturedQuentraSQL(ctx)
		out["quentraSQL"] = qSQL
		// quentraRewritten drives the badge: true only when the gateway actually
		// eliminated the UDF call, so the UI stops claiming "Call eliminated" when
		// no rewrite rule matched.
		out["quentraRewritten"] = qRewritten
		// Without the gateway both modes travel the same route, so the UI must
		// not present the comparison as if it were real.
		out["gatewayUp"] = s.store.HasQuentraGateway()
	}
	return out
}

// capturedQuentraSQL returns the statement SQL Server received on the Quentra
// route (captured from its DMVs) and whether that statement shows a real rewrite
// — i.e. the stock UDF call was eliminated. It falls back to the unrewritten
// application statement (rewritten=false) so the panel never fakes a rewrite.
func (s *Server) capturedQuentraSQL(ctx context.Context) (string, bool) {
	capCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	if got, err := s.store.CaptureScanSQL(capCtx, true); err == nil && got != "" {
		// The rewrite eliminated the call when the captured statement no longer
		// mentions the stock UDF.
		rewritten := !strings.Contains(strings.ToUpper(got), strings.ToUpper(db.StockFunctionName))
		return got, rewritten
	}
	return s.store.ItemScanSQL(false), false
}

func (s *Server) handleGetStockMode(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.stockModePayload(r.Context()))
}

// handleSetStockMode switches the per-scan stock lookup between the direct
// connection and the Quentra rewrite, live, without
// restarting the simulation.
func (s *Server) handleSetStockMode(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Mode string `json:"mode"` // off|baseline|quentra
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	switch body.Mode {
	case "off":
		s.engine.SetStockMode(false, false)
	case "baseline":
		s.engine.SetStockMode(true, false)
	case "quentra":
		s.engine.SetStockMode(true, true)
	default:
		writeErr(w, http.StatusBadRequest, fmt.Errorf("unknown stock mode %q (want off|baseline|quentra)", body.Mode))
		return
	}
	writeJSON(w, http.StatusOK, s.stockModePayload(r.Context()))
}

func (s *Server) handleEnvCheck(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()

	schema, err := s.store.DetectSchema(ctx)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	report := s.store.EnvironmentCheck(ctx, schema)
	s.engine.SetCurrency(report.Currency)
	writeJSON(w, http.StatusOK, report)
}

func (s *Server) handleRegister(open bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			No int `json:"no"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		var err error
		if open {
			err = s.engine.OpenRegister(body.No)
		} else {
			err = s.engine.CloseRegister(body.No)
		}
		if err != nil {
			writeErr(w, http.StatusConflict, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

func (s *Server) handleRetry(w http.ResponseWriter, r *http.Request) {
	var body struct {
		BasketID string `json:"basketId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.BasketID == "" {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("basketId required"))
		return
	}
	if err := s.engine.RetryBasket(body.BasketID); err != nil {
		writeErr(w, http.StatusConflict, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleEvents streams snapshot frames to the client over SSE.
func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	ch, cancel := s.hub.Subscribe()
	defer cancel()

	// Send an initial frame immediately.
	if frame, err := json.Marshal(s.engine.BuildSnapshot()); err == nil {
		fmt.Fprintf(w, "data: %s\n\n", frame)
		flusher.Flush()
	}

	keepAlive := time.NewTicker(15 * time.Second)
	defer keepAlive.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case frame, ok := <-ch:
			if !ok {
				return
			}
			fmt.Fprintf(w, "data: %s\n\n", frame)
			flusher.Flush()
		case <-keepAlive.C:
			fmt.Fprint(w, ": keep-alive\n\n")
			flusher.Flush()
		}
	}
}

// wrap turns a no-arg engine action into an HTTP handler.
func (s *Server) wrap(action func() error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := action(); err != nil {
			writeErr(w, http.StatusConflict, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "state": s.engine.State()})
	}
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func (s *Server) handleVehicleState(w http.ResponseWriter, r *http.Request) {
	if s.vehicle == nil {
		writeJSON(w, http.StatusOK, map[string]any{"provisioned": false, "running": false})
		return
	}
	writeJSON(w, http.StatusOK, s.vehicle.State())
}

func (s *Server) handleVehicleMode(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Mode string `json:"mode"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if s.vehicle != nil {
		s.vehicle.SetMode(body.Mode)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "mode": body.Mode})
}

func (s *Server) handleProductionState(w http.ResponseWriter, r *http.Request) {
	if s.production == nil {
		writeJSON(w, http.StatusOK, map[string]any{"provisioned": false, "running": false})
		return
	}
	writeJSON(w, http.StatusOK, s.production.State())
}

func (s *Server) handleProductionMode(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Mode string `json:"mode"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if s.production != nil {
		s.production.SetMode(body.Mode)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "mode": body.Mode})
}

func (s *Server) handleReportCacheState(w http.ResponseWriter, r *http.Request) {
	if s.reportCache == nil {
		writeJSON(w, http.StatusOK, map[string]any{"provisioned": false, "running": false})
		return
	}
	writeJSON(w, http.StatusOK, s.reportCache.State())
}

// handleReportCacheMode selects the connection path and, because the report is
// a heavy aggregate, also gates whether the workload runs at all. `live:false`
// stops the workers so leaving the page does not keep hammering SQL Server.
func (s *Server) handleReportCacheMode(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Mode string `json:"mode"`
		Live *bool  `json:"live"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if s.reportCache != nil {
		s.reportCache.SetMode(body.Mode)
		if body.Live != nil {
			if *body.Live {
				s.reportCache.Start()
			} else {
				s.reportCache.Pause()
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "mode": body.Mode})
}

func (s *Server) handleReportCacheReset(w http.ResponseWriter, r *http.Request) {
	if s.reportCache != nil {
		s.reportCache.ResetStats()
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func writeErr(w http.ResponseWriter, code int, err error) {
	writeJSON(w, code, map[string]any{"error": err.Error()})
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
