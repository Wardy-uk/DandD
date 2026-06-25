/**
 * AD&D 2e Spell Casting Resolution
 *
 * Handles: action parsing, validation, slot management, effect application,
 * armour failure, and DM-voice narration.
 *
 * Works with two spell-slot storage formats:
 *   Legacy:  spell_slots = { "1": 2, "2": 1 }          (count only)
 *   New:     spell_slots = { "1": { max: 2, used: 0 } } (max + used)
 *
 * Section 3 migrates all characters to the new format; this file handles both
 * transparently so the system works before and after that migration.
 */

import type { Database } from 'sql.js';
import { get, run } from '../db/helpers.js';
import { d20, roll } from '../engine/dice.js';
import { findSpell, type SpellDefinition, type SpellState, type SpellTarget } from './spells.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** New rich slot format (Section 3 target) */
export interface SpellSlotEntry {
  max: number;
  used: number;
}

export type SpellSlotMap = Record<string, SpellSlotEntry | number>;

export interface ParsedSpellAction {
  spellQuery: string;
  targetName?: string;
  raw: string;
}

export interface CastValidation {
  ok: boolean;
  reason?: string;
  spell?: SpellDefinition;
  slotLevel?: number;
}

export interface SpellCastResult {
  ok: boolean;
  error?: string;
  narration?: string;
  mechanicalDetail?: string;
  hpDelta?: number;
  targetId?: string;
  targetConditions?: string[];
  casterConditions?: string[];
  removeConditions?: string[];
  spellName?: string;
  slotLevel?: number;
}

// ─── Spell-slot helpers (format-agnostic) ────────────────────────────────────

/** Parse spell_slots JSON from DB regardless of storage format */
function parseSlotMap(raw: string | null | undefined): SpellSlotMap {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as SpellSlotMap;
  } catch {
    return {};
  }
}

/** How many slots are available for a given level */
function slotsAvailable(map: SpellSlotMap, level: number): number {
  const entry = map[String(level)];
  if (entry === undefined || entry === null) return 0;
  if (typeof entry === 'number') return entry; // legacy flat format
  return Math.max(0, entry.max - entry.used);
}

/** Decrement one slot at a given level; returns the updated map */
function decrementSlot(map: SpellSlotMap, level: number): SpellSlotMap {
  const key = String(level);
  const entry = map[key];
  if (entry === undefined || entry === null) return map;

  const updated = { ...map };
  if (typeof entry === 'number') {
    // Legacy: subtract 1, floor at 0
    updated[key] = Math.max(0, entry - 1);
  } else {
    // New format: increment used
    updated[key] = { max: entry.max, used: Math.min(entry.max, entry.used + 1) };
  }
  return updated;
}

// ─── Action Parser ────────────────────────────────────────────────────────────

/**
 * Extract spell name and optional target from a player action string.
 *
 * Recognises:
 *   "cast fireball"
 *   "cast cure light wounds on Aldric"
 *   "cast magic missile at the goblin"
 *   "use sleep on the guards"
 *   "fire a magic missile at the troll"
 *   "memorise fireball" → treated as cast in-game
 */
export function parseSpellAction(action: string): ParsedSpellAction | null {
  const cleaned = action.toLowerCase().trim();

  // Patterns: "cast <spell> [at/on/against <target>]"
  // Also: "use <spell> on <target>", "invoke <spell>", "memorise <spell>"
  const castPattern = /^(?:cast|use|invoke|channel|fire|throw|hurl|prepare|memorise|memorize)\s+(.+)$/i;
  const match = cleaned.match(castPattern);
  if (!match) return null;

  const rest = match[1].trim();

  // Split off target if present: "at/on/against/toward <target>"
  const targetSplit = rest.match(/^(.+?)\s+(?:at|on|against|toward|upon)\s+(.+)$/i);
  if (targetSplit) {
    return {
      spellQuery: targetSplit[1].trim(),
      targetName: targetSplit[2].trim(),
      raw: action,
    };
  }

  return { spellQuery: rest, raw: action };
}

/** Returns true if an action string looks like a spell-casting attempt */
export function isSpellCastAction(action: string): boolean {
  return parseSpellAction(action) !== null;
}

// ─── Armour Failure ──────────────────────────────────────────────────────────

/** Armour types that cause MU spell failure */
const ARCANE_ARMOUR_FAILURE_ITEMS = [
  'chain mail', 'plate mail', 'splint mail', 'banded mail', 'field plate', 'full plate',
  'scale mail', 'ring mail', 'studded leather', 'brigandine',
  'leather', 'leather armour',  // Leather *is* allowed — we list only prohibited
];

const MU_FORBIDDEN_ARMOUR = [
  'chain mail', 'plate mail', 'splint mail', 'banded mail', 'field plate', 'full plate',
  'scale mail', 'ring mail', 'studded leather', 'brigandine',
  'shield', // MUs can't use shields either
];

/**
 * Check if a MU character is wearing armour that prevents spellcasting.
 * Returns failure chance (0 = none, 1 = guaranteed failure).
 */
function arcaneArmourFailureChance(inventoryRaw: string | null | undefined): number {
  if (!inventoryRaw) return 0;
  let inventory: { item: string; equipped: boolean }[] = [];
  try {
    inventory = JSON.parse(inventoryRaw);
  } catch {
    return 0;
  }

  const equipped = inventory
    .filter((i) => i.equipped)
    .map((i) => i.item.toLowerCase());

  for (const armour of MU_FORBIDDEN_ARMOUR) {
    if (equipped.some((e) => e.includes(armour))) return 1; // Total failure
  }
  return 0;
}

// ─── Validate ────────────────────────────────────────────────────────────────

export function validateSpellCast(params: {
  spell: SpellDefinition;
  charClass: string;
  level: number;
  memorisedSpells: string[];
  slotMap: SpellSlotMap;
  armourFailure: number;
}): CastValidation {
  const { spell, charClass, memorisedSpells, slotMap, armourFailure } = params;

  // Class match (ranger gets druid spells at level 8+, handled separately)
  const classMatch =
    spell.class === charClass ||
    (charClass === 'ranger' && spell.class === 'druid' && params.level >= 8) ||
    (charClass === 'paladin' && spell.class === 'cleric' && params.level >= 9);

  if (!classMatch) {
    return {
      ok: false,
      reason: `${spell.name} is a ${spell.class} spell — ${charClass}s cannot cast it.`,
    };
  }

  // Priest classes (cleric/druid/ranger): all class spells available after preparing
  // Wizard: must have it in spellbook AND memorised
  if (charClass === 'mage') {
    if (!memorisedSpells.map((s) => s.toLowerCase()).includes(spell.name.toLowerCase())) {
      return {
        ok: false,
        reason: `${spell.name} is not in ${charClass === 'mage' ? 'your memorised spells' : 'your prepared spells'} today.`,
      };
    }
  } else {
    // Priest: prepared from the class list — if memorisedSpells is non-empty, check it
    // If empty, assume all class spells are available (fallback for legacy characters)
    if (memorisedSpells.length > 0) {
      if (!memorisedSpells.map((s) => s.toLowerCase()).includes(spell.name.toLowerCase())) {
        return {
          ok: false,
          reason: `${spell.name} is not among your prepared spells today.`,
        };
      }
    }
  }

  // Slot check
  const available = slotsAvailable(slotMap, spell.level);
  if (available <= 0) {
    return {
      ok: false,
      reason: `You have no ${spell.level === 1 ? 'first' : spell.level === 2 ? 'second' : spell.level === 3 ? 'third' : `${spell.level}th`}-level spell slots remaining.`,
    };
  }

  // Arcane armour check
  if (armourFailure >= 1) {
    return {
      ok: false,
      reason: 'Arcane magic cannot be shaped through armour. The spell fails before it forms.',
    };
  }

  return { ok: true, spell, slotLevel: spell.level };
}

// ─── Target resolution ───────────────────────────────────────────────────────

/**
 * Find a spell target from the scene/encounter.
 * Returns a lightweight SpellTarget or null.
 */
function resolveTarget(
  db: Database,
  campaignId: string,
  targetName?: string,
): SpellTarget | undefined {
  if (!targetName) return undefined;

  const tName = targetName.toLowerCase().trim();

  // Check active characters in campaign
  const chars = (get(db,
    'SELECT id, name, hp, max_hp, ac, conditions FROM characters WHERE campaign_id = ? AND status != "dead"',
    [campaignId]) as any[]) || [];

  // get() returns single row — use a helper approach
  // Actually, let's use the correct helper:
  const allChars = (() => {
    try {
      const stmt = (db as any).prepare(
        'SELECT id, name, hp, max_hp, ac, conditions FROM characters WHERE campaign_id = ? AND status != "dead"'
      );
      stmt.bind([campaignId]);
      const rows: any[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    } catch { return []; }
  })();

  const charMatch = allChars.find((c: any) =>
    String(c.name || '').toLowerCase().includes(tName)
  );
  if (charMatch) {
    return {
      id: charMatch.id,
      name: charMatch.name,
      hp: Number(charMatch.hp),
      maxHp: Number(charMatch.max_hp),
      ac: Number(charMatch.ac),
      conditions: JSON.parse(charMatch.conditions || '[]'),
    };
  }

  // Check NPCs in the current scene
  const allNpcs = (() => {
    try {
      const stmt = (db as any).prepare(
        'SELECT id, name, alive FROM npcs WHERE campaign_id = ? AND alive = 1'
      );
      stmt.bind([campaignId]);
      const rows: any[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    } catch { return []; }
  })();

  const npcMatch = allNpcs.find((n: any) =>
    String(n.name || '').toLowerCase().includes(tName)
  );
  if (npcMatch) {
    return {
      id: npcMatch.id,
      name: npcMatch.name,
      hp: 10, // NPCs don't track HP until encounter spawns a combatant
      maxHp: 10,
      ac: 10,
      conditions: [],
    };
  }

  // Target named but not found — create a stub so spells can still narrate
  return {
    id: 'unknown',
    name: targetName,
    hp: 10,
    maxHp: 10,
    ac: 10,
    conditions: [],
  };
}

// ─── Main Resolution ──────────────────────────────────────────────────────────

export function resolveSpellCast(params: {
  db: Database;
  campaignId: string;
  characterId: string;
  action: string;
  interrupted?: boolean; // True if caster took damage this segment
}): SpellCastResult {
  const { db, campaignId, characterId, action, interrupted = false } = params;

  // Parse the action
  const parsed = parseSpellAction(action);
  if (!parsed) {
    return { ok: false, error: 'That doesn\'t look like a spell casting action.' };
  }

  // Load character
  const character = get(db,
    'SELECT * FROM characters WHERE id = ? AND campaign_id = ?',
    [characterId, campaignId]) as any;
  if (!character) {
    return { ok: false, error: 'Character not found.' };
  }

  // Find the spell
  const spell = findSpell(parsed.spellQuery);
  if (!spell) {
    return {
      ok: false,
      error: `No spell matching "${parsed.spellQuery}" found. Check the name and try again.`,
    };
  }

  // Fizzle if interrupted (took damage while casting)
  if (interrupted) {
    return {
      ok: false,
      spellName: spell.name,
      narration: `${character.name} had begun the casting — the words were there, the gesture half-formed — but the blow lands and the spell comes apart. The energy disperses, ungoverned, and the slot is spent for nothing.`,
      error: `${spell.name} fizzled — interrupted mid-cast.`,
      slotLevel: spell.level,
    };
  }

  // Prepare validation inputs
  const slotMap = parseSlotMap(character.spell_slots);
  const memorisedSpells: string[] = (() => {
    try { return JSON.parse(character.memorised_spells || '[]'); }
    catch { return []; }
  })();

  const armourFailure = character.char_class === 'mage'
    ? arcaneArmourFailureChance(character.inventory)
    : 0;

  const validation = validateSpellCast({
    spell,
    charClass: character.char_class,
    level: Number(character.level),
    memorisedSpells,
    slotMap,
    armourFailure,
  });

  if (!validation.ok) {
    return { ok: false, error: validation.reason, spellName: spell.name };
  }

  // Resolve target
  const target = resolveTarget(db, campaignId, parsed.targetName);

  // Build casting state
  const castState: SpellState = {
    casterLevel: Number(character.level),
    casterName: character.name,
    isInCombat: false, // Caller sets this if needed
    seed: Date.now() ^ (Math.random() * 0x7fffffff | 0),
  };

  // Apply the spell
  const effect = spell.resolve(castState, target);

  // Decrement the slot in DB
  const updatedSlotMap = decrementSlot(slotMap, spell.level);
  run(db,
    'UPDATE characters SET spell_slots = ? WHERE id = ?',
    [JSON.stringify(updatedSlotMap), characterId]);

  // For MU: remove from memorised_spells (wizards can't re-cast same memorised copy)
  if (character.char_class === 'mage') {
    const idx = memorisedSpells.findIndex(
      (s) => s.toLowerCase() === spell.name.toLowerCase()
    );
    if (idx !== -1) {
      memorisedSpells.splice(idx, 1);
      run(db,
        'UPDATE characters SET memorised_spells = ? WHERE id = ?',
        [JSON.stringify(memorisedSpells), characterId]);
    }
  }

  // Apply HP delta to target if it's a character
  if (effect.hpDelta && target && target.id !== 'unknown') {
    const isCharacter = (() => {
      try {
        const row = get(db, 'SELECT id FROM characters WHERE id = ?', [target.id]) as any;
        return !!row;
      } catch { return false; }
    })();

    if (isCharacter) {
      run(db,
        'UPDATE characters SET hp = MAX(0, MIN(max_hp, hp + ?)) WHERE id = ?',
        [effect.hpDelta, target.id]);
    }
  }

  // Apply conditions to target character if known
  if (effect.targetConditions && target && target.id !== 'unknown') {
    try {
      const targetChar = get(db, 'SELECT conditions FROM characters WHERE id = ?', [target.id]) as any;
      if (targetChar) {
        const existingConds: string[] = JSON.parse(targetChar.conditions || '[]');
        const newConds = [...new Set([...existingConds, ...effect.targetConditions])];
        run(db, 'UPDATE characters SET conditions = ? WHERE id = ?',
          [JSON.stringify(newConds), target.id]);
      }
    } catch {}
  }

  // Apply caster conditions
  if (effect.casterConditions) {
    try {
      const casterChar = get(db, 'SELECT conditions FROM characters WHERE id = ?', [characterId]) as any;
      if (casterChar) {
        const existingConds: string[] = JSON.parse(casterChar.conditions || '[]');
        const newConds = [...new Set([...existingConds, ...effect.casterConditions])];
        run(db, 'UPDATE characters SET conditions = ? WHERE id = ?',
          [JSON.stringify(newConds), characterId]);
      }
    } catch {}
  }

  return {
    ok: true,
    spellName: spell.name,
    slotLevel: spell.level,
    narration: effect.narration,
    mechanicalDetail: effect.mechanicalDetail,
    hpDelta: effect.hpDelta,
    targetId: target?.id,
    targetConditions: effect.targetConditions,
    casterConditions: effect.casterConditions,
    removeConditions: effect.removeConditions,
  };
}

// ─── Slot recovery (called from makeCamp) ─────────────────────────────────────

/**
 * Recover all spell slots for a character after a full rest.
 * Returns a narration line if the character is a spellcaster.
 */
export function recoverSpellSlots(db: Database, characterId: string): string | null {
  const character = get(db, 'SELECT * FROM characters WHERE id = ?', [characterId]) as any;
  if (!character) return null;

  const charClass: string = character.char_class;
  const isSpellcaster = ['mage', 'cleric', 'druid', 'ranger', 'paladin'].includes(charClass);
  if (!isSpellcaster) return null;

  const slotMap = parseSlotMap(character.spell_slots);
  if (Object.keys(slotMap).length === 0) return null;

  // Reset all used slots to 0
  const recovered: SpellSlotMap = {};
  for (const [level, entry] of Object.entries(slotMap)) {
    if (typeof entry === 'number') {
      // Legacy: slot count is already the max — nothing to reset
      recovered[level] = entry;
    } else {
      recovered[level] = { max: entry.max, used: 0 };
    }
  }

  run(db, 'UPDATE characters SET spell_slots = ? WHERE id = ?',
    [JSON.stringify(recovered), characterId]);

  const classLabel: Record<string, string> = {
    mage: 'wizard', cleric: 'cleric', druid: 'druid', ranger: 'ranger', paladin: 'paladin',
  };

  return `${character.name}'s spell slots are restored. The ${classLabel[charClass] || charClass} wakes refreshed, the channels of power open again after a night of uninterrupted sleep.`;
}

/**
 * Prepare spells for a Cleric/Druid after rest (they pray/commune).
 * For priests, all class spells are available — this just resets the memorised list
 * to signal that preparation has occurred.
 */
export function preparePriestSpells(db: Database, characterId: string): string | null {
  const character = get(db, 'SELECT * FROM characters WHERE id = ?', [characterId]) as any;
  if (!character) return null;

  const charClass: string = character.char_class;
  if (!['cleric', 'druid'].includes(charClass)) return null;

  // For priests the full class list is always available — mark as prepared
  run(db, 'UPDATE characters SET memorised_spells = ? WHERE id = ?',
    [JSON.stringify(['__all_class_spells__']), characterId]);

  const prayer = charClass === 'cleric'
    ? `${character.name} kneels in prayer as the sun rises, petitioning the deity for the day's gifts. The spells settle into place, each one a promise answered.`
    : `${character.name} sits facing the dawn, the natural world settling into focus around them. The grove's gifts are renewed, the druidic mysteries available once more.`;

  return prayer;
}

// ─── Spellbook utilities ──────────────────────────────────────────────────────

/** Add a spell to a MU's spellbook (e.g. from loot or levelling) */
export function addSpellToSpellbook(
  db: Database,
  characterId: string,
  spellName: string,
): { ok: boolean; reason?: string } {
  const character = get(db, 'SELECT * FROM characters WHERE id = ?', [characterId]) as any;
  if (!character) return { ok: false, reason: 'Character not found.' };
  if (character.char_class !== 'mage') {
    return { ok: false, reason: 'Only Magic-Users have spellbooks.' };
  }

  const spellbook: string[] = (() => {
    try { return JSON.parse(character.spellbook || '[]'); }
    catch { return []; }
  })();

  const spell = findSpell(spellName);
  if (!spell) return { ok: false, reason: `No spell named "${spellName}" found.` };
  if (spell.class !== 'mage') return { ok: false, reason: `${spellName} is not a wizard spell.` };

  if (spellbook.map((s) => s.toLowerCase()).includes(spell.name.toLowerCase())) {
    return { ok: false, reason: `${spell.name} is already in the spellbook.` };
  }

  spellbook.push(spell.name);
  run(db, 'UPDATE characters SET spellbook = ? WHERE id = ?',
    [JSON.stringify(spellbook), characterId]);

  return { ok: true };
}

/** Memorise a spell from a MU's spellbook (consume a memorised-spell slot for that level) */
export function memoriseSpell(
  db: Database,
  characterId: string,
  spellName: string,
): { ok: boolean; reason?: string; narration?: string } {
  const character = get(db, 'SELECT * FROM characters WHERE id = ?', [characterId]) as any;
  if (!character) return { ok: false, reason: 'Character not found.' };

  const spellbook: string[] = (() => {
    try { return JSON.parse(character.spellbook || '[]'); }
    catch { return []; }
  })();

  const spell = findSpell(spellName);
  if (!spell) return { ok: false, reason: `No spell named "${spellName}" found.` };

  const inBook = spellbook.map((s) => s.toLowerCase()).includes(spell.name.toLowerCase());
  if (!inBook) return { ok: false, reason: `${spell.name} is not in the spellbook.` };

  const memorised: string[] = (() => {
    try { return JSON.parse(character.memorised_spells || '[]'); }
    catch { return []; }
  })();

  // Count how many of this level are already memorised
  const slotMap = parseSlotMap(character.spell_slots);
  const maxAtLevel = (() => {
    const entry = slotMap[String(spell.level)];
    if (entry === undefined) return 0;
    return typeof entry === 'number' ? entry : entry.max;
  })();

  const alreadyMemorised = memorised.filter((s) => {
    const found = findSpell(s);
    return found && found.level === spell.level;
  }).length;

  if (alreadyMemorised >= maxAtLevel) {
    return {
      ok: false,
      reason: `No memorisation slots remaining for level ${spell.level} spells today.`,
    };
  }

  memorised.push(spell.name);
  run(db, 'UPDATE characters SET memorised_spells = ? WHERE id = ?',
    [JSON.stringify(memorised), characterId]);

  return {
    ok: true,
    narration: `${character.name} opens the spellbook to the page for ${spell.name} and begins the long work of memorisation. An hour later, the pattern is committed. It sits in the mind now, waiting.`,
  };
}
