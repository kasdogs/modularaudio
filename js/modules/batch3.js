// Third batch ported from the earlier prototype: Sampler, FM Operator, clock and gate tools,
// Logic, Comparator, Math, Envelope Follower, DC Blocker, Stereo Utility, Tuner, Spectrum.
import { registerModule } from '../patch.js';
import { el, clamp, formatFrequency, formatTime, formatPercent, formatDb, dbToGain, setMeter, toast, nearestNote, freqToMidi, midiToName } from '../util.js';

const stop = (e) => e.stopPropagation();
const button = (text) => { const b = el('button', { class: 'param-button', type: 'button', text }); b.addEventListener('pointerdown', stop); return b; };
const led = () => el('span', { class: 'led' });
function blink(l, ms = 60) { l.classList.add('on'); clearTimeout(l._t); l._t = setTimeout(() => l.classList.remove('on'), ms); }
function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

// ---------------------------------------------------------------- Sampler
// Built-in one-shots so the module makes sound before any file is loaded.
function synthSample(ctx, kind) {
    const sr = ctx.sampleRate;
    const secs = { kick: 0.6, snare: 0.35, hat: 0.12, pluck: 1.2 }[kind] || 0.5;
    const n = Math.floor(sr * secs);
    const buf = ctx.createBuffer(1, n, sr);
    const d = buf.getChannelData(0);
    let ph = 0, lp = 0;
    const ks = kind === 'pluck' ? Array.from({ length: Math.floor(sr / 196) }, () => Math.random() * 2 - 1) : null;
    for (let i = 0; i < n; i++) {
        const t = i / sr;
        let v;
        if (kind === 'kick') { ph += (2 * Math.PI * (45 + 110 * Math.exp(-t * 30))) / sr; v = Math.sin(ph) * Math.exp(-t * 6); }
        else if (kind === 'snare') { ph += (2 * Math.PI * 185) / sr; v = (Math.sin(ph) * 0.5 * Math.exp(-t * 25)) + (Math.random() * 2 - 1) * 0.7 * Math.exp(-t * 14); }
        else if (kind === 'hat') { const w = Math.random() * 2 - 1; v = (w - lp) * Math.exp(-t * 45); lp = w; }
        else { const j = i % ks.length; v = ks[j]; ks[j] = 0.996 * 0.5 * (ks[j] + ks[(j + 1) % ks.length]); } // Karplus–Strong
        d[i] = v * 0.9;
    }
    return buf;
}

registerModule({
    type: 'sampler', title: 'Sampler', category: 'Sources', blurb: 'Plays a sample on each gate', width: 230,
    params: {
        source: { label: 'Sample', default: 'kick', options: [
            { value: 'kick', label: 'Kick (built-in)' }, { value: 'snare', label: 'Snare (built-in)' }, { value: 'hat', label: 'Hi-hat (built-in)' },
            { value: 'pluck', label: 'Pluck (built-in)' }, { value: 'file', label: 'Loaded file' }] },
        mode: { label: 'Playback', default: 'oneshot', options: [{ value: 'oneshot', label: 'One-shot' }, { value: 'gate', label: 'While gate is high' }, { value: 'loop', label: 'Loop while gate is high' }] },
        reverse: { label: 'Direction', default: 'fwd', options: [{ value: 'fwd', label: 'Forward' }, { value: 'rev', label: 'Reverse' }] },
        start: { label: 'Start', min: 0, max: 1, default: 0, format: formatPercent, unit: 'ratio' },
        end: { label: 'End', min: 0, max: 1, default: 1, format: formatPercent, unit: 'ratio' },
        tune: { label: 'Tune', min: -24, max: 24, default: 0, step: 0.01, format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)} st` },
        level: { label: 'Level', min: -60, max: 6, default: -3, step: 0.1, format: formatDb, unit: 'dB' },
        fileName: { default: '' },
    },
    create(m, ctx) {
        const out = ctx.createGain();
        const pitch = ctx.createGain(); pitch.gain.value = 1200;
        const pitchSum = ctx.createConstantSource(); pitchSum.offset.value = 1; pitchSum.start(); // ×tune gain = Tune in cents
        const tune = ctx.createGain(); tune.gain.value = 0;
        pitchSum.connect(tune);
        const edge = new AudioWorkletNode(ctx, 'ma-edge', { numberOfInputs: 1, numberOfOutputs: 0 });
        const manual = ctx.createConstantSource(); manual.offset.value = 0; manual.start(); manual.connect(edge);
        const fileIn = el('input', { type: 'file', accept: 'audio/*,.wav,.aiff,.flac,.mp3,.ogg', style: { display: 'none' } });
        const canvas = el('canvas', { class: 'display', width: 412, height: 120, style: { height: '60px' } });
        const info = el('span', { class: 'node-label', text: '' });
        const play = button('Play'), load = button('Load File…');
        m.select('source');
        m.content.append(canvas, el('div', { class: 'info-row' }, info), el('div', { class: 'btn-row' }, play, load), fileIn);
        m.select('mode'); m.select('reverse');
        ['start', 'end', 'tune', 'level'].forEach((k) => m.slider(k));
        const buffers = {};
        let fileBuf = null, revCache = new WeakMap(), voice = null;
        const current = () => (m.params.source === 'file' ? fileBuf : (buffers[m.params.source] ||= synthSample(ctx, m.params.source)));
        const reversed = (b) => {
            let r = revCache.get(b);
            if (!r) {
                r = ctx.createBuffer(b.numberOfChannels, b.length, b.sampleRate);
                for (let c = 0; c < b.numberOfChannels; c++) r.getChannelData(c).set(b.getChannelData(c).slice().reverse());
                revCache.set(b, r);
            }
            return r;
        };
        const draw = () => {
            const g = canvas.getContext('2d'), W = canvas.width, H = canvas.height, b = current();
            g.clearRect(0, 0, W, H);
            if (!b) { info.textContent = m.params.fileName ? `Reload “${m.params.fileName}”` : 'No file loaded'; return; }
            const d = b.getChannelData(0), step = d.length / W;
            g.fillStyle = css('--display-line');
            for (let x = 0; x < W; x++) {
                let pk = 0;
                for (let i = Math.floor(x * step); i < Math.floor((x + 1) * step); i++) pk = Math.max(pk, Math.abs(d[i] || 0));
                const h = Math.max(1, pk * (H - 4));
                g.fillRect(x, H / 2 - h / 2, 1, h);
            }
            const s = Math.min(m.params.start, m.params.end), e = Math.max(m.params.start, m.params.end);
            g.fillStyle = 'rgba(0,0,0,0.55)';
            g.fillRect(0, 0, s * W, H);
            g.fillRect(e * W, 0, W - e * W, H);
            info.textContent = m.params.source === 'file' ? `${m.params.fileName} · ${b.duration.toFixed(2)} s` : `${b.duration.toFixed(2)} s`;
        };
        const release = (t) => {
            if (!voice) return;
            const v = voice; voice = null;
            v.g.gain.setTargetAtTime(0, t, 0.01);
            try { v.src.stop(t + 0.08); } catch (e) {}
        };
        const trigger = (t = ctx.currentTime) => {
            const b0 = current();
            if (!b0) return;
            release(t);
            const b = m.params.reverse === 'rev' ? reversed(b0) : b0;
            let s = Math.min(m.params.start, m.params.end), e = Math.max(m.params.start, m.params.end);
            if (m.params.reverse === 'rev') [s, e] = [1 - e, 1 - s];
            const src = ctx.createBufferSource(), g = ctx.createGain();
            src.buffer = b;
            pitch.connect(src.detune);
            tune.connect(src.detune);
            src.connect(g).connect(out);
            const off = s * b.duration, dur = Math.max(0.005, (e - s) * b.duration);
            if (m.params.mode === 'loop') { src.loop = true; src.loopStart = off; src.loopEnd = off + dur; src.start(t, off); }
            else src.start(t, off, dur);
            voice = { src, g };
            src.onended = () => { try { src.disconnect(); g.disconnect(); } catch (e) {} if (voice && voice.src === src) voice = null; };
        };
        edge.port.onmessage = (e) => {
            const t = Math.max(ctx.currentTime, e.data.t);
            if (e.data.on) trigger(t);
            else if (m.params.mode !== 'oneshot') release(t);
        };
        play.addEventListener('pointerdown', () => m.set(manual.offset, 1, 0));
        const up = () => m.set(manual.offset, 0, 0);
        play.addEventListener('pointerup', up);
        play.addEventListener('pointercancel', up);
        load.addEventListener('click', () => fileIn.click());
        fileIn.addEventListener('change', async () => {
            const f = fileIn.files[0];
            fileIn.value = '';
            if (!f) return;
            try {
                fileBuf = await ctx.decodeAudioData(await f.arrayBuffer());
                m.setParam('fileName', f.name, false);
                m.setParam('end', 1, false);
                m.setParam('start', 0, false);
                m.setParam('source', 'file');
            } catch (err) { toast(`Couldn’t read that audio file: ${err.message || err}`, 4000); }
        });
        m.addInput('trig', 'Trig', 'gate', edge);
        m.addInput('pitch', 'Pitch', 'cv', pitch);
        m.addOutput('out', 'Out', 'audio', out);
        return {
            update(key, v) {
                if (key === 'level') m.set(out.gain, dbToGain(v));
                if (key === 'tune') m.set(tune.gain, v * 100);
                if (['source', 'start', 'end', 'fileName', 'reverse'].includes(key)) draw();
            },
            refresh: draw,
            dispose() { edge.port.onmessage = null; release(ctx.currentTime); try { manual.stop(); pitchSum.stop(); } catch (e) {} },
        };
    },
});

// ---------------------------------------------------------------- FM Operator
registerModule({
    type: 'fmop', title: 'FM Operator', category: 'Sources', blurb: 'Two-operator FM voice', width: 210,
    params: {
        mode: { default: 'note' }, freq: { default: 220 }, fine: { default: 0 }, note: { default: 'A' }, octave: { default: 3 },
        ratio: { label: 'Mod Ratio', min: 0.25, max: 16, curve: 'log', default: 2, format: (v) => `×${v.toFixed(3)}` },
        index: { label: 'FM Index', min: 0, max: 20, curve: 2, default: 2, format: (v) => v.toFixed(2) },
        cwave: { label: 'Carrier Wave', default: 'sine', options: [{ value: 'sine', label: 'Sine' }, { value: 'triangle', label: 'Triangle' }, { value: 'square', label: 'Square' }, { value: 'sawtooth', label: 'Sawtooth' }] },
        mwave: { label: 'Modulator Wave', default: 'sine', options: [{ value: 'sine', label: 'Sine' }, { value: 'triangle', label: 'Triangle' }, { value: 'square', label: 'Square' }, { value: 'sawtooth', label: 'Sawtooth' }] },
        level: { label: 'Level', min: -60, max: 0, default: -6, step: 0.1, format: formatDb, unit: 'dB' },
    },
    create(m, ctx) {
        const car = ctx.createOscillator(), mod = ctx.createOscillator();
        const depth = ctx.createGain(), out = ctx.createGain();
        const pitch = ctx.createGain(); pitch.gain.value = 1200;
        const indexCv = ctx.createGain(); // CV adds index units (scaled to Hz below)
        mod.connect(depth).connect(car.frequency);
        car.connect(out);
        pitch.connect(car.detune); pitch.connect(mod.detune);
        const modTap = ctx.createGain(); mod.connect(modTap);
        const idxMul = ctx.createGain(); indexCv.connect(idxMul).connect(depth.gain);
        car.start(); mod.start();
        const p = m.pitch({ min: 10, max: 20000, minOctave: -1, maxOctave: 9 });
        ['ratio', 'index'].forEach((k) => m.slider(k));
        m.select('cwave'); m.select('mwave'); m.slider('level');
        // Deviation (Hz) = index × modulator frequency.
        const apply = () => {
            const f = p.frequency(), mf = f * m.params.ratio;
            m.set(car.frequency, f, 0.01);
            m.set(mod.frequency, mf, 0.01);
            m.set(depth.gain, m.params.index * mf);
            m.set(idxMul.gain, mf);
        };
        m.addInput('pitch', 'Pitch', 'cv', pitch);
        m.addInput('index', 'Index', 'cv', indexCv);
        m.addOutput('out', 'Out', 'audio', out);
        m.addOutput('mod', 'Mod', 'audio', modTap);
        return {
            update(key, v) {
                if (['mode', 'freq', 'fine', 'note', 'octave', 'ratio', 'index'].includes(key)) apply();
                if (key === 'cwave') car.type = v;
                if (key === 'mwave') mod.type = v;
                if (key === 'level') m.set(out.gain, dbToGain(v));
            },
            refresh: apply,
            dispose() { try { car.stop(); mod.stop(); } catch (e) {} },
        };
    },
});

// ---------------------------------------------------------------- Clock & gate tools
registerModule({
    type: 'clockmod', title: 'Clock Modifier', category: 'Sequencing', blurb: 'Divide or multiply a clock',
    params: {
        mode: { label: 'Mode', default: 'divide', options: [{ value: 'divide', label: 'Divide' }, { value: 'multiply', label: 'Multiply' }] },
        ratio: { label: 'Factor', min: 1, max: 32, default: 2, step: 1, format: (v) => `${v}` },
    },
    create(m, ctx) {
        const node = new AudioWorkletNode(ctx, 'ma-clockmod', { numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [1] });
        const label = el('span', { class: 'node-label' });
        m.select('mode'); m.slider('ratio');
        m.content.append(el('div', { class: 'info-row' }, label));
        m.addInput('clock', 'Clock', 'gate', node, { index: 0 });
        m.addInput('reset', 'Reset', 'gate', node, { index: 1 });
        m.addOutput('out', 'Out', 'gate', node);
        const show = () => { label.textContent = m.params.mode === 'divide' ? `One pulse every ${m.params.ratio} clocks` : `${m.params.ratio} pulses per clock`; };
        return {
            update(key, v) {
                if (key === 'mode') node.parameters.get('multiply').value = v === 'multiply' ? 1 : 0;
                if (key === 'ratio') node.parameters.get('ratio').value = v;
                show();
            },
        };
    },
});

registerModule({
    type: 'clockquant', title: 'Clock Quantizer', category: 'Sequencing', blurb: 'Snaps gates to the next clock pulse',
    params: {},
    create(m, ctx) {
        const node = new AudioWorkletNode(ctx, 'ma-clockquant', { numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [1] });
        m.content.append(el('div', { class: 'info-row' }, el('span', { class: 'node-label', text: 'Gates wait for the next clock' })));
        m.addInput('gate', 'Gate', 'gate', node, { index: 0 });
        m.addInput('clock', 'Clock', 'gate', node, { index: 1 });
        m.addOutput('out', 'Out', 'gate', node);
        return {};
    },
});

registerModule({
    type: 'euclid', title: 'Euclidean Seq', category: 'Sequencing', blurb: 'Evenly spread rhythmic hits', width: 220,
    params: {
        steps: { label: 'Steps', min: 1, max: 32, default: 16, step: 1, format: (v) => `${v}` },
        fills: { label: 'Hits', min: 0, max: 32, default: 5, step: 1, format: (v) => `${v}` },
        rotate: { label: 'Rotate', min: 0, max: 31, default: 0, step: 1, format: (v) => `${v}` },
    },
    create(m, ctx) {
        const node = new AudioWorkletNode(ctx, 'ma-euclid', { numberOfInputs: 2, numberOfOutputs: 2, outputChannelCount: [1, 1] });
        const canvas = el('canvas', { class: 'display', width: 392, height: 200, style: { height: '100px' } });
        m.content.append(canvas);
        ['steps', 'fills', 'rotate'].forEach((k) => m.slider(k));
        let playing = -1;
        const hit = (i, n, k, r) => { if (k <= 0) return false; if (k >= n) return true; const j = (i + n - (r % n)) % n; return (j * k) % n < k; };
        const draw = () => {
            const g = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
            const n = m.params.steps, k = Math.min(m.params.fills, n), r = m.params.rotate;
            g.clearRect(0, 0, W, H);
            const R = H / 2 - 16;
            for (let i = 0; i < n; i++) {
                const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
                const x = W / 2 + Math.cos(a) * R, y = H / 2 + Math.sin(a) * R;
                g.beginPath();
                g.arc(x, y, Math.max(4, Math.min(11, 140 / n)), 0, Math.PI * 2);
                g.fillStyle = hit(i, n, k, r) ? css('--display-line') : css('--display-grid');
                g.fill();
                if (i === playing) { g.lineWidth = 3; g.strokeStyle = css('--step-active'); g.stroke(); }
            }
            g.fillStyle = css('--display-line');
            g.font = '600 26px Inter, system-ui, sans-serif';
            g.textAlign = 'center'; g.textBaseline = 'middle';
            g.fillText(`${k}/${n}`, W / 2, H / 2);
        };
        node.port.onmessage = (e) => { playing = e.data; draw(); };
        m.addInput('clock', 'Clock', 'gate', node, { index: 0 });
        m.addInput('reset', 'Reset', 'gate', node, { index: 1 });
        m.addOutput('hit', 'Hits', 'gate', node, { index: 0 });
        m.addOutput('off', 'Rests', 'gate', node, { index: 1 });
        return {
            update(key, v) { node.parameters.get(key).value = v; draw(); },
            refresh: draw,
            dispose() { node.port.onmessage = null; },
        };
    },
});

registerModule({
    type: 'probgate', title: 'Prob Gate', category: 'Sequencing', blurb: 'Lets each gate through by chance',
    params: { prob: { label: 'Probability', min: 0, max: 1, default: 0.5, format: formatPercent, unit: 'ratio' } },
    create(m, ctx) {
        const node = new AudioWorkletNode(ctx, 'ma-probgate', { numberOfInputs: 1, numberOfOutputs: 2, outputChannelCount: [1, 1] });
        const probCv = ctx.createGain(); probCv.gain.value = 0.5; // 1 unit = +50%
        probCv.connect(node.parameters.get('prob'));
        const la = led(), lb = led();
        m.slider('prob');
        m.content.append(el('div', { class: 'info-row' }, el('span', { class: 'node-label', text: 'A' }), la, el('span', { class: 'node-label', text: 'B' }), lb));
        node.port.onmessage = (e) => blink(e.data ? la : lb, 80);
        m.addInput('in', 'Gate', 'gate', node);
        m.addInput('prob', 'Prob', 'cv', probCv);
        m.addOutput('a', 'A', 'gate', node, { index: 0 });
        m.addOutput('b', 'B (else)', 'gate', node, { index: 1 });
        return { update(key, v) { m.set(node.parameters.get('prob'), v, 0.005); }, dispose() { node.port.onmessage = null; } };
    },
});

registerModule({
    type: 'trigdelay', title: 'Trig Delay', category: 'Sequencing', blurb: 'Fires a gate after a delay',
    params: {
        delay: { label: 'Delay', min: 0.001, max: 5, curve: 'log', default: 0.1, format: formatTime, unit: 's' },
        length: { label: 'Gate Length', min: 0.001, max: 1, curve: 'log', default: 0.02, format: formatTime, unit: 's' },
    },
    create(m, ctx) {
        const node = new AudioWorkletNode(ctx, 'ma-trigdelay', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
        const delayCv = ctx.createGain(); delayCv.gain.value = 0.1; // 1 unit = +100 ms
        delayCv.connect(node.parameters.get('delay'));
        m.slider('delay'); m.slider('length');
        m.addInput('in', 'Gate', 'gate', node);
        m.addInput('delay', 'Delay', 'cv', delayCv);
        m.addOutput('out', 'Out', 'gate', node);
        return {
            update(key, v) { if (key === 'delay') m.set(node.parameters.get('delay'), v, 0.005); else node.parameters.get('length').value = v; },
        };
    },
});

registerModule({
    type: 'trigger', title: 'Trigger', category: 'Sequencing', blurb: 'Manual gate button',
    params: { mode: { label: 'Mode', default: 'momentary', options: [{ value: 'momentary', label: 'Momentary' }, { value: 'latching', label: 'Latching' }] } },
    create(m, ctx) {
        const src = ctx.createConstantSource(); src.offset.value = 0; src.start();
        const btn = el('button', { class: 'param-button', type: 'button', text: 'Trigger', style: { height: '3rem', fontSize: '0.9rem' } });
        m.select('mode');
        m.content.append(el('div', { class: 'btn-row' }, btn));
        let on = false;
        const set = (v) => { on = v; btn.classList.toggle('active', v); m.set(src.offset, v ? 1 : 0, 0); };
        btn.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            e.preventDefault();
            btn.setPointerCapture(e.pointerId);
            set(m.params.mode === 'latching' ? !on : true);
        });
        const up = () => { if (m.params.mode !== 'latching') set(false); };
        btn.addEventListener('pointerup', up);
        btn.addEventListener('pointercancel', up);
        m.addOutput('out', 'Gate', 'gate', src);
        return { update() { set(false); }, dispose() { try { src.stop(); } catch (e) {} } };
    },
});

// ---------------------------------------------------------------- Logic & CV
registerModule({
    type: 'logic', title: 'Logic', category: 'Logic & CV', blurb: 'AND, OR, XOR and friends on gates',
    params: { op: { label: 'Operation', default: 0, options: ['AND', 'OR', 'XOR', 'NAND', 'NOR', 'XNOR', 'NOT A'].map((label, value) => ({ value, label })) } },
    create(m, ctx) {
        const node = new AudioWorkletNode(ctx, 'ma-logic', { numberOfInputs: 2, numberOfOutputs: 2, outputChannelCount: [1, 1] });
        m.select('op');
        m.addInput('a', 'A', 'gate', node, { index: 0 });
        m.addInput('b', 'B', 'gate', node, { index: 1 });
        m.addOutput('out', 'Out', 'gate', node, { index: 0 });
        m.addOutput('inv', 'Inverted', 'gate', node, { index: 1 });
        return { update(key, v) { node.parameters.get('op').value = v; } };
    },
});

registerModule({
    type: 'comparator', title: 'Comparator', category: 'Logic & CV', blurb: 'Gate high while a signal is above a threshold',
    params: {
        threshold: { label: 'Threshold', min: -1, max: 1, default: 0, format: (v) => v.toFixed(3) },
        hysteresis: { label: 'Hysteresis', min: 0, max: 0.5, curve: 2, default: 0.02, format: (v) => v.toFixed(3) },
    },
    create(m, ctx) {
        const node = new AudioWorkletNode(ctx, 'ma-comparator', { numberOfInputs: 1, numberOfOutputs: 2, outputChannelCount: [1, 1] });
        const l = led();
        m.slider('threshold'); m.slider('hysteresis');
        m.content.append(el('div', { class: 'info-row' }, el('span', { class: 'node-label', text: 'State' }), l));
        node.port.onmessage = (e) => l.classList.toggle('on', !!e.data);
        m.addInput('in', 'In', 'cv', node);
        m.addInput('thresh', 'Thresh', 'cv', node.parameters.get('threshold'));
        m.addOutput('out', 'Gate', 'gate', node, { index: 0 });
        m.addOutput('inv', 'Inverted', 'gate', node, { index: 1 });
        return {
            update(key, v) { if (key === 'threshold') m.set(node.parameters.get('threshold'), v, 0.005); else node.parameters.get('hysteresis').value = v; },
            dispose() { node.port.onmessage = null; },
        };
    },
});

const MATH_OPS = ['A + B', 'A − B', 'A × B', 'Min(A, B)', 'Max(A, B)', '|A| (rectify)', '−A (invert)', 'Sample A on B gate', 'Quantise A to semitones', 'A if positive'];
registerModule({
    type: 'math', title: 'Math', category: 'Logic & CV', blurb: 'Combine, scale, offset, slew', width: 210,
    params: {
        op: { label: 'Operation', default: 0, options: MATH_OPS.map((label, value) => ({ value, label })) },
        scale: { label: 'Scale', min: -2, max: 2, default: 1, format: (v) => `×${v.toFixed(3)}` },
        offset: { label: 'Offset', min: -2, max: 2, default: 0, format: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(3)}` },
        rise: { label: 'Slew Up', min: 0, max: 5, curve: 3, default: 0, format: (v) => (v < 0.0005 ? 'Off' : formatTime(v)), unit: 's' },
        fall: { label: 'Slew Down', min: 0, max: 5, curve: 3, default: 0, format: (v) => (v < 0.0005 ? 'Off' : formatTime(v)), unit: 's' },
    },
    create(m, ctx) {
        const node = new AudioWorkletNode(ctx, 'ma-math', { numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [1] });
        const readout = el('span', { class: 'node-label', text: '0.000' });
        m.select('op');
        ['scale', 'offset', 'rise', 'fall'].forEach((k) => m.slider(k));
        m.content.append(el('div', { class: 'info-row' }, el('span', { class: 'node-label', text: 'Output' }), readout));
        let f = 0;
        node.port.onmessage = (e) => { if (++f % 3 === 0) readout.textContent = e.data.toFixed(3); };
        m.addInput('a', 'A', 'cv', node, { index: 0 });
        m.addInput('b', 'B', 'cv', node, { index: 1 });
        m.addInput('scale', 'Scale', 'cv', node.parameters.get('scale'));
        m.addInput('offset', 'Offset', 'cv', node.parameters.get('offset'));
        m.addOutput('out', 'Out', 'cv', node);
        return {
            update(key, v) {
                const p = node.parameters.get(key);
                if (key === 'scale' || key === 'offset') m.set(p, v, 0.005); else p.value = v;
            },
            dispose() { node.port.onmessage = null; },
        };
    },
});

registerModule({
    type: 'follower', title: 'Env Follower', category: 'Logic & CV', blurb: 'Turns loudness into CV',
    params: {
        attack: { label: 'Attack', min: 0.0005, max: 1, curve: 'log', default: 0.01, format: formatTime, unit: 's' },
        release: { label: 'Release', min: 0.005, max: 3, curve: 'log', default: 0.2, format: formatTime, unit: 's' },
        gain: { label: 'Gain', min: -4, max: 4, default: 1, format: (v) => `×${v.toFixed(2)}` },
        offset: { label: 'Offset', min: -1, max: 1, default: 0, format: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}` },
    },
    create(m, ctx) {
        const node = new AudioWorkletNode(ctx, 'ma-follower', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
        const gain = ctx.createGain(), off = ctx.createConstantSource(), out = ctx.createGain();
        off.start();
        node.connect(gain).connect(out);
        off.connect(out);
        const meter = el('div', { class: 'meter' }, el('div', { class: 'meter-fill plain' }));
        m.content.append(meter);
        ['attack', 'release', 'gain', 'offset'].forEach((k) => m.slider(k));
        node.port.onmessage = (e) => setMeter(meter.firstChild, e.data);
        m.addInput('in', 'In', 'audio', node);
        m.addOutput('out', 'CV', 'cv', out);
        return {
            update(key, v) {
                if (key === 'gain') m.set(gain.gain, v);
                else if (key === 'offset') m.set(off.offset, v);
                else node.parameters.get(key).value = v;
            },
            dispose() { node.port.onmessage = null; try { off.stop(); } catch (e) {} },
        };
    },
});

// ---------------------------------------------------------------- Utilities
registerModule({
    type: 'dcblock', title: 'DC Blocker', category: 'Utilities', blurb: 'Removes offset and sub-audio rumble',
    params: { cutoff: { label: 'Cutoff', min: 1, max: 200, curve: 'log', default: 10, format: formatFrequency, unit: 'Hz' } },
    create(m, ctx) {
        const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.Q.value = 0.707;
        m.slider('cutoff');
        m.addInput('in', 'In', 'audio', hp);
        m.addOutput('out', 'Out', 'audio', hp);
        return { update(key, v) { m.set(hp.frequency, v); } };
    },
});

registerModule({
    type: 'stereo', title: 'Stereo Utility', category: 'Utilities', blurb: 'Width, mid/side, balance, swap',
    params: {
        mid: { label: 'Mid Gain', min: 0, max: 2, default: 1, format: (v) => `×${v.toFixed(2)}` },
        side: { label: 'Side Gain (Width)', min: 0, max: 2, default: 1, format: (v) => `×${v.toFixed(2)}` },
        balance: { label: 'Balance', min: -1, max: 1, default: 0, format: (v) => (Math.abs(v) < 0.005 ? 'Centre' : `${v < 0 ? 'L' : 'R'} ${Math.round(Math.abs(v) * 100)}%`) },
        swap: { label: 'Channels', default: 'normal', options: [{ value: 'normal', label: 'Normal' }, { value: 'swap', label: 'Swap L/R' }] },
    },
    create(m, ctx) {
        const input = ctx.createGain();
        input.channelCount = 2; input.channelCountMode = 'explicit'; input.channelInterpretation = 'speakers'; // mono upmixes to both sides
        const split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
        const inR = ctx.createGain(); // R from a separate jack, summed into the right side
        input.connect(split);
        const g = () => ctx.createGain();
        // M = (L+R)/2, S = (L-R)/2; L' = M*mid + S*side, R' = M*mid - S*side
        const mL = g(), mR = g(), sL = g(), sR = g(), mid = g(), side = g(), outL = g(), outR = g(), sideNeg = g();
        mL.gain.value = 0.5; mR.gain.value = 0.5; sL.gain.value = 0.5; sR.gain.value = -0.5; sideNeg.gain.value = -1;
        split.connect(mL, 0); split.connect(mR, 1); split.connect(sL, 0); split.connect(sR, 1);
        inR.connect(mR); const inRs = g(); inRs.gain.value = -0.5; inR.connect(inRs).connect(side);
        mL.connect(mid); mR.connect(mid); sL.connect(side); sR.connect(side);
        mid.connect(outL); mid.connect(outR);
        side.connect(outL); side.connect(sideNeg).connect(outR);
        const balL = g(), balR = g();
        outL.connect(balL); outR.connect(balR);
        const route = () => {
            try { balL.disconnect(); balR.disconnect(); } catch (e) {}
            const sw = m.params.swap === 'swap';
            balL.connect(merge, 0, sw ? 1 : 0);
            balR.connect(merge, 0, sw ? 0 : 1);
        };
        ['mid', 'side', 'balance'].forEach((k) => m.slider(k));
        m.select('swap');
        m.addInput('in', 'In / L', 'audio', input);
        m.addInput('r', 'R', 'audio', inR);
        m.addOutput('out', 'Stereo', 'audio', merge);
        route();
        return {
            update(key, v) {
                if (key === 'mid') m.set(mid.gain, v);
                if (key === 'side') m.set(side.gain, v);
                if (key === 'balance') { m.set(balL.gain, Math.min(1, 1 - v)); m.set(balR.gain, Math.min(1, 1 + v)); }
                if (key === 'swap') route();
            },
        };
    },
});

// Autocorrelation pitch detection (time-domain, normalised difference).
function detectPitch(buf, sr) {
    let rms = 0;
    for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / buf.length);
    if (rms < 0.01) return null;
    const minLag = Math.floor(sr / 2000), maxLag = Math.min(Math.floor(sr / 30), buf.length >> 1);
    const n = buf.length - maxLag;
    let best = -1, bestLag = 0;
    const corr = new Float32Array(maxLag + 2);
    for (let lag = minLag; lag <= maxLag; lag++) {
        let s = 0, e1 = 0, e2 = 0;
        for (let i = 0; i < n; i += 2) { const a = buf[i], b = buf[i + lag]; s += a * b; e1 += a * a; e2 += b * b; }
        const c = s / Math.sqrt(e1 * e2 + 1e-12);
        corr[lag] = c;
        if (c > best) { best = c; bestLag = lag; }
    }
    if (best < 0.85) return null;
    // Prefer the first strong peak (avoids octave-down errors).
    for (let lag = minLag + 1; lag < bestLag; lag++) {
        if (corr[lag] > best * 0.93 && corr[lag] >= corr[lag - 1] && corr[lag] >= corr[lag + 1]) { bestLag = lag; break; }
    }
    const a = corr[bestLag - 1] || 0, b = corr[bestLag], c = corr[bestLag + 1] || 0;
    const shift = (a - c) / (2 * (a - 2 * b + c) || 1);
    return sr / (bestLag + (Number.isFinite(shift) ? clamp(shift, -1, 1) : 0));
}

registerModule({
    type: 'tuner', title: 'Tuner', category: 'Utilities', blurb: 'Shows note, frequency and cents', width: 200,
    params: {},
    create(m, ctx) {
        const input = ctx.createGain(), an = ctx.createAnalyser();
        an.fftSize = 4096;
        input.connect(an);
        const noteEl = el('div', { style: { fontSize: '1.8rem', fontWeight: '700', textAlign: 'center', fontVariantNumeric: 'tabular-nums' }, text: '—' });
        const hzEl = el('div', { class: 'node-label', style: { textAlign: 'center' }, text: 'No signal' });
        const bar = el('div', { class: 'tuner-bar' }, el('div', { class: 'tuner-needle' }));
        m.content.append(noteEl, bar, hzEl);
        const buf = new Float32Array(an.fftSize);
        let last = 0, smooth = null;
        m.animate(() => {
            const now = performance.now();
            if (m.minimized || now - last < 80) return;
            last = now;
            an.getFloatTimeDomainData(buf);
            const f = detectPitch(buf, ctx.sampleRate);
            if (!f) { hzEl.textContent = 'No signal'; bar.classList.add('idle'); return; }
            smooth = smooth && Math.abs(Math.log2(f / smooth)) < 0.05 ? smooth * 0.6 + f * 0.4 : f;
            const midi = freqToMidi(smooth), n = Math.round(midi), cents = (midi - n) * 100;
            noteEl.textContent = midiToName(n);
            hzEl.textContent = `${formatFrequency(smooth)} · ${cents >= 0 ? '+' : ''}${cents.toFixed(1)} ¢`;
            bar.classList.remove('idle');
            bar.classList.toggle('intune', Math.abs(cents) < 3);
            bar.firstChild.style.left = `${50 + clamp(cents, -50, 50)}%`;
        });
        m.addInput('in', 'In', 'audio', input);
        m.addOutput('out', 'Thru', 'audio', input);
        return {};
    },
});

registerModule({
    type: 'spectrum', title: 'Spectrum', category: 'Utilities', blurb: 'Frequency analyser (FFT)', width: 280,
    params: {
        size: { label: 'FFT Size', default: 4096, options: [1024, 2048, 4096, 8192, 16384].map((v) => ({ value: v, label: String(v) })) },
        smoothing: { label: 'Averaging', min: 0, max: 0.99, default: 0.8, format: (v) => v.toFixed(2) },
        range: { label: 'Range', min: 30, max: 120, default: 90, step: 1, format: (v) => `${v} dB` },
    },
    create(m, ctx) {
        const input = ctx.createGain(), an = ctx.createAnalyser();
        input.connect(an);
        const canvas = el('canvas', { class: 'display', width: 512, height: 220, style: { height: '110px' } });
        m.content.append(canvas);
        m.select('size'); m.slider('smoothing'); m.slider('range');
        let data = new Float32Array(an.frequencyBinCount);
        const g = canvas.getContext('2d');
        m.animate(() => {
            if (m.minimized) return;
            if (data.length !== an.frequencyBinCount) data = new Float32Array(an.frequencyBinCount);
            an.getFloatFrequencyData(data);
            const W = canvas.width, H = canvas.height, ny = ctx.sampleRate / 2;
            const lo = Math.log10(20), hi = Math.log10(Math.min(20000, ny));
            g.clearRect(0, 0, W, H);
            g.strokeStyle = css('--display-grid'); g.lineWidth = 1; g.fillStyle = css('--display-grid');
            g.font = '18px Inter, system-ui, sans-serif';
            g.beginPath();
            for (const f of [100, 1000, 10000]) { const x = ((Math.log10(f) - lo) / (hi - lo)) * W; g.moveTo(x, 0); g.lineTo(x, H); g.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x + 4, H - 6); }
            g.stroke();
            const top = -10, bottom = top - m.params.range;
            g.strokeStyle = css('--display-line'); g.lineWidth = 2.5;
            g.beginPath();
            for (let x = 0; x < W; x++) {
                const f0 = Math.pow(10, lo + (x / W) * (hi - lo)), f1 = Math.pow(10, lo + ((x + 1) / W) * (hi - lo));
                const b0 = Math.floor((f0 / ny) * data.length), b1 = Math.max(b0 + 1, Math.floor((f1 / ny) * data.length));
                let v = -Infinity;
                for (let b = b0; b < b1 && b < data.length; b++) v = Math.max(v, data[b]);
                const y = H - ((clamp(v, bottom, top) - bottom) / (top - bottom)) * H;
                if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
            }
            g.stroke();
        });
        m.addInput('in', 'In', 'audio', input);
        m.addOutput('out', 'Thru', 'audio', input);
        return {
            update(key, v) {
                if (key === 'size') an.fftSize = Number(v);
                if (key === 'smoothing') an.smoothingTimeConstant = v;
            },
        };
    },
});
