import { useState, useEffect } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

type ChronicleEventType = 'milestone' | 'death' | 'lore' | 'rival' | 'faction' | 'nightly' | 'session';

interface ChronicleEvent {
  type: ChronicleEventType;
  timestamp: string;
  heading: string;
  body: string;
  icon: string;
}

interface ChronicleData {
  campaignName: string;
  dayCount: number;
  sessionCount: number;
  events: ChronicleEvent[];
}

interface Props {
  campaignId: string;
  campaignName: string;
  apiUrl: string;
  player: { token: string };
  onClose: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTimestamp(ts: string): string {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return '';
  }
}

const TYPE_ACCENT: Record<ChronicleEventType, string> = {
  death:     'border-blood/40 bg-blood/5',
  milestone: 'border-gold/40 bg-gold/5',
  lore:      'border-magic/30 bg-magic/5',
  rival:     'border-leather/30 bg-leather/5',
  faction:   'border-leather-dark/30 bg-parchment-light/60',
  nightly:   'border-ink-faint/20 bg-parchment-light/40',
  session:   'border-leather/20 bg-parchment-light/30',
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function Chronicle({ campaignId, campaignName, apiUrl, player, onClose }: Props) {
  const [chronicle, setChronicle] = useState<ChronicleData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const headers = { Authorization: `Bearer ${player.token}` };
    setLoading(true);
    fetch(`${apiUrl}/api/campaigns/${campaignId}/chronicle`, { headers })
      .then(r => r.json())
      .then(data => {
        if (data.ok) {
          setChronicle(data.data);
        } else {
          setError(data.error || 'Could not load chronicle.');
        }
      })
      .catch(() => setError('Could not reach the server.'))
      .finally(() => setLoading(false));
  }, [campaignId]);

  // Close on backdrop click
  const handleBackdrop = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/50 p-3 backdrop-blur-sm sm:items-center"
      onClick={handleBackdrop}
    >
      <div className="relative flex w-full max-w-xl flex-col rounded-t-2xl sm:rounded-lg border border-leather/20 bg-parchment shadow-2xl max-h-[92vh]">

        {/* ── Header ── */}
        <div className="flex-shrink-0 border-b border-leather/15 px-5 py-4 sm:px-6">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="font-heading text-xl font-bold tracking-wide text-leather-dark leading-tight">
                {loading ? campaignName : (chronicle?.campaignName ?? campaignName)}
              </h2>
              {chronicle && (
                <p className="mt-0.5 text-sm font-body italic text-ink-faint">
                  {chronicle.dayCount > 0 && `Turn ${chronicle.dayCount} · `}
                  {chronicle.sessionCount > 0
                    ? `${chronicle.sessionCount} session${chronicle.sessionCount !== 1 ? 's' : ''}`
                    : 'No sessions logged'}
                </p>
              )}
            </div>
            <button
              onClick={onClose}
              className="flex-shrink-0 rounded-md p-1.5 text-ink-faint hover:bg-parchment-dark/40 hover:text-ink transition-colors"
              aria-label="Close chronicle"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12"/>
              </svg>
            </button>
          </div>
        </div>

        {/* ── Body ── */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
          {loading && (
            <p className="py-16 text-center font-body italic text-ink-faint">
              Turning the pages…
            </p>
          )}

          {!loading && error && (
            <p className="py-16 text-center font-body italic text-blood">
              {error}
            </p>
          )}

          {!loading && !error && chronicle?.events.length === 0 && (
            <div className="py-16 text-center">
              <p className="font-heading text-base font-semibold text-leather-dark">
                The chronicle is blank.
              </p>
              <p className="mt-1 font-body italic text-sm text-ink-faint">
                Your story hasn't been written yet.
              </p>
            </div>
          )}

          {!loading && !error && chronicle && chronicle.events.length > 0 && (
            <div className="relative space-y-3">
              {/* Vertical connector line */}
              <div className="absolute left-[22px] top-3 bottom-3 w-px bg-leather/15 sm:left-[23px]" aria-hidden />

              {chronicle.events.map((event, i) => (
                <div key={i} className="relative flex gap-3 sm:gap-4">
                  {/* Icon bubble */}
                  <div className="flex-shrink-0 relative z-10 flex h-10 w-10 sm:h-11 sm:w-11 items-center justify-center rounded-full border border-leather/20 bg-parchment shadow-sm text-base sm:text-lg">
                    {event.icon}
                  </div>

                  {/* Card */}
                  <div className={`flex-1 min-w-0 rounded-lg border px-3 py-2.5 sm:px-4 sm:py-3 ${TYPE_ACCENT[event.type] ?? 'border-leather/15 bg-parchment-light/30'}`}>
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                      <p className="font-heading font-semibold text-sm sm:text-base text-leather-dark leading-snug">
                        {event.heading}
                      </p>
                      {event.timestamp && (
                        <time className="text-xs font-body text-ink-faint flex-shrink-0">
                          {formatTimestamp(event.timestamp)}
                        </time>
                      )}
                    </div>
                    <p className="mt-1 font-body text-sm text-ink-light leading-relaxed line-clamp-3">
                      {event.body}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <div className="flex-shrink-0 border-t border-leather/15 px-5 py-3 sm:px-6">
          <button
            onClick={onClose}
            className="w-full rounded-lg border border-leather/20 py-2 text-sm font-heading text-ink-faint hover:bg-parchment-dark/30 transition-colors"
          >
            Close Chronicle
          </button>
        </div>
      </div>
    </div>
  );
}
