// MediaPipe 33-point pose geometry. No inference or browser APIs in this module.
const SIDES = [[11, 13, 15, 23, 25, 27], [12, 14, 16, 24, 26, 28]];
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mean = (...v) => v.reduce((a, b) => a + b, 0) / v.length;
export function angle(a, b, c) {
  const u = {x: a.x - b.x, y: a.y - b.y}, v = {x: c.x - b.x, y: c.y - b.y};
  const norm = Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y);
  return norm < 1e-6 ? 0 : Math.acos(Math.max(-1, Math.min(1, (u.x * v.x + u.y * v.y) / norm))) * 180 / Math.PI;
}
export class Detector {
  constructor(action) { this.reset(action); }
  reset(action = this.action) {
    this.action = action; this.phase = 'ready'; this.since = 0; this.last = null;
    this.lastRep = -Infinity; this.candidate = ''; this.candidateSince = 0;
    this.invalidSince = null;
    this.samples = []; this.ground = null; this.waveStart = null; this.squatHip = null;
    this.hint = '请站稳，让需要的身体部位完整入镜。';
  }
  stable(condition, name, now, duration = 90) {
    if (!condition) { if (this.candidate === name) this.candidate = ''; return false; }
    if (this.candidate !== name) { this.candidate = name; this.candidateSince = now; return false; }
    return now - this.candidateSince >= duration;
  }
  change(phase, now) { this.phase = phase; this.since = now; this.candidate = ''; }
  update(raw, now, aspect = 4 / 3) {
    if (!Number.isFinite(now) || (this.last !== null && now <= this.last)) return {count: 0, hint: this.hint};
    if (this.last !== null && now - this.last > 450) this.reset();
    this.last = now;
    const l = raw?.map(p => ({x: p?.x * aspect, y: p?.y}));
    const visible = ids => ids.every(i => raw?.[i] && Number.isFinite(raw[i].x) && Number.isFinite(raw[i].y) && raw[i].x >= 0 && raw[i].x <= 1 && raw[i].y >= 0 && raw[i].y <= 1 && (raw[i].visibility ?? 0) >= 0.25);
    let count = 0;
    const emit = () => { if (now - this.lastRep >= 450) { count = 1; this.lastRep = now; } this.change('ready', now); };
    const torsoIds = [11, 12, 23, 24];
    const torso = visible(torsoIds) ? mean(dist(l[11], l[23]), dist(l[12], l[24])) : 0;
    let valid = torso > 0.05;
    if (this.phase !== 'ready' && now - this.since > (this.action === 'squat' ? 8000 : 3500)) this.reset();
    if (valid && this.action === 'wave') {
      valid = visible([12, 14, 16]);
      if (valid) {
        const level = Math.abs(l[16].y - l[12].y) < torso * 0.65;
        if (this.phase === 'ready') {
          const start = level && Math.abs(l[14].y - l[12].y) < torso * 0.6 && l[16].x < l[12].x - torso * 0.2;
          if (this.stable(start, 'arm', now, 100)) { this.waveStart = l[16].x; this.change('sweep', now); }
        } else if (level && l[16].x - this.waveStart > torso * 0.45) emit();
        this.hint = this.phase === 'sweep' ? '很好，右手保持肩高，向你的左侧挥动。' : '先将右臂向右侧平举，稍停，再向左挥动。';
      }
    } else if (valid && this.action === 'raise') {
      valid = visible([11, 12, 13, 14, 15, 16, 23, 24]);
      if (valid) {
        const elevations = SIDES.map(([s, e, , h]) => angle(l[e], l[s], l[h]));
        const down = elevations.every(x => x < 45);
        const up = elevations.every(x => x > 55 && x < 135) && SIDES.every(([s, e, w]) => angle(l[s], l[e], l[w]) > 115 && Math.abs(l[w].y - l[s].y) < torso * 0.65);
        if (this.phase === 'ready' && this.stable(down, 'down', now)) this.change('down', now);
        else if (this.phase === 'down' && this.stable(up, 'up', now, 100)) this.change('up', now);
        else if (this.phase === 'up' && this.stable(down, 'finish', now)) emit();
        this.hint = this.phase === 'up' ? '双臂放回身侧，完成这一次。' : '双臂向两侧平举至肩高，稍停，再放下。';
      }
    } else if (valid && this.action === 'jack') {
      valid = visible([11, 12, 15, 16, 23, 24, 27, 28]);
      if (valid) {
        const width = Math.max(dist(l[11], l[12]), torso * 0.45);
        const feet = Math.abs(l[27].x - l[28].x);
        const closed = l[15].y > l[11].y + torso * 0.3 && l[16].y > l[12].y + torso * 0.3 && feet < width * 1.2;
        const open = l[15].y < l[11].y - torso * 0.3 && l[16].y < l[12].y - torso * 0.3 && feet > width * 1.3;
        if (this.phase === 'ready' && this.stable(closed, 'closed', now)) this.change('closed', now);
        else if (this.phase === 'closed' && this.stable(open, 'open', now, 60)) this.change('open', now);
        else if (this.phase === 'open' && this.stable(closed, 'finish', now, 60)) emit();
        this.hint = this.phase === 'open' ? '放下双手，双脚收回。' : feet > width * 1.3 ? '双脚打开得很好，再把双手举高一些。' : '双脚打开，同时把双手举过头顶。';
      }
    } else if (valid && this.action === 'squat') {
      const sides = SIDES.filter(([s, , , h, k, a]) => visible([s, h, k, a]) && dist(l[h], l[k]) > torso * 0.25 && dist(l[k], l[a]) > torso * 0.25);
      valid = sides.length > 0;
      if (valid) {
        const best = sides.sort((a, b) => Math.min(...b.filter((_, i) => [0, 3, 4, 5].includes(i)).map(i => raw[i].visibility)) - Math.min(...a.filter((_, i) => [0, 3, 4, 5].includes(i)).map(i => raw[i].visibility)))[0];
        const [, , , h, k, a] = best, knee = angle(l[h], l[k], l[a]);
        if (this.phase === 'ready' && this.stable(knee > 148, 'standing', now, 100)) { this.squatHip = l[h].y; this.squatSide = h; this.change('standing', now); }
        else if (this.phase === 'standing' && h === this.squatSide && this.stable(knee < 138 && l[h].y - this.squatHip > torso * 0.08, 'low', now)) this.change('low', now);
        else if (this.phase === 'low' && h === this.squatSide && this.stable(knee > 148, 'finish', now, 90)) emit();
        this.hint = this.phase === 'low' ? '慢慢站直，完成这一次。' : '先站直，髋部向后下方坐，再站起。';
      }
    } else if (valid && this.action === 'jump') {
      valid = visible([11, 12, 23, 24, 25, 26, 27, 28]);
      if (valid) {
        const hip = mean(l[23].y, l[24].y);
        if (!this.ground) {
          this.samples.push({time: now, left: l[27].y, right: l[28].y, hip, torso});
          this.samples = this.samples.filter(x => now - x.time < 900);
          if (this.samples.length >= 4 && now - this.samples[0].time >= 400 && Math.max(...this.samples.map(x => x.hip)) - Math.min(...this.samples.map(x => x.hip)) < torso * 0.12) {
            const avg = key => mean(...this.samples.map(x => x[key]));
            this.ground = {left: avg('left'), right: avg('right'), hip: avg('hip'), torso: avg('torso')};
          }
          this.hint = '先站直并保持半秒，正在标定地面。';
        } else {
          const g = this.ground;
          const airborne = g.left - l[27].y > torso * 0.08 && g.right - l[28].y > torso * 0.08 && g.hip - hip > torso * 0.08 && torso / g.torso > 0.75 && torso / g.torso < 1.25;
          const landed = Math.abs(g.left - l[27].y) < torso * 0.12 && Math.abs(g.right - l[28].y) < torso * 0.12 && Math.abs(g.hip - hip) < torso * 0.22;
          if (this.phase === 'ready' && airborne) this.change('air', now);
          else if (this.phase === 'air' && now - this.since >= 70 && landed && !airborne) emit();
          // Follow slow camera/body drift only while confidently on the ground.
          if (this.phase === 'ready' && landed && !airborne) for (const [key, value] of Object.entries({left: l[27].y, right: l[28].y, hip})) g[key] += (value - g[key]) * 0.03;
          this.hint = this.phase === 'air' ? '双脚平稳落地。' : '双脚竖直起跳，再回到原地。';
        }
      }
    }
    if (!valid) {
      // A single low-confidence frame should not erase an otherwise complete motion.
      this.invalidSince ??= now;
      this.candidate = '';
      if (now - this.invalidSince >= 250) { this.reset(); this.last = now; }
      this.hint = this.action === 'wave' || this.action === 'raise' ? '请让肩、髋和双臂入镜，保持光线充足。' : '请退后一点，让肩、髋、膝和双脚完整入镜。';
    } else this.invalidSince = null;
    return {count, valid, phase: this.phase, hint: this.hint};
  }
}
