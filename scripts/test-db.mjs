// Runs the migrations in an in-memory Postgres (PGlite) with a minimal stand-in
// for Supabase's auth schema, then checks security and stock rules.
// Usage: npm run test:db
import { freshDb } from "./lib/pgtest.mjs";

const db = await freshDb();

const A = "00000000-0000-0000-0000-00000000000a",
  B = "00000000-0000-0000-0000-00000000000b";
await db.exec(`insert into auth.users values ('${A}'), ('${B}')`);

let failures = 0;
const as = async (user, sql, params) => {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${user ?? ""}', false);
                 set role ${user ? "authenticated" : "anon"};`);
  try {
    return await db.query(sql, params);
  } finally {
    await db.exec("reset role");
  }
};
const ok = async (name, fn) => {
  try {
    await fn();
    console.log("  pass ", name);
  } catch (e) {
    failures++;
    console.log("  FAIL ", name, "-", e.message);
  }
};
const rejects = (name, fn) =>
  ok(name, async () => {
    let threw = false;
    try {
      await fn();
    } catch {
      threw = true;
    }
    if (!threw) throw new Error("expected an error, got success");
  });
const eq = (a, b, what) => {
  if (String(a) !== String(b)) throw new Error(`${what}: expected ${b}, got ${a}`);
};

const shopA = (await as(A, "select create_shop('Shop A') id")).rows[0].id;
const shopB = (await as(B, "select create_shop('Shop B') id")).rows[0].id;
const item = (
  await as(A, "insert into items (shop_id, sku, name, min_qty) values ($1, 'B-1', 'Bolt', 5) returning id", [shopA])
).rows[0].id;

console.log("Isolation");
await ok("owner sees own item", async () =>
  eq((await as(A, "select count(*) n from items")).rows[0].n, 1, "rows"));
await ok("other shop sees nothing", async () =>
  eq((await as(B, "select count(*) n from items")).rows[0].n, 0, "rows"));
await ok("anonymous sees nothing", async () =>
  eq((await as(null, "select count(*) n from shops").catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n, 0, "rows"));
await rejects("cannot insert into another shop", () =>
  as(B, "insert into items (shop_id, sku, name) values ($1, 'X', 'X')", [shopA]));
await rejects("cannot adjust another shop's stock", () =>
  as(B, "select adjust_stock($1, 5)", [item]));
await ok("cannot edit another shop's item (0 rows)", async () =>
  eq((await as(B, "update items set name = 'hacked' where id = $1", [item])).affectedRows ?? 0, 0, "rows"));

console.log("Stock rules");
await rejects("qty column not writable directly", () =>
  as(A, "update items set qty = 999 where id = $1", [item]));
await ok("adjust_stock adds and logs", async () => {
  eq((await as(A, "select adjust_stock($1, 10, 'test') q", [item])).rows[0].q, 10, "qty");
  eq((await as(A, "select count(*) n from movements")).rows[0].n, 1, "movements");
});
await rejects("cannot go negative", () => as(A, "select adjust_stock($1, -11)", [item]));
await ok("set_stock logs the difference", async () => {
  eq((await as(A, "select set_stock($1, 7) q", [item])).rows[0].q, 7, "qty");
  eq((await as(A, "select qty from movements order by created_at desc, type limit 1")).rows[0].qty, 3, "diff");
});

console.log("Orders");
const ord = (
  await as(A, "insert into orders (shop_id, item_id, type, qty) values ($1, $2, 'out', 2) returning id", [shopA, item])
).rows[0].id;
await rejects("order status not writable directly", () =>
  as(A, "update orders set status = 'done' where id = $1", [ord]));
await ok("complete_order ships stock", async () => {
  await as(A, "select complete_order($1)", [ord]);
  eq((await as(A, "select qty from items where id = $1", [item])).rows[0].qty, 5, "qty");
});
await rejects("cannot complete twice", () => as(A, "select complete_order($1)", [ord]));
await ok("an inbound order received with an expiry date makes a dated batch (013)", async () => {
  const it = (await as(A, "insert into items (shop_id, sku, name, kind) values ($1, 'MILK-1', 'Milk', 'consumable') returning id", [shopA]))
    .rows[0].id;
  const o = (await as(A, "insert into orders (shop_id, item_id, type, qty) values ($1, $2, 'in', 4) returning id", [shopA, it])).rows[0].id;
  await as(A, "select complete_order($1, $2)", [o, "2030-01-31"]);
  const lot = (await as(A, "select qty, expiry::text as d from lots where item_id = $1", [it])).rows;
  eq(lot.length, 1, "lots");
  eq(+lot[0].qty, 4, "lot qty");
  eq(lot[0].d, "2030-01-31", "lot date");
  eq(+(await as(A, "select qty from items where id = $1", [it])).rows[0].qty, 4, "stock");
  await as(A, "delete from items where id = $1", [it]); // later checks count the shop's products
});
await ok("a product takes a photo stored in its own shop folder (014)", async () => {
  const p = `${shopA}/${item}-abc123.jpg`;
  await as(A, "update items set photo = $1 where id = $2", [p, item]);
  eq((await as(A, "select photo from items where id = $1", [item])).rows[0].photo, p, "photo path");
  await as(A, "update items set photo = null where id = $1", [item]);
});
await rejects("a product photo outside the product's own file is refused (014)", () =>
  as(A, "update items set photo = $1 where id = $2", [`${shopB}/${item}-abc123.jpg`, item]));
await ok("a batch's expiry date can be corrected, and joins a batch already on that date (015)", async () => {
  const it = (await as(A, "insert into items (shop_id, sku, name, kind) values ($1, 'JUICE-1', 'Juice', 'consumable') returning id", [shopA])).rows[0].id;
  await as(A, "select adjust_stock($1, 5, 't', $2)", [it, "2026-01-01"]);
  await as(A, "select adjust_stock($1, 3, 't', $2)", [it, "2027-06-30"]);
  const lot = (await as(A, "select id from lots where item_id = $1 and expiry = '2026-01-01'", [it])).rows[0].id;
  await as(A, "select change_lot_expiry($1, $2)", [lot, "2027-01-01"]);
  let rows = (await as(A, "select expiry::text as d, qty from lots where item_id = $1 order by expiry", [it])).rows;
  eq(rows.map((r) => r.d + "=" + +r.qty).join(","), "2027-01-01=5,2027-06-30=3", "moved");
  const again = (await as(A, "select id from lots where item_id = $1 and expiry = '2027-01-01'", [it])).rows[0].id;
  await as(A, "select change_lot_expiry($1, $2)", [again, "2027-06-30"]);
  rows = (await as(A, "select expiry::text as d, qty from lots where item_id = $1", [it])).rows;
  eq(rows.map((r) => r.d + "=" + +r.qty).join(","), "2027-06-30=8", "merged");
  eq(+(await as(A, "select qty from items where id = $1", [it])).rows[0].qty, 8, "stock unchanged");
  await as(A, "delete from items where id = $1", [it]);
});
await rejects("another shop cannot change a batch's date (015)", async () => {
  const it = (await as(A, "insert into items (shop_id, sku, name, kind) values ($1, 'JUICE-2', 'Juice', 'consumable') returning id", [shopA])).rows[0].id;
  await as(A, "select adjust_stock($1, 2, 't', $2)", [it, "2026-02-02"]);
  const lot = (await as(A, "select id from lots where item_id = $1", [it])).rows[0].id;
  try { await as(B, "select change_lot_expiry($1, $2)", [lot, "2027-02-02"]); }
  finally { await as(A, "delete from items where id = $1", [it]); }
});
await ok("a batch keeps its batch / production numbers, each once, and they follow a date change (016)", async () => {
  const it = (await as(A, "insert into items (shop_id, sku, name, kind) values ($1, 'COKE-B', 'Coke', 'consumable') returning id", [shopA])).rows[0].id;
  const num = async (d) => (await as(A, "select batch from lots where item_id = $1 and expiry = $2", [it, d])).rows[0]?.batch ?? null;
  await as(A, "select adjust_stock($1, 6, 't', $2)", [it, "2027-03-01"]);
  await as(A, "select set_lot_batch($1, $2, $3)", [it, "2027-03-01", "L100"]);
  await as(A, "select set_lot_batch($1, $2, $3)", [it, "2027-03-01", "l100"]);
  eq(await num("2027-03-01"), "L100", "same number once");
  await as(A, "select set_lot_batch($1, $2, $3)", [it, "2027-03-01", "L200"]);
  eq(await num("2027-03-01"), "L100, L200", "two deliveries, one date");
  await as(A, "select set_lot_batch($1, $2, $3, false)", [it, "2027-03-01", "L300"]);
  eq(await num("2027-03-01"), "L300", "corrected");
  await as(A, "select set_lot_batch($1, $2, $3)", [it, "2029-09-09", "NOPE"]);
  eq((await as(A, "select count(*)::int as n from lots where item_id = $1", [it])).rows[0].n, 1, "no batch made for a date not in stock");
  await as(A, "select adjust_stock($1, 2, 't', $2)", [it, "2027-04-01"]);
  await as(A, "select set_lot_batch($1, $2, $3)", [it, "2027-04-01", "L400"]);
  const lot = (await as(A, "select id from lots where item_id = $1 and expiry = '2027-04-01'", [it])).rows[0].id;
  await as(A, "select change_lot_expiry($1, $2)", [lot, "2027-03-01"]);
  eq(await num("2027-03-01"), "L300, L400", "numbers join with the batches");
  await as(A, "delete from items where id = $1", [it]);
});
await rejects("another shop cannot set a batch number (016)", async () => {
  const it = (await as(A, "insert into items (shop_id, sku, name, kind) values ($1, 'COKE-C', 'Coke', 'consumable') returning id", [shopA])).rows[0].id;
  await as(A, "select adjust_stock($1, 2, 't', $2)", [it, "2027-02-02"]);
  try { await as(B, "select set_lot_batch($1, $2, $3)", [it, "2027-02-02", "X"]); }
  finally { await as(A, "delete from items where id = $1", [it]); }
});
await rejects("cannot order another shop's item", () =>
  as(B, "insert into orders (shop_id, item_id, type, qty) values ($1, $2, 'in', 1)", [shopB, item]));

console.log("Automation");
await ok("auto-reorder creates one pending order", async () => {
  await as(A, "update settings set auto_reorder = true where shop_id = $1", [shopA]);
  await as(A, "select adjust_stock($1, -2)", [item]); // 3 < min 5
  await as(A, "select adjust_stock($1, -1)", [item]); // still low, no duplicate
  const r = (await as(A, "select qty from orders where auto and status = 'pending'")).rows;
  eq(r.length, 1, "auto orders");
  eq(r[0].qty, 7, "reorder qty (2*5-3)");
});
await rejects("staff/other user cannot change settings", async () => {
  const r = await as(B, "update settings set auto_reorder = false where shop_id = $1 returning 1", [shopA]);
  if (!r.rows.length) throw new Error("no rows");
});

// ---------- expiry and the till ----------
// Run on shop B, so shop A keeps exactly the one item the Billing checks expect.
// C is staff in shop B.
const C = "00000000-0000-0000-0000-00000000000c";
await db.exec(`insert into auth.users values ('${C}'); insert into members values ('${shopB}', '${C}', 'staff')`);
const one = async (user, sql, params) => (await as(user, sql, params)).rows[0];
const qtyOf = async (id) => +(await one(B, "select qty from items where id = $1", [id])).qty;
const lotsOf = async (id) =>
  (await as(B, "select to_char(expiry, 'YYYY-MM-DD') e, qty::int q from lots where item_id = $1 order by expiry", [id]))
    .rows.map((r) => `${r.e}:${r.q}`)
    .join(" ");
// Stock equals its movements, and dated stock never exceeds stock (none when below zero).
const balanced = async () => {
  const bad = await as(B, `
    select i.sku from items i
    where i.qty <> coalesce((select sum(case when m.type = 'in' then m.qty else -m.qty end)
                             from movements m where m.item_id = i.id), 0)
       or coalesce((select sum(qty) from lots l where l.item_id = i.id), 0) > greatest(i.qty, 0)`);
  if (bad.rows.length) throw new Error("stock out of step for " + bad.rows.map((r) => r.sku).join(", "));
};
const milk = (
  await one(
    B,
    `insert into items (shop_id, sku, name, kind, price, price_wholesale, wholesale_min_qty)
     values ($1, 'MILK', 'Milk', 'consumable', 10000, 9000, 12) returning id`,
    [shopB],
  )
).id;
const soap = (
  await one(B, "insert into items (shop_id, sku, name, price) values ($1, 'SOAP', 'Soap', 5000) returning id", [shopB])
).id;

console.log("Expiry");
await ok("receiving with an expiry date makes a lot; the same date again adds to it", async () => {
  await as(B, "select adjust_stock($1, 5, 'in', '2099-03-01')", [milk]);
  await as(B, "select adjust_stock($1, 3, 'in', '2099-03-01')", [milk]);
  await as(B, "select adjust_stock($1, 4, 'in', '2099-01-01')", [milk]);
  await as(B, "select adjust_stock($1, 2)", [milk]); // no date recorded
  await as(B, "select adjust_stock($1, 6, 'in', '2000-01-01')", [milk]); // already expired
  eq(await qtyOf(milk), 20, "qty");
  eq(await lotsOf(milk), "2000-01-01:6 2099-01-01:4 2099-03-01:8", "lots");
  await balanced();
});
await ok("stock leaves soonest-in-date first, then undated, expired last", async () => {
  await as(B, "select adjust_stock($1, -5)", [milk]); // 4 of Jan, 1 of Mar
  eq(await lotsOf(milk), "2000-01-01:6 2099-03-01:7", "after 5");
  await as(B, "select adjust_stock($1, -8)", [milk]); // 7 of Mar, 1 undated
  eq(await lotsOf(milk), "2000-01-01:6", "after 13");
  await as(B, "select adjust_stock($1, -2)", [milk]); // last undated, then 1 expired
  eq(await lotsOf(milk), "2000-01-01:5", "after 15");
  eq(await qtyOf(milk), 5, "qty");
  await balanced();
});
await ok("write_off_lot takes the whole lot out of stock and logs it", async () => {
  const lot = (await one(B, "select id from lots where item_id = $1", [milk])).id;
  await as(C, "select write_off_lot($1)", [lot]); // staff may do it
  eq(await qtyOf(milk), 0, "qty");
  eq(await lotsOf(milk), "", "lots");
  eq(
    (await one(B, "select note from movements where item_id = $1 order by created_at desc limit 1", [milk])).note,
    "expired",
    "note",
  );
  await balanced();
});
await rejects("lots cannot be written directly", () =>
  as(B, "insert into lots (shop_id, item_id, expiry, qty) values ($1, $2, '2099-01-01', 1)", [shopB, milk]));
await rejects("stock_move is not callable by clients", () =>
  as(B, "select stock_move($1, 100, 'x', null, null)", [milk]));
await rejects("another shop cannot write off my lot", async () => {
  await as(B, "select adjust_stock($1, 1, 'in', '2099-05-05')", [milk]);
  const lot = (await one(B, "select id from lots where item_id = $1", [milk])).id;
  await as(A, "select write_off_lot($1)", [lot]);
});

console.log("Cashier");
await as(B, "select adjust_stock($1, 30, 'in', '2099-06-01')", [milk]); // milk 31
await as(B, "select adjust_stock($1, 10)", [soap]); // soap 10
// Every sale comes from a till (004); this one stands in for the counter.
const counter = (await one(B, "select register_till($1, 'Counter') c", [shopB])).c;
const sell = (user, cid, lines, disc = 0, method = "cash", paid = 1e9) =>
  one(user, "select create_sale($1, $2, $3::jsonb, $4, $5, $6, null, $7) id", [
    shopB,
    cid,
    JSON.stringify(lines),
    disc,
    method,
    paid,
    counter,
  ]);
let sale1;
await ok("a sale takes stock and is priced on the server", async () => {
  sale1 = (
    await sell(
      C,
      "till-1-0001",
      [
        { item_id: milk, qty: 2 },
        { item_id: soap, qty: 1 },
        { item_id: milk, qty: 1 },
      ],
      0,
      "cash",
      50000,
    )
  ).id;
  const s = await one(
    B,
    "select receipt_no, subtotal::int, total::int, paid::int, change_due::int from sales where id = $1",
    [sale1],
  );
  eq(`${s.receipt_no} ${s.subtotal} ${s.total} ${s.paid} ${s.change_due}`, "1 35000 35000 50000 15000", "sale");
  eq((await one(B, "select count(*)::int n from sale_lines where sale_id = $1", [sale1])).n, 2, "lines (milk merged)");
  eq(await qtyOf(milk), 28, "milk");
  eq(await qtyOf(soap), 9, "soap");
  await balanced();
});
await ok("the same sale sent twice is sold once", async () => {
  eq((await sell(C, "till-1-0001", [{ item_id: milk, qty: 2 }])).id, sale1, "same sale");
  eq(await qtyOf(milk), 28, "milk unchanged");
});
await ok("the wholesale price applies from the wholesale quantity", async () => {
  const id = (await sell(B, "till-1-0002", [{ item_id: milk, qty: 12 }])).id;
  eq((await one(B, "select unit_price::int p from sale_lines where sale_id = $1", [id])).p, 9000, "price");
  eq((await one(B, "select receipt_no from sales where id = $1", [id])).receipt_no, 2, "receipt numbers run on");
});
await ok("a sale that fails on one line moves nothing and uses no receipt number", async () => {
  let threw = false;
  try {
    await sell(B, "till-1-0003", [
      { item_id: soap, qty: 1 },
      { item_id: milk, qty: 999 },
    ]);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("oversold");
  eq(await qtyOf(soap), 9, "soap untouched");
  eq((await one(B, "select receipt_seq from shops where id = $1", [shopB])).receipt_seq, 2, "receipt_seq");
});
await rejects("cash below the total is refused", () =>
  sell(B, "till-1-0004", [{ item_id: soap, qty: 1 }], 0, "cash", 4999));
await rejects("a discount above the subtotal is refused", () =>
  sell(B, "till-1-0005", [{ item_id: soap, qty: 1 }], 6000));
await rejects("a product with no sell price cannot be sold", async () => {
  const free = (await one(B, "insert into items (shop_id, sku, name) values ($1, 'FREE', 'No price') returning id", [shopB])).id;
  await as(B, "select adjust_stock($1, 1)", [free]);
  await sell(B, "till-1-0006", [{ item_id: free, qty: 1 }]);
});
await ok("a transfer is recorded for the exact total, after discount", async () => {
  const id = (await sell(B, "till-1-0007", [{ item_id: soap, qty: 2 }], 1000, "transfer", 0)).id;
  const s = await one(B, "select total::int, paid::int, change_due::int from sales where id = $1", [id]);
  eq(`${s.total} ${s.paid} ${s.change_due}`, "9000 9000 0", "sale");
});
await rejects("another shop cannot sell my products", () =>
  one(A, "select create_sale($1, 'x-till-0001', $2::jsonb, 0, 'cash', 1e9)", [
    shopA,
    JSON.stringify([{ item_id: soap, qty: 1 }]),
  ]));
await ok("another shop sees none of my sales", async () =>
  eq((await one(A, "select count(*)::int n from sales")).n, 0, "sales"));
await rejects("sales cannot be written directly", () => as(B, "update sales set total = 1 where id = $1", [sale1]));
await rejects("staff cannot void a sale", () => as(C, "select void_sale($1)", [sale1]));
await ok("void puts every unit back, into the lot it came from", async () => {
  const before = await lotsOf(milk);
  await as(B, "select void_sale($1)", [sale1]);
  eq(await qtyOf(milk), 16 + 3, "milk");
  eq(await qtyOf(soap), 7 + 1, "soap");
  eq((await one(B, "select status from sales where id = $1", [sale1])).status, "void", "status");
  if (before == (await lotsOf(milk))) throw new Error("lots did not change");
  await balanced();
});
await rejects("a sale cannot be voided twice", () => as(B, "select void_sale($1)", [sale1]));
await ok("erase removes sales, lines and lots too", async () => {
  await as(B, "select erase_shop_data($1)", [shopB]);
  const n = await one(
    B,
    "select (select count(*) from sales) + (select count(*) from sale_lines) + (select count(*) from lots) + (select count(*) from items) n",
  );
  eq(n.n, 0, "rows");
});

console.log("Offline sync");
// The offline checks start with no tills, as a new shop would.
await db.exec(`delete from tills where shop_id = '${shopB}'`);
// Shop B is empty again after the erase above.
const juice = (
  await one(B, "insert into items (shop_id, sku, name, kind, price) values ($1, 'JUICE', 'Juice', 'consumable', 8000) returning id", [shopB])
).id;
await as(B, "select adjust_stock($1, 1, 'in', '2099-01-01')", [juice]); // the last unit
const tillA = (await one(B, "select register_till($1, 'Front') c", [shopB])).c;
const tillB = (await one(C, "select register_till($1, 'Back') c", [shopB])).c;
const offSale = (user, cid, lines, at, till, no, method = "cash", paid = 1e9) =>
  one(
    user,
    "select create_sale($1, $2, $3::jsonb, 0, $4, $5, $6::timestamptz, $7, $8, true) id",
    [shopB, cid, JSON.stringify(lines), method, paid, at, till, no],
  );
const ago = (min) => new Date(Date.now() - min * 60e3).toISOString();
await ok("tills get their own letters", async () => eq(`${tillA} ${tillB}`, "A B", "codes"));
let offA, offB;
await ok("two tills each sell the last unit offline: both kept, stock below zero, both flagged", async () => {
  offA = (await offSale(C, "offline-A-0001", [{ item_id: juice, qty: 1, price: 8000 }], ago(20), "A", 1)).id;
  offB = (await offSale(C, "offline-B-0001", [{ item_id: juice, qty: 1, price: 8000 }], ago(10), "B", 1)).id;
  eq(await qtyOf(juice), -1, "juice");
  eq(await lotsOf(juice), "", "lots");
  const f = await one(B, "select array_to_string(flags, ',') f from sales where id = $1", [offB]);
  eq(f.f, "short", "flags on the late one");
  await balanced();
});
await ok("the same offline sale sent twice is sold once", async () => {
  eq((await offSale(C, "offline-A-0001", [{ item_id: juice, qty: 1, price: 8000 }], ago(20), "A", 1)).id, offA, "id");
  eq(await qtyOf(juice), -1, "juice unchanged");
});
await ok("offline sales keep the device time and sort by it", async () => {
  const r = await as(B, "select till || '-' || till_no t from sales where shop_id = $1 order by created_at", [shopB]);
  eq(r.rows.map((x) => x.t).join(" "), "A-1 B-1", "order");
  const s = await one(B, "select created_at < synced_at - interval '5 minutes' late from sales where id = $1", [offA]);
  eq(s.late, true, "created before synced");
});
await ok("an offline sale keeps the receipt's price and is flagged when it changed", async () => {
  await as(B, "select adjust_stock($1, 10)", [juice]); // 9
  const id = (await offSale(C, "offline-A-0002", [{ item_id: juice, qty: 2, price: 7000 }], ago(5), "A", 2)).id;
  const s = await one(B, "select total::int, array_to_string(flags, ',') f from sales where id = $1", [id]);
  eq(`${s.total} ${s.f}`, "14000 price_changed", "sale");
});
await rejects("an online sale still cannot go below zero", () =>
  sell(C, "online-0000001", [{ item_id: juice, qty: 99 }]));
await ok("a device clock in the future becomes server time, flagged", async () => {
  const id = (await offSale(C, "offline-B-0002", [{ item_id: juice, qty: 1, price: 8000 }], "2099-01-01T00:00:00Z", "B", 2)).id;
  const s = await one(B, "select created_at < now() + interval '1 minute' ok, array_to_string(flags, ',') f from sales where id = $1", [id]);
  eq(`${s.ok} ${s.f}`, "true clock", "sale");
});
await rejects("the same receipt number cannot be used twice on one till", () =>
  offSale(C, "offline-B-0099", [{ item_id: juice, qty: 1, price: 8000 }], ago(1), "B", 2));
await rejects("a till that was never registered cannot sell", () =>
  offSale(C, "offline-Z-0001", [{ item_id: juice, qty: 1, price: 8000 }], ago(1), "Z", 1));
await ok("a resent stock change is applied once", async () => {
  const before = await qtyOf(juice),
    send = () => as(C, "select adjust_stock($1, 5, 'in', '2099-02-01', 'adjust-0000001', $2::timestamptz, true)", [juice, ago(3)]);
  await send();
  await send();
  eq(await qtyOf(juice), before + 5, "juice");
  await balanced();
});
await ok("an offline stock-out may go below zero; online may not", async () => {
  let threw = false;
  try {
    await as(C, "select adjust_stock($1, -999, 'damaged', null, 'adjust-0000002', null, false)", [juice]);
  } catch {
    threw = true;
  }
  eq(threw, true, "online refused");
  await as(C, "select adjust_stock($1, -999, 'damaged', null, 'adjust-0000003', null, true)", [juice]);
  if ((await qtyOf(juice)) >= 0) throw new Error("not below zero");
  await balanced();
  await as(B, "select set_stock($1, 4, 'count')", [juice]); // the recount
  eq(await qtyOf(juice), 4, "recounted");
});
await ok("receiving into negative stock fills the hole first, then the lot", async () => {
  await offSale(C, "offline-A-0003", [{ item_id: juice, qty: 6, price: 8000 }], ago(2), "A", 3); // 4 → -2
  await as(B, "select adjust_stock($1, 5, 'in', '2099-05-01')", [juice]); // -2 → 3
  eq(await lotsOf(juice), "2099-05-01:3", "only what is on the shelf is dated");
  await balanced();
});
await ok("a write-off by date, resent, removes it once", async () => {
  const send = () =>
    as(C, "select write_off_expiry($1, '2099-05-01', 2, 'expired', 'wo-00000001', $2::timestamptz)", [juice, ago(1)]);
  await send();
  await send();
  eq(await lotsOf(juice), "2099-05-01:1", "lot");
  eq(await qtyOf(juice), 1, "juice");
  await balanced();
});
await ok("an offline sale can be voided by its device id, and the void resent", async () => {
  await as(B, "select void_sale_by_client($1, 'offline-A-0003', $2::timestamptz)", [shopB, ago(1)]);
  await as(B, "select void_sale_by_client($1, 'offline-A-0003', $2::timestamptz)", [shopB, ago(1)]);
  eq(await qtyOf(juice), 7, "juice back");
  await balanced();
});
await rejects("staff cannot void by device id", () =>
  as(C, "select void_sale_by_client($1, 'offline-A-0002')", [shopB]));
await rejects("another shop cannot sell on my till", () =>
  one(A, "select create_sale($1, 'x-offline-1', $2::jsonb, 0, 'cash', 1e9, now(), 'A', 50, true)", [
    shopB,
    JSON.stringify([{ item_id: juice, qty: 1, price: 1 }]),
  ]));
await ok("another shop sees none of my tills", async () => eq((await one(A, "select count(*)::int n from tills")).n, 0, "tills"));
await rejects("queued ids cannot be read or written directly", () => as(B, "select * from applied_ops"));
await rejects("stock_move is still not callable by clients", () =>
  as(B, "select stock_move($1, -1, 'x', null, null, true)", [juice]));
await ok("erase clears queued ids but keeps the tills", async () => {
  await as(B, "select erase_shop_data($1)", [shopB]);
  eq((await db.query(`select count(*)::int n from applied_ops where shop_id = '${shopB}'`)).rows[0].n, 0, "ops");
  eq((await one(B, "select count(*)::int n from tills")).n, 2, "tills");
});

console.log("Till limit");
// Shop B has tills A and B in use, and the trial allows 2. The erase above emptied it.
const tea = (
  await one(B, "insert into items (shop_id, sku, name, price) values ($1, 'TEA', 'Tea', 8000) returning id", [shopB])
).id;
const limitSale = (till, at, offline, cid) =>
  one(B, "select create_sale($1, $2, $3::jsonb, 0, 'cash', 1e9, $4::timestamptz, $5, null, $6) id", [
    shopB,
    cid,
    JSON.stringify([{ item_id: tea, qty: 1, price: 8000 }]),
    at,
    till,
    offline,
  ]);
await as(B, "select adjust_stock($1, 10)", [tea]);
await rejects("a third device cannot register on a 2-till plan", () => as(C, "select register_till($1, 'Extra')", [shopB]));
await rejects("a device with no till cannot sell", () => limitSale(null, null, false, "limit-none-1"));
await rejects("the owner cannot raise the limit", () => as(B, "update shops set max_tills = 50 where id = $1", [shopB]));
await rejects("staff cannot retire a till", () => as(C, "select retire_till($1, 'B')", [shopB]));
await rejects("another shop cannot retire my till", () => as(A, "select retire_till($1, 'B')", [shopB]));
await ok("a till sells before it is retired", async () => limitSale("B", null, false, "limit-b-1"));
await as(B, "select retire_till($1, 'B')", [shopB]);
await rejects("a retired till cannot sell online", () => limitSale("B", null, false, "limit-b-2"));
await ok("an offline sale made before retiring is still accepted", async () => limitSale("B", ago(5), true, "limit-b-3"));
await rejects("an offline sale made after retiring is refused", async () => {
  await db.exec(`update tills set retired_at = now() - interval '10 minutes' where shop_id = '${shopB}' and code = 'B'`);
  return limitSale("B", ago(1), true, "limit-b-4");
});
await ok("retiring frees the place, and the letter is not given out again", async () =>
  eq((await one(C, "select register_till($1, 'New phone') c", [shopB])).c, "C", "code"));
await ok("a bigger plan allows more tills", async () => {
  await db.exec(`update shops set max_tills = 4 where id = '${shopB}'`);
  eq((await one(C, "select register_till($1, 'PC') c", [shopB])).c, "D", "code");
});

console.log("Packs, expiring price, VAT");
// Shop B now sells from till C (the till-limit checks above registered it).
const sellC = (cid, lines, user = B) =>
  one(user, "select create_sale($1, $2, $3::jsonb, 0, 'cash', 1e9, null, 'C') id", [shopB, cid, JSON.stringify(lines)]);
const can = (
  await one(B, "insert into items (shop_id, sku, name, unit, price, kind) values ($1, 'CAN', 'Soda', 'can', 10000, 'consumable') returning id", [shopB])
).id;
await as(B, "select adjust_stock($1, 30, 'in', '2099-01-01')", [can]);
await as(B, "select adjust_stock($1, 20, 'in', '2099-06-01')", [can]);
let carton;
await ok("the owner adds a carton of 24", async () => {
  carton = (
    await one(B, "insert into packs (shop_id, item_id, name, size, barcode, price) values ($1, $2, 'Carton', 24, 'CTN-1', 210000) returning id", [shopB, can])
  ).id;
});
await rejects("staff cannot add a pack", () =>
  as(C, "insert into packs (shop_id, item_id, name, size, price) values ($1, $2, 'Box', 6, 1)", [shopB, can]));
await rejects("a pack can't hold 1 or fewer", () =>
  as(B, "insert into packs (shop_id, item_id, name, size, price) values ($1, $2, 'One', 1, 1)", [shopB, can]));
await rejects("two packs can't share a barcode", () =>
  as(B, "insert into packs (shop_id, item_id, name, size, barcode, price) values ($1, $2, 'Tray', 6, 'CTN-1', 1)", [shopB, can]));
await ok("another shop can't see the packs", async () =>
  eq((await one(A, "select count(*) n from packs")).n, 0, "rows"));
await rejects("another shop can't add a pack to my product", () =>
  as(A, "insert into packs (shop_id, item_id, name, size, price) values ($1, $2, 'Box', 6, 1)", [shopA, can]));
await ok("selling a carton takes 24 cans at the carton price", async () => {
  const id = (await sellC("pack-sale-1", [{ item_id: can, qty: 1, pack_id: carton }], C)).id;
  eq(await qtyOf(can), 26, "cans left");
  const l = await one(B, "select qty, pack_qty, pack_name, line_total, unit_price from sale_lines where sale_id = $1", [id]);
  eq(`${+l.qty} ${+l.pack_qty} ${l.pack_name} ${+l.line_total}`, "24 1 Carton 210000", "line");
  eq(await lotsOf(can), "2099-01-01:6 2099-06-01:20", "oldest batch first");
});
await ok("VAT inside the price: 10% of 210,000 is 19,090.91", async () => {
  const s = await one(B, "select vat, vat_rate from sales where client_id = 'pack-sale-1'");
  eq(`${+s.vat} ${+s.vat_rate}`, "19090.91 10", "vat");
});
await rejects("staff cannot set an expiring price", () => as(C, "select set_lot_price($1, '2099-06-01', 6000)", [can]));
await rejects("another shop cannot set my price", () => as(A, "select set_lot_price($1, '2099-06-01', 6000)", [can]));
await ok("an expiring price sells that batch first, at that price", async () => {
  await as(B, "select set_lot_price($1, '2099-06-01', 6000)", [can]);
  const id = (await sellC("exp-sale-1", [{ item_id: can, qty: 2, expiry: "2099-06-01" }], C)).id;
  eq((await one(B, "select total from sales where id = $1", [id])).total, 12000, "total");
  eq(await lotsOf(can), "2099-01-01:6 2099-06-01:18", "that batch");
});
await ok("a normal line still sells at the normal price", async () => {
  const id = (await sellC("plain-sale-1", [{ item_id: can, qty: 1 }], C)).id;
  eq((await one(B, "select total from sales where id = $1", [id])).total, 10000, "total");
});
await rejects("staff cannot change the VAT rate", async () => {
  const r = await as(C, "update settings set vat_rate = 0 where shop_id = $1", [shopB]);
  if (!r.affectedRows) throw new Error("no change");
});
await ok("VAT 0: the sale carries none", async () => {
  await as(B, "update settings set vat_rate = 0 where shop_id = $1", [shopB]);
  await sellC("novat-sale-1", [{ item_id: can, qty: 1 }]);
  eq(+(await one(B, "select vat from sales where client_id = 'novat-sale-1'")).vat, 0, "vat");
});
await rejects("a pack from another product is refused", async () => {
  await sellC("bad-pack-1", [{ item_id: tea, qty: 1, pack_id: carton }]);
});
await ok("stock still equals its movements", balanced);

// 010_receive_packs.sql. Shop B: B is the owner, C is staff.
console.log("Receiving boxes");
const waitingOf = async (pack) =>
  +(await one(B, "select coalesce(sum(boxes), 0) n from pack_receipts where pack_id = $1 and size is null", [pack])).n;
let box;
await ok("staff links a box to a product, count not known yet", async () => {
  box = (
    await one(C, "insert into packs (shop_id, item_id, name, barcode) values ($1, $2, 'Box', 'BOX-1') returning id, size", [shopB, can])
  );
  eq(box.size, null, "size");
  box = box.id;
});
await rejects("staff cannot add a pack with a price", () =>
  as(C, "insert into packs (shop_id, item_id, name, size, price) values ($1, $2, 'Tray', 6, 5000)", [shopB, can]));
await rejects("a pack with no count can't have a price", () =>
  as(B, "insert into packs (shop_id, item_id, name, price) values ($1, $2, 'Crate', 5000)", [shopB, can]));
await rejects("the count can't be written directly", () =>
  as(B, "update packs set size = 6 where id = $1", [box]));
let before;
await ok("boxes with no count wait and add nothing to stock", async () => {
  before = await qtyOf(can);
  await as(C, "select receive_pack($1, 5, '2099-09-01', 'rcv-box-0001')", [box]);
  eq(await qtyOf(can), before, "qty");
  eq(await waitingOf(box), 5, "waiting boxes");
});
await ok("the same delivery sent twice is kept once", async () => {
  await as(C, "select receive_pack($1, 5, '2099-09-01', 'rcv-box-0001')", [box]);
  eq(await waitingOf(box), 5, "waiting boxes");
});
await rejects("a box with no count can't be sold", () =>
  sellC("box-sale-1", [{ item_id: can, qty: 1, pack_id: box }]));
await rejects("NaN boxes are refused", () => as(C, "select receive_pack($1, 'NaN', null, 'rcv-box-nan1')", [box]));
await rejects("another shop can't receive into my box", () =>
  as(A, "select receive_pack($1, 1, null, 'rcv-box-oth1')", [box]));
await rejects("another shop can't count my box", () => as(A, "select set_pack_size($1, 12)", [box]));
await ok("staff enters 12 a box: the 5 waiting boxes become 60, at their date", async () => {
  await as(C, "select set_pack_size($1, 12)", [box]);
  eq(await qtyOf(can), before + 60, "qty");
  eq(await waitingOf(box), 0, "waiting boxes");
  eq((await lotsOf(can)).includes("2099-09-01:60"), true, "lot " + (await lotsOf(can)));
  await balanced();
});
await ok("once counted, a box received adds its count at once", async () => {
  await as(C, "select receive_pack($1, 2, null, 'rcv-box-0002')", [box]);
  eq(await qtyOf(can), before + 84, "qty");
});
await ok("a carton with its own count goes in the same way (24 each)", async () => {
  await as(C, "select receive_pack($1, 1, null, 'rcv-ctn-0001')", [carton]);
  eq(await qtyOf(can), before + 108, "qty");
});
await ok("a wrong count is fixed with one visible movement (7 boxes, 12 -> 10)", async () => {
  await as(C, "select set_pack_size($1, 10, 7)", [box]);
  eq(await qtyOf(can), before + 94, "qty");
  // Out of each batch it comes from, like any stock leaving (stock_move).
  const m = await one(B, "select string_agg(distinct type, ',') t, sum(qty) q from movements where item_id = $1 and note = 'box count fixed'", [can]);
  eq(`${m.t} ${+m.q}`, "out 14", "movement");
  eq(+(await one(B, "select size from packs where id = $1", [box])).size, 10, "size");
  await balanced();
});
await rejects("a count must be more than 1", () => as(C, "select set_pack_size($1, 1)", [box]));
await ok("the owner prices the box", async () => {
  await as(B, "update packs set price = 95000 where id = $1", [box]);
});
await rejects("staff can't recount a priced box", () => as(C, "select set_pack_size($1, 12)", [box]));
await rejects("staff can't rename or reprice a priced box", () =>
  as(C, "update packs set name = 'Cheap', price = 1 where id = $1", [box]));
await rejects("staff can't delete a pack", async () => {
  const r = await as(C, "delete from packs where id = $1", [box]);
  if (!r.affectedRows) throw new Error("no change");
});
await ok("stock still equals its movements", balanced);

console.log("Customers and import");
let cust;
await ok("staff adds a customer", async () => {
  cust = (await one(C, "insert into customers (shop_id, name, phone) values ($1, 'Mr Somchai', '020 5555 1234') returning id", [shopB])).id;
});
await rejects("two customers can't share a phone", () =>
  as(B, "insert into customers (shop_id, name, phone) values ($1, 'Other', '020 5555 1234')", [shopB]));
await ok("another shop can't see my customers", async () =>
  eq((await one(A, "select count(*) n from customers")).n, 0, "rows"));
await rejects("staff cannot delete a customer", async () => {
  const r = await as(C, "delete from customers where id = $1", [cust]);
  if (!r.affectedRows) throw new Error("no change");
});
await ok("a sale can name the customer", async () => {
  await one(C, "select create_sale($1, 'cust-sale-1', $2::jsonb, 0, 'cash', 1e9, null, 'C', null, false, $3) id",
    [shopB, JSON.stringify([{ item_id: can, qty: 1 }]), cust]);
  eq((await one(B, "select customer_id from sales where client_id = 'cust-sale-1'")).customer_id, cust, "customer");
});
await ok("a customer from another shop is ignored, the sale still counts", async () => {
  const other = (await one(A, "insert into customers (shop_id, name) values ($1, 'Elsewhere') returning id", [shopA])).id;
  await one(C, "select create_sale($1, 'cust-sale-2', $2::jsonb, 0, 'cash', 1e9, null, 'C', null, false, $3) id",
    [shopB, JSON.stringify([{ item_id: can, qty: 1 }]), other]);
  eq((await one(B, "select customer_id from sales where client_id = 'cust-sale-2'")).customer_id, null, "customer");
});
await ok("the 10-argument create_sale still works", async () => {
  await sellC("old-client-1", [{ item_id: can, qty: 1 }]);
});
await rejects("create_sale_core can't be called directly", () =>
  as(B, "select create_sale_core($1, 'core-1', $2::jsonb, 0, 'cash', 1e9, null, 'C', null, false)",
    [shopB, JSON.stringify([{ item_id: can, qty: 1 }])]));
await ok("customer totals count the sales", async () => {
  const r = await one(B, "select visits, total from customer_totals($1) where customer_id = $2", [shopB, cust]);
  eq(`${r.visits} ${+r.total}`, "1 10000", "totals");
});
await ok("another shop gets no totals", async () =>
  eq((await as(A, "select * from customer_totals($1)", [shopB])).rows.length, 0, "rows"));

const past = [
  { ref: "R-1001", at: "2026-01-05T10:00:00+07:00", method: "cash", customer: { name: "Mr Somchai", phone: "020 5555 1234" },
    lines: [{ sku: "can", qty: 3, price: 9000 }, { name: "Old product", qty: 1, price: 5000 }] },
  { ref: "R-1002", at: "2026-01-06T11:00:00+07:00", method: "transfer", discount: 1000, customer: { name: "New Lady" },
    lines: [{ sku: "CAN", qty: 1, price: 10000 }] },
];
const stockBefore = await qtyOf(can);
await ok("the owner imports past sales", async () => {
  const r = (await one(B, "select import_sales($1, $2::jsonb) r", [shopB, JSON.stringify(past)])).r;
  eq(`${r.added} ${r.skipped}`, "2 0", "added");
  const s = await one(B, "select total, method, till, flags, customer_id, created_at from sales where client_id = 'import:R-1001'");
  eq(`${+s.total} ${s.method} ${s.till} ${s.flags}`, "32000 cash IMP imported", "sale");
  eq(s.customer_id, cust, "matched by phone");
  const l = await as(B, "select item_id, sku, name from sale_lines where sale_id = (select id from sales where client_id = 'import:R-1001') order by name");
  eq(l.rows.map((x) => `${x.item_id ? "item" : "none"}:${x.sku}:${x.name}`).join(" "), "none:-:Old product item:CAN:Soda", "lines");
  eq(+(await one(B, "select total from sales where client_id = 'import:R-1002'")).total, 9000, "discounted");
});
await ok("importing past sales moves no stock", async () => eq(await qtyOf(can), stockBefore, "stock"));
await ok("importing the same file again adds nothing", async () => {
  const r = (await one(B, "select import_sales($1, $2::jsonb) r", [shopB, JSON.stringify(past)])).r;
  eq(`${r.added} ${r.skipped}`, "0 2", "added");
  eq((await one(B, "select count(*) n from customers where shop_id = $1", [shopB])).n, 2, "customers");
});
await rejects("staff cannot import sales", () =>
  as(C, "select import_sales($1, $2::jsonb)", [shopB, JSON.stringify([{ ...past[0], ref: "S-1" }])]));
await rejects("another shop cannot import into mine", () =>
  as(A, "select import_sales($1, $2::jsonb)", [shopB, JSON.stringify([{ ...past[0], ref: "S-2" }])]));
await rejects("a sale dated in the future is refused", () =>
  as(B, "select import_sales($1, $2::jsonb)", [shopB, JSON.stringify([{ ...past[0], ref: "F-1", at: "2099-01-01" }])]));
await rejects("a bad file imports nothing at all", async () => {
  await as(B, "select import_sales($1, $2::jsonb)", [shopB, JSON.stringify([{ ...past[0], ref: "G-1" }, { ...past[0], ref: "G-2", lines: [{ sku: "CAN", qty: -1, price: 1 }] }])]);
});
await ok("...and the good half of it was rolled back", async () =>
  eq((await one(B, "select count(*) n from sales where client_id = 'import:G-1'")).n, 0, "rows"));
await ok("voiding an imported sale moves no stock", async () => {
  const before = await qtyOf(can);
  await as(B, "select void_sale_by_client($1, 'import:R-1002', null)", [shopB]);
  eq(await qtyOf(can), before, "stock");
});
await ok("the owner deletes a customer; their sales stay", async () => {
  await as(B, "delete from customers where id = $1", [cust]);
  eq((await one(B, "select count(*) n from sales where client_id in ('cust-sale-1', 'import:R-1001')")).n, 2, "sales");
});
await ok("stock still equals its movements", balanced);

console.log("Staff invites");
// D is a new cashier with no shop. A owns shop A; C is staff in shop B.
const D = "00000000-0000-0000-0000-00000000000d";
await db.exec(`insert into auth.users values ('${D}', 'cashier@example.com')`);
let code;
await ok("the owner makes an 8-character code", async () => {
  code = (await one(A, "select create_invite($1) c", [shopA])).c;
  if (!/^[A-HJKMNP-Z2-9]{8}$/.test(code)) throw new Error("bad code " + code);
});
await rejects("staff cannot make a code", () => as(C, "select create_invite($1)", [shopB]));
await rejects("another shop cannot make a code for my shop", () => as(B, "select create_invite($1)", [shopA]));
await rejects("the invites table can't be read directly", () => as(A, "select * from invites"));
await rejects("a wrong code joins nothing", () => as(D, "select join_shop('ABCD-EFGH')"));
await ok("the cashier joins as staff (dash and small letters forgiven)", async () => {
  const typed = (code.slice(0, 4) + "-" + code.slice(4)).toLowerCase();
  eq((await one(D, "select join_shop($1) s", [typed])).s, shopA, "shop");
  eq((await one(D, "select role from members where shop_id = $1 and user_id = $2", [shopA, D])).role, "staff", "role");
  eq((await one(D, "select count(*) n from items")).n, 1, "sees the shop's products");
});
await rejects("a code works only once", async () => {
  await db.exec(`insert into auth.users values ('00000000-0000-0000-0000-0000000000e1')`);
  return as("00000000-0000-0000-0000-0000000000e1", "select join_shop($1)", [code]);
});
await rejects("the new staff member cannot delete products", async () => {
  const r = await as(D, "delete from items where shop_id = $1", [shopA]);
  if (!r.affectedRows) throw new Error("nothing deleted");
});
await rejects("an expired code is refused", async () => {
  const c2 = (await one(A, "select create_invite($1) c", [shopA])).c;
  await db.exec(`update invites set expires_at = now() - interval '1 minute' where code = '${c2}'`);
  return as("00000000-0000-0000-0000-0000000000e1", "select join_shop($1)", [c2]);
});
await ok("the owner sees staff with emails and the open codes", async () => {
  const c3 = (await one(A, "select create_invite($1) c", [shopA])).c;
  const p = (await one(A, "select shop_people($1) p", [shopA])).p;
  eq(p.members.length, 2, "members");
  eq(p.members.find((m) => m.role == "staff").email, "cashier@example.com", "email");
  eq(p.invites.map((i) => i.code).join(), c3, "only the open code");
  await as(A, "select cancel_invite($1, $2)", [shopA, c3]);
  eq((await one(A, "select shop_people($1) p", [shopA])).p.invites.length, 0, "cancelled");
});
await rejects("staff cannot see the staff list", () => as(D, "select shop_people($1)", [shopA]));
await rejects("at most 10 open codes", async () => {
  for (let i = 0; i < 11; i++) await as(A, "select create_invite($1)", [shopA]);
});
await rejects("the owner cannot be removed", () => as(A, "select remove_member($1, $2)", [shopA, A]));
await rejects("staff cannot remove staff", () => as(D, "select remove_member($1, $2)", [shopA, D]));
await ok("the owner removes a cashier, who then sees nothing", async () => {
  await as(A, "select remove_member($1, $2)", [shopA, D]);
  eq((await one(D, "select count(*) n from items")).n, 0, "rows");
});

// 008_hardening.sql. Shop B again: B is the owner, C is staff.
console.log("Hardening");
const gin = (
  await one(B, "insert into items (shop_id, sku, name, price, cost) values ($1, 'GIN', 'Gin', 500000, 400000) returning id", [shopB])
).id;
await as(B, "select adjust_stock($1, 10)", [gin]);
await rejects("staff cannot change a price", () => as(C, "update items set price = 1 where id = $1", [gin]));
await rejects("staff cannot change a wholesale price", () =>
  as(C, "update items set price_wholesale = 1, wholesale_min_qty = 1 where id = $1", [gin]));
await rejects("staff cannot change a cost", () => as(C, "update items set cost = 0 where id = $1", [gin]));
await ok("staff can still rename a product and set its unit", async () =>
  eq((await one(C, "update items set name = 'Gin 70cl', unit = 'bottle' where id = $1 returning name", [gin])).name, "Gin 70cl", "name"));
await ok("staff can still add a product with a price", async () =>
  eq((await one(C, "insert into items (shop_id, sku, name, price) values ($1, 'TONIC', 'Tonic', 9000) returning price", [shopB])).price, 9000, "price"));
await ok("the owner changes a price", async () =>
  eq((await one(B, "update items set price = 450000 where id = $1 returning price", [gin])).price, 450000, "price"));
await rejects("stock cannot become NaN", () => as(C, "select adjust_stock($1, 'NaN'::numeric)", [gin]));
await rejects("stock cannot become Infinity", () => as(C, "select adjust_stock($1, 'Infinity'::numeric)", [gin]));
await rejects("a sale line cannot be NaN units", () =>
  as(C, "select create_sale($1, 'nan-sale-1', $2::jsonb, 0, 'transfer', 0, null, 'A', 900)",
    [shopB, JSON.stringify([{ item_id: gin, qty: "NaN" }])]));
await rejects("an offline sale cannot carry an Infinity price", () =>
  as(C, "select create_sale($1, 'inf-sale-1', $2::jsonb, 0, 'transfer', 0, now(), 'A', 901, true)",
    [shopB, JSON.stringify([{ item_id: gin, qty: 1, price: "Infinity" }])]));
await rejects("the owner cannot set an Infinity price either", () =>
  as(B, "update items set price = 'Infinity' where id = $1", [gin]));
await ok("the gin's stock is untouched by all of that", async () => eq(await qtyOf(gin), 10, "qty"));

// 009_pay_qr.sql. Shop B: B is the owner, C is staff.
console.log("QR payment");
await ok("the owner saves the shop's bank QR; the amount is on by default", async () => {
  const r = await one(B, "update settings set pay_qr = '000201SHOPQR' where shop_id = $1 returning pay_qr, pay_qr_amount", [shopB]);
  eq(`${r.pay_qr} ${r.pay_qr_amount}`, "000201SHOPQR true", "settings");
});
await ok("a cashier's till can read it", async () =>
  eq((await one(C, "select pay_qr from settings where shop_id = $1", [shopB])).pay_qr, "000201SHOPQR", "qr"));
await ok("a cashier cannot swap in their own QR (0 rows)", async () => {
  const r = await as(C, "update settings set pay_qr = 'CASHIER-OWN-ACCOUNT' where shop_id = $1 returning 1", [shopB]);
  eq(r.rows.length, 0, "rows");
  eq((await one(B, "select pay_qr from settings where shop_id = $1", [shopB])).pay_qr, "000201SHOPQR", "unchanged");
});
await rejects("another shop cannot read or change it", async () => {
  const r = await as(A, "update settings set pay_qr = 'X' where shop_id = $1 returning 1", [shopB]);
  if (!r.rows.length) throw new Error("no rows");
});
await rejects("an empty or oversized QR is refused", () =>
  as(B, "update settings set pay_qr = repeat('x', 513) where shop_id = $1", [shopB]));
await ok("the owner turns the amount off and removes the QR", async () => {
  await as(B, "update settings set pay_qr_amount = false, pay_qr = null where shop_id = $1", [shopB]);
  const r = await one(B, "select pay_qr, pay_qr_amount from settings where shop_id = $1", [shopB]);
  eq(`${r.pay_qr} ${r.pay_qr_amount}`, "null false", "settings");
});

console.log("Billing");
await rejects("owner cannot extend own plan", () =>
  as(A, "update shops set plan_until = now() + interval '10 years' where id = $1", [shopA]));
await db.exec(`update shops set plan_until = now() - interval '1 day' where id = '${shopA}'`);
await ok("expired shop is still readable", async () =>
  eq((await as(A, "select count(*) n from items")).rows[0].n, 1, "rows"));
await rejects("expired shop cannot add items", () =>
  as(A, "insert into items (shop_id, sku, name) values ($1, 'N', 'N')", [shopA]));
await rejects("expired shop cannot adjust stock", () => as(A, "select adjust_stock($1, 1)", [item]));

console.log("Subscription payments");
// 011_billing.sql. Z is a Rapide admin. Shop A has just expired; B owns shop B, C is staff there.
const Z = "00000000-0000-0000-0000-0000000000ad";
await db.exec(`insert into auth.users values ('${Z}', 'admin@rapide.test'); insert into platform_admins (user_id) values ('${Z}')`);
// Read as the database itself: an admin sees shops only through admin_payments().
const raw = async (sql, params) => (await db.query(sql, params)).rows[0];
const days = async (shop) =>
  Math.round(+(await raw("select extract(epoch from plan_until - now()) / 86400 d from shops where id = $1", [shop])).d);
let payA;
await ok("every signed-in user sees the plans and prices", async () => {
  const r = (await as(C, "select code, price_kip, max_tills from plans order by sort")).rows;
  eq(r.map((p) => `${p.code}:${p.price_kip}:${p.max_tills}`).join(), "small:150000:1,mini:250000:4", "plans");
});
await ok("the owner of an expired shop can ask to pay; the server sets amount and reference", async () => {
  payA = await one(A, "select * from request_payment($1, 'mini', 3)", [shopA]);
  eq(`${payA.status} ${payA.amount_kip} ${payA.months}`, "pending 750000 3", "payment");
  if (!/^RP-[0-9A-Z]{8}$/.test(payA.reference)) throw new Error("bad reference " + payA.reference);
});
await rejects("staff cannot start a payment", () => as(C, "select request_payment($1, 'small', 1)", [shopB]));
await rejects("an owner cannot pay for another shop", () => as(B, "select request_payment($1, 'small', 1)", [shopA]));
await rejects("an unknown plan is refused", () => as(A, "select request_payment($1, 'free', 1)", [shopA]));
await rejects("more than 12 months is refused", () => as(A, "select request_payment($1, 'small', 13)", [shopA]));
await rejects("a payment can't be written directly", () =>
  as(A, "insert into payments (shop_id, plan, months, amount_kip, reference) values ($1, 'mini', 1, 1, 'RP-00000000')", [shopA]));
await rejects("an owner can't mark their own payment approved", () =>
  as(A, "update payments set status = 'approved' where id = $1", [payA.id]).then((r) => {
    if (!(r.affectedRows > 0)) throw new Error("no rows");
  }));
await ok("another shop doesn't see the payment; the admin does", async () => {
  eq((await one(B, "select count(*) n from payments")).n, 0, "other shop");
  eq((await one(Z, "select count(*) n from payments")).n, 1, "admin");
});
await ok("asking again replaces the waiting payment, so only one waits", async () => {
  const again = await one(A, "select * from request_payment($1, 'mini', 1)", [shopA]);
  const r = await as(Z, "select status from payments where shop_id = $1 order by created_at", [shopA]);
  eq(r.rows.map((x) => x.status).join(), "cancelled,pending", "statuses");
  payA = again;
});
await ok("'I've paid' marks it for the admin", async () => {
  eq(!!(await one(A, "select claimed_at from claim_payment($1)", [payA.id])).claimed_at, true, "claimed");
});
await rejects("a screenshot path from another shop or payment is refused", () =>
  as(A, "select claim_payment($1, $2)", [payA.id, `${shopB}/${payA.id}.jpg`]));
await ok("the screenshot of the transfer is kept with the payment", async () => {
  const path = `${shopA}/${payA.id}.jpg`;
  eq((await one(A, "select proof_path from claim_payment($1, $2)", [payA.id, path])).proof_path, path, "own row");
  eq((await one(Z, "select proof_path from admin_payments() where id = $1", [payA.id])).proof_path, path, "admin sees it");
});
await rejects("a non-admin cannot approve, even the shop's owner", () => as(A, "select approve_payment($1)", [payA.id]));
await rejects("a non-admin cannot list every payment", () => as(B, "select * from admin_payments()"));
await ok("the admin's list shows the shop, owner and amount, waiting ones first", async () => {
  const r = await one(Z, "select shop_name, plan, amount_kip, status from admin_payments() limit 1");
  eq(`${r.shop_name} ${r.plan} ${r.amount_kip} ${r.status}`, "Shop A mini 250000 pending", "row");
});
await ok("approving reopens an expired shop for a month from today, with the plan's tills", async () => {
  await as(Z, "select approve_payment($1, 'BCEL 18/11')", [payA.id]);
  const s = await raw("select plan, max_tills from shops where id = $1", [shopA]);
  eq(`${s.plan} ${s.max_tills}`, "paid 4", "shop");
  const d = await days(shopA);
  if (d < 28 || d > 31) throw new Error("expected about a month, got " + d + " days");
  eq(
    (await as(A, "insert into items (shop_id, sku, name) values ($1, 'PAID-1', 'Paid') returning 1", [shopA])).rows.length,
    1,
    "can write again",
  );
});
await rejects("a payment can't be approved twice", () => as(Z, "select approve_payment($1)", [payA.id]));
await ok("paying early adds the months after the current plan ends, so no days are lost", async () => {
  const before = await days(shopB); // shop B is still on its trial
  const p = await one(B, "select id from request_payment($1, 'small', 2)", [shopB]);
  await as(Z, "select approve_payment($1)", [p.id]);
  const gained = (await days(shopB)) - before;
  if (gained < 58 || gained > 62) throw new Error("expected about two months added, got " + gained + " days");
  eq((await raw("select max_tills m from shops where id = $1", [shopB])).m, 1, "small plan tills");
});
await ok("a rejected payment changes nothing", async () => {
  const before = await days(shopB);
  const p = await one(B, "select id from request_payment($1, 'mini', 1)", [shopB]);
  await as(Z, "select reject_payment($1, 'no money arrived')", [p.id]);
  eq(await days(shopB), before, "days");
  eq((await one(Z, "select status, note from payments where id = $1", [p.id])).note, "no money arrived", "note");
});
await ok("the owner can cancel a waiting payment", async () => {
  const p = await one(B, "select id from request_payment($1, 'mini', 1)", [shopB]);
  await as(B, "select cancel_payment($1)", [p.id]);
  eq((await one(B, "select status from payments where id = $1", [p.id])).status, "cancelled", "status");
});
await rejects("only an admin sets Rapide's bank QR", () => as(B, "select set_billing_qr('000201')"));
await ok("the admin sets Rapide's bank QR and every user can read it", async () => {
  await as(Z, "select set_billing_qr('000201010211')");
  eq((await one(C, "select pay_qr from billing")).pay_qr, "000201010211", "qr");
});

console.log("Batch numbers on sales");
await ok("a sale's stock records which batch it left from, even one it empties; a void puts it back (017)", async () => {
  const it = (await as(A, "insert into items (shop_id, sku, name, kind, price) values ($1, 'COKE-R', 'Coke', 'consumable', 10) returning id", [shopA])).rows[0].id;
  try {
  await as(A, "select adjust_stock($1, 2, 't', $2)", [it, "2099-01-01"]);
  await as(A, "select set_lot_batch($1, $2, $3)", [it, "2099-01-01", "L100"]);
  await as(A, "select adjust_stock($1, 3, 't', $2)", [it, "2099-06-01"]);
  await as(A, "select set_lot_batch($1, $2, $3)", [it, "2099-06-01", "L200"]);
  await as(A, "select write_off_expiry($1, $2, 1, 'damaged', 'wo-017-batch')", [it, "2099-06-01"]);
  eq((await as(A, "select batch from movements where item_id = $1 and note = 'damaged'", [it])).rows[0].batch, "L200", "write-off keeps the number");
  const till = (await as(A, "select register_till($1, 'Batch test') c", [shopA])).rows[0].c;
  const sale = (await as(A, "select create_sale($1, 'c-017-batch', $2::jsonb, 0, 'cash', 1e9, null, $3) id", [shopA, JSON.stringify([{ item_id: it, qty: 4 }]), till])).rows[0].id;
  const out = (await as(A, "select expiry::text as d, batch from movements where sale_id = $1 and type = 'out' order by expiry", [sale])).rows;
  eq(out.map((r) => r.d + "=" + r.batch).join(","), "2099-01-01=L100,2099-06-01=L200", "batch of an emptied lot kept");
  eq((await as(A, "select count(*)::int as n from lots where item_id = $1", [it])).rows[0].n, 0, "both batches sold out");
  await as(A, "select void_sale_by_client($1, 'c-017-batch')", [shopA]);
  const back = (await as(A, "select expiry::text as d, batch from lots where item_id = $1 order by expiry", [it])).rows;
  eq(back.map((r) => r.d + "=" + r.batch).join(","), "2099-01-01=L100,2099-06-01=L200", "void puts the numbers back");
  } finally {
    await as(A, "delete from items where id = $1", [it]);
  }
});
await ok("stock without a date keeps its batch no. on the product; a new delivery after selling out starts fresh (018)", async () => {
  const it = (await as(A, "insert into items (shop_id, sku, name, kind, price) values ($1, 'TIGER-W', 'Tigerhead water', 'durable', 5) returning id", [shopA])).rows[0].id;
  try {
    const num = async () => (await as(A, "select batch from items where id = $1", [it])).rows[0].batch;
    await as(A, "select adjust_stock($1, 4, 'scan')", [it]);
    await as(A, "select set_lot_batch($1, null, 'TH-01')", [it]);
    eq(await num(), "TH-01", "set without a date");
    const till = (await as(A, "select register_till($1, 'Water test') c", [shopA])).rows[0].c;
    const sale = (await as(A, "select create_sale($1, 'c-018-water', $2::jsonb, 0, 'cash', 1e9, null, $3) id", [shopA, JSON.stringify([{ item_id: it, qty: 4 }]), till])).rows[0].id;
    eq((await as(A, "select batch from movements where sale_id = $1 and type = 'out'", [sale])).rows[0].batch, "TH-01", "the sale carries it");
    await as(A, "select adjust_stock($1, 6, 'scan')", [it]);
    eq(await num(), null, "sold out, new delivery: the old number is cleared");
    await as(A, "select set_lot_batch($1, null, 'TH-02')", [it]);
    await as(A, "select adjust_stock($1, 2, 'scan')", [it]);
    eq(await num(), "TH-02", "more undated stock while some is left keeps the number");
  } finally {
    await as(A, "delete from items where id = $1", [it]);
  }
});

console.log(failures ? `\n${failures} FAILED` : "\nAll database checks passed");
process.exit(failures ? 1 : 0);
