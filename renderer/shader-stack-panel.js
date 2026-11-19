import { t } from '../src/i18n/index.js';
import { parseLayer, parseStack } from '../src/core/shader-stack.js';

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
    float2 offsetBase = ctx.lightDirScreen / max(ctx.depth, 0.001);
    float2 offsetUV = offsetBase * (3.0 * width) * (width * width);
    float neighborDepth = sampleSceneDepth(ctx.pixel + offsetUV * ctx.viewportSize);
    float rel = abs(neighborDepth - ctx.depth) / max(ctx.depth, 0.001);
    float mask = saturate((rel - bias) / max(fade, 1e-5));
    ctx.color += rimColor * mask * intensity;
}` },
];
const BLANK_TEMPLATE = { name: 'Custom', code: `void Custom(inout ShadingContext ctx) {\n    // ctx.color 를 변형하세요\n}` };

let nextId = 1;
const makeLayer = (name, code) => ({ id: `layer-${nextId++}`, name, code, enabled: true });

// Unity-like material shader editor: a library of shader stacks, per-material
// assignment, and per-material instance property values. stackId = library index+1;
// 0 = base. Properties edited here belong to the selected MATERIAL instance.
export class ShaderStackPanel {
  constructor() {
    this.$ = id => document.getElementById(id);
    this.library = []; this.instances = []; this.materialNames = []; this.stride = 1;
    this.selectedMaterial = 0; this.selectedStack = 0;
    this.selected = -1; this.editor = null; this.applying = false; this.dragIndex = -1; this.popup = null;
    this.$('shader-add').addEventListener('click', () => this.insertLayer(this.stack.length, SHADER_EXAMPLES[this.stack.length % SHADER_EXAMPLES.length]));
    this.$('shader-reset').addEventListener('click', () => { if (this.selectedStack < 1) return; this.library[this.selectedStack - 1].layers = []; this.selected = -1; this.render(); this.apply(); });
    this.$('shader-apply').addEventListener('click', () => this.apply());
    this.$('shader-library-add').addEventListener('click', () => this.addStack());
    this.$('shader-material').addEventListener('change', e => this.selectMaterial(Number(e.target.value)));
    this.$('shader-material-stack').addEventListener('change', e => this.assignStack(Number(e.target.value)));
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
  get instance() { return this.instances[this.selectedMaterial] || { stackId: 0, params: {} }; }

  async load() { this.setState(await window.api.shaderStackLibraryGet()); }
  setState(state) {
    this.library = state.library || []; this.instances = state.instances || []; this.materialNames = state.materialNames || []; this.stride = state.stride || 1;
    if (this.selectedMaterial >= this.materialNames.length) this.selectedMaterial = 0;
    this.selectedStack = this.instance.stackId || 0;
    if (this.selectedStack > this.library.length) this.selectedStack = 0;
    this.render();
  }

  selectMaterial(i) {
    this.selectedMaterial = i; this.selectedStack = this.instance.stackId || 0; this.selected = -1;
    window.api.shaderStackPreview(i).catch(() => {});
    this.render();
  }
  assignStack(stackId) {
    window.api.shaderStackAssign(this.selectedMaterial, stackId).catch(() => {});
    this.selectedStack = stackId; this.selected = -1;
    window.api.shaderStackPreview(this.selectedMaterial).catch(() => {});
    this.render();
  }
  selectStack(stackId) { this.selectedStack = stackId; this.selected = -1; this.render(); }
  async addStack() {
    this.library.push({ name: `${t('스택')} ${this.library.length + 1}`, outline: false, layers: [] });
    this.selectedStack = this.library.length; this.selected = -1;
    try { await window.api.shaderStackLibrarySet(this.library); } catch (e) { this.setError(e.message); }
    this.render();
  }
  async deleteStack(stackId) {
    this.library.splice(stackId - 1, 1);
    for (const inst of this.instances) { if (inst.stackId === stackId) inst.stackId = 0; else if (inst.stackId > stackId) inst.stackId -= 1; }
    if (this.selectedStack === stackId) this.selectedStack = 0; else if (this.selectedStack > stackId) this.selectedStack -= 1;
    try { await window.api.shaderStackLibrarySet(this.library); } catch (e) { this.setError(e.message); }
    this.render();
  }

  render() {
    this.renderMaterialSelector();
    this.renderLibrary();
    this.$('shader-stack-name').textContent = this.selectedStack >= 1 ? (this.library[this.selectedStack - 1]?.name || '') : t('기본 셰이딩');
    this.renderStack();
    this.renderEditor();
    this.renderProperties();
  }

  renderMaterialSelector() {
    const mat = this.$('shader-material');
    mat.replaceChildren(...this.materialNames.map((name, i) => node('option', { value: i, textContent: `${String(i + 1).padStart(2, '0')} ${name || t('(이름 없음)')}` })));
    if (!this.materialNames.length) mat.append(node('option', { value: 0, textContent: t('열린 모델 없음') }));
    mat.value = String(this.selectedMaterial);
    const stackSel = this.$('shader-material-stack');
    stackSel.replaceChildren(node('option', { value: 0, textContent: t('기본 셰이딩') }),
      ...this.library.map((s, i) => node('option', { value: i + 1, textContent: s.name })));
    stackSel.value = String(this.instance.stackId || 0);
  }

  renderLibrary() {
    const list = this.$('shader-library');
    list.replaceChildren();
    if (!this.library.length) { list.append(node('li', { className: 'material-empty', textContent: t('스택 추가를 눌러 셰이더 스택을 만드세요.') })); return; }
    this.library.forEach((s, i) => {
      const stackId = i + 1;
      const row = node('li', { className: stackId === this.selectedStack ? 'active' : '' });
      const users = this.instances.filter(a => a.stackId === stackId).length;
      const select = node('button', { className: 'shader-select', textContent: `${s.outline ? '◉ ' : ''}${s.name} (${users})`, ariaPressed: String(stackId === this.selectedStack) });
      select.addEventListener('click', () => this.selectStack(stackId));
      const del = node('button', { className: 'link', textContent: '✕', title: t('삭제') });
      del.addEventListener('click', () => this.deleteStack(stackId));
      row.append(select, del);
      list.append(row);
    });
  }

  insertLayer(index, template) {
    if (this.selectedStack < 1) { this.setError(t('먼저 스택을 추가/선택하세요.')); return; }
    const existing = new Set(this.stack.map(l => l.name));
    let name = template.name, n = 2;
    while (existing.has(name)) name = `${template.name}_${n++}`;
    const code = template.code.replace(/void\s+\w+\s*\(\s*inout\s+ShadingContext/, `void ${name}(inout ShadingContext`);
    this.stack.splice(index, 0, makeLayer(name, code));
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
    for (const example of [...SHADER_EXAMPLES, BLANK_TEMPLATE]) {
      const item = node('button', { className: 'shader-popup-item', textContent: example.name, role: 'menuitem' });
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
      return b;
    };
    if (this.selectedStack < 1) { list.append(node('li', { className: 'material-empty', textContent: t('기본 셰이딩입니다. 스택을 추가/할당하세요.') })); return; }
    if (!this.stack.length) { list.append(node('li', { className: 'material-empty', textContent: t('+ 를 눌러 셰이더 레이어를 쌓으세요.') })); list.append(insertButton(0)); return; }
    this.stack.forEach((layer, i) => {
      list.append(insertButton(i));
      const row = node('li', { className: i === this.selected ? 'active' : '', draggable: true });
      row.dataset.index = i;
      const toggle = node('input', { type: 'checkbox', checked: layer.enabled, title: t('활성화') });
      toggle.addEventListener('change', () => { layer.enabled = toggle.checked; this.apply(); });
      const select = node('button', { className: 'shader-select', textContent: layer.name, ariaPressed: String(i === this.selected) });
      select.addEventListener('click', () => { this.selected = i; this.render(); });
      row.append(toggle, select);
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
      this.editor.on('change', () => { const current = this.stack[this.selected]; if (current) current.code = this.editor.getValue(); });
    }
    if (this.editor.getValue() !== layer.code) this.editor.setValue(layer.code);
  }

  // Properties belong to the selected MATERIAL instance (Unity-style), not the
  // shared stack. Values are stored in instances[selectedMaterial].params.
  renderProperties() {
    const host = this.$('shader-properties');
    host.replaceChildren();
    const layer = this.stack[this.selected];
    if (!layer) { host.append(node('div', { className: 'muted', textContent: t('레이어를 선택하세요.') })); return; }
    const info = parseLayer(layer.code);
    if (info.errors.length) host.append(node('div', { className: 'shader-error', textContent: info.errors.join('\n') }));
    if (!info.properties.length) { host.append(node('div', { className: 'muted', textContent: t('//@property 주석으로 파라미터를 선언하세요.') })); return; }
    const inst = this.instance;
    const layerParams = inst.params?.[layer.id] || {};
    for (const prop of info.properties) {
      const value = layerParams[prop.name] !== undefined ? layerParams[prop.name] : prop.default;
      const row = node('label', { className: 'shader-prop-row', title: prop.label });
      row.append(node('span', { textContent: prop.label }));
      const commit = v => { this.setInstanceParam(layer.id, prop.name, v); };
      if (prop.type === 'bool') {
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
      host.append(row);
    }
  }

  setInstanceParam(layerId, propName, value) {
    const inst = this.instances[this.selectedMaterial];
    if (!inst) return;
    inst.params = inst.params || {};
    inst.params[layerId] = { ...(inst.params[layerId] || {}), [propName]: value };
    window.api.shaderStackInstanceParams(this.selectedMaterial, { [layerId]: { [propName]: value } }).catch(e => this.setError(e.message));
  }

  setError(message) { const box = this.$('shader-error'); box.hidden = !message; box.textContent = message || ''; }

  async apply() {
    if (this.applying || this.selectedStack < 1) return;
    this.applying = true;
    this.$('shader-status').textContent = t('컴파일 중…');
    try {
      const outline = this.library[this.selectedStack - 1]?.outline;
      await window.api.shaderStackStackApply(this.selectedStack, this.stack.map(l => ({ id: l.id, name: l.name, code: l.code, enabled: l.enabled })), outline);
      this.setError(null);
      this.$('shader-status').textContent = this.stack.some(l => l.enabled) ? t('적용됨') : t('기본 셰이딩');
    } catch (e) {
      this.setError(e.message);
      this.$('shader-status').textContent = t('컴파일 오류');
    }
    this.applying = false;
  }
}
