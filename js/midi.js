// Web MIDI access shared by all MIDI In modules, with a voice allocator so several MIDI In
// modules set to "Voice 1..N of N" play chords together.
let accessP = null;
let access = null;
const modules = new Set();      // subscribers: { filter(e), onMessage(msg) }
const deviceListeners = new Set();

export const midiSupported = () => typeof navigator.requestMIDIAccess === 'function';

export function requestMIDI() {
    if (!midiSupported()) return Promise.reject(new Error('This browser has no Web MIDI (Safari and iOS do not support it; use Chrome, Edge or Firefox).'));
    if (!accessP) {
        accessP = navigator.requestMIDIAccess({ sysex: false }).then((a) => {
            access = a;
            const bind = () => { for (const input of a.inputs.values()) input.onmidimessage = (e) => dispatch(input, e); };
            bind();
            a.onstatechange = () => { bind(); deviceListeners.forEach((fn) => fn(listInputs())); };
            return a;
        }).catch((e) => { accessP = null; throw e; });
    }
    return accessP;
}
export function listInputs() {
    if (!access) return [];
    return [...access.inputs.values()].filter((i) => i.state !== 'disconnected').map((i) => i.name || i.id);
}
export function onDevices(fn) { deviceListeners.add(fn); return () => deviceListeners.delete(fn); }
export function subscribe(sub) { modules.add(sub); return () => modules.delete(sub); }

// --- voice allocation per (device, channel, voice count) group ---
const groups = new Map(); // key -> { slots: [{note, t}], order }
function slotFor(key, voices, note, on) {
    let g = groups.get(key);
    if (!g || g.slots.length !== voices) { g = { slots: Array.from({ length: voices }, () => ({ note: null, t: 0 })), next: 0 }; groups.set(key, g); }
    if (on) {
        const same = g.slots.findIndex((s) => s.note === note);
        if (same >= 0) { g.slots[same].t = performance.now(); return same; }
        // Free slot after the last one used, otherwise steal the oldest note.
        let pick = -1;
        for (let k = 0; k < voices; k++) { const i = (g.next + k) % voices; if (g.slots[i].note === null) { pick = i; break; } }
        if (pick < 0) pick = g.slots.reduce((best, s, i) => (s.t < g.slots[best].t ? i : best), 0);
        g.slots[pick] = { note, t: performance.now() };
        g.next = (pick + 1) % voices;
        return pick;
    }
    const i = g.slots.findIndex((s) => s.note === note);
    if (i >= 0) g.slots[i] = { note: null, t: 0 };
    return i;
}

function dispatch(input, e) {
    const d = e.data;
    if (!d || !d.length) return;
    const status = d[0];
    const name = input.name || input.id;
    // e.timeStamp is on the performance.now() clock; modules convert it to audio time.
    const t = e.timeStamp || performance.now();
    if (status >= 0xf8) { // realtime: clock / start / continue / stop
        const kind = { 0xf8: 'clock', 0xfa: 'start', 0xfb: 'continue', 0xfc: 'stop' }[status];
        if (kind) for (const s of modules) if (s.device === 'all' || s.device === name) s.onMessage({ type: kind, t });
        return;
    }
    const type = status & 0xf0, ch = (status & 0x0f) + 1;
    let msg = null;
    if (type === 0x90 && d[2] > 0) msg = { type: 'on', note: d[1], vel: d[2] / 127 };
    else if (type === 0x80 || (type === 0x90 && d[2] === 0)) msg = { type: 'off', note: d[1] };
    else if (type === 0xb0) msg = { type: 'cc', cc: d[1], value: d[2] / 127 };
    else if (type === 0xe0) msg = { type: 'bend', value: ((d[2] << 7) | d[1]) / 8192 - 1 };
    else if (type === 0xd0) msg = { type: 'pressure', value: d[1] / 127 };
    if (!msg) return;
    msg.t = t;
    msg.channel = ch;
    msg.device = name;
    const seen = new Map(); // allocate once per group, not once per module
    for (const s of modules) {
        if (!(s.device === 'all' || s.device === name)) continue;
        if (s.channel && s.channel !== ch) continue;
        if ((msg.type === 'on' || msg.type === 'off') && s.voices > 1) {
            const key = `${s.device}|${s.channel}|${s.voices}`;
            if (!seen.has(key)) seen.set(key, slotFor(key, s.voices, msg.note, msg.type === 'on'));
            if (seen.get(key) !== s.voice - 1) continue;
        }
        s.onMessage(msg);
    }
}
