package sim

import (
	"context"
	"database/sql"
	"io"
	"log/slog"
	"os"
	"runtime"
	"testing"
	"time"

	"supermarketsim/internal/config"
	"supermarketsim/internal/db"
)

// These tests hit the real QUENTRA_RETAIL database and write rows, so they are
// opt-in. Enable with:  set SIM_DB_TEST=1  before running `go test`.
func dbTestStore(t *testing.T) *db.Store {
	t.Helper()
	if os.Getenv("SIM_DB_TEST") != "1" {
		t.Skip("set SIM_DB_TEST=1 to run database integration tests")
	}
	cfg := config.Load()
	store, err := db.Open(cfg)
	if err != nil {
		t.Fatalf("db open: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if _, err := store.DetectSchema(ctx); err != nil {
		t.Fatalf("detect schema: %v", err)
	}
	return store
}

func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// runSmall drives a small simulation to completion and returns the engine.
func runSmall(t *testing.T, store *db.Store, customers, registers int) *Engine {
	t.Helper()
	e := NewEngine(store, NewHub(), quietLogger())
	s := DefaultSettings()
	s.TotalCustomers = customers
	s.RegisterCount = registers
	s.ItemsPerCustomer = 5
	s.ScanMs, s.ReceiptMs, s.ArrivalMs = 1, 1, 0
	s.Speed = 50
	if err := e.Configure(s); err != nil {
		t.Fatalf("configure: %v", err)
	}
	if err := e.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		if e.State() == SimCompleted {
			return e
		}
		if e.State() == SimError {
			t.Fatalf("simulation errored")
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("simulation did not complete in time (state=%s)", e.State())
	return e
}

func TestIntegrationSmallRunCompletes(t *testing.T) {
	store := dbTestStore(t)
	defer store.Close()

	before := runtime.NumGoroutine()
	e := runSmall(t, store, 25, 5)

	if got := e.completed.Load() + e.failed.Load(); got != e.attempted.Load() {
		t.Fatalf("accounting mismatch: resolved=%d attempted=%d", got, e.attempted.Load())
	}
	if e.completed.Load() == 0 {
		t.Fatalf("no completed checkouts")
	}

	// Give workers a moment to fully unwind, then check for leaks.
	time.Sleep(500 * time.Millisecond)
	after := runtime.NumGoroutine()
	if after > before+5 {
		t.Fatalf("possible goroutine leak: before=%d after=%d", before, after)
	}
}

func TestIntegrationInvoiceTotalsMatchDetails(t *testing.T) {
	store := dbTestStore(t)
	defer store.Close()

	e := runSmall(t, store, 20, 4)
	_ = e
	sc := store.Schema

	// For a sample of completed baskets, the sum of BASKET line totals must
	// equal the corresponding detail row totals under the same invoice.
	ctx := context.Background()
	rows, err := store.DB.QueryContext(ctx, `SELECT TOP 5 INVOICE_REF FROM dbo.BASKET
		WHERE STATUS='COMPLETED' AND INVOICE_REF IS NOT NULL
		GROUP BY INVOICE_REF ORDER BY MAX(ID) DESC`)
	if err != nil {
		t.Fatalf("query invoices: %v", err)
	}
	var invRefs []int64
	for rows.Next() {
		var ref int64
		_ = rows.Scan(&ref)
		invRefs = append(invRefs, ref)
	}
	rows.Close()
	if len(invRefs) == 0 {
		t.Fatalf("no completed invoices found")
	}

	totalCol := detailTotalColumn(sc)
	if totalCol == "" || sc.LinkColumn == "" {
		t.Skip("detail total/link columns not resolvable for this schema")
	}
	for _, ref := range invRefs {
		var basketSum, detailSum sql.NullFloat64
		if err := store.DB.QueryRowContext(ctx,
			`SELECT SUM(LINE_TOTAL) FROM dbo.BASKET WHERE INVOICE_REF=@p1`, ref).Scan(&basketSum); err != nil {
			t.Fatalf("basket sum: %v", err)
		}
		q := "SELECT SUM([" + totalCol + "]) FROM dbo.[" + sc.DetailTable +
			"] WHERE [" + sc.LinkColumn + "] = (SELECT [" + sc.LinkColumn + "] FROM dbo.INVOICE WHERE [" + sc.InvoiceKey + "]=@p1)"
		if err := store.DB.QueryRowContext(ctx, q, ref).Scan(&detailSum); err != nil {
			t.Fatalf("detail sum: %v", err)
		}
		if diff := basketSum.Float64 - detailSum.Float64; diff > 0.01 || diff < -0.01 {
			t.Fatalf("invoice %d totals differ: basket=%.4f detail=%.4f", ref, basketSum.Float64, detailSum.Float64)
		}
	}
}

func TestIntegrationNoDoubleInvoice(t *testing.T) {
	store := dbTestStore(t)
	defer store.Close()
	ctx := context.Background()

	// Build a basket and invoice it once, then attempt again.
	pool, err := store.LoadItemPool(ctx, 20)
	if err != nil || len(pool) < 3 {
		t.Fatalf("load items: %v", err)
	}
	custs, err := store.LoadCustomerPool(ctx, 5)
	if err != nil || len(custs) == 0 {
		t.Fatalf("load customers: %v", err)
	}
	lines := selectLines(seededRNG(7), pool, DefaultSettings())[:3]
	basketID := db.NewBasketID()
	if err := store.InsertBasket(ctx, basketID, custs[0].Ref, lines); err != nil {
		t.Fatalf("insert basket: %v", err)
	}
	if err := store.SetBasketStatus(ctx, basketID, "INVOICING", nil); err != nil {
		t.Fatalf("set status: %v", err)
	}
	base, err := store.MaxLinkID(ctx)
	if err != nil {
		t.Fatalf("max link id: %v", err)
	}
	if _, err := store.CreateInvoice(ctx, basketID, custs[0].Ref, 1, lines, "TEST-INV-1", base+1); err != nil {
		t.Fatalf("first invoice failed: %v", err)
	}
	// Second attempt must be rejected as already invoiced.
	if _, err := store.CreateInvoice(ctx, basketID, custs[0].Ref, 1, lines, "TEST-INV-2", base+2); err != db.ErrAlreadyInvoiced {
		t.Fatalf("expected ErrAlreadyInvoiced, got %v", err)
	}
}

func TestIntegrationLoad1000x20(t *testing.T) {
	if os.Getenv("SIM_LOAD_TEST") != "1" {
		t.Skip("set SIM_LOAD_TEST=1 (and SIM_DB_TEST=1) to run the 1000/20 load test")
	}
	store := dbTestStore(t)
	defer store.Close()

	before := runtime.NumGoroutine()
	e := runSmall(t, store, 1000, 20)
	if e.completed.Load()+e.failed.Load() != e.attempted.Load() {
		t.Fatalf("not all customers resolved")
	}
	time.Sleep(time.Second)
	if runtime.NumGoroutine() > before+5 {
		t.Fatalf("goroutine leak after load test")
	}
}

func detailTotalColumn(sc *db.Schema) string {
	for _, c := range []string{"TOTALPRICE", "LINETOTAL", "LINE_TOTAL", "TOTAL"} {
		if _, ok := sc.DetailCols[c]; ok {
			return sc.DetailCols[c].Name
		}
	}
	return ""
}
