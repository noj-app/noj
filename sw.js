const CACHE_NAME = "noj-client-v4";
const APP_SHELL = [
  "./index.html",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// شبكة أولاً ثم تخزين مؤقت كبديل فقط عند فقدان الاتصال — كانت النسخة
// السابقة تعرض الملف المخزَّن فوراً دومًا (cached || network) وتُحدِّث
// الذاكرة المؤقتة "للمرة القادمة" فقط، فكان أي تعديل منشور لا يظهر
// للمستخدم إلا بعد إعادة تحميل الصفحة مرتين. الآن يُعرض أحدث نشر متاح
// فوراً في كل مرة، ولا تُستخدم النسخة المخزَّنة إلا حين يفشل الاتصال.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("./index.html")))
  );
});
