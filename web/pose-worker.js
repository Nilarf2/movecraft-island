import { FilesetResolver, PoseLandmarker } from './vendor/vision_bundle.mjs';
let landmarker;
self.onmessage = async ({data}) => {
  try {
    if (data.type === 'init') {
      const fileset = await FilesetResolver.forVisionTasks(new URL('./vendor/wasm', self.location.href).href, true);
      landmarker = await PoseLandmarker.createFromOptions(fileset, {
        baseOptions: {modelAssetPath: new URL('./models/pose_landmarker_lite.task', self.location.href).href, delegate: 'CPU'},
        runningMode: 'VIDEO', numPoses: 1, minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
      });
      self.postMessage({type: 'ready'});
    } else if (data.type === 'frame') {
      try {
        const begin = performance.now();
        const result = landmarker.detectForVideo(data.frame, data.timestamp);
        self.postMessage({type: 'pose', landmarks: result.landmarks[0] || [], timestamp: data.timestamp, latency: performance.now() - begin});
      } finally { data.frame.close(); }
    }
  } catch (e) { self.postMessage({type: 'error', message: String(e.message || e)}); }
};
