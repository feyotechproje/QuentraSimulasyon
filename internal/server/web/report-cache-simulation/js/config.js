// config.js — static demo constants (no backend, no real data)

export const WORLD = { w: 1600, h: 920 };

// The single heavy report every user runs.
export const REPORT = {
  id: "RPT-2026-0042",
  name: "Global Sales Performance",
  fullName: "GLOBAL SALES PERFORMANCE REPORT",
  queryType: "Heavy Aggregate Report",
  resultSize: "48 MB",
  baselineExec: "8.2 sec",
  cachedResponse: "180 ms",
  concurrent: 100,
  cacheKey: "report:RPT-2026-0042",
};

// Timing (seconds) used by the visual/logical model. Kept here so a future
// ApiReportCacheDataSource could return different numbers without touching sim.
export const TIMINGS = {
  travelToGateway: [0.6, 1.1],
  baselineSql:     [4.0, 9.0],
  cacheLookup:     [0.15, 0.35],
  cacheMissSql:    [4.0, 7.0],
  cacheStore:      0.5,
  cacheResponse:   [0.2, 0.6],
  returnTrip:      [0.5, 0.9],
};

export const COLORS = {
  sql:    "#f59e0b", // heavy SQL request  (amber/orange)
  sqlHot: "#ef4444", // overloaded         (red)
  hit:    "#14b8a6", // cache hit          (teal)
  miss:   "#7c3aed", // cache miss         (purple)
  wire:   "#c9d2e6",
  ink:    "#1e2338",
  ink2:   "#5a6379",
  ink3:   "#8b93a7",
  purple: "#6d5cf5",
};

export const DEVICE = { DESKTOP: "desktop", LAPTOP: "laptop", TABLET: "tablet", PHONE: "phone" };

// Ten operation-map locations. Positions in WORLD space. `slots` = where the
// hero figure + device scene is drawn relative to the tile.
export const LOCATIONS = [
  { id:"hq",      name:"Headquarters", env:"office",   x:210,  y:150, devices:[DEVICE.DESKTOP, DEVICE.TABLET], users:18 },
  { id:"factory", name:"Factory",      env:"factory",  x:180,  y:420, devices:[DEVICE.PHONE, DEVICE.TABLET],   users:12 },
  { id:"home",    name:"Home Office",  env:"home",     x:205,  y:720, devices:[DEVICE.DESKTOP],                users:9  },
  { id:"airport", name:"Airport",      env:"airport",  x:590,  y:120, devices:[DEVICE.LAPTOP, DEVICE.PHONE],   users:8  },
  { id:"cafe",    name:"Cafe",         env:"cafe",     x:1030, y:120, devices:[DEVICE.LAPTOP],                 users:7  },
  { id:"hotel",   name:"Hotel Lobby",  env:"hotel",    x:1400, y:210, devices:[DEVICE.TABLET, DEVICE.LAPTOP],  users:6  },
  { id:"branch",  name:"Branch Office",env:"office",   x:1430, y:470, devices:[DEVICE.DESKTOP],                users:11 },
  { id:"wh",      name:"Warehouse",    env:"warehouse",x:1400, y:730, devices:[DEVICE.PHONE, DEVICE.TABLET],   users:8  },
  { id:"field",   name:"Field Office", env:"field",    x:1010, y:790, devices:[DEVICE.PHONE],                  users:6  },
  { id:"meeting", name:"Meeting Room", env:"meeting",  x:560,  y:800, devices:[DEVICE.TABLET],                 users:15 },
];

// Central data-center cluster (Quentra + SQL).
export const CENTER = {
  gateway: { x:735, y:345, w:210, h:120 },
  cache:   { x:735, y:520, w:210, h:150 },
  sql:     { x:1000,y:400, w:210, h:230 },
};

export const TOTAL_USERS = 100;
