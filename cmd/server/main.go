package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"supermarketsim/internal/access"
	"supermarketsim/internal/aiguard"
	"supermarketsim/internal/config"
	"supermarketsim/internal/db"
	"supermarketsim/internal/fulltext"
	"supermarketsim/internal/hospital"
	"supermarketsim/internal/keybreaker"
	"supermarketsim/internal/production"
	"supermarketsim/internal/reportcache"
	"supermarketsim/internal/server"
	"supermarketsim/internal/sim"
	"supermarketsim/internal/vehicle"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(log)

	cfg := config.Load()
	log.Info("starting SuperMarketSim", "db", cfg.SafeSummary(), "http", cfg.HTTPAddr)

	store, err := db.Open(cfg)
	if err != nil {
		log.Error("database connection failed", "error", err.Error())
		os.Exit(1)
	}
	defer store.Close()

	// Resolve schema once at startup so the engine can sample reference data.
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	if _, err := store.DetectSchema(ctx); err != nil {
		cancel()
		log.Error("schema detection failed", "error", err.Error())
		os.Exit(1)
	}
	cancel()
	log.Info("schema detected",
		"detailTable", store.Schema.DetailTable,
		"priceSource", store.Schema.PriceSource,
		"linkColumn", store.Schema.LinkColumn)

	hub := sim.NewHub()
	engine := sim.NewEngine(store, hub, log)

	// Real SQL Server workload for the vehicle-tracking simulation. Provisioning
	// (create DB, seed 100k rows, stored proc) runs in the background so the rest
	// of the app stays available even if VEHICLEGPS is unreachable. The workload
	// itself is NOT started here — the portal's run/stop control does that, so an
	// idle server sends no SQL.
	vehMgr := vehicle.NewManager(cfg, log)
	go func() {
		pctx, pcancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer pcancel()
		if err := vehMgr.Provision(pctx); err != nil {
			log.Error("vehicle workload provisioning failed", "error", err.Error())
			return
		}
		log.Info("vehicle workload ready", "db", vehicle.DBName, "vehicles", vehicle.VehicleCount, "state", "idle")
	}()

	// Real SQL Server workload for the production-line simulation. Provisioning
	// (create DB, seed rows, both stored procs) runs in the background so the
	// rest of the app stays available even if PRODUCTIONLINE is unreachable.
	// Started on demand from the portal, same as the vehicle workload.
	prodMgr := production.NewManager(cfg, log)
	go func() {
		pctx, pcancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer pcancel()
		if err := prodMgr.Provision(pctx); err != nil {
			log.Error("production workload provisioning failed", "error", err.Error())
			return
		}
		log.Info("production workload ready", "db", production.DBName, "seedRows", production.SeedRowCount, "state", "idle")
	}()

	// Real SQL Server workload for the report-cache simulation. The report is a
	// heavy aggregate, so it only runs while a browser is actually in live mode
	// (see the /api/reportcache/mode endpoint) or while it is started from the
	// portal. Provisioning just opens the two pools — direct SQL Server and the
	// Quentra gateway — and verifies the procedure.
	rcMgr := reportcache.NewManager(cfg, log)
	go func() {
		pctx, pcancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer pcancel()
		if err := rcMgr.Provision(pctx); err != nil {
			log.Error("report cache workload provisioning failed", "error", err.Error())
			return
		}
		log.Info("report cache workload ready", "db", reportcache.DBName, "proc", reportcache.ProcName)
	}()

	// FullText / NGram search workload against the existing CRM2 customer table.
	// Provisioning creates the full-text catalog/index (idempotent); the ~5M-row
	// table is never rebuilt and full-text population then runs in the background.
	ftMgr := fulltext.NewManager(cfg, log)
	go func() {
		pctx, pcancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer pcancel()
		if err := ftMgr.Provision(pctx); err != nil {
			log.Error("fulltext workload provisioning failed", "error", err.Error())
			return
		}
		log.Info("fulltext workload ready", "db", fulltext.DBName, "state", "idle")
	}()

	// Key Breaker SQL-injection defense workload against a disposable database.
	kbMgr := keybreaker.NewManager(cfg, log)
	go func() {
		pctx, pcancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer pcancel()
		if err := kbMgr.Provision(pctx); err != nil {
			log.Error("keybreaker workload provisioning failed", "error", err.Error())
			return
		}
		log.Info("keybreaker workload ready", "db", keybreaker.DBName, "state", "idle")
	}()

	// Turnstile / factory "last movement" workload against the existing
	// TIGERMARKET ERP database. Nothing is provisioned — the data already exists.
	accMgr := access.NewManager(cfg, log)
	go func() {
		pctx, pcancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer pcancel()
		if err := accMgr.Provision(pctx); err != nil {
			log.Error("access workload provisioning failed", "error", err.Error())
			return
		}
		log.Info("access workload ready", "db", access.DBName, "state", "idle")
	}()

	// Hospital remote-support data-masking workload against a disposable
	// database. The same parameterized patient lookup is sent both direct and
	// through the Quentra gateway; a masking rule on the gateway shows up live.
	hospMgr := hospital.NewManager(cfg, log)
	go func() {
		pctx, pcancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer pcancel()
		if err := hospMgr.Provision(pctx); err != nil {
			log.Error("hospital workload provisioning failed", "error", err.Error())
			return
		}
		log.Info("hospital workload ready", "db", hospital.DBName, "patients", hospital.PatientCount, "state", "idle")
	}()

	// AI Guard prompt-injection defense workload against a disposable database.
	// The seeded support tickets carry planted instructions aimed at whatever
	// language model later reads them.
	agMgr := aiguard.NewManager(cfg, log)
	go func() {
		pctx, pcancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer pcancel()
		if err := agMgr.Provision(pctx); err != nil {
			log.Error("aiguard workload provisioning failed", "error", err.Error())
			return
		}
		log.Info("aiguard workload ready", "db", aiguard.DBName,
			"llm", agMgr.State().LLMModel, "llmLive", agMgr.State().LLMLive, "state", "idle")
	}()

	srv := server.New(engine, hub, store, vehMgr, prodMgr, rcMgr, ftMgr, kbMgr, accMgr, hospMgr, agMgr, cfg, log)

	httpServer := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Info("listening", "addr", cfg.HTTPAddr, "url", "http://localhost"+cfg.HTTPAddr)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("http server error", "error", err.Error())
			os.Exit(1)
		}
	}()

	// Graceful shutdown.
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	log.Info("shutting down")

	_ = engine.Stop()
	vehMgr.Stop()
	prodMgr.Stop()
	rcMgr.Stop()
	ftMgr.Stop()
	kbMgr.Stop()
	accMgr.Stop()
	hospMgr.Stop()
	agMgr.Stop()
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()
	_ = httpServer.Shutdown(shutdownCtx)
}
