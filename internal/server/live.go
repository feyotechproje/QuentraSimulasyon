package server

import (
	"encoding/json"
	"net/http"

	"supermarketsim/internal/access"
)

// handleLiveState wraps a manager snapshot getter into a GET handler. The getter
// returns a "not provisioned" placeholder when its manager is nil, so the UI can
// fall back to demo mode instead of erroring.
func (s *Server) handleLiveState(get func() any) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, get())
	}
}

// decodeMode reads the {"mode": "..."} body common to every live workload.
func decodeMode(r *http.Request) string {
	var body struct {
		Mode string `json:"mode"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	return body.Mode
}

var notProvisioned = map[string]any{"provisioned": false, "running": false}

// ---- FullText / NGram search ----

func (s *Server) fulltextState() any {
	if s.fulltext == nil {
		return notProvisioned
	}
	return s.fulltext.State()
}

func (s *Server) handleFulltextMode(w http.ResponseWriter, r *http.Request) {
	mode := decodeMode(r)
	if s.fulltext != nil {
		s.fulltext.SetMode(mode)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "mode": mode})
}

// ---- Key Breaker (SQL-injection defense) ----

func (s *Server) keyBreakerState() any {
	if s.keyBreaker == nil {
		return notProvisioned
	}
	return s.keyBreaker.State()
}

func (s *Server) handleKeyBreakerMode(w http.ResponseWriter, r *http.Request) {
	mode := decodeMode(r)
	if s.keyBreaker != nil {
		s.keyBreaker.SetMode(mode)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "mode": mode})
}

// ---- Turnstile / factory access (last-movement query) ----

func (s *Server) accessState() any {
	if s.access == nil {
		return notProvisioned
	}
	return s.access.State()
}

func (s *Server) handleAccessMode(w http.ResponseWriter, r *http.Request) {
	mode := decodeMode(r)
	if s.access != nil {
		s.access.SetMode(mode)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "mode": mode})
}

// handleAccessCheck runs one real card check for one on-screen worker: the bad
// application statement travels the requested route (direct :1433 or Quentra
// :14330 — never a silent fallback), the backend text is DMV-captured with the
// check's traceId, and the turnstile decision derives from the returned row.
func (s *Server) handleAccessCheck(w http.ResponseWriter, r *http.Request) {
	var req access.CheckRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if s.access == nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"source": "live", "gatewayUp": false, "ruleMatched": false,
			"decision": "MANUAL_REVIEW", "evidence": "unavailable",
			"error": "access workload kullanılamıyor",
		})
		return
	}
	writeJSON(w, http.StatusOK, s.access.Check(r.Context(), req))
}

// ---- Hospital remote-support data masking ----

func (s *Server) hospitalState() any {
	if s.hospital == nil {
		return notProvisioned
	}
	return s.hospital.State()
}

func (s *Server) handleHospitalMode(w http.ResponseWriter, r *http.Request) {
	mode := decodeMode(r)
	if s.hospital != nil {
		s.hospital.SetMode(mode)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "mode": mode})
}

// ---- AI Guard (prompt-injection defense) ----

func (s *Server) aiGuardState() any {
	if s.aiGuard == nil {
		return notProvisioned
	}
	return s.aiGuard.State()
}

func (s *Server) handleAIGuardMode(w http.ResponseWriter, r *http.Request) {
	mode := decodeMode(r)
	if s.aiGuard != nil {
		s.aiGuard.SetMode(mode)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "mode": mode})
}

// handleAIGuardAsk runs one full assistant turn: the legitimate retrieval
// query, the response-side guard, the model call, and the gate on whatever the
// model decided to do next.
func (s *Server) handleAIGuardAsk(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Question string `json:"question"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if s.aiGuard == nil {
		writeJSON(w, http.StatusOK, map[string]any{"error": "workload kullanılamıyor"})
		return
	}
	writeJSON(w, http.StatusOK, s.aiGuard.Ask(r.Context(), body.Question))
}

// handleHospitalQuery runs the SQL editor's user-authored SELECT on both
// routes (direct + Quentra) and returns the two result sets verbatim.
func (s *Server) handleHospitalQuery(w http.ResponseWriter, r *http.Request) {
	var body struct {
		SQL string `json:"sql"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if s.hospital == nil {
		writeJSON(w, http.StatusOK, map[string]any{"error": "workload kullanılamıyor"})
		return
	}
	writeJSON(w, http.StatusOK, s.hospital.RunQuery(r.Context(), body.SQL))
}
