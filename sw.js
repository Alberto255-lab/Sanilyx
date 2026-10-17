/* ================================================================
   SANILYX — SERVICE WORKER (sw.js, accanto a sanilyx-web.html)
   Fa due cose:
   1) OFFLINE: salva in cache pagina e librerie, così l'app si apre senza rete.
   2) NOTIFICHE IN BACKGROUND: riceve dall'app il calendario delle dosi e degli appuntamenti
      dei prossimi 7 giorni (salvato in IndexedDB; gli appuntamenti hanno id testuale "app-N") e, quando il browser lo sveglia
      (Periodic Background Sync), mostra le notifiche scadute.

   LIMITE ONESTO: i browser non permettono di "programmare" una notifica locale a
   un orario preciso con l'app chiusa (serve un server Web Push). Il Periodic
   Background Sync funziona solo su Chrome/Edge con l'app INSTALLATA e con
   frequenza decisa dal browser (di solito ogni ora o più). Con l'app aperta
   le notifiche arrivano puntuali (controllo ogni 20 secondi).
   ================================================================ */
const CACHE = 'sanilyx-web-v4';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(['./', 'sanilyx-web.html', 'sanilyx-web.css', 'sanilyx-web.js'].map(u => new Request(u, { cache: 'reload' }))).catch(() => {})).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(k => Promise.all(k.filter(n => n !== CACHE).map(n => caches.delete(n)))).then(() => self.clients.claim()));
});

// Rete prima, cache come ripiego (così con la rete hai sempre l'ultima versione)
self.addEventListener('fetch', e => {
  const r = e.request, url = new URL(r.url);
  if (r.method !== 'GET' || url.hostname.endsWith('googleapis.com') || url.hostname.endsWith('emailjs.com') || url.hostname.endsWith('supabase.co')) return; // le API non si cachano
  e.respondWith(
    fetch(r).then(res => { if (res.ok) { const copia = res.clone(); caches.open(CACHE).then(c => c.put(r, copia)); } return res; })
      .catch(() => caches.match(r, { ignoreSearch: true }).then(hit => hit || caches.match('sanilyx-web.html')))
  );
});

/* ---- piccolo archivio IndexedDB: calendario di dosi e appuntamenti ---- */
const apriDB = () => new Promise((ok, ko) => {
  const rq = indexedDB.open('sanilyx-sw', 1);
  rq.onupgradeneeded = () => rq.result.createObjectStore('dosi', { keyPath: 'id' });
  rq.onsuccess = () => ok(rq.result); rq.onerror = () => ko(rq.error);
});
const tutteLeDosi = async () => { const db = await apriDB(); return new Promise(ok => { db.transaction('dosi').objectStore('dosi').getAll().onsuccess = e => ok(e.target.result); }); };
async function scrivi(fn) { const db = await apriDB(); return new Promise(ok => { const tx = db.transaction('dosi', 'readwrite'); fn(tx.objectStore('dosi')); tx.oncomplete = ok; }); }

self.addEventListener('message', async e => {
  const m = e.data || {}, rispondi = d => e.ports[0] && e.ports[0].postMessage(d);
  if (m.tipo === 'programma') {                         // l'app invia le dosi future
    const vecchie = await tutteLeDosi(), inviate = new Set(vecchie.filter(v => v.inviata).map(v => v.id));
    await scrivi(s => { vecchie.filter(v => !v.inviata).forEach(v => s.delete(v.id)); m.items.forEach(i => { if (!inviate.has(i.id)) s.put({ ...i, inviata: false }); }); });
    rispondi(true);
  } else if (m.tipo === 'inviate') {                    // "quali dosi hai già notificato tu?"
    rispondi((await tutteLeDosi()).filter(d => d.inviata).map(d => d.id));
  } else if (m.tipo === 'ack') {                        // l'app le ha registrate: le togliamo
    await scrivi(s => m.ids.forEach(id => s.delete(id))); rispondi(true);
  }
});

// Mostra le notifiche scadute (dosi e appuntamenti hanno lo stesso formato: id, quando, titolo, corpo)
async function controllaDosi() {
  const finestre = await self.clients.matchAll({ type: 'window' });
  if (finestre.some(w => w.visibilityState === 'visible')) return;   // app aperta: ci pensa lei
  const ora = Date.now();
  for (const d of await tutteLeDosi()) {
    if (d.inviata || d.quando > ora || ora - d.quando > 2 * 3600e3) continue;
    await self.registration.showNotification(d.titolo, { body: d.corpo, tag: (typeof d.id === 'string' ? '' : 'dose-') + d.id, requireInteraction: true });
    await scrivi(s => s.put({ ...d, inviata: true }));
  }
}
self.addEventListener('periodicsync', e => { if (e.tag === 'sanilyx-dosi') e.waitUntil(controllaDosi()); });

// Tocco sulla notifica: riporta in primo piano l'app
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(w => w.length ? w[0].focus() : self.clients.openWindow('./sanilyx-web.html')));
});
