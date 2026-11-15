// Exchange rates: today's internet rates (per 1 USD), kept on the device so
// they still work offline, with built-in defaults before the first fetch.
// Costs typed in THB / USD / CNY and the dashboard use them. Shops no longer
// set their own rates; any settings.rates saved earlier is ignored, since
// there is no longer a screen to change it.
export const CUR = ["LAK", "THB", "USD", "CNY"];
export const SIGN = { LAK: "₭", THB: "฿", USD: "$", CNY: "¥" };
export const R = { USD: 1, LAK: 21700, THB: 35, CNY: 7.1 };
try {
  Object.assign(R, JSON.parse(localStorage.rates));
} catch {}

/** Kip per 1 unit of `cur`, at today's internet rate. */
export const kipPer = (cur) => (cur == "LAK" ? 1 : R.LAK / R[cur]);

/** Fetch today's internet rates. Returns false with no connection. */
export async function fetchRates() {
  try {
    const j = await (await fetch("https://open.er-api.com/v6/latest/USD")).json();
    ["LAK", "THB", "CNY"].forEach((c) => (R[c] = j.rates[c]));
    localStorage.rates = JSON.stringify(R);
    return true;
  } catch {
    return false;
  }
}
