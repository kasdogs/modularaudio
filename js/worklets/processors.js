// AudioWorklet processors for Modular Audio.
// Signal conventions: audio/CV are plain floats; gates are high above 0.5 and low below 0.25.

const GATE_HIGH = 0.5;
const GATE_LOW = 0.25;

class GateDetector {
    constructor() { this.high = false; }
    // Returns true on a rising edge.
    step(x) {
        if (!this.high && x > GATE_HIGH) { this.high = true; return true; }
        if (this.high && x < GATE_LOW) { this.high = false; }
        return false;
    }
}

// --- LFO: sine, triangle, saw, ramp, square, sample & hold ---
class LfoProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [
            { name: 'rate', defaultValue: 1, minValue: 0.0001, maxValue: 2000, automationRate: 'a-rate' },
            { name: 'rateCv', defaultValue: 0, minValue: -16, maxValue: 16, automationRate: 'a-rate' },
            { name: 'shape', defaultValue: 0, minValue: 0, maxValue: 5, automationRate: 'k-rate' },
            { name: 'unipolar', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
        ];
    }
    constructor() {
        super();
        this.phase = 0;
        this.sh = Math.random() * 2 - 1;
        this.reset = new GateDetector();
        this.blocks = 0;
        this.last = 0;
    }
    process(inputs, outputs, params) {
        const out = outputs[0][0];
        if (!out) return true;
        const resetIn = inputs[0] && inputs[0][0];
        const rate = params.rate, rateCv = params.rateCv;
        const shape = Math.round(params.shape[0]);
        const uni = params.unipolar[0] > 0.5;
        const inv = 1 / sampleRate;
        for (let i = 0; i < out.length; i++) {
            if (resetIn && this.reset.step(resetIn[i])) { this.phase = 0; this.sh = Math.random() * 2 - 1; }
            const r = (rate.length > 1 ? rate[i] : rate[0]) * Math.pow(2, rateCv.length > 1 ? rateCv[i] : rateCv[0]);
            const p = this.phase;
            let v;
            switch (shape) {
                case 1: v = p < 0.5 ? 4 * p - 1 : 3 - 4 * p; break;
                case 2: v = 2 * p - 1; break;
                case 3: v = 1 - 2 * p; break;
                case 4: v = p < 0.5 ? 1 : -1; break;
                case 5: v = this.sh; break;
                default: v = Math.sin(2 * Math.PI * p);
            }
            out[i] = uni ? (v + 1) * 0.5 : v;
            this.phase += r * inv;
            if (this.phase >= 1) { this.phase -= Math.floor(this.phase); this.sh = Math.random() * 2 - 1; }
            else if (this.phase < 0) { this.phase -= Math.floor(this.phase); }
        }
        this.last = out[out.length - 1];
        if (++this.blocks >= 8) { this.blocks = 0; this.port.postMessage(this.last); }
        return true;
    }
}

// --- ADSR envelope with gate input ---
class AdsrProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [
            { name: 'attack', defaultValue: 0.01, minValue: 0.0005, maxValue: 30, automationRate: 'k-rate' },
            { name: 'decay', defaultValue: 0.2, minValue: 0.001, maxValue: 30, automationRate: 'k-rate' },
            { name: 'sustain', defaultValue: 0.6, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
            { name: 'release', defaultValue: 0.4, minValue: 0.001, maxValue: 30, automationRate: 'k-rate' },
        ];
    }
    constructor() {
        super();
        this.env = 0;
        this.stage = 0; // 0 idle, 1 attack, 2 decay/sustain, 3 release
        this.gate = new GateDetector();
        this.blocks = 0;
    }
    process(inputs, outputs, params) {
        const out = outputs[0][0];
        if (!out) return true;
        const gateIn = inputs[0] && inputs[0][0];
        const a = params.attack[0], d = params.decay[0], s = params.sustain[0], r = params.release[0];
        const attackStep = 1 / (a * sampleRate);
        // Exponential segments reach ~99% of their target within the set time.
        const dCoef = 1 - Math.exp(-4.6 / (d * sampleRate));
        const rCoef = 1 - Math.exp(-4.6 / (r * sampleRate));
        for (let i = 0; i < out.length; i++) {
            const g = gateIn ? gateIn[i] : 0;
            if (this.gate.step(g)) this.stage = 1;
            else if (!this.gate.high && (this.stage === 1 || this.stage === 2)) this.stage = 3;
            switch (this.stage) {
                case 1:
                    this.env += attackStep;
                    if (this.env >= 1) { this.env = 1; this.stage = 2; }
                    break;
                case 2: this.env += (s - this.env) * dCoef; break;
                case 3:
                    this.env += (0 - this.env) * rCoef;
                    if (this.env < 1e-5) { this.env = 0; this.stage = 0; }
                    break;
            }
            out[i] = this.env;
        }
        if (++this.blocks >= 8) { this.blocks = 0; this.port.postMessage(this.env); }
        return true;
    }
}

// --- Clock: three gate outputs (x1, /2, /4) ---
class ClockProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [
            { name: 'bpm', defaultValue: 120, minValue: 1, maxValue: 1000, automationRate: 'k-rate' },
            { name: 'run', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
            { name: 'div', defaultValue: 4, minValue: 1, maxValue: 16, automationRate: 'k-rate' },
            { name: 'swing', defaultValue: 0, minValue: 0, maxValue: 0.75, automationRate: 'k-rate' },
        ];
    }
    constructor() {
        super();
        this.phase = 0;
        this.count = 0;
        this.reset = new GateDetector();
        this.port.onmessage = (e) => { if (e.data === 'reset') { this.phase = 0; this.count = 0; } };
    }
    process(inputs, outputs, params) {
        const o1 = outputs[0] && outputs[0][0];
        const o2 = outputs[1] && outputs[1][0];
        const o4 = outputs[2] && outputs[2][0];
        const n = (o1 || o2 || o4 || []).length;
        if (!n) return true;
        const resetIn = inputs[0] && inputs[0][0];
        const running = params.run[0] > 0.5;
        const ticksPerSec = params.bpm[0] / 60 * Math.max(1, Math.round(params.div[0]));
        const swing = params.swing[0];
        for (let i = 0; i < n; i++) {
            if (resetIn && this.reset.step(resetIn[i])) { this.phase = 0; this.count = 0; this.port.postMessage(0); }
            let g1 = 0, g2 = 0, g4 = 0;
            if (running) {
                // Swing stretches even ticks and shortens odd ones.
                const odd = this.count % 2 === 1;
                const len = odd ? 1 - swing * 0.5 : 1 + swing * 0.5;
                g1 = this.phase < 0.5 * len ? 1 : 0;
                const c = this.count;
                g2 = (c % 2 === 0 && this.phase < 1) ? 1 : 0;
                g4 = (c % 4 < 2) ? 1 : 0;
                this.phase += ticksPerSec / sampleRate;
                if (this.phase >= len) {
                    this.phase -= len;
                    this.count++;
                    this.port.postMessage(this.count);
                }
            }
            if (o1) o1[i] = g1;
            if (o2) o2[i] = g2;
            if (o4) o4[i] = g4;
        }
        return true;
    }
}

// --- Step sequencer: clock + reset in, pitch + gate out ---
class SequencerProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.steps = [];
        this.length = 8;
        this.gateLen = 0.5;
        this.step = -1;
        this.pitch = 0;
        this.sinceClock = 0;
        this.period = sampleRate * 0.25;
        this.sinceStep = 1e9;
        this.gateSamples = 0;
        this.clock = new GateDetector();
        this.reset = new GateDetector();
        this.port.onmessage = (e) => {
            const m = e.data;
            if (m.steps) this.steps = m.steps;
            if (m.length) this.length = m.length;
            if (m.gateLen !== undefined) this.gateLen = m.gateLen;
            if (m.reset) this.step = -1;
        };
    }
    process(inputs, outputs) {
        const pitchOut = outputs[0] && outputs[0][0];
        const gateOut = outputs[1] && outputs[1][0];
        const n = (pitchOut || gateOut || []).length;
        if (!n) return true;
        const clk = inputs[0] && inputs[0][0];
        const rst = inputs[1] && inputs[1][0];
        for (let i = 0; i < n; i++) {
            if (rst && this.reset.step(rst[i])) { this.step = -1; this.port.postMessage(-1); }
            this.sinceClock++;
            if (clk && this.clock.step(clk[i])) {
                if (this.sinceClock > 32 && this.sinceClock < sampleRate * 8) this.period = this.sinceClock;
                this.sinceClock = 0;
                this.step = (this.step + 1) % Math.max(1, this.length);
                const st = this.steps[this.step];
                if (st) this.pitch = st.note / 12;
                this.gateSamples = st && st.on ? Math.max(sampleRate * 0.002, this.gateLen * this.period) : 0;
                this.sinceStep = 0;
                this.port.postMessage(this.step);
            }
            // A short low gap at each step start lets envelopes retrigger on tied notes.
            const g = this.sinceStep >= 24 && this.sinceStep < this.gateSamples + 24 ? 1 : 0;
            this.sinceStep++;
            if (pitchOut) pitchOut[i] = this.pitch;
            if (gateOut) gateOut[i] = g;
        }
        return true;
    }
}

registerProcessor('ma-lfo', LfoProcessor);
registerProcessor('ma-adsr', AdsrProcessor);
registerProcessor('ma-clock', ClockProcessor);
registerProcessor('ma-sequencer', SequencerProcessor);
