// Module search shared by the browser and quick-add.
import { registry } from './patch.js';

// Extra search words so common synth names find the right module.
export const KEYWORDS = {
    oscillator: 'vco osc tone wave', lfo: 'modulation wobble', noise: 'white pink brown', keys: 'keyboard qwerty piano midi play',
    sampler: 'drum sample kick snare hat one-shot', fmop: 'fm operator dx', adsr: 'envelope eg contour', filter: 'vcf lowpass highpass bandpass notch',
    vca: 'amp amplifier volume', mixer: 'sum combine', delay: 'echo', reverb: 'room space', convreverb: 'convolution impulse ir space',
    chorus: 'ensemble stereo', flanger: 'jet', phaser: 'allpass sweep', tremolo: 'volume wobble', vibrato: 'pitch wobble',
    compressor: 'dynamics limiter squash', tilteq: 'eq tone bright dark', bitcrusher: 'lofi lo-fi crush decimate', ringmod: 'ring modulator am',
    waveshaper: 'distortion saturation drive overdrive', clipper: 'distortion clip limiter', wavefolder: 'fold distortion west coast',
    clock: 'tempo bpm metronome', sequencer: 'step seq pattern', clockmod: 'divider multiplier divide multiply', clockquant: 'quantize quantise sync',
    euclid: 'euclidean rhythm pattern', probgate: 'random chance probability bernoulli', trigger: 'button gate manual',
    logic: 'and or xor not gate boolean', comparator: 'threshold schmitt gate', math: 'attenuverter offset scale slew lag sample hold quantize invert',
    follower: 'envelope follower amplitude', dcblock: 'dc offset highpass', stereo: 'width pan mid side balance', tuner: 'pitch note detect',
    scope: 'oscilloscope waveform', spectrum: 'fft analyser analyzer frequency',
    midiin: 'midi keyboard controller usb input hardware note cc', recorder: 'record wav export bounce capture render',
    slew: 'slew lag portamento glide smooth rise fall trigger delay gate delay trig', transient: 'transient shaper attack sustain punch envelope dynamics',
    drumsampler: 'drum sampler kit kits 808 909 tr linn sample machine one-shot kick snare hat', calc: 'calculator bpm hz ms tempo delay time conversion tap', drum: 'drum kick snare hat hihat clap tom rim cowbell 808 percussion', granular: 'granular grain cloud texture sampler',
};

export function haystack(def) {
    return `${def.title} ${def.blurb || ''} ${def.category} ${def.type} ${KEYWORDS[def.type] || ''}`.toLowerCase();
}
export function matches(def, words) {
    const h = haystack(def);
    return words.every((w) => h.includes(w));
}
// Higher is better: title starts with the word > a title word starts with it > title contains it > other match.
export function rank(def, w) {
    const t = def.title.toLowerCase();
    return t.startsWith(w) ? 3 : t.split(/\s+/).some((p) => p.startsWith(w)) ? 2 : t.includes(w) ? 1 : 0;
}
export function words(q) { return q.trim().toLowerCase().split(/\s+/).filter(Boolean); }
// Ranked list of addable module definitions for a query (all of them for an empty query).
export function search(q, order = []) {
    const w = words(q);
    const defs = [...registry.values()].filter((d) => !d.hiddenInBrowser);
    const catIndex = (d) => { const i = order.indexOf(d.category); return i < 0 ? 99 : i; };
    if (!w.length) return defs.sort((a, b) => catIndex(a) - catIndex(b));
    return defs.filter((d) => matches(d, w)).sort((a, b) => rank(b, w[0]) - rank(a, w[0]) || catIndex(a) - catIndex(b));
}
