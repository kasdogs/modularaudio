// Slew Limiter (with trigger delay), Transient Shaper, Calculator, Drum Voice (worklet synth).
import { registerModule } from '../patch.js';
import { el, clamp, formatTime, formatPercent, formatDb, dbToGain, setMeter, toast, formatFrequency, freqToMidi, midiToName, NOTE_NAMES } from '../util.js';

const stop = (e) => e.stopPropagation();
const button = (text, cls = 'param-button') => { const b = el('button', { class: cls, type: 'button', text }); b.addEventListener('pointerdown', stop); return b; };
const section = (m, text) => m.content.append(el('div', { class: 'section-label', text }));
const offFmt = (v) => (v < 0.0005 ? 'Off' : formatTime(v));

// =====================================================================  Slew Limiter
registerModule({
    type: 'slew', title: 'Slew Limiter', category: 'Logic & CV', blurb: 'Smooths CV (rise/fall) and delays triggers', width: 210,
    params: {
        rise: { label: 'Rise', min: 0, max: 10, curve: 3, default: 0.1, format: offFmt, unit: 's' },
        fall: { label: 'Fall', min: 0, max: 10, curve: 3, default: 0.1, format: offFmt, unit: 's' },
        shape: { label: 'Response', default: 0, options: [{ value: 0, label: 'Linear (constant rate)' }, { value: 1, label: 'Exponential (RC curve)' }] },
        tdelay: { label: 'Delay', min: 0.001, max: 5, curve: 'log', default: 0.1, format: formatTime, unit: 's' },
        tlength: { label: 'Gate Length', min: 0.001, max: 2, curve: 'log', default: 0.02, format: formatTime, unit: 's' },
        tmode: { label: 'Gate Mode', default: 'fixed', options: [{ value: 'fixed', label: 'Fixed length pulse' }, { value: 'follow', label: 'Follow gate (delay both edges)' }] },
    },
    create(m, ctx) {
        const node = m.worklet('ma-slew', { numberOfInputs: 2, numberOfOutputs: 4, outputChannelCount: [1, 1, 1, 1] });
        const p = (k) => node.parameters.get(k);
        const riseCv = ctx.createGain(), fallCv = ctx.createGain(), delayCv = ctx.createGain();
        riseCv.connect(p('rise')); fallCv.connect(p('fall')); delayCv.connect(p('delay'));
        delayCv.gain.value = 0.1; // 1 unit = +100 ms
        section(m, 'Slew');
        m.slider('rise'); m.slider('fall'); m.select('shape');
        section(m, 'Trigger Delay');
        m.slider('tdelay'); m.select('tmode'); m.slider('tlength');
        m.addInput('in', 'In', 'cv', node, { index: 0 });
        m.addInput('rise', 'Rise', 'cv', riseCv);
        m.addInput('fall', 'Fall', 'cv', fallCv);
        m.addInput('gate', 'Gate', 'gate', node, { index: 1 });
        m.addInput('tdelay', 'Delay', 'cv', delayCv);
        m.addOutput('out', 'Out', 'cv', node, { index: 0 });
        m.addOutput('rising', 'Rising', 'gate', node, { index: 2 });
        m.addOutput('falling', 'Falling', 'gate', node, { index: 3 });
        m.addOutput('gout', 'Gate Out', 'gate', node, { index: 1 });
        return {
            update(key, v) {
                if (key === 'rise' || key === 'fall') m.set(p(key), v, 0.005);
                if (key === 'shape') p('shape').value = Number(v);
                if (key === 'tdelay') m.set(p('delay'), v, 0.005);
                if (key === 'tlength') p('length').value = v;
                if (key === 'tmode') {
                    p('follow').value = v === 'follow' ? 1 : 0;
                    m.controls.tlength && m.controls.tlength.el.classList.toggle('hidden', v === 'follow');
                }
            },
        };
    },
});

// =====================================================================  Transient Shaper
const pctFmt = (v) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`;
registerModule({
    type: 'transient', title: 'Transient Shaper', category: 'Dynamics & EQ', blurb: 'Boost or tame attacks and tails', width: 210,
    params: {
        attack: { label: 'Attack', min: -1, max: 1, default: 0, format: pctFmt },
        attackTh: { label: 'Attack Threshold', min: -80, max: 0, default: -40, step: 0.1, format: (v) => `${v.toFixed(1)} dB`, unit: 'dB' },
        release: { label: 'Release (Sustain)', min: -1, max: 1, default: 0, format: pctFmt },
        releaseTh: { label: 'Release Threshold', min: -80, max: 0, default: -40, step: 0.1, format: (v) => `${v.toFixed(1)} dB`, unit: 'dB' },
        speed: { label: 'Detector Speed', min: 0, max: 1, default: 0.4, format: (v) => (v < 0.34 ? 'Fast' : v < 0.67 ? 'Medium' : 'Slow') },
        mix: { label: 'Mix', min: 0, max: 1, default: 1, format: formatPercent, unit: 'ratio' },
        output: { label: 'Output', min: -24, max: 12, default: 0, step: 0.1, format: formatDb, unit: 'dB' },
    },
    create(m, ctx) {
        const input = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain(), out = ctx.createGain();
        const node = m.worklet('ma-transient');
        input.connect(dry).connect(out);
        input.connect(node).connect(wet).connect(out);
        const ma = el('div', { class: 'meter' }, el('div', { class: 'meter-fill plain' }));
        const mr = el('div', { class: 'meter' }, el('div', { class: 'meter-fill plain' }));
        const gr = el('span', { class: 'node-label', text: '0.0 dB' });
        m.content.append(el('div', { class: 'info-row' }, el('span', { class: 'node-label', text: 'Gain' }), gr));
        section(m, 'Attack');
        m.content.append(ma);
        m.slider('attack'); m.slider('attackTh');
        section(m, 'Release');
        m.content.append(mr);
        m.slider('release'); m.slider('releaseTh');
        m.slider('speed'); m.slider('mix'); m.slider('output');
        let f = 0;
        node.port.onmessage = (e) => {
            setMeter(ma.firstChild, Math.abs(e.data.a) / 18);
            setMeter(mr.firstChild, Math.abs(e.data.r) / 18);
            if (++f % 3 === 0) gr.textContent = `${e.data.g >= 0 ? '+' : ''}${e.data.g.toFixed(1)} dB`;
        };
        m.addInput('in', 'In', 'audio', input);
        m.addOutput('out', 'Out', 'audio', out);
        return {
            update(key, v) {
                if (key === 'mix') { m.set(wet.gain, v); m.set(dry.gain, 1 - v); }
                else if (key === 'output') m.set(out.gain, dbToGain(v));
                else node.parameters.get(key).value = v;
            },
            dispose() { node.port.onmessage = null; },
        };
    },
});

// =====================================================================  Calculator
const DIVS = [['1/1', 1], ['1/2', 1 / 2], ['1/4', 1 / 4], ['1/8', 1 / 8], ['1/16', 1 / 16], ['1/32', 1 / 32], ['1/64', 1 / 64]];
const FEELS = { straight: 1, dotted: 1.5, triplet: 2 / 3 };
const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(3)} s` : `${ms.toFixed(ms < 10 ? 3 : 2)} ms`);
const fmtHz = (hz) => `${hz.toFixed(hz < 1 ? 4 : hz < 100 ? 3 : 2)} Hz`;
function parseNote(s) {
    const m = String(s).trim().match(/^([A-Ga-g])([#b♯♭]?)(-?\d+)$/);
    if (!m) return null;
    let i = NOTE_NAMES.indexOf(m[1].toUpperCase());
    if (m[2] === '#' || m[2] === '♯') i++;
    if (m[2] === 'b' || m[2] === '♭') i--;
    return i + (Number(m[3]) + 1) * 12;
}

registerModule({
    type: 'calc', title: 'Calculator', category: 'Utilities', blurb: 'BPM ↔ ms ↔ Hz, note ↔ Hz, tap tempo', width: 260,
    params: {
        bpm: { default: 120, min: 1, max: 999 },
        div: { default: 1 / 4, min: 1 / 64, max: 1 },
        feel: { default: 'straight', options: Object.keys(FEELS).map((k) => ({ value: k, label: k })) },
        hz: { default: 440, min: 0.001, max: 24000 },
    },
    create(m, ctx) {
        const num = (title) => {
            const i = el('input', { class: 'calc-input', type: 'text', inputmode: 'decimal', title, spellcheck: 'false', autocomplete: 'off' });
            i.addEventListener('pointerdown', stop);
            i.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') i.blur(); });
            return i;
        };
        const bpmIn = num('Tempo in beats per minute'), msIn = num('Length of the selected division'), hzIn = num('Rate of the selected division');
        const pitchHz = num('Frequency in Hz'), pitchNote = num('Note name, e.g. A4 or C#3');
        const x2 = button('×2'), d2 = button('÷2'), tx2 = button('×2'), td2 = button('÷2'), tap = button('Tap');
        const divSel = el('select', {}, DIVS.map(([l, v]) => el('option', { value: String(v), text: l })));
        const feelSel = el('select', {}, Object.keys(FEELS).map((k) => el('option', { value: k, text: k[0].toUpperCase() + k.slice(1) })));
        [divSel, feelSel].forEach((s) => s.addEventListener('pointerdown', stop));
        const table = el('table', { class: 'calc-table' });
        const cents = el('span', { class: 'node-label' });
        const row = (label, ...kids) => el('div', { class: 'calc-row' }, el('span', { class: 'calc-label', text: label }), ...kids);
        section(m, 'Tempo');
        m.content.append(
            row('BPM', bpmIn, d2, x2, tap),
            row('Note', divSel, feelSel),
            row('Time', msIn, td2, tx2),
            row('Rate', hzIn),
            table);
        section(m, 'Pitch');
        m.content.append(row('Hz', pitchHz), row('Note', pitchNote, cents));
        const msFor = (bpm, div, feel) => (60000 / bpm) * 4 * div * FEELS[feel];
        const render = () => {
            const { bpm, div, feel } = m.params;
            const ms = msFor(bpm, div, feel);
            if (document.activeElement !== bpmIn) bpmIn.value = String(+bpm.toFixed(3));
            if (document.activeElement !== msIn) msIn.value = fmtMs(ms);
            if (document.activeElement !== hzIn) hzIn.value = fmtHz(1000 / ms);
            divSel.value = String(div); feelSel.value = feel;
            table.replaceChildren(el('tr', {}, el('th', { text: '' }), ...Object.keys(FEELS).map((k) => el('th', { text: k === 'straight' ? 'Straight' : k === 'dotted' ? 'Dotted' : 'Triplet' }))),
                ...DIVS.slice(0, 6).map(([l, v]) => el('tr', {}, el('th', { text: l }), ...Object.keys(FEELS).map((k) => {
                    const t = msFor(bpm, v, k);
                    const td = el('td', { text: t >= 1000 ? `${(t / 1000).toFixed(2)}s` : t.toFixed(1), title: `${fmtMs(t)} · ${fmtHz(1000 / t)} · click to copy` });
                    td.classList.toggle('current', v === div && k === feel);
                    td.addEventListener('pointerdown', stop);
                    td.addEventListener('click', () => { navigator.clipboard?.writeText(t.toFixed(3)).catch(() => {}); m.setParam('div', v); m.setParam('feel', k); toast(`Copied ${fmtMs(t)}`); });
                    return td;
                }))));
            const hz = m.params.hz, midi = freqToMidi(hz), n = Math.round(midi);
            if (document.activeElement !== pitchHz) pitchHz.value = String(+hz.toFixed(4));
            if (document.activeElement !== pitchNote) pitchNote.value = midiToName(n);
            const c = (midi - n) * 100;
            cents.textContent = `${c >= 0 ? '+' : ''}${c.toFixed(1)} ¢`;
        };
        const parse = (s) => { const v = parseFloat(String(s).replace(',', '.')); return Number.isFinite(v) ? v : NaN; };
        const setBpm = (b) => { if (Number.isFinite(b) && b > 0) m.setParam('bpm', clamp(b, 1, 999)); };
        bpmIn.addEventListener('change', () => setBpm(parse(bpmIn.value)));
        msIn.addEventListener('change', () => {
            let ms = parse(msIn.value);
            if (/s\s*$/i.test(msIn.value) && !/ms\s*$/i.test(msIn.value)) ms *= 1000;
            if (ms > 0) setBpm((60000 * 4 * m.params.div * FEELS[m.params.feel]) / ms);
        });
        hzIn.addEventListener('change', () => { const hz = parse(hzIn.value); if (hz > 0) setBpm((60 * hz) * 4 * m.params.div * FEELS[m.params.feel]); });
        pitchHz.addEventListener('change', () => { const hz = parse(pitchHz.value); if (hz > 0) m.setParam('hz', clamp(hz, 0.001, 24000)); });
        pitchNote.addEventListener('change', () => { const n = parseNote(pitchNote.value); if (n !== null) m.setParam('hz', 440 * Math.pow(2, (n - 69) / 12)); else toast('Write a note like A4, C#3 or Eb5'); });
        divSel.addEventListener('change', () => m.setParam('div', Number(divSel.value)));
        feelSel.addEventListener('change', () => m.setParam('feel', feelSel.value));
        x2.addEventListener('click', () => setBpm(m.params.bpm * 2));
        d2.addEventListener('click', () => setBpm(m.params.bpm / 2));
        tx2.addEventListener('click', () => setBpm(m.params.bpm / 2)); // twice the time = half the tempo
        td2.addEventListener('click', () => setBpm(m.params.bpm * 2));
        x2.title = 'Double the tempo'; d2.title = 'Halve the tempo'; tx2.title = 'Double the time'; td2.title = 'Halve the time';
        // Tap tempo: average of the last few taps.
        let taps = [];
        tap.addEventListener('click', () => {
            const now = performance.now();
            taps = taps.filter((t) => now - t < 2500);
            taps.push(now);
            if (taps.length >= 2) {
                const iv = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
                setBpm(Math.round((60000 / iv) * 100) / 100);
            }
        });
        // Clock input: pulses are read as the selected note value.
        const edge = m.worklet('ma-edge', { numberOfInputs: 1, numberOfOutputs: 0 });
        let last = null, ivs = [];
        edge.port.onmessage = (e) => {
            if (!e.data.on) return;
            if (last !== null) {
                const iv = e.data.t - last;
                if (iv > 0.005 && iv < 10) {
                    ivs.push(iv); if (ivs.length > 4) ivs.shift();
                    const avg = ivs.reduce((a, b) => a + b, 0) / ivs.length;
                    const bpm = Math.round(((60 * 4 * m.params.div * FEELS[m.params.feel]) / avg) * 100) / 100;
                    if (Math.abs(bpm - m.params.bpm) > 0.05) m.setParam('bpm', clamp(bpm, 1, 999));
                }
            }
            last = e.data.t;
        };
        m.addInput('clock', 'Clock', 'gate', edge);
        return {
            update: render,
            refresh: render,
            dispose() { edge.port.onmessage = null; },
        };
    },
});

// =====================================================================  Drum Voice
const DRUM_VOICES = [
    ['kick', 'Kick'], ['snare', 'Snare'], ['chh', 'Closed Hi-hat'], ['ohh', 'Open Hi-hat'], ['clap', 'Clap'], ['tom', 'Tom'],
    ['rim', 'Rimshot'], ['cowbell', 'Cowbell'], ['cymbal', 'Cymbal'], ['conga', 'Conga'], ['shaker', 'Shaker'], ['zap', 'Zap'],
];
registerModule({
    type: 'drum', title: 'Drum Voice', category: 'Sources', blurb: 'Synthesized drums: 12 voices, sample-accurate', width: 210,
    params: {
        voice: { label: 'Voice', default: 'kick', options: DRUM_VOICES.map(([value, label]) => ({ value, label })) },
        tune: { label: 'Tune', min: -24, max: 24, default: 0, step: 0.01, format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)} st` },
        decay: { label: 'Decay', min: 0.1, max: 4, curve: 'log', default: 1, format: (v) => `×${v.toFixed(2)}` },
        tone: { label: 'Tone', min: 0, max: 1, default: 0.5, format: formatPercent, unit: 'ratio' },
        snap: { label: 'Snap / Noise', min: 0, max: 1, default: 0.5, format: formatPercent, unit: 'ratio' },
        sweep: { label: 'Pitch Sweep', min: 0, max: 1, default: 0.5, format: formatPercent, unit: 'ratio' },
        accent: { label: 'Accent Depth', min: 0, max: 1, default: 0.5, format: formatPercent, unit: 'ratio' },
        drive: { label: 'Drive', min: 0, max: 1, default: 0, format: formatPercent, unit: 'ratio' },
        level: { label: 'Level', min: -60, max: 6, default: -3, step: 0.1, format: formatDb, unit: 'dB' },
    },
    create(m, ctx) {
        const node = m.worklet('ma-drum', { numberOfInputs: 4, numberOfOutputs: 1, outputChannelCount: [1] });
        const out = ctx.createGain();
        node.connect(out);
        const led = el('span', { class: 'led' });
        const hit = button('Hit'), soft = button('Soft Hit');
        m.select('voice');
        m.content.append(el('div', { class: 'btn-row' }, hit, soft), el('div', { class: 'info-row' }, el('span', { class: 'node-label', text: 'Trigger' }), led));
        ['tune', 'decay', 'tone', 'snap', 'sweep', 'accent', 'drive', 'level'].forEach((k) => m.slider(k));
        let t = null;
        node.port.onmessage = () => { led.classList.add('on'); clearTimeout(t); t = setTimeout(() => led.classList.remove('on'), 60); };
        hit.addEventListener('click', () => node.port.postMessage({ hit: 1 }));
        soft.addEventListener('click', () => node.port.postMessage({ hit: 0.4 }));
        m.addInput('trig', 'Trig', 'gate', node, { index: 0 });
        m.addInput('accent', 'Accent', 'cv', node, { index: 1 });
        m.addInput('pitch', 'Pitch', 'cv', node, { index: 2 });
        m.addInput('decay', 'Decay', 'cv', node, { index: 3 });
        m.addOutput('out', 'Out', 'audio', out);
        return {
            update(key, v) {
                if (key === 'level') m.set(out.gain, dbToGain(v));
                else if (key === 'voice') node.parameters.get('voice').value = Math.max(0, DRUM_VOICES.findIndex(([k]) => k === v));
                else node.parameters.get(key).value = v;
            },
            dispose() { clearTimeout(t); node.port.onmessage = null; },
        };
    },
});
