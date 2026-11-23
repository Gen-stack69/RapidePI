import { $, E, toast, form, dateText, expiryNote, checkExpiry, batchField } from "./lib/util.js";
import { t, errText } from "./i18n/index.js";
import * as store from "./data/store.js";
import { state, cashierUi } from "./data/store.js";
import * as camera from "./lib/camera.js";
import { lookupCode, parseTyped, status } from "./lib/expiry.js";

let last = "",
  lt = 0,
  expFor = null; // the product the date in the scanner's expiry box was entered for

export const active = camera.active;

/**
 * Camera on or off in the #rd box of the current screen. `handler` gets each
 * code. `opts.single` reads one aimed code at a time (the till); see camera.js.
 */
export async function cam(on, handler = onScan, opts = {}) {
  await camera.stop();
  if (!on) return;
  const host = $("#rd");
  if (!host) return;
  try {
    await camera.start(host, handler, opts);
  } catch {
    host.innerHTML = "";
    toast(t("scan.blocked"), true);
  }
}

const log = (h) => $("#res")?.insertAdjacentHTML("afterbegin", `<p style="margin-bottom:8px">${h}</p>`);

// The soonest date on the shelf for a product, for look-ups and results.
export function nextExpiry(itemId) {
  return state.lots.find((l) => l.item_id == itemId)?.expiry || null;
}
const expTag = (iso) =>
  iso ? ` · <span class="${status(iso) == "ok" ? "mut" : "warn"}">${t("exp.short")} ${dateText(iso)}${expiryNote(iso)}</span>` : "";

// "31/12/2027" — the form an expiry box shows a date in, and reads back.
export const typedDate = (iso) => (iso ? iso.split("-").reverse().join("/") : "");

/** Ask for the expiry date and batch no. of stock being received.
 * { expiry, batch }, or null = don't receive. */
export async function askReceive(it, date = "", batch = "") {
  const f = await form(
    t("scan.expTitle", { name: it.name }),
    [
      {
        k: "expiry",
        type: "expiry",
        label: t("f.expiry"),
        value: date,
        tools: [{ act: "readDate", label: t("btn.readDate") }],
        hint: t("scan.expHint"),
      },
      { ...batchField(), value: batch },
    ],
    t("scan.expOk"),
  );
  return f ? { expiry: f.expiry || null, batch: f.batch?.trim() || "" } : null;
}

/** What a new product made from the scanner starts with: in Receive mode, the
 * date printed in the code, else the boxes when they were typed for the next
 * product (not left over from another one). Look up / Remove: nothing. */
export function receiveStart(printed = "") {
  if ($("#mode")?.value != "in") return null;
  const fresh = !expFor;
  return {
    expiry: typedDate(printed) || (fresh ? $("#sexp")?.value || "" : ""),
    batch: fresh ? $("#sbatch")?.value.trim() || "" : "",
  };
}

/** The scan log's batch button: "Batch L100 ✎", or "Add batch no." */
export const batchLabel = (b) => (b ? `${t("exp.batchShort")} ${b} ✎` : t("exp.addBatch"));

// "QR" or "Barcode EAN-13" in front of a result, when the camera read it.
const kindTag = (format) =>
  format ? `<span class="tag">${camera.isQr(format) ? t("scan.qr") : t("scan.barcode", { f: camera.formatName(format) })}</span> ` : "";

// Scans are handled one at a time, in the order they were read. The camera can
// read several codes in one frame, and receiving a consumable stops to ask for
// its expiry date; codes read meanwhile used to be dropped without a word
// (3 cans scanned, 1 received). Now they wait here until the dialog closes.
let queue = Promise.resolve(),
  pending = 0; // scans read but not yet handled, including the one in progress
const dialogClosed = () =>
  new Promise((res) => {
    const d = $("#dlg");
    if (!d?.open) return res();
    d.addEventListener("close", () => setTimeout(res), { once: true });
  });

export function onScan(c, format) {
  c = String(c).trim();
  const n = Date.now();
  if (!c || (c == last && n - lt < 2500)) return queue;
  last = c;
  lt = n;
  navigator.vibrate?.(90);
  // Say so when a code has to wait behind another one or behind an open
  // dialog, so nobody scans it a second time.
  if (pending || $("#dlg").open) log(`<span class="mut">${t("scan.waiting", { code: `<b>${E(c)}</b>` })}</span>`);
  pending++;
  queue = queue
    .then(async () => {
      // Wait until no dialog is open, including one opened by the previous scan.
      while ($("#dlg").open) await dialogClosed();
      await handle(c, format);
    })
    .catch(() => {})
    .finally(() => pending--);
  return queue;
}

// ---------- boxes ----------
//
// Stock is counted in single units; a box is a pack of its product (packs).
// A box's own barcode always means the box. The single item's barcode is
// ambiguous when one of its boxes has no barcode or carries the same one, so
// the scanner asks once per product, "single or which box?", and keeps the
// answer for the rest of the delivery. #su can also say "always singles" or
// "always boxes".
let chosen = new Map(); // product id -> pack id, or "" for single units
// "auto" | "unit" | "box", kept here so a redraw of the screen keeps it.
export const scanUi = { unit: "auto" };
export function unitModeChanged() {
  scanUi.unit = $("#su")?.value || "auto";
  chosen = new Map();
}

const packsOf = (it) => state.packs.filter((p) => p.item_id == it.id);
const packLabel = (p) => `${p.name} × ${p.size == null ? "?" : +p.size}`;

/** The pack this scan counts in: a pack, null for single units, undefined when
 * the person cancelled. */
async function pickPack(it, pack, code) {
  if (pack) return pack;
  const packs = packsOf(it),
    how = scanUi.unit;
  if (!packs.length || how == "unit") return null;
  if (how == "auto") {
    const unitCode = String(it.barcode || "").trim(),
      unclear = packs.some((p) => !p.barcode || String(p.barcode).trim() == unitCode || String(p.barcode).trim() == code);
    if (!unclear) return null;
  } else if (packs.length == 1) return packs[0];
  if (chosen.has(it.id)) return packs.find((p) => p.id == chosen.get(it.id)) || null;
  const f = await form(
    t("scan.whichTitle", { name: it.name }),
    [
      {
        k: "pack",
        label: t("scan.whichLabel"),
        type: "select",
        value: how == "box" ? packs[0].id : "",
        options: [
          ...(how == "box" ? [] : [["", t("scan.single", { unit: it.unit || t("f.unitWord") })]]),
          ...packs.map((p) => [p.id, packLabel(p)]),
        ],
        hint: t("scan.whichHint"),
      },
    ],
    t("btn.next"),
  );
  if (!f) return undefined;
  chosen.set(it.id, f.pack);
  return packs.find((p) => p.id == f.pack) || null;
}

/** Scan a code again after its box was linked, so it is received now. */
export function again(code) {
  last = "";
  return onScan(code);
}

async function handle(c, format) {
  const { item: it, pack: scannedPack, code, expiry: printed } = lookupCode(state.items, c, state.packs),
    // A cashier only looks up, whatever the page says.
    m = cashierUi() ? "look" : $("#mode").value,
    n = Math.max(1, +$("#sq").value || 1);
  // A QR that is no product is usually a link or a payment slip: show it, don't offer to add it.
  if (!it && camera.isQr(format))
    return log(`${kindTag(format)}<span class="mut">${t("scan.qrText", { text: `<b>${E(c.slice(0, 120))}</b>` })}</span>`);
  // An unknown code is often a carton of something already here: offer to link
  // it as that product's box rather than make a second product of it.
  if (!it)
    return log(
      `${kindTag(format)}<span class="warn">${t("scan.unknown", { code: `<b>${E(code)}</b>` })}</span>${cashierUi() ? "" : ` <button class="g" data-act="linkBox" data-code="${E(code)}" data-scan="${E(c)}">${t("scan.linkBox")}</button> <button class="g" data-act="addItem" data-code="${E(code)}" data-exp="${E(printed || "")}">${t("scan.addNew")}</button>`}`,
    );
  if (m == "look")
    return log(
      kindTag(format) +
      (scannedPack ? `<span class="tag">${E(packLabel(scannedPack))}</span> ` : "") +
      t("scan.inStock", { name: E(it.name), sku: E(it.sku), qty: `<b>${+it.qty}</b>` }) +
        expTag(printed || nextExpiry(it.id)),
    );
  // "Count boxes" for a product with no box yet: offer to add one.
  if (!scannedPack && scanUi.unit == "box" && !packsOf(it).length)
    return log(
      `<span class="warn">${t("scan.noBox", { name: E(it.name) })}</span> <button class="g" data-act="linkBox" data-item="${E(it.id)}" data-code="${E(code == it.barcode || code.toLowerCase() == it.sku.toLowerCase() ? "" : code)}" data-scan="${E(c)}">${t("scan.linkBox")}</button>`,
    );
  const pack = await pickPack(it, scannedPack, code);
  if (pack === undefined) return log(`<span class="mut">${t("scan.cancelled", { sku: E(it.sku) })}</span>`);
  const packTag = pack ? `<span class="tag">${E(packLabel(pack))}</span> ` : "";
  if (pack && pack.size == null && m == "out")
    return log(`${packTag}<span class="warn">${E(it.sku)}: ${t("err.packNotCounted")}</span>`);

  let expiry = null,
    batch = "";
  if (m == "in") {
    const box = $("#sexp"),
      bbox = $("#sbatch");
    // The batch box, like the date box, was filled for one product.
    if (bbox && expFor && expFor != it.id) bbox.value = "";
    // A GS1 barcode carries its own date. Otherwise use the box, asking when a
    // consumable arrives without one, or when the box was filled for another product.
    expiry = printed || parseTyped(box?.value) || null;
    // A non-consumable is never asked, but doesn't take a date meant for another product either.
    if (!printed && it.kind != "consumable" && expFor && expFor != it.id) expiry = null;
    if (!printed && it.kind == "consumable" && (!expiry || (expFor && expFor != it.id))) {
      const asked = await askReceive(it, box?.value || "", bbox?.value.trim() || "");
      if (asked === null) return log(`<span class="mut">${t("scan.cancelled", { sku: E(it.sku) })}</span>`);
      expiry = asked.expiry;
      if (box) {
        box.value = typedDate(expiry);
        checkExpiry(box);
      }
      // Kept in the box for the next scans of this product, like the date.
      if (bbox) bbox.value = asked.batch;
    }
    expFor = it.id;
    // With or without a date (undated stock keeps its number on the product).
    // Boxes still waiting for their count add no stock, so no number either.
    batch = pack && pack.size == null ? "" : bbox?.value.trim() || "";
  }
  try {
    // Boxes received go through receivePack, which remembers the delivery; a
    // box with no count yet waits there and adds nothing to stock.
    if (pack && m == "in") await store.receivePack(pack.id, n, expiry);
    else await store.adjust(it.id, (m == "in" ? 1 : -1) * n * (pack ? +pack.size : 1), "scan", expiry);
    if (batch) await store.setLotBatch(it.id, expiry, batch);
    const now = state.items.find((i) => i.id == it.id);
    if (pack && pack.size == null)
      return log(
        `${kindTag(format)}${packTag}<span class="warn">${t("scan.boxWaiting", { n, pack: E(pack.name), name: E(it.name) })}</span>${expTag(expiry)}`,
      );
    const q = n * (pack ? +pack.size : 1);
    log(
      `${kindTag(format)}${packTag}<span class="${m}">${t("scan.ok", {
        name: E(it.name),
        sku: E(it.sku),
        sign: m == "in" ? "+" : "−",
        q,
        qty: `<b>${+now.qty}</b>`,
      })}</span>${expTag(expiry)}${m == "in" ? ` ${batchBtn(it.id, expiry, batch)}` : ""}`,
    );
  } catch (e) {
    log(`<span class="warn">${E(it.sku)}: ${E(errText(e))}</span>`);
  }
}

// Received stock with a date: a button to add or correct its batch no. later,
// for scans that went through without the dialog (box filled, GS1 date).
function batchBtn(itemId, expiry, batch = "") {
  const item = `data-act="lotBatch" data-item="${E(itemId)}"`;
  if (expiry) {
    const lot = state.lots.find((l) => l.item_id == itemId && l.expiry == expiry);
    return lot ? `<button class="g" ${item} data-exp="${E(expiry)}">${E(batchLabel(lot.batch || ""))}</button>` : "";
  }
  // No date (019): this delivery became the product's newest no-date batch if
  // it had a number; otherwise the button gives it one.
  return batch
    ? `<button class="g" ${item} data-latest="1">${E(batchLabel(batch))}</button>`
    : `<button class="g" ${item} data-new="1">${E(batchLabel(""))}</button>`;
}

// A date typed into the scanner's box by hand applies to the next product scanned.
export const dateTyped = () => (expFor = null);
