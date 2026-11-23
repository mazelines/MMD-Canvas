// Shared auto-generated property controls for shader stacks. Used by BOTH the
// shader editor (preview-only values for the selected library shader) and the
// material inspector (per-material instance values). The schema comes from each
// layer's //@property annotations (parseLayer); values are supplied by the caller.
import { t } from '../src/i18n/index.js';
import { parseLayer } from '../src/core/shader-stack.js';

const node = (tag, props = {}, ...children) => {
  const element = Object.assign(document.createElement(tag), props);
  element.append(...children);
  return element;
};

// Build one property widget. prop = parsed schema {type,name,default,min,max,label};
// value = current value; commit(v) persists a change. Returns a label row.
export function buildPropertyControl(prop, value, commit) {
  const row = node('label', { className: 'shader-prop-row', title: t(prop.label) });
  row.dataset.property = prop.name;
  row.append(node('span', { textContent: t(prop.label) }));
  if (prop.type === 'texture2D') {
    const controls = node('span', { className: 'shader-texture-control' });
    const path = value?.texture;
    const choose = node('button', { type: 'button', textContent: path ? path.split(/[\\/]/).pop() : t('텍스처 선택…'), title: path || t('미지정: 전체 발광') });
    const clear = node('button', { type: 'button', textContent: '×', title: t('텍스처 해제'), disabled: !path });
    const update = selected => {
      choose.textContent = selected ? selected.split(/[\\/]/).pop() : t('텍스처 선택…');
      choose.title = selected || t('미지정: 전체 발광'); clear.disabled = !selected;
    };
    choose.addEventListener('click', async event => {
      event.preventDefault();
      try {
        const selected = await window.api.shaderTextureOpen();
        if (selected) { await commit({ texture: selected }); update(selected); }
      } catch (error) { choose.title = error.message; choose.textContent = t('텍스처 선택 실패'); }
    });
    clear.addEventListener('click', event => { event.preventDefault(); commit({ texture: null }); update(null); });
    controls.append(choose, clear); row.append(controls);
  } else if (prop.type === 'bool') {
    row.classList.add('shader-prop-bool');
    const input = node('input', { type: 'checkbox', checked: !!value });
    input.addEventListener('change', () => commit(input.checked ? 1 : 0));
    row.append(input);
  } else if (prop.type === 'color' || prop.type === 'float3') {
    const arr = Array.isArray(value) ? value : [0, 0, 0];
    const hex = '#' + arr.slice(0, 3).map(c => Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16).padStart(2, '0')).join('');
    const input = node('input', { type: 'color', value: hex });
    input.addEventListener('input', () => { const n = parseInt(input.value.slice(1), 16); commit([((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]); });
    row.append(input);
  } else if (prop.type === 'float' || prop.type === 'int') {
    if (prop.min !== null && prop.max !== null) {
      const range = node('input', { type: 'range', min: prop.min, max: prop.max, step: prop.type === 'int' ? 1 : 0.01, value });
      const out = node('output', { textContent: String(value) });
      range.addEventListener('input', () => { out.textContent = range.value; commit(Number(range.value)); });
      row.append(range, out);
    } else {
      const input = node('input', { type: 'number', value, step: prop.type === 'int' ? 1 : 0.01 });
      input.addEventListener('change', () => commit(Number(input.value)));
      row.append(input);
    }
  } else {
    const arr = Array.isArray(value) ? value : [];
    const input = node('input', { type: 'text', value: arr.join(', '), spellcheck: false });
    input.addEventListener('change', () => commit(input.value.split(',').map(s => Number(s.trim()) || 0)));
    row.append(input);
  }
  return row;
}

// Render property controls for a stack's enabled layers into host (replacing its
// children). valuesByLayer = {layerId:{propName:value}}; missing values fall back
// to the code-defined default. commit(layerId, propName, value) persists a change.
// Layers are grouped under a name header so a whole shader's properties are shown.
export function renderShaderProperties(host, layers, valuesByLayer, commit) {
  host.replaceChildren();
  const enabled = (layers || []).filter(l => l.enabled !== false);
  let any = false;
  for (const layer of enabled) {
    const info = parseLayer(layer.code);
    if (info.errors.length) host.append(node('div', { className: 'shader-error', textContent: info.errors.join('\n') }));
    if (!info.properties.length) continue;
    any = true;
    host.append(node('div', { className: 'shader-prop-layer', textContent: layer.name }));
    const layerParams = valuesByLayer?.[layer.id] || {};
    for (const prop of info.properties) {
      const value = layerParams[prop.name] !== undefined ? layerParams[prop.name] : prop.default;
      host.append(buildPropertyControl(prop, value, v => commit(layer.id, prop.name, v)));
    }
  }
  if (!any) host.append(node('div', { className: 'muted', textContent: t('//@property 주석으로 파라미터를 선언하세요.') }));
}
