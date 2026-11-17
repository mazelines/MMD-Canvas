// Pixel comparisons through the real native renderer, not a CPU copy of its bias formula.
export async function runShadowCases({viewer, THREE, nativeModel, render, difference, check}) {
  const {api} = window;
  const crop = pixels => {
    const out = new Uint8Array(80 * 80 * 4);
    for (let y = 0; y < 80; y++) out.set(pixels.slice(((y + 40) * 160 + 40) * 4, ((y + 40) * 160 + 120) * 4), y * 80 * 4);
    return out;
  };
  const cameraAt = (center, rotation, scale, side = 1) => {
    viewer.camera.position.copy(new THREE.Vector3(0, 0, side * 3 * scale).applyQuaternion(rotation).add(center));
    viewer.camera.up.copy(new THREE.Vector3(0, 1, 0).applyQuaternion(rotation));
    viewer.camera.lookAt(center); viewer.camera.aspect = 1;
    viewer.camera.near = scale * 0.01; viewer.camera.far = scale * 100;
    viewer.camera.updateProjectionMatrix(); viewer.camera.updateMatrixWorld();
  };
  const results = [];
  // Strong tangent normals can point below the triangle while still facing a grazing light.
  // Shadow visibility of this isolated plane must not depend on that shading normal.
  const normalMap = new THREE.DataTexture(new Uint8Array([0, 128, 112, 255]), 1, 1);
  normalMap.needsUpdate = true;
  for (const [scale, translation, side] of [[1, 0, 1], [0.001, 0, 1], [1000, 0, 1], [1, 10000, 1], [1, -10000, -1]]) {
    const center = new THREE.Vector3(translation, -translation * 0.5, translation * 0.25);
    const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.23, -0.17, 0.11));
    const model = new THREE.Group();
    // A different first material forces a nonzero per-draw primitive offset for the receiver.
    const dummy = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial());
    dummy.position.copy(center).add(new THREE.Vector3(-20 * scale, 0, 0).applyQuaternion(rotation));
    dummy.scale.setScalar(scale); model.add(dummy);
    const material = new THREE.MeshLambertMaterial({color: 0xffffff, normalMap, side: THREE.DoubleSide, transparent: translation > 0, depthWrite: translation <= 0});
    const indexed = new THREE.PlaneGeometry(2, 2, 8, 8);
    const geometry = scale < 1 ? indexed.toNonIndexed() : indexed;
    if (geometry !== indexed) indexed.dispose();
    const receiver = new THREE.Mesh(geometry, material);
    receiver.position.copy(center); receiver.quaternion.copy(rotation); receiver.scale.set(scale, scale * 1.2, scale * 0.7); model.add(receiver);
    cameraAt(center, rotation, scale, side);
    await api.dx12Model(nativeModel(model));
    const options = {
      direction: new THREE.Vector3(1, 0, side * 0.04).normalize().applyQuaternion(rotation).toArray(),
      ambient: 0, softness: 0, diagonal: 30 * scale, ground: center.y - 100 * scale,
    };
    for (const toon of [0, 1]) {
      const off = crop(await render({...options, toon})), on = crop(await render({...options, toon, shadow: 1}));
      check(off.some((value, i) => i % 4 === 0 && value > 50), 'Acne receiver must be visibly lit');
      const diff = difference(off, on);
      check(diff.max <= 2, 'Isolated surface must not shadow itself: ' + JSON.stringify({scale, translation, side, toon, ...diff}));
      results.push({scale, translation, side, toon, ...diff});
    }
    // Pose-only upload must use the updated triangle plane as well as the updated BLAS.
    receiver.position.add(new THREE.Vector3(0, 0, 0.07 * scale).applyQuaternion(rotation));
    receiver.quaternion.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0.06, -0.02, 0.01)));
    await api.dx12Pose(nativeModel(model, true));
    check(difference(crop(await render(options)), crop(await render({...options, shadow: 1}))).max <= 2, 'Posed surface must not acquire self-shadow acne');
    receiver.geometry.dispose(); dummy.geometry.dispose(); material.dispose(); dummy.material.dispose();
  }
  normalMap.dispose();

  // A nearby, thin blocker must survive even when unrelated geometry enlarges scene bounds.
  const model = new THREE.Group();
  const receiver = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshLambertMaterial({color: 0xffffff}));
  model.add(receiver);
  const blocker = new THREE.Mesh(new THREE.PlaneGeometry(0.003, 0.8), new THREE.MeshLambertMaterial({side: THREE.DoubleSide}));
  blocker.rotation.y = Math.PI / 2; blocker.position.set(0.3, 0, 0.00155); model.add(blocker);
  const distant = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial());
  distant.position.set(-1000, 0, 0); model.add(distant);
  cameraAt(new THREE.Vector3(), new THREE.Quaternion(), 1);
  await api.dx12Model(nativeModel(model));
  const options = {direction: new THREE.Vector3(1, 0, 0.01).normalize().toArray(), ambient: 0, sun: 300, softness: 0, diagonal: 1002, ground: -100};
  const contact = difference(crop(await render(options)), crop(await render({...options, shadow: 1})));
  check(contact.darker > 100, 'A 0.00005-unit gap must retain its thin blocker shadow: ' + JSON.stringify(contact));
  const smallBounds = crop(await render({...options, shadow: 1, diagonal: 3}));
  check(difference(smallBounds, crop(await render({...options, shadow: 1}))).max <= 2, 'Unrelated model bounds must not change local contact shadows');
  for (const mesh of model.children) { mesh.geometry.dispose(); mesh.material.dispose(); }
  return {isolatedSurfaces: results, thinContact: contact};
}
