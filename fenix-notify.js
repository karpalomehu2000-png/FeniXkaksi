// FeniX notifications (browser side). Shared by the parent page (/) and the child page (/lapsi.html).
// - In-app notices are driven by the realtime Firebase state.
// - System (push) notifications come from the FeniX server through the service worker (sw.js),
//   so they also work when the app is in the background or closed, if the user has allowed them.
(() => {
  const $ = id => document.getElementById(id);
  const PAGE = location.pathname.endsWith('/lapsi.html') ? '/lapsi.html' : '/';
  const OVERDUE_WINDOW_MIN = 90;
  const EVENT_WINDOW_MS = 30 * 60 * 1000;
  const cloud = () => window.fenixCloud || null;
  const role = () => cloud()?.role || '';
  const code = () => cloud()?.code || '';
  const now = () => cloud()?.serverNow?.() ?? Date.now();
  const state = () => window.fenixGetState?.() || {};
  const list = v => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []).filter(Boolean);
  const reqId = (r, i) => String(r?.id || (r?.at ? 'at-' + r.at : 'i-' + i)).replace(/[^A-Za-z0-9_.:-]/g, '_');
  const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  // ---------- "Already notified" memory, shared by in-app notices and push messages ----------
  const SEEN_KEY = 'fenix-seen-notifications';
  let seen;
  try { seen = JSON.parse(localStorage.getItem(SEEN_KEY)) || []; } catch (e) { seen = []; }
  const isSeen = k => seen.includes(k);
  const markSeen = k => { if (isSeen(k)) return; seen.push(k); seen = seen.slice(-400); localStorage.setItem(SEEN_KEY, JSON.stringify(seen)); };

  // ---------- In-app notice banner ----------
  const css = document.createElement('style');
  css.textContent = `
  .fx-notice-wrap{position:fixed;left:0;right:0;top:calc(10px + env(safe-area-inset-top));z-index:5000;display:grid;gap:8px;justify-items:center;padding:0 12px;pointer-events:none}
  .fx-notice{pointer-events:auto;width:min(100%,520px);display:flex;align-items:center;gap:11px;background:linear-gradient(145deg,#fff,#fbf7ff);border:2px solid #d7c5ff;border-radius:18px;padding:12px 12px 12px 14px;box-shadow:0 14px 40px #1e143c40;font-family:Montserrat,system-ui,sans-serif;color:#30294c;animation:fxIn .25s ease-out;cursor:pointer;text-align:left}
  .fx-notice .fx-ico{font-size:26px;flex:none}.fx-notice .fx-txt{flex:1;min-width:0}.fx-notice strong{display:block;font-size:14px;font-weight:900}.fx-notice span{display:block;font-size:12.5px;color:#6d6884;line-height:1.4;margin-top:2px}
  .fx-notice button{flex:none;border:0;background:#f0eafd;color:#6550b7;border-radius:10px;padding:7px 9px;font-weight:900;cursor:pointer}
  @keyframes fxIn{from{transform:translateY(-14px);opacity:0}to{transform:none;opacity:1}}
  .play-status{margin:0 0 12px!important;padding:10px 12px;border-radius:14px;background:#ffffffb8;color:#5b4a3e!important;font-weight:800;font-size:13.5px!important}
  .play-status.active{background:#e9fbef;color:#24583a!important;font-size:15px!important}.play-status.ended{background:#ffe4e4;color:#9c3340!important}
  .play-status[hidden]{display:none}
  `;
  document.head.appendChild(css);
  let wrap;
  function notice(icon, title, text, onTap) {
    if (!wrap) { wrap = document.createElement('div'); wrap.className = 'fx-notice-wrap'; wrap.setAttribute('aria-live', 'assertive'); document.body.appendChild(wrap); }
    const n = document.createElement('div');
    n.className = 'fx-notice'; n.setAttribute('role', 'alert');
    const ico = document.createElement('div'); ico.className = 'fx-ico'; ico.textContent = icon;
    const txt = document.createElement('div'); txt.className = 'fx-txt';
    const t = document.createElement('strong'); t.textContent = title;
    const s = document.createElement('span'); s.textContent = text;
    txt.append(t, s);
    const close = document.createElement('button'); close.type = 'button'; close.textContent = '✕'; close.setAttribute('aria-label', 'Sulje ilmoitus');
    n.append(ico, txt, close);
    const remove = () => n.remove();
    close.onclick = e => { e.stopPropagation(); remove(); };
    n.onclick = () => { remove(); onTap?.(); };
    wrap.appendChild(n);
    setTimeout(remove, 9000);
  }

  // System notification while the page is open but hidden (e.g. phone screen locked or another app
  // in front). The server push uses the same tag, so the phone shows the event only once.
  async function systemNotify(tag, title, body, url) {
    if (!document.hidden || !pushSupported || Notification.permission !== 'granted') return;
    try {
      const reg = await navigator.serviceWorker.getRegistration('/');
      await reg?.showNotification(title, { body, tag, renotify: false, icon: '/icons/icon-192.png', badge: '/icons/badge-96.png', data: { url } });
    } catch (e) {}
  }

  // ---------- Navigation targets (notification taps) ----------
  function goHome(targetId) {
    document.querySelector('.nav-btn[data-view="homeView"]')?.click();
    setTimeout(() => (targetId ? $(targetId) : null)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60);
  }
  function openTarget(kind, requestId) {
    if (kind === 'play') {
      if (role() !== 'child' && typeof window.fenixOpenParentPlay === 'function') window.fenixOpenParentPlay(requestId);
      else goHome('playRequest');
    } else if (kind === 'tasks') goHome('todoList');
  }
  function handleUrl(u) {
    const p = new URL(u, location.origin).searchParams;
    const kind = p.get('fenix');
    if (kind) openTarget(kind, p.get('request'));
  }

  // ---------- Child: play time ----------
  function myUid() { return role() === 'child' ? cloud()?.uid || '' : ''; }
  function myRequests() {
    const uid = myUid();
    if (role() === 'child' && !uid) return []; // Wait until the child's identity is known.
    return list(state().requests).map((r, i) => ({ ...r, _id: reqId(r, i) }))
      .filter(r => (uid ? r.childUid === uid : !r.childUid || role() !== 'parent'));
  }
  function latestMine() {
    return myRequests().sort((a, b) => Date.parse(b.at || 0) - Date.parse(a.at || 0))[0] || null;
  }
  function endsAt(r) {
    const start = Date.parse(r?.approvedAt);
    const minutes = Number(r?.minutes) || 0;
    return start && minutes ? start + minutes * 60000 : 0;
  }
  function playInfo() {
    const r = latestMine();
    if (!r) return { r: null, phase: 'none' };
    if (r.status === 'waiting') return { r, phase: 'waiting' };
    if (r.status === 'rejected') return { r, phase: 'rejected' };
    if (r.status === 'approved') {
      const end = endsAt(r);
      return { r, phase: end && now() < end ? 'active' : 'ended', end };
    }
    return { r, phase: 'none' };
  }
  const fmt = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0'); };

  function renderPlay() {
    const btn = $('playRequest'); const box = $('playStatus');
    if (!btn || !box || role() === 'parent') { if (box) box.hidden = true; return; }
    const { r, phase, end } = playInfo();
    box.className = 'play-status'; box.hidden = false;
    btn.disabled = false; btn.textContent = 'Pyydä pelilupaa 💌';
    if (phase === 'waiting') { box.textContent = '💌 Pyyntö odottaa vanhemman vastausta…'; btn.disabled = true; btn.textContent = 'Odotetaan vastausta…'; }
    else if (phase === 'active') { box.classList.add('active'); box.textContent = `🎮 Peliaikaa jäljellä ${fmt(end - now())} (yhteensä ${r.minutes} min)`; btn.disabled = true; btn.textContent = 'Peliaika käynnissä'; }
    else if (phase === 'ended') { box.classList.add('ended'); box.textContent = '⏰ Peliaikasi on päättynyt! Lisää peliaikaa saa vain uudella vanhemman luvalla.'; btn.textContent = 'Pyydä uutta pelilupaa 💌'; }
    else if (phase === 'rejected') { box.textContent = 'Vanhempi ei hyväksynyt edellistä pyyntöä. Voit pyytää uudelleen myöhemmin.'; }
    else box.hidden = true;
  }

  function checkPlayEvents() {
    if (role() === 'parent') return;
    const c = code() || 'local';
    for (const r of myRequests()) {
      const decided = Date.parse(r.status === 'approved' ? r.approvedAt : r.rejectedAt);
      const decKey = `play-decision:${c}:${r._id}`;
      if ((r.status === 'approved' || r.status === 'rejected') && !isSeen(decKey)) {
        markSeen(decKey);
        if (now() - decided < EVENT_WINDOW_MS && !(r.status === 'approved' && now() >= endsAt(r))) {
          if (r.status === 'approved') {
            window.showModal?.('🎮', 'Peliaika myönnetty!', `Sait ${r.minutes} minuuttia peliaikaa. Aika laskee nyt – jäljellä oleva aika näkyy Saanko pelata? -kortissa.`);
            systemNotify(decKey, '✅ Peliaika myönnetty!', `Sait ${r.minutes} minuuttia peliaikaa. Pidä hauskaa!`, PAGE + '?fenix=play');
          } else {
            window.showModal?.('💜', 'Peliaikapyyntö hylättiin', 'Vanhempi ei hyväksynyt peliaikaa tällä kertaa.');
            systemNotify(decKey, 'Peliaikapyyntö hylättiin', 'Vanhempi ei hyväksynyt peliaikaa tällä kertaa.', PAGE + '?fenix=play');
          }
        }
      }
      if (r.status === 'approved') {
        const end = endsAt(r), endKey = `play-end:${c}:${r._id}`;
        if (end && now() >= end && !isSeen(endKey)) {
          markSeen(endKey);
          if (now() - end < 10 * 60 * 1000) {
            window.showModal?.('⏰', 'Peliaikasi on päättynyt!', 'Lopeta pelaaminen nyt. Lisää peliaikaa saa vain uudella vanhemman luvalla.');
            systemNotify(endKey, '⏰ Peliaikasi on päättynyt!', 'Lopeta pelaaminen nyt. Lisää peliaikaa saa vain uudella vanhemman luvalla.', PAGE + '?fenix=play');
          }
        }
      }
    }
  }

  // ---------- Child: overdue tasks ----------
  function localDate(d = new Date()) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
  function checkOverdue() {
    if (role() === 'parent') return;
    const s = state(), done = new Set(list(s.completed).map(String)), d = new Date();
    const nowMin = d.getHours() * 60 + d.getMinutes(), c = code() || 'local', date = localDate(d);
    const late = [];
    for (const t of list(s.tasks)) {
      // Only tasks explicitly enabled by the parent may generate overdue reminders.
      if (t.notify !== true || !t.time || !/^\d{2}:\d{2}$/.test(t.time) || done.has(String(t.id))) continue;
      const [h, m] = t.time.split(':').map(Number);
      const lateBy = nowMin - (h * 60 + m);
      const key = `overdue:${c}:${t.id}:${date}:${t.time}`;
      if (lateBy > 0 && lateBy <= OVERDUE_WINDOW_MIN && !isSeen(key)) { markSeen(key); late.push(t); systemNotify(key, '⏰ Tehtävä on myöhässä', `${t.emoji ? t.emoji + ' ' : ''}${t.name} (klo ${t.time}) odottaa vielä tekemistä.`, PAGE + '?fenix=tasks'); }
    }
    if (late.length === 1) notice('⏰', 'Tehtävä on myöhässä', `${late[0].name} (klo ${late[0].time}) odottaa vielä tekemistä.`, () => goHome('todoList'));
    else if (late.length > 1) notice('⏰', `${late.length} tehtävää on myöhässä`, late.map(t => t.name).join(', '), () => goHome('todoList'));
  }

  // ---------- Parent: new play requests ----------
  function checkParentRequests() {
    if (role() !== 'parent') return;
    const s = state(), names = s.children || {};
    list(s.requests).forEach((r, i) => {
      const key = `play-request:${code()}:${reqId(r, i)}`;
      if (r.status !== 'waiting' || isSeen(key)) return;
      markSeen(key);
      if (now() - Date.parse(r.at) > EVENT_WINDOW_MS) return;
      const name = names[r.childUid] || r.childName || 'Lapsi';
      // On screen the play request window opens automatically (parentRender); when hidden, use a system notification.
      systemNotify(key, '🎮 Uusi peliaikapyyntö', `${name} pyytää peliaikaa. Avaa pyyntö ja hyväksy tai hylkää se.`, `/?fenix=play&request=${encodeURIComponent(reqId(r, i))}`);
    });
  }

  function onState() { renderPlay(); checkPlayEvents(); checkParentRequests(); checkOverdue(); if (role() === 'parent') window.fenixRefreshParentRequests?.(); }

  // ---------- Push subscription ----------
  let swReg = null;
  async function registerSW() {
    if (!pushSupported) return null;
    if (!swReg) swReg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    return swReg;
  }
  const b64ToBytes = b64 => { const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(s, ch => ch.charCodeAt(0)); };
  const sameKey = (buf, bytes) => { if (!buf) return false; const a = new Uint8Array(buf); return a.length === bytes.length && a.every((v, i) => v === bytes[i]); };
  let pushState = 'unknown', subscribing = null, lastSubscribed = '';

  async function api(path, payload) {
    const c = cloud(); if (!c?.code) throw new Error('Perhettä ei ole yhdistetty');
    const token = await c.token();
    const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify(payload) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
    return data;
  }

  async function subscribe() {
    if (!pushSupported || Notification.permission !== 'granted') return false;
    const c = cloud(); if (!c?.code || !c?.role) { pushState = 'noFamily'; updateButtons(); return false; }
    const ident = `${c.code}|${c.role}|${c.uid}`;
    if (lastSubscribed === ident && pushState === 'on') return true;
    if (subscribing) return subscribing;
    subscribing = (async () => {
      try {
        const reg = await registerSW(); await navigator.serviceWorker.ready;
        const { publicKey } = await (await fetch('/api/push/public-key')).json();
        const key = b64ToBytes(publicKey);
        let sub = await reg.pushManager.getSubscription();
        if (sub && !sameKey(sub.options?.applicationServerKey, key)) { await sub.unsubscribe(); sub = null; }
        if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        await api('/api/push/subscribe', { familyCode: c.code, role: c.role, page: PAGE, subscription: sub.toJSON() });
        lastSubscribed = ident; pushState = 'on'; return true;
      } catch (e) { console.warn('FeniX push', e); pushState = 'error'; return false; }
      finally { subscribing = null; updateButtons(); }
    })();
    return subscribing;
  }

  async function enable() {
    if (!pushSupported) {
      alert(isIOS && !standalone
        ? 'iPhonessa ilmoitukset toimivat, kun FeniX on lisätty kotivalikkoon: Safari → Jaa → Lisää Koti-valikkoon. Avaa FeniX sen jälkeen kotivalikon kuvakkeesta ja salli ilmoitukset.'
        : 'Tämä selain ei tue push-ilmoituksia. Käytä Androidissa Chromea. Pyynnöt ja vastaukset näkyvät silti sovelluksessa.');
      return;
    }
    if (Notification.permission === 'denied') {
      alert('Ilmoitukset on estetty tältä sivustolta.\n\nAndroid / Chrome: napauta osoiterivin vasemmalla olevaa kuvaketta → Luvat / Sivustoasetukset → Ilmoitukset → Salli. Tarkista myös puhelimen Asetukset → Sovellukset → Chrome (tai FeniX) → Ilmoitukset → Päällä.\n\nPyynnöt ja vastaukset näkyvät silti sovelluksessa.');
      return;
    }
    if (Notification.permission !== 'granted') {
      await registerSW();
      const p = await Notification.requestPermission();
      if (p !== 'granted') { updateButtons(); return; }
    }
    const ok = await subscribe();
    const c = cloud();
    if (!c?.code) alert('Ilmoitukset sallittu ✓ Yhdistä vielä perhe (🔗-painike), niin ilmoitukset tulevat perheen toisilta puhelimilta.');
    else if (ok) notice('🔔', 'Ilmoitukset ovat päällä', c.role === 'parent' ? 'Saat ilmoituksen lapsen pelilupapyynnöistä. Lapsen muistutukset lähetetään lapsen puhelimeen.' : 'Saat ilmoitukset peliajasta, tehtävistä ja vanhemman asettamista muistutuksista.');
    else alert('Ilmoitusten käyttöönotto epäonnistui. Tarkista nettiyhteys ja yritä uudelleen.');
  }

  function updateButtons() {
    let label, title;
    if (!pushSupported) { label = isIOS && !standalone ? '🔔 Ilmoitukset (iPhone)' : ''; title = 'Push-ilmoitukset eivät ole käytettävissä tässä selaimessa.'; }
    else if (Notification.permission === 'denied') { label = '🔕 Ilmoitukset estetty'; title = 'Salli ilmoitukset selaimen sivustoasetuksista.'; }
    else if (Notification.permission === 'default') { label = '🔔 Salli ilmoitukset'; title = 'Salli puhelimen ilmoitukset FeniXille.'; }
    else if (pushState === 'on') { label = '🔔 Ilmoitukset päällä ✓'; title = 'Push-ilmoitukset ovat käytössä tässä puhelimessa.'; }
    else if (pushState === 'noFamily' || !code()) { label = '🔔 Ilmoitukset sallittu'; title = 'Yhdistä perhe, jotta ilmoitukset tulevat toisilta puhelimilta.'; }
    else if (pushState === 'error') { label = '🔔 Ota ilmoitukset käyttöön'; title = 'Ilmoitusten käyttöönotto epäonnistui – yritä uudelleen.'; }
    else { label = '🔔 Ilmoitukset…'; title = ''; }
    for (const id of ['notifyEnable', 'parentNotifyEnable']) {
      const b = $(id); if (!b) continue;
      b.hidden = !label; b.textContent = label; b.title = title;
    }
    const st = $('parentNotifyStatus'); if (st) st.textContent = title;
  }

  // ---------- Server sync (turns saved changes into push notifications for the other phones) ----------
  let syncTimer = null;
  function scheduleSync(delay = 700) {
    if (!code()) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      api('/api/sync', { familyCode: code(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }).catch(e => console.warn('FeniX sync', e.message));
    }, delay);
  }

  // ---------- Public hooks for the page scripts ----------
  window.fenixNotify = {
    onState,
    onSaved: () => scheduleSync(),
    onConnected: () => { subscribe(); scheduleSync(100); onState(); updateButtons(); },
    enable,
    playBlocked: () => { const { phase } = playInfo(); return phase === 'waiting' || phase === 'active'; },
    requestMeta: () => {
      const c = cloud();
      if (c?.role !== 'child') return {};
      return { childUid: c.uid, childName: localStorage.getItem('fenix-child-name') || 'Lapsi' };
    },
  };

  // Service worker messages: push received while the app is on screen, or a notification was tapped.
  if (pushSupported) {
    navigator.serviceWorker.addEventListener('message', e => {
      const m = e.data || {};
      if (m.type === 'fenix-open') handleUrl(m.url);
      if (m.type === 'fenix-push') {
        const p = m.payload || {};
        if (p.tag && isSeen(p.tag)) return;
        if (p.tag) markSeen(p.tag);
        if (p.kind === 'play' && role() === 'parent') { window.fenixRefreshParentRequests?.(); return; }
        notice(p.kind === 'tasks' ? '⏰' : '🎮', p.title || 'FeniX', p.body || '', () => handleUrl(p.url || PAGE));
      }
    });
    registerSW().catch(() => {});
  }

  document.addEventListener('DOMContentLoaded', () => {
    $('notifyEnable')?.addEventListener('click', enable);
    $('parentNotifyEnable')?.addEventListener('click', enable);
    updateButtons();
    onState();
    // Opened from a notification: go straight to the right place.
    if (new URLSearchParams(location.search).get('fenix')) {
      const url = location.href;
      history.replaceState(null, '', location.pathname);
      setTimeout(() => handleUrl(url), 400);
    }
  });
  setInterval(() => { renderPlay(); checkPlayEvents(); }, 1000);
  setInterval(checkOverdue, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) onState(); });
})();
