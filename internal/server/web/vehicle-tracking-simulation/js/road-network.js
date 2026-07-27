// road-network.js
// Node + segment based road graph. Purely geometric — no rendering here.
// The network is generated once and drives every vehicle route. Vehicles never
// use raw pixel positions; they always ride a segment between two nodes.

const ROAD_META = {
  highway:    { laneCount: 3, speedLimit: 120, width: 30 },
  avenue:     { laneCount: 2, speedLimit: 70,  width: 22 },
  local:      { laneCount: 1, speedLimit: 45,  width: 15 },
  industrial: { laneCount: 1, speedLimit: 50,  width: 18 },
  airport:    { laneCount: 2, speedLimit: 80,  width: 22 },
  tunnel:     { laneCount: 2, speedLimit: 60,  width: 22 },
  bridge:     { laneCount: 2, speedLimit: 70,  width: 22 },
};

let _nid = 0;
let _sid = 0;

export class RoadNode {
  constructor(x, y, opts = {}) {
    this.id = "N" + _nid++;
    this.x = x;
    this.y = y;
    this.segments = [];         // ids of connected segments
    this.trafficLight = !!opts.trafficLight;
    this.junctionType = opts.junctionType || "plain"; // plain | signal | roundabout
    // Traffic-light phase: alternates NS <-> EW. Cars whose approach axis is red wait.
    this.lightPhase = 0;        // 0 = NS green, 1 = EW green
    this.lightTimer = Math.random() * 6;
  }
}

export class RoadSegment {
  constructor(a, b, opts = {}) {
    this.id = "S" + _sid++;
    this.startNode = a.id;
    this.endNode = b.id;
    this.ax = a.x; this.ay = a.y;
    this.bx = b.x; this.by = b.y;
    this.roadType = opts.roadType || "local";
    const meta = ROAD_META[this.roadType] || ROAD_META.local;
    this.laneCount = opts.laneCount || meta.laneCount;
    this.speedLimit = opts.speedLimit || meta.speedLimit;
    this.width = meta.width;
    this.direction = opts.direction || "both";
    // Optional single control point for a curved (quadratic) segment.
    this.control = opts.control || null;
    this.length = this._computeLength();
  }

  _computeLength() {
    if (!this.control) {
      return Math.hypot(this.bx - this.ax, this.by - this.ay);
    }
    // Approximate bezier length by sampling.
    let len = 0, px = this.ax, py = this.ay;
    for (let i = 1; i <= 12; i++) {
      const p = this.point(i / 12);
      len += Math.hypot(p.x - px, p.y - py);
      px = p.x; py = p.y;
    }
    return len;
  }

  // Point along the segment. dir 1 = start->end, dir -1 = end->start.
  point(t) {
    if (this.control) {
      const mt = 1 - t;
      const x = mt * mt * this.ax + 2 * mt * t * this.control.x + t * t * this.bx;
      const y = mt * mt * this.ay + 2 * mt * t * this.control.y + t * t * this.by;
      return { x, y };
    }
    return {
      x: this.ax + (this.bx - this.ax) * t,
      y: this.ay + (this.by - this.ay) * t,
    };
  }

  // Tangent angle (radians) at t travelling in +t direction.
  tangent(t) {
    const a = this.point(Math.max(0, t - 0.02));
    const b = this.point(Math.min(1, t + 0.02));
    return Math.atan2(b.y - a.y, b.x - a.x);
  }
}

export class RoadNetwork {
  constructor() {
    this.nodes = new Map();
    this.segments = new Map();
    this.nodeList = [];
    this.segmentList = [];
    // Per segment+direction occupancy for simple car-following.
    // key = `${segId}:${dir}` -> array of vehicles (kept sorted by t each frame)
    this.lanes = new Map();
  }

  addNode(x, y, opts) {
    const n = new RoadNode(x, y, opts);
    this.nodes.set(n.id, n);
    this.nodeList.push(n);
    return n;
  }

  addSegment(a, b, opts) {
    const s = new RoadSegment(a, b, opts);
    this.segments.set(s.id, s);
    this.segmentList.push(s);
    a.segments.push(s.id);
    b.segments.push(s.id);
    return s;
  }

  node(id) { return this.nodes.get(id); }
  segment(id) { return this.segments.get(id); }

  // Neighbours reachable from a node: [{segId, nodeId, dir}]
  neighbours(nodeId) {
    const n = this.nodes.get(nodeId);
    const out = [];
    for (const sid of n.segments) {
      const s = this.segments.get(sid);
      if (s.startNode === nodeId) out.push({ segId: sid, nodeId: s.endNode, dir: 1 });
      else out.push({ segId: sid, nodeId: s.startNode, dir: -1 });
    }
    return out;
  }

  laneKey(segId, dir) { return segId + ":" + (dir > 0 ? 1 : 0); }

  // Reset per-frame lane buckets.
  clearLanes() {
    for (const arr of this.lanes.values()) arr.length = 0;
  }

  registerOnLane(v) {
    const key = this.laneKey(v.currentSegmentId, v.dir);
    let arr = this.lanes.get(key);
    if (!arr) { arr = []; this.lanes.set(key, arr); }
    arr.push(v);
  }
}
