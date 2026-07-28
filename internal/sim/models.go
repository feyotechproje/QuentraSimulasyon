package sim

import (
	"supermarketsim/internal/db"
)

// Settings are the user-configurable simulation parameters. Values are in the
// units shown; durations are milliseconds. Fields tagged "locked" on the UI are
// frozen while the simulation is running.
type Settings struct {
	TotalCustomers   int     `json:"totalCustomers"`
	RegisterCount    int     `json:"registerCount"`
	ItemsPerCustomer int     `json:"itemsPerCustomer"`
	MinQty           int     `json:"minQty"`
	MaxQty           int     `json:"maxQty"`
	ScanMs           int     `json:"scanMs"`
	ReceiptMs        int     `json:"receiptMs"`
	ArrivalMs        int     `json:"arrivalMs"`
	Speed            float64 `json:"speed"`
	MaxConcurrent    int     `json:"maxConcurrent"`
	Seed             int64   `json:"seed"`
	AutoDistribute   bool    `json:"autoDistribute"`
	AllowRepeatCust  bool    `json:"allowRepeatCustomer"`
	PerUnitScan      bool    `json:"perUnitScan"`    // true => scan time multiplied by quantity
	DispatchMode     string  `json:"dispatchMode"`   // estimatedWait|shortestQueue|roundRobin|random|fewestItems
	StockLookup      bool    `json:"stockLookup"`    // per-scan real stock lookup (the "software update")
	QuentraRewrite   bool    `json:"quentraRewrite"` // rewrite the slow stock UDF call to a constant 0
}

// DefaultSettings returns the specification defaults.
func DefaultSettings() Settings {
	return Settings{
		TotalCustomers: 1000,
		RegisterCount:  20,
		// Distinct products per basket. Each line costs one per-scan query, so
		// this directly multiplies the database work a single customer causes.
		ItemsPerCustomer: 2,
		MinQty:           1,
		MaxQty:           5,
		ScanMs:           500,
		ReceiptMs:        1000,
		ArrivalMs:        100,
		Speed:            1,
		MaxConcurrent:    0, // 0 => unlimited
		Seed:             42,
		AutoDistribute:   true,
		AllowRepeatCust:  true,
		PerUnitScan:      true,
		DispatchMode:     "estimatedWait",
		StockLookup:      false,
		QuentraRewrite:   false,
	}
}

// StockMode returns the scenario mode label derived from the stock settings:
// "off" (no lookup), "baseline" (slow scalar UDF) or "quentra" (rewritten).
func (s Settings) StockMode() string {
	if !s.StockLookup {
		return "off"
	}
	if s.QuentraRewrite {
		return "quentra"
	}
	return "baseline"
}

// Normalize clamps settings into safe ranges.
func (s *Settings) Normalize() {
	if s.TotalCustomers < 1 {
		s.TotalCustomers = 1
	}
	if s.RegisterCount < 1 {
		s.RegisterCount = 1
	}
	if s.ItemsPerCustomer < 1 {
		s.ItemsPerCustomer = 1
	}
	if s.MinQty < 1 {
		s.MinQty = 1
	}
	if s.MaxQty < s.MinQty {
		s.MaxQty = s.MinQty
	}
	if s.ScanMs < 0 {
		s.ScanMs = 0
	}
	if s.ReceiptMs < 0 {
		s.ReceiptMs = 0
	}
	if s.ArrivalMs < 0 {
		s.ArrivalMs = 0
	}
	if s.Speed <= 0 {
		s.Speed = 1
	}
	if s.MaxConcurrent < 0 {
		s.MaxConcurrent = 0
	}
	switch s.DispatchMode {
	case "estimatedWait", "shortestQueue", "roundRobin", "random", "fewestItems":
	default:
		s.DispatchMode = "estimatedWait"
	}
}

// Register lifecycle states.
const (
	RegClosed   = "Closed"
	RegIdle     = "Idle"
	RegWaiting  = "Waiting"
	RegScanning = "Scanning"
	RegPrinting = "Printing Receipt"
	RegPaused   = "Paused"
	RegError    = "Error"
)

// Simulation lifecycle states.
const (
	SimIdle      = "IDLE"
	SimPreparing = "PREPARING"
	SimRunning   = "RUNNING"
	SimPaused    = "PAUSED"
	SimStopping  = "STOPPING"
	SimStopped   = "STOPPED"
	SimCompleted = "COMPLETED"
	SimError     = "ERROR"
)

// QueuedCustomer is a customer waiting in a register queue.
type QueuedCustomer struct {
	BasketID    string          `json:"basketId"`
	Customer    db.Customer     `json:"customer"`
	Lines       []db.BasketLine `json:"-"`
	DistinctCnt int             `json:"distinctCount"`
	TotalQty    float64         `json:"totalQty"`
	Total       float64         `json:"total"`
	QueuedAtMs  int64           `json:"-"`
	// Route is captured once, at the first queue entry. A later mode switch or
	// register redistribution must not move an already-accrued wait to another
	// side of the comparison.
	QueuedViaQuentra bool `json:"-"`
}

// RegisterState is the compact live snapshot for one register.
type RegisterState struct {
	No              int              `json:"no"`
	Status          string           `json:"status"`
	QueueLen        int              `json:"queueLen"`
	QueueQty        float64          `json:"queueQty"`
	ActiveCustomer  string           `json:"activeCustomer"`
	ActiveItem      string           `json:"activeItem"`
	ActiveItemCode  string           `json:"activeItemCode"`
	ActiveUnitPrice float64          `json:"activeUnitPrice"`
	ActiveQty       float64          `json:"activeQty"`
	ActiveLineTotal float64          `json:"activeLineTotal"`
	BasketSubtotal  float64          `json:"basketSubtotal"`
	ItemProgress    int              `json:"itemProgress"`
	ItemTotal       int              `json:"itemTotal"`
	CompletedCust   int              `json:"completedCustomers"`
	TotalSales      float64          `json:"totalSales"`
	AvgProcessMs    int64            `json:"avgProcessMs"`
	ActiveStock     int64            `json:"activeStock"`   // stock returned for the active item
	ActiveStockMs   int64            `json:"activeStockMs"` // real ms the last stock lookup took
	ScannedItems    []ScannedItem    `json:"scannedItems"`
	LastEventUnixMs int64            `json:"lastEventMs"`
	QueuePreview    []QueuedCustomer `json:"queuePreview"`
}

// ScannedItem is one grounded QUENTRA_RETAIL product already passed over the barcode
// reader at a register. It is kept on the live register snapshot so the UI can
// show the full current basket, not just the item under the scanner.
type ScannedItem struct {
	Code      string  `json:"code"`
	Name      string  `json:"name"`
	Brand     string  `json:"brand"`
	Category  string  `json:"category"`
	Quantity  float64 `json:"quantity"`
	UnitPrice float64 `json:"unitPrice"`
	LineTotal float64 `json:"lineTotal"`
	QueryMs   int64   `json:"queryMs"`
	Route     string  `json:"route"`
	ScannedAt int64   `json:"scannedAt"`
}

// Metrics are aggregate KPIs.
type Metrics struct {
	TotalCustomers int     `json:"totalCustomers"`
	Waiting        int     `json:"waiting"`
	InCheckout     int     `json:"inCheckout"`
	Completed      int     `json:"completed"`
	OpenRegisters  int     `json:"openRegisters"`
	TotalSales     float64 `json:"totalSales"`
	TxnPerMinute   float64 `json:"txnPerMinute"`
	AvgWaitMs      int64   `json:"avgWaitMs"` // active route, rolling 60-second window
	AvgProcessMs   int64   `json:"avgProcessMs"`
	ItemsScanned   int64   `json:"itemsScanned"`
	Errors         int     `json:"errors"`
	ElapsedMs      int64   `json:"elapsedMs"`
	Generated      int     `json:"generated"`
	Currency       string  `json:"currency"`
	StockMode      string  `json:"stockMode"`    // off|baseline|quentra
	StockLookups   int64   `json:"stockLookups"` // count of per-scan lookups performed
	AvgStockMs     int64   `json:"avgStockMs"`   // mean stock-lookup latency
	LastStockMs    int64   `json:"lastStockMs"`  // most recent stock-lookup latency
	// Per-scan database time = product lookup + stock lookup. Averages cover the
	// CURRENT stock mode only (cleared whenever the mode changes).
	AvgItemMs    int64 `json:"avgItemMs"`    // mean product-lookup latency
	LastItemMs   int64 `json:"lastItemMs"`   // most recent product-lookup latency
	AvgScanDbMs  int64 `json:"avgScanDbMs"`  // mean product+stock time per scanned item
	LastScanDbMs int64 `json:"lastScanDbMs"` // most recent product+stock total
	StockErrors  int64 `json:"stockErrors"`  // failed lookups, excluded from the average
	// Checkout/queue averages split by route, so the UI can show the direct and
	// Quentra figures side by side. Zero means "no samples on that route yet".
	// These are NOT cleared on a mode switch: keeping both lets the two columns
	// stand next to each other for comparison.
	AvgProcessDirectMs  int64 `json:"avgProcessDirectMs"`
	AvgProcessQuentraMs int64 `json:"avgProcessQuentraMs"`
	AvgWaitDirectMs     int64 `json:"avgWaitDirectMs"`  // rolling 60-second window
	AvgWaitQuentraMs    int64 `json:"avgWaitQuentraMs"` // rolling 60-second window
	StockValue          int64 `json:"stockValue"`       // most recent stock value returned
}

// CompletedSale is a finished checkout record for the UI list.
type CompletedSale struct {
	InvoiceNo   string  `json:"invoiceNo"`
	InvoiceRef  int64   `json:"invoiceRef"`
	Customer    string  `json:"customer"`
	Register    int     `json:"register"`
	LineCount   int     `json:"lineCount"`
	TotalQty    float64 `json:"totalQty"`
	Total       float64 `json:"total"`
	DurationMs  int64   `json:"durationMs"`
	CompletedAt int64   `json:"completedAt"`
}

// ErrorEntry is a checkout failure surfaced in the Errors tab.
type ErrorEntry struct {
	Time     int64  `json:"time"`
	Register int    `json:"register"`
	Customer string `json:"customer"`
	BasketID string `json:"basketId"`
	Stage    string `json:"stage"`
	Message  string `json:"message"`
}

// Event is a discrete real-time notification pushed to the UI.
type Event struct {
	Type    string `json:"type"`
	Time    int64  `json:"time"`
	Payload any    `json:"payload,omitempty"`
}

// Snapshot is the batched frame delivered to clients on each tick.
type Snapshot struct {
	SimState  string          `json:"simState"`
	Metrics   Metrics         `json:"metrics"`
	Registers []RegisterState `json:"registers"`
	Activity  []Event         `json:"activity,omitempty"`
	Completed []CompletedSale `json:"completed,omitempty"`
	Errors    []ErrorEntry    `json:"errors,omitempty"`
}

// Event type constants.
const (
	EvSimStarted        = "simulation_started"
	EvSimPaused         = "simulation_paused"
	EvSimResumed        = "simulation_resumed"
	EvSimStopped        = "simulation_stopped"
	EvSimReset          = "simulation_reset"
	EvCustomerCreated   = "customer_created"
	EvCustomerQueued    = "customer_queued"
	EvRegisterChanged   = "register_state_changed"
	EvCheckoutStarted   = "customer_checkout_started"
	EvItemScanStarted   = "item_scan_started"
	EvItemScanCompleted = "item_scan_completed"
	EvReceiptStarted    = "receipt_print_started"
	EvCheckoutDone      = "checkout_completed"
	EvCheckoutFailed    = "checkout_failed"
	EvMetricsUpdated    = "metrics_updated"
	EvStockLookup       = "stock_lookup"
	EvStockModeChanged  = "stock_mode_changed"
)
