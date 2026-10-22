// Original canvas artwork; all shapes and textures are generated locally.
const TAU = Math.PI * 2;
const sceneMotion = new WeakMap();
function path(c, points, fill, stroke, width = 1) {
  c.beginPath(); points.forEach(([x, y], i) => i ? c.lineTo(x, y) : c.moveTo(x, y)); c.closePath();
  if (fill) { c.fillStyle = fill; c.fill(); } if (stroke) { c.strokeStyle = stroke; c.lineWidth = width; c.stroke(); }
}
function ellipse(c, x, y, rx, ry, fill, rot = 0) { c.beginPath(); c.ellipse(x, y, rx, ry, rot, 0, TAU); c.fillStyle = fill; c.fill(); }
function line(c, points, color, width) { c.beginPath(); points.forEach(([x, y], i) => i ? c.lineTo(x, y) : c.moveTo(x, y)); c.strokeStyle = color; c.lineWidth = width; c.lineCap = 'round'; c.lineJoin = 'round'; c.stroke(); }
const noise = i => { const n = Math.sin(i * 127.13 + 78.23) * 43758.54; return n - Math.floor(n); };
function palm(c, x, y, scale, coconuts = 5, t = 0) {
  c.save(); c.translate(x, y); c.scale(scale, scale);
  ellipse(c, 5, 2, 64, 12, '#485f3528');
  path(c, [[-12, 2], [1, -120], [-8, -240], [8, -260], [20, -130], [12, 2]], '#a18350');
  for (let i = 0; i < 12; i++) line(c, [[-5 + Math.sin(i / 2) * 5, -i * 19 - 5], [14 + Math.sin(i / 2) * 5, -i * 19 - 12]], '#7e724b70', 2);
  for (let i = 0; i < 9; i++) {
    const a = i * Math.PI / 5 + Math.sin(t / 3000 + i) * 0.025;
    const dx = Math.cos(a) * (i % 2 ? 135 : 115), dy = Math.sin(a) * 70;
    c.beginPath(); c.moveTo(5, -249); c.quadraticCurveTo(dx * 0.6, -295 + dy * 0.7, dx, -218 + dy); c.quadraticCurveTo(dx * 0.5, -250 + dy * 0.6, 5, -249); c.fillStyle = i % 2 ? '#456b47' : '#62844d'; c.fill();
    line(c, [[5, -249], [dx * .5, -263 + dy * .5], [dx, -218 + dy]], '#a8b77c60', 1.2);
  }
  for (let i = 0; i < coconuts; i++) { const a = i * 1.2; ellipse(c, 7 + Math.cos(a) * 16, -231 + Math.sin(a) * 10, 10, 13, '#89864c', a / 2); ellipse(c, 4 + Math.cos(a) * 16, -235 + Math.sin(a) * 10, 3, 5, '#a5a36b', a / 2); }
  c.restore();
}
function tree(c, x, y, progress, t) {
  c.save(); c.translate(x, y);
  ellipse(c, 0, 3, 88, 13, '#5069382b');
  const remain = 1 - progress;
  if (remain > 0) {
    c.save(); c.beginPath(); c.rect(-130, -320 * remain, 260, 320 * remain); c.clip();
    path(c, [[-16, 0], [-10, -220], [12, -220], [20, 0]], '#8e764e');
    line(c, [[1, -80], [-42, -172]], '#8e764e', 10); line(c, [[7, -120], [52, -204]], '#8e764e', 11);
    for (let i = 0; i < 14; i++) { const a = i * 2.4, r = 45 + noise(i) * 38; ellipse(c, Math.sin(a) * r + Math.sin(t / 1800) * 2, -205 + Math.cos(a) * r * .65, 48 + noise(i + 10) * 10, 44, ['#4b6c49', '#62804d', '#779256'][i % 3]); }
    for (let i = 0; i < 35; i++) ellipse(c, (noise(i + 5) - .5) * 180, -180 - noise(i + 40) * 100, 3, 1.5, '#aebc7a80', -.5);
    c.restore();
  }
  for (let i = 0; i < Math.floor(progress * 5); i++) {
    c.save(); c.translate(-52 + i * 23, 12 + (i % 2) * 15); c.rotate(-.3);
    path(c, [[0, 0], [48, -2], [48, 14], [0, 17]], '#99794d'); ellipse(c, 0, 8, 6, 9, '#c5ac77'); ellipse(c, 0, 8, 3, 5, '#a89165'); c.restore();
  }
  if (remain === 0) { path(c, [[-18, 0], [-16, -28], [18, -28], [21, 0]], '#8c744c'); ellipse(c, 1, -28, 18, 7, '#c7ae79'); }
  c.restore();
}
function farm(c, x, y, progress, t) {
  c.save(); c.translate(x, y);
  path(c, [[-138, -20], [40, -60], [164, 34], [-24, 89]], '#94764f', '#b1986d', 3);
  for (let row = 0; row < 5; row++) {
    const yy = -9 + row * 19;
    line(c, [[-109 + row * 19, yy], [38 + row * 23, yy - 35]], '#6d5c3c90', 3);
  }
  const total = Math.round(progress * 35);
  for (let i = 0; i < total; i++) {
    const row = Math.floor(i / 7), col = i % 7;
    const xx = -105 + row * 24 + col * 23, yy = -12 + row * 19 - col * 5;
    const height = 27 + noise(i) * 21, sway = Math.sin(t / 1400 + i) * 2;
    line(c, [[xx, yy], [xx + sway, yy - height]], '#a89e51', 2);
    line(c, [[xx, yy - 8], [xx - 10, yy - 24]], '#8e974f', 2);
    line(c, [[xx, yy - 16], [xx + 9, yy - 27]], '#8e974f', 2);
    for (let j = 0; j < 5; j++) { ellipse(c, xx + sway - 3, yy - height + j * 4, 2.5, 5, '#dfbe69', -.5); ellipse(c, xx + sway + 3, yy - height + j * 4, 2.5, 5, '#d4b25e', .5); }
  }
  for (const [xx, yy] of [[-160, -6], [64, -70], [180, 48], [-25, 104]]) { line(c, [[xx, yy], [xx, yy - 45]], '#a08b60', 5); }
  line(c, [[-160, -40], [64, -105], [180, 13]], '#aa9a75', 2);
  line(c, [[-160, -26], [-25, 75], [180, 27]], '#aa9a75', 2);
  c.restore();
}
function house(c, x, y, level, progress = 1) {
  c.save(); c.translate(x, y); const scale = 0.86 + level * 0.035; c.scale(scale, scale);
  ellipse(c, 12, 18, 150, 28, '#4a64322b');
  if (progress <= 0) { for (let i = 0; i < 4; i++) line(c, [[(i % 2) * 130 - 65, Math.floor(i / 2) * 35], [(i % 2) * 130 - 65, Math.floor(i / 2) * 35 - 23]], '#a7986d', 5); c.restore(); return; }
  c.save(); c.beginPath(); c.rect(-180, 45 - 260 * progress, 380, 260 * progress); c.clip();
  const roof = level >= 5 ? '#6a7770' : level === 2 ? '#b3a26a' : '#64745b';
  path(c, [[-105, -10], [20, 15], [20, -122], [-105, -145]], level >= 5 ? '#a0a28c' : '#b49569');
  path(c, [[20, 15], [110, -16], [110, -150], [20, -122]], level >= 4 ? '#929476' : '#9d8258');
  if (level <= 4) {
    for (let i = 0; i < 10; i++) {
      line(c, [[-103, -i * 13 - 5], [20, 20 - i * 13]], '#7f704b80', 3);
      line(c, [[22, 17 - i * 13], [110, -13 - i * 13]], '#6e634780', 3);
    }
  } else { for (let i = 0; i < 6; i++) { line(c, [[-105, -i * 23], [20, 25 - i * 23]], '#7d85727a', 2); for (let j = 0; j < 4; j++) line(c, [[-95 + j * 32 + i % 2 * 12, -i * 23], [-95 + j * 32 + i % 2 * 12, -i * 23 - 22]], '#7d85727a', 2); } }
  path(c, [[-127, -139], [-19, -235], [45, -124]], roof);
  path(c, [[-19, -235], [91, -253], [139, -160], [45, -124]], level >= 5 ? '#7c8c7f' : '#7e8d68');
  for (let i = 1; i < 13; i++) line(c, [[-18 + i * 8, -234 - i * 1.3], [43 + i * 7.2, -126 - i * 2.5]], level === 2 ? '#d1bd7b' : '#a3ad8250', level === 2 ? 4 : 1.5);
  path(c, [[-54, 0], [-54, -93], [-13, -85], [-13, 8]], '#465a43');
  line(c, [[-48, -4], [-48, -84]], '#648160', 2); ellipse(c, -22, -40, 2, 3, '#d2b472');
  path(c, [[45, -59], [79, -70], [79, -110], [45, -100]], '#3b574c');
  line(c, [[62, -65], [62, -105]], '#c8b483', 3); line(c, [[46, -80], [78, -90]], '#c8b483', 3);
  if (level >= 4) { line(c, [[-111, 3], [-111, -135]], '#6c7257', 9); line(c, [[24, 20], [24, -125]], '#6c7257', 9); }
  c.restore();
  if (level >= 6 && progress === 1) {
    line(c, [[157, 0], [157, -240]], '#8d8259', 5); path(c, [[158, -239], [214, -222], [158, -203]], '#cc935b');
    path(c, [[-220, 30], [-180, -70], [-138, 20]], '#929b72'); line(c, [[-182, -70], [-180, 24]], '#6e7a5b', 2);
  }
  c.restore();
}
function background(c, w, h, t, portrait = false) {
  const horizon = h * .43;
  const sky = c.createLinearGradient(0, 0, 0, h); sky.addColorStop(0, '#dae2cc'); sky.addColorStop(.5, '#e8e4c9'); sky.addColorStop(1, '#bdccb1');
  c.fillStyle = sky; c.fillRect(0, 0, w, h);
  ellipse(c, w * .72, h * .22, 36, 36, '#eed6a0'); ellipse(c, w * .72, h * .22, 52, 52, '#eed6a025');
  for (let i = 0; i < 5; i++) { const xx = noise(i + 100) * w + Math.sin(t / 20000 + i) * 7, yy = h * (.12 + noise(i + 200) * .22); ellipse(c, xx, yy, 38 + noise(i) * 45, 5 + noise(i + 3) * 4, '#f8f6e5a0'); }
  path(c, [[0, horizon + 25], [w * .13, horizon + 7], [w * .24, horizon - 32], [w * .32, horizon - 12], [w * .46, horizon + 18], [w * .55, horizon + 34], [w, horizon + 35], [w, h], [0, h]], '#b1c4ad');
  const sea = c.createLinearGradient(0, horizon + 30, 0, h); sea.addColorStop(0, '#91b6a3'); sea.addColorStop(1, '#4f9387'); c.fillStyle = sea; c.fillRect(0, horizon + 35, w, h);
  for (let i = 0; i < 65; i++) { const x = noise(i + 600) * w, y = horizon + 40 + noise(i + 700) * (h - horizon - 40); line(c, [[x + Math.sin(t / 1700 + i) * 4, y], [x + 10 + noise(i + 800) * 45, y]], i % 4 ? '#d6e4c644' : '#edf0d07a', 1); }
  if (portrait) {
    ellipse(c, w * .49, h * .73, w * .46, h * .11, '#d6cf9a'); ellipse(c, w * .49, h * .7, w * .42, h * .1, '#b9bd84'); ellipse(c, w * .5, h * .685, w * .37, h * .075, '#9fa973');
    palm(c, w * .33, h * .71, w / 500, 4, t); house(c, w * .61, h * .72, 2, 1);
    for (let i = 0; i < 40; i++) { const x = w * (.15 + noise(i + 950) * .65), y = h * (.69 + noise(i + 970) * .06); line(c, [[x, y], [x + 2, y - 5]], '#7e9662', 1); }
  }
}
export function drawPostcard(canvas, t = 0) {
  const c = canvas.getContext('2d'); c.clearRect(0, 0, canvas.width, canvas.height); background(c, canvas.width, canvas.height, t, true);
  c.strokeStyle = '#f1e9c766'; c.lineWidth = 1; c.strokeRect(18, 18, canvas.width - 36, canvas.height - 36);
}
export function drawWorld(canvas, {stage = 0, progress = 0, target = 5, shelter = 0, video = null, landmarks = null, t = 0, demo = false, transitioning = false}) {
  const c = canvas.getContext('2d'), w = canvas.width, h = canvas.height;
  background(c, w, h, t);
  c.beginPath(); c.moveTo(0, h * .7); c.bezierCurveTo(w * .3, h * .54, w * .45, h * .8, w, h * .59); c.lineTo(w, h); c.lineTo(0, h); c.closePath(); c.fillStyle = '#ddd1a2'; c.fill();
  c.beginPath(); c.moveTo(0, h * .73); c.bezierCurveTo(w * .3, h * .58, w * .45, h * .84, w, h * .62); c.lineTo(w, h); c.lineTo(0, h); c.closePath(); c.fillStyle = '#c3c08a'; c.fill();
  for (let i = 0; i < 180; i++) { const x = noise(i + 1200) * w, y = h * (.77 + noise(i + 1600) * .22); ellipse(c, x, y, noise(i) * 2 + .5, .7, i % 3 ? '#a4aa7380' : '#e5d6a1'); }
  palm(c, 54, 438, .6, 3, t); palm(c, w - 36, 442, .58, 2, t);
  // A few distant silhouettes make the active object read at human scale.
  if (stage !== 3 && shelter) { c.save(); c.globalAlpha = .6; c.translate(670, 414); c.scale(.35, .35); house(c, 0, 0, shelter); c.restore(); }
  const x = stage === 2 ? 420 : 395, y = 491;
  const count = Math.round(progress * target);
  let motion = sceneMotion.get(canvas);
  if (!motion || motion.stage !== stage || count < motion.count) motion = {stage, count, droppedAt: -Infinity};
  if (stage === 0 && count > motion.count) motion.droppedAt = t;
  motion.stage = stage; motion.count = count; sceneMotion.set(canvas, motion);
  if (stage === 0) {
    palm(c, x, y, 1.23, Math.max(0, target - count), t);
    const elapsed = t - motion.droppedAt;
    const falling = elapsed >= 0 && elapsed < 500;
    const dropped = count - (falling ? 1 : 0);
    for (let i = 0; i < dropped; i++) ellipse(c, x - 85 + (i % 8) * 25, y + 18 + Math.floor(i / 8) * 19 + (i % 2) * 8, 12, 15, '#91814d', i);
    if (falling) {
      const f = elapsed / 500; ellipse(c, x + 30, y - 260 + f * f * 260, 12, 15, '#999057', f * 4);
    }
  } else if (stage === 1) tree(c, x, y, progress, t);
  else if (stage === 2) farm(c, x, y - 20, progress, t);
  else house(c, x, y, stage >= 4 ? shelter : Math.min(6, shelter + (progress === 1 ? 0 : 1)), stage >= 4 ? 1 : progress);
  for (const [xx, yy, rr] of [[150, 520, 11], [600, 552, 13], [720, 475, 9], [78, 570, 5]]) { ellipse(c, xx, yy, rr * 1.4, rr, '#989f7e'); ellipse(c, xx - 2, yy - 3, rr, rr * .6, '#b6b79a'); }
  c.font = '11px system-ui'; c.fillStyle = '#405a40'; c.textAlign = 'center';
  const px = 775, py = 206, pw = 252, ph = 281;
  c.save(); c.beginPath(); c.roundRect(px, py, pw, ph, 14); c.clip();
  if (video?.readyState >= 2 && !video.paused) {
    c.fillStyle = '#213f36'; c.fillRect(px, py, pw, ph); const vw = video.videoWidth, vh = video.videoHeight;
    const scale = Math.min(pw / vw, (ph - 32) / vh), dw = vw * scale, dh = vh * scale;
    const ox = px + (pw - dw) / 2, oy = py + (ph - 32 - dh) / 2;
    c.save(); c.translate(ox + dw, oy); c.scale(-1, 1); c.drawImage(video, 0, 0, dw, dh); drawSkeleton(c, landmarks, dw, dh); c.restore();
  } else {
    c.fillStyle = '#b4c29b'; c.fillRect(px, py, pw, ph);
    // A quiet placeholder, distinct from a tracked player.
    ellipse(c, px + pw / 2, py + 63, 16, 18, '#708865'); line(c, [[px + pw / 2, py + 84], [px + pw / 2, py + 160]], '#708865', 21);
    line(c, [[px + pw / 2 - 25, py + 105], [px + pw / 2 + 25, py + 105]], '#708865', 11);
    line(c, [[px + pw / 2 - 22, py + 205], [px + pw / 2, py + 158], [px + pw / 2 + 22, py + 205]], '#708865', 12);
  }
  c.fillStyle = '#234b3ee6'; c.fillRect(px, py + ph - 32, pw, 32); c.fillStyle = '#e5e9ce'; c.font = '11px system-ui'; c.textAlign = 'center';
  c.fillText(video?.readyState >= 2 && !video.paused ? '你的小岛，因你而改变' : demo ? '键鼠体验 · 动作效果预览' : '开启摄像头后，在这里看见自己', px + pw / 2, py + ph - 12);
  c.restore();
  line(c, [[px + pw / 2 - 12, py + ph + 18], [px + pw / 2 + 12, py + ph + 18]], '#a49e71', 2);
  // Birds far from the shore.
  for (let i = 0; i < 3; i++) { const bx = 250 + i * 25 + Math.sin(t / 8000) * 12, by = 146 + i % 2 * 12; line(c, [[bx - 5, by], [bx, by + 3], [bx + 5, by]], '#718b7580', 1.5); }
}
const CONNECTIONS = [[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24],[23,25],[25,27],[24,26],[26,28]];
export function drawSkeleton(c, l, w, h) {
  if (!l?.length) return;
  c.strokeStyle = '#e9f9b9'; c.fillStyle = '#e9f9b9'; c.lineWidth = 2;
  for (const [a,b] of CONNECTIONS) if (l[a].visibility > .35 && l[b].visibility > .35) { c.beginPath(); c.moveTo(l[a].x*w,l[a].y*h);c.lineTo(l[b].x*w,l[b].y*h);c.stroke(); }
  for (const i of [11,12,13,14,15,16,23,24,25,26,27,28]) if (l[i].visibility > .35) ellipse(c,l[i].x*w,l[i].y*h,2.5,2.5,'#f5e09d');
}
export function mirror(canvas, video, landmarks) {
  const c = canvas.getContext('2d'), w = canvas.width, h = canvas.height;
  c.fillStyle='#193b32';c.fillRect(0,0,w,h);
  if (video.readyState < 2) return;
  const scale = Math.min(w/video.videoWidth,h/video.videoHeight), dw=video.videoWidth*scale, dh=video.videoHeight*scale;
  c.save();c.translate((w+dw)/2,(h-dh)/2);c.scale(-1,1);c.drawImage(video,0,0,dw,dh);drawSkeleton(c,landmarks,dw,dh);c.restore();
}
