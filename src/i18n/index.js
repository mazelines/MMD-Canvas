import { messages } from './messages.js';

export function resolveLanguage(locale) {
  const base = String(locale || '').toLowerCase().split(/[-_]/)[0];
  return ['ko', 'en', 'zh', 'ja'].includes(base) ? base : 'en';
}
let language = resolveLanguage(Intl.DateTimeFormat().resolvedOptions().locale);
export const getLanguage = () => language;
export function setLanguage(locale) { language = resolveLanguage(locale); return language; }
export const formatNumber = (value) => Number(value).toLocaleString(language === 'zh' ? 'zh-CN' : language);

/** Accepts a source label or a tagged template; interpolated file/model names remain untouched. */
export function t(source, ...values) {
  const key = Array.isArray(source) ? source.reduce((text, part, index) => text + (index ? `{${index - 1}}` : '') + part, '') : source;
  const translated = language === 'ko' ? key : messages[key]?.[['en', 'zh', 'ja'].indexOf(language)] || messages[key]?.[0] || key;
  return String(translated).replace(/\{(\d+)\}/g, (match, index) => Number(index) < values.length ? String(values[index]) : match);
}

/** Run once on the static app shell, before user-controlled names are inserted. */
export function translateStatic(root) {
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : language;
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walk.nextNode()) {
    const current = walk.currentNode;
    if (['SCRIPT', 'STYLE'].includes(current.parentElement?.tagName)) continue;
    const key = current.nodeValue.trim();
    if (messages[key]) current.nodeValue = current.nodeValue.replace(key, t(key));
  }
  for (const element of root.querySelectorAll('*')) {
    for (const attribute of ['title', 'placeholder', 'aria-label']) {
      const key = element.getAttribute(attribute);
      if (key && messages[key]) element.setAttribute(attribute, t(key));
    }
  }
}
