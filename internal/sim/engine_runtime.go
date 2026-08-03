package sim

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"sync"
	"time"

	"supermarketsim/internal/db"
)

// gate provides pause/resume coordination that also respects context cancel.
type gate struct {
	mu       sync.Mutex
	paused   bool
	resumeCh chan struct{}
}

func newGate() *gate { return &gate{resumeCh: make(chan struct{})} }

func (g *gate) pause() {
	g.mu.Lock()
	g.paused = true
	g.mu.Unlock()
}

func (g *gate) resume() {
	g.mu.Lock()
	if g.paused {
		g.paused = false
		close(g.resumeCh)
		g.resumeCh = make(chan struct{})
	}
	g.mu.Unlock()
}

// waitIfPaused blocks while paused, returning false if ctx is cancelled.
func (g *gate) waitIfPaused(ctx context.Context) bool {
	for {
		g.mu.Lock()
		if !g.paused {
			g.mu.Unlock()
			return ctx.Err() == nil
		}
		ch := g.resumeCh
		g.mu.Unlock()
		select {
		case <-ctx.Done():
			return false
		case <-ch:
		}
	}
}

// wait sleeps for ms (scaled by speed), honoring pause and cancellation.
// It returns false if the context was cancelled.
func (e *Engine) wait(ctx context.Context, ms int) bool {
	if ms <= 0 {
		return ctx.Err() == nil
	}
	speed := e.Settings().Speed
	if speed <= 0 {
		speed = 1
	}
	remaining := time.Duration(float64(ms) / speed * float64(time.Millisecond))
	const step = 25 * time.Millisecond
	for remaining > 0 {
		if !e.gate.waitIfPaused(ctx) {
			return false
		}
		d := step
		if remaining < d {
			d = remaining
		}
		t := time.NewTimer(d)
		select {
		case <-ctx.Done():
			t.Stop()
			return false
		case <-t.C:
			remaining -= d
		}
	}
	return true
}

// acquire takes a concurrency slot (if limited). Returns false on cancel.
func (e *Engine) acquire(ctx context.Context) bool {
	if e.sem == nil {
		return ctx.Err() == nil
	}
	select {
	case <-ctx.Done():
		return false
	case e.sem <- struct{}{}:
		return true
	}
}

func (e *Engine) release() {
	if e.sem == nil {
		return
	}
	select {
	case <-e.sem:
	default:
	}
}

// dispatch chooses a register for the customer and enqueues it.
func (e *Engine) dispatch(qc *QueuedCustomer) {
	r := e.chooseRegister(qc)
	if r == nil {
		return
	}
	no := r.no
	if err := e.store.SetBasketStatus(e.ctx, qc.BasketID, "QUEUED", &no); err != nil {
		e.log.Warn("set QUEUED failed", "basket_id", qc.BasketID, "error", err.Error())
	}
	// Stamp the first queue entry only. Redistributing a queued customer to a
	// different register must preserve both the original wait start and route.
	// The route is the chosen register's own bank.
	if qc.QueuedAtMs == 0 {
		qc.QueuedAtMs = nowMs()
		qc.QueuedViaQuentra = r.viaQuentra
	}
	r.enqueue(*qc)
	e.emit(EvCustomerQueued, map[string]any{"register": no, "customer": qc.Customer.Name})
}

// chooseRegister implements the configured dispatch algorithm over open regs.
func (e *Engine) chooseRegister(qc *QueuedCustomer) *registerRT {
	e.mu.RLock()
	regs := e.regs
	mode := e.settings.DispatchMode
	scanMs := e.settings.ScanMs
	receiptMs := e.settings.ReceiptMs
	perUnit := e.settings.PerUnitScan
	e.mu.RUnlock()

	var open []*registerRT
	for _, r := range regs {
		if r.isOpen() {
			open = append(open, r)
		}
	}
	if len(open) == 0 {
		return nil
	}

	// Registers form two permanent banks (direct / Quentra). New arrivals
	// alternate between the banks so both routes see the same load; a customer
	// re-dispatched from a closing register stays in its original bank so its
	// accrued wait is never charged to the other side of the comparison.
	var banks [2][]*registerRT
	for _, r := range open {
		mi := modeIndex(r.viaQuentra)
		banks[mi] = append(banks[mi], r)
	}
	if len(banks[0]) > 0 && len(banks[1]) > 0 {
		bank := int(e.bankCursor.Add(1)-1) % 2
		if qc.QueuedAtMs != 0 {
			bank = modeIndex(qc.QueuedViaQuentra)
		}
		open = banks[bank]
	}

	switch mode {
	case "roundRobin":
		i := int(e.rrCursor.Add(1)-1) % len(open)
		return open[i]
	case "random":
		return open[rand.Intn(len(open))]
	case "shortestQueue":
		return pickBy(open, func(r *registerRT) float64 {
			n, _ := r.queueStats()
			return float64(n)
		})
	case "fewestItems":
		return pickBy(open, func(r *registerRT) float64 {
			_, q := r.queueStats()
			return q
		})
	default: // estimatedWait
		return pickBy(open, func(r *registerRT) float64 {
			n, q := r.queueStats()
			scanUnits := q
			if !perUnit {
				scanUnits = float64(n) // approximate line-based scans
			}
			return scanUnits*float64(scanMs) + float64(n)*float64(receiptMs)
		})
	}
}

func pickBy(regs []*registerRT, cost func(*registerRT) float64) *registerRT {
	best := regs[0]
	bestCost := cost(best)
	for _, r := range regs[1:] {
		if c := cost(r); c < bestCost {
			best, bestCost = r, c
		}
	}
	return best
}

// snapshotLoop broadcasts a batched frame at a fixed cadence while active.
func (e *Engine) snapshotLoop() {
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	for range ticker.C {
		st := e.State()
		e.broadcastNow()
		if st == SimStopped || st == SimCompleted || st == SimError || st == SimIdle {
			// One final frame already sent; stop the loop.
			return
		}
	}
}

// broadcastNow builds and sends one snapshot frame immediately.
func (e *Engine) broadcastNow() {
	snap := e.BuildSnapshot()
	frame, err := json.Marshal(snap)
	if err != nil {
		return
	}
	e.hub.Broadcast(frame)
}

// BuildSnapshot assembles the current frame, draining pending deltas.
func (e *Engine) BuildSnapshot() Snapshot {
	e.mu.RLock()
	regs := e.regs
	state := e.state
	currency := e.currency
	e.mu.RUnlock()
	settings := e.Settings()

	registers := make([]RegisterState, 0, len(regs))
	inCheckout := 0
	queued := 0
	var queuedQty float64
	openCount := 0
	for _, r := range regs {
		rs := r.snapshot()
		registers = append(registers, rs)
		queued += rs.QueueLen
		queuedQty += rs.QueueQty
		if rs.Status != RegClosed {
			openCount++
		}
		if rs.ActiveCustomer != "" {
			inCheckout++
		}
	}

	// Drain deltas.
	e.pmu.Lock()
	activity := e.pendingActivity
	sales := e.pendingSales
	errs := e.pendingErrors
	e.pendingActivity, e.pendingSales, e.pendingErrors = nil, nil, nil
	e.pmu.Unlock()

	elapsed := int64(0)
	if !e.startWall.IsZero() {
		elapsed = time.Since(e.startWall).Milliseconds()
	}
	completed := int(e.completed.Load())

	e.aggMu.Lock()
	totalSales := e.totalSales
	var avgProc int64
	if e.procCount > 0 {
		avgProc = e.procSumMs / e.procCount
	}
	stockSums := e.stockSumByMode
	itemSums := e.itemSumByMode
	scanCounts := e.scanDbCountByMode
	// Per-route averages (0 = direct, 1 = Quentra gateway).
	avgOf := func(sum, n int64) int64 {
		if n <= 0 {
			return 0
		}
		return sum / n
	}
	avgProcDirect := avgOf(e.procSumByMode[0], e.procCountByMode[0])
	avgProcQuentra := avgOf(e.procSumByMode[1], e.procCountByMode[1])
	// Waiting time is deliberately a rolling window. A lifetime average keeps
	// old congestion visible long after the queue has recovered. Samples are
	// attributed to the route captured when the customer first joined the queue;
	// the blended figure combines both banks.
	const waitWindow = 60 * time.Second
	var waitSums, waitCounts [2]int64
	e.waitSamples, waitSums, waitCounts = summarizeWaitSamples(e.waitSamples, nowMs()-waitWindow.Milliseconds())
	avgWaitDirect := avgOf(waitSums[0], waitCounts[0])
	avgWaitQuentra := avgOf(waitSums[1], waitCounts[1])
	avgWait := avgOf(waitSums[0]+waitSums[1], waitCounts[0]+waitCounts[1])
	e.aggMu.Unlock()

	var tpm float64
	if elapsed > 0 {
		tpm = float64(completed) / (float64(elapsed) / 60000.0)
	}

	stockLookups := e.stockLookups.Load()
	scanDbCount := scanCounts[0] + scanCounts[1]
	stockSumMs := stockSums[0] + stockSums[1]
	itemSumMs := itemSums[0] + itemSums[1]
	var avgStock int64
	if stockLookups > 0 {
		avgStock = stockSumMs / stockLookups
	}
	// Per-scan DB time: product lookup + stock lookup. Blended across both banks
	// for the legacy fields, and split per route for the side-by-side columns.
	var avgItem, avgScanDb int64
	if scanDbCount > 0 {
		avgItem = itemSumMs / scanDbCount
		avgScanDb = (itemSumMs + stockSumMs) / scanDbCount
	}
	avgScanDirect := avgOf(itemSums[0]+stockSums[0], scanCounts[0])
	avgScanQuentra := avgOf(itemSums[1]+stockSums[1], scanCounts[1])

	m := Metrics{
		TotalCustomers: settings.TotalCustomers,
		Waiting:        queued,
		InCheckout:     inCheckout,
		Completed:      completed,
		OpenRegisters:  openCount,
		TotalSales:     totalSales,
		TxnPerMinute:   tpm,
		AvgWaitMs:      avgWait,
		AvgProcessMs:   avgProc,
		ItemsScanned:   e.itemsScanned.Load(),
		Errors:         int(e.failed.Load()),
		ElapsedMs:      elapsed,
		Generated:      int(e.generated.Load()),
		Currency:       currency,
		StockMode:      settings.StockMode(),
		StockLookups:   stockLookups,
		AvgStockMs:     avgStock,
		LastStockMs:    e.lastStockMs.Load(),
		AvgItemMs:      avgItem,
		LastItemMs:     e.lastItemMs.Load(),
		AvgScanDbMs:    avgScanDb,
		LastScanDbMs:   e.lastScanDbMs.Load(),
		StockErrors:    e.stockErrors.Load(),

		AvgProcessDirectMs:  avgProcDirect,
		AvgProcessQuentraMs: avgProcQuentra,
		AvgWaitDirectMs:     avgWaitDirect,
		AvgWaitQuentraMs:    avgWaitQuentra,
		StockValue:          e.lastStockVal.Load(),
		AvgScanDbDirectMs:   avgScanDirect,
		AvgScanDbQuentraMs:  avgScanQuentra,
		ScanCountDirect:     scanCounts[0],
		ScanCountQuentra:    scanCounts[1],
	}

	return Snapshot{
		SimState:  state,
		Metrics:   m,
		Registers: registers,
		Activity:  activity,
		Completed: sales,
		Errors:    errs,
	}
}

// summarizeWaitSamples drops expired measurements and returns the per-route
// sums and counts for the remaining rolling window, so callers can compute both
// per-route and blended averages. Invalid route values are treated as direct
// measurements so malformed data cannot disappear silently.
func summarizeWaitSamples(samples []waitSample, cutoffMs int64) ([]waitSample, [2]int64, [2]int64) {
	kept := samples[:0]
	var sums, counts [2]int64
	for _, sample := range samples {
		if sample.atMs < cutoffMs {
			continue
		}
		kept = append(kept, sample)
		mi := sample.mode
		if mi < 0 || mi > 1 {
			mi = 0
		}
		sums[mi] += sample.waitMs
		counts[mi]++
	}
	return kept, sums, counts
}

// watchCompletion transitions to COMPLETED once every customer is resolved.
func (e *Engine) watchCompletion() {
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-e.ctx.Done():
			return
		case <-ticker.C:
			st := e.State()
			if st != SimRunning && st != SimPaused {
				continue
			}
			if !e.genDone.Load() {
				continue
			}
			if e.resolved.Load() < e.attempted.Load() {
				continue
			}
			// All accounted for: finish.
			e.setState(SimCompleted)
			e.emit(EvSimStopped, map[string]any{"reason": "completed"})
			e.log.Info("simulation completed", "simulation_id", e.simID,
				"completed", e.completed.Load(), "failed", e.failed.Load())
			if e.cancel != nil {
				e.cancel()
			}
			e.broadcastNow()
			return
		}
	}
}

// ---- Interactive controls ----

// AddCustomer injects one extra customer into the running simulation.
func (e *Engine) AddCustomer() error {
	if e.State() != SimRunning {
		return fmt.Errorf("simulation is not running")
	}
	rng := rand.New(rand.NewSource(time.Now().UnixNano()))
	e.attempted.Add(1)
	qc := e.buildCustomer(rng, -1)
	if qc == nil {
		return fmt.Errorf("failed to create customer basket")
	}
	e.emit(EvCustomerCreated, map[string]any{"customer": qc.Customer.Name, "items": qc.DistinctCnt, "manual": true})
	e.dispatch(qc)
	return nil
}

// OpenRegister opens (or adds) a register by number.
func (e *Engine) OpenRegister(no int) error {
	if e.State() != SimRunning && e.State() != SimPaused {
		return fmt.Errorf("simulation is not active")
	}
	e.mu.Lock()
	for _, r := range e.regs {
		if r.no == no {
			e.mu.Unlock()
			r.setOpen(true)
			e.emit(EvRegisterChanged, map[string]any{"register": no, "state": RegIdle})
			return nil
		}
	}
	// Add a brand-new register and launch its worker. Its bank follows the same
	// split as the initial layout: numbers past the halfway point are Quentra.
	s := e.Settings()
	half := (s.RegisterCount + 1) / 2
	gwUp := e.store != nil && e.store.HasQuentraGateway()
	r := newRegister(no, gwUp && no > half)
	e.regs = append(e.regs, r)
	e.mu.Unlock()
	e.wg.Add(1)
	go e.runRegister(r)
	e.emit(EvRegisterChanged, map[string]any{"register": no, "state": RegIdle})
	return nil
}

// CloseRegister closes a register and redistributes its queued customers.
func (e *Engine) CloseRegister(no int) error {
	if e.State() != SimRunning && e.State() != SimPaused {
		return fmt.Errorf("simulation is not active")
	}
	e.mu.RLock()
	var target *registerRT
	for _, r := range e.regs {
		if r.no == no {
			target = r
			break
		}
	}
	e.mu.RUnlock()
	if target == nil {
		return fmt.Errorf("register %d not found", no)
	}
	moved := target.drainQueue()
	target.setOpen(false)
	for i := range moved {
		e.dispatch(&moved[i])
	}
	e.emit(EvRegisterChanged, map[string]any{"register": no, "state": RegClosed, "redistributed": len(moved)})
	return nil
}

// RetryBasket re-queues an errored basket for reprocessing.
func (e *Engine) RetryBasket(basketID string) error {
	if e.State() != SimRunning && e.State() != SimPaused {
		return fmt.Errorf("simulation is not active")
	}
	ctx := e.ctx
	if err := e.store.ResetBasketForRetry(ctx, basketID); err != nil {
		return err
	}
	lines, cust, err := e.reloadBasket(ctx, basketID)
	if err != nil {
		return err
	}
	qc := &QueuedCustomer{BasketID: basketID, Customer: cust, Lines: lines, DistinctCnt: len(lines)}
	for _, ln := range lines {
		qc.TotalQty += ln.Quantity
		qc.Total += ln.LineTotal
	}
	e.attempted.Add(1)
	e.dispatch(qc)
	return nil
}

// reloadBasket reads a basket's lines back from the database for retry.
func (e *Engine) reloadBasket(ctx context.Context, basketID string) ([]db.BasketLine, db.Customer, error) {
	return e.store.ReloadBasket(ctx, basketID)
}
