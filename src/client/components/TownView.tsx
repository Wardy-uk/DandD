import { useState, useEffect, useCallback } from 'react';
import type { Socket } from 'socket.io-client';
import { playSound, setAmbience } from '../audio/audioEngine.js';

// ─── Types ───────────────────────────────────────────────────────────────────

interface TownCharacter {
  id: string;
  name: string;
  hp: number;
  maxHp: number;
  gold: number;
  conditions: string[];
  charClass: string;
}

interface Companion {
  id: string;
  name: string;
  race: string;
  charClass: string;
  level: number;
  joinedParty: boolean;
  hp: number;
  maxHp: number;
  relationshipLabel: string;
  aspiration: string;
  grievance: string;
  personalQuestTitle: string;
  personalQuestResolved: boolean;
  relationship: {
    trust: number;
    bond: number;
    tension: number;
    morale: number;
    loyalty: number;
    romance: number;
  };
}

interface LootItem {
  item: string;
  quantity: number;
  gpValue: number;
  label: string;
}

interface CatalogueItem {
  item: string;
  gp: number;
  description: string;
}

interface HealQuote {
  injuries: Array<{ condition: string; cost: number }>;
  totalCost: number;
}

interface Contract {
  id: string;
  title: string;
  description: string;
  reward: number;
  factionKey: string;
  taken: boolean;
  openingContract?: boolean;
  followUpOf?: string;
  objectiveLabel?: string;
  objectiveTarget?: number;
  progress?: number;
  progressText?: string;
  completedAt?: string | null;
  claimedAt?: string | null;
  expiredAt?: string | null;
  postedAtSession?: number;
  readyToClaim?: boolean;
}

interface Prospect {
  name: string;
  race: string;
  charClass: string;
  level: number;
  personality: string;
  ask: number;
  hook?: string;
}

interface TownData {
  phase: string;
  townName: string;
  sessionNumber: number;
  character: TownCharacter | null;
  companions: Companion[];
  deadCompanions: any[];
  catalogue: CatalogueItem[];
  prospects: Prospect[];
  contracts: Contract[];
  healQuote: HealQuote;
  lootAppraisal: { items: LootItem[]; totalGp: number };
  expeditionSummary: {
    discoveredSites: number;
    fallbackPoints: number;
    campReady: number;
    hazardMarks: number;
    treasureMarks: number;
    encounterPressure: number;
    recentEvents: string[];
  };
  factions: Array<{ key: string; name: string; reputation: number; heat: number; contractCooldownUntilSession?: number | null }>;
}

type Tab = 'taproom' | 'market' | 'healer' | 'garrison';

interface Props {
  apiUrl: string;
  player: { id: string; token: string; displayName: string };
  campaignId: string;
  socket: Socket;
  onBack: () => void;
  onLeave: () => void; // called when leaving town back to dungeon
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function RelBar({ value, max = 5, color = '#8b5e2a' }: { value: number; max?: number; color?: string }) {
  const pct = Math.max(0, Math.min(100, ((value + max) / (max * 2)) * 100));
  return (
    <div className="h-1 rounded-full bg-parchment-dark/30 overflow-hidden">
      <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: color }} />
    </div>
  );
}

function GoldDisplay({ gold }: { gold: number }) {
  return (
    <span className="font-heading font-bold text-amber-700">
      {gold.toFixed(1)} <span className="text-xs font-normal">GP</span>
    </span>
  );
}

function FactionPip({ rep }: { rep: number }) {
  const color = rep >= 3 ? '#2d5a1e' : rep >= 1 ? '#8b5e2a' : rep <= -3 ? '#8b1a1a' : rep <= -1 ? '#c49a2a' : '#888';
  const label = rep >= 3 ? 'Allied' : rep >= 1 ? 'Friendly' : rep <= -3 ? 'Hostile' : rep <= -1 ? 'Wary' : 'Neutral';
  return (
    <span className="text-[10px] font-heading px-1.5 py-0.5 rounded" style={{ backgroundColor: `${color}22`, color }}>
      {label}
    </span>
  );
}

// ─── Companion Card ──────────────────────────────────────────────────────────

function TownCompanionCard({ companion }: { companion: Companion }) {
  const [expanded, setExpanded] = useState(false);
  const r = companion.relationship;
  const hasTension = r.tension >= 3;
  const hasRomance = r.romance >= 3;

  return (
    <div
      className={`rounded-lg border p-3 cursor-pointer transition-colors ${
        hasTension ? 'border-amber-700/40 bg-amber-50/30' :
        hasRomance ? 'border-rose-400/30 bg-rose-50/20' :
        'border-leather/15 bg-parchment-light/40'
      }`}
      onClick={() => setExpanded(!expanded)}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-heading font-bold text-leather-dark text-sm">{companion.name}</span>
            <span className="text-[10px] text-ink-faint font-heading">
              {companion.race} {companion.charClass} {companion.level}
            </span>
          </div>
          <p className="text-xs text-ink-faint font-body mt-0.5 italic">{companion.relationshipLabel}</p>
        </div>
        <div className="flex-shrink-0 text-right">
          <div className="text-xs font-heading text-ink-faint">{companion.hp}/{companion.maxHp} HP</div>
          {hasTension && <div className="text-[10px] text-amber-700 font-heading">⚡ tense</div>}
          {hasRomance && <div className="text-[10px] text-rose-500 font-heading">♥ close</div>}
        </div>
      </div>

      {expanded && (
        <div className="mt-3 space-y-2 border-t border-leather/10 pt-2">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            {[
              { label: 'Trust', value: r.trust },
              { label: 'Bond', value: r.bond },
              { label: 'Morale', value: r.morale },
              { label: 'Loyalty', value: r.loyalty },
            ].map(({ label, value }) => (
              <div key={label}>
                <div className="flex justify-between text-[10px] font-heading text-ink-faint mb-0.5">
                  <span>{label}</span>
                  <span className={value < 0 ? 'text-blood' : value >= 3 ? 'text-forest' : ''}>{value > 0 ? `+${value}` : value}</span>
                </div>
                <RelBar value={value} color={value < 0 ? '#8b1a1a' : '#2d5a1e'} />
              </div>
            ))}
          </div>
          {companion.aspiration && (
            <p className="text-[11px] font-body text-ink-faint italic">"{companion.aspiration}"</p>
          )}
          {companion.personalQuestTitle && !companion.personalQuestResolved && (
            <p className="text-[11px] font-body text-leather italic">Quest: {companion.personalQuestTitle}</p>
          )}
          {companion.grievance && r.tension >= 2 && (
            <p className="text-[11px] font-body text-amber-700 italic">Grievance: {companion.grievance}</p>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function TownView({ apiUrl, player, campaignId, socket, onBack, onLeave }: Props) {
  const [townData, setTownData] = useState<TownData | null>(null);
  const [tab, setTab] = useState<Tab>('taproom');
  const [loading, setLoading] = useState(true);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [log, setLog] = useState<Array<{ actor: string; content: string; id: string }>>([]);
  const [buyCart, setBuyCart] = useState<Record<string, number>>({});
  const [leaving, setLeaving] = useState(false);
  const [newContractId, setNewContractId] = useState<string | null>(null);

  const headers = { Authorization: `Bearer ${player.token}`, 'Content-Type': 'application/json' };

  const fetchTownData = useCallback(async () => {
    try {
      const res = await fetch(`${apiUrl}/api/town/${campaignId}`, { headers });
      const data = await res.json();
      if (data.ok) setTownData(data.data);
    } catch {}
    setLoading(false);
  }, [campaignId, apiUrl]);

  useEffect(() => {
    fetchTownData();
  }, [fetchTownData]);

  // Set town ambience on mount
  useEffect(() => {
    setAmbience('town_day');
    return () => { setAmbience('silence'); };
  }, []);

  useEffect(() => {
    const onNarration = (data: { actor: string; content: string }) => {
      setLog(prev => [...prev.slice(-30), { actor: data.actor, content: data.content, id: crypto.randomUUID() }]);
    };
    socket.on('game:narration', onNarration);
    return () => { socket.off('game:narration', onNarration); };
  }, [socket]);

  // React to new follow-up contracts posted by the server
  useEffect(() => {
    const onContractsUpdated = (data: { followUpId: string }) => {
      setNewContractId(data.followUpId);
      setTab('garrison'); // bring player to the board
      fetchTownData();
      // Clear highlight after 15 seconds
      setTimeout(() => setNewContractId(null), 15_000);
    };
    socket.on('game:contracts_updated', onContractsUpdated);
    return () => { socket.off('game:contracts_updated', onContractsUpdated); };
  }, [socket, fetchTownData]);

  const showMsg = (msg: string) => {
    setActionMsg(msg);
    setTimeout(() => setActionMsg(null), 4000);
  };

  const apiPost = async (path: string, body: object = {}) => {
    const res = await fetch(`${apiUrl}/api/town/${campaignId}/${path}`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });
    return res.json();
  };

  // ── Taproom actions ─────────────────────────────────────────────

  const handleRumours = async () => {
    const data = await apiPost('rumours', { count: 2 });
    if (data.ok) fetchTownData();
  };

  const handleDowntime = async () => {
    const data = await apiPost('downtime');
    if (data.ok) {
      fetchTownData();
      showMsg('Downtime processed — companions have had their evening.');
    }
  };

  // ── Market actions ──────────────────────────────────────────────

  const handleSellAll = async () => {
    const data = await apiPost('sell');
    if (data.ok) {
      fetchTownData();
      showMsg(`Sold ${data.data.soldItems.length} item(s) for ${data.data.gpEarned.toFixed(1)} GP (+${data.data.xpAwarded} XP)`);
      playSound('coin_clink');
    } else {
      showMsg(data.error || 'Sale failed');
    }
  };

  const handleBuy = async () => {
    const order = Object.entries(buyCart)
      .filter(([, qty]) => qty > 0)
      .map(([item, quantity]) => ({ item, quantity }));
    if (order.length === 0) { showMsg('Nothing in cart.'); return; }

    const data = await apiPost('buy', { order });
    if (data.ok) {
      setBuyCart({});
      fetchTownData();
      showMsg(`Purchased ${order.length} item type(s) for ${data.data.gpSpent.toFixed(2)} GP`);
      playSound('purchase');
    } else {
      showMsg(data.error || 'Purchase failed');
    }
  };

  const adjustCart = (item: string, delta: number) => {
    setBuyCart(prev => {
      const next = { ...prev, [item]: Math.max(0, (prev[item] || 0) + delta) };
      if (next[item] === 0) delete next[item];
      return next;
    });
  };

  const cartTotal = townData
    ? Object.entries(buyCart).reduce((sum, [item, qty]) => {
        const entry = townData.catalogue.find(c => c.item === item);
        return sum + (entry ? entry.gp * qty : 0);
      }, 0)
    : 0;

  // ── Healer actions ──────────────────────────────────────────────

  const handleHeal = async () => {
    const data = await apiPost('heal');
    if (data.ok) {
      fetchTownData();
      if (data.data.healed.length > 0) {
        showMsg(`Healed: ${data.data.healed.join(', ')} (${data.data.gpSpent} GP)`);
        playSound('heal');
      } else {
        showMsg('No injuries to treat.');
      }
    } else {
      showMsg(data.error || 'Healing failed');
    }
  };

  const handleResurrect = async (npcId: string) => {
    if (!confirm('Resurrection costs 1000 GP and may fail. Attempt it?')) return;
    const data = await apiPost('resurrect', { npcId });
    if (data.ok) {
      fetchTownData();
      showMsg(data.data.succeeded ? 'Resurrection succeeded.' : 'Resurrection failed. The companion is gone.');
    } else {
      showMsg(data.error || 'Cannot resurrect');
    }
  };

  // ── Garrison actions ────────────────────────────────────────────

  const handleTakeContract = async (contractId: string) => {
    const data = await apiPost('contract/take', { contractId });
    if (data.ok) {
      fetchTownData();
      showMsg(`Contract accepted: ${data.data.contract.title}`);
    }
  };

  const handleClaimContract = async (contractId: string) => {
    const data = await apiPost('contract/claim', { contractId });
    if (data.ok) {
      fetchTownData();
      showMsg(`Contract settled: +${data.data.reward} GP, +${data.data.xpAward} XP`);
      playSound('coin_clink');
    } else {
      showMsg(data.error || 'Could not settle contract');
    }
  };

  // ── Hire prospect ───────────────────────────────────────────────

  const handleHire = async (name: string, ask: number) => {
    if (!confirm(`Hire ${name} for ${ask} GP/week?`)) return;
    const data = await apiPost('hire', { prospectName: name });
    if (data.ok) {
      fetchTownData();
      showMsg(`${name} hired.`);
    } else {
      showMsg(data.error || 'Hire failed');
    }
  };

  // ── Leave town ──────────────────────────────────────────────────

  const handleLeave = async () => {
    if (!confirm('Leave town and return to the dungeon?')) return;
    setLeaving(true);
    const data = await apiPost('leave');
    if (data.ok) {
      onLeave();
    } else {
      setLeaving(false);
      showMsg(data.error || 'Departure failed');
    }
  };

  // ── Render ──────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-parchment">
        <p className="font-heading text-leather-dark text-lg animate-pulse">The road into town...</p>
      </div>
    );
  }

  if (!townData) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-parchment gap-4">
        <p className="font-body text-ink">Could not load town state.</p>
        <button onClick={onBack} className="px-4 py-2 rounded border border-leather text-leather font-heading">← Back</button>
      </div>
    );
  }

  const { townName, character, companions, catalogue, prospects, contracts, healQuote, lootAppraisal, deadCompanions } = townData;
  const joinedCompanions = companions.filter(c => c.joinedParty);
  const availableCompanions = companions.filter(c => !c.joinedParty);
  const activeTakenContracts = contracts.filter(c => c.taken && !c.expiredAt && !c.claimedAt);

  const TABS: Array<{ key: Tab; label: string; icon: string }> = [
    { key: 'taproom', label: 'Taproom', icon: '🍺' },
    { key: 'market', label: 'Market', icon: '⚖️' },
    { key: 'healer', label: 'Healer', icon: '⚕' },
    { key: 'garrison', label: 'Garrison', icon: '📋' },
  ];

  return (
    <div className="min-h-screen bg-parchment">

      {/* ── Header ── */}
      <div className="sticky top-0 z-10 border-b border-leather/20 bg-parchment-light/90 backdrop-blur-sm">
        <div className="flex items-center gap-3 px-4 py-3">
          <button onClick={onBack} className="text-leather hover:text-leather-dark font-body text-sm">←</button>
          <div className="flex-1 min-w-0">
            <h1 className="font-heading font-bold text-leather-dark text-base leading-tight">{townName}</h1>
            <p className="text-xs text-ink-faint font-body">Day {townData.sessionNumber} · Town</p>
          </div>
          {character && (
            <div className="flex-shrink-0 text-right">
              <GoldDisplay gold={character.gold} />
              <div className="text-xs text-ink-faint mt-0.5 font-body">{character.name}</div>
            </div>
          )}
        </div>

        {/* Tab bar */}
        <div className="flex border-t border-leather/10">
          {TABS.map(({ key, label, icon }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`flex-1 flex flex-col items-center py-2 gap-0.5 text-[10px] font-heading uppercase tracking-wide transition-colors ${
                tab === key
                  ? 'text-leather-dark border-t-2 border-leather bg-leather/5'
                  : 'text-ink-faint hover:text-leather'
              }`}
            >
              <span className="text-base leading-none">{icon}</span>
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Toast ── */}
      {actionMsg && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-50 bg-leather text-parchment-light text-sm font-body px-4 py-2 rounded-lg shadow-lg max-w-xs text-center">
          {actionMsg}
        </div>
      )}

      <div className="max-w-2xl mx-auto px-4 py-4 pb-28 space-y-4">

        {/* ── Log stream ── */}
        {log.length > 0 && (
          <div className="space-y-2">
            {log.slice(-5).map(entry => (
              <div key={entry.id} className="rounded-lg bg-parchment-light/60 border border-leather/10 px-3 py-2">
                {entry.actor && entry.actor !== 'DM' && (
                  <p className="text-[10px] font-heading text-leather-dark mb-1 uppercase tracking-wide">{entry.actor}</p>
                )}
                <p className="text-sm font-body text-ink leading-relaxed">{entry.content}</p>
              </div>
            ))}
          </div>
        )}

        {/* ═══ TAPROOM ═══ */}
        {tab === 'taproom' && (
          <div className="space-y-4">
            <div className="rounded-lg border border-leather/15 bg-parchment-light/50 p-4">
              <h2 className="font-heading font-bold text-leather-dark mb-1">The Common Room</h2>
              <p className="text-xs font-body text-ink-faint mb-4">
                Low light, low conversation, decent enough ale. The kind of place where rumours find their way to you.
              </p>

              <div className="flex flex-wrap gap-2">
                <button
                  onClick={handleRumours}
                  className="px-4 py-2 rounded-lg border border-leather/30 bg-leather/10 text-leather font-heading text-sm hover:bg-leather/20 transition-colors"
                >
                  Hear rumours
                </button>
                <button
                  onClick={handleDowntime}
                  className="px-4 py-2 rounded-lg border border-leather/30 bg-leather/10 text-leather font-heading text-sm hover:bg-leather/20 transition-colors"
                >
                  Evening downtime
                </button>
              </div>
            </div>

            <div className="rounded-lg border border-leather/15 bg-parchment-light/50 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="font-heading font-bold text-leather-dark">Last Expedition</h3>
                  <p className="text-xs font-body italic text-ink-faint">What the delve actually bought you.</p>
                </div>
                <span className="text-[10px] font-heading uppercase tracking-wide text-amber-700">
                  Pressure {townData.expeditionSummary.encounterPressure}/10
                </span>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
                <SummaryStat label="Sites" value={String(townData.expeditionSummary.discoveredSites)} />
                <SummaryStat label="Fallbacks" value={String(townData.expeditionSummary.fallbackPoints)} />
                <SummaryStat label="Camps" value={String(townData.expeditionSummary.campReady)} />
                <SummaryStat label="Hazards" value={String(townData.expeditionSummary.hazardMarks)} />
                <SummaryStat label="Loot Marks" value={String(townData.expeditionSummary.treasureMarks)} />
              </div>
              {townData.expeditionSummary.recentEvents.length > 0 && (
                <div className="mt-3 space-y-1">
                  {townData.expeditionSummary.recentEvents.map((event) => (
                    <p key={event} className="text-[11px] font-body text-ink-faint">
                      {event}
                    </p>
                  ))}
                </div>
              )}
            </div>

            {/* Prospects for hire */}
            {prospects.length > 0 && (
              <div className="rounded-lg border border-leather/15 bg-parchment-light/50 p-4">
                <h3 className="font-heading font-bold text-leather-dark mb-3">Seeking work</h3>
                <div className="space-y-3">
                  {prospects.map(p => {
                    const alreadyHired = companions.some(c => c.name === p.name && c.joinedParty);
                    return (
                      <div key={p.name} className="flex items-start gap-3 p-3 rounded-lg border border-leather/10 bg-parchment/40">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="font-heading font-bold text-sm text-leather-dark">{p.name}</span>
                            <span className="text-[10px] text-ink-faint font-heading">{p.race} {p.charClass} {p.level}</span>
                          </div>
                          <p className="text-xs font-body text-ink-faint italic">{p.personality}</p>
                          {p.hook && (
                            <p className="mt-1 text-[11px] font-body text-leather">{p.hook}</p>
                          )}
                          <p className="text-xs font-heading text-amber-700 mt-1">{p.ask} GP/week</p>
                        </div>
                        {!alreadyHired && (
                          <button
                            onClick={() => handleHire(p.name, p.ask)}
                            className="flex-shrink-0 px-3 py-1.5 rounded border border-leather/30 text-xs font-heading text-leather hover:bg-leather/10 transition-colors"
                          >
                            Hire
                          </button>
                        )}
                        {alreadyHired && (
                          <span className="text-[10px] text-green-700 font-heading flex-shrink-0">Hired</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Active companions */}
            {joinedCompanions.length > 0 && (
              <div>
                <h3 className="font-heading font-bold text-leather-dark mb-2 text-sm">With you</h3>
                <div className="space-y-2">
                  {joinedCompanions.map(c => <TownCompanionCard key={c.id} companion={c} />)}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ═══ MARKET ═══ */}
        {tab === 'market' && (
          <div className="space-y-4">

            {/* Sell loot */}
            {lootAppraisal.items.length > 0 && (
              <div className="rounded-lg border border-leather/15 bg-parchment-light/50 p-4">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="font-heading font-bold text-leather-dark">The Fence</h2>
                  <span className="text-sm font-heading text-amber-700">{lootAppraisal.totalGp.toFixed(1)} GP offered</span>
                </div>
                <div className="space-y-1 mb-3">
                  {lootAppraisal.items.map((it, i) => (
                    <div key={i} className="flex justify-between text-xs font-body text-ink">
                      <span className="text-ink-faint">{it.item}{it.quantity > 1 ? ` ×${it.quantity}` : ''}</span>
                      <span className="text-amber-700 font-heading">{it.gpValue} GP</span>
                    </div>
                  ))}
                </div>
                <button
                  onClick={handleSellAll}
                  className="w-full py-2.5 rounded-lg bg-leather text-parchment-light font-heading text-sm hover:bg-leather-dark transition-colors"
                >
                  Sell all loot — {lootAppraisal.totalGp.toFixed(1)} GP
                </button>
              </div>
            )}

            {lootAppraisal.items.length === 0 && (
              <div className="rounded-lg border border-leather/10 bg-parchment-light/40 p-4">
                <p className="text-sm font-body text-ink-faint italic">Nothing to sell. The fence has a look, shrugs, and goes back to counting yesterday's takings.</p>
              </div>
            )}

            {/* Buy supplies */}
            <div className="rounded-lg border border-leather/15 bg-parchment-light/50 p-4">
              <h2 className="font-heading font-bold text-leather-dark mb-3">Supplies</h2>
              <div className="space-y-2">
                {catalogue.map(item => (
                  <div key={item.item} className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-heading text-leather-dark">{item.item}</span>
                        <span className="text-[10px] text-amber-700 font-heading">{item.gp} GP</span>
                      </div>
                      <p className="text-[11px] text-ink-faint font-body truncate">{item.description}</p>
                    </div>
                    <div className="flex-shrink-0 flex items-center gap-1">
                      <button
                        onClick={() => adjustCart(item.item, -1)}
                        className="w-6 h-6 rounded border border-leather/20 text-leather font-heading text-sm flex items-center justify-center hover:bg-leather/10"
                      >−</button>
                      <span className="w-5 text-center text-sm font-heading text-ink">{buyCart[item.item] || 0}</span>
                      <button
                        onClick={() => adjustCart(item.item, 1)}
                        className="w-6 h-6 rounded border border-leather/20 text-leather font-heading text-sm flex items-center justify-center hover:bg-leather/10"
                      >+</button>
                    </div>
                  </div>
                ))}
              </div>

              {Object.keys(buyCart).length > 0 && (
                <div className="mt-4 border-t border-leather/10 pt-3 flex items-center justify-between">
                  <span className="text-sm font-heading text-ink-faint">
                    Total: <span className="text-amber-700">{cartTotal.toFixed(2)} GP</span>
                  </span>
                  <button
                    onClick={handleBuy}
                    disabled={!character || cartTotal > character.gold}
                    className="px-4 py-2 rounded-lg bg-leather text-parchment-light font-heading text-sm hover:bg-leather-dark disabled:opacity-40 transition-colors"
                  >
                    Buy
                  </button>
                </div>
              )}
            </div>

            {/* Factions */}
            {townData.factions.length > 0 && (
              <div className="rounded-lg border border-leather/10 bg-parchment-light/40 p-4">
                <h3 className="font-heading font-bold text-leather-dark text-sm mb-2">Word on the street</h3>
                <div className="grid grid-cols-2 gap-2">
                  {townData.factions.map(f => (
                    <div key={f.key} className="flex items-center gap-2">
                      <span className="text-xs font-body text-ink capitalize">{f.name}</span>
                      <FactionPip rep={f.reputation} />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ═══ HEALER ═══ */}
        {tab === 'healer' && (
          <div className="space-y-4">
            <div className="rounded-lg border border-leather/15 bg-parchment-light/50 p-4">
              <h2 className="font-heading font-bold text-leather-dark mb-1">Temple & Healer</h2>
              <p className="text-xs font-body text-ink-faint mb-4">
                Matter-of-fact, competent, and not interested in your story. They fix what they can fix.
              </p>

              {character && healQuote.injuries.length > 0 && (
                <div className="mb-4">
                  <h3 className="font-heading text-sm text-leather-dark mb-2">Injuries</h3>
                  <div className="space-y-1 mb-3">
                    {healQuote.injuries.map((inj, i) => (
                      <div key={i} className="flex justify-between text-xs font-body">
                        <span className="text-ink">{inj.condition}</span>
                        <span className="text-amber-700 font-heading">{inj.cost} GP</span>
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-sm font-heading text-ink-faint">Total: {healQuote.totalCost} GP</span>
                    {character.charClass === 'paladin' && (
                      <span className="text-[10px] text-green-700 font-heading">Lay on hands: 1 free</span>
                    )}
                  </div>
                  <button
                    onClick={handleHeal}
                    disabled={healQuote.totalCost > character.gold}
                    className="w-full py-2.5 rounded-lg bg-leather text-parchment-light font-heading text-sm hover:bg-leather-dark disabled:opacity-40 transition-colors"
                  >
                    Treat injuries — {healQuote.totalCost} GP
                  </button>
                </div>
              )}

              {character && healQuote.injuries.length === 0 && (
                <div className="rounded-lg border border-leather/10 bg-parchment/60 p-3 mb-4">
                  <p className="text-sm font-body text-ink-faint italic">No injuries requiring treatment. The healer approves.</p>
                </div>
              )}

              {/* Resurrect dead companions */}
              {deadCompanions.length > 0 && (
                <div>
                  <h3 className="font-heading text-sm text-leather-dark mb-2">The fallen</h3>
                  <div className="space-y-2">
                    {deadCompanions.map((dc: any) => (
                      <div key={dc.id} className="flex items-center justify-between p-3 rounded-lg border border-leather/10 bg-parchment/40">
                        <div>
                          <span className="text-sm font-heading text-ink">{dc.name}</span>
                          <span className="text-[10px] text-ink-faint font-body ml-2">{dc.char_class}</span>
                        </div>
                        <button
                          onClick={() => handleResurrect(dc.id)}
                          className="px-3 py-1.5 rounded border border-blood/30 text-blood text-xs font-heading hover:bg-blood/10 transition-colors"
                        >
                          Resurrect (1000 GP)
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ═══ GARRISON ═══ */}
        {tab === 'garrison' && (
          <div className="space-y-4">
            <div className="rounded-lg border border-leather/15 bg-parchment-light/50 p-4">
              <h2 className="font-heading font-bold text-leather-dark mb-1">Noticeboard</h2>
              <p className="text-xs font-body text-ink-faint mb-4">
                Contracts. Bounties. Rival sightings. The garrison posts what it wants done and pays when it's done.
              </p>

              {contracts.length > 0 ? (
                <div className="space-y-3">
                  {contracts.map(contract => (
                    <div key={contract.id} className={`p-3 rounded-lg border transition-colors ${
                      contract.id === newContractId
                        ? 'border-leather/50 bg-leather/8 ring-1 ring-leather/25'
                        : contract.expiredAt ? 'border-red-900/20 bg-red-950/5 opacity-70'
                        : contract.taken ? 'border-green-600/30 bg-green-50/30'
                        : 'border-leather/15 bg-parchment/40'
                    }`}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="font-heading font-bold text-sm text-leather-dark">{contract.title}</p>
                            {contract.id === newContractId && (
                              <span className="rounded-full border border-leather/40 bg-leather px-2 py-0.5 text-[10px] font-heading uppercase tracking-wide text-parchment-light animate-pulse">
                                New
                              </span>
                            )}
                            {contract.openingContract && (
                              <span className="rounded-full border border-blood/20 bg-blood/5 px-2 py-0.5 text-[10px] font-heading uppercase tracking-wide text-blood">
                                Opening Hook
                              </span>
                            )}
                            {contract.followUpOf && contract.id !== newContractId && (
                              <span className="rounded-full border border-leather/20 bg-parchment px-2 py-0.5 text-[10px] font-heading text-ink-faint">
                                follow-up
                              </span>
                            )}
                          </div>
                          <p className="text-xs font-body text-ink-faint mt-1">{contract.description}</p>
                          <div className="flex items-center gap-3 mt-2">
                            <span className="text-xs font-heading text-amber-700">{contract.reward} GP reward</span>
                            <span className="text-[10px] text-ink-faint capitalize font-body">{contract.factionKey}</span>
                          </div>
                          {contract.progressText && (
                            <div className="mt-2">
                              <p className="text-[11px] font-body text-ink-faint">{contract.progressText}</p>
                              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-parchment-dark/20">
                                <div
                                  className={`h-full rounded-full ${contract.readyToClaim ? 'bg-heal' : 'bg-leather'}`}
                                  style={{
                                    width: `${Math.max(8, Math.min(100, ((contract.progress || 0) / Math.max(1, contract.objectiveTarget || 1)) * 100))}%`,
                                  }}
                                />
                              </div>
                            </div>
                          )}
                        </div>
                        <div className="flex-shrink-0">
                          {contract.expiredAt ? (
                            <span className="text-[10px] text-red-700 font-heading px-2 py-1 rounded bg-red-900/10">Expired</span>
                          ) : contract.claimedAt ? (
                            <span className="text-[10px] text-heal font-heading px-2 py-1 rounded bg-heal/10">Paid</span>
                          ) : contract.readyToClaim ? (
                            <button
                              onClick={() => handleClaimContract(contract.id)}
                              className="px-3 py-1.5 rounded border border-heal/30 text-xs font-heading text-heal hover:bg-heal/10 transition-colors"
                            >
                              Claim
                            </button>
                          ) : contract.taken ? (
                            <span className="text-[10px] text-green-700 font-heading px-2 py-1 rounded bg-green-100/60">
                              {contract.completedAt ? 'Complete' : 'Taken'}
                            </span>
                          ) : (
                            <button
                              onClick={() => handleTakeContract(contract.id)}
                              className="px-3 py-1.5 rounded border border-leather/30 text-xs font-heading text-leather hover:bg-leather/10 transition-colors"
                            >
                              Accept
                            </button>
                          )}

                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm font-body text-ink-faint italic">The noticeboard is empty. Either the garrison has nothing to offer, or someone's already taken everything worth taking.</p>
              )}
            </div>

            {/* Faction heat summary */}
            {townData.factions.some(f => f.heat > 0) && (
              <div className="rounded-lg border border-amber-700/20 bg-amber-50/30 p-4">
                <h3 className="font-heading font-bold text-amber-700 text-sm mb-2">Heat</h3>
                <div className="space-y-1">
                  {townData.factions.filter(f => f.heat > 0).map(f => (
                    <div key={f.key} className="flex items-center justify-between text-xs">
                      <span className="font-body text-ink capitalize">{f.name}</span>
                      <span className="font-heading text-amber-700">{'●'.repeat(Math.min(f.heat, 6))}</span>
                    </div>
                  ))}
                </div>
                <p className="text-[11px] text-amber-700/70 font-body mt-2 italic">Heat means someone is watching. Don't linger too long.</p>
              </div>
            )}

            {/* Faction standing & unlocked benefits */}
            {townData.factions.some(f => f.reputation > 0 || (f.contractCooldownUntilSession && f.contractCooldownUntilSession > townData.sessionNumber)) && (
              <div className="rounded-lg border border-leather/10 bg-parchment-light/40 p-4">
                <h3 className="font-heading font-bold text-leather-dark text-sm mb-3">Faction standing</h3>
                <div className="space-y-3">
                  {townData.factions
                    .filter(f => f.reputation > 0 || (f.contractCooldownUntilSession && f.contractCooldownUntilSession > townData.sessionNumber))
                    .map(f => {
                      const benefits: string[] = [];
                      if (f.reputation >= 2) benefits.push('Rumour contacts');
                      if (f.reputation >= 3) benefits.push('Scout intel', 'Supply discount');
                      if (f.reputation >= 4) benefits.push('Safe house rest');
                      if (f.reputation >= 5) benefits.push('Safe route');
                      const nextAt = f.reputation < 2 ? 2 : f.reputation < 3 ? 3 : f.reputation < 4 ? 4 : f.reputation < 5 ? 5 : null;
                      const nextLabel = nextAt === 2 ? 'rumour contacts' : nextAt === 3 ? 'scout intel & discounts' : nextAt === 4 ? 'safe house' : nextAt === 5 ? 'safe routes' : null;
                      const onCooldown = f.contractCooldownUntilSession && f.contractCooldownUntilSession > townData.sessionNumber;
                      return (
                        <div key={f.key}>
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-xs font-heading font-bold text-leather-dark capitalize">{f.name}</span>
                            <FactionPip rep={f.reputation} />
                            {onCooldown && (
                              <span className="text-[10px] font-body text-red-600 italic">not posting work</span>
                            )}
                          </div>
                          {benefits.length > 0 && (
                            <div className="flex flex-wrap gap-1 mb-1">
                              {benefits.map(b => (
                                <span key={b} className="text-[10px] font-body bg-green-100/60 text-green-800 px-1.5 py-0.5 rounded">{b}</span>
                              ))}
                            </div>
                          )}
                          {nextLabel && (
                            <p className="text-[10px] text-ink-faint font-body">Rep {nextAt} unlocks {nextLabel}</p>
                          )}
                        </div>
                      );
                    })}
                </div>
              </div>
            )}

            {/* Active contracts summary */}
            {activeTakenContracts.length > 0 && (
              <div className="rounded-lg border border-leather/10 bg-parchment-light/40 p-3">
                <h3 className="font-heading font-bold text-leather-dark text-sm mb-1">Active contracts</h3>
                {activeTakenContracts.map(c => (
                  <div key={c.id} className="flex justify-between text-xs font-body py-1">
                    <span className="text-ink">{c.title}</span>
                    <span className="text-amber-700 font-heading">{c.reward} GP</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Sticky departure footer ── */}
      <div className="fixed bottom-0 left-0 right-0 border-t border-leather/20 bg-parchment-light/95 backdrop-blur-sm px-4 py-3"
           style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom, 12px))' }}>
        <div className="max-w-2xl mx-auto">
          <button
            onClick={handleLeave}
            disabled={leaving}
            className="w-full py-3 rounded-xl bg-leather-dark text-parchment-light font-heading text-sm font-bold hover:bg-leather transition-colors disabled:opacity-50"
          >
            {leaving ? 'Leaving...' : `Leave ${townName} — return to the dungeon`}
          </button>
        </div>
      </div>
    </div>
  );
}

function SummaryStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-leather/10 bg-parchment/60 p-2 text-center">
      <div className="text-[10px] font-heading uppercase tracking-wide text-ink-faint">{label}</div>
      <div className="mt-0.5 text-sm font-heading font-bold text-leather-dark">{value}</div>
    </div>
  );
}
