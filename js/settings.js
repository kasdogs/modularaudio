// User settings, persisted in localStorage.
const KEY = 'modularaudio.settings';

const defaults = {
    masterVolume: 0.8,
    theme: null,            // null = follow the system
    browserPosition: 'left',
    fineTuneRange: 8,       // ± percent for fine tune sliders
    cableOpacity: 0.85,
};

export const settings = { ...defaults };
try { Object.assign(settings, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) {}

const listeners = new Set();
export function onSettings(fn) { listeners.add(fn); }
export function updateSettings(patch) {
    Object.assign(settings, patch);
    try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch (e) {}
    listeners.forEach((fn) => fn(settings, patch));
}
