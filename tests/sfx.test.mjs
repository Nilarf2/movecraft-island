import test from 'node:test';
import assert from 'node:assert/strict';
import {createSfx, SFX_NAMES, PENTATONIC_MIDI, DEDUPE_MS, MAX_VOICES, DUCK, midiHz, scaleIndex, scaleHz,
  duckEnvelope, createDeduper, createVoicePool, seededRandom, softClipCurve, CLIP_RANGE} from '../web/stage/sfx.js';

// ---- 假的 AudioContext：只记录调用，时间由测试手动推进 ----
class FakeParam {
  constructor(value = 0) { this._value = value; this.events = []; }
  get value() { return this._value; }
  set value(v) { this._value = v; this.events.push({type: 'value', value: v}); }
  setValueAtTime(value, time) { this.events.push({type: 'set', value, time}); return this; }
  linearRampToValueAtTime(value, time) { this.events.push({type: 'linear', value, time}); return this; }
  exponentialRampToValueAtTime(value, time) {
    // 和浏览器一样：目标值为 0 或负数会抛错。
    if (!(value > 0) && !(value < 0)) throw new RangeError('exponential ramp to 0');
    this.events.push({type: 'exp', value, time}); return this;
  }
  setTargetAtTime(value, time, constant) { this.events.push({type: 'target', value, time, constant}); return this; }
  cancelScheduledValues(time) { this.events = this.events.filter(e => e.time === undefined || e.time < time); this.events.push({type: 'cancel', time}); return this; }
  last(type) { return [...this.events].reverse().find(e => !type || e.type === type); }
}

class FakeNode {
  constructor(ctx, kind) { this.ctx = ctx; this.kind = kind; this.outputs = new Set(); this.disconnected = false; ctx.nodes.push(this); }
  connect(target) {
    assert.ok(target, `${this.kind}.connect 收到空目标`);
    this.outputs.add(target);
    if (target instanceof FakeNode) target.inputs.add(this);
    return target;
  }
  disconnect() { for (const t of this.outputs) if (t instanceof FakeNode) t.inputs.delete(this); this.outputs.clear(); this.disconnected = true; }
  get inputs() { return (this._inputs ??= new Set()); }
}

class FakeSource extends FakeNode {
  constructor(ctx, kind) { super(ctx, kind); this.started = null; this.stops = []; this.onended = null; this.ended = false; }
  start(time = 0) {
    if (this.started !== null) throw new Error('InvalidStateError: start twice');
    this.started = time;
  }
  stop(time = 0) {
    if (this.started === null) throw new Error('InvalidStateError: stop before start');
    this.stops.push(time);
  }
  get stopAt() { return this.stops.length ? this.stops[this.stops.length - 1] : Infinity; }
  fire() { if (!this.ended) { this.ended = true; this.onended?.(); } }
}

class FakeContext {
  constructor({state = 'running', sampleRate = 48000} = {}) {
    this.state = state; this.sampleRate = sampleRate; this.currentTime = 0; this.nodes = []; this.resumes = 0;
    this.destination = new FakeNode(this, 'destination');
  }
  resume() { this.resumes++; this.state = 'running'; return Promise.resolve(); }
  createGain() { const n = new FakeNode(this, 'gain'); n.gain = new FakeParam(1); return n; }
  createBiquadFilter() {
    const n = new FakeNode(this, 'biquad'); n.type = 'lowpass';
    n.frequency = new FakeParam(350); n.Q = new FakeParam(1); n.gain = new FakeParam(0); return n;
  }
  createStereoPanner() { const n = new FakeNode(this, 'panner'); n.pan = new FakeParam(0); return n; }
  createWaveShaper() { const n = new FakeNode(this, 'shaper'); n.curve = null; n.oversample = 'none'; return n; }
  createDynamicsCompressor() { throw new Error('不应该再用压缩器'); }
  createOscillator() {
    const n = new FakeSource(this, 'osc'); n.type = 'sine';
    n.frequency = new FakeParam(440); n.detune = new FakeParam(0); return n;
  }
  createBufferSource() { const n = new FakeSource(this, 'buffer'); n.buffer = null; n.loop = false; n.playbackRate = new FakeParam(1); return n; }
  createBuffer(channels, length, sampleRate) {
    const data = Array.from({length: channels}, () => new Float32Array(length));
    return {numberOfChannels: channels, length, sampleRate, duration: length / sampleRate, getChannelData: c => data[c]};
  }
  // 推进时间，并让已经到停止时间的声源触发 onended（像真的 context 一样）。
  advance(seconds) {
    this.currentTime += seconds;
    for (const n of this.nodes) if (n instanceof FakeSource && n.started !== null && n.stopAt <= this.currentTime) n.fire();
  }
  sources() { return this.nodes.filter(n => n instanceof FakeSource); }
}

// 从扬声器往回找：destination ← shaper ← drive ← duck ← master ← bus / ambBus
const upstream = node => [...node.inputs][0];
function chain(ctx) {
  const shaper = upstream(ctx.destination), drive = upstream(shaper), duck = upstream(drive), master = upstream(duck);
  return {shaper, drive, duck, master};
}
const make = (opts = {}) => {
  const ctx = new FakeContext(opts);
  const sfx = createSfx({context: ctx, random: seededRandom(1), environment: {}});
  return {ctx, sfx};
};

// ---- 没有 AudioContext：全部空操作 ----
test('没有 AudioContext 时所有方法都是空操作，不报错', async () => {
  for (const sfx of [createSfx(), createSfx({environment: {}}), createSfx({environment: {AudioContext: undefined}})]) {
    assert.equal(sfx.available, false);
    assert.equal(sfx.context, null);
    assert.equal(await sfx.unlock(), false);
    for (const name of [...SFX_NAMES, 'nope', undefined]) assert.equal(sfx.play(name, {pitch: 0.5, gain: 2}), false);
    assert.equal(sfx.play('rep', null), false);
    assert.equal(sfx.ambient(true), false);
    assert.equal(sfx.ambient(false), false);
    assert.doesNotThrow(() => { sfx.setVolume(0.3); sfx.setVolume('x'); sfx.mute(true); sfx.mute(); sfx.duck(true); sfx.duck(false); });
    const stats = sfx.stats();
    assert.equal(stats.available, false);
    assert.equal(stats.voices, 0);
    assert.equal(stats.played, 0);
  }
});

test('AudioContext 构造失败时也退化成空操作', async () => {
  const sfx = createSfx({AudioContextClass: class { constructor() { throw new Error('no device'); } }, environment: {}});
  assert.equal(await sfx.unlock(), false);
  assert.equal(sfx.play('rep'), false);
  assert.equal(sfx.available, false);
  assert.doesNotThrow(() => { sfx.ambient(true); sfx.duck(true); sfx.mute(true); sfx.setVolume(0.5); });
});

// ---- 纯逻辑 ----
test('rep 的音高沿五声音阶单调上行', () => {
  assert.deepEqual([0, 0.124, 0.125, 0.5, 0.99, 1].map(p => scaleIndex(p)), [0, 0, 1, 4, 7, 8]);
  assert.deepEqual([-1, 2, NaN, undefined, 'x', '0.5'].map(p => scaleIndex(p)), [0, 8, 0, 0, 0, 4]);
  for (let count = 1; count < 10; count++) assert.ok(scaleIndex(count / 10) <= scaleIndex((count + 1) / 10));
  assert.ok(Math.abs(scaleHz(0) - 523.25) < 0.01);
  assert.ok(Math.abs(scaleHz(1) - 1567.98) < 0.01);
  assert.ok(Math.abs(midiHz(69) - 440) < 1e-9);
  // 只用 C D E G A 五个音
  assert.ok(PENTATONIC_MIDI.every(m => [0, 2, 4, 7, 9].includes(m % 12)));
});

test('duck 的包络：200 ms 压到 35%，600 ms 回到 100%', () => {
  assert.deepEqual(DUCK, {level: 0.35, attack: 0.2, release: 0.6});
  assert.deepEqual(duckEnvelope(true), {target: 0.35, duration: 0.2});
  assert.deepEqual(duckEnvelope(false), {target: 1, duration: 0.6});
});

test('去重：同名 40 ms 内只算第一次，不同名互不影响', () => {
  const allow = createDeduper(DEDUPE_MS);
  assert.deepEqual([[0, 'a'], [39.9, 'a'], [0, 'b'], [40, 'a'], [60, 'a'], [100, 'a']].map(([t, n]) => allow(n, t)),
    [true, false, true, true, false, true]);
});

test('声部池：满了挤掉最早的，过期的自动清掉', () => {
  const pool = createVoicePool(3), v = (end, done = false) => ({end, done});
  const voices = [v(1), v(2), v(3), v(4)];
  assert.deepEqual(pool.admit(voices[0], 0), []);
  pool.admit(voices[1], 0); pool.admit(voices[2], 0);
  assert.deepEqual(pool.admit(voices[3], 0), [voices[0]]);
  assert.equal(pool.size, 3);
  assert.equal(pool.prune(2.5), 2);
  voices[3].done = true;
  assert.equal(pool.prune(2.5), 1);
  assert.equal(MAX_VOICES, 12);
});

test('限幅曲线：0.7 以下不改变，峰值不超过 0.88，单调', () => {
  const curve = softClipCurve(), n = curve.length;
  const at = x => curve[Math.round(((x / CLIP_RANGE) + 1) / 2 * (n - 1))];
  for (const x of [0, 0.1, -0.3, 0.5, 0.69]) assert.ok(Math.abs(at(x) - x) < 0.002, `x=${x}`);
  assert.ok(Math.max(...curve) <= 0.88 && Math.min(...curve) >= -0.88);
  assert.ok(at(1) > 0.8 && at(1) < 0.88);
  for (let i = 1; i < n; i++) assert.ok(curve[i] >= curve[i - 1]);
});

// ---- 混音：duck 和 mute ----
test('duck(true) 200 ms 内压到 0.35，duck(false) 从当前值 600 ms 回到 1', () => {
  const {ctx, sfx} = make();
  const {duck, master} = chain(ctx);
  assert.equal(duck.kind, 'gain');
  sfx.duck(true);
  assert.deepEqual(duck.gain.last('linear'), {type: 'linear', value: 0.35, time: 0.2});
  assert.equal(sfx.stats().ducked, true);
  const before = duck.gain.events.length;
  sfx.duck(true);  // 同一个状态重复调用，不重新起斜坡
  assert.equal(duck.gain.events.length, before);
  ctx.currentTime = 0.1;  // 压到一半时松开：从 0.675 接着往回走，不跳变
  sfx.duck(false);
  const tail = duck.gain.events.slice(-3);
  assert.equal(tail[0].type, 'cancel');
  assert.equal(tail[1].type, 'set');
  assert.ok(Math.abs(tail[1].value - 0.675) < 1e-9);
  assert.equal(tail[1].time, 0.1);
  assert.equal(tail[2].type, 'linear');
  assert.equal(tail[2].value, 1);
  assert.ok(Math.abs(tail[2].time - 0.7) < 1e-9);
  // duck 不碰音量那一级
  assert.ok(!master.gain.events.some(e => e.type === 'linear'));
});

test('mute：音量级 50 ms 内到 0，静音时 play 不建节点，取消静音回到之前的音量', () => {
  const {ctx, sfx} = make();
  const {master} = chain(ctx);
  sfx.setVolume(0.6);
  assert.equal(master.gain.last('linear').value, 0.6);
  sfx.mute(true);
  assert.equal(master.gain.last('linear').value, 0);
  assert.ok(Math.abs(master.gain.last('linear').time - 0.05) < 1e-9);
  const nodes = ctx.nodes.length;
  assert.equal(sfx.play('rep'), false);
  assert.equal(ctx.nodes.length, nodes);
  sfx.setVolume(0.8);  // 静音期间改音量不出声
  assert.equal(master.gain.last('linear').value, 0);
  sfx.mute(false);
  assert.equal(master.gain.last('linear').value, 0.8);
  assert.equal(sfx.play('rep'), true);
  assert.deepEqual([sfx.stats().muted, sfx.stats().volume], [false, 0.8]);
  sfx.setVolume(5);
  assert.equal(sfx.stats().volume, 1);
});

// ---- 抢占和清理 ----
const voiceGainOf = (ctx, from) => ctx.nodes.slice(from).find(n => n.kind === 'gain');

test('同一种音效 40 ms 内重复触发会去重；之后再触发，旧的 40 ms 淡出并提前停掉', () => {
  const {ctx, sfx} = make();
  const mark1 = ctx.nodes.length;
  assert.equal(sfx.play('rep', {pitch: 0.1}), true);
  const first = ctx.nodes.slice(mark1), firstSources = first.filter(n => n instanceof FakeSource);
  assert.ok(firstSources.length >= 2);
  ctx.currentTime = 0.02;
  const mark2 = ctx.nodes.length;
  assert.equal(sfx.play('rep', {pitch: 0.2}), false);
  assert.equal(ctx.nodes.length, mark2, '去重时不建节点');
  assert.equal(sfx.stats().deduped, 1);
  ctx.currentTime = 0.1;
  assert.equal(sfx.play('rep', {pitch: 0.3}), true);
  assert.equal(sfx.stats().preempted, 1);
  const fade = voiceGainOf(ctx, mark1).gain.events.slice(-2);
  assert.deepEqual(fade, [{type: 'set', value: 1, time: 0.1}, {type: 'linear', value: 0, time: 0.14}]);
  for (const s of firstSources) assert.ok(Math.abs(s.stopAt - 0.145) < 1e-9, `${s.kind} stop ${s.stopAt}`);
  assert.equal(sfx.stats().voices, 2);
  ctx.advance(0.05);  // 到 0.15：旧声部的声源都结束了
  assert.ok(first.every(n => n.disconnected), '旧声部的节点全部断开');
  assert.ok(ctx.nodes.slice(mark2).every(n => !n.disconnected), '新声部还在响');
  assert.equal(sfx.stats().voices, 1);
});

test('连按 30 下 rep：同时最多两个声部（一个在淡出），全部结束后节点都断开', () => {
  const {ctx, sfx} = make();
  const mark = ctx.nodes.length;
  for (let i = 0; i < 30; i++) {
    assert.equal(sfx.play('rep', {pitch: i / 29}), true);
    assert.ok(sfx.stats().voices <= 2, `第 ${i} 下有 ${sfx.stats().voices} 个声部`);
    ctx.advance(0.05);
  }
  assert.equal(sfx.stats().preempted, 29);
  ctx.advance(5);
  const created = ctx.nodes.slice(mark);
  assert.ok(created.length > 30 * 3);
  assert.ok(created.every(n => n.disconnected), '所有声部的节点都断开了');
  assert.equal(sfx.stats().voices, 0);
  const bus = upstream(chain(ctx).master);
  assert.equal([...bus.inputs].length, 0, '总线上不再挂着旧声部');
});

test('声部上限 12：第 13 个不同的音效会挤掉最早的', () => {
  const {ctx, sfx} = make();
  const marks = [];
  for (const name of SFX_NAMES) { marks.push(ctx.nodes.length); assert.equal(sfx.play(name, {pitch: 0.5}), true); }
  assert.equal(SFX_NAMES.length, 13);
  assert.equal(sfx.stats().voices, MAX_VOICES);
  assert.equal(sfx.stats().stolen, 1);
  const oldest = ctx.nodes.slice(marks[0], marks[1]).filter(n => n instanceof FakeSource);
  assert.ok(oldest.every(s => s.stopAt < 0.06), '最早的声部被提前停掉');
  ctx.advance(3);
  assert.equal(sfx.stats().voices, 0);
});

// ---- 每个音效都能排出来 ----
test('每个音效都能播放，声源的起止时间合理，总长不超过 2 秒', () => {
  for (const name of SFX_NAMES) {
    for (const pitch of [0, 0.5, 1]) {
      const {ctx, sfx} = make();
      ctx.currentTime = 10;
      const mark = ctx.nodes.length;
      assert.equal(sfx.play(name, {pitch, gain: 1}), true, name);
      const sources = ctx.nodes.slice(mark).filter(n => n instanceof FakeSource);
      assert.ok(sources.length > 0, name);
      for (const s of sources) {
        assert.ok(s.started >= 10, `${name} 在过去起音`);
        assert.ok(Number.isFinite(s.stopAt) && s.stopAt > s.started, `${name} 没有停止时间`);
      }
      const length = Math.max(...sources.map(s => s.stopAt)) - 10;
      assert.ok(length <= 2.05, `${name} 长 ${length.toFixed(2)} 秒`);
      ctx.advance(3);
      assert.ok(ctx.nodes.slice(mark).every(n => n.disconnected), `${name} 结束后没清理干净`);
    }
  }
});

test('未知名字、坏参数不报错；不用压缩器', () => {
  const {ctx, sfx} = make();
  assert.equal(sfx.play('nope'), false);
  assert.equal(sfx.play('toString'), false);
  assert.equal(sfx.play('constructor'), false);
  assert.equal(sfx.stats().dropped, 3);
  assert.equal(sfx.play('coin', null), true);
  ctx.currentTime = 1;
  assert.equal(sfx.play('coin', {gain: 0}), false);
  assert.equal(sfx.play('uiMove', {pitch: NaN, gain: 'x'}), true);
  assert.equal(chain(ctx).shaper.kind, 'shaper');
  assert.ok(!ctx.nodes.some(n => n.kind === 'compressor'));
});

// ---- 解锁和环境声 ----
test('context 挂起时 play 不排音；unlock() 恢复后才响，之前要的环境声自动开始', async () => {
  const {ctx, sfx} = make({state: 'suspended'});
  assert.equal(sfx.play('rep'), false);
  assert.equal(sfx.ambient(true), true);
  assert.equal(sfx.stats().ambientPlaying, false);
  assert.equal(await sfx.unlock(), true);
  assert.equal(ctx.resumes, 1);
  assert.equal(sfx.stats().ambientPlaying, true);
  assert.equal(sfx.play('rep'), true);
  sfx.ambient(false);
});

test('不传 context 时，unlock() 再建；有过用户手势的页面不等 unlock()', async () => {
  let built = 0;
  class Ctx extends FakeContext { constructor() { super({state: 'running'}); built++; } }
  const lazy = createSfx({AudioContextClass: Ctx, environment: {}});
  assert.equal(lazy.available, true);
  assert.equal(lazy.stats().state, 'idle');
  assert.equal(lazy.play('rep'), false);
  assert.equal(built, 0);
  assert.equal(await lazy.unlock(), true);
  assert.equal(built, 1);
  assert.equal(lazy.play('rep'), true);
  assert.equal(await lazy.unlock(), true);
  assert.equal(built, 1, 'unlock() 可以重复调用');

  const active = createSfx({AudioContextClass: Ctx, environment: {navigator: {userActivation: {hasBeenActive: true}}}});
  assert.equal(active.play('uiSelect'), true);
  assert.equal(built, 2);
});

test('ambient：淡入，排好浪；关掉后淡出、停掉声源、清理节点', () => {
  const {ctx, sfx} = make();
  const mark = ctx.nodes.length;
  assert.equal(sfx.ambient(true), true);
  assert.equal(sfx.ambient(true), true);  // 重复打开不叠第二层
  const created = ctx.nodes.slice(mark);
  const loops = created.filter(n => n instanceof FakeSource && n.loop);
  assert.equal(loops.length, 2);
  const fade = created.find(n => n.kind === 'gain');
  assert.equal(fade.gain.last('linear').value, 1);
  const surf = created.filter(n => n.kind === 'gain')[1];
  assert.ok(surf.gain.events.filter(e => e.type === 'linear').length >= 2, '浪已经排进去');
  ctx.currentTime = 3;
  sfx.ambient(false);
  assert.equal(fade.gain.last('linear').value, 0);
  assert.ok(loops.every(s => s.stopAt <= 4.3));
  assert.equal(sfx.stats().ambientPlaying, false);
  ctx.advance(2);
  assert.ok(ctx.nodes.slice(mark).every(n => n.disconnected), '环境声的节点全部断开');
});
