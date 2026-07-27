package vehicle

// SQL provisioning + workload statements for the VEHICLEGPS database.

const createTableSQL = `
IF OBJECT_ID('dbo.Vehicles', 'U') IS NULL
BEGIN
	CREATE TABLE dbo.Vehicles (
		VehicleId  INT           NOT NULL PRIMARY KEY,
		Plate      NVARCHAR(16)  NOT NULL,
		Lat        DECIMAL(9,6)  NOT NULL,
		Lng        DECIMAL(9,6)  NOT NULL,
		Speed      INT           NOT NULL,
		Heading    INT           NOT NULL,
		Status     NVARCHAR(16)  NOT NULL CONSTRAINT DF_Vehicles_Status DEFAULT('MOVING'),
		LastUpdate DATETIME2(3)  NOT NULL CONSTRAINT DF_Vehicles_LastUpdate DEFAULT(SYSUTCDATETIME())
	);
END`

// seedSQL inserts @count rows starting after @offset. sys.all_objects is
// cross-joined to generate enough rows for a set-based bulk insert.
const seedSQL = `
;WITH n AS (
	SELECT TOP (@count) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS r
	FROM sys.all_objects a CROSS JOIN sys.all_objects b
)
INSERT INTO dbo.Vehicles (VehicleId, Plate, Lat, Lng, Speed, Heading, Status)
SELECT
	r + @offset,
	CONCAT('34 ', CHAR(65 + (r % 26)), CHAR(65 + ((r / 26) % 26)), ' ',
	       RIGHT('000' + CAST((r % 1000) AS VARCHAR(3)), 3)),
	41.000000 + (ABS(CHECKSUM(NEWID())) % 120000) / 1000000.0,
	28.900000 + (ABS(CHECKSUM(NEWID())) % 160000) / 1000000.0,
	ABS(CHECKSUM(NEWID())) % 120,
	ABS(CHECKSUM(NEWID())) % 360,
	'MOVING'
FROM n`

// createProcSQL is the rewrite TARGET: the shape the Quentra gateway turns the
// ad-hoc UPDATE into. This definition is owned by the database — it is kept
// here so a fresh environment can be provisioned, but the signature must match
// whatever the gateway actually emits. Today the gateway sends
//
//	EXEC dbo.sp_UpdateVehicleState @VehicleID, @IsRunning, @Latitude,
//	                               @Longitude, @Speed, @Heading
//
// which does not match these parameter names and carries an extra @IsRunning,
// so the call fails with "too many arguments specified". Fix belongs in the
// gateway rule, not by rewriting the procedure the DBA maintains.
const createProcSQL = `
CREATE OR ALTER PROCEDURE dbo.sp_UpdateVehicleState
	@VehicleId INT,
	@Lat       DECIMAL(9,6),
	@Lng       DECIMAL(9,6),
	@Speed     INT,
	@Heading   INT
AS
BEGIN
	SET NOCOUNT ON;
	UPDATE dbo.Vehicles
	   SET Lat = @Lat,
	       Lng = @Lng,
	       Speed = @Speed,
	       Heading = @Heading,
	       Status = CASE WHEN @Speed = 0 THEN 'STOPPED' ELSE 'MOVING' END,
	       LastUpdate = SYSUTCDATETIME()
	 WHERE VehicleId = @VehicleId;
END`

// spExecSQL is the form the Quentra gateway rewrites the ad-hoc UPDATE into.
// The application no longer sends it: rewriting client-side would defeat the
// comparison. Kept here as the documented target shape (and for reference when
// configuring the gateway rule).
const spExecSQL = `EXEC dbo.sp_UpdateVehicleState @VehicleId=@VehicleId, @Lat=@Lat, @Lng=@Lng, @Speed=@Speed, @Heading=@Heading;`
