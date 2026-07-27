// query.js
// SQL text builders + small card models used by the SQL Server / Plan Cache
// visuals. The literal values are returned as structured tokens so the UI can
// highlight them (red in baseline, green/purple in Quentra).

export function adHocSql(u) {
  return {
    kind: "adhoc",
    lines: [
      { t: "UPDATE dbo.VehicleState" },
      { t: "SET IsRunning = ", lit: "1" },
      { t: "    Latitude = ", lit: String(u.latitude) },
      { t: "    Longitude = ", lit: String(u.longitude) },
      { t: "    Speed = ", lit: String(u.speed) },
      { t: "    Heading = ", lit: String(u.heading) },
      { t: "    LastEventAt = SYSUTCDATETIME()," },
      { t: "    SequenceNo = SequenceNo + 1" },
      { t: "WHERE VehicleID = ", lit: String(u.vehicleNum) + ";" },
    ],
  };
}

export function procSql(u) {
  return {
    kind: "proc",
    lines: [
      { t: "EXEC dbo.sp_UpdateVehicleState" },
      { t: "    @VehicleID = ", param: "@VehicleID", val: String(u.vehicleNum) + "," },
      { t: "    @IsRunning = ", param: "@IsRunning", val: "1," },
      { t: "    @Latitude = ", param: "@Latitude", val: String(u.latitude) + "," },
      { t: "    @Longitude = ", param: "@Longitude", val: String(u.longitude) + "," },
      { t: "    @Speed = ", param: "@Speed", val: String(u.speed) + "," },
      { t: "    @Heading = ", param: "@Heading", val: String(u.heading) + ";" },
    ],
  };
}

// A short query card that pops around the SQL server in baseline mode.
export class QueryCard {
  constructor() { this.active = false; }
  reset(vehicleNum, mode) {
    this.active = true;
    this.vehicleNum = vehicleNum;
    this.mode = mode;
    this.state = mode === "quentra" ? "PLAN REUSED" : "COMPILING";
    this.age = 0;
    this.ttl = 1.6 + Math.random() * 0.9;
    // Scatter position assigned by the simulation relative to SQL server.
    this.ox = (Math.random() - 0.5) * 180;
    this.oy = -30 - Math.random() * 150;
    return this;
  }
  update(dt) {
    this.age += dt;
    if (this.mode !== "quentra" && this.age > this.ttl * 0.5) this.state = "NEW PLAN";
    if (this.age >= this.ttl) this.active = false;
  }
}

// Plan cache entry.
export class PlanCard {
  constructor(hash, single, useCount) {
    this.hash = hash;
    this.single = single;
    this.useCount = useCount || 1;
  }
}
