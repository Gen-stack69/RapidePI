// The printed-form layout of every export (Excel, PDF, print), laid out like a
// Lao warehouse form: shop and report title on top, date and document number
// on the right, numbered rows (ລດ) grouped with a total under each group, a
// summary, and signature lines at the bottom.
//
// The model is plain data, so the three outputs draw the same report:
//   { key, shop, title, date, no, by, period,
//     tables: [{ title, cols: [{ h, type }], groups: [{ title, rows, total }], grand }],
//     summary: [[label, value, type]], sign: [role, ...] }
// A column type is "s" text, "c" centred text, "n" a quantity, "m" an amount in kip.
// Quantities are only added up when the rows share one unit: 12 boxes and
// 3 cartons do not make 15 of anything.
import { t } from "../i18n/index.js";
import { saleNo } from "../data/apply.js";
import { daysLeft, status, SOON_DAYS } from "./expiry.js";
import { colName } from "./xlsxw.js";

const p2 = (n) => String(n).padStart(2, "0");
const asDate = (x) => (typeof x == "string" && /^\d{4}-\d{2}-\d{2}$/.test(x) ? new Date(x + "T00:00:00") : new Date(x));
/** 05/09/2026: one date format in every report, day first. */
export const dmy = (x) => {
  if (!x) return "";
  const d = asDate(x);
  return isNaN(d) ? "" : `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()}`;
};
/** 05/09/2026 14:03 */
export const dmyhm = (x) => {
  if (!x) return "";
  const d = asDate(x);
  return isNaN(d) ? "" : `${dmy(d)} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
};

// Document number prefix: STK-20261120.
const PREFIX = { Inventory: "STK", Sales: "SAL", Expiry: "EXP", Orders: "ORD", Movements: "MOV" };
const SIGN = {
  Inventory: ["counted", "whHead", "stockAcct"],
  Expiry: ["counted", "whHead", "stockAcct"],
  Orders: ["prepared", "whHead", "stockAcct"],
  Movements: ["prepared", "whHead", "stockAcct"],
  Sales: ["cashier", "acct", "manager"],
};

const col = (k, type = "s") => ({ h: t("rp.c." + k), type });

/** Why stock left (025): "Damaged", or "Other: fell off the van". */
export const reasonLabel = (code, text) => (code ? t("reason." + code) + (text ? ": " + text : "") : "");
/** Who did it: an email when this device knows it (the owner sees the
 * staff list), else the start of the user id, so two people still differ. */
export const whoOf = (s, id) =>
  !id ? "" : id == s.user?.id ? s.user.email || "" : s.people?.members?.find((m) => m.user_id == id)?.email || String(id).slice(0, 8);
const sum = (rows, i) => rows.reduce((a, r) => a + (+r[i] || 0), 0);
const oneUnit = (units) => new Set(units.map((u) => String(u || "").trim().toLowerCase())).size <= 1;
/** A total row: the label first, then the sums at their column numbers. */
const totalRow = (n, label, sums) => {
  const r = Array(n).fill("");
  r[0] = label;
  for (const [i, v] of Object.entries(sums)) if (v !== null) r[i] = v;
  return r;
};
const byName = (a, b) => String(a.name || "").localeCompare(String(b.name || ""));
const number = (rows) => rows.map((r, i) => [i + 1, ...r]);

/** "13 × Carton (12) + 7": stock counted in the product's biggest pack. */
function inPacks(qty, p) {
  const q = +qty,
    size = +p?.size;
  if (!p || !(size > 1) || !(q > 0) || !Number.isInteger(q)) return "";
  const full = Math.floor(q / size),
    rest = q % size;
  if (!full) return "";
  return `${full} × ${p.name} (${size})` + (rest ? ` + ${rest}` : "");
}

const BUILD = {
  Inventory(s) {
    const big = new Map();
    for (const p of s.packs || [])
      if (+p.size > 1 && !(+big.get(p.item_id)?.size >= +p.size)) big.set(p.item_id, p);
    const cols = [
      col("no", "c"),
      col("sku"),
      col("barcode"),
      col("name"),
      col("unit", "c"),
      col("packs"),
      col("qty", "n"),
      col("min", "n"),
      col("cost", "m"),
      col("price", "m"),
      col("value", "m"),
      col("note"),
    ];
    const n = cols.length,
      cats = new Map();
    for (const i of [...s.items].sort(byName)) {
      const c = String(i.category || "").trim() || t("rp.noCategory");
      if (!cats.has(c)) cats.set(c, []);
      cats.get(c).push(i);
    }
    const note = (i) => (+i.qty <= 0 ? t("rp.out") : +i.qty < +i.min_qty ? t("rp.low") : "");
    const groups = [...cats.keys()]
      .sort((a, b) => a.localeCompare(b))
      .map((c) => {
        const list = cats.get(c),
          rows = number(
            list.map((i) => [
              i.sku,
              i.barcode || "",
              i.name,
              i.unit || "",
              inPacks(i.qty, big.get(i.id)),
              +i.qty,
              +i.min_qty,
              +i.cost,
              +i.price || 0,
              i.qty * i.cost,
              note(i),
            ]),
          );
        return {
          title: c,
          rows,
          total: totalRow(n, t("rp.total") + " " + c, {
            6: oneUnit(list.map((i) => i.unit)) ? sum(rows, 6) : null,
            10: sum(rows, 10),
          }),
        };
      });
    const all = groups.flatMap((g) => g.rows),
      value = s.items.reduce((a, i) => a + i.qty * i.cost, 0),
      atPrice = s.items.reduce((a, i) => a + i.qty * (+i.price || 0), 0);
    return {
      tables: [
        {
          cols,
          groups,
          grand:
            groups.length > 1
              ? totalRow(n, t("rp.grand"), { 6: oneUnit(s.items.map((i) => i.unit)) ? sum(all, 6) : null, 10: value })
              : null,
        },
      ],
      summary: [
        [t("rp.s.products"), s.items.length, "n"],
        [t("rp.s.low"), s.items.filter((i) => +i.qty > 0 && +i.qty < +i.min_qty).length, "n"],
        [t("rp.s.out"), s.items.filter((i) => +i.qty <= 0).length, "n"],
        [t("rp.s.valueCost"), value, "m"],
        [t("rp.s.valuePrice"), atPrice, "m"],
      ],
    };
  },

  Expiry(s) {
    const byId = new Map(s.items.map((i) => [i.id, i])),
      lots = (s.lots || []).filter((l) => byId.has(l.item_id) && +l.qty > 0),
      per = new Map();
    for (const l of lots) {
      if (!per.has(l.item_id)) per.set(l.item_id, []);
      per.get(l.item_id).push(l);
    }
    const cols = [col("no", "c"), col("batch"), col("expiry", "c"), col("days", "n"), col("status"), col("qty", "n"), col("cost", "m"), col("value", "m")];
    const n = cols.length,
      word = (e) => ({ expired: t("rp.expired"), soon: t("rp.soon", { n: SOON_DAYS }), ok: t("rp.ok") })[status(e)];
    const items = [...per.keys()].map((id) => byId.get(id)).sort(byName);
    const groups = items.map((i) => {
      const rows = number(
        per
          .get(i.id)
          .sort((a, b) => String(a.expiry).localeCompare(String(b.expiry)))
          .map((l) => [l.batch || "", dmy(l.expiry), daysLeft(l.expiry), word(l.expiry), +l.qty, +i.cost, l.qty * i.cost]),
      );
      return {
        title: `${i.sku} · ${i.name}` + (i.unit ? ` (${i.unit})` : ""),
        rows,
        total: totalRow(n, t("rp.total"), { 5: sum(rows, 5), 7: sum(rows, 7) }),
      };
    });
    const valueIf = (st) => lots.filter((l) => status(l.expiry) == st).reduce((a, l) => a + l.qty * byId.get(l.item_id).cost, 0);
    return {
      tables: [
        {
          cols,
          groups,
          grand:
            groups.length > 1
              ? totalRow(n, t("rp.grand"), {
                  5: oneUnit(items.map((i) => i.unit)) ? sum(groups.flatMap((g) => g.rows), 5) : null,
                  7: lots.reduce((a, l) => a + l.qty * byId.get(l.item_id).cost, 0),
                })
              : null,
        },
      ],
      summary: [
        [t("rp.s.lots"), lots.length, "n"],
        [t("rp.s.expiredValue"), valueIf("expired"), "m"],
        [t("rp.s.soonValue", { n: SOON_DAYS }), valueIf("soon"), "m"],
      ],
    };
  },

  Sales(s) {
    const sale = new Map((s.sales || []).map((x) => [x.id, x])),
      lines = (s.saleLines || [])
        .filter((l) => sale.has(l.sale_id))
        .sort(
          (a, b) =>
            String(sale.get(a.sale_id).created_at).localeCompare(String(sale.get(b.sale_id).created_at)) ||
            String(a.sale_id).localeCompare(String(b.sale_id)),
        );
    const cols = [
      col("no", "c"),
      col("date", "c"),
      col("receipt", "c"),
      col("sku"),
      col("name"),
      col("qty", "n"),
      col("unitPrice", "m"),
      col("lineTotal", "m"),
      col("vat", "m"),
      col("payment"),
    ];
    const n = cols.length,
      pay = (m) => t(m == "transfer" ? "xw.transfer" : "xw.cash");
    const group = (title, list) => {
      const rows = number(
        list.map((l) => {
          const x = sale.get(l.sale_id);
          return [
            dmyhm(x.created_at),
            saleNo(x),
            l.sku,
            l.name + (l.pack_qty ? ` (${+l.pack_qty} × ${l.pack_name})` : ""),
            +l.qty,
            +l.unit_price,
            +l.line_total,
            // The sale's VAT shared out over its lines, so the lines add up to it.
            +x.subtotal ? Math.round(((+x.vat || 0) * l.line_total * 100) / x.subtotal) / 100 : 0,
            pay(x.method),
          ];
        }),
      );
      return { title, rows, total: totalRow(n, t("rp.total"), { 7: sum(rows, 7), 8: sum(rows, 8) }) };
    };
    const paid = lines.filter((l) => sale.get(l.sale_id).status != "void"),
      voided = lines.filter((l) => sale.get(l.sale_id).status == "void"),
      groups = [group(t("rp.paid"), paid)];
    if (voided.length) groups.push(group(t("rp.voided"), voided));
    const ok = (s.sales || []).filter((x) => x.status != "void"),
      bad = (s.sales || []).filter((x) => x.status == "void"),
      add = (list, f) => list.reduce((a, x) => a + (+x[f] || 0), 0),
      dates = (s.sales || []).map((x) => x.created_at).sort();
    return {
      period: dates.length ? `${dmy(dates[0])} – ${dmy(dates[dates.length - 1])}` : "",
      tables: [{ cols, groups, grand: null }],
      summary: [
        [t("rp.s.receipts"), ok.length, "n"],
        [t("rp.s.subtotal"), add(ok, "subtotal"), "m"],
        [t("rp.s.discount"), add(ok, "discount"), "m"],
        [t("rp.s.net"), add(ok, "total"), "m"],
        [t("rp.s.vat"), add(ok, "vat"), "m"],
        [t("rp.s.cash"), add(ok.filter((x) => x.method != "transfer"), "total"), "m"],
        [t("rp.s.transfer"), add(ok.filter((x) => x.method == "transfer"), "total"), "m"],
        [t("rp.s.voided", { n: bad.length }), add(bad, "total"), "m"],
      ],
    };
  },

  Orders(s) {
    const byId = new Map(s.items.map((i) => [i.id, i])),
      cols = [col("no", "c"), col("date", "c"), col("sku"), col("name"), col("qty", "n"), col("unit", "c"), col("party"), col("status")];
    const n = cols.length,
      sorted = [...s.orders].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    const groups = [
      ["in", t("rp.inbound")],
      ["out", t("rp.outbound")],
    ]
      .map(([type, title]) => {
        const list = sorted.filter((o) => (o.type == "in") == (type == "in")),
          rows = number(
            list.map((o) => {
              const i = byId.get(o.item_id);
              return [dmy(o.created_at), i?.sku || "", i?.name || "", +o.qty, i?.unit || "", o.party || "", t(o.status == "done" ? "xw.done" : "xw.pending")];
            }),
          );
        return {
          title,
          rows,
          total: totalRow(n, t("rp.total"), { 4: oneUnit(list.map((o) => byId.get(o.item_id)?.unit)) ? sum(rows, 4) : null }),
        };
      })
      .filter((g) => g.rows.length);
    const waiting = (type) => s.orders.filter((o) => (o.type == "in") == (type == "in") && o.status != "done").length;
    return {
      tables: [{ cols, groups, grand: null }],
      summary: [
        [t("rp.s.pendingIn"), waiting("in"), "n"],
        [t("rp.s.pendingOut"), waiting("out"), "n"],
      ],
    };
  },

  // Like a stock card: totals per product first, then every movement.
  Movements(s) {
    const bySku = new Map(s.items.map((i) => [i.sku, i])),
      list = [...s.movements].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))),
      inQ = (m) => (m.type == "in" ? Math.abs(+m.qty) : 0),
      outQ = (m) => (m.type == "in" ? 0 : Math.abs(+m.qty)),
      unitOf = (sku) => bySku.get(sku)?.unit || "",
      units = list.map((m) => unitOf(m.sku)),
      same = oneUnit(units);
    const per = new Map();
    for (const m of list) {
      const r = per.get(m.sku) || { sku: m.sku, name: bySku.get(m.sku)?.name || "", in: 0, out: 0 };
      r.in += inQ(m);
      r.out += outQ(m);
      per.set(m.sku, r);
    }
    const sumCols = [col("no", "c"), col("sku"), col("name"), col("unit", "c"), col("in", "n"), col("out", "n"), col("net", "n")],
      sumRows = number([...per.values()].sort(byName).map((r) => [r.sku, r.name, unitOf(r.sku), r.in, r.out, r.in - r.out]));
    const detCols = [
        col("no", "c"),
        col("date", "c"),
        col("sku"),
        col("name"),
        col("in", "n"),
        col("out", "n"),
        col("note"),
        col("reason"),
        col("user"),
      ],
      detRows = number(
        list.map((m) => [
          dmyhm(m.created_at),
          m.sku,
          bySku.get(m.sku)?.name || "",
          inQ(m) || "",
          outQ(m) || "",
          m.note || "",
          reasonLabel(m.reason_code, m.reason_text),
          whoOf(s, m.created_by),
        ]),
      );
    const tot = (rows, cols, n) => totalRow(n, t("rp.total"), Object.fromEntries(cols.map((i) => [i, same ? sum(rows, i) : null])));
    return {
      period: list.length ? `${dmy(list[0].created_at)} – ${dmy(new Date())}` : "",
      tables: [
        { title: t("rp.byProduct"), cols: sumCols, groups: [{ title: "", rows: sumRows, total: tot(sumRows, [4, 5, 6], 7) }], grand: null },
        { title: t("rp.detail"), cols: detCols, groups: [{ title: "", rows: detRows, total: tot(detRows, [4, 5], 9) }], grand: null },
      ],
      summary: [[t("rp.s.moves"), list.length, "n"]],
    };
  },
};

/** The report for one export set (keys as in export.js SETS). */
export function report(s, k, now = new Date()) {
  const r = BUILD[k](s),
    ymd = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}`;
  return {
    key: k,
    shop: s.shop?.name || "",
    title: t("rp.title." + k),
    date: dmy(now),
    no: `${PREFIX[k]}-${ymd}`,
    by: s.user?.email || "",
    period: "",
    ...r,
    sign: SIGN[k].map((x) => t("rp.sign." + x)),
  };
}

/** 1,234 or 1,234.5: every report writes numbers the same way, whatever the app language. */
export const fmtNum = (v, type) =>
  v === "" || v == null ? "" : typeof v != "number" ? String(v) : v.toLocaleString("en-US", { maximumFractionDigits: type == "m" ? 2 : 3 });

export const NUM = (type) => type == "n" || type == "m";
/** How many columns the "Total" label spans: up to the first figure. */
export const labelSpan = (row) => {
  const i = row.findIndex((v, j) => j > 0 && v !== "" && v != null);
  return i < 0 ? row.length : i;
};


// ---------- Excel ----------

/** The report as a sheet: rows of styled cells, merges, widths. */
export function reportSheet(R) {
  const n = Math.max(...R.tables.map((tb) => tb.cols.length)),
    rows = [],
    merges = [],
    heights = {};
  let titleRows = "";
  const put = (cells, ht) => {
    rows.push(cells);
    if (ht) heights[rows.length] = ht;
    return rows.length;
  };
  // A value across columns a..b, with the style on every cell so borders show.
  const span = (cells, v, s, a, b) => {
    for (let c = a; c <= b; c++) cells[c] = { v: c == a ? v : "", s };
    if (b > a) merges.push(`${colName(a)}${rows.length + 1}:${colName(b)}${rows.length + 1}`);
    return cells;
  };
  const half = Math.max(1, Math.floor(n / 2));
  put(span([], R.shop, "shop", 0, n - 1), 20);
  put(span([], R.title, "title", 0, n - 1), 26);
  put(span(span([], R.by ? `${t("rp.by")}: ${R.by}` : "", "small", 0, half - 1), `${t("rp.date")}: ${R.date}`, "right", half, n - 1));
  put(span(span([], R.period ? `${t("rp.period")}: ${R.period}` : "", "small", 0, half - 1), `${t("rp.no")}: ${R.no}`, "right", half, n - 1));
  put([]);
  const fig = (v, type, tot) => {
    if (v === "" || v == null || !NUM(type) || typeof v != "number") return { v, s: tot ? "totLabel" : type == "c" ? "center" : "cell" };
    const int = Number.isInteger(v);
    return { v, s: tot ? (int ? "totInt" : "totDec") : int ? "int" : "dec" };
  };
  const totalLine = (r, cols) => {
    const k = labelSpan(r),
      cells = span([], r[0], "totLabel", 0, k - 1);
    for (let c = k; c < cols.length; c++) cells[c] = fig(r[c], cols[c].type, true);
    put(cells);
  };
  for (const tb of R.tables) {
    const m = tb.cols.length;
    if (tb.title) put([{ v: tb.title, s: "bold" }], 18);
    const h = put(tb.cols.map((c) => ({ v: c.h, s: "head" })), 30);
    titleRows ||= `${h}:${h}`;
    for (const g of tb.groups) {
      if (g.title) put(span([], g.title, "group", 0, m - 1));
      for (const r of g.rows) put(r.map((v, c) => fig(v, tb.cols[c].type, false)));
      if (g.total) totalLine(g.total, tb.cols);
    }
    if (tb.grand) totalLine(tb.grand, tb.cols);
    put([]);
  }
  // Summary on the right, like the totals block of a paper form.
  const la = Math.max(0, n - 4);
  put([{ v: t("rp.summary"), s: "bold" }]);
  for (const [label, v, type] of R.summary) {
    const cells = span([], label, "sumLabel", la, n - 2);
    cells[n - 1] = { v, s: Number.isInteger(v) ? "sumInt" : type == "m" || type == "n" ? "sumDec" : "plain" };
    put(cells);
  }
  put([]);
  put([]);
  // Column widths from what is in the tables.
  const widths = Array.from({ length: n }, (_, c) => {
    let w = 4;
    for (const tb of R.tables) {
      if (!tb.cols[c]) continue;
      w = Math.max(w, Math.min(24, tb.cols[c].h.length * 0.9));
      for (const g of tb.groups) for (const r of g.rows) w = Math.max(w, fmtNum(r[c], tb.cols[c].type).length * 1.1);
    }
    return Math.round(Math.min(42, w + 2));
  });
  widths[0] = Math.max(widths[0], 6);
  // Signatures spread over the width: role, room to sign, line, name, date.
  // Each block gets about the same width on paper, and at least 30 characters,
  // so a report with few columns is widened rather than its signatures cut.
  const k = R.sign.length,
    need = 30 * k,
    have = widths.reduce((a, w) => a + w, 0);
  if (have < need) for (let c = 0; c < n; c++) widths[c] = Math.round((widths[c] * need) / have);
  const total = widths.reduce((a, w) => a + w, 0),
    starts = [0];
  for (let i = 1, acc = 0, c = 0; i < k; i++) {
    while (c < n - 1 && acc + widths[c] / 2 < (total * i) / k) acc += widths[c++];
    starts.push(Math.max(c, starts[i - 1] + 1));
  }
  const seg = (i) => [starts[i], (i + 1 < k ? starts[i + 1] : n) - 1];
  const signRow = (text, s, ht) => {
    const cells = [];
    R.sign.forEach((role, i) => {
      const [a, b] = seg(i);
      span(cells, typeof text == "function" ? text(role) : text, s, a, Math.max(a, b));
    });
    put(cells, ht);
  };
  signRow((r) => r, "signRole");
  signRow("", "signLine", 42);
  signRow("..........................", "signLine");
  signRow(t("rp.signName"), "signLine");
  signRow(t("rp.signDate"), "signLine");
  return { name: "Report", rows, merges, heights, widths, grid: false, titleRows };
}

/** The plain table as a sheet: the importer reads this one back. */
export const dataSheet = (r) => ({
  name: "Data",
  rows: r.map((row, i) => row.map((v) => (i ? v : { v, s: "bold" }))),
  widths: r[0].map((h) => Math.max(10, Math.min(30, String(h).length + 4))),
});

