// gateway.js
// The Quentra Gateway node. In baseline mode it is a pass-through; in Quentra
// mode it fingerprints the ad-hoc UPDATE, extracts parameters and rewrites to a
// stored procedure. It only tracks demo counters + module activity levels.

export const GATEWAY_MODULES = [
  { id: "fingerprint", label: "SQL Fingerprint" },
  { id: "pattern",     label: "Pattern Detection" },
  { id: "params",      label: "Parameter Extraction" },
  { id: "rewrite",     label: "Rewrite Engine" },
  { id: "router",      label: "Procedure Router" },
];

export class Gateway {
  constructor() {
    this.fingerprints = 0;
    this.rewriteMatches = 0;
    this.parametersExtracted = 0;
    this.proceduresUsed = 1;
    this.compilationsAvoided = 0;
    this.activity = 0;           // 0..1 glow used by renderer
    this.mode = "baseline";
    this.lastPattern = "UPDATE dbo.VehicleState SET … WHERE VehicleID = @VehicleID";
  }

  process(update) {
    if (this.mode === "quentra") {
      this.fingerprints++;
      this.rewriteMatches++;
      this.parametersExtracted += 6; // six literals -> six params
      this.compilationsAvoided++;
      this.activity = Math.min(1, this.activity + 0.08);
    } else {
      this.fingerprints++; // still sees it, just passes through
      this.activity = Math.min(1, this.activity + 0.03);
    }
  }

  update(dt, mode) {
    this.mode = mode;
    this.activity = Math.max(mode === "quentra" ? 0.35 : 0.15, this.activity - dt * 0.5);
  }
}
