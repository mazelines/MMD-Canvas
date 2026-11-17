// Radius is a percentage of the framed model's bounding-box diagonal.
export const DEFAULT_CORTAO = Object.freeze({ enabled: true, intensity: 1, radius: 2 });

export function normalizeCortao(value = {}) {
  const finite = (key, min, max) => Number.isFinite(value?.[key])
    ? Math.min(max, Math.max(min, value[key])) : DEFAULT_CORTAO[key];
  return {
    enabled: typeof value?.enabled === 'boolean' ? value.enabled : DEFAULT_CORTAO.enabled,
    intensity: finite('intensity', 0, 2),
    radius: finite('radius', 0.1, 10),
  };
}
