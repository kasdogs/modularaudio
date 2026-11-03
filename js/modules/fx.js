// Effects ported from the earlier prototype, rebuilt on the shared module system:
// Chorus, Flanger, Phaser, Tremolo, Vibrato, Conv Reverb, Compressor, Tilt EQ,
// Bitcrusher, Ring Mod, Waveshaper, Clipper, Wavefolder.
import { registerModule } from '../patch.js';
import { el, formatFrequency, formatTime, formatPercent, formatDb, dbToGain, setMeter, toast, cssVar } from '../util.js';

const ms = (v) => `${(v * 1000).toFixed(v < 0.01 ? 2 : 1)} ms`;
const times = (v) => `×${v.toFixed(2)}`;

// Equal-power dry/wet: input -> dry -> output, wetIn -> wet -> output.
function mixStage(ctx) {
    const input = ctx.createGain(), output = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain();
    input.connect(dry).connect(output);
    wet.connect(output);
    return {
        input, output, wetIn: wet,
        set(m, v) { m.set(wet.gain, Math.sin(v * Math.PI / 2)); m.set(dry.gain, Math.cos(v * Math.PI / 2)); },
    };
}
function lfo(ctx, type = 'sine') {
    const o = ctx.createOscillator();
    o.type = type;
    o.start();
    const rateCv = ctx.createGain(); rateCv.gain.value = 1200; // 1 unit = 1 octave faster
    rateCv.connect(o.detune);
    return { osc: o, rateCv };
}
const rateParam = (min, max, def) => ({ label: 'Rate', min, max, curve: 'log', default: def, format: formatFrequency, unit: 'Hz' });
const mixParam = (def) => ({ label: 'Mix', min: 0, max: 1, default: def, format: formatPercent, unit: 'ratio' });

registerModule({
    type: 'chorus', title: 'Chorus', category: 'Effects', blurb: 'Stereo modulated delay',
    params: {
        rate: rateParam(0.05, 10, 0.6),
        depth: { label: 'Depth', min: 0.0002, max: 0.01, curve: 2, default: 0.004, format: ms, unit: 's' },
        feedback: { label: 'Feedback', min: 0, max: 0.9, default: 0.15, format: formatPercent, unit: 'ratio' },
        mix: mixParam(0.5),
    },
    create(m, ctx) {
        const mx = mixStage(ctx);
        const { osc, rateCv } = lfo(ctx);
        const merger = ctx.createChannelMerger(2);
        const depthCv = ctx.createGain(); depthCv.gain.value = 0.005;
        const sides = [1, -1].map((sign, ch) => {
            const d = ctx.createDelay(0.1), g = ctx.createGain(), fb = ctx.createGain();
            mx.input.connect(d);
            osc.connect(g).connect(d.delayTime);
            depthCv.connect(d.delayTime);
            d.connect(fb).connect(d);
            d.connect(merger, 0, ch);
            return { d, g, fb, sign };
        });
        merger.connect(mx.wetIn);
        ['rate', 'depth', 'feedback', 'mix'].forEach((k) => m.slider(k));
        m.addInput('in', 'In', 'audio', mx.input);
        m.addInput('rate', 'Rate', 'cv', rateCv);
        m.addInput('depth', 'Depth', 'cv', depthCv);
        m.addOutput('out', 'Out', 'audio', mx.output);
        return {
            update(key, v) {
                if (key === 'rate') m.set(osc.frequency, v);
                if (key === 'depth') sides.forEach((s) => { m.set(s.g.gain, v * s.sign); m.set(s.d.delayTime, 0.008 + v * 1.2, 0.05); });
                if (key === 'feedback') sides.forEach((s) => m.set(s.fb.gain, v));
                if (key === 'mix') mx.set(m, v);
            },
            dispose() { try { osc.stop(); } catch (e) {} },
        };
    },
});

registerModule({
    type: 'flanger', title: 'Flanger', category: 'Effects', blurb: 'Short swept delay with feedback',
    params: {
        rate: rateParam(0.02, 5, 0.25),
        depth: { label: 'Depth', min: 0.0001, max: 0.01, curve: 2, default: 0.002, format: ms, unit: 's' },
        delay: { label: 'Delay', min: 0.0005, max: 0.015, curve: 2, default: 0.003, format: ms, unit: 's' },
        feedback: { label: 'Feedback', min: -0.95, max: 0.95, default: 0.6, format: formatPercent, unit: 'ratio' },
        mix: mixParam(0.5),
    },
    create(m, ctx) {
        const mx = mixStage(ctx);
        const { osc, rateCv } = lfo(ctx, 'triangle');
        const sum = ctx.createGain(), d = ctx.createDelay(0.1), depth = ctx.createGain(), fb = ctx.createGain();
        const delayCv = ctx.createGain(); delayCv.gain.value = 0.002;
        mx.input.connect(sum).connect(d).connect(mx.wetIn);
        d.connect(fb).connect(sum);
        osc.connect(depth).connect(d.delayTime);
        delayCv.connect(d.delayTime);
        ['rate', 'depth', 'delay', 'feedback', 'mix'].forEach((k) => m.slider(k));
        m.addInput('in', 'In', 'audio', mx.input);
        m.addInput('rate', 'Rate', 'cv', rateCv);
        m.addInput('delay', 'Delay', 'cv', delayCv);
        m.addOutput('out', 'Out', 'audio', mx.output);
        // The sweep must never push the delay below zero.
        const base = () => m.set(d.delayTime, Math.max(m.params.delay, m.params.depth + 0.0003), 0.05);
        return {
            update(key, v) {
                if (key === 'rate') m.set(osc.frequency, v);
                if (key === 'depth') { m.set(depth.gain, v); base(); }
                if (key === 'delay') base();
                if (key === 'feedback') m.set(fb.gain, v);
                if (key === 'mix') mx.set(m, v);
            },
            dispose() { try { osc.stop(); } catch (e) {} },
        };
    },
});

registerModule({
    type: 'phaser', title: 'Phaser', category: 'Effects', blurb: 'Swept all-pass stages',
    params: {
        stages: { label: 'Stages', default: 6, options: [{ value: 4, label: '4 stages' }, { value: 6, label: '6 stages' }, { value: 8, label: '8 stages' }, { value: 12, label: '12 stages' }] },
        rate: rateParam(0.02, 10, 0.4),
        base: { label: 'Base Freq', min: 100, max: 5000, curve: 'log', default: 700, format: formatFrequency, unit: 'Hz' },
        depth: { label: 'Depth', min: 0, max: 4000, curve: 2, default: 600, format: formatFrequency, unit: 'Hz' },
        q: { label: 'Q', min: 0.1, max: 10, curve: 2, default: 0.7, format: (v) => v.toFixed(2) },
        feedback: { label: 'Feedback', min: 0, max: 0.9, default: 0.3, format: formatPercent, unit: 'ratio' },
        mix: mixParam(0.5),
    },
    create(m, ctx) {
        const mx = mixStage(ctx);
        const { osc, rateCv } = lfo(ctx);
        const sum = ctx.createGain(), depth = ctx.createGain(), fb = ctx.createGain();
        const baseCv = ctx.createGain(); baseCv.gain.value = 1200;
        mx.input.connect(sum);
        osc.connect(depth);
        let chain = [];
        const build = (n) => {
            chain.forEach((f) => { try { f.disconnect(); } catch (e) {} });
            try { sum.disconnect(); } catch (e) {}
            chain = Array.from({ length: n }, () => {
                const f = ctx.createBiquadFilter();
                f.type = 'allpass';
                f.frequency.value = m.params.base;
                f.Q.value = m.params.q;
                depth.connect(f.frequency);
                baseCv.connect(f.detune);
                return f;
            });
            let node = sum;
            for (const f of chain) { node.connect(f); node = f; }
            node.connect(mx.wetIn);
            node.connect(fb);
        };
        fb.connect(sum);
        m.select('stages');
        ['rate', 'base', 'depth', 'q', 'feedback', 'mix'].forEach((k) => m.slider(k));
        m.addInput('in', 'In', 'audio', mx.input);
        m.addInput('rate', 'Rate', 'cv', rateCv);
        m.addInput('base', 'Base', 'cv', baseCv);
        m.addOutput('out', 'Out', 'audio', mx.output);
        return {
            update(key, v) {
                if (key === 'stages') build(Number(v));
                if (key === 'rate') m.set(osc.frequency, v);
                if (key === 'base') chain.forEach((f) => m.set(f.frequency, v));
                if (key === 'depth') m.set(depth.gain, v);
                if (key === 'q') chain.forEach((f) => m.set(f.Q, v));
                if (key === 'feedback') m.set(fb.gain, v);
                if (key === 'mix') mx.set(m, v);
            },
            dispose() { try { osc.stop(); } catch (e) {} },
        };
    },
});

registerModule({
    type: 'tremolo', title: 'Tremolo', category: 'Effects', blurb: 'Rhythmic volume modulation',
    params: {
        rate: rateParam(0.1, 30, 5),
        depth: { label: 'Depth', min: 0, max: 1, default: 0.7, format: formatPercent, unit: 'ratio' },
        shape: { label: 'Shape', default: 'sine', options: [{ value: 'sine', label: 'Sine' }, { value: 'triangle', label: 'Triangle' }, { value: 'square', label: 'Square' }] },
    },
    create(m, ctx) {
        const vca = ctx.createGain(), depth = ctx.createGain();
        const depthCv = ctx.createGain(); depthCv.gain.value = 0.5;
        const { osc, rateCv } = lfo(ctx);
        osc.connect(depth).connect(vca.gain);
        depthCv.connect(depth.gain);
        m.slider('rate'); m.slider('depth'); m.select('shape');
        m.addInput('in', 'In', 'audio', vca);
        m.addInput('rate', 'Rate', 'cv', rateCv);
        m.addInput('depth', 'Depth', 'cv', depthCv);
        m.addOutput('out', 'Out', 'audio', vca);
        return {
            update(key, v) {
                if (key === 'rate') m.set(osc.frequency, v);
                if (key === 'depth') { m.set(depth.gain, v / 2); m.set(vca.gain, 1 - v / 2); }
                if (key === 'shape') osc.type = v;
            },
            dispose() { try { osc.stop(); } catch (e) {} },
        };
    },
});

registerModule({
    type: 'vibrato', title: 'Vibrato', category: 'Effects', blurb: 'Pitch wobble from a swept delay',
    params: {
        rate: rateParam(0.1, 20, 5),
        depth: { label: 'Depth', min: 0.0001, max: 0.01, curve: 2, default: 0.0015, format: ms, unit: 's' },
    },
    create(m, ctx) {
        const d = ctx.createDelay(0.1), depth = ctx.createGain();
        const depthCv = ctx.createGain(); depthCv.gain.value = 0.002;
        const { osc, rateCv } = lfo(ctx);
        osc.connect(depth).connect(d.delayTime);
        depthCv.connect(d.delayTime);
        m.slider('rate'); m.slider('depth');
        m.addInput('in', 'In', 'audio', d);
        m.addInput('rate', 'Rate', 'cv', rateCv);
        m.addInput('depth', 'Depth', 'cv', depthCv);
        m.addOutput('out', 'Out', 'audio', d);
        return {
            update(key, v) {
                if (key === 'rate') m.set(osc.frequency, v);
                if (key === 'depth') { m.set(depth.gain, v); m.set(d.delayTime, v + 0.0005, 0.05); }
            },
            dispose() { try { osc.stop(); } catch (e) {} },
        };
    },
});

// --- Convolution reverb: built-in spaces or your own impulse response file ---
function makeSpace(ctx, kind) {
    const spec = { room: [0.9, 0.35], hall: [3.8, 0.75], plate: [2.2, 0.15], cathedral: [7, 0.85] }[kind] || [2, 0.5];
    const [secs, dark] = spec;
    const len = Math.floor(ctx.sampleRate * secs);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
        const d = buf.getChannelData(c);
        let lp = 0;
        for (let i = 0; i < len; i++) {
            const t = i / len;
            // Darker spaces lose highs faster over time.
            const a = dark * t;
            lp = lp * a + (Math.random() * 2 - 1) * (1 - a);
            d[i] = lp * Math.exp(-t * 6.5) * (kind === 'plate' ? 1.4 : 1);
        }
    }
    return buf;
}

registerModule({
    type: 'convreverb', title: 'Conv Reverb', category: 'Effects', blurb: 'Convolution with built-in or loaded spaces',
    width: 210,
    params: {
        space: { label: 'Space', default: 'hall', options: [
            { value: 'room', label: 'Room' }, { value: 'plate', label: 'Plate' }, { value: 'hall', label: 'Hall' },
            { value: 'cathedral', label: 'Cathedral' }, { value: 'file', label: 'Loaded file' }] },
        predelay: { label: 'Pre-delay', min: 0, max: 0.5, curve: 2, default: 0.02, format: formatTime, unit: 's' },
        gain: { label: 'Wet Gain', min: 0, max: 2, default: 1, format: times },
        mix: mixParam(0.35),
        fileName: { default: '' },
    },
    create(m, ctx) {
        const mx = mixStage(ctx);
        const pre = ctx.createDelay(1), conv = ctx.createConvolver(), wet = ctx.createGain();
        mx.input.connect(pre).connect(conv).connect(wet).connect(mx.wetIn);
        let fileBuffer = null;
        const fileInput = el('input', { type: 'file', accept: 'audio/*,.wav,.aiff,.flac,.mp3,.ogg', style: { display: 'none' } });
        const loadBtn = el('button', { class: 'param-button', type: 'button', text: 'Load IR File…' });
        const info = el('div', { class: 'info-row' }, el('span', { class: 'node-label', text: '' }));
        m.select('space');
        m.content.append(el('div', { class: 'btn-row' }, loadBtn), info, fileInput);
        ['predelay', 'gain', 'mix'].forEach((k) => m.slider(k));
        loadBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
        loadBtn.addEventListener('click', () => fileInput.click());
        const showInfo = () => {
            const t = m.params.space !== 'file' ? 'Built-in space'
                : fileBuffer ? `${m.params.fileName} · ${fileBuffer.duration.toFixed(2)} s`
                : m.params.fileName ? `Reload “${m.params.fileName}”` : 'No file loaded';
            info.firstChild.textContent = t;
        };
        fileInput.addEventListener('change', async () => {
            const f = fileInput.files[0];
            fileInput.value = '';
            if (!f) return;
            try {
                fileBuffer = await ctx.decodeAudioData(await f.arrayBuffer());
                m.setParam('fileName', f.name, false);
                m.setParam('space', 'file');
            } catch (e) {
                toast(`Couldn’t read that audio file: ${e.message || e}`, 4000);
            }
        });
        m.addInput('in', 'In', 'audio', mx.input);
        m.addOutput('out', 'Out', 'audio', mx.output);
        return {
            update(key, v) {
                if (key === 'space') {
                    // Files aren't stored in presets, so a restored patch asks for the file again.
                    if (v === 'file') conv.buffer = fileBuffer;
                    else conv.buffer = makeSpace(ctx, v);
                    showInfo();
                }
                if (key === 'predelay') m.set(pre.delayTime, v, 0.05);
                if (key === 'gain') m.set(wet.gain, v);
                if (key === 'mix') mx.set(m, v);
                if (key === 'fileName') showInfo();
            },
        };
    },
});

registerModule({
    type: 'compressor', title: 'Compressor', category: 'Dynamics & EQ', blurb: 'Level control with gain-reduction meter',
    params: {
        threshold: { label: 'Threshold', min: -60, max: 0, default: -24, step: 0.1, format: formatDb, unit: 'dB' },
        ratio: { label: 'Ratio', min: 1, max: 20, curve: 2, default: 4, format: (v) => `${v.toFixed(1)}:1` },
        knee: { label: 'Knee', min: 0, max: 40, default: 6, format: (v) => `${v.toFixed(1)} dB` },
        attack: { label: 'Attack', min: 0.0005, max: 0.5, curve: 'log', default: 0.005, format: formatTime, unit: 's' },
        release: { label: 'Release', min: 0.01, max: 1, curve: 'log', default: 0.15, format: formatTime, unit: 's' },
        makeup: { label: 'Makeup', min: -12, max: 24, default: 0, step: 0.1, format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`, unit: 'dB' },
    },
    create(m, ctx) {
        const comp = ctx.createDynamicsCompressor(), makeup = ctx.createGain();
        comp.connect(makeup);
        const meter = el('div', { class: 'meter' }, el('div', { class: 'meter-fill plain' }));
        const readout = el('span', { class: 'node-label', text: '0.0 dB' });
        m.content.append(el('div', { class: 'info-row' }, el('span', { class: 'node-label', text: 'Gain reduction' }), readout), meter);
        ['threshold', 'ratio', 'knee', 'attack', 'release', 'makeup'].forEach((k) => m.slider(k));
        let f = 0;
        m.animate(() => {
            const r = -comp.reduction;
            setMeter(meter.firstChild, r / 24);
            if (++f % 6 === 0) readout.textContent = `${r.toFixed(1)} dB`;
        });
        m.addInput('in', 'In', 'audio', comp);
        m.addOutput('out', 'Out', 'audio', makeup);
        return {
            update(key, v) {
                if (key === 'makeup') m.set(makeup.gain, dbToGain(v));
                else m.set(comp[key], v);
            },
        };
    },
});

registerModule({
    type: 'tilteq', title: 'Tilt EQ', category: 'Dynamics & EQ', blurb: 'One control: darker or brighter',
    params: {
        tilt: { label: 'Tilt (−bass / +treble)', min: -1, max: 1, default: 0, format: (v) => `${v > 0 ? '+' : ''}${(v * 12).toFixed(1)} dB` },
        center: { label: 'Centre', min: 100, max: 5000, curve: 'log', default: 800, format: formatFrequency, unit: 'Hz' },
    },
    create(m, ctx) {
        const lo = ctx.createBiquadFilter(), hi = ctx.createBiquadFilter();
        lo.type = 'lowshelf'; hi.type = 'highshelf';
        lo.connect(hi);
        const cv = ctx.createGain(), cvHi = ctx.createGain(), cvLo = ctx.createGain();
        cvHi.gain.value = 12; cvLo.gain.value = -12; // 1 unit of CV = full tilt
        cv.connect(cvHi).connect(hi.gain);
        cv.connect(cvLo).connect(lo.gain);
        m.slider('tilt'); m.slider('center');
        m.addInput('in', 'In', 'audio', lo);
        m.addInput('tilt', 'Tilt', 'cv', cv);
        m.addOutput('out', 'Out', 'audio', hi);
        return {
            update(key, v) {
                if (key === 'tilt') { m.set(hi.gain, v * 12); m.set(lo.gain, -v * 12); }
                if (key === 'center') { m.set(lo.frequency, v); m.set(hi.frequency, v); }
            },
        };
    },
});

registerModule({
    type: 'bitcrusher', title: 'Bitcrusher', category: 'Distortion', blurb: 'Bit depth and sample-rate reduction',
    params: {
        bits: { label: 'Bit Depth', min: 1, max: 16, default: 8, format: (v) => `${v.toFixed(1)} bits` },
        reduce: { label: 'Rate Reduction', min: 1, max: 64, curve: 2, default: 1, format: (v) => `÷${v.toFixed(1)}` },
        mix: mixParam(1),
    },
    create(m, ctx) {
        const mx = mixStage(ctx);
        const node = m.worklet('ma-crush');
        const bitsCv = ctx.createGain(); bitsCv.gain.value = 4; // 1 unit = 4 bits
        bitsCv.connect(node.parameters.get('bits'));
        mx.input.connect(node).connect(mx.wetIn);
        ['bits', 'reduce', 'mix'].forEach((k) => m.slider(k));
        m.addInput('in', 'In', 'audio', mx.input);
        m.addInput('bits', 'Bits', 'cv', bitsCv);
        m.addOutput('out', 'Out', 'audio', mx.output);
        return {
            update(key, v) {
                if (key === 'bits') m.set(node.parameters.get('bits'), v, 0.005);
                if (key === 'reduce') node.parameters.get('reduce').value = v;
                if (key === 'mix') mx.set(m, v);
            },
        };
    },
});

registerModule({
    type: 'ringmod', title: 'Ring Mod', category: 'Distortion', blurb: 'Multiply by a carrier; patch your own',
    params: {
        freq: { label: 'Carrier Freq', min: 1, max: 5000, curve: 'log', default: 440, format: formatFrequency, unit: 'Hz' },
        wave: { label: 'Carrier Wave', default: 'sine', options: [{ value: 'sine', label: 'Sine' }, { value: 'triangle', label: 'Triangle' }, { value: 'square', label: 'Square' }, { value: 'sawtooth', label: 'Sawtooth' }] },
        mix: mixParam(1),
    },
    create(m, ctx) {
        const mx = mixStage(ctx);
        const ring = ctx.createGain(); ring.gain.value = 0;
        const osc = ctx.createOscillator(), internal = ctx.createGain(), ext = ctx.createGain();
        const freqCv = ctx.createGain(); freqCv.gain.value = 1200;
        osc.start();
        osc.connect(internal).connect(ring.gain);
        ext.connect(ring.gain);
        freqCv.connect(osc.detune);
        mx.input.connect(ring).connect(mx.wetIn);
        const note = el('div', { class: 'info-row' }, el('span', { class: 'node-label', text: 'Carrier: internal oscillator' }));
        m.slider('freq'); m.select('wave'); m.slider('mix');
        m.content.append(note);
        m.addInput('in', 'In', 'audio', mx.input);
        m.addInput('carrier', 'Carrier', 'audio', ext, {
            // A patched carrier replaces the internal oscillator.
            onConnect(n) {
                m.set(internal.gain, n > 0 ? 0 : 1, 0.005);
                note.firstChild.textContent = n > 0 ? 'Carrier: patched input' : 'Carrier: internal oscillator';
            },
        });
        m.addInput('freq', 'Freq', 'cv', freqCv);
        m.addOutput('out', 'Out', 'audio', mx.output);
        return {
            update(key, v) {
                if (key === 'freq') m.set(osc.frequency, v);
                if (key === 'wave') osc.type = v;
                if (key === 'mix') mx.set(m, v);
            },
            dispose() { try { osc.stop(); } catch (e) {} },
        };
    },
});

// --- Shaper family: Waveshaper, Clipper, Wavefolder ---
const spow = (x, p) => Math.sign(x) * Math.pow(Math.abs(x), p); // sign-safe power (no NaN for x < 0)
const SHAPES = {
    waveshaper: {
        tanh: ['Tanh Saturator', (x, k) => Math.tanh(x * k)],
        velvetFold: ['Velvet Fold', (x, k) => 1.2 * x - 0.8 * x ** 3 + 0.6 * x * Math.exp(-k / 5 * Math.abs(x))],
        soft: ['Soft Clip', (x, k) => Math.atan(x * k) * (2 / Math.PI)],
        warpedHarmonicNebula: ['Warped Harmonic Nebula', (x, k) => 0.8 * Math.sin(Math.PI * spow(x, k / 10)) + 0.2 * x ** 5],
        cosineBloom: ['Cosine Bloom Saturator', (x, k) => Math.sign(x) * (1 - Math.cos(Math.PI * Math.abs(x) ** (1 + k / 20)))],
        windowedSineFizz: ['Windowed Sine Fizz', (x, k) => (Math.abs(x) < 1 - k / 120 ? Math.sin(Math.PI * x) : (0.8 + k / 500) * Math.sign(x))],
        hard: ['Hard Clip', (x, k) => x * k],
        lofiPushPull: ['Lo-fi Push-Pull', (x, k) => (x >= 0 ? (0.9 + k / 100) * x - (0.1 + k / 100) * x ** 2 : (0.5 + k / 100) * x - (0.9 + k / 100) * x ** 3)],
        phaseFoldedRipple: ['Phase-Folded Ripple', (x, k) => (x - x ** 3) * Math.sin(k / 2 * Math.PI * x)],
    },
    clipper: {
        softArc: ['Soft Arc', (x, k) => Math.atan(x * k) / (Math.PI / 2)],
        softLimiter: ['Soft Limiter', (x, k) => (x * k) / (1 + Math.abs(x * k))],
        softSigmoid: ['Soft Sigmoid', (x, k) => 2 / (1 + Math.exp(-x * k)) - 1],
        hard: ['Hard Clip', (x, k) => x * k],
        softCubic: ['Soft Cubic', (x, k) => { const y = Math.max(-1, Math.min(1, x * k)); return 1.5 * (y - y ** 3 / 3); }],
        hard70: ['Hard 70% Clip', (x, k) => Math.max(-0.7, Math.min(0.7, x * k))],
        softLog: ['Soft Log', (x, k) => Math.sign(x) * Math.log1p(k * Math.abs(x)) / Math.log1p(k)],
        softAsinh: ['Soft Asinh', (x, k) => Math.asinh(x * k) / Math.asinh(k)],
        softExp: ['Soft Exp', (x, k) => Math.sign(x) * (1 - Math.exp(-Math.abs(x * k)))],
    },
    wavefolder: {
        triTriangle: ['Triple-Triangle Fold', (x, k) => { const y = 0.5 * k * (x + 1); return 2 * Math.abs(y - Math.floor(y + 0.5)) - 1; }],
        sineCascade: ['Sine Cascade Fold', (x, k) => (Math.sin(Math.PI * k * x) + Math.sin(2 * Math.PI * k * x) + Math.sin(4 * Math.PI * k * x)) / 3],
        tanhMirror: ['Symmetric Tanh Mirror', (x, k) => Math.tanh(k / 2 * Math.sin(Math.PI * 2 * x))],
        cosineEven: ['Even-Order Cosine Fold', (x, k) => Math.cos(Math.PI * k * x) * Math.sign(x)],
        windowBounce: ['Window-Bounce Fold', (x, k) => (Math.abs(x) < 0.4 ? x : 0.8 * Math.sin((Math.abs(x) - 0.4) * k * Math.PI) * Math.sign(x))],
        circular: ['Circular Fold', (x, k) => { const p = Math.PI * k * x; const den = 1 + Math.cos(p); return Math.abs(den) < 1e-6 ? Math.sign(x) : Math.sin(p) / den; }],
        sawMirror: ['Saw Mirror Fold', (x, k) => { const y = (k * x + 1) * 0.5; return 2 * Math.abs(y - Math.floor(y + 0.5)) - 1; }],
        diodeRing: ['Diode Ring Fold', (x, k) => { const d = x >= 0 ? (0.9 + k / 50) * x - (0.4 + k / 50) * x ** 2 : (0.6 + k / 50) * x - (1.2 + k / 50) * x ** 3; return 2 * Math.abs(d) - 1; }],
        stairFold: ['Stair-Step Folder', (x, k) => { const f = 2 * Math.abs(k * x / 2 - Math.floor(k * x / 2) - 0.5); return Math.round(f * 8) / 8 * Math.sign(x); }],
    },
};

function makeCurve(fn, k) {
    const n = 4096, c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const y = fn(i * 2 / (n - 1) - 1, k);
        c[i] = Number.isFinite(y) ? Math.max(-1, Math.min(1, y)) : 0;
    }
    return c;
}

function shaperModule(type, title, blurb, family, def, amount) {
    const shapes = SHAPES[family];
    registerModule({
        type, title, category: 'Distortion', blurb, width: 210,
        params: {
            curve: { label: 'Curve', default: def, options: Object.entries(shapes).map(([value, [label]]) => ({ value, label })) },
            drive: { label: 'Drive', min: 0.1, max: 10, curve: 'log', default: 1, format: times },
            amount: { label: 'Amount', min: amount[0], max: amount[1], curve: 2, default: amount[2], format: (v) => v.toFixed(2) },
            mix: mixParam(1),
            level: { label: 'Output', min: -24, max: 6, default: -3, step: 0.1, format: formatDb, unit: 'dB' },
        },
        create(m, ctx) {
            const mx = mixStage(ctx);
            const drive = ctx.createGain(), shaper = ctx.createWaveShaper(), dcBlock = ctx.createBiquadFilter(), out = ctx.createGain();
            shaper.oversample = '4x';
            // Some curves are asymmetric or map silence away from zero; strip the DC they leave behind.
            dcBlock.type = 'highpass'; dcBlock.frequency.value = 10; dcBlock.Q.value = 0.707;
            mx.input.connect(drive).connect(shaper).connect(dcBlock).connect(mx.wetIn);
            mx.output.connect(out);
            const driveCv = ctx.createGain(); driveCv.connect(drive.gain);
            const canvas = el('canvas', { class: 'display', width: 372, height: 140, style: { height: '70px' } });
            m.select('curve');
            m.content.append(canvas);
            ['drive', 'amount', 'mix', 'level'].forEach((k) => m.slider(k));
            const draw = () => {
                const g = canvas.getContext('2d'), W = canvas.width, H = canvas.height, c = shaper.curve;
                g.clearRect(0, 0, W, H);
                g.strokeStyle = cssVar('--display-grid').trim();
                g.lineWidth = 1;
                g.beginPath(); g.moveTo(W / 2, 0); g.lineTo(W / 2, H); g.moveTo(0, H / 2); g.lineTo(W, H / 2); g.stroke();
                if (!c) return;
                g.strokeStyle = cssVar('--display-line').trim();
                g.lineWidth = 3;
                g.beginPath();
                for (let x = 0; x < W; x++) {
                    const y = c[Math.round((x / (W - 1)) * (c.length - 1))];
                    const py = H / 2 - y * (H / 2 - 4);
                    if (x === 0) g.moveTo(x, py); else g.lineTo(x, py);
                }
                g.stroke();
            };
            const rebuild = () => {
                const fn = (shapes[m.params.curve] || shapes[def])[1];
                shaper.curve = makeCurve(fn, m.params.amount);
                draw();
            };
            m.addInput('in', 'In', 'audio', mx.input);
            m.addInput('drive', 'Drive', 'cv', driveCv);
            m.addOutput('out', 'Out', 'audio', out);
            return {
                update(key, v) {
                    if (key === 'curve' || key === 'amount') rebuild();
                    if (key === 'drive') m.set(drive.gain, v);
                    if (key === 'mix') mx.set(m, v);
                    if (key === 'level') m.set(out.gain, dbToGain(v));
                },
                refresh: draw,
            };
        },
    });
}

shaperModule('waveshaper', 'Waveshaper', 'Saturation and harmonic curves', 'waveshaper', 'tanh', [1, 100, 5]);
shaperModule('clipper', 'Clipper', 'Soft and hard clipping curves', 'clipper', 'softArc', [0.1, 10, 1]);
shaperModule('wavefolder', 'Wavefolder', 'Folds the wave back on itself', 'wavefolder', 'triTriangle', [0.1, 10, 3]);
