// main.js
// Bootstraps the shared Quentra i18n language-picker overlay for the classic
// checkout control panel, then hands off to the existing classic /app.js
// bootstrap (window.CheckoutClassicApp.start), which renders/wires the panel
// using window.QuentraI18n.t(...) for all dynamic strings.

import { initQuentraApp } from "/shared/quentra-i18n.js";
import { CHECKOUT_CLASSIC_INTRO, CHECKOUT_CLASSIC_DICT } from "./i18n.js";

initQuentraApp({
  appId: "checkout-classic",
  accent: "#2563eb",
  accent2: "#f59e0b",
  brand: { name: "Quentra Checkout", sub: "Classic Control Panel", logo: "/assets/quentra-logo.jpeg" },
  intro: CHECKOUT_CLASSIC_INTRO,
  dict: CHECKOUT_CLASSIC_DICT,
  onReady: () => {
    if (window.CheckoutClassicApp && typeof window.CheckoutClassicApp.start === "function") {
      window.CheckoutClassicApp.start();
    }
  },
});
