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

// GLSL twin of gt7InverseDisplay; needs GT7_GLSL for gt7Curve.
export const GT7_INVERSE_GLSL = /* glsl */`
float gt7InverseDisplay(float c) {
  float target = clamp(c, 0.0, 0.98) / 0.4;
  float lo = 0.0, hi = 40.0;
  for (int i = 0; i < 20; i++) { float mid = 0.5 * (lo + hi); if (gt7Curve(mid) < target) lo = mid; else hi = mid; }
  return 0.5 * (lo + hi);
}
vec3 gt7InverseDisplay(vec3 c) { return vec3(gt7InverseDisplay(c.r), gt7InverseDisplay(c.g), gt7InverseDisplay(c.b)); }
`;

// Input/output are Linear Rec.709. PQ is an internal perceptual transform here,
// not the display encoding. The only display transfer follows this operation.
export const GT7_GLSL = /* glsl */`
vec3 gt7ToRec2020(vec3 c) {
  return vec3(dot(c, vec3(0.627403896, 0.329283038, 0.043313066)),
              dot(c, vec3(0.069097289, 0.919540395, 0.011362316)),
              dot(c, vec3(0.016391439, 0.088013308, 0.895595253)));
}
vec3 gt7ToRec709(vec3 c) {
  return vec3(dot(c, vec3(1.660491002, -0.587641139, -0.072849863)),
              dot(c, vec3(-0.124550475, 1.132899897, -0.008349422)),
              dot(c, vec3(-0.018150763, -0.100578898, 1.118729661)));
}
vec3 gt7PQ(vec3 nits) {
  vec3 p = pow(max(nits, vec3(0.0)) / 10000.0, vec3(2610.0 / 16384.0));
  return pow((vec3(3424.0 / 4096.0) + (2413.0 / 128.0) * p)
    / (vec3(1.0) + (2392.0 / 128.0) * p), vec3(2523.0 / 32.0));
}
vec3 gt7InversePQ(vec3 encoded) {
  vec3 p = pow(clamp(encoded, 0.0, 1.0), vec3(32.0 / 2523.0));
  return 10000.0 * pow(max(p - (3424.0 / 4096.0), vec3(0.0))
    / ((2413.0 / 128.0) - (2392.0 / 128.0) * p), vec3(16384.0 / 2610.0));
}
vec3 gt7ToICtCp(vec3 nits) {
  vec3 lms = vec3(dot(nits, vec3(1688.0, 2146.0, 262.0)),
                  dot(nits, vec3(683.0, 2951.0, 462.0)),
                  dot(nits, vec3(99.0, 309.0, 3688.0))) / 4096.0;
  vec3 p = gt7PQ(lms);
  return vec3(0.5 * (p.x + p.y),
    dot(p, vec3(6610.0, -13613.0, 7003.0)) / 4096.0,
    dot(p, vec3(17933.0, -17390.0, -543.0)) / 4096.0);
}
vec3 gt7FromICtCp(vec3 c) {
  vec3 lms = gt7InversePQ(vec3(c.x + 0.00860904 * c.y + 0.11103 * c.z,
    c.x - 0.00860904 * c.y - 0.11103 * c.z,
    c.x + 0.560031 * c.y - 0.320627 * c.z));
  return max(vec3(dot(lms, vec3(3.43661, -2.50645, 0.0698454)),
    dot(lms, vec3(-0.79133, 1.9836, -0.192271)),
    dot(lms, vec3(-0.0259499, -0.0989137, 1.12486))), vec3(0.0));
}
float gt7Curve(float x) {
  x = max(x, 0.0);
  const float peak = 2.5; // 250 nits / 100 nits reference
  const float gray = 0.538;
  const float section = 0.444;
  const float k = (section - 1.0) / (0.25 - 1.0);
  if (x < section * peak) {
    return mix(gray * pow(x / gray, 1.280), x, smoothstep(0.0, gray, x));
  }
  // Equivalent to ka + kb * exp(kc*x), avoiding a large intermediate exponential.
  return peak * section + peak * k * (1.0 - exp((section - x / peak) / k));
}
vec3 gt7ToneMap(vec3 linearRec709) {
  vec3 rgb = gt7ToRec2020(clamp(linearRec709, 0.0, 65504.0));
  vec3 original = gt7ToICtCp(rgb * 100.0);
  vec3 curved = vec3(gt7Curve(rgb.r), gt7Curve(rgb.g), gt7Curve(rgb.b));
  vec3 skewed = gt7ToICtCp(curved * 100.0);
  float peakI = gt7PQ(vec3(250.0)).x;
  float chroma = 1.0 - smoothstep(0.98, 1.16, original.x / peakI);
  vec3 restored = gt7FromICtCp(vec3(skewed.x, original.yz * chroma)) / 100.0;
  vec3 mapped = 0.4 * min(mix(curved, restored, 0.6), vec3(2.5));
  // The desktop viewport is SDR Rec.709; bound any remaining out-of-gamut channels.
  return clamp(gt7ToRec709(mapped), 0.0, 1.0);
}
`;
