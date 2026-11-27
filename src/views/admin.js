// Rapide admins only (011_billing.sql): every shop's subscription payments.
// Check the money in Rapide's bank app, then approve: the shop gets its plan
// and months at once. The server refuses all of this for anyone else.
import { E, fmt } from "../lib/util.js";
import { t, tn, fDateTime } from "../i18n/index.js";
import * as store from "../data/store.js";
import { describe, qrSvg } from "../lib/payqr.js";
import { planName } from "./sys.js";

let list = null, // the last list from the server
  loading = false,
  failed = "";

export async function load() {
  if (loading) return;
  loading = true;
  try {
    list = await store.adminPayments();
    failed = "";
  } catch (e) {
    failed = e.message || String(e);
  } finally {
    loading = false;
    store.emit();
  }
}

const when = (d) => (d ? fDateTime(new Date(d)) : "");

function row(p) {
  const pend = p.status == "pending";
  return `<tr class="${pend && p.claimed_at ? "hot" : ""}"><td data-l="${E(t("adm.shop"))}"><b>${E(p.shop_name)}</b><br><span class="mut">${E(
    p.owner_email || "",
  )}</span></td><td data-l="${E(t("adm.what"))}">${planName(p.plan)} · ${tn("bill.monthsN", p.months)}</td><td data-l="${E(
    t("adm.amount"),
  )}"><b>${fmt(p.amount_kip)}</b></td><td data-l="${E(t("adm.ref"))}"><b class="code">${E(p.reference)}</b></td><td data-l="${E(
    t("adm.when"),
  )}">${when(p.created_at)}${p.claimed_at ? `<br><span class="tag">${t("adm.claimed", { d: when(p.claimed_at) })}</span>` : ""}${
    p.proof_path
      ? `<br><button class="g" data-act="adminProof" data-path="${E(p.proof_path)}" data-ref="${E(p.reference)}">${t("adm.proof")}</button>`
      : pend
        ? `<br><span class="mut">${t("adm.noProof")}</span>`
        : ""
  }</td><td data-l="${E(
    t("adm.status"),
  )}"><span class="tag">${t("bill.st." + p.status)}</span>${p.note ? `<br><span class="mut">${E(p.note)}</span>` : ""}</td><td class="act">${
    pend
      ? `<button class="b" data-act="adminApprove" data-id="${E(p.id)}" data-ref="${E(p.reference)}" data-amount="${E(
          p.amount_kip,
        )}" data-shop="${E(p.shop_name)}">${t("adm.approve")}</button> <button class="g" data-act="adminReject" data-id="${E(
          p.id,
        )}">${t("adm.reject")}</button>`
      : ""
  }</td></tr>`;
}

export default function admin(s) {
  if (!s.billing?.admin) return `<div class="card warn">${t("adm.only")}</div>`;
  if (list == null && !failed) setTimeout(load);
  const pending = (list || []).filter((p) => p.status == "pending");
  const qr = s.billing.qr,
    d = qr && describe(qr);
  return `<div class="card"><h3>${t("adm.pending", { n: pending.length })}</h3><p class="mut">${t(
    "adm.howTo",
  )}</p><div class="row mt"><button class="g" data-act="adminLoad">${t("adm.refresh")}</button></div>${
    failed ? `<p class="bad mt">${E(failed)}</p>` : ""
  }${
    list == null
      ? `<p class="mut mt">${t("adm.loading")}</p>`
      : pending.length
        ? `<table class="mt"><tbody>${pending.map(row).join("")}</tbody></table>`
        : `<p class="mut mt">${t("adm.none")}</p>`
  }</div><div class="card"><h3>${t("adm.qr")}</h3><p class="mut">${t("adm.qrNote")}</p>${
    qr
      ? `<div class="payqr-set mt"><div class="payqr sm">${qrSvg(qr)}</div><div><p>${
          d.merchant ? `<b>${E(d.merchant)}</b>` : t("sys.payQrSaved")
        }</p><p class="mut">${t(d.amountable ? "sys.payQrAmountable" : "sys.payQrStatic")}</p></div></div>`
      : `<p class="warn mt">${t("adm.qrMissing")}</p>`
  }<div class="row mt"><button class="g" data-act="billingQrSet">${t(qr ? "sys.payQrChange" : "sys.payQrAdd")}</button></div></div>`;
}
