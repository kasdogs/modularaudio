// MIDI In, Recorder (48 kHz WAV), Drum Voice, Granular sampler.
import { registerModule } from '../patch.js';
import { el, clamp, formatTime, formatPercent, formatDb, dbToGain, setMeter, toast, midiToName, cssVar } from '../util.js';
import { requestMIDI, listInputs, onDevices, subscribe, midiSupported } from '../midi.js';
import { storeSample, getSample, librarySelect } from '../samples.js';

const stop = (e) => e.stopPropagation();
const button = (text, cls = 'param-button') => { const b = el('button', { class: cls, type: 'button', text }); b.addEventListener('pointerdown', stop); return b; };
const constant = (ctx, v = 0) => { const c = ctx.createConstantSource(); c.offset.value = v; c.start(); return c; };
// Reads the most recent value of a control signal on the main thread.
function cvReader(ctx) {
    const input = ctx.createGain(), an = ctx.createAnalyser();
    an.fftSize = 32;
    input.connect(an);
    const buf = new Float32Array(32);
    return { input, read() { an.getFloatTimeDomainData(buf); return buf[31]; } };
}

// =====================================================================  MIDI In
registerModule({
    type: 'midiin', title: 'MIDI In', category: 'Sources', blurb: 'Play from a MIDI keyboard or controller', width: 220,
    params: {
        device: { default: 'all' },
        channel: { label: 'Channel', default: 0, options: [{ value: 0, label: 'Omni (all)' }, ...Array.from({ length: 16 }, (_, i) => ({ value: i + 1, label: `Channel ${i + 1}` }))] },
        voices: { label: 'Polyphony group', default: 1, options: Array.from({ length: 8 }, (_, i) => ({ value: i + 1, label: i ? `${i + 1} voices` : 'Mono (1 voice)' })) },
        voice: { label: 'This module plays', default: 1, options: Array.from({ length: 8 }, (_, i) => ({ value: i + 1, label: `Voice ${i + 1}` })) },
        bend: { label: 'Pitch-bend Range', min: 0, max: 24, default: 2, step: 1, format: (v) => `±${v} st` },
        cc: { label: 'CC Number', min: 0, max: 127, default: 1, step: 1, format: (v) => (v === 1 ? '1 (mod wheel)' : String(v)) },
        clockDiv: { label: 'Clock Out', default: 6, options: [{ value: 24, label: '1/4 notes' }, { value: 12, label: '1/8 notes' }, { value: 6, label: '1/16 notes' }, { value: 1, label: '24 PPQN (raw)' }] },
    },
    create(m, ctx) {
        const pitch = constant(ctx), gate = constant(ctx), vel = constant(ctx), cc = constant(ctx), press = constant(ctx), clock = constant(ctx), reset = constant(ctx);
        const devSel = el('select', { title: 'MIDI input device' });
        devSel.addEventListener('pointerdown', stop);
        const status = el('span', { class: 'node-label', text: '' });
        const noteLabel = el('strong', { text: '—' });
        const devBox = el('div', { class: 'param-container' }, el('div', { class: 'param-header' }, el('label', { class: 'param-label', text: 'Device' })), devSel);
        m.content.append(devBox, el('div', { class: 'info-row' }, status, noteLabel));
        m.select('channel'); m.select('voices'); m.select('voice'); m.slider('bend'); m.slider('cc'); m.select('clockDiv');
        const fillDevices = (names = listInputs()) => {
            const want = m.params.device;
            const opts = [{ value: 'all', label: 'All devices' }, ...names.map((n) => ({ value: n, label: n }))];
            if (want !== 'all' && !names.includes(want)) opts.push({ value: want, label: `${want} (not connected)` });
            devSel.replaceChildren(...opts.map((o) => el('option', { value: o.value, text: o.label })));
            devSel.value = want;
            status.textContent = names.length ? `${names.length} device${names.length > 1 ? 's' : ''}` : 'No devices found';
        };
        devSel.addEventListener('change', () => m.setParam('device', devSel.value));
        let offDev = null;
        if (!midiSupported()) { fillDevices([]); status.textContent = 'No Web MIDI in this browser'; }
        else {
            status.textContent = 'Requesting MIDI access…';
            requestMIDI().then(() => { fillDevices(); offDev = onDevices(fillDevices); })
                .catch((e) => { fillDevices([]); status.textContent = 'MIDI access denied'; toast(`${e.message || 'MIDI access was denied'} · allow MIDI for this site in the browser's site settings`, 5000); });
        }
        const at = (t) => Math.max(ctx.currentTime, ctx.currentTime + (t - performance.now()) / 1000 + 0.004);
        const stack = [];
        let bendV = 0, ticks = 0;
        const setPitch = (note, t) => { pitch.offset.setValueAtTime((note - 60) / 12 + (bendV * m.params.bend) / 12, t); };
        const sub = {
            get device() { return m.params.device; }, get channel() { return Number(m.params.channel); },
            get voices() { return Number(m.params.voices); }, get voice() { return Number(m.params.voice); },
            onMessage(msg) {
                const t = at(msg.t);
                switch (msg.type) {
                    case 'on': {
                        const retrig = stack.length > 0;
                        const i = stack.indexOf(msg.note); if (i >= 0) stack.splice(i, 1);
                        stack.push(msg.note);
                        setPitch(msg.note, t);
                        vel.offset.setValueAtTime(msg.vel, t);
                        if (retrig) gate.offset.setValueAtTime(0, t);
                        gate.offset.setValueAtTime(1, t + (retrig ? 0.002 : 0));
                        noteLabel.textContent = midiToName(msg.note);
                        break;
                    }
                    case 'off': {
                        const i = stack.indexOf(msg.note); if (i < 0) break;
                        stack.splice(i, 1);
                        if (stack.length) setPitch(stack[stack.length - 1], t); else gate.offset.setValueAtTime(0, t);
                        break;
                    }
                    case 'bend': bendV = msg.value; if (stack.length) setPitch(stack[stack.length - 1], t); break;
                    case 'cc': if (msg.cc === m.params.cc) cc.offset.setValueAtTime(msg.value, t); if (msg.cc === 123 || msg.cc === 120) { stack.length = 0; gate.offset.setValueAtTime(0, t); } break;
                    case 'pressure': press.offset.setValueAtTime(msg.value, t); break;
                    case 'start': ticks = 0; reset.offset.setValueAtTime(1, t); reset.offset.setValueAtTime(0, t + 0.005); break;
                    case 'stop': clock.offset.setValueAtTime(0, t); break;
                    case 'clock': {
                        const d = Number(m.params.clockDiv);
                        const ph = ticks % d;
                        if (ph === 0) clock.offset.setValueAtTime(1, t);
                        if (d === 1) clock.offset.setValueAtTime(0, t + 0.004);
                        else if (ph === Math.floor(d / 2)) clock.offset.setValueAtTime(0, t);
                        ticks++;
                        break;
                    }
                }
            },
        };
        const unsub = subscribe(sub);
        m.addOutput('pitch', 'Pitch', 'cv', pitch);
        m.addOutput('gate', 'Gate', 'gate', gate);
        m.addOutput('vel', 'Velocity', 'cv', vel);
        m.addOutput('cc', 'CC', 'cv', cc);
        m.addOutput('press', 'Pressure', 'cv', press);
        m.addOutput('clock', 'Clock', 'gate', clock);
        m.addOutput('reset', 'Start', 'gate', reset);
        return {
            update(key, v) {
                if (key === 'device') { if (devSel.options.length) fillDevices(); stack.length = 0; gate.offset.setValueAtTime(0, ctx.currentTime); }
            },
            dispose() { unsub(); offDev && offDev(); [pitch, gate, vel, cc, press, clock, reset].forEach((c) => { try { c.stop(); } catch (e) {} }); },
        };
    },
});

// =====================================================================  Recorder
function encodeWav(channels, sampleRate, depth) {
    const nCh = channels.length, len = channels[0].length;
    const bytes = depth === 32 ? 4 : depth / 8;
    const dataLen = len * nCh * bytes;
    const buf = new ArrayBuffer(44 + dataLen);
    const v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true);
    v.setUint16(20, depth === 32 ? 3 : 1, true); // 3 = IEEE float, 1 = PCM
    v.setUint16(22, nCh, true); v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * nCh * bytes, true); v.setUint16(32, nCh * bytes, true); v.setUint16(34, depth, true);
    str(36, 'data'); v.setUint32(40, dataLen, true);
    let o = 44;
    for (let i = 0; i < len; i++) {
        for (let c = 0; c < nCh; c++) {
            const x = Math.max(-1, Math.min(1, channels[c][i]));
            if (depth === 32) { v.setFloat32(o, channels[c][i], true); o += 4; }
            else if (depth === 24) { const s = Math.round(x * 8388607); v.setUint8(o, s & 255); v.setUint8(o + 1, (s >> 8) & 255); v.setUint8(o + 2, (s >> 16) & 255); o += 3; }
            else { v.setInt16(o, Math.round(x * 32767), true); o += 2; }
        }
    }
    return new Blob([buf], { type: 'audio/wav' });
}
// Resample to exactly 48 kHz with the browser's own high-quality resampler.
async function to48k(chs, rate) {
    if (rate === 48000) return chs;
    const len = chs[0].length;
    const src = new OfflineAudioContext(chs.length, len, rate).createBuffer(chs.length, len, rate);
    chs.forEach((d, i) => src.copyToChannel(d, i));
    const off = new OfflineAudioContext(chs.length, Math.ceil((len * 48000) / rate), 48000);
    const s = off.createBufferSource();
    s.buffer = src;
    s.connect(off.destination);
    s.start();
    const r = await off.startRendering();
    return Array.from({ length: chs.length }, (_, i) => r.getChannelData(i));
}

registerModule({
    type: 'recorder', title: 'Recorder', category: 'Utilities', blurb: 'Records its input to a 48 kHz WAV file', width: 210,
    params: {
        channels: { label: 'Channels', default: 'stereo', options: [{ value: 'stereo', label: 'Stereo' }, { value: 'mono', label: 'Mono (summed)' }] },
        depth: { label: 'Bit Depth', default: 24, options: [{ value: 16, label: '16-bit PCM' }, { value: 24, label: '24-bit PCM' }, { value: 32, label: '32-bit float' }] },
        limit: { label: 'Auto-stop After', default: 30, options: [{ value: 5, label: '5 minutes' }, { value: 10, label: '10 minutes' }, { value: 30, label: '30 minutes' }, { value: 60, label: '60 minutes' }] },
        gateMode: { label: 'Rec Gate Input', default: 'hold', options: [{ value: 'hold', label: 'Record while high' }, { value: 'toggle', label: 'Each gate toggles' }] },
    },
    create(m, ctx) {
        const node = m.worklet('ma-recorder', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
        const edge = m.worklet('ma-edge', { numberOfInputs: 1, numberOfOutputs: 0 });
        const recBtn = button('● Record', 'param-button rec-btn');
        const again = button('Download Again');
        again.disabled = true;
        const time = el('strong', { text: '0:00.0' }), size = el('span', { class: 'node-label', text: '48 kHz WAV' });
        const meter = el('div', { class: 'meter' }, el('div', { class: 'meter-fill' }));
        m.content.append(el('div', { class: 'btn-row' }, recBtn), el('div', { class: 'info-row' }, time, size), meter);
        m.select('channels'); m.select('depth'); m.select('limit'); m.select('gateMode');
        m.content.append(el('div', { class: 'btn-row' }, again));
        let chunksL = [], chunksR = [], frames = 0, recording = false, startedAt = 0, peak = 0, lastBlob = null, lastName = '', finishing = null;
        node.port.onmessage = (e) => {
            const { l, r, done } = e.data;
            if (l.length) {
                chunksL.push(l); chunksR.push(r); frames += l.length;
                for (let i = 0; i < l.length; i += 8) peak = Math.max(peak, Math.abs(l[i]), Math.abs(r[i]));
            }
            if (done && finishing) finishing();
        };
        const fmtT = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
        const start = () => {
            if (recording) return;
            chunksL = []; chunksR = []; frames = 0; peak = 0;
            recording = true; startedAt = ctx.currentTime;
            node.port.postMessage('start');
            recBtn.textContent = '■ Stop'; recBtn.classList.add('active', 'recording');
        };
        const stopRec = async () => {
            if (!recording) return;
            recording = false;
            recBtn.textContent = '● Record'; recBtn.classList.remove('active', 'recording');
            await new Promise((res) => { finishing = res; node.port.postMessage('stop'); setTimeout(res, 1500); });
            finishing = null;
            if (!frames) { toast('Nothing was recorded'); return; }
            size.textContent = 'Encoding…';
            const join = (parts) => { const out = new Float32Array(frames); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
            let chs = [join(chunksL), join(chunksR)];
            if (m.params.channels === 'mono') { const mono = new Float32Array(frames); for (let i = 0; i < frames; i++) mono[i] = (chs[0][i] + chs[1][i]) * 0.5; chs = [mono]; }
            chs = await to48k(chs, ctx.sampleRate);
            lastBlob = encodeWav(chs, 48000, Number(m.params.depth));
            const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
            lastName = `modularaudio-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.wav`;
            save();
            again.disabled = false;
            size.textContent = `${(lastBlob.size / 1048576).toFixed(1)} MB · 48 kHz`;
            chunksL = []; chunksR = [];
        };
        const save = () => {
            if (!lastBlob) return;
            const a = el('a', { href: URL.createObjectURL(lastBlob), download: lastName });
            document.body.append(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        };
        recBtn.addEventListener('click', () => (recording ? stopRec() : start()));
        again.addEventListener('click', save);
        edge.port.onmessage = (e) => {
            if (m.params.gateMode === 'toggle') { if (e.data.on) (recording ? stopRec() : start()); }
            else if (e.data.on) start(); else stopRec();
        };
        let f = 0;
        m.animate(() => {
            if (!recording) { setMeter(meter.firstChild, 0); return; }
            const s = ctx.currentTime - startedAt;
            time.textContent = fmtT(s);
            if (++f % 15 === 0) size.textContent = `${((frames * (m.params.channels === 'mono' ? 1 : 2) * (Number(m.params.depth) / 8) * 48000) / ctx.sampleRate / 1048576).toFixed(1)} MB`;
            setMeter(meter.firstChild, peak > 1e-5 ? (20 * Math.log10(peak) + 48) / 48 : 0);
            peak *= 0.85;
            if (s > m.params.limit * 60) { stopRec(); toast(`Recording stopped at the ${m.params.limit}-minute limit`); }
        });
        m.addInput('in', 'In', 'audio', node);
        m.addInput('rec', 'Rec', 'gate', edge);
        m.addOutput('out', 'Thru', 'audio', node);
        return { dispose() { if (recording) stopRec(); } };
    },
});

// =====================================================================  Drum Voice
const noiseCache = new WeakMap();
function noise(ctx) {
    let b = noiseCache.get(ctx);
    if (!b) {
        b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
        const d = b.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
        noiseCache.set(ctx, b);
    }
    return b;
}
const DRUMS = [
    { value: 'kick', label: 'Kick' }, { value: 'snare', label: 'Snare' }, { value: 'chh', label: 'Closed Hi-hat' }, { value: 'ohh', label: 'Open Hi-hat' },
    { value: 'clap', label: 'Clap' }, { value: 'tom', label: 'Tom' }, { value: 'rim', label: 'Rimshot' }, { value: 'cowbell', label: 'Cowbell' },
];
registerModule({
    type: 'drum', title: 'Drum Voice', category: 'Sources', blurb: 'Synthesized kick, snare, hats, clap and more', width: 210,
    params: {
        voice: { label: 'Voice', default: 'kick', options: DRUMS },
        tune: { label: 'Tune', min: -24, max: 24, default: 0, step: 0.01, format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)} st` },
        decay: { label: 'Decay', min: 0.2, max: 4, curve: 'log', default: 1, format: (v) => `×${v.toFixed(2)}` },
        tone: { label: 'Tone', min: 0, max: 1, default: 0.5, format: formatPercent, unit: 'ratio' },
        snap: { label: 'Snap / Noise', min: 0, max: 1, default: 0.5, format: formatPercent, unit: 'ratio' },
        drive: { label: 'Drive', min: 0, max: 1, default: 0, format: formatPercent, unit: 'ratio' },
        level: { label: 'Level', min: -60, max: 6, default: -3, step: 0.1, format: formatDb, unit: 'dB' },
    },
    create(m, ctx) {
        const bus = ctx.createGain(), shaper = ctx.createWaveShaper(), out = ctx.createGain();
        shaper.oversample = '2x';
        bus.connect(shaper).connect(out);
        const edge = m.worklet('ma-edge', { numberOfInputs: 1, numberOfOutputs: 0 });
        const accent = cvReader(ctx), pitchCv = cvReader(ctx);
        const led = el('span', { class: 'led' });
        const hit = button('Hit');
        m.select('voice');
        m.content.append(el('div', { class: 'btn-row' }, hit), el('div', { class: 'info-row' }, el('span', { class: 'node-label', text: 'Trigger' }), led));
        ['tune', 'decay', 'tone', 'snap', 'drive', 'level'].forEach((k) => m.slider(k));
        let open = null; // open hi-hat voice, choked by a closed hat
        const env = (g, t, peak, dec, attack = 0.001) => {
            g.gain.setValueAtTime(0, t);
            g.gain.linearRampToValueAtTime(peak, t + attack);
            g.gain.exponentialRampToValueAtTime(0.0001, t + attack + dec);
        };
        const osc = (type, f, t, end) => { const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, t); o.start(t); o.stop(end); return o; };
        const nz = (t, end) => { const s = ctx.createBufferSource(); s.buffer = noise(ctx); s.loop = true; s.start(t, Math.random() * 0.9); s.stop(end); return s; };
        const filt = (type, f, q = 0.7) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; };
        const trigger = (t, velocity = 1) => {
            const P = m.params, pm = Math.pow(2, (P.tune + pitchCv.read() * 12) / 12), D = P.decay, T = P.tone, S = P.snap;
            const v = clamp(velocity + accent.read(), 0.05, 2);
            const voice = ctx.createGain(); voice.connect(bus);
            let end = t + 0.1;
            const add = (src, g) => { src.connect(g); g.connect(voice); };
            switch (P.voice) {
                case 'kick': {
                    const dec = 0.45 * D; end = t + dec + 0.05;
                    const o = osc('sine', 50 * pm * (3 + S * 6), t, end), g = ctx.createGain();
                    o.frequency.exponentialRampToValueAtTime(48 * pm, t + 0.02 + 0.08 * (1 - T));
                    env(g, t, v, dec); add(o, g);
                    const c = nz(t, t + 0.02), cg = ctx.createGain(), hp = filt('highpass', 2500);
                    c.connect(hp); env(cg, t, 0.5 * S * v, 0.008); add(hp, cg);
                    break;
                }
                case 'snare': {
                    const dec = 0.2 * D; end = t + dec + 0.05;
                    for (const f of [185, 330]) { const o = osc('triangle', f * pm, t, end), g = ctx.createGain(); o.frequency.exponentialRampToValueAtTime(f * pm * 0.8, t + 0.05); env(g, t, 0.5 * v * (1 - S * 0.5), 0.12 * D); add(o, g); }
                    const n = nz(t, end), bp = filt('highpass', 1200 + T * 4000), g = ctx.createGain();
                    n.connect(bp); env(g, t, (0.4 + S * 0.8) * v, dec); add(bp, g);
                    break;
                }
                case 'chh': case 'ohh': {
                    const dec = (P.voice === 'chh' ? 0.05 : 0.45) * D; end = t + dec + 0.05;
                    if (open) { open.gain.cancelScheduledValues(t); open.gain.setTargetAtTime(0, t, 0.005); open = null; } // choke
                    const mix = ctx.createGain(); mix.gain.value = 0.18;
                    for (const r of [205.3, 304.4, 369.6, 522.7, 540, 800]) osc('square', r * pm * (1.3 + T), t, end).connect(mix);
                    const bp = filt('bandpass', 10000, 0.8), hp = filt('highpass', 7000), g = ctx.createGain();
                    mix.connect(bp).connect(hp);
                    const n = nz(t, end); const ng = ctx.createGain(); ng.gain.value = S * 0.6; n.connect(ng).connect(hp);
                    env(g, t, v, dec); add(hp, g);
                    if (P.voice === 'ohh') open = g;
                    break;
                }
                case 'clap': {
                    const dec = 0.25 * D; end = t + 0.04 + dec + 0.05;
                    const n = nz(t, end), bp = filt('bandpass', 1100 * (1 + T), 1.2), g = ctx.createGain();
                    n.connect(bp);
                    g.gain.setValueAtTime(0, t);
                    for (const k of [0, 0.011, 0.022]) { g.gain.setValueAtTime(v, t + k); g.gain.exponentialRampToValueAtTime(0.08 * v, t + k + 0.009); }
                    g.gain.setValueAtTime(v * (0.5 + S * 0.5), t + 0.033);
                    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.033 + dec);
                    add(bp, g);
                    break;
                }
                case 'tom': {
                    const dec = 0.35 * D; end = t + dec + 0.05;
                    const f = 110 * pm * (1 + T);
                    const o = osc('sine', f * 1.6, t, end), g = ctx.createGain();
                    o.frequency.exponentialRampToValueAtTime(f, t + 0.04 + dec * 0.3);
                    env(g, t, v, dec); add(o, g);
                    const n = nz(t, t + 0.03), lp = filt('lowpass', 3000), ng = ctx.createGain();
                    n.connect(lp); env(ng, t, 0.3 * S * v, 0.02); add(lp, ng);
                    break;
                }
                case 'rim': {
                    const dec = 0.03 * D; end = t + 0.08 + dec;
                    const o = osc('triangle', 1700 * pm * (0.8 + T * 0.4), t, end), g = ctx.createGain();
                    env(g, t, v, dec); add(o, g);
                    const n = nz(t, end), bp = filt('bandpass', 4000, 2), ng = ctx.createGain();
                    n.connect(bp); env(ng, t, 0.6 * S * v, 0.01); add(bp, ng);
                    break;
                }
                case 'cowbell': {
                    const dec = 0.3 * D; end = t + dec + 0.05;
                    const mix = ctx.createGain(); mix.gain.value = 0.5;
                    osc('square', 540 * pm, t, end).connect(mix); osc('square', 800 * pm, t, end).connect(mix);
                    const bp = filt('bandpass', 2640 * (0.6 + T * 0.8), 2.5), g = ctx.createGain();
                    mix.connect(bp);
                    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(v, t + 0.001);
                    g.gain.exponentialRampToValueAtTime(v * 0.3, t + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, t + dec);
                    add(bp, g);
                    break;
                }
            }
            // Free the voice's nodes once it has finished.
            setTimeout(() => { try { voice.disconnect(); } catch (e) {} }, Math.max(0, (end - ctx.currentTime) * 1000 + 200));
            led.classList.add('on'); setTimeout(() => led.classList.remove('on'), 60);
        };
        edge.port.onmessage = (e) => { if (e.data.on) trigger(Math.max(ctx.currentTime, e.data.t)); };
        hit.addEventListener('click', () => trigger(ctx.currentTime + 0.005));
        m.addInput('trig', 'Trig', 'gate', edge);
        m.addInput('accent', 'Accent', 'cv', accent.input);
        m.addInput('pitch', 'Pitch', 'cv', pitchCv.input);
        m.addOutput('out', 'Out', 'audio', out);
        return {
            update(key, v) {
                if (key === 'level') m.set(out.gain, dbToGain(v));
                if (key === 'drive') {
                    const k = 1 + v * 12, n = 2048, c = new Float32Array(n);
                    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = v < 0.001 ? x : Math.tanh(x * k) / Math.tanh(k); }
                    shaper.curve = c;
                }
            },
            dispose() { edge.port.onmessage = null; },
        };
    },
});

// =====================================================================  Granular
function builtinTexture(ctx, kind) {
    const sr = ctx.sampleRate, secs = 6, n = sr * secs;
    const b = ctx.createBuffer(2, n, sr);
    for (let c = 0; c < 2; c++) {
        const d = b.getChannelData(c);
        if (kind === 'bells') {
            const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5];
            for (let k = 0; k < 14; k++) {
                const f = notes[(k * 3 + c) % notes.length] * (k % 4 === 3 ? 0.5 : 1), t0 = Math.floor((k / 14) * n);
                for (let i = t0; i < n; i++) { const t = (i - t0) / sr; d[i] += 0.18 * Math.exp(-t * 1.6) * (Math.sin(2 * Math.PI * f * t) + 0.4 * Math.sin(2 * Math.PI * f * 2.76 * t) * Math.exp(-t * 4)); }
            }
        } else {
            const chord = [130.81, 164.81, 196, 246.94, 329.63];
            for (let i = 0; i < n; i++) {
                const t = i / sr; let v = 0;
                for (let k = 0; k < chord.length; k++) { const f = chord[k] * (1 + (c ? 0.003 : -0.003) * (k + 1)); v += ((2 * ((t * f) % 1) - 1) * 0.5 + Math.sin(2 * Math.PI * f * t)) * 0.1; }
                d[i] = v * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.15 * t));
            }
            // gentle low-pass for a softer pad
            let lp = 0; for (let i = 0; i < n; i++) { lp += (d[i] - lp) * 0.12; d[i] = lp; }
        }
    }
    return b;
}
const HANN = (() => { const c = new Float32Array(64); for (let i = 0; i < 64; i++) c[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / 63); return c; })();

registerModule({
    type: 'granular', title: 'Granular', category: 'Sources', blurb: 'Clouds of tiny grains from a sample', width: 240,
    params: {
        source: { label: 'Source', default: 'pad', options: [{ value: 'pad', label: 'Pad (built-in)' }, { value: 'bells', label: 'Bells (built-in)' }, { value: 'file', label: 'Loaded file' }] },
        position: { label: 'Position', min: 0, max: 1, default: 0.3, format: formatPercent, unit: 'ratio' },
        spray: { label: 'Spray', min: 0, max: 0.5, curve: 2, default: 0.05, format: formatPercent, unit: 'ratio' },
        size: { label: 'Grain Size', min: 0.005, max: 1, curve: 'log', default: 0.12, format: formatTime, unit: 's' },
        density: { label: 'Density', min: 1, max: 120, curve: 'log', default: 18, format: (v) => `${v.toFixed(1)}/s` },
        pitch: { label: 'Pitch', min: -24, max: 24, default: 0, step: 0.01, format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)} st` },
        pitchSpray: { label: 'Pitch Spray', min: 0, max: 12, curve: 2, default: 0, format: (v) => `±${v.toFixed(2)} st` },
        spread: { label: 'Stereo Spread', min: 0, max: 1, default: 0.6, format: formatPercent, unit: 'ratio' },
        reverse: { label: 'Reverse Chance', min: 0, max: 1, default: 0, format: formatPercent, unit: 'ratio' },
        level: { label: 'Level', min: -60, max: 6, default: -6, step: 0.1, format: formatDb, unit: 'dB' },
        fileName: { default: '' },
        sampleId: { default: '' },
    },
    create(m, ctx) {
        const out = ctx.createGain();
        const posCv = cvReader(ctx), pitchCv = cvReader(ctx), densCv = cvReader(ctx);
        const edge = m.worklet('ma-edge', { numberOfInputs: 1, numberOfOutputs: 0 });
        let gated = false, gateHigh = false;
        const canvas = el('canvas', { class: 'display', width: 452, height: 120, style: { height: '60px' } });
        const info = el('span', { class: 'node-label' });
        const fileIn = el('input', { type: 'file', accept: 'audio/*,.wav,.aiff,.flac,.mp3,.ogg', style: { display: 'none' } });
        const load = button('Load File…');
        const lib = librarySelect(el, (id, name) => { m.setParam('fileName', name, false); m.setParam('sampleId', id); m.setParam('source', 'file'); });
        m.select('source');
        m.content.append(canvas, el('div', { class: 'info-row' }, info), el('div', { class: 'btn-row' }, load), lib.el, fileIn);
        ['position', 'spray', 'size', 'density', 'pitch', 'pitchSpray', 'spread', 'reverse', 'level'].forEach((k) => m.slider(k));
        const builtins = {}, revCache = new WeakMap();
        let fileBuf = null, recent = [];
        const current = () => (m.params.source === 'file' ? fileBuf : (builtins[m.params.source] ||= builtinTexture(ctx, m.params.source)));
        const reversed = (b) => {
            let r = revCache.get(b);
            if (!r) { r = ctx.createBuffer(b.numberOfChannels, b.length, b.sampleRate); for (let c = 0; c < b.numberOfChannels; c++) r.getChannelData(c).set(b.getChannelData(c).slice().reverse()); revCache.set(b, r); }
            return r;
        };
        let wave = null; // cached waveform image
        const drawWave = () => {
            const b = current(), W = canvas.width, H = canvas.height;
            const off = document.createElement('canvas'); off.width = W; off.height = H;
            const g = off.getContext('2d');
            if (b) {
                const d = b.getChannelData(0), step = d.length / W;
                g.fillStyle = cssVar('--display-line'); g.globalAlpha = 0.55;
                for (let x = 0; x < W; x++) { let pk = 0; for (let i = Math.floor(x * step); i < Math.floor((x + 1) * step); i += 4) pk = Math.max(pk, Math.abs(d[i] || 0)); const h = Math.max(1, pk * (H - 4)); g.fillRect(x, H / 2 - h / 2, 1, h); }
                info.textContent = m.params.source === 'file' ? `${m.params.fileName} · ${b.duration.toFixed(2)} s` : `${b.duration.toFixed(1)} s built-in`;
            } else info.textContent = m.params.fileName ? `Reload “${m.params.fileName}”` : 'No file loaded';
            wave = off;
        };
        // Grain scheduler: looks 120 ms ahead, runs every 25 ms.
        let next = ctx.currentTime + 0.05;
        const tick = () => {
            const b0 = current();
            if (!b0 || ctx.state !== 'running') { next = ctx.currentTime + 0.05; return; }
            if (gated && !gateHigh) { next = ctx.currentTime + 0.02; return; }
            const P = m.params, horizon = ctx.currentTime + 0.12;
            if (next < ctx.currentTime) next = ctx.currentTime;
            const dens = clamp(P.density * Math.pow(2, densCv.read()), 0.5, 250);
            const pos = clamp(P.position + posCv.read(), 0, 1);
            const pcv = pitchCv.read() * 12;
            let n = 0;
            while (next < horizon && n++ < 64) {
                const dur = P.size;
                const rev = Math.random() < P.reverse;
                const b = rev ? reversed(b0) : b0;
                let p = clamp(pos + (Math.random() * 2 - 1) * P.spray, 0, 1);
                if (rev) p = 1 - p;
                const semis = P.pitch + pcv + (Math.random() * 2 - 1) * P.pitchSpray;
                const rate = Math.pow(2, semis / 12);
                const offset = clamp(p * b.duration - (dur * rate) / 2, 0, Math.max(0, b.duration - 0.001));
                const src = ctx.createBufferSource(), g = ctx.createGain(), pan = ctx.createStereoPanner();
                src.buffer = b;
                src.playbackRate.value = rate;
                pan.pan.value = (Math.random() * 2 - 1) * P.spread;
                g.gain.value = 0;
                g.gain.setValueCurveAtTime(HANN, next, dur);
                src.connect(g).connect(pan).connect(out);
                src.start(next, offset, Math.min(dur * rate + 0.01, b.duration - offset));
                src.stop(next + dur + 0.02);
                src.onended = () => { try { pan.disconnect(); } catch (e) {} };
                recent.push({ p: rev ? 1 - p : p, t: performance.now() });
                // Overlapping grains add up; scale by expected overlap to keep the level steady.
                next += 1 / dens * (0.6 + Math.random() * 0.8);
            }
            if (recent.length > 120) recent = recent.slice(-120);
        };
        const timer = setInterval(tick, 25);
        m.timers.push(timer);
        m.animate(() => {
            const g = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
            g.clearRect(0, 0, W, H);
            if (wave) g.drawImage(wave, 0, 0);
            const pos = clamp(m.params.position + posCv.read(), 0, 1);
            g.fillStyle = 'rgba(96,165,250,0.18)';
            g.fillRect((pos - m.params.spray) * W, 0, m.params.spray * 2 * W, H);
            g.fillStyle = cssVar('--step-active');
            g.fillRect(pos * W - 1, 0, 2, H);
            const now = performance.now();
            g.fillStyle = '#fff';
            for (const r of recent) { const a = 1 - (now - r.t) / 400; if (a <= 0) continue; g.globalAlpha = a; g.fillRect(r.p * W - 1, H * 0.15 + Math.random() * H * 0.7, 2, 2); }
            g.globalAlpha = 1;
        });
        load.addEventListener('click', () => fileIn.click());
        fileIn.addEventListener('change', async () => {
            const f = fileIn.files[0]; fileIn.value = '';
            if (!f) return;
            try { const { id } = await storeSample(f); m.setParam('fileName', f.name, false); m.setParam('sampleId', id); m.setParam('source', 'file'); }
            catch (e) {
                try { fileBuf = await ctx.decodeAudioData(await f.arrayBuffer()); m.setParam('fileName', f.name, false); m.setParam('source', 'file'); toast('Sample loaded, but this browser could not store it for next time', 4000); }
                catch (e2) { toast(`Couldn’t read that audio file: ${e2.message || e2}`, 4000); }
            }
        });
        edge.port.onmessage = (e) => { gateHigh = e.data.on; };
        m.addInput('gate', 'Gate', 'gate', edge, { onConnect(n) { gated = n > 0; } });
        m.addInput('pos', 'Position', 'cv', posCv.input);
        m.addInput('pitch', 'Pitch', 'cv', pitchCv.input);
        m.addInput('density', 'Density', 'cv', densCv.input);
        m.addOutput('out', 'Out', 'audio', out);
        return {
            update(key, v) {
                if (key === 'level' || key === 'density' || key === 'size') {
                    const overlap = Math.max(1, m.params.density * m.params.size);
                    m.set(out.gain, dbToGain(m.params.level) / Math.sqrt(overlap));
                }
                if (key === 'sampleId' && v) getSample(v).then((b) => { if (m.params.sampleId === v) { fileBuf = b; drawWave(); } });
                if (key === 'source' || key === 'fileName') drawWave();
            },
            refresh: drawWave,
            dispose() { clearInterval(timer); lib.dispose(); edge.port.onmessage = null; },
        };
    },
});
