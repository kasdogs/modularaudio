// Effects: Delay, Reverb.
import { registerModule } from '../patch.js';
import { formatFrequency, formatTime, formatPercent } from '../util.js';

registerModule({
    type: 'delay', title: 'Delay', category: 'Effects', blurb: 'Echo with filtered feedback',
    params: {
        time: { label: 'Time', min: 0.001, max: 2, curve: 'log', default: 0.35, format: formatTime, unit: 's' },
        feedback: { label: 'Feedback', min: 0, max: 0.95, default: 0.4, format: formatPercent, unit: 'ratio' },
        tone: { label: 'Tone', min: 300, max: 20000, curve: 'log', default: 6000, format: formatFrequency, unit: 'Hz' },
        mix: { label: 'Mix', min: 0, max: 1, default: 0.35, format: formatPercent, unit: 'ratio' },
    },
    create(m, ctx) {
        const input = ctx.createGain();
        const out = ctx.createGain();
        const dry = ctx.createGain();
        const wet = ctx.createGain();
        const delay = ctx.createDelay(4);
        const tone = ctx.createBiquadFilter(); tone.type = 'lowpass';
        const fb = ctx.createGain();
        const timeCv = ctx.createGain(); timeCv.gain.value = 0.1; // 1 unit = 100 ms
        input.connect(dry).connect(out);
        input.connect(delay);
        delay.connect(tone).connect(fb).connect(delay);
        tone.connect(wet).connect(out);
        timeCv.connect(delay.delayTime);
        ['time', 'feedback', 'tone', 'mix'].forEach((k) => m.slider(k));
        m.addInput('in', 'In', 'audio', input);
        m.addInput('time', 'Time', 'cv', timeCv);
        m.addOutput('out', 'Out', 'audio', out);
        return {
            update(key, v) {
                if (key === 'time') m.set(delay.delayTime, v, 0.06);
                if (key === 'feedback') m.set(fb.gain, v);
                if (key === 'tone') m.set(tone.frequency, v);
                if (key === 'mix') { m.set(wet.gain, Math.sin(v * Math.PI / 2)); m.set(dry.gain, Math.cos(v * Math.PI / 2)); }
            },
        };
    },
});

function impulse(ctx, seconds) {
    const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < len; i++) {
            const t = i / len;
            d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2) * Math.exp(-t * 3);
        }
    }
    return buf;
}

registerModule({
    type: 'reverb', title: 'Reverb', category: 'Effects', blurb: 'Stereo room with damping',
    params: {
        decay: { label: 'Decay', min: 0.2, max: 10, curve: 'log', default: 2.5, format: formatTime, unit: 's' },
        predelay: { label: 'Pre-delay', min: 0, max: 0.25, curve: 2, default: 0.01, format: formatTime, unit: 's' },
        damp: { label: 'Damping', min: 500, max: 20000, curve: 'log', default: 8000, format: formatFrequency, unit: 'Hz' },
        mix: { label: 'Mix', min: 0, max: 1, default: 0.3, format: formatPercent, unit: 'ratio' },
    },
    create(m, ctx) {
        const input = ctx.createGain();
        const out = ctx.createGain();
        const dry = ctx.createGain();
        const wet = ctx.createGain();
        const pre = ctx.createDelay(1);
        const conv = ctx.createConvolver();
        const damp = ctx.createBiquadFilter(); damp.type = 'lowpass';
        input.connect(dry).connect(out);
        input.connect(pre).connect(conv).connect(damp).connect(wet).connect(out);
        ['decay', 'predelay', 'damp', 'mix'].forEach((k) => m.slider(k));
        m.addInput('in', 'In', 'audio', input);
        m.addOutput('out', 'Out', 'audio', out);
        let t = null;
        return {
            update(key, v) {
                if (key === 'decay') {
                    clearTimeout(t);
                    // Rebuilding the impulse is costly, so wait until the slider settles.
                    t = setTimeout(() => { conv.buffer = impulse(ctx, v); }, conv.buffer ? 150 : 0);
                }
                if (key === 'predelay') m.set(pre.delayTime, v, 0.05);
                if (key === 'damp') m.set(damp.frequency, v);
                if (key === 'mix') { m.set(wet.gain, Math.sin(v * Math.PI / 2)); m.set(dry.gain, Math.cos(v * Math.PI / 2)); }
            },
            dispose() { clearTimeout(t); },
        };
    },
});
