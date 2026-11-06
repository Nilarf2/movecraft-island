// Procedural low-poly geometry helpers. THREE is passed in by the caller so this
// code has no import-map dependency and can move into another host unchanged.
import {SLOT} from './palettes.js';

export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function hash(x, y, z, s = 0) {
  const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + s * 19.19) * 43758.5453;
  return h - Math.floor(h);
}

// Polygons are arrays of [x, z]. ccw() normalises to positive signed area.
export const poly = {
  area(p) {
    let s = 0;
    for (let i = 0; i < p.length; i++) { const [x1, z1] = p[i], [x2, z2] = p[(i + 1) % p.length]; s += x1 * z2 - x2 * z1; }
    return s / 2;
  },
  ccw(p) { const q = p.map(v => v.slice()); return poly.area(q) > 0 ? q : q.reverse(); },
  inside(p, x, z) {
    let c = false;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const [xi, zi] = p[i], [xj, zj] = p[j];
      if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c;
    }
    return c;
  },
  dist(p, x, z) {
    let d = Infinity;
    for (let i = 0; i < p.length; i++) {
      const [ax, az] = p[i], [bx, bz] = p[(i + 1) % p.length], vx = bx - ax, vz = bz - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / (vx * vx + vz * vz)));
      d = Math.min(d, Math.hypot(x - ax - vx * t, z - az - vz * t));
    }
    return d;
  },
  signed(p, x, z) { const d = poly.dist(p, x, z); return poly.inside(p, x, z) ? -d : d; },
  // p must be ccw; positive d moves the outline outward.
  offset(p, d) {
    const n = p.length, out = [];
    const normal = (a, b) => { const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1; return [dz / l, -dx / l]; };
    for (let i = 0; i < n; i++) {
      const n1 = normal(p[(i - 1 + n) % n], p[i]), n2 = normal(p[i], p[(i + 1) % n]);
      let mx = n1[0] + n2[0], mz = n1[1] + n2[1]; const ml = Math.hypot(mx, mz) || 1; mx /= ml; mz /= ml;
      const k = d / Math.max(0.35, mx * n1[0] + mz * n1[1]);
      out.push([p[i][0] + mx * k, p[i][1] + mz * k]);
    }
    return out;
  },
  counts(p, step) { return p.map((a, i) => { const b = p[(i + 1) % p.length]; return Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / step)); }); },
  subdivide(p, counts) {
    const out = [];
    p.forEach((a, i) => { const b = p[(i + 1) % p.length]; for (let k = 0; k < counts[i]; k++) { const t = k / counts[i]; out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); } });
    return out;
  },
};

// Bowyer-Watson Delaunay triangulation of [x, z] points; returns index triples.
export function delaunay(pts) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of pts) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
  const n = pts.length, dm = Math.max(x1 - x0, z1 - z0) * 30, mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
  const P = pts.concat([[mx - dm, mz - dm], [mx, mz + dm], [mx + dm, mz - dm]]);
  const make = (a, b, c) => {
    const [ax, az] = P[a], [bx, bz] = P[b], [cx, cz] = P[c];
    const d = 2 * (ax * (bz - cz) + bx * (cz - az) + cx * (az - bz));
    if (Math.abs(d) < 1e-12) return {a, b, c, x: 0, z: 0, r2: Infinity};
    const a2 = ax * ax + az * az, b2 = bx * bx + bz * bz, c2 = cx * cx + cz * cz;
    const x = (a2 * (bz - cz) + b2 * (cz - az) + c2 * (az - bz)) / d, z = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
    return {a, b, c, x, z, r2: (ax - x) ** 2 + (az - z) ** 2};
  };
  let tris = [make(n, n + 1, n + 2)];
  for (let i = 0; i < n; i++) {
    const [px, pz] = P[i], keep = [], edges = new Map();
    for (const t of tris) {
      if ((px - t.x) ** 2 + (pz - t.z) ** 2 < t.r2) {
        for (const [u, v] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]]) { const key = u < v ? u * 1e6 + v : v * 1e6 + u; edges.set(key, edges.has(key) ? null : [u, v]); }
      } else keep.push(t);
    }
    for (const e of edges.values()) if (e) keep.push(make(e[0], e[1], i));
    tris = keep;
  }
  return tris.filter(t => t.a < n && t.b < n && t.c < n).map(t => [t.a, t.b, t.c]);
}

export function createKit(THREE) {
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler(0, 0, 0, 'YXZ');
  const V = new THREE.Vector3(), S = new THREE.Vector3(), P = new THREE.Vector3();
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
  const templates = new Map();
  const template = (key, make) => {
    let t = templates.get(key);
    if (!t) {
      const g = make(), flat = g.index ? g.toNonIndexed() : g;
      t = Float32Array.from(flat.getAttribute('position').array);
      g.dispose(); if (flat !== g) flat.dispose();
      templates.set(key, t);
    }
    return t;
  };
  const shape = {
    box: () => template('box', () => new THREE.BoxGeometry(1, 1, 1)),
    prism: (n = 6, top = 1) => template(`prism${n}:${top}`, () => new THREE.CylinderGeometry(top, 1, 1, n, 1)),
    cone: (n = 6) => template(`cone${n}`, () => new THREE.ConeGeometry(1, 1, n, 1)),
    ico: (d = 0) => template(`ico${d}`, () => new THREE.IcosahedronGeometry(1, d)),
    dodeca: () => template('dodeca', () => new THREE.DodecahedronGeometry(1, 0)),
    octa: () => template('octa', () => new THREE.OctahedronGeometry(1, 0)),
  };
  const slotIndex = s => typeof s === 'number' ? s : (SLOT[s] ?? 0);

  // Collects flat-shaded triangles with a palette tone (slot, shade, glow) and a
  // wind weight per vertex. One Builder becomes one merged BufferGeometry.
  class Builder {
    constructor(seed = 1) { this.pos = []; this.tone = []; this.wind = []; this.rand = rng(seed); this.frame = null; }
    tri(a, b, c, slot, shade = 1, glow = 0, wind = 0) {
      const s = slotIndex(slot), w = Array.isArray(wind) ? wind : [wind, wind, wind];
      for (let k = 0; k < 3; k++) {
        const v = k === 0 ? a : k === 1 ? b : c;
        P.set(v[0], v[1], v[2]); if (this.frame) P.applyMatrix4(this.frame);
        this.pos.push(P.x, P.y, P.z); this.tone.push(s, shade, glow); this.wind.push(w[k]);
      }
      return this;
    }
    quad(a, b, c, d, slot, shade = 1, glow = 0, wind = 0) {
      const w = Array.isArray(wind) ? wind : [wind, wind, wind, wind];
      this.tri(a, b, c, slot, shade, glow, [w[0], w[1], w[2]]);
      return this.tri(a, c, d, slot, shade, glow, [w[0], w[2], w[3]]);
    }
    // Two-sided triangle for thin leaves, sails and flags.
    leaf(a, b, c, slot, shade = 1, wind = 0) {
      const w = Array.isArray(wind) ? wind : [wind, wind, wind];
      this.tri(a, b, c, slot, shade, 0, w);
      return this.tri(a, c, b, slot, shade * 0.86, 0, [w[0], w[2], w[1]]);
    }
    // o: {pos, rot:[x,y,z] (YXZ), scale, slot, shade, vary, glow, jitter, seed, base, wind, paint}
    add(arr, o = {}) {
      const sc = o.scale ?? 1;
      if (Array.isArray(sc)) S.set(sc[0], sc[1], sc[2]); else S.set(sc, sc, sc);
      const r = o.rot || [0, 0, 0], p = o.pos || [0, 0, 0];
      E.set(r[0], r[1], r[2], 'YXZ'); Q.setFromEuler(E); M.compose(V.set(p[0], p[1], p[2]), Q, S);
      const lift = o.base ? 0.5 : 0, jit = o.jitter || 0, seed = o.seed ?? Math.floor(this.rand() * 9973);
      const slot = slotIndex(o.slot ?? 'rock'), shade = o.shade ?? 1, vary = o.vary ?? 0.05, glow = o.glow || 0;
      for (let i = 0; i < arr.length; i += 9) {
        const face = [];
        for (let k = 0; k < 3; k++) {
          let x = arr[i + k * 3], y = arr[i + k * 3 + 1] + lift, z = arr[i + k * 3 + 2];
          if (jit) {
            const hx = hash(x, y, z, seed), hy = hash(y, z, x, seed + 1), hz = hash(z, x, y, seed + 2);
            x += (hx - 0.5) * 2 * jit; y += (hy - 0.5) * 2 * jit; z += (hz - 0.5) * 2 * jit;
          }
          P.set(x, y, z).applyMatrix4(M); face.push([P.x, P.y, P.z]);
        }
        let fs = slot, fsh = shade * (1 + (this.rand() - 0.5) * 2 * vary);
        if (o.paint) {
          A.fromArray(face[0]); B.fromArray(face[1]); C.fromArray(face[2]);
          const n = B.sub(A).cross(C.sub(A)).normalize();
          const res = o.paint({n, y: (face[0][1] + face[1][1] + face[2][1]) / 3, i: i / 9});
          if (res) { if (res.slot != null) fs = slotIndex(res.slot); if (res.shade != null) fsh *= res.shade; }
        }
        const wind = typeof o.wind === 'function' ? face.map(q => o.wind(q)) : (o.wind || 0);
        this.tri(face[0], face[1], face[2], fs, fsh, glow, wind);
      }
      return this;
    }
    box(o) { return this.add(shape.box(), o); }
    prism(n, o, top = 1) { return this.add(shape.prism(n, top), o); }
    cone(n, o) { return this.add(shape.cone(n), o); }
    ico(o, detail = 0) { return this.add(shape.ico(detail), o); }
    dodeca(o) { return this.add(shape.dodeca(), o); }
    octa(o) { return this.add(shape.octa(), o); }
    // Run fn with every vertex transformed by a frame (position + yaw).
    within(x, y, z, yaw, fn) {
      const prev = this.frame;
      const f = new THREE.Matrix4().makeRotationY(yaw).setPosition(x, y, z);
      this.frame = prev ? prev.clone().multiply(f) : f;
      fn(this); this.frame = prev; return this;
    }
    get triangles() { return this.pos.length / 9; }
    geometry() {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
      g.setAttribute('aTone', new THREE.Float32BufferAttribute(this.tone, 3));
      g.setAttribute('aWind', new THREE.Float32BufferAttribute(this.wind, 1));
      g.computeVertexNormals(); g.computeBoundingSphere(); g.computeBoundingBox();
      return g;
    }
  }
  return {Builder, shape};
}
