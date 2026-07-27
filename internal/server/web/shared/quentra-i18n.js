// quentra-i18n.js
// Shared, dependency-free language picker + animated intro overlay and a tiny
// i18n runtime used by every Quentra simulation page.
//
// Flow: on load an overlay shows the project intro (title / purpose) with a
// TR|EN language toggle. Picking a language re-animates the text; pressing the
// "Enter" button persists the choice (localStorage), translates the static DOM
// (any [data-i18n*] elements) and calls config.onReady(lang, t) so the app can
// boot in the chosen language. A small floating switch lets users change the
// language afterwards; apps can listen for the "quentra:langchange" event to
// re-render dynamic (feed/log) strings.
//
// Usage:
//   import { initQuentraApp } from "/shared/quentra-i18n.js";
//   initQuentraApp({
//     appId: "retail",
//     accent: "#7c3aed",
//     brand: { name: "Quentra Retail", sub: "Checkout Simulation", logo: "/assets/quentra-logo.png" },
//     intro: {
//       tr: { eyebrow, title, tagline, purpose: [..], cta },
//       en: { eyebrow, title, tagline, purpose: [..], cta },
//     },
//     dict: { tr: { key: "..." }, en: { key: "..." } },
//     onReady(lang, t) { /* boot the app */ },
//   });

const LANG_KEY = "quentra_lang";
const SUPPORTED = ["tr", "en"];

const LANG_META = {
  tr: { flag: "\u{1F1F9}\u{1F1F7}", label: "Türkçe" },
  en: { flag: "\u{1F1EC}\u{1F1E7}", label: "English" },
};

function detectLang() {
  const stored = localStorage.getItem(LANG_KEY);
  if (SUPPORTED.includes(stored)) return stored;
  const nav = (navigator.language || navigator.userLanguage || "en").toLowerCase();
  return nav.startsWith("tr") ? "tr" : "en";
}

/** Global runtime handle, also exposed as window.QuentraI18n. */
export const QuentraI18n = {
  lang: "en",
  dict: { tr: {}, en: {} },
  _listeners: new Set(),
  t(key, fallback) {
    const d = this.dict[this.lang] || {};
    if (key in d) return d[key];
    return fallback !== undefined ? fallback : key;
  },
  getLang() { return this.lang; },
  setLang(lang) {
    if (!SUPPORTED.includes(lang) || lang === this.lang) return;
    this.lang = lang;
    localStorage.setItem(LANG_KEY, lang);
    document.documentElement.setAttribute("lang", lang);
    applyTranslations(this);
    updateSwitch(this);
    this._emit();
  },
  onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); },
  _emit() {
    const detail = { lang: this.lang };
    for (const fn of this._listeners) { try { fn(this.lang); } catch (e) { /* ignore */ } }
    window.dispatchEvent(new CustomEvent("quentra:langchange", { detail }));
  },
};

/** Translate every [data-i18n*] element currently in the document. */
export function applyTranslations(state) {
  const d = state.dict[state.lang] || {};
  const get = (k) => (k in d ? d[k] : null);

  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const v = get(el.getAttribute("data-i18n"));
    if (v != null) el.textContent = v;
  });
  document.querySelectorAll("[data-i18n-html]").forEach((el) => {
    const v = get(el.getAttribute("data-i18n-html"));
    if (v != null) el.innerHTML = v;
  });
  // data-i18n-attr="placeholder:key;title:key2"
  document.querySelectorAll("[data-i18n-attr]").forEach((el) => {
    el.getAttribute("data-i18n-attr").split(";").forEach((pair) => {
      const [attr, key] = pair.split(":").map((s) => s && s.trim());
      if (!attr || !key) return;
      const v = get(key);
      if (v != null) el.setAttribute(attr, v);
    });
  });
}

function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}

function buildBrand(brand) {
  const wrap = el("div", "qi-brand");
  if (brand && brand.logo) {
    const img = el("img");
    img.src = brand.logo;
    img.alt = (brand && brand.name) || "Quentra";
    img.onerror = () => { img.replaceWith(el("div", "qi-brand-mark", "Q")); };
    wrap.appendChild(img);
  } else {
    wrap.appendChild(el("div", "qi-brand-mark", "Q"));
  }
  if (brand && (brand.name || brand.sub)) {
    wrap.appendChild(el("div", "qi-brand-name",
      `${brand.name || ""}${brand.sub ? `<small>${brand.sub}</small>` : ""}`));
  }
  return wrap;
}

function renderIntro(state, contentEl) {
  const intro = (state.config.intro && state.config.intro[state.lang]) || {};
  contentEl.innerHTML = "";
  if (intro.eyebrow) contentEl.appendChild(el("p", "qi-eyebrow", intro.eyebrow));
  contentEl.appendChild(el("h1", "qi-title", intro.title || ""));
  if (intro.tagline) contentEl.appendChild(el("p", "qi-tagline", intro.tagline));
  const ul = el("ul", "qi-purpose");
  (intro.purpose || []).forEach((line) => ul.appendChild(el("li", null, line)));
  contentEl.appendChild(ul);
  // re-trigger the staggered animation
  contentEl.classList.remove("qi-animate");
  void contentEl.offsetWidth;
  contentEl.classList.add("qi-animate");
}

function ctaLabel(state) {
  const intro = (state.config.intro && state.config.intro[state.lang]) || {};
  if (intro.cta) return intro.cta;
  return state.lang === "tr" ? "Simülasyonu Başlat" : "Launch Simulation";
}

function buildOverlay(state, onEnter) {
  const overlay = el("div", "qi-overlay");
  const card = el("div", "qi-card");

  card.appendChild(buildBrand(state.config.brand));

  // language pills
  const langs = el("div", "qi-langs");
  langs.setAttribute("role", "group");
  SUPPORTED.forEach((lang) => {
    const b = el("button", "qi-lang" + (lang === state.lang ? " is-active" : ""),
      `<span class="qi-flag">${LANG_META[lang].flag}</span>${LANG_META[lang].label}`);
    b.type = "button";
    b.dataset.lang = lang;
    b.addEventListener("click", () => {
      if (state.lang === lang) return;
      state.lang = lang;
      document.documentElement.setAttribute("lang", lang);
      langs.querySelectorAll(".qi-lang").forEach((x) =>
        x.classList.toggle("is-active", x.dataset.lang === lang));
      renderIntro(state, content);
      enterBtn.innerHTML = enterHTML(state);
    });
    langs.appendChild(b);
  });
  card.appendChild(langs);

  const content = el("div", "qi-content");
  card.appendChild(content);

  const actions = el("div", "qi-actions");
  const enterBtn = el("button", "qi-enter", enterHTML(state));
  enterBtn.type = "button";
  enterBtn.addEventListener("click", () => {
    overlay.classList.add("qi-hiding");
    setTimeout(() => overlay.remove(), 520);
    onEnter();
  });
  actions.appendChild(enterBtn);
  card.appendChild(actions);

  overlay.appendChild(card);
  document.body.appendChild(overlay);

  renderIntro(state, content);
}

function enterHTML(state) {
  return `<span>${ctaLabel(state)}</span>` +
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M13 6l6 6-6 6"/></svg>`;
}

// ---------------------------------------------------- floating switch ---
function mountSwitch(state) {
  let sw = document.querySelector(".qi-switch");
  if (sw) return;
  sw = el("div", "qi-switch");
  sw.setAttribute("aria-label", "Language");
  SUPPORTED.forEach((lang) => {
    const b = el("button", state.lang === lang ? "is-active" : null, lang.toUpperCase());
    b.type = "button";
    b.dataset.lang = lang;
    b.addEventListener("click", () => QuentraI18n.setLang(lang));
    sw.appendChild(b);
  });
  document.body.appendChild(sw);
}

function updateSwitch(state) {
  const sw = document.querySelector(".qi-switch");
  if (!sw) return;
  sw.querySelectorAll("button").forEach((b) =>
    b.classList.toggle("is-active", b.dataset.lang === state.lang));
}

/** Entry point. */
export function initQuentraApp(config) {
  const state = QuentraI18n;
  state.config = config || {};
  state.dict = config.dict || { tr: {}, en: {} };
  state.lang = detectLang();
  document.documentElement.setAttribute("lang", state.lang);

  if (config.accent) document.documentElement.style.setProperty("--qi-accent", config.accent);
  if (config.accent2) document.documentElement.style.setProperty("--qi-accent-2", config.accent2);

  const start = () => buildOverlay(state, () => {
    localStorage.setItem(LANG_KEY, state.lang);
    applyTranslations(state);
    mountSwitch(state);
    if (typeof config.onReady === "function") config.onReady(state.lang, state.t.bind(state));
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
}

window.QuentraI18n = QuentraI18n;
