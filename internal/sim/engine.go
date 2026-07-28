package sim

import (
	"context"
	"fmt"
	"log/slog"
	"math/rand"
	"sync"
	"sync/atomic"
	"time"

	"supermarketsim/internal/db"
)

// Engine owns the whole simulation lifecycle and all concurrency.
type Engine struct {
	store *db.Store
	hub   *Hub
	log   *slog.Logger

	mu       sync.RWMutex
	settings Settings
	state    string
	simID    string

	// runtime (recreated on each Start)
	ctx       context.Context
	cancel    context.CancelFunc
	gate      *gate
	sem       chan struct{}
	wg        sync.WaitGroup
	regs      []*registerRT
	pool      poolData
	startWall time.Time
	rrCursor  atomic.Int64

	// counters
	generated    atomic.Int64
	completed    atomic.Int64
	failed       atomic.Int64
	itemsScanned atomic.Int64
	stockLookups atomic.Int64 // per-scan stock lookups performed
	lastStockMs  atomic.Int64 // most recent stock-lookup latency (ms)
	lastStockVal atomic.Int64 // most recent stock value returned
	lastItemMs   atomic.Int64 // most recent product-lookup latency (ms)
	lastScanDbMs atomic.Int64 // most recent product+stock total for one scan (ms)
	stockErrors  atomic.Int64 // lookups that failed (excluded from the average)
	attempted    atomic.Int64 // customers the generator (or Add Customer) tried to create
	resolved     atomic.Int64 // customers that reached a terminal state (done or failed)
	invoiceSeq   atomic.Int64 // monotonic invoice-number sequence
	nextOrderID  atomic.Int64 // link-id allocator, seeded above existing data
	genDone      atomic.Bool  // the initial generator finished all customers

	// aggregate metrics
	aggMu      sync.Mutex
	totalSales float64
	procSumMs  int64
	procCount  int64
	// Same aggregates split by the route the checkout actually used, so the UI
	// can show direct-vs-Quentra side by side instead of one blended number.
	// Index 0 = direct connection, 1 = via the Quentra gateway.
	procSumByMode   [2]int64
	procCountByMode [2]int64
	waitSamples     []waitSample
	// Per-scan DB timing. These accumulate the CURRENT stock mode only: they are
	// cleared by SetStockMode so the average always describes the mode on screen
	// rather than blending slow baseline samples into the Quentra figure.
	stockSumMs  int64
	itemSumMs   int64
	scanDbCount int64

	// pending deltas drained by the snapshot loop
	pmu             sync.Mutex
	pendingActivity []Event
	pendingSales    []CompletedSale
	pendingErrors   []ErrorEntry

	currency string
}

type poolData struct {
	customers []db.Customer
	items     []db.Item
}

type waitSample struct {
	atMs   int64
	waitMs int64
	mode   int // 0 = direct, 1 = Quentra
}

// NewEngine constructs an idle engine.
func NewEngine(store *db.Store, hub *Hub, log *slog.Logger) *Engine {
	return &Engine{
		store:    store,
		hub:      hub,
		log:      log,
		settings: DefaultSettings(),
		state:    SimIdle,
		currency: "TRY",
	}
}

// State returns the current simulation lifecycle state.
func (e *Engine) State() string {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.state
}

func (e *Engine) setState(s string) {
	e.mu.Lock()
	e.state = s
	e.mu.Unlock()
}

// Settings returns a copy of the current settings.
func (e *Engine) Settings() Settings {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.settings
}

// Configure updates settings; only allowed when not actively running.
func (e *Engine) Configure(s Settings) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.state == SimRunning || e.state == SimPreparing || e.state == SimPaused || e.state == SimStopping {
		return fmt.Errorf("cannot change settings while simulation is %s", e.state)
	}
	s.Normalize()
	e.settings = s
	return nil
}

// SetCurrency records the currency label used for UI formatting.
func (e *Engine) SetCurrency(c string) {
	e.mu.Lock()
	if c != "" {
		e.currency = c
	}
	e.mu.Unlock()
}

// SetStockMode toggles the per-scan stock lookup and the Quentra rewrite while
// the simulation is running, so operators can watch scan latency change in real
// time. Unlike Configure this is intentionally not gated on the run state.
func (e *Engine) SetStockMode(stockLookup, quentraRewrite bool) {
	e.mu.Lock()
	e.settings.StockLookup = stockLookup
	e.settings.QuentraRewrite = quentraRewrite
	e.mu.Unlock()

	// Start a fresh measurement window. Without this the average would still
	// carry samples from the previous mode, so switching to the Quentra rewrite
	// would appear to inherit the baseline's slow per-scan time.
	e.aggMu.Lock()
	e.stockSumMs = 0
	e.itemSumMs = 0
	e.scanDbCount = 0
	e.aggMu.Unlock()
	e.stockLookups.Store(0)
	e.lastStockMs.Store(0)
	e.lastItemMs.Store(0)
	e.lastScanDbMs.Store(0)
	e.stockErrors.Store(0)
	e.emit(EvStockModeChanged, map[string]any{
		"stockLookup": stockLookup, "quentraRewrite": quentraRewrite,
	})
	e.broadcastNow()
}

// Start prepares resources and launches the simulation.
func (e *Engine) Start() error {
	e.mu.Lock()
	if e.state == SimRunning || e.state == SimPreparing || e.state == SimPaused {
		e.mu.Unlock()
		return fmt.Errorf("simulation already active (%s)", e.state)
	}
	settings := e.settings
	settings.Normalize()
	e.settings = settings
	e.state = SimPreparing
	e.simID = db.NewBasketID()
	e.mu.Unlock()

	// Reset counters/state.
	e.resetRuntime()

	ctx, cancel := context.WithCancel(context.Background())
	e.ctx = ctx
	e.cancel = cancel
	e.gate = newGate()
	if settings.MaxConcurrent > 0 {
		e.sem = make(chan struct{}, settings.MaxConcurrent)
	} else {
		e.sem = nil
	}

	// Ensure BASKET exists.
	if _, err := e.store.EnsureBasket(ctx); err != nil {
		e.fail(fmt.Errorf("ensure BASKET: %w", err))
		return err
	}

	// NOTE: dbo.QUENTRA_GetItemStock is owned by the database, not by this
	// application. It is deliberately expensive and is maintained externally,
	// so the engine must never CREATE OR ALTER it — doing so would silently
	// overwrite the real function with a generated approximation.

	// Load in-memory pools sized to the workload.
	custPoolSize := min(settings.TotalCustomers, 20000)
	if custPoolSize < 1 {
		custPoolSize = 1
	}
	itemPoolSize := clamp(settings.ItemsPerCustomer*40, 500, 8000)

	custs, err := e.store.LoadCustomerPool(ctx, custPoolSize)
	if err != nil {
		e.fail(fmt.Errorf("load customers: %w", err))
		return err
	}
	items, err := e.store.LoadItemPool(ctx, itemPoolSize)
	if err != nil {
		e.fail(fmt.Errorf("load items: %w", err))
		return err
	}
	if len(custs) == 0 || len(items) < settings.ItemsPerCustomer {
		e.fail(fmt.Errorf("insufficient data: %d customers, %d items (need %d distinct)",
			len(custs), len(items), settings.ItemsPerCustomer))
		return fmt.Errorf("insufficient reference data")
	}
	e.pool = poolData{customers: custs, items: items}

	// Seed the link-id (ORDERID) allocator strictly above any existing data so
	// new invoices never collide with pre-existing detail rows.
	base, err := e.store.MaxLinkID(ctx)
	if err != nil {
		e.fail(fmt.Errorf("read max link id: %w", err))
		return err
	}
	e.nextOrderID.Store(base)

	// Build registers (all open by default).
	e.regs = make([]*registerRT, settings.RegisterCount)
	for i := 0; i < settings.RegisterCount; i++ {
		e.regs[i] = newRegister(i + 1)
	}

	e.startWall = time.Now()
	e.setState(SimRunning)
	e.emit(EvSimStarted, map[string]any{"simId": e.simID, "registers": settings.RegisterCount, "customers": settings.TotalCustomers})
	e.log.Info("simulation started", "simulation_id", e.simID,
		"registers", settings.RegisterCount, "customers", settings.TotalCustomers)

	// Launch workers, generator, snapshot loop.
	for _, r := range e.regs {
		e.wg.Add(1)
		go e.runRegister(r)
	}
	e.wg.Add(1)
	go e.generator()
	go e.snapshotLoop()
	go e.watchCompletion()

	return nil
}

func (e *Engine) resetRuntime() {
	e.generated.Store(0)
	e.completed.Store(0)
	e.failed.Store(0)
	e.itemsScanned.Store(0)
	e.stockLookups.Store(0)
	e.lastStockMs.Store(0)
	e.lastStockVal.Store(0)
	e.lastItemMs.Store(0)
	e.lastScanDbMs.Store(0)
	e.stockErrors.Store(0)
	e.attempted.Store(0)
	e.resolved.Store(0)
	e.genDone.Store(false)
	e.rrCursor.Store(0)
	e.aggMu.Lock()
	e.totalSales, e.procSumMs, e.procCount = 0, 0, 0
	e.procSumByMode, e.procCountByMode = [2]int64{}, [2]int64{}
	e.waitSamples = nil
	e.stockSumMs = 0
	e.itemSumMs = 0
	e.scanDbCount = 0
	e.aggMu.Unlock()
	e.pmu.Lock()
	e.pendingActivity, e.pendingSales, e.pendingErrors = nil, nil, nil
	e.pmu.Unlock()
}

// Pause freezes progress while keeping all state intact.
func (e *Engine) Pause() error {
	if e.State() != SimRunning {
		return fmt.Errorf("cannot pause when %s", e.State())
	}
	e.gate.pause()
	e.setState(SimPaused)
	e.emit(EvSimPaused, nil)
	e.log.Info("simulation paused", "simulation_id", e.simID)
	return nil
}

// Resume continues a paused simulation.
func (e *Engine) Resume() error {
	if e.State() != SimPaused {
		return fmt.Errorf("cannot resume when %s", e.State())
	}
	e.gate.resume()
	e.setState(SimRunning)
	e.emit(EvSimResumed, nil)
	e.log.Info("simulation resumed", "simulation_id", e.simID)
	return nil
}

// Stop halts new customer acceptance and safely winds down workers.
func (e *Engine) Stop() error {
	st := e.State()
	if st != SimRunning && st != SimPaused {
		return fmt.Errorf("cannot stop when %s", st)
	}
	e.setState(SimStopping)
	if e.gate != nil {
		e.gate.resume() // release any paused workers so they can observe cancel
	}
	if e.cancel != nil {
		e.cancel()
	}
	go func() {
		e.wg.Wait()
		if e.State() != SimCompleted {
			e.setState(SimStopped)
		}
		e.emit(EvSimStopped, nil)
		e.log.Info("simulation stopped", "simulation_id", e.simID,
			"completed", e.completed.Load(), "failed", e.failed.Load())
		e.broadcastNow()
	}()
	return nil
}

// Reset clears runtime state back to idle. Database records are preserved.
func (e *Engine) Reset() error {
	st := e.State()
	if st == SimRunning || st == SimPreparing || st == SimPaused {
		return fmt.Errorf("stop the simulation before resetting")
	}
	e.mu.Lock()
	e.regs = nil
	e.pool = poolData{}
	e.state = SimIdle
	e.simID = ""
	e.mu.Unlock()
	e.resetRuntime()
	e.emit(EvSimReset, nil)
	e.broadcastNow()
	return nil
}

func (e *Engine) fail(err error) {
	e.setState(SimError)
	e.log.Error("simulation error", "simulation_id", e.simID, "error", err.Error())
	e.pushError(ErrorEntry{Time: nowMs(), Stage: "preparing", Message: err.Error()})
	e.broadcastNow()
}

// generator produces the initial customer batch over time and dispatches them.
func (e *Engine) generator() {
	defer e.wg.Done()
	defer e.genDone.Store(true)
	s := e.Settings()
	rng := rand.New(rand.NewSource(s.Seed))

	for i := 0; i < s.TotalCustomers; i++ {
		if e.ctx.Err() != nil {
			return
		}
		if !e.gate.waitIfPaused(e.ctx) {
			return
		}
		e.attempted.Add(1)
		qc := e.buildCustomer(rng, i)
		if qc == nil {
			// insert failed; buildCustomer already recorded the terminal state.
			e.waitArrival(s.ArrivalMs)
			continue
		}
		e.emit(EvCustomerCreated, map[string]any{"customer": qc.Customer.Name, "items": qc.DistinctCnt})
		e.dispatch(qc)
		e.waitArrival(s.ArrivalMs)
	}
}

func (e *Engine) waitArrival(ms int) {
	if ms <= 0 {
		return
	}
	_ = e.wait(e.ctx, ms)
}

// buildCustomer selects a customer + distinct items, inserts the basket, and
// returns the queued-customer descriptor.
func (e *Engine) buildCustomer(rng *rand.Rand, seq int) *QueuedCustomer {
	s := e.Settings()
	cust := e.pool.customers[rng.Intn(len(e.pool.customers))]

	lines := selectLines(rng, e.pool.items, s)
	var totalQty, total float64
	for _, ln := range lines {
		totalQty += ln.Quantity
		total += ln.LineTotal
	}

	basketID := db.NewBasketID()
	if err := e.store.InsertBasket(e.ctx, basketID, cust.Ref, lines); err != nil {
		e.failed.Add(1)
		e.resolved.Add(1)
		e.pushError(ErrorEntry{Time: nowMs(), Customer: cust.Name, BasketID: basketID,
			Stage: "basket_insert", Message: err.Error()})
		e.log.Error("basket insert failed", "simulation_id", e.simID,
			"basket_id", basketID, "customer_ref", cust.Ref, "error", err.Error())
		return nil
	}
	e.generated.Add(1)

	return &QueuedCustomer{
		BasketID:    basketID,
		Customer:    cust,
		Lines:       lines,
		DistinctCnt: len(lines),
		TotalQty:    totalQty,
		Total:       total,
	}
}

// selectLines picks distinct items and per-item quantities for one basket.
// It is deterministic for a given rng state, enabling reproducible seeds.
func selectLines(rng *rand.Rand, items []db.Item, s Settings) []db.BasketLine {
	n := s.ItemsPerCustomer
	if n > len(items) {
		n = len(items)
	}
	perm := rng.Perm(len(items))[:n]
	lines := make([]db.BasketLine, 0, n)
	for _, idx := range perm {
		it := items[idx]
		qty := float64(s.MinQty + rng.Intn(s.MaxQty-s.MinQty+1))
		lines = append(lines, db.BasketLine{
			ItemRef:   it.Ref,
			ItemCode:  it.Code,
			ItemName:  it.Name,
			Unit:      it.Unit,
			Quantity:  qty,
			UnitPrice: it.Price,
			LineTotal: qty * it.Price,
		})
	}
	return lines
}

func (e *Engine) emit(t string, payload any) {
	ev := Event{Type: t, Time: nowMs(), Payload: payload}
	e.pmu.Lock()
	e.pendingActivity = append(e.pendingActivity, ev)
	if len(e.pendingActivity) > 400 {
		e.pendingActivity = e.pendingActivity[len(e.pendingActivity)-400:]
	}
	e.pmu.Unlock()
}

func (e *Engine) pushSale(s CompletedSale) {
	e.pmu.Lock()
	e.pendingSales = append(e.pendingSales, s)
	e.pmu.Unlock()
}

func (e *Engine) pushError(err ErrorEntry) {
	e.pmu.Lock()
	e.pendingErrors = append(e.pendingErrors, err)
	e.pmu.Unlock()
}

func nowMs() int64 { return time.Now().UnixMilli() }

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
