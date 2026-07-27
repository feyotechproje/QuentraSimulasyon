// vehicle.js
// Vehicle model + movement state-machine + vector drawing. Vehicles always ride
// a road segment (never free pixels). They keep an actualPosition and a lagging
// displayedPosition — the gap between them is the visible "GPS position delay"
// that baseline mode makes worse and Quentra mode collapses.

let _vid = 0;

export const VEHICLE_STATE = {
  SPAWNING: "SPAWNING",
  SELECTING_ROUTE: "SELECTING_ROUTE",
  MOVING: "MOVING",
  APPROACHING_INTERSECTION: "APPROACHING_INTERSECTION",
  WAITING_AT_LIGHT: "WAITING_AT_LIGHT",
  TURNING: "TURNING",
  SENDING_GPS: "SENDING_GPS",
  CONTINUING: "CONTINUING",
  DESPAWNING: "DESPAWNING",
};

// length/width in world units, spawn weight, palette + a flag set for extras.
export const VEHICLE_TYPES = [
  { type: "Sedan",       L: 20, W: 9,  weight: 22, palette: ["#c7d0e0", "#8fa2c4", "#5b6b8c", "#9aa7bf", "#d8dce6"] },
  { type: "Hatchback",   L: 17, W: 9,  weight: 14, palette: ["#e0b84a", "#7ec7a2", "#c98f6a", "#b0b6c4"] },
  { type: "SUV",         L: 22, W: 10, weight: 14, palette: ["#3a4258", "#556074", "#2c3446", "#7d879c"] },
  { type: "Taxi",        L: 20, W: 9,  weight: 8,  palette: ["#f2c141"], taxi: true },
  { type: "Minibus",     L: 26, W: 10, weight: 5,  palette: ["#d7dbe4", "#c2c7d2"] },
  { type: "Service",     L: 21, W: 10, weight: 5,  palette: ["#5aa0d8", "#e07f3c"], beacon: true },
  { type: "Delivery van",L: 26, W: 11, weight: 8,  palette: ["#e4e7ee", "#c9ccd6", "#b6472f"], box: true },
  { type: "Truck",       L: 34, W: 12, weight: 6,  palette: ["#4d5670", "#6b7590", "#3a4258"], box: true, slow: true },
  { type: "Semi-truck",  L: 46, W: 12, weight: 3,  palette: ["#37506e", "#54607c"], semi: true, slow: true },
  { type: "Bus",         L: 40, W: 12, weight: 4,  palette: ["#c0453a", "#2f7fb0", "#3a8f6a"], bus: true, slow: true },
  { type: "Ambulance",   L: 28, W: 11, weight: 2,  palette: ["#f2f4f8"], emergency: "amb", fast: true },
  { type: "Police",      L: 22, W: 10, weight: 2,  palette: ["#e9edf4"], emergency: "pol", fast: true },
  { type: "Maintenance", L: 26, W: 11, weight: 3,  palette: ["#e0a63a"], beacon: true, box: true, slow: true },
];

const TYPE_TABLE = (() => {
  const t = [];
  for (const vt of VEHICLE_TYPES) for (let i = 0; i < vt.weight; i++) t.push(vt);
  return t;
})();

export function pickVehicleType() {
  return TYPE_TABLE[(Math.random() * TYPE_TABLE.length) | 0];
}

export class Vehicle {
  constructor(net, router, spawnNodeId) {
    this.id = ++_vid;
    this.vid = "VEH-" + String(100000 + ((Math.random() * 899999) | 0));
    const t = pickVehicleType();
    this.spec = t;
    this.vehicleType = t.type;
    this.color = t.palette[(Math.random() * t.palette.length) | 0];

    const built = router.build(spawnNodeId, 10);
    this.route = built.hops;
    this.hopIndex = 0;
    this.destNodeId = built.destNodeId;

    const first = this.route[0];
    this.currentSegmentId = first.segId;
    this.dir = first.dir;
    this.t = Math.random() * 0.6;
    this.laneIndex = 0;

    this.x = 0; this.y = 0;
    this.prevX = 0; this.prevY = 0;
    this.displayedX = 0; this.displayedY = 0;
    this.heading = 0;
    this.headingDeg = 0;

    this.currentSpeed = 0;
    this.targetSpeed = 60;
    this.acceleration = 0;

    this.state = VEHICLE_STATE.MOVING;
    this.leadGap = 9999;

    // GPS cadence (sim-seconds). Compressed vs the real 10s so packets stay lively.
    this.gpsInterval = 2.4 + Math.random() * 3.2;
    this.gpsElapsed = Math.random() * this.gpsInterval;
    this.lastGpsTime = 0;
    this.gpsDelay = 0;
    this.sequenceNo = (Math.random() * 900000) | 0;

    this.pulse = 0;            // visual GPS pulse timer
    this.selected = false;
    this.zone = null;
    this.speedKmh = 0;

    this._applyPosition(net);
    this.displayedX = this.x;
    this.displayedY = this.y;
  }

  _applyPosition(net) {
    const seg = net.segment(this.currentSegmentId);
    const t = this.dir > 0 ? this.t : 1 - this.t;
    const p = seg.point(t);
    let ang = seg.tangent(t);
    if (this.dir < 0) ang += Math.PI;
    // Lane offset: shift to the driving side (perpendicular right of travel).
    const laneW = seg.width * 0.26;
    const off = seg.width * 0.24 + this.laneIndex * laneW;
    const px = Math.sin(ang) * off;
    const py = -Math.cos(ang) * off;
    this.prevX = this.x; this.prevY = this.y;
    this.x = p.x + px;
    this.y = p.y + py;
    this.heading = ang;
    this.headingDeg = ((ang * 180 / Math.PI) % 360 + 360) % 360;
  }

  // toNode id the vehicle is heading toward on the current hop.
  _toNode(net) {
    const seg = net.segment(this.currentSegmentId);
    return this.dir > 0 ? seg.endNode : seg.startNode;
  }

  update(dt, net, sim) {
    const seg = net.segment(this.currentSegmentId);

    // --- desired speed from road + zone -------------------------------------
    let limit = seg.speedLimit;
    const zoneFactor = this.zone === "citycenter" || this.zone === "business" ? 0.6
      : this.zone === "harbor" || this.zone === "industrial" ? 0.75 : 1;
    let target = limit * zoneFactor;
    if (this.spec.slow) target *= 0.8;
    if (this.spec.fast) target *= 1.15;
    // Slow into turns near the end of a segment.
    if (this.t > 0.86) target *= 0.55;

    // --- car following ------------------------------------------------------
    const safe = 20 + this.spec.L * 0.5;
    if (this.leadGap < safe) {
      const ratio = Math.max(0, this.leadGap - this.spec.L * 0.5) / safe;
      target *= ratio;
    }

    // --- traffic light ------------------------------------------------------
    let waiting = false;
    if (this.t > 0.7) {
      const node = net.node(this._toNode(net));
      if (node && node.trafficLight) {
        const horizontal = Math.abs(Math.cos(this.heading)) > Math.abs(Math.sin(this.heading));
        const greenForMe = horizontal ? node.lightPhase === 1 : node.lightPhase === 0;
        if (!greenForMe) {
          // Stop before the stop-line (t ~ 0.94).
          if (this.t > 0.9) { target = 0; waiting = true; }
          else target *= 0.4;
        }
      }
    }

    // Convert km/h-ish limit to world units/sec.
    const targetWorld = target * 0.62;
    this.targetSpeed = targetWorld;
    // Smooth accel / decel.
    const rate = targetWorld > this.currentSpeed ? 42 : 90;
    const diff = targetWorld - this.currentSpeed;
    this.currentSpeed += Math.sign(diff) * Math.min(Math.abs(diff), rate * dt);
    if (this.currentSpeed < 0) this.currentSpeed = 0;
    this.speedKmh = Math.round(this.currentSpeed / 0.62);

    // --- advance along segment ---------------------------------------------
    const advance = (this.currentSpeed * dt) / Math.max(1, seg.length);
    this.t += advance;

    // state label
    if (waiting) this.state = VEHICLE_STATE.WAITING_AT_LIGHT;
    else if (this.t > 0.86) this.state = VEHICLE_STATE.APPROACHING_INTERSECTION;
    else this.state = VEHICLE_STATE.MOVING;

    if (this.t >= 1) {
      this.t -= 1;
      this.hopIndex++;
      this.state = VEHICLE_STATE.TURNING;
      if (this.hopIndex >= this.route.length) {
        // Extend or despawn.
        const node = this._toNode(net);
        if (Math.random() < 0.25) { this._despawn = true; return; }
        const more = sim.router.extend(node, this.currentSegmentId, 6);
        if (!more.length) { this._despawn = true; return; }
        this.route = this.route.concat(more);
      }
      const hop = this.route[this.hopIndex];
      this.currentSegmentId = hop.segId;
      this.dir = hop.dir;
    }

    this._applyPosition(net);

    // --- GPS cadence --------------------------------------------------------
    this.gpsElapsed += dt;
    if (this.gpsElapsed >= this.gpsInterval) {
      this.gpsElapsed = 0;
      this.sequenceNo++;
      this.pulse = 1;
      this.lastGpsTime = sim.clock;
      sim.emitGpsUpdate(this);
    }
    if (this.pulse > 0) this.pulse = Math.max(0, this.pulse - dt * 2.2);

    // --- displayed (lagging) position --------------------------------------
    // Baseline: displayed crawls behind -> visible gap. Quentra: snaps to actual.
    const k = sim.mode === "quentra" ? 9 : 0.85;
    this.displayedX += (this.x - this.displayedX) * Math.min(1, k * dt);
    this.displayedY += (this.y - this.displayedY) * Math.min(1, k * dt);
    const gap = Math.hypot(this.x - this.displayedX, this.y - this.displayedY);
    // Map the pixel gap to a plausible seconds figure for the HUD.
    const target2 = sim.mode === "quentra" ? 0.2 : 4.8;
    this.gpsDelay += (target2 * (0.4 + gap / 60) - this.gpsDelay) * Math.min(1, dt * 1.5);
    if (this.gpsDelay < 0.1) this.gpsDelay = 0.1;
  }
}
