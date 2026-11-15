// Payment by bank QR at the till.
//
// The owner saves the shop's own bank QR once (a photo or screenshot of the
// sticker their bank gave them). When the customer pays by transfer, the till
// shows that QR and the customer scans it with their bank app.
//
// Lao bank QR (LAO QR / LAPNet, as used by BCEL One, LDB, JDB...) follows the
// international EMVCo merchant QR format: fields written as a 2-digit id, a
// 2-digit length and the value, ending with a checksum in field 63. When the
// shop's QR is in that format and in kip (field 53 = 418), the total is
// written into field 54 and the checksum recomputed, so the customer's app
// opens with the amount filled in. Anything else is shown exactly as scanned
// and the customer types the amount.
//
// No bank is contacted: the cashier sees the payment on the customer's phone
// (or the shop's bank app) and then taps Charge, as with any transfer.
import qrcode from "qrcode-generator";

const LAK = "418";

/** CRC-16/CCITT-FALSE, the checksum EMVCo QR codes end with, as 4 hex digits. */
export function crc16(s) {
  let crc = 0xffff;
  for (const b of new TextEncoder().encode(s)) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

/** The fields of an EMVCo QR, in order, or null when it isn't one (or its checksum is wrong). */
export function parseEmv(payload) {
  const s = String(payload || "");
  const fields = [];
  let i = 0;
  while (i < s.length) {
    const id = s.slice(i, i + 2),
      len = s.slice(i + 2, i + 4);
    if (!/^\d\d$/.test(id) || !/^\d\d$/.test(len)) return null;
    const value = s.slice(i + 4, i + 4 + +len);
    if (value.length != +len) return null;
    fields.push({ id, value });
    i += 4 + +len;
  }
  const last = fields.at(-1);
  if (fields[0]?.id != "00" || last?.id != "63" || last.value.length != 4) return null;
  if (crc16(s.slice(0, -4)) != last.value.toUpperCase()) return null;
  return fields;
}

const field = (id, value) => id + String(value.length).padStart(2, "0") + value;
const get = (fields, id) => fields?.find((f) => f.id == id)?.value;

/** What the settings screen says about a saved QR. */
export function describe(payload) {
  const f = parseEmv(payload);
  return {
    emv: !!f,
    // The amount can only be filled in for a kip QR.
    amountable: !!f && get(f, "53") == LAK,
    merchant: (f && (get(f, "59") || "").trim()) || "",
  };
}

/** The shop's QR with `kip` filled in, or null when this QR can't carry an amount. */
export function withAmount(payload, kip) {
  const f = parseEmv(payload);
  const amount = Math.round(+kip);
  if (!f || get(f, "53") != LAK || !Number.isFinite(amount) || amount <= 0 || String(amount).length > 13) return null;
  // 00 first, 63 last; the amount goes right after the currency, where it belongs.
  const out = f
    .filter((x) => x.id != "54" && x.id != "63")
    .map((x) => (x.id == "01" ? { id: "01", value: "12" } : x)); // 12 = a QR for one payment
  out.splice(out.findIndex((x) => x.id == "53") + 1, 0, { id: "54", value: String(amount) });
  const body = out.map((x) => field(x.id, x.value)).join("") + "6304";
  return body + crc16(body);
}

/** What the till shows: the QR to scan, and whether the total is inside it. */
export function tillQr(payload, kip, putAmount = true) {
  const filled = putAmount ? withAmount(payload, kip) : null;
  return { text: filled || payload, hasAmount: !!filled };
}

// Bank QRs can hold Lao text (the shop's name), which must go in as UTF-8.
qrcode.stringToBytes = (s) => Array.from(new TextEncoder().encode(s));

/** An SVG of the QR: black on white, whatever the app's theme, with a quiet zone. */
export function qrSvg(text) {
  const qr = qrcode(0, "M");
  qr.addData(text, "Byte");
  qr.make();
  const n = qr.getModuleCount(),
    q = 4,
    size = n + q * 2;
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + q},${r + q}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
