// Palettes for the 3D island. Every procedural mesh stores a slot index per
// vertex; switching palettes only rewrites one uniform array, lights and sky.
export const SLOTS = [
  'sand', 'sandDark', 'grass', 'grassDark', 'soil', 'soilDark', 'rock', 'rockDark',
  'palmTrunk', 'palmTrunkDark', 'palmLeaf', 'palmLeafDark', 'coconut',
  'treeTrunk', 'leafA', 'leafB', 'pine', 'pineDark',
  'fieldSoil', 'fieldRidge', 'sprout',
  'wood', 'woodDark', 'plank', 'thatch', 'thatchDark', 'roof', 'roofDark',
  'stone', 'stoneDark', 'wall', 'window', 'door',
  'cloth', 'accent', 'rope', 'lantern', 'fire', 'metal', 'hull', 'sail', 'smoke', 'cloud', 'bird',
];
export const SLOT = Object.fromEntries(SLOTS.map((name, i) => [name, i]));

// Sun azimuth is measured from +z toward +x (the default camera sits near 35 degrees).
export const PALETTES = {
  deck: {
    label: '答辩稿 · 深青薄荷',
    slots: {
      sand: '#ecd39e', sandDark: '#cfb07a', grass: '#46a596', grassDark: '#348477', soil: '#957f59', soilDark: '#715f45',
      rock: '#5d6f6c', rockDark: '#41524f',
      palmTrunk: '#e7ce99', palmTrunkDark: '#c4a676', palmLeaf: '#a6e8c4', palmLeafDark: '#78c9a2', coconut: '#f2ad78',
      treeTrunk: '#8a6f4f', leafA: '#5cc39f', leafB: '#86dab5', pine: '#2f8f78', pineDark: '#22705e',
      fieldSoil: '#7c6549', fieldRidge: '#9a8360', sprout: '#b4f0c8',
      wood: '#b78f68', woodDark: '#7a5f48', plank: '#cfa77d', thatch: '#ecd39e', thatchDark: '#c9ab78', roof: '#f2ad78', roofDark: '#cc8260',
      stone: '#a9c0ba', stoneDark: '#7f9893', wall: '#f6f6eb', window: '#ffd77e', door: '#163b40',
      cloth: '#f6f6eb', accent: '#f2ad78', rope: '#e7ce99', lantern: '#ffe4a3', fire: '#f7a25e', metal: '#315158',
      hull: '#e7ce99', sail: '#f6f6eb', smoke: '#a6beb9', cloud: '#3d7472', bird: '#d8f5e4',
    },
    sky: {top: '#0a2228', mid: '#0d2b31', haze: '#123840', low: '#0e3036', sun: '#000000', sunX: 0.0},
    sea: {shallow: '#3c9e94', deep: '#1a5a5f', far: '#123a40', foam: '#bdf2d6', spark: '#d8fff0'},
    sun: {color: '#fff4e2', intensity: 2.5, azimuth: -38, elevation: 52},
    hemi: {sky: '#cfeee0', ground: '#2e4f52', intensity: 1.9},
    shadow: 0.72, glow: 0.9, cloudLift: 0.25,
  },
  day: {
    label: '明亮白天',
    slots: {
      sand: '#f7dc96', sandDark: '#e0b56d', grass: '#73c54e', grassDark: '#4f9e38', soil: '#b9733d', soilDark: '#86512d',
      rock: '#7d8590', rockDark: '#5b626d',
      palmTrunk: '#c08f55', palmTrunkDark: '#8f6638', palmLeaf: '#43bf55', palmLeafDark: '#2a9142', coconut: '#7d4a22',
      treeTrunk: '#7c5232', leafA: '#2f9e4a', leafB: '#5cc24c', pine: '#1f7f50', pineDark: '#16633e',
      fieldSoil: '#8f5630', fieldRidge: '#b5743f', sprout: '#8be04c',
      wood: '#b0743f', woodDark: '#7d4f2b', plank: '#cf9659', thatch: '#ebc163', thatchDark: '#c99a45', roof: '#e8603a', roofDark: '#b8452a',
      stone: '#c4c0b6', stoneDark: '#96928a', wall: '#f7ecd6', window: '#3b4d63', door: '#5a3a22',
      cloth: '#fbf4e6', accent: '#ff7a3d', rope: '#ddc28a', lantern: '#ffd76b', fire: '#ff8f2e', metal: '#5d6670',
      hull: '#f2ebdb', sail: '#fffaf0', smoke: '#f4f4f0', cloud: '#ffffff', bird: '#ffffff',
    },
    sky: {top: '#2f8fdc', mid: '#7cc4ef', haze: '#d6f0f7', low: '#58b2d8', sun: '#fff7d6', sunX: -0.55},
    sea: {shallow: '#3fd6c8', deep: '#1593d2', far: '#4fb4dc', foam: '#ffffff', spark: '#ffffff'},
    sun: {color: '#fff5e3', intensity: 2.7, azimuth: -40, elevation: 50},
    hemi: {sky: '#d6edff', ground: '#e7d3a6', intensity: 1.75},
    shadow: 0.62, glow: 0.55, cloudLift: 0.45,
  },
  sunset: {
    label: '黄昏',
    slots: {
      sand: '#f6c88e', sandDark: '#db9d68', grass: '#94b04a', grassDark: '#6f8c3a', soil: '#b0613a', soilDark: '#7a412d',
      rock: '#7f6c78', rockDark: '#5b4a5c',
      palmTrunk: '#b97c4a', palmTrunkDark: '#87563a', palmLeaf: '#71ad4a', palmLeafDark: '#4f833a', coconut: '#6c3a22',
      treeTrunk: '#6c4430', leafA: '#548c3f', leafB: '#82aa48', pine: '#3d6c4a', pineDark: '#2c5239',
      fieldSoil: '#83492f', fieldRidge: '#a35d38', sprout: '#b1d24a',
      wood: '#a3633f', woodDark: '#6e3f2a', plank: '#c27f50', thatch: '#e8ae5c', thatchDark: '#bd8740', roof: '#d64f3a', roofDark: '#a3392c',
      stone: '#c2aea6', stoneDark: '#927c79', wall: '#f4dcc0', window: '#ffc96a', door: '#5a3424',
      cloth: '#f6e2cc', accent: '#ff6a4a', rope: '#d6ad7c', lantern: '#ffd27a', fire: '#ff7a2a', metal: '#5a5a68',
      hull: '#efd8c2', sail: '#ffe9d2', smoke: '#e9d0c8', cloud: '#ffd2bd', bird: '#fff1e2',
    },
    sky: {top: '#353a6e', mid: '#c4728a', haze: '#f7b68a', low: '#8a6a8c', sun: '#ffd08a', sunX: -0.35},
    sea: {shallow: '#56b8aa', deep: '#3d6496', far: '#9a7d98', foam: '#fff1de', spark: '#ffd9a0'},
    sun: {color: '#ffbf85', intensity: 3.0, azimuth: -72, elevation: 24},
    hemi: {sky: '#9a94d6', ground: '#e8a274', intensity: 1.7},
    shadow: 0.7, glow: 1.0, cloudLift: 0.4,
  },
};
export const PALETTE_NAMES = Object.keys(PALETTES);
