import test from 'node:test';
import assert from 'node:assert/strict';
import {Narrator, VOICE_ASSETS} from '../web/voice.js';

function speechEnvironment() {
  const calls = [];
  const speechSynthesis = {
    speak(value) { calls.push(value); value.onstart?.(); },
    cancel() {}, getVoices() { return [{lang: 'zh-CN', name: 'Chinese'}]; },
  };
  return {environment: {speechSynthesis, SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } }}, calls};
}

test('recording slots are empty by default and unsupported speech completes safely', async () => {
  assert.deepEqual(VOICE_ASSETS, {});
  const voice = new Narrator({environment: {}});
  assert.deepEqual(await voice.speak('欢迎登岛'), {status: 'unavailable'});
});

test('Chinese synthesis resolves on completion and replaces stale speech', async () => {
  const {environment, calls} = speechEnvironment();
  const voice = new Narrator({environment});
  const old = voice.speak('第一个动作');
  const latest = voice.speak('完成竖直跳一次，继续加油');
  assert.deepEqual(await old, {status: 'cancelled'});
  assert.equal(calls[1].lang, 'zh-CN'); assert.equal(calls[1].voice.name, 'Chinese');
  calls[1].onend();
  assert.deepEqual(await latest, {status: 'ended'});
});

test('blocked or stalled voice cannot hold navigation indefinitely', async () => {
  const {environment} = speechEnvironment();
  environment.speechSynthesis.speak = () => {};
  const voice = new Narrator({environment, startTimeout: 10});
  assert.deepEqual(await voice.speak('规则'), {status: 'blocked'});
  const active = speechEnvironment();
  const stalled = new Narrator({...active, playbackTimeout: 10});
  assert.deepEqual(await stalled.speak('规则'), {status: 'timeout'});
});

test('correction messages are throttled and disabling resolves active and queued speech', async () => {
  const {environment, calls} = speechEnvironment();
  const voice = new Narrator({environment});
  const first = voice.speak('请让双脚入镜', {correction: true});
  assert.deepEqual(await voice.speak('请站远一点', {correction: true}), {status: 'throttled'});
  const queued = voice.speak('下一项', {replace: false});
  assert.equal(calls.length, 1);
  voice.setEnabled(false);
  assert.deepEqual(await first, {status: 'cancelled'});
  assert.deepEqual(await queued, {status: 'cancelled'});
  assert.deepEqual(await voice.speak('静音'), {status: 'skipped'});
});

test('optional queued speech runs sequentially and remains bounded', async () => {
  const {environment, calls} = speechEnvironment();
  const voice = new Narrator({environment});
  const first = voice.speak('开始');
  const dropped = voice.speak('一', {replace: false});
  const promises = [2, 3, 4].map(n => voice.speak(String(n), {replace: false}));
  assert.deepEqual(await dropped, {status: 'superseded'});
  calls[0].onend();
  assert.deepEqual(await first, {status: 'ended'});
  assert.equal(calls[1].text, '2');
  for (let i = 1; i <= 3; i++) calls[i].onend();
  assert.deepEqual(await Promise.all(promises), Array(3).fill({status: 'ended'}));
});

test('recorded clip uses manifest and failed clips fall back to synthesis', async () => {
  const {environment, calls} = speechEnvironment();
  const clips = [];
  environment.Audio = class {
    constructor(source) { this.source = source; clips.push(this); }
    play() { this.onplaying(); return Promise.resolve(); }
    pause() { this.paused = true; }
  };
  const voice = new Narrator({environment, assets: {rules: 'audio/rules.mp3'}});
  const recorded = voice.speak('简要规则', {key: 'rules'});
  assert.equal(clips[0].source, 'audio/rules.mp3'); assert.equal(calls.length, 0);
  clips[0].onended();
  assert.deepEqual(await recorded, {status: 'ended'});
  const fallback = voice.speak('简要规则', {key: 'rules'});
  clips[1].onerror();
  assert.equal(calls[0].text, '简要规则');
  calls[0].onend();
  assert.deepEqual(await fallback, {status: 'ended'});
});

test('fixed spoken text can directly reuse its recording key', async () => {
  const {environment, calls} = speechEnvironment();
  let clip;
  environment.Audio = class {
    constructor(source) { this.source = source; clip = this; }
    play() { this.onplaying(); return Promise.resolve(); }
    pause() {}
  };
  const text = '未获得摄像头权限。请重试。';
  const voice = new Narrator({environment, assets: {[text]: 'audio/camera-denied.mp3'}});
  const result = voice.speak(text, {key: text});
  assert.equal(clip.source, 'audio/camera-denied.mp3');
  clip.onended();
  assert.deepEqual(await result, {status: 'ended'});
  assert.deepEqual(calls, []);
});

test('reusable recorded segments play in order and cancellation stops the active segment', async () => {
  const {environment, calls} = speechEnvironment();
  const clips = [];
  environment.Audio = class {
    constructor(source) { this.source = source; clips.push(this); }
    play() { this.onplaying(); return Promise.resolve(); }
    pause() { this.paused = true; }
  };
  const voice = new Narrator({environment, assets: {'已完成': 'audio/done.mp3', '两': 'audio/two.mp3', '个。': 'audio/unit.mp3'}});
  const result = voice.speakParts([{text: '已完成'}, {text: '两'}, {text: '个。'}], {key: 'count'});
  assert.equal(voice.state.text, '已完成两个。');
  assert.equal(clips[0].source, 'audio/done.mp3');
  clips[0].onended();
  assert.equal(clips[1].source, 'audio/two.mp3');
  clips[1].onended();
  assert.equal(clips[2].source, 'audio/unit.mp3');
  voice.cancel();
  assert.deepEqual(await result, {status: 'cancelled'});
  assert.equal(clips[2].paused, true);
  assert.deepEqual(calls, []);
});

test('incomplete segment recordings use one complete synthesized fallback', async () => {
  const {environment, calls} = speechEnvironment();
  const clips = [];
  environment.Audio = class { constructor(source) { clips.push(source); } };
  const voice = new Narrator({environment, assets: {'固定片段': 'audio/fixed.mp3'}});
  const result = voice.speakParts([{text: '固定片段'}, {text: '十'}, {text: '次。'}]);
  assert.deepEqual(clips, []);
  assert.equal(calls[0].text, '固定片段十次。');
  calls[0].onend();
  assert.deepEqual(await result, {status: 'ended'});
});

test('a segment playback failure synthesizes only the remaining content', async () => {
  const {environment, calls} = speechEnvironment();
  const clips = [];
  environment.Audio = class {
    constructor(source) { this.source = source; clips.push(this); }
    play() { this.onplaying(); return Promise.resolve(); }
    pause() {}
  };
  const voice = new Narrator({environment, assets: {'前半句': 'audio/first.mp3', '后半句': 'audio/second.mp3'}});
  const result = voice.speakParts([{text: '前半句'}, {text: '后半句'}]);
  clips[0].onended();
  clips[1].onerror();
  assert.equal(calls[0].text, '后半句');
  calls[0].onend();
  assert.deepEqual(await result, {status: 'ended'});
});

test('rapid count groups preserve the current utterance and only queue the latest count', async () => {
  const {environment, calls} = speechEnvironment();
  const voice = new Narrator({environment});
  const first = voice.speak('完成一次', {key: 'count.jump.1', replace: false, group: 'count'});
  const second = voice.speak('完成两次', {replace: false, group: 'count'});
  const third = voice.speak('完成三次', {replace: false, group: 'count'});
  assert.deepEqual(await second, {status: 'superseded'});
  assert.equal(calls.length, 1); assert.equal(voice.state.queueLength, 1);
  assert.equal(voice.state.text, '完成一次');
  calls[0].onend();
  assert.deepEqual(await first, {status: 'ended'});
  assert.equal(calls.length, 2); assert.equal(calls[1].text, '完成三次');
  calls[1].onend();
  assert.deepEqual(await third, {status: 'ended'}); assert.equal(voice.busy, false);
});

test('state reports actual playback, completion and disabled state without trusting UI callbacks', async () => {
  const {environment, calls} = speechEnvironment();
  const states = [];
  const voice = new Narrator({environment, onStateChange(state) { states.push(state); }});
  const result = voice.speak('开始深蹲', {key: 'stage.squat'});
  assert.equal(voice.busy, true); assert.equal(voice.state.status, 'speaking');
  assert.ok(states.some(state => state.status === 'starting' && state.key === 'stage.squat'));
  calls[0].onend();
  await result;
  assert.equal(voice.state.status, 'idle'); assert.equal(voice.state.lastResult.status, 'ended');
  const snapshot = voice.state;
  snapshot.lastResult.status = 'changed';
  assert.equal(voice.state.lastResult.status, 'ended');
  voice.setEnabled(false);
  assert.equal(states.at(-1).status, 'disabled'); assert.equal(voice.state.busy, false);
  voice.onStateChange = () => { throw new Error('render failed'); };
  voice.setEnabled(true);
  const next = voice.speak('继续'); calls[1].onend();
  assert.deepEqual(await next, {status: 'ended'});
});

test('late audio callbacks after fallback cannot finish or alter the synthesized request', async () => {
  const {environment, calls} = speechEnvironment();
  let audio;
  environment.Audio = class {
    constructor() { audio = this; }
    play() { this.onplaying(); return Promise.resolve(); }
    pause() {}
  };
  const voice = new Narrator({environment, assets: {rules: 'audio/rules.mp3'}, startTimeout: 10});
  const result = voice.speak('规则介绍', {key: 'rules'});
  const oldEnd = audio.onended, oldPlaying = audio.onplaying, oldError = audio.onerror;
  oldError();
  oldEnd(); oldPlaying(); oldError();
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(calls.length, 1); assert.equal(voice.state.status, 'speaking');
  calls[0].onend();
  assert.deepEqual(await result, {status: 'ended'});
});

test('late callbacks from cancelled speech cannot start timers or terminate newer speech', async () => {
  const {environment, calls} = speechEnvironment();
  const voice = new Narrator({environment, playbackTimeout: 10});
  const first = voice.speak('旧页面');
  const oldStart = calls[0].onstart, oldEnd = calls[0].onend, oldError = calls[0].onerror;
  voice.cancel();
  assert.deepEqual(await first, {status: 'cancelled'});
  const latest = voice.speak('新页面');
  oldStart(); oldEnd(); oldError();
  assert.equal(voice.state.text, '新页面'); assert.equal(voice.busy, true);
  calls[1].onend();
  assert.deepEqual(await latest, {status: 'ended'});
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(voice.state.lastResult.status, 'ended');
});

test('clip cleanup exceptions and a rejected play promise fall back only once', async () => {
  const {environment, calls} = speechEnvironment();
  let audio, rejectPlay;
  environment.Audio = class {
    constructor() { audio = this; }
    play() { return new Promise((resolve, reject) => { rejectPlay = reject; }); }
    pause() { throw new Error('bad media implementation'); }
  };
  const voice = new Narrator({environment, assets: {rules: 'audio/rules.mp3'}});
  const result = voice.speak('规则', {key: 'rules'});
  audio.onerror(); rejectPlay(new Error('blocked'));
  await Promise.resolve();
  assert.equal(calls.length, 1);
  calls[0].onend();
  assert.deepEqual(await result, {status: 'ended'});
});

test('unavailable voice enumeration still uses the default Chinese language', async () => {
  const {environment, calls} = speechEnvironment();
  environment.speechSynthesis.getVoices = () => { throw new Error('temporarily unavailable'); };
  const voice = new Narrator({environment});
  const result = voice.speak('准备开始');
  assert.equal(calls[0].lang, 'zh-CN');
  calls[0].onend();
  assert.deepEqual(await result, {status: 'ended'});
});

test('a state listener can disable speech before playback without leaving a pending promise', async () => {
  const {environment, calls} = speechEnvironment();
  let voice;
  voice = new Narrator({environment, onStateChange(state) {
    if (state.status === 'starting') voice.setEnabled(false);
  }});
  assert.deepEqual(await voice.speak('取消'), {status: 'cancelled'});
  assert.equal(calls.length, 0); assert.equal(voice.state.status, 'disabled');
});
