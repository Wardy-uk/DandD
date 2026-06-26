import { useEffect, useState } from 'react';
import { fullRefreshQuestPwa } from '../pwa.js';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

export default function PwaPrompt() {
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);
  const [isOffline, setIsOffline] = useState(!navigator.onLine);
  const [refreshing, setRefreshing] = useState(false);

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

  return (
    <div className="mb-3 rounded-lg border border-leather/10 bg-[linear-gradient(135deg,rgba(107,68,35,0.9),rgba(74,46,21,0.84))] px-3 py-2 text-parchment-light shadow-[0_6px_14px_rgba(74,46,21,0.1)]">
      <div className="flex flex-wrap items-center gap-2 sm:justify-between">
        <div className="min-w-0">
          <p className="font-heading text-[11px] font-bold tracking-wide">
            {isOffline ? 'Offline Mode Active' : isInstalled ? 'QUEST App Installed' : 'Install QUEST'}
          </p>
          <p className="font-body text-[11px] text-parchment-light/75">
            {isOffline
              ? 'Cached screens remain available, but live campaign actions need a connection.'
              : isInstalled
                ? 'Use Full Refresh after a deployment to pull the newest client immediately.'
                : 'Add QUEST to your home screen for a full-screen tavern-table experience.'}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2 sm:flex-nowrap">
          {isOffline && (
            <span className="rounded-full border border-parchment-light/20 px-2 py-1 text-[9px] font-heading tracking-wide text-parchment-light/90">
              Reconnect to play
            </span>
          )}
          <button
            onClick={async () => {
              setRefreshing(true);
              await fullRefreshQuestPwa();
              setRefreshing(false);
            }}
            disabled={refreshing}
            className="rounded-full border border-parchment-light/20 px-2.5 py-1 text-[9px] font-heading font-bold tracking-wide text-parchment-light transition-colors hover:bg-parchment-light/10 disabled:cursor-wait disabled:opacity-60"
          >
            {refreshing ? 'Refreshing...' : 'Full Refresh'}
          </button>
          {!isOffline && installEvent && (
            <button
              onClick={handleInstall}
              className="rounded-full bg-parchment px-2.5 py-1 text-[9px] font-heading font-bold tracking-wide text-leather-dark transition-colors hover:bg-parchment-light"
            >
              Install App
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
