// Workspace view: pan, pinch/wheel zoom, module dragging and placement.
import { clamp } from './util.js';

const MIN_ZOOM = 0.2, MAX_ZOOM = 2;
const READABLE_ZOOM = 0.55; // smallest zoom 'fit' will use before panning to the top-left instead

export class Workspace {
    constructor(container, canvas, patch, onViewChange) {
        this.ws = container;
        this.canvas = canvas;
        this.patch = patch;
        this.view = { x: 0, y: 0, zoom: 1 };
        this.onViewChange = onViewChange;
        this.pointers = new Map();
        this.topZ = 10;
        this.bindPanZoom();
        this.bindModuleDrag();
        this.apply();
    }
    apply() {
        const { x, y, zoom } = this.view;
        this.canvas.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
        this.onViewChange && this.onViewChange();
    }
    setView(v) { Object.assign(this.view, v); this.view.zoom = clamp(this.view.zoom, MIN_ZOOM, MAX_ZOOM); this.apply(); }
    // Screen (client) -> canvas coordinates
    toCanvas(cx, cy) {
        const r = this.ws.getBoundingClientRect();
        return { x: (cx - r.left - this.view.x) / this.view.zoom, y: (cy - r.top - this.view.y) / this.view.zoom };
    }
    zoomAt(cx, cy, factor) {
        const r = this.ws.getBoundingClientRect();
        const z = clamp(this.view.zoom * factor, MIN_ZOOM, MAX_ZOOM);
        const px = cx - r.left, py = cy - r.top;
        const k = z / this.view.zoom;
        this.view.x = px - (px - this.view.x) * k;
        this.view.y = py - (py - this.view.y) * k;
        this.view.zoom = z;
        this.apply();
    }
    isBackground(target) {
        return target === this.ws || target === this.canvas || target.id === 'cable-layer';
    }
    bindPanZoom() {
        const ws = this.ws;
        let pan = null, pinch = null;
        ws.addEventListener('pointerdown', (e) => {
            if (!this.isBackground(e.target)) return;
            this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            ws.setPointerCapture(e.pointerId);
            if (this.pointers.size === 1) {
                pan = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y, moved: false };
                ws.classList.add('panning');
            } else if (this.pointers.size === 2) {
                pan = null;
                const [a, b] = [...this.pointers.values()];
                pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
            }
        });
        ws.addEventListener('pointermove', (e) => {
            if (!this.pointers.has(e.pointerId)) return;
            this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (pinch && this.pointers.size >= 2) {
                const [a, b] = [...this.pointers.values()];
                const d = Math.hypot(a.x - b.x, a.y - b.y);
                const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
                this.view.x += cx - pinch.cx;
                this.view.y += cy - pinch.cy;
                this.zoomAt(cx, cy, d / Math.max(1, pinch.d));
                pinch = { d, cx, cy };
            } else if (pan) {
                const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
                if (Math.abs(dx) + Math.abs(dy) > 3) pan.moved = true;
                this.view.x = pan.vx + dx;
                this.view.y = pan.vy + dy;
                this.apply();
            }
        });
        const up = (e) => {
            if (!this.pointers.has(e.pointerId)) return;
            this.pointers.delete(e.pointerId);
            if (this.pointers.size < 2) pinch = null;
            if (this.pointers.size === 0) {
                ws.classList.remove('panning');
                if (pan && !pan.moved && this.onBackgroundTap) this.onBackgroundTap(e);
                pan = null;
                this.onViewCommit && this.onViewCommit();
            }
        };
        ws.addEventListener('pointerup', up);
        ws.addEventListener('pointercancel', up);
        ws.addEventListener('wheel', (e) => {
            e.preventDefault();
            if (e.ctrlKey || e.metaKey) {
                this.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01));
            } else {
                this.view.x -= e.deltaX;
                this.view.y -= e.deltaY;
                this.apply();
            }
            clearTimeout(this.wheelT);
            this.wheelT = setTimeout(() => this.onViewCommit && this.onViewCommit(), 300);
        }, { passive: false });
        // Safari trackpad pinch
        ws.addEventListener('gesturestart', (e) => e.preventDefault());
    }
    bindModuleDrag() {
        let drag = null;
        this.canvas.addEventListener('pointerdown', (e) => {
            const modEl = e.target.closest('.module');
            if (!modEl) return;
            this.bringToFront(modEl);
            const header = e.target.closest('.module-header');
            if (!header || e.target.closest('button')) return;
            const m = this.patch.modules.get(modEl.dataset.moduleId);
            if (!m) return;
            e.preventDefault();
            header.setPointerCapture(e.pointerId);
            const p = this.toCanvas(e.clientX, e.clientY);
            drag = { id: e.pointerId, m, ox: p.x - m.x, oy: p.y - m.y, header, moved: false };
            modEl.classList.add('dragging');
        });
        this.canvas.addEventListener('pointermove', (e) => {
            if (!drag || e.pointerId !== drag.id) return;
            const p = this.toCanvas(e.clientX, e.clientY);
            drag.m.setPosition(p.x - drag.ox, p.y - drag.oy);
            drag.moved = true;
            this.onModuleMove && this.onModuleMove(drag.m);
        });
        const end = (e) => {
            if (!drag || e.pointerId !== drag.id) return;
            drag.m.element.classList.remove('dragging');
            if (drag.moved) this.patch.changed('layout');
            drag = null;
        };
        this.canvas.addEventListener('pointerup', end);
        this.canvas.addEventListener('pointercancel', end);
    }
    bringToFront(modEl) {
        if (modEl.style.zIndex === String(this.topZ)) return;
        modEl.style.zIndex = String(++this.topZ);
    }
    // Find a free spot near the centre of the visible area.
    freeSpot(width = 200, height = 260, exclude = null) {
        const r = this.ws.getBoundingClientRect();
        const c = this.toCanvas(r.left + r.width / 2, r.top + r.height / 2);
        const boxes = [...this.patch.modules.values()].filter((m) => m !== exclude).map((m) => ({ x: m.x, y: m.y, w: m.element.offsetWidth || 200, h: m.element.offsetHeight || 200 }));
        const hits = (x, y) => boxes.some((b) => x < b.x + b.w + 12 && x + width + 12 > b.x && y < b.y + b.h + 12 && y + height + 12 > b.y);
        const start = { x: c.x - width / 2, y: c.y - height / 2 };
        for (let ring = 0; ring < 12; ring++) {
            for (let i = 0; i < Math.max(1, ring * 8); i++) {
                const a = (i / Math.max(1, ring * 8)) * Math.PI * 2;
                const x = start.x + Math.cos(a) * ring * 110, y = start.y + Math.sin(a) * ring * 90;
                if (!hits(x, y)) return { x, y };
            }
        }
        return { x: start.x + Math.random() * 60, y: start.y + Math.random() * 60 };
    }
    // Move a just-added module to a free spot using its real rendered size.
    place(m) {
        const spot = this.freeSpot(m.element.offsetWidth, m.element.offsetHeight, m);
        m.setPosition(spot.x, spot.y);
        this.patch.changed('layout');
    }
    // Push modules down within each column so none overlap (used for the example layout).
    stackColumns(gap = 20) {
        const cols = new Map();
        for (const m of this.patch.modules.values()) {
            if (!cols.has(m.x)) cols.set(m.x, []);
            cols.get(m.x).push(m);
        }
        for (const list of cols.values()) {
            list.sort((a, b) => a.y - b.y);
            let bottom = -Infinity;
            for (const m of list) {
                if (m.y < bottom + gap) m.setPosition(m.x, bottom + gap);
                bottom = m.y + m.element.offsetHeight;
            }
        }
        this.patch.changed('layout');
    }
    fit(pad = 40) {
        const mods = [...this.patch.modules.values()];
        if (!mods.length) return;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const m of mods) {
            x0 = Math.min(x0, m.x); y0 = Math.min(y0, m.y);
            x1 = Math.max(x1, m.x + m.element.offsetWidth); y1 = Math.max(y1, m.y + m.element.offsetHeight);
        }
        const r = this.ws.getBoundingClientRect();
        const z = Math.min((r.width - pad * 2) / (x1 - x0), (r.height - pad * 2) / (y1 - y0), 1);
        if (z < READABLE_ZOOM) {
            // Too big to fit legibly (phones): show the start of the patch at a readable size.
            const zr = READABLE_ZOOM;
            this.setView({ zoom: zr, x: 16 - x0 * zr, y: 16 - y0 * zr });
        } else {
            this.setView({ zoom: z, x: (r.width - (x1 - x0) * z) / 2 - x0 * z, y: (r.height - (y1 - y0) * z) / 2 - y0 * z });
        }
        this.onViewCommit && this.onViewCommit();
    }
}
