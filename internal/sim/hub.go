package sim

import "sync"

// Hub is a minimal fan-out broadcaster for Server-Sent Events. Sends are
// non-blocking: if a slow client's buffer is full, the frame is dropped for
// that client so the simulation engine is never blocked by the UI.
type Hub struct {
	mu   sync.RWMutex
	subs map[chan []byte]struct{}
}

// NewHub creates an empty hub.
func NewHub() *Hub {
	return &Hub{subs: make(map[chan []byte]struct{})}
}

// Subscribe registers a new client and returns its channel plus a cancel func.
func (h *Hub) Subscribe() (<-chan []byte, func()) {
	ch := make(chan []byte, 16)
	h.mu.Lock()
	h.subs[ch] = struct{}{}
	h.mu.Unlock()

	cancel := func() {
		h.mu.Lock()
		if _, ok := h.subs[ch]; ok {
			delete(h.subs, ch)
			close(ch)
		}
		h.mu.Unlock()
	}
	return ch, cancel
}

// Broadcast delivers a frame to all subscribers without blocking.
func (h *Hub) Broadcast(frame []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for ch := range h.subs {
		select {
		case ch <- frame:
		default:
			// Drop for slow consumers; the next snapshot supersedes this one.
		}
	}
}

// Count returns the number of active subscribers.
func (h *Hub) Count() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.subs)
}
