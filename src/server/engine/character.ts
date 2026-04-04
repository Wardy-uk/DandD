/**
 * AD&D 2nd Edition Character Creation & Management
 * Handles stat generation, class eligibility, HP, levelling, proficiencies
 */

import { roll3d6, roll4d6DropLowest, rollPercentile, rollDie, type DiceResult } from './dice.js';
import {
  type Race, type CharClass, type Alignment,
  RACE_CLASS_ALLOWED, RACE_LEVEL_LIMITS, RACE_MULTICLASS,
  RACE_ABILITY_ADJ, RACE_ABILITY_LIMITS, RACE_BASE_MOVEMENT,
  CLASS_ABILITY_REQS, CLASS_ALIGNMENT_RESTRICTIONS, CLASS_THAC0_GROUP,
  HIT_DICE, XP_TABLE, THAC0_TABLE,
  STARTING_WEAPON_PROFS, STARTING_NONWEAPON_PROFS,
  WEAPON_PROF_RATE, NONWEAPON_PROF_RATE,
  getStrengthMods, getDexterityMods, getConstitutionMods, getWarriorConHpAdj,
  getIntelligenceMods, getWisdomSpellBonus, getCharismaMaxHenchmen,
  PRIEST_SPELL_SLOTS, WIZARD_SPELL_SLOTS, THIEF_SKILLS_BASE,
} from './tables.js';
import { getThac0, getSavingThrows } from './combat.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AbilityScores {
  str: number;
  strPercentile?: number; // Only for warriors with STR 18
  dex: number;
  con: number;
  int: number;
  wis: number;
  cha: number;
}

export interface AbilityRolls {
  method: '3d6' | '4d6kh3';
  rolls: { ability: string; result: DiceResult }[];
  scores: AbilityScores;
}

export interface CharacterData {
  id: string;
  campaignId: string;
  playerId: string;
  playerName: string;
  name: string;
  race: Race;
  charClass: CharClass;
  multiClass?: CharClass[];
  alignment: Alignment;
  level: number;
  xp: number;
  xpNext: number;

  // Ability scores
  str: number;
  strPercentile?: number;
  dex: number;
  con: number;
  int: number;
  wis: number;
  cha: number;

  // Combat
  thac0: number;
  ac: number;
  hp: number;
  maxHp: number;
  baseMovement: number;

  // Saving throws
  saves: {
    paralysis: number;
    rod: number;
    petrify: number;
    breath: number;
    spell: number;
  };

  // Proficiencies
  weaponProfSlots: number;
  nonweaponProfSlots: number;
  weaponProfs: { weapon: string; specialized: boolean }[];
  nonweaponProfs: { name: string; ability: string; modifier: number }[];

  // Spells (if applicable)
  spellSlots?: Record<number, number>;
  memorisedSpells?: string[];
  spellbook?: string[];
  priestSpheres?: string[];

  // Thief skills (if applicable)
  thiefSkills?: Record<string, number>;

  // Inventory
  inventory: { item: string; weight: number; quantity: number; equipped: boolean }[];
  gold: number;
  silver: number;
  copper: number;
  electrum: number;
  platinum: number;

  // Status
  conditions: string[];
  notes: string;

  // Async multiplayer
  status: 'active' | 'camp' | 'autopilot'; // camp=safe, autopilot=AI controls in combat
}

// ─── Ability Score Generation ───────────────────────────────────────────────

/** Generate ability scores using 3d6 straight */
export function generateAbilities3d6(): AbilityRolls {
  const abilities = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
  const rolls = abilities.map(ability => ({
    ability,
    result: roll3d6(),
  }));

  const scores: AbilityScores = {
    str: rolls[0].result.total,
    dex: rolls[1].result.total,
    con: rolls[2].result.total,
    int: rolls[3].result.total,
    wis: rolls[4].result.total,
    cha: rolls[5].result.total,
  };

  return { method: '3d6', rolls, scores };
}

/** Generate ability scores using 4d6 drop lowest */
export function generateAbilities4d6(): AbilityRolls {
  const abilities = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
  const rolls = abilities.map(ability => ({
    ability,
    result: roll4d6DropLowest(),
  }));

  const scores: AbilityScores = {
    str: rolls[0].result.total,
    dex: rolls[1].result.total,
    con: rolls[2].result.total,
    int: rolls[3].result.total,
    wis: rolls[4].result.total,
    cha: rolls[5].result.total,
  };

  return { method: '4d6kh3', rolls, scores };
}

// ─── Race & Class Validation ────────────────────────────────────────────────

/** Apply racial ability adjustments */
export function applyRacialAdjustments(scores: AbilityScores, race: Race): AbilityScores {
  const adj = RACE_ABILITY_ADJ[race];
  const result = { ...scores };

  for (const [ability, mod] of Object.entries(adj)) {
    (result as any)[ability] = (result as any)[ability] + (mod || 0);
  }

  // Clamp to racial limits
  const limits = RACE_ABILITY_LIMITS[race];
  for (const [ability, [min, max]] of Object.entries(limits)) {
    const val = (result as any)[ability];
    (result as any)[ability] = Math.max(min, Math.min(max, val));
  }

  return result;
}

/** Get classes available to a race */
export function getAvailableClasses(race: Race): CharClass[] {
  return RACE_CLASS_ALLOWED[race];
}

/** Get multi-class combinations available to a race */
export function getAvailableMultiClasses(race: Race): string[][] {
  return RACE_MULTICLASS[race];
}

/** Check if ability scores meet class requirements */
export function meetsClassRequirements(scores: AbilityScores, charClass: CharClass): boolean {
  const reqs = CLASS_ABILITY_REQS[charClass];
  for (const [ability, minScore] of Object.entries(reqs)) {
    if ((scores as any)[ability] < minScore!) return false;
  }
  return true;
}

/** Get all classes a character qualifies for given race and abilities */
export function getEligibleClasses(race: Race, scores: AbilityScores): CharClass[] {
  return getAvailableClasses(race).filter(c => meetsClassRequirements(scores, c));
}

/** Get eligible multi-class combinations */
export function getEligibleMultiClasses(race: Race, scores: AbilityScores): string[][] {
  return getAvailableMultiClasses(race).filter(combo =>
    combo.every(c => meetsClassRequirements(scores, c as CharClass))
  );
}

/** Get valid alignments for a class */
export function getValidAlignments(charClass: CharClass): Alignment[] {
  return CLASS_ALIGNMENT_RESTRICTIONS[charClass];
}

/** Get the level limit for a race/class combination (0 = unlimited) */
export function getLevelLimit(race: Race, charClass: CharClass): number | null {
  if (race === 'human') return null; // Unlimited
  const limits = RACE_LEVEL_LIMITS[race];
  return limits[charClass] ?? null;
}

// ─── Hit Points ─────────────────────────────────────────────────────────────

/** Roll HP for a new character (level 1) */
export function rollStartingHP(charClass: CharClass, con: number): number {
  const hdInfo = HIT_DICE[charClass];
  if (!hdInfo) return 1;

  const group = CLASS_THAC0_GROUP[charClass];
  const conBonus = group === 'warrior'
    ? getWarriorConHpAdj(con)
    : getConstitutionMods(con).hpAdj;

  // Roll hit die, add CON bonus, minimum 1
  const hpRoll = rollDie(hdInfo.die);
  return Math.max(1, hpRoll + conBonus);
}

/** Roll HP for levelling up */
export function rollLevelUpHP(charClass: CharClass, newLevel: number, con: number): number {
  const hdInfo = HIT_DICE[charClass];
  if (!hdInfo) return 0;

  const group = CLASS_THAC0_GROUP[charClass];

  // After name level, fixed HP per level (no CON bonus)
  if (newLevel > hdInfo.nameLevel) {
    return hdInfo.hpAfterNameLevel;
  }

  const conBonus = group === 'warrior'
    ? getWarriorConHpAdj(con)
    : Math.min(getConstitutionMods(con).hpAdj, hdInfo.conBonusCap ?? 99);

  const hpRoll = rollDie(hdInfo.die);
  return Math.max(1, hpRoll + conBonus);
}

// ─── Experience & Levelling ─────────────────────────────────────────────────

/** Get XP needed for next level */
export function getXpForLevel(charClass: CharClass, level: number): number {
  const table = XP_TABLE[charClass] || XP_TABLE.fighter;
  if (level >= table.length) {
    // Beyond table — extrapolate
    const lastGap = table[table.length - 1] - table[table.length - 2];
    return table[table.length - 1] + lastGap * (level - table.length + 1);
  }
  return table[level];
}

/** Check if character has enough XP to level up */
export function canLevelUp(charClass: CharClass, level: number, xp: number, race: Race): boolean {
  const limit = getLevelLimit(race, charClass);
  if (limit !== null && level >= limit) return false;

  const needed = getXpForLevel(charClass, level + 1);
  return xp >= needed;
}

// ─── Proficiencies ──────────────────────────────────────────────────────────

/** Get starting proficiency slot counts */
export function getStartingProfSlots(charClass: CharClass): { weapon: number; nonweapon: number } {
  const group = CLASS_THAC0_GROUP[charClass] || 'warrior';
  return {
    weapon: STARTING_WEAPON_PROFS[group] || 2,
    nonweapon: STARTING_NONWEAPON_PROFS[group] || 3,
  };
}

/** Get total proficiency slots at a given level */
export function getProfSlotsAtLevel(charClass: CharClass, level: number): { weapon: number; nonweapon: number } {
  const group = CLASS_THAC0_GROUP[charClass] || 'warrior';
  const startW = STARTING_WEAPON_PROFS[group] || 2;
  const startNW = STARTING_NONWEAPON_PROFS[group] || 3;
  const rateW = WEAPON_PROF_RATE[group] || 4;
  const rateNW = NONWEAPON_PROF_RATE[group] || 3;

  const bonusW = Math.floor((level - 1) / rateW);
  const bonusNW = Math.floor((level - 1) / rateNW);

  return {
    weapon: startW + bonusW,
    nonweapon: startNW + bonusNW,
  };
}

// ─── Thief Skills ───────────────────────────────────────────────────────────

/** Get base thief skills for a given level */
export function getThiefSkills(level: number): Record<string, number> {
  const skills: Record<string, number> = {};
  const clampedLevel = Math.min(level, 20);

  for (const [skill, values] of Object.entries(THIEF_SKILLS_BASE)) {
    skills[skill] = values[clampedLevel] || 0;
  }

  return skills;
}

// ─── Spell Slots ────────────────────────────────────────────────────────────

/** Get priest spell slots for a given level (including WIS bonus) */
export function getPriestSpellSlots(level: number, wis: number): Record<number, number> {
  const base = PRIEST_SPELL_SLOTS[Math.min(level, 20)];
  if (!base) return {};

  const slots: Record<number, number> = {};
  const wisBonus = getWisdomSpellBonus(wis);

  for (let i = 1; i < base.length; i++) {
    slots[i] = base[i] + (wisBonus[i] || 0);
  }

  return slots;
}

/** Get wizard spell slots for a given level */
export function getWizardSpellSlots(level: number): Record<number, number> {
  const base = WIZARD_SPELL_SLOTS[Math.min(level, 20)];
  if (!base) return {};

  const slots: Record<number, number> = {};
  for (let i = 1; i < base.length; i++) {
    slots[i] = base[i];
  }

  return slots;
}

// ─── Starting Equipment ─────────────────────────────────────────────────────

/** Get starting gold by class (in gold pieces) */
export function rollStartingGold(charClass: CharClass): number {
  switch (charClass) {
    case 'fighter':  return rollDie(6) * 10 + rollDie(6) * 10 + rollDie(6) * 10 + rollDie(6) * 10 + rollDie(6) * 10; // 5d4x10
    case 'paladin':  return (rollDie(4) + rollDie(4) + rollDie(4) + rollDie(4) + rollDie(4)) * 10;
    case 'ranger':   return (rollDie(4) + rollDie(4) + rollDie(4) + rollDie(4) + rollDie(4)) * 10;
    case 'cleric':   return (rollDie(6) + rollDie(6) + rollDie(6)) * 10;
    case 'druid':    return (rollDie(6) + rollDie(6) + rollDie(6)) * 10;
    case 'thief':    return (rollDie(6) + rollDie(6)) * 10;
    case 'bard':     return (rollDie(6) + rollDie(6) + rollDie(6) + rollDie(6) + rollDie(6)) * 10;
    case 'mage':     return (rollDie(4) + rollDie(4)) * 10;
    default:         return (rollDie(6) + rollDie(6) + rollDie(6)) * 10;
  }
}

// ─── Character Assembly ─────────────────────────────────────────────────────

/** Build a complete character from creation choices */
export function assembleCharacter(params: {
  id: string;
  campaignId: string;
  playerId: string;
  playerName: string;
  name: string;
  race: Race;
  charClass: CharClass;
  alignment: Alignment;
  scores: AbilityScores;
}): CharacterData {
  const { id, campaignId, playerId, playerName, name, race, charClass, alignment, scores } = params;

  // Apply racial adjustments
  const adjusted = applyRacialAdjustments(scores, race);

  // Exceptional strength for warriors with STR 18
  const group = CLASS_THAC0_GROUP[charClass];
  let strPercentile: number | undefined;
  if (group === 'warrior' && adjusted.str === 18) {
    strPercentile = rollPercentile();
    if (strPercentile === 0) strPercentile = 100; // 00 = 100
  }

  // Combat stats
  const thac0 = getThac0(charClass, 1);
  const dexMods = getDexterityMods(adjusted.dex);
  const baseAC = 10 + dexMods.defenseAdj; // No armour yet
  const hp = rollStartingHP(charClass, adjusted.con);
  const saves = getSavingThrows(charClass, 1);

  // Proficiency slots
  const profSlots = getStartingProfSlots(charClass);

  // Spell slots
  let spellSlots: Record<number, number> | undefined;
  let priestSpheres: string[] | undefined;
  let spellbook: string[] | undefined;

  if (charClass === 'cleric' || charClass === 'druid') {
    spellSlots = getPriestSpellSlots(1, adjusted.wis);
    priestSpheres = charClass === 'cleric'
      ? ['All', 'Astral', 'Charm', 'Combat', 'Creation', 'Divination', 'Guardian', 'Healing', 'Necromantic', 'Protection', 'Summoning', 'Sun']
      : ['All', 'Animal', 'Elemental', 'Healing', 'Plant', 'Weather'];
  } else if (charClass === 'mage') {
    spellSlots = getWizardSpellSlots(1);
    spellbook = []; // Player chooses starting spells
  }

  // Thief skills
  let thiefSkills: Record<string, number> | undefined;
  if (charClass === 'thief' || charClass === 'bard') {
    thiefSkills = getThiefSkills(1);
  }

  // Starting gold
  const gold = rollStartingGold(charClass);

  return {
    id,
    campaignId,
    playerId,
    playerName,
    name,
    race,
    charClass,
    alignment,
    level: 1,
    xp: 0,
    xpNext: getXpForLevel(charClass, 2),
    str: adjusted.str,
    strPercentile,
    dex: adjusted.dex,
    con: adjusted.con,
    int: adjusted.int,
    wis: adjusted.wis,
    cha: adjusted.cha,
    thac0,
    ac: baseAC,
    hp,
    maxHp: hp,
    baseMovement: RACE_BASE_MOVEMENT[race],
    saves,
    weaponProfSlots: profSlots.weapon,
    nonweaponProfSlots: profSlots.nonweapon,
    weaponProfs: [],
    nonweaponProfs: [],
    spellSlots,
    memorisedSpells: spellSlots ? [] : undefined,
    spellbook,
    priestSpheres,
    thiefSkills,
    inventory: [],
    gold,
    silver: 0,
    copper: 0,
    electrum: 0,
    platinum: 0,
    conditions: [],
    notes: '',
    status: 'active',
  };
}
