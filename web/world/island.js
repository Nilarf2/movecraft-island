// MoveCraft 3D island for the projector stage. Procedural low-poly, flat shaded.
// createIsland(THREE, opts) builds scene + camera only; the caller owns the one
// WebGLRenderer and calls update(dt, t) then renderer.render(scene, camera).
// Expected renderer: outputColorSpace sRGB, no tone mapping, shadowMap.type PCFShadowMap.
// Everything except createIsland is pure and runs in node (tests/island.test.mjs).
import {PALETTES, PALETTE_NAMES, SLOT} from './palettes.js';
import {createKit, poly, rng, delaunay, hash} from './kit.js';
import {createMaterials} from './materials.js';
import * as L from './layout.js';

export {PALETTE_NAMES};
export const QUALITY = {
  low: {shadow: false, mapSize: 0, particles: 70, forest: 0.55, seaStep: 2.2, seaRings: 10, clouds: 3, fireworks: 0.5},
  medium: {shadow: true, mapSize: 1024, particles: 160, forest: 0.8, seaStep: 1.5, seaRings: 13, clouds: 5, fireworks: 0.8},
  high: {shadow: true, mapSize: 2048, particles: 240, forest: 1, seaStep: 1.1, seaRings: 15, clouds: 7, fireworks: 1},
};
export const ZONE_NAMES = L.ZONES.map(z => z.name);
export const HUD = {top: 0.14, bottom: 0.18};
export const AVATAR_HEIGHT = L.AVATAR_HEIGHT;
export const NUTS = L.PALMS.reduce((n, p) => n + p.nuts, 0);
export const BASKET_MAX = 12, LOG_MAX = 10, CROP_ROWS = L.FIELD.rows;
export const ground = zone => L.TOP + (zone === 1 || zone === 2 ? L.RISE : 0);

export const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
export const ratio = (count, target) => target > 0 ? clamp((+count || 0) / target) : 0;
export const easeInOut = x => (x = clamp(x), x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
export const easeOutBack = x => { x = clamp(x); const c = 1.7; return 1 + (c + 1) * (x - 1) ** 3 + c * (x - 1) ** 2; };
export const shortAngle = (a, b) => { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };

// Persistent look of a zone for a progress ratio r = count / target in [0, 1].
export function stageState(stage, r) {
  r = clamp(r);
  if (stage === 0) return {nuts: NUTS - Math.round(r * NUTS), basket: Math.round(r * BASKET_MAX)};
  if (stage === 1) return {fallen: Math.floor(r * L.CHOP.length + 1e-6), logs: Math.round(r * LOG_MAX)};
  if (stage === 2) return {rows: Array.from({length: CROP_ROWS}, (_, i) => clamp(r * CROP_ROWS - i)), ripe: r >= 1};
  if (stage === 3) return {build: r};
  return {};
}
// Parts of the next house level shown while building; the old house hides past 40 %.
export function buildState(r, parts) {
  const shown = Math.min(parts, Math.floor(clamp(r) * parts + 1e-6));
  return {shown, hideOld: shown >= Math.ceil(parts * 0.4), scaffold: r > 0 && r < 1};
}
export function resourceCounts({water = 0, wood = 0, food = 0} = {}) {
  const n = (v, unit, max) => Math.min(max, Math.ceil(Math.max(0, +v || 0) / unit));
  return {barrels: n(water, 2, 6), logs: n(wood, 2.5, 12), baskets: n(food, 2, 5)};
}
// Camera framing. For an avatar of height h standing on the anchor, find the
// camera (pitch fixed) that puts the feet at NDC y = feet and the head at y = head.
// k(n) is the slope, relative to the camera, of the ray through NDC height n.
export function frameAvatar({height = AVATAR_HEIGHT, pitch, fov = L.FRAME.fov, feet = L.FRAME.feet, head = L.FRAME.head}) {
  const t = Math.tan(fov * Math.PI / 360), k = n => Math.tan(Math.atan(n * t) - pitch);
  const dh = height / (k(head) - k(feet)), cy = -dh * k(feet);
  return {dh, cy, targetY: cy - dh * Math.tan(pitch), distance: dh / Math.cos(pitch)};
}
export function zoneView(z) {
  const zn = L.ZONES[z], f = frameAvatar({pitch: zn.pitch});
  return {target: [zn.anchor[0], ground(z) + f.targetY, zn.anchor[1]], azimuth: zn.azimuth, pitch: zn.pitch, distance: f.distance};
}
export const overviewView = () => ({...L.OVERVIEW, target: L.OVERVIEW.target.slice()});
export const ORBIT = {
  attract: {target: [0.5, 2.6, 0], pitch: 27 * Math.PI / 180, distance: 52, speed: 0.07},
  celebrate: {target: [2, 3.2, 1.5], pitch: 23 * Math.PI / 180, distance: 44, speed: 0.13},
};
export function orbitPosition(v) {
  const cp = Math.cos(v.pitch);
  return [v.target[0] + Math.sin(v.azimuth) * cp * v.distance, v.target[1] + Math.sin(v.pitch) * v.distance, v.target[2] + Math.cos(v.azimuth) * cp * v.distance];
}
export function blendView(a, b, k) {
  return {target: a.target.map((v, i) => v + (b.target[i] - v) * k), azimuth: a.azimuth + shortAngle(a.azimuth, b.azimuth) * k,
    pitch: a.pitch + (b.pitch - a.pitch) * k, distance: a.distance + (b.distance - a.distance) * k};
}
// Where the avatar stands: on the ground, facing the zone camera. Avatar local +Z
// faces the viewer, so rotation.y = facing turns it toward the camera.
export function anchorOf(z) {
  const zn = L.ZONES[z];
  return {x: zn.anchor[0], y: ground(z), z: zn.anchor[1], facing: zn.azimuth};
}
const DEG = Math.PI / 180;
const zoneIndex = z => Math.max(0, Math.min(3, Math.round(+z) || 0));

export function createIsland(THREE, opts = {}) {
  const o = {palette: 'day', quality: 'medium', zone: 0, reducedMotion: false, ...opts};
  const kit = createKit(THREE), mats = createMaterials(THREE), {Builder} = kit;
  const scene = new THREE.Scene();
  scene.name = 'movecraft-island';
  const camera = new THREE.PerspectiveCamera(L.FRAME.fov, 16 / 9, 0.3, 420);
  const owned = [], keep = x => (owned.push(x), x);
  const WHITE = new THREE.Color(1, 1, 1), TMP = new THREE.Color(), M4 = new THREE.Matrix4(), M5 = new THREE.Matrix4();
  const V1 = new THREE.Vector3(), V2 = new THREE.Vector3(), Q1 = new THREE.Quaternion(), E1 = new THREE.Euler(), S1 = new THREE.Vector3();
  const propMat = mats.prop({key: 'prop'});
  const glowMat = mats.prop({key: 'lantern', lift: 0});
  const depthMat = mats.windDepth();
  const fxMat = keep(new THREE.MeshBasicMaterial({fog: false}));
  let reduced = !!o.reducedMotion, pal = PALETTES[o.palette] ? o.palette : 'day', qName = QUALITY[o.quality] ? o.quality : 'medium';
  let Qs = QUALITY[qName];
  // Static meshes are merged per builder; dynamic ones are InstancedMesh.
  const HIDE = new THREE.Matrix4().makeScale(1e-4, 1e-4, 1e-4).setPosition(0, -60, 0);
  function mesh(b, {cast = false, receive = true, mat = propMat, wind = false, name = '', parent = scene, still = true} = {}) {
    const m = new THREE.Mesh(keep(b.geometry()), mat);
    m.name = name; m.castShadow = cast; m.receiveShadow = receive;
    if (wind && cast) m.customDepthMaterial = depthMat;
    if (still) { m.matrixAutoUpdate = false; m.updateMatrix(); }
    parent.add(m); return m;
  }
  function inst(b, count, {cast = false, receive = true, mat = propMat, wind = false, color = false, name = ''} = {}) {
    const m = new THREE.InstancedMesh(keep(b.geometry()), mat, count);
    m.name = name; m.castShadow = cast; m.receiveShadow = receive; m.frustumCulled = false;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (wind && cast) m.customDepthMaterial = depthMat;
    for (let i = 0; i < count; i++) m.setMatrixAt(i, HIDE);
    if (color) { for (let i = 0; i < count; i++) m.setColorAt(i, WHITE); m.instanceColor.setUsage(THREE.DynamicDrawUsage); }
    scene.add(m); return m;
  }
  const setTRS = (m, i, x, y, z, ry = 0, s = 1, rx = 0, rz = 0) => {
    E1.set(rx, ry, rz, 'YXZ'); Q1.setFromEuler(E1);
    if (Array.isArray(s)) S1.set(s[0], s[1], s[2]); else S1.set(s, s, s);
    m.setMatrixAt(i, M4.compose(V1.set(x, y, z), Q1, S1));
  };

  // Lights: hemisphere + one directional sun whose azimuth follows the camera,
  // so every zone is lit from the front-left like a studio turntable.
  const hemi = new THREE.HemisphereLight(0xffffff, 0x888888, 1.7);
  const sun = new THREE.DirectionalLight(0xffffff, 2.6);
  sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.035; sun.shadow.radius = 2.5;
  sun.shadow.camera.near = 1; sun.shadow.camera.far = 140;
  scene.add(hemi, sun, sun.target);
  const sky = new THREE.Mesh(keep(new THREE.PlaneGeometry(2, 2)), mats.sky());
  sky.frustumCulled = false; sky.renderOrder = -10; sky.matrixAutoUpdate = false; sky.name = 'sky';
  scene.add(sky);
  scene.fog = new THREE.Fog(0xffffff, 60, 190);
  const sunDir = new THREE.Vector3(0, 1, 0);

  function applyPalette(name) {
    pal = PALETTES[name] ? name : 'day';
    const p = PALETTES[pal];
    mats.setPalette(p);
    hemi.color.set(p.hemi.sky); hemi.groundColor.set(p.hemi.ground); hemi.intensity = p.hemi.intensity;
    sun.color.set(p.sun.color); sun.intensity = p.sun.intensity; sun.shadow.intensity = p.shadow;
    scene.fog.color.set(p.sky.haze);
  }
  // ---- Terrain: beach top, grass plateau, layered cliff skirt, islets (one mesh).
  const outline = poly.ccw(L.OUTLINE), plateau = poly.ccw(L.PLATEAU);
  const edgeOut = (a, b) => { const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1; return [dz / l, 0, -dx / l]; };
  function orient(b, a, bb, c, out, slot, shade) {
    const ux = bb[0] - a[0], uy = bb[1] - a[1], uz = bb[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (nx * out[0] + ny * out[1] + nz * out[2] < 0) b.tri(a, c, bb, slot, shade); else b.tri(a, bb, c, slot, shade);
  }
  function surface(b, ring, y, jitterY, slotOf, seed, step, skip) {
    const pts = ring.map(p => p.slice()), r = rng(seed), edgeN = pts.length;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of ring) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    for (let x = x0; x <= x1; x += step) for (let z = z0; z <= z1; z += step) {
      const px = x + (r() - 0.5) * step * 0.8, pz = z + (r() - 0.5) * step * 0.8;
      if (poly.signed(ring, px, pz) < -step * 0.45 && !(skip && skip(px, pz))) pts.push([px, pz]);
    }
    const hy = pts.map(([x, z], i) => i < edgeN ? y : y + (hash(x, 0, z, seed) - 0.5) * jitterY);
    for (const [ia, ib, ic] of delaunay(pts)) {
      const cx = (pts[ia][0] + pts[ib][0] + pts[ic][0]) / 3, cz = (pts[ia][1] + pts[ib][1] + pts[ic][1]) / 3;
      if (!poly.inside(ring, cx, cz)) continue;
      const [slot, shade] = slotOf(cx, cz, r);
      orient(b, [pts[ia][0], hy[ia], pts[ia][1]], [pts[ib][0], hy[ib], pts[ib][1]], [pts[ic][0], hy[ic], pts[ic][1]], [0, 1, 0], slot, shade);
    }
  }
  const nearAnchor = (z, x, zz, r) => Math.hypot(x - L.ZONES[z].anchor[0], zz - L.ZONES[z].anchor[1]) < r;
  const campAt = L.local(3, ...L.CAMP.house);
  function buildTerrain() {
    const b = new Builder(11);
    const counts = poly.counts(outline, 1.2), ring0 = poly.subdivide(outline, counts);
    surface(b, ring0, L.TOP, 0.08, (x, z, r) => {
      const sd = poly.signed(outline, x, z), v = 0.95 + r() * 0.08;
      if (sd > -1.1) return ['sandDark', 1.02 * v];
      if (Math.hypot(x - campAt[0], z - campAt[1]) < 3.4 || nearAnchor(3, x, z, 1.6)) return ['sandDark', 1.08 * v];
      return ['sand', v * (hash(x, 1, z, 3) > 0.86 ? 0.95 : 1)];
    }, 21, 1.7, (x, z) => poly.signed(plateau, x, z) < -1.4);
    const pc = poly.counts(plateau, 1.1), pring = poly.subdivide(plateau, pc), top = L.TOP + L.RISE;
    surface(b, pring, top, 0.1, (x, z, r) => {
      const v = 0.94 + r() * 0.1;
      if (nearAnchor(1, x, z, 1.9) || nearAnchor(2, x, z, 1.5)) return ['sandDark', 0.98 * v];
      return [hash(x, 2, z, 5) > 0.8 ? 'grassDark' : 'grass', v];
    }, 31, 1.5);
    pring.forEach((a, i) => {
      const c = pring[(i + 1) % pring.length], n = edgeOut(a, c), lip = top - 0.14;
      orient(b, [a[0], lip, a[1]], [c[0], lip, c[1]], [c[0], top, c[1]], n, 'grassDark', 0.92);
      orient(b, [a[0], lip, a[1]], [c[0], top, c[1]], [a[0], top, a[1]], n, 'grassDark', 0.92);
      orient(b, [a[0], L.TOP - 0.06, a[1]], [c[0], L.TOP - 0.06, c[1]], [c[0], lip, c[1]], n, 'soil', 1.06);
      orient(b, [a[0], L.TOP - 0.06, a[1]], [c[0], lip, c[1]], [a[0], lip, a[1]], n, 'soil', 1.06);
    });
    // Cliff strata: concentric offset rings stepping outward and down.
    const far = poly.subdivide(poly.offset(outline, 1), counts);
    const dirs = far.map((p, i) => { const dx = p[0] - ring0[i][0], dz = p[1] - ring0[i][1], l = Math.hypot(dx, dz) || 1; return [dx / l, dz / l]; });
    const rings = L.STRATA.map(([y, off], k) => {
      if (k === 0) return ring0.map(([x, z]) => [x, y, z]);
      const r = poly.subdivide(poly.offset(outline, off), counts);
      return r.map(([x, z], i) => { const j = (hash(x, k, z, 7) - 0.5) * 0.22 * (k > 1 ? 1 : 0.3); return [x + dirs[i][0] * j, y + (k < L.STRATA.length - 1 ? (hash(z, k, x, 9) - 0.5) * 0.08 : 0), z + dirs[i][1] * j]; });
    });
    for (let k = 0; k < rings.length - 1; k++) {
      const up = rings[k], lo = rings[k + 1], [, , slot, shade] = L.STRATA[k + 1], n = up.length;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n, out = edgeOut(ring0[i], ring0[j]), s = shade * (0.93 + hash(i, k, 3, 1) * 0.12);
        orient(b, up[i], up[j], lo[j], out, slot, s); orient(b, up[i], lo[j], lo[i], out, slot, s);
      }
    }
    for (const it of L.ISLETS) {
      b.dodeca({pos: [it.x, 0, it.z], scale: [it.r, it.h, it.r * 0.86], rot: [0, it.x, 0], jitter: 0.1, slot: 'rock', seed: Math.abs(it.x * 13) | 0,
        paint: ({n}) => n.y > 0.62 ? {slot: 'sand'} : n.y > 0.2 ? {slot: 'rock'} : {slot: 'rockDark'}});
    }
    return mesh(b, {receive: true, name: 'terrain'});
  }
  // ---- Sea: rings offset from the waterline; aShore = distance from shore.
  function buildSea(step, nRings) {
    const all = [0, 0.4, 0.9, 1.6, 2.5, 3.7, 5.2, 7.2, 10, 13.5, 18, 24, 31, 40, 50];
    const ds = nRings >= all.length ? all : all.filter((d, i) => i < 4 || i === all.length - 1 || i % 2 === 0);
    const counts = poly.counts(outline, step), n = counts.reduce((a, c) => a + c, 0);
    const pos = new Float32Array(ds.length * n * 3), shore = new Float32Array(ds.length * n), idx = [];
    ds.forEach((d, j) => poly.subdivide(poly.offset(outline, L.WATERLINE_OFFSET - 0.06 + d), counts).forEach(([x, z], i) => {
      const k = j * n + i; pos[k * 3] = x; pos[k * 3 + 1] = 0; pos[k * 3 + 2] = z;
      shore[k] = d + (j > 0 && j < ds.length - 1 ? (hash(x, 4, z, 2) - 0.5) * Math.min(0.35, d * 0.3) : 0);
    }));
    for (let j = 0; j < ds.length - 1; j++) for (let i = 0; i < n; i++) {
      const a = j * n + i, b2 = j * n + (i + 1) % n, c = (j + 1) * n + (i + 1) % n, d = (j + 1) * n + i;
      idx.push(a, c, b2, a, d, c);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aShore', new THREE.BufferAttribute(shore, 1));
    g.setIndex(idx); g.computeVertexNormals();
    if (g.getAttribute('normal').getY(0) < 0) { for (let t = 0; t < idx.length; t += 3) { const s = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = s; } g.setIndex(idx); g.computeVertexNormals(); }
    g.computeBoundingSphere();
    return g;
  }
  const seaMat = mats.sea();
  const sea = new THREE.Mesh(buildSea(Qs.seaStep, Qs.seaRings), seaMat);
  sea.name = 'sea'; sea.receiveShadow = false; sea.renderOrder = 1; sea.matrixAutoUpdate = false;
  scene.add(sea);
  const terrain = buildTerrain();
  // ---- Static props, merged. View-frame helpers: W(z, x, dz) -> world [x, y, z].
  const groundAt = (x, z) => poly.signed(plateau, x, z) < 0 ? L.TOP + L.RISE : L.TOP;
  const W = (z, x, dz, lift = 0) => { const [wx, wz] = L.local(z, x, dz); return [wx, groundAt(wx, wz) + lift, wz]; };
  const yawOf = z => L.ZONES[z].azimuth;
  const lanternSpots = [];
  const dockA = outline[L.DOCK.edge], dockB = outline[(L.DOCK.edge + 1) % outline.length];
  const dockP = [dockA[0] + (dockB[0] - dockA[0]) * L.DOCK.t, dockA[1] + (dockB[1] - dockA[1]) * L.DOCK.t];
  const dockN = edgeOut(dockA, dockB), dockYaw = Math.atan2(dockN[0], dockN[2]);
  function buildDecor() {
    const b = new Builder(5);
    const post = (x, y, z, h = 1.5) => { b.box({pos: [x, y, z], scale: [0.12, h, 0.12], base: true, slot: 'woodDark'}); b.box({pos: [x, y + h, z], scale: [0.34, 0.06, 0.06], slot: 'woodDark'}); lanternSpots.push([x + 0.14, y + h - 0.22, z]); };
    // Dock: steps down the cliff, a deck on posts, crates.
    b.within(dockP[0], 0, dockP[1], dockYaw, () => {
      for (let i = 0; i < 6; i++) b.box({pos: [0, L.TOP - 0.1 - i * 0.42, -0.7 + i * 0.42], scale: [1.5, 0.12, 0.44], slot: i % 2 ? 'plank' : 'wood'});
      for (let i = 0; i < 9; i++) b.box({pos: [0, 0.62, 2.0 + i * 0.5], scale: [1.9, 0.1, 0.44], slot: i % 2 ? 'plank' : 'wood', shade: 0.96 + (i % 3) * 0.03});
      for (const s of [-1, 1]) for (let i = 0; i < 4; i++) b.prism(6, {pos: [s * 0.92, -0.6, 1.9 + i * 1.3], scale: [0.11, 1.4, 0.11], base: true, slot: 'woodDark'});
      for (const s of [-1, 1]) b.box({pos: [s * 0.95, 0.55, 3.9], scale: [0.08, 0.08, 4.4], slot: 'woodDark'});
      b.box({pos: [0.5, 0.67, 2.4], scale: 0.5, base: true, slot: 'wood', rot: [0, 0.3, 0]});
      b.prism(8, {pos: [-0.5, 0.67, 2.9], scale: [0.26, 0.6, 0.26], base: true, slot: 'woodDark'});
      post(-0.95, 0.67, 6.1, 1.4); post(0.95, 0.67, 6.1, 1.4); post(0.85, L.TOP, -1.6, 1.4);
    });
    // Shore rocks, avoiding the dock and the two sea-side cameras.
    const r = rng(44);
    for (let i = 0; i < 26; i++) {
      const [x, z] = poly.subdivide(outline, poly.counts(outline, 3))[Math.floor(r() * 30) % 30] || [0, 0];
      const o = poly.offset(outline, 0.9 + r() * 1.6), k = Math.floor(r() * o.length), t = r();
      const p = [o[k][0] + (o[(k + 1) % o.length][0] - o[k][0]) * t, o[k][1] + (o[(k + 1) % o.length][1] - o[k][1]) * t];
      if (Math.hypot(p[0] - dockP[0], p[1] - dockP[1]) < 4 || L.ZONES.some((zn, j) => Math.hypot(...[0, 1].map(q => p[q] - L.local(j, 0, 8)[q])) < 4.5)) continue;
      const s = 0.4 + r() * 0.9;
      b.dodeca({pos: [p[0], -0.2 + r() * 0.3, p[1]], scale: [s * 1.2, s * (0.7 + r() * 0.5), s], rot: [0, r() * 6, 0], jitter: 0.12, slot: 'rock', paint: ({n}) => n.y > 0.7 ? {slot: 'stone'} : n.y < 0 ? {slot: 'rockDark'} : null});
      void x; void z;
    }
    // Bushes along the plateau lip and a few on the beach.
    const pr = poly.subdivide(plateau, poly.counts(plateau, 2.6));
    pr.forEach(([x, z], i) => {
      if (i % 2 || L.ZONES.some((zn, j) => Math.hypot(x - zn.anchor[0], z - zn.anchor[1]) < 3.2 || Math.hypot(x - L.local(j, 0, 6)[0], z - L.local(j, 0, 6)[1]) < 3)) return;
      const s = 0.42 + hash(x, 0, z, 2) * 0.3;
      b.ico({pos: [x, L.TOP + L.RISE + s * 0.3, z], scale: [s * 1.3, s, s * 1.2], jitter: 0.08, slot: i % 4 ? 'leafB' : 'leafA', wind: 0.04});
    });
    // Forest: stumps under the choppable trees, a chopping block with an axe.
    for (const c of L.CHOP) { const p = W(1, ...c.at); b.prism(7, {pos: p, scale: [0.3 * c.s, 0.32, 0.3 * c.s], base: true, slot: 'treeTrunk', shade: 0.9}); }
    { const p = W(1, -1.9, 0.9); b.prism(7, {pos: p, scale: [0.36, 0.4, 0.36], base: true, slot: 'wood'}); b.prism(7, {pos: [p[0], p[1] + 0.4, p[2]], scale: [0.34, 0.02, 0.34], base: true, slot: 'plank'});
      b.box({pos: [p[0] + 0.1, p[1] + 0.68, p[2]], scale: [0.06, 0.6, 0.06], rot: [0, 0, -0.5], slot: 'woodDark'}); b.box({pos: [p[0] - 0.02, p[1] + 0.46, p[2]], scale: [0.26, 0.16, 0.05], rot: [0, 0, -0.5], slot: 'metal'}); }
    // Field: soil bed, ridges, a fence open toward the avatar, a scarecrow.
    const F = L.FIELD, fy = yawOf(2), fc = W(2, ...F.at);
    b.within(fc[0], fc[1], fc[2], fy, () => {
      b.box({pos: [0, -0.1, 0], scale: [F.w + 0.4, 0.24, F.d + 0.4], slot: 'fieldSoil'});
      for (let i = 0; i < F.rows; i++) b.box({pos: [0, 0.02, F.d / 2 - (i + 0.5) * F.d / F.rows], scale: [F.w - 0.3, 0.16, 0.34], slot: 'fieldRidge'});
      const hx = F.w / 2 + 0.5, hz = F.d / 2 + 0.5;
      for (let i = 0; i <= 12; i++) { const x = -hx + i * hx / 6; b.box({pos: [x, 0, -hz], scale: [0.1, 0.8, 0.1], base: true, slot: 'woodDark'}); if (Math.abs(x) > 1.6) b.box({pos: [x, 0, hz], scale: [0.1, 0.8, 0.1], base: true, slot: 'woodDark'}); }
      for (let i = 0; i <= 8; i++) { const z = -hz + i * hz / 4; for (const s of [-1, 1]) b.box({pos: [s * hx, 0, z], scale: [0.1, 0.8, 0.1], base: true, slot: 'woodDark'}); }
      for (const y of [0.35, 0.65]) { b.box({pos: [0, y, -hz], scale: [hx * 2, 0.06, 0.05], slot: 'wood'}); for (const s of [-1, 1]) { b.box({pos: [s * hx, y, 0], scale: [0.05, 0.06, hz * 2], slot: 'wood'}); b.box({pos: [s * (hx + 1.6) / 2, y, hz], scale: [hx - 1.6, 0.06, 0.05], slot: 'wood'}); } }
      const [sx, sz] = F.scarecrow;
      b.box({pos: [sx, 0, sz], scale: [0.09, 1.9, 0.09], base: true, slot: 'woodDark'}); b.box({pos: [sx, 1.35, sz], scale: [1.3, 0.08, 0.08], slot: 'woodDark'});
      b.box({pos: [sx, 1.1, sz], scale: [0.5, 0.6, 0.3], slot: 'accent'}); b.dodeca({pos: [sx, 1.72, sz], scale: 0.22, slot: 'thatch'});
      b.cone(8, {pos: [sx, 1.86, sz], scale: [0.4, 0.34, 0.4], base: true, slot: 'thatchDark'});
    });
    // Camp: stone fire ring, logs to sit on, flag pole.
    const fp = W(3, ...L.CAMP.fire);
    for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; b.dodeca({pos: [fp[0] + Math.cos(a) * 0.55, fp[1] + 0.08, fp[2] + Math.sin(a) * 0.55], scale: [0.18, 0.13, 0.16], slot: 'stone', jitter: 0.03}); }
    for (let i = 0; i < 3; i++) b.prism(6, {pos: [fp[0], fp[1] + 0.12, fp[2]], scale: [0.07, 0.8, 0.07], rot: [0, i * 2.1, 1.25], slot: 'woodDark'});
    { const p = W(3, -3.2, 2.0); b.prism(7, {pos: p, scale: [0.2, 1.4, 0.2], rot: [0, yawOf(3), Math.PI / 2], slot: 'wood'}); }
    const flag = W(3, ...L.CAMP.flag);
    b.prism(6, {pos: flag, scale: [0.07, 3.4, 0.07], base: true, slot: 'woodDark'});
    for (let i = 0; i < 2; i++) b.leaf([flag[0], flag[1] + 3.35 - i * 0.35, flag[2]], [flag[0] + 1.0, flag[1] + 3.15 - i * 0.35, flag[2] + 0.1], [flag[0], flag[1] + 3.0 - i * 0.35, flag[2]], 'accent', 1, [0, 0.3, 0]);
    // Palm zone: woven basket, lantern posts on the camp, palm grove and field.
    const bp = W(0, ...L.BASKET);
    b.prism(8, {pos: bp, scale: [0.55, 0.5, 0.55], base: true, slot: 'thatchDark'}, 1.25); b.prism(8, {pos: [bp[0], bp[1] + 0.5, bp[2]], scale: [0.7, 0.07, 0.7], base: true, slot: 'wood'});
    for (const [z, x, dz] of [[3, -4.6, 0.6], [3, 4.4, 0.4], [0, -3.8, 1.0], [2, 4.9, 0.6], [1, 3.9, 0.9]]) post(...W(z, x, dz), 1.7);
    return mesh(b, {cast: true, wind: true, name: 'decor'});
  }
  const decor = buildDecor();
  const lanterns = (() => {
    const b = new Builder(6);
    for (const [x, y, z] of lanternSpots) { b.box({pos: [x, y + 0.02, z], scale: [0.2, 0.26, 0.2], slot: 'lantern', glow: 0.9}); b.cone(4, {pos: [x, y + 0.15, z], scale: [0.18, 0.14, 0.18], base: true, slot: 'roofDark'}); }
    return mesh(b, {mat: glowMat, name: 'lanterns'});
  })();
  // ---- Palms (instanced) and coconuts (hanging, in the basket, falling).
  const NUT_LOCAL = [];
  const palmGeo = (() => {
    const b = new Builder(8), H = 3.0, c = t => [0.75 * t * t, H * t, 0];
    for (let i = 0; i < 6; i++) {
      const a = c(i / 6), e = c((i + 1) / 6), len = Math.hypot(e[0] - a[0], e[1] - a[1]), th = Math.atan2(e[0] - a[0], e[1] - a[1]), rad = 0.2 - i * 0.014;
      b.prism(6, {pos: a, scale: [rad, len * 1.04, rad], rot: [0, 0, -th], base: true, slot: i % 2 ? 'palmTrunkDark' : 'palmTrunk', vary: 0.02, wind: q => q[1] / H * 0.09}, 0.86);
    }
    const top = c(1);
    for (let k = 0; k < 7; k++) {
      const ang = k / 7 * Math.PI * 2 + hash(k, 1, 2, 3) * 0.5, d = [Math.cos(ang), Math.sin(ang)], n = [-d[1], d[0]], len = 1.75 + hash(k, 2, 1, 4) * 0.3;
      const at = s => [top[0] + d[0] * s * len, top[1] + 0.35 * s - 1.15 * s * s, top[2] + d[1] * s * len];
      for (let j = 0; j < 4; j++) {
        const s0 = j / 4, s1 = (j + 1) / 4, c0 = at(s0), c1 = at(s1), w0 = 0.38 * Math.sin(Math.PI * Math.min(1, s0 * 1.15 + 0.08)), w1 = 0.38 * Math.sin(Math.PI * Math.min(1, s1 * 1.15));
        const side = (c, w, sg) => [c[0] + n[0] * w * sg, c[1] - 0.14 * w, c[2] + n[1] * w * sg], slot = k % 2 ? 'palmLeaf' : 'palmLeafDark';
        for (const sg of [-1, 1]) b.leaf(c0, c1, side(c1, w1, sg), slot, 1, [s0 * 0.3, s1 * 0.3, s1 * 0.3]).leaf(c0, side(c1, w1, sg), side(c0, w0, sg), slot, 0.94, [s0 * 0.3, s1 * 0.3, s0 * 0.3]);
      }
    }
    for (let k = 0; k < 4; k++) { const a = k * Math.PI / 2 + 0.4; NUT_LOCAL.push(new THREE.Vector3(top[0] + Math.cos(a) * 0.22, top[1] - 0.24, top[2] + Math.sin(a) * 0.22)); }
    return b;
  })();
  const palmsMesh = inst(palmGeo, L.PALMS.length + 1, {cast: true, wind: true, name: 'palms'});
  const palms = L.PALMS.map((p, i) => {
    const {right, toward} = L.zoneFrame(0), vx = Math.sin(p.lean), vz = -Math.cos(p.lean);
    const dw = [right[0] * vx + toward[0] * vz, right[1] * vx + toward[1] * vz];
    return {pos: W(0, ...p.at), ry: Math.atan2(-dw[1], dw[0]), s: p.s, nuts: p.nuts, shake: -9, i, m: new THREE.Matrix4()};
  });
  const islet = L.ISLETS[0];
  setTRS(palmsMesh, L.PALMS.length, islet.x + islet.palm[0], islet.h * 0.86, islet.z + islet.palm[1], 2.2, islet.palm[2]);
  const nutGeo = new Builder(9).dodeca({scale: 0.17, slot: 'coconut', vary: 0.1});
  const NUT_HANG = NUTS, NUT_BASKET = BASKET_MAX, NUT_FALL = 6;
  const nutsMesh = inst(nutGeo, NUT_HANG + NUT_BASKET + NUT_FALL, {name: 'coconuts'});
  const nutSlots = [];
  palms.forEach(p => { for (let k = 0; k < p.nuts; k++) nutSlots.push({palm: p.i, k}); });
  // Round-robin removal order so every palm thins out evenly.
  const nutOrder = nutSlots.map((s, i) => i).sort((a, b) => (nutSlots[a].k - nutSlots[b].k) || (nutSlots[a].palm - nutSlots[b].palm));
  const basketAt = W(0, ...L.BASKET);
  const BASKET_POS = (() => { const out = [], lay = [[7, 0.3, 0.09], [4, 0.17, 0.27], [1, 0, 0.42]]; for (const [n, r, y] of lay) for (let k = 0; k < n; k++) { const a = k / n * Math.PI * 2 + y * 3; out.push([Math.cos(a) * r, 0.48 + y, Math.sin(a) * r]); } return out; })();
  function palmMatrix(p, t) {
    const age = t - p.shake, amp = age >= 0 && age < 1.6 ? Math.exp(-age * 3.2) * Math.sin(age * 22) * 0.12 * (reduced ? 0.5 : 1) : 0;
    E1.set(0, p.ry, -amp, 'YXZ'); Q1.setFromEuler(E1);
    return p.m.compose(V1.set(p.pos[0], p.pos[1] - 0.05, p.pos[2]), Q1, S1.set(p.s, p.s, p.s));
  }
  // ---- Forest: background broadleaf + pines (instanced), choppable trees are broadleaf 0..4.
  const leafGeo = (() => {
    const b = new Builder(12);
    b.prism(6, {scale: [0.2, 1.3, 0.2], base: true, slot: 'treeTrunk'}, 0.7);
    b.ico({pos: [0, 2.05, 0], scale: [1.05, 0.95, 1.0], jitter: 0.1, slot: 'leafA', wind: q => 0.05 * clamp(q[1] - 1.2)});
    b.ico({pos: [0.5, 1.7, 0.25], scale: 0.66, jitter: 0.08, slot: 'leafB', wind: 0.04});
    b.ico({pos: [-0.42, 2.45, -0.2], scale: 0.6, jitter: 0.08, slot: 'leafB', wind: 0.05});
    return b;
  })();
  const pineGeo = (() => {
    const b = new Builder(13);
    b.prism(6, {scale: [0.16, 0.8, 0.16], base: true, slot: 'treeTrunk'}, 0.8);
    [[0.6, 1.0, 1.35], [1.3, 0.85, 1.1], [1.95, 0.62, 0.95]].forEach(([y, r, h], i) => b.cone(7, {pos: [0, y, 0], scale: [r, h, r], base: true, slot: i % 2 ? 'pineDark' : 'pine', jitter: 0.03, wind: q => 0.03 * clamp(q[1] - 0.8)}));
    return b;
  })();
  const chopAt = L.CHOP.map(c => W(1, ...c.at)), logAt = W(1, ...L.LOG_PILE);
  const chopBlock = W(1, -1.9, 0.9), fieldC = W(2, ...L.FIELD.at), fieldYaw = yawOf(2);
  const inField = (x, z, pad) => { const dx = x - fieldC[0], dz = z - fieldC[2], c = Math.cos(fieldYaw), s = Math.sin(fieldYaw);
    const u = dx * c - dz * s, v = dx * s + dz * c; return Math.abs(u) < L.FIELD.w / 2 + pad && Math.abs(v) < L.FIELD.d / 2 + pad; };
  const trees = (() => {
    const r = rng(77), out = [];
    for (let k = 0; k < 900 && out.length < 60; k++) {
      const x = -17 + r() * 34, z = -12.5 + r() * 15;
      const sd = poly.signed(plateau, x, z);
      if (sd > -0.9) continue;
      const inForest = poly.inside(L.FOREST, x, z), backdrop = z < -8.2 && sd < -0.9;
      if (!inForest && !backdrop) continue;
      if (inField(x, z, 1.4) || Math.hypot(x - logAt[0], z - logAt[2]) < 1.6 || Math.hypot(x - chopBlock[0], z - chopBlock[2]) < 1.2) continue;
      if (chopAt.some(c => Math.hypot(x - c[0], z - c[2]) < 1.8)) continue;
      // Keep a clearing around the forest anchor and the corridor to its camera.
      const a = L.ZONES[1].anchor, {toward} = L.zoneFrame(1), dx = x - a[0], dz = z - a[1], along = dx * toward[0] + dz * toward[1], side = Math.abs(dx * toward[1] - dz * toward[0]);
      if (Math.hypot(dx, dz) < 3.2 || (along > -1 && side < 4.5)) continue;
      if (out.some(t => Math.hypot(t[0] - x, t[1] - z) < 1.55)) continue;
      out.push([x, z, 0.8 + r() * 0.4, r() * 6.28, r() < 0.42 ? 'pine' : 'leaf']);
    }
    return out;
  })();
  const bgLeaf = trees.filter(t => t[4] === 'leaf'), bgPine = trees.filter(t => t[4] === 'pine');
  const leafMesh = inst(leafGeo, L.CHOP.length + bgLeaf.length, {cast: true, wind: true, color: true, name: 'trees'});
  const pineMesh = inst(pineGeo, bgPine.length, {cast: true, wind: true, color: true, name: 'pines'});
  bgLeaf.forEach(([x, z, s, ry], i) => { setTRS(leafMesh, L.CHOP.length + i, x, L.TOP + L.RISE - 0.05, z, ry, s); leafMesh.setColorAt(L.CHOP.length + i, TMP.setRGB(0.9 + hash(x, 0, z, 1) * 0.2, 0.92 + hash(z, 0, x, 2) * 0.14, 0.9)); });
  bgPine.forEach(([x, z, s, ry], i) => { setTRS(pineMesh, i, x, L.TOP + L.RISE - 0.05, z, ry, s * 1.05); pineMesh.setColorAt(i, TMP.setRGB(0.92 + hash(x, 3, z, 1) * 0.16, 1, 0.95)); });
  const chops = L.CHOP.map((c, i) => {
    const p = chopAt[i], a = L.ZONES[1].anchor, dx = p[0] - a[0], dz = p[2] - a[1], l = Math.hypot(dx, dz) || 1;
    return {pos: p, s: c.s, ry: i * 1.7, dir: new THREE.Vector3(dx / l, 0, dz / l), axis: new THREE.Vector3(dz / l, 0, -dx / l), fall: -1, fallen: false, shake: -9};
  });
  function chopMatrix(c, t) {
    let ang = 0;
    if (c.fall >= 0) { const k = (t - c.fall) / 0.9; ang = k < 1 ? 1.43 * k * k : 1.43 - Math.exp(-(k - 1) * 6) * Math.sin((k - 1) * 18) * 0.06; }
    else { const age = t - c.shake; if (age >= 0 && age < 0.7) ang = Math.exp(-age * 7) * Math.sin(age * 40) * 0.07; }
    const sink = c.fall >= 0 ? clamp((t - c.fall - 1.25) / 0.5) : 0;
    if (c.fallen && c.fall < 0) return HIDE;
    if (sink >= 1) { c.fallen = true; return HIDE; }
    Q1.setFromAxisAngle(c.axis, ang); E1.set(0, c.ry, 0); const q2 = new THREE.Quaternion().setFromEuler(E1);
    const s = c.s * (1 - sink);
    return M4.compose(V1.set(c.pos[0], c.pos[1] - 0.04, c.pos[2]), Q1.multiply(q2), S1.set(s, s, s));
  }
  // ---- Logs: forest pile (0..LOG_MAX-1) and camp woodpile (LOG_MAX..), ends facing the camera.
  const logGeo = new Builder(14).prism(6, {scale: [0.17, 1.05, 0.17], rot: [0, 0, Math.PI / 2], slot: 'wood', paint: ({n}) => Math.abs(n.x) > 0.8 ? {slot: 'plank'} : null});
  const CAMP_LOGS = 12, logsMesh = inst(logGeo, LOG_MAX + CAMP_LOGS, {cast: true, name: 'logs'});
  const pileSlots = (z, at, rows) => {
    const {right, toward} = L.zoneFrame(z), ry = Math.atan2(-toward[1], toward[0]), out = [];
    rows.forEach((n, row) => { for (let k = 0; k < n; k++) { const u = (k - (n - 1) / 2) * 0.36; out.push([at[0] + right[0] * u, at[1] + 0.17 + row * 0.29, at[2] + right[1] * u, ry]); } });
    return out;
  };
  const logSlots = [...pileSlots(1, logAt, [4, 3, 2, 1]), ...pileSlots(3, W(3, ...L.CAMP.wood), [5, 4, 3])];
  const logBorn = new Float32Array(logSlots.length).fill(-1);
  // ---- Crops: green and golden variants, one instance per plant.
  const cropGeo = gold => { const b = new Builder(gold ? 16 : 15);
    for (let k = 0; k < 4; k++) { const a = k * Math.PI / 2 + 0.3, h = 0.72 + (k % 2) * 0.14;
      b.leaf([Math.cos(a + 1.4) * 0.05, 0, Math.sin(a + 1.4) * 0.05], [Math.cos(a) * 0.26, h, Math.sin(a) * 0.26], [Math.cos(a - 1.4) * 0.05, 0, Math.sin(a - 1.4) * 0.05], gold ? (k % 2 ? 'thatch' : 'thatchDark') : (k % 2 ? 'sprout' : 'grass'), 1, [0, 0.06, 0]); }
    b.octa({pos: [0, 0.9, 0], scale: [0.08, 0.2, 0.08], slot: gold ? 'thatch' : 'grassDark', shade: gold ? 1.12 : 1, wind: 0.06});
    return b; };
  const F = L.FIELD, nCrops = F.rows * F.perRow;
  const greenMesh = inst(cropGeo(false), nCrops, {cast: true, wind: true, name: 'crops'});
  const goldMesh = inst(cropGeo(true), nCrops, {wind: true, name: 'cropsGold'});
  const cropSlots = [];
  for (let i = 0; i < F.rows; i++) for (let j = 0; j < F.perRow; j++) {
    const u = -(F.w - 0.8) / 2 + j * (F.w - 0.8) / (F.perRow - 1) + (hash(i, j, 1, 5) - 0.5) * 0.2, v = F.d / 2 - (i + 0.5) * F.d / F.rows;
    const c = Math.cos(fieldYaw), s = Math.sin(fieldYaw);
    cropSlots.push({row: i, x: fieldC[0] + u * c + v * s, y: fieldC[1] + 0.08, z: fieldC[2] - u * s + v * c, ry: hash(j, i, 2, 3) * 6.28});
  }
  const field = {target: new Float32Array(F.rows), shown: new Float32Array(F.rows), pop: new Float32Array(F.rows).fill(-9), ripeAt: -1, dirty: true};
  function updateCrops(t, dt) {
    let busy = field.dirty; field.dirty = false;
    for (let i = 0; i < F.rows; i++) {
      const d = field.target[i] - field.shown[i];
      if (Math.abs(d) > 1e-3) { field.shown[i] += Math.sign(d) * Math.min(Math.abs(d), dt * 2.6); busy = true; }
      if (t - field.pop[i] < 0.6) busy = true;
    }
    if (field.ripeAt >= 0 && t - field.ripeAt < F.rows * 0.12 + 0.6) busy = true;
    if (!busy) return;
    cropSlots.forEach((c, k) => {
      const g = field.shown[c.row], age = t - field.pop[c.row], pop = age < 0.6 ? 1 + Math.exp(-age * 6) * Math.sin(age * 18) * 0.22 : 1;
      const gold = field.ripeAt >= 0 && t - field.ripeAt > c.row * 0.12;
      const sy = (0.14 + 0.86 * g) * pop, sx = 0.55 + 0.45 * g;
      setTRS(gold ? goldMesh : greenMesh, k, c.x, c.y, c.z, c.ry, [sx, sy, sx]);
      (gold ? greenMesh : goldMesh).setMatrixAt(k, HIDE);
    });
    greenMesh.instanceMatrix.needsUpdate = goldMesh.instanceMatrix.needsUpdate = true;
  }
  // ---- Camp: 7 house levels built bottom-up so drawRange can reveal them while building.
  function cabin(b, {w = 2.6, d = 2.1, h = 1.4, stone = 0.22, roof = 'roof', storey = 0, logs = true, corner = 'woodDark', door = true}) {
    b.box({pos: [0, 0, 0], scale: [w + 0.2, stone, d + 0.2], base: true, slot: 'stone', jitter: 0.02});
    const n = logs ? 4 : 1, lh = (h - stone) / n, dy = Math.min(stone, 0.25);
    for (let i = 0; i < n && lh > 0.05; i++) { const y = stone + i * lh, sl = i % 2 ? 'woodDark' : 'wood';
      b.box({pos: [0, y, d / 2 - 0.08], scale: [w, lh * 0.94, 0.18], base: true, slot: sl}); b.box({pos: [0, y, -d / 2 + 0.08], scale: [w, lh * 0.94, 0.18], base: true, slot: sl});
      b.box({pos: [w / 2 - 0.08, y, 0], scale: [0.18, lh * 0.94, d - 0.3], base: true, slot: sl}); b.box({pos: [-w / 2 + 0.08, y, 0], scale: [0.18, lh * 0.94, d - 0.3], base: true, slot: sl}); }
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box({pos: [sx * w / 2, 0, sz * d / 2], scale: [0.2, h + storey, 0.2], base: true, slot: corner});
    if (storey) b.box({pos: [0, h, 0], scale: [w + 0.1, storey, d + 0.1], base: true, slot: 'wall'});
    const top = h + storey, rh = 0.55 + w * 0.22, half = d / 2 + 0.3, th = Math.atan2(rh, half), len = Math.hypot(rh, half) + 0.08;
    for (const s of [-1, 1]) orient(b, [s * w / 2, top, -d / 2], [s * w / 2, top, d / 2], [s * w / 2, top + rh - 0.04, 0], [s, 0, 0], 'wall', 0.94);
    for (const s of [-1, 1]) b.box({pos: [0, top + rh / 2 + 0.02, s * half / 2], scale: [w + 0.5, 0.12, len], rot: [s * th, 0, 0], slot: s > 0 ? roof : roof + 'Dark'});
    b.box({pos: [0, top + rh + 0.03, 0], scale: [w + 0.56, 0.12, 0.16], slot: 'woodDark'});
    if (door) { b.box({pos: [0, dy, d / 2 + 0.11], scale: [0.62, 0.95, 0.06], base: true, slot: 'door'}); b.box({pos: [0, dy + 0.95, d / 2 + 0.12], scale: [0.78, 0.1, 0.07], slot: 'woodDark'}); }
    for (const s of [-1, 1]) { b.box({pos: [s * w * 0.3, dy + 0.62, d / 2 + 0.11], scale: [0.42, 0.42, 0.05], slot: 'window', glow: 0.25}); b.box({pos: [s * w * 0.3, dy + 0.38, d / 2 + 0.14], scale: [0.54, 0.07, 0.1], slot: 'woodDark'}); }
    if (storey) for (const s of [-1, 0, 1]) b.box({pos: [s * w * 0.3, h + storey * 0.5, d / 2 + 0.08], scale: [0.36, 0.34, 0.05], slot: 'window', glow: 0.3});
    return top + rh;
  }
  function houseLevel(level) {
    const b = new Builder(40 + level), marks = [], add = b.add.bind(b);
    b.add = (arr, o) => { marks.push(b.pos.length / 9); return add(arr, o); };
    if (level === 0) {
      for (const [x, z] of [[-1.3, -1], [1.3, -1], [1.3, 1], [-1.3, 1]]) b.box({pos: [x, 0, z], scale: [0.09, 0.55, 0.09], base: true, slot: 'wood'});
      for (const [x, z, sx, sz] of [[0, -1, 2.6, 0.03], [0, 1, 2.6, 0.03], [-1.3, 0, 0.03, 2], [1.3, 0, 0.03, 2]]) b.box({pos: [x, 0.42, z], scale: [sx, 0.03, sz], slot: 'rope'});
      for (let i = 0; i < 5; i++) b.dodeca({pos: [-0.5 + (i % 3) * 0.3, 0.12 + (i > 2 ? 0.2 : 0), -0.2 + (i % 2) * 0.25], scale: 0.18, slot: 'stone'});
      b.box({pos: [0.7, 0, 0.5], scale: [0.08, 0.8, 0.08], base: true, slot: 'woodDark'}); b.box({pos: [0.7, 0.72, 0.5], scale: [0.6, 0.32, 0.05], slot: 'plank'});
    } else if (level === 1) {
      b.box({pos: [0, 0, 0], scale: [2.0, 0.08, 1.6], base: true, slot: 'thatchDark'});
      for (const s of [-1, 1]) { b.box({pos: [s * 0.9, 0, 0.7], scale: [0.12, 1.45, 0.12], base: true, slot: 'wood'}); b.box({pos: [s * 0.9, 0, -0.7], scale: [0.12, 0.6, 0.12], base: true, slot: 'wood'}); }
      b.box({pos: [0, 1.0, 0], scale: [2.3, 0.1, 1.75], rot: [-0.62, 0, 0], slot: 'thatch'}); b.box({pos: [0, 1.06, 0.02], scale: [2.2, 0.08, 1.5], rot: [-0.62, 0, 0], slot: 'thatchDark'});
      b.box({pos: [-0.3, 0.08, 0.1], scale: [0.9, 0.14, 0.45], base: true, slot: 'cloth'}); b.box({pos: [0.55, 0, 0.35], scale: 0.32, base: true, slot: 'wood'});
    } else if (level === 2) {
      b.prism(8, {pos: [0, 0, 0], scale: [1.35, 0.12, 1.35], base: true, slot: 'stone'});
      b.prism(8, {pos: [0, 0.12, 0], scale: [1.15, 1.0, 1.15], base: true, slot: 'wood'}); b.prism(8, {pos: [0, 0.55, 0], scale: [1.17, 0.12, 1.17], base: true, slot: 'woodDark'});
      b.cone(8, {pos: [0, 1.05, 0], scale: [1.6, 1.25, 1.6], base: true, slot: 'thatch'}); b.cone(8, {pos: [0, 1.75, 0], scale: [0.75, 0.75, 0.75], base: true, slot: 'thatchDark'});
      b.box({pos: [0, 0.12, 1.12], scale: [0.55, 0.85, 0.1], base: true, slot: 'door'}); b.box({pos: [0, 1.0, 1.15], scale: [0.7, 0.08, 0.1], slot: 'woodDark'});
    } else if (level === 3) cabin(b, {});
    else if (level === 4) { cabin(b, {w: 3.0, d: 2.3, h: 1.6, stone: 0.4}); b.box({pos: [1.0, 1.4, -0.5], scale: [0.4, 1.6, 0.4], base: true, slot: 'stone'}); for (let i = 0; i < 5; i++) b.box({pos: [-2.1, 0, 1.3 - i * 0.55], scale: [0.09, 0.62, 0.09], base: true, slot: 'woodDark'}); b.box({pos: [-2.1, 0.45, 0.2], scale: [0.05, 0.06, 2.3], slot: 'wood'}); }
    else if (level === 5) { cabin(b, {w: 3.1, d: 2.4, h: 1.2, stone: 1.2, logs: false, storey: 0.95, roof: 'roof', corner: 'stoneDark'});
      b.within(-1.75, 0, -0.85, 0, () => { b.prism(6, {scale: [0.8, 2.6, 0.8], base: true, slot: 'stone'}); b.prism(6, {pos: [0, 2.6, 0], scale: [0.95, 0.3, 0.95], base: true, slot: 'stoneDark'}); b.cone(6, {pos: [0, 2.9, 0], scale: [1.0, 0.95, 1.0], base: true, slot: 'roofDark'}); b.box({pos: [0, 1.9, 0.72], scale: [0.26, 0.4, 0.05], slot: 'window', glow: 0.4}); }); }
    else { cabin(b, {w: 3.6, d: 2.5, h: 1.25, stone: 1.25, logs: false, storey: 0.95, corner: 'stoneDark'});
      b.within(-2.3, 0, -1.0, 0, () => { b.prism(8, {scale: [0.85, 2.9, 0.85], base: true, slot: 'wall'}, 0.86); for (let i = 0; i < 3; i++) b.prism(8, {pos: [0, 0.75 + i * 0.8, 0], scale: [0.86, 0.16, 0.86], base: true, slot: 'accent'}); b.prism(8, {pos: [0, 2.9, 0], scale: [0.55, 0.5, 0.55], base: true, slot: 'lantern', glow: 0.9}); b.cone(8, {pos: [0, 3.4, 0], scale: [0.8, 0.6, 0.8], base: true, slot: 'roofDark'}); });
      for (let i = 0; i < 15; i++) { const a = Math.PI * (0.92 + i / 14 * 1.16), x = Math.cos(a) * 3.3, z = Math.sin(a) * 2.6 - 0.2; b.prism(5, {pos: [x, 0, z], scale: [0.16, 1.2 + (i % 2) * 0.15, 0.16], base: true, slot: 'wood'}); b.cone(5, {pos: [x, 1.2 + (i % 2) * 0.15, z], scale: [0.16, 0.3, 0.16], base: true, slot: 'woodDark'}); }
      b.within(2.7, 0, -0.6, -0.4, () => { b.box({scale: [1.2, 1.0, 1.1], base: true, slot: 'wood'}); b.cone(4, {pos: [0, 1.0, 0], scale: [1.05, 0.6, 1.0], base: true, slot: 'thatch', rot: [0, Math.PI / 4, 0]}); }); }
    return {b, marks: marks.concat(b.pos.length / 9)};
  }
  const houseGroup = new THREE.Group(); houseGroup.name = 'camp';
  houseGroup.position.set(campAt[0], L.TOP, campAt[1]); houseGroup.rotation.y = yawOf(3) + L.CAMP.yaw;
  scene.add(houseGroup); houseGroup.updateMatrixWorld();
  const houses = Array.from({length: 7}, (_, lv) => {
    const {b, marks} = houseLevel(lv), m = mesh(b, {cast: true, parent: houseGroup, name: 'house' + lv, still: false});
    m.visible = false; return {m, marks, box: m.geometry.boundingBox};
  });
  const scaffolds = [];
  function scaffoldFor(lv) {
    if (scaffolds[lv]) return scaffolds[lv];
    const bx = houses[lv].box, b = new Builder(60 + lv), x0 = bx.min.x - 0.35, x1 = bx.max.x + 0.35, z0 = bx.min.z - 0.35, z1 = bx.max.z + 0.35, h = Math.min(3.0, bx.max.y * 0.8 + 0.3);
    for (const x of [x0, x1]) for (const z of [z0, z1]) b.box({pos: [x, 0, z], scale: [0.08, h, 0.08], base: true, slot: 'woodDark'});
    for (const y of [h * 0.45, h * 0.92]) { for (const z of [z0, z1]) b.box({pos: [(x0 + x1) / 2, y, z], scale: [x1 - x0, 0.06, 0.06], slot: 'wood'}); for (const x of [x0, x1]) b.box({pos: [x, y, (z0 + z1) / 2], scale: [0.06, 0.06, z1 - z0], slot: 'wood'}); }
    b.box({pos: [(x0 + x1) / 2, h * 0.45 + 0.05, z1 - 0.2], scale: [x1 - x0, 0.05, 0.4], slot: 'plank'});
    b.box({pos: [(x0 + x1) / 2, h * 0.225, z1], scale: [Math.hypot(x1 - x0, h * 0.45), 0.05, 0.05], rot: [0, 0, Math.atan2(h * 0.45, x1 - x0)], slot: 'wood'});
    const m = mesh(b, {parent: houseGroup, name: 'scaffold' + lv, still: false}); m.visible = false;
    return (scaffolds[lv] = m);
  }
  const camp = {shelter: 0, target: 0, shown: 0, pop: -9, squash: -9, done: false};
  function applyCamp() {
    const lv = camp.shelter, r = camp.shown;
    houses.forEach(h => { h.m.visible = false; h.m.geometry.setDrawRange(0, Infinity); });
    scaffolds.forEach(s => s && (s.visible = false));
    houses[lv].m.visible = true;
    if (r <= 0) return;
    if (lv >= 6) { if (r < 1) scaffoldFor(6).visible = true; return; }
    const nx = houses[lv + 1], st = buildState(r, nx.marks.length - 1);
    nx.m.visible = st.shown > 0; nx.m.geometry.setDrawRange(0, nx.marks[st.shown] * 3);
    if (st.hideOld || r >= 1) houses[lv].m.visible = false;
    if (r < 1) scaffoldFor(lv + 1).visible = true;
  }
  const planksMesh = inst(new Builder(61).box({scale: [0.95, 0.08, 0.26], slot: 'plank'}), 4, {name: 'planks'});
  const planks = [];
  function throwPlank(t, reveal) {
    if (planks.length >= 4) landPlank(planks.shift(), t);
    const bx = houses[Math.min(6, camp.shelter + (camp.shelter < 6 ? 1 : 0))].box, src = W(3, ...L.CAMP.wood, 0.7);
    V2.set((Math.random() - 0.5) * (bx.max.x - bx.min.x) * 0.5, Math.max(0.3, bx.max.y * clamp(reveal) * 0.9), bx.max.z * 0.4);
    houseGroup.localToWorld(V2);
    planks.push({a: src, b: [V2.x, V2.y, V2.z], t0: t, dur: reduced ? 0.25 : 0.5, reveal, spin: (Math.random() - 0.5) * 9});
  }
  function landPlank(p, t) { camp.shown = Math.max(camp.shown, p.reveal); applyCamp(); camp.squash = t; emit(8, p.b, {slot: 'sandDark', speed: 2.2, up: 1.6, size: 0.1, life: 0.6}); }
  const fireAt = W(3, ...L.CAMP.fire);
  const flame = mesh(new Builder(64).cone(5, {scale: [0.3, 0.75, 0.3], base: true, slot: 'fire', glow: 1}).cone(5, {pos: [0.05, 0, 0.04], scale: [0.17, 0.5, 0.17], base: true, slot: 'lantern', glow: 1}), {receive: false, name: 'flame', still: false});
  flame.position.set(fireAt[0], fireAt[1] + 0.08, fireAt[2]);
  const barrelB = new Builder(62); barrelB.prism(8, {scale: [0.28, 0.62, 0.28], base: true, slot: 'wood'}); for (const y of [0.1, 0.46]) barrelB.prism(8, {pos: [0, y, 0], scale: [0.3, 0.06, 0.3], base: true, slot: 'metal'}); barrelB.prism(8, {pos: [0, 0.62, 0], scale: [0.25, 0.03, 0.25], base: true, slot: 'woodDark'});
  const barrelsMesh = inst(barrelB, 6, {cast: true, name: 'barrels'});
  const foodB = new Builder(63); foodB.prism(7, {scale: [0.3, 0.3, 0.3], base: true, slot: 'thatchDark'}, 1.25); foodB.ico({pos: [0, 0.34, 0], scale: [0.3, 0.14, 0.3], slot: 'accent', jitter: 0.03}); foodB.ico({pos: [0.1, 0.42, 0.06], scale: 0.11, slot: 'sprout'});
  const foodMesh = inst(foodB, 5, {cast: true, name: 'food'});
  const slotsAt = (z, at, offs) => offs.map(([x, dz, y = 0]) => { const p = W(z, at[0] + x, at[1] + dz); return [p[0], p[1] + y, p[2], x * 3]; });
  const barrelSlots = slotsAt(3, L.CAMP.barrels, [[0, 0], [0.62, 0.12], [0.3, -0.52], [-0.36, -0.46], [0.95, -0.42], [0.31, -0.2, 0.63]]);
  const foodSlots = slotsAt(3, L.CAMP.food, [[0, 0], [0.7, -0.15], [-0.6, -0.3], [0.2, -0.75], [-0.25, 0.55]]);
  const born = {barrels: new Float32Array(6).fill(-1), food: new Float32Array(5).fill(-1)};
  const resState = {barrels: 0, logs: 0, baskets: 0, forest: 0, dirty: true, quiet: true};
  // ---- FX: one instanced particle pool (unlit, per-instance colour) + a halo ring.
  const PMAX = 260, fxMesh = new THREE.InstancedMesh(keep(new THREE.OctahedronGeometry(1, 0)), fxMat, PMAX);
  fxMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); fxMesh.frustumCulled = false; fxMesh.count = 0; fxMesh.name = 'fx';
  fxMesh.setColorAt(0, WHITE); fxMesh.instanceColor.setUsage(THREE.DynamicDrawUsage); scene.add(fxMesh);
  const parts = [];
  const slotColor = (slot, out) => out.set(PALETTES[pal].slots[slot] || '#ffffff');
  function emit(n, at, {slot = 'sparkle', speed = 2, up = 2, size = 0.12, life = 0.8, gravity = 6, drag = 1.5, spread = 0.25, color = null, burst = null, kind = 0} = {}) {
    const cap = Qs.particles * (reduced ? 0.4 : 1);
    n = Math.max(1, Math.round(n * (reduced ? 0.4 : 1)));
    for (let i = 0; i < n && parts.length < cap; i++) {
      const a = Math.random() * Math.PI * 2, s = speed * (0.4 + Math.random() * 0.6);
      const c = new THREE.Color(); if (color) c.copy(color); else if (slot === 'sparkle') c.setRGB(1, 0.97, 0.75); else slotColor(slot, c);
      parts.push({p: [at[0] + (Math.random() - 0.5) * spread, at[1] + Math.random() * spread * 0.5, at[2] + (Math.random() - 0.5) * spread],
        v: [Math.cos(a) * s, up * (0.6 + Math.random() * 0.6), Math.sin(a) * s], age: 0, life: life * (0.7 + Math.random() * 0.5), size, gravity, drag, c, spin: Math.random() * 6, burst, kind});
    }
  }
  function stepFx(dt) {
    for (let i = parts.length - 1; i >= 0; i--) {
      const q = parts[i]; q.age += dt;
      if (q.age >= q.life) { if (q.burst) q.burst(q.p); parts.splice(i, 1); continue; }
      const k = Math.exp(-q.drag * dt);
      q.v[0] *= k; q.v[2] *= k; q.v[1] = q.v[1] * k - q.gravity * dt;
      q.p[0] += q.v[0] * dt; q.p[1] += q.v[1] * dt; q.p[2] += q.v[2] * dt;
      if (q.kind === 0 && q.p[1] < groundAt(q.p[0], q.p[2]) + 0.02 && q.v[1] < 0) { q.p[1] = groundAt(q.p[0], q.p[2]) + 0.02; q.v[1] *= -0.3; q.v[0] *= 0.6; q.v[2] *= 0.6; }
    }
    const n = Math.min(PMAX, parts.length);
    for (let i = 0; i < n; i++) {
      const q = parts[i], f = 1 - q.age / q.life, s = q.size * (q.kind === 2 ? 1 : Math.min(1, f * 2.5)), sp = q.spin + q.age * 5;
      setTRS(fxMesh, i, q.p[0], q.p[1], q.p[2], sp, q.kind === 1 ? [s * 0.8, s * 1.4, s * 0.8] : s, sp * 0.7);
      fxMesh.setColorAt(i, q.c);
    }
    fxMesh.count = n; fxMesh.visible = n > 0;
    if (n) { fxMesh.instanceMatrix.needsUpdate = true; fxMesh.instanceColor.needsUpdate = true; }
  }
  const haloMat = keep(new THREE.MeshBasicMaterial({color: 0xfff3b0, transparent: true, opacity: 0, depthWrite: false, fog: false, side: THREE.DoubleSide}));
  const halo = new THREE.Mesh(keep(new THREE.RingGeometry(0.82, 1, 40, 1)), haloMat);
  halo.rotation.x = -Math.PI / 2; halo.visible = false; halo.renderOrder = 2; halo.name = 'halo'; scene.add(halo);
  let haloAt = -9;
  function stepHalo(t) {
    const k = (t - haloAt) / 1.3;
    halo.visible = k >= 0 && k < 1;
    if (!halo.visible) return;
    const s = 1.2 + easeOutBack(Math.min(1, k * 1.6)) * 3.2; halo.scale.set(s, s, s); haloMat.opacity = (1 - k) * 0.85;
  }
  // Clouds: a far ring near the horizon for close-ups, a few over the sea for overviews.
  const clouds = (() => {
    const b = new Builder(70), r = rng(70);
    for (let i = 0; i < 9; i++) {
      const a = i / 9 * Math.PI * 2 + r() * 0.4, far = i % 3 !== 0, R = far ? 92 + r() * 25 : 34 + r() * 8, y = far ? 16 + r() * 8 : 13 + r() * 4, s = far ? 3.4 + r() * 2 : 1.6 + r();
      for (let k = 0; k < 4; k++) b.ico({pos: [Math.sin(a) * R + (k - 1.5) * s * 0.9, y + (k % 2) * s * 0.35, Math.cos(a) * R + r() * s * 0.4], scale: [s * (0.8 + r() * 0.4), s * 0.55, s * 0.7], slot: 'cloud', jitter: 0.05});
    }
    const m = mesh(b, {receive: false, name: 'clouds', still: false}); return m;
  })();
  // ---- Zone state. prog[i] = last ratio per stage; quiet updates restore without effects.
  const prog = [0, 0, 0, 0], lastCount = [0, 0, 0, 0];
  const nut = {hang: new Uint8Array(NUTS).fill(1), basket: 0, basketShown: 0, falls: []};
  const nutHangPos = i => { const s = nutSlots[i]; return V1.copy(NUT_LOCAL[s.k]).applyMatrix4(palms[s.palm].m); };
  function setPalmState(r, t, quiet) {
    const st = stageState(0, r), hide = NUTS - st.nuts;
    let dropped = -1;
    nutOrder.forEach((slot, k) => { const h = k < hide ? 0 : 1; if (nut.hang[slot] && !h) dropped = slot; nut.hang[slot] = h; });
    nut.basket = st.basket;
    if (quiet) { nut.basketShown = st.basket; nut.falls.length = 0; }
    return dropped;
  }
  function dropNut(t, slot) {
    if (slot < 0) { const left = nutOrder.filter(s => nut.hang[s]); slot = left.length ? left[0] : nutOrder[0]; }
    const pi = nutSlots[slot].palm; palms[pi].shake = t;
    palmMatrix(palms[pi], t); const p = nutHangPos(slot).clone();
    const dx = basketAt[0] - p.x, dz = basketAt[2] - p.z, l = Math.hypot(dx, dz) || 1;
    if (nut.falls.length >= NUT_FALL) nut.falls.shift();
    nut.falls.push({p: [p.x, p.y, p.z], v: [dx / l * 0.9 + (Math.random() - 0.5), 0.6, dz / l * 0.9 + (Math.random() - 0.5)], t0: t, bounces: 0, roll: -1, from: null});
  }
  function stepNuts(t, dt) {
    palms.forEach(p => palmMatrix(p, t));
    nutSlots.forEach((s, i) => { if (nut.hang[i]) nutsMesh.setMatrixAt(i, M5.compose(nutHangPos(i), Q1.identity(), S1.set(1, 1, 1))); else nutsMesh.setMatrixAt(i, HIDE); });
    for (let i = nut.falls.length - 1; i >= 0; i--) {
      const f = nut.falls[i];
      if (f.roll < 0) {
        f.v[1] -= 14 * dt; for (let k = 0; k < 3; k++) f.p[k] += f.v[k] * dt;
        const gy = groundAt(f.p[0], f.p[2]) + 0.17;
        if (f.p[1] < gy) { f.p[1] = gy; f.v[1] = Math.abs(f.v[1]) * 0.42; f.v[0] *= 0.7; f.v[2] *= 0.7; f.bounces++;
          emit(f.bounces === 1 ? 7 : 3, [f.p[0], gy - 0.12, f.p[2]], {slot: 'sand', speed: 1.6, up: 1.4, size: 0.08, life: 0.5});
          if (f.bounces === 1) emit(5, [f.p[0], gy + 0.1, f.p[2]], {slot: 'sparkle', speed: 1.2, up: 2.2, size: 0.09, life: 0.5, gravity: 1});
          if (f.bounces >= 2) { f.roll = t; f.from = f.p.slice(); } }
      } else {
        const k = clamp((t - f.roll) / 0.45), tgt = BASKET_POS[Math.min(BASKET_MAX - 1, nut.basketShown)] || BASKET_POS[0];
        const ex = basketAt[0] + tgt[0], ey = basketAt[1] + tgt[1], ez = basketAt[2] + tgt[2];
        f.p = [f.from[0] + (ex - f.from[0]) * k, f.from[1] + (ey - f.from[1]) * k + Math.sin(k * Math.PI) * 0.5, f.from[2] + (ez - f.from[2]) * k];
        if (k >= 1) { nut.falls.splice(i, 1); nut.basketShown = Math.min(nut.basket, nut.basketShown + 1); emit(4, [ex, ey + 0.1, ez], {slot: 'sparkle', speed: 0.8, up: 1.6, size: 0.08, life: 0.4, gravity: 0}); continue; }
      }
    }
    if (nut.falls.length === 0) nut.basketShown = nut.basket;
    nut.basketShown = Math.min(nut.basketShown, nut.basket);
    for (let k = 0; k < NUT_BASKET; k++) { const q = BASKET_POS[k]; nutsMesh.setMatrixAt(NUT_HANG + k, k < nut.basketShown ? M5.makeTranslation(basketAt[0] + q[0], basketAt[1] + q[1], basketAt[2] + q[2]) : HIDE); }
    for (let k = 0; k < NUT_FALL; k++) { const f = nut.falls[k]; nutsMesh.setMatrixAt(NUT_HANG + NUT_BASKET + k, f ? M5.makeRotationY(t * 7).setPosition(f.p[0], f.p[1], f.p[2]) : HIDE); }
    nutsMesh.instanceMatrix.needsUpdate = true;
    palms.forEach(p => palmsMesh.setMatrixAt(p.i, p.m));
    palmsMesh.instanceMatrix.needsUpdate = true;
  }
  function setForestState(r, t, quiet) {
    const st = stageState(1, r);
    let fellNow = -1;
    chops.forEach((c, i) => {
      if (i < st.fallen) { if (!c.fallen && c.fall < 0) { if (quiet) c.fallen = true; else { c.fall = t; fellNow = i; } } }
      else { c.fallen = false; c.fall = -1; }
    });
    resState.forest = st.logs; resState.dirty = true; if (quiet) resState.quiet = true;
    return fellNow;
  }
  function stepForest(t) {
    chops.forEach((c, i) => {
      leafMesh.setMatrixAt(i, chopMatrix(c, t));
      if (c.fall >= 0 && !c.dust && t - c.fall > 0.85) { c.dust = true; const tip = V2.copy(c.dir).multiplyScalar(2.2 * c.s).add(V1.set(c.pos[0], c.pos[1], c.pos[2]));
        emit(14, [tip.x, tip.y + 0.3, tip.z], {slot: 'leafB', speed: 2.4, up: 2.2, size: 0.13, life: 0.9}); emit(10, [tip.x, tip.y, tip.z], {slot: 'sandDark', speed: 2, up: 1.2, size: 0.12, life: 0.7}); }
      if (c.fall < 0) c.dust = false;
    });
    leafMesh.instanceMatrix.needsUpdate = true;
  }
  function setFieldState(r, t, quiet) {
    const st = stageState(2, r);
    st.rows.forEach((g, i) => { if (!quiet && g > field.target[i] + 1e-4) field.pop[i] = t; field.target[i] = g; if (quiet) field.shown[i] = g; });
    field.ripeAt = st.ripe ? (quiet ? -100 : (field.ripeAt >= 0 ? field.ripeAt : t + 0.2)) : -1;
    field.dirty = true;
  }
  function setCampState(r, t, quiet) {
    camp.target = clamp(r);
    if (quiet || !camp.target) { camp.shown = camp.target; applyCamp(); return; }
    throwPlank(t, camp.target);
  }
  function stepCamp(t) {
    for (let i = planks.length - 1; i >= 0; i--) {
      const p = planks[i], k = (t - p.t0) / p.dur;
      if (k >= 1) { planks.splice(i, 1); landPlank(p, t); continue; }
      const x = p.a[0] + (p.b[0] - p.a[0]) * k, y = p.a[1] + (p.b[1] - p.a[1]) * k + Math.sin(k * Math.PI) * 1.8, z = p.a[2] + (p.b[2] - p.a[2]) * k;
      setTRS(planksMesh, i, x, y, z, p.spin * k, 1, p.spin * k * 0.5);
    }
    for (let i = planks.length; i < 4; i++) planksMesh.setMatrixAt(i, HIDE);
    planksMesh.instanceMatrix.needsUpdate = true;
    const pa = t - camp.pop, sa = t - camp.squash;
    let sy = 1, sxz = 1;
    if (pa >= 0 && pa < 1.1) { const e = Math.exp(-pa * 4.5) * Math.sin(pa * 15); sy = 1 + e * 0.28; sxz = 1 - e * 0.14; if (pa < 0.08) sy = sxz = 0.5 + pa * 6; }
    else if (sa >= 0 && sa < 0.45) { const e = Math.exp(-sa * 9) * Math.sin(sa * 30 + 0.6); sy = 1 - e * 0.07; sxz = 1 + e * 0.035; }
    houseGroup.scale.set(sxz, sy, sxz);
  }
  function setResourcesState(res, quiet) {
    const c = resourceCounts(res);
    resState.barrels = c.barrels; resState.logs = c.logs; resState.baskets = c.baskets; resState.dirty = true; if (quiet) resState.quiet = true;
  }
  function popper(meshI, slotsArr, n, bornArr, t, quiet, offset = 0, scale = 1) {
    for (let i = 0; i < slotsArr.length; i++) {
      if (i < n) { if (bornArr[i] < 0) bornArr[i] = quiet ? -100 : t; } else bornArr[i] = -1;
      const s = slotsArr[i], age = t - bornArr[i];
      if (bornArr[i] < 0 && bornArr[i] !== -100) { meshI.setMatrixAt(offset + i, HIDE); continue; }
      const k = bornArr[i] === -100 ? 1 : easeOutBack(clamp(age / 0.45));
      setTRS(meshI, offset + i, s[0], s[1] + (1 - clamp(age / 0.3)) * (bornArr[i] === -100 ? 0 : 0.6), s[2], s[3], Math.max(1e-3, k) * scale);
    }
    meshI.instanceMatrix.needsUpdate = true;
  }
  let resBusyUntil = 0;
  function stepResources(t) {
    if (!resState.dirty && t > resBusyUntil) return;
    const q = resState.quiet; if (resState.dirty) resBusyUntil = t + 0.6;
    popper(logsMesh, logSlots.slice(0, LOG_MAX), resState.forest, logBorn.subarray(0, LOG_MAX), t, q, 0);
    popper(logsMesh, logSlots.slice(LOG_MAX), resState.logs, logBorn.subarray(LOG_MAX), t, q, LOG_MAX);
    popper(barrelsMesh, barrelSlots, resState.barrels, born.barrels, t, q);
    popper(foodMesh, foodSlots, resState.baskets, born.food, t, q);
    resState.dirty = false; resState.quiet = false;
  }
  // ---- Camera: zone close-ups, overview, slow orbits for attract and celebrate.
  const cam = {mode: 'zone', zone: zoneIndex(o.zone), from: null, t0: 0, dur: 1.6, hop: 0, orbitAz: L.OVERVIEW.azimuth, clock: 0, view: null, w: 1920, h: 1080};
  function goalView() {
    if (cam.mode === 'zone') return zoneView(cam.zone);
    if (cam.mode === 'overview') return overviewView();
    const ob = ORBIT[cam.mode];
    return {target: ob.target.slice(), azimuth: cam.orbitAz, pitch: ob.pitch, distance: ob.distance};
  }
  function retarget(mode, zone, hop) {
    cam.from = cam.view ? {...cam.view, target: cam.view.target.slice()} : goalView();
    if (mode === 'attract' || mode === 'celebrate') cam.orbitAz = cam.from.azimuth;
    cam.mode = mode; if (zone != null) cam.zone = zone;
    cam.t0 = cam.clock; cam.dur = reduced ? 0.6 : (mode === 'zone' ? 1.7 : 2.4); cam.hop = reduced ? 0 : hop;
  }
  function stepCamera(dt) {
    if (cam.mode === 'attract' || cam.mode === 'celebrate') cam.orbitAz += ORBIT[cam.mode].speed * (reduced ? 0.35 : 1) * dt;
    let v = goalView();
    if (cam.from) {
      const k = clamp((cam.clock - cam.t0) / cam.dur), e = easeInOut(k);
      if (k >= 1) cam.from = null;
      else { v = blendView(cam.from, v, e); const bump = Math.sin(Math.PI * e) * cam.hop; v.distance *= 1 + bump * 0.45; v.pitch += bump * 0.22; }
    }
    cam.view = v;
    const sway = reduced || cam.mode !== 'zone' ? 0 : 1, tt = cam.clock;
    const az = v.azimuth + sway * Math.sin(tt * 0.785) * 0.012, pt = v.pitch + sway * Math.sin(tt * 0.393 + 1) * 0.006;
    const p = orbitPosition({...v, azimuth: az, pitch: pt});
    camera.position.set(p[0], p[1] + sway * Math.sin(tt * 1.178) * 0.025, p[2]);
    camera.lookAt(v.target[0], v.target[1], v.target[2]);
    camera.updateMatrixWorld();
  }
  function placeSun() {
    const P = PALETTES[pal], v = cam.view, az = v.azimuth + (P.sun.azimuth - 35) * DEG, el = P.sun.elevation * DEG;
    sunDir.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
    const half = 10 + clamp((v.distance - 9) / 40) * 16;
    sun.target.position.set(v.target[0], L.TOP, v.target[2]); sun.target.updateMatrixWorld();
    sun.position.copy(sun.target.position).addScaledVector(sunDir, 60);
    const sc = sun.shadow.camera; if (sc.right !== half) { sc.left = sc.bottom = -half; sc.right = sc.top = half; sc.updateProjectionMatrix(); }
    mats.SEA.uSunView.value.copy(sunDir).transformDirection(camera.matrixWorldInverse);
    const fwd = V1.set(0, 0, -1).applyQuaternion(camera.quaternion); fwd.y = 0; fwd.normalize();
    const hz = V2.copy(camera.position).addScaledVector(fwd, 1000).project(camera).y;
    mats.SKY.uHazeY.value = clamp(hz, -1.2, 1.2); mats.SKY.uAspect.value = camera.aspect;
    mats.SKY.uSunPos.value.set(P.sky.sunX + shortAngle(v.azimuth, 35 * DEG) * 0.8, clamp(hz, -1, 1) + 0.28);
    scene.fog.near = 10 + v.distance * 1.6; scene.fog.far = 70 + v.distance * 3.2;
  }
  // ---- Effects driven by the stage page.
  const stageSource = s => s === 0 ? [basketAt[0], basketAt[1] + 0.8, basketAt[2]] : s === 1 ? [logAt[0], logAt[1] + 0.7, logAt[2]] : s === 2 ? [fieldC[0], fieldC[1] + 0.9, fieldC[2]] : (() => { V2.set(0, houses[camp.shelter].box.max.y * 0.7, 0); houseGroup.localToWorld(V2); return [V2.x, V2.y, V2.z]; })();
  const ICON = ['water', 'wood', 'food', 'shelter'], ICON_SLOT = ['sea', 'plank', 'thatch', 'roof'];
  function stageDoneFx(stage) {
    const a = anchorOf(zoneIndex(stage)), t = cam.clock;
    halo.position.set(a.x, a.y + 0.06, a.z); haloAt = t;
    const src = stageSource(stage), col = stage === 0 ? new THREE.Color(PALETTES[pal].sea.shallow) : null;
    emit(6, src, {slot: ICON_SLOT[stage], color: col, speed: 0.6, up: 3.2, gravity: -0.6, drag: 0.4, size: 0.24, life: 1.6, kind: 1, spread: 0.6});
    emit(22, [a.x, a.y + 1.2, a.z], {slot: 'sparkle', speed: 3, up: 3.2, size: 0.1, life: 1.0, gravity: 3, spread: 1.4});
  }
  let celebrateAt = -99;
  function firework(t) {
    const c = V1.set(-4 + Math.random() * 12, 0, -4 + Math.random() * 10), cols = ['accent', 'lantern', 'sprout', 'roof', 'cloth'];
    const color = slotColor(cols[Math.floor(Math.random() * cols.length)], new THREE.Color());
    emit(1, [c.x, 4, c.z], {color, speed: 0.2, up: 12, size: 0.16, life: 0.75, gravity: 9, drag: 0.1, spread: 0, kind: 2,
      burst: p => emit(26 * Qs.fireworks, p, {color, speed: 6, up: 1.5, size: 0.15, life: 1.2, gravity: 2.4, drag: 1.4, spread: 0.2, kind: 2})});
  }
  // ---- Public API.
  const api = {
    scene, camera, sun, hemi, avatarHeight: AVATAR_HEIGHT, zones: ZONE_NAMES, palettes: PALETTE_NAMES,
    get palette() { return pal; }, get quality() { return qName; }, get zone() { return cam.zone; }, get mode() { return cam.mode; },
    get reducedMotion() { return reduced; },
    setReducedMotion(on) { reduced = !!on; },
    update(dt, t) {
      dt = +dt || 0; if (dt > 5) dt /= 1000; dt = clamp(dt, 0, 0.1);
      cam.clock += dt; const T = cam.clock;
      mats.U.uTime.value = T % 800;
      stepCamera(dt); placeSun();
      stepNuts(T, dt); stepForest(T); updateCrops(T, dt); stepCamp(T); stepResources(T); stepFx(dt); stepHalo(T);
      flame.scale.set(1 + Math.sin(T * 17) * 0.06, 1 + Math.sin(T * 11.3) * 0.14 + Math.sin(T * 23) * 0.05, 1 + Math.cos(T * 15) * 0.06);
      boat.position.y = Math.sin(T * 1.571) * 0.06; boat.rotation.z = Math.sin(T * 0.785 + 1) * 0.04; boat.updateMatrix();
      clouds.rotation.y = T * 0.004 % (Math.PI * 2);
      const ca = T - celebrateAt;
      glowMat.userData.lift.value += ((ca < 14 ? 0.9 : 0) - glowMat.userData.lift.value) * Math.min(1, dt * 3);
      if (ca < 9 && Qs.fireworks > 0 && Math.floor((ca) / (reduced ? 1.6 : 0.55)) !== Math.floor((ca - dt) / (reduced ? 1.6 : 0.55))) firework(T);
      void t;
    },
    resize(w, h) { cam.w = Math.max(1, w || 1); cam.h = Math.max(1, h || 1); camera.aspect = cam.w / cam.h; camera.updateProjectionMatrix(); },
    focusZone(i) {
      if (i == null || i < 0) { retarget('overview', null, 0.15); return; }
      const z = zoneIndex(i), hop = cam.mode === 'zone' && z !== cam.zone ? 0.35 : 0;
      retarget('zone', z, hop);
    },
    setAttract(on) { if (on) retarget('attract', null, 0); else if (cam.mode === 'attract') retarget('overview', null, 0); },
    setPalette(name) { applyPalette(name); },
    setQuality(level) {
      qName = QUALITY[level] ? level : 'medium'; Qs = QUALITY[qName];
      sun.castShadow = Qs.shadow;
      if (Qs.shadow && sun.shadow.mapSize.x !== Qs.mapSize) { sun.shadow.mapSize.set(Qs.mapSize, Qs.mapSize); if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; } }
      leafMesh.count = L.CHOP.length + Math.round(bgLeaf.length * Qs.forest); pineMesh.count = Math.round(bgPine.length * Qs.forest);
      const g = sea.geometry; sea.geometry = buildSea(Qs.seaStep, Qs.seaRings); g.dispose();
      if (parts.length > Qs.particles) parts.length = Qs.particles;
    },
    setShelter(level, {animate = false} = {}) {
      const lv = Math.max(0, Math.min(6, Math.round(+level) || 0)), changed = lv !== camp.shelter;
      camp.shelter = lv;
      if (changed || prog[3] >= 1) { prog[3] = 0; lastCount[3] = 0; camp.target = camp.shown = 0; planks.length = 0; }
      applyCamp();
      if (animate) { camp.pop = cam.clock; const p = stageSource(3); emit(18, [houseGroup.position.x, L.TOP + 0.1, houseGroup.position.z], {slot: 'sandDark', speed: 3.4, up: 1.4, size: 0.16, life: 0.9, spread: 2.2}); emit(16, p, {slot: 'sparkle', speed: 2.6, up: 3, size: 0.1, life: 1, gravity: 2}); }
    },
    setResources(res) { setResourcesState(res || {}, false); },
    setProgress(stage, count, target) { applyStage(stage, count, target, true); },
    rep(stage, count, target) { applyStage(stage, count, target, false); },
    stageDone(stage) { stageDoneFx(zoneIndex(stage)); if (zoneIndex(stage) === 2 && field.ripeAt < 0) { field.ripeAt = cam.clock; field.dirty = true; } },
    celebrate() { celebrateAt = cam.clock; retarget('celebrate', null, 0); if (Qs.fireworks > 0) firework(cam.clock); },
    anchor(zone) { const a = anchorOf(zoneIndex(zone)); return {position: new THREE.Vector3(a.x, a.y, a.z), facing: a.facing, zone: zoneIndex(zone), source: new THREE.Vector3(...stageSource(zoneIndex(zone)))}; },
    toScreen(v, w = cam.w, h = cam.h) {
      camera.updateMatrixWorld(); V1.set(v.x ?? v[0], v.y ?? v[1], v.z ?? v[2]).project(camera);
      return {x: (V1.x + 1) / 2 * w, y: (1 - V1.y) / 2 * h, visible: V1.z > -1 && V1.z < 1 && Math.abs(V1.x) <= 1 && Math.abs(V1.y) <= 1};
    },
    stats(renderer) {
      const s = {drawCalls: 0, triangles: 0, shadowCalls: 0, shadowTriangles: 0, meshes: 0, instanced: 0};
      scene.traverseVisible(m => {
        if (!m.isMesh) return;
        const g = m.geometry, n = m.isInstancedMesh ? m.count : 1; if (!n) return;
        const vc = g.index ? g.index.count : g.getAttribute('position').count, tris = Math.min(vc, g.drawRange.count) / 3 * n;
        s.drawCalls++; s.triangles += tris; s.meshes++; if (m.isInstancedMesh) s.instanced++;
        if (m.castShadow && sun.castShadow) { s.shadowCalls++; s.shadowTriangles += tris; }
      });
      s.triangles = Math.round(s.triangles); s.shadowTriangles = Math.round(s.shadowTriangles);
      s.totalCalls = s.drawCalls + s.shadowCalls; s.totalTriangles = s.triangles + s.shadowTriangles;
      if (renderer?.info) s.measured = {calls: renderer.info.render.calls, triangles: renderer.info.render.triangles};
      return s;
    },
    dispose() {
      scene.traverse(m => { if (m.isMesh) m.geometry.dispose(); });
      owned.forEach(x => x.dispose && x.dispose()); mats.dispose(); sea.geometry.dispose();
      if (sun.shadow.map) sun.shadow.map.dispose();
      scene.clear();
    },
  };
  function applyStage(stage, count, target, quiet) {
    const s = zoneIndex(stage), r = ratio(count, target), t = cam.clock, c = Math.max(0, +count || 0);
    if (s === 3 && !quiet && r >= 1 && t - camp.leveledAt < 3) { prog[3] = 0; lastCount[3] = 0; emit(10, stageSource(3), {slot: 'sparkle', speed: 2, up: 2.5, size: 0.1, life: 0.8}); return; }
    const reset = c < lastCount[s] || r < prog[s] - 1e-6, q = quiet || reset;
    prog[s] = r; lastCount[s] = c;
    if (s === 0) { const dropped = setPalmState(r, t, q); if (!quiet) dropNut(t, dropped); }
    else if (s === 1) {
      const fell = setForestState(r, t, q); if (quiet) return;
      const tree = fell >= 0 ? chops[fell] : chops.find(k => !k.fallen && k.fall < 0);
      const p = tree ? tree.pos : logAt; if (tree && fell < 0) tree.shake = t;
      emit(10, [p[0], p[1] + 0.7, p[2]], {slot: 'plank', speed: 2.8, up: 2.6, size: 0.09, life: 0.7});
      if (tree) emit(5, [p[0], p[1] + 2.2, p[2]], {slot: 'leafB', speed: 1.2, up: 0.4, size: 0.1, life: 1.0, gravity: 1.6, spread: 1});
    } else if (s === 2) {
      setFieldState(r, t, q); if (quiet) return;
      const row = Math.max(0, Math.min(F.rows - 1, Math.ceil(r * F.rows) - 1)); field.pop[row] = t; field.dirty = true;
      for (let k = 0; k < 4; k++) { const cs = cropSlots[row * F.perRow + Math.floor(Math.random() * F.perRow)]; emit(3, [cs.x, cs.y + 0.5, cs.z], {slot: 'sprout', speed: 0.8, up: 2, size: 0.08, life: 0.6, gravity: 1}); }
    } else { setCampState(r, t, q); if (!quiet && reset && r > 0) throwPlank(t, r); }
  }
  camp.leveledAt = -99;
  const _setShelter = api.setShelter;
  api.setShelter = (level, opt) => { const before = camp.shelter; _setShelter(level, opt); if (camp.shelter !== before) camp.leveledAt = cam.clock; };
  const boat = (() => {
    const b = new Builder(80);
    b.box({pos: [0, 0.12, 0], scale: [0.95, 0.4, 2.0], slot: 'hull'}); b.box({pos: [0, 0.33, 0], scale: [1.0, 0.07, 2.05], slot: 'accent'});
    b.cone(4, {pos: [0, 0.14, 1.2], scale: [0.48, 0.5, 0.22], rot: [Math.PI / 2, 0, 0], slot: 'hull'}); b.box({pos: [0, 0.33, 0], scale: [0.82, 0.04, 1.8], slot: 'plank'});
    b.prism(6, {pos: [0, 0.33, 0.25], scale: [0.05, 2.0, 0.05], base: true, slot: 'woodDark'});
    b.leaf([0, 2.3, 0.3], [0, 0.65, 0.3], [0, 0.65, -0.8], 'sail', 1, [0.2, 0, 0]);
    const m = mesh(b, {cast: true, wind: true, name: 'boat', still: false});
    const c = Math.cos(dockYaw), s = Math.sin(dockYaw), lx = 2.0, lz = 4.8;
    m.position.set(dockP[0] + lx * c + lz * s, 0, dockP[1] - lx * s + lz * c); m.rotation.y = dockYaw + 0.2;
    return m;
  })();
  // ---- Initial state.
  applyPalette(pal);
  api.setQuality(qName);
  houses[0].m.visible = true;
  setPalmState(0, 0, true); setForestState(0, 0, true); setFieldState(0, 0, true); setResourcesState({}, true);
  if (o.zone === 'overview' || +o.zone < 0) cam.mode = 'overview';
  api.resize(cam.w, cam.h);
  stepCamera(0); placeSun(); api.update(0);
  return api;
}
