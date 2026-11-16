// Camera barcode reader with a live AR overlay.
//
// Decoding uses the browser's own BarcodeDetector where it exists (Android
// Chrome, Chromebooks, macOS) and otherwise zxing-cpp compiled to WebAssembly
// (Windows, iPhone, Firefox). Both report a barcode's four corners, which is
// what the overlay draws. zxing reads straight, sideways and upside-down codes
// but not diagonal ones, so when a frame finds nothing it is tried again
// turned 45° (see turned()). The WebAssembly file ships
// with the app, so scanning works offline.
import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";
import { t } from "../i18n/index.js";
import { AIM, aimed, corners } from "./aim.js";

// Everything a shop meets: retail barcodes, shipping labels, QR, and the
// GS1 DataMatrix that carries expiry dates on medicine.
// A QR usually carries text or a link (a payment slip, a website), not a
// product number. Data Matrix stays a barcode: on medicine it is GS1 data.
export const isQr = (format) => format == "qr_code";
// "ean_13" -> "EAN-13", for showing which kind of code was read.
export const formatName = (format) => (format ? format.replace(/_/g, "-").toUpperCase() : "");

const WANT = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "itf", "qr_code", "data_matrix"];

let detectorPromise = null;
export const engine = { name: "" };

function makeDetector() {
  return (detectorPromise ||= (async () => {
    if ("BarcodeDetector" in window) {
      try {
        const have = await window.BarcodeDetector.getSupportedFormats();
        const formats = WANT.filter((f) => have.includes(f));
        if (formats.includes("ean_13")) {
          engine.name = "native";
          return new window.BarcodeDetector({ formats });
        }
      } catch {}
    }
    const m = await import("barcode-detector/ponyfill");
    m.prepareZXingModule({
      overrides: { locateFile: (path, prefix) => (path.endsWith(".wasm") ? wasmUrl : prefix + path) },
    });
    engine.name = "zxing";
    return new m.BarcodeDetector({ formats: WANT });
  })());
}

/** Read every barcode in a still image (a photo, a canvas, an ImageBitmap). */
export async function detectImage(source) {
  const det = await makeDetector(),
    img = source instanceof Blob ? await createImageBitmap(source) : source;
  const found = await det.detect(img);
  return found.length || engine.name != "zxing" ? found : turned(det, img, 45);
}

const sizeOf = (src) => ({ w: src.videoWidth || src.width, h: src.videoHeight || src.height });
let rotCanvas = null;

/**
 * Detect in a copy of the picture turned by `deg` degrees, then map the corners
 * back onto the original, so the overlay box still sits on the real barcode.
 * Scaled down to ~1000 px across to keep a cheap phone's frame rate up.
 */
export async function turned(det, src, deg) {
  const { w, h } = sizeOf(src);
  if (!w || !h) return [];
  const k = Math.min(1, 1000 / Math.hypot(w, h)),
    S = Math.ceil(Math.hypot(w, h) * k),
    a = (deg * Math.PI) / 180;
  const c = (rotCanvas ||= document.createElement("canvas"));
  c.width = c.height = S;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.fillStyle = "#fff";
  g.fillRect(0, 0, S, S);
  g.translate(S / 2, S / 2);
  g.rotate(a);
  g.drawImage(src, (-w * k) / 2, (-h * k) / 2, w * k, h * k);
  g.setTransform(1, 0, 0, 1, 0, 0);
  const cos = Math.cos(-a),
    sin = Math.sin(-a),
    back = (p) => {
      const x = p.x - S / 2,
        y = p.y - S / 2;
      return { x: (x * cos - y * sin) / k + w / 2, y: (x * sin + y * cos) / k + h / 2 };
    };
  return (await det.detect(c)).map((b) => {
    const cornerPoints = (b.cornerPoints || []).map(back),
      xs = cornerPoints.map((p) => p.x),
      ys = cornerPoints.map((p) => p.y),
      x = Math.min(...xs),
      y = Math.min(...ys);
    return {
      rawValue: b.rawValue,
      format: b.format,
      cornerPoints,
      boundingBox: { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y },
    };
  });
}

let cur = null; // { stream, video, overlay, running, timer }

export const active = () => !!cur;

/**
 * Start the camera inside `host` and call onCode(text, format) each time a
 * barcode comes into view. The same code is reported again only after it has
 * been out of view for a moment, so holding a product still adds it once, and
 * taking it away and back adds it again — how a supermarket scanner behaves.
 *
 * Normally every code in view is read, which makes receiving a pallet fast.
 * With `single`, as at the till, only a code inside the aim box is read, and
 * nothing is read while two different codes are in it, so a barcode in the
 * background can never be rung up by mistake.
 */
export async function start(host, onCode, { single = false } = {}) {
  await stop();
  host.innerHTML = `<div class="cam${single ? " cam--single" : ""}"><video playsinline muted></video><canvas></canvas>${
    single ? `<div class="camhint" aria-live="polite"></div>` : ""
  }<button type="button" class="g torch" hidden>🔦</button></div>`;
  const video = host.querySelector("video"),
    overlay = host.querySelector("canvas"),
    torch = host.querySelector(".torch"),
    hint = host.querySelector(".camhint");
  const say = (key) => {
    if (!hint || hint.dataset.key == key) return;
    hint.dataset.key = key;
    hint.textContent = t(key);
    hint.classList.toggle("warn", key == "cam.many");
  };
  say("cam.aim");
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
  });
  const me = (cur = { stream, video, overlay, running: true, timer: 0 });
  video.srcObject = stream;
  await video.play();

  // A torch for dim shop corners, where the phone offers one.
  const track = stream.getVideoTracks()[0];
  if (track.getCapabilities?.().torch) {
    let on = false;
    torch.hidden = false;
    torch.onclick = () => track.applyConstraints({ advanced: [{ torch: (on = !on) }] }).catch(() => {});
  }

  const det = await makeDetector(),
    seen = new Map(), // code -> last time it was in view
    boxes = []; // what the overlay shows, kept briefly so it doesn't flicker
  const GONE = 700;

  const loop = async () => {
    if (!me.running) return;
    if (video.readyState >= 2) {
      let found = [];
      try {
        found = await det.detect(video);
        // zxing already tries 90° steps, so one 45° turn covers every diagonal.
        if (!found.length && engine.name == "zxing") found = await turned(det, video, 45);
      } catch {}
      const now = performance.now();
      let read = found;
      if (single) {
        const a = aimed(found, video.videoWidth, video.videoHeight);
        for (const b of a.ignored) boxes.push({ ...b, at: now, look: "ignored" });
        if (a.many) {
          // Read nothing, but keep codes that were already read "in view", so
          // the product already rung up is not rung up again once the other
          // one leaves the box.
          for (const b of a.inBox) {
            if (seen.has(b.rawValue)) seen.set(b.rawValue, now);
            boxes.push({ ...b, at: now, look: "many" });
          }
          read = [];
        } else read = a.inBox;
        say(a.many ? "cam.many" : "cam.aim");
      }
      for (const b of read) {
        if (!b.rawValue) continue;
        const last = seen.get(b.rawValue);
        seen.set(b.rawValue, now);
        boxes.push({ ...b, at: now });
        if (last == null || now - last > GONE) {
          beep();
          onCode(b.rawValue, b.format);
        }
      }
      for (const [k, t] of seen) if (now - t > GONE) seen.delete(k);
      draw(overlay, video, boxes.filter((b) => now - b.at < 350), single);
      boxes.splice(0, boxes.length, ...boxes.filter((b) => now - b.at < 350));
    }
    // Fast enough to feel instant, slow enough to leave a cheap phone breathing.
    if (me.running) me.timer = setTimeout(loop, engine.name == "native" ? 60 : 110);
  };
  loop();
}

export async function stop() {
  const c = cur;
  cur = null;
  if (!c) return;
  c.running = false;
  clearTimeout(c.timer);
  c.stream.getTracks().forEach((t) => t.stop());
  c.video.srcObject = null;
}

// How each kind of box looks: green = read, amber = in the aim box with another
// code (not read), grey = outside the aim box (not read).
const LOOK = {
  read: { fill: "rgba(74,222,128,.22)", line: "#4ade80" },
  many: { fill: "rgba(251,191,36,.22)", line: "#fbbf24" },
  ignored: { fill: "rgba(236,232,248,.08)", line: "#cfc8ea", dash: true },
};

// Outline each barcode where it sits in the picture, at whatever angle.
function draw(canvas, video, found, single = false) {
  const w = video.videoWidth,
    h = video.videoHeight;
  if (canvas.width != w) canvas.width = w;
  if (canvas.height != h) canvas.height = h;
  const g = canvas.getContext("2d");
  g.clearRect(0, 0, w, h);
  const lw = Math.max(3, w / 220);
  if (single) {
    // The aim box: dim everything outside it, then mark its corners.
    const x = AIM.x * w,
      y = AIM.y * h,
      bw = AIM.w * w,
      bh = AIM.h * h,
      k = Math.min(bw, bh) * 0.14;
    g.fillStyle = "rgba(6,4,13,.45)";
    g.fillRect(0, 0, w, y);
    g.fillRect(0, y + bh, w, h - y - bh);
    g.fillRect(0, y, x, bh);
    g.fillRect(x + bw, y, w - x - bw, bh);
    g.lineWidth = lw;
    g.strokeStyle = "#c4b5fd";
    g.beginPath();
    for (const [cx, cy, dx, dy] of [
      [x, y, 1, 1],
      [x + bw, y, -1, 1],
      [x + bw, y + bh, -1, -1],
      [x, y + bh, 1, -1],
    ]) {
      g.moveTo(cx + dx * k, cy);
      g.lineTo(cx, cy);
      g.lineTo(cx, cy + dy * k);
    }
    g.stroke();
  }
  for (const b of found) {
    const look = LOOK[b.look] || LOOK.read;
    const p = b.cornerPoints?.length == 4 ? b.cornerPoints : corners(b.boundingBox);
    g.beginPath();
    p.forEach((q, i) => (i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y)));
    g.closePath();
    g.fillStyle = look.fill;
    g.fill();
    g.lineWidth = lw;
    g.strokeStyle = look.line;
    g.setLineDash(look.dash ? [lw * 3, lw * 2] : []);
    g.stroke();
    g.setLineDash([]);
    // Only codes that count get a label; a dashed one is just "seen, ignored".
    if (b.look == "ignored") continue;
    const top = p.reduce((a, q) => (q.y < a.y ? q : a));
    g.font = `600 ${Math.round(lw * 6)}px system-ui, sans-serif`;
    const label = b.rawValue.length > 24 ? b.rawValue.slice(0, 23) + "…" : b.rawValue,
      tw = g.measureText(label).width + lw * 4,
      th = lw * 9,
      x = Math.min(Math.max(top.x - tw / 2, 0), w - tw),
      y = Math.max(top.y - th - lw * 2, 0);
    g.fillStyle = look.line;
    g.fillRect(x, y, tw, th);
    g.fillStyle = "#06040d";
    g.fillText(label, x + lw * 2, y + th - lw * 2.5);
  }
}

// A short till beep, so the cashier knows without looking at the screen.
let audio = null;
function beep() {
  navigator.vibrate?.(60);
  try {
    audio ||= new AudioContext();
    const o = audio.createOscillator(),
      v = audio.createGain();
    o.frequency.value = 1760;
    v.gain.setValueAtTime(0.12, audio.currentTime);
    v.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.09);
    o.connect(v).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + 0.1);
  } catch {}
}
