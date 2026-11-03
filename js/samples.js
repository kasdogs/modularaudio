// Local sample library in IndexedDB. Samples are keyed by a SHA-256 of their bytes, so the same
// file is stored once and any module (Sampler, Granular, Conv Reverb) can find it again after a
// reload, undo, paste or preset load.
import { audio } from './audio.js';

const DB = 'modularaudio', STORE = 'samples', VERSION = 1;
let dbp = null;
const listeners = new Set();

function db() {
    if (!dbp) {
        dbp = new Promise((resolve, reject) => {
            if (!('indexedDB' in window)) { reject(new Error('IndexedDB is not available')); return; }
            const r = indexedDB.open(DB, VERSION);
            r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE, { keyPath: 'id' }); };
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => reject(r.error);
        });
        // Ask the browser not to evict the library under storage pressure.
        try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {}
    }
    return dbp;
}
async function tx(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
        const t = d.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        t.oncomplete = () => resolve(req && req.result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('Storage aborted'));
    });
}
async function hash(bytes) {
    const h = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

export function onLibraryChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const notify = () => listeners.forEach((fn) => { try { fn(); } catch (e) {} });

// Store a File/Blob; returns { id, name }. Decoding is checked first so junk never gets stored.
export async function storeSample(file) {
    const bytes = await file.arrayBuffer();
    await audio.ctx.decodeAudioData(bytes.slice(0));
    const id = await hash(bytes);
    const rec = { id, name: file.name || 'sample', type: file.type || '', size: bytes.byteLength, added: Date.now(), bytes };
    await tx('readwrite', (s) => s.put(rec));
    notify();
    return { id, name: rec.name };
}
export async function listSamples() {
    const all = (await tx('readonly', (s) => s.getAll())) || [];
    return all.map(({ id, name, size, added }) => ({ id, name, size, added })).sort((a, b) => b.added - a.added);
}
export async function deleteSample(id) { await tx('readwrite', (s) => s.delete(id)); decoded.delete(id); notify(); }
export async function clearSamples() { await tx('readwrite', (s) => s.clear()); decoded.clear(); notify(); }

// Decoded AudioBuffers are shared between modules.
const decoded = new Map();
export function getSample(id) {
    if (!id) return Promise.resolve(null);
    if (!decoded.has(id)) {
        decoded.set(id, (async () => {
            const rec = await tx('readonly', (s) => s.get(id));
            if (!rec) return null;
            return audio.ctx.decodeAudioData(rec.bytes.slice(0));
        })().catch((e) => { decoded.delete(id); console.warn('Sample load failed', e); return null; }));
    }
    return decoded.get(id);
}

// UI helper used by sample-based modules: a "Library" select kept in sync with the store.
export function librarySelect(el, onPick) {
    const sel = el('select', { title: 'Samples stored in this browser' });
    sel.addEventListener('pointerdown', (e) => e.stopPropagation());
    const fill = async () => {
        let items = [];
        try { items = await listSamples(); } catch (e) {}
        const cur = sel.value;
        sel.replaceChildren(el('option', { value: '', text: items.length ? `Library (${items.length})…` : 'Library is empty' }),
            ...items.map((s) => el('option', { value: s.id, text: `${s.name} · ${(s.size / 1048576).toFixed(1)} MB` })));
        sel.value = items.some((s) => s.id === cur) ? cur : '';
    };
    sel.addEventListener('change', () => { const id = sel.value; const name = sel.selectedOptions[0]?.textContent.split(' · ')[0]; sel.value = ''; if (id) onPick(id, name); });
    const off = onLibraryChange(fill);
    fill();
    return { el: sel, dispose: off };
}
