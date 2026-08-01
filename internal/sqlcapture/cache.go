package sqlcapture

import (
	"context"
	"database/sql"
	"sync"
	"time"
)

// Cache memoizes the captured direct/quentra SQL for a workload whose status is
// polled frequently. It refreshes at most once per interval and always off the
// caller's goroutine, so a status poll never blocks on a capture and the
// database is not hammered with an extra query on every tick.
//
// Until the first refresh lands, Get reports ready=false and the caller should
// fall back to its static display SQL. Callers that only want to capture while a
// workload is actively running should simply skip Get when idle.
type Cache struct {
	interval time.Duration

	mu       sync.Mutex
	key      string // capture is invalidated when this changes (e.g. a query shape)
	at       time.Time
	direct   string
	quentra  string
	ready    bool
	inflight bool
}

// NewCache returns a Cache that refreshes no more than once per interval.
func NewCache(interval time.Duration) *Cache {
	if interval <= 0 {
		interval = 30 * time.Second
	}
	return &Cache{interval: interval}
}

// Get returns the last captured (direct, quentra, ready) triple. When the cache
// is stale or key changed, it starts a single background refresh and returns the
// previous value (ready=false until the first successful capture for this key).
// fn must run the target query on the connection it is handed; it is executed
// once on the direct pool and once on the quentra pool.
func (c *Cache) Get(directPool, quentraPool *sql.DB, key string, fn func(ctx context.Context, conn *sql.Conn) error) (string, string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()

	fresh := c.ready && key == c.key && time.Since(c.at) <= c.interval
	if !fresh && !c.inflight && directPool != nil {
		c.inflight = true
		go c.refresh(directPool, quentraPool, key, fn)
	}
	return c.direct, c.quentra, c.ready && key == c.key
}

func (c *Cache) refresh(directPool, quentraPool *sql.DB, key string, fn func(ctx context.Context, conn *sql.Conn) error) {
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()

	// Original: what SQL Server receives on the direct route (verbatim).
	direct, derr := Captured(ctx, directPool, directPool, fn)
	// Rewritten: what it receives through the gateway — the same text unless a
	// Quentra rule rewrites it.
	quentra := direct
	if quentraPool != nil {
		if got, qerr := Captured(ctx, quentraPool, directPool, fn); qerr == nil && got != "" {
			quentra = got
		}
	}

	c.mu.Lock()
	c.inflight = false
	c.at = time.Now()
	if derr == nil && direct != "" {
		c.key, c.direct, c.quentra, c.ready = key, direct, quentra, true
	}
	c.mu.Unlock()
}
