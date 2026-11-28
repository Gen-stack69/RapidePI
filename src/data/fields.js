// Form values -> table rows, shared by both backends (remote.js, local.js).
import { err } from "../i18n/index.js";
import { kipPer } from "../lib/rates.js";

const fail = (code, params) => {
  throw err(code, params);
};

/** Rows of a product import that can be added: not a SKU the shop has, and
 * not a barcode (or code) already on a product or a box, here or earlier in
 * the file (025: one barcode, one product). The rest count as skipped. */
export function importable(list, items, packs) {
  const key = (v) => String(v ?? "").trim().toLowerCase(),
    skus = new Set(items.map((i) => key(i.sku))),
    codes = new Set([...items.flatMap((i) => [i.barcode, i.sku]), ...packs.map((p) => p.barcode)].filter(Boolean).map(key));
  return list.filter((x) => {
    const sku = key(x.sku),
      code = key(x.barcode || x.sku);
    if (!sku || skus.has(sku) || codes.has(code)) return false;
    skus.add(sku);
    codes.add(code).add(sku);
    return true;
  });
}

// Why stock left (025): the codes the database takes for each. A write-off
// uses the "remove" ones. "other" needs words.
export const REASONS = {
  remove: ["damaged", "expired", "theft", "own_use", "count", "returned", "other"],
  void: ["wrong_item", "changed_mind", "duplicate", "other"],
};
/** A reason { code, text } checked as use_reason() does, or it throws. */
export function checkReason(kind, r) {
  const code = String(r?.code || "").trim(),
    text = String(r?.text || "").trim().slice(0, 200);
  if (!REASONS[kind].includes(code) || (code == "other" && !text)) fail("err.needReason");
  return { code, text: text || null };
}

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
