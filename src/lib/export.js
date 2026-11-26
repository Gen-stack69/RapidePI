// PDF / Excel / CSV / ZIP exports. Heavy libraries load only when used.
import { toCsv } from "./csv.js";
import { $, E, dt, download } from "./util.js";
import { t, lang } from "../i18n/index.js";
import { saleNo } from "../data/apply.js";
import { today as localToday } from "./expiry.js";
import { report, fmtNum, NUM, labelSpan, reportSheet, dataSheet } from "./report.js";
import { xlsxBlob } from "./xlsxw.js";
import regularUrl from "../assets/fonts/pdf-regular.ttf?url";
import boldUrl from "../assets/fonts/pdf-bold.ttf?url";

// CSV stays a plain table with English headers: csvToItems() matches these
// header names when a shop re-imports its own export. Excel, PDF and print are
// for reading: they are laid out as a form (lib/report.js) in the app
// language, and the Excel file carries the plain table too, on a sheet called
// "Data" that the importer reads.
export const SETS = ["Inventory", "Sales", "Expiry", "Orders", "Movements"];

export const sets = (s) => {
  const bySku = new Map(s.items.map((i) => [i.id, i.sku])),
    sku = (id) => bySku.get(id) ?? "",
    byId = new Map(s.items.map((i) => [i.id, i])),
    next = new Map();
  for (const l of s.lots || []) if (!next.has(l.item_id)) next.set(l.item_id, l.expiry);
  const sale = new Map((s.sales || []).map((x) => [x.id, x]));
  return {
    Inventory: [
      [
        "SKU",
        "Name",
        "Category",
        "Barcode",
        "Qty",
        "Min",
        "Cost (LAK)",
        "Price (LAK)",
        "Wholesale (LAK)",
        "Wholesale min",
        "Value (LAK)",
        // Appended, never inserted: older exports must still import.
        "Kind",
        "Next expiry",
        "Unit",
      ],
      ...s.items.map((i) => [
        i.sku,
        i.name,
        i.category,
        i.barcode ?? "",
        +i.qty,
        +i.min_qty,
        +i.cost,
        +i.price || 0,
        +i.price_wholesale || 0,
        +i.wholesale_min_qty || 0,
        i.qty * i.cost,
        i.kind == "consumable" ? "consumable" : "durable",
        next.get(i.id) || "",
        i.unit || "",
      ]),
    ],
    Sales: [
      // Pack and VAT appended, never inserted. VAT is the sale's VAT shared out
      // over its lines, so a sale's lines add up to its VAT.
      ["Date", "Receipt", "SKU", "Name", "Qty", "Unit price (LAK)", "Wholesale", "Line total (LAK)", "Method", "Status", "Pack", "VAT (LAK)"],
      ...(s.saleLines || [])
        .filter((l) => sale.has(l.sale_id))
        .map((l) => {
          const x = sale.get(l.sale_id);
          return [
            dt(x.created_at),
            saleNo(x),
            l.sku,
            l.name,
            +l.qty,
            +l.unit_price,
            l.wholesale ? "yes" : "",
            +l.line_total,
            x.method,
            x.status,
            l.pack_qty ? `${+l.pack_qty} × ${l.pack_name} (${+l.pack_size})` : "",
            +x.subtotal ? Math.round(((+x.vat || 0) * l.line_total * 100) / x.subtotal) / 100 : 0,
          ];
        }),
    ],
    Expiry: [
      ["SKU", "Name", "Expiry", "Qty", "Value (LAK)", "Batch"],
      ...(s.lots || [])
        .filter((l) => byId.has(l.item_id))
        .map((l) => {
          const i = byId.get(l.item_id);
          return [i.sku, i.name, l.expiry, +l.qty, l.qty * i.cost, l.batch || ""];
        }),
    ],
    Orders: [
      ["Date", "Type", "SKU", "Qty", "Party", "Status"],
      ...s.orders.map((o) => [
        dt(o.created_at),
        o.type == "in" ? "Inbound" : "Outbound",
        sku(o.item_id),
        +o.qty,
        o.party,
        o.status == "done" ? "Done" : "Pending",
      ]),
    ],
    Movements: [
      ["Date", "SKU", "Type", "Qty", "Note"],
      ...s.movements.map((m) => [dt(m.created_at), m.sku, m.type == "in" ? "In" : "Out", +m.qty, m.note]),
    ],
  };
};

// The PDF font: Phetsarath for Lao, DejaVu for Latin (scripts/make-pdf-font.py).
let fontData = null;
function pdfFont() {
  const b64 = async (url) => {
    const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
    let s = "";
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  };
  return (fontData ||= Promise.all([b64(regularUrl), b64(boldUrl)]).catch((e) => {
    fontData = null;
    throw e;
  }));
}

// The shop's own date: in Laos the UTC date is still yesterday before 7 am.
const today = () => localToday();
const fileName = (s, k, ext) =>
  `${k}-${String(s.shop?.name || "shop")
    .replace(/[\\/:*?"<>|\s]+/g, "-")
    .slice(0, 40)}-${today()}.${ext}`;
// ---------- PDF ----------

async function reportPdf(R, name) {
  const [{ jsPDF }, { autoTable }, [regular, bold]] = await Promise.all([import("jspdf"), import("jspdf-autotable"), pdfFont()]);
  const d = new jsPDF({ orientation: "landscape" });
  d.addFileToVFS("rp-regular.ttf", regular);
  d.addFont("rp-regular.ttf", "RP", "normal");
  d.addFileToVFS("rp-bold.ttf", bold);
  d.addFont("rp-bold.ttf", "RP", "bold");
  const W = d.internal.pageSize.getWidth(),
    H = d.internal.pageSize.getHeight(),
    L = 14;
  d.setFont("RP", "bold");
  d.setFontSize(12);
  d.text(R.shop, L, 14);
  d.setFontSize(15);
  d.text(R.title, W / 2, 23, { align: "center" });
  d.setFont("RP", "normal");
  d.setFontSize(9);
  if (R.by) d.text(`${t("rp.by")}: ${R.by}`, L, 31);
  if (R.period) d.text(`${t("rp.period")}: ${R.period}`, L, 36);
  d.text(`${t("rp.date")}: ${R.date}`, W - L, 31, { align: "right" });
  d.text(`${t("rp.no")}: ${R.no}`, W - L, 36, { align: "right" });
  let y = 41;
  const base = { font: "RP", fontSize: 8.5, textColor: 20, lineColor: 140, lineWidth: 0.15, cellPadding: 1.6 },
    shade = 232;
  for (const tb of R.tables) {
    const m = tb.cols.length;
    if (tb.title) {
      d.setFont("RP", "bold");
      d.setFontSize(10);
      d.text(tb.title, L, y + 3);
      y += 6;
    }
    const line = (r, tot) => {
      if (!tot) return r.map((v, c) => fmtNum(v, tb.cols[c].type));
      const k = labelSpan(r);
      return [
        { content: r[0], colSpan: k, styles: { fontStyle: "bold", fillColor: shade, halign: "left" } },
        ...r.slice(k).map((v, i) => ({ content: fmtNum(v, tb.cols[k + i].type), styles: { fontStyle: "bold", fillColor: shade } })),
      ];
    };
    const body = [];
    for (const g of tb.groups) {
      if (g.title) body.push([{ content: g.title, colSpan: m, styles: { fontStyle: "bold", fillColor: 245, halign: "left" } }]);
      for (const r of g.rows) body.push(line(r, false));
      if (g.total) body.push(line(g.total, true));
    }
    if (tb.grand) body.push(line(tb.grand, true));
    autoTable(d, {
      head: [tb.cols.map((c) => c.h)],
      body,
      startY: y,
      margin: { left: L, right: L, bottom: 14 },
      styles: base,
      headStyles: { ...base, fontStyle: "bold", fillColor: shade, textColor: 0, halign: "center", valign: "middle" },
      columnStyles: Object.fromEntries(tb.cols.map((c, i) => [i, { halign: NUM(c.type) ? "right" : c.type == "c" ? "center" : "left" }])),
    });
    y = (d.lastAutoTable?.finalY ?? y) + 7;
  }
  autoTable(d, {
    head: [[t("rp.summary"), ""]],
    body: R.summary.map(([l, v, type]) => [l, fmtNum(v, type)]),
    startY: y,
    margin: { left: W - L - 110, right: L, bottom: 14 },
    tableWidth: 110,
    theme: "plain",
    styles: { font: "RP", fontSize: 9, cellPadding: 0.8, textColor: 20 },
    headStyles: { font: "RP", fontStyle: "bold" },
    columnStyles: { 1: { halign: "right", fontStyle: "bold" } },
  });
  // Signatures under the summary, or on a new page when they would not fit.
  y = (d.lastAutoTable?.finalY ?? y) + 8;
  if (y + 26 > H - 10) {
    d.addPage();
    y = 20;
  }
  const k = R.sign.length;
  R.sign.forEach((role, i) => {
    const x = L + ((W - 2 * L) * (i + 0.5)) / k;
    d.setFont("RP", "bold");
    d.setFontSize(10);
    d.text(role, x, y, { align: "center" });
    d.setFont("RP", "normal");
    d.setFontSize(9);
    d.text("..........................", x, y + 15, { align: "center" });
    d.text(t("rp.signName"), x, y + 20, { align: "center" });
    d.text(t("rp.signDate"), x, y + 25, { align: "center" });
  });
  const pages = d.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    d.setPage(p);
    d.setFont("RP", "normal");
    d.setFontSize(8);
    d.text(`${R.no} · ${p} / ${pages}`, W / 2, H - 7, { align: "center" });
  }
  d.save(name);
}

// ---------- print ----------

export const reportHtml = (R) => {
  const cls = (type) => (NUM(type) ? ' class="n"' : type == "c" ? ' class="c"' : "");
  const tables = R.tables
    .map((tb) => {
      const m = tb.cols.length,
        tot = (r) => {
          const k = labelSpan(r);
          return `<tr class="tot"><td colspan="${k}">${E(r[0])}</td>${r
            .slice(k)
            .map((v, i) => `<td${cls(tb.cols[k + i].type)}>${E(fmtNum(v, tb.cols[k + i].type))}</td>`)
            .join("")}</tr>`;
        };
      const body = tb.groups
        .map(
          (g) =>
            (g.title ? `<tr class="grp"><td colspan="${m}">${E(g.title)}</td></tr>` : "") +
            g.rows.map((r) => `<tr>${r.map((v, c) => `<td${cls(tb.cols[c].type)}>${E(fmtNum(v, tb.cols[c].type))}</td>`).join("")}</tr>`).join("") +
            (g.total ? tot(g.total) : ""),
        )
        .join("");
      return `${tb.title ? `<h5>${E(tb.title)}</h5>` : ""}<table><thead><tr>${tb.cols
        .map((c) => `<th>${E(c.h)}</th>`)
        .join("")}</tr></thead><tbody>${body}${tb.grand ? tot(tb.grand) : ""}</tbody></table>`;
    })
    .join("");
  return `<div class="report"><div class="rh"><b class="shop">${E(R.shop)}</b><h4>${E(R.title)}</h4><div class="meta"><span>${
    R.by ? E(`${t("rp.by")}: ${R.by}`) : ""
  }${R.period ? "<br>" + E(`${t("rp.period")}: ${R.period}`) : ""}</span><span class="r">${E(`${t("rp.date")}: ${R.date}`)}<br>${E(
    `${t("rp.no")}: ${R.no}`,
  )}</span></div></div>${tables}<table class="sum"><thead><tr><th colspan="2">${E(t("rp.summary"))}</th></tr></thead><tbody>${R.summary
    .map(([l, v, type]) => `<tr><td>${E(l)}</td><td class="n">${E(fmtNum(v, type))}</td></tr>`)
    .join("")}</tbody></table><div class="sign">${R.sign
    .map(
      (r) =>
        `<div><b>${E(r)}</b><span>....................................</span><span>${E(t("rp.signName"))}</span><span>${E(t("rp.signDate"))}</span></div>`,
    )
    .join("")}</div></div>`;
};

/** Print a set on paper (the print dialog can also save it as a PDF). */
export async function printSet(s, k) {
  // The print font loads only when first used: wait for it, or the first
  // printout comes out in the fallback font.
  await Promise.all([
    document.fonts.load('10px "RAPIDE POS-IMS PDF"'),
    document.fonts.load('bold 10px "RAPIDE POS-IMS PDF"'),
  ]).catch(() => {});
  $("#print").innerHTML = reportHtml(report(s, k));
  document.body.classList.add("printing");
  const done = () => {
    document.body.classList.remove("printing");
    removeEventListener("afterprint", done);
  };
  addEventListener("afterprint", done);
  print();
  setTimeout(done, 1500); // browsers without afterprint
}

export async function exportSet(s, k, f) {
  if (f == "print") return printSet(s, k);
  if (f == "csv") return download(new Blob(["﻿" + toCsv(sets(s)[k])], { type: "text/csv" }), fileName(s, k, "csv"));
  const R = report(s, k);
  if (f == "xlsx")
    return download(
      await xlsxBlob([reportSheet(R), dataSheet(sets(s)[k])], lang() == "lo" ? "Phetsarath OT" : "Calibri"),
      fileName(s, k, "xlsx"),
    );
  return reportPdf(R, fileName(s, k, "pdf"));
}

export async function exportZip(s) {
  const { default: JSZip } = await import("jszip");
  const z = new JSZip(),
    all = sets(s);
  for (const k in all) z.file(k + ".csv", "﻿" + toCsv(all[k]));
  // Every report as a printed form, one sheet each, for reading and printing.
  z.file(
    "Reports.xlsx",
    await xlsxBlob(
      SETS.map((k) => ({ ...reportSheet(report(s, k)), name: t("rp.title." + k) })),
      lang() == "lo" ? "Phetsarath OT" : "Calibri",
    ),
  );
  z.file(
    "backup.json",
    JSON.stringify(
      {
        shop: s.shop,
        items: s.items,
        packs: s.packs,
        customers: s.customers,
        lots: s.lots,
        orders: s.orders,
        movements: s.movements,
        sales: s.sales,
        sale_lines: s.saleLines,
        settings: s.settings,
        exported_at: new Date().toISOString(),
      },
      null,
      1,
    ),
  );
  const day = today(),
    shop = String(s.shop?.name || "shop")
      .replace(/[\\/:*?"<>|\s]+/g, "-")
      .slice(0, 40);
  download(await z.generateAsync({ type: "blob" }), `RAPIDE-POS-IMS-${shop}-${day}.zip`);
}
