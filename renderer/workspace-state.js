const $ = (id) => document.getElementById(id);

export function captureWorkspace(viewer, state, panel) {
  const current = viewer.current, camera = viewer.camera;
  return {
    format: 'mmd-canvas-workspace', version: 1,
    browser: { directory: state.dir, filter: $('filter-input').value, only3d: $('only-3d').checked },
    model: current ? {
      path: state.loadedPath,
      materials: current.materials.map((entry) => ({ name: entry.material.name || '', visible: entry.material.visible })),
      morphs: current.info.morphList.map((m, index) => ({ name: m.name, weight: current.morphWeights?.[index] || 0 })),
    } : null,
    viewport: {
      mode: viewer.renderMode, outline: { ...viewer.outlineSettings }, flags: { ...viewer.flags },
      lightIntensity: viewer.lightLevel, lightDirection: viewer.sun.position.toArray(),
      shadowEnabled: viewer.shadow.enabled, shadowSoftness: viewer.shadow.softness,
      gizmo: $('flag-light-gizmo').checked, gizmoSpace: viewer.lightControls.space,
      gizmoMode: viewer.lightControls.mode, gizmoPosition: viewer.lightRig.position.toArray(),
      camera: { position: camera.position.toArray(), target: viewer.controls.target.toArray(), up: camera.up.toArray(),
        fov: camera.fov, zoom: camera.zoom, near: camera.near, far: camera.far,
        maxDistance: Number.isFinite(viewer.controls.maxDistance) ? viewer.controls.maxDistance : 1e15 },
    },
    conversion: {
      mode: state.dialogMode, format: $('opt-format').value, output: $('opt-output').value.trim(),
      source: state.conversionSource || (state.dialogMode === 'single' ? state.loadedPath : state.dir),
      scale: Number($('opt-scale').value), nameMode: $('opt-names').value,
      morphs: $('opt-morphs').checked, copyTextures: $('opt-copy').checked, asciiNames: $('opt-ascii').checked, recursive: $('opt-recursive').checked,
    },
    inspector: { tab: $('tab-materials').getAttribute('aria-selected') === 'true' ? 'materials' : 'overview',
      selectedMaterial: panel.selected, filter: $('material-search').value, soloVisibility: panel.savedVisibility?.slice() || null },
  };
}

/** The model has already loaded successfully before any saved view state is applied. */
export function restoreWorkspaceState(data, viewer, state, panel, applyRenderMode, applyOutline) {
  const change = (id, value, checkbox = false, event = 'change') => {
    $(id)[checkbox ? 'checked' : 'value'] = value;
    $(id).dispatchEvent(new Event(event));
  };
  const v = data.viewport;
  applyRenderMode(v.mode);
  applyOutline(v.outline.width, v.outline.color, false);
  for (const [flag, value] of Object.entries(v.flags)) change(`flag-${flag}`, value, true);
  change('light-intensity', v.lightIntensity, false, 'input');
  change('flag-shadow', v.shadowEnabled, true);
  change('shadow-softness', v.shadowSoftness / 0.12 * 100, false, 'input');
  viewer.setShadowSoftness(v.shadowSoftness); // the slider snaps to whole steps; keep the saved value exact
  viewer.setLightDirection(v.lightDirection);
  viewer.lightRig.position.fromArray(v.gizmoPosition);
  viewer.setLightGizmoSpace(v.gizmoSpace);
  viewer.setLightGizmoMode(v.gizmoMode);
  $('btn-light-space').textContent = v.gizmoSpace === 'world' ? 'World' : 'Local';
  change('flag-light-gizmo', v.gizmo, true);

  let changedModel = false;
  if (data.model && viewer.current) {
    const materials = viewer.current.materials;
    const sameMaterials = materials.length === data.model.materials.length && materials.every((entry, index) => (entry.material.name || '') === data.model.materials[index].name);
    if (sameMaterials) {
      data.model.materials.forEach((entry, index) => viewer.setMaterialVisible(index, entry.visible));
      panel.savedVisibility = data.inspector.soloVisibility?.length === materials.length ? data.inspector.soloVisibility.slice() : null;
    } else changedModel = true;
    const morphs = viewer.current.info.morphList;
    if (morphs.length === data.model.morphs.length && morphs.every((m, index) => m.name === data.model.morphs[index].name)) {
      viewer.setMorphWeights(data.model.morphs.map((m) => m.weight));
      document.querySelectorAll('#morphs .morph').forEach((row, index) => {
        const weight = data.model.morphs[index].weight;
        row.querySelector('input').value = weight;
        row.querySelector('output').textContent = Number(weight.toFixed(2)).toString();
      });
    } else changedModel = true;
  }
  panel.selected = Math.min(data.inspector.selectedMaterial, Math.max(0, panel.entries.length - 1));
  $('material-search').value = data.inspector.filter;
  panel.renderList(); panel.renderDetail();
  $(`tab-${data.inspector.tab}`).click();

  const c = data.conversion;
  state.dialogMode = c.mode; state.conversionSource = c.source;
  $('opt-format').value = c.format; $('opt-output').value = c.output;
  $('opt-scale').value = String(c.scale); $('opt-names').value = c.nameMode;
  for (const [id, key] of [['opt-morphs', 'morphs'], ['opt-copy', 'copyTextures'], ['opt-ascii', 'asciiNames'], ['opt-recursive', 'recursive']]) $(id).checked = c[key];

  // Drain residual orbit damping before restoring the camera, then leave the user's view intact.
  const damping = viewer.controls.enableDamping;
  viewer.controls.enableDamping = false; viewer.controls.update();
  const camera = v.camera;
  viewer.camera.position.fromArray(camera.position); viewer.camera.up.fromArray(camera.up);
  viewer.controls.target.fromArray(camera.target);
  for (const key of ['fov', 'zoom', 'near', 'far']) viewer.camera[key] = camera[key];
  viewer.controls.maxDistance = camera.maxDistance;
  viewer.camera.updateProjectionMatrix(); viewer.controls.update(); viewer.controls.enableDamping = damping;
  viewer.invalidateShadows();
  return changedModel;
}
