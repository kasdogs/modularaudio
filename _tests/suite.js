// Modular Audio test suite. Runs inside the app (an iframe of ../index.html?test).
// Each test gets { A, app, wait, assert } where A = app.modularAudio.

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------- helpers ----------
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const C = (patch, a, ap, b, bp, g = 1) => patch.connect({ mod: a, port: ap, dir: 'out' }, { mod: b, port: bp, dir: 'in' }, g);
function analyse(ctx, node, index = 0, size = 2048) {
    const an = ctx.createAnalyser();
    an.fftSize = size;
    node.connect(an, index);
    const buf = new Float32Array(size);
    return {
        stats() {
            an.getFloatTimeDomainData(buf);
            let pk = 0, sq = 0, bad = 0;
            for (const v of buf) { if (!Number.isFinite(v)) { bad++; continue; } pk = Math.max(pk, Math.abs(v)); sq += v * v; }
            return { peak: pk, rms: Math.sqrt(sq / buf.length), bad };
        },
        async peakOver(ms) { let p = 0; for (let t = 0; t < ms; t += 25) { await wait(25); p = Math.max(p, this.stats().peak); } return p; },
        dispose() { try { node.disconnect(an, index); } catch (e) {} },
    };
}
function edgeCounter(ctx, mod, port) {
    const n = new AudioWorkletNode(ctx, 'ma-edge', { numberOfInputs: 1, numberOfOutputs: 0 });
    const o = mod.outputs[port];
    o.node.connect(n, o.index);
    const c = { on: 0 };
    n.port.onmessage = (e) => { if (e.data.on) c.on++; };
    return c;
}
// Import one of the app's own modules from inside the app frame (same instances the app uses).
export function appImport(app, path) {
    return app.Function('u', 'return import(u)')(new URL(path, app.location.href).href);
}
const moduleTypes = (app) => [...app.document.querySelectorAll('.add-module-btn')].map((b) => b.dataset.moduleType);

// ---------- boot ----------
test('App boots with audio worklets and the example patch', async ({ A }) => {
    assert(A.audio.ready, 'audio not ready');
    assert(A.patch.modules.size >= 5, `example patch has ${A.patch.modules.size} modules`);
    assert(A.patch.connections.size >= 5, 'example patch has no cables');
});

test('Every module type can be added, minimised and removed', async ({ A, app }) => {
    const list = moduleTypes(app);
    assert(list.length >= 45, `only ${list.length} module types in the browser`);
    A.patch.clear();
    for (const t of list) {
        const m = A.patch.addModule(t, { x: 0, y: 0 });
        assert(m, `could not add ${t}`);
        m.setMinimized(true); m.setMinimized(false);
        A.patch.removeModule(m.id);
    }
    assert(A.patch.modules.size === 1, 'modules left behind');
});

test('No module outputs NaN or runaway levels at extreme settings', async ({ A, app }) => {
    const { patch, audio } = A, ctx = audio.ctx;
    patch.clear();
    const src = patch.addModule('oscillator', {}), lfo = patch.addModule('lfo', { params: { rate: 8 } }), clk = patch.addModule('clock', { params: { bpm: 300, div: 4 } });
    const issues = [];
    for (const t of moduleTypes(app)) {
        if (t === 'recorder' || t === 'midiin') continue;
        const m = patch.addModule(t, {});
        for (const [n, p] of Object.entries(m.inputs)) {
            const s = p.kind === 'audio' ? [src, 'out'] : p.kind === 'cv' ? [lfo, 'out'] : [clk, 'x1'];
            if (s[0] !== m) C(patch, s[0], s[1], m, n, 1.5);
        }
        const outs = Object.entries(m.outputs).map(([n, p]) => [n, analyse(ctx, p.node, p.index)]);
        for (const mode of ['min', 'max']) {
            for (const [k, sp] of Object.entries(m.def.params)) {
                if (sp.options) m.setParam(k, sp.options[mode === 'min' ? 0 : sp.options.length - 1].value);
                else if (typeof sp.min === 'number') m.setParam(k, mode === 'min' ? sp.min : sp.max);
            }
            await wait(150);
            for (const [n, a] of outs) { const s = a.stats(); if (s.bad) issues.push(`${t}.${n} ${mode}: NaN`); if (s.peak > 50) issues.push(`${t}.${n} ${mode}: peak ${s.peak.toFixed(1)}`); }
        }
        outs.forEach(([, a]) => a.dispose());
        patch.removeModule(m.id);
    }
    assert(!issues.length, issues.join('; '));
});

// ---------- timing / gates ----------
test('Clock, divider, Euclidean, comparator timing', async ({ A }) => {
    const { patch, audio } = A, ctx = audio.ctx;
    patch.clear();
    const clk = patch.addModule('clock', { params: { bpm: 120, div: 4 } });
    const base = edgeCounter(ctx, clk, 'x1');
    const div = patch.addModule('clockmod', { params: { mode: 'divide', ratio: 2 } }); C(patch, clk, 'x1', div, 'clock');
    const eu = patch.addModule('euclid', { params: { steps: 16, fills: 4 } }); C(patch, clk, 'x1', eu, 'clock');
    const lfo = patch.addModule('lfo', { params: { rate: 4 } }), cmp = patch.addModule('comparator', {}); C(patch, lfo, 'out', cmp, 'in');
    const cD = edgeCounter(ctx, div, 'out'), cE = edgeCounter(ctx, eu, 'hit'), cC = edgeCounter(ctx, cmp, 'out');
    await wait(2000);
    assert(Math.abs(base.on - 16) <= 1, `clock gave ${base.on} pulses in 2 s (want 16)`);
    assert(Math.abs(cD.on - base.on / 2) <= 1, `divider gave ${cD.on} for ${base.on}`);
    assert(Math.abs(cE.on - base.on / 4) <= 1, `euclid 4/16 gave ${cE.on} for ${base.on}`);
    assert(Math.abs(cC.on - 8) <= 1, `comparator on 4 Hz LFO gave ${cC.on} in 2 s (want 8)`);
});

// ---------- patch model ----------
test('Save/load round trip is exact', async ({ A }) => {
    const s1 = JSON.stringify(A.patch.serialize());
    A.patch.load(JSON.parse(s1));
    const s2 = JSON.stringify(A.patch.serialize());
    assert(s1 === s2, 'serialised patch changed after reload');
});

test('Bad presets are rejected or sanitised, never break the app', async ({ A }) => {
    const { patch } = A;
    for (const bad of [null, {}, { modules: 'x' }]) { let threw = false; try { patch.load(bad); } catch (e) { threw = true; } assert(threw, 'bad preset accepted'); }
    patch.load({ modules: [{ type: 'nope', id: 'nope-1' }, { type: 'oscillator', id: 'oscillator-1', params: { level: 'loud', wave: 'banana', freq: -5 } }], connections: [{ from: ['x'], to: 3 }] });
    const o = [...patch.modules.values()].find((m) => m.type === 'oscillator');
    assert(o.params.level === -6 && o.params.wave === 'sawtooth' && o.params.freq === 10, `not sanitised: ${JSON.stringify(o.params)}`);
    assert(patch.suspendEvents === 0, 'patch events left suspended');
});

test('Feedback cables get a delay and are marked', async ({ A }) => {
    const { patch } = A;
    patch.clear();
    const o = patch.addModule('oscillator', {}), mx = patch.addModule('mixer', {}), f = patch.addModule('filter', {});
    const a = C(patch, o, 'out', mx, 'in1'), b = C(patch, mx, 'out', f, 'in'), c = C(patch, f, 'out', mx, 'in2');
    assert(!a.feedback && !b.feedback && c.feedback && c.delayNode, 'loop-closing cable not detected');
});

// ---------- editing ----------
test('Undo/redo, including undoing a full patch import', async ({ A }) => {
    const { patch, history } = A;
    patch.clear(); history.commit();
    patch.addModule('noise', {}); history.commit();
    const n = patch.modules.size;
    patch.load({ app: 'modularaudio', kind: 'patch', modules: [{ id: 'lfo-90', type: 'lfo' }], connections: [] }); history.commit();
    assert(patch.modules.size === 2, 'import did not replace the patch');
    history.undo();
    assert(patch.modules.size === n && [...patch.modules.values()].some((m) => m.type === 'noise'), 'undo did not restore the previous patch');
    history.redo();
    assert([...patch.modules.values()].some((m) => m.type === 'lfo'), 'redo did not re-apply the import');
});

test('Param undo updates in place (module is not rebuilt)', async ({ A }) => {
    const { patch, history } = A;
    patch.clear(); const o = patch.addModule('oscillator', {}); history.commit();
    o.setParam('level', -30); history.commit();
    history.undo();
    const o2 = [...patch.modules.values()].find((m) => m.type === 'oscillator');
    assert(o2 === o && o.params.level === -6, 'param undo rebuilt the module or failed');
});

test('Copy/paste and subpatch insert are additive with fresh ids', async ({ A }) => {
    const { patch, editor, ws } = A;
    patch.clear();
    const l = patch.addModule('lfo', { x: 0, y: 0 }), v = patch.addModule('vca', { x: 250, y: 0 }); C(patch, l, 'out', v, 'cv');
    ws.setSelection([l, v]);
    const data = editor.copySelected();
    assert(data.kind === 'subpatch' && data.modules.length === 2 && data.connections.length === 1, 'bad clipboard data');
    const before = [patch.modules.size, patch.connections.size];
    const added = editor.paste();
    assert(added.length === 2 && patch.modules.size === before[0] + 2 && patch.connections.size === before[1] + 1, 'paste not additive');
    assert(added.every((m) => m.id !== l.id && m.id !== v.id), 'pasted ids collide');
    let refused = false; try { patch.load({ ...data }); } catch (e) { refused = /subpatch/i.test(e.message); }
    assert(refused, 'loading a subpatch as a full patch was not refused');
});

test('Share link encodes and decodes the patch', async ({ A, app }) => {
    const { encodeShare, decodeShare } = await appImport(app, 'js/editor.js');
    const data = A.patch.serialize();
    const code = await encodeShare(data);
    assert(code.length < 20000, `share code too long: ${code.length}`);
    const back = await decodeShare(code);
    assert(JSON.stringify(back) === JSON.stringify(data), 'share round trip changed the patch');
});

test('Search ranks sensible results', async ({ app }) => {
    const { search } = await appImport(app, 'js/search.js');
    const first = (q) => search(q)[0]?.type;
    assert(first('vcf') === 'filter', 'vcf'); assert(first('echo') === 'delay', 'echo');
    assert(first('kick') === 'drum' || first('kick') === 'sampler', 'kick'); assert(search('zzzz').length === 0, 'zzzz');
});

// ---------- new modules ----------
test('MIDI In: notes, voice allocation, CC (mock device)', async ({ A, app }) => {
    const input = { id: 'k1', name: 'Mock Keys', state: 'connected', onmidimessage: null };
    app.navigator.requestMIDIAccess = () => Promise.resolve({ inputs: new Map([['k1', input]]), outputs: new Map(), onstatechange: null });
    const send = (b) => input.onmidimessage && input.onmidimessage({ data: new Uint8Array(b), timeStamp: app.performance.now() });
    const { patch, audio } = A, ctx = audio.ctx;
    patch.clear();
    const a = patch.addModule('midiin', { params: { voices: 2, voice: 1 } }), b = patch.addModule('midiin', { params: { voices: 2, voice: 2 } });
    await wait(200);
    const val = (m, p) => { const an = ctx.createAnalyser(); an.fftSize = 256; m.outputs[p].node.connect(an); return () => { const d = new Float32Array(256); an.getFloatTimeDomainData(d); return d[255]; }; };
    const ap = val(a, 'pitch'), ag = val(a, 'gate'), bp = val(b, 'pitch'), bg = val(b, 'gate'), acc = val(a, 'cc');
    send([0x90, 60, 100]); send([0x90, 67, 100]); await wait(100);
    assert(ap() === 0 && ag() === 1, 'voice 1 did not get C4');
    assert(Math.abs(bp() - 7 / 12) < 1e-4 && bg() === 1, 'voice 2 did not get G4');
    send([0xb0, 1, 127]); await wait(80);
    assert(Math.abs(acc() - 1) < 1e-4, 'CC1 not output');
    send([0x80, 60, 0]); send([0x80, 67, 0]); await wait(80);
    assert(ag() === 0 && bg() === 0, 'gates did not close');
});

test('Recorder writes a 48 kHz WAV of the right length and pitch', async ({ A, app }) => {
    const { patch } = A;
    patch.clear();
    const o = patch.addModule('oscillator', { params: { mode: 'free', freq: 440, wave: 'sine', level: -6 } });
    const r = patch.addModule('recorder', { params: { depth: 16 } });
    C(patch, o, 'out', r, 'in');
    let blob = null;
    const orig = app.URL.createObjectURL, origClick = app.HTMLAnchorElement.prototype.click;
    app.URL.createObjectURL = (b) => { if (b && b.type === 'audio/wav') blob = b; return orig.call(app.URL, b); };
    app.HTMLAnchorElement.prototype.click = function () { if (!this.download) origClick.call(this); }; // no real download during tests
    const btn = r.element.querySelector('.rec-btn');
    btn.click(); await wait(1000); btn.click();
    for (let i = 0; i < 40 && !blob; i++) await wait(50);
    app.URL.createObjectURL = orig;
    app.HTMLAnchorElement.prototype.click = origClick;
    assert(blob, 'no WAV produced');
    const v = new DataView(await blob.arrayBuffer());
    const rate = v.getUint32(24, true), ch = v.getUint16(22, true), bits = v.getUint16(34, true), len = v.getUint32(40, true);
    const secs = len / (ch * bits / 8) / rate;
    assert(rate === 48000 && ch === 2 && bits === 16, `header ${rate} Hz ${ch} ch ${bits} bit`);
    assert(Math.abs(secs - 1) < 0.08, `length ${secs.toFixed(3)} s`);
    let zc = 0, prev = 0;
    for (let i = 0; i < len / 4; i++) { const s = v.getInt16(44 + i * 4, true); if (prev < 0 && s >= 0) zc++; prev = s; }
    const hz = zc / secs;
    assert(Math.abs(hz - 440) < 5, `measured ${hz.toFixed(1)} Hz`);
});

test('Drum Voice: every voice sounds, closed hat chokes open hat', async ({ A }) => {
    const { patch, audio } = A, ctx = audio.ctx;
    patch.clear();
    const d = patch.addModule('drum', {}), an = analyse(ctx, d.outputs.out.node);
    const hit = () => d.element.querySelector('.btn-row button').click();
    for (const v of d.def.params.voice.options.map((o) => o.value)) {
        d.setParam('voice', v); await wait(120); hit();
        const pk = await an.peakOver(200);
        assert(pk > 0.05, `${v} silent (${pk})`);
    }
    d.setParam('voice', 'ohh'); await wait(600); hit(); await wait(50); d.setParam('voice', 'chh'); hit(); await wait(250);
    assert(an.stats().peak < 0.01, 'open hat not choked');
});

test('Granular: sounds, and stays silent while its gate is low', async ({ A }) => {
    const { patch, audio } = A, ctx = audio.ctx;
    patch.clear();
    const g = patch.addModule('granular', {}), an = analyse(ctx, g.outputs.out.node, 0, 4096);
    await wait(600);
    assert(an.stats().rms > 0.003, 'granular silent');
    const t = patch.addModule('trigger', {}); C(patch, t, 'out', g, 'gate');
    await wait(700);
    assert(an.stats().rms < 0.001, 'granular not gated');
});

test('Stereo survives every audio processor', async ({ A }) => {
    const { patch, audio } = A, ctx = audio.ctx;
    patch.clear();
    const o = patch.addModule('oscillator', { params: { mode: 'free', freq: 300, wave: 'sine' } });
    const mx = patch.addModule('mixer', { params: { pan1: -1 } });
    C(patch, o, 'out', mx, 'in1');
    const lr = async (node, idx = 0) => {
        const sp = ctx.createChannelSplitter(2), a = ctx.createAnalyser(), b = ctx.createAnalyser();
        node.connect(sp, idx); sp.connect(a, 0); sp.connect(b, 1);
        await wait(300);
        const d = new Float32Array(2048);
        const rms = (an) => { an.getFloatTimeDomainData(d); let s = 0; for (const x of d) s += x * x; return Math.sqrt(s / d.length); };
        const r = [rms(a), rms(b)];
        node.disconnect(sp);
        return r;
    };
    const bad = [];
    for (const t of ['filter', 'vca', 'delay', 'reverb', 'chorus', 'flanger', 'phaser', 'tremolo', 'vibrato', 'convreverb', 'compressor', 'tilteq', 'bitcrusher', 'waveshaper', 'clipper', 'wavefolder', 'dcblock', 'stereo', 'recorder']) {
        const m = patch.addModule(t, {});
        C(patch, mx, 'out', m, 'in');
        const [l, r] = await lr(m.outputs.out.node, m.outputs.out.index);
        if (!(l > 0.01 && r < l * 0.35)) bad.push(`${t} (L ${l.toFixed(3)} R ${r.toFixed(3)})`);
        patch.removeModule(m.id);
    }
    assert(!bad.length, `stereo collapsed in: ${bad.join(', ')}`);
});

test('Sample library stores and restores a sample', async ({ A, app }) => {
    const lib = await appImport(app, 'js/samples.js');
    // 0.25 s, 48 kHz mono 16-bit sine as a WAV file
    const n = 12000, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    const s = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
    s(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); s(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 48000, true); v.setUint32(28, 96000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); s(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.sin(i / 10) * 12000), true);
    const { patch } = A;
    patch.clear();
    const sm = patch.addModule('sampler', {});
    const dt = new app.DataTransfer(); dt.items.add(new app.File([buf], 'test-tone.wav', { type: 'audio/wav' }));
    const inp = sm.element.querySelector('input[type=file]'); inp.files = dt.files; inp.dispatchEvent(new app.Event('change'));
    for (let i = 0; i < 40 && !sm.params.sampleId; i++) await wait(50);
    assert(sm.params.sampleId, 'sample not stored');
    const id = sm.params.sampleId;
    const snap = patch.serialize();
    patch.clear();
    patch.load(snap);
    await wait(400);
    const sm2 = [...patch.modules.values()].find((m) => m.type === 'sampler');
    assert(/test-tone\.wav/.test(sm2.element.innerText) && /0\.25 s/.test(sm2.element.innerText), 'sample not restored from the library');
    await lib.deleteSample(id); // leave the developer's library as it was
});

test('Jack readout shows live values', async ({ A, app }) => {
    const { describe, tapPort } = await appImport(app, 'js/readouts.js');
    const { patch } = A;
    patch.clear();
    const m = patch.addModule('math', { params: { offset: 0.5 } });
    await wait(150);
    const t = tapPort(patch, m, 'out', 'out');
    await wait(100);
    const d = describe(t, 'out');
    t.dispose();
    assert(d.value === '+0.500', `readout said ${d.value}`);
});

// ---------- batch: slew, transient shaper, calculator, keys, drum worklet ----------
const lastValue = (ctx, mod, port) => {
    const an = ctx.createAnalyser(); an.fftSize = 256;
    const o = mod.outputs[port]; o.node.connect(an, o.index);
    const d = new Float32Array(256);
    return () => { an.getFloatTimeDomainData(d); return d[255]; };
};
const edgeTimes = (ctx, mod, port) => {
    const n = new AudioWorkletNode(ctx, 'ma-edge', { numberOfInputs: 1, numberOfOutputs: 0 });
    const o = mod.outputs[port]; o.node.connect(n, o.index);
    const ev = [];
    n.port.onmessage = (e) => ev.push(e.data);
    return ev;
};

test('Slew Limiter: linear and exponential rise times', async ({ A }) => {
    const { patch, audio } = A, ctx = audio.ctx;
    patch.clear();
    const src = patch.addModule('math', { params: { offset: 0 } });
    const sl = patch.addModule('slew', { params: { rise: 0.5, fall: 0.5, shape: 0 } });
    C(patch, src, 'out', sl, 'in');
    const v = lastValue(ctx, sl, 'out');
    await wait(150);
    src.setParam('offset', 1);
    await wait(250);
    const lin = v();
    assert(lin > 0.38 && lin < 0.62, `linear: ${lin.toFixed(3)} after 250 ms of a 500 ms rise (want ≈0.5)`);
    await wait(400);
    assert(Math.abs(v() - 1) < 0.01, 'linear did not settle');
    sl.setParam('shape', 1); src.setParam('offset', 0);
    await wait(600);
    const ex = v();
    assert(ex < 0.05, `exponential fall not ~99% done after its time (${ex.toFixed(3)})`);
});

test('Slew Limiter: trigger delay timing and follow-gate mode', async ({ A }) => {
    const { patch, audio } = A, ctx = audio.ctx;
    patch.clear();
    const clk = patch.addModule('clock', { params: { bpm: 120, div: 4 } }); // 8 pulses/s, 62.5 ms high
    const sl = patch.addModule('slew', { params: { tdelay: 0.1, tmode: 'fixed', tlength: 0.02 } });
    C(patch, clk, 'x1', sl, 'gate');
    const src = edgeTimes(ctx, clk, 'x1'), del = edgeTimes(ctx, sl, 'gout');
    await wait(1200);
    const ons = (ev) => ev.filter((e) => e.on).map((e) => e.t);
    const a = ons(src), b = ons(del);
    assert(b.length >= a.length - 2, `delayed ${b.length} of ${a.length}`);
    const d = b.slice(0, 5).map((t, i) => t - a[i]);
    assert(d.every((x) => Math.abs(x - 0.1) < 0.002), `delays ${d.map((x) => (x * 1000).toFixed(1)).join(', ')} ms (want 100)`);
    const widthsFixed = del.reduce((acc, e, i) => (e.on && del[i + 1] && !del[i + 1].on ? acc.concat(del[i + 1].t - e.t) : acc), []);
    assert(widthsFixed.length && widthsFixed.every((w) => Math.abs(w - 0.02) < 0.002), `fixed pulse widths ${widthsFixed.map((w) => (w * 1000).toFixed(1))}`);
    sl.setParam('tmode', 'follow');
    del.length = 0;
    await wait(800);
    // Ignore pulses already in flight when the mode changed.
    const widths = del.reduce((acc, e, i) => (e.on && del[i + 1] && !del[i + 1].on ? acc.concat(del[i + 1].t - e.t) : acc), []).slice(2);
    assert(widths.length && widths.every((w) => Math.abs(w - 0.0625) < 0.002), `follow widths ${widths.map((w) => (w * 1000).toFixed(1))} ms (want 62.5)`);
});

test('Old Trig Delay presets load into Slew Limiter', async ({ A }) => {
    const { patch } = A;
    patch.load({ app: 'modularaudio', kind: 'patch', modules: [{ id: 'clock-1', type: 'clock' }, { id: 'trigdelay-2', type: 'trigdelay', params: { delay: 0.25, length: 0.05 } }, { id: 'drum-3', type: 'drum' }],
        connections: [{ from: ['clock-1', 'x1'], to: ['trigdelay-2', 'in'] }, { from: ['trigdelay-2', 'out'], to: ['drum-3', 'trig'] }] });
    const s = patch.modules.get('trigdelay-2');
    assert(s && s.type === 'slew' && s.params.tdelay === 0.25 && s.params.tlength === 0.05, 'not migrated');
    assert(patch.connections.size === 2, `cables ${patch.connections.size} (want 2)`);
});

test('Transient Shaper: attack shapes punch; threshold disables it', async ({ A }) => {
    const { patch, audio } = A, ctx = audio.ctx;
    patch.clear();
    const clk = patch.addModule('clock', { params: { bpm: 120, div: 2 } });
    const d = patch.addModule('drum', { params: { voice: 'snare', decay: 1.5 } });
    const ts = patch.addModule('transient', { params: { attack: 0, attackTh: -60 } });
    C(patch, clk, 'x1', d, 'trig'); C(patch, d, 'out', ts, 'in');
    const an = analyse(ctx, ts.outputs.out.node, 0, 8192);
    const crest = async () => { let pk = 0, rmsSum = 0, n = 0; for (let t = 0; t < 1200; t += 50) { await wait(50); const s = an.stats(); pk = Math.max(pk, s.peak); rmsSum += s.rms; n++; } return pk / (rmsSum / n); };
    ts.setParam('attack', 1); await wait(300); const up = await crest();
    ts.setParam('attack', -1); await wait(300); const down = await crest();
    assert(up > down * 1.15, `attack +100% crest ${up.toFixed(2)} vs −100% ${down.toFixed(2)}`);
    ts.setParam('attack', 1); ts.setParam('attackTh', 0); await wait(300);
    const gains = []; const off = ts.worklets[0].port.onmessage;
    ts.worklets[0].port.onmessage = (e) => { gains.push(e.data.g); off(e); };
    await wait(800);
    ts.worklets[0].port.onmessage = off;
    assert(Math.max(...gains.map(Math.abs)) < 1, `gain moved ${Math.max(...gains.map(Math.abs)).toFixed(2)} dB with threshold above the signal`);
});

test('Calculator: BPM ↔ ms ↔ Hz, ×2/÷2, note ↔ Hz', async ({ A, app }) => {
    const { patch } = A;
    patch.clear();
    const c = patch.addModule('calc', { params: { bpm: 120, div: 0.25, feel: 'straight' } });
    const inputs = c.element.querySelectorAll('.calc-input');
    const [bpm, ms, hz, pHz, pNote] = inputs;
    assert(ms.value === '500.00 ms' && hz.value === '2.000 Hz', `120 BPM 1/4 → ${ms.value}, ${hz.value}`);
    c.setParam('div', 0.125); c.setParam('feel', 'dotted');
    assert(ms.value === '375.00 ms', `dotted 1/8 → ${ms.value}`);
    const btn = (t, i = 0) => [...c.element.querySelectorAll('.calc-row .param-button')].filter((b) => b.textContent === t)[i];
    btn('×2').click(); assert(c.params.bpm === 240, `×2 → ${c.params.bpm}`);
    btn('÷2').click(); assert(c.params.bpm === 120, `÷2 → ${c.params.bpm}`);
    c.setParam('div', 0.25); c.setParam('feel', 'straight');
    ms.value = '250'; ms.dispatchEvent(new app.Event('change'));
    assert(Math.abs(c.params.bpm - 240) < 1e-6, `250 ms → ${c.params.bpm} BPM`);
    pNote.value = 'A4'; pNote.dispatchEvent(new app.Event('change'));
    assert(Math.abs(c.params.hz - 440) < 1e-9, `A4 → ${c.params.hz}`);
    pHz.value = '261.63'; pHz.dispatchEvent(new app.Event('change'));
    assert(pNote.value === 'C4', `261.63 Hz → ${pNote.value}`);
});

test('Keys: tracker layout over two octaves and scale lock', async ({ A, app }) => {
    const { patch, audio } = A, ctx = audio.ctx;
    patch.clear();
    const k = patch.addModule('keys', { params: { octave: 3 } });
    const pitch = lastValue(ctx, k, 'pitch'), gate = lastValue(ctx, k, 'gate');
    const play = async (code) => {
        app.dispatchEvent(new app.KeyboardEvent('keydown', { code, key: 'x' }));
        await wait(40);
        const p = pitch(), g = gate();
        app.dispatchEvent(new app.KeyboardEvent('keyup', { code, key: 'x' }));
        await wait(20);
        return { semis: Math.round(p * 12), g };
    };
    const want = { KeyZ: -12, KeyS: -11, KeyM: -1, Comma: 0, KeyQ: 0, Digit2: 1, KeyI: 12, Slash: 4, BracketRight: 19 };
    for (const [code, semis] of Object.entries(want)) {
        const r = await play(code);
        assert(r.g === 1 && r.semis === semis, `${code} → ${r.semis} st from C4 (want ${semis}), gate ${r.g}`);
    }
    k.setParam('scale', 'ionian'); k.setParam('root', 0);
    assert((await play('Digit2')).semis === 0, 'C# not snapped to C in C major');
    assert((await play('Digit5')).semis === 5, 'F# not snapped to F in C major');
    k.setParam('scale', 'dorian'); k.setParam('root', 2); // D dorian = C major notes
    assert((await play('Digit3')).semis === 2, 'D# not snapped to D in D dorian');
    k.setParam('scale', 'custom');
    k.setParam('mask', Array.from({ length: 12 }, (_, i) => i === 4)); // only E
    assert((await play('KeyQ')).semis === 4 || (await play('KeyQ')).semis === -8, 'custom scale did not snap to E');
    assert((await play('KeyT')).semis === 4, 'G not snapped to E with only E allowed');
});

test('Drum Voice (worklet): 12 voices, choke, sample-exact timing', async ({ A }) => {
    const { patch, audio } = A, ctx = audio.ctx;
    patch.clear();
    const d = patch.addModule('drum', {}), an = analyse(ctx, d.outputs.out.node);
    for (const v of d.def.params.voice.options.map((o) => o.value)) {
        d.setParam('voice', v); await wait(100);
        d.element.querySelector('.btn-row button').click();
        const pk = await an.peakOver(200);
        assert(pk > 0.05, `${v} silent (${pk.toFixed(3)})`);
        assert(pk < 2.5, `${v} too loud (${pk.toFixed(2)})`);
    }
    d.setParam('voice', 'ohh'); await wait(700); d.element.querySelector('.btn-row button').click(); await wait(60);
    d.setParam('voice', 'chh'); await wait(5); d.element.querySelector('.btn-row button').click(); await wait(200);
    assert(an.stats().peak < 0.005, 'open hat not choked');
    // Timing: record a clock-driven kick and check the onsets are evenly spaced to the sample.
    d.setParam('voice', 'rim'); d.setParam('decay', 0.3);
    const clk = patch.addModule('clock', { params: { bpm: 240, div: 1 } }); // every 250 ms
    C(patch, clk, 'x1', d, 'trig');
    const rec = new AudioWorkletNode(ctx, 'ma-recorder', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    d.outputs.out.node.connect(rec);
    const parts = [];
    rec.port.onmessage = (e) => parts.push(e.data.l);
    rec.port.postMessage('start'); await wait(1400); rec.port.postMessage('stop'); await wait(150);
    d.outputs.out.node.disconnect(rec);
    const all = new Float32Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
    const onsets = [];
    for (let i = 0; i < all.length; i++) if (Math.abs(all[i]) > 0.02 && (!onsets.length || i - onsets[onsets.length - 1] > ctx.sampleRate * 0.1)) onsets.push(i);
    const iv = onsets.slice(1).map((x, i) => x - onsets[i]);
    const target = ctx.sampleRate * 0.25;
    assert(iv.length >= 3, `found ${onsets.length} onsets`);
    assert(iv.every((x) => Math.abs(x - target) <= 2), `onset spacing ${iv.join(', ')} samples (want ${target})`);
});
