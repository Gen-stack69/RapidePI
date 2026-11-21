import { E } from "../lib/util.js";
import { t } from "../i18n/index.js";
import { scanUi } from "../scanner.js";

export default function scan() {
  return `<div class="card"><div class="row"><select id="mode" data-input="scanMode"><option value="in">${t(
    "scan.in",
  )}</option><option value="out">${t("scan.out")}</option><option value="look">${t(
    "scan.look",
  )}</option></select><input id="sq" type="number" min="1" value="1" placeholder="${E(
    t("scan.qtyPer"),
  )}"><select id="su" data-input="scanUnit" aria-label="${E(t("scan.countAs"))}">${["auto", "unit", "box"]
    .map((k) => `<option value="${k}"${k == scanUi.unit ? " selected" : ""}>${t("scan.u." + k)}</option>`)
    .join("")}</select></div><label class="mt" id="sexpl">${t("scan.expBox")}<span class="tools"><input id="sexp" data-input="scanExpiry" autocomplete="off" inputmode="numeric" placeholder="${E(
    t("f.expiryPh"),
  )}"><button type="button" class="g" data-act="readDate" data-for="sexp">${t(
    "btn.readDate",
  )}</button></span><small class="said"></small></label><label class="mt" id="sbatchl">${t("f.batch")}<input id="sbatch" data-input="scanBatch" autocomplete="off" placeholder="${E(
    t("scan.batchPh"),
  )}"></label><div class="row mt"><button class="b" data-act="camOn">${t(
    "scan.camOn",
  )}</button><button class="g" data-act="camOff">${t(
    "scan.camOff",
  )}</button></div><p class="mut mt">${t("scan.anyAngle")}</p><div id="rd"></div><input id="man" class="mt" placeholder="${E(
    t("scan.manual"),
  )}" data-input="manualScan"><div id="res" class="mt"></div></div>`;
}
