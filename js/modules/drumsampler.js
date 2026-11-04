// Drum Sampler: plays drum samples from the repo's kits/ folder (kits/<hardware>/<files>),
// listed by kits/index.json. Playback runs on the audio thread (ma-drumsampler).
import { registerModule } from '../patch.js';
import { audio } from '../audio.js';
import { el, formatTime, formatPercent, formatDb, dbToGain, toast, cssVar } from '../util.js';

const KITS_URL = new URL('../../kits/', import.meta.url);
let kitsP = null;
export function loadKits(force = false) {
    if (!kitsP || force) {
        kitsP = fetch(new URL('index.json', KITS_URL), { cache: 'no-cache' })
            .then((r) => { if (!r.ok) throw new Error(`kits/index.json: HTTP ${r.status}`); return r.json(); })
            .then((j) => (Array.isArray(j.kits) ? j.kits : []))
            .catch((e) => { kitsP = null; throw e; });
    }
    return kitsP;
}
const buffers = new Map(); // url -> Promise<AudioBuffer>
export function sampleUrl(kit, file) { return new URL(`${encodeURIComponent(kit.folder)}/${encodeURIComponent(file)}`, KITS_URL).href; }
function loadBuffer(url) {
    if (!buffers.has(url)) {
        buffers.set(url, fetch(url).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
            .then((b) => audio.ctx.decodeAudioData(b))
            .catch((e) => { buffers.delete(url); throw e; }));
    }
    return buffers.get(url);
}

const stop = (e) => e.stopPropagation();
const button = (text, title) => { const b = el('button', { class: 'param-button', type: 'button', text, title }); b.addEventListener('pointerdown', stop); return b; };
const CHOKE = [{ value: 0, label: 'Off' }, ...'ABCDEFGH'.split('').map((c, i) => ({ value: i + 1, label: `Group ${c}` }))];
const HATS = new Set(['closed hat', 'open hat']);

registerModule({
    type: 'drumsampler', title: 'Drum Sampler', category: 'Sources', blurb: 'Drum machine samples from kits/', width: 240,
    params: {
        kit: { default: '' },
        sample: { default: '' },
        tune: { label: 'Tune', min: -24, max: 24, default: 0, step: 0.01, format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)} st` },
        decay: { label: 'Decay', min: 0.005, max: 10, curve: 'log', default: 10, format: (v) => (v >= 9.99 ? 'Natural' : formatTime(v)), unit: 's' },
        attack: { label: 'Attack', min: 0, max: 0.05, curve: 2, default: 0, format: (v) => (v < 0.0002 ? 'Instant' : formatTime(v)), unit: 's' },
        start: { label: 'Start', min: 0, max: 0.9, curve: 2, default: 0, format: formatPercent, unit: 'ratio' },
        tone: { label: 'Tone (dark ↔ bright)', min: -1, max: 1, default: 0, format: (v) => (Math.abs(v) < 0.005 ? 'Flat' : v < 0 ? `LP ${Math.round(-v * 100)}%` : `HP ${Math.round(v * 100)}%`) },
        drive: { label: 'Drive', min: 0, max: 1, default: 0, format: formatPercent, unit: 'ratio' },
        pan: { label: 'Pan', min: -1, max: 1, default: 0, format: (v) => (Math.abs(v) < 0.005 ? 'Centre' : `${v < 0 ? 'L' : 'R'} ${Math.round(Math.abs(v) * 100)}%`) },
        velocity: { label: 'Accent Depth', min: 0, max: 1, default: 0.5, format: formatPercent, unit: 'ratio' },
        level: { label: 'Level', min: -60, max: 6, default: -3, step: 0.1, format: formatDb, unit: 'dB' },
        reverse: { label: 'Direction', default: 'fwd', options: [{ value: 'fwd', label: 'Forward' }, { value: 'rev', label: 'Reverse' }] },
        mode: { label: 'Retrigger', default: 'mono', options: [{ value: 'mono', label: 'Mono (cut)' }, { value: 'poly', label: 'Poly (overlap)' }] },
        choke: { label: 'Choke Group', default: 0, options: CHOKE },
        preview: { label: 'Preview on Select', default: 'on', options: [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }] },
    },
    create(m, ctx) {
        const node = m.worklet('ma-drumsampler', { numberOfInputs: 3, numberOfOutputs: 1, outputChannelCount: [2] });
        const out = ctx.createGain();
        node.connect(out);
        // Keep the processor running even when unpatched, so choke groups and timing never depend on cabling.
        const keepAlive = ctx.createGain(); keepAlive.gain.value = 0;
        node.connect(keepAlive).connect(ctx.destination);
        const P = (k) => node.parameters.get(k);
        // --- kit / sample pickers
        const kitSel = el('select', { title: 'Kit' }), smpSel = el('select', { title: 'Sample' });
        [kitSel, smpSel].forEach((s) => s.addEventListener('pointerdown', stop));
        const prev = button('◀', 'Previous sample'), next = button('▶', 'Next sample');
        const canvas = el('canvas', { class: 'display', width: 452, height: 100, style: { height: '50px' } });
        const info = el('span', { class: 'node-label', text: 'Loading kits…' });
        const led = el('span', { class: 'led' });
        const hit = button('Hit'), soft = button('Soft');
        const pick = (label, ...kids) => el('div', { class: 'param-container' }, el('div', { class: 'param-header' }, el('label', { class: 'param-label', text: label })), ...kids);
        m.content.append(pick('Kit', kitSel), pick('Sample', el('div', { class: 'sample-pick' }, prev, smpSel, next)),
            canvas, el('div', { class: 'info-row' }, info, led), el('div', { class: 'btn-row' }, hit, soft));
        ['tune', 'decay', 'attack', 'start', 'tone', 'drive', 'pan', 'velocity', 'level'].forEach((k) => m.slider(k));
        const grid = el('div', { class: 'two-col' });
        m.content.append(grid);
        ['reverse', 'mode', 'choke', 'preview'].forEach((k) => m.select(k, grid));
        // A choke group the user picks is never overridden by hat auto-grouping.
        m.controls.choke.el.querySelector('select').addEventListener('change', () => { userChoke = true; });

        let kits = [], buf = null, loadToken = 0, userChoke = m.params.choke !== 0;
        const kitObj = () => kits.find((k) => k.folder === m.params.kit);
        const smpObj = () => kitObj()?.samples.find((s) => s.file === m.params.sample);
        const fillKits = () => {
            kitSel.replaceChildren(...(kits.length ? kits.map((k) => el('option', { value: k.folder, text: k.name })) : [el('option', { value: '', text: 'No kits found' })]));
            if (m.params.kit && !kitObj()) kitSel.append(el('option', { value: m.params.kit, text: `${m.params.kit} (missing)` }));
            kitSel.value = m.params.kit;
        };
        const fillSamples = () => {
            const k = kitObj();
            smpSel.replaceChildren(...(k ? k.samples.map((s) => el('option', { value: s.file, text: s.name })) : []));
            if (m.params.sample && !smpObj()) smpSel.append(el('option', { value: m.params.sample, text: `${m.params.sample} (missing)` }));
            smpSel.value = m.params.sample;
        };
        const draw = () => {
            const g = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
            g.clearRect(0, 0, W, H);
            if (!buf) return;
            const d = buf.getChannelData(0), step = d.length / W;
            g.fillStyle = cssVar('--display-line');
            for (let x = 0; x < W; x++) {
                let pk = 0;
                for (let i = Math.floor(x * step); i < Math.floor((x + 1) * step); i += 2) pk = Math.max(pk, Math.abs(d[i] || 0));
                const h = Math.max(1, pk * (H - 4));
                g.fillRect(m.params.reverse === 'rev' ? W - 1 - x : x, H / 2 - h / 2, 1, h);
            }
            g.fillStyle = 'rgba(0,0,0,0.55)';
            const sx = m.params.start * W;
            if (m.params.reverse === 'rev') g.fillRect(W - sx, 0, sx, H); else g.fillRect(0, 0, sx, H);
        };
        const describe = () => {
            const s = smpObj();
            if (!kits.length) return;
            info.textContent = !s ? 'Sample missing from this kit' : buf ? `${s.category} · ${buf.duration.toFixed(2)} s${buf.numberOfChannels > 1 ? ' · stereo' : ''}` : 'Loading…';
        };
        const loadSample = async (audition) => {
            const k = kitObj(), s = smpObj(), token = ++loadToken;
            buf = null; describe(); draw();
            node.port.postMessage({ sample: null });
            if (!k || !s) return;
            try {
                const b = await loadBuffer(sampleUrl(k, s.file));
                if (token !== loadToken) return;
                buf = b;
                // Copies, so the shared decoded buffer stays intact for other modules.
                const chans = Array.from({ length: Math.min(2, b.numberOfChannels) }, (_, c) => b.getChannelData(c).slice());
                node.port.postMessage({ sample: chans }, chans.map((c) => c.buffer));
                describe(); draw();
                if (audition && m.params.preview === 'on') setTimeout(() => node.port.postMessage({ hit: 0.8 }), 20);
            } catch (e) {
                if (token === loadToken) { info.textContent = `Couldn’t load ${s.file}`; toast(`Couldn’t load ${k.name} / ${s.file}: ${e.message}`, 4000); }
            }
        };
        const chooseSample = (file, audition = true) => {
            m.setParam('sample', file, false);
            // Hats default to a shared choke group so a closed hat cuts an open one.
            const s = smpObj();
            if (s && HATS.has(s.category) && !userChoke && m.params.choke === 0) m.setParam('choke', 1);
            fillSamples();
            loadSample(audition);
            m.patch.changed();
        };
        kitSel.addEventListener('change', () => {
            m.setParam('kit', kitSel.value, false);
            const k = kitObj();
            // Keep the same kind of drum when switching kits, if the new kit has one.
            const cat = smpObj()?.category || kits.flatMap((x) => x.samples).find((x) => x.file === m.params.sample)?.category;
            const same = k?.samples.find((x) => x.category === cat) || k?.samples[0];
            chooseSample(same ? same.file : '');
        });
        smpSel.addEventListener('change', () => chooseSample(smpSel.value));
        const stepSample = (d) => {
            const k = kitObj();
            if (!k || !k.samples.length) return;
            const i = k.samples.findIndex((s) => s.file === m.params.sample);
            chooseSample(k.samples[(i + d + k.samples.length) % k.samples.length].file);
        };
        prev.addEventListener('click', () => stepSample(-1));
        next.addEventListener('click', () => stepSample(1));
        hit.addEventListener('click', () => node.port.postMessage({ hit: 1 }));
        soft.addEventListener('click', () => node.port.postMessage({ hit: 0.4 }));
        let ledT = null;
        node.port.onmessage = () => { led.classList.add('on'); clearTimeout(ledT); ledT = setTimeout(() => led.classList.remove('on'), 60); };
        loadKits().then((list) => {
            kits = list;
            // Default to the first kit (or the kit that holds the chosen sample); keep a sample that exists there.
            if (!m.params.kit && kits.length) m.params.kit = (kits.find((k) => k.samples.some((x) => x.file === m.params.sample)) || kits[0]).folder;
            const k0 = kitObj();
            if (k0 && !k0.samples.some((x) => x.file === m.params.sample)) m.params.sample = k0.samples[0]?.file || '';
            fillKits(); fillSamples();
            if (!kits.length) info.textContent = 'No kits yet: add folders to kits/';
            loadSample(false);
        }).catch((e) => { fillKits(); info.textContent = 'kits/index.json not found'; console.warn(e); });

        m.addInput('trig', 'Trig', 'gate', node, { index: 0 });
        m.addInput('accent', 'Accent', 'cv', node, { index: 1 });
        m.addInput('pitch', 'Pitch', 'cv', node, { index: 2 });
        m.addOutput('out', 'Out', 'audio', out);
        return {
            update(key, v) {
                switch (key) {
                    case 'level': m.set(out.gain, dbToGain(v)); break;
                    case 'reverse': P('reverse').value = v === 'rev' ? 1 : 0; draw(); break;
                    case 'mode': P('mono').value = v === 'mono' ? 1 : 0; break;
                    case 'choke': P('choke').value = Number(v); break;
                    case 'start': P('start').value = v; draw(); break;
                    case 'kit': case 'sample': if (kits.length) { fillKits(); fillSamples(); loadSample(false); } break;
                    case 'preview': break;
                    default: if (node.parameters.has(key)) P(key).value = v;
                }
            },
            refresh() { draw(); },
            dispose() { clearTimeout(ledT); node.port.onmessage = null; try { keepAlive.disconnect(); } catch (e) {} },
        };
    },
});
