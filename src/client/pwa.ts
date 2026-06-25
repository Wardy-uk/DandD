import { registerSW } from 'virtual:pwa-register';

export function registerQuestPwa() {
  if (!('serviceWorker' in navigator)) {
    return;
  }

  registerSW({
    immediate: true,
    onRegistered(registration) {
      if (!registration) return;

      setInterval(() => {
        void registration.update();
      }, 60 * 60 * 1000);
    },
  });
}
