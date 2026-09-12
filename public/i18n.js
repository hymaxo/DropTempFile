import { ru } from './translations.js';

const storageKey = 'droptempfile.language';
export function resolveLanguage(preference, languages) {
  if (preference === 'en' || preference === 'ru') return preference;
  for (const tag of languages) {
    const language = tag.toLowerCase().split(/[-_]/)[0];
    if (language === 'en' || language === 'ru') return language;
  }
  return 'en';
}
let preference = 'auto';
try { preference = localStorage.getItem(storageKey) || 'auto'; } catch {}
if (!['auto', 'en', 'ru'].includes(preference)) preference = 'auto';
let language = resolveLanguage(preference, navigator.languages?.length ? navigator.languages : [navigator.language || 'en']);
export const locale = () => language;
export function t(key, values = []) {
  // Rate-limit responses include the server's calculated retry delay.
  const retry = key.match(/^Too many attempts\. Try again in (\d+) min\.$/);
  if (retry) return t('Too many attempts. Try again in {0} min.', [retry[1]]);
  const template = language === 'ru' ? ru[key] || key : key;
  return template.replace(/\{(\d+)\}/g, (match, index) => values[index] ?? match);
}
// Keep render functions for live status text; changing language never reloads the page.
const bindings = new Map();
export function setText(element, render, attribute) {
  let properties = bindings.get(element);
  if (!properties) { properties = new Map(); bindings.set(element, properties); }
  properties.set(attribute || 'textContent', render);
  if (attribute) element.setAttribute(attribute, render());
  else element.textContent = render();
}
const listeners = new Set();
export const onLanguageChange = callback => listeners.add(callback);
function renderLanguage() {
  document.documentElement.lang = language;
  for (const element of document.querySelectorAll('[data-i18n]')) element.textContent = t(element.dataset.i18n);
  for (const element of document.querySelectorAll('[data-i18n-aria]')) element.setAttribute('aria-label', t(element.dataset.i18nAria));
  for (const [element, properties] of bindings) {
    if (!element.isConnected) { bindings.delete(element); continue; }
    for (const [property, render] of properties) {
      if (property === 'textContent') element.textContent = render();
      else element.setAttribute(property, render());
    }
  }
  for (const listener of listeners) listener();
}
function updateLanguage() {
  language = resolveLanguage(preference, navigator.languages?.length ? navigator.languages : [navigator.language || 'en']);
  renderLanguage();
}
const selector = document.getElementById('language');
selector.value = preference;
selector.addEventListener('change', () => {
  preference = selector.value;
  try { localStorage.setItem(storageKey, preference); } catch {}
  updateLanguage();
});
window.addEventListener('languagechange', () => { if (preference === 'auto') updateLanguage(); });
renderLanguage();
