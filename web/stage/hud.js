// 游戏中的 HUD：顶部进度与资源、中部大号计数和进度环、底部提示、角标、提示条、换关提示、资源飞入。
import {STAGES} from '../core.js';

const RING = 2 * Math.PI * 52;   // 进度环周长，和 stage.html 里 r=52 一致
const $ = id => document.getElementById(id);
const ICONS = {water: '#i-water', wood: '#i-wood', food: '#i-food', house: '#i-house'};
const CHIPS = {water: 'chipWater', wood: 'chipWood', food: 'chipFood', hp: 'chipHp'};

export function createHud({reducedMotion = false} = {}) {
  const dots = $('dots');
  dots.replaceChildren(...STAGES.map(stage => Object.assign(document.createElement('li'), {title: stage.name})));
  const shown = {water: 0, wood: 0, food: 0, hp: 100};
  let lastHint = '', toastTimer = 0, flights = 0;

  function setValue(key, value, pop = false) {
    shown[key] = value;
    if (key === 'hp') {
      $('vHp').textContent = String(value);
      $('hpFill').style.width = Math.max(0, Math.min(100, value)) + '%';
      $(CHIPS.hp).classList.toggle('low', value <= 25);
    } else $('v' + key[0].toUpperCase() + key.slice(1)).textContent = String(value);
    if (pop && !reducedMotion) { const chip = $(CHIPS[key]); chip.classList.remove('pop'); void chip.offsetWidth; chip.classList.add('pop'); }
  }
  function ring(count, target) {
    const p = target > 0 ? Math.min(1, count / target) : 0;
    $('ringArc').style.strokeDashoffset = String(RING * (1 - p));
    $('counter').classList.toggle('complete', p >= 1);
  }
  function bump() {
    const node = $('countNow');
    if (!node.animate) return;
    if (reducedMotion) node.animate([{opacity: 0.4}, {opacity: 1}], {duration: 200});
    else node.animate([{transform: 'scale(1)'}, {transform: 'scale(1.32)', offset: 0.3}, {transform: 'scale(1)'}],
      {duration: 520, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)'});
  }
  function fly(kind, from, chipId, delay, done) {
    const target = $(chipId)?.querySelector('.ico') || $(chipId);
    if (!target || !from || reducedMotion || !document.body.animate) { setTimeout(done, delay); return; }
    const box = target.getBoundingClientRect();
    const to = {x: box.left + box.width / 2, y: box.top + box.height / 2};
    const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    node.setAttribute('class', 'ico ' + kind);
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', ICONS[kind]);
    node.append(use);
    $('fly').append(node);
    const half = parseFloat(getComputedStyle(node).width) / 2 || 30;
    const mid = {x: (from.x + to.x) / 2, y: Math.min(from.y, to.y) - innerHeight * 0.12};
    const at = (p, s) => ({transform: `translate(${p.x - half}px, ${p.y - half}px) scale(${s})`});
    flights++;
    const animation = node.animate([at(from, 0.6), {...at(mid, 1.3), offset: 0.45}, at(to, 0.8)],
      {duration: 950, delay, easing: 'cubic-bezier(0.45, 0, 0.3, 1)', fill: 'backwards'});
    const finish = () => { node.remove(); flights--; done(); };
    animation.onfinish = finish; animation.oncancel = finish;
  }
  return {
    // mode: 'play' shows everything, 'failed' hides the counter, false hides the HUD.
    show(mode) { $('top').hidden = $('hint').hidden = !mode; $('counter').hidden = mode !== 'play'; },
    values(island) { for (const key of ['water', 'wood', 'food', 'hp']) setValue(key, island[key]); },
    get flying() { return flights > 0; },
    stage({stage, target, done, island}) {
      const config = STAGES[Math.min(3, stage)];
      dots.querySelectorAll('li').forEach((li, i) => { li.className = i < stage ? 'done' : i === stage ? 'active' : ''; });
      $('stageNo').textContent = `第 ${Math.min(4, stage + 1)} 关 · ${config.move}`;
      $('stageName').textContent = config.name;
      $('moveName').textContent = `${config.move} · 目标 ${target} 次`;
      $('countNow').textContent = String(done);
      $('countTarget').textContent = '/ ' + target;
      ring(done, target);
      if (island) for (const key of ['water', 'wood', 'food', 'hp']) setValue(key, island[key]);
    },
    count(count, target) { $('countNow').textContent = String(count); $('countTarget').textContent = '/ ' + target; ring(count, target); bump(); },
    // Reward icons fly from the island into the HUD; chip values change when they land.
    reward({stage, resources, hp, shelter, shelterBefore}, from) {
      const gains = [['water', 0], ['wood', 1], ['food', 2]];
      for (const [key, i] of gains) {
        const value = resources[key];
        if (value === shown[key]) continue;
        if (stage === i && value > shown[key]) {
          const n = Math.min(3, value - shown[key]);
          let landed = 0;
          for (let k = 0; k < n; k++) fly(key, from, CHIPS[key], k * 140, () => { if (++landed === n) setValue(key, value, true); });
        } else setValue(key, value, true);
      }
      if (stage === 3 && shelter > shelterBefore) fly('house', from, 'dots', 0, () => {});
      if (hp !== shown.hp) setValue('hp', hp, true);
    },
    hint(text, tone = 'info') {
      const node = $('hintText');
      node.dataset.tone = tone;
      if (text === lastHint) return;
      lastHint = text; node.textContent = text;
      if (!reducedMotion && tone === 'warn') { node.classList.remove('pulse'); void node.offsetWidth; node.classList.add('pulse'); }
    },
    side(side) { const node = $('counter'); node.classList.toggle('left', side !== 'right'); node.classList.toggle('right', side === 'right'); },
    toast(title, detail, icon = 'water', ms = 3200) {
      clearTimeout(toastTimer);
      $('toastTitle').textContent = title; $('toastDetail').textContent = detail;
      $('toastIcon').querySelector('use').setAttribute('href', ICONS[icon] || ICONS.water);
      const node = $('toast'); node.hidden = true; void node.offsetWidth; node.hidden = false;
      toastTimer = setTimeout(() => { node.hidden = true; }, ms);
    },
    clearToast() { clearTimeout(toastTimer); $('toast').hidden = true; },
    badges(list) {
      $('badges').replaceChildren(...list.map(({text, kind}) => Object.assign(document.createElement('span'), {className: 'badge ' + kind, textContent: text})));
    },
    notice(text, tone = 'info', ms = 6000) {
      const box = $('notices');
      for (const old of box.children) if (old.textContent === text) old.remove();
      const node = Object.assign(document.createElement('p'), {className: 'panel notice', textContent: text});
      node.dataset.tone = tone;
      box.append(node);
      while (box.children.length > 3) box.firstElementChild.remove();
      setTimeout(() => { node.classList.add('out'); setTimeout(() => node.remove(), 600); }, ms);
    },
    reset() {
      this.clearToast(); $('fly').replaceChildren(); flights = 0; lastHint = '';
      for (const key of ['water', 'wood', 'food']) setValue(key, 0);
      setValue('hp', 100);
    },
  };
}
