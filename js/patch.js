// Patch model: modules, ports and connections, plus (de)serialisation.
import { audio, setParam } from './audio.js';
import { el } from './util.js';
import { sliderControl, selectControl, pitchControl } from './controls.js';

export const registry = new Map(); // type -> module definition
export function registerModule(def) { registry.set(def.type, def); }

let nextId = 1;

// Coerce a stored value to what the parameter spec allows (bad presets must never break a module).
export function sanitize(spec, v) {
    const d = spec.default;
    if (v === undefined || v === null) return d;
    if (spec.options) {
        const hit = spec.options.find((o) => String(o.value) === String(v));
        return hit ? hit.value : d;
    }
    if (Array.isArray(d)) return Array.isArray(v) ? v : d;
    if (typeof d === 'number') {
        const n = Number(v);
        if (!Number.isFinite(n)) return d;
        return typeof spec.min === 'number' ? Math.min(spec.max, Math.max(spec.min, n)) : n;
    }
    if (typeof d === 'string') return typeof v === 'string' ? v : d;
    return v;
}
let nextConnId = 1;

export class Module {
    constructor(def, patch, state = {}) {
        this.def = def;
        this.patch = patch;
        this.type = def.type;
        this.id = state.id || `${def.type}-${nextId++}`;
        const n = parseInt(String(this.id).split('-').pop(), 10);
        if (Number.isFinite(n)) nextId = Math.max(nextId, n + 1);
        this.x = Number.isFinite(state.x) ? state.x : 40;
        this.y = Number.isFinite(state.y) ? state.y : 40;
        this.minimized = !!state.minimized;
        this.params = {};
        for (const [k, spec] of Object.entries(def.params || {})) this.params[k] = spec.default;
        if (state.params && typeof state.params === 'object') for (const [k, v] of Object.entries(state.params)) if (k in this.params) this.params[k] = sanitize(def.params[k], v);
        this.locks = new Set(Array.isArray(state.locks) ? state.locks : []);
        this.worklets = [];
        this.visible = true;
        this.inputs = {};   // name -> { name, label, kind, target, index, conns:Set, onConnect }
        this.outputs = {};  // name -> { name, label, kind, node, index, conns:Set }
        this.controls = {}; // key -> { set, lock }
        this.timers = [];
        this.raf = null;
        this.buildElement();
        this.impl = def.create(this, audio.ctx) || {};
        this.buildPorts();
        for (const k of Object.keys(this.params)) this.applyParam(k);
        this.refreshControls();
    }

    // --- DOM ---
    buildElement() {
        const canDelete = this.def.deletable !== false;
        this.minBtn = el('button', { class: 'module-button minimize-btn', type: 'button', title: 'Minimize', text: '−' });
        this.delBtn = el('button', { class: 'module-button delete-btn', type: 'button', title: 'Delete', text: '✕' });
        this.header = el('div', { class: 'module-header handle' },
            this.def.minimizable === false ? el('span', { class: 'module-spacer' }) : this.minBtn,
            el('h3', { class: 'module-title', text: this.def.title }),
            canDelete ? this.delBtn : el('span', { class: 'module-spacer' }));
        this.content = el('div', { class: 'module-content' });
        this.element = el('div', { class: `module module-${this.type}`, dataset: { moduleId: this.id } }, this.header, this.content);
        if (this.def.width) this.element.style.width = `${this.def.width}px`;
        this.minBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
        this.delBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
        this.minBtn.addEventListener('click', () => this.setMinimized(!this.minimized));
        this.delBtn.addEventListener('click', () => this.patch.removeModule(this.id));
        this.header.addEventListener('dblclick', () => { if (this.def.minimizable !== false) this.setMinimized(!this.minimized); });
        this.element.classList.toggle('minimized', this.minimized);
        this.minBtn.textContent = this.minimized ? '+' : '−';
        this.setPosition(this.x, this.y);
    }
    setPosition(x, y) {
        this.x = Math.round(x);
        this.y = Math.round(y);
        this.element.style.transform = `translate(${this.x}px, ${this.y}px)`;
    }
    setMinimized(m) {
        this.minimized = m;
        this.element.classList.toggle('minimized', m);
        this.minBtn.textContent = m ? '+' : '−';
        this.minBtn.title = m ? 'Expand' : 'Minimize';
        this.patch.changed();
    }

    // --- Ports ---
    addInput(name, label, kind, target, opts = {}) {
        this.inputs[name] = { name, label, kind, target, index: opts.index || 0, conns: new Set(), onConnect: opts.onConnect, dir: 'in' };
    }
    addOutput(name, label, kind, node, opts = {}) {
        this.outputs[name] = { name, label, kind, node, index: opts.index || 0, conns: new Set(), dir: 'out' };
    }
    buildPorts() {
        const ins = Object.values(this.inputs), outs = Object.values(this.outputs);
        if (!ins.length && !outs.length) return;
        const mk = (p) => {
            const node = el('div', { class: `node ${p.dir} ${p.kind}`, title: `${p.label} (${p.kind} ${p.dir === 'in' ? 'input' : 'output'})`,
                dataset: { moduleId: this.id, port: p.name, dir: p.dir, kind: p.kind } });
            p.el = node;
            const label = el('span', { class: 'node-label', text: p.label });
            return el('div', { class: 'node-item' }, p.dir === 'in' ? [node, label] : [label, node]);
        };
        const row = el('div', { class: 'node-row' },
            el('div', { class: 'node-group-vertical inputs' }, ins.map(mk)),
            el('div', { class: 'node-group-vertical outputs' }, outs.map(mk)));
        (this.impl.portContainer || this.content).append(row);
    }
    port(dir, name) { return dir === 'in' ? this.inputs[name] : this.outputs[name]; }

    // --- Params ---
    spec(key) { return { key, ...this.def.params[key] }; }
    slider(key, parent = this.content) {
        const c = sliderControl(this, this.spec(key));
        this.controls[key] = c;
        parent.append(c.el);
        return c;
    }
    select(key, parent = this.content) {
        const c = selectControl(this, this.spec(key));
        this.controls[key] = c;
        parent.append(c.el);
        return c;
    }
    pitch(opts, parent = this.content) {
        const p = pitchControl(this, opts);
        Object.assign(this.controls, p.controls);
        this.pitchUi = p;
        parent.append(p.el);
        return p;
    }
    setParam(key, value, apply = true) {
        if (!(key in this.params)) return;
        this.params[key] = value;
        const c = this.controls[key];
        if (c) c.set(value);
        if (apply) this.applyParam(key);
        if (this.pitchUi) this.pitchUi.refresh();
        this.patch.changed();
    }
    applyParam(key) { if (this.impl.update) this.impl.update(key, this.params[key]); }
    resetParam(key) {
        const spec = this.def.params[key];
        if (spec) this.setParam(key, spec.default);
    }
    isLocked(key) { return this.locks.has(key); }
    setLocked(key, l) {
        if (l) this.locks.add(key); else this.locks.delete(key);
        const c = this.controls[key];
        if (c) c.lock(l);
        this.patch.changed();
    }
    refreshControls() {
        for (const [k, c] of Object.entries(this.controls)) {
            if (k in this.params) c.set(this.params[k]);
            c.lock(this.locks.has(k));
        }
        if (this.pitchUi) this.pitchUi.refresh();
        if (this.impl.refresh) this.impl.refresh();
    }
    // Create an AudioWorkletNode that is retired automatically when the module is deleted.
    worklet(name, opts) {
        const n = new AudioWorkletNode(audio.ctx, name, opts);
        this.worklets.push(n);
        return n;
    }
    // Animation loop for displays: skipped while minimised, off-screen or in a hidden tab; stops on dispose.
    animate(fn) {
        let frame = 0;
        const loop = () => {
            this.raf = requestAnimationFrame(loop);
            if (frame++ % 15 === 0) {
                const r = this.element.getBoundingClientRect();
                this.visible = r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
            }
            if (document.hidden || this.minimized || !this.visible) return;
            fn();
        };
        this.raf = requestAnimationFrame(loop);
    }
    // Smooth AudioParam helper exposed to modules.
    set(param, v, t) { setParam(param, v, t); }

    serialize() {
        return { id: this.id, type: this.type, x: this.x, y: this.y, minimized: this.minimized || undefined,
            params: { ...this.params }, locks: this.locks.size ? [...this.locks] : undefined };
    }
    dispose() {
        if (this.raf) cancelAnimationFrame(this.raf);
        this.timers.forEach(clearInterval);
        try { this.impl.dispose && this.impl.dispose(); } catch (e) { console.warn(e); }
        for (const w of this.worklets) {
            try { w.port.postMessage('__dispose'); w.port.onmessage = null; w.disconnect(); } catch (e) {}
        }
        for (const p of [...Object.values(this.outputs)]) {
            try { p.node.disconnect(); } catch (e) {}
        }
        this.element.remove();
    }
}

export class Patch {
    constructor(canvas) {
        this.canvas = canvas;
        this.modules = new Map();
        this.connections = new Map();
        this.listeners = new Set();
        this.suspendEvents = 0;
    }
    onChange(fn) { this.listeners.add(fn); }
    changed(kind = 'params') { if (!this.suspendEvents) this.listeners.forEach((fn) => fn(kind)); }

    addModule(type, state = {}) {
        const def = registry.get(type);
        if (!def) { console.warn(`Unknown module type: ${type}`); return null; }
        if (def.singleton && [...this.modules.values()].some((m) => m.type === type)) return [...this.modules.values()].find((m) => m.type === type);
        if (state.id && this.modules.has(state.id)) state = { ...state, id: undefined }; // duplicate id in a preset
        const m = new Module(def, this, state);
        this.modules.set(m.id, m);
        this.canvas.append(m.element);
        this.changed('structure');
        return m;
    }
    removeModule(id) {
        const m = this.modules.get(id);
        if (!m || m.def.deletable === false) return;
        for (const c of [...this.connections.values()]) if (c.from.mod === m || c.to.mod === m) this.disconnect(c.id, false);
        m.dispose();
        this.modules.delete(id);
        this.changed('structure');
    }

    canConnect(a, b) {
        if (!a || !b || a.dir === b.dir) return false;
        const out = a.dir === 'out' ? a : b, inp = a.dir === 'out' ? b : a;
        if (out.mod === inp.mod) return false;
        for (const c of this.connections.values()) if (c.from.port === out.port && c.to.port === inp.port && c.from.mod === out.mod && c.to.mod === inp.mod) return false;
        return true;
    }
    // a/b: { mod, port, dir } in any order.
    connect(a, b, gain = 1, id) {
        if (!this.canConnect(a, b)) return null;
        const from = a.dir === 'out' ? a : b, to = a.dir === 'out' ? b : a;
        const op = from.mod.outputs[from.port], ip = to.mod.inputs[to.port];
        if (!op || !ip) return null;
        if (!Number.isFinite(gain)) gain = 1;
        const g = audio.ctx.createGain();
        g.gain.value = gain;
        // A cable that closes a loop gets a DelayNode: Web Audio requires one in every cycle,
        // and browsers that follow the spec strictly (e.g. Firefox) silence loops without it.
        const feedback = this.reaches(to.mod, from.mod);
        let last = g;
        if (feedback) { last = audio.ctx.createDelay(0.01); last.delayTime.value = 0; g.connect(last); }
        try {
            op.node.connect(g, op.index);
            if (ip.target instanceof AudioParam) last.connect(ip.target);
            else last.connect(ip.target, 0, ip.index);
        } catch (e) {
            console.warn('Connection failed', e);
            try { g.disconnect(); } catch (_) {}
            return null;
        }
        const conn = { id: id || `c${nextConnId++}`, from: { mod: from.mod, port: from.port }, to: { mod: to.mod, port: to.port }, gain, gainNode: g, delayNode: last !== g ? last : null, feedback, kind: op.kind };
        const n = parseInt(String(conn.id).slice(1), 10);
        if (Number.isFinite(n)) nextConnId = Math.max(nextConnId, n + 1);
        this.connections.set(conn.id, conn);
        op.conns.add(conn.id);
        ip.conns.add(conn.id);
        if (ip.onConnect) ip.onConnect(ip.conns.size);
        this.changed('structure');
        return conn;
    }
    // Is there a cable path from module a to module b?
    reaches(a, b) {
        if (a === b) return true;
        const seen = new Set([a]), stack = [a];
        while (stack.length) {
            const m = stack.pop();
            for (const c of this.connections.values()) {
                if (c.from.mod !== m || seen.has(c.to.mod)) continue;
                if (c.to.mod === b) return true;
                seen.add(c.to.mod);
                stack.push(c.to.mod);
            }
        }
        return false;
    }
    disconnect(id, notify = true) {
        const c = this.connections.get(id);
        if (!c) return;
        const op = c.from.mod.outputs[c.from.port], ip = c.to.mod.inputs[c.to.port];
        try { op.node.disconnect(c.gainNode, op.index); } catch (e) {}
        try { c.gainNode.disconnect(); } catch (e) {}
        try { c.delayNode && c.delayNode.disconnect(); } catch (e) {}
        op.conns.delete(id);
        ip.conns.delete(id);
        this.connections.delete(id);
        if (ip.onConnect) ip.onConnect(ip.conns.size);
        if (notify) this.changed('structure');
    }
    setCableGain(id, g) {
        const c = this.connections.get(id);
        if (!c) return;
        c.gain = g;
        setParam(c.gainNode.gain, g, 0.01);
        this.changed('params');
    }
    connectionsOf(mod, dir, port) {
        return [...this.connections.values()].filter((c) => (dir === 'out' ? c.from : c.to).mod === mod && (dir === 'out' ? c.from : c.to).port === port);
    }

    // Run fn with change events held back, then send a single 'structure' event.
    batch(fn) {
        const depth = this.suspendEvents;
        this.suspendEvents++;
        try { return fn(); } finally { this.suspendEvents = depth; this.changed('structure'); }
    }

    // Bring the patch to a saved state by changing only what differs (used by undo/redo),
    // so untouched modules keep running without a glitch.
    applySnapshot(data) {
        return this.batch(() => {
            const want = new Map();
            for (const s of data.modules || []) if (s && registry.has(s.type)) want.set(s.id, s);
            // Permanent modules (Output) are kept and re-identified rather than recreated.
            for (const s of want.values()) {
                const def = registry.get(s.type);
                if (def.deletable === false && !this.modules.has(s.id)) {
                    const ex = [...this.modules.values()].find((m) => m.type === s.type);
                    if (ex) this.restoreInto(ex, s);
                }
            }
            for (const m of [...this.modules.values()]) {
                const s = want.get(m.id);
                if (!s || s.type !== m.type) {
                    if (m.def.deletable === false) continue;
                    for (const c of [...this.connections.values()]) if (c.from.mod === m || c.to.mod === m) this.disconnect(c.id, false);
                    m.dispose();
                    this.modules.delete(m.id);
                }
            }
            for (const s of want.values()) {
                const m = this.modules.get(s.id);
                if (!m) { this.addModule(s.type, s); continue; }
                if (m.x !== s.x || m.y !== s.y) m.setPosition(s.x, s.y);
                if (!!s.minimized !== m.minimized) { m.minimized = !!s.minimized; m.element.classList.toggle('minimized', m.minimized); m.minBtn.textContent = m.minimized ? '+' : '−'; }
                for (const [k, v] of Object.entries(s.params || {})) {
                    if (!(k in m.params)) continue;
                    const nv = sanitize(m.def.params[k], v);
                    if (JSON.stringify(nv) !== JSON.stringify(m.params[k])) { m.params[k] = nv; m.applyParam(k); }
                }
                m.locks = new Set(Array.isArray(s.locks) ? s.locks : []);
                m.refreshControls();
            }
            const key = (f, fp, t, tp) => `${f}|${fp}|${t}|${tp}`;
            const wantC = new Map();
            for (const c of data.connections || []) if (c && Array.isArray(c.from) && Array.isArray(c.to)) wantC.set(key(c.from[0], c.from[1], c.to[0], c.to[1]), c);
            for (const c of [...this.connections.values()]) {
                const w = wantC.get(key(c.from.mod.id, c.from.port, c.to.mod.id, c.to.port));
                if (!w) this.disconnect(c.id, false);
                else { if (w.gain !== c.gain) this.setCableGain(c.id, Number(w.gain ?? 1)); wantC.delete(key(c.from.mod.id, c.from.port, c.to.mod.id, c.to.port)); }
            }
            for (const c of wantC.values()) {
                const a = this.modules.get(c.from[0]), b = this.modules.get(c.to[0]);
                if (a && b) this.connect({ mod: a, port: c.from[1], dir: 'out' }, { mod: b, port: c.to[1], dir: 'in' }, Number(c.gain ?? 1));
            }
        });
    }

    // Serialise a set of modules and the cables between them (copy / subpatch export).
    serializeGroup(mods) {
        const set = new Set(mods.filter((m) => m.def.deletable !== false));
        return {
            app: 'modularaudio', kind: 'subpatch', version: 1,
            modules: [...set].map((m) => m.serialize()),
            connections: [...this.connections.values()].filter((c) => set.has(c.from.mod) && set.has(c.to.mod))
                .map((c) => ({ from: [c.from.mod.id, c.from.port], to: [c.to.mod.id, c.to.port], gain: c.gain })),
        };
    }
    // Add a group of modules (paste / subpatch import) with fresh ids, its top-left at (x, y).
    // Never replaces anything already in the patch.
    insert(data, x, y) {
        if (!data || !Array.isArray(data.modules)) throw new Error('Not a Modular Audio subpatch.');
        const mods = data.modules.filter((s) => s && registry.has(s.type) && registry.get(s.type).deletable !== false && !registry.get(s.type).singleton);
        const skipped = data.modules.filter((s) => s && !registry.has(s.type)).map((s) => s.type);
        if (!mods.length) return { added: [], skipped };
        const x0 = Math.min(...mods.map((s) => (Number.isFinite(s.x) ? s.x : 0)));
        const y0 = Math.min(...mods.map((s) => (Number.isFinite(s.y) ? s.y : 0)));
        const idMap = new Map();
        const added = this.batch(() => {
            const out = [];
            for (const s of mods) {
                const m = this.addModule(s.type, { ...s, id: undefined, x: x + ((Number.isFinite(s.x) ? s.x : 0) - x0), y: y + ((Number.isFinite(s.y) ? s.y : 0) - y0) });
                if (m) { idMap.set(s.id, m); out.push(m); }
            }
            for (const c of Array.isArray(data.connections) ? data.connections : []) {
                const a = idMap.get(c?.from?.[0]), b = idMap.get(c?.to?.[0]);
                if (a && b) this.connect({ mod: a, port: c.from[1], dir: 'out' }, { mod: b, port: c.to[1], dir: 'in' }, Number(c.gain ?? 1));
            }
            return out;
        });
        return { added, skipped };
    }

    clear() {
        this.suspendEvents++;
        for (const id of [...this.connections.keys()]) this.disconnect(id, false);
        for (const m of [...this.modules.values()]) {
            if (m.def.deletable === false) continue;
            m.dispose();
            this.modules.delete(m.id);
        }
        this.suspendEvents--;
        this.changed('structure');
    }
    serialize(view) {
        return {
            app: 'modularaudio', kind: 'patch', version: 1,
            modules: [...this.modules.values()].map((m) => m.serialize()),
            connections: [...this.connections.values()].map((c) => ({ from: [c.from.mod.id, c.from.port], to: [c.to.mod.id, c.to.port], gain: c.gain })),
            view,
        };
    }
    load(data) {
        if (!data || typeof data !== 'object' || !Array.isArray(data.modules)) throw new Error('Not a Modular Audio preset.');
        if (data.kind === 'subpatch') throw new Error('This file is a subpatch. Use “Add Subpatch” to add it to your patch.');
        const depth = this.suspendEvents;
        this.suspendEvents++;
        const skipped = [];
        try {
            this.clear();
            for (const s of data.modules) {
                if (!s || typeof s !== 'object' || !registry.has(s.type)) { skipped.push(s && s.type); continue; }
                try {
                    const def = registry.get(s.type);
                    const existing = def.deletable === false ? [...this.modules.values()].find((m) => m.type === s.type) : null;
                    if (existing) this.restoreInto(existing, s);
                    else this.addModule(s.type, s);
                } catch (e) {
                    console.warn(`Could not restore ${s.type}`, e);
                    skipped.push(s.type);
                }
            }
            for (const c of Array.isArray(data.connections) ? data.connections : []) {
                if (!c || !Array.isArray(c.from) || !Array.isArray(c.to)) continue;
                const a = this.modules.get(c.from[0]), b = this.modules.get(c.to[0]);
                if (!a || !b) continue;
                this.connect({ mod: a, port: c.from[1], dir: 'out' }, { mod: b, port: c.to[1], dir: 'in' }, Number(c.gain ?? 1));
            }
        } finally {
            // Always restore event delivery, even if something above threw.
            this.suspendEvents = depth;
        }
        this.changed('structure');
        return { skipped: skipped.filter(Boolean) };
    }
    // Keep a permanent module (Output) but move it and restore its settings under the saved id.
    restoreInto(existing, s) {
        const id = typeof s.id === 'string' ? s.id : existing.id;
        this.modules.delete(existing.id);
        existing.id = id;
        existing.element.dataset.moduleId = id;
        Object.values(existing.inputs).concat(Object.values(existing.outputs)).forEach((p) => p.el && (p.el.dataset.moduleId = id));
        this.modules.set(id, existing);
        existing.setPosition(Number.isFinite(s.x) ? s.x : existing.x, Number.isFinite(s.y) ? s.y : existing.y);
        if (s.params && typeof s.params === 'object') {
            for (const [k, v] of Object.entries(s.params)) if (k in existing.params) { existing.params[k] = sanitize(existing.def.params[k], v); existing.applyParam(k); }
        }
        existing.locks = new Set(Array.isArray(s.locks) ? s.locks : []);
        existing.refreshControls();
    }
}
