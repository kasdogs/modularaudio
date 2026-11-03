// Modular Audio — app entry point.
import { initAudio, onAudioState, setMasterVolume, audio } from './audio.js';
import { Patch, registry } from './patch.js';
import { Workspace } from './workspace.js';
import { Cables } from './cables.js';
import { settings, updateSettings, onSettings } from './settings.js';
import { el, toast } from './util.js';
import { EXAMPLE_PATCH } from './example.js';
import './modules/sources.js';
import './modules/shaping.js';
import './modules/effects.js';
import './modules/fx.js';
import './modules/sequencing.js';
import './modules/utility.js';

const PATCH_KEY = 'modularaudio.patch';
const CATEGORY_ORDER = ['Sources', 'Modulation', 'Processors', 'Effects', 'Dynamics & EQ', 'Distortion', 'Sequencing', 'Utilities'];
const $ = (id) => document.getElementById(id);

const isMobile = () => window.matchMedia('(max-width: 767px)').matches;

async function boot() {
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
    ws.onModuleMove = () => cables.redraw();
    ws.onBackgroundTap = () => { cables.clearSelection(); cables.hideMenu(); cables.hidePopup(); };
    window.modularAudio = { patch, ws, cables, audio }; // handy for debugging from the console

    // Redraw cables whenever a module changes size (minimise, mode switches, etc.)
    const ro = new ResizeObserver(() => cables.scheduleRedraw());
    let saveTimer = null;
    const save = () => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            try { localStorage.setItem(PATCH_KEY, JSON.stringify(patch.serialize(ws.view))); } catch (e) {}
        }, 400);
    };
    patch.onChange((kind) => {
        if (kind === 'structure') for (const m of patch.modules.values()) ro.observe(m.element);
        cables.scheduleRedraw();
        save();
    });
    ws.onViewCommit = save;

    buildBrowser(patch, ws);
    bindSettings(patch, ws, cables);

    // Restore the last session, or start with the example.
    patch.addModule('output', { x: 600, y: 40 });
    let restored = false;
    try {
        const saved = JSON.parse(localStorage.getItem(PATCH_KEY) || 'null');
        if (saved && saved.modules?.length) {
            patch.load(saved);
            if (saved.view) ws.setView(saved.view);
            restored = true;
        }
    } catch (e) {
        console.warn('Could not restore the saved patch', e);
    }
    if (!restored) patch.load(EXAMPLE_PATCH);
    requestAnimationFrame(() => {
        if (!restored) { ws.stackColumns(); ws.fit(); }
        cables.redraw();
    });

    window.addEventListener('resize', () => cables.scheduleRedraw());
}

function buildBrowser(patch, ws) {
    const list = $('module-list');
    const browser = $('module-browser');
    const groups = {};
    for (const def of registry.values()) {
        if (def.hiddenInBrowser) continue;
        (groups[def.category] ||= []).push(def);
    }
    for (const cat of CATEGORY_ORDER) {
        if (!groups[cat]) continue;
        list.append(el('div', { class: 'browser-category', text: cat }));
        for (const def of groups[cat]) {
            const btn = el('button', { class: 'add-module-btn', type: 'button', dataset: { moduleType: def.type } }, def.title, el('small', { text: def.blurb || '' }));
            btn.addEventListener('click', () => {
                const m = patch.addModule(def.type, ws.freeSpot(def.width || 200, 280));
                if (m) { ws.place(m); ws.bringToFront(m.element); }
                if (isMobile()) setBrowserCollapsed(true);
            });
            list.append(btn);
        }
    }
    const setBrowserCollapsed = (c) => browser.classList.toggle('collapsed', c);
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

function bindSettings(patch, ws, cables) {
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
            cables.recolor();
            patch.modules.forEach((m) => m.refreshControls());
        }
        if ('browserPosition' in changed || 'cableOpacity' in changed) { applyLayout(); cables.scheduleRedraw(); }
        if ('fineTuneRange' in changed) patch.modules.forEach((m) => m.refreshControls());
    });
    applyLayout();

    // Presets
    $('download-preset-btn').addEventListener('click', () => {
        const data = JSON.stringify(patch.serialize(ws.view), null, 2);
        const a = el('a', { href: URL.createObjectURL(new Blob([data], { type: 'application/json' })), download: `modularaudio-${new Date().toISOString().slice(0, 10)}.json` });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    $('upload-preset-input').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        e.target.value = '';
        if (!file) return;
        try {
            const data = JSON.parse(await file.text());
            patch.load(data);
            if (data.view) ws.setView(data.view); else requestAnimationFrame(() => ws.fit());
            close();
            toast(`Loaded ${file.name}`);
        } catch (err) {
            toast(`Couldn’t load that file: ${err.message}`, 4000);
        }
    });
    $('example-patch-btn').addEventListener('click', () => {
        patch.load(EXAMPLE_PATCH);
        close();
        requestAnimationFrame(() => { ws.stackColumns(); ws.fit(); });
    });
    $('clear-patch-btn').addEventListener('click', () => {
        if (!confirm('Remove every module from the patch?')) return;
        patch.clear();
        close();
    });
}

boot();
