// Undo / redo: snapshots of the patch (without the view), recorded once changes settle.
// Undo and redo apply a diff, so only what changed is rebuilt.
const LIMIT = 200;
const SETTLE_MS = 350;

export class History {
    constructor(patch, onUpdate) {
        this.patch = patch;
        this.onUpdate = onUpdate || (() => {});
        this.past = [];
        this.future = [];
        this.current = this.snap();
        this.timer = null;
        this.applying = false;
        this.pointers = 0;
        patch.onChange(() => { if (!this.applying) this.schedule(); });
        // A slider drag or module move becomes one step: wait until the pointer is released.
        addEventListener('pointerdown', () => { this.pointers++; }, true);
        const up = () => { this.pointers = Math.max(0, this.pointers - 1); if (this.timer) this.schedule(); };
        addEventListener('pointerup', up, true);
        addEventListener('pointercancel', up, true);
    }
    snap() {
        const s = this.patch.serialize();
        delete s.view;
        return JSON.stringify(s);
    }
    schedule() {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            if (this.pointers > 0) return; // pointerup reschedules
            this.commit();
        }, SETTLE_MS);
    }
    // Record the current state now (call before and after big operations such as imports).
    commit() {
        clearTimeout(this.timer);
        this.timer = null;
        if (this.applying) return;
        const s = this.snap();
        if (s === this.current) return;
        this.past.push(this.current);
        if (this.past.length > LIMIT) this.past.shift();
        this.current = s;
        this.future = [];
        this.onUpdate(this);
    }
    get canUndo() { return this.past.length > 0 || this.snap() !== this.current; }
    get canRedo() { return this.future.length > 0; }
    undo() {
        this.commit();
        if (!this.past.length) return false;
        this.future.push(this.current);
        this.go(this.past.pop());
        return true;
    }
    redo() {
        this.commit();
        if (!this.future.length) return false;
        this.past.push(this.current);
        this.go(this.future.pop());
        return true;
    }
    go(state) {
        this.applying = true;
        try { this.patch.applySnapshot(JSON.parse(state)); } finally { this.applying = false; }
        clearTimeout(this.timer);
        this.timer = null;
        // Store the state as it now actually is, so the next edit diffs against reality.
        this.current = this.snap();
        this.onUpdate(this);
    }
    reset() { this.past = []; this.future = []; this.current = this.snap(); this.onUpdate(this); }
}
