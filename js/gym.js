// Browser-Funktionen für die Gym-App: Speicher (IndexedDB), Bildschirm wach halten, Ton, Teilen/Export, Fotos.
window.gym = (function () {
    const DB = 'gymapp', STORE = 'kv';
    let dbPromise = null;
    function db() {
        if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB, 1);
            req.onupgradeneeded = () => req.result.createObjectStore(STORE);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        return dbPromise;
    }
    async function idbGet(key) {
        try {
            const d = await db();
            return await new Promise((resolve, reject) => {
                const r = d.transaction(STORE, 'readonly').objectStore(STORE).get(key);
                r.onsuccess = () => resolve(r.result === undefined ? null : r.result);
                r.onerror = () => reject(r.error);
            });
        } catch (e) { console.warn('idbGet', e); return localStorage.getItem('gym:' + key); }
    }
    function idbSet(key, value) {
        // zusätzlich in localStorage spiegeln (falls klein), damit nichts verloren geht
        try { if (value.length < 400000) localStorage.setItem('gym:' + key, value); } catch (e) { }
        return db().then(d => new Promise((resolve, reject) => {
            const tx = d.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).put(value, key);
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => reject(tx.error);
        })).catch(e => console.warn('idbSet', e));
    }
    function idbDel(key) {
        try { localStorage.removeItem('gym:' + key); } catch (e) { }
        return db().then(d => new Promise(resolve => {
            const tx = d.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).delete(key);
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
        })).catch(() => { });
    }
    async function loadBoth() {
        let main = await idbGet('gymdata.json');
        if (!main) main = localStorage.getItem('gym:gymdata.json');
        let active = await idbGet('aktives-training.json');
        const lsActive = localStorage.getItem('gym:aktives-training.json');
        if (!active && lsActive) active = lsActive;
        return JSON.stringify({ main: main, active: active });
    }
    async function persist() {
        try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch (e) { }
        return false;
    }
    async function storageInfo() {
        try {
            if (navigator.storage && navigator.storage.estimate) {
                const e = await navigator.storage.estimate();
                const p = navigator.storage.persisted ? await navigator.storage.persisted() : false;
                return JSON.stringify({ usage: e.usage || 0, quota: e.quota || 0, persisted: p });
            }
        } catch (e) { }
        return JSON.stringify({ usage: 0, quota: 0, persisted: false });
    }

    // ---- Bildschirm wach halten
    let wakeLock = null, wantWake = false;
    async function requestWake() {
        if (!wantWake || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
        try { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } catch (e) { }
    }
    function setWake(on) {
        wantWake = on;
        if (on) requestWake();
        else if (wakeLock) { wakeLock.release().catch(() => { }); wakeLock = null; }
    }
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') { requestWake(); if (dotnetRef) dotnetRef.invokeMethodAsync('OnVisible').catch(() => { }); }
    });

    // ---- Ton (Web Audio, muss einmal durch Antippen freigeschaltet werden)
    let audio = null;
    function unlock() {
        try {
            if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
            if (audio.state === 'suspended') audio.resume();
            const o = audio.createOscillator(), g = audio.createGain();
            g.gain.value = 0.0001; o.connect(g); g.connect(audio.destination); o.start(); o.stop(audio.currentTime + 0.01);
        } catch (e) { }
    }
    ['touchend', 'click'].forEach(ev => document.addEventListener(ev, unlock, { passive: true }));
    function beep() {
        try {
            if (!audio) unlock();
            const t0 = audio.currentTime;
            [[880, 0, 0.18], [880, 0.26, 0.18], [1175, 0.52, 0.32]].forEach(([f, s, d]) => {
                const o = audio.createOscillator(), g = audio.createGain();
                o.type = 'sine'; o.frequency.value = f;
                g.gain.setValueAtTime(0.0001, t0 + s);
                g.gain.exponentialRampToValueAtTime(0.5, t0 + s + 0.02);
                g.gain.exponentialRampToValueAtTime(0.0001, t0 + s + d);
                o.connect(g); g.connect(audio.destination); o.start(t0 + s); o.stop(t0 + s + d + 0.05);
            });
        } catch (e) { }
        try { if (navigator.vibrate) navigator.vibrate([200, 100, 200]); } catch (e) { }
    }

    // ---- Datei teilen / speichern
    async function shareFile(name, mime, text) {
        const blob = new Blob([text], { type: mime });
        try {
            const file = new File([blob], name, { type: mime });
            if (navigator.canShare && navigator.canShare({ files: [file] })) {
                await navigator.share({ files: [file], title: name });
                return 'shared';
            }
        } catch (e) { if (e && e.name === 'AbortError') return 'aborted'; }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = name; document.body.appendChild(a); a.click();
        setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 2000);
        return 'downloaded';
    }
    async function copyText(text) {
        try { await navigator.clipboard.writeText(text); return true; } catch (e) { return false; }
    }

    // ---- Fotos: auswählen, verkleinern, in IndexedDB ablegen
    function pickPhoto(dotnet) {
        const input = document.createElement('input');
        input.type = 'file'; input.accept = 'image/*';
        input.onchange = () => {
            const f = input.files && input.files[0];
            if (!f) return;
            const img = new Image();
            const url = URL.createObjectURL(f);
            img.onload = async () => {
                const max = 1280, s = Math.min(1, max / Math.max(img.width, img.height));
                const c = document.createElement('canvas');
                c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
                c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
                const data = c.toDataURL('image/jpeg', 0.82);
                URL.revokeObjectURL(url);
                const id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
                await idbSet('photo:' + id, data);
                dotnet.invokeMethodAsync('OnPhoto', id);
            };
            img.onerror = () => dotnet.invokeMethodAsync('OnPhoto', '');
            img.src = url;
        };
        input.click();
    }
    async function getPhoto(id) { return await idbGet('photo:' + id); }
    function openImage(data) {
        const w = window.open();
        if (w) w.document.write('<body style="margin:0;background:#000"><img src="' + data + '" style="width:100%"></body>');
    }

    // ---- Sonstiges
    let dotnetRef = null;
    function register(ref) { dotnetRef = ref; }
    function isStandalone() { return !!(window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches); }
    function isIos() { return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }
    function scrollTop(id) { const el = document.getElementById(id); if (el) el.scrollTop = 0; }
    function scrollBottom(id) { const el = document.getElementById(id); if (el) setTimeout(() => el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }), 50); }
    function getScroll(id) { const el = document.getElementById(id); return el ? el.scrollTop : 0; }
    function setScroll(id, y) { const el = document.getElementById(id); if (el) el.scrollTop = y; }
    function setTheme(t) {
        document.documentElement.setAttribute('data-theme', t);
        const m = document.querySelector('meta[name=theme-color]');
        if (m) m.setAttribute('content', t === 'light' ? '#f3f4f6' : '#111214');
    }
    function focus(id) { const el = document.getElementById(id); if (el) { el.focus(); if (el.select) el.select(); } }
    function blurActive() { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); }
    function watchUpdates(reg) {
        if (!reg) return;
        reg.addEventListener('updatefound', () => {
            const nw = reg.installing;
            if (!nw) return;
            nw.addEventListener('statechange', () => {
                if (nw.state === 'installed' && navigator.serviceWorker.controller && dotnetRef)
                    dotnetRef.invokeMethodAsync('OnUpdateReady').catch(() => { });
            });
        });
    }
    function applyUpdate() {
        navigator.serviceWorker.getRegistration().then(reg => {
            if (reg && reg.waiting) reg.waiting.postMessage('skipWaiting');
            setTimeout(() => location.reload(), 400);
        });
    }
    return { idbGet, idbSet, idbDel, loadBoth, persist, storageInfo, setWake, beep, shareFile, copyText, pickPhoto, getPhoto, openImage,
        register, isStandalone, isIos, scrollTop, scrollBottom, getScroll, setScroll, setTheme, focus, blurActive, watchUpdates, applyUpdate };
})();
