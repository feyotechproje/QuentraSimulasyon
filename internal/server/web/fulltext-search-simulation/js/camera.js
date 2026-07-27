// High-angle (~35°) perspective camera. Not top-down, not isometric.
// World coords:
//   x : horizontal, roughly -1 (left) .. +1 (right)
//   d : depth, 0 = far (back of office) .. 1 = near (front, closest to viewer)
//   z : height above the floor in "screen-ish" units (positive = up)
// Nearer things (larger d) are drawn bigger and lower on screen.

export class Camera {
  constructor(view) {
    this.view = view;
    this.recompute();
  }

  recompute() {
    const { w, h } = this.view;
    this.cx = w * 0.5;
    // Premium close-in framing: office backdrop is a thin strip up top,
    // the desk cluster dominates and workers occupy the lower half.
    this.topY = h * 0.17;      // screen y of the far floor line (d = 0)
    this.botY = h * 0.97;      // screen y of the near floor line (d = 1)
    this.spanX = w * 0.30;     // half-width of the floor at reference depth
  }

  // Perspective scale for a given depth (foreshortening). ~45% closer overall.
  scaleAt(d) {
    return 0.95 + d * 1.45;
  }

  // Non-linear depth ramp so near rows spread out more (perspective feel).
  depthY(d) {
    const t = Math.pow(d, 1.18);
    return this.topY + t * (this.botY - this.topY);
  }

  // Project a floor point + height to screen.
  // Returns { x, y, s } where s is the local scale.
  project(wx, d, z = 0) {
    const s = this.scaleAt(d);
    const y = this.depthY(d) - z * s;
    const x = this.cx + wx * this.spanX * s;
    return { x, y, s };
  }
}
