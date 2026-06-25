import { registerSW } from 'virtual:pwa-register';

let triggerSwUpdate: ((reloadPage?: boolean) => Promise<void>) | null = null;

export function registerQuestPwa() {
  if (!('serviceWorker' in navigator)) {
    return;
  }

  triggerSwUpdate = registerSW({
    immediate: true,
    onRegistered(registration) {
      if (!registration) return;

      setInterval(() => {
        void registration.update();
      }, 60 * 60 * 1000);
    },
  });
}

export async function fullRefreshQuestPwa() {
  // Prefer a guaranteed hard refresh path over relying on an update being available.
  if (triggerSwUpdate) {
    try {
      await triggerSwUpdate(false);
    } catch {
      // Fall through to the manual refresh path below.
    }
  }

  if ('serviceWorker' in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
  }

  if ('caches' in window) {
    const cacheKeys = await caches.keys();
    await Promise.all(cacheKeys.map((cacheKey) => caches.delete(cacheKey)));
  }

  const cacheBuster = `refresh=${Date.now()}`;
  const baseUrl = `${window.location.origin}${window.location.pathname}`;
  const query = window.location.search ? `${window.location.search}&${cacheBuster}` : `?${cacheBuster}`;
  window.location.replace(`${baseUrl}${query}${window.location.hash}`);
}
