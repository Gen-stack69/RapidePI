// Merging what changed on the server (022 sync_changes) into a device's copy
// of the shop, instead of downloading the whole shop again. Pure: the copy
// goes in, a new copy comes out; tested in scripts/test-units.mjs.

// The copy's lists and the database tables they come from. Lots are kept as
// two lists (dated, and the no-date batches of 019) and handled apart.
const LISTS = {
  items: "items",
  orders: "orders",
  movements: "movements",
  sales: "sales",
  saleLines: "sale_lines",
  tills: "tills",
  packs: "packs",
  packReceipts: "pack_receipts",
  customers: "customers",
};
const DAY = 864e5;
const t = (x) => new Date(x).getTime();
const newest = (a, b) => t(b.created_at) - t(a.created_at) || String(a.id).localeCompare(String(b.id));
const oldest = (a, b) => -newest(a, b);
const SORT = {
  items: (a, b) => String(a.sku).localeCompare(String(b.sku)),
  orders: newest,
  movements: newest,
  sales: newest,
  saleLines: newest,
  tills: oldest,
  packs: oldest,
  packReceipts: oldest,
  customers: (a, b) => String(a.name).localeCompare(String(b.name)) || String(a.id).localeCompare(String(b.id)),
};

// Rows by id: changed ones replace or join, deleted ones leave.
function merge(rows, changed, gone) {
  const m = new Map((rows || []).map((r) => [r.id, r]));
  for (const r of changed || []) m.set(r.id, r);
  for (const id of gone || []) m.delete(id);
  return [...m.values()];
}

/** server: the copy ({items, lots, ulots, sales, …}). ch: sync_changes()'s
 * answer. now: for the 30-day window of sales, sale lines and movements. */
export function mergeChanges(server, ch, now = Date.now()) {
  const gone = new Map();
  for (const d of ch.deleted || []) (gone.get(d.t) || gone.set(d.t, new Set()).get(d.t)).add(d.id);
  const out = { ...server };
  for (const [k, table] of Object.entries(LISTS)) out[k] = merge(server[k], ch[table], gone.get(table)).sort(SORT[k]);

  const lots = merge([...(server.lots || []), ...(server.ulots || [])], ch.lots, gone.get("lots"));
  out.lots = lots.filter((l) => l.expiry).sort((a, b) => (a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : 0));
  out.ulots = lots.filter((l) => !l.expiry).sort(oldest);

  // The same window as a full download: older history leaves the copy.
  const since = now - 30 * DAY,
    recent = (r) => t(r.created_at) >= since;
  out.movements = out.movements.filter(recent);
  out.sales = out.sales.filter(recent);
  out.saleLines = out.saleLines.filter(recent);
  out.packReceipts = out.packReceipts.filter((r) => r.size == null || recent(r));

  if (ch.settings) out.settings = ch.settings;
  if (ch.shop) out.shop = { ...server.shop, ...ch.shop };
  return out;
}
