// gps-update.js
// A single GPS update packet travelling Vehicle -> Quentra Gateway -> SQL Server
// -> back. Pooled and reused. It carries the payload literals the scenario is
// about (VehicleID, lat/lon, speed, heading, sequence) and a query lifecycle.

export const GPS_STATE = {
  CREATED: "CREATED",
  LEAVING_VEHICLE: "LEAVING_VEHICLE",
  TRAVELING_TO_GATEWAY: "TRAVELING_TO_GATEWAY",
  FINGERPRINTING: "FINGERPRINTING",
  REWRITE_MATCH: "REWRITE_MATCH",
  TRAVELING_TO_SQL: "TRAVELING_TO_SQL",
  COMPILING: "COMPILING",
  PLAN_REUSED: "PLAN_REUSED",
  EXECUTING: "EXECUTING",
  COMPLETED: "COMPLETED",
  RETURNING_ACK: "RETURNING_ACK",
  DELIVERED: "DELIVERED",
};

export class GpsUpdate {
  constructor() {
    this.reset(null, 0, 0, "baseline", { x: 0, y: 0 }, { x: 0, y: 0 });
  }

  reset(vehicle, gatewayPt, sqlPt, mode) {
    this.active = true;
    this.vehicleId = vehicle ? vehicle.vid : "VEH-000000";
    this.vehicleNum = vehicle ? vehicle.id : 0;
    this.latitude = vehicle ? worldToLat(vehicle.y) : 41.0;
    this.longitude = vehicle ? worldToLon(vehicle.x) : 29.0;
    this.speed = vehicle ? vehicle.speedKmh : 0;
    this.heading = vehicle ? Math.round(vehicle.headingDeg) : 0;
    this.sequenceNo = vehicle ? vehicle.sequenceNo : 0;

    this.mode = mode;
    this.queryType = mode === "quentra" ? "Stored Procedure" : "Ad-hoc SQL";
    this.compilationRequired = mode !== "quentra";
    this.planReused = mode === "quentra";

    this.state = GPS_STATE.LEAVING_VEHICLE;
    this.pos = { x: vehicle ? vehicle.x : 0, y: vehicle ? vehicle.y : 0 };
    this.gateway = gatewayPt;
    this.sql = sqlPt;
    this.leg = 0;               // 0 -> gateway, 1 -> sql, 2 -> return
    this.phaseTimer = 0;
    this.elapsed = 0;
    this.totalDuration = 0;
    this.done = false;
    return this;
  }

  update(dt) {
    if (!this.active) return;
    this.elapsed += dt;
    const speed = 340; // world units / sec

    if (this.leg === 0) {
      this.state = GPS_STATE.TRAVELING_TO_GATEWAY;
      if (this._moveTo(this.gateway, speed, dt)) {
        this.leg = 1; this.phaseTimer = 0;
        this.state = this.mode === "quentra" ? GPS_STATE.FINGERPRINTING : GPS_STATE.TRAVELING_TO_SQL;
      }
    } else if (this.leg === 1) {
      // Brief gateway processing for Quentra (fingerprint + rewrite).
      if (this.mode === "quentra" && this.phaseTimer < 0.5) {
        this.phaseTimer += dt;
        this.state = this.phaseTimer < 0.25 ? GPS_STATE.FINGERPRINTING : GPS_STATE.REWRITE_MATCH;
        return;
      }
      this.state = GPS_STATE.TRAVELING_TO_SQL;
      if (this._moveTo(this.sql, speed, dt)) {
        this.leg = 2; this.phaseTimer = 0;
        this.state = this.mode === "quentra" ? GPS_STATE.PLAN_REUSED : GPS_STATE.COMPILING;
      }
    } else if (this.leg === 2) {
      // SQL processing: compile (baseline, slow) or reuse plan (quentra, fast).
      const dur = this.mode === "quentra" ? 0.35 : 0.95;
      this.phaseTimer += dt;
      if (this.phaseTimer < dur * 0.6) {
        this.state = this.mode === "quentra" ? GPS_STATE.PLAN_REUSED : GPS_STATE.COMPILING;
      } else if (this.phaseTimer < dur) {
        this.state = GPS_STATE.EXECUTING;
      } else {
        this.state = GPS_STATE.COMPLETED;
        this.totalDuration = this.mode === "quentra" ? 80 : 420;
        this.leg = 3; this.phaseTimer = 0;
      }
    } else if (this.leg === 3) {
      this.state = GPS_STATE.RETURNING_ACK;
      if (this._moveTo(this.gateway, speed * 1.3, dt)) {
        this.state = GPS_STATE.DELIVERED;
        this.active = false;
        this.done = true;
      }
    }
  }

  _moveTo(dst, speed, dt) {
    const dx = dst.x - this.pos.x, dy = dst.y - this.pos.y;
    const d = Math.hypot(dx, dy);
    const step = speed * dt;
    if (d <= step || d < 1) { this.pos.x = dst.x; this.pos.y = dst.y; return true; }
    this.pos.x += (dx / d) * step;
    this.pos.y += (dy / d) * step;
    return false;
  }
}

// Fake but stable geo mapping so payloads look like Istanbul-ish coordinates.
export function worldToLat(y) { return +(41.20 - (y / 1180) * 0.22).toFixed(6); }
export function worldToLon(x) { return +(28.85 + (x / 1720) * 0.30).toFixed(6); }
