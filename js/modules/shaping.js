// Shaping and control: Filter, VCA, ADSR, Mixer.
import { registerModule } from '../patch.js';
import { el, formatFrequency, formatTime, formatPercent, setMeter } from '../util.js';

registerModule({
    type: 'filter', title: 'Filter', category: 'Processors', blurb: '12/24 dB multimode with 1V/oct cutoff CV',
    params: {
        mode: { label: 'Type', default: 'lowpass', options: [
            { value: 'lowpass', label: 'Low Pass' }, { value: 'highpass', label: 'High Pass' },
            { value: 'bandpass', label: 'Band Pass' }, { value: 'notch', label: 'Notch' }] },
        slope: { label: 'Slope', default: 12, options: [{ value: 12, label: '12 dB/oct' }, { value: 24, label: '24 dB/oct' }] },
        cutoff: { label: 'Cutoff', min: 20, max: 20000, curve: 'log', default: 1200, format: formatFrequency, unit: 'Hz' },
        q: { label: 'Resonance (Q)', min: 0.1, max: 30, curve: 2.5, default: 1, format: (v) => v.toFixed(2) },
        amount: { label: 'CV Amount', min: -8, max: 8, default: 3, format: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)} oct` },
    },
    create(m, ctx) {
        const input = ctx.createGain();
        const f1 = ctx.createBiquadFilter();
        const f2 = ctx.createBiquadFilter();
        const cv = ctx.createGain();
        input.connect(f1).connect(f2);
        cv.connect(f1.detune);
        cv.connect(f2.detune);
        m.select('mode');
        m.select('slope');
        m.slider('cutoff');
        m.slider('q');
        m.slider('amount');
        m.addInput('in', 'In', 'audio', input);
        m.addInput('cutoff', 'Cutoff', 'cv', cv);
        m.addOutput('out', 'Out', 'audio', f2);
        const shape = () => {
            const steep = Number(m.params.slope) === 24;
            f1.type = m.params.mode;
            // 12 dB: the second stage is an all-pass, which leaves the magnitude untouched.
            f2.type = steep ? m.params.mode : 'allpass';
            m.set(f1.Q, m.params.q);
            m.set(f2.Q, steep ? Math.min(m.params.q, 0.707) : 0.0001);
        };
        return {
            update(key, v) {
                if (key === 'mode' || key === 'slope' || key === 'q') shape();
                if (key === 'cutoff') { m.set(f1.frequency, v, 0.01); m.set(f2.frequency, v, 0.01); }
                if (key === 'amount') m.set(cv.gain, v * 1200);
            },
        };
    },
});

registerModule({
    type: 'vca', title: 'VCA', category: 'Processors', blurb: 'Amplifier; CV controls the level',
    params: {
        level: { label: 'Level', min: 0, max: 1.5, curve: 2, default: 1, format: (v) => `×${v.toFixed(2)}` },
        response: { label: 'Response', default: 'lin', options: [{ value: 'lin', label: 'Linear' }, { value: 'exp', label: 'Exponential' }] },
    },
    create(m, ctx) {
        const vca = ctx.createGain();
        const shaper = ctx.createWaveShaper(); // exponential response for CV
        const cvIn = ctx.createGain();
        const level = ctx.createGain();
        vca.connect(level);
        const curve = new Float32Array(1025);
        for (let i = 0; i < curve.length; i++) { const x = (i / 1024) * 2 - 1; curve[i] = x <= 0 ? 0 : x * x * x; }
        shaper.curve = curve;
        const note = el('div', { class: 'info-row' }, el('span', { class: 'node-label', text: 'Unpatched CV: always open' }));
        m.slider('level');
        m.select('response');
        m.content.append(note);
        let patched = false;
        const route = () => {
            try { cvIn.disconnect(); } catch (e) {}
            if (m.params.response === 'exp') cvIn.connect(shaper).connect(vca.gain);
            else cvIn.connect(vca.gain);
        };
        m.addInput('in', 'In', 'audio', vca);
        m.addInput('cv', 'CV', 'cv', cvIn, {
            // With CV patched the base gain is 0 so the CV alone opens the VCA.
            onConnect(n) {
                patched = n > 0;
                m.set(vca.gain, patched ? 0 : 1, 0.005);
                note.firstChild.textContent = patched ? 'Level follows CV' : 'Unpatched CV: always open';
            },
        });
        m.addOutput('out', 'Out', 'audio', level);
        route();
        return {
            update(key, v) {
                if (key === 'level') m.set(level.gain, v);
                if (key === 'response') { try { shaper.disconnect(); } catch (e) {} route(); }
            },
        };
    },
});

registerModule({
    type: 'adsr', title: 'ADSR', category: 'Modulation', blurb: 'Envelope triggered by a gate',
    params: {
        attack: { label: 'Attack', min: 0.001, max: 10, curve: 'log', default: 0.01, format: formatTime, unit: 's' },
        decay: { label: 'Decay', min: 0.001, max: 10, curve: 'log', default: 0.25, format: formatTime, unit: 's' },
        sustain: { label: 'Sustain', min: 0, max: 1, default: 0.6, format: formatPercent, unit: 'ratio' },
        release: { label: 'Release', min: 0.001, max: 10, curve: 'log', default: 0.5, format: formatTime, unit: 's' },
    },
    create(m, ctx) {
        const node = new AudioWorkletNode(ctx, 'ma-adsr', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
        const manual = ctx.createConstantSource(); manual.offset.value = 0; manual.start();
        manual.connect(node);
        const canvas = el('canvas', { class: 'display', width: 352, height: 96, style: { height: '48px' } });
        const meter = el('div', { class: 'meter' }, el('div', { class: 'meter-fill plain' }));
        const trig = el('button', { class: 'param-button', type: 'button', text: 'Hold to Trigger' });
        m.content.append(canvas, meter);
        m.slider('attack'); m.slider('decay'); m.slider('sustain'); m.slider('release');
        m.content.append(el('div', { class: 'btn-row' }, trig));
        const down = (e) => { e.stopPropagation(); e.preventDefault(); trig.setPointerCapture(e.pointerId); trig.classList.add('active'); m.set(manual.offset, 1, 0); };
        const up = () => { trig.classList.remove('active'); m.set(manual.offset, 0, 0); };
        trig.addEventListener('pointerdown', down);
        trig.addEventListener('pointerup', up);
        trig.addEventListener('pointercancel', up);
        node.port.onmessage = (e) => setMeter(meter.firstChild, e.data);
        const draw = () => {
            const g = canvas.getContext('2d');
            const W = canvas.width, H = canvas.height, pad = 6;
            const cs = getComputedStyle(document.documentElement);
            g.clearRect(0, 0, W, H);
            const { attack: a, decay: d, sustain: s, release: r } = m.params;
            // Log-ish time axis so short and long stages both stay visible.
            const t = (x) => Math.log10(1 + x * 100);
            const ta = t(a), td = t(d), tr = t(r), hold = 0.5;
            const total = ta + td + hold + tr;
            const X = (v) => pad + (v / total) * (W - pad * 2);
            const Y = (v) => H - pad - v * (H - pad * 2);
            g.strokeStyle = cs.getPropertyValue('--display-line').trim();
            g.lineWidth = 3;
            g.beginPath();
            g.moveTo(X(0), Y(0));
            g.lineTo(X(ta), Y(1));
            g.quadraticCurveTo(X(ta + td * 0.15), Y(s), X(ta + td), Y(s));
            g.lineTo(X(ta + td + hold), Y(s));
            g.quadraticCurveTo(X(ta + td + hold + tr * 0.15), Y(0), X(total), Y(0));
            g.stroke();
        };
        m.addInput('gate', 'Gate', 'gate', node);
        m.addOutput('env', 'Env', 'cv', node);
        return {
            update(key, v) {
                const p = node.parameters.get(key);
                if (p) p.value = v;
                draw();
            },
            refresh: draw,
            dispose() { node.port.onmessage = null; try { manual.stop(); } catch (e) {} },
        };
    },
});

registerModule({
    type: 'mixer', title: 'Mixer', category: 'Processors', blurb: 'Four channels into one',
    params: {
        ch1: { label: 'Channel 1', min: 0, max: 1.5, curve: 2, default: 0.8, format: (v) => `×${v.toFixed(2)}` },
        ch2: { label: 'Channel 2', min: 0, max: 1.5, curve: 2, default: 0.8, format: (v) => `×${v.toFixed(2)}` },
        ch3: { label: 'Channel 3', min: 0, max: 1.5, curve: 2, default: 0.8, format: (v) => `×${v.toFixed(2)}` },
        ch4: { label: 'Channel 4', min: 0, max: 1.5, curve: 2, default: 0.8, format: (v) => `×${v.toFixed(2)}` },
        master: { label: 'Master', min: 0, max: 1.5, curve: 2, default: 1, format: (v) => `×${v.toFixed(2)}` },
    },
    create(m, ctx) {
        const out = ctx.createGain();
        const ch = [1, 2, 3, 4].map(() => { const g = ctx.createGain(); g.connect(out); return g; });
        ['ch1', 'ch2', 'ch3', 'ch4', 'master'].forEach((k) => m.slider(k));
        ch.forEach((g, i) => m.addInput(`in${i + 1}`, `In ${i + 1}`, 'audio', g));
        m.addOutput('out', 'Out', 'audio', out);
        return {
            update(key, v) {
                if (key === 'master') m.set(out.gain, v);
                else ch[Number(key.slice(2)) - 1] && m.set(ch[Number(key.slice(2)) - 1].gain, v);
            },
        };
    },
});
