// Photometric units for lit viewport materials.
//
// Light uniforms carry illuminance in lux, so a Lambert surface comes out in cd/m². The viewport
// buffer stores luminance relative to GT7's reference white (1.0 = 100 cd/m²); this converts.
// Only three.js lit materials (those with a `lights_fragment_end` chunk) can take it: a model that
// ships its own ShaderMaterial is drawn as authored.
import { REFERENCE_LUMINANCE } from '../src/core/lighting.js';

const SCALE = REFERENCE_LUMINANCE.toFixed(1);
export const PHOTOMETRIC_CACHE_KEY = 'photometric-v5';

/** Use inside a material's onBeforeCompile. */
export function applyPhotometricUnits(shader) {
  shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
    reflectedLight.directDiffuse /= ${SCALE};
    reflectedLight.directSpecular /= ${SCALE};
    reflectedLight.indirectDiffuse /= ${SCALE};
    reflectedLight.indirectSpecular /= ${SCALE};
    // emissive colour * emissiveIntensity is expressed in cd/m² too
    totalEmissiveRadiance /= ${SCALE};
  `);
}
