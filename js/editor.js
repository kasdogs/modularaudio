// Editing layer: undo/redo, selection, clipboard, subpatches, quick add and share links.
import { el, toast, typingInField, clamp } from './util.js';
import { search } from './search.js';

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = isMac ? '⌘' : 'Ctrl+';
const PASTE_OFFSET = 30;

// ---------- share links: patch JSON -> deflate -> base64url in the URL hash ----------
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
async function pipe(bytes, stream) {
    const out = await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer();
    return new Uint8Array(out);
}
export async function encodeShare(data) {
    const json = new TextEncoder().encode(JSON.stringify(data));
    if (typeof CompressionStream === 'function') {
        const z = await pipe(json, new CompressionStream('deflate-raw'));
        let s = '';
        for (let i = 0; i < z.length; i += 0x8000) s += String.fromCharCode(...z.subarray(i, i + 0x8000));
        return 'z' + btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    return 'j' + b64url(json);
}
export async function decodeShare(code) {
    const kind = code[0], bytes = unb64url(code.slice(1));
    const raw = kind === 'z' ? await pipe(bytes, new DecompressionStream('deflate-raw')) : bytes;
    return JSON.parse(new TextDecoder().decode(raw));
}

export class Editor {
    constructor({ patch, ws, cables, history, categories, fitView }) {
        Object.assign(this, { patch, ws, cables, history, categories, fitView });
        this.clipboard = null;  // last copied subpatch (also put on the system clipboard as text)
        this.pasteCount = 0;
        this.menu = document.getElementById('edit-menu');
        this.menuBtn = document.getElementById('edit-btn');
        this.bar = document.getElementById('selection-bar');
        this.undoBtn = document.getElementById('undo-btn');
        this.redoBtn = document.getElementById('redo-btn');
        this.quick = document.getElementById('quick-add');
        this.quickInput = document.getElementById('quick-add-input');
        this.quickList = document.getElementById('quick-add-list');
        this.subInput = document.getElementById('subpatch-input');
        this.bindKeys();
        this.bindClipboard();
        this.bindMenu();
        this.bindQuickAdd();
        this.undoBtn.addEventListener('click', () => this.undo());
        this.redoBtn.addEventListener('click', () => this.redo());
        this.subInput.addEventListener('change', () => this.importSubpatchFile());
        ws.onSelectionChange = () => this.renderBar();
        ws.onBackgroundDoubleTap = (e) => this.openQuickAdd(e.clientX, e.clientY);
        this.updateButtons();
    }

    // ---------- undo / redo ----------
    undo() { if (this.history.undo()) { this.ws.pruneSelection(); toast('Undo'); } }
    redo() { if (this.history.redo()) { this.ws.pruneSelection(); toast('Redo'); } }
    updateButtons() {
        this.undoBtn.disabled = !this.history.canUndo;
        this.redoBtn.disabled = !this.history.canRedo;
    }

    // ---------- selection actions ----------
    get selected() { return [...this.ws.selection].filter((m) => this.patch.modules.get(m.id) === m); }
    selectAll() { this.ws.setSelection(this.patch.modules.values()); }
    deleteSelected() {
        const mods = this.selected.filter((m) => m.def.deletable !== false);
        if (!mods.length) return;
        this.patch.batch(() => mods.forEach((m) => this.patch.removeModule(m.id)));
        this.ws.clearSelection();
        this.history.commit();
        toast(`Deleted ${mods.length} module${mods.length > 1 ? 's' : ''} · ${MOD}Z to undo`);
    }
    copySelected() {
        const mods = this.selected.filter((m) => m.def.deletable !== false);
        if (!mods.length) return null;
        this.clipboard = this.patch.serializeGroup(mods);
        this.pasteCount = 0;
        this.renderBar();
        return this.clipboard;
    }
    cutSelected() { if (this.copySelected()) this.deleteSelected(); }
    paste(data = this.clipboard, at = null) {
        if (!data) { toast('Nothing to paste'); return; }
        let x, y;
        if (at) ({ x, y } = at);
        else {
            // Offset each successive paste so copies don't stack exactly on top of each other.
            this.pasteCount++;
            const xs = data.modules.map((s) => s.x || 0), ys = data.modules.map((s) => s.y || 0);
            x = Math.min(...xs) + PASTE_OFFSET * this.pasteCount;
            y = Math.min(...ys) + PASTE_OFFSET * this.pasteCount;
        }
        this.history.commit();
        const { added, skipped } = this.patch.insert(data, x, y);
        this.ws.setSelection(added);
        added.forEach((m) => this.ws.bringToFront(m.element));
        this.history.commit();
        if (skipped.length) toast(`Skipped unknown modules: ${[...new Set(skipped)].join(', ')}`, 4000);
        return added;
    }
    duplicate() { const d = this.copySelected(); if (d) this.paste(d); }

    // ---------- subpatches ----------
    exportSubpatch() {
        const data = this.copySelected();
        if (!data) { toast('Select modules first (Shift-drag, or Select mode on touch)'); return; }
        const out = {
            ...data,
            note: 'Modular Audio SUBPATCH: adds these modules to an existing patch (it never replaces it). Import with Edit → Add Subpatch.',
            exported: new Date().toISOString(),
        };
        const name = prompt('Name this subpatch', 'my-subpatch');
        if (name === null) return;
        const safe = (name.trim() || 'subpatch').replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-');
        download(`${safe}.subpatch.json`, JSON.stringify(out, null, 2));
        toast(`Exported ${data.modules.length} modules as a subpatch`);
    }
    pickSubpatch() { this.subInput.click(); }
    async importSubpatchFile(file = this.subInput.files[0]) {
        this.subInput.value = '';
        if (!file) return;
        try {
            const data = JSON.parse(await file.text());
            if (data.kind !== 'subpatch') throw new Error('That is a full patch, not a subpatch. Use “Upload Preset” to open a full patch.');
            this.insertAtView(data, file.name);
        } catch (e) { toast(`Couldn’t add subpatch: ${e.message}`, 4500); }
    }
    insertAtView(data, label = 'Subpatch') {
        const r = this.ws.ws.getBoundingClientRect();
        const c = this.ws.toCanvas(r.left + r.width * 0.3, r.top + r.height * 0.25);
        const added = this.paste(data, c) || [];
        toast(`Added ${added.length} modules from ${label} · your patch was kept`, 3500);
    }

    // ---------- share links ----------
    async copyShareLink(view) {
        const data = this.patch.serialize(view);
        const code = await encodeShare(data);
        const url = `${location.origin}${location.pathname}#patch=${code}`;
        const files = data.modules.filter((m) => m.params && m.params.sampleId).length;
        try { await navigator.clipboard.writeText(url); toast(`Share link copied (${Math.round(url.length / 100) / 10} k characters)${files ? ' · loaded samples are not included' : ''}`, 4000); }
        catch (e) { prompt('Copy this share link:', url); }
        return url;
    }

    // ---------- keyboard ----------
    bindKeys() {
        document.addEventListener('keydown', (e) => {
            if (typingInField()) return;
            const mod = e.ctrlKey || e.metaKey;
            const k = e.key.toLowerCase();
            if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); this.undo(); return; }
            if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); this.redo(); return; }
            if (mod && k === 'a') { e.preventDefault(); this.selectAll(); return; }
            if (mod && k === 'd') { e.preventDefault(); this.duplicate(); return; }
            if ((e.key === 'Delete' || e.key === 'Backspace') && this.ws.selection.size) { e.preventDefault(); this.deleteSelected(); return; }
            if (e.key === 'Escape') { this.ws.clearSelection(); this.closeQuickAdd(); this.closeMenu(); }
        });
    }
    // Ctrl+C / Ctrl+X / Ctrl+V go through the real clipboard, so patches can move between tabs.
    bindClipboard() {
        const busy = () => typingInField() || (window.getSelection && String(window.getSelection()).length > 0);
        document.addEventListener('copy', (e) => {
            if (busy() || !this.ws.selection.size) return;
            const d = this.copySelected();
            if (!d) return;
            e.clipboardData.setData('text/plain', JSON.stringify(d));
            e.preventDefault();
            toast(`Copied ${d.modules.length} module${d.modules.length > 1 ? 's' : ''}`);
        });
        document.addEventListener('cut', (e) => {
            if (busy() || !this.ws.selection.size) return;
            const d = this.copySelected();
            if (!d) return;
            e.clipboardData.setData('text/plain', JSON.stringify(d));
            e.preventDefault();
            this.deleteSelected();
        });
        document.addEventListener('paste', (e) => {
            if (typingInField()) return;
            const text = e.clipboardData && e.clipboardData.getData('text/plain');
            let data = null;
            try { const j = JSON.parse(text); if (j && j.app === 'modularaudio' && Array.isArray(j.modules)) data = j; } catch (_) {}
            if (!data && !this.clipboard) return;
            e.preventDefault();
            if (data && JSON.stringify(data) !== JSON.stringify(this.clipboard)) { this.clipboard = data; this.pasteCount = 0; }
            this.paste();
        });
    }

    // ---------- Edit menu ----------
    bindMenu() {
        this.menuBtn.addEventListener('click', (e) => { e.stopPropagation(); this.menu.classList.contains('open') ? this.closeMenu() : this.openMenu(); });
        document.addEventListener('pointerdown', (e) => { if (!this.menu.contains(e.target) && e.target !== this.menuBtn && !this.menuBtn.contains(e.target)) this.closeMenu(); }, true);
    }
    openMenu() {
        const n = this.selected.length;
        const item = (label, key, fn, disabled = false, checked = false) => {
            const b = el('button', { type: 'button', role: 'menuitem', class: checked ? 'checked' : '' }, el('span', { text: label }), key ? el('kbd', { text: key }) : null);
            b.disabled = disabled;
            b.addEventListener('click', () => { this.closeMenu(); fn(); });
            return b;
        };
        this.menu.replaceChildren(
            item('Undo', `${MOD}Z`, () => this.undo(), !this.history.canUndo),
            item('Redo', isMac ? '⇧⌘Z' : 'Ctrl+Y', () => this.redo(), !this.history.canRedo),
            el('hr'),
            item('Select mode (touch box select)', '', () => this.toggleSelectMode(), false, this.ws.selectMode),
            item('Select all', `${MOD}A`, () => this.selectAll()),
            item(`Copy${n ? ` (${n})` : ''}`, `${MOD}C`, () => { const d = this.copySelected(); if (d) { this.writeSystemClipboard(d); toast(`Copied ${d.modules.length} modules`); } }, !n),
            item('Cut', `${MOD}X`, () => { const d = this.copySelected(); if (d) { this.writeSystemClipboard(d); this.deleteSelected(); } }, !n),
            item('Paste', `${MOD}V`, () => this.pasteFromMenu(), false),
            item('Duplicate', `${MOD}D`, () => this.duplicate(), !n),
            item('Delete', 'Del', () => this.deleteSelected(), !n),
            el('hr'),
            item('Export selection as subpatch…', '', () => this.exportSubpatch(), !n),
            item('Add subpatch from file…', '', () => this.pickSubpatch()),
            el('hr'),
            item('Copy share link', '', () => this.copyShareLink(this.ws.view)),
            item('Quick add here…', 'dbl-click', () => { const r = this.ws.ws.getBoundingClientRect(); this.openQuickAdd(r.left + r.width / 2, r.top + r.height / 3); }),
        );
        this.menu.classList.add('open');
        this.menuBtn.setAttribute('aria-expanded', 'true');
    }
    closeMenu() { this.menu.classList.remove('open'); this.menuBtn.setAttribute('aria-expanded', 'false'); }
    async writeSystemClipboard(d) { try { await navigator.clipboard.writeText(JSON.stringify(d)); } catch (e) {} }
    async pasteFromMenu() {
        // Menu paste (no keyboard event): try the system clipboard, fall back to the internal one.
        try {
            const j = JSON.parse(await navigator.clipboard.readText());
            if (j && j.app === 'modularaudio' && Array.isArray(j.modules) && JSON.stringify(j) !== JSON.stringify(this.clipboard)) { this.clipboard = j; this.pasteCount = 0; }
        } catch (e) {}
        this.paste();
    }
    toggleSelectMode(on = !this.ws.selectMode) {
        this.ws.selectMode = on;
        this.ws.ws.classList.toggle('select-mode', on);
        toast(on ? 'Select mode: drag on empty space to select' : 'Select mode off');
        this.renderBar();
    }
    renderBar() {
        const n = this.selected.length;
        const bar = this.bar;
        if (!n && !this.ws.selectMode) { bar.classList.add('hidden'); return; }
        const b = (text, fn, cls = '') => { const x = el('button', { type: 'button', class: cls, text }); x.addEventListener('click', fn); x.addEventListener('pointerdown', (e) => e.stopPropagation()); return x; };
        bar.replaceChildren(
            el('span', { text: n ? `${n} selected` : 'Select mode' }),
            ...(n ? [b('Copy', () => { const d = this.copySelected(); if (d) { this.writeSystemClipboard(d); toast(`Copied ${n} modules`); } }), b('Duplicate', () => this.duplicate()), b('Subpatch…', () => this.exportSubpatch()), b('Delete', () => this.deleteSelected(), 'danger')] : []),
            ...(this.clipboard ? [b('Paste', () => this.paste())] : []),
            b(this.ws.selectMode ? 'Done' : '✕', () => { if (this.ws.selectMode) this.toggleSelectMode(false); this.ws.clearSelection(); }));
        bar.classList.remove('hidden');
    }

    // ---------- quick add ----------
    bindQuickAdd() {
        this.quickInput.addEventListener('input', () => this.renderQuick());
        this.quickInput.addEventListener('keydown', (e) => {
            e.stopPropagation();
            const btns = [...this.quickList.querySelectorAll('button')];
            const i = btns.findIndex((b) => b.classList.contains('active'));
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const j = clamp(i + (e.key === 'ArrowDown' ? 1 : -1), 0, btns.length - 1);
                btns.forEach((b, k) => b.classList.toggle('active', k === j));
                btns[j]?.scrollIntoView({ block: 'nearest' });
            } else if (e.key === 'Enter') { e.preventDefault(); (btns[i] || btns[0])?.click(); }
            else if (e.key === 'Escape') this.closeQuickAdd();
        });
        document.addEventListener('pointerdown', (e) => { if (this.quick.classList.contains('open') && !this.quick.contains(e.target)) this.closeQuickAdd(); }, true);
    }
    openQuickAdd(cx, cy) {
        this.quickAt = this.ws.toCanvas(cx, cy);
        this.quick.classList.add('open');
        const r = this.quick.getBoundingClientRect();
        this.quick.style.left = `${clamp(cx - 20, 8, innerWidth - r.width - 8)}px`;
        this.quick.style.top = `${clamp(cy - 20, 8, innerHeight - Math.max(r.height, 320) - 8)}px`;
        this.quickInput.value = '';
        this.renderQuick();
        setTimeout(() => this.quickInput.focus(), 0);
    }
    closeQuickAdd() { this.quick.classList.remove('open'); }
    renderQuick() {
        const defs = search(this.quickInput.value, this.categories);
        this.quickList.replaceChildren(...defs.map((d, i) => {
            const b = el('button', { type: 'button', role: 'option', class: i === 0 ? 'active' : '' }, el('span', { text: d.title }), el('small', { text: d.category }));
            b.addEventListener('click', () => {
                // Place the module where the user double-clicked; no cables are added.
                this.history.commit();
                const m = this.patch.addModule(d.type, { x: this.quickAt.x - 20, y: this.quickAt.y - 14 });
                if (m) { this.ws.bringToFront(m.element); this.ws.setSelection([m]); }
                this.closeQuickAdd();
            });
            return b;
        }));
        if (!defs.length) this.quickList.append(el('div', { class: 'quick-add-empty', text: 'No modules match' }));
    }
}

export function download(name, text, type = 'application/json') {
    const a = el('a', { href: URL.createObjectURL(text instanceof Blob ? text : new Blob([text], { type })), download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
