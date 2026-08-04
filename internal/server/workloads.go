package server

import (
	"encoding/json"
	"fmt"
	"net/http"

	"supermarketsim/internal/sim"
)

// Workload IDs used by the portal's run/stop controls. They match the folder
// names under web/ so the portal card and the workload share one key.
const (
	WorkloadRetail       = "retail-simulation"
	WorkloadVehicle      = "vehicle-tracking-simulation"
	WorkloadProduction   = "production-line-simulation"
	WorkloadReportCache  = "report-cache-simulation"
	WorkloadFulltext     = "fulltext-search-simulation"
	WorkloadKeyBreaker   = "key-breaker-simulation"
	WorkloadFactory      = "factory-turnstile-simulation"
	WorkloadTurnstile    = "turnstile"
	WorkloadHospital     = "hospital-masking-simulation"
)

// workloadStatus is the per-workload snapshot served to the portal.
type workloadStatus struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Running     bool   `json:"running"`
	Provisioned bool   `json:"provisioned"`
	// Detail carries a short human-readable note, e.g. why a workload cannot
	// start yet ("veritabanı hazırlanıyor").
	Detail string `json:"detail,omitempty"`
}

// workload wires one backend workload to the portal's start/stop controls.
// Managers that only expose Start/Pause are adapted here rather than in the
// HTTP handlers so adding a workload is a single entry in s.workloads().
type workload struct {
	id      string
	title   string
	start   func() error
	stop    func() error
	status  func() workloadStatus
	present bool
}

// workloads returns the registry in portal display order. Nil managers (a
// workload compiled in but not wired) are reported as absent instead of
// panicking on start.
func (s *Server) workloads() []workload {
	list := []workload{
		{
			id:      WorkloadRetail,
			title:   "Retail Checkout Simülasyonu",
			present: s.engine != nil,
			start:   func() error { return s.engine.Start() },
			stop:    func() error { return s.engine.Stop() },
			status: func() workloadStatus {
				st := s.engine.State()
				return workloadStatus{
					Running:     st == sim.SimRunning || st == sim.SimPreparing || st == sim.SimPaused,
					Provisioned: true,
					Detail:      st,
				}
			},
		},
		{
			id:      WorkloadVehicle,
			title:   "Fleet · Vehicle Tracking",
			present: s.vehicle != nil,
			start:   func() error { return startProvisioned(s.vehicle.State().Provisioned, s.vehicle.Start) },
			stop:    func() error { s.vehicle.Pause(); return nil },
			status: func() workloadStatus {
				st := s.vehicle.State()
				return workloadStatus{Running: st.Running, Provisioned: st.Provisioned}
			},
		},
		{
			id:      WorkloadProduction,
			title:   "Production Line Digital Twin",
			present: s.production != nil,
			start:   func() error { return startProvisioned(s.production.State().Provisioned, s.production.Start) },
			stop:    func() error { s.production.Pause(); return nil },
			status: func() workloadStatus {
				st := s.production.State()
				return workloadStatus{Running: st.Running, Provisioned: st.Provisioned}
			},
		},
		{
			id:      WorkloadReportCache,
			title:   "Distributed Report Cache",
			present: s.reportCache != nil,
			start:   func() error { return startProvisioned(s.reportCache.State().Provisioned, s.reportCache.Start) },
			stop:    func() error { s.reportCache.Pause(); return nil },
			status: func() workloadStatus {
				st := s.reportCache.State()
				return workloadStatus{Running: st.Running, Provisioned: st.Provisioned}
			},
		},
		{
			id:      WorkloadFulltext,
			title:   "Office FullText / NGram Search",
			present: s.fulltext != nil,
			start:   func() error { return startProvisioned(s.fulltext.State().Provisioned, s.fulltext.Start) },
			stop:    func() error { s.fulltext.Pause(); return nil },
			status: func() workloadStatus {
				st := s.fulltext.State()
				return workloadStatus{Running: st.Running, Provisioned: st.Provisioned}
			},
		},
		{
			id:      WorkloadKeyBreaker,
			title:   "Key Breaker · SQL Defense",
			present: s.keyBreaker != nil,
			start:   func() error { return startProvisioned(s.keyBreaker.State().Provisioned, s.keyBreaker.Start) },
			stop:    func() error { s.keyBreaker.Pause(); return nil },
			status: func() workloadStatus {
				st := s.keyBreaker.State()
				return workloadStatus{Running: st.Running, Provisioned: st.Provisioned}
			},
		},
		{
			id:      WorkloadFactory,
			title:   "Factory Turnstile Girişi",
			present: s.access != nil,
			start:   func() error { return startProvisioned(s.access.State().Provisioned, s.access.Start) },
			stop:    func() error { s.access.Pause(); return nil },
			status: func() workloadStatus {
				st := s.access.State()
				return workloadStatus{Running: st.Running, Provisioned: st.Provisioned}
			},
		},
		{
			id:      WorkloadTurnstile,
			title:   "Turnstile Access",
			present: s.access != nil,
			start:   func() error { return startProvisioned(s.access.State().Provisioned, s.access.Start) },
			stop:    func() error { s.access.Pause(); return nil },
			status: func() workloadStatus {
				st := s.access.State()
				return workloadStatus{Running: st.Running, Provisioned: st.Provisioned}
			},
		},
		{
			id:      WorkloadHospital,
			title:   "Hastane Veri Maskeleme",
			present: s.hospital != nil,
			start:   func() error { return startProvisioned(s.hospital.State().Provisioned, s.hospital.Start) },
			stop:    func() error { s.hospital.Pause(); return nil },
			status: func() workloadStatus {
				st := s.hospital.State()
				return workloadStatus{Running: st.Running, Provisioned: st.Provisioned}
			},
		},
	}
	return list
}

// startProvisioned refuses to start a workload whose background provisioning
// has not finished yet, so the portal can show a real reason instead of a
// button that silently does nothing.
func startProvisioned(provisioned bool, start func()) error {
	if !provisioned {
		return fmt.Errorf("veritabanı henüz hazır değil (provisioning sürüyor)")
	}
	start()
	return nil
}

// snapshot fills in the id/title the status closure does not know about.
func (w workload) snapshot() workloadStatus {
	if !w.present {
		return workloadStatus{ID: w.id, Title: w.title, Detail: "kullanılamıyor"}
	}
	st := w.status()
	st.ID = w.id
	st.Title = w.title
	return st
}

func (s *Server) find(id string) (workload, bool) {
	for _, w := range s.workloads() {
		if w.id == id {
			return w, true
		}
	}
	return workload{}, false
}

// handleWorkloadList reports every workload's run state for the portal cards.
func (s *Server) handleWorkloadList(w http.ResponseWriter, r *http.Request) {
	all := s.workloads()
	out := make([]workloadStatus, 0, len(all))
	for _, wl := range all {
		out = append(out, wl.snapshot())
	}
	writeJSON(w, http.StatusOK, map[string]any{"workloads": out})
}

// handleWorkloadAction starts or stops one workload by id.
func (s *Server) handleWorkloadAction(start bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if id == "" {
			var body struct {
				ID string `json:"id"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			id = body.ID
		}
		wl, ok := s.find(id)
		if !ok {
			writeErr(w, http.StatusNotFound, fmt.Errorf("unknown workload %q", id))
			return
		}
		if !wl.present {
			writeErr(w, http.StatusServiceUnavailable, fmt.Errorf("workload %q kullanılamıyor", id))
			return
		}

		action := wl.stop
		if start {
			action = wl.start
		}
		if err := action(); err != nil {
			writeErr(w, http.StatusConflict, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "workload": wl.snapshot()})
	}
}
