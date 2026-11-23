import * as THREE from 'three';
import { setLanguage, translateStatic } from '../src/i18n/index.js';
import { Viewer } from './viewer.js';
import { Dx12Viewport } from './dx12.js';
import { ShaderStackPanel } from './shader-stack-panel.js';

// Unreal-material-editor style: a shader preview sphere in the center canvas
// (its own DX12 host, routed by sender in main), library/stack/code/properties on
// the right. Previews the selected library shader, not a model material.
const api = window.api;
const startup = await api.startup();
setLanguage(startup.locale);
translateStatic(document.body);

const viewer = new Viewer(document.getElementById('shader-preview-host'));
window.__shaderPreview = viewer; // integration checks share the main viewport's inspection pattern
viewer.flags.grid = false;
viewer.grid.visible = false;
viewer.setLightGizmo(false);

// Neutral material sphere for shader authoring.
const sphere = new THREE.Mesh(
  new THREE.SphereGeometry(1, 64, 48),
  new THREE.MeshLambertMaterial({ color: 0x9aa0ad })
);
viewer.root.add(sphere);
viewer.current = { object: sphere, kind: 'preview' };
viewer.camera.position.set(0, 0.4, 3.4);
viewer.controls.target.set(0, 0, 0);
viewer.camera.lookAt(0, 0, 0);
viewer.controls.update();

viewer.dx12 = new Dx12Viewport(viewer, document.getElementById('shader-preview-status'));
viewer.dx12.aaMode = 0; // MSAA preview: avoid creating a DLSS feature in the preview host
viewer.dx12.sharpen = 0;
document.getElementById('renderer-retry').addEventListener('click', () => viewer.dx12.start());
window.__shaderStackRender = () => viewer.requestRender();
api.onShaderStackApplied(() => viewer.requestRender());
void viewer.dx12.start();

const panel = new ShaderStackPanel();
window.__shaderPanel = panel;
panel.setState(await api.shaderStackLibraryGet());
function syncPreview() {
  // The sphere previews the SELECTED library shader with preview-only values
  // (code defaults unless tweaked). No model material is involved.
  const stackId = panel.selectedStack || 0;
  // Direct mutation replies and IPC broadcasts feed the same committed state.
  // Local, uncompiled editor drafts must not change GPU parameter layouts.
  const state = panel.committedState || {};
  viewer.dx12.library = state.library || [];
  viewer.dx12.stride = state.stride || 1;
  viewer.dx12.instances = [{ stackId, params: panel.previewValues || {} }];
  viewer.dx12.materialAssign = [stackId];
  viewer.requestRender();
}
panel.onPreviewChange = () => syncPreview();
api.onShaderStackUpdated(state => panel.setState(state));
syncPreview();
