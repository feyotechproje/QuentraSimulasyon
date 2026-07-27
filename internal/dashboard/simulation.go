package dashboard

import (
	"context"
	"fmt"
	"strings"
)

// originalQueryTemplate mirrors the heavy query an ORM/dashboard tool emits:
// a redundant derived table plus an nvarchar literal against a varchar column.
const originalQueryTemplate = `EXEC sp_executesql
N'
SELECT
    "TBL0"."CITY",
    SUM("TBL0"."ORDER_LINETOTAL")
FROM
(
    SELECT *
    FROM %s
) AS "TBL0"
WHERE
    "TBL0"."REGION" = N''%s''
GROUP BY
    "TBL0"."CITY";
';`

// rewrittenQueryTemplate is the SARGable form the Quentra gateway produces.
const rewrittenQueryTemplate = `SELECT
    CITY,
    SUM(ORDER_LINETOTAL)
FROM %s
WHERE REGION = '%s'
GROUP BY CITY;`

// buildQueryDetails renders the before/after SQL and the analysis for a region.
func buildQueryDetails(table string, filter DashboardFilter) QueryDetails {
	region := filter.Region
	if region == "" {
		region = "Marmara"
	}
	lowered := strings.ToLower(region)
	return QueryDetails{
		Filter:         filter,
		OriginalQuery:  fmt.Sprintf(originalQueryTemplate, table, lowered),
		RewrittenQuery: fmt.Sprintf(rewrittenQueryTemplate, table, lowered),
		Issues: []QueryIssue{
			{Code: "REDUNDANT_SUBQUERY", Detail: "Redundant SELECT * subquery"},
			{Code: "UNICODE_LITERAL", Detail: "Unicode literal against varchar column"},
			{Code: "CONVERT_IMPLICIT", Detail: "CONVERT_IMPLICIT on REGION"},
			{Code: "NON_SARGABLE", Detail: "Non-SARGable predicate"},
			{Code: "INDEX_SCAN_RISK", Detail: "Index scan risk"},
			{Code: "HIGH_READS", Detail: "High logical reads"},
			{Code: "SLOW_REFRESH", Detail: "Slow master filter refresh"},
		},
		Optimizations: []string{
			"Removed redundant derived table",
			"Replaced nvarchar literal with varchar literal",
			"Removed column-side implicit conversion",
			"Restored SARGability",
			"Enabled index seek",
			"Reduced logical reads",
			"Preserved result semantics",
		},
	}
}

// directStages is the animated execution timeline for the Direct Connection.
func directStages() []ExecutionStage {
	return []ExecutionStage{
		{Label: "Parsing Query", Severity: "normal"},
		{Label: "Compiling Execution Plan", Severity: "normal"},
		{Label: "Scanning SALES100K", Severity: "warn"},
		{Label: "Applying Implicit Conversion", Severity: "error"},
		{Label: "Aggregating by City", Severity: "warn"},
		{Label: "Refreshing Dashboard Components", Severity: "warn"},
	}
}

// quentraStages is the animated execution timeline for the Quentra gateway.
func quentraStages() []ExecutionStage {
	return []ExecutionStage{
		{Label: "Query Intercepted", Severity: "normal"},
		{Label: "Pattern Detected", Severity: "success"},
		{Label: "Query Rewritten", Severity: "success"},
		{Label: "Optimized Query Executed", Severity: "success"},
		{Label: "Dashboard Refreshed", Severity: "success"},
	}
}

// MockSimulationService returns the fixed demo timings and the filtered data.
// A future SQL Server implementation can compute real metrics while keeping
// this same interface; visual demo timings stay decoupled from real latency.
type MockSimulationService struct {
	repo  DashboardRepository
	table string
}

// NewMockSimulationService wires the simulation to a dashboard repository.
func NewMockSimulationService(repo DashboardRepository, table string) *MockSimulationService {
	if table == "" {
		table = "SALES100K"
	}
	return &MockSimulationService{repo: repo, table: table}
}

// RunDirect returns the slow, unoptimized execution result.
func (s *MockSimulationService) RunDirect(ctx context.Context, filter DashboardFilter) (SimulationResult, error) {
	data, err := s.repo.GetDashboard(ctx, filter)
	if err != nil {
		return SimulationResult{}, err
	}
	return SimulationResult{
		Mode:   "direct",
		Filter: filter,
		Metrics: QueryMetrics{
			ElapsedMs:        12_870,
			CPUMs:            10_420,
			LogicalReadPages: 84_326,
			RowsReturned:     6,
			QueryExecutions:  1,
		},
		Plan: ExecutionPlan{
			AccessMethod:       "Index Scan / Table Scan",
			ImplicitConversion: true,
			DashboardRefresh:   "Slow",
		},
		Stages:    directStages(),
		Dashboard: data,
	}, nil
}

// RunQuentra returns the optimized, fast execution result.
func (s *MockSimulationService) RunQuentra(ctx context.Context, filter DashboardFilter) (SimulationResult, error) {
	data, err := s.repo.GetDashboard(ctx, filter)
	if err != nil {
		return SimulationResult{}, err
	}
	return SimulationResult{
		Mode:   "quentra",
		Filter: filter,
		Metrics: QueryMetrics{
			ElapsedMs:        820,
			CPUMs:            190,
			LogicalReadPages: 224,
			RowsReturned:     6,
			QueryExecutions:  1,
		},
		Plan: ExecutionPlan{
			AccessMethod:       "Index Seek",
			ImplicitConversion: false,
			DashboardRefresh:   "Instant",
		},
		Stages: quentraStages(),
		Validation: &Validation{
			ResultMatch:        true,
			SemanticValidation: "passed",
		},
		Dashboard: data,
	}, nil
}

// QueryDetails renders the original/rewritten SQL and analysis for the filter.
func (s *MockSimulationService) QueryDetails(_ context.Context, filter DashboardFilter) (QueryDetails, error) {
	return buildQueryDetails(s.table, filter), nil
}
