/**
 * AD&D 2nd Edition Reference Tables
 * All data sourced from the Player's Handbook and Dungeon Master's Guide
 */

// ─── THAC0 by Class and Level ───────────────────────────────────────────────
// Warriors (Fighter, Paladin, Ranger) improve fastest
// Priests (Cleric, Druid) improve medium
// Rogues (Thief, Bard) improve medium-slow
// Wizards (Mage, Specialist) improve slowest

export const THAC0_TABLE: Record<string, number[]> = {
  // Index = level (0 = unused, 1-20)
  warrior:  [20, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
  priest:   [20, 20, 20, 20, 18, 18, 18, 16, 16, 16, 14, 14, 14, 12, 12, 12, 10, 10, 10, 8, 8],
  rogue:    [20, 20, 20, 19, 19, 18, 18, 17, 17, 16, 16, 15, 15, 14, 14, 13, 13, 12, 12, 11, 11],
  wizard:   [20, 20, 20, 20, 20, 19, 19, 19, 19, 18, 18, 18, 18, 17, 17, 17, 17, 16, 16, 16, 16],
};

// Map each class to its THAC0 group
export const CLASS_THAC0_GROUP: Record<string, string> = {
  fighter: 'warrior', paladin: 'warrior', ranger: 'warrior',
  cleric: 'priest', druid: 'priest',
  thief: 'rogue', bard: 'rogue',
  mage: 'wizard', illusionist: 'wizard', necromancer: 'wizard',
  invoker: 'wizard', conjurer: 'wizard', diviner: 'wizard',
  enchanter: 'wizard', transmuter: 'wizard', abjurer: 'wizard',
};

// ─── Saving Throw Tables ────────────────────────────────────────────────────
// 5 categories: Paralyzation/Poison/Death, Rod/Staff/Wand, Petrification/Polymorph, Breath Weapon, Spell
// Index by level bracket

export interface SavingThrows {
  paralysis: number;  // Paralyzation, Poison, Death Magic
  rod: number;        // Rod, Staff, Wand
  petrify: number;    // Petrification, Polymorph
  breath: number;     // Breath Weapon
  spell: number;      // Spell
}

// Level brackets: [minLevel, maxLevel, saves]
type SaveTableEntry = [number, number, SavingThrows];

export const SAVE_TABLES: Record<string, SaveTableEntry[]> = {
  warrior: [
    [1, 2,   { paralysis: 14, rod: 16, petrify: 15, breath: 17, spell: 17 }],
    [3, 4,   { paralysis: 13, rod: 15, petrify: 14, breath: 16, spell: 16 }],
    [5, 6,   { paralysis: 11, rod: 13, petrify: 12, breath: 13, spell: 14 }],
    [7, 8,   { paralysis: 10, rod: 12, petrify: 11, breath: 12, spell: 13 }],
    [9, 10,  { paralysis: 8,  rod: 10, petrify: 9,  breath: 9,  spell: 11 }],
    [11, 12, { paralysis: 7,  rod: 9,  petrify: 8,  breath: 8,  spell: 10 }],
    [13, 14, { paralysis: 5,  rod: 7,  petrify: 6,  breath: 5,  spell: 8 }],
    [15, 16, { paralysis: 4,  rod: 6,  petrify: 5,  breath: 4,  spell: 7 }],
    [17, 20, { paralysis: 3,  rod: 5,  petrify: 4,  breath: 4,  spell: 6 }],
  ],
  priest: [
    [1, 3,   { paralysis: 10, rod: 14, petrify: 13, breath: 16, spell: 15 }],
    [4, 6,   { paralysis: 9,  rod: 13, petrify: 12, breath: 15, spell: 14 }],
    [7, 9,   { paralysis: 7,  rod: 11, petrify: 10, breath: 13, spell: 12 }],
    [10, 12, { paralysis: 6,  rod: 10, petrify: 9,  breath: 12, spell: 11 }],
    [13, 15, { paralysis: 5,  rod: 9,  petrify: 8,  breath: 11, spell: 10 }],
    [16, 18, { paralysis: 4,  rod: 8,  petrify: 7,  breath: 10, spell: 9 }],
    [19, 20, { paralysis: 2,  rod: 6,  petrify: 5,  breath: 8,  spell: 7 }],
  ],
  rogue: [
    [1, 4,   { paralysis: 13, rod: 14, petrify: 12, breath: 16, spell: 15 }],
    [5, 8,   { paralysis: 12, rod: 12, petrify: 11, breath: 15, spell: 13 }],
    [9, 12,  { paralysis: 11, rod: 10, petrify: 10, breath: 14, spell: 11 }],
    [13, 16, { paralysis: 10, rod: 8,  petrify: 9,  breath: 13, spell: 9 }],
    [17, 20, { paralysis: 9,  rod: 6,  petrify: 8,  breath: 12, spell: 7 }],
  ],
  wizard: [
    [1, 5,   { paralysis: 14, rod: 11, petrify: 13, breath: 15, spell: 12 }],
    [6, 10,  { paralysis: 13, rod: 9,  petrify: 11, breath: 13, spell: 10 }],
    [11, 15, { paralysis: 11, rod: 7,  petrify: 9,  breath: 11, spell: 8 }],
    [16, 20, { paralysis: 10, rod: 5,  petrify: 7,  breath: 9,  spell: 6 }],
  ],
};

export const CLASS_SAVE_GROUP: Record<string, string> = {
  fighter: 'warrior', paladin: 'warrior', ranger: 'warrior',
  cleric: 'priest', druid: 'priest',
  thief: 'rogue', bard: 'rogue',
  mage: 'wizard', illusionist: 'wizard', necromancer: 'wizard',
  invoker: 'wizard', conjurer: 'wizard', diviner: 'wizard',
  enchanter: 'wizard', transmuter: 'wizard', abjurer: 'wizard',
};

// ─── XP Tables (per class) ─────────────────────────────────────────────────
// XP needed to reach each level. Index = level.

export const XP_TABLE: Record<string, number[]> = {
  fighter:    [0, 0, 2000, 4000, 8000, 16000, 32000, 64000, 125000, 250000, 500000, 750000, 1000000, 1250000, 1500000, 1750000, 2000000, 2250000, 2500000, 2750000, 3000000],
  paladin:    [0, 0, 2250, 4500, 9000, 18000, 36000, 75000, 150000, 300000, 600000, 900000, 1200000, 1500000, 1800000, 2100000, 2400000, 2700000, 3000000, 3300000, 3600000],
  ranger:     [0, 0, 2250, 4500, 9000, 18000, 36000, 75000, 150000, 300000, 600000, 900000, 1200000, 1500000, 1800000, 2100000, 2400000, 2700000, 3000000, 3300000, 3600000],
  cleric:     [0, 0, 1500, 3000, 6000, 13000, 27500, 55000, 110000, 225000, 450000, 675000, 900000, 1125000, 1350000, 1575000, 1800000, 2025000, 2250000, 2475000, 2700000],
  druid:      [0, 0, 2000, 4000, 7500, 12500, 20000, 35000, 60000, 90000, 125000, 200000, 300000, 750000, 1500000, 3000000, 3500000, 4000000, 4500000, 5000000, 5500000],
  thief:      [0, 0, 1250, 2500, 5000, 10000, 20000, 40000, 70000, 110000, 160000, 220000, 440000, 660000, 880000, 1100000, 1320000, 1540000, 1760000, 1980000, 2200000],
  bard:       [0, 0, 1250, 2500, 5000, 10000, 20000, 40000, 70000, 110000, 160000, 220000, 440000, 660000, 880000, 1100000, 1320000, 1540000, 1760000, 1980000, 2200000],
  mage:       [0, 0, 2500, 5000, 10000, 20000, 40000, 60000, 90000, 135000, 250000, 375000, 750000, 1125000, 1500000, 1875000, 2250000, 2625000, 3000000, 3375000, 3750000],
};

// ─── Hit Dice ───────────────────────────────────────────────────────────────

export interface HitDiceInfo {
  die: number;       // d10, d8, d6, d4, etc.
  conBonusCap?: number; // Max CON HP bonus per level (warriors=unlimited, priests/rogues=2, wizards=2 after name level)
  hpAfterNameLevel: number; // Fixed HP per level after 9th/10th
  nameLevel: number;
}

export const HIT_DICE: Record<string, HitDiceInfo> = {
  fighter:  { die: 10, nameLevel: 9,  hpAfterNameLevel: 3 },
  paladin:  { die: 10, nameLevel: 9,  hpAfterNameLevel: 3 },
  ranger:   { die: 10, nameLevel: 9,  hpAfterNameLevel: 3 },
  cleric:   { die: 8,  nameLevel: 9,  hpAfterNameLevel: 2, conBonusCap: 2 },
  druid:    { die: 8,  nameLevel: 9,  hpAfterNameLevel: 2, conBonusCap: 2 },
  thief:    { die: 6,  nameLevel: 10, hpAfterNameLevel: 2, conBonusCap: 2 },
  bard:     { die: 6,  nameLevel: 10, hpAfterNameLevel: 2, conBonusCap: 2 },
  mage:     { die: 4,  nameLevel: 10, hpAfterNameLevel: 1, conBonusCap: 2 },
};

// ─── Warrior Attacks per Round ──────────────────────────────────────────────
// Fighters/Paladins/Rangers get extra attacks at higher levels

export function getWarriorAttacksPerRound(level: number): { attacks: number; perRounds: number } {
  if (level < 7) return { attacks: 1, perRounds: 1 };
  if (level < 13) return { attacks: 3, perRounds: 2 }; // 3/2
  return { attacks: 2, perRounds: 1 }; // 2/1
}

// ─── Ability Score Modifiers ────────────────────────────────────────────────

export interface StrengthMods {
  hitAdj: number;
  dmgAdj: number;
  weightAllow: number;  // lbs
  maxPress: number;
  openDoors: number;    // on d20
  bendBars: number;     // percentage
}

// Strength table (including exceptional strength for warriors with 18)
export function getStrengthMods(str: number, percentile?: number): StrengthMods {
  if (str <= 1)  return { hitAdj: -5, dmgAdj: -4, weightAllow: 1, maxPress: 3, openDoors: 1, bendBars: 0 };
  if (str <= 3)  return { hitAdj: -3, dmgAdj: -1, weightAllow: 5, maxPress: 10, openDoors: 2, bendBars: 0 };
  if (str <= 5)  return { hitAdj: -2, dmgAdj: -1, weightAllow: 10, maxPress: 25, openDoors: 3, bendBars: 0 };
  if (str <= 7)  return { hitAdj: -1, dmgAdj: 0, weightAllow: 20, maxPress: 55, openDoors: 4, bendBars: 0 };
  if (str <= 9)  return { hitAdj: 0, dmgAdj: 0, weightAllow: 35, maxPress: 90, openDoors: 5, bendBars: 1 };
  if (str <= 11) return { hitAdj: 0, dmgAdj: 0, weightAllow: 40, maxPress: 115, openDoors: 6, bendBars: 2 };
  if (str <= 13) return { hitAdj: 0, dmgAdj: 0, weightAllow: 45, maxPress: 140, openDoors: 7, bendBars: 4 };
  if (str <= 15) return { hitAdj: 0, dmgAdj: 0, weightAllow: 55, maxPress: 170, openDoors: 8, bendBars: 7 };
  if (str === 16) return { hitAdj: 0, dmgAdj: 1, weightAllow: 70, maxPress: 195, openDoors: 9, bendBars: 10 };
  if (str === 17) return { hitAdj: 1, dmgAdj: 1, weightAllow: 85, maxPress: 220, openDoors: 10, bendBars: 13 };
  if (str === 18 && !percentile) return { hitAdj: 1, dmgAdj: 2, weightAllow: 110, maxPress: 255, openDoors: 11, bendBars: 16 };
  // Exceptional strength (18/xx) — warriors only
  if (str === 18 && percentile !== undefined) {
    if (percentile <= 50)  return { hitAdj: 1, dmgAdj: 3, weightAllow: 135, maxPress: 280, openDoors: 12, bendBars: 20 };
    if (percentile <= 75)  return { hitAdj: 2, dmgAdj: 3, weightAllow: 160, maxPress: 305, openDoors: 13, bendBars: 25 };
    if (percentile <= 90)  return { hitAdj: 2, dmgAdj: 4, weightAllow: 185, maxPress: 330, openDoors: 14, bendBars: 30 };
    if (percentile <= 99)  return { hitAdj: 2, dmgAdj: 5, weightAllow: 235, maxPress: 380, openDoors: 15, bendBars: 35 };
    return { hitAdj: 3, dmgAdj: 6, weightAllow: 335, maxPress: 480, openDoors: 16, bendBars: 40 }; // 18/00
  }
  if (str === 19) return { hitAdj: 3, dmgAdj: 7, weightAllow: 485, maxPress: 640, openDoors: 16, bendBars: 50 };
  // 20+ for monsters
  return { hitAdj: 3, dmgAdj: 8, weightAllow: 535, maxPress: 700, openDoors: 17, bendBars: 60 };
}

export interface DexterityMods {
  reactionAdj: number;
  missileAdj: number;
  defenseAdj: number; // AC adjustment (negative = better)
}

export function getDexterityMods(dex: number): DexterityMods {
  if (dex <= 1)  return { reactionAdj: -6, missileAdj: -6, defenseAdj: 5 };
  if (dex === 2) return { reactionAdj: -4, missileAdj: -4, defenseAdj: 5 };
  if (dex === 3) return { reactionAdj: -3, missileAdj: -3, defenseAdj: 4 };
  if (dex === 4) return { reactionAdj: -2, missileAdj: -2, defenseAdj: 3 };
  if (dex === 5) return { reactionAdj: -1, missileAdj: -1, defenseAdj: 2 };
  if (dex === 6) return { reactionAdj: 0, missileAdj: 0, defenseAdj: 1 };
  if (dex <= 14) return { reactionAdj: 0, missileAdj: 0, defenseAdj: 0 };
  if (dex === 15) return { reactionAdj: 0, missileAdj: 0, defenseAdj: -1 };
  if (dex === 16) return { reactionAdj: 1, missileAdj: 1, defenseAdj: -2 };
  if (dex === 17) return { reactionAdj: 2, missileAdj: 2, defenseAdj: -3 };
  if (dex === 18) return { reactionAdj: 2, missileAdj: 2, defenseAdj: -4 };
  return { reactionAdj: 3, missileAdj: 3, defenseAdj: -4 }; // 19+
}

export interface ConstitutionMods {
  hpAdj: number;        // Per hit die
  systemShock: number;  // Percentage
  resurrection: number; // Percentage
  poisonSave: number;   // Saving throw adjustment
}

export function getConstitutionMods(con: number): ConstitutionMods {
  if (con <= 1)  return { hpAdj: -3, systemShock: 25, resurrection: 30, poisonSave: 0 };
  if (con === 2) return { hpAdj: -2, systemShock: 30, resurrection: 35, poisonSave: 0 };
  if (con === 3) return { hpAdj: -2, systemShock: 35, resurrection: 40, poisonSave: 0 };
  if (con === 4) return { hpAdj: -1, systemShock: 40, resurrection: 45, poisonSave: 0 };
  if (con === 5) return { hpAdj: -1, systemShock: 45, resurrection: 50, poisonSave: 0 };
  if (con === 6) return { hpAdj: -1, systemShock: 50, resurrection: 55, poisonSave: 0 };
  if (con === 7) return { hpAdj: 0, systemShock: 55, resurrection: 60, poisonSave: 0 };
  if (con <= 10) return { hpAdj: 0, systemShock: 60 + (con - 8) * 5, resurrection: 65 + (con - 8) * 5, poisonSave: 0 };
  if (con <= 13) return { hpAdj: 0, systemShock: 75 + (con - 11) * 2, resurrection: 80 + (con - 11) * 2, poisonSave: 0 };
  if (con === 14) return { hpAdj: 0, systemShock: 88, resurrection: 92, poisonSave: 0 };
  if (con === 15) return { hpAdj: 1, systemShock: 91, resurrection: 94, poisonSave: 0 };
  if (con === 16) return { hpAdj: 2, systemShock: 95, resurrection: 96, poisonSave: 0 };
  if (con === 17) return { hpAdj: 2, systemShock: 97, resurrection: 98, poisonSave: 0 };  // +3 for warriors
  if (con === 18) return { hpAdj: 2, systemShock: 99, resurrection: 100, poisonSave: 0 }; // +4 for warriors
  return { hpAdj: 2, systemShock: 99, resurrection: 100, poisonSave: 1 }; // 19+, +5 for warriors
}

// Warriors get higher CON HP bonus
export function getWarriorConHpAdj(con: number): number {
  if (con <= 14) return getConstitutionMods(con).hpAdj;
  if (con === 15) return 1;
  if (con === 16) return 2;
  if (con === 17) return 3;
  if (con === 18) return 4;
  return 5; // 19+
}

export interface IntelligenceMods {
  numLanguages: number;
  spellLevel: number | null;  // Max spell level learnable (wizards)
  chanceToLearn: number | null; // Percentage (wizards)
  maxSpellsPerLevel: number | null; // Wizards
}

export function getIntelligenceMods(int: number): IntelligenceMods {
  if (int <= 8)  return { numLanguages: 1, spellLevel: null, chanceToLearn: null, maxSpellsPerLevel: null };
  if (int === 9) return { numLanguages: 2, spellLevel: 4, chanceToLearn: 35, maxSpellsPerLevel: 6 };
  if (int <= 11) return { numLanguages: 2, spellLevel: 5, chanceToLearn: 40 + (int - 10) * 5, maxSpellsPerLevel: 7 };
  if (int === 12) return { numLanguages: 3, spellLevel: 6, chanceToLearn: 50, maxSpellsPerLevel: 7 };
  if (int === 13) return { numLanguages: 3, spellLevel: 6, chanceToLearn: 55, maxSpellsPerLevel: 9 };
  if (int === 14) return { numLanguages: 4, spellLevel: 7, chanceToLearn: 60, maxSpellsPerLevel: 9 };
  if (int === 15) return { numLanguages: 4, spellLevel: 7, chanceToLearn: 65, maxSpellsPerLevel: 11 };
  if (int === 16) return { numLanguages: 5, spellLevel: 8, chanceToLearn: 70, maxSpellsPerLevel: 11 };
  if (int === 17) return { numLanguages: 6, spellLevel: 8, chanceToLearn: 75, maxSpellsPerLevel: 14 };
  if (int === 18) return { numLanguages: 7, spellLevel: 9, chanceToLearn: 85, maxSpellsPerLevel: 18 };
  return { numLanguages: 8, spellLevel: 9, chanceToLearn: 95, maxSpellsPerLevel: 22 }; // 19+
}

export function getWisdomSpellBonus(wis: number): Record<number, number> {
  // Returns bonus priest spells by spell level
  if (wis <= 12) return {};
  if (wis === 13) return { 1: 1 };
  if (wis === 14) return { 1: 2 };
  if (wis === 15) return { 1: 2, 2: 1 };
  if (wis === 16) return { 1: 2, 2: 2 };
  if (wis === 17) return { 1: 2, 2: 2, 3: 1 };
  if (wis === 18) return { 1: 2, 2: 2, 3: 1, 4: 1 };
  return { 1: 3, 2: 2, 3: 1, 4: 2 }; // 19+
}

export function getCharismaReactionAdj(cha: number): number {
  if (cha <= 1) return -7;
  if (cha <= 4) return -3 + (cha - 2);
  if (cha <= 7) return -1;
  if (cha <= 12) return 0;
  if (cha <= 14) return 1;
  if (cha === 15) return 3;
  if (cha === 16) return 5;
  if (cha === 17) return 6;
  if (cha === 18) return 7;
  return 8; // 19+
}

export function getCharismaMaxHenchmen(cha: number): number {
  if (cha <= 1) return 0;
  if (cha <= 4) return 1;
  if (cha <= 5) return 2;
  if (cha <= 7) return 3;
  if (cha <= 9) return 4;
  if (cha <= 11) return 5;
  if (cha <= 13) return 6;
  if (cha <= 15) return 7;
  if (cha <= 17) return 10;
  if (cha === 18) return 15;
  return 20;
}

// ─── Racial Restrictions ────────────────────────────────────────────────────

export type Race = 'human' | 'elf' | 'half-elf' | 'dwarf' | 'gnome' | 'halfling';
export type CharClass = 'fighter' | 'paladin' | 'ranger' | 'cleric' | 'druid' | 'thief' | 'bard' | 'mage';

export const RACE_CLASS_ALLOWED: Record<Race, CharClass[]> = {
  human:     ['fighter', 'paladin', 'ranger', 'cleric', 'druid', 'thief', 'bard', 'mage'],
  elf:       ['fighter', 'ranger', 'cleric', 'thief', 'mage'],
  'half-elf': ['fighter', 'ranger', 'cleric', 'druid', 'thief', 'bard', 'mage'],
  dwarf:     ['fighter', 'cleric', 'thief'],
  gnome:     ['fighter', 'cleric', 'thief', 'mage'],  // illusionist only for mage
  halfling:  ['fighter', 'cleric', 'thief'],
};

// Racial level limits (0 = unlimited, i.e. human)
export const RACE_LEVEL_LIMITS: Record<Race, Partial<Record<CharClass, number>>> = {
  human:     {}, // No limits
  elf:       { fighter: 7, ranger: 8, cleric: 12, thief: 12, mage: 12 },
  'half-elf': { fighter: 14, ranger: 16, cleric: 5, druid: 9, thief: 12, bard: 12, mage: 12 },
  dwarf:     { fighter: 15, cleric: 10, thief: 12 },
  gnome:     { fighter: 11, cleric: 9, thief: 13, mage: 12 },
  halfling:  { fighter: 9, cleric: 8, thief: 15 },
};

// Multi-class combinations (demi-humans only)
export const RACE_MULTICLASS: Record<Race, string[][]> = {
  human:     [], // Humans dual-class, not multi-class
  elf:       [['fighter', 'mage'], ['fighter', 'thief'], ['mage', 'thief'], ['fighter', 'mage', 'thief']],
  'half-elf': [['fighter', 'cleric'], ['fighter', 'thief'], ['fighter', 'mage'], ['cleric', 'mage'],
               ['cleric', 'thief'], ['thief', 'mage'], ['fighter', 'cleric', 'mage'], ['fighter', 'mage', 'thief']],
  dwarf:     [['fighter', 'cleric'], ['fighter', 'thief']],
  gnome:     [['fighter', 'cleric'], ['fighter', 'thief'], ['cleric', 'thief'], ['fighter', 'mage']],
  halfling:  [['fighter', 'thief']],
};

// Racial ability score adjustments
export const RACE_ABILITY_ADJ: Record<Race, Partial<Record<string, number>>> = {
  human:     {},
  elf:       { dex: 1, con: -1 },
  'half-elf': {},
  dwarf:     { con: 1, cha: -1 },
  gnome:     { int: 1, wis: -1 },
  halfling:  { dex: 1, str: -1 },
};

// Racial ability score minimums and maximums
export const RACE_ABILITY_LIMITS: Record<Race, Record<string, [number, number]>> = {
  human:     { str: [3, 18], dex: [3, 18], con: [3, 18], int: [3, 18], wis: [3, 18], cha: [3, 18] },
  elf:       { str: [3, 18], dex: [7, 19], con: [6, 17], int: [8, 18], wis: [3, 18], cha: [8, 18] },
  'half-elf': { str: [3, 18], dex: [6, 18], con: [6, 18], int: [4, 18], wis: [3, 18], cha: [3, 18] },
  dwarf:     { str: [8, 18], dex: [3, 17], con: [12, 19], int: [3, 18], wis: [3, 18], cha: [3, 17] },
  gnome:     { str: [6, 18], dex: [3, 18], con: [8, 18], int: [7, 19], wis: [3, 18], cha: [3, 18] },
  halfling:  { str: [6, 17], dex: [8, 19], con: [10, 18], int: [6, 18], wis: [3, 17], cha: [3, 18] },
};

// ─── Alignment ──────────────────────────────────────────────────────────────

export const ALIGNMENTS = [
  'Lawful Good', 'Neutral Good', 'Chaotic Good',
  'Lawful Neutral', 'True Neutral', 'Chaotic Neutral',
  'Lawful Evil', 'Neutral Evil', 'Chaotic Evil',
] as const;

export type Alignment = typeof ALIGNMENTS[number];

export const CLASS_ALIGNMENT_RESTRICTIONS: Record<CharClass, Alignment[]> = {
  fighter: [...ALIGNMENTS],
  paladin: ['Lawful Good'],
  ranger: ['Lawful Good', 'Neutral Good', 'Chaotic Good'],
  cleric: [...ALIGNMENTS],
  druid: ['True Neutral'],
  thief: [...ALIGNMENTS], // But generally non-lawful
  bard: ['True Neutral', 'Neutral Good', 'Neutral Evil', 'Lawful Neutral', 'Chaotic Neutral',
         'Chaotic Good', 'Chaotic Neutral', 'Chaotic Evil'], // Any neutral component
  mage: [...ALIGNMENTS],
};

// ─── Ability Score Requirements ─────────────────────────────────────────────

export const CLASS_ABILITY_REQS: Record<CharClass, Partial<Record<string, number>>> = {
  fighter:  { str: 9 },
  paladin:  { str: 12, con: 9, wis: 13, cha: 17 },
  ranger:   { str: 13, dex: 13, con: 14, wis: 14 },
  cleric:   { wis: 9 },
  druid:    { wis: 12, cha: 15 },
  thief:    { dex: 9 },
  bard:     { dex: 12, int: 13, cha: 15 },
  mage:     { int: 9 },
};

// ─── Starting Proficiency Slots ─────────────────────────────────────────────

export const STARTING_WEAPON_PROFS: Record<string, number> = {
  warrior: 4, priest: 2, rogue: 2, wizard: 1,
};

export const STARTING_NONWEAPON_PROFS: Record<string, number> = {
  warrior: 3, priest: 4, rogue: 3, wizard: 4,
};

export const WEAPON_PROF_RATE: Record<string, number> = {
  warrior: 3, priest: 4, rogue: 4, wizard: 6,
};

export const NONWEAPON_PROF_RATE: Record<string, number> = {
  warrior: 3, priest: 3, rogue: 3, wizard: 3,
};

// ─── Base Movement Rates ────────────────────────────────────────────────────

export const RACE_BASE_MOVEMENT: Record<Race, number> = {
  human: 12,
  elf: 12,
  'half-elf': 12,
  dwarf: 6,
  gnome: 6,
  halfling: 6,
};

// ─── Turn Undead Table ──────────────────────────────────────────────────────
// Value: number needed on d20, 'T' = auto-turn, 'D' = auto-destroy, null = cannot turn
// Undead types by power: Skeleton, Zombie, Ghoul, Shadow, Wight, Ghast, Wraith, Mummy, Spectre, Vampire, Ghost, Lich, Special

export const UNDEAD_TYPES = [
  'Skeleton', 'Zombie', 'Ghoul', 'Shadow', 'Wight', 'Ghast',
  'Wraith', 'Mummy', 'Spectre', 'Vampire', 'Ghost', 'Lich', 'Special'
] as const;

export type TurnResult = number | 'T' | 'D' | null;

export const TURN_UNDEAD_TABLE: Record<number, TurnResult[]> = {
  // Level: [Skeleton, Zombie, Ghoul, Shadow, Wight, Ghast, Wraith, Mummy, Spectre, Vampire, Ghost, Lich, Special]
  1:  [10, 13, 16, 19, 20, null, null, null, null, null, null, null, null],
  2:  [7, 10, 13, 16, 19, 20, null, null, null, null, null, null, null],
  3:  [4, 7, 10, 13, 16, 19, 20, null, null, null, null, null, null],
  4:  ['T', 4, 7, 10, 13, 16, 19, 20, null, null, null, null, null],
  5:  ['T', 'T', 4, 7, 10, 13, 16, 19, 20, null, null, null, null],
  6:  ['D', 'T', 'T', 4, 7, 10, 13, 16, 19, 20, null, null, null],
  7:  ['D', 'D', 'T', 'T', 4, 7, 10, 13, 16, 19, 20, null, null],
  8:  ['D', 'D', 'D', 'T', 'T', 4, 7, 10, 13, 16, 19, 20, null],
  9:  ['D', 'D', 'D', 'D', 'T', 'T', 4, 7, 10, 13, 16, 19, 20],
  10: ['D', 'D', 'D', 'D', 'D', 'T', 'T', 4, 7, 10, 13, 16, 19],
  11: ['D', 'D', 'D', 'D', 'D', 'D', 'T', 'T', 4, 7, 10, 13, 16],
  12: ['D', 'D', 'D', 'D', 'D', 'D', 'D', 'T', 'T', 4, 7, 10, 13],
  13: ['D', 'D', 'D', 'D', 'D', 'D', 'D', 'D', 'T', 'T', 4, 7, 10],
  14: ['D', 'D', 'D', 'D', 'D', 'D', 'D', 'D', 'D', 'T', 'T', 4, 7],
};

// ─── Morale ─────────────────────────────────────────────────────────────────

export const MORALE_CHECK_TRIGGERS = [
  'first_casualty',           // First ally killed
  'half_casualties',          // 50% of group killed
  'leader_killed',            // Leader slain
  'fighting_hopeless_odds',   // Clearly outmatched
  'ally_flees',               // Companion runs
  'surprised',                // Caught off guard
  'hit_by_magic',             // First time targeted by spell
] as const;

// ─── Treasure Types ─────────────────────────────────────────────────────────
// Classic 2e treasure types A through Z — simplified for generation

export interface TreasureType {
  copper?: [number, number, number];   // [numDice, dieType, multiplier] e.g. [1, 6, 1000]
  silver?: [number, number, number];
  electrum?: [number, number, number];
  gold?: [number, number, number];
  platinum?: [number, number, number];
  gems?: [number, number];             // [numDice, dieType] count
  jewellery?: [number, number];
  magicChance?: number;                // Percentage chance
  magicRolls?: number;                 // Number of rolls on magic table
}

export const TREASURE_TYPES: Record<string, TreasureType> = {
  A: { copper: [1, 6, 1000], silver: [1, 6, 1000], electrum: [1, 6, 1000], gold: [1, 10, 1000], platinum: [1, 4, 100], gems: [4, 10], jewellery: [3, 10], magicChance: 30, magicRolls: 3 },
  B: { copper: [1, 8, 1000], silver: [1, 6, 1000], electrum: [1, 4, 1000], gold: [1, 3, 1000], gems: [1, 8], jewellery: [1, 4], magicChance: 10, magicRolls: 1 },
  C: { copper: [1, 12, 1000], silver: [1, 6, 1000], electrum: [1, 4, 1000], gems: [1, 6], jewellery: [1, 3], magicChance: 10, magicRolls: 1 },
  D: { copper: [1, 8, 1000], silver: [1, 12, 1000], gold: [1, 6, 1000], gems: [1, 10], jewellery: [1, 6], magicChance: 15, magicRolls: 2 },
  E: { copper: [1, 10, 1000], silver: [1, 12, 1000], electrum: [1, 6, 1000], gold: [1, 8, 1000], gems: [1, 12], jewellery: [1, 8], magicChance: 25, magicRolls: 3 },
  F: { silver: [1, 20, 1000], electrum: [1, 12, 1000], gold: [1, 10, 1000], platinum: [1, 8, 100], gems: [2, 12], jewellery: [1, 12], magicChance: 30, magicRolls: 3 },
  // Individual treasure types
  J: { copper: [3, 8, 1] },
  K: { silver: [3, 6, 1] },
  L: { electrum: [2, 6, 1] },
  M: { gold: [2, 4, 1] },
  N: { platinum: [1, 6, 1] },
};

// ─── Weapon Data ────────────────────────────────────────────────────────────

export interface WeaponData {
  name: string;
  damage_sm: string;   // Damage vs Small/Medium
  damage_lg: string;   // Damage vs Large
  speed: number;       // Speed factor
  weight: number;      // Weight in lbs
  type: 'S' | 'P' | 'B' | 'SP' | 'SB' | 'PB' | 'SPB'; // Slashing, Piercing, Bludgeoning
  range?: [number, number, number]; // Short/Medium/Long (for missile)
  profGroup: string;
}

export const WEAPONS: Record<string, WeaponData> = {
  // Melee weapons
  battle_axe:     { name: 'Battle Axe', damage_sm: '1d8', damage_lg: '1d8', speed: 7, weight: 7, type: 'S', profGroup: 'warrior' },
  hand_axe:       { name: 'Hand Axe', damage_sm: '1d6', damage_lg: '1d4', speed: 4, weight: 5, type: 'S', range: [10, 20, 30], profGroup: 'warrior' },
  club:           { name: 'Club', damage_sm: '1d6', damage_lg: '1d3', speed: 4, weight: 3, type: 'B', profGroup: 'all' },
  dagger:         { name: 'Dagger', damage_sm: '1d4', damage_lg: '1d3', speed: 2, weight: 1, type: 'P', range: [10, 20, 30], profGroup: 'all' },
  flail:          { name: 'Flail', damage_sm: '1d6+1', damage_lg: '2d4', speed: 7, weight: 15, type: 'B', profGroup: 'warrior' },
  halberd:        { name: 'Halberd', damage_sm: '1d10', damage_lg: '2d6', speed: 9, weight: 15, type: 'SP', profGroup: 'warrior' },
  long_sword:     { name: 'Long Sword', damage_sm: '1d8', damage_lg: '1d12', speed: 5, weight: 4, type: 'S', profGroup: 'warrior' },
  short_sword:    { name: 'Short Sword', damage_sm: '1d6', damage_lg: '1d8', speed: 3, weight: 3, type: 'P', profGroup: 'all' },
  two_hand_sword: { name: 'Two-Handed Sword', damage_sm: '1d10', damage_lg: '3d6', speed: 10, weight: 15, type: 'S', profGroup: 'warrior' },
  mace:           { name: 'Mace', damage_sm: '1d6+1', damage_lg: '1d6', speed: 7, weight: 10, type: 'B', profGroup: 'priest' },
  morning_star:   { name: 'Morning Star', damage_sm: '2d4', damage_lg: '1d6+1', speed: 7, weight: 12, type: 'B', profGroup: 'warrior' },
  war_hammer:     { name: 'War Hammer', damage_sm: '1d4+1', damage_lg: '1d4', speed: 4, weight: 6, type: 'B', profGroup: 'priest' },
  quarterstaff:   { name: 'Quarterstaff', damage_sm: '1d6', damage_lg: '1d6', speed: 4, weight: 4, type: 'B', profGroup: 'all' },
  spear:          { name: 'Spear', damage_sm: '1d6', damage_lg: '1d8', speed: 6, weight: 5, type: 'P', range: [10, 20, 30], profGroup: 'all' },
  lance:          { name: 'Lance', damage_sm: '1d6', damage_lg: '1d8', speed: 8, weight: 10, type: 'P', profGroup: 'warrior' },
  scimitar:       { name: 'Scimitar', damage_sm: '1d8', damage_lg: '1d8', speed: 5, weight: 4, type: 'S', profGroup: 'warrior' },
  bastard_sword:  { name: 'Bastard Sword', damage_sm: '1d8', damage_lg: '1d12', speed: 6, weight: 10, type: 'S', profGroup: 'warrior' },
  trident:        { name: 'Trident', damage_sm: '1d6+1', damage_lg: '3d4', speed: 7, weight: 5, type: 'P', profGroup: 'warrior' },
  // Missile weapons
  long_bow:       { name: 'Long Bow', damage_sm: '1d6', damage_lg: '1d6', speed: 8, weight: 3, type: 'P', range: [70, 140, 210], profGroup: 'warrior' },
  short_bow:      { name: 'Short Bow', damage_sm: '1d6', damage_lg: '1d6', speed: 7, weight: 2, type: 'P', range: [50, 100, 150], profGroup: 'warrior' },
  light_crossbow: { name: 'Light Crossbow', damage_sm: '1d4', damage_lg: '1d4', speed: 7, weight: 7, type: 'P', range: [60, 120, 180], profGroup: 'all' },
  heavy_crossbow: { name: 'Heavy Crossbow', damage_sm: '1d4+1', damage_lg: '1d6+1', speed: 10, weight: 14, type: 'P', range: [80, 160, 240], profGroup: 'warrior' },
  sling:          { name: 'Sling', damage_sm: '1d4', damage_lg: '1d4', speed: 6, weight: 0, type: 'B', range: [40, 80, 160], profGroup: 'all' },
  dart:           { name: 'Dart', damage_sm: '1d3', damage_lg: '1d2', speed: 2, weight: 0.5, type: 'P', range: [10, 20, 40], profGroup: 'all' },
};

// ─── Armour Data ────────────────────────────────────────────────────────────

export interface ArmourData {
  name: string;
  ac: number;
  weight: number;
  bulkiness: string; // 'non', 'fairly', 'bulky'
}

export const ARMOUR: Record<string, ArmourData> = {
  none:           { name: 'No Armour', ac: 10, weight: 0, bulkiness: 'non' },
  leather:        { name: 'Leather', ac: 8, weight: 15, bulkiness: 'non' },
  studded:        { name: 'Studded Leather', ac: 7, weight: 25, bulkiness: 'non' },
  ring_mail:      { name: 'Ring Mail', ac: 7, weight: 25, bulkiness: 'fairly' },
  scale_mail:     { name: 'Scale Mail', ac: 6, weight: 40, bulkiness: 'fairly' },
  chain_mail:     { name: 'Chain Mail', ac: 5, weight: 40, bulkiness: 'fairly' },
  splint_mail:    { name: 'Splint Mail', ac: 4, weight: 40, bulkiness: 'bulky' },
  banded_mail:    { name: 'Banded Mail', ac: 4, weight: 35, bulkiness: 'bulky' },
  plate_mail:     { name: 'Plate Mail', ac: 3, weight: 45, bulkiness: 'bulky' },
  field_plate:    { name: 'Field Plate', ac: 2, weight: 60, bulkiness: 'bulky' },
  full_plate:     { name: 'Full Plate', ac: 1, weight: 70, bulkiness: 'bulky' },
  shield:         { name: 'Shield', ac: -1, weight: 10, bulkiness: 'non' }, // AC bonus (subtractive)
};

// ─── Priest Spell Slots by Level ────────────────────────────────────────────
// Index 0 = unused, index 1 = spell level 1, etc.

export const PRIEST_SPELL_SLOTS: Record<number, number[]> = {
  // clericLevel: [0, 1st, 2nd, 3rd, 4th, 5th, 6th, 7th]
  1:  [0, 1],
  2:  [0, 2],
  3:  [0, 2, 1],
  4:  [0, 3, 2],
  5:  [0, 3, 3, 1],
  6:  [0, 3, 3, 2],
  7:  [0, 3, 3, 2, 1],
  8:  [0, 3, 3, 3, 2],
  9:  [0, 4, 4, 3, 2, 1],
  10: [0, 4, 4, 3, 3, 2],
  11: [0, 5, 4, 4, 3, 2, 1],
  12: [0, 6, 5, 5, 3, 2, 2],
  13: [0, 6, 6, 6, 4, 2, 2],
  14: [0, 6, 6, 6, 5, 3, 2],
  15: [0, 6, 6, 6, 6, 3, 2, 1],
  16: [0, 7, 7, 7, 6, 4, 2, 1],
  17: [0, 7, 7, 7, 7, 5, 3, 1],
  18: [0, 8, 8, 8, 8, 6, 4, 1],
  19: [0, 9, 9, 8, 8, 6, 4, 2],
  20: [0, 9, 9, 9, 9, 7, 5, 2],
};

// ─── Wizard Spell Slots by Level ────────────────────────────────────────────

export const WIZARD_SPELL_SLOTS: Record<number, number[]> = {
  // mageLevel: [0, 1st, 2nd, 3rd, 4th, 5th, 6th, 7th, 8th, 9th]
  1:  [0, 1],
  2:  [0, 2],
  3:  [0, 2, 1],
  4:  [0, 3, 2],
  5:  [0, 4, 2, 1],
  6:  [0, 4, 2, 2],
  7:  [0, 4, 3, 2, 1],
  8:  [0, 4, 3, 3, 2],
  9:  [0, 4, 3, 3, 2, 1],
  10: [0, 4, 4, 3, 2, 2],
  11: [0, 4, 4, 4, 3, 3],
  12: [0, 4, 4, 4, 4, 4, 1],
  13: [0, 5, 5, 5, 4, 4, 2],
  14: [0, 5, 5, 5, 4, 4, 2, 1],
  15: [0, 5, 5, 5, 5, 5, 2, 1],
  16: [0, 5, 5, 5, 5, 5, 3, 2, 1],
  17: [0, 5, 5, 5, 5, 5, 3, 3, 2],
  18: [0, 5, 5, 5, 5, 5, 3, 3, 2, 1],
  19: [0, 5, 5, 5, 5, 5, 3, 3, 3, 1],
  20: [0, 5, 5, 5, 5, 5, 4, 3, 3, 2],
};

// ─── Thief Skills ───────────────────────────────────────────────────────────
// Base percentages by level

export const THIEF_SKILLS_BASE: Record<string, number[]> = {
  // Index = level (1-20). Values are base percentages.
  pick_pockets:   [0, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 99, 99, 99],
  open_locks:     [0, 10, 15, 20, 25, 29, 33, 37, 42, 47, 52, 57, 62, 67, 72, 77, 82, 87, 92, 97, 99],
  find_traps:     [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 99],
  move_silently:  [0, 10, 15, 20, 25, 31, 37, 43, 49, 55, 62, 69, 76, 83, 90, 95, 99, 99, 99, 99, 99],
  hide_shadows:   [0, 5, 10, 15, 20, 25, 31, 37, 43, 49, 56, 63, 70, 77, 84, 91, 98, 99, 99, 99, 99],
  detect_noise:   [0, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 99, 99, 99],
  climb_walls:    [0, 60, 63, 66, 69, 72, 75, 78, 81, 84, 87, 90, 92, 94, 96, 98, 99, 99, 99, 99, 99],
  read_languages: [0, 0, 0, 0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85],
};

// ─── Reaction Roll Table (2d6) ──────────────────────────────────────────────

export function getReactionResult(roll: number): string {
  if (roll <= 2) return 'hostile';
  if (roll <= 5) return 'unfriendly';
  if (roll <= 8) return 'indifferent';
  if (roll <= 11) return 'friendly';
  return 'enthusiastic';
}

// ─── Encumbrance Categories ─────────────────────────────────────────────────

export interface EncumbranceCategory {
  name: string;
  maxWeight: number;
  movementRate: number;
}

export function getEncumbrance(str: number, currentWeight: number): EncumbranceCategory {
  const mods = getStrengthMods(str);
  const allowance = mods.weightAllow;

  if (currentWeight <= allowance * 0.33) return { name: 'Unencumbered', maxWeight: allowance * 0.33, movementRate: 12 };
  if (currentWeight <= allowance * 0.67) return { name: 'Light', maxWeight: allowance * 0.67, movementRate: 9 };
  if (currentWeight <= allowance) return { name: 'Moderate', maxWeight: allowance, movementRate: 6 };
  if (currentWeight <= allowance * 1.5) return { name: 'Heavy', maxWeight: allowance * 1.5, movementRate: 3 };
  return { name: 'Severe', maxWeight: allowance * 2, movementRate: 1 };
}
