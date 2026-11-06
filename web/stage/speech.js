// 旁白：包一层 voice.js 的 Narrator。加了音量（录音和 TTS 都跟着菜单音量走），旁白播放时让音效 duck。
import {Narrator} from '../voice.js';

export function createSpeech({sfx} = {}) {
  let volume = 1, ducked = false;
  // Narrator reads these lazily, so a page that blocks Audio or speechSynthesis still works.
  const environment = {
    get performance() { return globalThis.performance; },
    get speechSynthesis() { return globalThis.speechSynthesis; },
    get SpeechSynthesisUtterance() {
      const Native = globalThis.SpeechSynthesisUtterance;
      if (!Native) return Native;
      return function Utterance(text) { const u = new Native(text); try { u.volume = volume; } catch { /* optional */ } return u; };
    },
    get Audio() {
      const Native = globalThis.Audio;
      if (!Native) return Native;
      return function VoiceClip(src) { const a = new Native(src); try { a.volume = volume; } catch { /* optional */ } return a; };
    },
  };
  const narrator = new Narrator({environment, onStateChange: state => {
    const busy = !!state.busy;
    if (busy === ducked) return;
    ducked = busy;
    try { sfx?.duck?.(busy); } catch { /* sound is optional */ }
  }});
  return {
    get busy() { return narrator.busy; },
    get state() { return narrator.state; },
    // Resolves with the Narrator result; never rejects, so the flow cannot stall on speech.
    say(parts, options = {}) {
      try { return narrator.speakParts(parts, options).catch(() => ({status: 'error'})); } catch { return Promise.resolve({status: 'error'}); }
    },
    cancel() { try { narrator.cancel(); } catch { /* nothing to stop */ } },
    setVolume(v) { volume = Math.max(0, Math.min(1, v)); },
    mute(on) { narrator.setEnabled(!on); },
  };
}
