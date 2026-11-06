// Shared materials. Props use one Lambert material whose colour comes from a
// palette uniform array (per-vertex slot + shade), with optional wind sway and
// flickering glow. Every animated frequency divides LOOP so captures loop cleanly.
import {SLOTS} from './palettes.js';

export const LOOP = 8; // seconds

const WIND_PARS = /* glsl */`
attribute float aWind;
uniform float uTime;
uniform vec2 uWindDir;
vec3 islandWind(vec3 wp, float w) {
  float ph = dot(wp.xz, vec2(0.21, 0.17));
  float s = sin(uTime * 1.5708 + ph) * 0.75 + sin(uTime * 3.1416 + ph * 1.7) * 0.25;
  vec2 d = uWindDir * (0.45 + 0.55 * s) * w;
  return vec3(d.x, -0.12 * abs(w) * (0.5 + 0.5 * s), d.y);
}
`;
const WIND_APPLY = /* glsl */`
#ifdef USE_INSTANCING
  vec3 iOrigin = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
#else
  vec3 iOrigin = (modelMatrix * vec4(transformed, 1.0)).xyz;
#endif
if (aWind != 0.0) {
  vec3 wOff = islandWind(iOrigin, aWind);
  #ifdef USE_INSTANCING
    wOff = inverse(mat3(instanceMatrix)) * wOff;
  #endif
  transformed += wOff;
}
`;
const TONE_VERT_PARS = /* glsl */`
attribute vec3 aTone;
uniform vec3 uPalette[${SLOTS.length}];
varying vec3 vTone;
varying float vGlow;
`;
const TONE_VERT = /* glsl */`
vTone = uPalette[int(aTone.x + 0.5)] * aTone.y;
vGlow = aTone.z;
if (aTone.z > 0.0) {
  float fp = dot(iOrigin.xz, vec2(0.37, 0.23));
  vGlow *= 0.84 + 0.11 * sin(uTime * 12.566 + fp) + 0.05 * sin(uTime * 31.416 + fp * 2.3);
}
`;
const TONE_FRAG_PARS = /* glsl */`
varying vec3 vTone;
varying float vGlow;
uniform float uGlow;
uniform float uLift;
`;

export function createMaterials(THREE) {
  const U = {
    uTime: {value: 0},
    uWindDir: {value: new THREE.Vector2(0.8, 0.6).normalize()},
    uGlow: {value: 1},
    uPalette: {value: SLOTS.map(() => new THREE.Color())},
  };
  const SEA = {
    uSeaShallow: {value: new THREE.Color()}, uSeaDeep: {value: new THREE.Color()}, uSeaFar: {value: new THREE.Color()},
    uFoam: {value: new THREE.Color()}, uSpark: {value: new THREE.Color()},
    uSeaFade: {value: new THREE.Vector4(16, 46, 7, 0)}, uSunView: {value: new THREE.Vector3(0, 1, 0)},
  };
  const SKY = {
    uTop: {value: new THREE.Vector3()}, uMid: {value: new THREE.Vector3()}, uHaze: {value: new THREE.Vector3()},
    uLow: {value: new THREE.Vector3()}, uSun: {value: new THREE.Vector3()}, uSunPos: {value: new THREE.Vector2(0, 0.6)},
    uSunAmt: {value: 0}, uHazeY: {value: 0.5}, uAspect: {value: 16 / 9},
  };
  const all = [];

  function prop({fog = true, lift = 0, key = 'prop'} = {}) {
    const m = new THREE.MeshLambertMaterial({flatShading: true, fog});
    m.userData.lift = {value: lift};
    m.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, U, {uLift: m.userData.lift});
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n' + WIND_PARS + TONE_VERT_PARS)
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + WIND_APPLY + TONE_VERT);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + TONE_FRAG_PARS)
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= vTone;')
        .replace('#include <opaque_fragment>', `
outgoingLight = mix(outgoingLight, diffuseColor.rgb * 1.45, clamp(vGlow * uGlow, 0.0, 1.0));
outgoingLight += diffuseColor.rgb * uLift;
#include <opaque_fragment>`);
    };
    m.customProgramCacheKey = () => 'island-' + key;
    all.push(m);
    return m;
  }

  // Shadow-pass twin so swaying leaves cast matching shadows.
  function windDepth() {
    const m = new THREE.MeshDepthMaterial({depthPacking: THREE.RGBADepthPacking});
    m.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, {uTime: U.uTime, uWindDir: U.uWindDir});
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n' + WIND_PARS)
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + WIND_APPLY);
    };
    m.customProgramCacheKey = () => 'island-wind-depth';
    all.push(m);
    return m;
  }

  function sea() {
    const m = new THREE.MeshLambertMaterial({flatShading: true, transparent: true});
    m.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, {uTime: U.uTime}, SEA);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
attribute float aShore;
uniform float uTime;
varying float vShore;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
vShore = aShore;
vec4 seaW = modelMatrix * vec4(transformed, 1.0);
float sw = sin(dot(seaW.xz, vec2(0.23, 0.11)) - uTime * 1.5708) * 0.16
         + sin(dot(seaW.xz, vec2(-0.13, 0.29)) - uTime * 2.3562) * 0.10
         + sin(dot(seaW.xz, vec2(0.41, -0.33)) - uTime * 3.1416) * 0.05;
transformed.y += sw * smoothstep(-0.6, 1.6, aShore);`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
uniform float uTime;
uniform vec3 uSeaShallow, uSeaDeep, uSeaFar, uFoam, uSpark;
uniform vec4 uSeaFade;
uniform vec3 uSunView;
varying float vShore;
float seaFoam;`)
        .replace('#include <color_fragment>', `#include <color_fragment>
float sh = vShore;
vec3 water = mix(uSeaShallow, uSeaDeep, smoothstep(0.4, uSeaFade.z, sh));
water = mix(water, uSeaFar, smoothstep(uSeaFade.z, uSeaFade.y, sh));
float fr = fract(sh * 0.36 + uTime * 0.25);
float ring = (1.0 - smoothstep(0.035, 0.085, abs(fr - 0.5))) * (1.0 - smoothstep(0.9, 4.2, sh));
seaFoam = clamp(max(1.0 - smoothstep(0.25, 0.85, sh), ring * 0.9), 0.0, 1.0);
diffuseColor.rgb = water;
diffuseColor.a = 1.0 - smoothstep(uSeaFade.x, uSeaFade.y, sh);`)
        .replace('#include <opaque_fragment>', `
vec3 seaH = normalize(uSunView + normalize(vViewPosition));
outgoingLight += uSpark * pow(max(dot(normal, seaH), 0.0), 80.0) * 0.85;
outgoingLight = mix(outgoingLight, uFoam, seaFoam);
#include <opaque_fragment>`);
    };
    m.customProgramCacheKey = () => 'island-sea';
    all.push(m);
    return m;
  }

  function sky() {
    const m = new THREE.ShaderMaterial({
      uniforms: SKY, depthTest: false, depthWrite: false,
      vertexShader: 'varying vec2 vNdc;\nvoid main() { vNdc = position.xy; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: /* glsl */`
uniform vec3 uTop, uMid, uHaze, uLow, uSun;
uniform vec2 uSunPos;
uniform float uSunAmt, uHazeY, uAspect;
varying vec2 vNdc;
void main() {
  float y = vNdc.y;
  vec3 c;
  if (y > uHazeY) {
    float k = (y - uHazeY) / max(0.001, 1.0 - uHazeY);
    c = mix(uHaze, uMid, smoothstep(0.0, 0.5, k));
    c = mix(c, uTop, smoothstep(0.3, 1.0, k));
  } else {
    float k = (uHazeY - y) / max(0.001, uHazeY + 1.0);
    c = mix(uHaze, uLow, smoothstep(0.0, 0.8, k));
  }
  vec2 sp = (vNdc - uSunPos) * vec2(uAspect, 1.0);
  c = mix(c, uSun, clamp(exp(-dot(sp, sp) * 2.2) * uSunAmt, 0.0, 1.0));
  c += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
  gl_FragColor = vec4(c, 1.0);
}`,
    });
    all.push(m);
    return m;
  }

  const srgb = (hex, v) => { const n = parseInt(hex.slice(1), 16); return v.set((n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255); };
  function setPalette(p) {
    SLOTS.forEach((name, i) => U.uPalette.value[i].set(p.slots[name] ?? '#ff00ff'));
    U.uGlow.value = p.glow;
    SEA.uSeaShallow.value.set(p.sea.shallow); SEA.uSeaDeep.value.set(p.sea.deep); SEA.uSeaFar.value.set(p.sea.far);
    SEA.uFoam.value.set(p.sea.foam); SEA.uSpark.value.set(p.sea.spark);
    srgb(p.sky.top, SKY.uTop.value); srgb(p.sky.mid, SKY.uMid.value); srgb(p.sky.haze, SKY.uHaze.value);
    srgb(p.sky.low, SKY.uLow.value); srgb(p.sky.sun, SKY.uSun.value);
    SKY.uSunAmt.value = p.sky.sun === '#000000' ? 0 : 0.85;
  }
  return {U, SEA, SKY, prop, windDepth, sea, sky, setPalette, dispose: () => all.forEach(m => m.dispose())};
}
