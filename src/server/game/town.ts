/**
 * town.ts — Town Phase Engine
 *
 * Deterministic (no AI) town services:
 *   - Sell loot and treasure for GP + XP
 *   - Buy supplies at market rates
 *   - Heal injuries at the temple
 *   - Resurrect fallen companions (risky, expensive)
 *   - Hire companion prospects at the tavern
 *   - Surface rumours (barkeep voice)
 *   - Pick up garrison contracts
 *   - Companion downtime processing
 *   - Return-to-town / departure transitions
 */

import { v4 as uuid } from 'uuid';
import type { Database } from 'sql.js';
import { get, all, run } from '../db/helpers.js';
import { roll, d6, roll2d6 } from '../engine/dice.js';
import {
  getCampaignState,
  saveCampaignState,
  noteCampaignEvent,
  shiftFactionStanding,
  type CampaignSimulationState,
} from './campaignState.js';
import { surfaceRumours, popDawnSummary } from './nightlyGrowth.js';
import { getPartyCompanions, normalizeRelationshipState } from './companions.js';
import { getStarterProspects } from './starterPacks.js';

// ─── Town Name Generator ────────────────────────────────────────────────────

const TOWN_NAME_PREFIXES = [
  'Ash', 'Black', 'Bram', 'Cairn', 'Cinder', 'Copper', 'Crow', 'Dark', 'Dusk',
  'Elder', 'Fallow', 'Fell', 'Forge', 'Grim', 'Gravel', 'Grey', 'Groan', 'Hollow',
  'Iron', 'Mill', 'Mire', 'Moss', 'Mud', 'Old', 'Raven', 'Red', 'Rook',
  'Salt', 'Shadow', 'Silver', 'Smoke', 'Stone', 'Thorn', 'Tumble', 'Wander',
];
const TOWN_NAME_SUFFIXES = [
  'borough', 'bridge', 'bury', 'cross', 'dale', 'fall', 'ford', 'gate', 'haven',
  'holm', 'keep', 'landing', 'moor', 'port', 'reach', 'ridge', 'rock', 'run',
  'shade', 'shore', 'side', 'stand', 'stead', 'vale', 'watch', 'well', 'wick',
];

export function generateTownName(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0;
  const prefix = TOWN_NAME_PREFIXES[Math.abs(h) % TOWN_NAME_PREFIXES.length];
  const suffix = TOWN_NAME_SUFFIXES[Math.abs(h >> 4) % TOWN_NAME_SUFFIXES.length];
  return prefix + suffix;
}

// ─── Town descriptions (arrival) ────────────────────────────────────────────

const TOWN_ARRIVAL_LINES = [
  (name: string) => `The silhouette of ${name} rises out of the murk — torchlight in the tavern window, smoke from the smithy, the distant bark of a dog. You made it.`,
  (name: string) => `${name} is quieter than you expected at this hour. The streets are half-mud, the inn sign is faded, and the smell of the dungeon is still on your clothes. Nobody seems to notice.`,
  (name: string) => `The gate-warden at ${name} barely looks up as you pass. She's seen your kind before — loaded down, limping slightly, eyes still adjusting to the light.`,
  (name: string) => `${name} announces itself with noise before you see it — a market in wind-down, an argument somewhere over money, a drunk singing badly near the well. Civilization. After a fashion.`,
  (name: string) => `You come down the road into ${name} as the light fails. The town smells of bread and horse and woodsmoke and it is very nearly enough to make the whole thing feel worth it.`,
];

export function describeArrival(townName: string, seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (Math.imul(17, h) + seed.charCodeAt(i)) | 0;
  const fn = TOWN_ARRIVAL_LINES[Math.abs(h) % TOWN_ARRIVAL_LINES.length];
  return fn(townName);
}

// ─── Loot identification & pricing ──────────────────────────────────────────

const NON_SELLABLE = new Set([
  'torch', 'torches', 'ration', 'rations', 'food', 'water',
  'rope', 'bandage', 'bandages', 'oil', 'tinderbox', 'arrow', 'arrows',
  'bolt', 'bolts', 'lockpick', 'lockpicks', 'chalk', 'spike', 'spikes',
  'lantern', 'candle', 'candles', 'waterskin',
]);

const SALVAGE_KEYWORDS: Array<{ pattern: RegExp; gp: number; label: string }> = [
  { pattern: /gem|jewel|ruby|sapphire|emerald|diamond|opal|pearl/i,      gp: 75,  label: 'precious gems' },
  { pattern: /art|painting|tapestry|statuette|idol|icon/i,               gp: 80,  label: 'artwork' },
  { pattern: /chalice|goblet|urn|vase|reliquary/i,                       gp: 60,  label: 'valuables' },
  { pattern: /crown|sceptre|orb|regalia/i,                               gp: 200, label: 'regalia' },
  { pattern: /necklace|bracelet|ring|amulet|pendant|brooch/i,            gp: 50,  label: 'jewellery' },
  { pattern: /spellbook|grimoire|tome/i,                                 gp: 100, label: 'arcane texts' },
  { pattern: /scroll/i,                                                  gp: 25,  label: 'scrolls' },
  { pattern: /potion/i,                                                  gp: 30,  label: 'potions' },
  { pattern: /silver/i,                                                  gp: 5,   label: 'silverware' },
  { pattern: /gold coin|gp|gold piece/i,                                 gp: 1,   label: 'coin' },
  { pattern: /platinum/i,                                                gp: 5,   label: 'platinum coin' },
  { pattern: /sword|blade|axe|hammer|mace|flail|spear|halberd/i,        gp: 8,   label: 'arms' },
  { pattern: /bow|crossbow/i,                                            gp: 15,  label: 'ranged weapon' },
  { pattern: /armour|armor|mail|plate|shield/i,                          gp: 20,  label: 'armour' },
  { pattern: /hide|pelt|fur|scales/i,                                    gp: 6,   label: 'pelts' },
  { pattern: /fang|claw|horn|tusk|tooth/i,                               gp: 3,   label: 'trophies' },
  { pattern: /bone|skull/i,                                              gp: 1,   label: 'bones' },
];

function estimateSellValue(itemName: string, quantity: number, fenceBonus: number): number {
  const lower = itemName.toLowerCase();
  if (NON_SELLABLE.has(lower.replace(/s$/, ''))) return 0;

  for (const entry of SALVAGE_KEYWORDS) {
    if (entry.pattern.test(lower)) {
      const base = entry.gp * quantity;
      return Math.floor(base * (1 + fenceBonus));
    }
  }
  // Unknown item — salvage at 1 GP each (weight-based)
  return Math.floor(1 * quantity * (1 + fenceBonus));
}

export function appraiseLoot(db: Database, campaignId: string, characterId: string): {
  items: Array<{ item: string; quantity: number; gpValue: number; label: string }>;
  totalGp: number;
} {
  const char = get(db, 'SELECT inventory FROM characters WHERE id = ?', [characterId]) as any;
  if (!char) return { items: [], totalGp: 0 };

  const inventory = JSON.parse(char.inventory || '[]') as Array<{ item: string; quantity: number; equipped?: boolean }>;
  const state = getCampaignState(db, campaignId);
  const shadowRep = (state.factions['shadows']?.reputation || 0);
  const fenceBonus = shadowRep >= 3 ? 0.1 : 0;

  const items: Array<{ item: string; quantity: number; gpValue: number; label: string }> = [];
  let totalGp = 0;

  for (const entry of inventory) {
    if (entry.equipped) continue;
    const lower = String(entry.item || '').toLowerCase();
    if (NON_SELLABLE.has(lower) || NON_SELLABLE.has(lower.replace(/s$/, ''))) continue;

    const gpValue = estimateSellValue(entry.item, entry.quantity || 1, fenceBonus);
    if (gpValue > 0) {
      const labelEntry = SALVAGE_KEYWORDS.find(e => e.pattern.test(lower));
      items.push({ item: entry.item, quantity: entry.quantity || 1, gpValue, label: labelEntry?.label || 'salvage' });
      totalGp += gpValue;
    }
  }

  return { items, totalGp };
}

// ─── Supply pricing ──────────────────────────────────────────────────────────

export const SUPPLY_CATALOGUE: Array<{ item: string; gp: number; description: string }> = [
  { item: 'Torch',       gp: 0.01,  description: 'Six hours of torchlight. You always need more.' },
  { item: 'Ration',      gp: 0.5,   description: 'One day of travel food. Hard bread, dried meat, nothing fancy.' },
  { item: 'Bandage',     gp: 0.25,  description: 'Cloth strips for field wounds. Better than nothing.' },
  { item: 'Rope (50ft)', gp: 1.0,   description: 'Hemp rope. Fifty feet of it. Indispensable.' },
  { item: 'Oil',         gp: 0.1,   description: 'Flask of lamp oil. Burns slow and bright.' },
  { item: 'Arrow',       gp: 0.05,  description: 'Standard war arrow. Buy twenty at minimum.' },
  { item: 'Lockpick',    gp: 5.0,   description: 'A single quality pick. Thieves charge accordingly.' },
  { item: 'Chalk',       gp: 0.01,  description: 'Mark your path. Underrated.' },
  { item: 'Spike',       gp: 0.02,  description: 'Iron piton. Wedge doors open or shut.' },
  { item: 'Tinderbox',   gp: 0.1,   description: 'Flint, steel, and tinder. Required for torches.' },
];

function supplyPrice(baseGp: number, localsRep: number): number {
  let price = baseGp;
  if (localsRep >= 3) price *= 0.9;
  else if (localsRep <= -3) price *= 1.1;
  return Math.round(price * 100) / 100;
}

export function getCatalogue(db: Database, campaignId: string) {
  const state = getCampaignState(db, campaignId);
  const localsRep = state.factions['locals']?.reputation || 0;
  return SUPPLY_CATALOGUE.map(s => ({ ...s, gp: supplyPrice(s.gp, localsRep) }));
}

// ─── Injury system ───────────────────────────────────────────────────────────

const INJURY_COSTS: Record<string, number> = {
  'minor wound': 10,
  'wounded': 15,
  'serious wound': 25,
  'deep wound': 30,
  'critical wound': 50,
  'broken bone': 40,
  'blinded': 60,
  'crippled': 75,
};

function healingCost(condition: string): number {
  const lower = condition.toLowerCase();
  for (const [key, cost] of Object.entries(INJURY_COSTS)) {
    if (lower.includes(key)) return cost;
  }
  if (/wound|injur|hurt|damaged/i.test(lower)) return 20;
  return 0;
}

export function getHealingQuote(db: Database, characterId: string): {
  injuries: Array<{ condition: string; cost: number }>;
  totalCost: number;
} {
  const char = get(db, 'SELECT conditions FROM characters WHERE id = ?', [characterId]) as any;
  if (!char) return { injuries: [], totalCost: 0 };

  const conditions = JSON.parse(char.conditions || '[]') as string[];
  const injuries = conditions
    .filter(c => healingCost(c) > 0)
    .map(c => ({ condition: c, cost: healingCost(c) }));

  return { injuries, totalCost: injuries.reduce((n, i) => n + i.cost, 0) };
}

// ─── Garrison contracts ──────────────────────────────────────────────────────

const CONTRACT_TEMPLATES: Array<{
  title: (faction: string) => string;
  description: string;
  reward: number;
  factionKey: string;
  objectiveType: NonNullable<TownContract['objectiveType']>;
  objectiveTarget: number;
  objectiveLabel: string;
}> = [
  {
    title: (f) => `Clear the ${['south passage', 'old shrine', 'collapsed hall', 'flooded level'][Math.abs(f.charCodeAt(0)) % 4]}`,
    description: 'The garrison wants proof of clearance. Kill or drive out whatever is using the space.',
    reward: 75,
    factionKey: 'watch',
    objectiveType: 'cleared_scenes',
    objectiveTarget: 1,
    objectiveLabel: 'cleared scenes',
  },
  {
    title: () => 'Locate the missing surveyor',
    description: 'A guild surveyor went in three days ago and has not come back. Return with news — living or dead.',
    reward: 100,
    factionKey: 'locals',
    objectiveType: 'discovered_sites',
    objectiveTarget: 3,
    objectiveLabel: 'sites discovered',
  },
  {
    title: () => 'Recover the manifold seal',
    description: 'An item of significance to people with money. Described as a flat disc of inscribed bronze.',
    reward: 150,
    factionKey: 'shadows',
    objectiveType: 'treasure_marks',
    objectiveTarget: 2,
    objectiveLabel: 'treasure leads secured',
  },
  {
    title: () => 'Map the third level approaches',
    description: 'The delvers\' guild wants reliable maps of approaches to the deeper levels. Return with sketches.',
    reward: 60,
    factionKey: 'delvers',
    objectiveType: 'fallback_points',
    objectiveTarget: 1,
    objectiveLabel: 'fallback routes marked',
  },
  {
    title: () => 'Eliminate the bounty hunter',
    description: 'Someone has posted a contract on the party. Deal with the contractor before they deal with you.',
    reward: 200,
    factionKey: 'shadows',
    objectiveType: 'revelations',
    objectiveTarget: 1,
    objectiveLabel: 'major revelations',
  },
];

export interface TownContract {
  id: string;
  title: string;
  description: string;
  reward: number;
  factionKey: string;
  taken: boolean;
  completedAt: string | null;
  claimedAt?: string | null;
  openingContract?: boolean;
  objectiveType?: 'discovered_sites' | 'cleared_scenes' | 'fallback_points' | 'treasure_marks' | 'lore_entries' | 'revelations';
  objectiveTarget?: number;
  objectiveLabel?: string;
  progress?: number;
  progressText?: string;
  readyToClaim?: boolean;
}

export function generateContracts(state: CampaignSimulationState, campaignName: string, settingId = ''): TownContract[] {
  let h = 0;
  const seedText = `${campaignName}:${settingId}`;
  for (let i = 0; i < seedText.length; i++) h = (Math.imul(37, h) + seedText.charCodeAt(i)) | 0;

  const count = 2 + (Math.abs(h) % 2); // 2-3 contracts
  const selected: TownContract[] = [];
  const used = new Set<number>();

  for (let i = 0; i < count; i++) {
    let idx = Math.abs(h + i * 7) % CONTRACT_TEMPLATES.length;
    while (used.has(idx)) idx = (idx + 1) % CONTRACT_TEMPLATES.length;
    used.add(idx);
    const tmpl = CONTRACT_TEMPLATES[idx];
    selected.push({
      id: uuid(),
      title: tmpl.title(campaignName),
      description: tmpl.description,
      reward: tmpl.reward,
      factionKey: tmpl.factionKey,
      taken: false,
      completedAt: null,
      claimedAt: null,
      objectiveType: tmpl.objectiveType,
      objectiveTarget: tmpl.objectiveTarget,
      objectiveLabel: tmpl.objectiveLabel,
    });
  }

  return selected;
}

export function evaluateContracts(db: Database, campaignId: string, contracts: TownContract[]): TownContract[] {
  const metrics = getContractMetrics(db, campaignId);

  return contracts.map((contract) => {
    const objectiveType = contract.objectiveType || 'discovered_sites';
    const objectiveTarget = Number(contract.objectiveTarget || 1);
    const progress = Number(metrics[objectiveType] || 0);
    const completedAt = contract.completedAt || (contract.taken && progress >= objectiveTarget ? new Date().toISOString() : null);
    return {
      ...contract,
      objectiveType,
      objectiveTarget,
      objectiveLabel: contract.objectiveLabel || describeObjective(objectiveType),
      progress,
      progressText: `${Math.min(progress, objectiveTarget)}/${objectiveTarget} ${contract.objectiveLabel || describeObjective(objectiveType)}`,
      completedAt,
      readyToClaim: Boolean(contract.taken && completedAt && !contract.claimedAt),
    };
  });
}

export function claimContractReward(params: {
  db: Database;
  campaignId: string;
  characterId: string;
  contractId: string;
}) {
  const { db, campaignId, characterId, contractId } = params;
  const campaign = get(db, 'SELECT town_contracts FROM campaigns WHERE id = ?', [campaignId]) as any;
  let contracts: TownContract[] = [];
  try { contracts = JSON.parse(campaign?.town_contracts || '[]'); } catch {}

  const evaluated = evaluateContracts(db, campaignId, contracts);
  const contract = evaluated.find((entry) => entry.id === contractId);
  if (!contract) return { ok: false, error: 'Contract not found' };
  if (!contract.taken) return { ok: false, error: 'Contract has not been taken' };
  if (!contract.completedAt) return { ok: false, error: 'Contract is not complete yet' };
  if (contract.claimedAt) return { ok: false, error: 'Contract reward already claimed' };

  const xpAward = Math.max(20, Math.floor(contract.reward / 2));
  run(db, 'UPDATE characters SET gold = gold + ?, xp = xp + ? WHERE id = ?', [contract.reward, xpAward, characterId]);

  const claimedAt = new Date().toISOString();
  const patched = evaluated.map((entry) => entry.id === contractId ? {
    ...entry,
    claimedAt,
    readyToClaim: false,
  } : entry);
  run(db, 'UPDATE campaigns SET town_contracts = ? WHERE id = ?', [JSON.stringify(patched), campaignId]);

  const state = getCampaignState(db, campaignId);
  noteCampaignEvent(state, `Contract settled: ${contract.title} for ${contract.reward} GP and ${xpAward} XP.`);
  shiftFactionStanding(state, contract.factionKey, { reputation: 1 });
  saveCampaignState(db, campaignId, state);

  return {
    ok: true,
    contract: { ...contract, claimedAt, readyToClaim: false },
    reward: contract.reward,
    xpAward,
    narration: `The board clerk checks your proof, scratches out the posting, and pays ${contract.reward} GP. Word spreads quickly enough to count for another ${xpAward} XP.`,
  };
}

function getContractMetrics(db: Database, campaignId: string): Record<string, number> {
  const mapStats = getMapStats(db, campaignId);
  const loreCount = Number((get(db,
    'SELECT COUNT(*) as count FROM world_lore WHERE campaign_id = ? AND category != "history" AND category != "faction"',
    [campaignId]) as any)?.count || 0);
  const revelationCount = Number((get(db,
    'SELECT COUNT(*) as count FROM world_lore WHERE campaign_id = ? AND category = "revelation"',
    [campaignId]) as any)?.count || 0);

  return {
    discovered_sites: mapStats.discoveredSites,
    cleared_scenes: mapStats.clearedScenes,
    fallback_points: mapStats.fallbackPoints,
    treasure_marks: mapStats.treasureMarks,
    lore_entries: loreCount,
    revelations: revelationCount,
  };
}

function getMapStats(db: Database, campaignId: string) {
  const rows = all(db, 'SELECT state_json FROM scene_state WHERE campaign_id = ?', [campaignId]) as Array<{ state_json?: string }>;
  let clearedScenes = 0;
  let fallbackPoints = 0;
  let treasureMarks = 0;
  for (const row of rows) {
    let state: any = {};
    try { state = JSON.parse(row.state_json || '{}'); } catch {}
    if (state.cleared) clearedScenes += 1;
    if (state.fallbackPoint) fallbackPoints += 1;
    if (state.knownTreasure) treasureMarks += 1;
  }
  const discoveredSites = Number((get(db,
    'SELECT COUNT(*) as count FROM scenes WHERE campaign_id = ? AND visited = 1',
    [campaignId]) as any)?.count || 0);
  return { discoveredSites, clearedScenes, fallbackPoints, treasureMarks };
}

function describeObjective(objectiveType: NonNullable<TownContract['objectiveType']>) {
  switch (objectiveType) {
    case 'cleared_scenes': return 'cleared scenes';
    case 'fallback_points': return 'fallback routes marked';
    case 'treasure_marks': return 'treasure leads secured';
    case 'lore_entries': return 'lore proofs gathered';
    case 'revelations': return 'major revelations';
    case 'discovered_sites':
    default:
      return 'sites discovered';
  }
}

// ─── Companion hire prospects ────────────────────────────────────────────────

const PROSPECT_POOL: Array<{
  name: string; race: string; charClass: string; level: number;
  personality: string; ask: number; voiceNotes: string; hook?: string;
}> = [
  { name: 'Gareth the Stout',   race: 'human',   charClass: 'fighter', level: 2, personality: 'Reliable, doesn\'t ask questions', ask: 10, voiceNotes: 'Blunt, northern accent, short sentences' },
  { name: 'Syla Moonwhisper',   race: 'half-elf', charClass: 'ranger',  level: 2, personality: 'Quiet, capable, watchful',         ask: 12, voiceNotes: 'Soft voice, pauses before speaking, precise' },
  { name: 'Brother Aldric',     race: 'human',   charClass: 'cleric',  level: 1, personality: 'Idealistic, nervous but willing',   ask: 8,  voiceNotes: 'Speaks in benedictions, slightly too loud' },
  { name: 'Finn Copperpurse',   race: 'halfling', charClass: 'thief',   level: 2, personality: 'Cheerful, quick, ethically flexible', ask: 14, voiceNotes: 'Fast talker, cheerful even when he shouldn\'t be' },
  { name: 'Marta Ironforge',    race: 'dwarf',   charClass: 'fighter', level: 2, personality: 'Stubborn, proud, deeply reliable',  ask: 10, voiceNotes: 'Flat affect, deadpan, says exactly what she means' },
  { name: 'Caleb Dustweather',  race: 'human',   charClass: 'mage',    level: 1, personality: 'Curious, distracted, genuinely brave', ask: 15, voiceNotes: 'Talks too much about theory, then does the job anyway' },
  { name: 'Seraph Whiteleaf',   race: 'elf',     charClass: 'mage',    level: 2, personality: 'Aloof, precise, observant',        ask: 18, voiceNotes: 'Formal speech, never uses contractions, slight disdain' },
  { name: 'Dorn the Scarred',   race: 'human',   charClass: 'fighter', level: 3, personality: 'Veteran, cynical, effective',      ask: 20, voiceNotes: 'Tired, economical, has heard every plan before' },
  { name: 'Oona Brightflame',   race: 'gnome',   charClass: 'bard',    level: 2, personality: 'Enthusiastic, social, resourceful', ask: 12, voiceNotes: 'Warm, sings fragments, always has a story' },
  { name: 'Hector of the Wall', race: 'human',   charClass: 'paladin', level: 2, personality: 'Earnest, inflexible, brave',       ask: 12, voiceNotes: 'Formal, moralistic, means every word of it' },
];

export function getProspects(campaignId: string, partyClasses: string[], dayCount: number, settingId = ''): Array<(typeof PROSPECT_POOL)[number]> {
  let h = 0;
  for (let i = 0; i < campaignId.length; i++) h = (Math.imul(31, h) + campaignId.charCodeAt(i)) | 0;
  h += dayCount * 13;
  const starterProspects = getStarterProspects(settingId);
  const combinedPool = [...starterProspects, ...PROSPECT_POOL.filter((prospect) =>
    !starterProspects.some((starter) => starter.name === prospect.name)
  )];

  // Pick 2 prospects, biased away from classes already in party
  const partyClassSet = new Set(partyClasses.map(c => c.toLowerCase()));
  const sorted = [...combinedPool].sort((a, b) => {
    const aInParty = partyClassSet.has(a.charClass) ? 1 : 0;
    const bInParty = partyClassSet.has(b.charClass) ? 1 : 0;
    return aInParty - bInParty;
  });

  const idx1 = Math.abs(h) % sorted.length;
  const idx2 = (Math.abs(h) + 3) % sorted.length;
  const result = [sorted[idx1]];
  if (idx2 !== idx1) result.push(sorted[idx2]);
  return result;
}

// ─── Sell loot ───────────────────────────────────────────────────────────────

export interface SellResult {
  gpEarned: number;
  xpAwarded: number;
  soldItems: string[];
  narration: string;
}

export function sellLoot(db: Database, campaignId: string, characterId: string, itemsToSell?: string[]): SellResult {
  const char = get(db, 'SELECT * FROM characters WHERE id = ?', [characterId]) as any;
  if (!char) return { gpEarned: 0, xpAwarded: 0, soldItems: [], narration: 'No character found.' };

  const { items } = appraiseLoot(db, campaignId, characterId);
  const toSell = itemsToSell
    ? items.filter(i => itemsToSell.some(n => i.item.toLowerCase().includes(n.toLowerCase())))
    : items;

  if (toSell.length === 0) {
    return { gpEarned: 0, xpAwarded: 0, soldItems: [], narration: 'The fence looks over your gear. "Nothing I can move," he says. Nothing sellable found.' };
  }

  let gpEarned = 0;
  const soldNames: string[] = [];

  // Remove sold items from inventory
  let inventory = JSON.parse(char.inventory || '[]') as any[];
  for (const sale of toSell) {
    gpEarned += sale.gpValue;
    soldNames.push(`${sale.item}${sale.quantity > 1 ? ` ×${sale.quantity}` : ''}`);
    inventory = inventory.filter(i => i.item !== sale.item);
  }

  const xpAwarded = Math.floor(gpEarned);

  run(db, 'UPDATE characters SET inventory = ?, gold = gold + ?, xp = xp + ? WHERE id = ?', [
    JSON.stringify(inventory),
    gpEarned,
    xpAwarded,
    characterId,
  ]);

  noteCampaignEvent(getCampaignState(db, campaignId), `Sold ${soldNames.length} lot(s) for ${gpEarned.toFixed(1)} GP in ${generateTownName(campaignId)}.`);

  const FENCE_LINES = [
    `He counts it out without looking at you. "${gpEarned.toFixed(1)} gold. That's my offer and it's generous." It's not generous. But it's coin.`,
    `The fence wraps the pieces in cloth before you've even finished putting them on the counter. He knows what's worth what. ${gpEarned.toFixed(1)} gold slides back to you across the wood.`,
    `"Interesting haul," she says, which means nothing good. She weighs the heaviest piece and names her price: ${gpEarned.toFixed(1)} gold. You take it.`,
    `Cash moves across the table. ${gpEarned.toFixed(1)} gold, which is what survival looks like when it's converted into numbers.`,
  ];
  const line = FENCE_LINES[Math.abs(gpEarned | 0) % FENCE_LINES.length];

  return { gpEarned, xpAwarded, soldItems: soldNames, narration: line };
}

// ─── Buy supplies ────────────────────────────────────────────────────────────

export interface BuyResult {
  ok: boolean;
  gpSpent: number;
  items: Array<{ item: string; quantity: number }>;
  narration: string;
  error?: string;
}

export function buySupplies(
  db: Database,
  campaignId: string,
  characterId: string,
  order: Array<{ item: string; quantity: number }>,
): BuyResult {
  const char = get(db, 'SELECT * FROM characters WHERE id = ?', [characterId]) as any;
  if (!char) return { ok: false, gpSpent: 0, items: [], narration: '', error: 'Character not found' };

  const state = getCampaignState(db, campaignId);
  const localsRep = state.factions['locals']?.reputation || 0;
  const catalogue = getCatalogue(db, campaignId);

  let gpSpent = 0;
  const purchased: Array<{ item: string; quantity: number }> = [];
  const inventory = JSON.parse(char.inventory || '[]') as any[];

  for (const req of order) {
    const entry = catalogue.find(c => c.item.toLowerCase() === req.item.toLowerCase());
    if (!entry) continue;
    const cost = entry.gp * req.quantity;
    gpSpent += cost;

    // Merge into inventory
    const existing = inventory.find((i: any) => i.item === entry.item);
    if (existing) {
      existing.quantity = (existing.quantity || 1) + req.quantity;
    } else {
      inventory.push({ item: entry.item, weight: 0.1, quantity: req.quantity, equipped: false });
    }
    purchased.push({ item: entry.item, quantity: req.quantity });
  }

  gpSpent = Math.round(gpSpent * 100) / 100;
  if (gpSpent > Number(char.gold || 0)) {
    return { ok: false, gpSpent: 0, items: [], narration: '', error: `Not enough gold. Need ${gpSpent.toFixed(2)} GP, have ${Number(char.gold || 0).toFixed(2)} GP.` };
  }

  run(db, 'UPDATE characters SET inventory = ?, gold = gold - ? WHERE id = ?', [
    JSON.stringify(inventory), gpSpent, characterId,
  ]);

  const BUY_LINES = [
    'The market stall is quick and professional about it. What you need, you now have.',
    'The merchant bags everything without conversation. Coin changes hands. The party is resupplied.',
    `${gpSpent.toFixed(2)} gold for supplies that might keep you alive next time.`,
    'The goods are wrapped and ready before you\'ve counted the coin out. They know their regular customers.',
  ];
  const line = BUY_LINES[purchased.length % BUY_LINES.length];

  return { ok: true, gpSpent, items: purchased, narration: line };
}

// ─── Heal injuries ────────────────────────────────────────────────────────────

export interface HealResult {
  ok: boolean;
  gpSpent: number;
  healed: string[];
  narration: string;
  error?: string;
}

export function healInjuries(db: Database, characterId: string, isPaladin: boolean): HealResult {
  const char = get(db, 'SELECT * FROM characters WHERE id = ?', [characterId]) as any;
  if (!char) return { ok: false, gpSpent: 0, healed: [], narration: '', error: 'Character not found' };

  const conditions = JSON.parse(char.conditions || '[]') as string[];
  const treatable = conditions.filter(c => healingCost(c) > 0);

  if (treatable.length === 0) {
    const HEALTHY_LINES = [
      `The healer gives you a thorough look-over. "Nothing I can fix that isn't already fixed," she says, which is the closest to a compliment she'll give.`,
      `"You're in better shape than most who walk through that door." The healer charges you for the assessment anyway.`,
    ];
    return { ok: true, gpSpent: 0, healed: [], narration: HEALTHY_LINES[Math.floor(Math.random() * HEALTHY_LINES.length)] };
  }

  let totalCost = treatable.reduce((n, c) => n + healingCost(c), 0);

  if (isPaladin) {
    // Paladin lay on hands covers one injury free
    const [freeOne, ...rest] = treatable;
    totalCost = rest.reduce((n, c) => n + healingCost(c), 0);
    void freeOne;
  }

  if (totalCost > Number(char.gold || 0)) {
    return { ok: false, gpSpent: 0, healed: [], narration: '', error: `Treatment costs ${totalCost} GP. You have ${Number(char.gold || 0).toFixed(1)} GP.` };
  }

  const remaining = conditions.filter(c => !treatable.includes(c));
  run(db, 'UPDATE characters SET conditions = ?, gold = gold - ? WHERE id = ?', [
    JSON.stringify(remaining), totalCost, characterId,
  ]);

  const HEAL_LINES = [
    `The healer works without sentimentality. Needles, thread, poultices, and a matter-of-fact declaration when it's done: "You'll live." You feel it.`,
    `It hurts while it's happening and feels better when it stops. That's the whole of healing, in the healer's estimation. ${totalCost} GP and your injuries are seen to.`,
    `"Hold still." She doesn't say it gently. But the wounds are closed by the time she's done, and she tells you you're fit to walk if not yet fit to fight hard.`,
  ];
  const line = HEAL_LINES[Math.abs(totalCost | 0) % HEAL_LINES.length];

  return { ok: true, gpSpent: totalCost, healed: treatable, narration: line };
}

// ─── Resurrect companion ──────────────────────────────────────────────────────

export interface ResurrectResult {
  ok: boolean;
  succeeded: boolean;
  gpSpent: number;
  narration: string;
  error?: string;
}

export function resurrectCompanion(db: Database, characterId: string, npcId: string): ResurrectResult {
  const char = get(db, 'SELECT * FROM characters WHERE id = ?', [characterId]) as any;
  const npc = get(db, 'SELECT * FROM npcs WHERE id = ? AND alive = 0', [npcId]) as any;

  if (!char) return { ok: false, succeeded: false, gpSpent: 0, narration: '', error: 'Character not found' };
  if (!npc) return { ok: false, succeeded: false, gpSpent: 0, narration: '', error: 'Companion not found or not dead' };

  const cost = 1000;
  if (Number(char.gold || 0) < cost) {
    return { ok: false, succeeded: false, gpSpent: 0, narration: '', error: `Resurrection costs ${cost} GP. You have ${Number(char.gold).toFixed(0)} GP.` };
  }

  const rel = normalizeRelationshipState(JSON.parse(npc.relationship_state || '{}'));
  const loyaltyBonus = Math.min(3, Math.max(-3, Math.floor(rel.loyalty / 2)));
  const faithBonus = /cleric|paladin|druid/.test(String(npc.char_class || '').toLowerCase()) ? 2 : 0;
  const roll2d = roll2d6().total;
  const target = 7 - loyaltyBonus - faithBonus;
  const succeeded = roll2d >= target;

  run(db, 'UPDATE characters SET gold = gold - ? WHERE id = ?', [cost, characterId]);

  if (succeeded) {
    const stats = JSON.parse(npc.stats || '{}');
    const newHp = Math.max(1, Math.floor((stats.maxHp || 6) / 2));
    run(db, `UPDATE npcs SET alive = 1, stats = json_set(stats, '$.currentHp', ?) WHERE id = ?`, [newHp, npcId]);

    return {
      ok: true, succeeded: true, gpSpent: cost,
      narration: `The ritual takes time and costs more than money. When it's done, ${npc.name} draws a sharp breath and opens their eyes. They're pale and confused, but here. The cost sits heavy — ${cost} GP and something less quantifiable. They're back.`,
    };
  }

  return {
    ok: true, succeeded: false, gpSpent: cost,
    narration: `The priest does everything that can be done. The coin changes hands. The prayers are said. ${npc.name} does not stir. Some deaths, the healer tells you with genuine regret, don't reverse. The money is gone, and so are they.`,
  };
}

// ─── Return to Town transition ────────────────────────────────────────────────

export function returnToTown(db: Database, campaignId: string): {
  townName: string;
  arrivalNarration: string;
  dawnSummary: string | null;
} {
  const campaign = get(db, 'SELECT * FROM campaigns WHERE id = ?', [campaignId]) as any;
  if (!campaign) throw new Error('Campaign not found');

  // Generate town name if not set
  let townName = String(campaign.town_name || '').trim();
  if (!townName) {
    townName = generateTownName(String(campaign.name || campaignId));
    run(db, 'UPDATE campaigns SET town_name = ? WHERE id = ?', [townName, campaignId]);
  }

  // Advance day count
  run(db, `UPDATE campaigns SET
      campaign_phase = 'town',
      session_number = session_number + 1
    WHERE id = ?`, [campaignId]);

  const activeChars = all(db, 'SELECT id, conditions FROM characters WHERE campaign_id = ? AND status != "dead"', [campaignId]) as any[];
  for (const row of activeChars) {
    try {
      const conditions = JSON.parse(row.conditions || '[]') as string[];
      const cleaned = conditions.filter((condition) => condition !== 'lay_on_hands_spent');
      if (cleaned.length !== conditions.length) {
        run(db, 'UPDATE characters SET conditions = ? WHERE id = ?', [JSON.stringify(cleaned), row.id]);
      }
    } catch {}
  }

  // Reset delve conditions on arrival (fresh torches are from inventory, not here)
  const state = getCampaignState(db, campaignId);
  state.delve.fatigueTicks = 0;
  state.delve.hungerTicks = 0;
  state.delve.attritionHp = 0;
  state.delve.lootCarried = 0;
  state.delve.encumbered = false;
  state.delve.retreatPenalty = 0;
  state.delve.tensionFromSupply = 0;
  state.delve.campQuality = 'adequate';
  state.delve.campTurnNumber = 0;
  saveCampaignState(db, campaignId, state);

  const arrivalNarration = describeArrival(townName, campaignId);

  // Pop dawn summary if any - imported at top
  let dawnSummary: string | null = null;
  try {
    dawnSummary = popDawnSummary(db, campaignId);
  } catch { /* nightly growth not yet run */ }

  return { townName, arrivalNarration, dawnSummary };
}

// ─── Leave Town transition ───────────────────────────────────────────────────

export function leaveForDungeon(db: Database, campaignId: string, characterId: string): {
  summary: string;
  finalRumour: string | null;
} {
  run(db, `UPDATE campaigns SET campaign_phase = 'dungeon' WHERE id = ?`, [campaignId]);

  // Reset torch tracking at start of fresh delve
  const state = getCampaignState(db, campaignId);
  state.delve.torchesLit = 0;
  state.delve.lightsOutAt = 0;
  state.delve.lightLevel = 'normal';
  saveCampaignState(db, campaignId, state);

  const char = get(db, 'SELECT * FROM characters WHERE id = ?', [characterId]) as any;
  const campaign = get(db, 'SELECT * FROM campaigns WHERE id = ?', [campaignId]) as any;
  const companions = getPartyCompanions(db, campaignId).filter(c => c.joinedParty);

  const hp = char ? `${char.hp}/${char.max_hp} HP` : '';
  const gp = char ? `${Number(char.gold || 0).toFixed(1)} GP` : '';
  const conditions = char ? JSON.parse(char.conditions || '[]') as string[] : [];
  const injurySummary = conditions.length > 0 ? `, ${conditions.join(', ')}` : '';

  const companionLines = companions.map(c => `${c.name} (${c.relationshipLabel})`);

  const summaryParts = [`${char?.name || 'The party'} — ${hp}${injurySummary}, ${gp}`];
  if (companionLines.length > 0) summaryParts.push(`With: ${companionLines.join(', ')}`);

  const summary = summaryParts.join('\n');

  let finalRumour: string | null = null;
  try {
    const rumours = surfaceRumours(db, campaignId, 1);
    if (rumours.length > 0) finalRumour = rumours[0];
  } catch {}

  noteCampaignEvent(state, `Party left ${campaign?.town_name || 'town'} for the dungeon.`);
  saveCampaignState(db, campaignId, state);

  return { summary, finalRumour };
}
