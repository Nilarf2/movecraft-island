// Add recorded Chinese clips by key here; missing clips use the device's voice.
export const VOICE_ASSETS = {};

export class Narrator {
  constructor({assets = VOICE_ASSETS, environment = globalThis, startTimeout = 3000,
    playbackTimeout = null, correctionInterval = 8000, onStateChange = null} = {}) {
    this.assets = assets;
    this.environment = environment;
    this.startTimeout = startTimeout;
    this.playbackTimeout = playbackTimeout;
    this.correctionInterval = correctionInterval;
    this.enabled = true;
    this.active = null;
    this.queue = [];
    this.lastCorrection = -Infinity;
    this.onStateChange = onStateChange;
    this.lastResult = null;
  }

  get busy() { return Boolean(this.active); }

  get state() {
    return {status: !this.enabled ? 'disabled' : this.active?.phase || 'idle',
      busy: this.busy, enabled: this.enabled, key: this.active?.key ?? null,
      text: this.active?.text ?? '', queueLength: this.queue.length,
      lastResult: this.lastResult ? {...this.lastResult} : null};
  }

  notify() {
    // UI listeners must not strand the speech promise if rendering fails.
    try { this.onStateChange?.(this.state); } catch { /* Speech remains usable. */ }
  }

  owns(request, attempt = request.attempt) {
    return this.active === request && !request.finished && request.attempt === attempt;
  }

  speak(text, {key, replace = true, correction = false, group} = {}) {
    text = String(text ?? '').trim();
    if (!this.enabled || !text) return Promise.resolve({status: 'skipped'});
    if (correction) {
      const now = this.environment.performance?.now?.() ?? Date.now();
      if (now - this.lastCorrection < this.correctionInterval) return Promise.resolve({status: 'throttled'});
      this.lastCorrection = now;
    }
    if (replace) this.cancel();
    return new Promise(resolve => {
      const request = {text, key, group, resolve, cleanup: null, finished: false, attempt: 0, phase: 'starting'};
      if (this.active) {
        // Keep the in-progress count audible, then read only the latest count.
        if (group) {
          const replaced = this.queue.filter(value => value.group === group);
          this.queue = this.queue.filter(value => value.group !== group);
          for (const value of replaced) this.finish(value, 'superseded', false, false);
        }
        if (this.queue.length >= 3) this.finish(this.queue.shift(), 'superseded', false, false);
        this.queue.push(request);
        this.notify();
      } else this.start(request);
    });
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (!this.enabled) this.cancel();
    else this.notify();
  }

  cancel() {
    for (const request of this.queue.splice(0)) this.finish(request, 'cancelled', false, false);
    if (this.active) this.finish(this.active, 'cancelled', false);
    else this.notify();
  }

  finish(request, status, drain = true, notify = true) {
    if (request.finished) return;
    request.finished = true;
    if (this.active === request) this.active = null;
    try { request.cleanup?.(); } catch { /* A broken media API must still resolve. */ }
    this.lastResult = {status, key: request.key ?? null, text: request.text};
    request.resolve({status});
    if (notify) this.notify();
    if (drain && !this.active && this.queue.length) this.start(this.queue.shift());
  }

  start(request) {
    this.active = request;
    this.notify();
    if (!this.owns(request)) return;
    const source = request.key && this.assets[request.key];
    if (typeof source === 'string' && source && this.environment.Audio) this.playClip(request, source);
    else this.synthesize(request);
  }

  timeoutFor(text) {
    return this.playbackTimeout ?? Math.min(180000, Math.max(15000, text.length * 450));
  }

  playClip(request, source) {
    const attempt = ++request.attempt;
    let audio, startTimer, endTimer;
    const cleanup = () => {
      clearTimeout(startTimer); clearTimeout(endTimer);
      if (audio) {
        audio.onended = audio.onerror = audio.onplaying = null;
        try { audio.pause(); } catch { /* Still allow TTS fallback or completion. */ }
        try { audio.removeAttribute?.('src'); audio.load?.(); } catch { /* Optional media APIs. */ }
      }
    };
    const fallback = () => {
      if (!this.owns(request, attempt)) return;
      request.attempt++;
      cleanup();
      this.synthesize(request);
    };
    request.cleanup = cleanup;
    try {
      audio = new this.environment.Audio(source);
      audio.preload = 'auto';
      audio.onended = () => { if (this.owns(request, attempt)) this.finish(request, 'ended'); };
      audio.onerror = fallback;
      audio.onplaying = () => {
        if (!this.owns(request, attempt) || request.phase === 'speaking') return;
        request.phase = 'speaking';
        clearTimeout(startTimer);
        endTimer = setTimeout(() => { if (this.owns(request, attempt)) this.finish(request, 'timeout'); }, this.timeoutFor(request.text));
        this.notify();
      };
      startTimer = setTimeout(fallback, this.startTimeout);
      Promise.resolve(audio.play()).catch(fallback);
    } catch { fallback(); }
  }

  synthesize(request) {
    if (!this.owns(request)) return;
    const attempt = ++request.attempt;
    request.phase = 'starting';
    this.notify();
    if (!this.owns(request, attempt)) return;
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
      let voices = [];
      try { voices = speech.getVoices?.() || []; } catch { /* The default language still works. */ }
      const voice = voices.find(x => /^zh[-_]CN$/i.test(x.lang)) || voices.find(x => /^zh/i.test(x.lang));
      if (voice) utterance.voice = voice;
      utterance.onstart = () => {
        if (!this.owns(request, attempt) || request.phase === 'speaking') return;
        request.phase = 'speaking';
        clearTimeout(startTimer);
        endTimer = setTimeout(() => { if (this.owns(request, attempt)) this.finish(request, 'timeout'); }, this.timeoutFor(request.text));
        this.notify();
      };
      utterance.onend = () => { if (this.owns(request, attempt)) this.finish(request, 'ended'); };
      utterance.onerror = () => { if (this.owns(request, attempt)) this.finish(request, 'blocked'); };
      // Browsers may silently block speech before the first user interaction.
      startTimer = setTimeout(() => { if (this.owns(request, attempt)) this.finish(request, 'blocked'); }, this.startTimeout);
      speech.speak(utterance);
    } catch { this.finish(request, 'error'); }
  }
}
