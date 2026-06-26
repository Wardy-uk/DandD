import { useEffect, useState } from 'react';

interface RosterCharacter {
  id: string;
  name: string;
  race: string;
  charClass: string;
  alignment: string;
  level: number;
  xp: number;
  hp: number;
  maxHp: number;
  status: string;
  campaignId: string;
  campaignName: string;
  rootCharacterId: string;
  rootCharacterName: string;
  rootCampaignId: string;
  sourceCharacterId: string | null;
  sourceCampaignId: string | null;
  isCampaignCopy: boolean;
  createdAt: string;
}

const RACE_LABELS: Record<string, string> = {
  human: 'Human',
  elf: 'Elf',
  'half-elf': 'Half-Elf',
  dwarf: 'Dwarf',
  gnome: 'Gnome',
  halfling: 'Halfling',
};

const CLASS_LABELS: Record<string, string> = {
  fighter: 'Fighter',
  paladin: 'Paladin',
  ranger: 'Ranger',
  cleric: 'Cleric',
  druid: 'Druid',
  thief: 'Thief',
  bard: 'Bard',
  mage: 'Mage',
};

interface Props {
  apiUrl: string;
  player: { token: string };
  onBack: () => void;
}

export default function AdventurerRoster({ apiUrl, player, onBack }: Props) {
  const [roster, setRoster] = useState<RosterCharacter[]>([]);
  const [loading, setLoading] = useState(true);

  const headers = { Authorization: `Bearer ${player.token}` };

  const deleteCharacter = async (character: RosterCharacter) => {
    if (!confirm(`Delete ${character.name}? This cannot be undone.`)) return;
    try {
      const res = await fetch(`${apiUrl}/api/characters/${character.id}`, {
        method: 'DELETE',
        headers,
      });
      const data = await res.json();
      if (data.ok) {
        setRoster(prev => prev.filter(c => c.id !== character.id));
      } else {
        alert(data.error || 'Failed to delete character');
      }
    } catch (err) {
      console.error('Failed to delete character', err);
    }
  };

  useEffect(() => {
    fetch(`${apiUrl}/api/characters/roster`, { headers })
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) setRoster(data.data || []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [apiUrl, player.token]);

  const grouped = roster.reduce<Record<string, RosterCharacter[]>>((acc, character) => {
    const key = character.rootCharacterId || character.id;
    if (!acc[key]) acc[key] = [];
    acc[key].push(character);
    return acc;
  }, {});

  const families = Object.values(grouped)
    .map((group) => group.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt))))
    .sort((left, right) => String(right[0]?.createdAt || '').localeCompare(String(left[0]?.createdAt || '')));

  return (
    <div className="mx-auto max-w-5xl">
      <button onClick={onBack} className="mb-4 inline-block text-sm font-body text-leather hover:text-leather-dark">
        &larr; Back to campaigns
      </button>

      <div className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-2xl font-heading font-bold tracking-wide text-leather-dark sm:text-3xl">
            Your Adventurers
          </h2>
          <p className="mt-1 text-sm font-body italic text-ink-faint">
            Each hero can travel into multiple campaigns. Imported versions are campaign copies that grow independently.
          </p>
        </div>
        <div className="text-xs font-body text-ink-faint">
          {roster.length} total character{roster.length !== 1 ? 's' : ''} across {families.length} adventurer line{families.length !== 1 ? 's' : ''}
        </div>
      </div>

      {loading ? (
        <p className="py-12 text-center font-body italic text-ink-faint">Loading your stable...</p>
      ) : families.length === 0 ? (
        <div className="rounded-lg border border-dashed border-leather/20 p-12 text-center">
          <p className="font-body italic text-ink-faint">No adventurers yet.</p>
          <p className="mt-2 text-xs font-body text-ink-faint">Create someone new and they will appear here automatically.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {families.map((group) => {
            const anchor = group.find((character) => !character.isCampaignCopy) || group[0];
            const copies = group.filter((character) => character.isCampaignCopy);
            return (
              <div key={anchor.rootCharacterId || anchor.id} className="rounded-2xl border border-leather/15 bg-parchment-light/40 p-4 sm:p-5">
                <div className="flex flex-col gap-3 border-b border-leather/10 pb-4 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-heading text-lg font-bold text-leather-dark">{anchor.rootCharacterName || anchor.name}</h3>
                      <span className="rounded-full border border-leather/15 bg-parchment px-2 py-0.5 text-[10px] font-heading uppercase tracking-wide text-ink-faint">
                        Original Build
                      </span>
                      {copies.length > 0 && (
                        <span className="rounded-full border border-gold/20 bg-gold/10 px-2 py-0.5 text-[10px] font-heading uppercase tracking-wide text-gold">
                          {copies.length} Campaign Cop{copies.length === 1 ? 'y' : 'ies'}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-sm font-body italic text-ink-faint">
                      {RACE_LABELS[anchor.race] || anchor.race} {CLASS_LABELS[anchor.charClass] || anchor.charClass} · {anchor.alignment}
                    </p>
                    <p className="mt-1 text-xs font-body text-ink-faint">
                      First seen in {anchor.campaignName} · Level {anchor.level} · XP {anchor.xp}
                    </p>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <RosterStat label="HP" value={`${anchor.hp}/${anchor.maxHp}`} />
                    <RosterStat label="Status" value={anchor.status} />
                    <RosterStat label="Lives" value={String(group.filter((character) => character.status !== 'dead').length)} />
                  </div>
                </div>

                <div className="mt-4 space-y-2">
                  {group.map((character) => (
                    <div key={character.id} className="rounded-xl border border-leather/10 bg-parchment/65 p-3">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <div className="font-heading font-bold text-leather-dark">{character.name}</div>
                            <span className={`rounded-full px-2 py-0.5 text-[10px] font-heading uppercase tracking-wide ${
                              character.isCampaignCopy
                                ? 'border border-gold/20 bg-gold/10 text-gold'
                                : 'border border-heal/20 bg-heal/10 text-heal'
                            }`}>
                              {character.isCampaignCopy ? 'Campaign Copy' : 'Anchor'}
                            </span>
                            {character.status === 'dead' && (
                              <span className="rounded-full border border-blood/20 bg-blood/10 px-2 py-0.5 text-[10px] font-heading uppercase tracking-wide text-blood">
                                Dead
                              </span>
                            )}
                          </div>
                          <p className="mt-1 text-xs font-body italic text-ink-faint">
                            {character.campaignName} · Level {character.level} {RACE_LABELS[character.race] || character.race} {CLASS_LABELS[character.charClass] || character.charClass}
                          </p>
                          <p className="mt-1 text-xs font-body text-ink-faint">
                            HP {character.hp}/{character.maxHp} · XP {character.xp}
                            {character.isCampaignCopy && character.sourceCampaignId
                              ? ` · Imported from another campaign branch`
                              : ''}
                          </p>
                        </div>
                        <div className="flex items-center gap-3">
                          <div className="text-xs font-body text-ink-faint">
                            {formatDate(character.createdAt)}
                          </div>
                          <button
                            onClick={() => deleteCharacter(character)}
                            className="rounded border border-red-300/60 px-2 py-1 text-[10px] font-heading font-semibold text-red-600 hover:bg-red-50 transition-colors"
                            title="Delete character"
                          >
                            🗑
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function RosterStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-leather/10 bg-parchment/60 px-3 py-2">
      <div className="text-[10px] font-heading uppercase tracking-wide text-ink-faint">{label}</div>
      <div className="mt-0.5 text-sm font-heading font-bold text-ink">{value}</div>
    </div>
  );
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
