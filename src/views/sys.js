import { E, fmt } from "../lib/util.js";
import { t, tn, lang, LANGS, fDate, fDateTime } from "../i18n/index.js";
import { isOwner, configured, myTill, canWrite, cashierUi, CASHIER_URL } from "../data/store.js";

// owner, staff (shown as Manager) or cashier (021).
const roleName = (r) => t(r == "owner" ? "role.owner" : r == "cashier" ? "role.cashier" : "role.staff");
import { describe, tillQr, qrSvg } from "../lib/payqr.js";

// Owner only: the shop's bank QR, which the till shows for transfer payments.
// Staff never see this card, so they can't point payments at another account
// (the database refuses that too).
function payQr(s) {
  if (!isOwner()) return "";
  const qr = s.settings.pay_qr;
  if (!qr)
    return `<div class="card"><h3>${t("sys.payQr")}</h3><p class="mut">${t("sys.payQrNote")}</p><div class="row mt"><button class="g" data-act="payQrSet">${t(
      "sys.payQrAdd",
    )}</button></div></div>`;
  const d = describe(qr),
    on = s.settings.pay_qr_amount !== false,
    sample = tillQr(qr, 1000, on);
  return `<div class="card"><h3>${t("sys.payQr")}</h3><div class="payqr-set"><div class="payqr sm">${qrSvg(sample.text)}</div><div><p>${
    d.merchant ? `<b>${E(d.merchant)}</b>` : t("sys.payQrSaved")
  }</p><p class="mut">${t(d.amountable ? "sys.payQrAmountable" : "sys.payQrStatic")}</p>${
    d.amountable
      ? `<label class="chk mt"><input type="checkbox" data-input="setting" data-key="pay_qr_amount"${on ? " checked" : ""}> ${t("sys.payQrPutAmount")}</label>`
      : ""
  }</div></div><p class="mut mt">${t("sys.payQrTest")}</p><div class="row mt"><button class="g" data-act="payQrSet">${t(
    "sys.payQrChange",
  )}</button><button class="g" data-act="payQrDel">${t("sys.payQrDel")}</button></div></div>`;
}

// The other shops this account is in (an owner with two branches, a cashier
// in two shops, a Rapide admin with a test shop): open one in a tap, or
// start another one.
function otherShops(s) {
  const others = (s.shopList || []).filter((m) => m.shops.id != s.shop.id),
    // Not in cashier mode: a cashier's own new shop would open on the till.
    add = cashierUi() ? "" : `<div class="row mt"><button class="g" data-act="newShop">${t("sys.newShop")}</button></div>`;
  if (!others.length) return add;
  return `<p class="mut mt">${t("sys.otherShops")}</p>${others
    .map(
      (m) =>
        `<div class="row mt"><b>${E(m.shops.name)}</b><span class="tag">${roleName(m.role)}</span><button class="g" data-act="switchShop" data-id="${E(
          m.shops.id,
        )}">${t("sys.open")}</button></div>`,
    )
    .join("")}${add}`;
}

// Owner only, with a server: pay for a plan. The shop transfers the amount to
// Rapide's bank QR with the payment's reference in the note, taps "I've paid",
// and a Rapide admin approves it once the money is in (011_billing.sql).
const PAY_MONTHS = [1, 3, 6, 12];
export const planName = (code) => t("bill.plan." + code);
function billing(s) {
  if (!configured || !isOwner() || !s.billing) return "";
  const b = s.billing,
    wait = b.payments.find((p) => p.status == "pending");
  const head = `<div class="card"><h3>${t("bill.title")}</h3>`;
  if (wait)
    return `${head}<p class="mt"><b>${t("bill.waiting", {
      plan: planName(wait.plan),
      n: wait.months,
      amount: fmt(wait.amount_kip),
    })}</b></p><p class="mut">${t("bill.ref", { ref: E(wait.reference) })}</p><p class="mut mt">${t(
      wait.claimed_at ? "bill.claimed" : "bill.toPay",
    )}</p><div class="row mt"><button class="b" data-act="payShow" data-id="${E(wait.id)}">${t("bill.showQr")}</button>${
      wait.proof_path ? "" : `<button class="g" data-act="payClaim" data-id="${E(wait.id)}">${t("bill.iPaid")}</button>`
    }<button class="g" data-act="payCancel" data-id="${E(wait.id)}">${t("bill.cancel")}</button></div>${history(b)}</div>`;
  const plans = b.plans
    .map(
      (p) =>
        `<div class="row mt"><b>${planName(p.code)}</b><span class="mut">${tn("bill.planLine", p.max_tills, {
          price: fmt(p.price_kip),
        })}</span><button class="g" data-act="payStart" data-plan="${E(p.code)}">${t("bill.choose")}</button></div>`,
    )
    .join("");
  return `${head}<p class="mut">${t("bill.note")}</p><label class="mt">${t("bill.months")}<select id="paymonths">${PAY_MONTHS.map(
    (n) => `<option value="${n}">${tn("bill.monthsN", n)}</option>`,
  ).join("")}</select></label>${plans}${history(b)}</div>`;
}
function history(b) {
  const done = b.payments.filter((p) => p.status != "pending").slice(0, 5);
  if (!done.length) return "";
  return `<p class="mut mt">${t("bill.history")}</p>${done
    .map(
      (p) =>
        `<div class="row"><span>${fDate(new Date(p.decided_at || p.created_at))}</span><span>${planName(p.plan)} · ${tn(
          "bill.monthsN",
          p.months,
        )}</span><span>${fmt(p.amount_kip)}</span><span class="tag">${t("bill.st." + p.status)}</span></div>`,
    )
    .join("")}`;
}

// The devices that sell. The plan sets how many can be in use; the owner
// retires an old phone to make room for a new one.
function tills(s) {
  if (!configured) return "";
  const used = s.tills.filter((x) => !x.retired_at),
    mine = myTill(),
    max = s.shop.max_tills ?? "";
  const rows = used
    .map(
      (x) =>
        `<div class="row mt"><b>${t("sys.tillName", { code: E(x.code) })}</b><span class="mut">${E(x.name || "")}</span>${
          mine?.code == x.code ? `<span class="tag">${t("sys.thisDevice")}</span>` : ""
        }${isOwner() ? `<button class="g" data-act="retireTill" data-code="${E(x.code)}">${t("sys.retire")}</button>` : ""}</div>`,
    )
    .join("");
  return `<div class="card"><h3>${t("sys.tills")}</h3><p class="mut">${t("sys.tillsUsed", { n: used.length, max })}</p>${rows}<p class="mut mt">${
    mine ? t("sys.till", { code: E(mine.code) }) : s.tillFull ? t("err.tillFull", { max }) : t("sys.noTill")
  }</p>${
    !mine && canWrite() && s.online ? `<div class="row mt"><button class="g" data-act="registerTill">${t("sys.useAsTill")}</button></div>` : ""
  }</div>`;
}

// Owner only: who can log in to this shop, and codes for new cashiers.
const showCode = (c) => c.slice(0, 4) + "-" + c.slice(4);
function staff(s) {
  if (!configured || !isOwner() || !s.people) return "";
  const people = s.people.members
    .map(
      (m) =>
        `<div class="row mt"><b>${E(m.email || "")}</b><span class="tag">${roleName(m.role)}</span>${
          m.user_id == s.user.id ? `<span class="mut">${t("sys.you")}</span>` : ""
        }${
          m.role != "owner"
            ? `<button class="g" data-act="setRole" data-id="${E(m.user_id)}" data-role="${m.role == "cashier" ? "staff" : "cashier"}">${t(
                m.role == "cashier" ? "sys.makeManager" : "sys.makeCashier",
              )}</button>`
            : ""
        }${m.role != "owner" ? `<button class="g" data-act="removeStaff" data-id="${E(m.user_id)}" data-email="${E(m.email || "")}">${t("sys.remove")}</button>` : ""}</div>`,
    )
    .join("");
  const codes = s.people.invites
    .map(
      (i) =>
        `<div class="row mt"><b class="code">${E(showCode(i.code))}</b><span class="tag">${roleName(i.role)}</span><span class="mut">${t("sys.codeUntil", {
          d: fDateTime(new Date(i.expires_at)),
        })}</span><button class="g" data-act="shareInvite" data-code="${E(i.code)}" data-role="${E(i.role || "staff")}">${t("invite.share")}</button><button class="g" data-act="cancelInvite" data-code="${E(i.code)}">${t("sys.cancel")}</button></div>`,
    )
    .join("");
  return `<div class="card"><h3>${t("sys.staff")}</h3><p class="mut">${t("sys.staffNote")}</p><p class="mut">${t("sys.cashierSite", { url: `<a href="${CASHIER_URL}" target="_blank" rel="noopener">${CASHIER_URL.slice("https://".length, -1)}</a>` })}</p>${people}${
    codes ? `<p class="mut mt">${t("sys.codesOpen")}</p>${codes}` : ""
  }<div class="row mt"><button class="g" data-act="addStaff" data-role="staff">${t("sys.addManager")}</button><button class="g" data-act="addStaff" data-role="cashier">${t(
    "sys.addCashier",
  )}</button></div></div>`;
}

// VAT inside the shelf price. Exchange rates are not set here: costs in
// another currency and the dashboard use today's internet rate (rates.js).
function prices(s) {
  const own = !isOwner() ? " disabled" : "";
  return `<div class="card"><h3>${t("sys.prices")}</h3><label class="mt">${t("sys.vatRate")}<input type="number" min="0" max="100" step="any" data-input="setting" data-key="vat_rate" data-num="1" value="${E(
    s.settings.vat_rate ?? 10,
  )}"${own}></label><p class="mut">${t("sys.vatNote")}</p></div>`;
}

export default function sys(s) {
  const until = new Date(s.shop.plan_until),
    days = Math.ceil((until - Date.now()) / 864e5),
    plan = t(s.shop.plan == "paid" ? "plan.paid" : "plan.trial");
  return `<div class="card"><h3>${t("sys.shop")}</h3><p class="mt"><b>${E(s.shop.name)}</b></p><p class="mut">${t(
    "sys.signedIn",
    { email: E(s.user.email), role: roleName(s.role) },
  )}</p><p class="plan mt ${days <= 0 ? "expired" : ""}">${
    days > 0
      ? tn("sys.planLeft", days, { plan, date: fDate(until) })
      : t("sys.planExpired")
  }</p>${
    configured
      ? `<div class="row mt"><button class="g" data-act="signOut">${t("sys.signOut")}</button></div>`
      : `<p class="mut mt">${t("sys.localNote")}</p>`
  }${otherShops(s)}</div>${
    // Cashier mode: the shop, this device's till and the language; nothing else.
    cashierUi() ? `${tills(s)}${langCard()}` : `${billing(s)}${prices(s)}${payQr(s)}${staff(s)}${tills(s)}${langCard()}
<div class="card"><h3>${t("sys.backup")}</h3><div class="row mt"><button class="g" data-act="zip">${t(
    "sys.zip",
  )}</button><label class="g">${t(
    "sys.import",
  )}<input type="file" accept=".csv,.xlsx,.xls,.ods,text/csv" hidden data-input="importFile"></label>${
    isOwner() ? `<button class="g" data-act="erase">${t("sys.erase")}</button>` : ""
  }</div><p class="mut mt">${t("sys.csvNote")}</p></div>`
  }`;
}

const langCard = () =>
  `<div class="card"><h3>${t("sys.lang")}</h3><div class="row mt"><select data-input="lang">${LANGS.map(
    ([c, n]) => `<option value="${c}" ${c == lang() ? "selected" : ""}>${n}</option>`,
  ).join("")}</select></div></div>`;
