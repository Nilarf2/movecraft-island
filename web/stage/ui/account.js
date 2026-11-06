// Big-screen login (mountLogin) and account menu (mountAccountMenu).
// The screen is public: "remember me" starts off, passwords never touch storage, and recent names can be removed.
import {h, uid, trapTab, composing, play, announce, whenStyled} from './dom.js';
import {validateForm, errorCode, errorText, withTimeout, userFrom, normalizeUsername, PRIVACY,
  loadRecent, saveRecent, addRecent, removeRecent, cleanRecent, WELCOME_MS} from './logic.js';

// api.recentUsers()/forgetRecent() own the list when they exist; otherwise it lives in localStorage here.
function recentStore(api) {
  let storage = null;
  try { storage = globalThis.localStorage ?? null; } catch {}
  const own = typeof api?.recentUsers === 'function';
  return {
    list: () => Promise.resolve().then(() => own ? api.recentUsers() : loadRecent(storage))
      .then(cleanRecent).catch(() => []),
    add(name) { if (!own) saveRecent(storage, addRecent(loadRecent(storage), name)); },
    forget(name) {
      try { if (own) api.forgetRecent?.(name); else saveRecent(storage, removeRecent(loadRecent(storage), name)); } catch {}
    },
  };
}

function passwordInput(id, placeholder) {
  return h('input', {id, class: 'mcui-input', type: 'password', autocomplete: 'new-password', maxlength: 128,
    spellcheck: 'false', autocapitalize: 'off', placeholder});
}
const capsBadge = () => h('span', {class: 'mcui-caps', role: 'status', hidden: true, text: '大写锁定'});

// onDone({user, isNew}) after the 1-second welcome, or onDone({guest: true}). Esc calls onCancel (back to attract).
export function mountLogin(root, {api = null, sfx = null, onDone = () => {}, onCancel = null} = {}) {
  const ids = {user: uid('mcui-user'), pass: uid('mcui-pass'), confirm: uid('mcui-confirm'), msg: uid('mcui-msg'),
    note: uid('mcui-note'), title: uid('mcui-title')};
  const store = recentStore(api);
  let mode = 'login', busy = false, finished = false, destroyed = false, timer = 0, recent = [];

  const user = h('input', {id: ids.user, class: 'mcui-input', type: 'text', autocomplete: 'off', maxlength: 32,
    spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off', placeholder: '2–16 个字', 'data-field': 'username'});
  const pass = passwordInput(ids.pass, '至少 6 位');
  pass.dataset.field = 'password';
  const confirm = passwordInput(ids.confirm, '再输一次密码');
  confirm.dataset.field = 'confirm';
  const caps = capsBadge(), capsConfirm = capsBadge();
  const eye = h('button', {class: 'mcui-eye', type: 'button', 'aria-pressed': 'false', 'aria-controls': `${ids.pass} ${ids.confirm}`,
    'aria-label': '显示密码', text: '显示'});
  const passWrap = h('div', {class: 'mcui-wrap has-eye'}, pass, caps, eye);
  const confirmWrap = h('div', {class: 'mcui-wrap'}, confirm, capsConfirm);
  const confirmLabel = h('label', {class: 'mcui-label', for: ids.confirm, text: '确认密码'});
  const remember = h('input', {type: 'checkbox', role: 'switch', 'data-field': 'remember'});
  const msg = h('p', {id: ids.msg, class: 'mcui-msg', 'aria-live': 'assertive', 'aria-atomic': 'true'});
  const btn = (action, text) => h('button', {class: 'mcui-btn', type: 'button', 'data-action': action, text});
  const loginBtn = btn('login', '登录'), registerBtn = btn('register', '注册'), guestBtn = btn('guest', '游客');
  const LABEL = {login: '登录', register: '注册'};

  const title = h('h2', {id: ids.title, class: 'mcui-title'});
  const sub = h('p', {class: 'mcui-sub', text: '输入用户名和密码登录，也可以先当游客玩一轮'});
  const note = h('p', {id: ids.note, class: 'mcui-note', hidden: true, text: '用户名会显示在排行榜上，不要用真名'});
  const fields = h('div', {class: 'mcui-fields'},
    h('label', {class: 'mcui-label', for: ids.user, text: '用户名'}), user,
    h('label', {class: 'mcui-label', for: ids.pass, text: '密码'}), passWrap,
    confirmLabel, confirmWrap);
  const rememberRow = h('label', {class: 'mcui-switch'}, remember,
    h('span', {class: 'mcui-switch-text', text: '记住我'}),
    h('span', {class: 'mcui-switch-hint', text: '公用大屏请保持关闭'}));
  const main = h('div', {class: 'mcui-main'}, h('div', {class: 'mcui-head'}, title, sub, note),
    fields, rememberRow, msg, h('div', {class: 'mcui-actions'}, loginBtn, registerBtn, guestBtn));

  const chips = h('ul', {class: 'mcui-chips', 'aria-label': '最近登录的用户名'});
  const recentBox = h('section', {class: 'mcui-recent', hidden: true},
    h('h3', {class: 'mcui-side-title', text: '最近登录'}), chips);
  const privacyId = uid('mcui-privacy');
  const privacy = h('section', {class: 'mcui-privacy', 'aria-labelledby': privacyId, 'data-ui': 'privacy'},
    h('h3', {id: privacyId, class: 'mcui-side-title', text: PRIVACY.title}),
    ...PRIVACY.sections.map(([head, text]) => h('p', {}, h('b', {text: head}), text)));
  const card = h('div', {class: 'mcui-card mcui-login', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': ids.title},
    main, h('aside', {class: 'mcui-side'}, recentBox, privacy));
  const layer = h('div', {class: 'mcui mcui-layer', 'data-ui': 'login'}, card);
  const inputs = {username: user, password: pass, confirm};
  pass.setAttribute('aria-describedby', ids.msg);
  confirm.setAttribute('aria-describedby', ids.msg);

  // Caps Lock is only known after a key press; the badge shows inside the focused password box.
  let capsOn = false;
  function showCaps() {
    const active = document.activeElement;
    caps.hidden = !(capsOn && active === pass);
    capsConfirm.hidden = !(capsOn && active === confirm);
    passWrap.classList.toggle('has-caps', !caps.hidden);
    confirmWrap.classList.toggle('has-caps', !capsConfirm.hidden);
  }
  for (const type of ['keydown', 'keyup']) card.addEventListener(type, event => {
    if (typeof event.getModifierState !== 'function') return;
    capsOn = event.getModifierState('CapsLock');
    showCaps();
  });
  card.addEventListener('focusin', showCaps);
  card.addEventListener('focusout', showCaps);
  eye.addEventListener('click', () => {
    const show = pass.type === 'password';
    pass.type = confirm.type = show ? 'text' : 'password';
    eye.textContent = show ? '隐藏' : '显示';
    eye.setAttribute('aria-pressed', String(show));
    play(sfx, 'uiMove');
  });
  for (const input of [user, pass, confirm]) input.addEventListener('input', () => {
    if (input.getAttribute('aria-invalid') !== 'true') return;
    input.removeAttribute('aria-invalid');
    msg.textContent = '';
  });
  loginBtn.addEventListener('click', () => press('login'));
  registerBtn.addEventListener('click', () => press('register'));
  guestBtn.addEventListener('click', () => guest());
  // 登录 / 注册 buttons: the button of the current mode submits; the other one switches mode first.
  function press(action) {
    if (busy || finished) return;
    if (action === mode) { submit(); return; }
    setMode(action);
    // Going back to login with both boxes filled logs in at once; register still needs the second password.
    if (action === 'login' && !firstEmpty()) submit();
    else (firstEmpty() || (action === 'login' ? loginBtn : registerBtn)).focus();
  }
  const order = () => mode === 'register' ? [user, pass, confirm] : [user, pass];
  const firstEmpty = () => order().find(input => !input.value);
  function enter() {
    const empty = firstEmpty();
    if (empty && empty !== document.activeElement) empty.focus();
    else submit();
  }

  function renderChips() {
    chips.replaceChildren(...recent.map(name => h('li', {class: 'mcui-chip'},
      h('button', {class: 'mcui-chip-pick', type: 'button', 'data-action': 'pick', title: name, text: name,
        onclick: () => choose(name),
        onkeydown: event => { if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); forget(name); } }}),
      h('button', {class: 'mcui-chip-x', type: 'button', 'data-action': 'forget', 'aria-label': `删除最近登录的 ${name}`, text: '×',
        onclick: () => forget(name)}))));
    recentBox.hidden = mode !== 'login' || recent.length === 0;
  }
  function choose(name) {
    if (busy || finished) return;
    user.value = name; pass.value = '';
    user.removeAttribute('aria-invalid'); msg.textContent = '';
    play(sfx, 'uiSelect');
    pass.focus();
  }
  function forget(name) {
    const index = recent.indexOf(name);
    recent = removeRecent(recent, name);
    store.forget(name);
    play(sfx, 'uiBack');
    renderChips();
    const next = chips.querySelectorAll('.mcui-chip-pick')[Math.min(index, recent.length - 1)];
    (next || user).focus();
  }

  function onKey(event) {
    if (destroyed || !layer.isConnected) return;
    const inside = layer.contains(event.target) || event.target === document.body;
    if (!inside) return;
    if (event.key === 'Escape') {
      if (composing(event)) return;
      if (back()) { event.preventDefault(); event.stopPropagation(); }
    } else if (event.key === 'Tab') trapTab(event, layer);
    else if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
      // Enter picks an IME candidate while the candidate window is open.
      if (composing(event) || event.repeat) return;
      event.preventDefault();
      if (!busy && !finished) enter();
    }
  }

  async function submit() {
    if (busy || finished || destroyed) return;
    const values = {username: user.value, password: pass.value, confirm: confirm.value};
    const problem = validateForm(mode, values);
    if (problem) { fail(problem.field, problem.message); return; }
    const call = mode === 'register' ? api?.register : api?.login;
    if (typeof call !== 'function') { fail(null, errorText('network'), 'warn'); guestBtn.classList.add('is-hint'); return; }
    const name = normalizeUsername(values.username);
    user.value = name;
    setBusy(true);
    try {
      const result = await withTimeout(Promise.resolve().then(() => call.call(api, name, values.password, {remember: remember.checked})));
      if (destroyed || finished) return;
      welcome(userFrom(result, name), mode === 'register');
    } catch (error) {
      if (destroyed || finished) return;
      setBusy(false);
      const code = errorCode(error);
      if (code === 'credentials') pass.value = confirm.value = '';
      guestBtn.classList.toggle('is-hint', code === 'network');
      const field = {credentials: 'password', taken: 'username', locked: 'username', invalid: 'username'}[code] || null;
      fail(field, errorText(error), code === 'network' ? 'warn' : 'error');
    }
  }
  function fail(field, text, tone = 'error') {
    for (const input of Object.values(inputs)) input.removeAttribute('aria-invalid');
    const input = field ? inputs[field] : null;
    if (input) {
      input.setAttribute('aria-invalid', 'true');
      input.focus();
      if (field === 'username') input.select();
    }
    announce(msg, text, tone);
    play(sfx, 'error');
  }
  function setBusy(on) {
    busy = on;
    if (on) card.setAttribute('aria-busy', 'true'); else card.removeAttribute('aria-busy');
    for (const b of [loginBtn, registerBtn, guestBtn]) {
      if (on) b.setAttribute('aria-disabled', 'true'); else b.removeAttribute('aria-disabled');
    }
    const active = mode === 'register' ? registerBtn : loginBtn;
    active.textContent = on ? `${LABEL[mode]}中…` : LABEL[mode];
    if (on) msg.textContent = '';
  }
  function welcome(account, isNew) {
    finished = true;
    store.add(account.username);
    clearSecrets();
    play(sfx, 'login');
    const greet = h('div', {class: 'mcui-greet', role: 'status', tabindex: '-1', 'data-ui': 'welcome'},
      isNew ? '欢迎加入小岛，' : '欢迎回来，', h('span', {class: 'mcui-greet-name', text: account.username}));
    card.replaceWith(greet);
    greet.focus();
    timer = setTimeout(() => { if (!destroyed) onDone({user: account, isNew}); }, WELCOME_MS);
  }
  function clearSecrets() {
    pass.value = confirm.value = '';
    pass.type = confirm.type = 'password';
  }
  function guest() {
    if (busy || finished) return;
    finished = true;
    clearSecrets();
    play(sfx, 'uiSelect');
    onDone({guest: true});
  }
  // Esc: register goes back to login; login goes back to attract. Returns whether Esc was used.
  function back() {
    if (finished) return false;
    if (mode === 'register' && !busy) { setMode('login'); (firstEmpty() || loginBtn).focus(); play(sfx, 'uiBack'); return true; }
    if (typeof onCancel !== 'function') return false;
    finished = true;
    clearSecrets();
    play(sfx, 'uiBack');
    onCancel();
    return true;
  }
  function setMode(next) {
    mode = next;
    const register = mode === 'register';
    title.textContent = register ? '注册新岛民' : '欢迎来到 MoveCraft 小岛';
    sub.hidden = register;
    note.hidden = !register;
    confirmLabel.hidden = confirmWrap.hidden = !register;
    if (!register) confirm.value = '';
    loginBtn.classList.toggle('is-primary', !register);
    registerBtn.classList.toggle('is-primary', register);
    user.setAttribute('aria-describedby', register ? `${ids.note} ${ids.msg}` : ids.msg);
    for (const input of Object.values(inputs)) input.removeAttribute('aria-invalid');
    msg.textContent = '';
    renderChips();
  }

  setMode('login');
  if (!api) announce(msg, errorText('network'), 'warn');
  store.list().then(list => { if (!destroyed) { recent = list; renderChips(); } });
  const styled = whenStyled(layer);
  root.append(layer);
  document.addEventListener('keydown', onKey, true);
  function focus() {
    styled.then(() => {
      if (destroyed || finished) return;
      const target = firstEmpty() || (mode === 'register' ? registerBtn : loginBtn);
      target.focus();
    });
  }
  function destroy() {
    destroyed = true;
    clearTimeout(timer);
    document.removeEventListener('keydown', onKey, true);
    clearSecrets();
    layer.remove();
  }
  focus();
  return {focus, destroy};
}
// Account menu, opened from the big-screen Esc menu: change password or delete the account.
// Calls api.changePassword(current, next) and api.deleteAccount(password); without them it says so.
// onDone({changed: true}), onDone({deleted: true}) (log out, back to attract) or onDone({}) for 返回.
export function mountAccountMenu(root, {api = null, sfx = null, onDone = () => {}} = {}) {
  const ids = {title: uid('mcui-title'), msg: uid('mcui-msg')};
  let view = 'menu', busy = false, finished = false, destroyed = false, timer = 0, secret = '', inputs = {};
  const name = String(api?.user?.username || '');
  const title = h('h2', {id: ids.title, class: 'mcui-title'});
  const sub = h('p', {class: 'mcui-sub'});
  const body = h('div', {class: 'mcui-menu-body'});
  const msg = h('p', {id: ids.msg, class: 'mcui-msg', 'aria-live': 'assertive', 'aria-atomic': 'true'});
  const card = h('div', {class: 'mcui-card mcui-menu', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': ids.title, tabindex: '-1'},
    h('div', {class: 'mcui-head'}, title, sub), body);
  const layer = h('div', {class: 'mcui mcui-layer', 'data-ui': 'account'}, card);
  const btn = (action, text, cls, onclick) => h('button', {class: `mcui-btn ${cls}`, type: 'button', 'data-action': action, text,
    onclick: () => { if (!busy && !finished) onclick(); }});
  function field(key, label) {
    const input = passwordInput(uid(`mcui-${key}`), null);
    input.dataset.field = key;
    input.setAttribute('aria-describedby', ids.msg);
    input.addEventListener('input', () => {
      if (input.getAttribute('aria-invalid') === 'true') { input.removeAttribute('aria-invalid'); msg.textContent = ''; }
    });
    inputs[key] = input;
    return [h('label', {class: 'mcui-label', for: input.id, text: label}), h('div', {class: 'mcui-wrap'}, input)];
  }
  const VIEWS = {
    menu: () => [['账号管理', name ? `当前账号：${name}` : '现在没有登录'],
      h('div', {class: 'mcui-menu-list'}, ...(name ? [btn('password', '修改密码', 'is-primary', () => open('password')),
        btn('delete', '删除账号', '', () => open('delete'))] : []), btn('back', '返回', 'is-quiet', close))],
    password: () => [['修改密码', '改好以后，其他设备上的登录会失效'],
      h('div', {class: 'mcui-fields'}, ...field('current', '现在的密码'), ...field('password', '新密码'), ...field('confirm', '确认新密码')),
      h('div', {class: 'mcui-actions'}, btn('submit', '确认修改', 'is-primary', submit), btn('back', '返回', 'is-quiet', () => show('menu')))],
    delete: () => [['删除账号', name ? `账号：${name}` : ''],
      h('p', {class: 'mcui-warn', text: '删除后，小岛存档和排行榜成绩会一起清除，不能恢复。'}),
      h('div', {class: 'mcui-fields'}, ...field('password', '输入密码')),
      h('div', {class: 'mcui-actions'}, btn('submit', '删除账号', 'is-danger', submit), btn('back', '返回', 'is-quiet', () => show('menu')))],
    confirm: () => [['真的要删除吗？', name ? `账号「${name}」会被永久删除` : ''],
      h('p', {class: 'mcui-warn', text: '小岛存档和排行榜成绩会一起清除，不能恢复。'}),
      h('div', {class: 'mcui-actions'}, btn('confirm', '确认删除', 'is-danger', submit), btn('cancel', '不删了', 'is-primary', () => show('menu')))],
  };
  function show(next) {
    view = next; inputs = {}; msg.textContent = '';
    if (next !== 'confirm') secret = '';
    const [[head, detail], ...nodes] = VIEWS[next]();
    title.textContent = head; sub.textContent = detail; sub.hidden = !detail;
    nodes.splice(nodes.length - 1, 0, msg);
    body.replaceChildren(...nodes);
    // The safe choice gets focus on the final question.
    const target = next === 'confirm' ? body.querySelector('[data-action="cancel"]') : body.querySelector('input, button');
    styled.then(() => { if (!destroyed && !finished && view === next) target?.focus(); });
  }
  function open(next) {
    play(sfx, 'uiSelect');
    show(next);
    const method = next === 'password' ? 'changePassword' : 'deleteAccount';
    if (typeof api?.[method] !== 'function') announce(msg, errorText('unsupported'), 'warn');
  }
  function submit() {
    if (busy || finished || destroyed) return;
    if (view === 'password') {
      const values = {current: inputs.current.value, password: inputs.password.value, confirm: inputs.confirm.value};
      const problem = validateForm('password', values);
      if (problem) fail(problem.field, problem.message);
      else run('changePassword', [values.current, values.password], {changed: true});
    } else if (view === 'delete') {
      const problem = validateForm('delete', {password: inputs.password.value});
      if (problem) { fail(problem.field, problem.message); return; }
      secret = inputs.password.value;
      play(sfx, 'uiSelect');
      show('confirm');
    } else if (view === 'confirm') run('deleteAccount', [secret], {deleted: true});
  }
  async function run(method, args, result) {
    if (typeof api?.[method] !== 'function') { announce(msg, errorText('unsupported'), 'warn'); play(sfx, 'error'); return; }
    setBusy(true);
    try {
      await withTimeout(Promise.resolve().then(() => api[method](...args)));
      if (destroyed) return;
      secret = '';
      done(result);
    } catch (error) {
      if (destroyed) return;
      setBusy(false);
      const code = errorCode(error);
      if (view === 'confirm') show('delete');
      const target = code === 'credentials' ? (view === 'password' ? 'current' : 'password')
        : code === 'invalid' && view === 'password' ? 'password' : null;
      if (target && inputs[target]) inputs[target].value = '';
      fail(target, errorText(error, {context: 'menu'}));
    }
  }
  function fail(key, text) {
    for (const input of Object.values(inputs)) input.removeAttribute('aria-invalid');
    const input = key ? inputs[key] : null;
    if (input) { input.setAttribute('aria-invalid', 'true'); input.focus(); }
    announce(msg, text, 'error');
    play(sfx, 'error');
  }
  function setBusy(on) {
    busy = on;
    if (on) card.setAttribute('aria-busy', 'true'); else card.removeAttribute('aria-busy');
    for (const b of body.querySelectorAll('button')) {
      if (on) b.setAttribute('aria-disabled', 'true'); else b.removeAttribute('aria-disabled');
    }
    if (on) msg.textContent = '';
  }
  function done(result) {
    finished = true;
    play(sfx, result.deleted ? 'uiBack' : 'uiSelect');
    title.textContent = result.deleted ? '账号已删除' : '密码已修改';
    sub.textContent = result.deleted ? '即将回到待机画面' : '下次登录请用新密码';
    sub.hidden = false;
    body.replaceChildren();
    card.focus();
    timer = setTimeout(() => { if (!destroyed) onDone(result); }, WELCOME_MS * 1.5);
  }
  function close() {
    finished = true;
    play(sfx, 'uiBack');
    onDone({});
  }
  function onKey(event) {
    if (destroyed || !layer.isConnected) return;
    if (!layer.contains(event.target) && event.target !== document.body) return;
    if (event.key === 'Escape') {
      if (composing(event) || finished || busy) return;
      event.preventDefault(); event.stopPropagation();
      if (view === 'confirm') show('delete');
      else if (view !== 'menu') show('menu');
      else close();
    } else if (event.key === 'Tab') trapTab(event, layer);
    else if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
      if (composing(event) || event.repeat) return;
      event.preventDefault();
      const empty = Object.values(inputs).find(input => !input.value);
      if (empty && empty !== event.target) empty.focus(); else submit();
    }
  }

  const styled = whenStyled(layer);
  show('menu');
  root.append(layer);
  document.addEventListener('keydown', onKey, true);
  function focus() {
    styled.then(() => { if (!destroyed && !finished) (body.querySelector('input, button') || card).focus(); });
  }
  function destroy() {
    destroyed = true;
    clearTimeout(timer);
    secret = '';
    document.removeEventListener('keydown', onKey, true);
    layer.remove();
  }
  return {focus, destroy};
}
