// Modular Audio — app entry point.
import { initAudio, onAudioState, setMasterVolume, audio } from './audio.js';
import { Patch, registry } from './patch.js';
import { Workspace } from './workspace.js';
import { Cables } from './cables.js';
import { settings, updateSettings, onSettings } from './settings.js';
import { el, toast, clearCssCache } from './util.js';
import { EXAMPLE_PATCH } from './example.js';
import { haystack, rank as rankDef } from './search.js';
import { History } from './history.js';
import { Editor, decodeShare, download } from './editor.js';
import { Readouts } from './readouts.js';
import { listSamples, clearSamples, onLibraryChange } from './samples.js';
import './modules/sources.js';
import './modules/shaping.js';
import './modules/effects.js';
import './modules/fx.js';
import './modules/batch3.js';
import './modules/batch4.js';
import './modules/sequencing.js';
import './modules/utility.js';

// ?test runs the app isolated from the real saved patch (used by _tests/).
const TEST_MODE = new URLSearchParams(location.search).has('test');
const PATCH_KEY = TEST_MODE ? 'modularaudio.test.patch' : 'modularaudio.patch';
const CATEGORY_ORDER = ['Sources', 'Modulation', 'Processors', 'Effects', 'Dynamics & EQ', 'Distortion', 'Sequencing', 'Logic & CV', 'Utilities'];
const $ = (id) => document.getElementById(id);

const isMobile = () => window.matchMedia('(max-width: 767px)').matches;

async function boot() {
    // iOS mutes Web Audio when the ringer switch is off unless the session is 'playback'.
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {}
    const status = $('audio-status');
    try {
        await initAudio(settings.masterVolume);
    } catch (e) {
        console.error(e);
        status.classList.add('error');
        status.querySelector('.status-text').textContent = 'Audio unavailable';
        toast(`Audio could not start: ${e.message}`, 6000);
        return;
    }
    onAudioState((s) => {
        status.classList.toggle('running', s === 'running');
        status.querySelector('.status-text').textContent = s === 'running' ? 'Audio on' : 'Tap to start audio';
        status.title = s === 'running' ? 'Audio is running' : 'Start audio';
    });
    status.addEventListener('click', () => audio.ctx.resume());

    const canvas = $('canvas');
    const patch = new Patch(canvas);
    let cables = null;
    const ws = new Workspace($('workspace'), canvas, patch, () => cables && cables.scheduleRedraw());
    cables = new Cables(patch, ws, $('cable-layer'));
    new Readouts(patch, canvas);
    ws.onModuleMove = () => cables.redraw();
    ws.onBackgroundTap = () => { cables.clearSelection(); cables.hideMenu(); cables.hidePopup(); };

    // Redraw cables whenever a module changes size (minimise, mode switches, etc.)
    const ro = new ResizeObserver(() => cables.scheduleRedraw());
    let saveTimer = null;
    const save = () => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            if (TEST_MODE) return;
            try { localStorage.setItem(PATCH_KEY, JSON.stringify(patch.serialize(ws.view))); } catch (e) {}
        }, 400);
    };
    patch.onChange((kind) => {
        if (kind === 'structure') { for (const m of patch.modules.values()) ro.observe(m.element); cables.validate(); ws.pruneSelection(); }
        cables.scheduleRedraw();
        save();
    });
    ws.onViewCommit = save;

    // Restore the last session, or start with the example.
    patch.addModule('output', { x: 600, y: 40 });
    let restored = false;
    try {
        const saved = TEST_MODE ? null : JSON.parse(localStorage.getItem(PATCH_KEY) || 'null');
        if (saved && saved.modules?.length) {
            patch.load(saved);
            if (saved.view) ws.setView(saved.view);
            restored = true;
        }
    } catch (e) {
        console.warn('Could not restore the saved patch', e);
    }
    if (!restored) patch.load(EXAMPLE_PATCH);

    // History starts from the restored session so the first undo can't empty the patch.
    let editor = null;
    const history = new History(patch, () => editor && editor.updateButtons());
    editor = new Editor({ patch, ws, cables, history, categories: CATEGORY_ORDER });
    window.modularAudio = { patch, ws, cables, audio, history, editor }; // handy for debugging (and used by _tests/)

    buildBrowser(patch, ws, history);
    bindSettings(patch, ws, cables, history, editor);

    requestAnimationFrame(() => {
        if (!restored) { ws.stackColumns(); ws.fit(); history.reset(); }
        cables.redraw();
    });

    // Opening a share link: load it as one undoable step, then tidy the address bar.
    const share = location.hash.match(/^#patch=([A-Za-z0-9_-]+)$/);
    if (share) {
        try {
            const data = await decodeShare(share[1]);
            history.commit();
            patch.load(data);
            history.commit();
            if (data.view) ws.setView(data.view); else requestAnimationFrame(() => ws.fit());
            toast('Opened a shared patch · Ctrl+Z restores your previous patch', 4500);
        } catch (e) { toast(`That share link couldn’t be opened: ${e.message}`, 4500); }
        window.history.replaceState(null, '', location.pathname + location.search);
    }
    window.modularAudioReady = true;

    window.addEventListener('resize', () => cables.scheduleRedraw());
}

function buildBrowser(patch, ws, history) {
    const list = $('module-list');
    const browser = $('module-browser');
    const search = $('module-search');
    const empty = $('search-empty');
    const groups = {};
    for (const def of registry.values()) {
        if (def.hiddenInBrowser) continue;
        (groups[def.category] ||= []).push(def);
    }
    const setBrowserCollapsed = (c) => browser.classList.toggle('collapsed', c);
    const items = []; // { btn, titleEl, def, cat, hay }
    const cats = [];
    const addModule = (def) => {
        history.commit();
        const m = patch.addModule(def.type, ws.freeSpot(def.width || 200, 280));
        if (m) { ws.place(m); ws.bringToFront(m.element); }
        if (isMobile()) setBrowserCollapsed(true);
    };
    for (const cat of CATEGORY_ORDER) {
        if (!groups[cat]) continue;
        const head = el('div', { class: 'browser-category', text: cat });
        list.append(head);
        const catItems = [];
        for (const def of groups[cat]) {
            const titleEl = el('span', { text: def.title });
            const btn = el('button', { class: 'add-module-btn', type: 'button', dataset: { moduleType: def.type } }, titleEl, el('small', { text: def.blurb || '' }));
            btn.addEventListener('click', () => addModule(def));
            btn.addEventListener('keydown', (e) => {
                // Arrow keys move through the visible results.
                if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
                e.preventDefault();
                const vis = items.filter((i) => !i.btn.classList.contains('hidden'));
                const i = vis.findIndex((v) => v.btn === btn);
                if (e.key === 'ArrowUp' && i === 0) search.focus();
                else vis[Math.min(vis.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.btn.focus();
            });
            list.append(btn);
            const item = { btn, titleEl, def, cat, hay: haystack(def) };
            items.push(item);
            catItems.push(item);
        }
        cats.push({ head, items: catItems });
    }

    const filter = () => {
        const q = search.value.trim().toLowerCase();
        const words = q.split(/\s+/).filter(Boolean);
        let first = null, shown = 0;
        for (const it of items) {
            const ok = words.every((w) => it.hay.includes(w));
            it.btn.classList.toggle('hidden', !ok);
            it.btn.classList.remove('first-match');
            // Highlight the matched part of the title.
            const t = it.def.title, i = words.length ? t.toLowerCase().indexOf(words[0]) : -1;
            it.titleEl.replaceChildren(...(i >= 0 ? [t.slice(0, i), el('mark', { text: t.slice(i, i + words[0].length) }), t.slice(i + words[0].length)] : [t]));
            if (ok) { shown++; if (!first) first = it; }
        }
        // Rank: a title that starts with the query beats a keyword hit.
        if (words.length) {
            const best = items.filter((it) => !it.btn.classList.contains('hidden'))
                .sort((a, b) => rank(b, words[0]) - rank(a, words[0]))[0];
            if (best) { first = best; best.btn.classList.add('first-match'); }
        }
        for (const c of cats) c.head.classList.toggle('hidden', !c.items.some((it) => !it.btn.classList.contains('hidden')));
        empty.classList.toggle('hidden', shown > 0);
        return first;
    };
    const rank = (it, w) => rankDef(it.def, w);
    search.addEventListener('input', filter);
    search.addEventListener('keydown', (e) => {
        e.stopPropagation(); // keep Keys / shortcuts out of the search field
        if (e.key === 'Enter') {
            const first = filter();
            if (first) { addModule(first.def); search.value = ''; filter(); search.blur(); }
        } else if (e.key === 'Escape') {
            if (search.value) { search.value = ''; filter(); } else search.blur();
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            items.find((i) => !i.btn.classList.contains('hidden'))?.btn.focus();
        }
    });
    // "/" focuses search from anywhere (opens the drawer on phones).
    document.addEventListener('keydown', (e) => {
        if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
        const a = document.activeElement;
        if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return;
        e.preventDefault();
        setBrowserCollapsed(false);
        search.focus();
        search.select();
    });

    if (isMobile()) setBrowserCollapsed(true);
    $('browser-toggle').addEventListener('click', () => setBrowserCollapsed(!browser.classList.contains('collapsed')));
    // Tapping the workspace on a phone closes the drawer.
    $('workspace').addEventListener('pointerdown', () => { if (isMobile()) setBrowserCollapsed(true); });
}

function applyLayout() {
    const browser = $('module-browser');
    const container = $('workspace-container');
    browser.classList.toggle('position-left', settings.browserPosition !== 'bottom');
    browser.classList.toggle('position-bottom', settings.browserPosition === 'bottom');
    container.classList.toggle('browser-bottom', settings.browserPosition === 'bottom');
    document.documentElement.style.setProperty('--cable-opacity', String(settings.cableOpacity));
}

function bindSettings(patch, ws, cables, history, editor) {
    const modal = $('settings-modal');
    const open = () => modal.classList.add('open');
    const close = () => modal.classList.remove('open');
    $('settings-btn').addEventListener('click', open);
    $('modal-close-btn').addEventListener('click', close);
    modal.addEventListener('pointerdown', (e) => { if (e.target === modal) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    $('view-reset-btn').addEventListener('click', () => ws.fit());

    const vol = $('master-volume'), volV = $('master-volume-value');
    vol.value = Math.round(settings.masterVolume * 100);
    volV.textContent = vol.value;
    vol.addEventListener('input', () => { volV.textContent = vol.value; updateSettings({ masterVolume: vol.value / 100 }); });

    $('theme-toggle').addEventListener('click', () => {
        const dark = !document.documentElement.classList.contains('dark');
        updateSettings({ theme: dark ? 'dark' : 'light' });
    });
    const pos = $('browser-position');
    pos.value = settings.browserPosition;
    pos.addEventListener('change', () => updateSettings({ browserPosition: pos.value }));
    const fine = $('fine-tune-range');
    fine.value = String(settings.fineTuneRange);
    fine.addEventListener('change', () => updateSettings({ fineTuneRange: Number(fine.value) }));
    const op = $('cable-opacity'), opV = $('cable-opacity-value');
    op.value = Math.round(settings.cableOpacity * 100);
    opV.textContent = op.value;
    op.addEventListener('input', () => { opV.textContent = op.value; updateSettings({ cableOpacity: op.value / 100 }); });

    onSettings((s, changed) => {
        if ('masterVolume' in changed) setMasterVolume(s.masterVolume);
        if ('theme' in changed) {
            document.documentElement.classList.toggle('dark', s.theme === 'dark');
            clearCssCache();
            cables.recolor();
            patch.modules.forEach((m) => m.refreshControls());
        }
        if ('browserPosition' in changed || 'cableOpacity' in changed) { applyLayout(); cables.scheduleRedraw(); }
        if ('fineTuneRange' in changed) patch.modules.forEach((m) => m.refreshControls());
    });
    applyLayout();

    // Presets
    $('download-preset-btn').addEventListener('click', () => {
        download(`modularaudio-${new Date().toISOString().slice(0, 10)}.patch.json`, JSON.stringify(patch.serialize(ws.view), null, 2));
    });
    $('share-link-btn').addEventListener('click', () => editor.copyShareLink(ws.view));
    $('add-subpatch-btn').addEventListener('click', () => { close(); editor.pickSubpatch(); });
    // Sample library summary
    const libInfo = async () => {
        try {
            const items = await listSamples();
            const mb = items.reduce((a, s) => a + s.size, 0) / 1048576;
            $('library-info').textContent = items.length ? `${items.length} sample${items.length > 1 ? 's' : ''} stored in this browser · ${mb.toFixed(1)} MB` : 'No samples stored yet';
        } catch (e) { $('library-info').textContent = 'Not available in this browser'; }
    };
    onLibraryChange(libInfo);
    $('settings-btn').addEventListener('click', libInfo);
    $('library-clear-btn').addEventListener('click', async () => {
        if (!confirm('Delete every stored sample from this browser? Modules using them will need the files loaded again.')) return;
        await clearSamples();
        toast('Sample library cleared');
    });
    $('upload-preset-input').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        e.target.value = '';
        if (!file) return;
        try {
            const data = JSON.parse(await file.text());
            if (data && data.kind === 'subpatch') {
                // Subpatches are always additive, even through Upload Preset.
                close();
                editor.insertAtView(data, file.name);
                return;
            }
            history.commit();
            const res = patch.load(data);
            history.commit();
            if (res.skipped.length) setTimeout(() => toast(`Skipped unknown modules: ${[...new Set(res.skipped)].join(', ')}`, 4500), 2300);
            if (data.view) ws.setView(data.view); else requestAnimationFrame(() => ws.fit());
            close();
            toast(`Loaded ${file.name} · Ctrl+Z restores your previous patch`, 3500);
        } catch (err) {
            toast(`Couldn’t load that file: ${err.message}`, 4000);
        }
    });
    $('example-patch-btn').addEventListener('click', () => {
        history.commit();
        patch.load(EXAMPLE_PATCH);
        close();
        requestAnimationFrame(() => { ws.stackColumns(); ws.fit(); history.commit(); });
    });
    $('clear-patch-btn').addEventListener('click', () => {
        history.commit();
        patch.clear();
        history.commit();
        close();
        toast('Patch cleared · Ctrl+Z to undo', 3000);
    });
}

boot();
