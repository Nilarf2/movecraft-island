// MoveCraft 大屏小人：低多边形、平面着色，像照镜子一样跟着玩家动。
// 本模块不 import three。createAvatar(THREE, opts) 由调用方传入 THREE，其余导出都是纯函数或纯数据类，可以在 node 里测。
//
// 坐标约定（镜像测试见 tests/avatar.test.mjs）：
// - MediaPipe 的 left/right 指被拍者自己的左右。输入必须是未镜像的摄像头原始画面（app.js 就是这样送进 worker 的）。
//   被拍者正对镜头时，右肩 12 在图像左侧，x 比左肩 11 小；detector.js 的挥手判定也依赖这一点。
// - 2D landmarks：x 向右、y 向下，归一化到 [0, 1]；z 以髋中点为 0，越小越靠近镜头。
// - worldLandmarks：单位米，原点在髋中点，轴向与图像一致：x 向右、y 向下、z 远离镜头。
// - 小人本地坐标：+Y 向上，脸朝 +Z（调用方让 +Z 朝向镜头）。从镜头看过去 +X 在画面右侧，也是小人自己的左手一侧。
// - 映射是 X = s·x、Y = −y、Z = −z。mirror=true 时 s=−1，这是一次反射：玩家抬右手，小人在观众看来位于画面右侧（+X）的
//   那只手抬起（小人自己的左手），和照镜子一样。mirror=false 时 s=+1，是纯旋转：玩家右手驱动小人自己的右手。

export const LM = Object.freeze({nose: 0, earL: 7, earR: 8, shoulderL: 11, shoulderR: 12, elbowL: 13, elbowR: 14, wristL: 15, wristR: 16,
  hipL: 23, hipR: 24, kneeL: 25, kneeR: 26, ankleL: 27, ankleR: 28, heelL: 29, heelR: 30, toeL: 31, toeR: 32});
export const ACTIONS = Object.freeze(['idle', 'wave', 'jump', 'jack', 'raise', 'squat']);
export const PARTS = Object.freeze(['legs', 'arms', 'body']);
export const VISIBLE = 0.5;
export const STALE_MS = 600;
export const FLASH_MS = 150;
const USED = [0, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32];

// 设计单位下的骨架比例，脚底 y = 0。头大、四肢粗，3 米外看投影也能一眼分清手脚。
export const RIG = (() => {
  const r = {ankle: 0.06, shin: 0.17, thigh: 0.17, hipHalf: 0.068, hipDrop: 0.02, spine: 0.24, shoulderHalf: 0.155, neck: 0.03, headR: 0.15,
    upperArm: 0.145, forearm: 0.125, armR: 0.048, foreR: 0.044, handR: 0.054, thighR: 0.062, shinR: 0.054,
    torsoTop: 0.15, torsoBottom: 0.125, torsoDepth: 0.72, footFront: 0.088, footBack: 0.04, footHalf: 0.052, shoulderDrop: 0.035};
  r.hip = r.ankle + r.shin + r.thigh;              // 髋关节高度
  r.pelvis = r.hip + r.hipDrop;                    // 骨盆中心（躯干根部）
  r.shoulder = r.pelvis + r.spine;
  r.headY = r.shoulder + r.neck + r.headR;
  r.height = r.headY + 0.19;                       // 帽顶（含描边）
  return Object.freeze(r);
})();

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = x => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
const approach = (a, b, dt, tau) => a + (b - a) * (1 - Math.exp(-dt / tau));
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
const len = a => Math.hypot(a[0], a[1], a[2]);
export const norm = (a, fallback = [0, 1, 0]) => { const l = len(a); return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : fallback; };
// a 去掉沿 n 的分量后归一化；退化时返回 fallback。
const ortho = (a, n, fallback) => { const p = sub(a, scale(n, dot(a, n))); return len(p) > 1e-6 ? norm(p) : fallback; };
// 两个单位向量的归一化插值；接近反向时退回 b。
export const nlerp = (a, b, k) => { if (k <= 0) return a.slice(); if (k >= 1) return b.slice(); return norm(add(scale(a, 1 - k), scale(b, k)), b); };
const angleBetween = (a, b) => Math.acos(clamp(dot(norm(a), norm(b)), -1, 1));

// MediaPipe 坐标（米或任意等比单位，x 右、y 下、z 远离镜头）→ 小人本地坐标。
export const toAvatar = (p, mirror = true) => [(mirror ? -1 : 1) * p.x, -p.y, -p.z];

// 小人身上的两侧按本地 X 的正负区分："pos" 在 +X（从镜头看画面右侧），"neg" 在 −X。
// mirror=true：玩家右侧（MediaPipe 的 R）驱动 pos；mirror=false：玩家左侧驱动 pos。
const CHAIN = {L: {shoulder: 11, elbow: 13, wrist: 15, hip: 23, knee: 25, ankle: 27, heel: 29, toe: 31},
  R: {shoulder: 12, elbow: 14, wrist: 16, hip: 24, knee: 26, ankle: 28, heel: 30, toe: 32}};
export const chainFor = (side, mirror = true) => CHAIN[(side === 'pos') === mirror ? 'R' : 'L'];
export const SIDES = Object.freeze(['pos', 'neg']);

// 静止姿势（小人本地坐标，单位向量）。手臂略微张开，脚尖稍外八。
export const REST = Object.freeze({
  up: [0, 1, 0], side: [1, 0, 0], headUp: [0, 1, 0], headFwd: [0, 0, 1],
  pos: {upper: norm([0.2, -1, 0.02]), fore: norm([0.16, -1, 0.1]), thigh: [0, -1, 0], shin: [0, -1, 0], foot: norm([0.12, 0, 1])},
  neg: {upper: norm([-0.2, -1, 0.02]), fore: norm([-0.16, -1, 0.1]), thigh: [0, -1, 0], shin: [0, -1, 0], foot: norm([-0.12, 0, 1])},
});
export const BONES = Object.freeze(['up', 'side', 'headUp', 'headFwd',
  ...['pos', 'neg'].flatMap(s => ['upper', 'fore', 'thigh', 'shin', 'foot'].map(b => s + '.' + b))]);
const getBone = (pose, key) => { const i = key.indexOf('.'); return i < 0 ? pose[key] : pose[key.slice(0, i)][key.slice(i + 1)]; };
const setBone = (pose, key, v) => { const i = key.indexOf('.'); if (i < 0) pose[key] = v; else pose[key.slice(0, i)][key.slice(i + 1)] = v; };
export const clonePose = p => ({up: p.up.slice(), side: p.side.slice(), headUp: p.headUp.slice(), headFwd: p.headFwd.slice(), lift: p.lift || 0,
  pos: Object.fromEntries(Object.entries(p.pos).map(([k, v]) => [k, v.slice()])), neg: Object.fromEntries(Object.entries(p.neg).map(([k, v]) => [k, v.slice()]))});
export const blendPose = (a, b, k) => {
  const out = clonePose(a);
  for (const key of BONES) setBone(out, key, nlerp(getBone(a, key), getBone(b, key), k));
  out.lift = (a.lift || 0) * (1 - k) + (b.lift || 0) * k;
  return out;
};

// 由关键点（MediaPipe 坐标）求骨骼方向。pts[i] 是 {x, y, z}，vis[i] 是 0–1。
// 某段骨骼两端有一个不可见就给 null，交给 BoneTracker 保持或回到静止姿势。
export function measureBones(pts, vis, mirror = true) {
  const ok = i => pts[i] && Number.isFinite(pts[i].x) && Number.isFinite(pts[i].y) && Number.isFinite(pts[i].z) && (vis[i] ?? 0) >= VISIBLE;
  const P = i => toAvatar(pts[i], mirror);
  const out = {up: null, side: null, headUp: null, headFwd: null, pos: {}, neg: {}};
  const sPos = chainFor('pos', mirror), sNeg = chainFor('neg', mirror);
  const torsoOk = ok(sPos.shoulder) && ok(sNeg.shoulder) && ok(sPos.hip) && ok(sNeg.hip);
  if (torsoOk) {
    const sm = mid(P(sPos.shoulder), P(sNeg.shoulder)), hm = mid(P(sPos.hip), P(sNeg.hip));
    const up = norm(sub(sm, hm), null);
    // 左右轴取肩线和髋线的平均，转身时更稳。
    const across = add(sub(P(sPos.shoulder), P(sNeg.shoulder)), scale(sub(P(sPos.hip), P(sNeg.hip)), 0.6));
    if (up && up[1] > -0.2) {
      out.up = up;
      out.side = ortho(across, up, null);
    }
  }
  const upRef = out.up || REST.up;
  if (ok(LM.earL) && ok(LM.earR) && ok(LM.nose)) {
    const em = mid(P(LM.earL), P(LM.earR));
    if (torsoOk) {
      const sm = mid(P(sPos.shoulder), P(sNeg.shoulder));
      const hu = norm(sub(em, sm), null);
      if (hu && dot(hu, upRef) > 0.3) out.headUp = nlerp(upRef, hu, 0.6);
    }
    const hf = ortho(sub(P(LM.nose), em), out.headUp || upRef, null);
    if (hf && hf[2] > -0.2) out.headFwd = hf;
  }
  for (const side of SIDES) {
    const c = chainFor(side, mirror), o = out[side];
    o.upper = ok(c.shoulder) && ok(c.elbow) ? norm(sub(P(c.elbow), P(c.shoulder)), null) : null;
    o.fore = ok(c.elbow) && ok(c.wrist) ? norm(sub(P(c.wrist), P(c.elbow)), null) : null;
    o.thigh = ok(c.hip) && ok(c.knee) ? norm(sub(P(c.knee), P(c.hip)), null) : null;
    o.shin = ok(c.knee) && ok(c.ankle) ? norm(sub(P(c.ankle), P(c.knee)), null) : null;
    let foot = null;
    if (ok(c.heel) && ok(c.toe)) {
      const f = sub(P(c.toe), P(c.heel));
      // 脚的关键点噪声大：只要大致朝前的读数，而且压平。
      if (f[2] > 0.2 * len(f)) foot = norm([f[0], f[1] * 0.4, f[2]], null);
    }
    o.foot = foot;
  }
  return out;
}
// 缺失关节的回退：可见时跟随测量值；不可见时先保持上一次的方向 HOLD_S 秒，再按 RETURN_TAU 慢慢回到静止姿势。
export const HOLD_S = 0.35, RETURN_TAU = 0.45;
export class BoneTracker {
  constructor(rest = REST) { this.rest = rest; this.reset(); }
  reset() { this.pose = clonePose(this.rest); this.age = Object.fromEntries(BONES.map(k => [k, Infinity])); }
  // measured 来自 measureBones；dt 单位秒。返回当前姿势（内部对象，调用方不要改）。
  update(measured, dt) {
    for (const key of BONES) {
      const m = getBone(measured, key);
      if (m) { setBone(this.pose, key, m.slice()); this.age[key] = 0; continue; }
      this.age[key] += dt;
      if (this.age[key] > HOLD_S) setBone(this.pose, key, nlerp(getBone(this.pose, key), getBone(this.rest, key), 1 - Math.exp(-dt / RETURN_TAU)));
    }
    // 躯干左右轴要和上方向正交。
    this.pose.side = ortho(this.pose.side, this.pose.up, this.rest.side);
    return this.pose;
  }
}

// One Euro 滤波（Casiez 2012）。静止时强平滑，快速运动时降低延迟。t 单位秒。
export class OneEuro {
  constructor({minCutoff = 1.5, beta = 2, dCutoff = 1} = {}) { this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff; this.reset(); }
  reset() { this.x = null; this.dx = 0; this.t = null; }
  static alpha(cutoff, dt) { const r = 2 * Math.PI * cutoff * dt; return r / (r + 1); }
  filter(value, t) {
    if (!Number.isFinite(value)) return this.x ?? value;
    if (this.x === null || !Number.isFinite(t) || this.t === null) { this.x = value; this.dx = 0; this.t = t; return value; }
    const dt = t - this.t;
    if (!(dt > 0)) return this.x;
    this.t = t;
    const dx = (value - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (dx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }
}
export class PointFilter {
  constructor(opts) { this.f = [new OneEuro(opts), new OneEuro(opts), new OneEuro(opts)]; }
  reset() { this.f.forEach(f => f.reset()); }
  filter(p, t) { return {x: this.f[0].filter(p.x, t), y: this.f[1].filter(p.y, t), z: this.f[2].filter(p.z, t)}; }
}

// worldLandmarks 为空时的估算：2D 点以髋中点为原点，按躯干长度换成米，深度先取固定值 0，
// 再用骨长恢复被透视缩短的那部分：手臂、大腿默认向镜头前方伸，小腿从膝盖向后收（深蹲时膝盖在脚尖前）。
export const BODY_M = Object.freeze({torso: 0.5, shoulders: 0.34, upperArm: 0.29, forearm: 0.27, thigh: 0.43, shin: 0.42});
export function liftLandmarks2D(landmarks, aspect = 4 / 3) {
  const l = Array.isArray(landmarks) ? landmarks : [];
  const fin = i => l[i] && Number.isFinite(l[i].x) && Number.isFinite(l[i].y);
  if (![11, 12, 23, 24].every(fin)) return [];
  const xy = i => [l[i].x * aspect, l[i].y];
  const hm = [(xy(23)[0] + xy(24)[0]) / 2, (xy(23)[1] + xy(24)[1]) / 2];
  const sm = [(xy(11)[0] + xy(12)[0]) / 2, (xy(11)[1] + xy(12)[1]) / 2];
  const torso = Math.hypot(sm[0] - hm[0], sm[1] - hm[1]), shoulders = Math.hypot(xy(11)[0] - xy(12)[0], xy(11)[1] - xy(12)[1]);
  // 深蹲时躯干前倾会变短，转身时肩宽会变窄，取两者里较大的那个当尺子。
  const unit = Math.max(torso / BODY_M.torso, shoulders / BODY_M.shoulders);
  if (!(unit > 1e-4)) return [];
  const out = l.map((p, i) => fin(i) ? {x: (xy(i)[0] - hm[0]) / unit, y: (xy(i)[1] - hm[1]) / unit, z: 0, visibility: p.visibility ?? 0} : {x: 0, y: 0, z: 0, visibility: 0});
  const depth = (a, b, length, sign) => {
    const d = Math.hypot(out[b].x - out[a].x, out[b].y - out[a].y);
    out[b].z = out[a].z + sign * Math.sqrt(Math.max(0, length * length - d * d));
  };
  for (const c of [CHAIN.L, CHAIN.R]) {
    depth(c.shoulder, c.elbow, BODY_M.upperArm, -1);
    depth(c.elbow, c.wrist, BODY_M.forearm, -1);
    depth(c.hip, c.knee, BODY_M.thigh, -1);
    depth(c.knee, c.ankle, BODY_M.shin, +1);
    out[c.heel].z += out[c.ankle].z; out[c.toe].z += out[c.ankle].z - 0.12;
  }
  out[LM.nose].z = -0.1;
  return out;
}

// 跳跃高度：按 2D 画面里髋部的上移量估算，单位是「躯干长度」。只有髋和脚同时离开站立基线才算离地，
// 所以深蹲（髋下沉）、踮脚、走近镜头（躯干变长）都不会让小人飘起来。滤波只用于基线，离地量本身不做平滑，跳跃不会被吃掉。
export class JumpEstimator {
  constructor({deadzone = 0.03, max = 0.9} = {}) { this.deadzone = deadzone; this.max = max; this.reset(); }
  reset() { this.hip = null; this.foot = null; this.torso = null; this.lift = 0; }
  update(landmarks, aspect = 4 / 3) {
    const l = landmarks || [];
    const seen = i => l[i] && Number.isFinite(l[i].x) && Number.isFinite(l[i].y) && (l[i].visibility ?? 0) >= VISIBLE;
    if (![11, 12, 23, 24].every(seen) || !(seen(27) || seen(28))) { this.lift = 0; return 0; }
    const hip = (l[23].y + l[24].y) / 2;
    const foot = Math.max(seen(27) ? l[27].y : -Infinity, seen(28) ? l[28].y : -Infinity);
    const torso = Math.hypot(((l[11].x + l[12].x) - (l[23].x + l[24].x)) / 2 * aspect, ((l[11].y + l[12].y) - (l[23].y + l[24].y)) / 2);
    if (!(torso > 0.02)) { this.lift = 0; return 0; }
    if (this.hip === null) { this.hip = hip; this.foot = foot; this.torso = torso; this.lift = 0; return 0; }
    const ratio = torso / this.torso;
    const hipRise = (this.hip - hip) / torso, footRise = (this.foot - foot) / torso;
    const stable = ratio > 0.85 && ratio < 1.18;
    const grounded = !stable || footRise < 0.04;
    // 站在地上时基线快速跟随（含深蹲时的髋下沉）；离地时冻结。脚低于基线说明人走近了，立刻跟上。
    if (grounded) {
      const k = stable ? 0.25 : 0.5;
      this.hip += (hip - this.hip) * k; this.foot += (foot - this.foot) * k; this.torso += (torso - this.torso) * k;
    }
    if (foot > this.foot) this.foot = foot;
    this.lift = stable && !grounded ? clamp(Math.min(hipRise, footRise) - this.deadzone, 0, this.max) : 0;
    return this.lift;
  }
}
// 由骨骼方向和固定骨长摆出全部关节（设计单位，原点在两脚中点的地面上）。
// 最低的脚跟或脚尖放在 y = pose.lift，所以任何姿势下脚都不会穿进地面。
const JOINT_KEYS = ['shoulder', 'elbow', 'wrist', 'hand', 'hip', 'knee', 'ankle', 'sole', 'heel', 'toe'];
// 举过头顶的手臂向外让开帽檐：手臂越竖直越往外推，直到离竖直约 26°。向前伸的手臂不受影响。
const HAT_OUT = 0.44, HEAD_TILT_COS = Math.cos(20 * Math.PI / 180);
function clearHat(d, sign, up, side, fwd) {
  const u = dot(d, up), o = dot(d, side) * sign, f = dot(d, fwd);
  if (u <= 0.5 || o >= HAT_OUT) return d;
  const w = smooth((u - 0.5) / 0.35) * (1 - smooth((f - 0.35) / 0.3));
  if (w <= 0) return d;
  return norm(add(add(scale(side, sign * (o + (HAT_OUT - o) * w)), scale(up, u)), scale(fwd, f)), d);
}
export function buildSkeleton(pose, rig = RIG) {
  const up = norm(pose.up, [0, 1, 0]);
  const side = ortho(pose.side, up, [1, 0, 0]);
  const fwd = cross(side, up);
  const pelvis = [0, rig.pelvis, 0];
  const neck = add(pelvis, scale(up, rig.spine));
  // 头最多倾斜 20°：深蹲、弯腰时脸仍然朝前，帽子不会挡住脸。
  let headUp = norm(pose.headUp, up);
  if (headUp[1] < HEAD_TILT_COS) {
    const h = Math.hypot(headUp[0], headUp[2]) || 1, s = Math.sqrt(1 - HEAD_TILT_COS * HEAD_TILT_COS) / h;
    headUp = [headUp[0] * s, HEAD_TILT_COS, headUp[2] * s];
  }
  const headFwd = ortho(pose.headFwd, headUp, fwd);
  const head = add(neck, scale(headUp, rig.neck + rig.headR));
  const j = {pelvis, neck, head, up, side, fwd, headUp, headFwd, headSide: cross(headUp, headFwd)};
  for (const s of SIDES) {
    const sign = s === 'pos' ? 1 : -1, b = pose[s];
    const shoulder = add(add(neck, scale(side, sign * rig.shoulderHalf)), scale(up, -rig.shoulderDrop));
    const upper = clearHat(norm(b.upper, REST[s].upper), sign, up, side, fwd), fore = clearHat(norm(b.fore, REST[s].fore), sign, up, side, fwd);
    const elbow = add(shoulder, scale(upper, rig.upperArm));
    const wrist = add(elbow, scale(fore, rig.forearm));
    const hand = add(wrist, scale(fore, rig.handR * 0.8));
    const hip = add(add(pelvis, scale(side, sign * rig.hipHalf)), scale(up, -rig.hipDrop));
    const thigh = norm(b.thigh, [0, -1, 0]), shin = norm(b.shin, [0, -1, 0]);
    const knee = add(hip, scale(thigh, rig.thigh));
    const ankle = add(knee, scale(shin, rig.shin));
    let footFwd = norm(b.foot, REST[s].foot);
    // 脚掌大体保持水平，只随小腿倾斜一点。
    const roll = ortho(scale(shin, -1), footFwd, [0, 1, 0]);
    let footUp = norm(add([0, 0.65, 0], scale(roll, 0.35)), [0, 1, 0]);
    if (footUp[1] < 0.3) footUp = [0, 1, 0];
    footFwd = ortho(footFwd, footUp, [0, 0, 1]);
    const sole = add(ankle, scale(footUp, -rig.ankle));
    j[s] = {shoulder, elbow, wrist, hand, hip, knee, ankle, sole,
      heel: add(sole, scale(footFwd, -rig.footBack)), toe: add(sole, scale(footFwd, rig.footFront)),
      upper, fore, thigh, shin, footFwd, footUp, footSide: cross(footUp, footFwd)};
  }
  const minY = Math.min(j.pos.heel[1], j.pos.toe[1], j.neg.heel[1], j.neg.toe[1]);
  const fm = mid(j.pos.sole, j.neg.sole);
  const lift = Math.max(0, pose.lift || 0);
  const off = [-fm[0], lift - minY, -fm[2]];
  for (const k of ['pelvis', 'neck', 'head']) j[k] = add(j[k], off);
  for (const s of SIDES) for (const k of JOINT_KEYS) j[s][k] = add(j[s][k], off);
  j.lift = lift; j.offset = off;
  return j;
}

// ---- 示范动作（程序化，节奏约 1 秒一次）----
const D2R = Math.PI / 180;
// abd：在身体侧面离开躯干的角度（0 下垂、90 平举、180 举过头顶）；fwd：向前（+Z）抬起的角度，负值向后。
export function limbDir(sign, abd, fwd = 0) {
  const a = abd * D2R, f = fwd * D2R;
  return norm([sign * Math.sin(a) * Math.cos(f), -Math.cos(a) * Math.cos(f), Math.sin(f)]);
}
function makePose({lean = 0, roll = 0, nod = 0.04, turn = 0, lift = 0, breath = 0, arm = {}, leg = {}, armPos, armNeg, legPos, legNeg}) {
  const up = norm([Math.sin(roll), Math.cos(roll) * Math.cos(lean), Math.cos(roll) * Math.sin(lean)]);
  const p = {up, side: ortho([Math.cos(roll), -Math.sin(roll), 0], up, [1, 0, 0]), lift, breath, pos: {}, neg: {}};
  p.headUp = nlerp(up, [0, 1, 0], 0.5);
  p.headFwd = norm([Math.sin(turn), -Math.sin(nod), Math.cos(turn)]);
  for (const s of SIDES) {
    const sign = s === 'pos' ? 1 : -1;
    const a = {abd: 12, fwd: 3, elbow: 8, foreFwd: 8, ...arm, ...(s === 'pos' ? armPos : armNeg)};
    const g = {abd: 2, fwd: 0, shinAbd: null, shinBack: 0, toe: 0.13, ...leg, ...(s === 'pos' ? legPos : legNeg)};
    const o = p[s];
    o.upper = a.upper || limbDir(sign, a.abd, a.fwd);
    o.fore = a.fore || limbDir(sign, a.abd + a.elbow, a.fwd + a.foreFwd);
    o.thigh = limbDir(sign, g.abd, g.fwd);
    o.shin = limbDir(sign, g.shinAbd ?? g.abd, -g.shinBack);
    o.foot = norm([sign * g.toe, 0, 1]);
  }
  return p;
}
const phase = (t, period) => ((t % period) + period) % period / period;
const env = (p, a, b, c, d) => p < a ? 0 : p < b ? smooth((p - a) / (b - a)) : p < c ? 1 : p < d ? 1 - smooth((p - c) / (d - c)) : 0;
export const JUMP_DEMO_HEIGHT = 0.22;
// mirror 决定「玩家右手」在小人哪一侧：示范挥手和真人挥手看起来要一致。
export function demoPose(action, t, mirror = true) {
  const right = mirror ? 'pos' : 'neg', rs = right === 'pos' ? 1 : -1;
  const b = Math.sin(2 * Math.PI * t / 3.2), sw = Math.sin(2 * Math.PI * t / 4.8);
  const idle = {lean: 0.02 + 0.012 * b, roll: 0.035 * sw, nod: 0.05 + 0.025 * Math.sin(2 * Math.PI * t / 5.6), turn: 0.14 * Math.sin(2 * Math.PI * t / 7.2), breath: b,
    arm: {abd: 11 + 2.5 * b, elbow: 10}};
  if (action === 'wave') {
    const p = phase(t, 1.1), k = env(p, 0.05, 0.45, 0.58, 0.95);
    const yaw = 75 * k * D2R;
    const dir = [rs * Math.cos(yaw), 0.1 + 0.12 * k, Math.sin(yaw)];
    const fore = [rs * Math.cos(yaw * 0.85), 0.2 + 0.25 * k, Math.sin(yaw * 0.85)];
    return makePose({...idle, turn: 0, [right === 'pos' ? 'armPos' : 'armNeg']: {upper: norm(dir), fore: norm(fore)}});
  }
  if (action === 'jump') {
    const p = phase(t, 1);
    let d = 0, lift = 0, air = 0;
    if (p < 0.2) d = smooth(p / 0.2);
    else if (p < 0.28) d = 1 - smooth((p - 0.2) / 0.08);
    else if (p < 0.68) { const a = (p - 0.28) / 0.4; lift = 4 * a * (1 - a) * JUMP_DEMO_HEIGHT; air = Math.sin(Math.PI * a); }
    else if (p < 0.86) d = 0.6 * Math.sin(Math.PI * (p - 0.68) / 0.18);
    return makePose({lean: 0.3 * d, lift, nod: 0.05 - 0.1 * air,
      arm: {abd: 14 + 130 * air, fwd: -38 * d + 18 * air, elbow: 10 + 10 * d, foreFwd: 10},
      leg: {abd: 2 + 3 * air, fwd: 52 * d + 26 * air, shinBack: 46 * d + 38 * air}});
  }
  if (action === 'jack') {
    const p = phase(t, 1), o = smooth(0.5 - 0.5 * Math.cos(2 * Math.PI * p));
    const lift = 0.07 * Math.max(0, Math.cos(4 * Math.PI * (p - 0.25)));
    return makePose({lift, nod: 0.04 - 0.06 * o, arm: {abd: 10 + 158 * o, fwd: 4, elbow: 8 * (1 - o) + 10 * o, foreFwd: 6 * (1 - o)},
      leg: {abd: 2 + 18 * o, toe: 0.13 + 0.25 * o}});
  }
  if (action === 'raise') {
    const k = env(phase(t, 1), 0.06, 0.4, 0.6, 0.94);
    return makePose({...idle, turn: 0, roll: 0, arm: {abd: 11 + 81 * k, fwd: 3 - 3 * k, elbow: 10 * (1 - k), foreFwd: 8 * (1 - k)}});
  }
  if (action === 'squat') {
    const d = env(phase(t, 1.2), 0.06, 0.42, 0.58, 0.94);
    return makePose({lean: 0.42 * d, nod: 0.05 - 0.25 * d, arm: {abd: 12 - 8 * d, fwd: 3 + 77 * d, elbow: 8 * (1 - d), foreFwd: 8 * (1 - d)},
      leg: {abd: 2 + 6 * d, fwd: 78 * d, shinAbd: 2 + 2 * d, shinBack: 32 * d, toe: 0.13 + 0.12 * d}});
  }
  return makePose(idle);
}
// ---- 固定的 33 点测试姿态（截图、node 测试、键鼠试玩都可以用）----
// 世界坐标单位米，原点髋中点，x 向右（被拍者正对镜头时他的右侧在 −x）、y 向下、z 远离镜头。
// 2D 点按针孔相机投影：人离镜头 3 米，站立时全身约占画面高度的 72%。
export const SAMPLE_POSES = Object.freeze(['stand', 'armsUp', 'squat', 'jack', 'rightUp', 'jump']);
const POSE_DEFS = {
  stand: {shoulder: [0.17, 0.5, 0], elbow: [0.21, 0.22, 0], wrist: [0.23, -0.04, -0.03], hip: [0.1, 0, 0], knee: [0.11, -0.43, -0.01], ankle: [0.11, -0.85, 0]},
  armsUp: {elbow: [0.22, 0.78, 0], wrist: [0.25, 1.05, -0.02]},
  squat: {shoulder: [0.17, 0.44, -0.25], elbow: [0.18, 0.4, -0.53], wrist: [0.18, 0.38, -0.8], hip: [0.11, 0, 0], knee: [0.17, -0.12, -0.4], ankle: [0.16, -0.52, -0.25], head: [0, 0.69, -0.36]},
  jack: {elbow: [0.315, 0.751, 0], wrist: [0.45, 0.985, -0.02], knee: [0.211, -0.415, 0], ankle: [0.32, -0.82, 0]},
  rightUp: {rightElbow: [0.2, 0.79, 0], rightWrist: [0.22, 1.06, -0.02]},
  jump: {up: 0.15},
};
export function samplePose(name = 'stand', {aspect = 4 / 3, distance = 3, focal = 1.22, visibility = 0.98} = {}) {
  const d = {...POSE_DEFS.stand, head: [0, 0.75, 0], ...(POSE_DEFS[name] || {})};
  const Y = {}; // y 向上的临时坐标
  const sideOf = sign => (sign < 0 ? 'right' : 'left');
  const put = (i, p) => { Y[i] = p; };
  for (const sign of [1, -1]) {
    const c = sign > 0 ? CHAIN.L : CHAIN.R, s = sideOf(sign);
    const mir = v => [sign * v[0], v[1], v[2]];
    const pick = k => d[s + k[0].toUpperCase() + k.slice(1)] || d[k];
    for (const k of ['shoulder', 'elbow', 'wrist', 'hip', 'knee', 'ankle']) put(c[k], mir(pick(k)));
    const a = Y[c.ankle], w = Y[c.wrist];
    put(c.heel, [a[0], a[1] - 0.05, a[2] + 0.05]); put(c.toe, [a[0] + sign * 0.03, a[1] - 0.07, a[2] - 0.13]);
    const hand = sign > 0 ? [17, 19, 21] : [18, 20, 22];
    hand.forEach((i, k) => put(i, [w[0] + sign * (0.01 + 0.01 * k), w[1] + (Y[c.elbow][1] > w[1] ? -0.06 : 0.06), w[2] - 0.02]));
    put(sign > 0 ? LM.earL : LM.earR, [d.head[0] + sign * 0.075, d.head[1], d.head[2] + 0.02]);
    [1, 2, 3].forEach((k, j) => put(sign > 0 ? k : k + 3, [d.head[0] + sign * (0.015 + 0.02 * j), d.head[1] + 0.03, d.head[2] - 0.09]));
    put(sign > 0 ? 9 : 10, [d.head[0] + sign * 0.025, d.head[1] - 0.06, d.head[2] - 0.09]);
  }
  put(LM.nose, [d.head[0], d.head[1] - 0.01, d.head[2] - 0.11]);
  const minY = Math.min(...[29, 30, 31, 32].map(i => Y[i][1]));
  const lift = d.up || 0, floor = -0.92;
  const worldLandmarks = [], landmarks = [];
  for (let i = 0; i < 33; i++) {
    const p = Y[i] || [0, 0, 0];
    worldLandmarks.push({x: p[0], y: -p[1], z: p[2], visibility, presence: visibility});
    const gy = p[1] + (floor - minY) + lift + 0.03, depth = distance + p[2];
    landmarks.push({x: 0.5 + focal * p[0] / depth / aspect, y: 0.5 - focal * gy / depth, z: p[2] * focal / (distance * aspect), visibility, presence: visibility});
  }
  return {landmarks, worldLandmarks};
}
// ---- 外观 ----
// 配色：深一点的肤色和沙滩拉开；珊瑚色背心、钴蓝短裤、深色鞋，四肢和躯干颜色互相区分。
export const AVATAR_PALETTES = {
  day: {skin: '#d98a5c', skinDark: '#b8693f', hair: '#3a2418', hat: '#f2cf5b', hatDark: '#d9a93a', band: '#e2453a', vest: '#ff5a4e', vestDark: '#d63f3c',
    stripe: '#fff3d6', shorts: '#2864d8', shortsDark: '#1d4aa8', sock: '#ffffff', shoe: '#22314f', sole: '#f4efe4', band2: '#ffd23f', eye: '#1d1410', blush: '#f07a6a',
    outline: '#2a1c16', glow: '#fff2a8', shadow: '#2a3a20'},
};
AVATAR_PALETTES.sunset = {...AVATAR_PALETTES.day, skin: '#cf7f55', vest: '#ff6a4e', shorts: '#3a63c8', outline: '#2a1820', shadow: '#3a2030'};
AVATAR_PALETTES.deck = {...AVATAR_PALETTES.day, vest: '#f2ad78', vestDark: '#cc8260', shorts: '#2f8f78', shortsDark: '#22705e', outline: '#0e2226', shadow: '#0a2228'};
export const OUTLINE = 0.011;

// 一个 Part 收集若干个低多边形图元，合并成一个平面着色的 BufferGeometry（一个网格、一次绘制）。
// outline=true 的图元另外生成一层略大、反向绕序的外壳，形成卡通描边，不增加绘制次数。
function makeBuilder(THREE, colors) {
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler(), S = new THREE.Vector3(), P = new THREE.Vector3();
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3(), N = new THREE.Vector3();
  const color = name => colors[name] || (colors[name] = new THREE.Color(AVATAR_PALETTES.day[name] || '#ff00ff'));
  const flat = g => { const f = g.index ? g.toNonIndexed() : g; const a = Float32Array.from(f.getAttribute('position').array); g.dispose(); if (f !== g) f.dispose(); return a; };
  const shapes = {
    capsule: (r, h, t = 0) => flat(new THREE.CapsuleGeometry(r + t, h, 2, 7, 1).translate(0, h / 2, 0)),
    ball: (r, t = 0, d = 1) => flat(new THREE.IcosahedronGeometry(r + t, d)),
    box: (w, h, d, t = 0) => flat(new THREE.BoxGeometry(w + 2 * t, h + 2 * t, d + 2 * t)),
    cyl: (rt, rb, h, n = 8, t = 0) => flat(new THREE.CylinderGeometry(rt + t, rb + t, h + 2 * t, n, 2)),
  };
  class Part {
    constructor() { this.pos = []; this.col = []; }
    push(arr, {pos = [0, 0, 0], rot = [0, 0, 0], scl = [1, 1, 1], paint = 'skin', flip = false}) {
      E.set(rot[0], rot[1], rot[2], 'XYZ'); Q.setFromEuler(E); M.compose(P.set(pos[0], pos[1], pos[2]), Q, S.set(scl[0], scl[1], scl[2]));
      for (let i = 0; i < arr.length; i += 9) {
        A.fromArray(arr, i).applyMatrix4(M); B.fromArray(arr, i + 3).applyMatrix4(M); C.fromArray(arr, i + 6).applyMatrix4(M);
        N.subVectors(C, B).cross(P.subVectors(A, B)).normalize();
        const c = (A.y + B.y + C.y) / 3, cx = (A.x + B.x + C.x) / 3, cz = (A.z + B.z + C.z) / 3;
        const name = typeof paint === 'function' ? paint({x: cx, y: c, z: cz, n: N}) : paint;
        const k = color(name);
        const tri = flip ? [A, C, B] : [A, B, C];
        for (const v of tri) { this.pos.push(v.x, v.y, v.z); this.col.push(k.r, k.g, k.b); }
      }
      return this;
    }
    // kind: capsule | ball | box | cyl；args 是该图元的尺寸参数（不含描边厚度）。
    add(kind, args, o = {}) {
      this.push(shapes[kind](...args), o);
      if (o.outline) this.push(shapes[kind](...outlineArgs(kind, args, o.outline === true ? OUTLINE : o.outline)), {...o, paint: 'outline', flip: true});
      return this;
    }
    get triangles() { return this.pos.length / 9; }
    geometry() {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
      g.computeVertexNormals(); g.computeBoundingSphere();
      return g;
    }
  }
  return {Part, color};
}
// 描边外壳：把厚度加到半径或边长上。
function outlineArgs(kind, args, t) {
  if (kind === 'capsule') return [args[0], args[1], t];
  if (kind === 'ball') return [args[0], t, args[2] ?? 1];
  if (kind === 'box') return [args[0], args[1], args[2], t];
  return [args[0], args[1], args[2], args[3] ?? 8, t];
}
// 每个网格的造型。原点和朝向：头在头心（X=头的左右、Y=头顶、Z=脸朝向）；躯干在骨盆（X=左右、Y=上、Z=前）；
// 四肢在近端关节，+Y 指向远端关节；脚在脚底中心（Y=脚背、Z=脚尖）。
function buildParts(THREE, colors) {
  const {Part} = makeBuilder(THREE, colors);
  const r = RIG, P = {};
  const tilt = [-0.12, 0, 0];
  P.head = new Part()
    .add('ball', [r.headR], {scl: [1.04, 0.98, 1], outline: true, paint: ({y, z, n}) => (n.z < -0.2 && y > -0.07) || y > 0.075 ? 'hair' : 'skin'})
    .add('ball', [0.032, 0, 0], {pos: [0.152, -0.01, 0], scl: [0.6, 1, 0.9], paint: 'skin', outline: true})
    .add('ball', [0.032, 0, 0], {pos: [-0.152, -0.01, 0], scl: [0.6, 1, 0.9], paint: 'skin', outline: true})
    .add('ball', [0.022, 0, 0], {pos: [0.052, 0.0, 0.134], scl: [0.8, 1.3, 0.6], paint: 'eye'})
    .add('ball', [0.022, 0, 0], {pos: [-0.052, 0.0, 0.134], scl: [0.8, 1.3, 0.6], paint: 'eye'})
    .add('ball', [0.02, 0, 0], {pos: [0.088, -0.045, 0.108], scl: [1.2, 0.6, 0.45], paint: 'blush'})
    .add('ball', [0.02, 0, 0], {pos: [-0.088, -0.045, 0.108], scl: [1.2, 0.6, 0.45], paint: 'blush'})
    .add('box', [0.045, 0.012, 0.012], {pos: [0, -0.072, 0.126], paint: 'eye'})
    .add('cyl', [0.225, 0.225, 0.02, 10], {pos: [0, 0.1, -0.005], rot: tilt, paint: ({n}) => n.y < -0.5 ? 'hatDark' : 'hat', outline: true})
    .add('cyl', [0.115, 0.135, 0.08, 8], {pos: [0, 0.14, -0.012], rot: tilt, paint: 'hat', outline: true})
    .add('cyl', [0.137, 0.139, 0.026, 8], {pos: [0, 0.114, -0.01], rot: tilt, paint: 'band'});
  P.torso = new Part()
    .add('cyl', [r.torsoTop, r.torsoBottom, 0.2, 8], {pos: [0, 0.13, 0], rot: [0, Math.PI / 8, 0], scl: [1, 1, r.torsoDepth], outline: true,
      paint: ({n}) => n.z > 0.85 ? 'stripe' : 'vest'})
    .add('cyl', [0.045, 0.05, 0.06, 6], {pos: [0, 0.245, 0], paint: 'skin'})
    .add('cyl', [0.124, 0.152, 0.14, 8], {pos: [0, -0.03, 0], rot: [0, Math.PI / 8, 0], scl: [1, 1, 0.8], outline: true,
      paint: ({n}) => n.y < -0.5 ? 'shortsDark' : 'shorts'});
  const upper = () => new Part().add('capsule', [r.armR, r.upperArm], {outline: true, paint: ({y}) => y < r.upperArm * 0.3 ? 'vest' : 'skin'});
  const fore = () => new Part()
    .add('capsule', [r.foreR, r.forearm], {outline: true, paint: 'skin'})
    .add('cyl', [r.foreR + 0.008, r.foreR + 0.008, 0.026, 8], {pos: [0, r.forearm - 0.018, 0], paint: 'band2'})
    .add('ball', [r.handR], {pos: [0, r.forearm + r.handR * 0.8, 0], scl: [1, 1.05, 0.85], outline: true, paint: 'skin'});
  const thigh = () => new Part()
    .add('capsule', [r.thighR, r.thigh], {outline: true, paint: ({y}) => y < 0 ? 'shorts' : 'skin'})
    .add('cyl', [r.thighR + 0.012, r.thighR + 0.01, r.thigh * 0.42, 8], {pos: [0, r.thigh * 0.21, 0], outline: true, paint: ({n}) => n.y < -0.5 ? 'shortsDark' : 'shorts'});
  const shin = () => new Part()
    .add('capsule', [r.shinR, r.shin], {outline: true, paint: 'skin'})
    .add('cyl', [r.shinR + 0.006, r.shinR + 0.006, 0.04, 8], {pos: [0, r.shin - 0.012, 0], paint: 'sock'});
  const footLen = r.footFront + r.footBack + 0.02, footMid = (r.footFront - r.footBack) / 2;
  const foot = () => new Part()
    .add('box', [r.footHalf * 2, 0.07, footLen], {pos: [0, 0.047, footMid], outline: true, paint: 'shoe'})
    .add('box', [r.footHalf * 2 + 0.008, 0.016, footLen + 0.008], {pos: [0, 0.008, footMid], paint: 'sole'});
  for (const s of SIDES) { P[s + 'Upper'] = upper(); P[s + 'Fore'] = fore(); P[s + 'Thigh'] = thigh(); P[s + 'Shin'] = shin(); P[s + 'Foot'] = foot(); }
  return P;
}
export const PART_GROUPS = Object.freeze({
  body: ['head', 'torso'], arms: ['posUpper', 'posFore', 'negUpper', 'negFore'],
  legs: ['posThigh', 'posShin', 'posFoot', 'negThigh', 'negShin', 'negFoot'],
});
// ---- createAvatar ----
// 大屏页用法：
//   const avatar = createAvatar(THREE, {height: island.avatarHeight, palette: 'day', mirror: true});
//   island.scene.add(avatar.group); const a = island.anchor(zone); avatar.group.position.copy(a.position); avatar.group.rotation.y = a.facing;
//   pose-stream 的 onPose：avatar.setPose(landmarks, worldLandmarks, timestamp)；每帧 avatar.update(dt, t)，dt、t 单位秒。
// 小人本地 +Z 是脸的朝向，rotation.y = facing 后面朝 facing 方向。
export const JUMP_GAIN = 1.8;   // 真人跳 10–20 厘米，投影上要放大才看得清
export function createAvatar(THREE, {height = 1.8, palette = 'day', mirror = true, aspect = 4 / 3} = {}) {
  const pal = AVATAR_PALETTES[palette] || AVATAR_PALETTES.day;
  const colors = Object.fromEntries(Object.entries(pal).map(([k, v]) => [k, new THREE.Color(v)]));
  const P = buildParts(THREE, colors);
  const group = new THREE.Group(); group.name = 'avatar';
  const body = new THREE.Group(); body.name = 'avatar-body';
  const k = height / RIG.height; body.scale.setScalar(k); group.add(body);
  const mats = {}, meshes = {}, geometries = [];
  for (const [g, names] of Object.entries(PART_GROUPS)) {
    const m = new THREE.MeshLambertMaterial({vertexColors: true, flatShading: true});
    m.name = 'avatar-' + g; m.emissive.set(pal.glow); m.emissiveIntensity = 0; mats[g] = m;
    for (const n of names) {
      const geo = P[n].geometry(); geometries.push(geo);
      const mesh = new THREE.Mesh(geo, m); mesh.name = 'avatar-' + n; mesh.castShadow = false; mesh.receiveShadow = false;
      meshes[n] = mesh; body.add(mesh);
    }
  }
  // 地面上的软阴影：一个径向渐隐的圆盘，跳起时变小变淡。
  const blobGeo = new THREE.RingGeometry(0, 0.3, 16, 3);
  const bc = [], bp = blobGeo.getAttribute('position');
  for (let i = 0; i < bp.count; i++) { const rr = Math.hypot(bp.getX(i), bp.getY(i)) / 0.3; bc.push(1, 1, 1, Math.max(0, 1 - rr * rr) * 0.55); }
  blobGeo.setAttribute('color', new THREE.Float32BufferAttribute(bc, 4));
  blobGeo.rotateX(-Math.PI / 2); geometries.push(blobGeo);
  const blobMat = new THREE.MeshBasicMaterial({color: pal.shadow, vertexColors: true, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2});
  blobMat.name = 'avatar-shadow';
  const blob = new THREE.Mesh(blobGeo, blobMat); blob.name = 'avatar-shadow'; blob.position.y = 0.004; blob.renderOrder = -1;
  body.add(blob);
  const V = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0), M4 = new THREE.Matrix4();
  const X3 = new THREE.Vector3(), Y3 = new THREE.Vector3(), Z3 = new THREE.Vector3();
  const place = (mesh, at, dir) => { mesh.position.set(at[0], at[1], at[2]); mesh.quaternion.setFromUnitVectors(UP, V.set(dir[0], dir[1], dir[2])); };
  const frame = (mesh, at, x, y, z) => {
    mesh.position.set(at[0], at[1], at[2]);
    M4.makeBasis(X3.set(x[0], x[1], x[2]), Y3.set(y[0], y[1], y[2]), Z3.set(z[0], z[1], z[2])); mesh.quaternion.setFromRotationMatrix(M4);
  };
  const filters = USED.map(() => new PointFilter({minCutoff: 1.5, beta: 2, dCutoff: 1}));
  const tracker = new BoneTracker(), jump = new JumpEstimator();
  const state = {clock: 0, demo: 'idle', demoStart: 0, lastPoseClock: -Infinity, lastStamp: null, live: 0, livePose: clonePose(REST),
    shown: demoPose('idle', 0, mirror), flash: {legs: -Infinity, arms: -Infinity, body: -Infinity}, poses: 0, joints: null, disposed: false};
  state.shown.lift = 0;

  // landmarks、worldLandmarks：MediaPipe 的 33 个点；timestamp 单位毫秒（pose-stream 给的 performance.now() 时间）。
  function setPose(landmarks, worldLandmarks, timestamp) {
    if (state.disposed) return;
    const l2 = Array.isArray(landmarks) ? landmarks : [];
    const w = Array.isArray(worldLandmarks) && worldLandmarks.length >= 33 ? worldLandmarks : null;
    if (l2.length < 33 && !w) return; // 画面里没人：不刷新，600 ms 后自动回到 idle
    const pts = w || liftLandmarks2D(l2, aspect);
    if (pts.length < 33) return;
    let t = Number.isFinite(timestamp) ? timestamp / 1000 : state.clock;
    const stale = state.clock - state.lastPoseClock > STALE_MS / 1000;
    if (stale || (state.lastStamp !== null && t < state.lastStamp - 0.001)) {
      filters.forEach(f => f.reset()); jump.reset(); state.lastStamp = null;
      if (stale) tracker.reset();
    }
    const dt = state.lastStamp === null ? 1 / 30 : clamp(t - state.lastStamp, 1 / 240, 0.25);
    state.lastStamp = Math.max(t, state.lastStamp ?? t);
    const vis = pts.map((p, i) => l2[i]?.visibility ?? p?.visibility ?? 0);
    const filtered = [];
    USED.forEach((i, n) => { filtered[i] = vis[i] >= VISIBLE && pts[i] ? filters[n].filter(pts[i], t) : pts[i]; });
    const pose = clonePose(tracker.update(measureBones(filtered, vis, mirror), dt));
    pose.lift = jump.update(l2, aspect) * RIG.spine * JUMP_GAIN;
    state.livePose = pose; state.lastPoseClock = state.clock; state.poses++;
  }
  // 没有人时循环播放的示范动作；默认 idle。有人时以真人姿态为准。
  function setDemo(action) {
    const a = ACTIONS.includes(action) ? action : 'idle';
    if (a !== state.demo) { state.demo = a; state.demoStart = state.clock; }
  }
  function flash(part) { for (const g of PARTS.includes(part) ? [part] : PARTS) state.flash[g] = state.clock; }
  // dt、t 单位秒（t 不用于时序，示范动作用内部时钟，切换动作时从头播放）。
  function update(dt) {
    if (state.disposed) return;
    dt = Number.isFinite(dt) ? clamp(dt, 0, 0.1) : 1 / 60;
    state.clock += dt;
    const fresh = state.clock - state.lastPoseClock <= STALE_MS / 1000;
    // 有人：0.1 秒内切到真人；超过 600 ms 没有新姿态：约 0.35 秒渐变回示范动作（默认 idle）。
    state.live = approach(state.live, fresh ? 1 : 0, dt, fresh ? 0.1 : 0.35);
    if (!fresh && state.live < 0.002) state.live = 0;
    const demo = demoPose(state.demo, state.clock - state.demoStart, mirror);
    const target = state.live > 0 ? blendPose(demo, state.livePose, state.live) : demo;
    const kb = 1 - Math.exp(-dt / 0.05);
    const lift = state.shown.lift;
    state.shown = blendPose(state.shown, target, kb);
    state.shown.lift = approach(lift, target.lift || 0, dt, 0.03);
    state.shown.breath = (demo.breath || 0) * (1 - state.live);
    const j = buildSkeleton(state.shown);
    state.joints = j;
    frame(meshes.head, j.head, j.headSide, j.headUp, j.headFwd);
    frame(meshes.torso, j.pelvis, j.side, j.up, j.fwd);
    for (const s of SIDES) {
      const q = j[s];
      place(meshes[s + 'Upper'], q.shoulder, q.upper); place(meshes[s + 'Fore'], q.elbow, q.fore);
      place(meshes[s + 'Thigh'], q.hip, q.thigh); place(meshes[s + 'Shin'], q.knee, q.shin);
      frame(meshes[s + 'Foot'], q.sole, q.footSide, q.footUp, q.footFwd);
    }
    // 呼吸：躯干轻微起伏。
    const br = 1 + 0.018 * state.shown.breath;
    meshes.torso.scale.set(br, 1 + 0.01 * state.shown.breath, br);
    // 阴影：位置在两脚中点，随张开的双脚变宽，随离地高度变小变淡。
    const spread = Math.abs(j.pos.sole[0] - j.neg.sole[0]);
    const h = clamp(j.lift / 0.3, 0, 1);
    blob.position.set((j.pos.sole[0] + j.neg.sole[0]) / 2, 0.004, (j.pos.sole[2] + j.neg.sole[2]) / 2 + 0.01);
    blob.scale.set((0.85 + spread * 1.4) * (1 - 0.35 * h), 1, (0.75 + 0.2 * Math.abs(j.pos.sole[2] - j.neg.sole[2])) * (1 - 0.35 * h));
    blobMat.opacity = 1 - 0.55 * h;
    // 计数闪光：约 150 ms，先亮后灭，同时略微放大。
    for (const g of PARTS) {
      const age = state.clock - state.flash[g];
      const f = age < 0 || age > FLASH_MS / 1000 ? 0 : age < 0.05 ? 1 : 1 - (age - 0.05) / (FLASH_MS / 1000 - 0.05);
      mats[g].emissiveIntensity = 0.9 * f;
      const pop = 1 + 0.12 * f;
      for (const n of PART_GROUPS[g]) {
        const m = meshes[n];
        if (n === 'torso') m.scale.multiplyScalar(pop); else if (n.endsWith('Foot') || n === 'head') m.scale.setScalar(pop); else m.scale.set(pop, 1, pop);
      }
    }
  }
  function dispose() {
    if (state.disposed) return;
    state.disposed = true;
    group.removeFromParent();
    geometries.forEach(g => g.dispose());
    Object.values(mats).forEach(m => m.dispose()); blobMat.dispose();
  }
  const tris = g => (g.index ? g.index.count : g.getAttribute('position').count) / 3;
  const stats = () => ({drawCalls: Object.keys(meshes).length + 1, triangles: geometries.reduce((n, g) => n + tris(g), 0),
    live: state.live, demo: state.demo, poses: state.poses});
  update(0);
  return {group, setPose, setDemo, flash, update, dispose, stats, get joints() { return state.joints; }, get height() { return height; }};
}
