// Esc 菜单：↑↓ 选择，←→ 调整，Enter 确认，Esc 返回。菜单项由大屏页按当前状态给出：
// {label, value?: () => string, run?, adjust?(dir), keep?: 执行后不关菜单, confirm?: 要按两次, disabled?, danger?}
const $ = id => document.getElementById(id);

export function createMenu({sfx} = {}) {
  const box = $('menu'), list = $('menuList');
  let items = [], index = 0, onClose = null;
  const play = name => { try { sfx?.play?.(name); } catch { /* sound is optional */ } };
  const selectable = i => !!items[i] && !items[i].disabled;

  function render() {
    list.replaceChildren(...items.map((item, i) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'menuitem');
      li.setAttribute('aria-selected', String(i === index));
      if (item.disabled) li.setAttribute('aria-disabled', 'true');
      if (item.danger) li.classList.add('danger');
      li.append(Object.assign(document.createElement('span'), {textContent: item.armed ? item.armedLabel || '再按一次 Enter 确认' : item.label}));
      const value = typeof item.value === 'function' ? item.value() : item.value;
      if (value) li.append(Object.assign(document.createElement('span'), {className: 'value', textContent: value}));
      li.onclick = () => { if (!selectable(i)) return; if (index !== i) { index = i; disarm(); } activate(); };
      return li;
    }));
  }
  function disarm() { for (const item of items) item.armed = false; }
  function move(dir) {
    for (let step = 1; step <= items.length; step++) {
      const next = ((index + dir * step) % items.length + items.length) % items.length;
      if (selectable(next)) { index = next; break; }
    }
    disarm(); play('uiMove'); render();
  }
  function activate() {
    const item = items[index];
    if (!selectable(index)) { play('error'); return; }
    if (item.confirm && !item.armed) { item.armed = true; play('uiMove'); render(); return; }
    play('uiSelect');
    try { item.run?.(); } catch (error) { console.warn('[stage] 菜单项出错：', item.label, error); }
    if (box.hidden) return;
    if (item.keep) { disarm(); render(); } else api.close();
  }
  const api = {
    get open() { return !box.hidden; },
    show(newItems, {onClose: callback = null} = {}) {
      items = newItems; onClose = callback;
      index = Math.max(0, items.findIndex((_, i) => selectable(i)));
      box.hidden = false; render();
    },
    // hide: just the UI (the flow already closed the menu); close: also tells the page.
    hide() { box.hidden = true; items = []; onClose = null; },
    close() { const callback = onClose; api.hide(); callback?.(); },
    refresh() { if (!box.hidden) render(); },
    key(event) {
      const key = event.key;
      if (key === 'ArrowDown' || key === 'ArrowUp') move(key === 'ArrowDown' ? 1 : -1);
      else if (key === 'ArrowLeft' || key === 'ArrowRight') {
        const item = items[index];
        if (item?.adjust && selectable(index)) { item.adjust(key === 'ArrowRight' ? 1 : -1); play('uiMove'); render(); }
      } else if (key === 'Enter' || key === ' ') activate();
      else if (key === 'Escape') { play('uiBack'); api.close(); }
      else return false;
      event.preventDefault();
      return true;
    },
  };
  return api;
}
