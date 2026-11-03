// Timing: Clock, Sequencer.
import { registerModule } from '../patch.js';
import { el, midiToName, clamp } from '../util.js';

registerModule({
    type: 'clock', title: 'Clock', category: 'Sequencing', blurb: 'Tempo source with divided outputs',
    params: {
        run: { default: 1 },
        bpm: { label: 'Tempo', min: 20, max: 300, default: 120, step: 0.1, format: (v) => `${v.toFixed(1)} BPM` },
        div: { label: 'Rate', default: 4, options: [{ value: 1, label: '1/4 notes' }, { value: 2, label: '1/8 notes' }, { value: 3, label: '1/8 triplets' }, { value: 4, label: '1/16 notes' }] },
        swing: { label: 'Swing', min: 0, max: 0.6, default: 0, format: (v) => `${Math.round(v * 100)}%` },
    },
    create(m, ctx) {
        const node = new AudioWorkletNode(ctx, 'ma-clock', { numberOfInputs: 1, numberOfOutputs: 3, outputChannelCount: [1, 1, 1] });
        const led = el('span', { class: 'led' });
        const runBtn = el('button', { class: 'param-button', type: 'button' });
        const resetBtn = el('button', { class: 'param-button', type: 'button', text: 'Reset' });
        m.content.append(el('div', { class: 'btn-row' }, runBtn, resetBtn));
        m.content.append(el('div', { class: 'info-row' }, el('span', { class: 'node-label', text: 'Tick' }), led));
        m.slider('bpm');
        m.select('div');
        m.slider('swing');
        [runBtn, resetBtn].forEach((b) => b.addEventListener('pointerdown', (e) => e.stopPropagation()));
        runBtn.addEventListener('click', () => m.setParam('run', m.params.run ? 0 : 1));
        resetBtn.addEventListener('click', () => node.port.postMessage('reset'));
        let off = null;
        node.port.onmessage = () => {
            led.classList.add('on');
            clearTimeout(off);
            off = setTimeout(() => led.classList.remove('on'), 50);
        };
        m.addInput('reset', 'Reset', 'gate', node);
        m.addOutput('x1', 'Clock', 'gate', node, { index: 0 });
        m.addOutput('d2', '÷2', 'gate', node, { index: 1 });
        m.addOutput('d4', '÷4', 'gate', node, { index: 2 });
        const p = (k) => node.parameters.get(k);
        return {
            update(key, v) {
                if (key === 'run') {
                    p('run').value = v ? 1 : 0;
                    runBtn.textContent = v ? 'Stop' : 'Run';
                    runBtn.classList.toggle('active', !!v);
                    if (!v) node.port.postMessage('reset');
                }
                if (key === 'bpm') p('bpm').value = v;
                if (key === 'div') p('div').value = Number(v);
                if (key === 'swing') p('swing').value = v;
            },
            dispose() { node.port.onmessage = null; clearTimeout(off); },
        };
    },
});

const DEFAULT_STEPS = [0, 3, 7, 10, 12, 10, 7, 3, 0, 5, 7, 12, 15, 12, 7, 5].map((note, i) => ({ note, on: i < 8 }));

registerModule({
    type: 'sequencer', title: 'Sequencer', category: 'Sequencing', blurb: '16-step pitch and gate sequencer',
    width: 272,
    params: {
        steps: { default: DEFAULT_STEPS },
        length: { label: 'Length', min: 1, max: 16, default: 8, step: 1, format: (v) => `${v} steps` },
        gateLen: { label: 'Gate Length', min: 0.05, max: 1, default: 0.5, format: (v) => `${Math.round(v * 100)}%` },
        transpose: { label: 'Transpose', min: -24, max: 24, default: 0, step: 1, format: (v) => `${v > 0 ? '+' : ''}${v} st` },
    },
    create(m, ctx) {
        const node = new AudioWorkletNode(ctx, 'ma-sequencer', { numberOfInputs: 2, numberOfOutputs: 2, outputChannelCount: [1, 1] });
        let selected = 0;
        let playing = -1;
        const grid = el('div', { class: 'steps' });
        const stepEls = [];
        for (let i = 0; i < 16; i++) {
            const s = el('button', { class: 'step', type: 'button', title: `Step ${i + 1}` },
                el('span', { class: 'step-bar' }), el('span', { class: 'step-num', text: String(i + 1) }));
            stepEls.push(s);
            grid.append(s);
        }
        const noteLabel = el('div', { class: 'step-note' });
        const gateBtn = el('button', { class: 'param-button', type: 'button' });
        const randBtn = el('button', { class: 'param-button', type: 'button', text: 'Random' });
        const clearBtn = el('button', { class: 'param-button', type: 'button', text: 'Clear' });
        m.content.append(grid, noteLabel, el('div', { class: 'btn-row' }, gateBtn, randBtn, clearBtn));
        m.slider('length');
        m.slider('gateLen');
        m.slider('transpose');

        const steps = () => m.params.steps;
        const commit = (arr) => { m.setParam('steps', arr.map((s) => ({ ...s }))); };
        const send = () => node.port.postMessage({
            steps: steps().map((s) => ({ note: s.note + m.params.transpose, on: s.on })),
            length: m.params.length, gateLen: m.params.gateLen,
        });
        const render = () => {
            const arr = steps();
            stepEls.forEach((s, i) => {
                const st = arr[i];
                s.classList.toggle('on', st.on);
                s.classList.toggle('selected', i === selected);
                s.classList.toggle('playing', i === playing);
                s.classList.toggle('disabled', i >= m.params.length);
                s.firstChild.style.height = `${clamp((st.note + 24) / 48, 0.04, 1) * 100}%`;
            });
            const st = arr[selected];
            noteLabel.textContent = `Step ${selected + 1}: ${midiToName(60 + st.note + m.params.transpose)} (${st.note >= 0 ? '+' : ''}${st.note} st)`;
            gateBtn.textContent = st.on ? 'Gate On' : 'Gate Off';
            gateBtn.classList.toggle('active', st.on);
        };
        // Tap selects a step (tap again to toggle its gate); drag up/down sets its pitch.
        let drag = null;
        grid.addEventListener('pointerdown', (e) => {
            const s = e.target.closest('.step');
            if (!s) return;
            e.stopPropagation();
            e.preventDefault();
            grid.setPointerCapture(e.pointerId);
            const i = stepEls.indexOf(s);
            drag = { id: e.pointerId, i, y: e.clientY, start: steps()[i].note, moved: false, wasSelected: i === selected };
            selected = i;
            render();
        });
        grid.addEventListener('pointermove', (e) => {
            if (!drag || e.pointerId !== drag.id) return;
            const dy = drag.y - e.clientY;
            if (!drag.moved && Math.abs(dy) < 4) return;
            drag.moved = true;
            const n = clamp(Math.round(drag.start + dy / (e.shiftKey ? 24 : 6)), -24, 24);
            if (n !== steps()[drag.i].note) { const arr = steps().map((x) => ({ ...x })); arr[drag.i].note = n; commit(arr); }
        });
        const up = (e) => {
            if (!drag || e.pointerId !== drag.id) return;
            if (!drag.moved && drag.wasSelected) { const arr = steps().map((x) => ({ ...x })); arr[drag.i].on = !arr[drag.i].on; commit(arr); }
            drag = null;
        };
        grid.addEventListener('pointerup', up);
        grid.addEventListener('pointercancel', up);
        [gateBtn, randBtn, clearBtn].forEach((b) => b.addEventListener('pointerdown', (e) => e.stopPropagation()));
        gateBtn.addEventListener('click', () => { const arr = steps().map((x) => ({ ...x })); arr[selected].on = !arr[selected].on; commit(arr); });
        randBtn.addEventListener('click', () => {
            const scale = [0, 2, 3, 5, 7, 8, 10, 12, 14, 15];
            commit(steps().map((s, i) => (i < m.params.length ? { note: scale[Math.floor(Math.random() * scale.length)], on: Math.random() > 0.25 } : s)));
        });
        clearBtn.addEventListener('click', () => commit(steps().map(() => ({ note: 0, on: true }))));
        node.port.onmessage = (e) => { playing = e.data; render(); };

        m.addInput('clock', 'Clock', 'gate', node, { index: 0 });
        m.addInput('reset', 'Reset', 'gate', node, { index: 1 });
        m.addOutput('pitch', 'Pitch', 'cv', node, { index: 0 });
        m.addOutput('gate', 'Gate', 'gate', node, { index: 1 });
        return {
            update(key) {
                if (key === 'steps' && (!Array.isArray(m.params.steps) || m.params.steps.length !== 16)) {
                    m.params.steps = DEFAULT_STEPS.map((s) => ({ ...s }));
                }
                selected = Math.min(selected, 15);
                send();
                render();
            },
            dispose() { node.port.onmessage = null; },
        };
    },
});
