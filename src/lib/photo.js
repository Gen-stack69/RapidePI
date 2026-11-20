// Pictures from the camera or the gallery, made small before they are kept:
// a phone photo is 3–8 MB, a product picture needs a few dozen KB.

/** A JPEG of the picture, at most `max` px on its longer side. */
export async function toJpeg(file, max = 1600, quality = 0.85) {
  const img = await createImageBitmap(file),
    k = Math.min(1, max / Math.max(img.width, img.height)),
    c = document.createElement("canvas");
  c.width = Math.round(img.width * k);
  c.height = Math.round(img.height * k);
  const g = c.getContext("2d");
  // A transparent PNG would turn black in a JPEG.
  g.fillStyle = "#fff";
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(img, 0, 0, c.width, c.height);
  img.close?.();
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("image"))), "image/jpeg", quality));
}

/** A product photo: 640 px is sharp on any phone screen and about 40–80 KB. */
export const productJpeg = (file) => toJpeg(file, 640, 0.8);

/** The picture as a data: URL (the demo keeps photos in the browser's storage). */
export const dataUrl = (blob) =>
  new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
