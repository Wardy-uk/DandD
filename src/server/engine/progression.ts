/**
 * Progression Engine — XP, levelling, injuries, milestones
 * AD&D 2nd Edition rules, capped at level 10
 */

import { v4 as uuid } from 'uuid';
import type { Database } from 'sql.js';
import { get, all, run } from '../db/helpers.js';
import {
  CLASS_THAC0_GROUP,
  PRIEST_SPELL_SLOTS, WIZARD_SPELL_SLOTS, THIEF_SKILLS_BASE,
} from './tables.js';
import type { CharClass } from './tables.js';
import { rollLevelUpHP, getXpForLevel, getPriestSpellSlots, getWizardSpellSlots, getThiefSkills } from './character.js';
import { getThac0, getSavingThrows } from './combat.js';

// ─── Injury System ─────────────────────────────────────────────────────────

export const INJURY_TABLE = [
  {
    id: 'sprained_ankle',
    name: 'Sprained Ankle',
    description: 'Movement halved until treated. Running is out of the question.',
    mechanical: 'movement_half',
  },
  {
    id: 'deep_cut',
    name: 'Deep Cut',
    description: 'Bleeds on exertion — 1 HP per round of combat until bandaged.',
    mechanical: 'bleed_on_exertion',
  },
  {
    id: 'bruised_ribs',
    name: 'Bruised Ribs',
    description: 'Carry capacity halved. Encumbrance penalties double.',
    mechanical: 'carry_half',
  },
  {
    id: 'head_blow',
    name: 'Head Blow',
    description: 'WIS checks and perception penalised by 2 until rested.',
    mechanical: 'perception_penalty',
  },
  {
    id: 'sword_arm_wound',
    name: 'Sword Arm Wound',
    description: 'Attack rolls penalised by 2 until properly treated at camp.',
    mechanical: 'attack_penalty',
  },
] as const;

export type InjuryId = typeof INJURY_TABLE[number]['id'];

export interface CharacterInjury {
  id: string;
  name: string;
  description: string;
  mechanical: string;
  treated: boolean;
  worsened: boolean;
  acquiredAt: string;
}

export function rollInjury(): CharacterInjury {
  const type = INJURY_TABLE[Math.floor(Math.random() * INJURY_TABLE.length)];
  return {
    id: type.id,
    name: type.name,
    description: type.description,
    mechanical: type.mechanical,
    treated: false,
    worsened: false,
    acquiredAt: new Date().toISOString(),
  };
}

export function getCharacterInjuries(char: any): CharacterInjury[] {
  try {
    const raw = char?.injuries;
    if (!raw) return [];
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function addInjuryToCharacter(db: Database, characterId: string, injury: CharacterInjury): void {
  const char = get(db, 'SELECT injuries FROM characters WHERE id = ?', [characterId]) as any;
  const injuries = getCharacterInjuries(char);
  if (!injuries.find((i) => i.id === injury.id)) {
    injuries.push(injury);
  }
  run(db, 'UPDATE characters SET injuries = ? WHERE id = ?', [JSON.stringify(injuries), characterId]);
}

export function treatAllInjuries(db: Database, characterId: string): number {
  const char = get(db, 'SELECT injuries FROM characters WHERE id = ?', [characterId]) as any;
  const injuries = getCharacterInjuries(char);
  const untreated = injuries.filter((i) => !i.treated);
  for (const injury of injuries) injury.treated = true;
  if (untreated.length > 0) {
    run(db, 'UPDATE characters SET injuries = ? WHERE id = ?', [JSON.stringify(injuries), characterId]);
  }
  return untreated.length;
}

export function worsenUntreatedInjuries(db: Database, characterId: string): CharacterInjury[] {
  const char = get(db, 'SELECT injuries FROM characters WHERE id = ?', [characterId]) as any;
  const injuries = getCharacterInjuries(char);
  const worsened: CharacterInjury[] = [];
  for (const injury of injuries) {
    if (!injury.treated && !injury.worsened) {
      injury.worsened = true;
      worsened.push(injury);
    }
  }
  if (worsened.length > 0) {
    run(db, 'UPDATE characters SET injuries = ? WHERE id = ?', [JSON.stringify(injuries), characterId]);
  }
  return worsened;
}

export function describeInjury(injury: CharacterInjury): string {
  const worn = injury.worsened ? ' [Worsened]' : '';
  const healed = injury.treated ? ' [Treated]' : '';
  return `${injury.name}${worn}${healed}: ${injury.description}`;
}

export function getAttackPenaltyFromInjuries(injuries: CharacterInjury[]): number {
  return injuries.filter((i) => i.id === 'sword_arm_wound' && !i.treated).length * 2;
}

// ─── XP System ─────────────────────────────────────────────────────────────

export type XpSource = 'kill' | 'exploration' | 'treasure' | 'near_death' | 'quest_beat' | 'survived_odds';

export interface LevelUpResult {
  levelled: boolean;
  newLevel?: number;
  narration?: string;
  hpGain?: number;
  classAnnouncement?: string;
}

export function awardXp(
  db: Database,
  characterId: string,
  amount: number,
  source: XpSource,
  campaignId?: string,
): LevelUpResult {
  if (amount <= 0) return { levelled: false };

  const char = get(db, 'SELECT * FROM characters WHERE id = ?', [characterId]) as any;
  if (!char) return { levelled: false };
  if (String(char.status) === 'dead') return { levelled: false };

  const newXp = (Number(char.xp) || 0) + amount;
  run(db, 'UPDATE characters SET xp = ? WHERE id = ?', [newXp, characterId]);

  if (campaignId) {
    run(db,
      'INSERT INTO game_log (id, campaign_id, type, actor, content) VALUES (?, ?, ?, ?, ?)',
      [uuid(), campaignId, 'system', 'DM',
        `${char.name} earns ${amount} XP (${source.replace(/_/g, ' ')}).`]);
  }

  if (Number(char.level) >= 10) return { levelled: false };

  return checkAndApplyLevelUp(db, characterId, char, newXp, campaignId);
}

export function checkAndApplyLevelUp(
  db: Database,
  characterId: string,
  char: any,
  currentXp: number,
  campaignId?: string,
): LevelUpResult {
  const charClass = char.char_class as CharClass;
  const currentLevel = Number(char.level);
  if (currentLevel >= 10) return { levelled: false };

  const xpForNext = getXpForLevel(charClass, currentLevel + 1);
  if (currentXp < xpForNext) return { levelled: false };

  const newLevel = currentLevel + 1;

  // HP increase
  const hpGain = rollLevelUpHP(charClass, newLevel, Number(char.con));
  const newMaxHp = Number(char.max_hp) + hpGain;

  // THAC0
  const newThac0 = getThac0(charClass, newLevel);

  // Saving throws
  const newSaves = getSavingThrows(charClass, newLevel);

  // Proficiency slots
  const { weapon: newWeaponSlots, nonweapon: newNwSlots } = calcProfSlotsAtLevel(charClass, newLevel);

  // XP for next level
  const xpNext = newLevel < 10 ? getXpForLevel(charClass, newLevel + 1) : getXpForLevel(charClass, newLevel);

  // Class-specific advances
  const classAdvance = getClassAdvance(charClass, newLevel, char);

  // Build update SQL
  let sql = `
    UPDATE characters SET
      level = ?, max_hp = ?, hp = MIN(hp + ?, max_hp + ?),
      thac0 = ?,
      save_paralysis = ?, save_rod = ?, save_petrify = ?, save_breath = ?, save_spell = ?,
      weapon_prof_slots = ?, nonweapon_prof_slots = ?,
      xp_next = ?
  `;
  const params: any[] = [
    newLevel, newMaxHp, hpGain, hpGain,
    newThac0,
    newSaves.paralysis, newSaves.rod, newSaves.petrify, newSaves.breath, newSaves.spell,
    newWeaponSlots, newNwSlots,
    xpNext,
  ];

  if (classAdvance.sqlExtra) {
    sql += `, ${classAdvance.sqlExtra}`;
    params.push(...(classAdvance.sqlParams || []));
  }

  sql += ' WHERE id = ?';
  params.push(characterId);

  run(db, sql, params);

  const narration = buildLevelUpNarration(char.name, charClass, newLevel, hpGain, classAdvance.announcement);

  if (campaignId) {
    run(db,
      'INSERT INTO game_log (id, campaign_id, type, actor, content) VALUES (?, ?, ?, ?, ?)',
      [uuid(), campaignId, 'level_up', char.name, narration]);
  }

  return {
    levelled: true,
    newLevel,
    narration,
    hpGain,
    classAnnouncement: classAdvance.announcement,
  };
}

function buildLevelUpNarration(name: string, charClass: string, newLevel: number, hpGain: number, classLine: string): string {
  const parts = [
    `Something shifts in ${name} — the dungeon has carved its lessons into bone and reflex.`,
    `Level ${newLevel} ${charClass}.`,
    hpGain > 0 ? `${hpGain} hit point${hpGain === 1 ? '' : 's'} harder to kill.` : null,
    classLine,
    `"You feel something shift. You're not the same person who walked in."`,
  ].filter(Boolean);
  return parts.join(' ');
}

interface ClassAdvance {
  announcement: string;
  sqlExtra?: string;
  sqlParams?: any[];
}

function getClassAdvance(charClass: string, newLevel: number, char: any): ClassAdvance {
  switch (charClass) {
    case 'fighter':
      return {
        announcement: newLevel >= 7
          ? 'Three swings every two rounds now. The fighter is a weapon of war.'
          : 'THAC0 and saves tighten. Endurance and skill accumulate.',
      };
    case 'ranger':
      return {
        announcement: newLevel >= 7
          ? 'The ranger moves with a predator\'s economy, pressing three attacks for every two rounds.'
          : 'The ranger\'s senses and instincts sharpen. Fewer enemies will catch them unready.',
      };
    case 'paladin':
      return {
        announcement: newLevel >= 3
          ? `Lay on hands grows stronger. ${newLevel >= 9 ? 'The paladin can now attempt to resurrect the fallen.' : 'Protection from evil flows outward now.'}`
          : 'Divine grace runs deeper. The paladin is harder to break.',
      };
    case 'cleric': {
      try {
        const slots = getPriestSpellSlots(newLevel, Number(char.wis));
        return {
          announcement: 'The cleric\'s prayers reach higher circles. New realms of divine power open.',
          sqlExtra: 'spell_slots = ?',
          sqlParams: [JSON.stringify(slots)],
        };
      } catch {
        return { announcement: 'Divine power deepens.' };
      }
    }
    case 'druid': {
      try {
        const slots = getPriestSpellSlots(newLevel, Number(char.wis));
        return {
          announcement: 'The druid\'s bond with the wild grows. The natural world answers differently now.',
          sqlExtra: 'spell_slots = ?',
          sqlParams: [JSON.stringify(slots)],
        };
      } catch {
        return { announcement: 'The druid\'s connection to the natural order deepens.' };
      }
    }
    case 'mage': {
      try {
        const slots = getWizardSpellSlots(newLevel);
        return {
          announcement: 'The mage\'s arcane capacity expands. Higher spells can now be inscribed and cast.',
          sqlExtra: 'spell_slots = ?',
          sqlParams: [JSON.stringify(slots)],
        };
      } catch {
        return { announcement: 'Arcane potential expands.' };
      }
    }
    case 'thief': {
      try {
        const skills = getThiefSkills(newLevel);
        return {
          announcement: 'The thief\'s fingers are faster, their footsteps quieter, their eye sharper for opportunity.',
          sqlExtra: 'thief_skills = ?',
          sqlParams: [JSON.stringify(skills)],
        };
      } catch {
        return { announcement: 'Roguish talents deepen.' };
      }
    }
    case 'bard': {
      try {
        const skills = getThiefSkills(newLevel);
        return {
          announcement: 'The bard\'s lore deepens and their cunning improves. They know more than they let on.',
          sqlExtra: 'thief_skills = ?',
          sqlParams: [JSON.stringify(skills)],
        };
      } catch {
        return { announcement: 'The bard\'s repertoire and cunning both deepen.' };
      }
    }
    default:
      return { announcement: 'Experience hardens into power.' };
  }
}

function calcProfSlotsAtLevel(charClass: string, level: number): { weapon: number; nonweapon: number } {
  const group = CLASS_THAC0_GROUP[charClass] || 'warrior';
  const startW: Record<string, number> = { warrior: 4, priest: 2, rogue: 3, wizard: 1 };
  const startNW: Record<string, number> = { warrior: 3, priest: 4, rogue: 3, wizard: 4 };
  const rateW: Record<string, number> = { warrior: 3, priest: 4, rogue: 4, wizard: 6 };
  const rateNW: Record<string, number> = { warrior: 3, priest: 3, rogue: 4, wizard: 3 };
  return {
    weapon: (startW[group] || 2) + Math.floor((level - 1) / (rateW[group] || 4)),
    nonweapon: (startNW[group] || 3) + Math.floor((level - 1) / (rateNW[group] || 3)),
  };
}

// ─── Exploration XP ────────────────────────────────────────────────────────

/**
 * Award 100 XP to all active party members for entering a previously unvisited scene.
 * Returns level-up results if any character levelled.
 */
export function awardExplorationXp(
  db: Database,
  campaignId: string,
): LevelUpResult[] {
  const chars = all(db,
    'SELECT * FROM characters WHERE campaign_id = ? AND status IN ("active", "dying")',
    [campaignId]) as any[];

  const results: LevelUpResult[] = [];
  for (const char of chars) {
    const result = awardXp(db, char.id, 100, 'exploration', campaignId);
    if (result.levelled) results.push(result);
  }
  return results;
}

// ─── Treasure XP ──────────────────────────────────────────────────────────

/** 1 GP recovered = 1 XP, classic AD&D. */
export function awardTreasureXp(
  db: Database,
  characterId: string,
  gpValue: number,
  campaignId?: string,
): LevelUpResult {
  const xp = Math.floor(gpValue);
  if (xp <= 0) return { levelled: false };
  return awardXp(db, characterId, xp, 'treasure', campaignId);
}

// ─── Near-Death XP ────────────────────────────────────────────────────────

/**
 * Award 50 bonus XP when a character survives dropping to ≤10% of max HP.
 * Should only trigger once per encounter (callers track this).
 */
export function awardNearDeathXp(
  db: Database,
  characterId: string,
  campaignId?: string,
): LevelUpResult {
  return awardXp(db, characterId, 50, 'near_death', campaignId);
}
