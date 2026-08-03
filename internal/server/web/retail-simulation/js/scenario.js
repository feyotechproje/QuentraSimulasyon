// scenario.js
// Drives the "direct connection vs Quentra" comparison on top of the checkout
// simulation. The store runs BOTH routes at once: the left register bank scans
// over the direct connection, the right bank through the Quentra gateway.
//
// run mode:
//   DEMO — nothing is executed against SQL Server. The left floor's cadence is
//          the fixed slow constant, the right floor's the fast one, so the
//          direct queue visibly piles up while the Quentra side drains.
//   LIVE — the Go engine runs the real per-scan stock lookup on every register,
//          each over its own bank's connection. Latency figures come from the
//          backend snapshot per route — measured, never invented.

export const RUN_MODE = { DEMO: "demo", LIVE: "live" };
export const CONNECTION = { DIRECT: "direct", QUENTRA: "quentra" };

// Fixed 50x demo separation (per scanned item). Only used when runMode === demo.
export const DEMO_SCAN_SEC = { direct: 5, quentra: 0.1 };

/**
 * The auto-demo story. Each beat holds for `hold` seconds and shows a caption
 * explaining what the audience is watching. Both banks always run their own
 * route — the story narrates the standing comparison instead of switching it.
 */
export const STORY = [
  { key: "story.normal",   fallback: "One store, two register banks: direct on the left, Quentra on the right", hold: 7, tone: "neutral" },
  { key: "story.update",   fallback: "A software update added a stock check to every scan",                     hold: 7, tone: "bad" },
  { key: "story.udf",      fallback: "Each barcode now calls a scalar UDF that scans the sales table",          hold: 8, tone: "bad" },
  { key: "story.slow",     fallback: "Left bank: 5s per item. The cashier waits, the queue grows",              hold: 9, tone: "bad" },
  { key: "story.enter",    fallback: "Right bank: the SAME query travels through Quentra",                      hold: 7, tone: "good" },
  { key: "story.rewrite",  fallback: "SELECT dbo.QUENTRA_GetItemStock(@p1)  →  SELECT 0",                        hold: 8, tone: "good" },
  { key: "story.fast",     fallback: "0.1s per item. 50x faster, the right queue drains",                       hold: 9, tone: "good" },
  { key: "story.result",   fallback: "Same hardware · same data · same application code",                       hold: 8, tone: "good" },
];

// The SQL shown before the backend answers with the grounded text. Mirrors
// db.Store.ItemScanSQL so the panel is never empty on first paint.
const FALLBACK_SQL = {
  direct:
    "exec sp_executesql\n" +
    "  N'SELECT ITEMCODE,ITEMNAME,UNITPRICE,\n" +
    "      DBO.QUENTRA_GetItemStock(ITEMCODE) AS STOCK\n" +
    "    FROM dbo.[ITEMS] WHERE [ID] = @p1',\n" +
    "  N'@p1 bigint', @p1 = 1314",
  quentra:
    "exec sp_executesql\n" +
    "  N'SELECT ITEMCODE,ITEMNAME,UNITPRICE,100 STOCK\n" +
    "    FROM dbo.[ITEMS] WHERE [ID] = @p1',\n" +
    "  N'@p1 bigint', @p1 = 1314",
};

export class ScenarioController {
  /**
   * @param {object} client BackendClient — used only in live mode.
   * @param {function} onChange invoked whenever mode/SQL changes.
   */
  constructor(client, onChange) {
    this.client = client;
    this.onChange = onChange || (() => {});

    this.runMode = RUN_MODE.DEMO;
    this.auto = true;           // auto-play the narration in demo mode

    // Narration state: `beat` is the caption currently on screen (null when in
    // live mode or when the narration is off).
    this.beat = null;
    this.beatIndex = 0;
    this.beatCount = STORY.length;
    this._beatIndex = null;
    this._beatElapsed = Infinity;

    // Live-side measured figures, split per route (both banks run at once).
    this.liveMs = { direct: 0, quentra: 0 };       // avg per-scan DB ms
    this.liveScans = { direct: 0, quentra: 0 };    // samples per route
    this.liveErrors = 0;                           // failed lookups (excluded)
    // Whether the Quentra gateway pool was established. When false, both banks
    // travel the direct connection and the comparison is not real.
    this.gatewayUp = true;
    // Whether the captured Quentra statement shows a real rewrite (the UDF call
    // was eliminated). Live-only; defaults false so the badge never claims a
    // rewrite before the backend confirms one.
    this.liveRewritten = false;
    this.sql = { direct: FALLBACK_SQL.direct, quentra: FALLBACK_SQL.quentra };
  }

  // ------------------------------------------------------------------ state ---
  get isDemo() { return this.runMode === RUN_MODE.DEMO; }

  /**
   * SQL texts for the before/after panel. Demo plays the scripted story, so it
   * shows the matching hand-written pair (both pretty-printed); live shows the
   * application's real statement and the text CAPTURED from SQL Server, so a
   * missing rewrite is visible instead of papered over.
   */
  get displaySQL() {
    return this.isDemo ? FALLBACK_SQL : this.sql;
  }

  /**
   * Whether the Quentra side truly rewrote the query (UDF call eliminated). The
   * demo narrative always shows the rewrite; live mode reflects what was
   * actually captured from SQL Server's DMVs.
   */
  get rewritten() { return this.isDemo ? true : this.liveRewritten; }

  /**
   * Latency to display for a side, in milliseconds. In demo mode both sides are
   * the fixed constants; in live mode they are whatever the engine measured on
   * that bank.
   */
  latencyMs(side) {
    if (this.isDemo) return DEMO_SCAN_SEC[side] * 1000;
    return this.liveMs[side] || 0;
  }

  /** True when the figures on screen come from real query execution. */
  get isMeasured() { return !this.isDemo; }

  // ----------------------------------------------------------------- control ---
  async setRunMode(mode) {
    if (mode === this.runMode) return;
    this.runMode = mode;
    if (mode === RUN_MODE.LIVE) {
      this.beat = null;                  // captions describe the demo story only
      // Turn the real per-scan lookup ON. Routing is per register bank, so this
      // single switch arms both sides of the comparison.
      await this._post("baseline");
    } else {
      // Leaving live mode: stop the real per-scan lookup so we are not holding
      // SQL Server under load while the demo plays.
      await this._post("off");
    }
    this.onChange();
  }

  setAuto(on) {
    this.auto = !!on && this.isDemo;     // narration only makes sense in demo
    if (this.auto) this.restartStory();
    else this.beat = null;
    this.onChange();
  }

  /**
   * Advance the auto-demo narration. Called once per frame with the delta.
   * Beats only narrate — both banks always run their own fixed route.
   */
  tick(dt) {
    if (!this.isDemo || !this.auto) { this.beat = null; return; }

    if (this._beatIndex == null) { this._beatIndex = -1; this._beatElapsed = Infinity; }
    const current = STORY[this._beatIndex];
    const hold = current ? current.hold : 0;
    this._beatElapsed += dt;
    if (this._beatElapsed < hold) return;

    this._beatIndex = (this._beatIndex + 1) % STORY.length;
    this._beatElapsed = 0;
    this.beat = STORY[this._beatIndex];
    this.beatIndex = this._beatIndex;
    this.beatCount = STORY.length;
    this.onChange();
  }

  /** 0..1 through the current caption's hold time (for the progress bar). */
  beatProgress() {
    const b = this.beat;
    if (!b || !b.hold) return 0;
    return Math.max(0, Math.min(1, this._beatElapsed / b.hold));
  }

  /** Restart the narration from the first beat. */
  restartStory() {
    this._beatIndex = null;
    this._beatElapsed = Infinity;
    this.beat = null;
  }

  /**
   * Absorb backend snapshot metrics (live mode measurements). Both banks run at
   * once, so each column reads its own route's average directly — no mode
   * gating, no column can land in the wrong side.
   */
  applySnapshot(snap) {
    const m = (snap && snap.metrics) || null;
    if (!m) return;
    this.liveErrors = m.stockErrors || 0;
    this.liveScans.direct = m.scanCountDirect || 0;
    this.liveScans.quentra = m.scanCountQuentra || 0;
    if (m.avgScanDbDirectMs) this.liveMs.direct = m.avgScanDbDirectMs;
    if (m.avgScanDbQuentraMs) this.liveMs.quentra = m.avgScanDbQuentraMs;
  }

  // ------------------------------------------------------------------ wiring ---
  /**
   * Each column is the single query a register runs per scanned barcode. The
   * two differ only in the stock expression, which is what the rewrite targets,
   * so the panel's SQL fully accounts for the latency the panel reports.
   */
  _absorbSQL(res) {
    this.sql.direct = res.baselineSQL || this.sql.direct;
    this.sql.quentra = res.quentraSQL || this.sql.quentra;
    if (typeof res.gatewayUp === "boolean") this.gatewayUp = res.gatewayUp;
    if (typeof res.quentraRewritten === "boolean") this.liveRewritten = res.quentraRewritten;
  }

  async _post(mode) {
    if (!this.client) return;
    try {
      const res = await this.client.setStockMode(mode);
      if (res && res.baselineSQL) {
        this._absorbSQL(res);
        this.onChange();
      }
    } catch {
      /* backend unreachable — demo mode still works, panel keeps fallback SQL */
    }
  }

  /** Fetch the grounded SQL texts once at boot. */
  async loadSQL() {
    if (!this.client) return;
    try {
      const res = await this.client.getStockMode();
      if (res && res.baselineSQL) {
        this._absorbSQL(res);
        this.onChange();
      }
    } catch { /* keep fallback */ }
  }
}
