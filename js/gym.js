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
    async function shareText(text) {
        try { if (navigator.share) { await navigator.share({ text }); return 'shared'; } }
        catch (e) { if (e && e.name === 'AbortError') return 'aborted'; }
        try { await navigator.clipboard.writeText(text); return 'copied'; } catch (e) { return 'failed'; }
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
    function register(ref) { dotnetRef = ref; initGestures(); setTimeout(heal, 300); setTimeout(heal, 1500); }

    // ---- iOS-Fehler bei Home-Bildschirm-Apps (beide kosten genau die Höhe der Statusleiste):
    // 1. Kaltstart: mit height:100% bekommt die App zu wenig Höhe, darunter zeichnet WebKit nichts.
    //    Abhilfe: html/body/.app auf 100vh (CSS, html[data-standalone]).
    // 2. Nach dem ersten Öffnen der Tastatur schrumpft das Fenster und bleibt klein.
    //    Abhilfe: die volle App-Fläche kurz aus- und einblenden, dann misst WebKit neu.
    // Bleibt das Fenster danach trotzdem kurz, wird die App auf das sichtbare Fenster begrenzt
    // (html[data-vshort]), damit die Leiste nie abgeschnitten wird.
    const root = document.documentElement;
    const standalone = (() => { try { return navigator.standalone === true || matchMedia('(display-mode: standalone)').matches; } catch (_) { return false; } })();
    if (standalone) root.setAttribute('data-standalone', '1');
    let maxH = 0;
    const screenH = () => innerHeight > innerWidth ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height);
    const typing = () => { const a = document.activeElement; return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable); };
    const keyboardUp = () => typing() || (window.visualViewport && visualViewport.height < innerHeight - 80);
    function shortBy() {
        if (!standalone || innerHeight <= innerWidth) return 0;
        const d = Math.round(Math.max(screenH(), maxH) - innerHeight);
        return d >= 4 && d <= 90 ? d : 0;
    }
    function heal() {
        if (!standalone || keyboardUp()) return;
        maxH = Math.max(maxH, innerHeight);
        if (shortBy() > 0) {
            const app = document.querySelector('.app');
            if (app) {
                const page = document.getElementById('page'); const y = page ? page.scrollTop : 0;
                app.style.display = 'none'; void app.offsetHeight; app.style.display = '';
                if (page) page.scrollTop = y;
            }
        }
        maxH = Math.max(maxH, innerHeight);
        const d = shortBy();
        if (d > 0) root.setAttribute('data-vshort', '1'); else root.removeAttribute('data-vshort');
    }
    function fixViewport() { heal(); return shortBy(); }
    function viewportInfo() {
        return `Bildschirm ${screenH()} · Fenster ${innerHeight} · 100vh ${Math.round(document.getElementById('vh-probe')?.offsetHeight || 0)}`
            + (standalone ? ' · Home-Bildschirm' : ' · Browser') + (root.hasAttribute('data-vshort') ? ' · gekürzt' : '');
    }
    let healTimer = 0;
    const healSoon = (ms) => { clearTimeout(healTimer); healTimer = setTimeout(heal, ms); };
    addEventListener('resize', () => healSoon(120));
    addEventListener('orientationchange', () => healSoon(350));
    addEventListener('pageshow', () => healSoon(60));
    addEventListener('load', () => { healSoon(50); setTimeout(heal, 700); setTimeout(heal, 2000); });
    document.addEventListener('focusout', () => healSoon(160));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) healSoon(120); });
    if (window.visualViewport) visualViewport.addEventListener('resize', () => healSoon(160));

    // ---- Gesten wie bei iOS: vom linken Rand zurückwischen, Sheets nach unten ziehen
    let gesturesReady = false;
    function initGestures() {
        if (gesturesReady) return; gesturesReady = true;
        const EDGE = 28, EASE = 'cubic-bezier(.2,.8,.2,1)';
        let sw = null, sh = null;
        const clear = el => { if (!el) return; el.style.transition = ''; el.style.transform = ''; el.style.filter = ''; el.style.boxShadow = ''; };

        document.addEventListener('touchstart', e => {
            if (e.touches.length !== 1) return;
            const t = e.touches[0];
            // Sheet am oberen Rand greifen
            const panel = e.target.closest && e.target.closest('.sheet-panel');
            if (panel) {
                const r = panel.getBoundingClientRect();
                if (t.clientY - r.top < 38) sh = { panel, y0: t.clientY, y: t.clientY, hist: [[performance.now(), t.clientY]], on: false };
                return;
            }
            const app = document.querySelector('.app');
            if (!app || app.dataset.back !== '1' || t.clientX > EDGE) return;
            sw = { x0: t.clientX, y0: t.clientY, x: t.clientX, hist: [], phase: 'wait' };
        }, { passive: true });

        document.addEventListener('touchmove', e => {
            const t = e.touches[0];
            if (sh) {
                const dy = t.clientY - sh.y0;
                if (!sh.on && dy > 6) sh.on = true;
                if (!sh.on) return;
                e.preventDefault();
                sh.y = t.clientY; sh.hist.push([performance.now(), t.clientY]); if (sh.hist.length > 6) sh.hist.shift();
                sh.panel.style.transition = 'none';
                sh.panel.style.transform = `translateY(${Math.max(0, dy)}px)`;
                return;
            }
            if (!sw) return;
            const dx = t.clientX - sw.x0, dy = t.clientY - sw.y0;
            if (sw.phase === 'wait') {
                if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { sw = null; return; }
                if (!(dx > 8 && dx > Math.abs(dy))) return;
                let ok = false; try { ok = dotnetRef.invokeMethod('SwipeBegin'); } catch (_) { }
                if (!ok) { sw = null; return; }
                sw.phase = 'drag'; sw.w = window.innerWidth; sw.cur = document.getElementById('page');
            }
            e.preventDefault();
            sw.x = t.clientX; sw.hist.push([performance.now(), t.clientX]); if (sw.hist.length > 6) sw.hist.shift();
            const d = Math.max(0, dx), p = Math.min(1, d / sw.w);
            if (sw.cur) { sw.cur.style.transition = 'none'; sw.cur.style.transform = `translateX(${d}px)`; sw.cur.style.boxShadow = '-12px 0 32px rgba(0,0,0,.38)'; }
            const pk = document.getElementById('page-peek');
            if (pk) { pk.style.transition = 'none'; pk.style.transform = `translateX(${-28 + 28 * p}%)`; pk.style.filter = `brightness(${0.72 + 0.28 * p})`; }
        }, { passive: false });

        const speed = h => { if (h.length < 2) return 0; const a = h[0], b = h[h.length - 1]; return (b[1] - a[1]) / Math.max(1, b[0] - a[0]); };

        const end = () => {
            if (sh) {
                const s = sh; sh = null;
                if (!s.on) return;
                const dy = s.y - s.y0, v = speed(s.hist);
                if (dy > 110 || (v > 0.55 && dy > 30)) {
                    const bd = s.panel.closest('.ov-backdrop');
                    s.panel.style.transition = `transform .24s ${EASE}`;
                    s.panel.style.transform = 'translateY(100%)';
                    if (bd) bd.click();
                } else {
                    s.panel.style.transition = `transform .3s cubic-bezier(.3,1.3,.5,1)`;
                    s.panel.style.transform = 'translateY(0)';
                    setTimeout(() => clear(s.panel), 320);
                }
                return;
            }
            if (!sw) return;
            const s = sw; sw = null;
            if (s.phase !== 'drag') return;
            const dx = s.x - s.x0, v = speed(s.hist);
            let commit = dx > s.w * 0.33 || (v > 0.45 && dx > 30);
            if (commit) { try { commit = dotnetRef.invokeMethod('SwipeCheck'); } catch (_) { commit = false; } }
            const cur = s.cur, pk = document.getElementById('page-peek');
            const tr = `transform .3s ${EASE}, filter .3s ${EASE}`;
            if (cur) { cur.style.transition = tr; cur.style.transform = commit ? 'translateX(100%)' : 'translateX(0)'; }
            if (pk) { pk.style.transition = tr; pk.style.transform = commit ? 'translateX(0)' : 'translateX(-28%)'; pk.style.filter = commit ? 'brightness(1)' : 'brightness(.72)'; }
            setTimeout(() => {
                if (commit) { clear(document.getElementById('page-peek')); try { dotnetRef.invokeMethod('SwipeCommit'); } catch (_) { } }
                else { clear(cur); try { dotnetRef.invokeMethod('SwipeCancel'); } catch (_) { } }
            }, 310);
        };
        document.addEventListener('touchend', end);
        document.addEventListener('touchcancel', end);
    }

    // ---- Gleitende Auswahl im Umschalter
    function segPill(el, first) {
        if (!el) return;
        const pill = el.querySelector(':scope > .seg-pill'), on = el.querySelector(':scope > button.on');
        if (!pill) return;
        if (!on) { pill.style.opacity = '0'; return; }
        const instant = first || !pill.dataset.ready;
        if (instant) pill.style.transition = 'none';
        pill.style.opacity = '1';
        pill.style.width = on.offsetWidth + 'px';
        pill.style.transform = `translateX(${on.offsetLeft}px)`;
        if (instant) { void pill.offsetWidth; pill.style.transition = ''; pill.dataset.ready = '1'; }
    }
    function scrollTopSmooth(id) { const el = document.getElementById(id); if (el) el.scrollTo({ top: 0, behavior: 'smooth' }); }
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
    return { idbGet, idbSet, idbDel, loadBoth, persist, storageInfo, setWake, beep, shareFile, shareText, copyText, pickPhoto, getPhoto, openImage,
        register, isStandalone, isIos, fixViewport, viewportInfo, segPill, scrollTopSmooth, scrollTop, scrollBottom, getScroll, setScroll, setTheme, focus, blurActive, watchUpdates, applyUpdate };
})();
