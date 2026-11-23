import * as THREE from 'three';

// Reference bounds in the model root's coordinate system, shared by all meshes.
// Hidden materials and unposed vertices count too: visibility/animation must not
// change the normalization range underneath the artist's gradient.
export function measureObjectHeight(root) {
  root.updateMatrixWorld(true);
  const inverse = root.matrixWorld.clone().invert(), transform = new THREE.Matrix4(), point = new THREE.Vector3();
  let min = Infinity, max = -Infinity;
  root.traverse(mesh => {
    const positions = mesh.geometry?.attributes.position;
    if (!mesh.isMesh || mesh.userData.viewportOutline || !positions) return;
    transform.multiplyMatrices(inverse, mesh.matrixWorld);
    for (let i = 0; i < positions.count; i++) {
      point.fromBufferAttribute(positions, i).applyMatrix4(transform);
      min = Math.min(min, point.y); max = Math.max(max, point.y);
    }
  });
  return { min, max };
}

export function objectHeightPlane(root, bounds) {
  root.updateMatrixWorld(true);
  const height = bounds.max - bounds.min;
  if (!Number.isFinite(height) || height < 1e-8 || Math.abs(root.matrixWorld.determinant()) < 1e-15) return [0, 0, 0, 0.5];
  const e = root.matrixWorld.clone().invert().elements;
  return [e[1] / height, e[5] / height, e[9] / height, (e[13] - bounds.min) / height];
}
