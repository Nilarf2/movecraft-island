import test from 'node:test';
import assert from 'node:assert/strict';
import {createQuality, webglAvailable, LEVELS, RULES} from '../web/stage/quality.js';

function fakeRenderer() {
  return {ratio: 1, shadowMap: {enabled: true, needsUpdate: false},
    getPixelRatio() { return this.ratio; }, setPixelRatio(ratio) { this.ratio = ratio; }};
}
function make(options = {}, renderer = fakeRenderer()) {
  const changes = [];
  const q = createQuality(renderer, {onChange: (level, info) => changes.push({level, ...info}), ...options});
  return {q, renderer, changes};
}
// Feed `seconds` of frames at `fps` with a recognition rate; returns the level afterwards.
function run(q, seconds, fps, poseFps = 14) {
  const dt = 1000 / fps;
  for (let i = 0, n = Math.round(seconds * fps); i < n; i++) q.sample(dt, {poseFps});
  return q.level;
}
function withDpr(dpr, body) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'devicePixelRatio');
  globalThis.devicePixelRatio = dpr;
  try { return body(); } finally {
    if (saved) Object.defineProperty(globalThis, 'devicePixelRatio', saved); else delete globalThis.devicePixelRatio;
  }
}

test('auto starts at medium and applies its renderer settings without calling onChange', () => {
  const {q, renderer, changes} = make();
  assert.equal(q.level, 'medium'); assert.equal(q.auto, true);
  assert.equal(renderer.ratio, 0.85); assert.equal(renderer.shadowMap.enabled, true);
  assert.deepEqual(changes, []);
  assert.deepEqual(Object.keys(LEVELS), ['low', 'medium', 'high']);
  const stats = q.stats();
  assert.equal(stats.level, 'medium'); assert.equal(stats.settling, true); assert.equal(stats.fps, null);
});

test('slow start-up seconds (model load, shader compile) do not count', () => {
  const {q} = make();
  assert.equal(run(q, RULES.startSettleMs / 1000 - 0.1, 10), 'medium');
});

test('drops one level after 3 s averaging under 30 FPS', () => {
  const {q, renderer, changes} = make();
  run(q, 4, 60);
  assert.equal(run(q, 2.9, 25), 'medium');
  assert.equal(run(q, 0.5, 25), 'low');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].from, 'medium'); assert.equal(changes[0].reason, 'render'); assert.equal(changes[0].auto, true);
  assert.equal(renderer.ratio, 0.67); assert.equal(renderer.shadowMap.enabled, false); assert.equal(renderer.shadowMap.needsUpdate, true);
  assert.equal(changes[0].settings.pixelRatio, 0.67);
});

test('a one-second dip that keeps the 3 s average at 30 or more does not drop', () => {
  const {q} = make();
  run(q, 4, 60); run(q, 1, 20); run(q, 2, 60);
  assert.equal(q.level, 'medium');
});
test('drops when recognition stays under 8 FPS even if rendering is smooth', () => {
  const {q, changes} = make();
  run(q, 4, 60);
  assert.equal(run(q, 3.5, 60, 6), 'low');
  assert.equal(changes[0].reason, 'pose');
});

test('unknown recognition (camera off or warming up) never causes a drop', () => {
  const {q} = make();
  run(q, 4, 60);
  assert.equal(run(q, 6, 40, 0), 'medium');
  assert.equal(run(q, 6, 40, null), 'medium');
});

test('steps up after 10 s above 55 FPS', () => {
  const {q, renderer, changes} = make();
  run(q, 4, 60);
  assert.equal(run(q, 9.5, 60), 'medium');
  const stats = q.stats();
  assert.equal(Math.round(stats.fps), 60); assert.equal(stats.poseFps, 14); assert.equal(stats.settling, false);
  assert.equal(run(q, 1, 60), 'high');
  assert.deepEqual(changes.map(c => [c.from, c.level, c.reason]), [['medium', 'high', 'smooth']]);
  assert.equal(renderer.ratio, 1); assert.equal(renderer.shadowMap.enabled, true);
});

test('a slow second restarts the 10 s needed to step up', () => {
  const {q} = make();
  run(q, 4, 60); run(q, 5, 60); run(q, 1, 40);
  assert.equal(run(q, 5, 60), 'medium');
  assert.equal(run(q, 5.5, 60), 'high');
});

test('does not step up while recognition is weak, but does with the camera off', () => {
  let {q} = make();
  run(q, 4, 60);
  assert.equal(run(q, 15, 60, 9), 'medium');
  ({q} = make());
  run(q, 4, 60);
  assert.equal(run(q, 10.5, 60, 0), 'high');
});

test('steps up at most once every 30 s', () => {
  const {q, changes} = make();
  run(q, 4, 60);
  assert.equal(run(q, 3.5, 20), 'low');
  assert.equal(run(q, 12.5, 60), 'medium');
  assert.equal(run(q, 28.5, 60), 'medium');
  assert.equal(run(q, 3, 60), 'high');
  assert.deepEqual(changes.map(c => c.level), ['low', 'medium', 'high']);
});
test('never steps up again after two drops', () => {
  const {q, changes} = make();
  run(q, 4, 60);
  assert.equal(run(q, 10.5, 60), 'high');
  assert.equal(run(q, 5.5, 20), 'medium');
  assert.equal(run(q, 4.5, 20), 'low');
  assert.equal(run(q, 60, 60), 'low');
  assert.deepEqual(changes.map(c => c.level), ['high', 'medium', 'low']);
  assert.equal(q.stats().downgrades, 2);
});

test('one very long frame is a pause (hidden tab), not a slow machine', () => {
  const {q} = make();
  run(q, 4, 60); run(q, 2, 40);
  q.sample(5000, {poseFps: 14});
  assert.equal(q.stats().settling, true);
  assert.equal(run(q, 6, 40), 'medium');
});

test('set() pins a level; set("auto") restarts the rules from medium', () => {
  const {q, changes} = make();
  assert.equal(q.set('low'), 'low'); assert.equal(q.auto, false);
  assert.deepEqual(changes.map(c => [c.level, c.reason, c.auto]), [['low', 'manual', false]]);
  assert.equal(run(q, 20, 60), 'low');
  assert.equal(q.set('auto'), 'medium'); assert.equal(q.auto, true);
  assert.equal(run(q, 3, 20), 'medium');
  assert.equal(run(q, 2.5, 20), 'low');
  assert.equal(q.set('nonsense'), 'low');
  assert.equal(changes.length, 3);
});

test('a fixed initial level ignores frame times; unknown names mean auto', () => {
  const {q, changes} = make({initial: 'high'});
  assert.equal(q.auto, false);
  assert.equal(run(q, 10, 10), 'high');
  assert.deepEqual(changes, []);
  const other = make({initial: 'toString'}).q;
  assert.equal(other.auto, true); assert.equal(other.level, 'medium');
});

test('pixel ratio follows devicePixelRatio, the level scale and its cap', () => {
  withDpr(2, () => {
    const {q, renderer} = make();
    assert.equal(renderer.ratio, 1.25);
    q.set('high'); assert.equal(renderer.ratio, 2);
    q.set('low'); assert.equal(renderer.ratio, 1);
  });
  withDpr(1.25, () => {
    const {q, renderer} = make();
    assert.equal(renderer.ratio, 1.06);
    q.set('low'); assert.equal(renderer.ratio, 0.84);
    q.set('high'); assert.equal(renderer.ratio, 1.25);
  });
  withDpr(1, () => {
    const {q, renderer} = make();
    assert.equal(renderer.ratio, 0.85);
    globalThis.devicePixelRatio = 2;   // window dragged to a high-DPI screen
    q.sample(16, {poseFps: 14});
    assert.equal(renderer.ratio, 1.25);
  });
});

test('a shadow switch rebuilds scene materials; shadow maps follow the level size', () => {
  const light = {isLight: true, castShadow: false, shadow: {mapSize: {x: 512, y: 512, set(x, y) { this.x = x; this.y = y; }}}};
  const meshA = {material: {needsUpdate: false}}, meshB = {material: [{needsUpdate: false}, null]};
  const scene = {traverse(visit) { [light, meshA, meshB].forEach(visit); }};
  const {q, renderer} = make({scene: () => scene});
  assert.equal(light.shadow.mapSize.x, 1024);
  assert.equal(meshA.material.needsUpdate, false, 'no switch, no rebuild');
  q.set('low');
  assert.equal(renderer.shadowMap.enabled, false);
  assert.equal(meshA.material.needsUpdate, true); assert.equal(meshB.material[0].needsUpdate, true);
  meshA.material.needsUpdate = false;
  q.set('high');
  assert.equal(renderer.shadowMap.enabled, true); assert.equal(meshA.material.needsUpdate, true);
  assert.equal(light.shadow.mapSize.x, 2048); assert.equal(light.shadow.mapSize.y, 2048);
});

test('works without a renderer, and webglAvailable() is false outside a browser', () => {
  const q = createQuality(null);
  run(q, 4, 60);
  assert.equal(run(q, 3.5, 20), 'low');
  assert.equal(q.settings.pixelRatio, 0.67);
  assert.equal(webglAvailable(), false);
});
