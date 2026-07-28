package sim

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"supermarketsim/internal/db"
)

// registerRT is the runtime state for a single register/checkout lane.
type registerRT struct {
	no int

	mu    sync.Mutex
	open  bool
	queue []QueuedCustomer

	// live display state (guarded by mu)
	status          string
	activeCustomer  string
	activeItem      string
	activeItemCode  string
	activeUnitPrice float64
	activeQty       float64
	activeLineTotal float64
	basketSubtotal  float64
	itemProgress    int
	itemTotal       int
	activeStock     int64
	activeStockMs   int64
	scannedItems    []ScannedItem
	pendingScan     *ScannedItem
	completed       int
	totalSales      float64
	procSumMs       int64
	procCount       int64
	lastEventMs     int64

	notify chan struct{}
}

func newRegister(no int) *registerRT {
	return &registerRT{
		no:     no,
		open:   true,
		status: RegIdle,
		notify: make(chan struct{}, 1),
	}
}

func (r *registerRT) signal() {
	select {
	case r.notify <- struct{}{}:
	default:
	}
}

func (r *registerRT) isOpen() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.open
}

func (r *registerRT) setOpen(v bool) {
	r.mu.Lock()
	r.open = v
	if !v && r.activeCustomer == "" {
		r.status = RegClosed
	} else if v && r.status == RegClosed {
		r.status = RegIdle
	}
	r.mu.Unlock()
	r.signal()
}

func (r *registerRT) enqueue(qc QueuedCustomer) {
	r.mu.Lock()
	r.queue = append(r.queue, qc)
	r.mu.Unlock()
	r.signal()
}

func (r *registerRT) dequeue() (QueuedCustomer, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.queue) == 0 {
		return QueuedCustomer{}, false
	}
	qc := r.queue[0]
	r.queue = r.queue[1:]
	return qc, true
}

// drainQueue removes and returns all queued customers (used when closing).
func (r *registerRT) drainQueue() []QueuedCustomer {
	r.mu.Lock()
	defer r.mu.Unlock()
	moved := r.queue
	r.queue = nil
	return moved
}

func (r *registerRT) queueStats() (int, float64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var q float64
	for _, c := range r.queue {
		q += c.TotalQty
	}
	return len(r.queue), q
}

func (r *registerRT) setStatus(s string) {
	r.mu.Lock()
	r.status = s
	r.lastEventMs = nowMs()
	r.mu.Unlock()
}

// snapshot returns a copy of the register's display state for the UI frame.
func (r *registerRT) snapshot() RegisterState {
	r.mu.Lock()
	defer r.mu.Unlock()
	var qq float64
	const queuePreviewLimit = 24
	preview := make([]QueuedCustomer, 0, min(len(r.queue), queuePreviewLimit))
	for i, c := range r.queue {
		qq += c.TotalQty
		if i < queuePreviewLimit {
			pc := c
			pc.Lines = nil
			preview = append(preview, pc)
		}
	}
	var avg int64
	if r.procCount > 0 {
		avg = r.procSumMs / r.procCount
	}
	return RegisterState{
		No:              r.no,
		Status:          r.status,
		QueueLen:        len(r.queue),
		QueueQty:        qq,
		ActiveCustomer:  r.activeCustomer,
		ActiveItem:      r.activeItem,
		ActiveItemCode:  r.activeItemCode,
		ActiveUnitPrice: r.activeUnitPrice,
		ActiveQty:       r.activeQty,
		ActiveLineTotal: r.activeLineTotal,
		BasketSubtotal:  r.basketSubtotal,
		ItemProgress:    r.itemProgress,
		ItemTotal:       r.itemTotal,
		CompletedCust:   r.completed,
		TotalSales:      r.totalSales,
		AvgProcessMs:    avg,
		ActiveStock:     r.activeStock,
		ActiveStockMs:   r.activeStockMs,
		ScannedItems:    append([]ScannedItem(nil), r.scannedItems...),
		LastEventUnixMs: r.lastEventMs,
		QueuePreview:    preview,
	}
}

// runRegister is the worker goroutine for one register.
func (e *Engine) runRegister(r *registerRT) {
	defer e.wg.Done()
	ctx := e.ctx

	for {
		if ctx.Err() != nil {
			r.setStatus(RegClosed)
			return
		}
		if !e.gate.waitIfPaused(ctx) {
			return
		}

		qc, ok := r.dequeue()
		if !ok {
			if r.isOpen() {
				r.setStatus(RegIdle)
			} else {
				r.setStatus(RegClosed)
			}
			select {
			case <-ctx.Done():
				return
			case <-r.notify:
			case <-time.After(300 * time.Millisecond):
			}
			continue
		}

		if !e.acquire(ctx) {
			return
		}
		e.processCheckout(ctx, r, qc)
		e.release()
	}
}

// processCheckout runs a single customer's checkout: scan items (outside any
// transaction), then invoice in one short transaction, then print the receipt.
// modeIndex maps the route to a slot in the per-mode aggregates:
// 0 = direct connection, 1 = via the Quentra gateway.
func modeIndex(viaQuentra bool) int {
	if viaQuentra {
		return 1
	}
	return 0
}

func (e *Engine) processCheckout(ctx context.Context, r *registerRT, qc QueuedCustomer) {
	start := time.Now()
	s := e.Settings()

	// Record queue wait against the route captured when this customer first
	// entered the queue. This prevents an old direct backlog from being charged
	// to Quentra after the operator switches modes.
	if qc.QueuedAtMs > 0 {
		measuredAt := nowMs()
		wait := measuredAt - qc.QueuedAtMs
		mi := modeIndex(qc.QueuedViaQuentra)
		e.aggMu.Lock()
		e.waitSamples = append(e.waitSamples, waitSample{atMs: measuredAt, waitMs: wait, mode: mi})
		e.aggMu.Unlock()
	}

	r.beginCheckout(qc)
	if err := e.store.SetBasketStatus(ctx, qc.BasketID, "SCANNING", &r.no); err != nil {
		e.log.Warn("set SCANNING failed", "basket_id", qc.BasketID, "error", err.Error())
	}
	e.emit(EvCheckoutStarted, map[string]any{"register": r.no, "customer": qc.Customer.Name, "items": len(qc.Lines)})

	// Scan each line, honoring pause/stop. Physical waits are outside any tx.
	for idx, ln := range qc.Lines {
		r.setActiveItem(idx, ln)
		e.emit(EvItemScanStarted, map[string]any{"register": r.no, "item": ln.ItemName, "qty": ln.Quantity})

		scanMs := s.ScanMs
		if s.PerUnitScan {
			scanMs = int(float64(s.ScanMs) * ln.Quantity)
		}

		// Per-scan stock lookup. This is a REAL query against QUENTRA_RETAIL. Both
		// the on/off switch and the route are read
		// live, so toggling modes takes effect on the very next scanned item
		// instead of waiting for every in-flight basket to finish.
		live := e.Settings()
		if live.StockLookup {
			// One query per scanned barcode: product columns plus the stock
			// value. The statement is identical either way; only the connection
			// differs, and the gateway is what rewrites it.
			lctx, lcancel := context.WithTimeout(ctx, 60*time.Second)
			// Re-read the route per scan rather than using the settings snapshot
			// taken when this checkout began: a basket can take many seconds, so
			// a snapshot would keep sending down the old connection long after
			// the operator switched modes.
			stock, elapsed, lerr := e.store.ScanItem(lctx, ln.ItemRef, live.QuentraRewrite)
			lcancel()
			if lerr != nil {
				if ctx.Err() != nil {
					r.endCheckout()
					return
				}
				e.log.Warn("item scan query failed", "item_ref", ln.ItemRef, "error", lerr.Error())
			}
			ms := elapsed.Milliseconds()
			totalMs := ms
			itemMs := int64(0) // single round trip: no separate product-lookup leg
			r.setStockLookup(stock, ms)

			// Only successful lookups feed the average. A failed query returns
			// its timeout as "elapsed" (tens of seconds), which would otherwise
			// dominate the mean and misreport the mode as catastrophically slow
			// when the real story is a connection error.
			if lerr == nil {
				e.stockLookups.Add(1)
				e.lastStockMs.Store(ms)
				e.lastStockVal.Store(stock)
				e.lastItemMs.Store(itemMs)
				e.lastScanDbMs.Store(totalMs)
				e.aggMu.Lock()
				e.stockSumMs += ms
				e.itemSumMs += itemMs
				e.scanDbCount++
				e.aggMu.Unlock()
			} else {
				e.stockErrors.Add(1)
			}
			e.emit(EvStockLookup, map[string]any{
				"register": r.no, "item": ln.ItemName, "stock": stock,
				"elapsedMs": ms, "itemMs": itemMs, "scanDbMs": totalMs,
				"mode": live.StockMode(), "failed": lerr != nil,
			})
			r.setScanMetadata("", "", ms, live.QuentraRewrite)
		}

		if !e.wait(ctx, scanMs) {
			// Stopped mid-scan: leave basket in SCANNING for later retry.
			r.endCheckout()
			return
		}
		e.itemsScanned.Add(1)
		r.commitLine(ln)
		e.emit(EvItemScanCompleted, map[string]any{"register": r.no, "item": ln.ItemName, "lineTotal": ln.LineTotal})
	}

	if err := e.store.SetBasketStatus(ctx, qc.BasketID, "SCANNED", &r.no); err != nil {
		e.log.Warn("set SCANNED failed", "basket_id", qc.BasketID, "error", err.Error())
	}

	// Invoice (short transaction).
	if err := e.store.SetBasketStatus(ctx, qc.BasketID, "INVOICING", &r.no); err != nil {
		e.log.Warn("set INVOICING failed", "basket_id", qc.BasketID, "error", err.Error())
	}
	invoiceNo := e.nextInvoiceNo()
	orderID := e.nextOrderID.Add(1)
	res, err := e.store.CreateInvoice(ctx, qc.BasketID, qc.Customer.Ref, r.no, qc.Lines, invoiceNo, orderID)
	if err != nil {
		if errors.Is(err, db.ErrAlreadyInvoiced) {
			// Idempotent: another path already invoiced this basket.
			e.resolved.Add(1)
			r.endCheckout()
			return
		}
		r.setStatus(RegError)
		e.failed.Add(1)
		e.resolved.Add(1)
		e.pushError(ErrorEntry{
			Time: nowMs(), Register: r.no, Customer: qc.Customer.Name,
			BasketID: qc.BasketID, Stage: "invoicing", Message: err.Error(),
		})
		e.emit(EvCheckoutFailed, map[string]any{"register": r.no, "customer": qc.Customer.Name, "error": err.Error()})
		e.log.Error("invoice failed", "simulation_id", e.simID, "register_no", r.no,
			"basket_id", qc.BasketID, "customer_ref", qc.Customer.Ref, "error", err.Error())
		r.endCheckout()
		return
	}

	// Print receipt.
	r.setStatus(RegPrinting)
	e.emit(EvReceiptStarted, map[string]any{"register": r.no, "invoiceNo": res.InvoiceNo})
	_ = e.wait(ctx, s.ReceiptMs)

	dur := time.Since(start).Milliseconds()
	r.finishCheckout(res.Total, dur)

	e.completed.Add(1)
	e.resolved.Add(1)
	// Attribute the checkout duration to the route actually used for its scans.
	// Read live rather than from the opening snapshot, matching the per-scan
	// routing, so a mode switch is reflected in the right column.
	cmi := modeIndex(e.Settings().QuentraRewrite)
	e.aggMu.Lock()
	e.totalSales += res.Total
	e.procSumMs += dur
	e.procCount++
	e.procSumByMode[cmi] += dur
	e.procCountByMode[cmi]++
	e.aggMu.Unlock()

	e.pushSale(CompletedSale{
		InvoiceNo:   res.InvoiceNo,
		InvoiceRef:  res.InvoiceRef,
		Customer:    qc.Customer.Name,
		Register:    r.no,
		LineCount:   res.LineCount,
		TotalQty:    qc.TotalQty,
		Total:       res.Total,
		DurationMs:  dur,
		CompletedAt: nowMs(),
	})
	e.emit(EvCheckoutDone, map[string]any{
		"register": r.no, "customer": qc.Customer.Name,
		"invoiceNo": res.InvoiceNo, "total": res.Total, "durationMs": dur,
	})
	e.log.Info("checkout completed", "simulation_id", e.simID, "register_no", r.no,
		"basket_id", qc.BasketID, "invoice_ref", res.InvoiceRef,
		"customer_ref", qc.Customer.Ref, "duration_ms", dur)
}

func (e *Engine) nextInvoiceNo() string {
	seq := e.invoiceSeq.Add(1)
	return fmt.Sprintf("SIM-%d-%06d", e.startWall.Unix()%1000000, seq)
}

// ---- register display transitions ----

func (r *registerRT) beginCheckout(qc QueuedCustomer) {
	r.mu.Lock()
	r.status = RegScanning
	r.activeCustomer = qc.Customer.Name
	r.itemTotal = len(qc.Lines)
	r.itemProgress = 0
	r.basketSubtotal = 0
	r.activeItem = ""
	r.activeItemCode = ""
	r.activeUnitPrice = 0
	r.activeQty = 0
	r.activeLineTotal = 0
	r.activeStock = 0
	r.activeStockMs = 0
	r.scannedItems = nil
	r.pendingScan = nil
	r.lastEventMs = nowMs()
	r.mu.Unlock()
}

func (r *registerRT) setActiveItem(idx int, ln db.BasketLine) {
	r.mu.Lock()
	r.status = RegScanning
	r.activeItem = ln.ItemName
	r.activeItemCode = ln.ItemCode
	r.activeUnitPrice = ln.UnitPrice
	r.activeQty = ln.Quantity
	r.activeLineTotal = ln.LineTotal
	r.itemProgress = idx
	r.lastEventMs = nowMs()
	r.mu.Unlock()
}

func (r *registerRT) commitLine(ln db.BasketLine) {
	r.mu.Lock()
	r.basketSubtotal += ln.LineTotal
	r.itemProgress++
	item := ScannedItem{
		Code: ln.ItemCode, Name: ln.ItemName, Quantity: ln.Quantity,
		UnitPrice: ln.UnitPrice, LineTotal: ln.LineTotal,
		QueryMs: r.activeStockMs, ScannedAt: nowMs(),
	}
	if r.pendingScan != nil {
		item.Brand = r.pendingScan.Brand
		item.Category = r.pendingScan.Category
		item.Route = r.pendingScan.Route
		item.QueryMs = r.pendingScan.QueryMs
	}
	r.scannedItems = append(r.scannedItems, item)
	r.pendingScan = nil
	r.lastEventMs = nowMs()
	r.mu.Unlock()
}

func (r *registerRT) setScanMetadata(brand, category string, ms int64, viaQuentra bool) {
	route := "direct"
	if viaQuentra {
		route = "quentra"
	}
	r.mu.Lock()
	r.pendingScan = &ScannedItem{Brand: brand, Category: category, QueryMs: ms, Route: route}
	r.mu.Unlock()
}

func (r *registerRT) setStockLookup(stock, ms int64) {
	r.mu.Lock()
	r.activeStock = stock
	r.activeStockMs = ms
	r.lastEventMs = nowMs()
	r.mu.Unlock()
}

func (r *registerRT) finishCheckout(total float64, durMs int64) {
	r.mu.Lock()
	r.completed++
	r.totalSales += total
	r.procSumMs += durMs
	r.procCount++
	r.activeCustomer = ""
	r.activeItem = ""
	r.activeItemCode = ""
	r.activeUnitPrice = 0
	r.activeQty = 0
	r.activeLineTotal = 0
	r.itemProgress = 0
	r.itemTotal = 0
	r.activeStock = 0
	r.activeStockMs = 0
	if r.open {
		r.status = RegIdle
	} else {
		r.status = RegClosed
	}
	r.lastEventMs = nowMs()
	r.mu.Unlock()
}

func (r *registerRT) endCheckout() {
	r.mu.Lock()
	r.activeCustomer = ""
	r.activeItem = ""
	if r.status != RegError {
		if r.open {
			r.status = RegIdle
		} else {
			r.status = RegClosed
		}
	}
	r.lastEventMs = nowMs()
	r.mu.Unlock()
}
