package dashboard

import "context"

// DashboardRepository provides dashboard aggregates for a given filter.
// A mock implementation ships today; a SQL Server implementation reading the
// SALES100K table can be added later without changing callers.
type DashboardRepository interface {
	GetDashboard(ctx context.Context, filter DashboardFilter) (DashboardData, error)
}

// QuerySimulationService produces the two side-by-side execution results.
type QuerySimulationService interface {
	RunDirect(ctx context.Context, filter DashboardFilter) (SimulationResult, error)
	RunQuentra(ctx context.Context, filter DashboardFilter) (SimulationResult, error)
	QueryDetails(ctx context.Context, filter DashboardFilter) (QueryDetails, error)
}
