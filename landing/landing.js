// The landing page at the site root. The app itself is under app/.
import "./landing.css";
// The same bundled Lao font as the app, so Lao renders the same everywhere.
import "@fontsource/noto-sans-lao/lao-400.css";
import "@fontsource/noto-sans-lao/lao-600.css";
import "@fontsource/noto-sans-lao/lao-700.css";

// ---------------------------------------------------------------------------
// Edit these. Prices are in kip per shop per month. A contact left empty ("")
// is simply not shown, so the page never displays a placeholder number.
// ---------------------------------------------------------------------------
const CONFIG = {
  prices: { small: 150000, mini: 250000 },
  // WhatsApp and phone: the full number with country code, e.g. "8562012345678".
  whatsapp: "",
  phone: "",
  // The full address of the Facebook page, e.g. "https://www.facebook.com/rapidewms".
  facebook: "",
  // A try-it-now copy of the app that keeps data in the visitor's browser.
  demo: "https://gen-stack69.github.io/RapidePI/app/",
};

// English text, by data-t key. The Lao text is what index.html contains.
const EN = {
  "nav.services": "Services",
  "nav.pricing": "Pricing",
  "nav.faq": "FAQ",
  "nav.contact": "Contact",
  "nav.signin": "Sign in",
  "hero.eyebrow": "For shops, minimarts and warehouses in Laos",
  "hero.title": "Point of sale and stock control that's easy to use, in Lao",
  "hero.lead":
    "Sell faster, keep stock right and know in advance what's about to expire. Works on a phone or a PC, even when the internet drops.",
  "hero.trial": "Start a 14-day free trial",
  "hero.talk": "Talk to us",
  "hero.fine": "No card needed · Lao and English · Pay by BCEL One / LAPNet QR",
  "mock.title": "Till",
  "mock.i1": "Drinking water 1.5 L × 2",
  "mock.i2": "Beerlao (carton of 24)",
  "mock.i3": "Bread",
  "mock.total": "Total",
  "mock.qr": "The customer scans the bank QR, with the total already filled in",
  "svc.title": "What RAPIDÉWMS does for your shop",
  "svc.till.h": "Till and bank QR",
  "svc.till.p":
    "Scan a barcode or search by name, take cash or a transfer. Your shop's bank QR shows the total for the customer to scan with BCEL One, LDB or JDB.",
  "svc.stock.h": "Stock and barcodes",
  "svc.stock.p":
    "Receive and ship goods with a phone camera or a USB scanner. Handles cartons, wholesale prices and low-stock alerts.",
  "svc.exp.h": "Expiry dates",
  "svc.exp.p": "See what expires soonest first, mark one batch down, and write off expired stock in one tap.",
  "svc.off.h": "Sells when the internet drops",
  "svc.off.p":
    "Keep selling with no connection. When it's back, every device sends its sales by itself, and nothing is sold twice.",
  "svc.multi.h": "Many devices, one set of data",
  "svc.multi.p": "Phones, tablets and PCs see the same stock straight away. Owners and staff get different rights.",
  "svc.rep.h": "Reports and receipts",
  "svc.rep.p": "Today's sales and stock value. Export to PDF, Excel or CSV, and print receipts on 58 mm or A4.",
  "help.title": "We help you get started",
  "help.import.h": "We import your data",
  "help.import.p": "Send us your Excel file or Loyverse export and we help import your products, customers and past sales.",
  "help.train.h": "Training",
  "help.train.p": "We train you and your staff until the till and receiving goods feel easy.",
  "help.support.h": "Support in Lao",
  "help.support.p": "Questions or problems? Ask us on WhatsApp, by phone or on Facebook.",
  "how.title": "Up and running in a day",
  "how.1.h": "Sign up and create your shop",
  "how.1.p": "With an email and a password. No card needed.",
  "how.2.h": "Add your products",
  "how.2.p": "Scan them, type them, or import them from an Excel file.",
  "how.3.h": "Start selling",
  "how.3.p": "Open the till on a phone or a PC and take payments right away.",
  "price.title": "Clear prices, paid monthly",
  "price.lead": "Every plan has every feature. Try it free for 14 days first, and cancel any time.",
  "plan.small.h": "Small shop",
  "plan.small.who": "A shop with one till",
  "plan.month": "₭ / month",
  "plan.small.f1": "1 till (phone, tablet or PC)",
  "plan.all": "Till, stock, expiry dates, reports",
  "plan.offline": "Sells when the internet drops",
  "plan.help": "Help importing products, and training",
  "plan.start": "Start free trial",
  "plan.pop": "Most popular",
  "plan.mini.h": "Minimart",
  "plan.mini.who": "A shop with several tills",
  "plan.mini.f1": "Up to 4 devices (3 tills + 1 PC)",
  "plan.staff": "Separate rights for staff and owner",
  "plan.big.h": "Warehouse or several branches",
  "plan.big.who": "More than 4 devices, or several shops",
  "plan.big.price": "Custom price",
  "plan.big.f1": "As many devices as you need",
  "plan.big.f2": "Help with setup and moving all your data",
  "plan.contact": "Contact us",
  "price.note":
    "Paid monthly by BCEL One or LAPNet QR. If you don't renew, the shop becomes view-only and your data is never deleted.",
  "faq.title": "Frequently asked questions",
  "faq.net.q": "Do I need the internet all the time?",
  "faq.net.a":
    "No. You need it the first time you open your shop, and to add or edit products. Selling, voiding a sale and receiving or shipping goods work with no internet, and are sent up by themselves when it's back.",
  "faq.dev.q": "Which devices does it work on?",
  "faq.dev.a":
    "Android phones or iPhones, tablets, and Windows PCs with Chrome, Edge or Safari. It installs like an app. USB or Bluetooth barcode scanners and 58 mm receipt printers work with it.",
  "faq.pay.q": "How do I pay?",
  "faq.pay.a": "By monthly transfer with BCEL One or LAPNet QR. We activate your shop once the payment arrives.",
  "faq.trial.q": "What happens after the 14-day trial?",
  "faq.trial.a":
    "If you haven't paid yet, the shop becomes view-only: you can still see and export your data, and nothing is deleted. As soon as you pay, you carry on where you left off.",
  "faq.safe.q": "Is my shop's data safe?",
  "faq.safe.a": "Each shop sees only its own data. You can export and back up all of it as a ZIP file at any time.",
  "faq.move.q": "Can I move over from Loyverse or Excel?",
  "faq.move.a":
    "Yes. Import products, customers and past sales from a CSV or Excel file, or send us the file and we'll help.",
  "contact.title": "Want a demo, or have a question?",
  "contact.lead": "Get in touch, we're happy to help in Lao or English.",
  "contact.demo": "Try the demo (no sign-up)",
  "contact.wa": "WhatsApp",
  "contact.phone": "Call us",
  "contact.fb": "Facebook",
  "contact.none": "Contact details coming soon.",
  "foot.where": "Vientiane Capital, Lao PDR",
};
// The few Lao strings made here rather than written in index.html.
const LO = {
  "contact.wa": "WhatsApp",
  "contact.phone": "ໂທຫາພວກເຮົາ",
  "contact.fb": "Facebook",
  "contact.none": "ຂໍ້ມູນຕິດຕໍ່ຈະມີໄວໆນີ້.",
  "hero.waText": "ສະບາຍດີ, ຂ້ອຍສົນໃຈ RAPIDÉWMS ສຳລັບຮ້ານຂອງຂ້ອຍ.",
};
EN["hero.waText"] = "Hello, I'm interested in RAPIDÉWMS for my shop.";

const KEY = "lang"; // the app's own key (src/i18n/index.js), so the choice carries over
const nodes = [...document.querySelectorAll("[data-t]")];
// The Lao text, as written in index.html, kept so switching back restores it.
for (const n of nodes) n.dataset.lo = n.innerHTML;

let lang = "lo";
try {
  const saved = localStorage.getItem(KEY);
  if (saved == "en" || saved == "lo") lang = saved;
} catch {}

const say = (k) => (lang == "en" ? EN[k] : LO[k]) ?? k;
const digits = (s) => String(s).replace(/\D/g, "");
const kip = (n) => new Intl.NumberFormat("en-US").format(n);

function contacts() {
  const out = [];
  if (CONFIG.whatsapp) {
    const href = `https://wa.me/${digits(CONFIG.whatsapp)}?text=${encodeURIComponent(say("hero.waText"))}`;
    out.push(`<a class="chip wa" href="${href}" target="_blank" rel="noopener">${say("contact.wa")}</a>`);
  }
  if (CONFIG.phone) {
    const d = digits(CONFIG.phone);
    out.push(`<a class="chip" href="tel:+${d}">${say("contact.phone")} · +${d}</a>`);
  }
  if (/^https:\/\//.test(CONFIG.facebook)) {
    out.push(`<a class="chip fb" href="${CONFIG.facebook}" target="_blank" rel="noopener">${say("contact.fb")}</a>`);
  }
  document.getElementById("contacts").innerHTML = out.length ? out.join("") : `<p class="muted">${say("contact.none")}</p>`;

  // "Talk to us" buttons open WhatsApp when there's a number, else jump to #contact.
  for (const a of document.querySelectorAll("[data-wa]")) {
    if (CONFIG.whatsapp) {
      a.href = `https://wa.me/${digits(CONFIG.whatsapp)}?text=${encodeURIComponent(say("hero.waText"))}`;
      a.target = "_blank";
      a.rel = "noopener";
    } else a.href = "#contact";
  }
}

function apply() {
  document.documentElement.lang = lang;
  document.body.classList.toggle("en", lang == "en");
  for (const n of nodes) n.innerHTML = lang == "en" && EN[n.dataset.t] != null ? EN[n.dataset.t] : n.dataset.lo;
  document.title =
    lang == "en" ? "RAPIDÉWMS — Point of sale and stock for shops in Laos" : "RAPIDÉWMS — ລະບົບຂາຍໜ້າຮ້ານ ແລະ ສາງສິນຄ້າ";
  contacts();
}

for (const b of document.querySelectorAll("[data-price]")) b.textContent = kip(CONFIG.prices[b.dataset.price]);
document.getElementById("year").textContent = new Date().getFullYear();
const demo = document.getElementById("demo");
if (CONFIG.demo) {
  demo.href = CONFIG.demo;
  demo.hidden = false;
}

document.getElementById("lang").addEventListener("click", () => {
  lang = lang == "en" ? "lo" : "en";
  try {
    localStorage.setItem(KEY, lang);
  } catch {}
  apply();
});

apply();
