// A small .xlsx writer with cell styles (bold, borders, shading, number
// formats, merged cells, print setup). The free SheetJS build cannot write
// styles, and a printed form needs them. Built on JSZip, already used for the
// backup .zip.
//
// sheet = { name, rows: [[cell]], merges: ["A1:F1"], widths: [chars], heights: {row: pt},
//           grid: bool, titleRows: "6:6" }
// cell  = a value, or { v, s } with s one of the style names in XF below.
// Numbers stay numbers in Excel (they add up and sort); text is stored inline.

// [font, fill, border, numFmt, horizontal, wrap]
const XF = {
  plain: [0, 0, 0, 0],
  title: [2, 0, 0, 0, "center"],
  shop: [3, 0, 0, 0],
  small: [4, 0, 0, 0],
  smallRight: [4, 0, 0, 0, "right"],
  right: [0, 0, 0, 0, "right"],
  bold: [1, 0, 0, 0],
  head: [1, 2, 1, 0, "center", 1],
  cell: [0, 0, 1, 0],
  center: [0, 0, 1, 0, "center"],
  int: [0, 0, 1, 164],
  dec: [0, 0, 1, 165],
  group: [1, 3, 1, 0],
  totLabel: [1, 2, 1, 0],
  totInt: [1, 2, 1, 164],
  totDec: [1, 2, 1, 165],
  sumLabel: [0, 0, 0, 0, "right"],
  sumInt: [1, 0, 0, 164],
  sumDec: [1, 0, 0, 165],
  signRole: [1, 0, 0, 0, "center"],
  signLine: [0, 0, 0, 0, "center"],
};
const NAMES = Object.keys(XF);
const IDX = Object.fromEntries(NAMES.map((n, i) => [n, i]));

const esc = (s) =>
  String(s)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** 0 -> A, 25 -> Z, 26 -> AA */
export const colName = (i) => {
  let s = "";
  for (i++; i; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
};

function styles(font) {
  const f = (extra, size, color = "") => `<font>${extra}<sz val="${size}"/>${color}<name val="${esc(font)}"/></font>`;
  const xf = NAMES.map((n) => {
    const [fo, fi, bo, nf, h, wrap] = XF[n];
    const al = h || wrap ? `<alignment vertical="center"${h ? ` horizontal="${h}"` : ""}${wrap ? ' wrapText="1"' : ""}/>` : '<alignment vertical="center"/>';
    return `<xf numFmtId="${nf}" fontId="${fo}" fillId="${fi}" borderId="${bo}" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">${al}</xf>`;
  }).join("");
  const side = (k) => `<${k} style="thin"><color rgb="FF7F7F7F"/></${k}>`;
  const fill = (rgb) => `<fill><patternFill patternType="solid"><fgColor rgb="${rgb}"/><bgColor indexed="64"/></patternFill></fill>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0"/><numFmt numFmtId="165" formatCode="#,##0.0##"/></numFmts><fonts count="5">${f("", 11)}${f("<b/>", 11)}${f("<b/>", 15)}${f("<b/>", 13)}${f("", 9, '<color rgb="FF555555"/>')}</fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>${fill("FFE7E6E6")}${fill("FFF5F5F5")}</fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border>${side("left")}${side("right")}${side("top")}${side("bottom")}<diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${NAMES.length}">${xf}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
}

function sheetXml(sh) {
  const rows = sh.rows
    .map((r, ri) => {
      const n = ri + 1,
        ht = sh.heights?.[n],
        cells = r
          .map((c, ci) => {
            if (c == null || c === "") return "";
            const o = typeof c == "object" ? c : { v: c },
              ref = colName(ci) + n,
              s = IDX[o.s ?? "plain"] ?? 0;
            if (o.v == null || o.v === "") return `<c r="${ref}" s="${s}"/>`;
            if (typeof o.v == "number" && Number.isFinite(o.v)) return `<c r="${ref}" s="${s}"><v>${o.v}</v></c>`;
            return `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${esc(o.v)}</t></is></c>`;
          })
          .join("");
      return `<row r="${n}"${ht ? ` ht="${ht}" customHeight="1"` : ""}>${cells}</row>`;
    })
    .join("");
  const cols = (sh.widths || []).map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("");
  const merges = sh.merges?.length ? `<mergeCells count="${sh.merges.length}">${sh.merges.map((m) => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>` : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><sheetViews><sheetView workbookViewId="0"${sh.grid === false ? ' showGridLines="0"' : ""}/></sheetViews><sheetFormatPr defaultRowHeight="15"/>${cols ? `<cols>${cols}</cols>` : ""}<sheetData>${rows}</sheetData>${merges}<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.6" header="0.3" footer="0.3"/><pageSetup paperSize="9" orientation="${sh.portrait ? "portrait" : "landscape"}" fitToWidth="1" fitToHeight="0"/><headerFooter><oddFooter>&amp;C&amp;P / &amp;N</oddFooter></headerFooter></worksheet>`;
}

/** The .xlsx file as a Blob. font: the font name for every cell. */
export async function xlsxBlob(sheets, font = "Calibri") {
  const { default: JSZip } = await import("jszip");
  const z = new JSZip(),
    S = sheets.map((sh, i) => ({ ...sh, id: i + 1, name: String(sh.name).replace(/[\\/?*[\]:]/g, " ").slice(0, 31) }));
  z.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${S.map(
      (s) => `<Override PartName="/xl/worksheets/sheet${s.id}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    ).join("")}</Types>`,
  );
  z.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  const titles = S.filter((s) => s.titleRows)
    .map((s) => `<definedName name="_xlnm.Print_Titles" localSheetId="${s.id - 1}">'${s.name.replace(/'/g, "''")}'!$${s.titleRows.replace(":", ":$")}</definedName>`)
    .join("");
  z.file(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${S.map(
      (s) => `<sheet name="${esc(s.name)}" sheetId="${s.id}" r:id="rId${s.id}"/>`,
    ).join("")}</sheets>${titles ? `<definedNames>${titles}</definedNames>` : ""}</workbook>`,
  );
  z.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${S.map(
      (s) => `<Relationship Id="rId${s.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${s.id}.xml"/>`,
    ).join("")}<Relationship Id="rId${S.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  );
  z.file("xl/styles.xml", styles(font));
  for (const s of S) z.file(`xl/worksheets/sheet${s.id}.xml`, sheetXml(s));
  return z.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}
