// world.js — builds the static scene graph (locations, hero figures, devices,
// network paths, central nodes). Pure data + geometry; no rendering here.

import { LOCATIONS, CENTER, DEVICE } from "./config.js";
import { SKINS, HAIRS, SHIRTS } from "./draw.js";
import { SCREEN, controlPoint, pick, randi } from "./models.js";

const FIRST = ["Ava","Liam","Mia","Noah","Zoe","Ethan","Aria","Kai","Ivy","Leo",
               "Sara","Omar","Nina","Jack","Lena","Theo","Maya","Finn","Rosa","Dev"];

function appearance() {
  return { skin:pick(SKINS), hair:pick(HAIRS), shirt:pick(SHIRTS),
           pants:pick(["#3a4256","#2f3446","#4a3f5e","#274156"]), hairStyle:randi(0,2) };
}

/** Anchor where a location connects into the network (near tile bottom-center). */
function anchorFor(loc) {
  const tile = tileRect(loc);
  return { x: tile.x + tile.w/2, y: tile.y + tile.h - 6 };
}

export function tileRect(loc) {
  const w = 236, h = 168;
  return { x: loc.x - w/2, y: loc.y - h/2, w, h };
}

export function buildWorld() {
  const gatewayIn = { x: CENTER.gateway.x + CENTER.gateway.w/2, y: CENTER.gateway.y };

  const locations = LOCATIONS.map(def => {
    const tile = tileRect(def);
    // hero device = first device type; placed inside the tile scene area.
    const heroDevice = def.devices[0];
    const hero = {
      name: pick(FIRST),
      app: appearance(),
      device: heroDevice,
      pose: (heroDevice === DEVICE.DESKTOP) ? "sit" : "stand",
      screen: SCREEN.IDLE,
      progress: 0,
      source: null,
      // scene origin inside tile
      sx: tile.x + tile.w*0.5,
      sy: tile.y + tile.h*0.72,
    };
    // small secondary figures (crowd) for "many users" feel
    const extras = [];
    const n = Math.min(3, Math.max(1, Math.round(def.users/6)));
    for (let i=0;i<n;i++) extras.push({ app: appearance(), dx: (i-1)*26, phase: Math.random()*6 });

    return {
      ...def, tile, hero, extras,
      anchor: anchorFor(def),
      // live status (updated by simulation)
      pending: 0, completed: 0, avgMs: 0, dataSource: "sql",
      t: Math.random()*10,
    };
  });

  // curved network path per location -> gateway
  const paths = locations.map(loc => {
    const a = loc.anchor, b = gatewayIn;
    return { locId: loc.id, a, b, c: controlPoint(a, b, 0.14) };
  });

  return {
    locations, paths, gatewayIn,
    nodes: {
      gateway: { ...CENTER.gateway, cx: CENTER.gateway.x + CENTER.gateway.w/2, cy: CENTER.gateway.y + CENTER.gateway.h/2 },
      cache:   { ...CENTER.cache,   cx: CENTER.cache.x   + CENTER.cache.w/2,   cy: CENTER.cache.y   + CENTER.cache.h/2 },
      sql:     { ...CENTER.sql,     cx: CENTER.sql.x     + CENTER.sql.w/2,     cy: CENTER.sql.y     + CENTER.sql.h/2 },
    },
  };
}
