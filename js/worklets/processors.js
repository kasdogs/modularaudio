// AudioWorklet processors for Modular Audio.
// Signal conventions: audio/CV are plain floats; gates are high above 0.5 and low below 0.25.

const GATE_HIGH = 0.5;
const GATE_LOW = 0.25;

// Base class: lets the main thread retire a processor so deleted modules stop using CPU.
class Base extends AudioWorkletProcessor {
    constructor() {
        super();
        this.alive = true;
        this.port.onmessage = (e) => {
            if (e.data === '__dispose') { this.alive = false; return; }
            if (this.onMessage) this.onMessage(e);
        };
    }
}

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
class LfoProcessor extends Base {
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
        if (!this.alive) return false;
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
class AdsrProcessor extends Base {
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
        if (!this.alive) return false;
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
class ClockProcessor extends Base {
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
        this.onMessage = (e) => { if (e.data === 'reset') { this.phase = 0; this.count = 0; } };
    }
    process(inputs, outputs, params) {
        if (!this.alive) return false;
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
class SequencerProcessor extends Base {
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
        this.onMessage = (e) => {
            const m = e.data;
            if (m.steps) this.steps = m.steps;
            if (m.length) this.length = m.length;
            if (m.gateLen !== undefined) this.gateLen = m.gateLen;
            if (m.reset) this.step = -1;
        };
    }
    process(inputs, outputs) {
        if (!this.alive) return false;
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

// --- Bitcrusher: bit depth and sample-rate reduction, per-channel state ---
class CrushProcessor extends Base {
    static get parameterDescriptors() {
        return [
            { name: 'bits', defaultValue: 8, minValue: 1, maxValue: 16, automationRate: 'a-rate' },
            { name: 'reduce', defaultValue: 1, minValue: 1, maxValue: 64, automationRate: 'k-rate' },
        ];
    }
    constructor() { super(); this.phase = []; this.held = []; }
    process(inputs, outputs, params) {
        if (!this.alive) return false;
        const input = inputs[0], output = outputs[0];
        if (!input || !input.length) return true;
        const bits = params.bits;
        const reduce = Math.max(1, params.reduce[0]);
        for (let c = 0; c < output.length; c++) {
            const inp = input[c] || input[0], out = output[c];
            let ph = this.phase[c] || 0, h = this.held[c] || 0;
            for (let i = 0; i < out.length; i++) {
                ph += 1;
                if (ph >= reduce) {
                    ph -= reduce;
                    const b = Math.min(16, Math.max(1, bits.length > 1 ? bits[i] : bits[0]));
                    const levels = Math.pow(2, b - 1); // fractional depths are allowed
                    h = Math.round(inp[i] * levels) / levels;
                }
                out[i] = h;
            }
            this.phase[c] = ph;
            this.held[c] = h;
        }
        return true;
    }
}

// --- Clock modifier: divide or multiply an incoming clock ---
class ClockModProcessor extends Base {
    static get parameterDescriptors() {
        return [
            { name: 'ratio', defaultValue: 2, minValue: 1, maxValue: 32, automationRate: 'k-rate' },
            { name: 'multiply', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
        ];
    }
    constructor() {
        super();
        this.clk = new GateDetector(); this.rst = new GateDetector();
        this.count = -1; this.since = 0; this.period = sampleRate * 0.5;
        this.pos = 1e12; // samples since the current output cycle started
        this.cycle = sampleRate * 0.5;
    }
    process(inputs, outputs, params) {
        if (!this.alive) return false;
        const out = outputs[0][0];
        if (!out) return true;
        const clk = inputs[0] && inputs[0][0], rst = inputs[1] && inputs[1][0];
        const n = Math.max(1, Math.round(params.ratio[0]));
        const mul = params.multiply[0] > 0.5;
        for (let i = 0; i < out.length; i++) {
            this.since++;
            if (rst && this.rst.step(rst[i])) { this.count = -1; this.pos = 1e12; }
            if (clk && this.clk.step(clk[i])) {
                if (this.since > 16 && this.since < sampleRate * 8) this.period = this.since;
                this.since = 0;
                this.count = (this.count + 1) % n;
                if (mul) { this.cycle = this.period / n; this.pos = 0; }
                else if (this.count === 0) { this.cycle = this.period * n; this.pos = 0; }
            }
            let g = 0;
            if (mul) {
                // n evenly spaced pulses per input period, 50% duty
                const k = Math.floor(this.pos / this.cycle);
                g = k < n && (this.pos - k * this.cycle) < this.cycle * 0.5 ? 1 : 0;
            } else g = this.pos < this.cycle * 0.5 ? 1 : 0;
            this.pos++;
            out[i] = g;
        }
        return true;
    }
}

// --- Euclidean rhythm: clock + reset in, hit and off-beat gates out ---
class EuclidProcessor extends Base {
    static get parameterDescriptors() {
        return [
            { name: 'steps', defaultValue: 16, minValue: 1, maxValue: 64, automationRate: 'k-rate' },
            { name: 'fills', defaultValue: 4, minValue: 0, maxValue: 64, automationRate: 'k-rate' },
            { name: 'rotate', defaultValue: 0, minValue: 0, maxValue: 63, automationRate: 'k-rate' },
        ];
    }
    constructor() { super(); this.clk = new GateDetector(); this.rst = new GateDetector(); this.step = -1; this.hit = false; }
    static isHit(i, n, k, r) { if (k <= 0) return false; if (k >= n) return true; const j = (i + n - (r % n)) % n; return (j * k) % n < k; }
    process(inputs, outputs, params) {
        if (!this.alive) return false;
        const o1 = outputs[0] && outputs[0][0], o2 = outputs[1] && outputs[1][0];
        const len = (o1 || o2 || []).length;
        if (!len) return true;
        const clk = inputs[0] && inputs[0][0], rst = inputs[1] && inputs[1][0];
        const n = Math.max(1, Math.round(params.steps[0]));
        const k = Math.round(params.fills[0]), r = Math.round(params.rotate[0]);
        for (let i = 0; i < len; i++) {
            if (rst && this.rst.step(rst[i])) { this.step = -1; this.port.postMessage(-1); }
            if (clk && this.clk.step(clk[i])) {
                this.step = (this.step + 1) % n;
                this.hit = EuclidProcessor.isHit(this.step, n, k, r);
                this.port.postMessage(this.step);
            }
            const high = this.clk.high && this.step >= 0;
            if (o1) o1[i] = high && this.hit ? 1 : 0;
            if (o2) o2[i] = high && !this.hit ? 1 : 0;
        }
        return true;
    }
}

// --- Probability gate: each incoming gate passes to A with probability p, otherwise to B ---
class ProbGateProcessor extends Base {
    static get parameterDescriptors() { return [{ name: 'prob', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'a-rate' }]; }
    constructor() { super(); this.g = new GateDetector(); this.pass = false; }
    process(inputs, outputs, params) {
        if (!this.alive) return false;
        const a = outputs[0] && outputs[0][0], b = outputs[1] && outputs[1][0];
        const len = (a || b || []).length;
        if (!len) return true;
        const inp = inputs[0] && inputs[0][0];
        const p = params.prob;
        for (let i = 0; i < len; i++) {
            const x = inp ? inp[i] : 0;
            if (this.g.step(x)) {
                const pr = Math.min(1, Math.max(0, p.length > 1 ? p[i] : p[0]));
                this.pass = Math.random() < pr;
                this.port.postMessage(this.pass ? 1 : 0);
            }
            const h = this.g.high;
            if (a) a[i] = h && this.pass ? 1 : 0;
            if (b) b[i] = h && !this.pass ? 1 : 0;
        }
        return true;
    }
}

// --- Trigger delay: each rising edge fires a gate of set length after a delay ---
class TrigDelayProcessor extends Base {
    static get parameterDescriptors() {
        return [
            { name: 'delay', defaultValue: 0.1, minValue: 0, maxValue: 10, automationRate: 'a-rate' },
            { name: 'length', defaultValue: 0.01, minValue: 0.001, maxValue: 5, automationRate: 'k-rate' },
        ];
    }
    constructor() { super(); this.g = new GateDetector(); this.queue = []; this.t = 0; this.offAt = -1; }
    process(inputs, outputs, params) {
        if (!this.alive) return false;
        const out = outputs[0][0];
        if (!out) return true;
        const inp = inputs[0] && inputs[0][0];
        const d = params.delay, len = params.length[0] * sampleRate;
        for (let i = 0; i < out.length; i++) {
            this.t++;
            if (inp && this.g.step(inp[i]) && this.queue.length < 256) {
                const dl = Math.max(0, d.length > 1 ? d[i] : d[0]);
                this.queue.push(this.t + dl * sampleRate);
            }
            while (this.queue.length && this.queue[0] <= this.t) { this.queue.shift(); this.offAt = this.t + len; this.gap = 24; }
            // brief low gap so back-to-back pulses stay distinct
            let g = this.t < this.offAt ? 1 : 0;
            if (this.gap > 0) { this.gap--; g = 0; }
            out[i] = g;
        }
        return true;
    }
}

// --- Logic: AND, OR, XOR, NAND, NOR, XNOR, NOT A on two gates ---
class LogicProcessor extends Base {
    static get parameterDescriptors() { return [{ name: 'op', defaultValue: 0, minValue: 0, maxValue: 6, automationRate: 'k-rate' }]; }
    constructor() { super(); this.a = new GateDetector(); this.b = new GateDetector(); }
    process(inputs, outputs, params) {
        if (!this.alive) return false;
        const o = outputs[0] && outputs[0][0], inv = outputs[1] && outputs[1][0];
        const len = (o || inv || []).length;
        if (!len) return true;
        const A = inputs[0] && inputs[0][0], B = inputs[1] && inputs[1][0];
        const op = Math.round(params.op[0]);
        for (let i = 0; i < len; i++) {
            this.a.step(A ? A[i] : 0); this.b.step(B ? B[i] : 0);
            const a = this.a.high, b = this.b.high;
            let r;
            switch (op) {
                case 1: r = a || b; break;
                case 2: r = a !== b; break;
                case 3: r = !(a && b); break;
                case 4: r = !(a || b); break;
                case 5: r = a === b; break;
                case 6: r = !a; break;
                default: r = a && b;
            }
            if (o) o[i] = r ? 1 : 0;
            if (inv) inv[i] = r ? 0 : 1;
        }
        return true;
    }
}

// --- Comparator with hysteresis: gate high while input > threshold ---
class ComparatorProcessor extends Base {
    static get parameterDescriptors() {
        return [
            { name: 'threshold', defaultValue: 0, minValue: -10, maxValue: 10, automationRate: 'a-rate' },
            { name: 'hysteresis', defaultValue: 0.02, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
        ];
    }
    constructor() { super(); this.high = false; this.blocks = 0; }
    process(inputs, outputs, params) {
        if (!this.alive) return false;
        const o = outputs[0] && outputs[0][0], inv = outputs[1] && outputs[1][0];
        const len = (o || inv || []).length;
        if (!len) return true;
        const x = inputs[0] && inputs[0][0];
        const th = params.threshold, h = params.hysteresis[0] / 2;
        for (let i = 0; i < len; i++) {
            const v = x ? x[i] : 0, t = th.length > 1 ? th[i] : th[0];
            if (!this.high && v > t + h) this.high = true;
            else if (this.high && v < t - h) this.high = false;
            if (o) o[i] = this.high ? 1 : 0;
            if (inv) inv[i] = this.high ? 0 : 1;
        }
        if (++this.blocks >= 8) { this.blocks = 0; this.port.postMessage(this.high ? 1 : 0); }
        return true;
    }
}

// --- Math: two inputs, one operation, then scale/offset and optional slew ---
class MathProcessor extends Base {
    static get parameterDescriptors() {
        return [
            { name: 'op', defaultValue: 0, minValue: 0, maxValue: 9, automationRate: 'k-rate' },
            { name: 'scale', defaultValue: 1, minValue: -100, maxValue: 100, automationRate: 'a-rate' },
            { name: 'offset', defaultValue: 0, minValue: -100, maxValue: 100, automationRate: 'a-rate' },
            { name: 'rise', defaultValue: 0, minValue: 0, maxValue: 30, automationRate: 'k-rate' },
            { name: 'fall', defaultValue: 0, minValue: 0, maxValue: 30, automationRate: 'k-rate' },
        ];
    }
    constructor() { super(); this.y = 0; this.sh = 0; this.g = new GateDetector(); this.blocks = 0; }
    process(inputs, outputs, params) {
        if (!this.alive) return false;
        const out = outputs[0][0];
        if (!out) return true;
        const A = inputs[0] && inputs[0][0], B = inputs[1] && inputs[1][0];
        const op = Math.round(params.op[0]);
        const sc = params.scale, of = params.offset;
        // Slew: time to move one unit
        const rise = params.rise[0], fall = params.fall[0];
        const up = rise > 0 ? 1 / (rise * sampleRate) : Infinity, dn = fall > 0 ? 1 / (fall * sampleRate) : Infinity;
        for (let i = 0; i < out.length; i++) {
            const a = A ? A[i] : 0, b = B ? B[i] : 0;
            let r;
            switch (op) {
                case 1: r = a - b; break;
                case 2: r = a * (B ? b : 1); break;
                case 3: r = Math.min(a, B ? b : a); break;
                case 4: r = Math.max(a, B ? b : a); break;
                case 5: r = Math.abs(a); break;
                case 6: r = -a; break;
                case 7: if (this.g.step(b)) this.sh = a; r = this.sh; break; // sample & hold A when B gates
                case 8: r = Math.round(a * 12) / 12; break;              // quantise to semitones (1V/oct)
                case 9: r = a > 0 ? a : 0; break;                         // half-wave rectify
                default: r = a + b;
            }
            r = r * (sc.length > 1 ? sc[i] : sc[0]) + (of.length > 1 ? of[i] : of[0]);
            const d = r - this.y;
            this.y += d > 0 ? Math.min(d, up) : Math.max(d, -dn);
            out[i] = this.y;
        }
        if (++this.blocks >= 8) { this.blocks = 0; this.port.postMessage(this.y); }
        return true;
    }
}

// --- Envelope follower: rectify and smooth into a CV ---
class FollowerProcessor extends Base {
    static get parameterDescriptors() {
        return [
            { name: 'attack', defaultValue: 0.01, minValue: 0.0001, maxValue: 2, automationRate: 'k-rate' },
            { name: 'release', defaultValue: 0.2, minValue: 0.001, maxValue: 5, automationRate: 'k-rate' },
        ];
    }
    constructor() { super(); this.env = 0; this.blocks = 0; }
    process(inputs, outputs, params) {
        if (!this.alive) return false;
        const out = outputs[0][0];
        if (!out) return true;
        const inp = inputs[0];
        const a = 1 - Math.exp(-1 / (params.attack[0] * sampleRate));
        const r = 1 - Math.exp(-1 / (params.release[0] * sampleRate));
        for (let i = 0; i < out.length; i++) {
            let x = 0;
            if (inp) for (let c = 0; c < inp.length; c++) x = Math.max(x, Math.abs(inp[c][i]));
            this.env += (x - this.env) * (x > this.env ? a : r);
            out[i] = this.env;
        }
        if (++this.blocks >= 8) { this.blocks = 0; this.port.postMessage(this.env); }
        return true;
    }
}

// --- Clock quantiser: an incoming gate is delayed to the next clock pulse ---
class ClockQuantProcessor extends Base {
    constructor() { super(); this.g = new GateDetector(); this.c = new GateDetector(); this.armed = false; this.firing = false; }
    process(inputs, outputs) {
        if (!this.alive) return false;
        const out = outputs[0][0];
        if (!out) return true;
        const gate = inputs[0] && inputs[0][0], clk = inputs[1] && inputs[1][0];
        for (let i = 0; i < out.length; i++) {
            if (gate && this.g.step(gate[i])) this.armed = true;
            const edge = clk ? this.c.step(clk[i]) : false;
            if (edge) { this.firing = this.armed; this.armed = false; }
            if (this.firing && !this.c.high) this.firing = false;
            out[i] = this.firing ? 1 : 0;
        }
        return true;
    }
}

// --- Edge reporter: tells the main thread about gate rises and falls ---
class EdgeProcessor extends Base {
    constructor() { super(); this.g = new GateDetector(); }
    process(inputs) {
        if (!this.alive) return false;
        const x = inputs[0] && inputs[0][0];
        if (!x) return true;
        for (let i = 0; i < x.length; i++) {
            const was = this.g.high;
            if (this.g.step(x[i])) this.port.postMessage({ on: true, t: currentTime + i / sampleRate });
            else if (was && !this.g.high) this.port.postMessage({ on: false, t: currentTime + i / sampleRate });
        }
        return true;
    }
}

// --- Recorder: passes audio through and streams stereo blocks to the main thread while armed ---
class RecorderProcessor extends Base {
    constructor() {
        super();
        this.rec = false;
        this.size = 16384;
        this.fill = 0;
        this.l = new Float32Array(this.size); this.r = new Float32Array(this.size);
        this.onMessage = (e) => {
            if (e.data === 'start') { this.rec = true; this.fill = 0; }
            if (e.data === 'stop') { this.flush(true); this.rec = false; }
        };
    }
    flush(done = false) {
        const l = this.l.slice(0, this.fill), r = this.r.slice(0, this.fill);
        this.port.postMessage({ l, r, done }, [l.buffer, r.buffer]);
        this.fill = 0;
    }
    process(inputs, outputs) {
        if (!this.alive) return false;
        const inp = inputs[0], out = outputs[0];
        const L = inp && inp[0], R = inp && (inp[1] || inp[0]);
        const n = out[0] ? out[0].length : 128;
        for (let c = 0; c < out.length; c++) { const src = c === 0 ? L : R; if (src) out[c].set(src); else out[c].fill(0); }
        if (this.rec) {
            for (let i = 0; i < n; i++) {
                this.l[this.fill] = L ? L[i] : 0;
                this.r[this.fill] = R ? R[i] : 0;
                if (++this.fill === this.size) this.flush();
            }
        }
        return true;
    }
}

// --- Slew limiter + trigger delay ---
// Input 0: CV to slew. Input 1: gate to delay.
// Out 0: slewed CV, 1: delayed gate, 2: high while rising, 3: high while falling.
class SlewProcessor extends Base {
    static get parameterDescriptors() {
        return [
            { name: 'rise', defaultValue: 0.1, minValue: 0, maxValue: 30, automationRate: 'a-rate' },
            { name: 'fall', defaultValue: 0.1, minValue: 0, maxValue: 30, automationRate: 'a-rate' },
            { name: 'shape', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' }, // 0 linear, 1 exponential
            { name: 'delay', defaultValue: 0.1, minValue: 0, maxValue: 10, automationRate: 'a-rate' },
            { name: 'length', defaultValue: 0.01, minValue: 0.001, maxValue: 5, automationRate: 'k-rate' },
            { name: 'follow', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' }, // 1: delay both edges of the gate
        ];
    }
    constructor() { super(); this.y = 0; this.g = new GateDetector(); this.t = 0; this.events = []; this.offAt = -1; this.high = false; this.gap = 0; }
    process(inputs, outputs, params) {
        if (!this.alive) return false;
        const o = outputs.map((x) => x && x[0]);
        const n = (o.find(Boolean) || []).length;
        if (!n) return true;
        const cv = inputs[0] && inputs[0][0], gate = inputs[1] && inputs[1][0];
        const P = (p, i) => (p.length > 1 ? p[i] : p[0]);
        const exp = params.shape[0] > 0.5, follow = params.follow[0] > 0.5, len = params.length[0] * sampleRate;
        for (let i = 0; i < n; i++) {
            // --- slew: linear moves 1 unit per Rise/Fall time; exponential reaches 99% in that time
            const x = cv ? cv[i] : 0, d = x - this.y;
            const t = d > 0 ? P(params.rise, i) : P(params.fall, i);
            if (t <= 0) this.y = x;
            else if (exp) this.y += d * (1 - Math.exp(-4.6 / (t * sampleRate)));
            else { const step = 1 / (t * sampleRate); this.y += d > 0 ? Math.min(d, step) : Math.max(d, -step); }
            if (o[0]) o[0][i] = this.y;
            if (o[2]) o[2][i] = d > 1e-4 ? 1 : 0;
            if (o[3]) o[3][i] = d < -1e-4 ? 1 : 0;
            // --- trigger delay
            this.t++;
            const was = this.g.high;
            const rise = gate ? this.g.step(gate[i]) : false;
            const fell = was && !this.g.high;
            const dl = Math.max(0, P(params.delay, i)) * sampleRate;
            if (this.events.length < 512) {
                if (rise) this.events.push([this.t + dl, 1]);
                if (fell && follow) this.events.push([this.t + dl, 0]);
            }
            while (this.events.length && this.events[0][0] <= this.t) {
                const [, on] = this.events.shift();
                if (on) { if (this.high || this.t < this.offAt) this.gap = 24; this.high = true; this.offAt = follow ? Infinity : this.t + len; }
                else { this.high = false; this.offAt = -1; }
            }
            if (this.high && this.t >= this.offAt) this.high = false;
            let gv = this.high ? 1 : 0;
            if (this.gap > 0) { this.gap--; gv = 0; }
            if (o[1]) o[1][i] = gv;
        }
        return true;
    }
}

// --- Transient shaper: attack and sustain gain, each with its own threshold (stereo-linked) ---
class TransientProcessor extends Base {
    static get parameterDescriptors() {
        return [
            { name: 'attack', defaultValue: 0, minValue: -1, maxValue: 1, automationRate: 'k-rate' },
            { name: 'attackTh', defaultValue: -40, minValue: -80, maxValue: 0, automationRate: 'k-rate' },
            { name: 'release', defaultValue: 0, minValue: -1, maxValue: 1, automationRate: 'k-rate' },
            { name: 'releaseTh', defaultValue: -40, minValue: -80, maxValue: 0, automationRate: 'k-rate' },
            { name: 'speed', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
        ];
    }
    constructor() {
        super();
        this.fa = 0; this.sa = 0; this.fr = 0; this.sr = 0; this.g = 1;
        this.blocks = 0; this.att = 0; this.rel = 0;
    }
    process(inputs, outputs, params) {
        if (!this.alive) return false;
        const inp = inputs[0], out = outputs[0];
        if (!inp || !inp.length) { for (const c of out) c.fill(0); return true; }
        const n = out[0].length;
        const coef = (ms) => 1 - Math.exp(-1 / (ms * 0.001 * sampleRate));
        const sp = params.speed[0]; // longer windows when slower
        const fastA = coef(0.3), slowA = coef(4 + 40 * sp), rel = coef(40 + 160 * sp);
        const fastR = coef(15 + 60 * sp), slowR = coef(150 + 900 * sp), atk = coef(0.3);
        const A = params.attack[0], R = params.release[0], aTh = params.attackTh[0], rTh = params.releaseTh[0];
        const gSmooth = coef(1);
        const db = (v) => 20 * Math.log10(v + 1e-9);
        let am = 0, rm = 0;
        for (let i = 0; i < n; i++) {
            let x = 0;
            for (let c = 0; c < inp.length; c++) x = Math.max(x, Math.abs(inp[c][i]));
            // attack detector: same release, different attack speeds
            this.fa += (x - this.fa) * (x > this.fa ? fastA : rel);
            this.sa += (x - this.sa) * (x > this.sa ? slowA : rel);
            // sustain detector: same attack, different release speeds
            this.fr += (x - this.fr) * (x > this.fr ? atk : fastR);
            this.sr += (x - this.sr) * (x > this.sr ? atk : slowR);
            const lvl = db(this.fa);
            // Each section only works on signal above its own threshold (6 dB soft knee).
            const wA = Math.min(1, Math.max(0, (lvl - aTh) / 6 + 0.5));
            const wR = Math.min(1, Math.max(0, (db(this.sr) - rTh) / 6 + 0.5));
            const tA = Math.max(0, db(this.fa) - db(this.sa));
            const tR = Math.max(0, db(this.sr) - db(this.fr));
            let gdb = A * Math.min(24, tA * 1.5) * wA + R * Math.min(24, tR * 1.2) * wR;
            gdb = Math.max(-30, Math.min(24, gdb));
            const target = Math.pow(10, gdb / 20);
            this.g += (target - this.g) * gSmooth;
            for (let c = 0; c < out.length; c++) out[c][i] = (inp[c] || inp[0])[i] * this.g;
            am = Math.max(am, A * tA * wA); rm = Math.max(rm, R * tR * wR);
        }
        this.att = Math.max(am, this.att * 0.7); this.rel = Math.max(rm, this.rel * 0.7);
        if (++this.blocks >= 8) { this.blocks = 0; this.port.postMessage({ a: this.att, r: this.rel, g: 20 * Math.log10(this.g) }); }
        return true;
    }
}

// --- Drum voice: all synthesis on the audio thread, sample-accurate triggering ---
// Inputs: 0 trigger, 1 accent CV, 2 pitch CV (1V/oct), 3 decay CV (octaves). One mono output.
class SVF { // Simper/Cytomic state-variable filter
    constructor() { this.ic1 = 0; this.ic2 = 0; this.set(1000, 0.7); }
    set(f, q) { const g = Math.tan(Math.PI * Math.min(f, sampleRate * 0.45) / sampleRate), k = 1 / Math.max(0.05, q); this.a1 = 1 / (1 + g * (g + k)); this.a2 = g * this.a1; this.a3 = g * this.a2; this.k = k; }
    tick(v0) {
        const v3 = v0 - this.ic2, v1 = this.a1 * this.ic1 + this.a2 * v3, v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
        this.ic1 = 2 * v1 - this.ic1; this.ic2 = 2 * v2 - this.ic2;
        this.lp = v2; this.bp = v1; this.hp = v0 - this.k * v1 - v2;
        return this;
    }
}
const VOICES = ['kick', 'snare', 'chh', 'ohh', 'clap', 'tom', 'rim', 'cowbell', 'cymbal', 'conga', 'shaker', 'zap'];
const HAT_RATIOS = [205.3, 304.4, 369.6, 522.7, 540, 800];
// Per-voice gain so every voice peaks near 1.0 at default settings.
const VOICE_LEVEL = { kick: 0.74, snare: 0.82, chh: 1.95, ohh: 1.2, clap: 0.83, tom: 0.95, rim: 0.68, cowbell: 0.34, cymbal: 1.2, conga: 0.78, shaker: 0.66, zap: 1 };
class DrumProcessor extends Base {
    static get parameterDescriptors() {
        const k = (name, def, min, max) => ({ name, defaultValue: def, minValue: min, maxValue: max, automationRate: 'k-rate' });
        return [k('voice', 0, 0, VOICES.length - 1), k('tune', 0, -48, 48), k('decay', 1, 0.05, 8), k('tone', 0.5, 0, 1),
            k('snap', 0.5, 0, 1), k('sweep', 0.5, 0, 1), k('drive', 0, 0, 1), k('accent', 0.5, 0, 1)];
    }
    constructor() {
        super();
        this.voices = []; // { kind, t, vel, pm, D, tone, snap, sweep, ph:[], f:[...], fade }
        this.g = new GateDetector();
        this.seed = 0x12345678;
        this.dc = 0; this.dcy = 0;
        this.onMessage = (e) => { if (e.data && e.data.hit) this.manual = e.data.hit; };
    }
    noise() { let x = this.seed; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.seed = x >>> 0; return (this.seed / 4294967296) * 2 - 1; }
    start(P, vel, pitchCv, decayCv) {
        const kind = VOICES[Math.round(P.voice)] || 'kick';
        const v = {
            kind, t: 0, vel, pm: Math.pow(2, (P.tune + pitchCv * 12) / 12), D: P.decay * Math.pow(2, decayCv),
            tone: P.tone, snap: P.snap, sweep: P.sweep, ph: [0, 0, 0, 0, 0, 0], f1: new SVF(), f2: new SVF(), fade: 1, fading: 0,
        };
        // Choke: closed hats cut open hats and cymbals; any new hit fades same-kind tails quickly (no clicks).
        for (const o of this.voices) {
            if (kind === 'chh' && (o.kind === 'ohh' || o.kind === 'cymbal')) o.fading = 0.003;
            // Like a drum machine, each voice is monophonic: a re-trigger fades out its own previous hit.
            if (o.kind === kind && !o.fading) o.fading = 0.004;
        }
        if (this.voices.length >= 8) this.voices.shift();
        this.voices.push(v);
        this.port.postMessage(1);
    }
    render(v) {
        const sr = sampleRate, t = v.t / sr, D = v.D, pm = v.pm, T = v.tone, S = v.snap, W = v.sweep;
        const e = (tau) => Math.exp(-t / Math.max(1e-4, tau));
        const osc = (i, f, shape = 'sin') => {
            v.ph[i] += f / sr; v.ph[i] -= Math.floor(v.ph[i]);
            const p = v.ph[i];
            if (shape === 'sq') return p < 0.5 ? 1 : -1;
            if (shape === 'tri') return 4 * Math.abs(p - 0.5) - 1;
            return Math.sin(2 * Math.PI * p);
        };
        const atk = Math.min(1, t / 0.0005); // 0.5 ms anti-click attack
        let y = 0, done = false;
        switch (v.kind) {
            case 'kick': {
                const base = 48 * pm, f = base * (1 + W * 7 * e(0.008 + 0.05 * (1 - T)));
                const amp = e(0.32 * D); y = osc(0, f) * amp;
                if (t < 0.03) { v.f1.set(2500 + 6000 * T, 0.7); y += v.f1.tick(this.noise()).hp * e(0.0025) * S * 0.9; }
                y *= 1.1; done = amp < 1e-4; break;
            }
            case 'snare': {
                const tones = (osc(0, 185 * pm * (1 + W * 0.5 * e(0.01)), 'tri') + osc(1, 330 * pm * (1 + W * 0.5 * e(0.01)), 'tri') * 0.6) * e(0.07 * D) * (1 - S * 0.5);
                v.f1.set(1500 + 5000 * T, 0.6);
                const nz = v.f1.tick(this.noise()).hp * e(0.13 * D) * (0.35 + S);
                y = (tones * 0.7 + nz * 0.8); done = t > 0.13 * D * 9.2; break;
            }
            case 'chh': case 'ohh': case 'cymbal': {
                const tau = v.kind === 'chh' ? 0.016 : v.kind === 'ohh' ? 0.16 : 0.9;
                const fm = pm * (1.25 + T * 0.75) * (v.kind === 'cymbal' ? 0.8 : 1);
                let m = 0; for (let k = 0; k < 6; k++) m += osc(k, HAT_RATIOS[k] * fm, 'sq');
                m = m / 6 + this.noise() * S * 0.8;
                v.f1.set(v.kind === 'cymbal' ? 6500 : 9500, 0.9); v.f2.set(v.kind === 'cymbal' ? 4500 : 7000, 0.7);
                const amp = e(tau * D) * (v.kind === 'cymbal' ? 0.8 + 0.2 * e(0.02) : 1);
                y = v.f2.tick(v.f1.tick(m).bp).hp * amp * 2.2; done = amp < 1e-4; break;
            }
            case 'clap': {
                v.f1.set(1100 * (1 + T * 1.5), 1.6);
                const n = v.f1.tick(this.noise()).bp;
                let env = 0;
                for (const k of [0, 0.010, 0.021]) if (t >= k && t < 0.032) env = Math.max(env, Math.exp(-(t - k) / 0.0035));
                if (t >= 0.031) env = Math.max(env, (0.45 + 0.55 * S) * Math.exp(-(t - 0.031) / (0.11 * D)));
                y = n * env * 2.4; done = t > 0.031 + 0.11 * D * 9.2; break;
            }
            case 'tom': case 'conga': {
                const conga = v.kind === 'conga';
                const base = (conga ? 210 : 105) * pm * (1 + T);
                const f = base * (1 + W * (conga ? 0.25 : 0.7) * e(conga ? 0.015 : 0.04));
                const amp = e((conga ? 0.11 : 0.2) * D);
                y = (osc(0, f) + (conga ? 0.25 * osc(1, f * 1.5) : 0)) * amp;
                if (t < 0.02) { v.f1.set(3000, 0.7); y += v.f1.tick(this.noise()).lp * e(0.004) * S * 0.6; }
                done = amp < 1e-4; break;
            }
            case 'rim': {
                v.f1.set(4200, 2.5);
                y = osc(0, 1700 * pm * (0.8 + T * 0.4), 'tri') * e(0.011 * D) + v.f1.tick(this.noise()).bp * e(0.004) * S * 1.2;
                done = t > 0.011 * D * 9.2 + 0.03; break;
            }
            case 'cowbell': {
                v.f1.set(2640 * (0.6 + T * 0.8), 3);
                const m = (osc(0, 540 * pm, 'sq') + osc(1, 800 * pm, 'sq')) * 0.5;
                const amp = 0.65 * e(0.012) + 0.35 * e(0.14 * D);
                y = v.f1.tick(m).bp * amp * 2.2; done = amp < 1e-4; break;
            }
            case 'shaker': {
                const a = Math.min(1, t / (0.004 + 0.02 * S));
                v.f1.set(5000 + 4000 * T, 1.2);
                const amp = a * e(0.05 * D);
                y = v.f1.tick(this.noise()).hp * amp * 1.4; done = t > 0.03 && amp < 1e-4; break;
            }
            case 'zap': {
                const f = (60 + 3000 * W * e(0.01 + 0.04 * (1 - T))) * pm;
                const amp = e(0.12 * D);
                y = osc(0, f) * amp; done = amp < 1e-4; break;
            }
        }
        if (v.fading) { v.fade -= 1 / (v.fading * sr); if (v.fade <= 0) done = true; }
        v.t++;
        if (v.t > sr * 20) done = true;
        return { y: y * atk * v.vel * Math.max(0, v.fade) * (VOICE_LEVEL[v.kind] || 1), done };
    }
    process(inputs, outputs, params) {
        if (!this.alive) return false;
        const out = outputs[0][0];
        if (!out) return true;
        const trig = inputs[0] && inputs[0][0], acc = inputs[1] && inputs[1][0], pcv = inputs[2] && inputs[2][0], dcv = inputs[3] && inputs[3][0];
        const P = {};
        for (const k of ['voice', 'tune', 'decay', 'tone', 'snap', 'sweep', 'drive', 'accent']) P[k] = params[k][0];
        const drive = P.drive, dk = 1 + drive * 14, dn = Math.tanh(dk);
        const dcC = 1 - Math.exp(-2 * Math.PI * 10 / sampleRate);
        for (let i = 0; i < out.length; i++) {
            const hit = (trig && this.g.step(trig[i])) || (i === 0 && this.manual);
            if (hit) {
                const vel = Math.max(0.05, Math.min(2, (i === 0 && this.manual ? this.manual : 1) * (1 + (acc ? acc[i] : 0) * (0.25 + P.accent * 1.5))));
                this.start(P, vel, pcv ? pcv[i] : 0, dcv ? dcv[i] : 0);
                if (i === 0) this.manual = 0;
            }
            let y = 0;
            for (let k = this.voices.length - 1; k >= 0; k--) {
                const r = this.render(this.voices[k]);
                y += r.y;
                if (r.done) this.voices.splice(k, 1);
            }
            if (drive > 0.001) y = Math.tanh(y * dk) / dn;
            // DC blocker
            this.dc += (y - this.dc) * dcC;
            const o = y - this.dc;
            out[i] = Number.isFinite(o) ? o : 0;
            if (!Number.isFinite(this.dc)) this.dc = 0;
        }
        return true;
    }
}

// --- Drum sampler: sample-accurate one-shot playback with drum-style shaping ---
// Inputs: 0 trigger, 1 accent CV, 2 pitch CV (1V/oct). Stereo output.
// Choke groups are shared by every drum sampler in the same AudioContext.
const chokeGroups = new Map(); // group number -> Set(processors)
class DrumSamplerProcessor extends Base {
    static get parameterDescriptors() {
        const k = (name, def, min, max) => ({ name, defaultValue: def, minValue: min, maxValue: max, automationRate: 'k-rate' });
        return [k('tune', 0, -48, 48), k('decay', 10, 0.005, 10), k('attack', 0, 0, 0.1), k('start', 0, 0, 0.95), k('reverse', 0, 0, 1),
            k('tone', 0, -1, 1), k('drive', 0, 0, 1), k('pan', 0, -1, 1), k('velocity', 0.5, 0, 1), k('mono', 1, 0, 1), k('choke', 0, 0, 8)];
    }
    constructor() {
        super();
        this.data = null; this.len = 0;
        this.voices = [];
        this.g = new GateDetector();
        this.lp = [new SVF(), new SVF()]; this.hp = [new SVF(), new SVF()];
        this.group = 0;
        this.onMessage = (e) => {
            const d = e.data;
            if (d.sample !== undefined) { this.data = d.sample; this.len = d.sample ? d.sample[0].length : 0; this.voices = []; }
            if (d.hit) this.manual = d.hit;
        };
    }
    setGroup(n) {
        if (n === this.group) return;
        if (this.group) chokeGroups.get(this.group)?.delete(this);
        this.group = n;
        if (n) { if (!chokeGroups.has(n)) chokeGroups.set(n, new Set()); chokeGroups.get(n).add(this); }
    }
    choke() { for (const v of this.voices) if (!v.fading) { v.fading = true; v.fade = 1; } }
    start(P, vel, pitchCv) {
        if (!this.data || !this.len) return;
        if (this.group) for (const p of chokeGroups.get(this.group) || []) if (p !== this) p.choke();
        if (P.mono > 0.5) this.choke(); else if (this.voices.length >= 16) this.voices.shift();
        const rate = Math.pow(2, (P.tune + pitchCv * 12) / 12);
        const rev = P.reverse > 0.5;
        const startPos = P.start * this.len;
        this.voices.push({ pos: rev ? Math.max(0, this.len - 2 - startPos) : startPos, step: rev ? -rate : rate, t: 0, vel, fade: 1, fading: false });
        this.port.postMessage(1);
    }
    process(inputs, outputs, params) {
        if (!this.alive) { this.setGroup(0); return false; }
        const out = outputs[0];
        const L = out[0], R = out[1] || out[0], n = L.length;
        const trig = inputs[0] && inputs[0][0], acc = inputs[1] && inputs[1][0], pcv = inputs[2] && inputs[2][0];
        const P = {};
        for (const k of ['tune', 'decay', 'attack', 'start', 'reverse', 'tone', 'drive', 'pan', 'velocity', 'mono', 'choke']) P[k] = params[k][0];
        this.setGroup(Math.round(P.choke));
        // Tone: below 0 sweeps a low-pass down, above 0 sweeps a high-pass up.
        const lpF = P.tone < 0 ? 20000 * Math.pow(150 / 20000, -P.tone) : 20000, hpF = P.tone > 0 ? 20 * Math.pow(4000 / 20, P.tone) : 0;
        for (const f of this.lp) f.set(lpF, 0.707);
        for (const f of this.hp) f.set(Math.max(20, hpF), 0.707);
        const natural = P.decay >= 9.99, dCoef = natural ? 1 : Math.exp(-1 / (P.decay * sampleRate));
        const att = Math.max(1, P.attack * sampleRate + 0.0005 * sampleRate); // always ≥ 0.5 ms: no clicks
        const fadeStep = 1 / (0.003 * sampleRate);
        const dk = 1 + P.drive * 10, dn = Math.tanh(dk);
        const pl = Math.cos((P.pan + 1) * Math.PI / 4), pr = Math.sin((P.pan + 1) * Math.PI / 4);
        const chs = this.data ? this.data.length : 0;
        for (let i = 0; i < n; i++) {
            const hit = (trig && this.g.step(trig[i])) || (i === 0 && this.manual);
            if (hit) {
                const base = i === 0 && this.manual ? this.manual : 1;
                this.start(P, Math.max(0.05, Math.min(2, base * (1 + (acc ? acc[i] : 0) * (0.25 + P.velocity * 1.5)))), pcv ? pcv[i] : 0);
                if (i === 0) this.manual = 0;
            }
            let yl = 0, yr = 0;
            for (let k = this.voices.length - 1; k >= 0; k--) {
                const v = this.voices[k];
                const p = v.pos, i0 = Math.floor(p);
                if (i0 < 0 || i0 >= this.len - 1 || (v.fading && v.fade <= 0)) { this.voices.splice(k, 1); continue; }
                // Cubic (Hermite) interpolation for clean pitch shifting
                const f = p - i0;
                const s = (c) => {
                    const d = this.data[c];
                    const xm = d[Math.max(0, i0 - 1)], x0 = d[i0], x1 = d[i0 + 1], x2 = d[Math.min(this.len - 1, i0 + 2)];
                    const c1 = 0.5 * (x1 - xm), c2 = xm - 2.5 * x0 + 2 * x1 - 0.5 * x2, c3 = 0.5 * (x2 - xm) + 1.5 * (x0 - x1);
                    return ((c3 * f + c2) * f + c1) * f + x0;
                };
                let amp = v.vel * Math.min(1, (v.t + 1) / att);
                if (!natural) { v.env = (v.env ?? 1) * dCoef; amp *= v.env; if (v.env < 1e-4) { this.voices.splice(k, 1); continue; } }
                if (v.fading) { v.fade -= fadeStep; amp *= Math.max(0, v.fade); }
                const a = s(0), b = chs > 1 ? s(1) : a;
                yl += a * amp; yr += b * amp;
                v.pos += v.step; v.t++;
            }
            if (hpF > 0) { yl = this.hp[0].tick(yl).hp; yr = this.hp[1].tick(yr).hp; }
            if (lpF < 19999) { yl = this.lp[0].tick(yl).lp; yr = this.lp[1].tick(yr).lp; }
            if (P.drive > 0.001) { yl = Math.tanh(yl * dk) / dn; yr = Math.tanh(yr * dk) / dn; }
            L[i] = Number.isFinite(yl) ? yl * pl * 1.4142 : 0;
            if (R !== L) R[i] = Number.isFinite(yr) ? yr * pr * 1.4142 : 0;
        }
        return true;
    }
}

registerProcessor('ma-drumsampler', DrumSamplerProcessor);
registerProcessor('ma-slew', SlewProcessor);
registerProcessor('ma-transient', TransientProcessor);
registerProcessor('ma-drum', DrumProcessor);
registerProcessor('ma-recorder', RecorderProcessor);
registerProcessor('ma-clockmod', ClockModProcessor);
registerProcessor('ma-euclid', EuclidProcessor);
registerProcessor('ma-probgate', ProbGateProcessor);
registerProcessor('ma-trigdelay', TrigDelayProcessor);
registerProcessor('ma-logic', LogicProcessor);
registerProcessor('ma-comparator', ComparatorProcessor);
registerProcessor('ma-math', MathProcessor);
registerProcessor('ma-follower', FollowerProcessor);
registerProcessor('ma-clockquant', ClockQuantProcessor);
registerProcessor('ma-edge', EdgeProcessor);
registerProcessor('ma-crush', CrushProcessor);
registerProcessor('ma-lfo', LfoProcessor);
registerProcessor('ma-adsr', AdsrProcessor);
registerProcessor('ma-clock', ClockProcessor);
registerProcessor('ma-sequencer', SequencerProcessor);
