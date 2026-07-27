// assets.js — image asset cache with graceful fallback.
// Loads the provided Quentra / Key Breaker PNGs when present in ./assets.
// If a file is missing (e.g. not yet dropped in), the flag stays false and the
// renderer draws a vector fallback instead — so the demo always renders.

import { ASSETS } from "./config.js";

class AssetStore {
  constructor() {
    this.images = {};   // key -> HTMLImageElement
    this.ready = {};    // key -> boolean
  }

  load() {
    const load1 = (key, src) =>
      new Promise((resolve) => {
        const img = new Image();
        img.onload = () => { this.images[key] = img; this.ready[key] = true; resolve(); };
        img.onerror = () => { this.ready[key] = false; resolve(); };
        img.src = src;
      });
    return Promise.all(Object.entries(ASSETS).map(([k, src]) => load1(k, src)));
  }

  get(key) { return this.ready[key] ? this.images[key] : null; }
  has(key) { return !!this.ready[key]; }
}

export const Assets = new AssetStore();
