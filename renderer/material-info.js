// Keep materials distinct by identity: different materials often share a name.
export function collectMaterials(object) {
  const entries = [], byMaterial = new Map();
  object.traverse((o) => {
    if (!o.material) return;
    const materials = Array.isArray(o.material) ? o.material : [o.material];
    materials.forEach((material, slot) => {
      if (!material) return;
      let entry = byMaterial.get(material);
      if (!entry) {
        entry = { material, name: material.name || '(이름 없음)', usages: [], triangles: 0 };
        byMaterial.set(material, entry);
        entries.push(entry);
      }
      const g = o.geometry;
      let count = 0;
      if (o.isMesh && g) {
        const total = g.index?.count ?? g.attributes.position?.count ?? 0;
        const start = Math.max(0, g.drawRange.start), end = Math.min(total, start + g.drawRange.count);
        const ranges = Array.isArray(o.material) ? g.groups.filter((group) => group.materialIndex === slot) : [{ start: 0, count: total }];
        count = ranges.reduce((sum, range) => sum + Math.floor(Math.max(0, Math.min(end, range.start + range.count) - Math.max(start, range.start)) / 3), 0);
        if (o.isInstancedMesh) count *= o.count;
      }
      entry.triangles += count;
      entry.usages.push({ name: o.name || '(이름 없는 오브젝트)', slot, triangles: count, type: o.type });
    });
  });
  return entries;
}

export const TEXTURE_SLOTS = {
  map: '베이스 컬러', normalMap: '노멀', roughnessMap: '거칠기', metalnessMap: '금속성',
  emissiveMap: '발광', alphaMap: '불투명도', aoMap: '앰비언트 오클루전', bumpMap: '범프',
  displacementMap: '변위', lightMap: '라이트맵', specularMap: '스페큘러', envMap: '환경',
  clearcoatMap: '클리어코트', clearcoatNormalMap: '코트 노멀', clearcoatRoughnessMap: '코트 거칠기',
  transmissionMap: '투과', thicknessMap: '두께', specularColorMap: '스페큘러 색상',
  specularIntensityMap: '스페큘러 강도', sheenColorMap: '시인 색상', sheenRoughnessMap: '시인 거칠기',
};

export function textureInfo(texture) {
  const source = texture.image;
  const image = Array.isArray(source) ? source[0] : source;
  return {
    image,
    width: image?.naturalWidth || image?.videoWidth || image?.width || 0,
    height: image?.naturalHeight || image?.videoHeight || image?.height || 0,
    path: texture.userData.sourcePath || image?.currentSrc || image?.src || texture.name || '모델에 포함된 텍스처',
    status: texture.userData.loadStatus || (image ? 'loaded' : 'pending'),
  };
}
