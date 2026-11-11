import { t, setLanguage, getLanguage, formatNumber, translateStatic } from '../src/i18n/index.js';
import { Viewer, VIEWABLE } from './viewer.js';
import { MaterialPanel } from './material-panel.js';
import { captureWorkspace, restoreWorkspaceState } from './workspace-state.js';
import { DEFAULT_LIGHT_LUX, DEFAULT_EV100, clampLightLux, legacyLightToLux } from '../src/core/lighting.js';

const api = window.api;
const startup = await api.startup();
setLanguage(startup.locale);
translateStatic(document.body);
document.getElementById('viewport').dataset.dropLabel = t('여기에 놓아 열기');
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...children);
  return n;
};

const viewer = new Viewer($('canvas-host'));
const materialPanel = new MaterialPanel(viewer);
const applyRenderMode = (mode, save = false) => {
  viewer.setRenderMode(mode);
  $('toon-settings').hidden = viewer.renderMode !== 'toon';
  document.querySelectorAll('.viewport-mode').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.mode === viewer.renderMode)));
  if (save) localStorage.setItem('viewportRenderMode', viewer.renderMode);
};
document.querySelectorAll('.viewport-mode').forEach((button) => button.addEventListener('click', () => applyRenderMode(button.dataset.mode, true)));
applyRenderMode(localStorage.getItem('viewportRenderMode') === 'toon' ? 'toon' : 'lambert');
const applyOutline = (width, color, save = true) => {
  viewer.setOutline(width, color);
  const settings = viewer.outlineSettings;
  $('outline-width').value = String(settings.width);
  $('outline-width-number').value = String(settings.width);
  $('outline-color').value = settings.color;
  $('outline-color-value').textContent = settings.color.toUpperCase();
  if (save) localStorage.setItem('viewportOutline', JSON.stringify(settings));
};
for (const id of ['outline-width', 'outline-width-number']) {
  $(id).addEventListener('input', () => {
    if ($(id).value !== '') applyOutline(Number($(id).value), $('outline-color').value);
  });
  $(id).addEventListener('change', () => applyOutline(Number($(id).value), $('outline-color').value));
}
$('outline-color').addEventListener('input', () => applyOutline(Number($('outline-width').value), $('outline-color').value));
$('outline-reset').addEventListener('click', () => applyOutline(1.6, '#151923'));
try {
  const settings = JSON.parse(localStorage.getItem('viewportOutline') || 'null');
  if (settings) applyOutline(settings.width, settings.color, false);
} catch { /* ignore invalid stored settings */ }
for (const tab of document.querySelectorAll('.inspector-tab')) {
  tab.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...document.querySelectorAll('.inspector-tab')];
    const target = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : tabs[(tabs.indexOf(tab) + 1) % tabs.length];
    target.click(); target.focus();
  });
  tab.addEventListener('click', () => {
    for (const other of document.querySelectorAll('.inspector-tab')) {
      const selected = other === tab;
      other.setAttribute('aria-selected', String(selected));
      other.tabIndex = selected ? 0 : -1;
      $(other.getAttribute('aria-controls')).hidden = !selected;
    }
  });
}
const state = {
  dir: null,
  parent: null,
  entries: [],
  visible: [],      // entries currently shown in the list
  selected: -1,     // index into visible
  loadedPath: null,
  loadedInfo: null,
  formats: {},
  dialogMode: 'single',
  lastOutput: null,
  busy: false,
  workspacePath: null,
  workspaceBusy: false,
  restoring: false,
  modelLoading: false,
  modelLoadId: 0,
  conversionSource: null,
};
const OPENABLE = [...VIEWABLE, '.canvas'];

const basename = (p) => p.replace(/^.*[\\/]/, '');
const dirname = (p) => p.replace(/[\\/][^\\/]*$/, '') || p;
const stripExt = (p) => p.replace(/\.[^.\\/]+$/, '');
const joinPath = (dir, name) => (/[\\/]$/.test(dir) ? dir + name : `${dir}\\${name}`);
const fmtSize = (n) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
const fmtNum = formatNumber;

function setStatus(text, kind = '') {
  $('status-text').textContent = text;
  $('statusbar').className = kind;
}

// ---------------- file browser ----------------
async function navigate(dir, selectName = null) {
  try {
    const r = await api.list(dir);
    state.dir = r.dir;
    state.parent = r.parent;
    state.entries = r.entries;
    $('path-input').value = r.dir;
    $('path-input').scrollLeft = $('path-input').scrollWidth;
    localStorage.setItem('lastDir', r.dir);
    renderList(selectName);
  } catch (e) {
    setStatus(t`폴더를 열 수 없습니다: ${e.message}`, 'error');
    $('path-input').value = state.dir || '';
  }
}

function renderList(selectName = null) {
  const filter = $('filter-input').value.trim().toLowerCase();
  const only3d = $('only-3d').checked;
  const collator = new Intl.Collator(getLanguage(), { numeric: true, sensitivity: 'base' });
  const dirs = state.entries.filter((e) => e.isDir && !e.name.startsWith('$')).sort((a, b) => collator.compare(a.name, b.name));
  const files = state.entries.filter((e) => !e.isDir && (!only3d || OPENABLE.includes(e.ext))).sort((a, b) => collator.compare(a.name, b.name));
  state.visible = [...dirs, ...files].filter((e) => !filter || e.name.toLowerCase().includes(filter));

  const list = $('file-list');
  list.replaceChildren();
  state.visible.forEach((e, i) => {
    const viewable = OPENABLE.includes(e.ext);
    const li = el('li', { className: e.isDir ? 'dir' : `${e.ext.slice(1)}${viewable ? '' : ' dim'}`, title: e.path });
    li.dataset.index = i;
    li.append(
      el('span', { className: 'icon', textContent: e.isDir ? 'DIR' : (e.ext.slice(1, 5).toUpperCase() || '—') }),
      el('span', { className: 'fname', textContent: e.name }),
    );
    if (!e.isDir) li.append(el('span', { className: 'fsize', textContent: fmtSize(e.size) }));
    if (e.path === state.loadedPath) li.classList.add('loaded');
    list.append(li);
  });
  const modelCount = files.filter((f) => VIEWABLE.includes(f.ext)).length;
  const pmxCount = files.filter((f) => f.ext === '.pmx').length;
  $('browser-status').textContent = t`폴더 ${dirs.length} · 3D 파일 ${modelCount}${pmxCount ? ` (PMX ${pmxCount})` : ''}`;
  let sel = -1;
  if (selectName) sel = state.visible.findIndex((e) => e.name === selectName);
  if (sel < 0) sel = state.visible.findIndex((e) => e.path === state.loadedPath);
  select(sel, false);
}

function select(index, scroll = true) {
  state.selected = index;
  const list = $('file-list');
  list.querySelector('.selected')?.classList.remove('selected');
  const li = list.children[index];
  if (li) {
    li.classList.add('selected');
    if (scroll) li.scrollIntoView({ block: 'nearest' });
  }
}

function activate(index) {
  const e = state.visible[index];
  if (!e) return;
  if (e.isDir) navigate(e.path);
  else if (e.ext === '.canvas') openWorkspace(e.path);
  else if (VIEWABLE.includes(e.ext)) openModel(e.path);
}

$('file-list').addEventListener('click', (ev) => {
  const li = ev.target.closest('li');
  if (!li) return;
  const i = Number(li.dataset.index);
  select(i);
  if (!state.visible[i].isDir) activate(i);
});
$('file-list').addEventListener('dblclick', (ev) => {
  const li = ev.target.closest('li');
  if (li && state.visible[Number(li.dataset.index)].isDir) activate(Number(li.dataset.index));
});
$('file-list').addEventListener('keydown', (ev) => {
  const n = state.visible.length;
  if (!n) return;
  let i = state.selected;
  if (ev.key === 'ArrowDown') i = Math.min(n - 1, i + 1);
  else if (ev.key === 'ArrowUp') i = Math.max(0, i - 1);
  else if (ev.key === 'Home') i = 0;
  else if (ev.key === 'End') i = n - 1;
  else if (ev.key === 'Enter') { activate(state.selected); ev.preventDefault(); return; }
  else if (ev.key === 'Backspace') { if (state.parent) navigate(state.parent, basename(state.dir)); ev.preventDefault(); return; }
  else return;
  ev.preventDefault();
  select(i);
  // arrow keys preview files immediately, like an image browser
  const e = state.visible[i];
  if (e && !e.isDir && VIEWABLE.includes(e.ext)) openModel(e.path);
});

$('btn-up').addEventListener('click', () => { if (state.parent) navigate(state.parent, basename(state.dir)); });
$('btn-pick').addEventListener('click', async () => {
  const dir = await api.pickFolder(state.dir);
  if (dir) navigate(dir);
});
$('path-input').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') openPath($('path-input').value.trim().replace(/^"|"$/g, ''));
});
$('filter-input').addEventListener('input', () => renderList());
$('only-3d').addEventListener('change', () => renderList());

async function openPath(p) {
  if (!p || state.workspaceBusy || state.busy) return;
  if (/\.canvas$/i.test(p)) { await openWorkspace(p); return; }
  try {
    const st = await api.stat(p);
    if (st.isDir) await navigate(p);
    else { await navigate(dirname(p), basename(p)); await openModel(p); }
  } catch (e) {
    setStatus(t`경로를 열 수 없습니다: ${p}`, 'error');
  }
}

// ---------------- model loading ----------------
async function openModel(filePath, fromWorkspace = false) {
  if ((state.workspaceBusy && !fromWorkspace) || state.busy) return null;
  const loadId = ++state.modelLoadId;
  state.modelLoading = true; updateWorkspaceBar();
  $('empty-hint').hidden = true;
  $('viewport-error').hidden = true;
  $('loading').hidden = false;
  setStatus(t`불러오는 중: ${filePath}`);
  const started = performance.now();
  try {
    const info = await viewer.load(filePath);
    if (!info) return; // superseded by a newer request
    state.loadedPath = filePath;
    state.loadedInfo = info;
    renderInfo(info, filePath);
    $('btn-convert').disabled = info.kind !== 'pmx';
    document.querySelectorAll('#file-list li.loaded').forEach((li) => li.classList.remove('loaded'));
    const idx = state.visible.findIndex((e) => e.path === filePath);
    if (idx >= 0) $('file-list').children[idx].classList.add('loaded');
    document.title = `${basename(filePath)} — MMD Canvas`;
    setStatus(t`${filePath}  ·  정점 ${fmtNum(info.vertices)} · 삼각형 ${fmtNum(info.triangles)}  ·  ${Math.round(performance.now() - started)} ms`);
    api.notifyLoaded({ file: filePath, vertices: info.vertices, triangles: info.triangles, kind: info.kind });
    return info;
  } catch (e) {
    console.error(e);
    if (state.loadedPath === null) $('empty-hint').hidden = false;
    $('viewport-error').textContent = t`${basename(filePath)} 을(를) 열 수 없습니다 — ${e.message}`;
    $('viewport-error').hidden = false;
    setStatus(t`불러오기 실패: ${e.message}`, 'error');
    api.notifyLoaded({ file: filePath, error: e.message });
    return null;
  } finally {
    if (loadId === state.modelLoadId) { $('loading').hidden = true; state.modelLoading = false; updateWorkspaceBar(); }
  }
}

function renderInfo(info, filePath) {
  const rows = [
    [t('이름'), info.name || basename(filePath)],
    info.nameEn ? [t('영문 이름'), info.nameEn] : null,
    [t('형식'), info.format],
    [t('정점'), fmtNum(info.vertices)],
    [t('삼각형'), fmtNum(info.triangles)],
    [t('재질'), fmtNum(info.materialNames.length)],
    [t('본'), fmtNum(info.bones)],
    info.kind === 'pmx' ? [t('모프'), fmtNum(info.morphs)] : [t('메시'), fmtNum(info.meshes)],
    info.kind === 'pmx' ? [t('텍스처'), fmtNum(info.textures)] : null,
    info.kind === 'pmx' ? [t('물리'), t`강체 ${fmtNum(info.rigidBodies)} · 조인트 ${fmtNum(info.joints)}`] : null,
  ].filter(Boolean);
  const grid = $('info');
  grid.replaceChildren();
  for (const [k, v] of rows) grid.append(el('dt', { textContent: k }), el('dd', { textContent: v }));
  if (info.comment && info.comment.trim()) grid.append(el('div', { className: 'comment', textContent: info.comment.trim() }));

  $('panel-warnings').hidden = !info.warnings.length;
  $('warnings').replaceChildren(...info.warnings.map((w) => el('li', { textContent: w })));

  materialPanel.load();

  $('panel-morphs').hidden = !info.morphList.length;
  $('morph-count').textContent = info.morphList.length;
  $('morphs').replaceChildren(...info.morphList.map((m, i) => {
    const out = el('output', { textContent: '0' });
    const range = el('input', { type: 'range', min: 0, max: 1, step: 0.01, value: 0 });
    range.setAttribute('aria-label', m.name);
    range.addEventListener('input', () => { out.textContent = Number(range.value).toFixed(2).replace(/^0\.00$/, '0'); viewer.setMorph(i, Number(range.value)); });
    return el('div', { className: 'morph' }, el('span', { textContent: m.name, title: m.name }), range, out);
  }));
}

$('btn-reset-morphs').addEventListener('click', () => {
  document.querySelectorAll('#morphs .morph').forEach((row, i) => {
    const range = row.querySelector('input');
    if (Number(range.value) !== 0) { range.value = 0; row.querySelector('output').textContent = '0'; viewer.setMorph(i, 0); }
  });
});

// ---------------- toolbar ----------------
{
  const ev = $('exposure-ev100'), compensation = $('exposure-compensation');
  const apply = (ev100, offset, save) => {
    if (!Number.isFinite(ev100) || !Number.isFinite(offset)) return;
    viewer.setExposure(ev100, offset);
    ev.value = String(viewer.exposure.ev100); compensation.value = String(viewer.exposure.compensation);
    if (save && !state.restoring) localStorage.setItem('viewportExposure', JSON.stringify(viewer.exposure));
  };
  for (const input of [ev, compensation]) {
    input.addEventListener('input', () => apply(ev.valueAsNumber, compensation.valueAsNumber, true));
    input.addEventListener('blur', () => apply(viewer.exposure.ev100, viewer.exposure.compensation, false));
  }
  $('exposure-reset').addEventListener('click', () => apply(DEFAULT_EV100, 0, true));
  try {
    const saved = JSON.parse(localStorage.getItem('viewportExposure') || 'null');
    if (saved) apply(saved.ev100, saved.compensation, false);
  } catch { /* ignore malformed preferences */ }
}
$('btn-open').addEventListener('click', async () => {
  const p = await api.openFile(state.dir);
  if (p) openPath(p);
});
$('btn-frame').addEventListener('click', () => viewer.frame());
for (const flag of ['grid', 'skeleton', 'wireframe']) {
  $(`flag-${flag}`).addEventListener('change', (ev) => viewer.setFlag(flag, ev.target.checked));
}
{
  const slider = $('light-intensity'), input = $('light-intensity-number');
  const apply = (value, save) => {
    if (!Number.isFinite(value)) return;
    const lux = clampLightLux(value);
    slider.max = String(Math.max(100, Math.ceil(lux / 100) * 100));
    slider.value = input.value = String(lux);
    viewer.setLightIntensity(lux);
    if (save && !state.restoring) localStorage.setItem('lightIlluminanceLux', String(lux));
  };
  const saved = localStorage.getItem('lightIlluminanceLux');
  const legacy = localStorage.getItem('lightIntensity');
  const initial = saved !== null && Number.isFinite(Number(saved)) ? Number(saved)
    : legacy !== null && Number.isFinite(Number(legacy)) ? legacyLightToLux(Number(legacy)) : DEFAULT_LIGHT_LUX;
  slider.addEventListener('input', () => apply(slider.valueAsNumber, true));
  input.addEventListener('input', () => apply(input.valueAsNumber, true));
  input.addEventListener('blur', () => apply(viewer.lightLevel, false));
  slider.addEventListener('dblclick', () => apply(DEFAULT_LIGHT_LUX, true));
  apply(initial, false);
}
{
  // soft shadows: toggle + softness (0..100 -> tan of the light's angular radius)
  const toggle = $('flag-shadow'), soft = $('shadow-softness');
  const apply = (save) => {
    viewer.setShadowSoftness((Number(soft.value) / 100) * 0.12);
    viewer.setShadows(toggle.checked);
    soft.disabled = !toggle.checked;
    if (save && !state.restoring) localStorage.setItem('shadow', JSON.stringify({ on: toggle.checked, softness: Number(soft.value) }));
  };
  try {
    const p = JSON.parse(localStorage.getItem('shadow') || '{}');
    if (typeof p.on === 'boolean') toggle.checked = p.on;
    if (Number.isFinite(p.softness)) soft.value = String(p.softness);
  } catch { /* ignore broken prefs */ }
  toggle.addEventListener('change', () => apply(true));
  soft.addEventListener('input', () => apply(true));
  soft.addEventListener('dblclick', () => { soft.value = '25'; apply(true); });
  window.__setShadowTest = (on, softness) => { toggle.checked = on; if (softness != null) soft.value = String(softness); apply(false); };
  apply(false);
}
{
  // light direction: viewport gizmo + persisted direction
  const gizmo = $('flag-light-gizmo');
  try {
    const d = JSON.parse(localStorage.getItem('lightDir') || 'null');
    if (Array.isArray(d) && d.length === 3) viewer.setLightDirection(d);
  } catch { /* ignore broken prefs */ }
  viewer.onLightDirection = (d) => localStorage.setItem('lightDir', JSON.stringify(d));
  gizmo.addEventListener('change', () => viewer.setLightGizmo(gizmo.checked));
  $('btn-light-reset').addEventListener('click', () => viewer.resetLightDirection());
  const spaceBtn = $('btn-light-space');
  const setSpace = (space) => {
    viewer.setLightGizmoSpace(space);
    spaceBtn.textContent = space === 'world' ? 'World' : 'Local';
    localStorage.setItem('lightGizmoSpace', space);
  };
  spaceBtn.addEventListener('click', () => setSpace(viewer.lightControls.space === 'world' ? 'local' : 'world'));
  setSpace(localStorage.getItem('lightGizmoSpace') === 'world' ? 'world' : 'local');
  window.__viewer = viewer;
  window.__setGizmoTest = (dir) => { gizmo.checked = true; viewer.setLightGizmo(true); if (dir) viewer.setLightDirection(dir); };
}
window.addEventListener('keydown', (ev) => {
  // checkboxes / sliders keep focus after a click but are not text entry; ev.code works with a Korean IME too
  const el = document.activeElement;
  const typing = !!el && (/^(SELECT|TEXTAREA)$/.test(el.tagName) || (el.tagName === 'INPUT' && !/^(checkbox|range|button)$/.test(el.type)));
  const plain = !typing && !ev.ctrlKey && !ev.altKey && !ev.metaKey && !document.querySelector('dialog[open]');
  if ((ev.ctrlKey || ev.metaKey) && ev.code === 'KeyS') { ev.preventDefault(); saveWorkspace(ev.shiftKey); }
  else if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && ev.code === 'KeyO') { ev.preventDefault(); openWorkspace(); }
  else if (ev.ctrlKey && ev.code === 'KeyO') { ev.preventDefault(); $('btn-open').click(); }
  else if (ev.ctrlKey && ev.code === 'KeyE') { ev.preventDefault(); if (!$('btn-convert').disabled) $('btn-convert').click(); }
  else if (plain && ev.code === 'KeyF') viewer.frame();
  else if (plain && ev.code === 'KeyW' && $('flag-light-gizmo').checked) viewer.setLightGizmoMode('translate');
  else if (plain && ev.code === 'KeyE' && $('flag-light-gizmo').checked) viewer.setLightGizmoMode('rotate');
  else if (plain && ev.code === 'KeyX' && $('flag-light-gizmo').checked) $('btn-light-space').click();
});

// drag & drop
const viewport = $('viewport');
window.addEventListener('dragover', (ev) => { ev.preventDefault(); viewport.classList.add('dragover'); });
window.addEventListener('dragleave', (ev) => { if (!ev.relatedTarget) viewport.classList.remove('dragover'); });
window.addEventListener('drop', (ev) => {
  ev.preventDefault();
  viewport.classList.remove('dragover');
  const file = ev.dataTransfer?.files?.[0];
  if (file) openPath(api.pathForFile(file));
});

// ---------------- convert dialog ----------------
const dialog = $('convert-dialog');
const options = () => ({
  scale: Number($('opt-scale').value),
  nameMode: $('opt-names').value,
  morphs: $('opt-morphs').checked,
  copyTextures: $('opt-copy').checked,
  asciiNames: $('opt-ascii').checked,
});

function saveDialogPrefs() {
  localStorage.setItem('convertPrefs', JSON.stringify({ format: $('opt-format').value, ...options(), recursive: $('opt-recursive').checked }));
}
function loadDialogPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem('convertPrefs') || '{}');
    if (p.format) $('opt-format').value = p.format;
    if (p.scale) $('opt-scale').value = String(p.scale);
    if (p.nameMode) $('opt-names').value = p.nameMode;
    if (typeof p.morphs === 'boolean') $('opt-morphs').checked = p.morphs;
    if (typeof p.copyTextures === 'boolean') $('opt-copy').checked = p.copyTextures;
    if (typeof p.asciiNames === 'boolean') $('opt-ascii').checked = p.asciiNames;
    if (typeof p.recursive === 'boolean') $('opt-recursive').checked = p.recursive;
  } catch { /* ignore broken prefs */ }
}

function syncDialog() {
  const format = $('opt-format').value;
  $('row-ascii').hidden = format === 'fbx';
  $('row-copy').hidden = format === 'usdz';
  if (state.dialogMode === 'single') {
    const cur = $('opt-output').value;
    const base = cur ? stripExt(cur) : stripExt(state.loadedPath);
    $('opt-output').value = base + state.formats[format].ext;
  }
}

function openDialog(mode) {
  if (state.workspaceBusy || state.modelLoading) return;
  const source = mode === 'single' ? state.loadedPath : state.dir;
  if (mode !== state.dialogMode || source !== state.conversionSource) $('opt-output').value = '';
  state.conversionSource = source;
  state.dialogMode = mode;
  state.lastOutput = null;
  $('convert-result').hidden = true;
  $('btn-reveal').hidden = true;
  $('btn-run').disabled = false;
  $('row-recursive').hidden = mode !== 'batch';
  if (mode === 'single') {
    $('convert-title').textContent = t('PMX 변환');
    $('convert-source').textContent = state.loadedPath;
    $('label-output').textContent = t('저장 위치');
  } else {
    $('convert-title').textContent = t('폴더 일괄 변환');
    $('convert-source').textContent = t`${state.dir} 의 모든 PMX`;
    $('label-output').textContent = t('출력 폴더 (비워 두면 각 PMX와 같은 폴더)');
  }
  syncDialog();
  dialog.showModal();
}

$('btn-convert').addEventListener('click', () => openDialog('single'));
$('btn-batch').addEventListener('click', () => { if (state.dir) openDialog('batch'); });
$('opt-format').addEventListener('change', syncDialog);
$('btn-cancel').addEventListener('click', () => { if (!state.busy) dialog.close(); });
dialog.addEventListener('cancel', (ev) => { if (state.busy) ev.preventDefault(); });
$('btn-output').addEventListener('click', async () => {
  if (state.dialogMode === 'single') {
    const p = await api.saveFile($('opt-output').value, $('opt-format').value);
    if (p) $('opt-output').value = p;
  } else {
    const p = await api.pickFolder($('opt-output').value || state.dir);
    if (p) $('opt-output').value = p;
  }
});
$('btn-reveal').addEventListener('click', () => { if (state.lastOutput) api.reveal(state.lastOutput); });

function resultLines(r) {
  const s = r.stats;
  const lines = [
    el('div', { className: 'ok', textContent: `✔ ${r.output} (${fmtSize(r.size)})` }),
    el('div', { textContent: t`정점 ${fmtNum(s.vertices)} · 삼각형 ${fmtNum(s.triangles)} · 재질 ${s.materials} · 본 ${s.bones} · 모프 ${s.morphs} · 텍스처 ${s.textures}${s.missingTextures ? t` (누락 ${s.missingTextures})` : ''}` }),
  ];
  for (const w of r.warnings) lines.push(el('div', { className: 'warn', textContent: `⚠ ${w}` }));
  return lines;
}

api.onConvertProgress((p) => {
  const box = $('convert-result');
  box.hidden = false;
  box.replaceChildren(el('div', { textContent: t`변환 중 ${p.index + 1} / ${p.total} — ${basename(p.file)}` }));
});

$('btn-run').addEventListener('click', async () => {
  if (state.busy) return;
  const format = $('opt-format').value;
  const box = $('convert-result');
  const output = $('opt-output').value.trim();
  if (state.dialogMode === 'single' && !output) { box.hidden = false; box.replaceChildren(el('div', { className: 'err', textContent: t('저장 위치를 입력하세요.') })); return; }
  saveDialogPrefs();
  state.busy = true;
  updateWorkspaceBar();
  $('btn-run').disabled = true;
  $('btn-cancel').disabled = true;
  box.hidden = false;
  box.replaceChildren(el('div', { textContent: t('변환 중…') }));
  try {
    if (state.dialogMode === 'single') {
      const r = await api.convertFile(state.loadedPath, output, { ...options(), format });
      box.replaceChildren(...resultLines(r));
      state.lastOutput = r.output;
      setStatus(t`변환 완료: ${r.output}`, 'ok');
    } else {
      const results = await api.convertBatch(state.dir, output || null, format, $('opt-recursive').checked, options());
      const ok = results.filter((r) => r.ok);
      const lines = [el('div', { className: results.length && ok.length === results.length ? 'ok' : 'warn', textContent: results.length ? t`${ok.length} / ${results.length}개 변환 완료` : t('이 폴더에는 PMX 파일이 없습니다.') })];
      for (const r of results) {
        if (r.ok) {
          lines.push(el('div', { textContent: `✔ ${basename(r.output)} (${fmtSize(r.size)})${r.stats.missingTextures ? t` — 텍스처 누락 ${r.stats.missingTextures}` : ''}` }));
        } else {
          lines.push(el('div', { className: 'err', textContent: `✘ ${basename(r.input)} — ${r.error}` }));
        }
      }
      box.replaceChildren(...lines);
      state.lastOutput = ok.length ? ok[0].output : null;
      setStatus(t`일괄 변환: ${ok.length} / ${results.length}개 완료`, ok.length === results.length ? 'ok' : 'error');
    }
    $('btn-reveal').hidden = !state.lastOutput;
    if (state.dir) navigate(state.dir); // show new files in the browser
  } catch (e) {
    box.replaceChildren(el('div', { className: 'err', textContent: t`✘ 변환 실패 — ${e.message}` }));
    setStatus(t`변환 실패: ${e.message}`, 'error');
  } finally {
    state.busy = false;
    updateWorkspaceBar();
    $('btn-run').disabled = false;
    $('btn-cancel').disabled = false;
  }
});

// ---------------- workspace ----------------
function updateWorkspaceBar() {
  const unavailable = state.workspaceBusy || state.modelLoading || state.busy;
  for (const id of ['workspace-open', 'workspace-save', 'workspace-save-as']) $(id).disabled = unavailable;
  $('workspace-name').textContent = state.workspacePath ? basename(state.workspacePath) : t('저장되지 않은 작업');
  $('workspace-name').title = state.workspacePath || t('폴더·모델·뷰포트·변환 설정을 .canvas 파일로 저장합니다.');
}

async function saveWorkspace(saveAs = false) {
  if (state.workspaceBusy || state.modelLoading || state.busy) return;
  state.workspaceBusy = true; updateWorkspaceBar();
  try {
    const result = await api.saveWorkspace(captureWorkspace(viewer, state, materialPanel), state.workspacePath, saveAs);
    if (!result) return;
    state.workspacePath = result.filePath;
    setStatus(t`워크스페이스 저장 완료: ${result.filePath}`, 'ok');
    if (state.dir) await navigate(state.dir, basename(result.filePath));
  } catch (error) { setStatus(t`워크스페이스 저장 실패: ${error.message}`, 'error'); }
  finally { state.workspaceBusy = false; updateWorkspaceBar(); }
}

async function openWorkspace(filePath = null) {
  if (state.workspaceBusy || state.modelLoading || state.busy) return;
  state.workspaceBusy = true; updateWorkspaceBar();
  try {
    const result = await api.openWorkspace(filePath);
    if (!result) return;
    const { data } = result;
    if (data.model && !await openModel(data.model.path, true)) return;
    if (!data.model) {
      viewer.clear(); state.loadedPath = null; state.loadedInfo = null;
      $('info').replaceChildren(el('div', { className: 'muted', textContent: t('열린 모델이 없습니다.') }));
      $('panel-warnings').hidden = true; $('panel-morphs').hidden = true;
      $('morphs').replaceChildren(); $('btn-convert').disabled = true;
      $('empty-hint').hidden = false; $('viewport-error').hidden = true;
      materialPanel.load();
    }
    $('filter-input').value = data.browser.filter; $('only-3d').checked = data.browser.only3d;
    let directory = data.browser.directory;
    if (!directory || !(await api.stat(directory).catch(() => null))?.isDir) directory = data.model ? dirname(data.model.path) : dirname(result.filePath);
    await navigate(directory, data.model ? basename(data.model.path) : null);
    let changed;
    state.restoring = true; // controls are driven through their own events; keep those out of the saved defaults
    try { changed = restoreWorkspaceState(data, viewer, state, materialPanel, applyRenderMode, applyOutline); }
    finally { state.restoring = false; reportMenuState(); }
    $('convert-dialog').close(); $('convert-result').hidden = true; state.lastOutput = null;
    state.workspacePath = result.filePath;
    document.title = `${basename(result.filePath)} — MMD Canvas`;
    setStatus(t`워크스페이스 열기 완료: ${result.filePath}${changed ? t(' · 모델 구성이 달라 재질·모프 상태 일부를 생략했습니다.') : ''}`, 'ok');
  } catch (error) { setStatus(t`워크스페이스 열기 실패: ${error.message}`, 'error'); }
  finally { state.workspaceBusy = false; updateWorkspaceBar(); }
}
$('workspace-open').addEventListener('click', () => openWorkspace());
$('workspace-save').addEventListener('click', () => saveWorkspace());
$('workspace-save-as').addEventListener('click', () => saveWorkspace(true));
api.onOpenFile((filePath) => openPath(filePath));
// ---------------- application menu ----------------
const MENU_FLAGS = ['flag-grid', 'flag-skeleton', 'flag-wireframe', 'flag-shadow', 'flag-light-gizmo'];
function reportMenuState() {
  const menuState = Object.fromEntries(MENU_FLAGS.map((id) => [id, $(id).checked]));
  menuState['mode-lambert'] = viewer.renderMode !== 'toon';
  menuState['mode-toon'] = viewer.renderMode === 'toon';
  api.menuState(menuState);
}
for (const id of MENU_FLAGS) $(id).addEventListener('change', reportMenuState);
document.querySelectorAll('.viewport-mode').forEach((button) => button.addEventListener('click', reportMenuState));
api.onMenuCommand((command) => {
  const [kind, target] = command.split(':');
  if (command === 'open-file') $('btn-open').click();
  else if (command === 'workspace-open') openWorkspace();
  else if (command === 'workspace-save') saveWorkspace();
  else if (command === 'workspace-save-as') saveWorkspace(true);
  else if (command === 'convert') { if (!$('btn-convert').disabled) $('btn-convert').click(); }
  else if (command === 'batch') $('btn-batch').click();
  else if (command === 'frame') viewer.frame();
  else if (command === 'light-reset') $('btn-light-reset').click();
  else if (kind === 'mode') $(`mode-${target}`).click();
  else if (kind === 'toggle' && MENU_FLAGS.includes(target)) {
    $(target).checked = !$(target).checked;
    $(target).dispatchEvent(new Event('change'));
  }
  reportMenuState();
});
reportMenuState();


// ---------------- startup ----------------
(async () => {
  const start = startup;
  state.formats = start.formats;
  loadDialogPrefs();
  const drives = await api.drives().catch(() => []);
  $('drives').replaceChildren(...drives.map((d) => {
    const b = el('button', { textContent: d.replace(/\\$/, ''), title: d });
    b.addEventListener('click', () => navigate(d));
    return b;
  }));
  if (start.testShadow) window.__setShadowTest(start.testShadow !== 'off', start.testShadow === 'off' ? null : Number(start.testShadow));
  if (start.testGizmo) window.__setGizmoTest(start.testGizmo === '1' ? null : start.testGizmo.split(',').map(Number));
  if (start.openFile) {
    await openPath(start.openFile);
    if (start.testConvert && state.loadedInfo?.kind === 'pmx') { // automated UI test hook
      openDialog('single');
      $('opt-format').value = start.testConvert.format; syncDialog();
      $('opt-output').value = start.testConvert.output;
      $('btn-run').click();
    }
    return;
  }
  const last = localStorage.getItem('lastDir');
  await navigate(last || start.home);
  if (!state.dir) await navigate(start.home);
})();
