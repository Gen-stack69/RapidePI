// Single-scan mode's aim box: which of the codes in one camera frame may be
// read at the till. Kept apart from camera.js, which needs a browser, so the
// rule can be unit-tested (npm run test:unit).

// As fractions of the picture: the middle 70% across and 50% down. A barcode
// counts only when its centre is inside.
export const AIM = { x: 0.15, y: 0.25, w: 0.7, h: 0.5 };

export const corners = (r) => [
  { x: r.x, y: r.y },
  { x: r.x + r.width, y: r.y },
  { x: r.x + r.width, y: r.y + r.height },
  { x: r.x, y: r.y + r.height },
];

const centre = (b) => {
  const p = b.cornerPoints?.length ? b.cornerPoints : corners(b.boundingBox);
  return { x: p.reduce((a, q) => a + q.x, 0) / p.length, y: p.reduce((a, q) => a + q.y, 0) / p.length };
};

/**
 * Sort one frame's codes. `inBox` are the codes whose centre is in the aim
 * box; `ignored` are the rest (a shelf behind the product, the next item on
 * the counter). Only a lone code in the box may be read: two different codes
 * in it at once is ambiguous (`many`), and the cashier is asked to aim at one.
 */
export function aimed(found, w, h) {
  const x0 = AIM.x * w,
    y0 = AIM.y * h,
    x1 = x0 + AIM.w * w,
    y1 = y0 + AIM.h * h;
  const inBox = [],
    ignored = [];
  for (const b of found) {
    if (!b.rawValue) continue;
    const c = centre(b);
    (c.x >= x0 && c.x <= x1 && c.y >= y0 && c.y <= y1 ? inBox : ignored).push(b);
  }
  // The same code twice in the box (two identical cans) is still one product.
  const many = new Set(inBox.map((b) => b.rawValue)).size > 1;
  return { inBox, ignored, many };
}
