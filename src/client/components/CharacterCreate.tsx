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

const ABILITY_HELP: Record<string, string> = {
  STR: 'Strength — melee attack power, carrying capacity, forcing doors',
  DEX: 'Dexterity — ranged attacks, dodging, stealth, picking locks',
  CON: 'Constitution — hit points, resisting poison, endurance',
  INT: 'Intelligence — spells for wizards, languages, lore knowledge',
  WIS: 'Wisdom — spells for priests, willpower, perception',
  CHA: 'Charisma — leadership, NPC reactions, max henchmen',
};

const RACE_HELP: Record<string, { desc: string; traits: string }> = {
  human: {
    desc: 'The most versatile race. No level limits, can be any class, and can dual-class at higher levels.',
    traits: 'No ability adjustments. Access to all classes. Unlimited level progression.',
  },
  elf: {
    desc: 'Graceful and long-lived woodland folk. Natural affinity for magic and swordplay.',
    traits: '+1 DEX, -1 CON. 90% resistance to sleep/charm. Infravision 60\'. Detect secret doors. Level limits apply.',
  },
  'half-elf': {
    desc: 'Blending human adaptability with elven grace. The most flexible of the demi-humans.',
    traits: 'No ability adjustments. 30% resistance to sleep/charm. Infravision 60\'. Widest multi-class options.',
  },
  dwarf: {
    desc: 'Stout, resilient mountain folk. Born warriors and craftsmen with a hatred of goblins and giants.',
    traits: '+1 CON, -1 CHA. Poison resistance. Infravision 60\'. Detect stonework traps. Tough but limited class options.',
  },
  gnome: {
    desc: 'Clever, curious tinkers and illusionists. Smaller than dwarves but just as hardy.',
    traits: '+1 INT, -1 WIS. Poison resistance. Infravision 60\'. Can be illusionist mages. Good saving throws.',
  },
  halfling: {
    desc: 'Small, nimble folk who prefer comfort but make surprisingly brave adventurers.',
    traits: '+1 DEX, -1 STR. Excellent saving throws. Nearly invisible in the wild. Deadly with slings.',
  },
};

const CLASS_HELP: Record<string, { desc: string; role: string; prime: string }> = {
  fighter: {
    desc: 'The backbone of any party. Masters of weapons and armour, fighters can deal and absorb tremendous punishment.',
    role: 'Front-line combatant. Best THAC0, most hit points, weapon specialisation.',
    prime: 'STR 9+',
  },
  paladin: {
    desc: 'A holy warrior sworn to uphold law and goodness. Immune to disease, can detect evil, and lays on hands to heal.',
    role: 'Tank and off-healer. Must be Lawful Good. Gains priest spells at level 9.',
    prime: 'STR 12+, CON 9+, WIS 13+, CHA 17+',
  },
  ranger: {
    desc: 'A skilled wilderness warrior and tracker. Expert at fighting specific enemy types and surviving in the wild.',
    role: 'Versatile combatant and scout. Two-weapon fighting. Gains some druid/mage spells.',
    prime: 'STR 13+, DEX 13+, CON 14+, WIS 14+',
  },
  cleric: {
    desc: 'A warrior-priest who channels divine power to heal allies, smite undead, and protect the faithful.',
    role: 'Healer and support. Good armour, decent combat, turn undead, divine spells from level 1.',
    prime: 'WIS 9+',
  },
  druid: {
    desc: 'A priest of nature who draws power from the natural world. Shape-changes into animals at higher levels.',
    role: 'Nature caster and healer. Must be True Neutral. Unique nature spells, animal companions.',
    prime: 'WIS 12+, CHA 15+',
  },
  thief: {
    desc: 'A master of stealth, trickery, and precision. Thrives in the shadows where others fear to tread.',
    role: 'Scout and skill specialist. Pick locks, find/disarm traps, backstab for massive damage.',
    prime: 'DEX 9+',
  },
  bard: {
    desc: 'A jack-of-all-trades who blends combat, magic, and lore. Inspires allies and knows a little of everything.',
    role: 'Support and utility. Some thief skills, some wizard spells, legend lore, charm abilities.',
    prime: 'DEX 12+, INT 13+, CHA 15+',
  },
  mage: {
    desc: 'A student of the arcane arts who bends reality through memorised spells. Fragile but devastating.',
    role: 'Ranged damage and utility. Weakest in combat but most powerful spells. Carries a spellbook.',
    prime: 'INT 9+',
  },
};

const ALIGNMENT_HELP: Record<string, string> = {
  'Lawful Good': 'The crusader. Honour, duty, compassion. Protects the innocent through order and justice.',
  'Neutral Good': 'The benefactor. Does what is right without bias toward law or chaos. Pure altruism.',
  'Chaotic Good': 'The rebel. Follows their conscience, despises tyranny. Kind-hearted but unpredictable.',
  'Lawful Neutral': 'The judge. Order and structure above all. The law is the law, for good or ill.',
  'True Neutral': 'The undecided. Seeks balance, or simply acts pragmatically without moral agenda.',
  'Chaotic Neutral': 'The free spirit. Values personal freedom above all. Unpredictable and self-serving.',
  'Lawful Evil': 'The dominator. Uses law and order to get what they want. Ruthless but disciplined.',
  'Neutral Evil': 'The malefactor. Purely selfish. Will do whatever they can get away with.',
  'Chaotic Evil': 'The destroyer. Cruelty, chaos, and self-interest. The most dangerous alignment.',
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
  const [step, setStep] = useState(1);
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

      <h2 className="text-2xl font-heading font-bold text-leather-dark tracking-wide mb-2">
        Create Your Character
      </h2>
      <p className="text-sm text-ink-faint font-body italic mb-6">
        AD&D 2nd Edition &mdash; every choice matters. There are no wrong answers, only different adventures.
      </p>

      {error && <p className="text-blood text-sm font-body mb-4">{error}</p>}

      {/* Step 1: Roll Abilities */}
      {step === 1 && (
        <div className="border border-leather/15 rounded-lg p-6 bg-parchment-light/40">
          <h3 className="font-heading font-bold text-leather text-sm uppercase tracking-wider mb-3">
            I. Roll Ability Scores
          </h3>

          {!abilityRolls ? (
            <div className="space-y-4">
              <p className="text-sm text-ink-light font-body leading-relaxed">
                Your character has six abilities that define their strengths and weaknesses.
                These are determined by rolling dice &mdash; the luck of the draw shapes your destiny.
              </p>

              <div className="bg-parchment-dark/15 rounded-lg p-4 space-y-2">
                {abilityNames.map(name => (
                  <div key={name} className="text-xs font-body">
                    <span className="font-heading font-bold text-leather-dark">{name}</span>
                    <span className="text-ink-faint"> &mdash; {ABILITY_HELP[name]}</span>
                  </div>
                ))}
              </div>

              <p className="text-xs text-ink-faint font-body italic">
                Scores range from 3-18. Higher is better. 10-11 is average for a human.
              </p>

              <div className="space-y-2">
                <button onClick={() => rollAbilities('4d6kh3')} disabled={loading}
                  className="w-full py-3 rounded-lg bg-leather text-parchment-light font-heading font-semibold text-sm hover:bg-leather-dark disabled:opacity-50">
                  Roll 4d6, Drop Lowest
                </button>
                <p className="text-xs text-ink-faint font-body text-center italic">
                  Recommended &mdash; roll four six-sided dice, keep the best three. Tends to produce heroic characters.
                </p>
                <button onClick={() => rollAbilities('3d6')} disabled={loading}
                  className="w-full py-3 rounded-lg border border-leather/20 text-leather font-heading font-semibold text-sm hover:bg-leather/5 disabled:opacity-50">
                  Roll 3d6 Straight
                </button>
                <p className="text-xs text-ink-faint font-body text-center italic">
                  Old school &mdash; roll three six-sided dice per ability. Harder, but more authentic.
                </p>
              </div>
            </div>
          ) : (
            <div>
              <p className="text-sm text-ink-light font-body mb-3">
                The dice have spoken. Here are your ability scores:
              </p>
              <div className="grid grid-cols-6 gap-2 mb-3">
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
              {/* Quick assessment */}
              <div className="bg-parchment-dark/15 rounded-lg p-3 mb-4">
                <p className="text-xs text-ink-faint font-body italic">
                  {(() => {
                    const vals = abilityRolls.map(r => r.result.total);
                    const max = Math.max(...vals);
                    const min = Math.min(...vals);
                    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
                    if (avg >= 14) return 'Exceptional rolls! You have the makings of a legend.';
                    if (avg >= 12) return 'Strong rolls. You will make a fine adventurer.';
                    if (avg >= 10) return 'Solid, dependable scores. A good foundation.';
                    if (min >= 8) return 'Modest but workable. Many heroes have started with less.';
                    return 'The gods were not generous today. Consider re-rolling, or embrace the challenge.';
                  })()}
                </p>
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
          <h3 className="font-heading font-bold text-leather text-sm uppercase tracking-wider mb-3">
            II. Choose Race
          </h3>
          <p className="text-sm text-ink-light font-body mb-4 leading-relaxed">
            Your race determines your character's heritage and natural abilities.
            Non-human races gain special powers but have class and level restrictions.
            Humans are the only race with no limits.
          </p>
          <div className="space-y-2">
            {RACES.map(r => (
              <button key={r} onClick={() => selectRace(r)} disabled={loading}
                className="w-full py-3 px-4 rounded-lg border border-leather/15 text-left hover:bg-parchment-light/70 hover:border-leather/30 transition-all disabled:opacity-50">
                <div className="font-heading font-bold text-leather-dark">{RACE_LABELS[r]}</div>
                <p className="text-xs text-ink-faint font-body mt-0.5">{RACE_HELP[r].desc}</p>
                <p className="text-xs text-ink-faint font-body mt-1 italic">{RACE_HELP[r].traits}</p>
              </button>
            ))}
          </div>
          <button onClick={() => setStep(1)}
            className="mt-4 text-xs text-leather hover:text-leather-dark font-body">
            &larr; Back to ability scores
          </button>
        </div>
      )}

      {/* Step 3: Choose Class */}
      {step === 3 && (
        <div className="border border-leather/15 rounded-lg p-6 bg-parchment-light/40">
          <h3 className="font-heading font-bold text-leather text-sm uppercase tracking-wider mb-3">
            III. Choose Class
          </h3>
          <p className="text-sm text-ink-light font-body mb-2 leading-relaxed">
            Your class is your profession &mdash; how you fight, what you can do, and how you grow.
            Only classes your {RACE_LABELS[race]}'s abilities qualify for are shown below.
          </p>

          {/* Show adjusted scores */}
          {adjustedScores && (
            <div className="flex gap-2 mb-4 bg-parchment-dark/10 rounded-lg p-2">
              {abilityKeys.map((k, i) => {
                const orig = (scores as any)?.[k];
                const adj = (adjustedScores as any)[k];
                const changed = orig !== adj;
                return (
                  <div key={k} className="text-center flex-1">
                    <div className="text-xs font-heading text-ink-faint">{abilityNames[i]}</div>
                    <div className={`font-heading font-bold ${changed ? 'text-leather' : 'text-leather-dark'}`}>
                      {adj}
                      {changed && <span className="text-xs ml-0.5">({adj > orig ? '+' : ''}{adj - orig})</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="space-y-2">
            {eligibleClasses.map(c => (
              <button key={c} onClick={() => selectClass(c)}
                className="w-full py-3 px-4 rounded-lg border border-leather/15 text-left hover:bg-parchment-light/70 hover:border-leather/30 transition-all">
                <div className="flex items-baseline justify-between">
                  <span className="font-heading font-bold text-leather-dark">{CLASS_LABELS[c] || c}</span>
                  <span className="text-xs text-ink-faint font-body">{CLASS_HELP[c]?.prime}</span>
                </div>
                <p className="text-xs text-ink-faint font-body mt-0.5">{CLASS_HELP[c]?.desc}</p>
                <p className="text-xs text-ink-light font-body mt-1 italic">{CLASS_HELP[c]?.role}</p>
              </button>
            ))}
          </div>
          {eligibleClasses.length === 0 && (
            <div className="text-center py-6">
              <p className="text-blood text-sm font-body italic">
                Your abilities don't meet the requirements for any class available to {RACE_LABELS[race]}.
              </p>
              <p className="text-xs text-ink-faint font-body mt-2">
                Try a different race, or go back and re-roll your abilities.
              </p>
            </div>
          )}
          <button onClick={() => setStep(2)}
            className="mt-4 text-xs text-leather hover:text-leather-dark font-body">
            &larr; Back to race selection
          </button>
        </div>
      )}

      {/* Step 4: Choose Alignment */}
      {step === 4 && (
        <div className="border border-leather/15 rounded-lg p-6 bg-parchment-light/40">
          <h3 className="font-heading font-bold text-leather text-sm uppercase tracking-wider mb-3">
            IV. Choose Alignment
          </h3>
          <p className="text-sm text-ink-light font-body mb-2 leading-relaxed">
            Alignment is your character's moral compass. It combines two axes:
          </p>
          <div className="bg-parchment-dark/15 rounded-lg p-3 mb-4 space-y-1">
            <p className="text-xs font-body text-ink-faint">
              <span className="font-heading font-bold text-leather-dark">Law vs Chaos</span> &mdash; Do you value order, rules, and tradition? Or freedom, flexibility, and independence?
            </p>
            <p className="text-xs font-body text-ink-faint">
              <span className="font-heading font-bold text-leather-dark">Good vs Evil</span> &mdash; Do you protect others and act selflessly? Or pursue your own interests at any cost?
            </p>
          </div>
          {validAlignments.length < 9 && (
            <p className="text-xs text-ink-faint font-body italic mb-3">
              {CLASS_LABELS[charClass]}s are restricted to the alignments shown below.
            </p>
          )}
          <div className="space-y-2">
            {validAlignments.map(a => (
              <button key={a} onClick={() => { setAlignment(a); setStep(5); }}
                className="w-full py-3 px-4 rounded-lg border border-leather/15 text-left hover:bg-parchment-light/70 hover:border-leather/30 transition-all">
                <div className="font-heading font-semibold text-sm text-leather-dark">{a}</div>
                <p className="text-xs text-ink-faint font-body mt-0.5">{ALIGNMENT_HELP[a]}</p>
              </button>
            ))}
          </div>
          <button onClick={() => setStep(3)}
            className="mt-4 text-xs text-leather hover:text-leather-dark font-body">
            &larr; Back to class selection
          </button>
        </div>
      )}

      {/* Step 5: Name */}
      {step === 5 && (
        <div className="border border-leather/15 rounded-lg p-6 bg-parchment-light/40">
          <h3 className="font-heading font-bold text-leather text-sm uppercase tracking-wider mb-3">
            V. Name Your Character
          </h3>
          <p className="text-sm text-ink-light font-body mb-4 leading-relaxed">
            Choose a name worthy of legend. Fantasy names work best &mdash; think Tolkien, not Twitter.
          </p>
          <input
            type="text"
            value={charName}
            onChange={e => setCharName(e.target.value)}
            placeholder="Enter character name..."
            autoFocus
            className="w-full px-4 py-3 rounded-lg border border-leather/20 bg-parchment font-heading text-lg text-leather-dark focus:outline-none focus:border-leather/50"
          />
          <div className="mt-4 p-3 bg-parchment-dark/15 rounded-lg">
            <p className="text-sm text-ink-light font-body">
              <strong className="font-heading text-leather-dark">{charName || '???'}</strong> &mdash; {RACE_LABELS[race]} {CLASS_LABELS[charClass]}, {alignment}
            </p>
          </div>
          <button onClick={() => { setStep(6); }} disabled={!charName.trim()}
            className="w-full mt-4 py-3 rounded-lg bg-leather text-parchment-light font-heading font-semibold hover:bg-leather-dark disabled:opacity-50">
            Review Character
          </button>
          <button onClick={() => setStep(4)}
            className="mt-3 text-xs text-leather hover:text-leather-dark font-body block mx-auto">
            &larr; Back to alignment
          </button>
        </div>
      )}

      {/* Step 6: Confirm */}
      {step === 6 && (
        <div className="border border-leather/15 rounded-lg p-6 bg-parchment-light/40">
          <h3 className="font-heading font-bold text-leather text-sm uppercase tracking-wider mb-4">
            VI. Confirm Your Character
          </h3>
          <div className="space-y-3">
            <div className="text-center pb-3 border-b border-leather/10">
              <p className="text-2xl font-heading font-bold text-leather-dark">{charName}</p>
              <p className="text-sm text-ink-light font-body mt-1">
                {RACE_LABELS[race]} {CLASS_LABELS[charClass]}
              </p>
              <p className="text-xs text-ink-faint font-body italic">{alignment}</p>
            </div>
            <div className="grid grid-cols-6 gap-2">
              {abilityKeys.map((k, i) => (
                <div key={k} className="text-center border border-leather/10 rounded p-2 bg-parchment/50">
                  <div className="text-xs font-heading text-ink-faint">{abilityNames[i]}</div>
                  <div className="text-lg font-heading font-bold text-leather-dark">{(adjustedScores || scores as any)?.[k]}</div>
                </div>
              ))}
            </div>
            <p className="text-xs text-ink-faint font-body italic text-center">
              Hit points, THAC0, saving throws, and starting gold will be rolled when you confirm.
            </p>
          </div>
          <div className="flex gap-3 mt-6">
            <button onClick={() => setStep(1)}
              className="flex-1 py-2.5 rounded-lg border border-leather/20 text-sm font-heading text-ink-faint hover:bg-parchment-dark/20">
              Start Over
            </button>
            <button onClick={createCharacter} disabled={loading}
              className="flex-1 py-2.5 rounded-lg bg-leather text-parchment-light text-sm font-heading font-semibold hover:bg-leather-dark disabled:opacity-50">
              {loading ? 'The gods forge your destiny...' : 'Begin Adventure'}
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
