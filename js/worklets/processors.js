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
