/**
 * AD&D 2nd Edition Combat Engine
 * Handles THAC0, initiative, attack resolution, saving throws, morale, turn undead
 */

import { d20, roll, rollNotation, rollInitiative, roll2d6, d100, type DiceResult } from './dice.js';
import {
  THAC0_TABLE, CLASS_THAC0_GROUP, SAVE_TABLES, CLASS_SAVE_GROUP,
  TURN_UNDEAD_TABLE, UNDEAD_TYPES, WEAPONS, type WeaponData,
  type SavingThrows, type TurnResult,
  getStrengthMods, getDexterityMods, getWarriorAttacksPerRound,
} from './tables.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Combatant {
  id: string;
  name: string;
  charClass: string;
  level: number;
  thac0: number;
  ac: number;
  hp: number;
  maxHp: number;
  str: number;
  strPercentile?: number;
  dex: number;
  weaponSpeed: number;
  weaponDamageSm: string;
  weaponDamageLg: string;
  isLargeTarget: boolean;
  conditions: string[];
  side: 'party' | 'enemy';
  initiativeRoll?: number;
  finalInitiative?: number;
}

export interface AttackResult {
  attacker: string;
  defender: string;
  attackRoll: number;
  thac0: number;
  targetAC: number;
  hitNeeded: number;
  hit: boolean;
  natural20: boolean;
  natural1: boolean;
  damage?: DiceResult;
  totalDamage?: number;
  defenderHpAfter?: number;
  defenderKilled?: boolean;
  description: string; // Machine-readable summary for AI
}

export interface InitiativeResult {
  type: 'group' | 'individual';
  partyRoll?: number;
  enemyRoll?: number;
  order: { id: string; name: string; initiative: number; side: string }[];
}

export interface SaveResult {
  saveType: keyof SavingThrows;
  needed: number;
  rolled: number;
  modifier: number;
  success: boolean;
}

export interface MoraleResult {
  roll: number;
  morale: number;
  holds: boolean;
}

export interface TurnUndeadResult {
  clericLevel: number;
  undeadType: string;
  needed: TurnResult;
  roll?: number;
  result: 'turned' | 'destroyed' | 'no_effect' | 'cannot_turn';
  numAffected?: number;
}

// ─── THAC0 ──────────────────────────────────────────────────────────────────

/** Get THAC0 for a class at a given level */
export function getThac0(charClass: string, level: number): number {
  const group = CLASS_THAC0_GROUP[charClass] || 'warrior';
  const table = THAC0_TABLE[group];
  const clampedLevel = Math.min(level, 20);
  return table[clampedLevel];
}

/** Calculate the number needed to hit on d20 */
export function hitNeeded(thac0: number, targetAC: number): number {
  return thac0 - targetAC;
}

// ─── Attack Resolution ──────────────────────────────────────────────────────

/** Resolve a melee attack */
export function resolveAttack(attacker: Combatant, defender: Combatant): AttackResult {
  const attackRoll = d20();
  const natural20 = attackRoll === 20;
  const natural1 = attackRoll === 1;

  // Strength bonuses for melee
  const strMods = getStrengthMods(attacker.str, attacker.strPercentile);
  const modifiedRoll = attackRoll + strMods.hitAdj;

  const needed = hitNeeded(attacker.thac0, defender.ac);
  const hit = natural20 || (!natural1 && modifiedRoll >= needed);

  const result: AttackResult = {
    attacker: attacker.name,
    defender: defender.name,
    attackRoll,
    thac0: attacker.thac0,
    targetAC: defender.ac,
    hitNeeded: needed,
    hit,
    natural20,
    natural1,
    description: '',
  };

  if (hit) {
    const damageNotation = defender.isLargeTarget ? attacker.weaponDamageLg : attacker.weaponDamageSm;
    const damage = rollNotation(damageNotation);
    const totalDamage = Math.max(1, damage.total + strMods.dmgAdj);

    result.damage = damage;
    result.totalDamage = totalDamage;
    result.defenderHpAfter = defender.hp - totalDamage;
    result.defenderKilled = result.defenderHpAfter <= 0;

    result.description = `${attacker.name} attacks ${defender.name} with a roll of ${attackRoll} ` +
      `(modified ${modifiedRoll}) vs THAC0 ${attacker.thac0}, target AC ${defender.ac} (need ${needed}). ` +
      `HIT for ${totalDamage} damage. ${defender.name} has ${result.defenderHpAfter} HP remaining.` +
      (result.defenderKilled ? ` ${defender.name} is SLAIN.` : '');
  } else {
    result.description = `${attacker.name} attacks ${defender.name} with a roll of ${attackRoll} ` +
      `(modified ${modifiedRoll}) vs THAC0 ${attacker.thac0}, target AC ${defender.ac} (need ${needed}). MISS.`;
  }

  return result;
}

/** Resolve a missile/ranged attack */
export function resolveMissileAttack(
  attacker: Combatant,
  defender: Combatant,
  range: 'short' | 'medium' | 'long',
): AttackResult {
  const attackRoll = d20();
  const natural20 = attackRoll === 20;
  const natural1 = attackRoll === 1;

  const dexMods = getDexterityMods(attacker.dex);
  const rangePenalty = range === 'short' ? 0 : range === 'medium' ? -2 : -5;
  const modifiedRoll = attackRoll + dexMods.missileAdj + rangePenalty;

  const needed = hitNeeded(attacker.thac0, defender.ac);
  const hit = natural20 || (!natural1 && modifiedRoll >= needed);

  const result: AttackResult = {
    attacker: attacker.name,
    defender: defender.name,
    attackRoll,
    thac0: attacker.thac0,
    targetAC: defender.ac,
    hitNeeded: needed,
    hit,
    natural20,
    natural1,
    description: '',
  };

  if (hit) {
    const damageNotation = defender.isLargeTarget ? attacker.weaponDamageLg : attacker.weaponDamageSm;
    const damage = rollNotation(damageNotation);
    const totalDamage = Math.max(1, damage.total); // No STR bonus on missile

    result.damage = damage;
    result.totalDamage = totalDamage;
    result.defenderHpAfter = defender.hp - totalDamage;
    result.defenderKilled = result.defenderHpAfter <= 0;

    result.description = `${attacker.name} fires at ${defender.name} (${range} range) ` +
      `with a roll of ${attackRoll} (modified ${modifiedRoll}). HIT for ${totalDamage} damage.` +
      (result.defenderKilled ? ` ${defender.name} is SLAIN.` : '');
  } else {
    result.description = `${attacker.name} fires at ${defender.name} (${range} range) ` +
      `with a roll of ${attackRoll} (modified ${modifiedRoll}). MISS.`;
  }

  return result;
}

// ─── Initiative ─────────────────────────────────────────────────────────────

/** Roll group initiative (classic 2e) — lower is better */
export function rollGroupInitiative(
  party: Combatant[],
  enemies: Combatant[],
): InitiativeResult {
  const partyRoll = rollInitiative().total;
  const enemyRoll = rollInitiative().total;

  // Build order: within each side, sort by weapon speed (lower first)
  const partyOrder = party
    .filter(c => c.hp > 0)
    .map(c => ({ id: c.id, name: c.name, initiative: partyRoll + c.weaponSpeed, side: 'party' }));

  const enemyOrder = enemies
    .filter(c => c.hp > 0)
    .map(c => ({ id: c.id, name: c.name, initiative: enemyRoll + c.weaponSpeed, side: 'enemy' }));

  const order = [...partyOrder, ...enemyOrder].sort((a, b) => a.initiative - b.initiative);

  return { type: 'group', partyRoll, enemyRoll, order };
}

/** Roll individual initiative — each combatant rolls d10 + weapon speed */
export function rollIndividualInitiative(combatants: Combatant[]): InitiativeResult {
  const order = combatants
    .filter(c => c.hp > 0)
    .map(c => {
      const initRoll = rollInitiative().total;
      const finalInit = initRoll + c.weaponSpeed;
      return { id: c.id, name: c.name, initiative: finalInit, side: c.side };
    })
    .sort((a, b) => a.initiative - b.initiative); // Lower goes first

  return { type: 'individual', order };
}

// ─── Saving Throws ──────────────────────────────────────────────────────────

/** Get saving throw values for a class and level */
export function getSavingThrows(charClass: string, level: number): SavingThrows {
  const group = CLASS_SAVE_GROUP[charClass] || 'warrior';
  const table = SAVE_TABLES[group];

  for (const [min, max, saves] of table) {
    if (level >= min && level <= max) {
      return saves;
    }
  }

  // Return the last bracket for levels beyond the table
  const last = table[table.length - 1];
  return last[2];
}

/** Make a saving throw */
export function makeSavingThrow(
  charClass: string,
  level: number,
  saveType: keyof SavingThrows,
  modifier = 0,
): SaveResult {
  const saves = getSavingThrows(charClass, level);
  const needed = saves[saveType];
  const rolled = d20();
  const success = (rolled + modifier) >= needed;

  return {
    saveType,
    needed,
    rolled,
    modifier,
    success,
  };
}

// ─── Morale ─────────────────────────────────────────────────────────────────

/** Check morale for a monster/NPC group */
export function checkMorale(baseMorale: number, modifier = 0): MoraleResult {
  const result = roll2d6();
  const effectiveMorale = baseMorale + modifier;

  return {
    roll: result.total,
    morale: effectiveMorale,
    holds: result.total <= effectiveMorale,
  };
}

// ─── Turn Undead ────────────────────────────────────────────────────────────

/** Attempt to turn undead */
export function turnUndead(clericLevel: number, undeadType: string): TurnUndeadResult {
  const undeadIndex = UNDEAD_TYPES.indexOf(undeadType as any);
  if (undeadIndex === -1) {
    return { clericLevel, undeadType, needed: null, result: 'cannot_turn' };
  }

  const level = Math.min(clericLevel, 14);
  const table = TURN_UNDEAD_TABLE[level];
  if (!table) {
    return { clericLevel, undeadType, needed: null, result: 'cannot_turn' };
  }

  const needed = table[undeadIndex];

  if (needed === null) {
    return { clericLevel, undeadType, needed, result: 'cannot_turn' };
  }

  if (needed === 'D') {
    const numAffected = roll(2, 6).total;
    return { clericLevel, undeadType, needed, result: 'destroyed', numAffected };
  }

  if (needed === 'T') {
    const numAffected = roll(2, 6).total;
    return { clericLevel, undeadType, needed, result: 'turned', numAffected };
  }

  // Need to roll on d20
  const turnRoll = d20();
  if (turnRoll >= needed) {
    const numAffected = roll(2, 6).total;
    return { clericLevel, undeadType, needed, roll: turnRoll, result: 'turned', numAffected };
  }

  return { clericLevel, undeadType, needed, roll: turnRoll, result: 'no_effect' };
}

// ─── Surprise ───────────────────────────────────────────────────────────────

export interface SurpriseResult {
  partyRoll: number;
  enemyRoll: number;
  partySurprised: boolean;
  enemySurprised: boolean;
  surpriseSegments: number; // 0, 1, or 2 segments of free action
}

/** Roll surprise for an encounter. d10, surprised on 1-3 by default */
export function rollSurpriseCheck(
  partyModifier = 0,
  enemyModifier = 0,
  surpriseRange = 3,
): SurpriseResult {
  const partyRoll = roll(1, 10).total;
  const enemyRoll = roll(1, 10).total;

  const partySurprised = (partyRoll + partyModifier) <= surpriseRange;
  const enemySurprised = (enemyRoll + enemyModifier) <= surpriseRange;

  // Difference in rolls determines segments of surprise
  let surpriseSegments = 0;
  if (partySurprised && !enemySurprised) {
    surpriseSegments = Math.min(enemyRoll - partyRoll, 3);
  } else if (enemySurprised && !partySurprised) {
    surpriseSegments = Math.min(partyRoll - enemyRoll, 3);
  }

  return { partyRoll, enemyRoll, partySurprised, enemySurprised, surpriseSegments: Math.max(0, surpriseSegments) };
}
