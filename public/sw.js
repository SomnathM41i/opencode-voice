/*
 * OpenCode Voice service worker.
 *
 * Network-first everywhere: this app talks to a local OpenCode server, so
 * freshness matters more than saving bytes. The cache exists so the shell can
 * still open when the network blips, and so Chrome can install the app.
 */
const VERSION = "v1";
const CACHE = `opencode-voice-${VERSION}`;
const SHELL = [
  "/",
  "/manifest.webmanifest",
  "/icons/icon-96.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("opencode-voice-") && key !== CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

function isCacheable(response) {
  return response && response.status === 200 && response.type === "basic";
}

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;
  if (request.headers.get("accept")?.includes("text/event-stream")) return;

  event.respondWith(
    (async () => {
      try {
        const response = await fetch(request);
        if (isCacheable(response)) {
          const cache = await caches.open(CACHE);
          cache.put(request, response.clone()).catch(() => undefined);
        }
        return response;
      } catch {
        const cached = await caches.match(request);
        if (cached) return cached;

        if (request.mode === "navigate") {
          const shell = await caches.match("/");
          if (shell) return shell;
        }

        return new Response("You are offline.", {
          status: 503,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
    })(),
  );
});
