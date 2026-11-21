// Expiry dates: every dated batch on the shelf, soonest first, so staff check
// the few products the list points at instead of every shelf. A search finds
// a batch by product or batch number (a recall), and "Latest arrivals" shows
// what has just come in, to check its batch number and date.
import { E, num, fmt, dateText, dt } from "../lib/util.js";
import { t, tn } from "../i18n/index.js";
import { isOwner } from "../data/store.js";
import { daysLeft, status, SOON_DAYS, lastReceived, undatedBatches } from "../lib/expiry.js";

// q: search text. view: date | batch | latest | nobatch
export const ui = { q: "", view: "date" };

const COLS = ["th.sku", "th.name", "th.batch", "th.expiry", "th.left", "th.qty", "th.value"];
// "By batch no." puts the batch number first.
const BATCH_FIRST = [2, 0, 1, 3, 4, 5, 6];
const RECENT_DAYS = 30; // how far back "Latest arrivals" looks

const key = (lot) => lot.item_id + "|" + lot.expiry;

// Batches received in the last RECENT_DAYS, newest first.
function recent(lots, rec) {
  const since = new Date(Date.now() - RECENT_DAYS * 864e5).toISOString();
  return lots
    .filter((x) => (rec.get(key(x)) || "") >= since)
    .sort((a, b) => String(rec.get(key(b))).localeCompare(String(rec.get(key(a)))));
}

/** The tables under the search box: re-drawn alone while typing. */
export function lists(s) {
  const byId = new Map(s.items.map((i) => [i.id, i])),
    q = ui.q.trim().toLowerCase(),
    found = (l) => {
      const it = byId.get(l.item_id);
      return it && (!q || [it.sku, it.name, it.barcode, l.batch].join(" ").toLowerCase().includes(q));
    },
    lots = s.lots.filter(found),
    // stock without a date that has a batch no. (018), any kind of product
    undated = undatedBatches(s).filter(found),
    l = [...COLS, "th.received"].map((k) => E(t(k))),
    td = (j, v, cls) => `<td data-l="${l[j]}"${cls ? ` class="${cls}"` : ""}><span class="v">${v}</span></td>`;
  // One batch. order: the column order (COLS indexes); rec: add "Received".
  const row = (lot, rec, order = COLS.map((_, j) => j)) => {
    const it = byId.get(lot.item_id),
      dated = !!lot.expiry,
      d = dated ? daysLeft(lot.expiry) : null,
      st = dated ? status(lot.expiry) : "ok",
      when = rec && rec.get(key(lot));
    // A batch close to its date can sell for less (the till offers that price).
    const cut = lot.price != null ? ` <span class="tag warn">${t("exp.priceTag", { p: fmt(lot.price) })}</span>` : "",
      priceBtn =
        dated && isOwner() && st != "ok"
          ? `<button class="g" data-act="lotPrice" data-item="${E(lot.item_id)}" data-exp="${E(lot.expiry)}">${t("exp.setPrice")}</button> `
          : "";
    const cells = [
      td(0, `<b>${E(it.sku)}</b>`),
      td(1, E(it.name) + cut),
      td(2, lot.batch ? `<b>${E(lot.batch)}</b>` : `<span class="mut">—</span>`),
      td(3, dated ? dateText(lot.expiry) : `<span class="mut">${t("inv.noDate")}</span>`, st == "ok" ? "" : "warn"),
      td(
        4,
        !dated ? "—" : d < 0 ? t("exp.agoN", { n: -d }) : d == 0 ? t("exp.today") : t("exp.inN", { n: d }),
        st == "expired" ? "bad" : st == "soon" ? "warn" : "",
      ),
      td(5, num(lot.qty)),
      td(6, fmt(lot.qty * it.cost)),
    ];
    // Undated stock has no batch of its own to write off or re-date: only its number.
    const acts = dated
      ? `${priceBtn}<button class="g" data-act="writeOff" data-id="${E(lot.id)}">${t("exp.writeOff")}</button> <button class="g" data-act="lotDate" data-id="${E(
          lot.id,
        )}">${t("exp.changeDate")}</button> <button class="g" data-act="lotBatch" data-id="${E(lot.id)}">`
      : `<button class="g" data-act="lotBatch" data-item="${E(lot.item_id)}">`;
    return `<tr>${order.map((j) => cells[j]).join("")}${rec ? td(7, when ? dt(when) : "—") : ""}<td class="act">${acts}${t(
      lot.batch ? "exp.editBatch" : "exp.addBatch",
    )}</button></td></tr>`;
  };
  const table = (list, empty, rec, order = COLS.map((_, j) => j)) =>
    `<table class="rt"><thead><tr>${[...order.map((j) => COLS[j]), ...(rec ? ["th.received"] : [])].map((k) => `<th>${t(k)}</th>`).join("")}<th></th></tr></thead><tbody>${
      list.length
        ? list.map((x) => row(x, rec, order)).join("")
        : `<tr><td colspan="${rec ? 9 : 8}" class="mut">${q ? t("exp.noMatch") : empty}</td></tr>`
    }</tbody></table>`;

  // Every batch that has a number, the one to expire first on top; undated last.
  if (ui.view == "batch") {
    const L = [...lots.filter((x) => x.batch).sort((a, b) => (a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : 0)), ...undated];
    return `<div class="card ts"><h3>${t("exp.view.byBatchH")}</h3>${table(L, t("exp.noneBatch"), null, BATCH_FIRST)}</div>`;
  }

  if (ui.view != "date") {
    const rec = lastReceived(s),
      L = recent(lots, rec).filter((x) => ui.view != "nobatch" || !x.batch);
    return `<div class="card ts"><h3>${t(ui.view == "nobatch" ? "exp.view.noBatchH" : "exp.view.latestH", { n: RECENT_DAYS })}</h3>${table(
      L,
      t(ui.view == "nobatch" ? "exp.noneNoBatch" : "exp.noneLatest", { n: RECENT_DAYS }),
      rec,
    )}</div>`;
  }

  const expired = lots.filter((x) => status(x.expiry) == "expired"),
    soon = lots.filter((x) => status(x.expiry) == "soon");
  // "Soon" split into within a week, a month and two months, as far as the
  // shop's warning reaches (settings.expiry_days).
  const bands = (list) => {
    const out = [];
    let from = -1;
    for (const n of [7, 30, 60]) {
      if (from >= SOON_DAYS) break;
      const to = Math.min(n, SOON_DAYS);
      out.push([t("exp.band." + n), list.filter((x) => daysLeft(x.expiry) > from && daysLeft(x.expiry) <= to)]);
      from = to;
    }
    return out;
  };
  const parts = [
    [t("exp.listExpired"), expired, t("exp.noneExpired")],
    ...bands(soon).map(([h, L]) => [h, L, t("exp.noneSoon")]),
    [t("exp.listAll"), lots.filter((x) => status(x.expiry) == "ok"), t("exp.noneDated")],
    // only shown when there is some: most shops have none
    ...(undated.length ? [[t("exp.noDateH"), undated, ""]] : []),
  ]
    // While searching, only the lists with something found.
    .filter(([, L]) => !q || L.length);
  if (!parts.length) return `<div class="card"><p class="mut">${t("exp.noMatch")}</p></div>`;
  return parts.map(([h, L, empty]) => `<div class="card ts"><h3>${h}</h3>${table(L, empty)}</div>`).join("\n");
}

export default function exp(s) {
  const byId = new Map(s.items.map((i) => [i.id, i])),
    lots = s.lots.filter((l) => byId.has(l.item_id)),
    expired = lots.filter((l) => status(l.expiry) == "expired"),
    soon = lots.filter((l) => status(l.expiry) == "soon"),
    // consumables with stock but no date recorded: what to date next
    undated = s.items.filter(
      (i) =>
        i.kind == "consumable" &&
        +i.qty > lots.filter((l) => l.item_id == i.id).reduce((a, l) => a + +l.qty, 0),
    ),
    // just-arrived batches still without a batch number: what to fill in next
    noBatch = recent(lots, lastReceived(s)).filter((l) => !l.batch).length;
  const warn = `<div class="card"><div class="row"><b style="flex:1 1 200px">${t("exp.warnMe")}</b><select data-input="setting" data-key="expiry_days" data-num="1"${
    isOwner() ? "" : " disabled"
  }>${[7, 30, 60]
    .map((n) => `<option value="${n}"${n == SOON_DAYS ? " selected" : ""}>${t("exp.before." + n)}</option>`)
    .join("")}</select>${
    "Notification" in window && Notification.permission != "granted"
      ? `<button class="g" data-act="allowNotes">${t("exp.allowNotes")}</button>`
      : ""
  }</div></div>`;
  const find = `<div class="card"><div class="row"><input id="expq" type="search" placeholder="${E(t("exp.search"))}" value="${E(
    ui.q,
  )}" data-input="expSearch" autocomplete="off"><select data-input="expView" aria-label="${E(t("exp.view.label"))}">${[
    ["date", t("exp.view.byDate")],
    ["batch", t("exp.view.byBatch")],
    ["latest", t("exp.view.latest", { n: RECENT_DAYS })],
    ["nobatch", t("exp.view.noBatch", { n: noBatch })],
  ]
    .map(([v, label]) => `<option value="${v}"${v == ui.view ? " selected" : ""}>${E(label)}</option>`)
    .join("")}</select></div></div>`;
  return `${warn}<div class="stats">${[
    ["exp.expired", expired, "bad"],
    ["exp.soon", soon, "warn"],
    ["exp.dated", lots, "in"],
  ]
    .map(
      ([k, L, cl]) =>
        `<div class="card"><div class="sh">${t(k, { n: SOON_DAYS })}</div><b class="n ${cl}">${num(
          L.reduce((a, x) => a + +x.qty, 0),
        )}</b><small>${tn("exp.batches", L.length)}</small></div>`,
    )
    .join("")}</div>
${find}<div id="expl">${lists(s)}</div>${
    undated.length
      ? `<div class="card"><h3>${t("exp.undated", { n: undated.length })}</h3><p class="mut mt">${t(
          "exp.undatedNote",
        )}</p><p class="mt">${undated.map((i) => `<span class="tag">${E(i.sku)} · ${E(i.name)}</span>`).join(" ")}</p></div>`
      : ""
  }`;
}
