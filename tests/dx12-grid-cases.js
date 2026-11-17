// Measure the coverage of projected world-space grid lines, independently of
// the shader's ray/plane derivatives. Integrate linear-light coverage across
// each line's screen-space normal: a minor line should occupy one output pixel.
export async function runGridCases(v) {
  const THREE = await import('three');
  const { nativeModel } = await import('../renderer/dx12.js');
  v.dx12.enabled = false;
  v.controls.update = () => false;
  await api.dx12Model(nativeModel(new THREE.Group()));
  const width = 640, height = 480, canvas = document.getElementById('dx12-canvas');
  const linear = x => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  const lineRed = linear(54 / 255);
  const draw = async (mode, grid = true) => {
    const data = v.dx12.frame(), f = new Float32Array(data, 4);
    f.set([width, height, 0, 1, 100, 0, 0, 0, 1, 0, 4, 0], 44);
    f.set([0, 0, 0, Number(grid), 0, 10, 20, 0, 0, 0, 0, mode, 0, 0, 20, 1], 56);
    // No sharpening: inspect the actual grid filter, independent of user prefs.
    if (f.length > 72) f[72] = 0;
    const frame = await api.dx12Render(data);
    return { frame, pixels: canvas.getContext('2d').getImageData(0, 0, width, height).data };
  };
  const camera = (position, shift = 0) => {
    v.camera.position.set(position[0] + shift, position[1], position[2]);
    v.camera.up.set(0, 1, 0);
    v.camera.lookAt(shift, 0, 0);
    v.camera.aspect = width / height;
    v.camera.near = 0.1; v.camera.far = 1000;
    v.camera.updateProjectionMatrix(); v.camera.updateMatrixWorld();
  };
  const project = (x, z) => {
    const p = new THREE.Vector3(x, 0, z).project(v.camera);
    return [(p.x * 0.5 + 0.5) * width, (0.5 - p.y * 0.5) * height];
  };
  const coverage = (pixels, x, y) => {
    x -= 0.5; y -= 0.5;
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const at = (dx, dy) => linear(pixels[((iy + dy) * width + ix + dx) * 4] / 255) / lineRed;
    return (at(0, 0) * (1 - fx) + at(1, 0) * fx) * (1 - fy) +
      (at(0, 1) * (1 - fx) + at(1, 1) * fx) * fy;
  };
  const lineWidth = (pixels, alongX) => {
    // Halfway between perpendicular lines, away from the two brighter axes.
    const a = project(alongX ? 2.5 : 2, alongX ? 2 : 2.5);
    const b = project(alongX ? 3.5 : 2, alongX ? 2 : 3.5);
    const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
    const nx = -dy / length, ny = dx / length;
    if (a[0] < 4 || a[0] >= width - 4 || a[1] < 4 || a[1] >= height - 4) throw new Error('Grid probe outside viewport');
    let area = 0;
    for (let s = -3; s < 3; s += 0.025) area += coverage(pixels, a[0] + nx * (s + 0.0125), a[1] + ny * (s + 0.0125)) * 0.025;
    return area;
  };
  const difference = (a, b) => {
    let sum = 0, max = 0;
    for (let i = 0; i < a.length; i += 4) for (let c = 0; c < 3; c++) {
      const delta = Math.abs(a[i + c] - b[i + c]); sum += delta; max = Math.max(max, delta);
    }
    return { mean: sum / (width * height * 3), max };
  };
  const results = [], images = [];
  for (const [name, position] of [['oblique', [8, 4, 11]], ['grazing', [2, 1.3, 15]], ['overhead', [3, 15, 5]]]) {
    camera(position);
    const reference = await draw(0);
    const modes = [];
    for (const mode of [0, 1, 2, 3]) {
      let current;
      for (let i = 0; i < (mode ? 8 : 1); i++) current = await draw(mode);
      modes.push({ mode, antialiasing: current.frame.antialiasing,
        widths: [lineWidth(current.pixels, true), lineWidth(current.pixels, false)],
        modeDifference: difference(current.pixels, reference.pixels),
        staticDifference: difference(current.pixels, (await draw(mode)).pixels) });
    }
    images.push({ name, png: canvas.toDataURL('image/png') });
    const moving = [];
    for (let i = 0; i < 10; i++) {
      camera(position, i * 0.007);
      const current = await draw(1);
      moving.push([lineWidth(current.pixels, true), lineWidth(current.pixels, false)]);
    }
    const off = await draw(1, false);
    let offMax = 0;
    for (let i = 0; i < off.pixels.length; i += 4) offMax = Math.max(offMax, off.pixels[i]);
    results.push({ name, modes, moving, offMax });
  }
  // Distant grid families become subpixel: all AA modes must still agree, and
  // crossing the horizon must leave the sky exactly black.
  camera([2, 0.3, 15]); v.camera.lookAt(0, 0.3, 0); v.camera.updateMatrixWorld();
  const horizon = await draw(3);
  let skyMax = 0;
  for (let i = 0; i < width * (height / 2 - 2) * 4; i += 4) skyMax = Math.max(skyMax, horizon.pixels[i]);
  images.push({ name: 'horizon', png: canvas.toDataURL('image/png') });
  return { results, skyMax, images };
}
