import test from 'node:test';
import assert from 'node:assert/strict';
import {Detector, angle} from '../web/detector.js';

function standing() {
  const p = Array.from({length: 33}, () => ({x: 0.5, y: 0.15, visibility: 1}));
  for (const [id, x, y] of [[11,.42,.25],[12,.58,.25],[13,.4,.37],[14,.6,.37],[15,.39,.55],[16,.61,.55],
    [23,.44,.45],[24,.56,.45],[25,.44,.66],[26,.56,.66],[27,.46,.88],[28,.54,.88]]) p[id] = {x,y,visibility:1};
  return p;
}
const shifted = (p, dy) => p.map(x => ({...x, y:x.y + dy}));
function raised() {
  const p = standing();
  for (const [id,x] of [[13,.25],[14,.75],[15,.1],[16,.9]]) p[id] = {x,y:.25,visibility:1};
  return p;
}
function openJack() {
  const p = standing(); p[15].y = p[16].y = .08; p[27].x = .25; p[28].x = .75; return p;
}
function crouched() {
  const p = standing();
  for (const [hip,knee,ankle] of [[23,25,27],[24,26,28]]) {
    p[hip].y = .53; p[knee] = {...p[knee],x:p[hip].x+.14,y:.68}; p[ankle].x = p[hip].x;
  }
  return p;
}
function runner(action) {
  const d = new Detector(action); let now = 0, counts = 0;
  return {d, get counts() {return counts;}, feed(p, frames = 4, step = 100) {
    let result;
    for (let i=0;i<frames;i++) {now += step; result=d.update(p,now); counts+=result.count;}
    return result;
  }};
}

test('geometry corrects degenerate angles', () => {
  assert.equal(angle({x:0,y:1},{x:0,y:0},{x:1,y:0}), 90);
  assert.equal(angle({x:0,y:0},{x:0,y:0},{x:1,y:0}), 0);
});

test('arm raises count only after both arms rise and return', () => {
  const r = runner('raise'); r.feed(standing()); r.feed(raised()); assert.equal(r.counts,0);
  r.feed(standing()); assert.equal(r.counts,1);
  r.feed(standing(),10); assert.equal(r.counts,1);
  const one = raised(); for (const i of [14,16]) one[i] = standing()[i];
  r.feed(one); r.feed(standing()); assert.equal(r.counts,1);
  r.feed(raised()); r.feed(standing()); assert.equal(r.counts,2);
});

test('jumping jacks require hands overhead, open feet and a full return', () => {
  const r=runner('jack'); r.feed(standing());
  const armsOnly=openJack(); armsOnly[27].x=.46; armsOnly[28].x=.54;
  r.feed(armsOnly); r.feed(standing()); assert.equal(r.counts,0);
  r.feed(openJack()); assert.equal(r.counts,0);
  r.feed(standing()); assert.equal(r.counts,1);
});

test('squats count on standing back up, not on lowering or knee jitter', () => {
  const r=runner('squat'); r.feed(standing()); r.feed(crouched()); assert.equal(r.counts,0);
  r.feed(standing()); assert.equal(r.counts,1);
  r.feed(standing(),12); assert.equal(r.counts,1);
});

test('jump calibrates on stable ground and requires two feet plus landing', () => {
  const r=runner('jump'); r.feed(standing(),8);
  const oneFoot=standing(); oneFoot[27].y-=.06;
  r.feed(oneFoot); r.feed(standing()); assert.equal(r.counts,0);
  r.feed(shifted(standing(),-.06),2); assert.equal(r.counts,0);
  r.feed(standing(),2); assert.equal(r.counts,1);
});

test('login wave requires a stable initial pose then a lateral sweep', () => {
  const r=runner('wave'), start=standing();
  start[14]={x:.4,y:.25,visibility:1}; start[16]={x:.3,y:.25,visibility:1};
  r.feed(start); assert.equal(r.counts,0);
  const end=structuredClone(start); end[16].x=.8;
  r.feed(end); assert.equal(r.counts,1);
  r.feed(end,10); assert.equal(r.counts,1);
});

test('occlusion, out-of-frame landmarks and frame gaps cancel partial movements', () => {
  for (const invalid of [[], standing().map(p=>({...p,visibility:0})), standing().map(p=>({...p,y:1.1}))]) {
    const r=runner('raise'); r.feed(standing()); r.feed(raised());
    assert.equal(r.feed(invalid,1).valid,false);
    r.feed(standing()); assert.equal(r.counts,0);
  }
  const r=runner('raise'); r.feed(standing()); r.feed(raised());
  r.feed(standing(),1,1000); r.feed(standing()); assert.equal(r.counts,0);
  r.feed(raised()); r.feed(standing()); assert.equal(r.counts,1);
});

test('duplicate and reversed timestamps cannot add a repetition', () => {
  const r=runner('raise'); r.feed(standing()); r.feed(raised());
  assert.equal(r.d.update(standing(),1).count,0);
  r.feed(standing()); assert.equal(r.counts,1);
});

test('stable poses and full raise cycles behave consistently from five to thirty FPS', () => {
  for (const fps of [5, 10, 15, 30]) {
    const r=runner('raise'), step=1000/fps, frames=Math.ceil(fps*.65);
    r.feed(standing(),frames,step); assert.equal(r.counts,0);
    r.feed(raised(),frames,step); assert.equal(r.counts,0);
    r.feed(standing(),frames,step); assert.equal(r.counts,1,`${fps} FPS`);
  }
  for (const action of ['jump','jack','raise','squat','wave']) {
    const r=runner(action); r.feed(standing(),120);
    assert.equal(r.counts,0,`${action} must not count a static pose`);
  }
});
