// worker.js
// A visual factory worker: appearance, an access-control state machine and
// waypoint-based movement. Purely cosmetic demo entities — never persisted.

export const WORKER_STATE = {
  ARRIVING: "ARRIVING",
  SELECTING_GATE: "SELECTING_GATE",
  WALKING_TO_QUEUE: "WALKING_TO_QUEUE",
  WAITING_IN_QUEUE: "WAITING_IN_QUEUE",
  APPROACHING_READER: "APPROACHING_READER",
  PRESENTING_CARD: "PRESENTING_CARD",
  CARD_READ: "CARD_READ",
  CHECKING_LAST_MOVEMENT: "CHECKING_LAST_MOVEMENT",
  ENTRY_APPROVED: "ENTRY_APPROVED",
  ACCESS_DENIED: "ACCESS_DENIED",
  MANUAL_REVIEW: "MANUAL_REVIEW",
  GATE_OPENING: "GATE_OPENING",
  PASSING_GATE: "PASSING_GATE",
  WALKING_INSIDE: "WALKING_INSIDE",
  WALKING_OUT: "WALKING_OUT",
  COMPLETED: "COMPLETED",
};

const SKINS = ["#f2c9a6", "#e5b18a", "#d29b6e", "#b87a4d", "#8a5a34", "#63402a"];
const HAIRS = ["#2a2320", "#3a2a1c", "#5a3b22", "#7a5230", "#9a7a4a", "#1c1c22", "#6a6a72"];
const HAIR_STYLES = ["short", "buzz", "bun", "long", "cap", "bald"];

// Department presets drive uniform colours + accessories so departments read
// clearly on the floor without changing character rendering rules.
const DEPARTMENTS = [
  { name: "PRODUCTION", shirt: "#f4801f", pants: "#2b3446", vest: true, helmet: 0.7, backpack: 0.05 },
  { name: "MAINTENANCE", shirt: "#1f5fa8", pants: "#1b2432", vest: false, helmet: 0.85, backpack: 0.1 },
  { name: "LOGISTICS", shirt: "#f2c200", pants: "#33383f", vest: true, helmet: 0.25, backpack: 0.5 },
  { name: "TECHNICAL", shirt: "#4a5568", pants: "#2a2f3a", vest: false, helmet: 0.3, backpack: 0.3 },
  { name: "QUALITY", shirt: "#2f855a", pants: "#2a2f3a", vest: false, helmet: 0.1, backpack: 0.15 },
  { name: "OFFICE", shirt: "#5b6bd6", pants: "#2c3350", vest: false, helmet: 0, backpack: 0.35 },
  { name: "DATABASE OPERATIONS", shirt: "#6d5efc", pants: "#2a2f4a", vest: false, helmet: 0, backpack: 0.4 },
  { name: "SECURITY", shirt: "#3a4252", pants: "#22262f", vest: false, helmet: 0, backpack: 0.05 },
];

const FIRST_NAMES = [
  "ÖMER", "ELİF", "MEHMET", "ZEYNEP", "AHMET", "AYŞE", "MURAT", "FATMA",
  "CAN", "SELİN", "EMRE", "BURAK", "DENİZ", "MERVE", "KAAN", "SEDA",
  "TOLGA", "GİZEM", "ONUR", "İREM", "SERKAN", "EBRU", "VOLKAN", "PINAR",
];
const LAST_NAMES = [
  "ÇOLAKOĞLU", "YILMAZ", "KAYA", "DEMİR", "ŞAHİN", "ÇELİK", "YILDIZ",
  "AYDIN", "ÖZTÜRK", "ARSLAN", "DOĞAN", "KILIÇ", "ASLAN", "ÇETİN", "KURT",
];

let SEQ = 1000;
function pick(a) { return a[(Math.random() * a.length) | 0]; }

function makeAppearance() {
  const dept = pick(DEPARTMENTS);
  const helmet = Math.random() < dept.helmet;
  const backpack = Math.random() < dept.backpack;
  return {
    skin: pick(SKINS),
    hair: pick(HAIRS),
    hairStyle: helmet ? "cap" : pick(HAIR_STYLES),
    shirt: dept.shirt,
    pants: dept.pants,
    heightScale: 0.9 + Math.random() * 0.28,
    hasHelmet: helmet,
    hasVest: dept.vest,
    hasBackpack: backpack,
  };
}

const BASE_SPEED = 82; // world units / second

export class Worker {
  constructor() {
    const dept = pick(DEPARTMENTS);
    SEQ += 1 + ((Math.random() * 6) | 0);
    this.id = "W" + SEQ;
    this.employeeId = "EMP-" + (10000 + SEQ);
    this.displayName = pick(FIRST_NAMES) + " " + pick(LAST_NAMES);
    this.department = dept.name;
    this.appearance = { ...makeAppearance(), shirt: dept.shirt, pants: dept.pants };
    this.appearance.hasVest = dept.vest;

    this.pos = { x: 0, y: 0 };
    this.waypoints = [];
    this.wpIndex = 0;
    this.moving = false;
    this.arrived = false;
    this.facing = "up";
    this.speed = BASE_SPEED * (0.9 + Math.random() * 0.2);
    this.walkPhase = Math.random() * Math.PI * 2;

    this.state = WORKER_STATE.ARRIVING;
    this.turnstileId = null;
    this.queueIndex = -1;

    // Access-check payload (assigned when the card is read).
    this.check = null;          // result object from the data source
    this.checkElapsed = 0;      // live seconds spent in CHECKING_LAST_MOVEMENT
    this.stateTimer = 0;        // generic timer for short states
    this.idleTimer = Math.random() * 2; // impatience animation phase
    this.impatient = false;

    this.highlight = false;
  }

  setPath(waypoints) {
    this.waypoints = waypoints;
    this.wpIndex = 0;
    this.arrived = false;
    this.moving = waypoints.length > 0;
  }

  goTo(point) { this.setPath([{ x: point.x, y: point.y }]); }

  get depth() { return this.pos.y; }

  // Advance along the current waypoint list. Returns true when it just arrived.
  step(dt) {
    if (this.moving) this.walkPhase += dt * this.speed * 0.05;
    if (this.wpIndex >= this.waypoints.length) { this.moving = false; return false; }

    const t = this.waypoints[this.wpIndex];
    const dx = t.x - this.pos.x;
    const dy = t.y - this.pos.y;
    const dist = Math.hypot(dx, dy);
    const stepLen = this.speed * dt;

    if (dist <= stepLen || dist < 0.4) {
      this.pos.x = t.x;
      this.pos.y = t.y;
      this.wpIndex++;
      if (this.wpIndex >= this.waypoints.length) {
        this.moving = false;
        this.arrived = true;
        return true;
      }
      return false;
    }
    this.pos.x += (dx / dist) * stepLen;
    this.pos.y += (dy / dist) * stepLen;
    this.moving = true;
    this.facing = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up");
    return false;
  }

  // Pose consumed by drawPerson in the renderer.
  pose() {
    let facing = this.facing;
    let armAction = null;
    // While presenting the card / being checked, reach toward the reader.
    if (
      this.state === WORKER_STATE.PRESENTING_CARD ||
      this.state === WORKER_STATE.CARD_READ ||
      this.state === WORKER_STATE.CHECKING_LAST_MOVEMENT
    ) {
      facing = "up";
      armAction = "scan";
    }
    return {
      facing,
      moving: this.moving,
      walkPhase: this.walkPhase,
      armAction,
      carry: null,
    };
  }
}
