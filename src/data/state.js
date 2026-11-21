// Shared in-memory state for the current shop, used by both backends.
export const state = {
  user: null, // { id, email }
  shop: null, // { id, name, plan, plan_until }
  role: null, // 'owner' | 'staff'
  settings: { low_alert: true, auto_reorder: false, vat_rate: 10, expiry_days: 30, rates: {} },
  items: [],
  packs: [], // bigger units of a product: { id, item_id, name, size (null: not counted yet), barcode, price, sized_at }
  packReceipts: [], // boxes received: { pack_id, item_id, boxes, size (null: waiting to be counted), expiry, created_at }
  customers: [], // { id, name, phone, note, created_at }
  custTotals: {}, // customer id -> { visits, total, last_at }, over all time
  orders: [],
  movements: [], // last 30 days
  lots: [], // units per expiry date, all of them
  ulots: [], // no-date batches: a delivery with a batch no. but no date (019)
  sales: [], // last 30 days
  saleLines: [], // lines of those sales
  truncated: false, // true when the server held back older orders/movements
  online: navigator.onLine,
  savedAt: null, // when this copy came from the server (shown while offline)
  pending: 0, // work done on this device the server doesn't have yet
  failed: [], // queued work the server refused, for the owner to decide
  tills: [], // the shop's devices that sell (A, B, C...), retired ones too
  people: null, // owner only: { members: [{ user_id, email, role }], invites: [{ code, expires_at }] }
  tillFull: false, // this device could not become a till: the plan's tills are all in use
  // Server only (011_billing.sql): { plans: [{ code, price_kip, max_tills }], qr: Rapide's
  // bank QR text, admin: is this user a Rapide admin, payments: this shop's, owner only }
  billing: null,
};

const listeners = new Set();
export const onChange = (fn) => listeners.add(fn);
export const emit = () => listeners.forEach((fn) => fn());

export const canWrite = () => !!state.shop && new Date(state.shop.plan_until) > new Date();
export const isOwner = () => state.role == "owner";
