import { t } from '../src/i18n/index.js';
import { renderShaderProperties } from './shader-properties.js';

const node = (tag, props = {}, ...children) => {
  const element = Object.assign(document.createElement(tag), props);
  element.append(...children);
  return element;
};

// Example layers users can insert into a stack. Each is a void function on the
// shared ShadingContext with //@property annotations driving the property UI.
export const SHADER_EXAMPLES = [
  { name: 'RimLight', code: `//@property float strength = 0.5 [0,1] "림 강도"
//@property float3 rimColor = (1,1,1) "림 색상"
//@property float power = 3 [1,8] "림 날카로움"
void RimLight(inout ShadingContext ctx) {
    float rim = pow(1 - saturate(dot(ctx.normal, ctx.viewDir)), power);
    ctx.color += rimColor * rim * strength;
}` },
  { name: 'Fresnel', code: `//@property float3 tint = (0.2,0.5,1) "프레넬 색상"
//@property float strength = 0.4 [0,1] "강도"
void Fresnel(inout ShadingContext ctx) {
    float f = pow(1 - saturate(dot(ctx.normal, ctx.viewDir)), 5);
    ctx.color = lerp(ctx.color, ctx.color + tint, f * strength);
}` },
  { name: 'ColorGrade', code: `//@property float3 multiply = (1,1,1) "곱하기"
//@property float3 add = (0,0,0) "더하기"
//@property float saturation = 1 [0,2] "채도"
void ColorGrade(inout ShadingContext ctx) {
    float3 c = ctx.color * multiply + add;
    float luma = dot(c, float3(0.2126, 0.7152, 0.0722));
    ctx.color = lerp(luma.xxx, c, saturation);
}` },
  { name: 'ToonRamp', code: `//@property float steps = 4 [2,8] "단계 수"
//@property float3 shadowTint = (0.6,0.65,0.8) "그림자 색"
void ToonRamp(inout ShadingContext ctx) {
    float band = floor(saturate(ctx.ndl) * steps) / steps;
    ctx.color *= lerp(shadowTint, float3(1,1,1), band);
}` },
  { name: 'DepthRimLight', code: `//@property float width = 1.0 [0,3] "림 폭"
//@property float bias = 0.1 [0,1] "깊이 임계값"
//@property float fade = 0.3 [0.01,1] "전이 폭"
//@property float intensity = 1.0 [0,2] "강도"
//@property float3 rimColor = (1,1,1) "림 색상"
void DepthRimLight(inout ShadingContext ctx) {
    // Light-facing variant: width is linear, in 3-pixel units at 1080p.
    float2 direction = ctx.lightDirScreen / max(length(ctx.lightDirScreen), 1e-5);
    float2 samplePixel = ctx.pixel + direction * (3.0 * width) * (ctx.viewportSize.y / 1080.0);
    // Off-screen depth is unknown; do not turn the viewport border into a rim.
    if (any(samplePixel < 0) || any(samplePixel >= ctx.viewportSize)) return;
    float neighborDepth = sampleSceneDepth(samplePixel);
    float rel = (neighborDepth - ctx.depth) / max(ctx.depth, 0.001);
    // Background is 0 in this renderer, and represents open space beyond the silhouette.
    float mask = neighborDepth <= 0 ? 1.0 : smoothstep(bias, bias + max(fade, 1e-5), rel);
    ctx.color += rimColor * mask * intensity;
}` },
];
const BLANK_TEMPLATE = { name: 'Custom', code: `void Custom(inout ShadingContext ctx) {\n    // ctx.color 를 변형하세요\n}` };

const makeLayer = (name, code) => ({ id: `layer-${crypto.randomUUID()}`, name, code, enabled: true });

// Pure shader-library authoring tool: edit built-in and user shaders as stacks of
// HLSL functions, save/manage them, and preview the SELECTED shader on a sphere.
// stackId = library index+1; 0 = base. No per-material assignment or instance values
// here — those live in the material inspector. The property panel previews the
// selected shader with code-defined defaults (preview-only, not persisted).
export class ShaderStackPanel {
  constructor() {
    this.$ = id => document.getElementById(id);
    this.library = []; this.stride = 1; this.functions = []; this.builtinFunctions = [];
    this.selectedStack = 1; this.previewValues = {}; this.onPreviewChange = null;
    this.selected = -1; this.editor = null; this.applying = false; this.dragIndex = -1; this.popup = null;
    this.$('shader-add').addEventListener('click', ev => this.openCatalog(this.stack.length, ev.currentTarget));
    this.$('shader-reset').addEventListener('click', () => { if (this.selectedStack < 1) return; this.library[this.selectedStack - 1].layers = []; this.selected = -1; this.render(); this.apply(); });
    this.$('shader-apply').addEventListener('click', () => this.apply());
    this.$('shader-library-add').addEventListener('click', () => this.addStack());
    this.$('shader-save').addEventListener('click', () => this.saveStack(false));
    this.$('shader-save-as').addEventListener('click', () => this.saveStack(true));
    this.$('shader-function-open').addEventListener('click', () => this.openFunction());
    this.$('shader-function-save').addEventListener('click', () => this.saveFunction(false));
    this.$('shader-function-save-as').addEventListener('click', () => this.saveFunction(true));
    this.$('shader-function-name').addEventListener('input', e => { if (this.stack[this.selected]) this.stack[this.selected].name = e.target.value; if (this.applying) this.pendingApply = true; });
    this.$('shader-asset-name').addEventListener('input', e => { if (this.library[this.selectedStack - 1]) this.library[this.selectedStack - 1].name = e.target.value; if (this.applying) this.pendingApply = true; });
    this.$('shader-outline').addEventListener('change', e => { if (this.selectedStack < 1) return; this.library[this.selectedStack - 1].outline = e.target.checked; this.apply(); });
    document.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Delete' && ev.key !== 'Backspace') return;
      const el = document.activeElement;
      const typing = el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.closest?.('.CodeMirror'));
      if (typing || this.selected < 0 || this.popup) return;
      ev.preventDefault(); this.removeLayer(this.selected);
    });
    document.addEventListener('pointerdown', (ev) => { if (this.popup && !this.popup.contains(ev.target)) this.closePopup(); }, true);
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') this.closePopup(); });
    this.render();
  }

  get stack() { return this.selectedStack >= 1 ? (this.library[this.selectedStack - 1]?.layers || []) : []; }

  async load() { this.setState(await window.api.shaderStackLibraryGet()); }
  setState(state) {
    this.committedState = state;
    if (this.applying) { this.onPreviewChange?.(); return; } // keep local source while adopting committed preview data
    this.library = state.library || []; this.stride = state.stride || 1;
    this.functions = state.functions || [];
    this.builtinFunctions = state.builtinFunctions || [];
    const errors = this.$('shader-assets-error');
    errors.textContent = (state.assetErrors || []).map(e => `${e.path}\n${e.message}`).join('\n\n');
    errors.hidden = !errors.textContent;
    // Library selection is independent of material assignments: preserve it across
    // broadcasts (which may originate from the main window's material edits).
    if (this.selectedStack > this.library.length) this.selectedStack = this.library.length;
    this.render();
    this.onPreviewChange?.();
  }

  selectStack(stackId) {
    this.selectedStack = stackId; this.selected = -1; this.previewValues = {};
    this.render();
    window.api.shaderStackPreviewShader(stackId).catch(() => {});
    this.onPreviewChange?.();
  }
  async addStack() {
    this.library.push({ name: `${t('스택')} ${this.library.length + 1}`, outline: false, layers: [], source: 'file', ref: null, path: null, metadata: { tags: [] } });
    try { const st = await window.api.shaderStackLibrarySet(this.library); if (st?.library) this.setState(st); } catch (e) { this.setError(e.message); return; }
    this.selectStack(this.library.length);
  }
  async deleteStack(stackId) {
    const entry = this.library[stackId - 1];
    if (!entry) return;
    if (entry.source === 'builtin') { this.setError(t('빌트인 셰이더는 삭제할 수 없습니다.')); return; }
    try { const st = await window.api.shaderStackDeleteEntry(stackId); if (st?.library) this.setState(st); } catch (e) { this.setError(e.message); return; }
    this.previewValues = {}; this.selected = -1; this.render();
    window.api.shaderStackPreviewShader(this.selectedStack).catch(() => {});
    this.onPreviewChange?.();
  }
  async saveStack(saveAs = false) {
    if (this.selectedStack < 1) return;
    const layerId = this.stack[this.selected]?.id;
    try {
      if (!await this.apply()) return;
      const r = await window.api.shaderStackSaveEntry(this.selectedStack, saveAs);
      if (!r) return; // user canceled the save dialog
      if (r.state?.library) this.setState(r.state);
      this.selectStack(r.stackId || this.selectedStack);
      this.selected = this.stack.findIndex(layer => layer.id === layerId); this.render();
      this.$('shader-status').textContent = t('저장됨');
    } catch (e) { this.setError(e.message); }
  }
  async openFunction() {
    try {
      if (!await this.apply()) return;
      const result = await window.api.shaderFunctionOpen();
      if (!result) return;
      this.setState(result.state);
      this.insertLayer(this.stack.length, result.asset);
    } catch (error) { this.setError(error.message); }
  }
  async saveFunction(saveAs) {
    try {
      if (this.applyTask) await this.applyTask;
      const layer = this.stack[this.selected]; if (!layer) return;
      const state = await window.api.shaderFunctionSave(this.selectedStack, layer.id, { ...layer }, saveAs);
      if (state) { this.setState(state); this.setError(null); this.$('shader-status').textContent = t('저장됨'); }
    } catch (error) { this.setError(error.message); }
  }

  render() {
    this.renderLibrary();
    this.$('shader-asset-name').value = this.library[this.selectedStack - 1]?.name || '';
    this.$('shader-asset-name').disabled = this.selectedStack < 1;
    this.$('shader-stack-name').textContent = this.selectedStack >= 1 ? (this.library[this.selectedStack - 1]?.name || '') : t('기본 셰이딩');
    this.renderOutlineToggle();
    this.renderStack();
    this.renderEditor();
    this.renderProperties();
  }

  renderOutlineToggle() {
    const cb = this.$('shader-outline');
    cb.disabled = this.selectedStack < 1;
    cb.checked = this.selectedStack >= 1 ? !!this.library[this.selectedStack - 1]?.outline : false;
  }

  renderLibrary() {
    const list = this.$('shader-library');
    list.replaceChildren();
    if (!this.library.length) { list.append(node('li', { className: 'material-empty', textContent: t('스택 추가를 눌러 셰이더 스택을 만드세요.') })); return; }
    this.library.forEach((s, i) => {
      const stackId = i + 1;
      const row = node('li', { className: stackId === this.selectedStack ? 'active' : '' });
      const mark = `${s.outline ? '◉ ' : ''}${s.dirty ? '● ' : ''}${s.name}`;
      const select = node('button', { className: 'shader-select', textContent: mark, title: s.source === 'builtin' ? t('빌트인') : (s.ref || t('저장 안 됨')), ariaPressed: String(stackId === this.selectedStack) });
      select.addEventListener('click', () => this.selectStack(stackId));
      row.append(select);
      if (s.source !== 'builtin') {
        const del = node('button', { className: 'link', textContent: '✕', title: t('삭제') });
        del.addEventListener('click', () => this.deleteStack(stackId));
        row.append(del);
      }
      list.append(row);
    });
  }

  insertLayer(index, template) {
    if (this.selectedStack < 1) { this.setError(t('먼저 스택을 추가/선택하세요.')); return; }
    const existing = new Set(this.stack.map(l => l.name));
    let name = template.name, n = 2;
    while (!template.ref && existing.has(name)) name = `${template.name}_${n++}`;
    const code = template.ref ? template.code : template.code.replace(/void\s+\w+\s*\(\s*inout\s+ShadingContext/, `void ${name}(inout ShadingContext`);
    this.stack.splice(index, 0, { ...makeLayer(name, code), ref: template.ref || null, metadata: template.metadata || { tags: [] } });
    this.selected = index;
    this.closePopup(); this.render(); this.apply();
  }
  removeLayer(index) {
    if (index < 0 || index >= this.stack.length) return;
    this.stack.splice(index, 1);
    this.selected = Math.min(this.selected, this.stack.length - 1);
    this.closePopup(); this.render(); this.apply();
  }
  moveLayer(from, to) {
    if (from === to || from < 0 || from >= this.stack.length) return;
    const [layer] = this.stack.splice(from, 1);
    this.stack.splice(Math.max(0, Math.min(to, this.stack.length)), 0, layer);
    this.selected = this.stack.indexOf(layer);
    this.render(); this.apply();
  }

  openCatalog(index, anchor) {
    this.closePopup();
    const menu = node('div', { className: 'shader-popup', role: 'menu' });
    menu.append(node('div', { className: 'shader-popup-title', textContent: t('함수 삽입') }));
    for (const example of [...this.builtinFunctions, ...SHADER_EXAMPLES, BLANK_TEMPLATE, ...this.functions]) {
      const item = node('button', { className: 'shader-popup-item', textContent: example.name, role: 'menuitem' });
      item.title = example.ref || example.metadata?.description || '';
      item.addEventListener('click', () => this.insertLayer(index, example));
      menu.append(item);
    }
    this.showPopup(menu, anchor);
  }
  openContextMenu(index, ev) {
    this.closePopup(); this.selected = index; this.renderStack();
    const menu = node('div', { className: 'shader-popup shader-context', role: 'menu' });
    const del = node('button', { className: 'shader-popup-item', textContent: t('삭제'), role: 'menuitem' });
    del.addEventListener('click', () => this.removeLayer(index));
    menu.append(del);
    this.showPopup(menu, null, ev.clientX, ev.clientY);
  }
  showPopup(menu, anchor, x, y) {
    document.body.append(menu); this.popup = menu;
    const r = anchor ? anchor.getBoundingClientRect() : null;
    const left = r ? r.left : x, top = r ? r.bottom + 2 : y;
    menu.style.left = Math.min(left, window.innerWidth - menu.offsetWidth - 8) + 'px';
    menu.style.top = Math.min(top, window.innerHeight - menu.offsetHeight - 8) + 'px';
  }
  closePopup() { if (this.popup) { this.popup.remove(); this.popup = null; } }

  renderStack() {
    const list = this.$('shader-stack');
    list.replaceChildren();
    const insertButton = (index) => {
      const b = node('button', { className: 'shader-insert', textContent: '+', title: t('여기에 함수 삽입'), ariaLabel: t('여기에 함수 삽입') });
      b.addEventListener('click', () => this.openCatalog(index, b));
      return node('li', { className: 'shader-insert-row', role: 'presentation' }, b);
    };
    if (this.selectedStack < 1) { list.append(node('li', { className: 'material-empty', textContent: t('기본 셰이딩입니다. 스택을 추가하세요.') })); return; }
    if (!this.stack.length) { list.append(node('li', { className: 'material-empty', textContent: t('+ 를 눌러 첫 번째 함수를 추가하세요.') })); list.append(insertButton(0)); return; }
    // Display the same array order passed to the compiler and saved in .shader.
    // Disabled layers keep their position, but are skipped by execution numbering.
    let executionOrder = 0;
    this.stack.forEach((layer, i) => {
      list.append(insertButton(i));
      const enabled = layer.enabled !== false;
      const order = enabled ? String(++executionOrder) : '—';
      const label = enabled ? t('{0}번째 실행: {1}', order, layer.name) : t('실행 건너뜀: {0}', layer.name);
      const row = node('li', { className: `shader-layer-row${i === this.selected ? ' active' : ''}${enabled ? '' : ' disabled'}`, draggable: true, ariaLabel: label });
      row.dataset.index = i;
      row.dataset.layerId = layer.id;
      const number = node('span', { className: 'shader-execution-number', textContent: order, title: label, ariaHidden: 'true' });
      const toggle = node('input', { type: 'checkbox', checked: enabled, title: t('활성화') });
      toggle.addEventListener('click', ev => ev.stopPropagation());
      toggle.addEventListener('change', () => { this.stack[i].enabled = toggle.checked; this.renderStack(); this.apply(); });
      const select = node('button', { className: 'shader-select', textContent: layer.name, ariaPressed: String(i === this.selected) });
      row.append(number, toggle, select);
      row.addEventListener('click', () => { this.selected = i; this.render(); });
      row.addEventListener('contextmenu', (ev) => { ev.preventDefault(); this.openContextMenu(i, ev); });
      row.addEventListener('dragstart', (ev) => { this.dragIndex = i; ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', String(i)); row.classList.add('dragging'); });
      row.addEventListener('dragend', () => { this.dragIndex = -1; list.querySelectorAll('.drop-above,.drop-below,.dragging').forEach(el => el.classList.remove('drop-above', 'drop-below', 'dragging')); });
      row.addEventListener('dragover', (ev) => { ev.preventDefault(); ev.dataTransfer.dropEffect = 'move'; const rect = row.getBoundingClientRect(); const after = ev.clientY > rect.top + rect.height / 2; row.classList.toggle('drop-below', after); row.classList.toggle('drop-above', !after); });
      row.addEventListener('dragleave', () => row.classList.remove('drop-above', 'drop-below'));
      row.addEventListener('drop', (ev) => { ev.preventDefault(); const rect = row.getBoundingClientRect(); const after = ev.clientY > rect.top + rect.height / 2; let to = i + (after ? 1 : 0); if (this.dragIndex < to) to -= 1; this.moveLayer(this.dragIndex, to); });
      list.append(row);
    });
    list.append(insertButton(this.stack.length));
  }

  renderEditor() {
    const host = this.$('shader-editor-host');
    const layer = this.stack[this.selected];
    this.$('shader-name').textContent = layer ? layer.name : '';
    this.$('shader-function-name').value = layer?.name || '';
    this.$('shader-function-name').disabled = !layer;
    this.$('shader-function-save').disabled = !layer;
    this.$('shader-function-save-as').disabled = !layer;
    const uses = layer?.ref ? this.library.reduce((n, e) => n + e.layers.filter(l => l.ref === layer.ref).length, 0) : 0;
    this.$('shader-function-source').textContent = layer?.ref
      ? `${layer.ref} · ${t('공유 함수')} (${uses})`
      : t('함수 저장 시 .shaderStack 파일로 분리됩니다.');
    this.$('shader-function-source').title = layer?.ref || '';
    if (!layer) {
      if (this.editor) { this.editor.toTextArea(); this.editor = null; }
      host.replaceChildren(node('div', { className: 'muted', textContent: t('레이어를 선택하세요.') }));
      return;
    }
    if (!this.editor) {
      host.replaceChildren();
      const ta = node('textarea', { id: 'shader-code' });
      host.append(ta);
      this.editor = window.CodeMirror.fromTextArea(ta, {
        mode: 'text/x-c++src', theme: 'material-darker', lineNumbers: true,
        indentUnit: 4, tabSize: 4, indentWithTabs: false, lineWrapping: false,
        extraKeys: { 'Ctrl-S': () => this.apply(), 'Cmd-S': () => this.apply() },
      });
      this.editor.on('change', () => { const current = this.stack[this.selected]; if (current) current.code = this.editor.getValue(); if (this.applying) this.pendingApply = true; });
    }
    if (this.editor.getValue() !== layer.code) this.editor.setValue(layer.code);
  }

  // Preview-only properties for the SELECTED library shader. Values are transient
  // (previewValues), initialized from code defaults, and reset on shader switch.
  // Per-material instance values are edited in the material inspector, not here.
  renderProperties() {
    renderShaderProperties(this.$('shader-properties'), this.stack, this.previewValues, (layerId, propName, value) => {
      this.previewValues[layerId] = { ...(this.previewValues[layerId] || {}), [propName]: value };
      this.onPreviewChange?.();
    });
  }

  setError(message) { const box = this.$('shader-error'); box.hidden = !message; box.textContent = message || ''; }

  apply() {
    if (this.selectedStack < 1) return Promise.resolve(false);
    if (this.applying) { this.pendingApply = true; return this.applyTask; }
    this.applying = true;
    this.applyTask = (async () => {
      let ok = false;
      do {
        this.pendingApply = false;
        const index = this.selectedStack - 1, snapshot = JSON.stringify(this.library[index]);
        const entry = JSON.parse(snapshot);
        this.$('shader-status').textContent = t('컴파일 중…');
        try {
          const state = await window.api.shaderStackStackApply(index + 1, entry.layers, entry.outline, entry.name);
          this.committedState = state;
          // Preserve newer local keystrokes while adopting shared-function updates.
          const edited = JSON.stringify(this.library[index]) !== snapshot ? this.library[index] : null;
          this.library = state.library; if (edited) this.library[index] = edited;
          this.functions = state.functions || []; this.builtinFunctions = state.builtinFunctions || []; this.stride = state.stride;
          this.setError(null); this.renderLibrary(); this.renderProperties();
          this.onPreviewChange?.();
          this.$('shader-status').textContent = t('적용됨'); ok = true;
        } catch (error) { this.setError(error.message); this.$('shader-status').textContent = t('컴파일 오류'); ok = false; }
      } while (this.pendingApply);
      return ok;
    })().finally(() => { this.applying = false; this.applyTask = null; });
    return this.applyTask;
  }
}
