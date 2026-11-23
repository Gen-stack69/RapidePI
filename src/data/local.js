// Local demo backend: no server, data lives in this browser's localStorage.
// It mirrors the rules in supabase/migrations (unique SKUs, no negative stock,
// orders complete once, auto-reorder, read-only after the trial, expiry lots
// taken soonest-first, sales priced from the product and sold all-or-nothing)
// so the app behaves the same before Supabase is set up.
import { state, emit, canWrite } from "./state.js";
import { err } from "../i18n/index.js";
import * as apply from "./apply.js";
import { costFields, packRow, custRow, newCustomers, amount, keepOwnerPrices } from "./fields.js";
import { toJpeg, dataUrl } from "../lib/photo.js";

const KEY = "rapidewms.local";
const uid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();

const SETTINGS = { low_alert: true, auto_reorder: false, vat_rate: 10, expiry_days: 30, rates: {}, pay_qr: null, pay_qr_amount: true };
let db = load();
function load() {
  let d = null;
  try {
    d = JSON.parse(localStorage[KEY]);
  } catch {}
  if (!d || !d.shops) d = { shops: [], settings: {} };
  // Data saved before expiry tracking and the till existed lacks these lists.
  for (const k of ["items", "orders", "movements", "lots", "ulots", "sales", "sale_lines", "packs", "pack_receipts", "customers"]) d[k] ||= [];
  // 018 kept a no-date number on the product; 019 makes it a batch of its own.
  for (const i of d.items)
    if (i.batch) {
      const free = +i.qty - [...d.lots, ...d.ulots].filter((l) => l.item_id == i.id).reduce((a, l) => a + +l.qty, 0);
      if (free > 0)
        d.ulots.push({ id: crypto.randomUUID(), shop_id: i.shop_id, item_id: i.id, expiry: null, qty: free, batch: i.batch, created_at: new Date().toISOString() });
      delete i.batch;
    }
  // ...and settings saved before VAT and expiry reminders.
  for (const id in d.settings) d.settings[id] = { ...SETTINGS, ...d.settings[id] };
  return d;
}
const persist = () => (localStorage[KEY] = JSON.stringify(db));

// Errors carry a translation key so the UI can show them in any language.
const fail = (code, params) => {
  throw err(code, params);
};
const writable = () => canWrite() || fail("err.readonly");
const ownerOnly = () => state.role == "owner" || fail("err.noPerm");
const shopId = () => state.shop.id;
const mine = (list) => list.filter((x) => x.shop_id == shopId());

export const configured = false;
export const signOut = async () => {};
// The demo keeps everything in this browser already: nothing to queue or send.
export const sync = async () => ({ sent: [], stopped: false });
export const openCached = async () => false;
export const myTill = () => null;
export const registerTill = async () => {};
export const retireTill = async () => {};
// Staff need accounts, so invites exist only with Supabase.
export const joinShop = async () => fail("err.noPerm");
export const createInvite = async () => fail("err.noPerm");
export const cancelInvite = async () => {};
export const removeMember = async () => {};
export const setMemberRole = async () => fail("err.noPerm");
// Paying for a plan needs the server (011_billing.sql): the demo has no billing.
export const requestPayment = async () => fail("err.billingDemo");
export const claimPayment = async () => fail("err.billingDemo");
export const cancelPayment = async () => {};
export const proofUrl = async () => fail("err.billingDemo");
export const adminPayments = async () => [];
export const approvePayment = async () => fail("err.billingDemo");
export const rejectPayment = async () => fail("err.billingDemo");
export const setBillingQr = async () => fail("err.billingDemo");
export const retryFailed = async () => {};
export const discardFailed = async () => {};

// ---------- session & shop ----------

export async function myShops() {
  return db.shops.map((s) => ({ role: "owner", shops: s }));
}

export async function createShop(name) {
  name = String(name || "").trim() || fail("err.needShopName");
  const s = {
    id: uid(),
    name,
    plan: "trial",
    plan_until: new Date(Date.now() + 14 * 864e5).toISOString(),
    created_at: nowIso(),
  };
  db.shops.push(s);
  db.settings[s.id] = { shop_id: s.id, ...SETTINGS };
  persist();
  return s.id;
}

export async function openShop(m) {
  state.shop = m.shops;
  state.role = m.role;
  localStorage.lastShop = state.shop.id;
  await reload();
}

export async function reload() {
  const since = Date.now() - 30 * 864e5,
    byNewest = (a, b) => (a.created_at < b.created_at ? 1 : -1);
  state.items = mine(db.items).sort((a, b) => a.sku.localeCompare(b.sku));
  state.orders = mine(db.orders).sort(byNewest);
  state.movements = mine(db.movements)
    .filter((m) => new Date(m.created_at) >= since)
    .sort(byNewest);
  state.lots = mine(db.lots).sort((a, b) => (a.expiry < b.expiry ? -1 : 1));
  state.ulots = mine(db.ulots).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  state.sales = mine(db.sales)
    .filter((x) => new Date(x.created_at) >= since)
    .sort(byNewest);
  const shown = new Set(state.sales.map((x) => x.id));
  state.saleLines = mine(db.sale_lines).filter((l) => shown.has(l.sale_id));
  state.packs = mine(db.packs);
  // Boxes still waiting to be counted, and the last 30 days' deliveries.
  state.packReceipts = mine(db.pack_receipts).filter((r) => r.size == null || new Date(r.created_at) >= since);
  state.customers = mine(db.customers).sort((a, b) => a.name.localeCompare(b.name));
  state.custTotals = {};
  for (const s of mine(db.sales)) {
    if (!s.customer_id || s.status != "paid") continue;
    const t = (state.custTotals[s.customer_id] ||= { customer_id: s.customer_id, visits: 0, total: 0, last_at: null });
    t.visits++;
    t.total += +s.total;
    if (!t.last_at || s.created_at > t.last_at) t.last_at = s.created_at;
  }
  state.settings = db.settings[shopId()];
  state.shop = db.shops.find((s) => s.id == shopId());
  emit();
}

const commit = async () => {
  persist();
  await reload();
};

// ---------- stock (mirrors adjust_stock / set_stock / complete_order) ----------

// The rules themselves live in apply.js, shared with the offline copy of a
// Supabase shop, so the demo and a real shop behave the same.
const ctx = () => ({ shopId: shopId(), userId: state.user?.id ?? null });
function moveRaw(itemId, delta, note, expiry = null, saleId = null) {
  writable();
  return apply.stockMove(db, ctx(), itemId, delta, note, expiry, saleId);
}

const adjustRaw = (itemId, delta, note, expiry) => moveRaw(itemId, delta, note, expiry);

const setStockRaw = (itemId, qty, note, expiry) => {
  const it = db.items.find((i) => i.id == itemId);
  if (it && +qty != +it.qty) adjustRaw(itemId, qty - it.qty, note, qty > it.qty ? expiry : null);
};

export async function adjust(id, delta, note = "manual", expiry = null) {
  adjustRaw(id, delta, note, expiry);
  await commit();
}

// Mirrors write_off_lot(): the whole lot leaves stock, logged as expired.
export async function writeOffLot(lotId, note = "expired") {
  writable();
  const lot = db.lots.find((l) => l.id == lotId && l.shop_id == shopId()) || fail("err.lotNotFound");
  apply.writeOff(db, ctx(), lot.item_id, lot.expiry, +lot.qty, note);
  await commit();
}

// ---------- items ----------

const skuTaken = (sku, exceptId) =>
  mine(db.items).some((i) => i.id != exceptId && i.sku.toLowerCase() == sku.toLowerCase());

export async function saveItem(id, f) {
  writable();
  const row = {
    sku: f.sku.trim(),
    name: f.name.trim(),
    category: f.category.trim() || "General",
    kind: f.kind == "consumable" ? "consumable" : "durable",
    barcode: f.barcode.trim() || f.sku.trim(),
    min_qty: amount(f.min_qty),
    price: amount(f.price),
    price_wholesale: amount(f.price_wholesale),
    wholesale_min_qty: amount(f.wholesale_min_qty),
    ...costFields(f),
    updated_at: nowIso(),
  };
  keepOwnerPrices(row, id, state.role == "owner");
  if (!row.sku || !row.name) fail("err.needSkuName");
  if (skuTaken(row.sku, id)) fail("err.dupSku");
  let it = id && db.items.find((i) => i.id == id && i.shop_id == shopId());
  if (it) Object.assign(it, row);
  else db.items.push((it = { id: uid(), shop_id: shopId(), qty: 0, created_at: nowIso(), ...row }));
  setStockRaw(it.id, Math.max(0, +f.qty || 0), id ? "edit" : "initial", f.expiry || null);
  if (f.batch) apply.setBatch(db, it.id, f.expiry || null, f.batch);
  await commit();
}

// ---------- product photos ----------
// The demo keeps a small copy (320 px) inside the browser's own storage, which
// only holds a few MB; the online version keeps photos on the server.

/** The picture to show for a product, or "". */
export const photoSrc = (it) => it?.photo || "";

/** Give a product a photo (a picture file), or take it away (null). */
export async function setItemPhoto(itemId, file) {
  writable();
  const it = db.items.find((i) => i.id == itemId && i.shop_id == shopId()) || fail("err.itemNotFound");
  it.photo = file ? await dataUrl(await toJpeg(file, 320, 0.7)) : null;
  try {
    await commit();
  } catch {
    // The browser's storage is full: keep the product, without the photo.
    it.photo = null;
    persist();
    fail("err.photoFull");
  }
}

export async function deleteItem(id) {
  writable();
  ownerOnly();
  db.items = db.items.filter((i) => !(i.id == id && i.shop_id == shopId()));
  db.orders = db.orders.filter((o) => o.item_id != id);
  db.lots = db.lots.filter((l) => l.item_id != id);
  db.ulots = db.ulots.filter((l) => l.item_id != id);
  db.packs = db.packs.filter((p) => p.item_id != id);
  db.pack_receipts = db.pack_receipts.filter((r) => r.item_id != id);
  db.sale_lines.forEach((l) => l.item_id == id && (l.item_id = null)); // receipts keep the name
  db.movements.forEach((m) => m.item_id == id && (m.item_id = null)); // history keeps the SKU
  await commit();
}

export async function importItems(list) {
  writable();
  let n = 0;
  for (const x of list) {
    if (skuTaken(x.sku)) continue;
    const it = {
      id: uid(),
      shop_id: shopId(),
      sku: x.sku,
      name: x.name,
      category: x.category || "General",
      kind: x.kind == "consumable" ? "consumable" : "durable",
      barcode: x.barcode || x.sku,
      qty: 0,
      min_qty: Math.max(0, +x.min_qty || 0),
      cost: Math.max(0, +x.cost || 0),
      price: Math.max(0, +x.price || 0),
      price_wholesale: Math.max(0, +x.price_wholesale || 0),
      wholesale_min_qty: Math.max(0, +x.wholesale_min_qty || 0),
      unit: String(x.unit || "").slice(0, 20),
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    db.items.push(it);
    if (x.qty > 0) setStockRaw(it.id, x.qty, "import", x.expiry || null);
    n++;
  }
  await commit();
  return n;
}

// ---------- orders ----------

export async function addOrder(o) {
  writable();
  if (!mine(db.items).some((i) => i.id == o.item_id)) fail("err.itemNotFound");
  if (!(o.qty > 0)) fail("err.qtyPositive");
  db.orders.push({
    id: uid(),
    shop_id: shopId(),
    item_id: o.item_id,
    type: o.type == "out" ? "out" : "in",
    qty: +o.qty,
    party: o.party || "",
    status: "pending",
    auto: false,
    created_at: nowIso(),
  });
  await commit();
}

export async function completeOrder(id, expiry = null, batch = "") {
  const o = db.orders.find((x) => x.id == id && x.shop_id == shopId()) || fail("err.orderNotFound");
  if (o.status != "pending") fail("err.orderDone");
  adjustRaw(o.item_id, o.type == "in" ? o.qty : -o.qty, "order", o.type == "in" ? expiry : null);
  if (o.type == "in" && batch) apply.setBatch(db, o.item_id, expiry || null, batch);
  o.status = "done";
  o.completed_at = nowIso();
  await commit();
}

export async function deleteOrder(id) {
  writable();
  ownerOnly();
  db.orders = db.orders.filter((o) => !(o.id == id && o.shop_id == shopId()));
  await commit();
}

// ---------- the till (mirrors create_sale / void_sale) ----------

// lines: [{ item_id, qty }]. Prices come from the product, never the till.
export async function createSale({ client_id, lines, discount = 0, method = "cash", paid = 0, customer_id = null }) {
  writable();
  // A failing line must leave stock and receipt numbers untouched: snapshot and roll back.
  const before = JSON.stringify(db);
  try {
    const shop = db.shops.find((x) => x.id == shopId()),
      known = db.sales.some((x) => x.shop_id == shopId() && x.client_id == client_id),
      lines0 = lines.map(({ item_id, qty, pack_id, expiry }) => ({ item_id, qty, pack_id, expiry })),
      sale = apply.sale(db, ctx(), {
        client_id,
        lines: lines0,
        discount,
        method,
        paid,
        customer_id,
        receipt_no: (shop.receipt_seq || 0) + 1,
      });
    if (!known) shop.receipt_seq = sale.receipt_no;
    await commit();
    return sale;
  } catch (e) {
    db = JSON.parse(before);
    throw e;
  }
}

export async function voidSale(id) {
  writable();
  ownerOnly();
  const sale = db.sales.find((x) => x.id == id && x.shop_id == shopId()) || fail("err.saleNotFound");
  if (sale.status == "void") fail("err.saleVoided");
  apply.voidSale(db, ctx(), sale);
  await commit();
}

// ---------- settings / danger zone ----------

export async function setSetting(k, v) {
  ownerOnly();
  db.settings[shopId()][k] = v;
  await commit();
}

export async function eraseAll() {
  ownerOnly();
  const keep = (x) => x.shop_id != shopId();
  db.items = db.items.filter(keep);
  db.orders = db.orders.filter(keep);
  db.movements = db.movements.filter(keep);
  db.lots = db.lots.filter(keep);
  db.ulots = db.ulots.filter(keep);
  db.sales = db.sales.filter(keep);
  db.sale_lines = db.sale_lines.filter(keep);
  db.packs = db.packs.filter(keep);
  db.pack_receipts = db.pack_receipts.filter(keep);
  db.customers = db.customers.filter(keep);
  db.shops.find((x) => x.id == shopId()).receipt_seq = 0;
  await commit();
}

// ---------- packs and expiring prices (mirror 006_units_vat.sql) ----------

// Staff add packs and change unpriced ones; the price is the owner's
// (packs_price_guard). The count changes through setPackSize, as on the server.
// f.fix: boxes already received at the old count to correct (0: none).
export async function savePack(id, itemId, f) {
  writable();
  const owner = state.role == "owner",
    row = packRow(f);
  if (row.barcode && mine(db.packs).some((p) => p.id != id && p.barcode == row.barcode)) fail("err.packBarcode");
  const p = id && db.packs.find((x) => x.id == id && x.shop_id == shopId());
  if (!owner && (p ? +p.price : row.price)) fail("err.noPerm");
  if (!owner) row.price = 0;
  const before = JSON.stringify(db);
  try {
    if (p) {
      const { size, ...rest } = row;
      if (size != null && size !== (p.size == null ? null : +p.size))
        apply.setPackSize(db, ctx(), p.id, size, amount(f.fix), owner);
      if (rest.price && p.size == null) fail("err.packCountFirst");
      Object.assign(p, rest);
    } else
      db.packs.push({ id: uid(), shop_id: shopId(), item_id: itemId, created_at: nowIso(), sized_at: row.size ? nowIso() : null, ...row });
  } catch (e) {
    db = JSON.parse(before);
    throw e;
  }
  await commit();
}
export async function deletePack(id) {
  writable();
  ownerOnly();
  db.packs = db.packs.filter((p) => !(p.id == id && p.shop_id == shopId()));
  db.pack_receipts = db.pack_receipts.filter((r) => r.pack_id != id);
  await commit();
}
/** Boxes of a pack arrive (mirrors receive_pack). */
export async function receivePack(packId, boxes, expiry = null) {
  writable();
  apply.receivePack(db, ctx(), packId, boxes, expiry);
  await commit();
}
/** How many are in one box; waiting boxes go into stock (mirrors set_pack_size). */
export async function setPackSize(packId, size, fixBoxes = 0) {
  writable();
  const before = JSON.stringify(db);
  try {
    apply.setPackSize(db, ctx(), packId, size, fixBoxes, state.role == "owner");
  } catch (e) {
    db = JSON.parse(before);
    throw e;
  }
  await commit();
}
export async function setLotPrice(itemId, expiry, price) {
  writable();
  ownerOnly();
  const lot = db.lots.find((l) => l.item_id == itemId && l.expiry == expiry && l.shop_id == shopId()) || fail("err.lotNotFound");
  lot.price = price;
  await commit();
}

/** A batch's batch / production number (mirror 016): add beside, or replace. */
export async function setLotBatch(itemId, expiry, batch, add = true) {
  writable();
  apply.setBatch(db, itemId, expiry, batch, add);
  await commit();
}

/** Correct a batch's expiry date; a batch already on that date takes it in (mirror 015). */
export async function changeLotExpiry(lotId, expiry) {
  writable();
  if (!expiry) fail("err.needDate");
  // a no-date batch (019) getting its date moves over to the dated ones
  const nd = db.ulots.find((l) => l.id == lotId && l.shop_id == shopId());
  if (nd) {
    db.ulots = db.ulots.filter((l) => l.id != lotId);
    const to = db.lots.find((l) => l.item_id == nd.item_id && l.expiry == expiry);
    if (to) {
      to.qty = +to.qty + +nd.qty;
      to.batch = apply.addBatch(to.batch, nd.batch);
    } else db.lots.push({ ...nd, expiry });
    return commit();
  }
  const lot = db.lots.find((l) => l.id == lotId && l.shop_id == shopId()) || fail("err.lotNotFound");
  if (lot.expiry == expiry) return;
  const to = db.lots.find((l) => l.item_id == lot.item_id && l.expiry == expiry && l.id != lot.id);
  if (to) {
    to.qty = +to.qty + +lot.qty;
    to.batch = apply.addBatch(to.batch, lot.batch);
    db.lots = db.lots.filter((l) => l.id != lot.id);
  } else lot.expiry = expiry;
  await commit();
}

/** Correct a no-date batch's number (mirror 019). */
export async function setUndatedBatch(lotId, batch) {
  writable();
  apply.setUndatedBatch(db, lotId, batch);
  await commit();
}

// ---------- customers and past sales (mirror 007_customers_import.sql) ----------

export async function saveCustomer(id, f) {
  writable();
  const row = custRow(f);
  if (row.phone && mine(db.customers).some((c) => c.id != id && c.phone == row.phone)) fail("err.custPhone");
  let c = id && db.customers.find((x) => x.id == id && x.shop_id == shopId());
  if (c) Object.assign(c, row);
  else db.customers.push((c = { id: uid(), shop_id: shopId(), created_at: nowIso(), ...row }));
  await commit();
  return c.id;
}
export async function deleteCustomer(id) {
  writable();
  ownerOnly();
  db.customers = db.customers.filter((c) => !(c.id == id && c.shop_id == shopId()));
  db.sales.forEach((s) => s.customer_id == id && (s.customer_id = null));
  await commit();
}
export async function importCustomers(list) {
  writable();
  const fresh = newCustomers(list, mine(db.customers));
  for (const c of fresh) db.customers.push({ id: uid(), shop_id: shopId(), created_at: nowIso(), ...c });
  await commit();
  return fresh.length;
}
export async function importSales(rows, progress = () => {}) {
  writable();
  ownerOnly();
  // All or nothing, like the server's transaction.
  const before = JSON.stringify(db),
    shop = db.shops.find((x) => x.id == shopId()),
    done = { added: 0, skipped: 0 };
  try {
    for (const r of rows)
      if (apply.importSale(db, ctx(), r, (shop.receipt_seq || 0) + 1)) {
        shop.receipt_seq = (shop.receipt_seq || 0) + 1;
        done.added++;
      } else done.skipped++;
  } catch (e) {
    db = JSON.parse(before);
    throw e;
  }
  progress(rows.length, rows.length);
  await commit();
  return done;
}

// Other tabs of this browser: pick up their changes.
addEventListener("storage", (e) => {
  if (e.key != KEY) return;
  db = load();
  if (state.shop) reload();
});
