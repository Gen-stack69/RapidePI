import { E, fmt, num, dateText, expiryNote } from "../lib/util.js";
import { t } from "../i18n/index.js";
import { isOwner, photoSrc } from "../data/store.js";
import { waitingBoxes } from "../data/fields.js";
import { status, undatedBatches } from "../lib/expiry.js";
import { SIGN } from "../lib/rates.js";

// q: search text. f: all | consumable | durable | soon | expired. s: sort order (SORTS)
// open: products whose batch list is rolled down (kept while the list redraws).
export const ui = { q: "", f: "all", s: "name", open: new Set() };

// Column order, shared by the header and the per-cell mobile labels
// (styles.css shows `data-l` instead of the hidden header on narrow screens).
const COLS = ["th.sku", "th.name", "th.category", "th.qty", "th.min", "th.cost", "th.price", "th.value"];

// The soonest expiry per product (lots arrive sorted by date).
const firstExpiry = (s) => {
  const m = new Map();
  for (const l of s.lots) if (!m.has(l.item_id)) m.set(l.item_id, l.expiry);
  return m;
};

// Every batch per product: the dated ones soonest first, then the undated
// stock when it has a batch no. (018).
const batchesOf = (s) => {
  const m = new Map();
  for (const l of [...s.lots, ...undatedBatches(s)]) {
    if (!m.has(l.item_id)) m.set(l.item_id, []);
    m.get(l.item_id).push(l);
  }
  return m;
};
// "EXP 31/12/2026 · in 40 days", or "No date" for undated stock.
const when = (l) => (l.expiry ? `${t("exp.short")} ${dateText(l.expiry)}${expiryNote(l.expiry)}` : t("inv.noDate"));

export function rows(s) {
  const q = ui.q.toLowerCase(),
    next = firstExpiry(s),
    bats = batchesOf(s),
    pass = (i) => {
      const e = next.get(i.id);
      switch (ui.f) {
        case "consumable":
        case "durable":
          return (i.kind || "durable") == ui.f;
        case "soon":
          return e && status(e) == "soon";
        case "expired":
          return e && status(e) == "expired";
      }
      return true;
    },
    L = s.items.filter(
      (i) =>
        pass(i) &&
        [i.sku, i.name, i.category, i.barcode, ...(bats.get(i.id) || []).map((l) => l.batch || "")]
          .join(" ")
          .toLowerCase()
          .includes(q),
    );
  sortBy(L, next);
  if (!L.length)
    return `<tr><td colspan="9" class="mut">${t(s.items.length ? "inv.noMatch" : "inv.none")}</td></tr>`;
  const l = COLS.map((k) => E(t(k)));
  return L.map((i) => {
    const low = +i.qty < +i.min_qty,
      id = E(i.id),
      td = (j, v, cls) => `<td data-l="${l[j]}"${cls ? ` class="${cls}"` : ""}><span class="v">${v}</span></td>`,
      kind = i.kind == "consumable" ? "consumable" : "durable";
    // Its packs ("Carton × 24 · ₭210,000"). Tapping one changes it: the owner
    // any, staff only one with no price yet. "× ?" is a box not counted yet.
    const packs = s.packs
      .filter((p) => p.item_id == i.id)
      .map((p) => {
        const edit = isOwner() || !+p.price,
          wait = waitingBoxes(s.packReceipts, p.id);
        return `<${edit ? `button class="tag pk${p.size == null ? " warn" : ""}" data-act="editPack" data-item="${id}" data-id="${E(p.id)}"` : 'span class="tag"'}>${E(
          p.name,
        )} × ${p.size == null ? "?" : num(p.size)}${+p.price ? ` · ${fmt(p.price)}` : ""}${
          wait ? ` · ${t("inv.waiting", { n: num(wait) })}` : ""
        }</${edit ? "button" : "span"}>`;
      })
      .join(" ");
    // One batch: its line under the name (date · batch no. · how many).
    // Several: a button that rolls down a list of them under the product, so
    // two deliveries of the same product are never mixed up.
    const B = bats.get(i.id) || [],
      cls = (l) => (!l.expiry || status(l.expiry) == "ok" ? "mut" : "warn"),
      batchNo = (l) => (l.batch ? `${t("exp.batchShort")} ${E(l.batch)}` : `<span class="mut">${t("inv.noBatchNo")}</span>`),
      open = B.length > 1 && (ui.open.has(i.id) || (q && B.some((l) => String(l.batch || "").toLowerCase().includes(q)))),
      lines =
        B.length == 1
          ? `<br><small class="${cls(B[0])}">${when(B[0])}${
              B[0].batch ? ` · ${t("exp.batchShort")} ${E(B[0].batch)}` : ""
            } · ${num(B[0].qty)}</small>`
          : B.length > 1
            ? `<br><button type="button" class="bt${open ? " on" : ""}${B.some((l) => cls(l) == "warn") ? " warn" : ""}" data-act="invBatches" data-id="${id}" aria-expanded="${!!open}"><i class="chev" aria-hidden="true">▸</i><span class="bt-t"><b>${t("inv.batchesN", { n: B.length })}</b><span>${
                B[0].expiry ? `${t("exp.short")} ${dateText(B[0].expiry)}` : t("inv.noDate")
              }</span>${nums(B) ? `<small class="bt-n">${nums(B)}</small>` : ""}</span></button>`
            : "",
      detail =
        B.length > 1
          ? `<tr class="bd${open ? " open" : ""}" data-for="${id}"><td colspan="9"><div class="bdw"><div class="bl">${B.map(
              (l) =>
                `<div class="br ${cls(l)}"><span>${when(l)}</span><span>${batchNo(l)}</span><span class="q">${num(
                  l.qty,
                )}${i.unit ? " " + E(i.unit) : ""}</span><span><button class="g" data-act="lotBatch" ${
                  l.id ? `data-id="${E(l.id)}"` : `data-item="${id}"`
                }>${t(
                  l.batch ? "exp.editBatch" : "exp.addBatch",
                )}</button></span></div>`,
            ).join("")}<p class="mt"><a href="#exp" data-act="expFor" data-sku="${E(i.sku)}">${t("inv.openExpiry")}</a></p></div></div></td></tr>`
          : "";
    const pic = photoSrc(i),
      name = `${E(i.name)} <span class="tag ${kind}">${t("kind." + kind)}</span>${packs ? "<br>" + packs : ""}${lines}`;
    const cost =
      fmt(i.cost) +
      (i.cost_currency && i.cost_currency != "LAK" ? `<br><small class="mut">${SIGN[i.cost_currency]}${num(i.cost_orig)}</small>` : "");
    // The product's photo, if it has one, sits beside its SKU.
    return `<tr>${td(
      0,
      pic ? `<span class="skuph"><img class="ph" src="${E(pic)}" alt="" loading="lazy"><b>${E(i.sku)}</b></span>` : `<b>${E(i.sku)}</b>`,
      pic ? "sku hasph" : "sku",
    )}${td(1, name, "nm")}${td(2, E(i.category))}${td(
      3,
      num(i.qty) + (i.unit ? " " + E(i.unit) : "") + (low ? " ⚠" : ""),
      low ? "warn" : "",
    )}${td(4, num(i.min_qty))}${td(5, cost)}${td(6, fmt(i.price))}${td(
      7,
      fmt(i.qty * i.cost),
    )}<td class="act"><button class="g" data-act="adj" data-id="${id}" data-dir="1" title="${E(
      t("tip.addStock"),
    )}">＋</button> <button class="g" data-act="adj" data-id="${id}" data-dir="-1" title="${E(
      t("tip.removeStock"),
    )}">－</button> <button class="g" data-act="editItem" data-id="${id}" title="${E(t("tip.edit"))}">✎</button>${
      isOwner()
        ? ` <button class="g" data-act="delItem" data-id="${id}" title="${E(t("tip.delete"))}">🗑</button>`
        : ""
    } <button class="g" data-act="addPack" data-id="${id}" title="${E(t("tip.addPack"))}">📦</button></td></tr>${detail}`;
  }).join("");
}

const FILTERS = ["all", "consumable", "durable", "soon", "expired"];
// The batch numbers of a product's batches, soonest date first, each once:
// "L001, L002" (the first 3, then "+N"), so they show without opening the list.
function nums(B) {
  const all = [];
  for (const l of B)
    for (const n of String(l.batch || "").split(","))
      if (n.trim() && !all.some((x) => x.toLowerCase() == n.trim().toLowerCase())) all.push(n.trim());
  if (!all.length) return "";
  return `${E(all.slice(0, 3).join(", "))}${all.length > 3 ? ` +${all.length - 3}` : ""}`;
}

const SORTS = ["name", "sku", "expiry", "recent", "qty", "low"];

// Products with no date go last when sorting by expiry; ties keep name order.
function sortBy(L, next) {
  const byName = (a, b) => a.name.localeCompare(b.name),
    far = "9999-12-31",
    by = {
      name: byName,
      sku: (a, b) => a.sku.localeCompare(b.sku, undefined, { numeric: true }),
      expiry: (a, b) => (next.get(a.id) || far).localeCompare(next.get(b.id) || far) || byName(a, b),
      recent: (a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")) || byName(a, b),
      qty: (a, b) => a.qty - b.qty || byName(a, b),
      low: (a, b) => a.qty - a.min_qty - (b.qty - b.min_qty) || byName(a, b),
    }[ui.s];
  if (by) L.sort(by);
}

export default function inv(s) {
  return `<div class="card"><div class="row"><input id="q" placeholder="${E(t("inv.search"))}" value="${E(
    ui.q,
  )}" data-input="search"><select data-input="invFilter">${FILTERS.map(
    (f) => `<option value="${f}"${f == ui.f ? " selected" : ""}>${t("inv.f." + f)}</option>`,
  ).join("")}</select><select data-input="invSort" aria-label="${E(t("inv.sortBy"))}">${SORTS.map(
    (k) => `<option value="${k}"${k == ui.s ? " selected" : ""}>${t("inv.s." + k)}</option>`,
  ).join("")}</select></div></div><div class="card ts"><table class="rt"><thead><tr>${COLS.map(
    (k) => `<th>${t(k)}</th>`,
  ).join("")}<th></th></tr></thead><tbody id="tb">${rows(s)}</tbody></table></div>`;
}
