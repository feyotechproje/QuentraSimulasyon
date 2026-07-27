package production

// SQL provisioning + workload statements for the PRODUCTIONLINE database.

const createTableSQL = `
IF OBJECT_ID('dbo.Production', 'U') IS NULL
BEGIN
	CREATE TABLE dbo.Production (
		ProductionId   BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
		LineId         INT           NOT NULL,
		ItemCode       NVARCHAR(20)  NOT NULL,
		Quantity       INT           NOT NULL,
		ProductionDate DATETIME2(3)  NOT NULL CONSTRAINT DF_Production_ProductionDate DEFAULT(SYSUTCDATETIME())
	);
END`

// seedSQL inserts @count historical rows spread over the last 30 days,
// starting after @offset, so the daily-production query has real data to
// scan (including "today") both for the baseline and Quentra demo modes.
const seedSQL = `
;WITH n AS (
	SELECT TOP (@count) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS r
	FROM sys.all_objects a CROSS JOIN sys.all_objects b
)
INSERT INTO dbo.Production (LineId, ItemCode, Quantity, ProductionDate)
SELECT
	1 + (r % 5),
	CONCAT('SKU-', RIGHT('00000' + CAST((r % 5000) AS VARCHAR(5)), 5)),
	1 + ABS(CHECKSUM(NEWID())) % 12,
	DATEADD(SECOND, -(ABS(CHECKSUM(NEWID())) % 2592000), SYSUTCDATETIME())
FROM n`

// insertOneSQL appends one freshly produced unit, timestamped "now", so the
// daily count keeps growing while the workload runs.
const insertOneSQL = `
INSERT INTO dbo.Production (LineId, ItemCode, Quantity, ProductionDate)
VALUES (@LineId, @ItemCode, @Quantity, SYSUTCDATETIME())`

// createProcSQL defines the demo's deliberately NON-OPTIMIZED stored
// procedure for pulling today's production count. It mirrors the "PROBLEM"
// panel shown on the production-line-simulation page: wrapping the date
// column in CONVERT() makes the predicate non-sargable, so SQL Server must
// scan every row in dbo.Production instead of seeking an index range, even
// when an index exists on ProductionDate.
const createProcSQL = `
CREATE OR ALTER PROCEDURE dbo.sp_GetDailyProduction_Unoptimized
	@LineId INT = NULL
AS
BEGIN
	SET NOCOUNT ON;
	SELECT
		LineId,
		COUNT(*)      AS UnitsProduced,
		SUM(Quantity) AS TotalQuantity
	FROM dbo.Production
	WHERE CONVERT(date, ProductionDate) = CONVERT(date, GETDATE())
	  AND (@LineId IS NULL OR LineId = @LineId)
	GROUP BY LineId
	ORDER BY LineId;
END`

// createProcOptimizedSQL is the "Quentra" counterpart: a sargable range
// predicate on the bare ProductionDate column lets SQL Server seek the
// index instead of scanning the whole table.
const createProcOptimizedSQL = `
CREATE OR ALTER PROCEDURE dbo.sp_GetDailyProduction_Optimized
	@LineId INT = NULL
AS
BEGIN
	SET NOCOUNT ON;
	DECLARE @Today DATE = CONVERT(date, GETDATE());
	SELECT
		LineId,
		COUNT(*)      AS UnitsProduced,
		SUM(Quantity) AS TotalQuantity
	FROM dbo.Production
	WHERE ProductionDate >= @Today
	  AND ProductionDate <  DATEADD(day, 1, @Today)
	  AND (@LineId IS NULL OR LineId = @LineId)
	GROUP BY LineId
	ORDER BY LineId;
END`

// createIndexSQL adds the supporting index. It exists purely to prove the
// point of the demo: even with this index in place, the unoptimized
// procedure's CONVERT(date, ProductionDate) predicate cannot use it (a scan
// still happens), while the optimized procedure benefits from a seek.
const createIndexSQL = `
IF NOT EXISTS (
	SELECT 1 FROM sys.indexes
	WHERE object_id = OBJECT_ID('dbo.Production') AND name = 'IX_Production_ProductionDate'
)
BEGIN
	CREATE INDEX IX_Production_ProductionDate ON dbo.Production (ProductionDate) INCLUDE (LineId, Quantity);
END`

const execUnoptimizedSQL = `EXEC dbo.sp_GetDailyProduction_Unoptimized @LineId=@LineId;`
const execOptimizedSQL = `EXEC dbo.sp_GetDailyProduction_Optimized @LineId=@LineId;`
