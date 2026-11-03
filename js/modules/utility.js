// Utilities: Scope, Output.
import { registerModule } from '../patch.js';
import { audio } from '../audio.js';
import { el, formatDb, dbToGain } from '../util.js';

registerModule({
    type: 'scope', title: 'Scope', category: 'Utilities', blurb: 'Oscilloscope with pass-through',
    width: 260,
    params: {
        window: { label: 'Time Window', min: 2, max: 500, curve: 'log', default: 20, format: (v) => `${v < 10 ? v.toFixed(1) : Math.round(v)} ms` },
        gain: { label: 'Vertical Zoom', min: 0.1, max: 10, curve: 'log', default: 1, format: (v) => `×${v.toFixed(2)}` },
        trigger: { label: 'Trigger', default: 'rise', options: [{ value: 'rise', label: 'Rising edge' }, { value: 'free', label: 'Free run' }] },
    },
    create(m, ctx) {
        const input = ctx.createGain();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 32768;
        input.connect(analyser);
        const canvas = el('canvas', { class: 'display', width: 472, height: 200, style: { height: '100px' } });
        const readout = el('div', { class: 'info-row' }, el('span', { class: 'node-label', text: 'Peak' }), el('span', { class: 'node-label', text: '—' }));
        m.content.append(canvas, readout);
        m.slider('window');
        m.slider('gain');
        m.select('trigger');
        const data = new Float32Array(analyser.fftSize);
        const g = canvas.getContext('2d');
        let frame = 0;
        m.animate(() => {
            if (m.minimized || !m.element.isConnected) return;
            analyser.getFloatTimeDomainData(data);
            const W = canvas.width, H = canvas.height;
            const cs = getComputedStyle(document.documentElement);
            g.clearRect(0, 0, W, H);
            g.strokeStyle = cs.getPropertyValue('--display-grid').trim();
            g.lineWidth = 1;
            g.beginPath();
            for (let i = 1; i < 8; i++) { g.moveTo((W * i) / 8, 0); g.lineTo((W * i) / 8, H); }
            for (let i = 1; i < 4; i++) { g.moveTo(0, (H * i) / 4); g.lineTo(W, (H * i) / 4); }
            g.stroke();
            const span = Math.min(data.length / 2, Math.max(16, Math.round((m.params.window / 1000) * ctx.sampleRate)));
            let start = data.length - span;
            if (m.params.trigger === 'rise') {
                // Search backwards for the most recent rising zero crossing that leaves a full window.
                for (let i = data.length - span - 1; i > data.length - span * 2 && i > 0; i--) {
                    if (data[i - 1] <= 0 && data[i] > 0) { start = i; break; }
                }
            }
            let peak = 0;
            g.strokeStyle = cs.getPropertyValue('--display-line').trim();
            g.lineWidth = 2.5;
            g.beginPath();
            const step = span / W;
            for (let x = 0; x < W; x++) {
                const i0 = Math.floor(start + x * step), i1 = Math.max(i0 + 1, Math.floor(start + (x + 1) * step));
                let lo = Infinity, hi = -Infinity;
                for (let i = i0; i < i1 && i < data.length; i++) { const v = data[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
                peak = Math.max(peak, Math.abs(lo), Math.abs(hi));
                const y1 = H / 2 - hi * m.params.gain * (H / 2 - 4), y2 = H / 2 - lo * m.params.gain * (H / 2 - 4);
                if (x === 0) g.moveTo(x, y1);
                g.lineTo(x, y1);
                if (y2 - y1 > 1) g.lineTo(x, y2);
            }
            g.stroke();
            if (++frame % 10 === 0) readout.lastChild.textContent = peak.toFixed(3);
        });
        m.addInput('in', 'In', 'audio', input);
        m.addOutput('out', 'Thru', 'audio', input);
        return {};
    },
});

registerModule({
    type: 'output', title: 'Output', category: 'Utilities', blurb: 'To your speakers',
    deletable: false, minimizable: false, singleton: true, hiddenInBrowser: true,
    width: 150,
    params: {
        level: { label: 'Level', min: -60, max: 6, default: 0, step: 0.1, format: formatDb, unit: 'dB' },
    },
    create(m, ctx) {
        const input = ctx.createGain();
        const level = ctx.createGain();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        input.connect(level);
        level.connect(analyser);
        level.connect(audio.master);
        const meter = el('div', { class: 'meter' }, el('div', { class: 'meter-fill' }));
        m.content.append(meter);
        m.slider('level');
        const buf = new Float32Array(analyser.fftSize);
        let hold = 0;
        m.animate(() => {
            analyser.getFloatTimeDomainData(buf);
            let pk = 0;
            for (let i = 0; i < buf.length; i++) pk = Math.max(pk, Math.abs(buf[i]));
            hold = Math.max(pk, hold * 0.92);
            const db = hold > 0 ? 20 * Math.log10(hold) : -60;
            meter.firstChild.style.width = `${Math.max(0, Math.min(1, (db + 48) / 48)) * 100}%`;
        });
        m.addInput('in', 'In', 'audio', input);
        return {
            update(key, v) { if (key === 'level') m.set(level.gain, dbToGain(v)); },
            dispose() { try { level.disconnect(); } catch (e) {} },
        };
    },
});
