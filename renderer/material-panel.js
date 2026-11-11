import { TEXTURE_SLOTS, textureInfo } from './material-info.js';

const node = (tag, props = {}, ...children) => {
  const element = Object.assign(document.createElement(tag), props);
  element.append(...children);
  return element;
};
const number = (value) => Number.isInteger(value) ? value.toLocaleString('ko-KR') : Number(value.toFixed(3)).toString();
const yes = (value) => value ? '사용' : '사용 안 함';

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
      checkbox.setAttribute('aria-label', `${entry.name} 표시`);
      checkbox.addEventListener('change', () => { this.viewer.setMaterialVisible(i, checkbox.checked); this.renderDetail(); });
      const swatch = node('span', { className: 'material-swatch' });
      swatch.style.backgroundColor = entry.material.color ? `#${entry.material.color.getHexString()}` : '#777777';
      const button = node('button', { className: 'material-select', title: entry.name }, swatch,
        node('span', { className: 'material-label' }, node('strong', { textContent: entry.name }),
          node('small', { textContent: `${entry.material.type.replace(/^Mesh|Material$/g, '')} · 삼각형 ${number(entry.triangles)}` })),
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
    if (!matches) list.append(node('li', { className: 'material-empty', textContent: this.entries.length ? '검색 결과가 없습니다.' : '모델을 열면 재질이 표시됩니다.' }));
    this.$('material-results').textContent = `${matches} / ${this.entries.length}개`;
    this.$('material-show-all').disabled = !this.entries.length;
  }

  renderDetail() {
    const host = this.$('material-detail');
    host.replaceChildren();
    const entry = this.entries[this.selected];
    this.$('material-solo').disabled = !entry;
    this.$('material-solo').textContent = this.savedVisibility ? '단독 보기 해제' : '선택만 보기';
    this.$('material-solo').setAttribute('aria-pressed', String(!!this.savedVisibility));
    if (!entry) return;
    const m = entry.material;
    host.append(node('div', { className: 'material-heading' }, node('h3', { textContent: entry.name }),
      node('span', { className: 'material-badge', textContent: m.visible ? '표시 중' : '숨김' })),
      node('div', { className: 'material-type', textContent: `${m.type} · 뷰포트 ${this.viewer.renderMode === 'toon' ? 'Toon' : 'Lambert'}` }));
    const section = (title) => {
      const block = node('section', { className: 'material-section' }, node('h4', { textContent: title }));
      host.append(block);
      return block;
    };
    const properties = section('표면 속성');
    const grid = node('dl', { className: 'info-grid material-properties' });
    properties.append(grid);
    const row = (label, value) => grid.append(node('dt', { textContent: label }), node('dd', {}, value));
    for (const [key, label] of [['color', '베이스 컬러'], ['emissive', '발광 색상'], ['specular', '스페큘러']]) {
      if (!m[key]?.isColor) continue;
      const color = `#${m[key].getHexString().toUpperCase()}`;
      const swatch = node('span', { className: 'property-swatch' });
      swatch.style.backgroundColor = color;
      row(label, node('span', { className: 'color-value' }, swatch, color));
    }
    for (const [key, label] of [['opacity', '불투명도'], ['roughness', '거칠기'], ['metalness', '금속성'], ['shininess', '광택'], ['emissiveIntensity', '발광 강도'], ['ior', '굴절률'], ['transmission', '투과'], ['clearcoat', '클리어코트'], ['alphaTest', '알파 컷오프']]) {
      if (typeof m[key] === 'number') row(label, number(m[key]));
    }
    row('투명 처리', yes(m.transparent));
    row('면 표시', ['앞면', '뒷면', '양면'][m.side] || String(m.side));
    row('깊이 쓰기', yes(m.depthWrite));
    row('정점 색상', yes(m.vertexColors));

    const textures = section('텍스처');
    const maps = Object.keys(m).filter((key) => m[key]?.isTexture).map((key) => [key, TEXTURE_SLOTS[key] || key]);
    if (!maps.length) textures.append(node('p', { className: 'muted', textContent: '연결된 텍스처가 없습니다.' }));
    for (const [key, label] of maps) {
      const texture = m[key], info = textureInfo(texture);
      const preview = this.preview(texture, 72);
      const thumb = node('button', { className: 'texture-thumb', title: `${label} 크게 보기`, disabled: !preview },
        preview || node('span', { textContent: info.status === 'error' ? '실패' : info.status === 'pending' ? '로딩…' : '미리보기 없음' }));
      thumb.addEventListener('click', () => {
        const large = this.preview(texture, 1024);
        this.$('texture-title').textContent = `${entry.name} · ${label}`;
        this.$('texture-meta').textContent = `${path} · ${info.width} × ${info.height}`;
        this.$('texture-preview').replaceChildren(...(large ? [large] : []));
        this.$('texture-dialog').showModal();
      });
      let path = info.path;
      if (/^(blob:|data:)/.test(path)) path = texture.name ? `내장 텍스처 · ${texture.name}` : '모델에 포함된 텍스처';
      else if (path.startsWith('app://fs/')) {
        try { path = decodeURIComponent(path.slice(9)); } catch { /* preserve undecodable source */ }
      }
      const caption = node('div', { className: 'texture-caption' }, node('strong', { textContent: label }),
        node('span', { className: 'texture-path', textContent: path, title: path }),
        node('small', { textContent: info.status === 'error' ? '텍스처를 불러오지 못했습니다.' : info.width ? `${info.width} × ${info.height} · ${texture.colorSpace || '선형 / 데이터'} · UV ${texture.channel}` : '이미지 로딩 중…' }),
        node('small', { textContent: `반복 ${number(texture.repeat.x)}, ${number(texture.repeat.y)} · 오프셋 ${number(texture.offset.x)}, ${number(texture.offset.y)}` }));
      textures.append(node('div', { className: `texture-card${info.status === 'error' ? ' texture-error' : ''}` }, thumb, caption));
    }

    const usage = section('사용 현황');
    usage.append(node('p', { className: 'usage-summary', textContent: `${entry.usages.length}개 슬롯 · 삼각형 ${number(entry.triangles)}` }));
    const usages = node('ul', { className: 'material-usages' });
    for (const u of entry.usages) usages.append(node('li', {}, node('span', { textContent: u.name, title: u.name }), node('small', { textContent: `슬롯 ${u.slot} · ${number(u.triangles)} tris` })));
    usage.append(usages);

    if (m.userData.pmx) {
      const pmx = m.userData.pmx;
      const source = section('PMX 원본 정보');
      source.append(node('p', { className: 'muted', textContent: '파일에 기록된 값입니다. 뷰어의 표면 속성과 다를 수 있습니다.' }));
      const original = node('dl', { className: 'info-grid material-properties' });
      const add = (key, value) => original.append(node('dt', { textContent: key }), node('dd', { textContent: value }));
      if (pmx.nameEn) add('영문 이름', pmx.nameEn);
      add('Diffuse RGBA', pmx.diffuse.map(number).join(', '));
      add('Ambient RGB', pmx.ambient.map(number).join(', '));
      add('Specular RGB', pmx.specular.map(number).join(', '));
      add('광택', number(pmx.shininess));
      add('윤곽선', pmx.hasEdge ? `사용 · 두께 ${number(pmx.edgeSize)}` : '사용 안 함');
      add('스피어 맵', m.userData.pmxTextures.sphere || '없음');
      add('스피어 모드', ['사용 안 함', '곱하기', '더하기', '서브 텍스처'][pmx.sphereMode] || String(pmx.sphereMode));
      add('툰 맵', pmx.sharedToon ? `공유 toon${String(pmx.toonIndex + 1).padStart(2, '0')}` : m.userData.pmxTextures.toon || '없음');
      source.append(original, node('p', { className: 'muted', textContent: '스피어·툰 맵은 현재 뷰어에 적용되지 않습니다.' }));
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
