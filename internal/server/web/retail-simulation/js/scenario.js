// scenario.js
// Drives the "direct connection vs Quentra" comparison on top of the checkout
// simulation. Two orthogonal axes:
//
//   run mode   : "demo" | "live"
//   connection : "direct" | "quentra"
//
// DEMO  — nothing is executed against SQL Server. The scan cadence is scaled
//         locally by DEMO_SCAN_SEC so the queue visibly piles up on the direct
//         connection and drains once Quentra rewrites the lookup. The latency
//         figures shown are the fixed demo constants, and are labelled as such.
// LIVE  — the real engine runs the per-scan stock lookup. On "direct" that is
//         the slow scalar UDF (dbo.QUENTRA_GetItemStock); on "quentra" the call
//         is rewritten to a constant. Latency figures come from the backend
//         snapshot (avgScanDbMs) — measured, never invented.
//
// In demo mode with auto on, a narrated STORY drives both the captions and the
// connection switches so the animation explains the improvement as it happens.

export const RUN_MODE = { DEMO: "demo", LIVE: "live" };
export const CONNECTION = { DIRECT: "direct", QUENTRA: "quentra" };

// Fixed 50x demo separation (per scanned item). Only used when runMode === demo.
export const DEMO_SCAN_SEC = { direct: 5, quentra: 0.1 };

/**
 * The auto-demo story. Each beat holds for `hold` seconds, optionally switches
 * the connection, and shows a caption explaining what the audience is watching.
 * `tone` drives the caption's styling: neutral / bad (the problem building) /
 * good (the fix landing).
 *
 * The arc: a normal store -> a software update adds a per-scan stock lookup ->
 * queues grow -> Quentra rewrites the call away -> queues drain -> the summary.
 */
export const STORY = [
  { key: "story.normal",   fallback: "A normal morning. 10 registers, steady flow",            hold: 6,  tone: "neutral", conn: CONNECTION.QUENTRA },
  { key: "story.update",   fallback: "A software update adds a stock check to every scan",      hold: 7,  tone: "bad",     conn: CONNECTION.DIRECT },
  { key: "story.udf",      fallback: "Each barcode now calls a scalar UDF that scans the sales table", hold: 8, tone: "bad" },
  { key: "story.slow",     fallback: "5s per item. The cashier waits, the queue grows",       hold: 9,  tone: "bad" },
  { key: "story.pain",     fallback: "Nothing is broken. The database is simply asked too much.", hold: 8, tone: "bad" },
  { key: "story.enter",    fallback: "Quentra rewrites the query at runtime. No code change",  hold: 7,  tone: "good",    conn: CONNECTION.QUENTRA },
  { key: "story.rewrite",  fallback: "SELECT dbo.QUENTRA_GetItemStock(@p1)  →  SELECT 0",       hold: 8,  tone: "good" },
  { key: "story.fast",     fallback: "0.1s per item. 50x faster, the queue drains",           hold: 9,  tone: "good" },
  { key: "story.result",   fallback: "Same hardware · same data · same application code",       hold: 8,  tone: "good" },
];

// The SQL shown before the backend answers with the grounded text. Mirrors
// db.Store.StockLookupSQL so the panel is never empty on first paint.
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
   * @param {function} onChange invoked whenever mode/connection/SQL changes.
   */
  constructor(client, onChange) {
    this.client = client;
    this.onChange = onChange || (() => {});

    this.runMode = RUN_MODE.DEMO;
    this.connection = CONNECTION.DIRECT;
    this.auto = true;           // auto-cycle in demo mode
    this._autoElapsed = 0;

    // Narration state: `beat` is the caption currently on screen (null when the
    // operator is driving manually or in live mode).
    this.beat = null;
    this.beatIndex = 0;
    this.beatCount = STORY.length;
    this._beatIndex = null;
    this._beatElapsed = Infinity;

    // Demo-side measurements are derived from the fixed constants; live-side
    // figures are filled in from the backend snapshot.
    this.liveAvgMs = 0;      // product + stock, averaged over the current mode
    this.liveLastMs = 0;
    this.liveItemMs = 0;     // product-lookup share of the average
    this.liveStockMs = 0;    // stock-lookup share of the average
    this.liveSamples = 0;    // scans measured in the current mode window
    this.liveErrors = 0;     // failed lookups, excluded from the average
    // Whether the Quentra gateway pool was established. When false, live mode
    // sends both modes down the same route and the comparison is not real.
    this.gatewayUp = true;
    this.sql = { direct: FALLBACK_SQL.direct, quentra: FALLBACK_SQL.quentra };

    // Remembers the best measurement seen per connection in live mode, so the
    // comparison panel can still show "before" numbers after switching away.
    this.seenLiveMs = { direct: 0, quentra: 0 };
  }

  // ------------------------------------------------------------------ state ---
  get isDemo() { return this.runMode === RUN_MODE.DEMO; }
  get isQuentra() { return this.connection === CONNECTION.QUENTRA; }

  /** Seconds per scanned item currently in force (demo mode only). */
  get demoScanSec() {
    return this.isQuentra ? DEMO_SCAN_SEC.quentra : DEMO_SCAN_SEC.direct;
  }

  /** Backend stock-mode string for the current connection. */
  get stockMode() {
    return this.isQuentra ? "quentra" : "baseline";
  }

  /**
   * Latency to display for a side, in milliseconds. In demo mode both sides are
   * the fixed constants; in live mode they are whatever the engine measured.
   */
  latencyMs(side) {
    if (this.isDemo) return DEMO_SCAN_SEC[side] * 1000;
    return this.seenLiveMs[side] || 0;
  }

  /** True when the figures on screen come from real query execution. */
  get isMeasured() { return !this.isDemo; }

  // ----------------------------------------------------------------- control ---
  async setRunMode(mode) {
    if (mode === this.runMode) return;
    this.runMode = mode;
    this._autoElapsed = 0;
    if (mode === RUN_MODE.LIVE) {
      this.auto = false;                 // live mode is always operator-driven
      this.beat = null;                  // captions describe the demo story only
      await this._pushStockMode();
    } else {
      // Leaving live mode: stop the real per-scan lookup so we are not holding
      // SQL Server under load while the demo plays.
      await this._post("off");
    }
    this.onChange();
  }

  async setConnection(conn) {
    if (conn === this.connection) return;
    this.connection = conn;
    this._autoElapsed = 0;
    if (this.runMode === RUN_MODE.LIVE) await this._pushStockMode();
    this.onChange();
  }

  setAuto(on) {
    this.auto = !!on && this.isDemo;     // auto-cycling only makes sense in demo
    this._autoElapsed = 0;
    // Starting auto replays the story from the top; stopping clears the caption.
    if (this.auto) this.restartStory();
    else this.beat = null;
    this.onChange();
  }

  /** Manual toggle used by the Direct/Quentra buttons. Cancels auto-cycling. */
  async selectConnection(conn) {
    this.auto = false;
    this.beat = null;
    await this.setConnection(conn);
  }

  /**
   * Advance the auto-demo. Called each frame with the frame delta.
   *
   * When auto is on, the narrated STORY drives both the caption and the
   * connection switches, so the animation explains itself. With auto off the
   * operator drives the connection and no captions are shown.
   */
  tick(dt) {
    if (!this.isDemo) return;
    if (!this.auto) { this.beat = null; return; }

    if (this._beatIndex == null) { this._beatIndex = -1; this._beatElapsed = Infinity; }
    const current = STORY[this._beatIndex];
    const hold = current ? current.hold : 0;
    this._beatElapsed += dt;
    if (this._beatElapsed < hold) return;

    // Advance to the next beat (looping), applying its connection if it sets one.
    this._beatIndex = (this._beatIndex + 1) % STORY.length;
    this._beatElapsed = 0;
    const beat = STORY[this._beatIndex];
    this.beat = beat;
    this.beatIndex = this._beatIndex;
    this.beatCount = STORY.length;
    if (beat.conn && beat.conn !== this.connection) this.connection = beat.conn;
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
   * Absorb backend snapshot metrics (live mode measurements).
   *
   * The headline figure is avgScanDbMs — product lookup + stock lookup summed
   * per scanned item, which is the database time a cashier actually waits for.
   * The backend clears this average whenever the stock mode changes, so it only
   * ever describes the mode currently on screen.
   */
  applySnapshot(snap) {
    const m = (snap && snap.metrics) || null;
    if (!m) return;
    this.liveAvgMs = m.avgScanDbMs || 0;
    this.liveLastMs = m.lastScanDbMs || 0;
    this.liveItemMs = m.avgItemMs || 0;
    this.liveStockMs = m.avgStockMs || 0;
    this.liveSamples = m.stockLookups || 0;
    this.liveErrors = m.stockErrors || 0;
    if (this.runMode !== RUN_MODE.LIVE) return;
    // Only record a measurement when the backend agrees which mode is active,
    // so a figure never lands in the wrong column during a switch. Requires at
    // least one sample in the new window, otherwise a freshly-cleared average
    // (0) would blank out the column mid-switch.
    if (!this.liveSamples) return;
    if (m.stockMode === "quentra") this.seenLiveMs.quentra = this.liveAvgMs;
    else if (m.stockMode === "baseline") this.seenLiveMs.direct = this.liveAvgMs;
  }

  // ------------------------------------------------------------------ wiring ---
  /**
   * Each column is the single query the register runs per scanned barcode. The
   * two differ only in the stock expression, which is what the rewrite targets,
   * so the panel's SQL fully accounts for the latency the panel reports.
   */
  _absorbSQL(res) {
    this.sql.direct = res.baselineSQL || this.sql.direct;
    this.sql.quentra = res.quentraSQL || this.sql.quentra;
    if (typeof res.gatewayUp === "boolean") this.gatewayUp = res.gatewayUp;
  }

  async _pushStockMode() { await this._post(this.stockMode); }

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
