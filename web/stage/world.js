// 大屏画面：优先用 3D 岛（web/world/island.js）加小人（web/world/avatar.js）；
// WebGL 不可用、3D 模块缺失或运行中出错时，退到 scene.js 的 2D 画法。两种模式对外接口相同。
import {drawWorld} from '../scene.js';

const W2 = 1120, H2 = 620;               // scene.js 的设计尺寸
const PLAYER_2D = {x: 901, y: 330};      // 2D 画面里玩家镜像画框的中心
const PROP_2D = {x: 400, y: 330};        // 2D 画面里当前关的道具
const LEVELS = ['low', 'medium', 'high'];
const sceneLevel = level => LEVELS.includes(level) ? level : 'medium';

export function createWorld({canvas, canvas2d, THREE, islandModule, avatarModule, qualityModule, reducedMotion = false, onFallback}) {
  const view = {stage: 0, progress: 0, target: 10, shelter: 0, attract: false, attractAt: 0, demo: false};
  const w = {mode: '2d', island: null, avatar: null, renderer: null, quality: null, error: null,
    frameErrors: 0, callErrors: 0, demo: null, lastPaint: -Infinity, video: null, landmarks: null};

  function init3d() {
    if (!THREE) throw new Error('three.js 没有加载');
    if (!islandModule?.createIsland) throw new Error('island.js 没有加载');
    const ok = qualityModule?.webglAvailable ? qualityModule.webglAvailable() : !!document.createElement('canvas').getContext('webgl2');
    if (!ok) throw new Error('WebGL 不可用');
    const renderer = new THREE.WebGLRenderer({canvas, antialias: true, powerPreference: 'high-performance'});
    w.renderer = renderer;
    canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); fallback(new Error('WebGL 上下文丢失')); });
    if (qualityModule?.createQuality) {
      w.quality = qualityModule.createQuality(renderer, {initial: 'auto', scene: () => w.island?.scene,
        onChange: level => call('setQuality', sceneLevel(typeof level === 'string' ? level : level?.level))});
    } else renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 1.5));
    w.island = islandModule.createIsland(THREE, {palette: 'day', quality: sceneLevel(w.quality?.level), zone: 0, reducedMotion});
    w.mode = '3d';
    resize();
    try { addAvatar(); } catch (error) { console.warn('[stage] 小人不可用：', error); w.avatar = null; }
    canvas.hidden = false; canvas2d.hidden = true;
  }
  function addAvatar() {
    if (!avatarModule?.createAvatar) return;
    w.avatar = avatarModule.createAvatar(THREE, {height: w.island.avatarHeight || 1.7, palette: 'day', mirror: true});
    w.island.scene.add(w.avatar.group);
    place(view.stage);
  }
  function place(zone) {
    if (!w.avatar || !w.island?.anchor) return;
    const anchor = w.island.anchor(Math.min(3, zone));
    if (anchor?.position) w.avatar.group.position.copy(anchor.position);
    if (Number.isFinite(anchor?.facing)) w.avatar.group.rotation.y = anchor.facing;
  }
  function dropAvatar(error) {
    console.warn('[stage] 小人出错，已隐藏：', error);
    const avatar = w.avatar; w.avatar = null;
    try { w.island?.scene.remove(avatar.group); avatar.dispose?.(); } catch { /* already broken */ }
  }
  function fallback(error) {
    if (w.mode === '2d' && w.error) return;
    w.error = error;
    console.warn('[stage] 退到 2D 画面：', error?.message || error);
    const {island, avatar, renderer} = w;
    Object.assign(w, {mode: '2d', island: null, avatar: null, quality: null, renderer: null});
    for (const item of [avatar, island, renderer]) { try { item?.dispose?.(); } catch { /* best effort */ } }
    canvas.hidden = true; canvas2d.hidden = false;
    try { onFallback?.(error); } catch { /* the 2D view still works */ }
  }
  // One failing scene call is logged; a burst of them means the 3D side is broken.
  function call(name, ...args) {
    if (w.mode !== '3d') return undefined;
    try { return w.island[name]?.(...args); } catch (error) {
      console.warn(`[stage] island.${name} 出错：`, error);
      if (++w.callErrors >= 20) fallback(error);
      return undefined;
    }
  }
  function avatarCall(name, ...args) {
    if (!w.avatar) return;
    try { w.avatar[name]?.(...args); } catch (error) { dropAvatar(error); }
  }
  function resize() {
    if (w.mode !== '3d') return;
    try { w.renderer.setSize(innerWidth, innerHeight, false); w.island.resize(innerWidth, innerHeight); } catch (error) { fallback(error); }
  }
  function to2d({x, y}) {
    const width = innerWidth, height = innerHeight, s = Math.max(width / W2, height / H2);
    return {x: (width - W2 * s) / 2 + x * s, y: (height - H2 * s) / 2 + y * s};
  }
  function screenOf(lift) {
    if (w.mode === '3d') {
      try {
        const anchor = w.island.anchor(Math.min(3, view.stage));
        const p = anchor?.position?.clone?.();
        if (p) { p.y += (w.island.avatarHeight || 1.7) * lift; const s = w.island.toScreen(p, innerWidth, innerHeight); if (Number.isFinite(s?.x)) return s; }
      } catch { /* use the 2D layout */ }
    }
    return null;
  }

  // dtMs, tMs from requestAnimationFrame; island/avatar get seconds.
  function frame(dtMs, tMs, {poseFps = 0} = {}) {
    if (w.mode === '3d') {
      try {
        w.quality?.sample?.(dtMs, {poseFps});
        w.island.update(dtMs / 1000, tMs / 1000);
        if (w.avatar) { try { w.avatar.update(dtMs / 1000, tMs / 1000); } catch (error) { dropAvatar(error); } }
        w.renderer.render(w.island.scene, w.island.camera);
        w.frameErrors = 0;
      } catch (error) {
        console.warn('[stage] 3D 渲染出错：', error);
        if (++w.frameErrors >= 3) fallback(error);
      }
      return;
    }
    if (tMs - w.lastPaint < 32) return;
    w.lastPaint = tMs;
    if (view.attract && tMs - view.attractAt > 6000) { view.attractAt = tMs; view.stage = (view.stage + 1) % 4; view.progress = 0.6; }
    drawWorld(canvas2d, {stage: view.stage, progress: view.progress, target: view.target, shelter: view.shelter,
      video: w.video, landmarks: w.landmarks, t: tMs, demo: view.demo, transitioning: false});
  }

  try { init3d(); } catch (error) { fallback(error); }
  addEventListener('resize', resize);
  return {
    get mode() { return w.mode; },
    get error() { return w.error; },
    get hasAvatar() { return !!w.avatar; },
    get qualityLevel() { return w.quality?.level ?? null; },
    frame,
    stats: () => call('stats') || null,
    setQuality(level) { if (w.quality?.set) w.quality.set(level); else call('setQuality', sceneLevel(level)); },
    attract(on) { view.attract = !!on; view.attractAt = performance.now(); if (!on) view.progress = 0; call('setAttract', !!on); },
    focus(stage, {target = 10, done = 0} = {}) {
      Object.assign(view, {stage, target, progress: target ? done / target : 0});
      call('focusZone', Math.min(3, stage)); place(stage);
    },
    rep(stage, count, target) { view.progress = target ? count / target : 0; call('rep', stage, count, target); },
    stageDone(stage) { view.progress = 1; call('stageDone', stage); },
    shelter(level, animate = false) { view.shelter = level; call('setShelter', level, {animate}); },
    resources(values) { call('setResources', values); },
    celebrate() { view.stage = 4; view.progress = 1; call('celebrate'); },
    // CSS px: where the player stands (lift 0.5 = chest height), and where reward icons start.
    player: () => screenOf(0.5) || to2d(PLAYER_2D),
    origin: () => screenOf(0.2) || to2d(PROP_2D),
    pose(landmarks, worldLandmarks, timestamp) { w.landmarks = landmarks; w.demo = null; avatarCall('setPose', landmarks, worldLandmarks || [], timestamp); },
    noPose() { w.landmarks = null; },
    demo(action) { if (w.demo !== action) { w.demo = action; avatarCall('setDemo', action); } },
    flash(part) { avatarCall('flash', part); },
    setVideo(video) { w.video = video || null; },
    setDemoMode(on) { view.demo = !!on; },
  };
}
