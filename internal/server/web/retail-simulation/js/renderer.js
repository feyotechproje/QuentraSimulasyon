// renderer.js
// Canvas 2D renderer with devicePixelRatio support, a pseudo-isometric camera
// (vertical squash) and painter's-algorithm depth sorting. Everything is drawn
// procedurally — no images, no emoji.

import { WORLD, queueSlot } from "./world.js";
import { drawPerson, CUSTOMER_STATE } from "./customer.js";
import { REGISTER_STATE } from "./checkout.js";

const SECTIONS = ["PRODUCE", "BAKERY", "DAIRY", "MEAT", "FROZEN", "PANTRY", "DRINKS", "HOME"];

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.dpr = 1;
    this.cssW = 0;
    this.cssH = 0;
    this.scale = 1;
    this.offsetX = 0;
    this.offsetY = 0;
    this.resize();
  }

  resize(world) {
    const wrap = this.canvas.parentElement;
    const rect = (wrap || this.canvas).getBoundingClientRect();
    this.cssW = Math.max(1, Math.round(rect.width));
    // Width drives the scale; the resulting scene height becomes the canvas's
    // own height so the wrapper can scroll to it instead of squeezing the
    // queue lanes to fit a fixed viewport. Registers stay pinned near the top;
    // the wrapper starts scrolled to top so counters are visible immediately.
    if (world) {
      const pad = 34;
      const padTop = 64;
      const worldW = world.width;
      const worldH = world.height * WORLD.squash;
      const availW = Math.max(40, this.cssW - 2 * pad);
      const fitW = Math.max(0.05, availW / worldW);
      // Fit the complete floor to the available width. The previous 1.12
      // overscan cropped the outer registers and became especially noticeable
      // when live mode used a different register count from the demo.
      this.scale = fitW;
      this.offsetX = (this.cssW - worldW * this.scale) / 2 - world.origin.x * this.scale;
      this.offsetY = padTop - world.origin.y * WORLD.squash * this.scale;
      // The canvas bitmap itself must be at least as tall as its viewport.
      // Letting CSS stretch a shorter bitmap changes the Y scale independently
      // and makes the live floor look vertically distorted.
      const sceneH = Math.round(worldH * this.scale + padTop + pad);
      this.cssH = Math.max(1, Math.round(rect.height), sceneH);
    } else {
      this.cssH = Math.max(1, Math.round(rect.height));
    }
    this.canvas.style.height = this.cssH + "px";
    this.dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2.5));
    this.canvas.width = Math.round(this.cssW * this.dpr);
    this.canvas.height = Math.round(this.cssH * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  toScreen(wx, wy, z = 0) {
    return {
      x: this.offsetX + wx * this.scale,
      y: this.offsetY + wy * WORLD.squash * this.scale - z * this.scale,
    };
  }

  roundRect(x, y, w, h, rad) {
    const ctx = this.ctx;
    if (w < 0) { x += w; w = -w; }
    if (h < 0) { y += h; h = -h; }
    const rr = Math.max(0, Math.min(rad, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  render(sim) {
    if (this._lastRegCount !== sim.world.registers.length || !this._sized) {
      this._lastRegCount = sim.world.registers.length;
      this._sized = true;
      this.resize(sim.world);
    }
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    this._cashierHits = [];

    this._drawFloor(sim.world);
    this._drawLanes(sim.world);
    this._drawShelves(sim.world);
    this._drawSigns(sim.world);

    // depth-sorted scene
    const draws = [];
    for (const reg of sim.registers) {
      draws.push({ y: reg.reg.frontY, fn: () => this._drawCounter(reg, sim) });
      draws.push({ y: reg.cashier.pos.y, fn: () => { reg.cashier.draw(this); this._drawCashierLabel(reg); } });
    }
    for (const c of sim.customers) {
      // Shoppers walking in from the off-screen door stay hidden until they take
      // their place in a queue: the scene is about the queues, not the traffic.
      // Only entry walkers are skipped — `enteringStore` is cleared on arrival,
      // so someone stepping from the queue front up to the counter still shows.
      if (c.enteringStore) continue;
      draws.push({ y: c.depth, fn: () => this._drawCustomer(c, sim) });
    }
    draws.sort((a, b) => a.y - b.y);
    for (const d of draws) d.fn();

    // selection highlight on top
    const sel = sim.selectedRegister;
    if (sel) this._drawSelection(sel);
  }

  // ---------- environment ----------
  _drawFloor(world) {
    const ctx = this.ctx;
    const b = world.bounds;
    const tl = this.toScreen(b.minX, b.minY);
    const br = this.toScreen(b.maxX, b.maxY);
    const floor = ctx.createLinearGradient(0, tl.y, 0, br.y);
    floor.addColorStop(0, "#eaf0f7");
    floor.addColorStop(.24, "#f8fafc");
    floor.addColorStop(1, "#eef3f8");
    ctx.fillStyle = floor;
    ctx.fillRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
    // A quiet merchandising wall anchors the checkout area visually.
    const wallBottom = this.toScreen(b.maxX, b.minY + 92);
    ctx.fillStyle = "#e2e8f0";
    ctx.fillRect(tl.x, tl.y, br.x - tl.x, wallBottom.y - tl.y);
    ctx.fillStyle = "#172554";
    ctx.fillRect(tl.x, tl.y, br.x - tl.x, 6);
    ctx.fillStyle = "rgba(23,37,84,.12)";
    ctx.font = `700 ${Math.max(10, 12 * this.scale)}px Inter, system-ui, sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText("SATIŞ ALANI  ·  QUENTRA_RETAIL ÜRÜN AKIŞI", tl.x + 18, tl.y + 15);

    ctx.strokeStyle = "rgba(100,116,139,0.11)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = b.minX; x <= b.maxX; x += 48) {
      const a = this.toScreen(x, b.minY), c = this.toScreen(x, b.maxY);
      ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y);
    }
    for (let y = b.minY; y <= b.maxY; y += 48) {
      const a = this.toScreen(b.minX, y), c = this.toScreen(b.maxX, y);
      ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y);
    }
    ctx.stroke();
  }

  _drawLanes(world) {
    const ctx = this.ctx;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.shadowBlur = 0;
    // main corridor line
    const cA = this.toScreen(world.bounds.minX + 60, world.corridorY);
    const cB = this.toScreen(world.bounds.maxX - 60, world.corridorY);
    ctx.strokeStyle = "rgba(79,70,229,.30)";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cA.x, cA.y); ctx.lineTo(cB.x, cB.y); ctx.stroke();
    // per-register queue lanes
    for (const reg of world.registers) {
      const top = this.toScreen(reg.cx, world.corridorY);
      const bend = this.toScreen(reg.cx, reg.frontY + 10);
      const lastSlot = queueSlot(reg, WORLD.visibleQueueSlots - 1);
      const tail = this.toScreen(reg.cx, lastSlot.y);
      ctx.strokeStyle = "rgba(37,99,235,.20)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(top.x, top.y); ctx.lineTo(bend.x, bend.y); ctx.lineTo(tail.x, tail.y);
      ctx.stroke();
      ctx.fillStyle = "rgba(79,70,229,.72)";
      ctx.beginPath(); ctx.arc(bend.x, bend.y, 3, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    ctx.shadowBlur = 0;
  }

  _drawShelves(world) {
    const ctx = this.ctx;
    const shelfY = world.bounds.minY + 26;
    const startX = world.bounds.minX + 60;
    const endX = world.bounds.maxX - 60;
    const span = (endX - startX) / SECTIONS.length;
    for (let i = 0; i < SECTIONS.length; i++) {
      const x0 = startX + i * span + 8;
      const x1 = x0 + span - 26;
      const p0 = this.toScreen(x0, shelfY, 44);
      const p1 = this.toScreen(x1, shelfY, 44);
      const b0 = this.toScreen(x0, shelfY, 0);
      // shelf body
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(p0.x, p0.y, p1.x - p0.x, b0.y - p0.y);
      ctx.fillStyle = "rgba(79,70,229,.55)";
      ctx.fillRect(p0.x, p0.y, p1.x - p0.x, 3);
      // stocked rows
      ctx.fillStyle = "rgba(148,163,184,.38)";
      for (let ry = 1; ry <= 3; ry++) {
        ctx.fillRect(p0.x, p0.y + ry * ((b0.y - p0.y) / 4), p1.x - p0.x, 3);
      }
      // section sign
      const sign = this.toScreen((x0 + x1) / 2, shelfY, 58);
      ctx.fillStyle = "rgba(255,255,255,0.96)";
      this.roundRect(sign.x - 34, sign.y - 12, 68, 18, 4); ctx.fill();
      ctx.strokeStyle = "rgba(79,70,229,.25)"; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = "#3730a3";
      ctx.font = "600 9px Inter, system-ui, sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(SECTIONS[i], sign.x, sign.y - 3);
    }
  }

  _drawSigns(world) {
    const ctx = this.ctx;
    const drawSign = (pt, text, color) => {
      ctx.save();
      ctx.shadowColor = color; ctx.shadowBlur = 16;
      ctx.fillStyle = "rgba(255,255,255,0.96)";
      this.roundRect(pt.x - 32, pt.y - 34, 64, 20, 6); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = color; ctx.lineWidth = 1.4;
      this.roundRect(pt.x - 32, pt.y - 34, 64, 20, 6); ctx.stroke();
      ctx.fillStyle = color;
      ctx.font = "700 10px Inter, system-ui, sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(text, pt.x, pt.y - 24);
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash([4, 4]);
      ctx.shadowColor = color; ctx.shadowBlur = 10;
      ctx.beginPath(); ctx.moveTo(pt.x, pt.y - 14); ctx.lineTo(pt.x, pt.y + 8); ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    };
    // Entrance sits on the sales floor at the bottom; the corridor behind the
    // counters is exit-only, so the two flows never share a lane.
    drawSign(this.toScreen(world.entrance.x, world.entranceY), "ENTRANCE", "#22d3ee");
    drawSign(this.toScreen(world.exit.x, world.corridorY), "EXIT", "#5eead4");
  }

  // ---------- register / counter ----------
  _drawCashierLabel(register) {
    const ctx = this.ctx;
    const name = register.cashier && register.cashier.name ? register.cashier.name : "Kasiyer";
    const p = this.toScreen(register.cashier.pos.x, register.cashier.pos.y, 52);
    const fontSize = Math.max(8.5, Math.min(11, 9.5 * this.scale));
    ctx.save();
    ctx.font = `700 ${fontSize}px Inter, system-ui, sans-serif`;
    const width = Math.max(54, ctx.measureText(name).width + 18);
    const height = 19;
    const x = p.x - width / 2;
    const y = p.y - height / 2;
    ctx.fillStyle = register.highlighted ? "#4f46e5" : "rgba(255,255,255,.97)";
    this.roundRect(x, y, width, height, 7); ctx.fill();
    ctx.strokeStyle = register.highlighted ? "#4338ca" : "rgba(99,102,241,.35)";
    ctx.lineWidth = 1;
    this.roundRect(x, y, width, height, 7); ctx.stroke();
    ctx.fillStyle = register.highlighted ? "#ffffff" : "#334155";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(name, p.x, p.y + .5);
    ctx.restore();
    this._cashierHits.push({ id: register.id, x, y, width, height });
  }

  _drawCounter(register, sim) {
    const ctx = this.ctx;
    const reg = register.reg;
    const cx = reg.cx;
    const halfW = reg.w / 2;
    const h = reg.h;

    const tl = this.toScreen(cx - halfW, reg.backY, h);
    const tr = this.toScreen(cx + halfW, reg.backY, h);
    const brp = this.toScreen(cx + halfW, reg.frontY, h);
    const blp = this.toScreen(cx - halfW, reg.frontY, h);
    const bl0 = this.toScreen(cx - halfW, reg.frontY, 0);
    const br0 = this.toScreen(cx + halfW, reg.frontY, 0);

    // front face
    ctx.fillStyle = "#d8e1ec";
    ctx.beginPath();
    ctx.moveTo(blp.x, blp.y); ctx.lineTo(brp.x, brp.y);
    ctx.lineTo(br0.x, br0.y); ctx.lineTo(bl0.x, bl0.y); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#4f46e5";
    ctx.fillRect(bl0.x, br0.y - 4, br0.x - bl0.x, 4);

    // top surface
    const grad = ctx.createLinearGradient(tl.x, tl.y, blp.x, blp.y);
    grad.addColorStop(0, "#ffffff");
    grad.addColorStop(1, "#e7edf5");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(tl.x, tl.y); ctx.lineTo(tr.x, tr.y);
    ctx.lineTo(brp.x, brp.y); ctx.lineTo(blp.x, blp.y); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = "rgba(71,85,105,.20)"; ctx.lineWidth = 1; ctx.stroke();

    // conveyor belt (customer side of the top surface)
    const beltBackY = reg.frontY - 8;
    const beltFrontY = reg.frontY - 26;
    const beltL = this.toScreen(cx - halfW + 10, beltFrontY, h + 1);
    const beltR = this.toScreen(cx + halfW - 34, beltFrontY, h + 1);
    const beltBL = this.toScreen(cx - halfW + 10, beltBackY, h + 1);
    ctx.fillStyle = "#64748b";
    ctx.beginPath();
    ctx.moveTo(beltL.x, beltL.y); ctx.lineTo(beltR.x, beltR.y);
    const beltBR = this.toScreen(cx + halfW - 34, beltBackY, h + 1);
    ctx.lineTo(beltBR.x, beltBR.y); ctx.lineTo(beltBL.x, beltBL.y); ctx.closePath(); ctx.fill();
    // belt rollers
    ctx.strokeStyle = "rgba(255,255,255,0.42)"; ctx.lineWidth = 1;
    for (let i = 1; i < 6; i++) {
      const t = i / 6;
      const a = this._lerp(beltL, beltR, t), bpt = this._lerp(beltBL, beltBR, t);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(bpt.x, bpt.y); ctx.stroke();
    }

    // items on the belt during unloading / scanning
    this._drawBeltItems(register, cx, halfW, h, beltBackY, beltFrontY, sim);

    // barcode scanner glow near the register end
    const scan = this.toScreen(cx + halfW - 24, reg.frontY - 16, h + 1);
    const scanning = register.state === REGISTER_STATE.SCANNING;
    ctx.fillStyle = scanning ? "#059669" : "#64748b";
    this.roundRect(scan.x - 6, scan.y - 4, 12, 8, 2); ctx.fill();
    if (scanning) {
      ctx.strokeStyle = "#d1fae5"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(scan.x - 5, scan.y); ctx.lineTo(scan.x + 5, scan.y); ctx.stroke();
    }

    // POS screen standing on the counter (register side)
    const posBase = this.toScreen(cx + halfW - 12, reg.backY + 10, h);
    const posTop = this.toScreen(cx + halfW - 12, reg.backY + 10, h + 20);
    ctx.strokeStyle = "#6b7280"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(posBase.x, posBase.y); ctx.lineTo(posTop.x, posTop.y); ctx.stroke();
    ctx.fillStyle = register.currentCustomer ? "#1e293b" : "#334155";
    this.roundRect(posTop.x - 11, posTop.y - 9, 22, 14, 2); ctx.fill();
    if (register.currentCustomer) {
      ctx.fillStyle = "#7CF0C0";
      ctx.font = "700 6px Inter, system-ui, sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      const t = register.currentCustomer.runningTotal || 0;
      ctx.fillText(t.toFixed(0), posTop.x, posTop.y - 2);
    }

    // receipt extruding from the printer
    if (register.state === REGISTER_STATE.RECEIPT && register.receipt > 0) {
      const pr = this.toScreen(cx + halfW - 22, reg.backY + 14, h + 2);
      const len = 22 * register.receipt;
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "#cbd5e1"; ctx.lineWidth = 1;
      this.roundRect(pr.x - 6, pr.y, 12, len, 1); ctx.fill(); ctx.stroke();
      ctx.strokeStyle = "#e2e8f0";
      for (let i = 1; i * 5 < len; i++) {
        ctx.beginPath(); ctx.moveTo(pr.x - 4, pr.y + i * 5); ctx.lineTo(pr.x + 4, pr.y + i * 5); ctx.stroke();
      }
    }

    // hanging register number sign
    const sign = this.toScreen(cx, reg.backY - 6, h + 46);
    ctx.save();
    ctx.shadowColor = register.highlighted ? "rgba(94,234,212,0.9)" : "rgba(34,211,238,0.5)";
    ctx.shadowBlur = register.highlighted ? 18 : 10;
    ctx.fillStyle = "#0c1730";
    this.roundRect(sign.x - 15, sign.y - 10, 30, 18, 5); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = register.highlighted ? "#5eead4" : "rgba(94,234,212,0.55)";
    ctx.lineWidth = 1.4;
    this.roundRect(sign.x - 15, sign.y - 10, 30, 18, 5); ctx.stroke();
    ctx.fillStyle = "#eaf6ff";
    ctx.font = "700 11px Inter, system-ui, sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(String(register.id).padStart(2, "0"), sign.x, sign.y);
    ctx.restore();

    // customer-facing product / price display behind the counter
    this._drawCustomerDisplay(register, sim);
  }

  // A small screen mounted behind the register that shows the items being
  // scanned with prices and the live running total. Product names are cosmetic;
  // the total is the register's real basketSubtotal (see backend _updateReceipt).
  _drawCustomerDisplay(register, sim) {
    const ctx = this.ctx;
    const reg = register.reg;
    const cx = reg.cx;
    const h = reg.h;
    const c = register.currentCustomer;
    const lines = register._rcptLines || [];
    const scanning = register.state === REGISTER_STATE.SCANNING;

    // Tie the board size to the counter's on-screen width so it scales with the
    // world zoom. This keeps every counter visible in its place: the screen just
    // floats above it and never grows wide enough to cover the register.
    const counterW = reg.w * this.scale;
    const W = Math.min(counterW * 1.02, 78);
    const f = Math.max(0.5, Math.min(1.15, W / 62)); // proportional detail factor
    const headerH = 12 * f;
    const rowH = 8 * f;
    const totalH = 19 * f;
    const padV = 4 * f;
    const shownRows = c ? Math.min(4, Math.max(1, lines.length)) : 1;
    const bodyH = headerH + shownRows * rowH + totalH + padV;
    const px = (n) => `${(n * f).toFixed(1)}px`;

    const signTop = this.toScreen(cx, reg.backY - 6, h + 46).y - 10 * f;
    const anchor = this.toScreen(cx, reg.backY - 6, h + 66);
    const x = anchor.x - W / 2;
    const y = anchor.y - bodyH;

    // short mount pole from the number sign up to the board
    ctx.strokeStyle = "#586277"; ctx.lineWidth = Math.max(1, 2 * f);
    ctx.beginPath(); ctx.moveTo(anchor.x, signTop); ctx.lineTo(anchor.x, y + bodyH); ctx.stroke();

    // panel
    ctx.save();
    ctx.shadowColor = scanning ? "rgba(94,234,212,0.5)" : "rgba(34,211,238,0.2)";
    ctx.shadowBlur = (scanning ? 13 : 6) * f;
    ctx.fillStyle = "rgba(9,16,30,0.97)";
    this.roundRect(x, y, W, bodyH, 5 * f); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = scanning ? "rgba(94,234,212,0.7)" : "rgba(94,234,212,0.28)";
    ctx.lineWidth = Math.max(0.75, 1 * f);
    this.roundRect(x, y, W, bodyH, 5 * f); ctx.stroke();

    const padX = 5 * f;

    // header
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#7fe9d6";
    ctx.font = "700 " + px(6.5) + " Inter, system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("KASA " + String(register.id).padStart(2, "0"), x + padX, y + headerH / 2 + 1);
    if (c) {
      ctx.textAlign = "right";
      ctx.fillStyle = "rgba(180,230,220,0.8)";
      ctx.font = "600 " + px(6) + " Inter, system-ui, sans-serif";
      ctx.fillText(`${c.scannedItems || 0}/${c.basketItems || 0}`, x + W - padX, y + headerH / 2 + 1);
    }
    ctx.strokeStyle = "rgba(94,234,212,0.2)"; ctx.lineWidth = Math.max(0.75, 1 * f);
    ctx.beginPath(); ctx.moveTo(x + 4 * f, y + headerH); ctx.lineTo(x + W - 4 * f, y + headerH); ctx.stroke();

    let ry = y + headerH + 2 * f;
    if (!c) {
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(140,170,190,0.5)";
      ctx.font = "600 " + px(6.5) + " Inter, system-ui, sans-serif";
      ctx.fillText("HAZIR", x + W / 2, ry + rowH / 2 + 1);
    } else if (lines.length === 0) {
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(150,180,200,0.55)";
      ctx.font = "500 " + px(6) + " Inter, system-ui, sans-serif";
      ctx.fillText("Okutuluyor…", x + W / 2, ry + rowH / 2 + 1);
    } else {
      const start = Math.max(0, lines.length - shownRows);
      for (let i = start; i < lines.length; i++) {
        const ln = lines[i];
        const isLast = i === lines.length - 1;
        ctx.textAlign = "left";
        ctx.fillStyle = isLast && scanning ? "#eafff9" : "rgba(212,226,236,0.85)";
        ctx.font = (isLast ? "700 " : "500 ") + px(6) + " Inter, system-ui, sans-serif";
        ctx.fillText(this._clip(ln.name, 9), x + padX, ry + rowH / 2);
        ctx.textAlign = "right";
        ctx.fillStyle = isLast && scanning ? "#7CF0C0" : "rgba(160,220,205,0.82)";
        ctx.fillText(this._fmtPrice(ln.price), x + W - padX, ry + rowH / 2);
        ry += rowH;
      }
    }

    // total block (stacked label + big value, centered)
    const ty = y + bodyH - totalH;
    ctx.fillStyle = "rgba(34,211,238,0.10)";
    this.roundRect(x + 3 * f, ty + 1 * f, W - 6 * f, totalH - 3 * f, 3 * f); ctx.fill();
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(170,215,205,0.75)";
    ctx.font = "600 " + px(5.5) + " Inter, system-ui, sans-serif";
    ctx.fillText("TOPLAM", x + W / 2, ty + 6 * f);
    ctx.fillStyle = "#7CF0C0";
    ctx.font = "800 " + px(9) + " Inter, system-ui, sans-serif";
    const total = register.subtotal || (c ? c.runningTotal : 0) || 0;
    ctx.fillText(this._curSym(sim) + this._fmtPrice(total), x + W / 2, ty + 14 * f);
    ctx.restore();
  }

  _clip(s, n) { s = s || ""; return s.length > n ? s.slice(0, n - 1) + "…" : s; }
  _fmtPrice(v) { return Number(v || 0).toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  _curSym(sim) {
    const c = (sim && sim._currency) ? sim._currency : "₺";
    const m = { USD: "$", EUR: "€", GBP: "£", TRY: "₺" };
    return m[c] || c;
  }

  _drawBeltItems(register, cx, halfW, h, beltBackY, beltFrontY, sim) {
    const c = register.currentCustomer;
    if (!c) return;
    const active = register.state === REGISTER_STATE.UNLOADING || register.state === REGISTER_STATE.SCANNING;
    if (!active) return;
    const remaining = Math.max(0, c.basketItems - c.scannedItems);
    const shown = Math.min(remaining, 7);
    const ctx = this.ctx;
    const palette = ["#e0574e", "#4f6bed", "#2fa27a", "#e6a23c", "#7c5cd6", "#d65a9a", "#2c8fb3"];
    const anim = (sim.time * 0.6) % 1;
    for (let i = 0; i < shown; i++) {
      const t = (i + anim) / 7; // 0 (near register/scanner) .. 1 (customer side)
      const wx = cx + halfW - 30 - t * (reg2span(halfW));
      const wy = (beltBackY + beltFrontY) / 2;
      const p = this.toScreen(wx, wy, h + 4);
      ctx.fillStyle = palette[(c.id + i) % palette.length];
      this.roundRect(p.x - 4, p.y - 6, 8, 7, 1.5); ctx.fill();
      ctx.fillStyle = "rgba(0,0,0,0.15)";
      this.roundRect(p.x - 4, p.y - 6, 8, 2, 1); ctx.fill();
    }
    function reg2span(hw) { return hw * 2 - 44; }
  }

  _drawCustomer(c, sim) {
    const st = c.state;
    let carry = null;
    if (st === CUSTOMER_STATE.APPROACHING || st === CUSTOMER_STATE.WAITING) carry = c.appearance.carry;
    drawPerson(this, c.pos.x, c.pos.y, c.appearance, {
      facing: c.facing,
      moving: c.moving,
      walkPhase: c.animPhase,
      armAction: null,
      carry,
    });
    if (st === CUSTOMER_STATE.WAITING) this._drawWaitTimer(c, sim);
  }

  /**
   * Seconds-in-queue badge above a waiting shopper's head. This is the whole
   * point of the demo made visible per person: on the slow path the numbers
   * climb, and they collapse once the query is rewritten.
   */
  _drawWaitTimer(c, sim) {
    if (!sim || typeof sim.time !== "number" || c.joinedQueueAt == null) return;
    const secs = sim.time - c.joinedQueueAt;
    if (secs < 0.5) return;                    // avoid a flash of "0s" on arrival

    const ctx = this.ctx;
    // Sits just above the head. drawPerson stacks legs(15) + torso(18) + head,
    // all scaled by heightScale, so ~52 clears the crown with a small gap.
    const hs = c.appearance.heightScale || 1;
    const p = this.toScreen(c.pos.x, c.pos.y, 58 * hs); // clears the taller badge
    const label = secs >= 60
      ? `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, "0")}`
      : `${Math.floor(secs)}s`;

    // Colour ramps with the wait so a long queue reads at a glance.
    const color = secs >= 45 ? "#fb5c6c" : secs >= 20 ? "#fbbf24" : "#5eead4";
    const fs = Math.max(13.6, 17 * this.scale);   // 1.7x the original 10px
    ctx.save();
    ctx.font = `700 ${fs}px ui-monospace, SFMono-Regular, Consolas, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const w = Math.max(ctx.measureText(label).width + 12 * this.scale, 26 * this.scale);
    const h = fs + 8 * this.scale;
    ctx.fillStyle = "rgba(6,12,24,0.82)";
    this.roundRect(p.x - w / 2, p.y - h / 2, w, h, 3 * this.scale);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.fillText(label, p.x, p.y);
    ctx.restore();
  }

  _drawSelection(register) {
    const ctx = this.ctx;
    const reg = register.reg;
    const cx = reg.cx, halfW = reg.w / 2;
    const p = this.toScreen(cx, reg.frontY + 6, 0);
    ctx.save();
    ctx.shadowColor = "rgba(34,211,238,0.8)"; ctx.shadowBlur = 14;
    ctx.strokeStyle = "rgba(94,234,212,0.95)"; ctx.lineWidth = 2.2;
    const w = (halfW + 26) * this.scale * 2;
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, w / 2, w / 5, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  _lerp(a, b, t) { return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; }

  /** Returns the register id under a CSS pixel, or null. */
  pickRegister(cssX, cssY, sim) {
    for (const hit of this._cashierHits || []) {
      if (cssX >= hit.x && cssX <= hit.x + hit.width && cssY >= hit.y && cssY <= hit.y + hit.height) return hit.id;
    }
    let best = null, bestD = 46;
    for (const reg of sim.world.registers) {
      const p = this.toScreen(reg.cx, (reg.backY + reg.frontY) / 2, reg.h * 0.5);
      const d = Math.hypot(cssX - p.x, cssY - p.y);
      if (d < bestD) { bestD = d; best = reg.id; }
    }
    return best;
  }
}
