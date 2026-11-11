import { t, formatNumber } from '../src/i18n/index.js';
import { TEXTURE_SLOTS, textureInfo } from './material-info.js';
import { MAX_EMISSIVE_NITS } from '../src/core/lighting.js';

const node = (tag, props = {}, ...children) => {
  const element = Object.assign(document.createElement(tag), props);
  element.append(...children);
  return element;
};
const number = (value) => Number.isInteger(value) ? formatNumber(value) : Number(value.toFixed(3)).toString();
const yes = (value) => value ? t('사용') : t('사용 안 함');

export class MaterialPanel {
  constructor(viewer) {
    this.viewer = viewer;
    this.selected = 0;
    this.entries = [];
    this.savedVisibility = null;
    this.$ = (id) => document.getElementById(id);
    this.$('material-search').addEventListener('input', () => this.renderList());
    this.$('material-solo').addEventListener('click', () => this.toggleSolo());
    this.$('material-show-all').addEventListener('click', () => {
      this.savedVisibility = null;
      this.entries.forEach((_, i) => viewer.setMaterialVisible(i, true));
      this.renderList(); this.renderDetail();
    });
    this.$('texture-close').addEventListener('click', () => this.$('texture-dialog').close());
    viewer.onMaterialsChanged = () => this.renderDetail();
    this.load();
  }

  load() {
    this.entries = this.viewer.current?.materials || [];
    this.selected = 0;
    this.savedVisibility = null;
    this.$('material-search').value = '';
    this.$('material-tab-count').textContent = this.entries.length;
    this.$('texture-dialog').close();
    this.renderList(); this.renderDetail();
  }

  toggleSolo() {
    if (this.savedVisibility) {
      this.savedVisibility.forEach((visible, i) => this.viewer.setMaterialVisible(i, visible));
      this.savedVisibility = null;
    } else {
      this.savedVisibility = this.entries.map((entry) => entry.material.visible);
      this.entries.forEach((_, i) => this.viewer.setMaterialVisible(i, i === this.selected));
    }
    this.renderList(); this.renderDetail();
  }

  renderList() {
    const query = this.$('material-search').value.trim().toLocaleLowerCase();
    const list = this.$('materials');
    list.replaceChildren();
    let matches = 0;
    this.entries.forEach((entry, i) => {
      if (!`${entry.name} ${entry.material.type} ${entry.usages.map((u) => u.name).join(' ')}`.toLocaleLowerCase().includes(query)) return;
      matches++;
      const checkbox = node('input', { type: 'checkbox', checked: entry.material.visible, disabled: !!this.savedVisibility });
      checkbox.setAttribute('aria-label', t`${entry.name} 표시`);
      checkbox.addEventListener('change', () => { this.viewer.setMaterialVisible(i, checkbox.checked); this.renderDetail(); });
      const swatch = node('span', { className: 'material-swatch' });
      swatch.style.backgroundColor = entry.material.color ? `#${entry.material.color.getHexString()}` : '#777777';
      const button = node('button', { className: 'material-select', title: entry.name }, swatch,
        node('span', { className: 'material-label' }, node('strong', { textContent: entry.name }),
          node('small', { textContent: t`${entry.material.type.replace(/^Mesh|Material$/g, '')} · 삼각형 ${number(entry.triangles)}` })),
        node('span', { className: 'material-index', textContent: String(i + 1).padStart(2, '0') }));
      button.setAttribute('aria-pressed', String(i === this.selected));
      button.addEventListener('click', () => {
        this.selected = i;
        if (this.savedVisibility) this.entries.forEach((_, j) => this.viewer.setMaterialVisible(j, j === i));
        this.renderList(); this.renderDetail();
        this.$('materials').querySelector(`[data-index="${i}"] button`)?.focus();
      });
      const row = node('li', { className: i === this.selected ? 'active' : '' }, checkbox, button);
      row.dataset.index = i;
      list.append(row);
    });
    if (!matches) list.append(node('li', { className: 'material-empty', textContent: this.entries.length ? t('검색 결과가 없습니다.') : t('모델을 열면 재질이 표시됩니다.') }));
    this.$('material-results').textContent = t`${matches} / ${this.entries.length}개`;
    this.$('material-show-all').disabled = !this.entries.length;
  }

  renderDetail() {
    const host = this.$('material-detail');
    host.replaceChildren();
    const entry = this.entries[this.selected];
    this.$('material-solo').disabled = !entry;
    this.$('material-solo').textContent = this.savedVisibility ? t('단독 보기 해제') : t('선택만 보기');
    this.$('material-solo').setAttribute('aria-pressed', String(!!this.savedVisibility));
    if (!entry) return;
    const m = entry.material;
    host.append(node('div', { className: 'material-heading' }, node('h3', { textContent: entry.name }),
      node('span', { className: 'material-badge', textContent: m.visible ? t('표시 중') : t('숨김') })),
      node('div', { className: 'material-type', textContent: t`${m.type} · 뷰포트 ${this.viewer.renderMode === 'toon' ? 'Toon' : 'Lambert'}` }));
    const section = (title) => {
      const block = node('section', { className: 'material-section' }, node('h4', { textContent: title }));
      host.append(block);
      return block;
    };
    const properties = section(t('표면 속성'));
    const grid = node('dl', { className: 'info-grid material-properties' });
    properties.append(grid);
    const row = (label, value) => grid.append(node('dt', { textContent: label }), node('dd', {}, value));
    for (const [key, label] of [['color', t('베이스 컬러')], ['emissive', t('발광 색상')], ['specular', t('스페큘러')]]) {
      if (!m[key]?.isColor) continue;
      const color = `#${m[key].getHexString().toUpperCase()}`;
      const swatch = node('span', { className: 'property-swatch' });
      swatch.style.backgroundColor = color;
      row(label, node('span', { className: 'color-value' }, swatch, color));
    }
    for (const [key, label] of [['opacity', t('불투명도')], ['roughness', t('거칠기')], ['metalness', t('금속성')], ['shininess', t('광택')], ['emissiveIntensity', t('원본 발광 배율')], ['ior', t('굴절률')], ['transmission', t('투과')], ['clearcoat', t('클리어코트')], ['alphaTest', t('알파 컷오프')]]) {
      if (typeof m[key] === 'number') row(label, number(m[key]));
    }
    const emission = this.viewer.getMaterialEmission(this.selected);
    if (emission) {
      const selected = this.selected;
      const input = node('input', { id: 'material-emissive-nits', type: 'number', min: '0', max: String(MAX_EMISSIVE_NITS), step: '0.1', value: String(emission.nits),
        title: t('흰색 발광 기준 휘도입니다. 실제 휘도는 발광 색상과 텍스처에 따라 달라집니다.') });
      input.setAttribute('aria-label', t('발광 기준 휘도 (cd/m²)'));
      const reset = node('button', { id: 'material-emissive-reset', textContent: '↺', title: t('원본 발광 설정 복원'), disabled: emission.override === null });
      input.addEventListener('input', () => {
        if (!Number.isFinite(input.valueAsNumber)) return;
        this.viewer.setMaterialEmission(selected, input.valueAsNumber);
        reset.disabled = false; // the field itself is normalised on blur, not while typing
      });
      input.addEventListener('blur', () => { input.value = String(this.viewer.getMaterialEmission(selected).nits); });
      reset.addEventListener('click', () => { this.viewer.setMaterialEmission(selected, null); this.renderDetail(); });
      row(t('발광 기준 휘도'), node('span', { className: 'emission-control' }, input, node('span', { textContent: 'cd/m²' }), reset));
    }
    row(t('투명 처리'), yes(m.transparent));
    row(t('면 표시'), [t('앞면'), t('뒷면'), t('양면')][m.side] || String(m.side));
    row(t('깊이 쓰기'), yes(m.depthWrite));
    row(t('정점 색상'), yes(m.vertexColors));

    const textures = section(t('텍스처'));
    const maps = Object.keys(m).filter((key) => m[key]?.isTexture).map((key) => [key, t(TEXTURE_SLOTS[key] || key)]);
    if (!maps.length) textures.append(node('p', { className: 'muted', textContent: t('연결된 텍스처가 없습니다.') }));
    for (const [key, label] of maps) {
      const texture = m[key], info = textureInfo(texture);
      const preview = this.preview(texture, 72);
      const thumb = node('button', { className: 'texture-thumb', title: t`${label} 크게 보기`, disabled: !preview },
        preview || node('span', { textContent: info.status === 'error' ? t('실패') : info.status === 'pending' ? t('로딩…') : t('미리보기 없음') }));
      thumb.addEventListener('click', () => {
        const large = this.preview(texture, 1024);
        this.$('texture-title').textContent = `${entry.name} · ${label}`;
        this.$('texture-meta').textContent = `${path} · ${info.width} × ${info.height}`;
        this.$('texture-preview').replaceChildren(...(large ? [large] : []));
        this.$('texture-dialog').showModal();
      });
      let path = info.path;
      if (/^(blob:|data:)/.test(path)) path = texture.name ? t`내장 텍스처 · ${texture.name}` : t('모델에 포함된 텍스처');
      else if (path.startsWith('app://fs/')) {
        try { path = decodeURIComponent(path.slice(9)); } catch { /* preserve undecodable source */ }
      }
      const caption = node('div', { className: 'texture-caption' }, node('strong', { textContent: label }),
        node('span', { className: 'texture-path', textContent: path, title: path }),
        node('small', { textContent: info.status === 'error' ? t('텍스처를 불러오지 못했습니다.') : info.width ? `${info.width} × ${info.height} · ${texture.colorSpace || t('선형 / 데이터')} · UV ${texture.channel}` : t('이미지 로딩 중…') }),
        node('small', { textContent: t`반복 ${number(texture.repeat.x)}, ${number(texture.repeat.y)} · 오프셋 ${number(texture.offset.x)}, ${number(texture.offset.y)}` }));
      textures.append(node('div', { className: `texture-card${info.status === 'error' ? ' texture-error' : ''}` }, thumb, caption));
    }

    const usage = section(t('사용 현황'));
    usage.append(node('p', { className: 'usage-summary', textContent: t`${entry.usages.length}개 슬롯 · 삼각형 ${number(entry.triangles)}` }));
    const usages = node('ul', { className: 'material-usages' });
    for (const u of entry.usages) usages.append(node('li', {}, node('span', { textContent: u.name, title: u.name }), node('small', { textContent: t`슬롯 ${u.slot} · ${number(u.triangles)} tris` })));
    usage.append(usages);

    if (m.userData.pmx) {
      const pmx = m.userData.pmx;
      const source = section(t('PMX 원본 정보'));
      source.append(node('p', { className: 'muted', textContent: t('파일에 기록된 값입니다. 뷰어의 표면 속성과 다를 수 있습니다.') }));
      const original = node('dl', { className: 'info-grid material-properties' });
      const add = (key, value) => original.append(node('dt', { textContent: key }), node('dd', { textContent: value }));
      if (pmx.nameEn) add(t('영문 이름'), pmx.nameEn);
      add('Diffuse RGBA', pmx.diffuse.map(number).join(', '));
      add('Ambient RGB', pmx.ambient.map(number).join(', '));
      add('Specular RGB', pmx.specular.map(number).join(', '));
      add(t('광택'), number(pmx.shininess));
      add(t('윤곽선'), pmx.hasEdge ? t`사용 · 두께 ${number(pmx.edgeSize)}` : t('사용 안 함'));
      add(t('스피어 맵'), m.userData.pmxTextures.sphere || t('없음'));
      add(t('스피어 모드'), [t('사용 안 함'), t('곱하기'), t('더하기'), t('서브 텍스처')][pmx.sphereMode] || String(pmx.sphereMode));
      add(t('툰 맵'), pmx.sharedToon ? t`공유 toon${String(pmx.toonIndex + 1).padStart(2, '0')}` : m.userData.pmxTextures.toon || t('없음'));
      source.append(original, node('p', { className: 'muted', textContent: t('스피어·툰 맵은 현재 뷰어에 적용되지 않습니다.') }));
      if (pmx.memo) source.append(node('p', { className: 'material-memo', textContent: pmx.memo }));
    }
  }

  preview(texture, maxSize) {
    const info = textureInfo(texture);
    if (!info.width || !info.height || texture.isCompressedTexture || Array.isArray(texture.image)) return null;
    const scale = Math.min(1, maxSize / Math.max(info.width, info.height));
    const canvas = node('canvas', { width: Math.max(1, Math.round(info.width * scale)), height: Math.max(1, Math.round(info.height * scale)) });
    try {
      let image = info.image;
      // TGA and other byte-based data textures have pixels rather than an HTML image.
      if (texture.isDataTexture) {
        const data = image.data, pixels = info.width * info.height;
        if (!(data instanceof Uint8Array) || data.length !== pixels * 4 || pixels > 16777216) return null;
        const source = node('canvas', { width: info.width, height: info.height });
        source.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data), info.width, info.height), 0, 0);
        image = source;
      }
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      return canvas;
    }
    catch { return null; }
  }
}
