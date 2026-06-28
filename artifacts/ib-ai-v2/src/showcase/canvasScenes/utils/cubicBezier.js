/**
 * cubicBezier(t, p1x, p1y, p2x, p2y)
 *
 * Evaluates a CSS cubic-bezier timing function at input time t (0–1).
 * Matches the browser's implementation: control points at (p1x, p1y) and
 * (p2x, p2y), anchors fixed at (0,0) and (1,1).
 *
 * Uses Newton's method to invert the x-parametric to find the curve
 * parameter, then evaluates y. Falls back to bisection if Newton diverges.
 *
 * Accuracy: < 1e-7 error on x, well within perceptual threshold.
 */
export function cubicBezier(t, p1x, p1y, p2x, p2y) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;

  const cx = 3 * p1x;
  const bx = 3 * (p2x - p1x) - cx;
  const ax = 1 - cx - bx;

  const cy = 3 * p1y;
  const by = 3 * (p2y - p1y) - cy;
  const ay = 1 - cy - by;

  const sampleX = (u) => ((ax * u + bx) * u + cx) * u;
  const sampleY = (u) => ((ay * u + by) * u + cy) * u;
  const derivX  = (u) => (3 * ax * u + 2 * bx) * u + cx;

  function solveT(x) {
    let u = x;
    for (let i = 0; i < 8; i++) {
      const dx = sampleX(u) - x;
      if (Math.abs(dx) < 1e-7) return u;
      const d = derivX(u);
      if (Math.abs(d) < 1e-6) break;
      u -= dx / d;
    }
    let lo = 0, hi = 1, mid = x;
    while (hi - lo > 1e-7) {
      mid = (lo + hi) / 2;
      const xm = sampleX(mid);
      if (Math.abs(xm - x) < 1e-7) return mid;
      if (xm < x) lo = mid; else hi = mid;
    }
    return mid;
  }

  return sampleY(solveT(t));
}
