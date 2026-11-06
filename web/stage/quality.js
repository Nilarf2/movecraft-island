// Render quality for the big screen. Owns the renderer side: pixel ratio (render
// scale) and the shadow map. The scene side (casters, particles, density) is
// island.setQuality(level), which the caller runs from onChange.
// Auto mode starts at medium, steps down when rendering or recognition is starved
// (integrated GPUs share the CPU with the pose worker) and steps up only after a
// long smooth stretch. Time is the sum of sampled frame times, so the rules are
// deterministic and testable in node. No DOM or three.js import at module level.

export const LEVELS = {
  low: {scale: 0.67, maxPixelRatio: 1, shadows: false, shadowMapSize: 0},
  medium: {scale: 0.85, maxPixelRatio: 1.25, shadows: true, shadowMapSize: 1024},
  high: {scale: 1, maxPixelRatio: 2, shadows: true, shadowMapSize: 2048},
};
const ORDER = ['low', 'medium', 'high'];
const isLevel = level => ORDER.includes(level);
export const RULES = {
  startSettleMs: 4000,     // model load and shader compile at start-up are not the machine's real speed
  settleMs: 2000,          // after a level change: programs recompile, buffers resize
  maxFrameMs: 1000,        // a longer frame is a pause (hidden tab, sleep): dropped, windows restart
  downSeconds: 3, downFps: 30, downPoseFps: 8,
  upSeconds: 10, upFps: 55, upPoseFps: 10, upSpacingMs: 30000, noUpAfterDowngrades: 2,
};

// createQuality(renderer, {initial: 'auto' | 'low' | 'medium' | 'high', onChange(level, info), scene})
// scene (object or function returning it) is optional: when given, a shadow switch
// recompiles its materials and shadow maps get the level's size.
export function createQuality(renderer, {initial = 'auto', onChange, scene} = {}) {
  const q = {
    auto: !isLevel(initial), level: isLevel(initial) ? initial : 'medium', settings: null, dpr: 0,
    clock: 0, settleUntil: RULES.startSettleMs, bucket: newBucket(), buckets: [],
    downgrades: 0, upgrades: 0, lastUpgradeAt: -Infinity,
  };
  apply();

  function apply() {
    const cfg = LEVELS[q.level], dpr = q.dpr = globalThis.devicePixelRatio || 1;
    const pixelRatio = Math.min(cfg.maxPixelRatio, Math.max(0.5, Math.round(dpr * cfg.scale * 100) / 100));
    q.settings = {level: q.level, ...cfg, pixelRatio};
    if (!renderer) return;
    if (renderer.getPixelRatio?.() !== pixelRatio) renderer.setPixelRatio?.(pixelRatio);
    const shadowMap = renderer.shadowMap;
    if (!shadowMap) return;
    const toggled = shadowMap.enabled !== cfg.shadows;
    shadowMap.enabled = cfg.shadows;
    if (toggled) shadowMap.needsUpdate = true;
    syncScene(toggled);
  }
  // three.js bakes "shadow map on/off" into each program, and r186 does not notice a
  // runtime switch of shadowMap.enabled alone, so the materials are flagged to rebuild.
  function syncScene(toggled) {
    const root = typeof scene === 'function' ? scene() : scene;
    if (!root?.traverse) return;
    const size = LEVELS[q.level].shadowMapSize;
    root.traverse(object => {
      if (toggled && object.material) for (const material of [].concat(object.material)) if (material) material.needsUpdate = true;
      // Also lights whose castShadow is still off: island.setQuality turns it on after onChange.
      const mapSize = object.isLight && object.shadow?.mapSize;
      if (mapSize && size && (mapSize.x !== size || mapSize.y !== size)) mapSize.set(size, size);
    });
  }

  // ---- auto ----
  function sample(dtMs, {poseFps} = {}) {
    if (!(dtMs > 0)) return q.level;
    if ((globalThis.devicePixelRatio || 1) !== q.dpr) apply();   // window moved to another screen or zoom changed
    if (!q.auto) return q.level;
    if (dtMs > RULES.maxFrameMs) { restartWindows(RULES.settleMs); return q.level; }
    q.clock += dtMs;
    if (q.clock < q.settleUntil) return q.level;
    const b = q.bucket;
    b.ms += dtMs; b.frames++;
    if (poseFps > 0) { b.poseSum += poseFps; b.poseFrames++; } else b.poseUnknown = true;
    if (b.ms >= 1000) {
      q.buckets.push({ms: b.ms, frames: b.frames, fps: b.frames * 1000 / b.ms, poseFps: b.poseUnknown || !b.poseFrames ? null : b.poseSum / b.poseFrames});
      if (q.buckets.length > RULES.upSeconds) q.buckets.shift();
      q.bucket = newBucket();
      evaluate();
    }
    return q.level;
  }
  function evaluate() {
    const index = ORDER.indexOf(q.level), recent = q.buckets.slice(-RULES.downSeconds);
    if (index > 0 && recent.length === RULES.downSeconds) {
      // "3 秒平均": frames over time across the whole window, not a mean of per-second values.
      const fps = recent.reduce((sum, b) => sum + b.frames, 0) * 1000 / recent.reduce((sum, b) => sum + b.ms, 0);
      const poseKnown = recent.every(b => b.poseFps !== null);
      const poseFps = poseKnown ? recent.reduce((sum, b) => sum + b.poseFps, 0) / recent.length : null;
      if (fps < RULES.downFps) return step(-1, 'render', {fps, poseFps});
      if (poseKnown && poseFps < RULES.downPoseFps) return step(-1, 'pose', {fps, poseFps});
    }
    if (index < ORDER.length - 1 && q.downgrades < RULES.noUpAfterDowngrades && q.buckets.length >= RULES.upSeconds
      && q.clock - q.lastUpgradeAt >= RULES.upSpacingMs
      && q.buckets.every(b => b.fps > RULES.upFps && (b.poseFps === null || b.poseFps >= RULES.upPoseFps))) {
      return step(1, 'smooth', {fps: Math.min(...q.buckets.map(b => b.fps))});
    }
  }
  function step(direction, reason, measured) {
    if (direction < 0) q.downgrades++; else { q.upgrades++; q.lastUpgradeAt = q.clock; }
    change(ORDER[ORDER.indexOf(q.level) + direction], reason, measured);
  }
  function change(level, reason, measured = null) {
    const from = q.level;
    q.level = level;
    apply();
    restartWindows(RULES.settleMs);
    if (level !== from) call(onChange, level, {from, reason, auto: q.auto, measured, settings: q.settings});
  }
  function restartWindows(settleMs) {
    q.settleUntil = q.clock + settleMs; q.bucket = newBucket(); q.buckets = [];
  }
  // set('auto') restarts the auto rules from medium; a fixed level turns auto off.
  function set(level) {
    if (level === 'auto') {
      q.auto = true; q.downgrades = 0; q.upgrades = 0; q.lastUpgradeAt = -Infinity;
      change('medium', 'manual');
    } else if (isLevel(level)) {
      q.auto = false;
      change(level, 'manual');
    }
    return q.level;
  }
  function stats() {
    const last = q.buckets.at(-1);
    return {...q.settings, auto: q.auto, downgrades: q.downgrades, upgrades: q.upgrades, settling: q.clock < q.settleUntil,
      fps: last ? Math.round(last.fps * 10) / 10 : null, poseFps: last?.poseFps == null ? null : Math.round(last.poseFps * 10) / 10};
  }
  return {
    get level() { return q.level; }, get auto() { return q.auto; }, get settings() { return {...q.settings}; },
    sample, set, stats,
  };
}

function newBucket() { return {ms: 0, frames: 0, poseSum: 0, poseFrames: 0, poseUnknown: false}; }
function call(callback, ...args) {
  if (!callback) return;
  try { callback(...args); } catch (error) { setTimeout(() => { throw error; }); }
}

// three.js r186 needs WebGL2. Checked once; the probe context is released right away.
let webgl = null;
export function webglAvailable() {
  if (webgl !== null) return webgl;
  if (typeof document === 'undefined') return false;
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    webgl = !!gl;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch { webgl = false; }
  return webgl;
}
