// Minimal service worker — enables PWA installability.
// The app is server-backed, so no offline cache: network-first passthrough.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
