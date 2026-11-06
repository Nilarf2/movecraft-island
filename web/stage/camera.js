// 摄像头：包一层 pose-stream.js，跑 detector.js 的动作识别，画角落小窗。
// pose-stream 缺失或摄像头打不开时 available 为 false，大屏页照常用键鼠试玩。
import {Detector} from '../detector.js';
import {mirror} from '../scene.js';
import {personInView} from './flow.js';

const DEVICE_KEY = 'movecraft.stage.camera';
const readDevice = () => { try { return localStorage.getItem(DEVICE_KEY) || ''; } catch { return ''; } };
const writeDevice = id => { try { localStorage.setItem(DEVICE_KEY, id || ''); } catch { /* not remembered */ } };

// onFrame({landmarks, worldLandmarks, timestamp, present, fps}); onDetect(result, action); onStatus({state, error, live})
export function createCamera({poseModule, onFrame, onDetect, onStatus}) {
  const c = {stream: null, state: poseModule?.createPoseStream ? 'stopped' : 'unavailable', error: null,
    devices: [], deviceId: readDevice(), label: '', landmarks: null, lastPose: -Infinity, fps: 0, action: 'none', detector: null};
  const live = () => c.state === 'running' || c.state === 'ready';
  function status(state, error = null) {
    const was = live();
    c.state = state; c.error = error;
    try { onStatus?.({state, error, live: live(), changed: was !== live()}); } catch (e) { console.warn('[stage] camera status handler failed', e); }
  }
  function onPose({landmarks = [], worldLandmarks = [], timestamp, fps}) {
    c.landmarks = landmarks; c.lastPose = performance.now(); if (Number.isFinite(fps)) c.fps = fps;
    const present = personInView(landmarks);
    try { onFrame?.({landmarks, worldLandmarks, timestamp, present, fps: c.fps}); } catch (e) { console.warn('[stage] pose handler failed', e); }
    if (!c.detector || c.action === 'none') return;
    const video = c.stream?.video;
    const aspect = video?.videoWidth && video?.videoHeight ? video.videoWidth / video.videoHeight : 4 / 3;
    const result = c.detector.update(landmarks, timestamp, aspect);
    try { onDetect?.(result, c.action); } catch (e) { console.warn('[stage] detect handler failed', e); }
  }
  async function listDevices() {
    try { c.devices = (await poseModule.listCameras?.()) || []; } catch { c.devices = []; }
    if (c.deviceId && c.devices.length && !c.devices.some(d => d.deviceId === c.deviceId)) { c.deviceId = ''; writeDevice(''); }
    return c.devices;
  }
  return {
    get available() { return !!poseModule?.createPoseStream; },
    get live() { return live(); },
    get state() { return c.state; },
    get error() { return c.error; },
    get fps() { return live() ? c.fps : 0; },
    get video() { return c.stream?.video || null; },
    get devices() { return c.devices; },
    get label() { return c.devices.find(d => d.deviceId === c.deviceId)?.label || (c.deviceId ? '已选摄像头' : '系统默认'); },
    // Landmarks newer than ms, else null.
    fresh(ms = 500) { return performance.now() - c.lastPose < ms ? c.landmarks : null; },
    async start() {
      if (!poseModule?.createPoseStream || c.stream) return false;
      try {
        await listDevices();
        c.stream = poseModule.createPoseStream({deviceId: c.deviceId || undefined, width: 640, height: 480, onPose,
          onStatus: ({state, error} = {}) => status(state || 'error', error || null)});
        await c.stream.start();
        return true;
      } catch (error) { status('error', error); return false; }
    },
    stop() { try { c.stream?.stop(); } catch { /* already stopped */ } },
    // Next camera in the list (wraps to the system default).
    async next() {
      await listDevices();
      const ids = ['', ...c.devices.map(d => d.deviceId).filter(Boolean)];
      const id = ids[(ids.indexOf(c.deviceId) + 1) % ids.length] || '';
      c.deviceId = id; writeDevice(id);
      try { await c.stream?.switchCamera(id || undefined); } catch (error) { status('error', error); }
      return this.label;
    },
    // A new detector per stage or screen, so half a gesture never carries over.
    setAction(action) { c.action = action; c.detector = action === 'none' ? null : new Detector(action); },
    draw(canvas) {
      const ctx = canvas.getContext('2d');
      const video = c.stream?.video;
      if (!video || !live()) { ctx.fillStyle = '#0a363b'; ctx.fillRect(0, 0, canvas.width, canvas.height); return; }
      mirror(canvas, video, this.fresh());
    },
  };
}
