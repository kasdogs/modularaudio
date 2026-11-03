// Cable drawing and patching interactions: tap-to-connect, drag-to-connect,
// re-patch by dragging a plugged input, hold/right-click menu, cable gain popup.
import { el, clamp, typingInField } from './util.js';
import { FineSlider } from './controls.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const HOLD_MS = 450;
const DRAG_PX = 6;
const COLORS = { audio: '--output-bg', cv: '--cv-output-bg', gate: '--trigger-output-bg' };

function svg(tag, attrs = {}) {
    const e = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
}

// Sub-section of a cubic Bezier between t0 and t1 (de Casteljau).
function splitCubic(P, t0, t1) {
    const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    const at = (Q, t) => {
        const a = lerp(Q[0], Q[1], t), b = lerp(Q[1], Q[2], t), c = lerp(Q[2], Q[3], t);
        const d = lerp(a, b, t), e = lerp(b, c, t), f = lerp(d, e, t);
        return { left: [Q[0], a, d, f], right: [f, e, c, Q[3]] };
    };
    const right = at(P, t0).right;
    return at(right, (t1 - t0) / (1 - t0)).left;
}

export class Cables {
    constructor(patch, workspace, layer) {
        this.patch = patch;
        this.ws = workspace;
        this.layer = layer;
        this.groups = new Map(); // conn id -> { g, shadow, path, hit, p1, p2 }
        this.ghost = null;
        this.selected = null;    // { mod, port, dir }
        this.pending = false;
        this.hint = document.getElementById('patch-hint');
        this.menu = document.getElementById('node-sub-menu');
        this.popup = document.getElementById('cable-gain-popup');
        this.colors = {};
        this.readColors();
        this.bindNodes();
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !typingInField()) { this.clearSelection(); this.hideMenu(); this.hidePopup(); }
        });
        document.addEventListener('pointerdown', (e) => {
            if (this.menu.classList.contains('visible') && !this.menu.contains(e.target)) this.hideMenu();
            if (this.popup.classList.contains('visible') && !this.popup.contains(e.target) && !e.target.classList?.contains('cable-hit')) this.hidePopup();
        }, true);
    }
    // Drop selection, menus and popups that refer to modules or cables that no longer exist.
    validate() {
        const has = (mod) => mod && this.patch.modules.get(mod.id) === mod;
        if (this.selected && !has(this.selected.mod)) this.clearSelection();
        if (this.menuRef && !has(this.menuRef.mod)) this.hideMenu();
        if (this.popupConn && !this.patch.connections.has(this.popupConn)) this.hidePopup();
    }
    readColors() {
        const cs = getComputedStyle(document.documentElement);
        for (const [k, v] of Object.entries(COLORS)) this.colors[k] = cs.getPropertyValue(v).trim() || '#10b981';
    }

    // --- Geometry ---
    portEl(mod, dir, port) { return mod.port(dir, port)?.el; }
    portPos(mod, dir, port) {
        let target = this.portEl(mod, dir, port);
        if (!target || mod.minimized || !target.isConnected) {
            // Minimised modules: attach to the header edge.
            const h = mod.header.getBoundingClientRect();
            const p = this.ws.toCanvas(dir === 'out' ? h.right : h.left, h.top + h.height / 2);
            return p;
        }
        const r = target.getBoundingClientRect();
        return this.ws.toCanvas(r.left + r.width / 2, r.top + r.height / 2);
    }
    static points(a, b) {
        const dist = Math.hypot(b.x - a.x, b.y - a.y);
        const sag = Math.min(90, dist * 0.18);
        const dx = Math.max(30, Math.abs(b.x - a.x) * 0.35);
        return [a, { x: a.x + dx, y: a.y + sag }, { x: b.x - dx, y: b.y + sag }, b];
    }
    static curve(a, b) {
        const [p0, p1, p2, p3] = Cables.points(a, b);
        return `M ${p0.x} ${p0.y} C ${p1.x} ${p1.y}, ${p2.x} ${p2.y}, ${p3.x} ${p3.y}`;
    }
    // The cable's tap target stops short of both jacks so plugged jacks stay tappable.
    static hitCurve(a, b, trim = 18) {
        const P = Cables.points(a, b);
        let len = 0;
        for (let i = 1; i < 4; i++) len += Math.hypot(P[i].x - P[i - 1].x, P[i].y - P[i - 1].y);
        const t0 = Math.min(0.45, trim / Math.max(1, len)), t1 = 1 - t0;
        const [q0, q1, q2, q3] = splitCubic(P, t0, t1);
        return `M ${q0.x} ${q0.y} C ${q1.x} ${q1.y}, ${q2.x} ${q2.y}, ${q3.x} ${q3.y}`;
    }

    // --- Rendering ---
    scheduleRedraw() {
        if (this.pending) return;
        this.pending = true;
        requestAnimationFrame(() => { this.pending = false; this.redraw(); });
    }
    redraw() {
        const live = new Set();
        for (const c of this.patch.connections.values()) {
            live.add(c.id);
            let g = this.groups.get(c.id);
            if (!g) g = this.makeGroup(c);
            const a = this.portPos(c.from.mod, 'out', c.from.port);
            const b = this.portPos(c.to.mod, 'in', c.to.port);
            const d = Cables.curve(a, b);
            g.shadow.setAttribute('d', d);
            g.path.setAttribute('d', d);
            g.hit.setAttribute('d', Cables.hitCurve(a, b));
            g.p1.setAttribute('cx', a.x); g.p1.setAttribute('cy', a.y);
            g.p2.setAttribute('cx', b.x); g.p2.setAttribute('cy', b.y);
            g.g.classList.toggle('muted', Math.abs(c.gain) < 0.001);
        }
        for (const [id, g] of this.groups) if (!live.has(id)) { g.g.remove(); this.groups.delete(id); }
        // Mark plugged jacks
        for (const m of this.patch.modules.values()) {
            for (const p of [...Object.values(m.inputs), ...Object.values(m.outputs)]) p.el && p.el.classList.toggle('connected', p.conns.size > 0);
        }
    }
    makeGroup(c) {
        const color = this.colors[c.kind] || this.colors.audio;
        const g = svg('g', { class: 'cable-group' });
        const shadow = svg('path', { class: 'cable-shadow', 'stroke-width': 6 });
        const path = svg('path', { class: 'cable', stroke: color, 'stroke-width': 4 });
        if (c.feedback) { path.setAttribute('stroke-dasharray', '10 5'); g.classList.add('feedback'); }
        const hit = svg('path', { class: 'cable-hit' });
        const p1 = svg('circle', { class: 'cable-plug', r: 5, fill: color });
        const p2 = svg('circle', { class: 'cable-plug', r: 5, fill: color });
        g.append(shadow, path, p1, p2, hit);
        hit.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
        hit.addEventListener('click', (e) => { e.stopPropagation(); this.showPopup(c.id, e.clientX, e.clientY); });
        hit.addEventListener('pointerenter', () => g.classList.add('highlight'));
        hit.addEventListener('pointerleave', () => { if (this.popupConn !== c.id) g.classList.remove('highlight'); });
        this.layer.append(g);
        const rec = { g, shadow, path, hit, p1, p2 };
        this.groups.set(c.id, rec);
        return rec;
    }
    recolor() {
        this.readColors();
        for (const [id, g] of this.groups) {
            const c = this.patch.connections.get(id);
            const color = this.colors[c?.kind] || this.colors.audio;
            g.path.setAttribute('stroke', color);
            g.p1.setAttribute('fill', color);
            g.p2.setAttribute('fill', color);
        }
    }

    // --- Patching ---
    refFromNode(node) {
        const mod = this.patch.modules.get(node.dataset.moduleId);
        return mod ? { mod, port: node.dataset.port, dir: node.dataset.dir, node } : null;
    }
    bindNodes() {
        const canvas = this.ws.canvas;
        let st = null;
        canvas.addEventListener('contextmenu', (e) => {
            const node = e.target.closest('.node');
            if (!node) return;
            e.preventDefault();
            const ref = this.refFromNode(node);
            if (ref) this.showMenu(ref, e.clientX, e.clientY);
        });
        canvas.addEventListener('pointerdown', (e) => {
            const node = e.target.closest('.node');
            if (!node || e.button > 0) return;
            e.stopPropagation();
            e.preventDefault();
            const ref = this.refFromNode(node);
            if (!ref) return;
            node.setPointerCapture(e.pointerId);
            st = { id: e.pointerId, ref, node, x: e.clientX, y: e.clientY, dragging: false, held: false };
            st.timer = setTimeout(() => {
                if (!st || st.dragging) return;
                st.held = true;
                this.showMenu(ref, e.clientX, e.clientY);
            }, HOLD_MS);
        });
        canvas.addEventListener('pointermove', (e) => {
            if (!st || e.pointerId !== st.id || st.held) return;
            if (!st.dragging && Math.hypot(e.clientX - st.x, e.clientY - st.y) > DRAG_PX) {
                clearTimeout(st.timer);
                st.dragging = true;
                this.beginDrag(st);
            }
            if (st.dragging) this.moveDrag(st, e);
        });
        const end = (e) => {
            if (!st || e.pointerId !== st.id) return;
            clearTimeout(st.timer);
            const s = st;
            st = null;
            if (s.held) return;
            if (s.dragging) this.endDrag(s, e);
            else this.tap(s.ref);
        };
        canvas.addEventListener('pointerup', end);
        canvas.addEventListener('pointercancel', (e) => { if (st && e.pointerId === st.id) { clearTimeout(st.timer); if (st.dragging) this.cancelDrag(st); st = null; } });
    }
    tap(ref) {
        this.hideMenu();
        this.hidePopup();
        const sel = this.selected;
        if (sel && sel.dir !== ref.dir) {
            const conn = this.patch.connect(sel, ref);
            if (!conn && sel.mod === ref.mod) this.flashHint('A module can’t patch into itself');
            this.clearSelection();
            return;
        }
        if (sel && sel.mod === ref.mod && sel.port === ref.port) { this.clearSelection(); return; }
        this.clearSelection();
        this.selected = ref;
        ref.node.classList.add('selected');
        this.markTargets(ref);
        this.showHint(ref.dir === 'out' ? 'Tap an input to connect · Esc to cancel' : 'Tap an output to connect · Esc to cancel');
    }
    clearSelection() {
        if (this.selected) this.selected.node.classList.remove('selected');
        this.selected = null;
        this.unmarkTargets();
        this.showHint(null);
    }
    markTargets(ref) {
        document.body.classList.add(ref.dir === 'out' ? 'patching' : 'patching-from-in');
        for (const n of this.ws.canvas.querySelectorAll('.node')) {
            const r = this.refFromNode(n);
            n.classList.toggle('drop-ok', !!r && this.patch.canConnect(ref, r));
        }
    }
    unmarkTargets() {
        document.body.classList.remove('patching', 'patching-from-in');
        for (const n of this.ws.canvas.querySelectorAll('.node.drop-ok, .node.drop-target')) n.classList.remove('drop-ok', 'drop-target');
    }
    beginDrag(st) {
        this.hideMenu();
        this.hidePopup();
        this.clearSelection();
        let anchor = st.ref;
        // Dragging a plugged input picks up its most recent cable.
        if (st.ref.dir === 'in') {
            const conns = this.patch.connectionsOf(st.ref.mod, 'in', st.ref.port);
            const c = conns[conns.length - 1];
            if (c) {
                st.repatch = { gain: c.gain, from: { mod: c.from.mod, port: c.from.port, dir: 'out' } };
                this.patch.disconnect(c.id);
                anchor = { ...st.repatch.from, node: c.from.mod.outputs[c.from.port].el };
            }
        }
        st.anchor = anchor;
        const kind = anchor.mod.port(anchor.dir, anchor.port).kind;
        const color = this.colors[kind] || this.colors.audio;
        this.ghost = svg('path', { class: 'cable', stroke: color, 'stroke-width': 4, 'stroke-dasharray': '8 6', opacity: 0.9 });
        this.layer.append(this.ghost);
        this.markTargets(anchor);
    }
    moveDrag(st, e) {
        const a = this.portPos(st.anchor.mod, st.anchor.dir, st.anchor.port);
        const p = this.ws.toCanvas(e.clientX, e.clientY);
        const target = this.nodeAt(e.clientX, e.clientY, st.anchor);
        for (const n of this.ws.canvas.querySelectorAll('.node.drop-target')) if (n !== target?.node) n.classList.remove('drop-target');
        let b = p;
        if (target) { target.node.classList.add('drop-target'); b = this.portPos(target.mod, target.dir, target.port); }
        this.ghost.setAttribute('d', st.anchor.dir === 'out' ? Cables.curve(a, b) : Cables.curve(b, a));
        this.edgeScroll(e);
    }
    nodeAt(x, y, anchor) {
        const hit = document.elementFromPoint(x, y)?.closest?.('.node');
        if (!hit) return null;
        const ref = this.refFromNode(hit);
        return ref && this.patch.canConnect(anchor, ref) ? ref : null;
    }
    endDrag(st, e) {
        const target = this.nodeAt(e.clientX, e.clientY, st.anchor);
        if (target) this.patch.connect(st.anchor, target, st.repatch ? st.repatch.gain : 1);
        this.cancelDrag(st);
    }
    cancelDrag() {
        if (this.ghost) this.ghost.remove();
        this.ghost = null;
        this.unmarkTargets();
        this.scheduleRedraw();
    }
    edgeScroll(e) {
        const r = this.ws.ws.getBoundingClientRect();
        const m = 30;
        let dx = 0, dy = 0;
        if (e.clientX < r.left + m) dx = 8; else if (e.clientX > r.right - m) dx = -8;
        if (e.clientY < r.top + m) dy = 8; else if (e.clientY > r.bottom - m) dy = -8;
        if (dx || dy) { this.ws.view.x += dx; this.ws.view.y += dy; this.ws.apply(); }
    }

    // --- Hint pill ---
    showHint(text) {
        if (!this.hint) return;
        if (text) { this.hint.textContent = text; this.hint.classList.add('visible'); }
        else this.hint.classList.remove('visible');
    }
    flashHint(text) {
        this.showHint(text);
        clearTimeout(this.hintT);
        this.hintT = setTimeout(() => { if (!this.selected) this.showHint(null); }, 1800);
    }

    // --- Node menu (hold / right-click) ---
    showMenu(ref, x, y) {
        this.clearSelection();
        this.menuRef = ref;
        const port = ref.mod.port(ref.dir, ref.port);
        const conns = this.patch.connectionsOf(ref.mod, ref.dir, ref.port);
        const menu = this.menu;
        menu.replaceChildren();
        const close = el('button', { class: 'sub-menu-close-btn', type: 'button', text: '×', 'aria-label': 'Close' });
        close.addEventListener('click', () => this.hideMenu());
        menu.append(el('div', { class: 'sub-menu-header' },
            el('span', { class: 'sub-menu-title', text: `${ref.mod.def.title} · ${port.label} ${ref.dir === 'in' ? 'in' : 'out'}` }), close));
        if (!conns.length) menu.append(el('div', { class: 'sub-menu-empty', text: 'Nothing connected' }));
        for (const c of conns) {
            const other = ref.dir === 'out' ? c.to : c.from;
            const op = other.mod.port(ref.dir === 'out' ? 'in' : 'out', other.port);
            const gainBtn = el('button', { class: 'sub-menu-action-btn gain', type: 'button', text: `Gain ×${c.gain.toFixed(2)}` });
            const delBtn = el('button', { class: 'sub-menu-action-btn delete', type: 'button', text: 'Delete' });
            gainBtn.addEventListener('click', () => { const r = gainBtn.getBoundingClientRect(); this.hideMenu(); this.showPopup(c.id, r.left + r.width / 2, r.top); });
            delBtn.addEventListener('click', () => { this.patch.disconnect(c.id); this.showMenu(ref, x, y); });
            menu.append(el('div', { class: 'sub-menu-module-item' },
                el('div', { class: 'sub-menu-module-name', text: `${ref.dir === 'out' ? '→' : '←'} ${other.mod.def.title} · ${op?.label || other.port}` }),
                el('div', { class: 'sub-menu-module-actions' }, gainBtn, delBtn)));
        }
        if (conns.length > 1) {
            const all = el('button', { class: 'sub-menu-action-btn delete', type: 'button', text: 'Disconnect all' });
            all.addEventListener('click', () => { conns.forEach((c) => this.patch.disconnect(c.id)); this.hideMenu(); });
            menu.append(all);
        }
        menu.classList.add('visible');
        const r = menu.getBoundingClientRect();
        menu.style.left = `${clamp(x + 12, 8, window.innerWidth - r.width - 8)}px`;
        menu.style.top = `${clamp(y - 12, 8, window.innerHeight - r.height - 8)}px`;
    }
    hideMenu() { this.menuRef = null; this.menu.classList.remove('visible'); }

    // --- Cable gain popup ---
    showPopup(connId, x, y) {
        const c = this.patch.connections.get(connId);
        if (!c) return;
        this.hidePopup();
        this.popupConn = connId;
        this.groups.get(connId)?.g.classList.add('highlight');
        const pop = this.popup;
        pop.replaceChildren();
        const fromP = c.from.mod.outputs[c.from.port], toP = c.to.mod.inputs[c.to.port];
        const value = el('span', { class: 'param-value-display' });
        const slider = new FineSlider({ key: 'gain', label: 'Cable gain', min: -2, max: 2, default: 1 }, (v) => {
            this.patch.setCableGain(connId, v);
            value.textContent = `×${v.toFixed(3)}`;
            this.scheduleRedraw();
        });
        slider.setValue(c.gain);
        value.textContent = `×${c.gain.toFixed(3)}`;
        const reset = el('button', { class: 'cable-gain-ok-btn', type: 'button', text: '×1' });
        const ok = el('button', { class: 'cable-gain-ok-btn', type: 'button', text: 'OK' });
        const del = el('button', { class: 'cable-delete-btn', type: 'button', text: 'Delete' });
        reset.addEventListener('click', () => slider.setValue(1, true));
        ok.addEventListener('click', () => this.hidePopup());
        del.addEventListener('click', () => { this.patch.disconnect(connId); this.hidePopup(); });
        pop.append(
            el('div', { class: 'cg-title', text: 'Cable Gain' }),
            el('div', { class: 'cg-sub', text: `${c.from.mod.def.title} ${fromP.label} → ${c.to.mod.def.title} ${toP.label}` }),
            c.feedback ? el('div', { class: 'cg-sub', text: 'Feedback loop (dashed): delayed by one audio block' }) : null,
            el('div', { class: 'param-control-wrapper' }, slider.root, value),
            el('div', { class: 'cg-actions' }, reset, ok, del));
        pop.classList.add('visible');
        const r = pop.getBoundingClientRect();
        pop.style.left = `${clamp(x, r.width / 2 + 8, window.innerWidth - r.width / 2 - 8)}px`;
        pop.style.top = `${clamp(y - r.height / 2 - 16, r.height / 2 + 8, window.innerHeight - r.height / 2 - 8)}px`;
        slider.root.focus({ preventScroll: true });
    }
    hidePopup() {
        if (this.popupConn) this.groups.get(this.popupConn)?.g.classList.remove('highlight');
        this.popupConn = null;
        this.popup.classList.remove('visible');
    }
}
