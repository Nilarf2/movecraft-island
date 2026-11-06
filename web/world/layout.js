// Island plan in world units. x to the right, z toward the default camera, y up;
// sea level is y = 0. Polygons are [x, z]. The avatar is AVATAR_HEIGHT tall and
// props are sized relative to it (about 1.5x at most) so a close-up fits the
// safe band between the top and bottom HUD strips.
export const AVATAR_HEIGHT = 2.4;
export const TOP = 3.0;          // beach surface
export const RISE = 0.55;        // grass plateau above the beach
export const OUTLINE = [
  [-20.5, -3.5], [-16.5, -10.5], [-8.5, -13.8], [1.5, -14.6], [10.5, -12.6], [17.5, -8.8], [20.8, -1.2],
  [18.6, 7.6], [13, 12.6], [3, 14.6], [-6.5, 14], [-15, 10.8], [-20.2, 4.2],
];
export const PLATEAU = [
  [-17, -3.2], [-13.8, -8.8], [-7.4, -11.6], [1.2, -12.4], [10.8, -11.4], [16.2, -7.6], [17.6, -2.6],
  [14.6, -0.6], [6.4, -0.4], [-1.2, 1.8], [-6.5, 4.6], [-12.6, 4.8], [-16.8, 1.2],
];
// Cliff strata from the beach edge down past the waterline: [y, outward offset, slot, shade].
export const STRATA = [
  [TOP, 0.0], [2.62, 0.06, 'sandDark', 1], [2.5, 0.3, 'sand', 0.98], [1.62, 0.36, 'soil', 1],
  [1.5, 0.58, 'soil', 1.12], [0.62, 0.62, 'soilDark', 1], [0.5, 0.82, 'soilDark', 1.15], [-0.8, 1.0, 'rock', 1],
];
export const WATERLINE_OFFSET = 0.89;
export const FOREST = [[-16.2, -3], [-13.4, -8.4], [-7.2, -10.8], [-1.2, -11], [1.4, -8.6], [0.4, -3.2], [-2.2, -0.6], [-7, 2.6], [-12.6, 3.2], [-16, 0.8]];
export const ISLETS = [
  {x: -28, z: -14, r: 3.3, h: 1.9, palm: [0.6, 0.4, 0.8]},
  {x: 28.5, z: -12.5, r: 2.4, h: 1.3},
  {x: -25, z: 12.5, r: 1.4, h: 0.8},
];

// Each zone: where the avatar stands (anchor, on the ground), the camera azimuth
// (radians from +z toward +x, measured from the anchor) and pitch. Props are
// placed in the zone's view frame: x to the screen's right, z toward the camera.
const D = Math.PI / 180;
export const ZONES = [
  {key: 'palm', name: '海风椰林', anchor: [-8.2, 9.6], azimuth: 15 * D, pitch: 15 * D},
  {key: 'forest', name: '林间空地', anchor: [-5.6, -1.4], azimuth: 30 * D, pitch: 16 * D},
  {key: 'field', name: '海岸麦田', anchor: [9.0, -2.6], azimuth: -18 * D, pitch: 22 * D},
  {key: 'camp', name: '你的营地', anchor: [12.5, 6.5], azimuth: 40 * D, pitch: 15 * D},
];
// Camera framing in NDC: avatar feet and head. 0.8 of the 2.0 NDC height = 40%.
export const FRAME = {feet: -0.54, head: 0.26, fov: 38};
export const OVERVIEW = {target: [0, 2.2, 0], azimuth: 30 * D, pitch: 30 * D, distance: 56};

export function zoneFrame(z) {
  const a = ZONES[z].azimuth;
  return {right: [Math.cos(a), -Math.sin(a)], toward: [Math.sin(a), Math.cos(a)]};
}
// View-frame offset (x right, z toward camera) to world [x, z].
export function local(z, x, dz) {
  const {right, toward} = zoneFrame(z), [ax, az] = ZONES[z].anchor;
  return [ax + right[0] * x + toward[0] * dz, az + right[1] * x + toward[1] * dz];
}

// Zone 0: palms around a clearing. [x, z, scale, lean dir (rad, view frame), coconuts]
export const PALMS = [
  {at: [-2.6, -2.2], s: 1.0, lean: -0.5, nuts: 4},
  {at: [2.8, -2.6], s: 0.96, lean: 0.6, nuts: 4},
  {at: [-0.6, -4.0], s: 1.08, lean: -0.1, nuts: 4},
  {at: [-4.6, -2.0], s: 0.9, lean: -0.9, nuts: 4},
  {at: [5.4, -0.6], s: 0.86, lean: 0.9, nuts: 0},
];
export const BASKET = [2.1, 0.6];
// Zone 1: trees that fall one by one (nearest first) and the log pile.
export const CHOP = [
  {at: [-2.0, -1.6], s: 1.0}, {at: [2.2, -1.8], s: 0.95}, {at: [-0.4, -3.6], s: 1.05},
  {at: [3.8, -4.0], s: 1.0}, {at: [-3.6, -3.6], s: 0.96},
];
export const LOG_PILE = [2.5, 0.6];
// Zone 2: field rectangle in its own frame (rows run along x, stacked toward -z).
export const FIELD = {at: [-0.5, -4.4], w: 7.2, d: 4.6, rows: 6, perRow: 9, scarecrow: [3.0, -1.2]};
// Zone 3: camp.
export const CAMP = {house: [-2.2, -3.4], yaw: 0.25, barrels: [2.6, -1.0], wood: [3.3, -3.0], food: [-3.1, 0.3],
  fire: [-1.6, 1.6], flag: [-5.2, -3.6]};
export const DOCK = {edge: 6, t: 0.56};
