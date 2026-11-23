// Invite links: the owner's "Invite a cashier" gives a link such as
// https://cashier.rapidewms.workers.dev/#join=ABCD2345 to send on WhatsApp.
// Opening it keeps the code on this device (it must outlive the sign-up email
// round trip), and the app joins the shop with it as soon as someone is
// signed in (main.js enter()). A code works once, for 24 hours (005).
import { CASHIER_URL, MANAGER_URL } from "../data/state.js";

const KEY = "rapidewms.join";
const DAY_MS = 864e5;

function save(code) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ code, at: Date.now() }));
  } catch {
    // storage blocked: the code can still be typed by hand
  }
}

/** The code from an invite link this device opened in the last day, or null. */
export function pendingJoin() {
  try {
    const j = JSON.parse(localStorage.getItem(KEY) || "null");
    return j && Date.now() - j.at < DAY_MS && /^[A-Z0-9]{8}$/.test(j.code) ? j.code : null;
  } catch {
    return null;
  }
}

export function clearJoin() {
  try {
    localStorage.removeItem(KEY);
  } catch {}
}

/** The link to send: the cashier site for a cashier, the manager site for a manager. */
export const inviteLink = (code, role) => (role == "cashier" ? CASHIER_URL : MANAGER_URL) + "#join=" + code;

// Read when this module loads, before the app picks a screen from the address:
// #join=ABCD-2345 → kept, and the address goes back to plain.
if (typeof location != "undefined") {
  const m = /^#join=([A-Za-z0-9-]{8,12})$/.exec(location.hash);
  if (m) {
    save(m[1].replace(/-/g, "").toUpperCase());
    history.replaceState(null, "", location.pathname + location.search);
  }
}
