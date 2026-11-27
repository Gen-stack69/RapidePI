import { E, fmt, fmtIn, num } from "../lib/util.js";
import { CUR, SIGN, kipPer } from "../lib/rates.js";
import { t, tn, locale, lang } from "../i18n/index.js";
import { status } from "../lib/expiry.js";
import { dt } from "../lib/util.js";
import { saleNo, moveFlow } from "../data/apply.js";
import { errText } from "../i18n/index.js";
import { isOwner } from "../data/store.js";
import { waitingBoxes } from "../data/fields.js";

// What needs a person after work done offline: stock that went below zero,
// sales the server flagged, and queued work it refused.
function checks(s) {
  const neg = s.items.filter((i) => +i.qty < 0),
    // "imported" only says where a past sale came from: nothing to check.
    problems = (x) => (x.flags || []).filter((f) => f != "imported"),
    flagged = s.sales.filter((x) => x.status != "void" && problems(x).length),
    failed = s.failed || [];
  if (!neg.length && !flagged.length && !failed.length) return "";
  const what = (r) =>
    r.op == "sale"
      ? t("sync.op.sale", { n: r.args.till ? `${r.args.till}-${String(r.args.till_no).padStart(4, "0")}` : "" })
      : t("sync.op." + r.op, { sku: s.items.find((i) => i.id == r.args.item_id)?.sku ?? "" });
  return `<div class="card ts"><h3>${t("chk.title")}<small>${t("chk.sub")}</small></h3><table class="rt">${[
    ...neg.map(
      (i) =>
        `<tr><td><b>${E(i.sku)}</b> ${E(i.name)}</td><td class="bad">${num(i.qty)}</td><td>${t(
          "chk.below",
        )}</td><td class="act"><button class="g" data-act="editItem" data-id="${E(i.id)}">${t("chk.recount")}</button></td></tr>`,
    ),
    ...flagged.map(
      (x) =>
        `<tr><td><b>#${E(saleNo(x))}</b> ${dt(x.created_at)}</td><td>${fmt(x.total)}</td><td class="warn">${problems(x)
          .map((f) => t("chk.flag." + f))
          .join(", ")}</td><td class="act"><button class="g" data-act="posReceipt" data-id="${E(x.client_id)}">🧾</button></td></tr>`,
    ),
    ...failed.map(
      (r) =>
        `<tr><td><b>${E(what(r))}</b> ${dt(r.at)}</td><td colspan="2" class="bad">${E(
          errText(r.error?.code ? { code: r.error.code, params: r.error.params } : r.error?.message || ""),
        )}</td><td class="act"><button class="g" data-act="retryFailed" data-id="${E(r.id)}">${t(
          "sync.retry",
        )}</button> <button class="g" data-act="discardFailed" data-id="${E(r.id)}">${t("sync.discard")}</button></td></tr>`,
    ),
  ].join("")}</table></div>`;
}

// Boxes received before anyone counted what is inside one: not in stock yet.
// Counting one box puts every waiting box of that kind into stock.
function waiting(s) {
  const packs = s.packs
    .map((p) => ({ p, n: waitingBoxes(s.packReceipts, p.id), it: s.items.find((i) => i.id == p.item_id) }))
    .filter((x) => x.n && x.it);
  if (!packs.length) return "";
  return `<div class="card ts"><h3>${t("box.title")}<small>${t("box.sub")}</small></h3><table class="rt">${packs
    .map(
      ({ p, n, it }) =>
        `<tr><td><b>${E(it.sku)}</b> ${E(it.name)}</td><td class="warn">${t("box.row", { n: num(n), pack: E(p.name) })}</td><td class="act">${
          isOwner() || !+p.price ? `<button class="g" data-act="countPack" data-id="${E(p.id)}">${t("box.count")}</button>` : ""
        }</td></tr>`,
    )
    .join("")}</table></div>`;
}

// Which currency the money tiles show (this device only).
export const ui = { cur: "LAK" };
try {
  if (CUR.includes(localStorage.dashCur)) ui.cur = localStorage.dashCur;
} catch {}

// One tile: a link to the screen that deals with it.
const tile = (href, tone, icon, label, value, sub, cl = "") =>
  `<a class="card tile" href="#${href}"><i class="ic ${tone}">${icon}</i><span><span class="sh">${label}</span><b class="n ${cl}">${value}</b><small>${sub}</small></span><em>›</em></a>`;

// Chrome has no Lao day names (it falls back to English).
const LO_DAYS = ["ອາທິດ", "ຈັນ", "ອັງຄານ", "ພຸດ", "ພະຫັດ", "ສຸກ", "ເສົາ"];

// Money for a chart axis: 2.5M, 300K (in the chosen currency).
const short = (kip) =>
  ((+kip || 0) / kipPer(ui.cur)).toLocaleString(locale(), { notation: "compact", maximumFractionDigits: 1 });

// Takings per day for the last 7 days, today last.
function week(sales) {
  const days = [...Array(7)].map((_, j) => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - 6 + j);
    return { d, key: d.toDateString(), total: 0 };
  });
  const by = new Map(days.map((x) => [x.key, x]));
  for (const x of sales) {
    if (x.status == "void") continue;
    const day = by.get(new Date(x.created_at).toDateString());
    if (day) day.total += +x.total;
  }
  return days;
}

function salesChart(s) {
  const days = week(s.sales),
    sum = days.reduce((a, x) => a + x.total, 0),
    top = Math.max(...days.map((x) => x.total)),
    // A round top line: 1, 2 or 5 times a power of ten.
    p = 10 ** Math.floor(Math.log10(top || 1)),
    max = top ? [1, 2, 5, 10].map((m) => m * p).find((m) => m >= top) : 1,
    W = 360,
    H = 190,
    L = 40,
    B = 24,
    x = (j) => L + (j * (W - L - 18)) / 6,
    y = (v) => 10 + (1 - v / max) * (H - B - 10),
    pts = days.map((d, j) => [x(j), y(d.total)]),
    line = pts.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join(" "),
    wd = (d) => (lang() == "lo" ? LO_DAYS[d.getDay()] : d.toLocaleDateString("en", { weekday: "short" }));
  const grid = [0, 0.5, 1]
    .map(
      (f) =>
        `<line x1="${L}" x2="${W - 10}" y1="${y(max * f)}" y2="${y(max * f)}" class="gl"/><text x="${L - 8}" y="${
          y(max * f) + 4
        }" text-anchor="end">${top ? short(max * f) : f ? "" : "0"}</text>`,
    )
    .join("");
  return `<div class="card"><h3>${t("dash.week")}<small>${fmtIn(sum, ui.cur)}</small></h3><svg class="line" viewBox="0 0 ${W} ${H}" role="img" aria-label="${E(
    t("dash.week"),
  )}">${grid}<polygon points="${x(0)},${y(0)} ${line} ${x(6)},${y(0)}" class="area"/><polyline points="${line}" class="stroke"/>${pts
    .map(([a, b], j) => `<circle cx="${a}" cy="${b}" r="4"><title>${E(wd(days[j].d))}: ${E(fmtIn(days[j].total, ui.cur))}</title></circle>`)
    .join("")}${days
    .map((d, j) => `<text x="${x(j)}" y="${H - 6}" text-anchor="middle">${E(wd(d.d))}</text>`)
    .join("")}</svg></div>`;
}

function flowChart(s) {
  const v = moveFlow(s.movements, s.sales),
    [inb, ob] = v,
    mx = Math.max(1, ...v);
  return `<div class="card"><h3>${t("dash.move")}<small>${t(
    "dash.last30",
  )}</small></h3><div style="display:flex;align-items:flex-end;gap:8%;height:180px;margin:20px 0 8px;padding:0 6%;border-bottom:1px solid var(--edge);background:repeating-linear-gradient(var(--grid) 0 1px,transparent 1px 40px)">${v
    .map(
      (x, j) =>
        `<div style="flex:1;height:${(x / mx) * 100}%;min-height:2px;background:${["var(--in)", "var(--out)"][j]};border-radius:6px 6px 0 0"></div>`,
    )
    .join("")}</div><div class="mut" style="display:flex;justify-content:space-around;text-align:center;gap:6px"><span>${t(
    "dash.received",
    { n: num(inb) },
  )}</span><span>${t("dash.shipped", { n: num(ob) })}</span></div></div>`;
}

// The latest sales and stock changes: a short record of what happened.
// A sale's own stock lines are left out: the sale row stands for them.
function activity(s) {
  const name = new Map(s.items.map((i) => [i.sku, i.name])),
    rows = [
      ...s.sales.map((x) => ({
        at: x.created_at,
        ic: "🧾",
        tone: "t-in",
        what: t(x.status == "void" ? "act.void" : "act.sale", { n: E(saleNo(x)) }),
        amt: fmtIn(x.total, ui.cur),
      })),
      ...s.movements
        .filter((m) => !m.sale_id)
        .map((m) => ({
          at: m.created_at,
          ic: m.type == "in" ? "▲" : "▼",
          tone: m.type == "in" ? "t-val" : "t-warn",
          what: t(m.type == "in" ? "act.in" : "act.out", { n: num(Math.abs(+m.qty)), name: E(name.get(m.sku) || m.sku || "") }),
          amt: m.note ? E(m.note) : "",
        })),
    ]
      .filter((r) => r.at)
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .slice(0, 8);
  return `<div class="card"><h3>${t("dash.recent")}<a class="more" href="#rep">${t("dash.viewAll")} →</a></h3>${
    rows.length
      ? `<ul class="feed">${rows
          .map(
            (r) =>
              `<li><i class="ic ${r.tone}">${r.ic}</i><span><b>${r.what}</b><small>${dt(r.at)}</small></span><em>${r.amt}</em></li>`,
          )
          .join("")}</ul>`
      : s.items.length
        ? `<p class="mut">${t("dash.noActivity")}</p>`
        : // A brand-new shop: point to where the first product is added.
          `<p class="mut">${t("dash.firstProduct")}</p><div class="row mt"><button class="b" data-act="addItem">${t("btn.addItem")}</button></div>`
  }</div>`;
}

export default function dash(s) {
  const I = s.items,
    units = I.reduce((a, i) => a + +i.qty, 0),
    lo = I.filter((i) => +i.qty < +i.min_qty).length,
    val = I.reduce((a, i) => a + i.qty * i.cost, 0),
    retail = I.reduce((a, i) => a + i.qty * i.price, 0),
    day = new Date().toDateString(),
    sold = s.sales.filter((x) => x.status != "void" && new Date(x.created_at).toDateString() == day),
    dated = s.lots.filter((l) => status(l.expiry) != "ok");
  const pick = `<div class="row" style="justify-content:flex-end;margin-bottom:10px"><span class="mut">${t(
    "dash.showIn",
  )}</span><select data-input="dashCur" aria-label="${E(t("dash.showIn"))}">${CUR.map(
    (c) => `<option value="${c}"${c == ui.cur ? " selected" : ""}>${SIGN[c]} ${c}</option>`,
  ).join("")}</select></div>`;
  return `${pick}<div class="stats">${[
    tile("rep", "t-in", "🧾", t("dash.sales"), fmtIn(sold.reduce((a, x) => a + +x.total, 0), ui.cur), tn("dash.sales.sub", sold.length), "in"),
    tile("inv", "t-warn", "⚠", t("dash.low"), num(lo), t("dash.low.of", { n: num(I.length) }), lo ? "warn" : ""),
    tile(
      "exp",
      "t-bad",
      "⏳",
      t("dash.expiring"),
      num(dated.reduce((a, l) => a + +l.qty, 0)),
      tn("dash.expiring.sub", dated.length),
      dated.length ? "warn" : "",
    ),
    tile("inv", "t-val", SIGN[ui.cur], t("dash.value"), fmtIn(val, ui.cur), t("dash.value.more", { retail: fmtIn(retail, ui.cur), n: num(units) })),
  ].join("")}</div>
${checks(s)}
${waiting(s)}
<div class="charts">${salesChart(s)}${flowChart(s)}</div>
${activity(s)}`;
}
