import { useEffect, useState } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

export default function PwaPrompt() {
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);
  const [isOffline, setIsOffline] = useState(!navigator.onLine);

  useEffect(() => {
    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallEvent(event as BeforeInstallPromptEvent);
    };

    const handleInstalled = () => {
      setIsInstalled(true);
      setInstallEvent(null);
    };

    const handleOnline = () => setIsOffline(false);
    const handleOffline = () => setIsOffline(true);

    setIsInstalled(window.matchMedia('(display-mode: standalone)').matches);

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleInstalled);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleInstalled);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const handleInstall = async () => {
    if (!installEvent) return;
    await installEvent.prompt();
    await installEvent.userChoice;
    setInstallEvent(null);
  };

  if (isInstalled && !isOffline) {
    return null;
  }

  return (
    <div className="mb-6 rounded-2xl border border-leather/20 bg-[linear-gradient(135deg,rgba(107,68,35,0.96),rgba(74,46,21,0.92))] px-4 py-3 text-parchment-light shadow-[0_12px_30px_rgba(74,46,21,0.18)]">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="font-heading text-sm font-bold tracking-wide">
            {isOffline ? 'Offline Mode Active' : 'Install QUEST'}
          </p>
          <p className="font-body text-sm text-parchment-light/85">
            {isOffline
              ? 'Cached screens remain available, but live campaign actions need a connection.'
              : 'Add QUEST to your home screen for a full-screen tavern-table experience.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isOffline && (
            <span className="rounded-full border border-parchment-light/25 px-3 py-1 text-xs font-heading tracking-wide text-parchment-light/90">
              Reconnect to play
            </span>
          )}
          {!isOffline && installEvent && (
            <button
              onClick={handleInstall}
              className="rounded-full bg-parchment px-4 py-2 text-xs font-heading font-bold tracking-wide text-leather-dark transition-colors hover:bg-parchment-light"
            >
              Install App
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
