package dashboard

import "context"

// DashboardRepository provides dashboard aggregates for a given filter.
// The production implementation reads the SALES50M database; the in-memory
// implementation remains available only for isolated tests and offline demos.
type DashboardRepository interface {
	GetDashboard(ctx context.Context, filter DashboardFilter) (DashboardData, error)
}

// QuerySimulationService produces the two side-by-side execution results.
type QuerySimulationService interface {
	RunDirect(ctx context.Context, filter DashboardFilter) (SimulationResult, error)
	RunQuentra(ctx context.Context, filter DashboardFilter) (SimulationResult, error)
	QueryDetails(ctx context.Context, filter DashboardFilter) (QueryDetails, error)
}
