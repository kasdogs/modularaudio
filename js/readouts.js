// Live jack readouts: hover a jack (or hold it on touch) to see what's on it.
import { audio } from './audio.js';
import { el, midiToName } from './util.js';

const HOVER_MS = 220;

// Tap a port: outputs read their node; inputs read the sum of their incoming cables.
export function tapPort(patch, mod, dir, portName) {
    const ctx = audio.ctx;
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    const sources = [];
    const p = mod.port(dir, portName);
    if (!p) return null;
    if (dir === 'out') { p.node.connect(an, p.index); sources.push([p.node, p.index]); }
    else for (const c of patch.connectionsOf(mod, 'in', portName)) { const n = c.delayNode || c.gainNode; n.connect(an); sources.push([n, 0]); }
    const buf = new Float32Array(an.fftSize);
    return {
        port: p,
        connected: sources.length > 0,
        read() {
            an.getFloatTimeDomainData(buf);
            let mn = Infinity, mx = -Infinity, sq = 0;
            for (const v of buf) { if (v < mn) mn = v; if (v > mx) mx = v; sq += v * v; }
            return { last: buf[buf.length - 1], min: mn, max: mx, rms: Math.sqrt(sq / buf.length) };
        },
        dispose() { for (const [n, i] of sources) { try { n.disconnect(an, i); } catch (e) { try { n.disconnect(an); } catch (_) {} } } },
    };
}

// Format a reading for the port kind.
export function describe(tap, name) {
    if (!tap.connected) return { value: 'Not connected', sub: '', bar: null };
    const r = tap.read();
    const kind = tap.port.kind;
    if (kind === 'gate') {
        const high = r.last > 0.5;
        const pulsing = r.max > 0.5 && r.min < 0.25;
        return { value: high ? 'HIGH' : 'LOW', sub: pulsing ? 'pulsing' : '', bar: high ? [0, 1] : [0, 0] };
    }
    if (kind === 'cv') {
        const isPitch = /pitch/i.test(name);
        const sub = isPitch ? `≈ ${midiToName(60 + r.last * 12)} (C4 = 0)` : `range ${r.min.toFixed(2)} … ${r.max.toFixed(2)}`;
        const toBar = (v) => Math.max(0, Math.min(1, (v + 1) / 2)); // −1…+1 → bar
        return { value: `${r.last >= 0 ? '+' : ''}${r.last.toFixed(3)}`, sub, bar: [toBar(Math.min(0, r.last)), toBar(Math.max(0, r.last))] };
    }
    const pk = Math.max(Math.abs(r.min), Math.abs(r.max));
    const db = pk > 1e-5 ? 20 * Math.log10(pk) : -Infinity;
    return { value: Number.isFinite(db) ? `${db.toFixed(1)} dBFS peak` : 'Silent', sub: `RMS ${r.rms.toFixed(3)}`, bar: [0, Math.max(0, Math.min(1, (db + 60) / 60))] };
}

export class Readouts {
    constructor(patch, canvas) {
        this.patch = patch;
        this.tip = document.getElementById('jack-readout');
        this.cur = null;
        canvas.addEventListener('pointerover', (e) => {
            if (e.pointerType !== 'mouse') return;
            const node = e.target.closest?.('.node');
            if (!node || this.cur?.node === node) return;
            this.hide();
            const t = setTimeout(() => this.show(node), HOVER_MS);
            this.cur = { node, t };
        });
        canvas.addEventListener('pointerout', (e) => {
            if (!this.cur || e.target.closest?.('.node') !== this.cur.node) return;
            if (e.relatedTarget && this.cur.node.contains(e.relatedTarget)) return;
            this.hide();
        });
        canvas.addEventListener('pointerdown', () => this.hide(), true);
    }
    show(node) {
        const mod = this.patch.modules.get(node.dataset.moduleId);
        if (!mod || !this.cur || this.cur.node !== node) return;
        const tap = tapPort(this.patch, mod, node.dataset.dir, node.dataset.port);
        if (!tap) return;
        this.cur.tap = tap;
        const title = el('div', { class: 'jr-title', text: `${mod.def.title} · ${tap.port.label} ${node.dataset.dir === 'in' ? 'in' : 'out'} (${tap.port.kind})` });
        const value = el('div', { class: 'jr-value' }), sub = el('div', { class: 'jr-sub' }), barFill = el('i'), bar = el('div', { class: 'jr-bar' }, barFill);
        this.tip.replaceChildren(title, value, sub, bar);
        const r = node.getBoundingClientRect();
        this.tip.style.left = `${r.left + r.width / 2}px`;
        this.tip.style.top = `${r.top}px`;
        this.tip.classList.add('visible');
        const tick = () => {
            if (!this.cur || this.cur.tap !== tap) return;
            const d = describe(tap, tap.port.name + ' ' + tap.port.label);
            value.textContent = d.value;
            sub.textContent = d.sub;
            bar.style.display = d.bar ? '' : 'none';
            if (d.bar) { barFill.style.left = `${d.bar[0] * 100}%`; barFill.style.width = `${(d.bar[1] - d.bar[0]) * 100}%`; }
            this.cur.raf = setTimeout(tick, 66);
        };
        tick();
    }
    hide() {
        if (!this.cur) return;
        clearTimeout(this.cur.t);
        clearTimeout(this.cur.raf);
        this.cur.tap && this.cur.tap.dispose();
        this.cur = null;
        this.tip.classList.remove('visible');
    }
}

// A live readout line for the touch long-press menu.
export function menuReadout(patch, ref) {
    const tap = tapPort(patch, ref.mod, ref.dir, ref.port);
    const line = el('div', { class: 'sub-menu-readout' });
    let t = null;
    const tick = () => {
        if (!line.isConnected) { tap && tap.dispose(); return; }
        const d = describe(tap, tap.port.name + ' ' + tap.port.label);
        line.textContent = d.sub ? `${d.value} · ${d.sub}` : d.value;
        t = setTimeout(tick, 100);
    };
    if (tap) setTimeout(tick, 0);
    return line;
}
