// cashier.js
// A cashier standing behind a register, back to the camera. Reuses drawPerson.

import { drawPerson } from "./customer.js";

const UNIFORM = "#4338ca"; // Quentra navy uniform
const CASHIER_NAMES = [
  "Ayşe Kaya", "Mehmet Demir", "Elif Yılmaz", "Can Arslan",
  "Zeynep Çetin", "Emre Koç", "Selin Aydın", "Burak Şahin",
  "Derya Öz", "Mert Aksoy", "İrem Kaplan", "Okan Yıldız",
  "Ece Polat", "Kerem Güneş", "Seda Kılıç", "Tolga Aslan",
];

export class Cashier {
  constructor(register) {
    this.register = register;
    this.name = CASHIER_NAMES[(Math.max(1, register.id) - 1) % CASHIER_NAMES.length];
    this.pos = { x: register.cashier.x, y: register.cashier.y };
    this.appearance = {
      skin: pick(["#f2c9a4", "#e8b48c", "#c88f66", "#a56a44"]),
      hair: pick(["#2b2118", "#111318", "#6b4a2b", "#4a3423"]),
      hairStyle: pick(["short", "buzz", "bun"]),
      shirt: UNIFORM,
      pants: "#26304a",
      heightScale: 1.02,
      carry: null,
    };
    this.phase = Math.random() * Math.PI * 2;
    this.active = false; // scanning?
  }

  update(dt, scanning) {
    this.active = scanning;
    if (scanning) this.phase += dt * 9;
  }

  draw(r) {
    drawPerson(r, this.pos.x, this.pos.y, this.appearance, {
      facing: "up",
      moving: false,
      walkPhase: this.phase,
      armAction: this.active ? "scan" : null,
      carry: null,
    });
  }

  get depth() { return this.pos.y; }
}

function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
