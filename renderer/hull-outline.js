import * as THREE from 'three';

/** Inverted geometry hull, expanded along the projected skinned/morphed vertex normal. */
export function createHullMaterial(source, viewport, width) {
  const material = new THREE.MeshBasicMaterial({ color: 0x151923, side: THREE.BackSide, depthWrite: false, toneMapped: false });
  material.name = `${source.name} · outline`;
  material.userData.viewportOutline = true;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.hullViewport = { value: viewport };
    shader.uniforms.hullWidth = width;
    shader.vertexShader = 'uniform vec2 hullViewport;\nuniform float hullWidth;\n' + shader.vertexShader
      // Basic materials normally compute normals only for skinning/environment maps.
      .replace('#if defined ( USE_ENVMAP ) || defined ( USE_SKINNING )', '#if 1')
      .replace('#include <project_vertex>', `#include <project_vertex>
        // BackSide flips the normal; undo it before expanding the hull outwards.
        vec4 hullNormal = projectionMatrix * vec4( -transformedNormal, 0.0 );
        vec2 hullDirection = ( hullNormal.xy * gl_Position.w - gl_Position.xy * hullNormal.w ) * hullViewport;
        float hullLength = length( hullDirection );
        if ( hullLength > 0.00001 ) {
          gl_Position.xy += ( hullDirection / hullLength ) * ( 2.0 * hullWidth / hullViewport ) * gl_Position.w;
        }
        gl_Position.z += 0.00001 * gl_Position.w;
      `);
    // Retain texture alpha cutouts, but do not tint the outline with texture RGB.
    shader.fragmentShader = shader.fragmentShader.replace('#include <alphatest_fragment>', '#include <alphatest_fragment>\n diffuseColor.rgb = diffuse;');
  };
  material.customProgramCacheKey = () => 'viewport-inverted-hull-v1';
  return material;
}

export function createHullMesh(mesh, material, geometry = mesh.geometry) {
  let hull;
  if (mesh.isSkinnedMesh) {
    hull = new THREE.SkinnedMesh(geometry, material);
    hull.skeleton = mesh.skeleton;
    hull.bindMode = mesh.bindMode;
    hull.bindMatrix.copy(mesh.bindMatrix);
    hull.bindMatrixInverse.copy(mesh.bindMatrixInverse);
  } else if (mesh.isInstancedMesh) {
    hull = new THREE.InstancedMesh(geometry, material, mesh.count);
    hull.instanceMatrix = mesh.instanceMatrix;
    hull.morphTexture = mesh.morphTexture;
  } else hull = new THREE.Mesh(geometry, material);
  hull.name = `${mesh.name} · outline`;
  hull.userData.viewportOutline = true;
  hull.morphTargetInfluences = mesh.morphTargetInfluences;
  hull.morphTargetDictionary = mesh.morphTargetDictionary;
  hull.frustumCulled = false; // the expanded shell may extend past the source bounds
  hull.raycast = () => {};
  hull.renderOrder = mesh.renderOrder;
  hull.layers.mask = mesh.layers.mask;
  mesh.add(hull); // identity local transform follows the mesh and its ancestors
  return hull;
}
