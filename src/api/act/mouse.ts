import type { Page } from 'playwright';

/**
 * Moves the mouse from (x0,y0) to (x1,y1) along a cubic Bézier curve
 * with two random control points — produces a natural, human-like arc.
 *
 * Steps are scaled to the distance: short movements use fewer points,
 * long diagonal swipes use up to 40. Typical duration: ~120–180 ms.
 */
export async function moveMouse(page: Page, x0: number, y0: number, x1: number, y1: number): Promise<void> {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const steps = Math.max(8, Math.min(40, Math.round(dist / 15)));

  // Random control points displaced perpendicular to the straight line
  const perp = { x: -dy / dist || 0, y: dx / dist || 0 };
  const c1Offset = (0.2 + Math.random() * 0.3) * dist;
  const c2Offset = (0.2 + Math.random() * 0.3) * dist;
  const cx1 = x0 + dx * 0.25 + perp.x * c1Offset * (Math.random() > 0.5 ? 1 : -1);
  const cy1 = y0 + dy * 0.25 + perp.y * c1Offset * (Math.random() > 0.5 ? 1 : -1);
  const cx2 = x0 + dx * 0.75 + perp.x * c2Offset * (Math.random() > 0.5 ? 1 : -1);
  const cy2 = y0 + dy * 0.75 + perp.y * c2Offset * (Math.random() > 0.5 ? 1 : -1);

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const bx = u * u * u * x0 + 3 * u * u * t * cx1 + 3 * u * t * t * cx2 + t * t * t * x1;
    const by = u * u * u * y0 + 3 * u * u * t * cy1 + 3 * u * t * t * cy2 + t * t * t * y1;
    await page.mouse.move(bx, by);
    // Non-uniform timing — faster in the middle, slower at start/end
    const delay = 4 + Math.round(8 * Math.sin(Math.PI * t));
    await page.waitForTimeout(delay);
  }
}
