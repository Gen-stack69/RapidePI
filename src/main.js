// First, so every module after it can make IDs (see uuid.js).
import "./lib/uuid.js";
import "./styles.css";
// Lao glyphs, bundled with the app rather than fetched from a CDN, so Lao still
// renders with no internet. Only the Lao subset is pulled in: ~9 KB a weight.
import "@fontsource/noto-sans-lao/lao-400.css";
import "@fontsource/noto-sans-lao/lao-500.css";
import "@fontsource/noto-sans-lao/lao-600.css";
import "@fontsource/noto-sans-lao/lao-700.css";
import { $, E, toast, form, pickPhoto, checkExpiry, slashDate, dateText, fmt, num, dt, batchField, reasonFields, reasonOf } from "./lib/util.js";
import { t, tn, errText, setLang, other, applyStatic, fDateTime, fTime } from "./i18n/index.js";
import { readTable, guessKind, guessColumns, build, KINDS } from "./lib/importer.js";
import { exportSet, exportZip } from "./lib/export.js";
import * as store from "./data/store.js";
import { state, canWrite, isOwner, isCashier, cashierUi, CASHIER_SITE, CASHIER_URL } from "./data/store.js";
import { PRICE_KEYS, waitingBoxes, packRow } from "./data/fields.js";
import { err } from "./i18n/index.js";

const fail = (code, params) => {
  throw err(code, params);
};
import { showAuth, showCreateShop, showNewPassword, showCashierSite } from "./auth.js";
import { pendingJoin, clearJoin, inviteLink } from "./lib/invite.js";
import * as scanner from "./scanner.js";
import dash, { ui as dashUi } from "./views/dash.js";
import inv, { ui as invUi, rows as invRows } from "./views/inv.js";
import { ui as expUi, lists as expLists } from "./views/exp.js";
import ord from "./views/ord.js";
import scan from "./views/scan.js";
import rep, { conv, refreshRates } from "./views/rep.js";
import auto from "./views/auto.js";
import sys from "./views/sys.js";
import pos, * as till from "./views/pos.js";
import exp from "./views/exp.js";
import admin, { load as loadAdmin, toggleHistory } from "./views/admin.js";
import { planName } from "./views/sys.js";
import { tillQr, qrSvg } from "./lib/payqr.js";
import { status, SOON_DAYS, setSoonDays, daysLeft } from "./lib/expiry.js";
import { CUR, SIGN, kipPer } from "./lib/rates.js";
import { registerSW } from "virtual:pwa-register";
import { showTheme, switchTheme } from "./lib/theme.js";

// Registers the service worker that lets the app open with no internet. A
// new version is looked for every 30 minutes and whenever the app comes back
// to the screen, not only when it is opened: a phone can keep it open for days.
registerSW({
  immediate: true,
  onRegisteredSW(_url, reg) {
    if (!reg) return;
    const check = () => navigator.onLine && reg.update().catch(() => {});
    setInterval(check, 30 * 60e3);
    document.addEventListener("visibilitychange", () => document.visibilityState == "visible" && check());
  },
});

// After an update, the files an older open copy would load on demand (PDF,
// Excel, ZIP, camera...) are no longer on the server. Load the new version
// instead of failing; at most once a minute, so a real outage can't loop.
const STALE = /dynamically imported module|Importing a module script failed|Failed to fetch dynamically/i;
function reloadForUpdate() {
  try {
    if (Date.now() - (+sessionStorage.rpUpdateReload || 0) < 60e3) return false;
    sessionStorage.rpUpdateReload = Date.now();
  } catch {}
  toast(t("msg.newVersion"));
  setTimeout(() => location.reload(), 800);
  return true;
}
addEventListener("vite:preloadError", (ev) => reloadForUpdate() && ev.preventDefault());

const VIEWS = { dash, pos, inv, exp, ord, scan, rep, auto, sys, admin };
// [view key, icon]; the label and subtitle come from nav.<key> / nav.<key>.sub
const N = [
  ["dash", "◔"],
  ["pos", "₭"],
  ["inv", "▦"],
  ["exp", "⏳"],
  ["ord", "⛟"],
  ["scan", "▥"],
  ["rep", "▤"],
  ["auto", "⚙"],
  ["sys", "☰"],
  ["admin", "✓"], // Rapide admins only
];

// ---------- cashier mode (021) ----------
// On the cashier site, or for a cashier account: the till, products and stock
// to look at, the scanner to look up, and an Account screen. The database
// refuses a cashier's stock changes anyway; this keeps the screens to what
// works. Every button and field outside these lists is refused.
const CASHIER_VIEWS = ["pos", "inv", "scan", "sys"];
const CASHIER_ACTS = new Set([
  ...["posAdd", "posInc", "posDec", "posDel", "posCut", "posClear", "posMethod", "posQrBig", "posQuick"],
  ...["posCharge", "posReceipt", "posPrint", "posCam", "closeDlg"],
  ...["invBatches", "quickScan", "scanView", "camOn", "camOff", "syncNow", "retryFailed"],
  ...["switchShop", "registerTill", "signOut", "lang", "theme", "install", "top"],
]);
const CASHIER_INPUTS = new Set(["search", "pos", "lang", "invFilter", "invSort", "scanMode", "manualScan"]);
const allowed = (set, k) => !cashierUi() || set.has(k);
// The settings screen is the cashier's "Account".
const navKey = (k) => (k == "sys" && cashierUi() ? "acct" : k);
let view = VIEWS[location.hash.slice(1)] ? location.hash.slice(1) : "dash";

// ---------- expiry notification ----------
// Once a day, a phone or PC notification about batches expiring within a week
// (or already expired), if the owner allowed it. Shown while the app is open:
// a reminder with the app closed needs a server job (not built yet).
function expiryNote(force) {
  if (!("Notification" in window) || Notification.permission != "granted") return;
  const day = new Date().toDateString(),
    key = "rapidewms.expNote." + state.shop.id;
  let seen = null;
  try {
    seen = localStorage[key];
  } catch {}
  if (seen == day && !force) return;
  const week = state.lots.filter((l) => daysLeft(l.expiry) <= 7);
  try {
    localStorage[key] = day;
  } catch {}
  if (!week.length) return;
  const body = tn("note.expBody", week.length),
    title = t("note.expTitle", { shop: state.shop.name });
  // An installed app on Android only shows notifications through its service worker.
  if (navigator.serviceWorker?.controller)
    navigator.serviceWorker.ready.then((r) =>
      r.showNotification(title, { body, tag: "expiry", icon: import.meta.env.BASE_URL + "icon.svg" }),
    );
  else new Notification(title, { body, tag: "expiry" });
}

// ---------- paying for a plan ----------
// Rapide's bank QR with the amount and the payment's reference filled in (the
// reference goes into the transfer's note, as at the till), so the admin can
// match the money in the bank app to this shop.
function showPay(p) {
  if (!p) return;
  const qr = state.billing?.qr,
    q = qr ? tillQr(qr, p.amount_kip, true, p.reference) : null,
    dlg = $("#dlg");
  dlg.innerHTML = `<div class="qrdlg"><h3>${t("bill.payTitle", { plan: planName(p.plan), n: p.months })}</h3>${
    q ? `<div class="payqr big">${qrSvg(q.text)}</div>` : `<p class="warn">${t("bill.noQr")}</p>`
  }<b class="n big">${fmt(p.amount_kip)}</b><p class="mt">${t("bill.ref", { ref: E(p.reference) })}</p><ol class="mut mt steps-sm"><li>${t(
    q?.hasAmount ? "bill.step1Amount" : "bill.step1Type",
    { amount: fmt(p.amount_kip) },
  )}</li><li>${t(q?.ref ? "bill.step2Ref" : "bill.step2Type", { ref: E(p.reference) })}</li><li>${t("bill.step3")}</li></ol><div class="row mt">${
    p.proof_path ? "" : `<button class="b" data-act="payClaim" data-id="${E(p.id)}">${t("bill.iPaid")}</button>`
  }<button class="g" data-act="closeDlg">${t("btn.close")}</button></div></div>`;
  dlg.showModal();
}

// ---------- render ----------

// force: rebuild the till too (a language switch); otherwise it only refreshes.
// The view whose screen is in #main now (null before the first draw).
let drawn = null;
function render(force) {
  if (!state.shop) return;
  // A cashier on the manager site is sent to the cashier site.
  if (isCashier() && !CASHIER_SITE) return showCashierSite(CASHIER_URL);
  if (cashierUi() && !CASHIER_VIEWS.includes(view)) view = "pos";
  setSoonDays(state.settings.expiry_days);
  expiryNote();
  $("#auth").hidden = true;
  $("#app").hidden = false;
  const expired = state.lots.filter((l) => status(l.expiry) == "expired").length,
    alerts = expired + state.lots.filter((l) => status(l.expiry) == "soon").length;
  const lo = state.items.filter((i) => +i.qty < +i.min_qty).length,
    po = state.orders.filter((o) => o.status == "pending").length,
    days = Math.ceil((new Date(state.shop.plan_until) - Date.now()) / 864e5);

  // The whole-shop export is not for cashier mode.
  $("#hdrzip").hidden = cashierUi();
  $("#shopname").textContent = state.shop.name + (cashierUi() ? " · " + t("cs.badge") : "");
  $("#nav").innerHTML = `<h6>${t("nav.title")}</h6><div>${N.filter(([k]) => (k != "admin" || state.billing?.admin) && (!cashierUi() || CASHIER_VIEWS.includes(k))).map(
    ([k, i]) =>
      `<a class="${k == view ? "on" : ""}" href="#${k}"><i>${i}</i>${t("nav." + navKey(k))}${
        k == "inv"
          ? `<em>${state.items.length}</em>`
          : k == "ord"
            ? `<em>${po}</em>`
            : k == "exp" && alerts
              ? `<em class="warn">${alerts}</em>`
              : ""
      }</a>`,
  ).join("")}</div>`;
  // Phone: a bar along the bottom with the everyday screens; "More" opens the full list.
  const tabs = cashierUi()
    ? [["pos", "₭", "nav.tab.sell"], ["inv", "▦", "nav.tab.products"], ["scan", "▥", "nav.tab.scan"], ["sys", "☰", "nav.acct"]]
    : [["dash", "◔", "nav.tab.home"], ["pos", "₭", "nav.tab.sell"], ["inv", "▦", "nav.tab.products"]];
  $("#tabs").innerHTML =
    tabs.map(([k, i, l]) => `<a class="${k == view ? "on" : ""}" href="#${k}"><i>${i}</i>${t(l)}</a>`).join("") +
    (cashierUi()
      ? ""
      : `<button type="button" class="${tabs.some(([k]) => k == view) ? "" : "on"}" data-act="more"><i>☰</i>${t("nav.tab.more")}</button>`);
  $("#eng").innerHTML = `<div>${t("eng.status")}<b>${t(
    state.online ? "eng.online" : "eng.offline",
  )}</b></div><p class="plan ${days <= 0 ? "expired" : ""}">${
    days <= 0
      ? t("plan.expiredShort")
      : tn("plan.left", days, { plan: t(state.shop.plan == "paid" ? "plan.paid" : "plan.trial") })
  }</p>`;

  // Offline, or work not yet on the server: say so, and how old the data is.
  const sy = $("#sync"),
    failed = state.failed.length;
  sy.hidden = state.online && !state.pending && !failed;
  sy.className = "btn sync" + (state.online ? "" : " off") + (failed ? " bad" : "");
  sy.textContent = [
    state.online ? "" : t("sync.offline", { time: !state.savedAt ? "–" : new Date(state.savedAt).toDateString() == new Date().toDateString() ? fTime(state.savedAt, false) : fDateTime(state.savedAt) }),
    state.pending ? tn("sync.waiting", state.pending) : "",
    failed ? tn("sync.failed", failed) : "",
  ]
    .filter(Boolean)
    .join(" · ");

  // The till draws its own changes, so a sale in progress is never wiped.
  if (view == "pos" && $("#pos") && !force) return till.refresh();
  // Don't wipe the camera view or an input the user is typing in. That only
  // holds while the screen on show is still this view: after a tap on another
  // screen (or a language switch, force) the field belongs to the old screen
  // and must go, or the old screen stays up and the new one's parts are missing.
  const same = drawn == view && !force;
  // The warnings on top (low stock, expired…). When the screen itself is kept
  // (camera on, a box being typed in), they are still brought up to date.
  const bans = banners(expired, lo);
  if (same && view == "scan" && scanner.active()) return setBanners(bans);
  const focused = document.activeElement;
  if (same && focused && $("#main").contains(focused) && focused.matches("input,select")) {
    if (view == "inv" && $("#tb")) $("#tb").innerHTML = invRows(state);
    if (view == "exp" && $("#expl")) $("#expl").innerHTML = expLists(state);
    return setBanners(bans);
  }
  if ($("#dlg").open && !force) return;
  drawn = view;

  // Only Inventory gets the title card with "Add product" and "Quick scan":
  // on every other screen they were noise. A screen opened from the phone's
  // "More" list gets just its name (.ptitle, phone only), since no tab is lit for it.
  $("#main").innerHTML = `${
    view == "inv"
      ? `<div class="card top"><div><h2>${t("nav.inv")}</h2><p>${t(
          cashierUi() ? "cs.inv.sub" : "nav.inv.sub",
        )}</p></div><div class="r">${cashierUi() ? "" : `<button class="b" data-act="addItem">${t("btn.addItem")}</button>`}<button class="g" data-act="quickScan">${t("btn.quickScan")}</button></div></div>`
      : tabs.some(([k]) => k == view)
        ? ""
        : `<h2 class="ptitle">${t("nav." + navKey(view))}</h2>`
  }${bans}${VIEWS[view](state)}`;
  if (view == "rep") conv();
  if (view == "scan") syncScanView();
}
store.onChange(render);

// The warning cards at the top of a screen, each marked data-ban.
function banners(expired, lo) {
  const card = (html) => `<div class="card warn" data-ban>${html}</div>`;
  return [
    !canWrite() &&
      card(
        `${t("plan.expiredCard")}${store.configured && isOwner() && view != "sys" ? ` <a href="#sys">${t("bill.renew")}</a>` : ""}`,
      ),
    // Only on the screens built from orders/movements; products are never capped.
    state.truncated && ["dash", "ord", "rep"].includes(view) && card(t("msg.truncated")),
    expired && !["exp", "pos"].includes(view) && card(`${t("msg.expired", { n: expired })} <a href="#exp">${t("msg.openExp")}</a>`),
    state.settings.low_alert && lo && !["auto", "pos"].includes(view) && card(tn("msg.low", lo)),
  ]
    .filter(Boolean)
    .join("") + limitNotes();
}

// Swap the warning cards of the screen on show for new ones, leaving the rest.
function setBanners(html) {
  const m = $("#main");
  m.querySelectorAll(":scope > [data-ban]").forEach((e) => e.remove());
  const after = m.querySelector(":scope > .card.top, :scope > .ptitle");
  if (after) after.insertAdjacentHTML("afterend", html);
  else m.insertAdjacentHTML("afterbegin", html);
}

// 023: products and photos at 80% of the plan or more, for the owner and
// managers on the screens where they add them. Adding stops at the limit;
// selling never does.
function limitNotes() {
  const s = state.shop;
  if (cashierUi() || !s?.max_items || !["dash", "inv", "sys"].includes(view)) return "";
  const up = isOwner() && store.configured && view != "sys" ? ` <a href="#sys">${t("lim.upgrade")}</a>` : "";
  return [
    [state.items.length, s.max_items, "lim.items"],
    [state.items.filter((i) => i.photo).length, s.max_photos, "lim.photos"],
  ]
    .filter(([n, max]) => max && n >= 0.8 * max)
    .map(([n, max, k]) => `<div class="card warn" data-ban>${t(k, { n: num(n), max: num(max) })}${up}</div>`)
    .join("");
}

async function go(v, camOn) {
  await scanner.cam(false);
  if (cashierUi() && !CASHIER_VIEWS.includes(v)) v = "pos";
  view = v;
  if (location.hash.slice(1) != v) history.replaceState(null, "", "#" + v);
  render();
  (innerWidth <= 900 ? $("#main") : document.body).scrollIntoView();
  if (camOn) scanner.cam(true);
}
addEventListener("hashchange", () => VIEWS[location.hash.slice(1)] && go(location.hash.slice(1)));
// A form that saves while open (its check) can't redraw the screen under it.
$("#dlg").addEventListener("close", () => render());
// Picking a screen (even the one on show) closes the phone's "More" list.
addEventListener("click", (e) => {
  if (e.target.closest("#nav a, #tabs a")) document.body.classList.remove("more");
});

// ---------- actions ----------

const needWrite = () => {
  if (canWrite()) return true;
  toast(t("err.readonly"), true);
  return false;
};

// A SKU for a product saved without one: P0001, P0002… (most small shops
// have no product codes; the barcode, when there is one, is what gets scanned).
function newSku() {
  const n = Math.max(0, ...state.items.map((x) => +(/^P(\d+)$/i.exec(x.sku)?.[1] ?? 0)));
  return "P" + String(n + 1).padStart(4, "0");
}

// What stops a product form from saving, as a message, or "" when it can be saved.
function itemProblem(id, before, f) {
  const code = (f.barcode.trim() || f.sku.trim()).toLowerCase();
  // One barcode, one product: a scan can only ever find one of two.
  const other =
    code &&
    (state.items.find((x) => x.id != id && [x.barcode, x.sku].some((c) => String(c || "").toLowerCase() == code)) ||
      // (a product's own box may carry its barcode: many cartons do)
      state.items.find((x) => x.id != id && state.packs.some((p) => p.item_id == x.id && String(p.barcode || "").toLowerCase() == code)));
  if (other) return t("err.dupBarcode", { name: other.name });
  // A date belongs to stock coming in: with none added it would be dropped.
  if (f.expiry && !(+f.qty > +(before.qty || 0))) return t("err.expiryNoQty");
  // A batch number is kept with the date of the stock it came on.
  if (f.batch?.trim() && !(+f.qty > +(before.qty || 0))) return t("err.batchNoQty");
  return "";
}



// start: { expiry (as typed, 31/12/2027), batch } to begin with, from the scanner.
async function itemForm(id, code, start = null) {
  if (!needWrite()) return;
  const i = state.items.find((x) => x.id == id) || {
    // A scanned code is the barcode only; the product code is made (P0001…),
    // so correcting a wrong barcode later leaves nothing of it behind.
    sku: "",
    barcode: code || "",
    name: "",
    category: "",
    // Most of what a mini-mart sells has a date on it; the date box can stay empty.
    kind: "consumable",
    qty: 0,
    min_qty: 0,
    cost: 0,
    price: 0,
    price_wholesale: 0,
    wholesale_min_qty: 0,
  };
  const shown = +i.qty; // the stock the form opened with
  let photoErr = "";
  // Saved with the form still open: a problem shows in it, with what was typed kept.
  const ok = await itemFields(id, { ...i, expiry: start?.expiry || "", batch: start?.batch || "" }, async (typed) => {
    const f = { ...typed },
      pic = f.photo; // undefined = as it was, a File = new, "" = removed
    delete f.photo;
    const why = itemProblem(id, i, f);
    if (why) return why;
    if (!f.sku.trim()) f.sku = newSku();
    // Quantity left as it was shown: keep the stock as it is now. A sale or
    // delivery on another till while the form was open must not be undone.
    if (id && +f.qty == shown) f.qty = state.items.find((x) => x.id == id)?.qty ?? f.qty;
    await store.saveItem(id, f);
    // The product is saved first, so a photo that can't be sent (no
    // internet, too big) never loses what was typed.
    const saved = id || state.items.find((x) => x.sku.toLowerCase() == f.sku.trim().toLowerCase())?.id;
    if (pic !== undefined && saved)
      try {
        await store.setItemPhoto(saved, pic || null);
      } catch (e) {
        photoErr = errText(e);
      }
    return "";
  });
  if (!ok) return;
  if (photoErr) return toast(t("err.photoSave", { why: photoErr }), true);
  toast(t(id ? "msg.itemSaved" : "msg.itemAdded"));
}

// A sell price under the cost (in kip, whatever the cost was typed in), as a
// warning: selling at a loss can be meant (a loss leader), so it never blocks.
function belowCost(fm) {
  const el = fm.elements;
  if (!el.cost || !el.price) return "";
  const cost = (+el.cost.value || 0) * kipPer(el.cost_currency?.value || "LAK"),
    out = [];
  for (const [k, key] of [
    ["price", "warn.belowCost"],
    ["price_wholesale", "warn.wBelowCost"],
  ]) {
    const p = +el[k]?.value || 0;
    if (cost > 0 && p > 0 && p < cost) out.push(t(key, { loss: fmt(Math.round((cost - p) * 100) / 100) }));
  }
  return out.join(" ");
}

function itemFields(id, i, check) {
  const photo = store.photoSrc(state.items.find((x) => x.id == id));
  return form(t(id ? "title.editItem" : "title.addItem"), [
    { k: "sku", label: t("f.sku"), value: i.sku, hint: id ? "" : t("f.skuHint") },
    { k: "name", label: t("f.name"), value: i.name, required: true },
    // Optional: a picture helps staff pick the right product.
    { k: "photo", label: t("f.photo"), type: "photo", value: photo, hint: t("f.photoHint") },
    { k: "category", label: t("f.category"), value: i.category },
    { k: "unit", label: t("f.unit"), value: i.unit || "", hint: t("f.unitHint") },
    {
      k: "kind",
      label: t("f.kind"),
      type: "select",
      value: i.kind || "durable",
      options: [
        ["consumable", t("kind.consumableLong")],
        ["durable", t("kind.durableLong")],
      ],
    },
    { k: "barcode", label: t("f.barcode"), value: i.barcode ?? "" },
    { k: "qty", label: t("f.qty"), type: "number", value: +i.qty },
    {
      k: "expiry",
      label: t(id ? "f.expiryAdded" : "f.expiry"),
      type: "expiry",
      value: i.expiry || "",
      tools: [{ act: "readDate", label: t("btn.readDate") }],
      hint: t("f.expiryHint"),
    },
    // Every product may have a date and batch no. (batteries, paint, cosmetics);
    // only for consumables does the app ask for one and warn when it is missing.
    { ...batchField(id ? "f.batchAdded" : "f.batch"), value: i.batch || "" },
    { k: "min_qty", label: t("f.min"), type: "number", value: +i.min_qty },
    {
      k: "cost_currency",
      label: t("f.costCur"),
      type: "select",
      value: i.cost_currency || "LAK",
      options: CUR.map((c) => [c, c == "LAK" ? "₭ LAK" : `${SIGN[c]} ${c}`]),
    },
    { k: "cost", label: t("f.costIn"), type: "number", value: i.cost_currency && i.cost_currency != "LAK" ? +i.cost_orig : +i.cost },
    { k: "price", label: t("f.price"), type: "number", value: +i.price || 0 },
    { k: "price_wholesale", label: t("f.wprice"), type: "number", value: +i.price_wholesale || 0 },
    { k: "wholesale_min_qty", label: t("f.wmin"), type: "number", value: +i.wholesale_min_qty || 0 },
    // Staff add products with prices, but only the owner changes them later.
  ].filter((x) => !id || isOwner() || !PRICE_KEYS.includes(x.k)),
    t("btn.save"),
    "",
    check,
    belowCost,
  );
}

// A bigger unit of a product: "Carton" = 24 cans, with its own barcode and price.
// Anyone can add one and leave the count for later (010_receive_packs.sql);
// only the owner prices it, and a priced pack is the owner's to change.
// itemId null: pick the product first (a box scanned with an unknown code).
// Returns the saved pack's item id, or null when nothing was saved.
async function packForm(itemId, packId, code = "") {
  if (!needWrite()) return null;
  const owner = isOwner(),
    // A new box has no count yet (null), so the count may be left empty.
    p = state.packs.find((x) => x.id == packId) || { name: t("f.boxDefault"), size: null, barcode: code, price: "" };
  if (packId && +p.price && !owner) return toast(t("err.noPerm"), true), null;
  let it = state.items.find((x) => x.id == (itemId || p.item_id));
  const label = (i) => `${i.name} · ${i.sku}`,
    // The product typed into the box form (by its label, code or name).
    typedItem = (f) => {
      const typed = String(f.item || "").trim().toLowerCase();
      return (
        state.items.find((i) => label(i).toLowerCase() == typed) ||
        state.items.find((i) => i.sku.toLowerCase() == typed || i.barcode?.toLowerCase() == typed) ||
        state.items.find((i) => i.name.toLowerCase() == typed)
      );
    },
    // Checked with the form still open, so a mistake keeps what was typed.
    check = (f) => {
      if (f.remove == "yes") {
        const n = waitingBoxes(state.packReceipts, packId);
        return n ? t("err.packWaiting", { n }) : "";
      }
      packRow(f); // a bad name or count throws, and shows in the form
      const clash = packClash((it || typedItem(f))?.id, packId, f.barcode);
      return clash ? t("err.dupBarcode", { name: clash.name }) : "";
    },
    unit = it?.unit || t("f.unitWord"),
    f = await form(
      it ? t(packId ? "title.editPack" : "title.addPack", { name: it.name }) : t("title.linkBox"),
      [
        ...(it
          ? []
          : [
              {
                k: "item",
                label: t("f.boxItem"),
                required: true,
                list: [...state.items].sort((a, b) => a.name.localeCompare(b.name)).map(label),
                hint: t("f.boxItemHint"),
              },
            ]),
        { k: "name", label: t("f.packName"), value: p.name, required: true, hint: t("f.packNameHint") },
        {
          k: "size",
          label: t("f.packSize", { unit }),
          type: "number",
          value: p.size ?? "",
          // Once counted it stays counted; before that it may stay empty.
          required: p.size != null,
          hint: p.size == null ? t("f.packSizeLater") : "",
        },
        { k: "barcode", label: t("f.barcode"), value: p.barcode || "" },
        ...(owner ? [{ k: "price", label: t("f.packPrice"), type: "number", value: p.price, hint: t("f.packPriceHint") }] : []),
        ...(packId && owner
          ? [{ k: "remove", label: t("f.packRemove"), type: "select", value: "no", options: [["no", t("f.no")], ["yes", t("f.packRemoveYes")]] }]
          : []),
      ],
      t("btn.save"),
      "",
      check,
    );
  if (!f) return null;
  if (!it) {
    it = typedItem(f);
    // Not a product here yet (a carton of something new): add it now, so the
    // box always belongs to a product and no second product is made later.
    if (!it) it = await newItemForBox(f);
    if (!it) return null;
  }
  if (f.remove == "yes") {
    const n = waitingBoxes(state.packReceipts, packId);
    if (n) return toast(t("err.packWaiting", { n }), true), null;
    await store.deletePack(packId);
    toast(t("msg.deleted"));
    return null;
  }
  // A changed count: offer to correct the boxes already received at the old one.
  const size = String(f.size ?? "").trim() == "" ? null : +f.size;
  if (packId && p.size != null && size != null && size != +p.size) {
    const since = p.sized_at || p.created_at || "",
      got = state.packReceipts
        // Counted at the old count since it was set: boxes that waited count
        // from when they were counted, not when they arrived.
        .filter((r) => r.pack_id == packId && r.size != null && +r.size == +p.size && (r.counted_at || r.created_at) >= since)
        .reduce((a, r) => a + +r.boxes, 0),
      fix = await form(
        t("title.fixBoxes"),
        [{ k: "fix", label: t("f.fixBoxes", { old: num(p.size) }), type: "number", value: got, hint: t("f.fixHint", { old: num(p.size), size: num(size) }) }],
        t("btn.save"),
      );
    if (!fix) return null;
    f.fix = Math.max(0, +fix.fix || 0);
  }
  // Checked again: a product just added for the box wasn't known before.
  const clash = packClash(it.id, packId, f.barcode);
  if (clash) return toast(t("err.dupBarcode", { name: clash.name }), true), null;
  const waiting = packId ? waitingBoxes(state.packReceipts, packId) : 0;
  await store.savePack(packId || null, it.id, f);
  toast(waiting && size != null && p.size == null ? t("msg.boxCounted", { n: num(waiting * size), unit }) : t("msg.saved"));
  return it.id;
}

// One barcode, one product: a box's barcode may not be another product's own
// barcode or code, or any other box's. Returns the product it clashes with.
function packClash(itemId, packId, barcode) {
  const bc = String(barcode || "").trim().toLowerCase(),
    same = (c) => String(c || "").trim().toLowerCase() == bc;
  if (!bc) return null;
  return (
    state.items.find((x) => x.id != itemId && (same(x.barcode) || same(x.sku))) ||
    state.items.find((x) => state.packs.some((q) => q.id != packId && q.item_id == x.id && same(q.barcode))) ||
    null
  );
}

// The product inside a box, added from the box form when it isn't in the shop
// yet. The box's own fields are checked first, so a mistake there doesn't
// leave a new product with no box. Returns the new product, or null.
async function newItemForBox(box) {
  packRow(box);
  const bc = String(box.barcode || "").trim();
  if (bc && state.packs.some((p) => p.barcode == bc)) fail("err.packBarcode");
  const typed = String(box.item || "").trim(),
    f = await form(
      t("title.newItemInBox"),
      [
        { k: "sku", label: t("f.sku"), required: true },
        { k: "name", label: t("f.name"), value: typed, required: true },
        { k: "unit", label: t("f.unit"), hint: t("f.unitHint") },
        {
          k: "kind",
          label: t("f.kind"),
          type: "select",
          value: "durable",
          options: [
            ["consumable", t("kind.consumableLong")],
            ["durable", t("kind.durableLong")],
          ],
        },
        { k: "barcode", label: t("f.barcode"), hint: t("f.singleBarcodeHint") },
        { k: "price", label: t("f.price"), type: "number" },
      ],
      t("btn.next"),
      E(t("f.newItemNote", { name: typed })),
      async (f) => {
        const why = itemProblem(null, {}, { ...f, expiry: "", batch: "" });
        if (why) return why;
        await store.saveItem(null, {
          ...f,
          category: "",
          qty: 0,
          expiry: "",
          min_qty: 0,
          cost_currency: "LAK",
          cost: 0,
          price_wholesale: 0,
          wholesale_min_qty: 0,
        });
        return "";
      },
    );
  if (!f) return null;
  return state.items.find((i) => i.sku.toLowerCase() == f.sku.trim().toLowerCase()) || null;
}

// Boxes waiting to be counted: open one, count, enter it.
async function countPack(packId) {
  if (!needWrite()) return;
  const p = state.packs.find((x) => x.id == packId),
    it = p && state.items.find((i) => i.id == p.item_id);
  if (!it) return;
  if (+p.price && !isOwner()) return toast(t("err.noPerm"), true);
  const n = waitingBoxes(state.packReceipts, packId),
    unit = it.unit || t("f.unitWord"),
    f = await form(
      t("title.countPack", { pack: p.name, name: it.name }),
      [{ k: "size", label: t("f.packSize", { unit }), type: "number", required: true, hint: t("f.countHint", { n: num(n) }) }],
      t("btn.save"),
      "",
      async (f) => (await store.setPackSize(packId, +f.size, 0), ""),
    );
  if (!f) return;
  toast(t("msg.boxCounted", { n: num(n * +f.size), unit }));
}

// Import wizard: the file -> what it holds -> which column is which -> check -> import.
async function importFile(file) {
  let tb;
  try {
    tb = await readTable(file);
  } catch {
    return toast(t("imp.unreadable"), true);
  }
  if (!tb.rows.length) return toast(t("msg.importEmpty"), true);
  const kinds = ["products", ...(isOwner() ? ["sales"] : [])],
    guessed = guessKind(tb.head),
    one = await form(
      t("imp.title", { file: file.name }),
      [
        {
          k: "kind",
          label: t("imp.what"),
          type: "select",
          value: kinds.includes(guessed) ? guessed : "products",
          options: kinds.map((k) => [k, t("imp.kind." + k)]),
        },
      ],
      t("btn.next"),
      E(t("imp.rows", { n: num(tb.rows.length) })),
    );
  if (!one) return;
  const kind = one.kind,
    guess = guessColumns(tb.head, kind),
    sample = (i) =>
      tb.rows
        .slice(0, 3)
        .map((r) => String(r[i] ?? "").trim())
        .filter(Boolean)
        .join(" · ")
        .slice(0, 60),
    cols = [["-1", t("imp.none")], ...tb.head.map((h, i) => [String(i), `${h || t("imp.col", { n: i + 1 })}${sample(i) ? "  (" + sample(i) + ")" : ""}`])],
    two = await form(
      t("imp.match"),
      KINDS[kind].map((f) => ({
        k: f.k,
        label: t("imp.f." + kind + "." + f.k) + (f.req ? " *" : ""),
        type: "select",
        value: String(guess[f.k]),
        options: cols,
      })),
      t("btn.next"),
      t(kind == "sales" ? "imp.matchSales" : "imp.matchNote"),
    );
  if (!two) return;
  const map = Object.fromEntries(KINDS[kind].map((f) => [f.k, +two[f.k]])),
    missing = KINDS[kind].filter((f) => f.req && map[f.k] < 0);
  if (missing.length) return toast(t("imp.need", { f: missing.map((f) => t("imp.f." + kind + "." + f.k)).join(", ") }), true);
  const { records, dropped } = build(kind, tb.rows, map);
  if (!records.length) return toast(t("msg.importEmpty"), true);
  const head = {
      products: ["imp.h.sku", "imp.h.name", "imp.h.qty", "imp.h.price"],
      sales: ["imp.h.receipt", "imp.h.date", "imp.h.lines", "imp.h.total"],
    }[kind],
    cells = (x) =>
      kind == "products"
        ? [x.sku, x.name, num(x.qty), fmt(x.price)]
        : [x.ref, dt(x.at), num(x.lines.length), fmt(x.lines.reduce((a, l) => a + l.qty * l.price, 0) - x.discount)],
    preview = `<table class="rt mt"><thead><tr>${head.map((k) => `<th>${t(k)}</th>`).join("")}</tr></thead><tbody>${records
      .slice(0, 10)
      .map((x) => `<tr>${cells(x).map((v) => `<td>${E(v ?? "")}</td>`).join("")}</tr>`)
      .join("")}</tbody></table>`,
    note = `${t("imp.preview", { n: num(Math.min(10, records.length)), total: num(records.length) })}${
      dropped ? " " + t("imp.dropped", { n: num(dropped) }) : ""
    }${kind == "sales" ? " " + t("imp.salesNote") : ""}${preview}`,
    three = await form(t("imp.confirm"), [], t("imp.go", { n: num(records.length) }), note);
  if (!three) return;
  toast(t("imp.working"));
  let added, skipped;
  if (kind == "products") (added = await store.importItems(records)), (skipped = records.length - added);
  else ({ added, skipped } = await store.importSales(records));
  toast(t("imp.done", { added: num(added), skipped: num(skipped) }));
}

const A = {
  addPack: (el) => packForm(el.dataset.id),
  editPack: (el) => packForm(el.dataset.item, el.dataset.id),
  countPack: (el) => countPack(el.dataset.id),
  // From the scanner: a box with a code nobody knows yet (or a product with no
  // box). Once linked, the code is scanned again so the box is received now.
  async linkBox(el) {
    const scanned = el.dataset.scan || "";
    if (!(await packForm(el.dataset.item || null, null, el.dataset.code || ""))) return;
    if (scanned && view == "scan" && $("#mode")?.value != "look") await scanner.again(scanned);
  },
  async lotPrice(el) {
    if (!needWrite()) return;
    const it = state.items.find((x) => x.id == el.dataset.item),
      lot = state.lots.find((l) => l.item_id == it.id && l.expiry == el.dataset.exp),
      f = await form(
        t("title.lotPrice", { name: it.name, d: dateText(lot.expiry) }),
        [{ k: "price", label: t("f.lotPrice", { p: fmt(it.price) }), type: "number", value: lot.price ?? "", hint: t("f.lotPriceHint") }],
        t("btn.save"),
        "",
        async (f) => (await store.setLotPrice(it.id, lot.expiry, f.price === "" ? null : Math.max(0, +f.price)), ""),
      );
    if (!f) return;
    toast(t("msg.saved"));
  },
  async allowNotes() {
    if ((await Notification.requestPermission()) == "granted") expiryNote(true);
    render();
  },
  // From the scanner while receiving, the new product starts with the date
  // and batch no. in the scanner's boxes (or the date printed in the code).
  addItem: (el) => itemForm(null, el.dataset.code, view == "scan" ? scanner.receiveStart(el.dataset.exp) : null),
  editItem: (el) => itemForm(el.dataset.id),
  async delItem(el) {
    const it = state.items.find((x) => x.id == el.dataset.id);
    if (!needWrite() || !confirm(t("ask.delItem", { sku: it.sku, name: it.name }))) return;
    await store.deleteItem(it.id);
    toast(t("msg.deleted"));
  },
  async adj(el) {
    if (!needWrite()) return;
    const it = state.items.find((x) => x.id == el.dataset.id),
      dir = +el.dataset.dir,
      dated = dir > 0,
      f = await form(
        t(dir > 0 ? "title.addStock" : "title.removeStock", { sku: it.sku }),
        [
        { k: "q", label: t("f.howMany", { qty: +it.qty }), type: "number", value: 1, required: true },
        ...(dated
          ? [
              {
                k: "expiry",
                label: t("f.expiry"),
                type: "expiry",
                tools: [{ act: "readDate", label: t("btn.readDate") }],
                hint: t("f.expiryHint"),
              },
              batchField(),
            ]
          : // Taking stock out by hand says why (025): the owner's check on shrinkage.
            reasonFields("remove")),
        ],
        t("btn.save"),
        "",
        // Checked and saved with the form open: "only 22 in stock" shows in it.
        async (f) => {
          const q = +f.q;
          if (!(q > 0)) return t("err.qtyAboveZero");
          const now = +(state.items.find((x) => x.id == it.id)?.qty ?? 0);
          if (dir < 0 && q > now) return t("err.removeTooMany", { n: num(now) });
          const why = dir < 0 ? reasonOf(f) : null;
          if (why?.why) return why.why;
          await store.adjust(it.id, dir * q, "manual", (dated && f.expiry) || null, why);
          const batch = (dated && f.batch?.trim()) || "";
          if (batch) await store.setLotBatch(it.id, f.expiry || null, batch);
          return "";
        },
      );
    if (!f) return;
    toast(t("msg.adjusted", { sku: it.sku, sign: dir > 0 ? "+" : "−", q: +f.q }));
  },
  async addOrder() {
    if (!needWrite()) return;
    const item_id = $("#o_s").value,
      qty = +$("#o_q").value;
    if (!item_id || !(qty > 0)) return toast(t("msg.pickProduct"), true);
    await store.addOrder({ item_id, qty, type: $("#o_t").value, party: $("#o_p").value.trim() });
    toast(t("msg.orderCreated"));
  },
  async doneOrder(el) {
    if (!needWrite()) return;
    // Goods arriving can carry their expiry date and batch no., so they
    // show on the Expiry screen like stock received any other way.
    const o = state.orders.find((x) => x.id == el.dataset.id),
      it = o && state.items.find((i) => i.id == o.item_id);
    if (o?.type == "in" && it) {
      const f = await form(
        t("title.receiveOrder", { qty: num(o.qty), name: it.name }),
        [
          {
            k: "expiry",
            label: t("f.expiry"),
            type: "expiry",
            tools: [{ act: "readDate", label: t("btn.readDate") }],
            hint: t("f.expiryHint"),
          },
          batchField(),
        ],
        t("ord.complete"),
        "",
        async (f) => (await store.completeOrder(el.dataset.id, f.expiry || null, f.batch?.trim() || ""), ""),
      );
      if (!f) return;
    } else await store.completeOrder(el.dataset.id, null, "");
    toast(t("msg.orderDone"));
  },
  async delOrder(el) {
    if (!needWrite() || !confirm(t("ask.delOrder"))) return;
    await store.deleteOrder(el.dataset.id);
  },
  // ---- expiry ----
  async readDate(el) {
    const box = el.form?.elements[el.dataset.for] || $("#" + el.dataset.for);
    const photo = await pickPhoto();
    if (!photo) return;
    const label = el.textContent;
    try {
      const { readExpiry } = await import("./lib/ocr.js");
      const r = await readExpiry(photo, (stage) => (el.textContent = t("ocr." + stage)));
      if (!r.expiry) return toast(t("ocr.none"), true);
      box.value = scanner.typedDate(r.expiry);
      checkExpiry(box);
      if (box.id == "sexp") scanner.dateTyped();
      toast(t("ocr.found", { d: dateText(r.expiry) }));
    } finally {
      el.textContent = label;
    }
  },
  // A batch's date was typed wrong: move the whole batch to the right date.
  async lotDate(el) {
    if (!needWrite()) return;
    // a no-date batch (019) can be given its date here too
    const lot = [...state.lots, ...state.ulots].find((l) => l.id == el.dataset.id),
      it = lot && state.items.find((i) => i.id == lot.item_id);
    if (!it) return;
    let merge = false;
    const f = await form(
      t(lot.expiry ? "title.lotDate" : "title.addDate", { name: it.name, n: num(lot.qty) }),
      [
        {
          k: "expiry",
          label: t("f.newExpiry"),
          type: "expiry",
          value: scanner.typedDate(lot.expiry),
          required: true,
          tools: [{ act: "readDate", label: t("btn.readDate") }],
          hint: lot.expiry ? t("f.newExpiryHint", { d: dateText(lot.expiry) }) : t("f.addExpiryHint"),
        },
      ],
      t("btn.save"),
      "",
      async (f) => {
        if (!f.expiry) return t("err.needDate");
        if (f.expiry == lot.expiry) return "";
        merge = state.lots.some((l) => l.item_id == lot.item_id && l.expiry == f.expiry && l.id != lot.id);
        await store.changeLotExpiry(lot.id, f.expiry);
        return "";
      },
    );
    if (!f || f.expiry == lot.expiry) return;
    toast(t(merge ? "msg.lotMerged" : "msg.lotDateChanged", { d: dateText(f.expiry) }));
  },
  // Type or correct the batch / production number(s) of one batch.
  async lotBatch(el) {
    if (!needWrite()) return;
    // A batch by id (dated or no-date), or from the scanner's log, where a
    // batch received offline has no lasting id: by product and date, the
    // product's newest no-date batch (data-latest), or its latest no-date
    // delivery that has no number yet (data-new).
    const d = el.dataset,
      lot = d.id
        ? [...state.lots, ...state.ulots].find((l) => l.id == d.id)
        : d.exp
          ? state.lots.find((l) => l.item_id == d.item && l.expiry == d.exp)
          : d.latest
            ? state.ulots.filter((l) => l.item_id == d.item).at(-1)
            : d.new
              ? { item_id: d.item, expiry: null, batch: "", fresh: true }
              : null,
      it = lot && state.items.find((i) => i.id == lot.item_id);
    if (!it) return toast(t("err.lotNotFound"), true);
    const f = await form(
      t(lot.expiry ? "title.lotBatch" : "title.undatedBatch", { name: it.name, d: dateText(lot.expiry) }),
      [{ k: "batch", label: t("f.batch"), value: lot.batch || "", hint: t(lot.expiry ? "f.batchEditHint" : "f.batchUndatedHint") }],
      t("btn.save"),
      "",
      async (f) => {
        if (f.batch.trim() == (lot.batch || "")) return "";
        if (lot.fresh) await store.setLotBatch(it.id, null, f.batch, true);
        else if (!lot.expiry) await store.setUndatedBatch(lot.id, f.batch);
        else await store.setLotBatch(it.id, lot.expiry, f.batch, false);
        return "";
      },
    );
    if (!f || f.batch.trim() == (lot.batch || "")) return;
    if (!d.id && el.isConnected) {
      el.textContent = scanner.batchLabel(f.batch.trim());
      if (lot.fresh && f.batch.trim()) {
        delete el.dataset.new;
        el.dataset.latest = "1";
      }
    }
    toast(t("msg.saved"));
  },
  async writeOff(el) {
    if (!needWrite()) return;
    const lot = state.lots.find((l) => l.id == el.dataset.id),
      it = lot && state.items.find((i) => i.id == lot.item_id);
    if (!it) return;
    const n = +lot.qty; // read first: the lot is emptied by the write-off
    // Asked in the app's own window, with why (025): "Expired" unless changed.
    const f = await form(
      t("exp.writeOff") + " – " + it.name,
      reasonFields("remove", "expired"),
      t("exp.writeOff"),
      E(t("ask.writeOff", { n, name: it.name, d: dateText(lot.expiry) })),
      async (v) => {
        const why = reasonOf(v);
        if (why.why) return why.why;
        await store.writeOffLot(lot.id, "expired", why);
        return "";
      },
    );
    if (f) toast(t("msg.writtenOff", { n, sku: it.sku }));
  },
  // ---- offline work ----
  async syncNow() {
    if (!state.online) return toast(t("sync.stillOffline"), true);
    const out = await store.sync();
    toast(out.stopped ? t("sync.stillOffline") : tn("sync.sent", out.sent.length), out.stopped);
  },
  async retryFailed(el) {
    await store.retryFailed(el.dataset.id);
  },
  async discardFailed(el) {
    if (!confirm(t("sync.askDiscard"))) return;
    await store.discardFailed(el.dataset.id);
  },
  // ---- the till ----
  posAdd: (el) => till.add(el.dataset.id),
  posInc: (el) => till.inc(el.dataset.id, 1),
  posDec: (el) => till.inc(el.dataset.id, -1),
  posDel: (el) => till.remove(el.dataset.id),
  posCut: (el) => till.toggleCut(el.dataset.id),
  posClear: () => till.clear(),
  posMethod: (el) => till.setMethod(el.dataset.m),
  posQrBig: () => till.showQr(),
  // ---- bank QR (owner, in Shop & backup) ----
  // A photo or screenshot of the shop's QR sticker. On a phone this opens the
  // camera; on a PC, the file picker (a screenshot from the bank app works).
  async payQrSet(el) {
    if (!needWrite()) return;
    const photo = await pickPhoto();
    if (!photo) return;
    const label = el.textContent;
    el.textContent = t("sys.payQrReading");
    try {
      const { detectImage, isQr } = await import("./lib/camera.js");
      const code = (await detectImage(photo)).find((c) => isQr(c.format) && c.rawValue)?.rawValue;
      if (!code) return toast(t("sys.payQrNone"), true);
      if (code.length > 512) return toast(t("sys.payQrLong"), true);
      await store.setSetting("pay_qr", code);
      toast(t("sys.payQrDone"));
    } finally {
      el.textContent = label;
    }
  },
  async payQrDel() {
    if (!needWrite() || !confirm(t("ask.payQrDel"))) return;
    await store.setSetting("pay_qr", null);
  },
  // ---- subscription (owner, in Shop & backup) ----
  // Paying is allowed on an expired shop: that is when it's needed most.
  async payStart(el) {
    const months = +($("#paymonths")?.value || 1);
    const p = await store.requestPayment(el.dataset.plan, months);
    showPay(p);
  },
  payShow: (el) => showPay(state.billing?.payments.find((p) => p.id == el.dataset.id)),
  // The screenshot of the successful transfer is required: it's what the
  // admin checks against Rapide's bank account. From the gallery, not the camera.
  async payClaim(el) {
    const shot = await pickPhoto({ camera: false });
    if (!shot) return toast(t("bill.needShot"), true);
    // Closed before sending: the screen doesn't redraw while a dialog is open.
    if ($("#dlg").open) $("#dlg").close();
    toast(t("bill.sending"));
    await store.claimPayment(el.dataset.id, shot);
    toast(t("bill.thanks"));
  },
  async payCancel(el) {
    if (!confirm(t("bill.askCancel"))) return;
    await store.cancelPayment(el.dataset.id);
  },
  // ---- Rapide admin ----
  // Another shop this account belongs to: open it, and remember it for next
  // time (reload() keeps it as this account's last shop). Work queued on this
  // device stays with its own shop (queue.js) and is sent on coming back.
  async switchShop(el) {
    const m = state.shopList?.find((x) => x.shops.id == el.dataset.id);
    if (!m || m.shops.id == state.shop?.id) return;
    // The other shop has to be fetched; offline there is only this one's copy.
    if (store.configured && !navigator.onLine) return toast(t("err.offline"), true);
    if (state.pending && !confirm(t("ask.switchPending"))) return;
    await openOther(m);
  },
  // A second shop for this account (another branch): its own stock, staff,
  // tills and 14-day trial, made as at sign-up (create_shop), then opened.
  async newShop() {
    if (store.configured && !navigator.onLine) return toast(t("err.offline"), true);
    const name = (prompt(t("sys.newShopName"), "") ?? "").trim().slice(0, 80);
    if (!name) return;
    if (state.pending && !confirm(t("ask.switchPending"))) return;
    const id = await store.createShop(name);
    state.shopList = await store.myShops();
    const m = state.shopList.find((x) => x.shops.id == id);
    if (m) await openOther(m);
  },
  adminLoad: () => loadAdmin(),
  adminHistory: () => toggleHistory(),
  async adminProof(el) {
    const url = await store.proofUrl(el.dataset.path),
      dlg = $("#dlg");
    dlg.innerHTML = `<div class="qrdlg"><h3>${t("adm.proofTitle", { ref: E(el.dataset.ref) })}</h3><img class="proof" src="${E(
      url,
    )}" alt=""><div class="row mt"><a class="g" href="${E(url)}" target="_blank" rel="noopener">${t("adm.proofOpen")}</a><button class="b" data-act="closeDlg">${t(
      "btn.close",
    )}</button></div></div>`;
    dlg.showModal();
  },
  async adminApprove(el) {
    const { id, ref, amount, shop } = el.dataset;
    if (!confirm(t("adm.askApprove", { amount: fmt(amount), ref, shop }))) return;
    const note = prompt(t("adm.notePrompt"), "") ?? "";
    await store.approvePayment(id, note.trim());
    toast(t("adm.approved", { shop }));
    await loadAdmin();
  },
  async adminReject(el) {
    const note = prompt(t("adm.rejectPrompt"), "");
    if (note == null) return;
    await store.rejectPayment(el.dataset.id, note.trim());
    toast(t("adm.rejected"));
    await loadAdmin();
  },
  // A photo or screenshot of Rapide's own bank QR, as for the shop's till QR.
  async billingQrSet(el) {
    const photo = await pickPhoto();
    if (!photo) return;
    const label = el.textContent;
    el.textContent = t("sys.payQrReading");
    try {
      const { detectImage, isQr } = await import("./lib/camera.js");
      const code = (await detectImage(photo)).find((c) => isQr(c.format) && c.rawValue)?.rawValue;
      if (!code) return toast(t("sys.payQrNone"), true);
      if (code.length > 512) return toast(t("sys.payQrLong"), true);
      await store.setBillingQr(code);
      toast(t("sys.payQrDone"));
    } finally {
      el.textContent = label;
    }
  },
  posQuick: (el) => till.quick(el.dataset.v),
  async posCharge() {
    try {
      await till.charge();
    } finally {
      setTimeout(till.refresh); // after run() re-enables the button, set it right
    }
  },
  posReceipt: (el) => till.showReceipt(el.dataset.id),
  posPrint: (el) => till.printSale(el.dataset.id),
  posVoid: (el) => till.voidIt(el.dataset.id),
  // The till reads one aimed code at a time, so a barcode in the background
  // is never rung up by mistake.
  posCam: () => (scanner.active() ? scanner.cam(false) : scanner.cam(true, till.addCode, { single: true })),
  closeDlg: () => $("#dlg").close(),
  // Roll a product's batch list down or up, without redrawing the table, so
  // the rows below slide instead of jumping.
  invBatches(el) {
    const id = el.dataset.id,
      open = !el.classList.contains("on");
    if (open) invUi.open.add(id);
    else invUi.open.delete(id);
    el.classList.toggle("on", open);
    el.setAttribute("aria-expanded", open);
    document.querySelector(`tr.bd[data-for="${CSS.escape(id)}"]`)?.classList.toggle("open", open);
  },
  // Inventory: that product's batches on the Expiry screen.
  expFor(el) {
    expUi.q = el.dataset.sku || "";
    expUi.view = "date";
    go("exp");
  },
  quickScan: () => go("scan", true),
  scanView: () => go("scan"),
  camOn: () => scanner.cam(true),
  camOff: () => scanner.cam(false),
  export: (el) => exportSet(state, el.dataset.set, el.dataset.fmt),
  zip: () => exportZip(state),
  rates: () => refreshRates(),
  async erase() {
    if (
      !needWrite() ||
      !confirm(t("ask.erase", { shop: state.shop.name })) ||
      prompt(t("ask.eraseType")) !== "ERASE"
    )
      return;
    await store.eraseAll();
    toast(t("msg.erased"));
  },
  async retireTill(el) {
    const code = el.dataset.code;
    if (!confirm(t("ask.retireTill", { code }))) return;
    await store.retireTill(code);
    toast(t("msg.tillRetired", { code }));
  },
  // ---- staff ----
  // el.dataset.role: staff (a manager) or cashier.
  async addStaff(el) {
    const role = el.dataset.role == "cashier" ? "cashier" : "staff";
    showInvite(await store.createInvite(role), role);
  },
  shareInvite: (el) => showInvite(el.dataset.code, el.dataset.role),
  async copyInvite(el) {
    await navigator.clipboard.writeText(el.dataset.link);
    toast(t("invite.copied"));
  },
  async cancelInvite(el) {
    await store.cancelInvite(el.dataset.code);
  },
  async setRole(el) {
    await store.setMemberRole(el.dataset.id, el.dataset.role);
    toast(t("msg.saved"));
  },
  async removeStaff(el) {
    if (!confirm(t("ask.removeStaff", { email: el.dataset.email }))) return;
    await store.removeMember(el.dataset.id);
    toast(t("msg.staffRemoved", { email: el.dataset.email }));
  },
  async registerTill() {
    await store.registerTill();
    if (store.myTill()) toast(t("sys.till", { code: store.myTill().code }));
  },
  // Queued work stays on this device and is sent after the next sign-in,
  // but nobody should leave a till believing it is already on the server.
  signOut: () => (!state.pending || confirm(tn("sync.askSignOut", state.pending))) && store.signOut(),
  lang: () => switchLang(other()),
  theme: () => switchTheme(),
  install: () => installApp(),
  top: () => scrollTo({ top: 0, behavior: "smooth" }),
  more: () => document.body.classList.toggle("more"),
};

// ---------- install as an app ----------
// Chrome offers an install button in the address bar, which most shop owners
// never notice, so put one in the header. The browser only lets us ask once it
// has decided the app qualifies, hence the saved event.
let installPrompt = null;
const installBtn = () => $("#install");

addEventListener("beforeinstallprompt", (ev) => {
  ev.preventDefault(); // keep the browser's own mini-bar from appearing
  installPrompt = ev;
  installBtn().hidden = false;
});
addEventListener("appinstalled", () => {
  installPrompt = null;
  installBtn().hidden = true;
});

async function installApp() {
  if (!installPrompt) return;
  const p = installPrompt;
  installPrompt = null; // the event can only be used once
  installBtn().hidden = true;
  await p.prompt();
  await p.userChoice;
  // Whether they accepted or not, this event is spent. The button stays hidden
  // until the browser offers another one, which it does on a later visit;
  // showing it again now would leave a button that does nothing.
}

// Language is only ever a redraw: every view reads t() at render time.
function switchLang(l) {
  setLang(l);
  applyStatic();
  showTheme();
  tick();
  if (state.shop) render(true);
}


// The scanner's expiry box only matters when receiving.
function syncScanView() {
  for (const l of [$("#sexpl"), $("#sbatchl")]) if (l) l.hidden = $("#mode").value != "in";
}

const INPUT = {
  search(el) {
    invUi.q = el.value;
    $("#tb").innerHTML = invRows(state);
  },
  expSearch(el) {
    expUi.q = el.value;
    $("#expl").innerHTML = expLists(state);
  },
  expView(el) {
    expUi.view = el.value;
    $("#expl").innerHTML = expLists(state);
  },
  conv,
  // Checkboxes and number boxes (data-num).
  async setting(el) {
    const k = el.dataset.key;
    const v = el.type == "checkbox" ? el.checked : el.dataset.num ? +el.value : el.value;
    if (k == "vat_rate" && !(v >= 0 && v <= 100)) return toast(t("err.vatRate"), true);
    await store.setSetting(k, v);
    toast(t("msg.saved"));
  },
  async importFile(el) {
    const f = el.files[0];
    el.value = "";
    if (f && needWrite()) await importFile(f);
  },
  lang: (el) => switchLang(el.value),
  invFilter(el) {
    invUi.f = el.value;
    $("#tb").innerHTML = invRows(state);
  },
  dashCur(el) {
    dashUi.cur = el.value;
    try {
      localStorage.dashCur = el.value;
    } catch {}
    render();
  },
  invSort(el) {
    invUi.s = el.value;
    $("#tb").innerHTML = invRows(state);
  },
  pos: (el) => till.typed(el),
  // A new mode is a new delivery: ask "single or box?" again.
  scanMode: () => (syncScanView(), scanner.unitModeChanged()),
  scanUnit: () => scanner.unitModeChanged(),
  scanExpiry(el) {
    checkExpiry(el);
    scanner.dateTyped();
  },
  // Typed by hand: like the date, it is for the next product scanned.
  scanBatch: () => scanner.dateTyped(),
};

// One delegated handler for every button; errors become a toast.
const run = async (fn, el) => {
  if (el.tagName == "BUTTON") el.disabled = true;
  try {
    await fn(el);
  } catch (e) {
    if (!(STALE.test(errText(e)) && reloadForUpdate())) toast(errText(e), true);
  } finally {
    if (el.tagName == "BUTTON") el.disabled = false;
  }
};
document.addEventListener("click", (ev) => {
  const el = ev.target.closest("[data-act]");
  if (!el || !A[el.dataset.act]) return;
  if (!allowed(CASHIER_ACTS, el.dataset.act)) return toast(t("err.noPerm"), true);
  run(A[el.dataset.act], el);
});
document.addEventListener("input", (ev) => {
  const k = ev.target.dataset?.input;
  if (!allowed(CASHIER_INPUTS, k)) return;
  if (k == "scanExpiry") slashDate(ev.target, ev);
  if (["search", "expSearch", "conv", "pos", "scanExpiry", "scanBatch"].includes(k)) INPUT[k](ev.target);
});
document.addEventListener("change", (ev) => {
  const k = ev.target.dataset?.input;
  if (k && !allowed(CASHIER_INPUTS, k)) return;
  if (
    ["setting", "importFile", "lang", "invFilter", "invSort", "expView", "scanMode", "scanUnit", "dashCur"].includes(k) ||
    (k == "conv" && ev.target.tagName == "SELECT")
  )
    run(INPUT[k], ev.target);
});
document.addEventListener("keydown", (ev) => {
  if (ev.key != "Enter") return;
  const el = ev.target;
  if (el.dataset?.input == "manualScan") {
    scanner.onScan(el.value);
    el.value = "";
  }
  // The till: a USB scanner types the code and presses Enter.
  if (el.id == "pq") {
    ev.preventDefault();
    till.addCode(el.value);
  }
  if (el.id == "ppaid" || el.id == "pdisc") {
    ev.preventDefault();
    run(A.posCharge, $("#pcharge"));
  }
  if (el.dataset?.qty) el.blur();
});

// ---------- start ----------

function storedSession() {
  try {
    const k = Object.keys(localStorage).find((x) => /^sb-.+-auth-token$/.test(x)),
      s = k && JSON.parse(localStorage[k]);
    return s?.user ? s : null;
  } catch {
    return null;
  }
}

// An invite code with its link, to send: copy it, or share on WhatsApp.
function showInvite(code, role) {
  const link = inviteLink(code, role),
    who = t(role == "cashier" ? "role.cashier" : "role.staff"),
    msg = t("invite.msg", { shop: state.shop.name, role: who, url: link }),
    dlg = $("#dlg");
  dlg.innerHTML = `<div class="qrdlg"><h3>${t(role == "cashier" ? "sys.addCashier" : "sys.addManager")}</h3><p class="mut">${t("invite.note", {
    shop: E(state.shop.name),
    role: E(who),
  })}</p><p class="mt"><b class="code big">${E(code.slice(0, 4) + "-" + code.slice(4))}</b></p><input class="mt" readonly value="${E(link)}" onfocus="this.select()"><div class="row mt"><button class="b" data-act="copyInvite" data-link="${E(link)}">${t(
    "invite.copy",
  )}</button><a class="g" href="https://wa.me/?text=${encodeURIComponent(msg)}" target="_blank" rel="noopener">${t("invite.whatsapp")}</a><button class="g" data-act="closeDlg">${t(
    "btn.close",
  )}</button></div></div>`;
  dlg.showModal();
}

// Open another of this account's shops (Switch shop, Create another shop).
async function openOther(m) {
  const was = state.shopList?.find((x) => x.shops.id == state.shop?.id);
  toast(t("msg.opening", { name: m.shops.name }));
  // A sale in progress belongs to this shop: its lines are this shop's products.
  till.reset();
  try {
    await store.openShop(m);
  } catch (e) {
    // Half-opened (the connection dropped): go back, so the name on screen
    // and the data under it are the same shop.
    if (was) await store.openShop(was).catch(() => {});
    throw e;
  }
  go("dash");
}

async function enter() {
  let shops;
  try {
    shops = await store.myShops();
  } catch (e) {
    // No connection: open the copy of the shop kept on this device.
    if (await store.openCached()) return;
    throw e;
  }
  // Opened from an invite link: join that shop now, and open it.
  const code = store.configured && pendingJoin();
  if (code) {
    clearJoin();
    try {
      const id = await store.joinShop(code);
      localStorage["rapidewms.lastShop." + state.user?.id] = id;
      shops = await store.myShops();
      toast(t("msg.joined", { shop: shops.find((x) => x.shops.id == id)?.shops.name || "" }));
    } catch (e) {
      toast(errText(e), true);
    }
  }
  if (!shops.length) return showCreateShop(enter);
  state.shopList = shops; // for "Switch shop" in Shop & backup
  // This account's last shop on this device (two people can share a till);
  // the device-wide one for a session from before that was kept per account.
  const last = localStorage["rapidewms.lastShop." + state.user?.id] || localStorage.lastShop,
    m = shops.find((x) => x.shops.id == last) || shops[0];
  await store.openShop(m);
  if (view == "rep") refreshRates();
}

const tick = () => {
  const d = new Date();
  $("#clk").textContent = fDateTime(d);
};
applyStatic();
showTheme();
tick();
setInterval(tick, 1000);

if (!store.configured) {
  // No Supabase keys in .env: run the in-browser demo backend.
  state.user = { id: "local", email: t("auth.localUser") };
  enter().catch((e) => toast(errText(e), true));
} else {
  // A password-reset link arrives as #type=recovery and carries a real session,
  // so without this guard the app would walk straight past the new-password
  // screen. Read the hash now: supabase-js clears it once it has parsed it.
  let recovering = /type=recovery/.test(location.hash),
    asked = false;
  store.sb.auth.onAuthStateChange((ev, session) => {
    if (ev == "PASSWORD_RECOVERY") recovering = true;
    if (!session) recovering = false; // expired or already-used link
    if (recovering) {
      if (asked) return; // the form is already on screen; don't wipe it
      asked = true;
      return showNewPassword(async () => {
        recovering = false;
        state.user = session.user;
        try {
          await enter();
        } catch (e) {
          toast(errText(e), true);
        }
      });
    }
    // Supabase advises not awaiting its calls inside this callback.
    setTimeout(async () => {
      // Offline with a login that needs renewing: supabase-js can't renew it
      // without the network and reports no session, but it is still stored.
      // Work from it; it is renewed when the network returns.
      if (!session && !navigator.onLine && ev != "SIGNED_OUT") session = storedSession();
      if (!session) {
        // The next person to sign in on this till starts with an empty sale
        // (also the one kept for a reload: cleared while the shop is known).
        till.clear();
        Object.assign(state, { user: null, shop: null, items: [], orders: [], movements: [] });
        await scanner.cam(false);
        return showAuth();
      }
      if (state.user?.id == session.user.id && state.shop) return;
      state.user = session.user;
      try {
        await enter();
      } catch (e) {
        toast(errText(e), true);
      }
    });
  });
}
