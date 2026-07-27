package sim

import (
	"context"
	"math/rand"
	"sync"
	"testing"
	"time"

	"supermarketsim/internal/db"
)

func seededRNG(seed int64) *rand.Rand { return rand.New(rand.NewSource(seed)) }

func testItems(n int) []db.Item {
	items := make([]db.Item, n)
	for i := 0; i < n; i++ {
		items[i] = db.Item{Ref: int64(i + 1), Code: "C", Name: "Item", Price: float64(i%10) + 1}
	}
	return items
}

func TestSelectLinesDistinctAndQtyRange(t *testing.T) {
	s := DefaultSettings()
	s.ItemsPerCustomer = 9
	s.MinQty, s.MaxQty = 1, 5
	rng := seededRNG(1)
	items := testItems(50)

	lines := selectLines(rng, items, s)
	if len(lines) != 9 {
		t.Fatalf("expected 9 lines, got %d", len(lines))
	}
	seen := map[int64]bool{}
	for _, ln := range lines {
		if seen[ln.ItemRef] {
			t.Fatalf("duplicate item %d in basket", ln.ItemRef)
		}
		seen[ln.ItemRef] = true
		if ln.Quantity < 1 || ln.Quantity > 5 {
			t.Fatalf("quantity %v out of range", ln.Quantity)
		}
		if ln.LineTotal != ln.Quantity*ln.UnitPrice {
			t.Fatalf("line total mismatch")
		}
	}
}

func TestSelectLinesReproducibleBySeed(t *testing.T) {
	s := DefaultSettings()
	items := testItems(40)
	a := selectLines(seededRNG(42), items, s)
	b := selectLines(seededRNG(42), items, s)
	if len(a) != len(b) {
		t.Fatalf("length mismatch")
	}
	for i := range a {
		if a[i].ItemRef != b[i].ItemRef || a[i].Quantity != b[i].Quantity {
			t.Fatalf("non-reproducible at %d", i)
		}
	}
}

func TestSelectLinesFewerItemsThanRequested(t *testing.T) {
	s := DefaultSettings()
	s.ItemsPerCustomer = 20
	items := testItems(5)
	lines := selectLines(seededRNG(1), items, s)
	if len(lines) != 5 {
		t.Fatalf("expected clamp to 5, got %d", len(lines))
	}
}

func TestGatePauseResume(t *testing.T) {
	g := newGate()
	ctx := context.Background()
	if !g.waitIfPaused(ctx) {
		t.Fatal("should pass when not paused")
	}
	g.pause()
	released := make(chan bool, 1)
	go func() { released <- g.waitIfPaused(ctx) }()
	select {
	case <-released:
		t.Fatal("waitIfPaused returned while paused")
	case <-time.After(50 * time.Millisecond):
	}
	g.resume()
	select {
	case ok := <-released:
		if !ok {
			t.Fatal("expected true after resume")
		}
	case <-time.After(time.Second):
		t.Fatal("did not release after resume")
	}
}

func TestGateCancelReleases(t *testing.T) {
	g := newGate()
	g.pause()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan bool, 1)
	go func() { done <- g.waitIfPaused(ctx) }()
	cancel()
	select {
	case ok := <-done:
		if ok {
			t.Fatal("expected false on cancel")
		}
	case <-time.After(time.Second):
		t.Fatal("cancel did not release gate")
	}
}

func TestChooseRegisterDispatchModes(t *testing.T) {
	mk := func(mode string) *Engine {
		e := &Engine{settings: DefaultSettings()}
		e.settings.DispatchMode = mode
		e.regs = []*registerRT{newRegister(1), newRegister(2), newRegister(3)}
		return e
	}
	qc := &QueuedCustomer{TotalQty: 3}

	// shortestQueue: reg 2 has fewest queued.
	e := mk("shortestQueue")
	e.regs[0].enqueue(QueuedCustomer{TotalQty: 1})
	e.regs[0].enqueue(QueuedCustomer{TotalQty: 1})
	e.regs[2].enqueue(QueuedCustomer{TotalQty: 1})
	if r := e.chooseRegister(qc); r.no != 2 {
		t.Fatalf("shortestQueue expected reg 2, got %d", r.no)
	}

	// fewestItems: reg with least total qty.
	e = mk("fewestItems")
	e.regs[0].enqueue(QueuedCustomer{TotalQty: 10})
	e.regs[1].enqueue(QueuedCustomer{TotalQty: 2})
	e.regs[2].enqueue(QueuedCustomer{TotalQty: 5})
	if r := e.chooseRegister(qc); r.no != 2 {
		t.Fatalf("fewestItems expected reg 2, got %d", r.no)
	}

	// roundRobin: sequential.
	e = mk("roundRobin")
	got := []int{}
	for i := 0; i < 4; i++ {
		got = append(got, e.chooseRegister(qc).no)
	}
	if got[0] != 1 || got[1] != 2 || got[2] != 3 || got[3] != 1 {
		t.Fatalf("roundRobin sequence wrong: %v", got)
	}

	// closed registers are skipped.
	e = mk("shortestQueue")
	e.regs[0].setOpen(false)
	e.regs[1].setOpen(false)
	if r := e.chooseRegister(qc); r.no != 3 {
		t.Fatalf("expected only open reg 3, got %d", r.no)
	}

	// all closed => nil.
	for _, r := range e.regs {
		r.setOpen(false)
	}
	if r := e.chooseRegister(qc); r != nil {
		t.Fatalf("expected nil when all closed")
	}
}

func TestRegisterQueueOps(t *testing.T) {
	r := newRegister(1)
	r.enqueue(QueuedCustomer{BasketID: "a", TotalQty: 2})
	r.enqueue(QueuedCustomer{BasketID: "b", TotalQty: 3})
	n, q := r.queueStats()
	if n != 2 || q != 5 {
		t.Fatalf("stats wrong: %d %v", n, q)
	}
	first, ok := r.dequeue()
	if !ok || first.BasketID != "a" {
		t.Fatalf("FIFO order broken")
	}
	moved := r.drainQueue()
	if len(moved) != 1 || moved[0].BasketID != "b" {
		t.Fatalf("drain wrong")
	}
	if _, ok := r.dequeue(); ok {
		t.Fatalf("queue should be empty")
	}
}

func TestHubBroadcastAndUnsubscribe(t *testing.T) {
	h := NewHub()
	ch, cancel := h.Subscribe()
	if h.Count() != 1 {
		t.Fatalf("expected 1 subscriber")
	}
	h.Broadcast([]byte("hello"))
	select {
	case msg := <-ch:
		if string(msg) != "hello" {
			t.Fatalf("wrong payload")
		}
	case <-time.After(time.Second):
		t.Fatal("no broadcast received")
	}
	cancel()
	if h.Count() != 0 {
		t.Fatalf("expected 0 subscribers after cancel")
	}
	// Broadcasting to no subscribers must not panic.
	h.Broadcast([]byte("noop"))
}

func TestHubNonBlockingOnSlowConsumer(t *testing.T) {
	h := NewHub()
	_, cancel := h.Subscribe()
	defer cancel()
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 1000; i++ {
			h.Broadcast([]byte("x")) // buffer fills; must drop, not block
		}
	}()
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Broadcast blocked on slow consumer")
	}
}
