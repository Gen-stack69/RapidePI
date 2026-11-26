// crypto.randomUUID only exists on secure (https) pages and in Chrome 92+.
// Older Android phones, and a test copy opened over the local Wi-Fi (http),
// lack it, so build the same random (version 4) ID from getRandomValues.
if (globalThis.crypto && !crypto.randomUUID)
  crypto.randomUUID = () => {
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };
