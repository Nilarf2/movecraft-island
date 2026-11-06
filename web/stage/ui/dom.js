// Small DOM helpers shared by the big-screen UI components. Text always goes in as textContent.
let serial = 0;
export const uid = prefix => `${prefix}-${++serial}`;

// h('button', {class: 'x', type: 'button', onclick}, '登录', child)
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key in el && typeof value !== 'string') el[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) el.append(child);
  return el;
}

const FOCUSABLE = 'button, input, select, textarea, [href], [tabindex]';
export function focusables(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter(el => el.tabIndex >= 0 && !el.disabled
    && !el.closest('[hidden], [inert]') && el.getClientRects().length > 0);
}
// Keeps Tab inside root: the big screen has nothing else to tab to.
export function trapTab(event, root) {
  if (event.key !== 'Tab') return;
  const list = focusables(root);
  if (!list.length) return;
  const first = list[0], last = list[list.length - 1], active = document.activeElement;
  if (event.shiftKey && (active === first || !root.contains(active))) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && (active === last || !root.contains(active))) { event.preventDefault(); first.focus(); }
}
// An IME candidate window is open: Enter picks a candidate, Esc closes the window.
export const composing = event => event.isComposing || event.keyCode === 229;

export function reducedMotion() {
  try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}
// Sound must never break the flow.
export function play(sfx, name, options) {
  try { sfx?.play?.(name, options); } catch {}
}
// Re-announces repeated text for screen readers and pulses the line so it is noticed from far away.
export function announce(el, text, tone = 'info') {
  el.dataset.tone = tone;
  if (el.textContent === text) {
    el.classList.remove('mcui-pulse'); void el.offsetWidth; el.classList.add('mcui-pulse');
    el.textContent = ''; setTimeout(() => { el.textContent = text; }, 60);
  } else el.textContent = text;
}

// Components load ui.css themselves when the page has not linked it.
const CSS_URL = new URL('./ui.css', import.meta.url).href;
let cssReady = null;
export function ensureStyles() {
  if (cssReady) return cssReady;
  const linked = [...document.querySelectorAll('link[rel~="stylesheet"]')].some(link => link.href.split(/[?#]/)[0] === CSS_URL);
  if (linked) return (cssReady = Promise.resolve());
  const link = Object.assign(document.createElement('link'), {rel: 'stylesheet', href: CSS_URL});
  cssReady = new Promise(resolve => { link.onload = link.onerror = () => resolve(); });
  document.head.append(link);
  return cssReady;
}
// Keeps el invisible until ui.css is in, so a card never flashes unstyled.
export function whenStyled(el) {
  const ready = ensureStyles();
  el.style.visibility = 'hidden';
  return ready.then(() => { el.style.visibility = ''; });
}
