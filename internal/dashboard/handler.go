package dashboard

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"

	"supermarketsim/internal/config"
)

// Handler exposes the demo dashboard endpoints. It is transport-only: all data
// comes from the injected repository and simulation service.
type Handler struct {
	repo DashboardRepository
	sim  QuerySimulationService
}

// NewHandler builds the dashboard HTTP handler backed by SALES50M.
func NewHandler(cfg *config.Config, log *slog.Logger) *Handler {
	repo := NewSQLRepository(cfg, log)
	return &Handler{
		repo: repo,
		sim:  NewSQLSimulationService(repo, salesTable),
	}
}

// Register attaches all demo dashboard routes to the provided mux.
func (h *Handler) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /demo/dashboard", h.handleDashboard)
	mux.HandleFunc("GET /demo/dashboard/filter", h.handleFilter)
	mux.HandleFunc("GET /demo/dashboard/query-details", h.handleQueryDetails)
	mux.HandleFunc("GET /demo/dashboard/capture-probe", h.handleCaptureProbe)
	mux.HandleFunc("POST /demo/dashboard/reset", h.handleReset)
}

// handleCaptureProbe is a temporary diagnostic: it runs the region query through
// both routes and returns the SQL the backend actually executed, so we can see
// the real Quentra rewrite straight from SQL Server's DMVs.
func (h *Handler) handleCaptureProbe(w http.ResponseWriter, r *http.Request) {
	repo, ok := h.repo.(*SQLRepository)
	if !ok {
		writeError(w, http.StatusServiceUnavailable, "capture probe requires the live SQL repository")
		return
	}
	res, err := repo.ProbeRewrite(r.Context(), strings.TrimSpace(r.URL.Query().Get("region")))
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (h *Handler) handleDashboard(w http.ResponseWriter, r *http.Request) {
	// First dashboard visit starts the per-region decor pre-compute in the
	// background, so region clicks soon refresh instantly — without pinning the
	// SQL Server at process start for users who never open this page.
	if repo, ok := h.repo.(*SQLRepository); ok {
		repo.WarmRegions()
	}
	filter := DashboardFilter{Region: strings.TrimSpace(r.URL.Query().Get("region"))}
	data, err := h.repo.GetDashboard(r.Context(), filter)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, data)
}

func (h *Handler) handleFilter(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	filter := DashboardFilter{Region: strings.TrimSpace(q.Get("region"))}
	if filter.Region == "" {
		writeError(w, http.StatusBadRequest, "region query parameter is required")
		return
	}

	var (
		result SimulationResult
		err    error
	)
	switch strings.ToLower(strings.TrimSpace(q.Get("mode"))) {
	case "direct":
		result, err = h.sim.RunDirect(r.Context(), filter)
	case "quentra":
		result, err = h.sim.RunQuentra(r.Context(), filter)
	default:
		writeError(w, http.StatusBadRequest, "mode must be 'direct' or 'quentra'")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (h *Handler) handleQueryDetails(w http.ResponseWriter, r *http.Request) {
	region := strings.TrimSpace(r.URL.Query().Get("region"))
	if region == "" {
		region = "Marmara"
	}
	details, err := h.sim.QueryDetails(r.Context(), DashboardFilter{Region: region})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, details)
}

func (h *Handler) handleReset(w http.ResponseWriter, r *http.Request) {
	data, err := h.repo.GetDashboard(r.Context(), DashboardFilter{})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":        true,
		"state":     "idle",
		"dashboard": data,
	})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]any{"error": msg})
}
