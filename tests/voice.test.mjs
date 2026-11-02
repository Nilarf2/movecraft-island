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
