// 大屏音效：全部用 WebAudio 实时合成，不加载任何音频文件。
// 用法：const sfx = createSfx();（context 可选，不传就在 unlock() 时自己建）
//   第一次 keydown / pointerdown 里调 sfx.unlock()，可以重复调；解锁前的 play() 直接丢弃。
//   sfx.play('rep', {pitch: count / target})，本关最后一下用 'repFinal'；倒计时最后一下 play('countdown', {pitch: 1})。
//   sfx.ambient(true) 随时可调，解锁后自动开始。旁白避让：new Narrator({onStateChange: s => sfx.duck(s.busy)})。
//   另有 setVolume(0–1)、mute(on)、stats()。试听页：web/sfx-lab.html。
// 没有 AudioContext（比如在 node 里）时，所有方法都是空操作。

export const SFX_NAMES = Object.freeze(['rep', 'repFinal', 'stageDone', 'shelterUp', 'roundDone', 'coin',
  'uiMove', 'uiSelect', 'uiBack', 'error', 'login', 'countdown', 'whoosh']);

// rep 的音高沿 C 大调五声音阶往上走：C5 D5 E5 G5 A5 C6 D6 E6 G6。repFinal 的和弦落在更高的 C7。
export const PENTATONIC_MIDI = Object.freeze([72, 74, 76, 79, 81, 84, 86, 88, 91]);
export const DEDUPE_MS = 40;
export const MAX_VOICES = 12;
export const DUCK = Object.freeze({level: 0.35, attack: 0.2, release: 0.6});

export const midiHz = midi => 440 * 2 ** ((midi - 69) / 12);
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const finite = (value, fallback) => (Number.isFinite(value) ? value : fallback);

// pitch 取 0–1，0 是音阶第一个音，1 是最后一个音；超出范围或不是数字时按边界或 0 处理。
export function scaleIndex(pitch, length = PENTATONIC_MIDI.length) {
  const p = clamp(finite(Number(pitch), 0), 0, 1);
  return Math.min(length - 1, Math.floor(p * (length - 1) + 1e-9));
}
export const scaleHz = pitch => midiHz(PENTATONIC_MIDI[scaleIndex(pitch)]);

// duck 的包络：on 时 attack 秒内压到 level，off 时 release 秒内回到 1。
export function duckEnvelope(on, {level, attack, release} = DUCK) {
  return on ? {target: level, duration: attack} : {target: 1, duration: release};
}

// 同名音效在 windowMs 内重复触发时只算第一次。
export function createDeduper(windowMs = DEDUPE_MS) {
  const last = new Map();
  return (name, nowMs) => {
    const previous = last.get(name);
    if (previous !== undefined && nowMs - previous >= 0 && nowMs - previous < windowMs) return false;
    last.set(name, nowMs);
    return true;
  };
}

// 声部池：超过上限时挤掉最早的声部，让最新的反馈一定能响。
export function createVoicePool(max = MAX_VOICES) {
  let voices = [];
  return {
    get size() { return voices.length; },
    prune(now) { voices = voices.filter(voice => !voice.done && voice.end > now); return voices.length; },
    admit(voice, now) {
      this.prune(now);
      const stolen = [];
      while (voices.length >= max) stolen.push(voices.shift());
      voices.push(voice);
      return stolen;
    },
    clear() { const all = voices; voices = []; return all; },
  };
}

// 可复现的随机数（mulberry32），离线渲染和测试用；默认用 Math.random。
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function noopSfx() {
  return {
    available: false,
    context: null,
    unlock: () => Promise.resolve(false),
    play: () => false,
    ambient: () => false,
    setVolume: () => {},
    mute: () => {},
    duck: () => {},
    stats: () => ({available: false, state: 'unavailable', voices: 0, ducked: false, muted: false, volume: 1,
      ambient: false, ambientPlaying: false, played: 0, deduped: 0, dropped: 0, stolen: 0, preempted: 0}),
  };
}

// ---- 合成工具 ----
const SILENT = 0.0001;

// 打击包络：线性起音，指数衰减到 -60 dB，最后线性收到 0，起止都不跳变。
function percEnv(param, t, peak, attack, decay) {
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + attack);
  param.exponentialRampToValueAtTime(Math.max(SILENT * 0.1, peak * 0.001), t + attack + decay);
  param.linearRampToValueAtTime(0, t + attack + decay + 0.02);
  return t + attack + decay + 0.02;
}

// 长音包络：起音、保持、指数释放。
function swellEnv(param, t, peak, attack, hold, release) {
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + attack);
  param.setValueAtTime(peak, t + attack + hold);
  param.exponentialRampToValueAtTime(Math.max(SILENT * 0.1, peak * 0.001), t + attack + hold + release);
  param.linearRampToValueAtTime(0, t + attack + hold + release + 0.02);
  return t + attack + hold + release + 0.02;
}

const shape = (param, t, peak, o) => (o.hold === undefined
  ? percEnv(param, t, peak, o.attack ?? 0.003, o.decay ?? 0.2)
  : swellEnv(param, t, peak, o.attack ?? 0.02, o.hold, o.release ?? 0.3));

// 末级限幅曲线：输入幅度 knee 以下完全线性，以上用 tanh 平滑压向 ceiling（0.88 ≈ -1.1 dBFS）。
// 曲线覆盖 ±range 的输入，WaveShaper 前面要乘 1/range；超过 ±range 才会被硬卡在曲线端点。
export function softClipCurve(n = 4096, knee = 0.7, ceiling = 0.88, range = 2) {
  const curve = new Float32Array(n), span = ceiling - knee;
  for (let i = 0; i < n; i++) {
    const x = ((i * 2) / (n - 1) - 1) * range, a = Math.abs(x);
    curve[i] = Math.sign(x) * (a <= knee ? a : knee + span * Math.tanh((a - knee) / span));
  }
  return curve;
}
export const CLIP_RANGE = 2;

function makeNoise(ctx, seconds, rand) {
  const buffer = ctx.createBuffer(1, Math.max(1, Math.round(ctx.sampleRate * seconds)), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = rand() * 2 - 1;
  return buffer;
}

// 一次 play() 用一个 kit：所有节点都接到这个声部的增益上，记下声源，方便抢占和清理。
function createKit(ctx, out, noiseBuffer, rand) {
  const sources = [];
  let end = 0;
  const begin = (source, t, stopAt, offset) => {
    if (offset === undefined) source.start(t); else source.start(t, offset);
    source.stop(stopAt + 0.02);
    sources.push(source);
    end = Math.max(end, stopAt + 0.02);
  };
  const route = (node, o, t, stopAt) => {
    if ((!o.pan && o.panTo === undefined) || typeof ctx.createStereoPanner !== 'function') { node.connect(out); return; }
    const panner = ctx.createStereoPanner();
    panner.pan.setValueAtTime(clamp(o.pan || 0, -1, 1), t);
    if (o.panTo !== undefined) panner.pan.linearRampToValueAtTime(clamp(o.panTo, -1, 1), stopAt);
    node.connect(panner);
    panner.connect(out);
  };
  const sweep = (param, t, points) => {
    param.setValueAtTime(points[0][1], t + points[0][0]);
    for (const [dt, value] of points.slice(1)) param.exponentialRampToValueAtTime(value, t + dt);
  };
  const filter = (type, freq, q) => {
    const node = ctx.createBiquadFilter();
    node.type = type; node.frequency.value = freq; node.Q.value = q;
    return node;
  };
  const amp = () => { const node = ctx.createGain(); node.gain.value = 0; return node; };

  const kit = {
    sources,
    get end() { return end; },
    // 振荡器音：可选滑音、低通扫频、颤音、声像。
    tone(t, o) {
      const osc = ctx.createOscillator(), gain = amp();
      osc.type = o.type || 'sine';
      osc.frequency.setValueAtTime(o.freq, t);
      if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t + (o.glide ?? 0.1));
      if (o.detune) osc.detune.value = o.detune;
      const stopAt = shape(gain.gain, t, o.peak, o);
      let head = osc;
      if (o.lowpass) {
        const lp = filter('lowpass', o.lowpass, o.q ?? 0.7);
        if (o.sweep) sweep(lp.frequency, t, o.sweep);
        osc.connect(lp); head = lp;
      }
      if (o.vibrato) {
        const lfo = ctx.createOscillator(), depth = ctx.createGain();
        lfo.frequency.value = o.vibrato;
        depth.gain.setValueAtTime(0, t);
        depth.gain.linearRampToValueAtTime(o.vibratoCents ?? 12, t + 0.25);
        lfo.connect(depth); depth.connect(osc.detune);
        begin(lfo, t, stopAt);
      }
      head.connect(gain);
      route(gain, o, t, stopAt);
      begin(osc, t, stopAt);
      return stopAt;
    },
    // 滤波噪声：敲击的「嚓」、风声、浪声。
    noise(t, o) {
      const src = ctx.createBufferSource(), gain = amp();
      src.buffer = noiseBuffer; src.loop = true;
      const f = filter(o.filter || 'bandpass', o.freq, o.q ?? 1);
      if (o.sweep) sweep(f.frequency, t, o.sweep);
      const stopAt = shape(gain.gain, t, o.peak, o);
      src.connect(f); f.connect(gain);
      route(gain, o, t, stopAt);
      begin(src, t, stopAt, rand() * Math.max(0, noiseBuffer.duration - 0.5));
      return stopAt;
    },
    // 两算子 FM：铃声。调制深度随时间衰减，泛音越来越少。
    fm(t, o) {
      const carrier = ctx.createOscillator(), mod = ctx.createOscillator(), depth = ctx.createGain(), gain = amp();
      carrier.frequency.value = o.freq;
      mod.frequency.value = o.freq * (o.ratio ?? 2);
      const deviation = o.freq * (o.index ?? 1);
      depth.gain.setValueAtTime(deviation, t);
      depth.gain.exponentialRampToValueAtTime(Math.max(0.5, deviation * 0.04), t + (o.decay ?? 0.4) * 0.7 + 0.01);
      mod.connect(depth); depth.connect(carrier.frequency);
      const stopAt = shape(gain.gain, t, o.peak, o);
      carrier.connect(gain);
      route(gain, o, t, stopAt);
      begin(carrier, t, stopAt); begin(mod, t, stopAt);
      return stopAt;
    },
  };
  return kit;
}

// ---- 音色配方：每个函数在 kit 上从时间 t 开始排好一个音效，g 是 play() 传进来的 gain ----
const hz = midiHz;

// 木琴：FM（调制比 4，出 3 倍和 5 倍泛音）给敲击的亮音，调制深度衰减后只剩基音；一小段高频噪声当槌头的「嗒」。
// 不再叠同频正弦：Chrome 里它和 FM 载波的相位关系随音高变化，高音会互相抵消掉 7 dB。
function mallet(kit, t, freq, peak, o = {}) {
  kit.fm(t, {freq, ratio: 4, index: 1.2, peak: peak * 0.88, attack: 0.002, decay: o.decay ?? 0.4, pan: o.pan});
  kit.noise(t, {filter: 'highpass', freq: 3800, q: 0.7, peak: peak * 0.15, attack: 0.001, decay: 0.022, pan: o.pan});
}

const RECIPES = {
  // 每个动作一声，音高随进度沿五声音阶上行。
  rep(kit, t, g, pitch) {
    mallet(kit, t, scaleHz(pitch), 0.4 * g);
  },
  // 本关最后一下：C6 E6 G6 快速扫弦落到 C7，下面垫一个 C5。
  repFinal(kit, t, g) {
    [84, 88, 91, 96].forEach((m, i) => mallet(kit, t + i * 0.028, hz(m), 0.3 * g, {decay: 0.55, pan: (i - 1.5) * 0.18}));
    kit.tone(t, {freq: hz(72), type: 'triangle', peak: 0.16 * g, attack: 0.004, decay: 0.6});
  },
  // 一关完成：C5 E5 G5 C6 E6 上行琶音，接一个带颤音的亮长音 G6。
  stageDone(kit, t, g) {
    [72, 76, 79, 84, 88].forEach((m, i) => mallet(kit, t + i * 0.075, hz(m), 0.34 * g, {decay: 0.3, pan: (i - 2) * 0.15}));
    const s = t + 0.375;
    kit.tone(s, {freq: hz(91), type: 'sine', peak: 0.22 * g, attack: 0.03, hold: 0.32, release: 0.7, vibrato: 5.5, vibratoCents: 10});
    kit.tone(s, {freq: hz(79), type: 'sawtooth', peak: 0.08 * g, attack: 0.04, hold: 0.28, release: 0.6, lowpass: 2600, q: 0.5});
  },
  // 房子升级：两下木头敲击，再来一个温暖的 C 大三和弦。
  shelterUp(kit, t, g) {
    [0, 0.13].forEach((dt, i) => {
      kit.noise(t + dt, {filter: 'bandpass', freq: i ? 1150 : 900, q: 6, peak: 0.7 * g, attack: 0.001, decay: 0.07});
      kit.tone(t + dt, {freq: i ? 330 : 260, to: i ? 280 : 220, glide: 0.06, type: 'sine', peak: 0.38 * g, attack: 0.001, decay: 0.09});
    });
    const c = t + 0.26;
    [60, 64, 67, 72].forEach((m, i) => kit.tone(c + i * 0.02, {freq: hz(m), type: 'triangle', detune: (i % 2 ? 4 : -4),
      peak: 0.12 * g, attack: 0.05, hold: 0.25, release: 0.55, lowpass: 2400, pan: (i - 1.5) * 0.2}));
  },
  // 一轮完成：铜管味的「哒哒哒——哒」G4 C5 E5 G5，最后一个音上撒几声钟琴，总长 2 秒以内。
  roundDone(kit, t, g) {
    const notes = [[67, 0, 0.09], [72, 0.13, 0.09], [76, 0.26, 0.09], [79, 0.4, 0.48]];
    for (const [m, dt, hold] of notes) {
      for (const detune of [-6, 6]) {
        kit.tone(t + dt, {freq: hz(m), type: 'sawtooth', detune, peak: 0.1 * g, attack: 0.02, hold, release: 0.22,
          lowpass: 900, q: 0.8, sweep: [[0, 700], [0.05, 2600], [0.05 + hold, 1500]]});
      }
    }
    [91, 96, 100].forEach((m, i) => kit.fm(t + 0.42 + i * 0.09, {freq: hz(m), ratio: 3.5, index: 0.6, peak: 0.16 * g,
      attack: 0.002, decay: 0.7, pan: (i - 1) * 0.35}));
  },
  // 资源进账：B6 → E7 两声轻叮。
  coin(kit, t, g) {
    kit.fm(t, {freq: hz(95), ratio: 2, index: 0.4, peak: 0.12 * g, attack: 0.002, decay: 0.12});
    kit.fm(t + 0.06, {freq: hz(100), ratio: 2, index: 0.4, peak: 0.14 * g, attack: 0.002, decay: 0.3});
  },
  // 菜单移动：很轻的一下「嗒」，略往下滑。
  uiMove(kit, t, g) {
    kit.tone(t, {freq: 1320, to: 1180, glide: 0.03, type: 'sine', peak: 0.085 * g, attack: 0.002, decay: 0.05});
  },
  // 确认：E6 → A6 两个短音。
  uiSelect(kit, t, g) {
    kit.tone(t, {freq: hz(88), type: 'triangle', peak: 0.11 * g, attack: 0.003, decay: 0.07, lowpass: 5000});
    kit.tone(t + 0.055, {freq: hz(93), type: 'triangle', peak: 0.12 * g, attack: 0.003, decay: 0.14, lowpass: 5000});
  },
  // 返回：D6 往下滑到 G5。
  uiBack(kit, t, g) {
    kit.tone(t, {freq: hz(86), to: hz(79), glide: 0.09, type: 'triangle', peak: 0.11 * g, attack: 0.004, decay: 0.12, lowpass: 4000});
  },
  // 出错：G4 → E4 两个圆润的低音，低通滤掉毛刺，不刺耳。
  error(kit, t, g) {
    kit.tone(t, {freq: hz(67), type: 'triangle', peak: 0.2 * g, attack: 0.008, decay: 0.14, lowpass: 1200});
    kit.tone(t + 0.15, {freq: hz(64), type: 'triangle', peak: 0.22 * g, attack: 0.008, decay: 0.26, lowpass: 1000});
  },
  // 登录欢迎：G5 → C6 上行双音，第二个音长一点。
  login(kit, t, g) {
    mallet(kit, t, hz(79), 0.3 * g, {decay: 0.3});
    mallet(kit, t + 0.14, hz(84), 0.32 * g, {decay: 0.6});
    kit.tone(t + 0.14, {freq: hz(84), type: 'triangle', peak: 0.07 * g, attack: 0.03, hold: 0.12, release: 0.4});
  },
  // 倒计时：木鱼式的「嗒」。pitch ≥ 1 时（最后一下）高一个八度。
  countdown(kit, t, g, pitch) {
    const top = Number(pitch) >= 1, f = top ? 2400 : 1800;
    kit.noise(t, {filter: 'bandpass', freq: f, q: 8, peak: 0.6 * g, attack: 0.001, decay: 0.04});
    kit.tone(t, {freq: f, type: 'sine', peak: 0.16 * g, attack: 0.001, decay: 0.06});
  },
  // 镜头切换：带通噪声先升后降，从左扫到右，底下垫一层低通风声。
  whoosh(kit, t, g) {
    kit.noise(t, {filter: 'bandpass', freq: 400, q: 1.4, peak: 0.42 * g, attack: 0.22, hold: 0.06, release: 0.38,
      sweep: [[0, 350], [0.26, 2400], [0.68, 600]], pan: -0.6, panTo: 0.6});
    kit.noise(t, {filter: 'lowpass', freq: 500, q: 0.5, peak: 0.16 * g, attack: 0.25, hold: 0.05, release: 0.4});
  },
};

// 环境声里的鸟鸣：2–4 个很短的上滑正弦音。
function chirp(kit, t, rand, level) {
  const base = 2600 + rand() * 1400, pan = rand() * 1.4 - 0.7, n = 2 + Math.floor(rand() * 3);
  for (let i = 0; i < n; i++) {
    const s = t + i * (0.085 + rand() * 0.04), f = base * (1 + rand() * 0.12);
    kit.tone(s, {freq: f, to: f * (1.25 + rand() * 0.2), glide: 0.05, type: 'sine', peak: level * (0.7 + rand() * 0.3),
      attack: 0.006, decay: 0.07, pan});
  }
}

// 海浪的底：棕噪声，去掉首尾落差和直流，循环时接缝不出咔哒。
function brownNoise(ctx, seconds, rand) {
  const buffer = ctx.createBuffer(1, Math.max(1, Math.round(ctx.sampleRate * seconds)), ctx.sampleRate);
  const data = buffer.getChannelData(0), n = data.length;
  let last = 0, peak = 0, mean = 0;
  for (let i = 0; i < n; i++) { last = last * 0.995 + (rand() * 2 - 1) * 0.05; data[i] = last; }
  const drift = n > 1 ? (data[n - 1] - data[0]) / (n - 1) : 0;
  for (let i = 0; i < n; i++) { data[i] -= drift * i; mean += data[i] / n; }
  for (let i = 0; i < n; i++) { data[i] -= mean; peak = Math.max(peak, Math.abs(data[i])); }
  if (peak > 0) for (let i = 0; i < n; i++) data[i] /= peak;
  return buffer;
}

// ---- 引擎 ----
const LEAD = 0.005;          // 新音效比 currentTime 晚 5 ms 起，避免起音被截掉
const PREEMPT_FADE = 0.04;   // 被抢占或挤掉的声部 40 ms 内淡出
const AMBIENT_LEVEL = 0.5;   // 环境声总线的增益（浪声本身已经很低，见 startAmbient）

// 自己记住每个增益参数的直线斜坡，任何时刻都能算出当前值，不依赖浏览器读 AudioParam.value 的差异。
function createRamp(param, initial) {
  let from = initial, to = initial, t0 = 0, t1 = 0;
  param.value = initial;
  const valueAt = now => (now >= t1 || t1 <= t0 ? to : from + (to - from) * Math.max(0, (now - t0) / (t1 - t0)));
  return {
    valueAt,
    get target() { return to; },
    set(value, now, seconds) {
      const current = valueAt(now);
      param.cancelScheduledValues(now);
      param.setValueAtTime(current, now);
      if (seconds > 0) param.linearRampToValueAtTime(value, now + seconds); else param.setValueAtTime(value, now);
      from = current; to = value; t0 = now; t1 = now + Math.max(0, seconds);
    },
  };
}

// 包一层 context：记下这个声部建的所有节点，结束时统一 disconnect。
function trackingContext(ctx, nodes) {
  const wrap = name => (...args) => { const node = ctx[name](...args); nodes.push(node); return node; };
  return {
    get sampleRate() { return ctx.sampleRate; },
    createBuffer: (...args) => ctx.createBuffer(...args),
    createOscillator: wrap('createOscillator'),
    createGain: wrap('createGain'),
    createBiquadFilter: wrap('createBiquadFilter'),
    createBufferSource: wrap('createBufferSource'),
    createStereoPanner: typeof ctx.createStereoPanner === 'function' ? wrap('createStereoPanner') : undefined,
  };
}

const disconnectAll = nodes => { for (const node of nodes) { try { node.disconnect(); } catch { /* 已经断开 */ } } };

export function createSfx({context = null, AudioContextClass, random = Math.random, environment = globalThis} = {}) {
  const Ctor = AudioContextClass ?? environment.AudioContext ?? environment.webkitAudioContext;
  if (!context && typeof Ctor !== 'function') return noopSfx();

  let ctx = context, graph = null, broken = false, unlocked = context?.state === 'running', unlockPending = false;
  let volume = 1, muted = false, ducked = false, ambientWanted = false, amb = null;
  const dedupe = createDeduper(DEDUPE_MS), pool = createVoicePool(MAX_VOICES), latest = new Map();
  const counts = {played: 0, deduped: 0, dropped: 0, stolen: 0, preempted: 0};
  const offline = () => typeof environment.OfflineAudioContext === 'function' && ctx instanceof environment.OfflineAudioContext;
  const ready = () => Boolean(graph) && (offline() || ctx.state === 'running' || (unlockPending && ctx.state === 'suspended'));

  // 声部 → 总线 → 音量（含静音）→ duck → 限幅（软削峰）→ 扬声器
  // 不用 DynamicsCompressor：Chrome 里它在 context 启动后约 1 秒内多压 8–9 dB，对短促的打击音也压得不均匀，
  // 现场第一声会变小，离线测出来的电平也对不上。各音效的电平按配方定好，叠加过头时由限幅曲线兜底。
  function build() {
    if (graph || broken) return graph;
    try {
      if (!ctx) ctx = new Ctor();
      const shaper = ctx.createWaveShaper(), drive = ctx.createGain();
      shaper.curve = softClipCurve();
      drive.gain.value = 1 / CLIP_RANGE;
      const master = ctx.createGain(), duckGain = ctx.createGain(), bus = ctx.createGain(), ambBus = ctx.createGain();
      bus.gain.value = 1; ambBus.gain.value = AMBIENT_LEVEL;
      bus.connect(master); ambBus.connect(master); master.connect(duckGain); duckGain.connect(drive);
      drive.connect(shaper); shaper.connect(ctx.destination);
      graph = {bus, ambBus, drive, shaper, noise: makeNoise(ctx, 2, random), brown: brownNoise(ctx, 8, random),
        master: createRamp(master.gain, muted ? 0 : volume), duck: createRamp(duckGain.gain, ducked ? DUCK.level : 1)};
      // 别的代码把共用的 context 恢复了，也要把等着的环境声接上。
      ctx.addEventListener?.('statechange', () => { if (ctx.state === 'running') onRunning(); });
    } catch {
      broken = true; graph = null;
    }
    return graph;
  }

  // 页面已经有过用户手势时（navigator.userActivation），不等 unlock() 也可以直接建 context。
  const activated = () => Boolean(environment.navigator?.userActivation?.hasBeenActive);
  const autoStart = () => { if (!graph && !broken && (unlocked || activated())) { unlocked = true; build(); } return Boolean(graph); };

  function onRunning() {
    if (ambientWanted && !amb) startAmbient();
  }

  function unlock() {
    unlocked = true;
    if (!build()) return Promise.resolve(false);
    if (offline() || ctx.state === 'running') { onRunning(); return Promise.resolve(true); }
    if (ctx.state === 'closed' || typeof ctx.resume !== 'function') return Promise.resolve(false);
    // resume() 没有用户手势时会一直挂着；最多等 500 ms，之后的 play() 不再往冻住的时间线上排音。
    unlockPending = true;
    const pendingTimer = setTimeout(() => { unlockPending = false; }, 500);
    pendingTimer?.unref?.();
    let resumed;
    try { resumed = Promise.resolve(ctx.resume()); } catch (error) { resumed = Promise.reject(error); }
    return resumed.then(() => ctx.state === 'running', () => false).then(running => {
      clearTimeout(pendingTimer);
      unlockPending = false;
      if (running) onRunning();
      return running;
    });
  }

  // 一次 play() 一个声部：自己的增益节点 + kit 建的全部节点；所有声源都结束后统一 disconnect。
  function spawn(recipe, t, gain, pitch, out) {
    const nodes = [], voiceGain = ctx.createGain();
    nodes.push(voiceGain);
    voiceGain.gain.value = 1;
    voiceGain.connect(out);
    const kit = createKit(trackingContext(ctx, nodes), voiceGain, graph.noise, random);
    const voice = {name: '', start: t, end: t, done: false, released: false, gain: voiceGain, sources: kit.sources, nodes};
    voice.finish = () => { if (!voice.done) { voice.done = true; disconnectAll(nodes); } };
    try {
      recipe(kit, t, gain, pitch);
    } catch {
      for (const source of kit.sources) { try { source.stop(); } catch { /* 已经停了 */ } }
      voice.finish();
      return null;
    }
    voice.end = kit.end;
    let ended = 0;
    for (const source of kit.sources) source.onended = () => { if (++ended >= kit.sources.length) voice.finish(); };
    if (!kit.sources.length) voice.finish();
    return voice;
  }

  // 抢占或挤掉：40 ms 淡出，声源提前停，停下后由 onended 清理节点。
  function release(voice, now) {
    if (!voice || voice.done || voice.released || voice.end <= now + PREEMPT_FADE) return false;
    voice.released = true;
    const at = Math.max(now, voice.start);
    voice.gain.gain.setValueAtTime(1, at);
    voice.gain.gain.linearRampToValueAtTime(0, at + PREEMPT_FADE);
    for (const source of voice.sources) { try { source.stop(at + PREEMPT_FADE + 0.005); } catch { /* 已经停了 */ } }
    voice.end = at + PREEMPT_FADE + 0.005;
    return true;
  }

  function play(name, options) {
    const {pitch = 0, gain = 1} = options || {};
    const recipe = Object.prototype.hasOwnProperty.call(RECIPES, name) ? RECIPES[name] : null;
    if (!recipe) { counts.dropped++; return false; }
    autoStart();
    resumeQuietly();
    if (!ready() || muted) { counts.dropped++; return false; }
    const g = clamp(finite(Number(gain), 1), 0, 2);
    if (g <= 0) { counts.dropped++; return false; }
    const now = ctx.currentTime;
    if (!dedupe(name, now * 1000)) { counts.deduped++; return false; }
    if (release(latest.get(name), now)) counts.preempted++;
    const voice = spawn(recipe, now + LEAD, g, pitch, graph.bus);
    if (!voice) { counts.dropped++; return false; }
    voice.name = name;
    latest.set(name, voice);
    for (const old of pool.admit(voice, now)) if (release(old, now)) counts.stolen++;
    counts.played++;
    return true;
  }

  // 海浪：棕噪声过低通，浪头来时截止频率和音量一起抬起；高通白噪声做浪花的「沙」；偶尔一声鸟鸣。
  // 浪是一个接一个用 currentTime 排进去的（提前 4 秒），离线渲染时一次排满。
  function startAmbient() {
    if (amb || !ready()) return;
    const now = ctx.currentTime, fade = ctx.createGain(), surf = ctx.createGain(), foam = ctx.createGain();
    const lp = ctx.createBiquadFilter(), hp = ctx.createBiquadFilter();
    const low = ctx.createBufferSource(), high = ctx.createBufferSource();
    lp.type = 'lowpass'; lp.Q.value = 0.5; lp.frequency.value = 350;
    hp.type = 'highpass'; hp.Q.value = 0.5; hp.frequency.value = 3500;
    low.buffer = graph.brown; low.loop = true; high.buffer = graph.noise; high.loop = true;
    surf.gain.value = 0.05; foam.gain.value = 0;
    low.connect(lp); lp.connect(surf); surf.connect(fade);
    high.connect(hp); hp.connect(foam); foam.connect(fade);
    fade.connect(graph.ambBus);
    const state = {fade: createRamp(fade.gain, 0), surf, foam, lp, sources: [low, high],
      nodes: [fade, surf, foam, lp, hp, low, high], birds: new Set(), next: now + 0.1, timer: null, stopping: false};
    low.start(now, random() * 6); high.start(now, random() * 1.5);
    state.fade.set(1, now, 2.5);
    amb = state;
    scheduleWaves(state, offline() ? now + 600 : now + 4);
    if (!offline()) {
      state.timer = setInterval(() => scheduleWaves(state, ctx.currentTime + 4), 1000);
      state.timer?.unref?.();
    }
  }

  function scheduleWaves(state, until) {
    if (state.stopping) return;
    while (state.next < until) {
      const t = state.next, len = 5 + random() * 4, rise = len * (0.35 + random() * 0.15);
      const crest = 0.12 + random() * 0.08, trough = 0.035 + random() * 0.02, bright = 650 + random() * 500;
      state.surf.gain.linearRampToValueAtTime(crest, t + rise);
      state.surf.gain.linearRampToValueAtTime(trough, t + len);
      state.lp.frequency.linearRampToValueAtTime(bright, t + rise);
      state.lp.frequency.linearRampToValueAtTime(300 + random() * 80, t + len);
      state.foam.gain.setValueAtTime(0, t + rise * 0.7);
      state.foam.gain.linearRampToValueAtTime(crest * 0.05, t + rise + 0.25);
      state.foam.gain.linearRampToValueAtTime(0, t + rise + 1.6);
      if (random() < 0.3) addBird(state, t + rise + random() * 2);
      state.next = t + len;
    }
  }

  function addBird(state, t) {
    const voice = spawn((kit, at) => chirp(kit, at, random, 0.03), t, 1, 0, state.nodes[0]);
    if (!voice) return;
    state.birds.add(voice);
    const finish = voice.finish;
    voice.finish = () => { state.birds.delete(voice); finish(); };
  }

  function stopAmbient() {
    const state = amb;
    if (!state) return;
    amb = null; state.stopping = true;
    if (state.timer) clearInterval(state.timer);
    const now = ctx.currentTime, end = now + 1.2;
    state.fade.set(0, now, 1.2);
    for (const bird of state.birds) if (bird.start >= end) { for (const s of bird.sources) { try { s.stop(); } catch { /* */ } } }
    let ended = 0;
    const finish = () => { if (++ended >= state.sources.length) { disconnectAll(state.nodes); } };
    for (const source of state.sources) { source.onended = finish; try { source.stop(end + 0.05); } catch { finish(); } }
  }

  function ambient(on = true) {
    ambientWanted = Boolean(on);
    autoStart();
    if (!graph) return false;
    if (ambientWanted) startAmbient(); else stopAmbient();
    return true;
  }

  // 已解锁过但 context 又被挂起（比如系统打断）：后台试着恢复。这一声先不排，免得恢复时一起爆出来。
  function resumeQuietly() {
    if (!graph || !unlocked || unlockPending || offline() || ctx.state !== 'suspended' || typeof ctx.resume !== 'function') return;
    try { Promise.resolve(ctx.resume()).catch(() => {}); } catch { /* 下次再试 */ }
  }

  function setVolume(v) {
    volume = clamp(finite(Number(v), volume), 0, 1);
    if (graph && !muted) graph.master.set(volume, ctx.currentTime, 0.05);
  }

  function mute(on = true) {
    muted = Boolean(on);
    if (graph) graph.master.set(muted ? 0 : volume, ctx.currentTime, 0.05);
  }

  // duck(true)：200 ms 内压到 35%；duck(false)：600 ms 内回到 100%。重复调用同一个状态不重新起斜坡。
  function duck(on = true) {
    on = Boolean(on);
    if (on === ducked) return;
    ducked = on;
    if (!graph) return;
    const {target, duration} = duckEnvelope(on);
    graph.duck.set(target, ctx.currentTime, duration);
  }

  function stats() {
    if (graph) pool.prune(ctx.currentTime);
    return {available: !broken, state: ctx ? ctx.state : 'idle', voices: pool.size, ducked, muted, volume,
      ambient: ambientWanted, ambientPlaying: Boolean(amb), ...counts};
  }

  if (context) build();
  return {
    get available() { return !broken; },
    get context() { return ctx; },
    unlock, play, ambient, setVolume, mute, duck, stats,
  };
}
