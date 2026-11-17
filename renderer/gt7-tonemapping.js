// GT7 SDR color-volume mapping, adapted from Polyphony Digital's SIGGRAPH 2025
// reference (MIT). Reference equations are also implemented by Google Filament.
// See docs/color-pipeline.md and licenses/GT7-MIT.txt for sources and license.
import { REFERENCE_LUMINANCE } from '../src/core/lighting.js';
export const GT7_SDR = Object.freeze({
  referenceLuminance: REFERENCE_LUMINANCE, displayPeakLuminance: 250, sdrCorrection: 0.4,
  alpha: 0.25, grayPoint: 0.538, linearSection: 0.444, toeStrength: 1.280,
  blendRatio: 0.6, fadeStart: 0.98, fadeEnd: 1.16,
});

const CURVE = { peak: 2.5, gray: 0.538, section: 0.444, toe: 1.280, k: (0.444 - 1) / (0.25 - 1) };
function gt7Curve(x) {
  x = Math.max(x, 0);
  if (x < CURVE.section * CURVE.peak) {
    const s = Math.min(Math.max(x / CURVE.gray, 0), 1), blend = s * s * (3 - 2 * s);
    const toe = CURVE.gray * Math.pow(x / CURVE.gray, CURVE.toe);
    return toe + (x - toe) * blend;
  }
  return CURVE.peak * CURVE.section + CURVE.peak * CURVE.k * (1 - Math.exp((CURVE.section - x / CURVE.peak) / CURVE.k));
}

/**
 * Scene-linear value that the GT7 output shows as the display-linear value `c` (per channel; exact for
 * neutral colours). Editor colours are pre-distorted with it so they come out as authored.
 */
export function gt7InverseDisplay(c) {
  const target = Math.min(Math.max(c, 0), 0.98) / GT7_SDR.sdrCorrection;
  let lo = 0, hi = 40;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (gt7Curve(mid) < target) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}
