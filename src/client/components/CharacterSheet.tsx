interface Props {
  character: any;
  onClose: () => void;
}

const SAVE_LABELS = {
  save_paralysis: 'Paralyzation / Poison / Death',
  save_rod: 'Rod / Staff / Wand',
  save_petrify: 'Petrification / Polymorph',
  save_breath: 'Breath Weapon',
  save_spell: 'Spell',
};

export default function CharacterSheet({ character, onClose }: Props) {
  const c = character;

  return (
    <div className="border border-leather/20 rounded-lg bg-parchment p-6 shadow-2xl">
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div>
          <h2 className="text-3xl font-heading font-bold text-leather-dark tracking-wide">{c.name}</h2>
          <p className="text-sm text-ink-faint font-body">
            Level {c.level} {c.race} {c.char_class} &mdash; {c.alignment}
          </p>
          <p className="text-xs text-ink-faint font-body">
            Player: {c.player_name || c.playerName}
          </p>
        </div>
        <button onClick={onClose} className="text-ink-faint hover:text-ink text-xl leading-none">&times;</button>
      </div>

      <div className="h-px bg-gradient-to-r from-leather/30 via-leather/10 to-transparent mb-4" />

      <div className="grid grid-cols-2 gap-6">
        {/* Left Column */}
        <div className="space-y-4">
          {/* Ability Scores */}
          <div>
            <h3 className="text-[10px] font-heading font-bold text-ink-faint uppercase tracking-wider mb-2">Ability Scores</h3>
            <div className="grid grid-cols-3 gap-2">
              {[
                ['STR', c.str, c.str_percentile || c.strPercentile],
                ['DEX', c.dex, null],
                ['CON', c.con, null],
                ['INT', c.int, null],
                ['WIS', c.wis, null],
                ['CHA', c.cha, null],
              ].map(([label, val, extra]) => (
                <div key={label as string} className="text-center border border-leather/10 rounded p-2 bg-parchment-light/30">
                  <div className="text-[10px] font-heading text-ink-faint uppercase">{label as string}</div>
                  <div className="text-xl font-heading font-bold text-leather-dark">
                    {val as number}
                    {extra && <span className="text-sm text-ink-faint">/{extra}</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Combat */}
          <div>
            <h3 className="text-[10px] font-heading font-bold text-ink-faint uppercase tracking-wider mb-2">Combat</h3>
            <div className="grid grid-cols-4 gap-2">
              {[
                ['THAC0', c.thac0],
                ['AC', c.ac],
                ['HP', `${c.hp}/${c.max_hp || c.maxHp}`],
                ['Mv', c.base_movement || c.baseMovement],
              ].map(([label, val]) => (
                <div key={label as string} className="text-center border border-leather/10 rounded p-2 bg-parchment-light/30">
                  <div className="text-[10px] font-heading text-ink-faint uppercase">{label as string}</div>
                  <div className="text-lg font-heading font-bold text-leather-dark">{val}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Saving Throws */}
          <div>
            <h3 className="text-[10px] font-heading font-bold text-ink-faint uppercase tracking-wider mb-2">Saving Throws</h3>
            <div className="space-y-1">
              {Object.entries(SAVE_LABELS).map(([key, label]) => (
                <div key={key} className="flex justify-between text-xs font-body">
                  <span className="text-ink-faint">{label}</span>
                  <span className="font-heading font-bold text-leather-dark">{c[key]}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Experience */}
          <div>
            <h3 className="text-[10px] font-heading font-bold text-ink-faint uppercase tracking-wider mb-2">Experience</h3>
            <div className="flex justify-between text-sm font-body">
              <span>Current XP</span>
              <span className="font-heading font-bold">{c.xp?.toLocaleString()}</span>
            </div>
            <div className="flex justify-between text-sm font-body">
              <span>Next Level</span>
              <span className="font-heading font-bold">{(c.xp_next || c.xpNext)?.toLocaleString()}</span>
            </div>
            <div className="mt-1 h-1.5 bg-parchment-dark/20 rounded-full overflow-hidden">
              <div className="h-full bg-leather/60 rounded-full"
                style={{ width: `${Math.min(100, (c.xp / (c.xp_next || c.xpNext || 1)) * 100)}%` }} />
            </div>
          </div>
        </div>

        {/* Right Column */}
        <div className="space-y-4">
          {/* Wealth */}
          <div>
            <h3 className="text-[10px] font-heading font-bold text-ink-faint uppercase tracking-wider mb-2">Wealth</h3>
            <div className="grid grid-cols-5 gap-1 text-center">
              {[
                ['PP', c.platinum, '#8a8a8a'],
                ['GP', c.gold, '#c49a2a'],
                ['EP', c.electrum, '#9ca3af'],
                ['SP', c.silver, '#a0a0a0'],
                ['CP', c.copper, '#b87333'],
              ].map(([label, val, color]) => (
                <div key={label as string}>
                  <div className="text-[10px] font-heading" style={{ color: color as string }}>{label as string}</div>
                  <div className="font-heading font-bold text-sm">{val as number}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Weapon Proficiencies */}
          <div>
            <h3 className="text-[10px] font-heading font-bold text-ink-faint uppercase tracking-wider mb-2">
              Weapon Proficiencies ({(c.weaponProfs || JSON.parse(c.weapon_profs || '[]')).length}/{c.weapon_prof_slots || c.weaponProfSlots})
            </h3>
            {(() => {
              const profs = c.weaponProfs || JSON.parse(c.weapon_profs || '[]');
              return profs.length > 0 ? (
                <ul className="text-xs font-body space-y-0.5">
                  {profs.map((p: any, i: number) => (
                    <li key={i}>{p.weapon} {p.specialized && '(specialized)'}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-ink-faint font-body italic">None assigned yet</p>
              );
            })()}
          </div>

          {/* Thief Skills */}
          {(c.thiefSkills || c.thief_skills) && (
            <div>
              <h3 className="text-[10px] font-heading font-bold text-ink-faint uppercase tracking-wider mb-2">Thief Skills</h3>
              <div className="space-y-0.5">
                {Object.entries(c.thiefSkills || JSON.parse(c.thief_skills || '{}')).map(([skill, val]) => (
                  <div key={skill} className="flex justify-between text-xs font-body">
                    <span className="text-ink-faint">{skill.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}</span>
                    <span className="font-heading font-bold">{val as number}%</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Spell Slots */}
          {(c.spellSlots || c.spell_slots) && (
            <div>
              <h3 className="text-[10px] font-heading font-bold text-ink-faint uppercase tracking-wider mb-2">Spell Slots</h3>
              <div className="flex gap-2">
                {Object.entries(c.spellSlots || JSON.parse(c.spell_slots || '{}')).map(([level, count]) => (
                  <div key={level} className="text-center border border-magic/20 rounded px-2 py-1 bg-magic/5">
                    <div className="text-[10px] text-magic font-heading">Lvl {level}</div>
                    <div className="font-heading font-bold text-magic">{count as number}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Inventory */}
          <div>
            <h3 className="text-[10px] font-heading font-bold text-ink-faint uppercase tracking-wider mb-2">Inventory</h3>
            {(() => {
              const inv = c.inventory ? (typeof c.inventory === 'string' ? JSON.parse(c.inventory) : c.inventory) : [];
              return inv.length > 0 ? (
                <ul className="text-xs font-body space-y-0.5 max-h-32 overflow-y-auto">
                  {inv.map((item: any, i: number) => (
                    <li key={i} className="flex justify-between">
                      <span>{item.item} {item.quantity > 1 && `(x${item.quantity})`} {item.equipped && '•'}</span>
                      <span className="text-ink-faint">{item.weight}lb</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-ink-faint font-body italic">Empty</p>
              );
            })()}
          </div>

          {/* Conditions */}
          {(() => {
            const conditions = c.conditions ? (typeof c.conditions === 'string' ? JSON.parse(c.conditions) : c.conditions) : [];
            return conditions.length > 0 && (
              <div>
                <h3 className="text-[10px] font-heading font-bold text-blood uppercase tracking-wider mb-2">Conditions</h3>
                <div className="flex gap-1 flex-wrap">
                  {conditions.map((cond: string, i: number) => (
                    <span key={i} className="text-xs px-2 py-0.5 rounded-full bg-blood/10 text-blood font-heading">{cond}</span>
                  ))}
                </div>
              </div>
            );
          })()}
        </div>
      </div>
    </div>
  );
}
