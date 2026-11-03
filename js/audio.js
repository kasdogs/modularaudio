// Audio engine bootstrap: one AudioContext, worklets loaded before any module exists.

export const audio = {
    ctx: null,
    master: null,      // master volume GainNode -> limiter -> destination
    ready: false,
    listeners: new Set(),
};

export async function initAudio(masterVolume = 0.8) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error('Web Audio is not supported in this browser.');
    const ctx = new Ctx({ latencyHint: 'interactive' });
    audio.ctx = ctx;
    if (!ctx.audioWorklet) throw new Error('AudioWorklet is not supported in this browser.');
    await ctx.audioWorklet.addModule(new URL('./worklets/processors.js', import.meta.url));

    // Master: volume -> gentle limiter -> speakers
    const master = ctx.createGain();
    master.gain.value = masterVolume;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.1;
    master.connect(limiter).connect(ctx.destination);
    audio.master = master;
    audio.ready = true;

    ctx.addEventListener('statechange', () => notify());
    // Browsers only allow audio after a user gesture; resume on the first one.
    const resume = () => { if (ctx.state !== 'running') ctx.resume().catch(() => {}); };
    ['pointerdown', 'keydown', 'touchend'].forEach((ev) => document.addEventListener(ev, resume, { capture: true }));
    notify();
    return ctx;
}

export function onAudioState(fn) { audio.listeners.add(fn); fn(audioState()); }
export function audioState() { return audio.ctx ? audio.ctx.state : 'none'; }
function notify() { const s = audioState(); audio.listeners.forEach((fn) => fn(s)); }

export function setMasterVolume(v) {
    if (!audio.master) return;
    audio.master.gain.setTargetAtTime(v, audio.ctx.currentTime, 0.02);
}

// Smoothly set an AudioParam without zipper noise.
export function setParam(param, value, time = 0.015) {
    if (!param || !audio.ctx || !Number.isFinite(value)) return;
    const t = audio.ctx.currentTime;
    if (time <= 0) { param.cancelScheduledValues(t); param.setValueAtTime(value, t); return; }
    const cur = param.value;
    param.cancelScheduledValues(t);
    param.setValueAtTime(cur, t);
    param.setTargetAtTime(value, t, time / 3);
}
