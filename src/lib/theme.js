// Light and dark mode, as on the landing page. It follows the device until the
// user picks one with a ☀/☾ button (in the app's header, and on the sign-in
// screens); that choice is remembered on this device and applied in
// index.html's head before the page draws. Every colour is a CSS variable, so
// switching needs no redraw.
import { t } from "../i18n/index.js";

const THEME = "rapidewms.theme";
const sysLight = matchMedia("(prefers-color-scheme: light)");
const themeNow = () => document.documentElement.dataset.theme || (sysLight.matches ? "light" : "dark");

/** Bring every ☀/☾ button on screen (and the browser's bar colour) up to date. */
export function showTheme() {
  const light = themeNow() == "light",
    title = t(light ? "hdr.themeDark" : "hdr.themeLight");
  for (const b of document.querySelectorAll('[data-act="theme"]')) {
    b.textContent = light ? "☾" : "☀";
    b.title = title;
    b.setAttribute("aria-label", title);
  }
  document.querySelector('meta[name="theme-color"]').content = light ? "#f7f5fc" : "#07050f";
}

export function switchTheme() {
  const next = themeNow() == "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(THEME, next);
  } catch {}
  showTheme();
}

sysLight.addEventListener("change", showTheme);
