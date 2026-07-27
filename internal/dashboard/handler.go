package dashboard

import (
	"encoding/json"
	"net/http"
	"strings"
)

// Handler exposes the demo dashboard endpoints. It is transport-only: all data
// comes from the injected repository and simulation service.
type Handler struct {
	repo DashboardRepository
	sim  QuerySimulationService
}

// NewHandler builds the dashboard HTTP handler with the default mock services.
func NewHandler() *Handler {
	repo := NewMockRepository()
	return &Handler{
		repo: repo,
		sim:  NewMockSimulationService(repo, "SALES100K"),
	}
}

// Register attaches all demo dashboard routes to the provided mux.
func (h *Handler) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /demo/dashboard", h.handleDashboard)
	mux.HandleFunc("GET /demo/dashboard/filter", h.handleFilter)
	mux.HandleFunc("GET /demo/dashboard/query-details", h.handleQueryDetails)
	mux.HandleFunc("POST /demo/dashboard/reset", h.handleReset)
}

func (h *Handler) handleDashboard(w http.ResponseWriter, r *http.Request) {
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
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]any{"error": msg})
}
