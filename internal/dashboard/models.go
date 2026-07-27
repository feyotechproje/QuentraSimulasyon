package dashboard

// DashboardFilter describes an optional master-filter applied to the dashboard.
// An empty Region means "no filter" (the full data set).
type DashboardFilter struct {
	Region string `json:"region,omitempty"`
}

// KPIs holds the six headline metrics rendered at the top of each dashboard.
type KPIs struct {
	TotalSales      float64 `json:"totalSales"`
	TotalOrders     int     `json:"totalOrders"`
	Customers       int     `json:"customers"`
	AverageOrder    float64 `json:"averageOrderValue"`
	ItemsSold       int     `json:"itemsSold"`
	ActiveCities    int     `json:"activeCities"`
}

// RegionRow is one line in the "Sales by Region" master-filter component.
type RegionRow struct {
	Region string  `json:"region"`
	Sales  float64 `json:"sales"`
	Share  float64 `json:"share"`
	Orders int     `json:"orders"`
}

// MonthPoint is one column in the "Sales by Month" chart.
type MonthPoint struct {
	Month string  `json:"month"`
	Sales float64 `json:"sales"`
}

// CategorySlice is one arc in the "Sales by Category" donut.
type CategorySlice struct {
	Category string  `json:"category"`
	Sales    float64 `json:"sales"`
}

// CityRow is one line in the "Top Cities" table.
type CityRow struct {
	City         string  `json:"city"`
	Sales        float64 `json:"sales"`
	Orders       int     `json:"orders"`
	AverageBasket float64 `json:"averageBasket"`
}

// TrendPoint is one point on the "Order Trend" line chart.
type TrendPoint struct {
	Label  string `json:"label"`
	Orders int    `json:"orders"`
}

// ProductRow is one line in the "Top Products" widget.
type ProductRow struct {
	ItemName string  `json:"itemName"`
	Brand    string  `json:"brand"`
	Quantity int     `json:"quantity"`
	Revenue  float64 `json:"revenue"`
}

// GenderSlice is one segment in the "Gender Distribution" chart.
type GenderSlice struct {
	Gender string  `json:"gender"`
	Count  int     `json:"count"`
	Sales  float64 `json:"sales"`
}

// DashboardData is the full payload rendered by every dashboard component.
type DashboardData struct {
	Filter          DashboardFilter `json:"filter"`
	KPIs            KPIs            `json:"kpis"`
	SalesByRegion   []RegionRow     `json:"salesByRegion"`
	SalesByMonth    []MonthPoint    `json:"salesByMonth"`
	SalesByCategory []CategorySlice `json:"salesByCategory"`
	TopCities       []CityRow       `json:"topCities"`
	OrderTrend      []TrendPoint    `json:"orderTrend"`
	TopProducts     []ProductRow    `json:"topProducts"`
	GenderDist      []GenderSlice   `json:"genderDistribution"`
}

// QueryMetrics are the execution numbers that differ between the two engines.
type QueryMetrics struct {
	ElapsedMs        int `json:"elapsedMs"`
	CPUMs            int `json:"cpuMs"`
	LogicalReadPages int `json:"logicalReadPages"`
	RowsReturned     int `json:"rowsReturned"`
	QueryExecutions  int `json:"queryExecutions"`
}

// ExecutionPlan captures the plan characteristics reported for a run.
type ExecutionPlan struct {
	AccessMethod       string `json:"accessMethod"`
	ImplicitConversion bool   `json:"implicitConversion"`
	DashboardRefresh   string `json:"dashboardRefresh"`
}

// ExecutionStage is one animated step in the execution timeline.
type ExecutionStage struct {
	Label    string `json:"label"`
	Severity string `json:"severity"` // "normal" | "warn" | "error" | "success"
}

// Validation reports semantic-equivalence results (Quentra side only).
type Validation struct {
	ResultMatch        bool   `json:"resultMatch"`
	SemanticValidation string `json:"semanticValidation"`
}

// SimulationResult is the response for a single-engine filter run.
type SimulationResult struct {
	Mode       string          `json:"mode"` // "direct" | "quentra"
	Filter     DashboardFilter `json:"filter"`
	Metrics    QueryMetrics    `json:"metrics"`
	Plan       ExecutionPlan   `json:"plan"`
	Stages     []ExecutionStage `json:"stages"`
	Validation *Validation     `json:"validation,omitempty"`
	Dashboard  DashboardData   `json:"dashboard"`
}

// QueryIssue describes one detected anti-pattern in the generated query.
type QueryIssue struct {
	Code   string `json:"code"`
	Detail string `json:"detail"`
}

// QueryDetails contains the original/rewritten SQL plus analysis.
type QueryDetails struct {
	Filter        DashboardFilter `json:"filter"`
	OriginalQuery string          `json:"originalQuery"`
	RewrittenQuery string         `json:"rewrittenQuery"`
	Issues        []QueryIssue    `json:"issues"`
	Optimizations []string        `json:"optimizations"`
}
