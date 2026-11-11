// Directional-light direct-normal illuminance, in lux (lm/m²).
export const DEFAULT_LIGHT_LUX = 10;
export const MAX_LIGHT_LUX = 200000;
// Sky/ground fill so faces turned away from the directional light are not pure black.
export const DEFAULT_AMBIENT_LUX = 2;
// GT7 scene-linear framebuffer convention: 1.0 represents 100 cd/m².
export const REFERENCE_LUMINANCE = 100;
export const DEFAULT_EV100 = 0;
export const MIN_EV100 = -10;
export const MAX_EV100 = 24;
export const MAX_EXPOSURE_COMPENSATION = 10;
export const MAX_EMISSIVE_NITS = 1000000;
// Legacy workspaces used L / 100 directly as the GT7 input.
export const LEGACY_EV100 = Math.log2(REFERENCE_LUMINANCE);

export function normalizeExposure(ev100 = DEFAULT_EV100, compensation = 0) {
  return {
    ev100: Number.isFinite(ev100) ? Math.max(MIN_EV100, Math.min(MAX_EV100, ev100)) : DEFAULT_EV100,
    compensation: Number.isFinite(compensation) ? Math.max(-MAX_EXPOSURE_COMPENSATION, Math.min(MAX_EXPOSURE_COMPENSATION, compensation)) : 0,
  };
}

export function exposureScale(ev100, compensation) {
  const e = normalizeExposure(ev100, compensation);
  // Restore cd/m² from the HDR storage scale, then B = L * 2^(-EV100 + compensation).
  return REFERENCE_LUMINANCE * 2 ** (e.compensation - e.ev100);
}

export function sourceEmissionNits(material) {
  // Imported emissive strengths have no common absolute calibration. Preserve the
  // previous viewport interpretation: a white source value of 1 represents 100 cd/m².
  const strength = material.emissiveIntensity ?? 1;
  return Number.isFinite(strength) ? Math.max(0, Math.min(MAX_EMISSIVE_NITS, strength * REFERENCE_LUMINANCE)) : 0;
}

export function clampLightLux(value) {
  return Number.isFinite(value) ? Math.max(0, Math.min(MAX_LIGHT_LUX, value)) : DEFAULT_LIGHT_LUX;
}

// Old preferences/workspaces stored a 0..3 multiplier, with 1 = 6 lux.
// Keep this historical calibration independent of the current default.
export function legacyLightToLux(value) {
  return clampLightLux(Math.max(0, Math.min(3, value)) * 6);
}
