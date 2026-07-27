// metrics.js — in-memory KPI/metric state (demo values only).

export class Metrics {
  constructor() { this.reset(); }

  reset() {
    this.attacksDetected = 0;
    this.attacksBlocked = 0;
    this.safeAllowed = 0;
    this.incidents = 0;
    this.falsePositives = 0;
    this.activeSources = 7;
    this.highRisk = 0;
    this.threatAccuracy = 99.98;
    this.avgResponseMs = 0.21;
    this.queriesPerSec = 18420;
    this.byType = {};       // attackType -> count
    this.trend = [];        // {blocked, allowed} samples for the trend chart
    this._trendAccum = 0;
    this._qpsPhase = 0;
  }

  countAttack(typeKey) {
    this.attacksDetected++;
    this.byType[typeKey] = (this.byType[typeKey] || 0) + 1;
  }
  block() { this.attacksBlocked++; this.highRisk++; }
  incident() { this.incidents++; }
  allow() { this.safeAllowed++; }

  // slight live jitter for a "real-time" feel
  update(dt, active) {
    this._qpsPhase += dt;
    this.queriesPerSec = 18420 + Math.round(Math.sin(this._qpsPhase * 0.7) * 900);
    this.avgResponseMs = active
      ? 0.19 + 0.03 * (0.5 + 0.5 * Math.sin(this._qpsPhase * 1.3))
      : 4.2 + 1.5 * (0.5 + 0.5 * Math.sin(this._qpsPhase));
    this._trendAccum += dt;
    if (this._trendAccum >= 0.5) {
      this._trendAccum = 0;
      this.trend.push({ blocked: this.attacksBlocked, allowed: this.safeAllowed });
      if (this.trend.length > 60) this.trend.shift();
    }
  }
}
