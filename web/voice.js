// Add recorded Chinese clips by key here; missing clips use the device's voice.
export const VOICE_ASSETS = {};

export class Narrator {
  constructor({assets = VOICE_ASSETS, environment = globalThis, startTimeout = 3000,
    playbackTimeout = null, correctionInterval = 8000} = {}) {
    this.assets = assets;
    this.environment = environment;
    this.startTimeout = startTimeout;
    this.playbackTimeout = playbackTimeout;
    this.correctionInterval = correctionInterval;
    this.enabled = true;
    this.active = null;
    this.queue = [];
    this.lastCorrection = -Infinity;
  }

  speak(text, {key, replace = true, correction = false} = {}) {
    text = String(text ?? '').trim();
    if (!this.enabled || !text) return Promise.resolve({status: 'skipped'});
    if (correction) {
      const now = Date.now();
      if (now - this.lastCorrection < this.correctionInterval) return Promise.resolve({status: 'throttled'});
      this.lastCorrection = now;
    }
    if (replace) this.cancel();
    return new Promise(resolve => {
      const request = {text, key, resolve, cleanup: null, finished: false};
      if (this.active) {
        // Optional sequencing is bounded; rapid rep counts should use replace.
        if (this.queue.length >= 3) this.queue.shift().resolve({status: 'superseded'});
        this.queue.push(request);
      } else this.start(request);
    });
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (!this.enabled) this.cancel();
  }

  cancel() {
    for (const request of this.queue.splice(0)) request.resolve({status: 'cancelled'});
    if (this.active) this.finish(this.active, 'cancelled', false);
  }

  finish(request, status, drain = true) {
    if (request.finished) return;
    request.finished = true;
    request.cleanup?.();
    if (this.active === request) this.active = null;
    request.resolve({status});
    if (drain && !this.active && this.queue.length) this.start(this.queue.shift());
  }

  start(request) {
    this.active = request;
    const source = request.key && this.assets[request.key];
    if (typeof source === 'string' && source && this.environment.Audio) this.playClip(request, source);
    else this.synthesize(request);
  }

  timeoutFor(text) {
    return this.playbackTimeout ?? Math.min(180000, Math.max(15000, text.length * 450));
  }

  playClip(request, source) {
    let audio, startTimer, endTimer, fellBack = false;
    const cleanup = () => {
      clearTimeout(startTimer); clearTimeout(endTimer);
      if (audio) {
        audio.onended = audio.onerror = audio.onplaying = null;
        audio.pause();
      }
    };
    const fallback = () => {
      if (fellBack || request.finished || this.active !== request) return;
      fellBack = true;
      cleanup();
      this.synthesize(request);
    };
    request.cleanup = cleanup;
    try {
      audio = new this.environment.Audio(source);
      audio.preload = 'auto';
      audio.onended = () => this.finish(request, 'ended');
      audio.onerror = fallback;
      audio.onplaying = () => {
        clearTimeout(startTimer);
        clearTimeout(endTimer);
        endTimer = setTimeout(() => this.finish(request, 'timeout'), this.timeoutFor(request.text));
      };
      startTimer = setTimeout(fallback, this.startTimeout);
      Promise.resolve(audio.play()).catch(fallback);
    } catch { fallback(); }
  }

  synthesize(request) {
    const {speechSynthesis: speech, SpeechSynthesisUtterance: Utterance} = this.environment;
    if (!speech || typeof speech.speak !== 'function' || !Utterance) {
      this.finish(request, 'unavailable'); return;
    }
    let utterance, startTimer, endTimer;
    request.cleanup = () => {
      clearTimeout(startTimer); clearTimeout(endTimer);
      if (utterance) utterance.onstart = utterance.onend = utterance.onerror = null;
      try { speech.cancel(); } catch { /* Some embedded browsers expose a partial API. */ }
    };
    try {
      utterance = new Utterance(request.text);
      utterance.lang = 'zh-CN'; utterance.rate = 1; utterance.pitch = 1;
      const voices = typeof speech.getVoices === 'function' ? speech.getVoices() : [];
      const voice = voices.find(x => /^zh[-_]CN$/i.test(x.lang)) || voices.find(x => /^zh/i.test(x.lang));
      if (voice) utterance.voice = voice;
      utterance.onstart = () => {
        clearTimeout(startTimer);
        endTimer = setTimeout(() => this.finish(request, 'timeout'), this.timeoutFor(request.text));
      };
      utterance.onend = () => this.finish(request, 'ended');
      utterance.onerror = () => this.finish(request, 'blocked');
      // Browsers may silently block speech before the first user interaction.
      startTimer = setTimeout(() => this.finish(request, 'blocked'), this.startTimeout);
      speech.speak(utterance);
    } catch { this.finish(request, 'error'); }
  }
}
