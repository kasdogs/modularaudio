// Starter patch: clocked sequence through a filtered, enveloped oscillator with delay.
export const EXAMPLE_PATCH = {
    app: 'modularaudio', version: 1,
    modules: [
        { id: 'clock-1', type: 'clock', x: 20, y: 20, params: { bpm: 112, div: 2, run: 1 } },
        { id: 'sequencer-2', type: 'sequencer', x: 250, y: 20, params: { length: 8, gateLen: 0.45 } },
        { id: 'lfo-3', type: 'lfo', x: 20, y: 300, params: { rate: 0.15, shape: 1, depth: 1 } },
        { id: 'oscillator-4', type: 'oscillator', x: 550, y: 20, params: { mode: 'note', note: 'C', octave: 3, wave: 'sawtooth', level: -6 } },
        { id: 'adsr-5', type: 'adsr', x: 550, y: 420, params: { attack: 0.004, decay: 0.22, sustain: 0.15, release: 0.3 } },
        { id: 'filter-6', type: 'filter', x: 790, y: 20, params: { mode: 'lowpass', slope: 24, cutoff: 380, q: 4, amount: 4 } },
        { id: 'vca-7', type: 'vca', x: 1020, y: 20, params: { level: 0.9 } },
        { id: 'delay-8', type: 'delay', x: 1020, y: 230, params: { time: 0.402, feedback: 0.42, mix: 0.28, tone: 4200 } },
        { id: 'scope-9', type: 'scope', x: 1250, y: 300, params: { window: 12 } },
        { id: 'output-10', type: 'output', x: 1250, y: 20, params: { level: -4 } },
    ],
    connections: [
        { from: ['clock-1', 'x1'], to: ['sequencer-2', 'clock'], gain: 1 },
        { from: ['sequencer-2', 'pitch'], to: ['oscillator-4', 'pitch'], gain: 1 },
        { from: ['sequencer-2', 'gate'], to: ['adsr-5', 'gate'], gain: 1 },
        { from: ['oscillator-4', 'out'], to: ['filter-6', 'in'], gain: 1 },
        { from: ['adsr-5', 'env'], to: ['filter-6', 'cutoff'], gain: 1 },
        { from: ['lfo-3', 'out'], to: ['filter-6', 'cutoff'], gain: 0.25 },
        { from: ['adsr-5', 'env'], to: ['vca-7', 'cv'], gain: 1 },
        { from: ['filter-6', 'out'], to: ['vca-7', 'in'], gain: 1 },
        { from: ['vca-7', 'out'], to: ['delay-8', 'in'], gain: 1 },
        { from: ['delay-8', 'out'], to: ['output-10', 'in'], gain: 1 },
        { from: ['vca-7', 'out'], to: ['scope-9', 'in'], gain: 1 },
    ],
};
