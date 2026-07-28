// world.js
// Builds the whole scene geometry once: the road network (grid + ring + highway
// + bridge/tunnel/roundabout), city zones, buildings/landmarks, decorative
// props (trees, fuel stations, crosswalks) and the central operations cluster
// (Quentra Gateway, SQL Server, Plan Cache …). Nothing here renders — it only
// produces plain data the renderer consumes.

import { RoadNetwork } from "./road-network.js";

export const WORLD = { w: 1720, h: 1160 };

// Zone definitions (rectangles, world coords). Purely for tinting + labels +
// per-region metrics. Vehicles are assigned to a zone by point-in-rect.
export const ZONES = [
  { id: "residential", name: "Residential Area", x: 40,   y: 40,   w: 500, h: 360, tint: "#1c2740" },
  { id: "citycenter",  name: "City Center",      x: 560,  y: 360,  w: 560, h: 420, tint: "#20263f" },
  { id: "business",    name: "Business District",x: 1140, y: 320,  w: 540, h: 380, tint: "#1d2742" },
  { id: "airport",     name: "Airport",          x: 1180, y: 40,   w: 500, h: 250, tint: "#182238" },
  { id: "industrial",  name: "Industrial Zone",  x: 40,   y: 760,  w: 520, h: 360, tint: "#231f33" },
  { id: "logistics",   name: "Logistics Hub",    x: 600,  y: 820,  w: 500, h: 300, tint: "#1a2436" },
  { id: "harbor",      name: "Harbor",           x: 1140, y: 740,  w: 540, h: 380, tint: "#122234" },
  { id: "highway",     name: "Highway Corridor", x: 40,   y: 410,  w: 1640, h: 60,  tint: "#242433" },
];

export function zoneAt(x, y) {
  // Prefer smaller/foreground zones first (business/citycenter over highway).
  for (const z of ZONES) {
    if (z.id === "highway") continue;
    if (x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h) return z;
  }
  return ZONES.find((z) => x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h) || null;
}

export class World {
  constructor() {
    this.net = new RoadNetwork();
    this.buildings = [];
    this.props = [];        // trees, fuel, crosswalks, signs, park
    this.central = null;    // operations cluster
    this._build();
  }

  _build() {
    this._buildRoads();
    this._buildBuildings();
    this._buildProps();
    this._buildCentral();
  }

  _buildRoads() {
    const net = this.net;
    // Grid columns (vertical roads) and rows (horizontal roads).
    const cols = [120, 400, 700, 1010, 1310, 1600];
    const rows = [120, 300, 470, 640, 820, 1010];
    const grid = [];
    for (let r = 0; r < rows.length; r++) {
      grid[r] = [];
      for (let c = 0; c < cols.length; c++) {
        const interior = r > 0 && r < rows.length - 1 && c > 0 && c < cols.length - 1;
        const n = net.addNode(cols[c], rows[r], {
          trafficLight: interior,
          junctionType: interior ? "signal" : "plain",
        });
        grid[r][c] = n;
      }
    }
    this._grid = grid;
    this._cols = cols;
    this._rows = rows;

    const rowType = (r) => (r === 2 ? "highway" : r === 0 ? "avenue" : "avenue");
    const colType = (c) => (c === 0 || c === cols.length - 1 ? "avenue" : "local");

    // Horizontal segments.
    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < cols.length - 1; c++) {
        let type = rowType(r);
        // A bridge over the harbor on the right of row 3; a tunnel under the
        // city on row 1 between two central columns.
        if (r === 3 && c === cols.length - 2) type = "bridge";
        if (r === 1 && c === 2) type = "tunnel";
        net.addSegment(grid[r][c], grid[r][c + 1], { roadType: type });
      }
    }
    // Vertical segments.
    for (let c = 0; c < cols.length; c++) {
      for (let r = 0; r < rows.length - 1; r++) {
        let type = colType(c);
        if (c === cols.length - 1 && r >= 3) type = "industrial";
        if (c === 0 && r >= 3) type = "industrial";
        net.addSegment(grid[r][c], grid[r + 1][c], { roadType: type });
      }
    }

    // Roundabout: replace the central grid node with a signalless roundabout.
    const rbNode = grid[3][2];
    rbNode.junctionType = "roundabout";
    rbNode.trafficLight = false;
    this.roundabout = { x: rbNode.x, y: rbNode.y, r: 42 };

    // A curved airport access road looping from the top-right into the airport.
    const apA = grid[0][4];
    const apB = net.addNode(1500, 150, { trafficLight: false });
    net.addSegment(apA, apB, { roadType: "airport", control: { x: 1560, y: 70 } });

    // Mark bridge / tunnel meta for the renderer.
    this.bridge = net.segmentList.find((s) => s.roadType === "bridge") || null;
    this.tunnel = net.segmentList.find((s) => s.roadType === "tunnel") || null;
  }

  _buildBuildings() {
    // Place buildings inside the blocks between roads, biased by zone identity.
    const grid = this._grid, cols = this._cols, rows = this._rows;
    const rng = mulberry32(1337);
    const pushB = (x, y, w, h, opts = {}) => {
      const z = zoneAt(x + w / 2, y + h / 2);
      this.buildings.push({
        x, y, w, h,
        h3d: opts.h3d || 26,
        kind: opts.kind || "block",
        label: opts.label || null,
        zone: z ? z.id : "citycenter",
        color: opts.color || null,
      });
    };

    // Generic filler blocks per grid cell (leave road margins clear).
    for (let r = 0; r < rows.length - 1; r++) {
      for (let c = 0; c < cols.length - 1; c++) {
        const x0 = cols[c] + 26, y0 = rows[r] + 24;
        const x1 = cols[c + 1] - 26, y1 = rows[r + 1] - 24;
        const cw = x1 - x0, ch = y1 - y0;
        if (cw < 60 || ch < 60) continue;
        const z = zoneAt((x0 + x1) / 2, (y0 + y1) / 2);
        const zid = z ? z.id : "citycenter";
        // Skip harbor water cells (kept open) and highway corridor.
        if (zid === "highway") continue;
        const n = 2 + Math.floor(rng() * 3);
        for (let i = 0; i < n; i++) {
          const bw = 34 + rng() * (cw / 2.2);
          const bh = 30 + rng() * (ch / 2.4);
          const bx = x0 + rng() * (cw - bw);
          const by = y0 + rng() * (ch - bh);
          const tall = zid === "citycenter" || zid === "business";
          pushB(bx, by, bw, bh, {
            h3d: tall ? 40 + rng() * 70 : 18 + rng() * 26,
            kind: tall ? "tower" : "block",
          });
        }
      }
    }

    // Named landmarks (drawn distinctly).
    pushB(1230, 70, 380, 120, { kind: "airport", label: "INTL AIRPORT", h3d: 34, color: "#dbeafe" });
    pushB(90, 820, 200, 120, { kind: "factory", label: "FACTORY", h3d: 46, color: "#ede9fe" });
    pushB(330, 900, 180, 110, { kind: "warehouse", label: "WAREHOUSE", h3d: 30, color: "#e2e8f0" });
    pushB(640, 870, 200, 120, { kind: "logistics", label: "LOGISTICS CTR", h3d: 34, color: "#dbeafe" });
    pushB(880, 890, 160, 100, { kind: "warehouse", label: "DEPOT", h3d: 28, color: "#e2e8f0" });
    pushB(1200, 780, 210, 130, { kind: "port", label: "PORT TERMINAL", h3d: 26, color: "#cffafe" });
    pushB(1460, 800, 180, 120, { kind: "port", label: "CONTAINER YARD", h3d: 22, color: "#cffafe" });
    pushB(620, 420, 150, 150, { kind: "mall", label: "GRAND MALL", h3d: 44, color: "#ede9fe" });
    pushB(900, 400, 140, 120, { kind: "hospital", label: "HOSPITAL", h3d: 52, color: "#fee2e2" });
    pushB(1180, 380, 150, 170, { kind: "tower", label: "OFFICE A", h3d: 96, color: "#dbeafe" });
    pushB(1380, 400, 130, 150, { kind: "tower", label: "OFFICE B", h3d: 120, color: "#dbeafe" });
    pushB(150, 120, 150, 90, { kind: "block", label: "CITY HALL", h3d: 40, color: "#e2e8f0" });

    // Harbor water body (a prop, not a building) added in props.
  }

  _buildProps() {
    const rng = mulberry32(99);
    // Harbor water.
    this.props.push({ type: "water", x: 1150, y: 980, w: 540, h: 150 });
    // Parks / green.
    this.props.push({ type: "park", x: 560, y: 620, w: 150, h: 130 });
    this.props.push({ type: "park", x: 430, y: 150, w: 120, h: 110 });
    // Trees scattered near parks and avenues.
    const treeSpots = [
      [500, 260], [520, 300], [470, 340], [600, 640], [660, 700], [700, 650],
      [180, 260], [260, 300], [1050, 600], [1090, 660], [980, 720], [1450, 300],
      [1500, 360], [360, 500], [820, 560], [880, 640],
    ];
    for (const [x, y] of treeSpots) this.props.push({ type: "tree", x, y, r: 9 + rng() * 5 });
    // Fuel stations.
    this.props.push({ type: "fuel", x: 720, y: 300, label: "FUEL" });
    this.props.push({ type: "fuel", x: 1030, y: 640, label: "FUEL" });
    // Road signs at a couple of junctions.
    this.props.push({ type: "sign", x: 700, y: 300, text: "CENTER" });
    this.props.push({ type: "sign", x: 1310, y: 300, text: "AIRPORT" });
    // Crosswalks near signalled interior nodes are drawn procedurally by renderer.
  }

  _buildCentral() {
    // Operations cluster sits along the bottom band, visually a data-center row.
    const cx = 210, cy = 1092, gap = 250;
    this.central = {
      // Gateway is the funnel every GPS packet passes through.
      gateway: { id: "gateway", x: 470, y: 1088, w: 210, h: 92, label: "QUENTRA GATEWAY" },
      sql:     { id: "sql",     x: 980, y: 1088, w: 210, h: 92, label: "SQL SERVER" },
      planCache:{ id: "planCache", x: 1250, y: 1088, w: 200, h: 92, label: "PLAN CACHE" },
      opsCenter:{ id: "opsCenter", x: 1530, y: 1088, w: 170, h: 92, label: "OPS CENTER" },
    };
    // Extend world height a touch so the cluster fits with margin.
    WORLD.h = 1180;
  }
}

// Deterministic tiny PRNG so the city looks the same every reload.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export { mulberry32 };
