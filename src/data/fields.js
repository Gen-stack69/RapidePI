// Form values -> table rows, shared by both backends (remote.js, local.js).
import { err } from "../i18n/index.js";
import { kipPer } from "../lib/rates.js";

const fail = (code, params) => {
  throw err(code, params);
};

/** A typed amount as a number of 0 or more. "1e999" is Infinity in JavaScript,
 * which the database refuses (008_hardening.sql), so it counts as 0 like any
 * other unreadable entry. */
export const amount = (v) => {
  const n = +v;
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** Prices and cost belong to the owner (008_hardening.sql). Staff editing a
 * product send none of them, so the database never sees them try. */
export const PRICE_KEYS = ["price", "price_wholesale", "wholesale_min_qty", "cost", "cost_orig", "cost_currency"];
export function keepOwnerPrices(row, id, owner) {
  if (id && !owner) for (const k of PRICE_KEYS) delete row[k];
  return row;
}

/** The product form's unit and cost. A cost typed in THB, USD or CNY is
 * stored in Kip at today's internet rate; what was typed is kept beside it. */
export function costFields(f) {
  const cur = ["THB", "USD", "CNY"].includes(f.cost_currency) ? f.cost_currency : "LAK",
    typed = amount(f.cost),
    rate = kipPer(cur);
  if (cur != "LAK" && !(rate > 0)) fail("err.noRate", { cur });
  return {
    unit: String(f.unit || "").trim().slice(0, 20),
    cost_currency: cur,
    cost_orig: cur == "LAK" ? null : typed,
    cost: Math.round(typed * rate * 100) / 100,
  };
}
/** A pack form ({ name, size, barcode, price }). An empty size means "count
 * later" (010_receive_packs.sql): size null, and then no price either. */
export function packRow(f) {
  const name = String(f.name || "").trim().slice(0, 30),
    blank = f.size == null || String(f.size).trim() == "",
    size = blank ? null : +f.size,
    price = amount(f.price);
  if (!name) fail("err.packName");
  if (!blank && !(size > 1 && Number.isFinite(size))) fail("err.packSize");
  if (blank && price > 0) fail("err.packCountFirst");
  return { name, size, barcode: String(f.barcode || "").trim() || null, price };
}

/** Boxes of a pack still waiting to be counted (size null), from the copy in hand. */
export const waitingBoxes = (receipts, packId) =>
  (receipts || []).filter((r) => r.pack_id == packId && r.size == null).reduce((a, r) => a + +r.boxes, 0);
