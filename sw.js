// Офлайн-работа: сохраняем приложение в кэш и открываем его без интернета.
const CACHE = "smeny-v2";
// "./" и index.html — одна и та же страница, качаем её один раз
const SHELL = ["index.html", "manifest.webmanifest", "icon-180.png", "icon-192.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  // Страница: сначала сеть (чтобы получать обновления), без сети — из кэша.
  // Плохой интернет: ждём сеть не дольше 4 секунд, потом открываем сохранённую копию.
  // В кэш кладём только нормальную страницу — ошибка GitHub (404/500) не затрёт рабочую копию.
  if (req.mode === "navigate") {
    const net = fetch(req).then(r => { if (r && r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put("index.html", copy)); } return r; });
    const slow = new Promise(res => setTimeout(res, 4000)).then(() => caches.match("index.html"));
    e.respondWith(
      Promise.race([net.catch(() => null), slow]).then(r => r || net)          // что пришло первым
        .then(r => (r && r.ok) ? r : caches.match("index.html").then(c => c || r))
        .catch(() => caches.match("index.html"))
    );
    return;
  }
  // Файлы шрифтов на gstatic не меняются: если есть в кэше — сеть не нужна.
  // Остальное (иконки, таблица шрифтов): из кэша, а в фоне обновляем. Иконки с ?v=2 находят копию без него.
  const immutable = new URL(req.url).hostname === "fonts.gstatic.com";
  e.respondWith(caches.match(req, { ignoreSearch: new URL(req.url).origin === self.location.origin }).then(hit => {
    if (hit && immutable) return hit;
    const net = fetch(req).then(r => { if (r && (r.ok || r.type === "opaque")) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return r; }).catch(() => hit);
    return hit || net;
  }));
});
