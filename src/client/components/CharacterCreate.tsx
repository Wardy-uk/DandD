import { useState } from 'react';

const RACES = ['human', 'elf', 'half-elf', 'dwarf', 'gnome', 'halfling'] as const;
const RACE_LABELS: Record<string, string> = {
  human: 'Human', elf: 'Elf', 'half-elf': 'Half-Elf',
  dwarf: 'Dwarf', gnome: 'Gnome', halfling: 'Halfling',
};
const CLASS_LABELS: Record<string, string> = {
  fighter: 'Fighter', paladin: 'Paladin', ranger: 'Ranger',
  cleric: 'Cleric', druid: 'Druid', thief: 'Thief',
  bard: 'Bard', mage: 'Mage',
};

interface AbilityRoll {
  ability: string;
  result: { rolls: number[]; total: number };
}

interface Props {
  apiUrl: string;
  player: { id: string; token: string };
  campaignId: string;
  onCreated: (characterId: string) => void;
  onBack: () => void;
}

export default function CharacterCreate({ apiUrl, player, campaignId, onCreated, onBack }: Props) {
  const [step, setStep] = useState(1); // 1=roll, 2=race, 3=class, 4=alignment, 5=name, 6=confirm
  const [abilityRolls, setAbilityRolls] = useState<AbilityRoll[] | null>(null);
  const [scores, setScores] = useState<Record<string, number> | null>(null);
  const [adjustedScores, setAdjustedScores] = useState<Record<string, number> | null>(null);
  const [race, setRace] = useState('');
  const [charClass, setCharClass] = useState('');
  const [eligibleClasses, setEligibleClasses] = useState<string[]>([]);
  const [alignment, setAlignment] = useState('');
  const [validAlignments, setValidAlignments] = useState<string[]>([]);
  const [charName, setCharName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const headers = { Authorization: `Bearer ${player.token}`, 'Content-Type': 'application/json' };

  const rollAbilities = async (method: '3d6' | '4d6kh3') => {
    setLoading(true);
    try {
      const res = await fetch(`${apiUrl}/api/characters/roll-abilities`, {
        method: 'POST', headers, body: JSON.stringify({ method }),
      });
      const data = await res.json();
      if (data.ok) {
        setAbilityRolls(data.data.rolls);
        setScores(data.data.scores);
      }
    } catch {
      setError('Failed to roll abilities');
    } finally {
      setLoading(false);
    }
  };

  const selectRace = async (r: string) => {
    setRace(r);
    setLoading(true);
    try {
      const res = await fetch(`${apiUrl}/api/characters/eligible-classes`, {
        method: 'POST', headers, body: JSON.stringify({ race: r, scores }),
      });
      const data = await res.json();
      if (data.ok) {
        setAdjustedScores(data.data.adjustedScores);
        setEligibleClasses(data.data.singleClasses);
        setStep(3);
      }
    } catch {
      setError('Failed to check classes');
    } finally {
      setLoading(false);
    }
  };

  const selectClass = async (c: string) => {
    setCharClass(c);
    try {
      const res = await fetch(`${apiUrl}/api/characters/alignments/${c}`, { headers });
      const data = await res.json();
      if (data.ok) {
        setValidAlignments(data.data);
        setStep(4);
      }
    } catch {
      setError('Failed to fetch alignments');
    }
  };

  const createCharacter = async () => {
    if (!charName.trim()) { setError('Name required'); return; }
    setLoading(true);
    try {
      const res = await fetch(`${apiUrl}/api/characters`, {
        method: 'POST', headers,
        body: JSON.stringify({
          campaignId, name: charName, race, charClass, alignment, scores: adjustedScores || scores,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        onCreated(data.data.id);
      } else {
        setError(data.error || 'Failed to create character');
      }
    } catch {
      setError('Failed to create character');
    } finally {
      setLoading(false);
    }
  };

  const abilityNames = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'];
  const abilityKeys = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

  return (
    <div className="max-w-xl mx-auto">
      <button onClick={onBack} className="text-sm text-leather hover:text-leather-dark font-body mb-4 inline-block">
        &larr; Back to campaigns
      </button>

      <h2 className="text-2xl font-heading font-bold text-leather-dark tracking-wide mb-6">
        Create Your Character
      </h2>

      {error && <p className="text-blood text-sm font-body mb-4">{error}</p>}

      {/* Step 1: Roll Abilities */}
      {step === 1 && (
        <div className="border border-leather/15 rounded-lg p-6 bg-parchment-light/40">
          <h3 className="font-heading font-bold text-leather text-sm uppercase tracking-wider mb-4">
            I. Roll Ability Scores
          </h3>

          {!abilityRolls ? (
            <div className="space-y-3">
              <p className="text-sm text-ink-faint font-body italic">
                Choose your method of ability generation, adventurer.
              </p>
              <div className="flex gap-3">
                <button onClick={() => rollAbilities('4d6kh3')} disabled={loading}
                  className="flex-1 py-3 rounded-lg bg-leather text-parchment-light font-heading font-semibold text-sm hover:bg-leather-dark disabled:opacity-50">
                  4d6 Drop Lowest
                </button>
                <button onClick={() => rollAbilities('3d6')} disabled={loading}
                  className="flex-1 py-3 rounded-lg border border-leather/20 text-leather font-heading font-semibold text-sm hover:bg-leather/5 disabled:opacity-50">
                  3d6 Straight
                </button>
              </div>
            </div>
          ) : (
            <div>
              <div className="grid grid-cols-6 gap-2 mb-4">
                {abilityRolls.map((r, i) => (
                  <div key={r.ability} className="text-center border border-leather/10 rounded-lg p-3 bg-parchment/50">
                    <div className="text-xs font-heading font-bold text-ink-faint uppercase">{abilityNames[i]}</div>
                    <div className="text-2xl font-heading font-bold text-leather-dark mt-1">{r.result.total}</div>
                    <div className="text-xs text-ink-faint font-body mt-0.5">
                      [{r.result.rolls.join(', ')}]
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex gap-3">
                <button onClick={() => { setAbilityRolls(null); setScores(null); }}
                  className="flex-1 py-2 rounded-lg border border-leather/20 text-sm font-heading text-ink-faint hover:bg-parchment-dark/20">
                  Re-roll
                </button>
                <button onClick={() => setStep(2)}
                  className="flex-1 py-2 rounded-lg bg-leather text-parchment-light text-sm font-heading font-semibold hover:bg-leather-dark">
                  Accept Scores
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Step 2: Choose Race */}
      {step === 2 && (
        <div className="border border-leather/15 rounded-lg p-6 bg-parchment-light/40">
          <h3 className="font-heading font-bold text-leather text-sm uppercase tracking-wider mb-4">
            II. Choose Race
          </h3>
          <div className="grid grid-cols-2 gap-2">
            {RACES.map(r => (
              <button key={r} onClick={() => selectRace(r)} disabled={loading}
                className="py-3 px-4 rounded-lg border border-leather/15 text-left hover:bg-parchment-light/70 hover:border-leather/30 transition-all disabled:opacity-50">
                <div className="font-heading font-bold text-leather-dark">{RACE_LABELS[r]}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Step 3: Choose Class */}
      {step === 3 && (
        <div className="border border-leather/15 rounded-lg p-6 bg-parchment-light/40">
          <h3 className="font-heading font-bold text-leather text-sm uppercase tracking-wider mb-2">
            III. Choose Class
          </h3>
          <p className="text-xs text-ink-faint font-body mb-4 italic">
            Eligible classes for {RACE_LABELS[race]} with your abilities:
          </p>

          {/* Show adjusted scores */}
          {adjustedScores && (
            <div className="flex gap-2 mb-4">
              {abilityKeys.map((k, i) => (
                <div key={k} className="text-center flex-1">
                  <div className="text-xs font-heading text-ink-faint">{abilityNames[i]}</div>
                  <div className="font-heading font-bold text-leather-dark">{(adjustedScores as any)[k]}</div>
                </div>
              ))}
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            {eligibleClasses.map(c => (
              <button key={c} onClick={() => selectClass(c)}
                className="py-3 px-4 rounded-lg border border-leather/15 text-left hover:bg-parchment-light/70 hover:border-leather/30 transition-all">
                <div className="font-heading font-bold text-leather-dark">{CLASS_LABELS[c] || c}</div>
              </button>
            ))}
          </div>
          {eligibleClasses.length === 0 && (
            <p className="text-blood text-sm font-body italic text-center py-4">
              No classes available. Your abilities may not meet the requirements.
            </p>
          )}
        </div>
      )}

      {/* Step 4: Choose Alignment */}
      {step === 4 && (
        <div className="border border-leather/15 rounded-lg p-6 bg-parchment-light/40">
          <h3 className="font-heading font-bold text-leather text-sm uppercase tracking-wider mb-4">
            IV. Choose Alignment
          </h3>
          <div className="grid grid-cols-3 gap-2">
            {validAlignments.map(a => (
              <button key={a} onClick={() => { setAlignment(a); setStep(5); }}
                className="py-3 px-3 rounded-lg border border-leather/15 text-center hover:bg-parchment-light/70 hover:border-leather/30 transition-all">
                <div className="font-heading font-semibold text-sm text-leather-dark">{a}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Step 5: Name */}
      {step === 5 && (
        <div className="border border-leather/15 rounded-lg p-6 bg-parchment-light/40">
          <h3 className="font-heading font-bold text-leather text-sm uppercase tracking-wider mb-4">
            V. Name Your Character
          </h3>
          <input
            type="text"
            value={charName}
            onChange={e => setCharName(e.target.value)}
            placeholder="Enter character name..."
            autoFocus
            className="w-full px-4 py-3 rounded-lg border border-leather/20 bg-parchment font-heading text-lg text-leather-dark focus:outline-none focus:border-leather/50"
          />
          <div className="mt-4 text-sm text-ink-faint font-body">
            <strong>{charName || '???'}</strong> — {RACE_LABELS[race]} {CLASS_LABELS[charClass]}, {alignment}
          </div>
          <button onClick={() => { setStep(6); }} disabled={!charName.trim()}
            className="w-full mt-4 py-3 rounded-lg bg-leather text-parchment-light font-heading font-semibold hover:bg-leather-dark disabled:opacity-50">
            Review Character
          </button>
        </div>
      )}

      {/* Step 6: Confirm */}
      {step === 6 && (
        <div className="border border-leather/15 rounded-lg p-6 bg-parchment-light/40">
          <h3 className="font-heading font-bold text-leather text-sm uppercase tracking-wider mb-4">
            VI. Confirm
          </h3>
          <div className="space-y-2 text-sm font-body">
            <p><strong className="font-heading">{charName}</strong></p>
            <p>{RACE_LABELS[race]} {CLASS_LABELS[charClass]}</p>
            <p>{alignment}</p>
            <div className="flex gap-3 mt-3">
              {abilityKeys.map((k, i) => (
                <span key={k} className="text-center">
                  <span className="text-xs text-ink-faint font-heading">{abilityNames[i]}</span>{' '}
                  <span className="font-heading font-bold">{(adjustedScores || scores as any)?.[k]}</span>
                </span>
              ))}
            </div>
          </div>
          <div className="flex gap-3 mt-6">
            <button onClick={() => setStep(1)}
              className="flex-1 py-2.5 rounded-lg border border-leather/20 text-sm font-heading text-ink-faint hover:bg-parchment-dark/20">
              Start Over
            </button>
            <button onClick={createCharacter} disabled={loading}
              className="flex-1 py-2.5 rounded-lg bg-leather text-parchment-light text-sm font-heading font-semibold hover:bg-leather-dark disabled:opacity-50">
              {loading ? 'Creating...' : 'Begin Adventure'}
            </button>
          </div>
        </div>
      )}

      {/* Step indicator */}
      <div className="flex justify-center gap-2 mt-6">
        {[1, 2, 3, 4, 5, 6].map(s => (
          <div key={s} className={`w-2 h-2 rounded-full transition-colors ${
            s === step ? 'bg-leather' : s < step ? 'bg-leather/40' : 'bg-leather/15'
          }`} />
        ))}
      </div>
    </div>
  );
}
