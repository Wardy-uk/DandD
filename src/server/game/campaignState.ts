import type { Database } from 'sql.js';
import { get, run } from '../db/helpers.js';

export interface FactionStanding {
  name: string;
  reputation: number;
  heat: number;
  notes: string;
}

export interface DelveConditions {
  // Light state
  torchesLit: number;        // currently burning torches
  lightsOutAt: number;       // exploration turn when torches run out (0 = unlimited)
  lightLevel: 'bright' | 'normal' | 'dim' | 'dark';

  // Fatigue / attrition
  fatigueTicks: number;      // 0–5; each turn without rest adds 1
  hungerTicks: number;       // 0–4; each 4 turns without rations adds 1
  attritionHp: number;       // HP lost to accumulated attrition (applied to character)

  // Encumbrance from loot
  lootCarried: number;       // gp-weight equivalent
  encumbered: boolean;       // lootCarried > threshold
  retreatPenalty: number;    // movement penalty (0–3) when encumbered

  // Camp quality (last rest)
  campQuality: 'poor' | 'adequate' | 'good' | 'fortified';
  campTurnNumber: number;    // turn when last camp was made

  // Companion tension from supply
  tensionFromSupply: number; // extra tension applied to all companions
}

export interface NightlyWorldEvent {
  id: string;
  type: string;
  text: string;
  injected: boolean;
  createdAt: string;
}

export interface NightlyLogEntry {
  at: string;
  summary: string;
  details: string[];
}

export interface NightlyGrowthData {
  pendingDawnSummary: string | null;
  pendingWorldEvents: NightlyWorldEvent[];
  nightlyLog: NightlyLogEntry[];
}

export interface DeathRecord {
  characterName: string;
  charClass: string;
  level: number;
  cause: string;
  sceneName: string;
  sessionNumber: number;
  triggeredAt: string;
}

export interface MilestoneRecord {
  id: string;
  name: string;
  narration: string;
  triggeredAt: string;
}

export interface CampaignSimulationState {
  factions: Record<string, FactionStanding>;
  supply: {
    torchesBurned: number;
    rationsSpent: number;
    lockpicksBroken: number;
    arrowsSpent: number;
    bandagesUsed: number;
  };
  delve: DelveConditions;
  encounterPressure: number;
  lastEncounterTurn: number;
  recentEvents: string[];
  nightlyGrowth: NightlyGrowthData;
  // Progression
  deaths: DeathRecord[];
  milestones: MilestoneRecord[];
}

export interface CampaignStateSnapshot {
  encounterPressure: number;
  supply: CampaignSimulationState['supply'];
  delve: DelveConditions;
  factions: Array<{
    key: string;
    name: string;
    reputation: number;
    heat: number;
    summary: string;
    notes: string;
  }>;
  recentEvents: string[];
}

const DEFAULT_FACTIONS: Array<[string, string]> = [
  ['locals', 'townsfolk, guides, and the ordinary people living near the danger'],
  ['delvers', 'rival treasure-seekers and opportunists working the same frontier'],
  ['watch', 'soldiers, guards, templars, and authority figures trying to contain the region'],
  ['shadows', 'hidden cults, smugglers, beasts, and things that profit from chaos'],
];

export function getCampaignState(db: Database, campaignId: string): CampaignSimulationState {
  const row = get(db, 'SELECT state_json FROM campaign_state WHERE campaign_id = ?', [campaignId]) as any;
  if (!row?.state_json) {
    const initial = createDefaultCampaignState();
    saveCampaignState(db, campaignId, initial);
    return initial;
  }

  try {
    return normalizeCampaignState(JSON.parse(row.state_json));
  } catch {
    const initial = createDefaultCampaignState();
    saveCampaignState(db, campaignId, initial);
    return initial;
  }
}

export function saveCampaignState(db: Database, campaignId: string, state: CampaignSimulationState) {
  run(db, `
    INSERT OR REPLACE INTO campaign_state (campaign_id, state_json, updated_at)
    VALUES (?, ?, datetime('now'))
  `, [campaignId, JSON.stringify(state)]);
}

export function noteCampaignEvent(state: CampaignSimulationState, event: string) {
  state.recentEvents.push(event);
  if (state.recentEvents.length > 12) {
    state.recentEvents.shift();
  }
}

export function shiftFactionStanding(
  state: CampaignSimulationState,
  factionKey: string,
  patch: Partial<Pick<FactionStanding, 'reputation' | 'heat'>>,
  note?: string,
) {
  const faction = state.factions[factionKey] || {
    name: factionKey,
    reputation: 0,
    heat: 0,
    notes: '',
  };
  faction.reputation = clamp((faction.reputation ?? 0) + (patch.reputation ?? 0), -10, 10);
  faction.heat = clamp((faction.heat ?? 0) + (patch.heat ?? 0), 0, 12);
  if (note) faction.notes = note;
  state.factions[factionKey] = faction;
}

export function describeFactionStanding(faction: FactionStanding): string {
  if (faction.reputation >= 6) return `${faction.name} regard the party as proven allies.`;
  if (faction.reputation >= 3) return `${faction.name} are inclined to trust the party.`;
  if (faction.reputation >= 1) return `${faction.name} are cautiously positive toward the party.`;
  if (faction.reputation <= -6) return `${faction.name} actively seek chances to hurt the party.`;
  if (faction.reputation <= -3) return `${faction.name} are openly hostile to the party.`;
  if (faction.reputation <= -1) return `${faction.name} distrust the party and watch for weakness.`;
  return `${faction.name} are still deciding what the party means to them.`;
}

export function getCampaignStateSnapshot(state: CampaignSimulationState): CampaignStateSnapshot {
  return {
    encounterPressure: state.encounterPressure,
    supply: { ...state.supply },
    delve: { ...state.delve },
    factions: Object.entries(state.factions).map(([key, faction]) => ({
      key,
      name: faction.name,
      reputation: faction.reputation,
      heat: faction.heat,
      summary: describeFactionStanding(faction),
      notes: faction.notes,
    })),
    recentEvents: [...state.recentEvents].slice(-5).reverse(),
  };
}

function createDefaultCampaignState(): CampaignSimulationState {
  const factions: Record<string, FactionStanding> = {};
  for (const [key, notes] of DEFAULT_FACTIONS) {
    factions[key] = {
      name: key,
      reputation: 0,
      heat: 0,
      notes,
    };
  }

  return {
    factions,
    supply: {
      torchesBurned: 0,
      rationsSpent: 0,
      lockpicksBroken: 0,
      arrowsSpent: 0,
      bandagesUsed: 0,
    },
    delve: {
      torchesLit: 0,
      lightsOutAt: 0,
      lightLevel: 'normal',
      fatigueTicks: 0,
      hungerTicks: 0,
      attritionHp: 0,
      lootCarried: 0,
      encumbered: false,
      retreatPenalty: 0,
      campQuality: 'adequate',
      campTurnNumber: 0,
      tensionFromSupply: 0,
    },
    encounterPressure: 2,
    lastEncounterTurn: 0,
    recentEvents: [],
    nightlyGrowth: {
      pendingDawnSummary: null,
      pendingWorldEvents: [],
      nightlyLog: [],
    },
    deaths: [],
    milestones: [],
  };
}

function normalizeCampaignState(raw: any): CampaignSimulationState {
  const base = createDefaultCampaignState();
  return {
    factions: { ...base.factions, ...(raw?.factions || {}) },
    supply: {
      ...base.supply,
      ...(raw?.supply || {}),
    },
    delve: {
      ...base.delve,
      ...(raw?.delve || {}),
    },
    encounterPressure: Number(raw?.encounterPressure ?? base.encounterPressure),
    lastEncounterTurn: Number(raw?.lastEncounterTurn ?? base.lastEncounterTurn),
    recentEvents: Array.isArray(raw?.recentEvents) ? raw.recentEvents.slice(0, 12) : [],
    nightlyGrowth: {
      pendingDawnSummary: raw?.nightlyGrowth?.pendingDawnSummary ?? null,
      pendingWorldEvents: Array.isArray(raw?.nightlyGrowth?.pendingWorldEvents)
        ? raw.nightlyGrowth.pendingWorldEvents
        : [],
      nightlyLog: Array.isArray(raw?.nightlyGrowth?.nightlyLog)
        ? raw.nightlyGrowth.nightlyLog.slice(-5)
        : [],
    },
    deaths: Array.isArray(raw?.deaths) ? raw.deaths : [],
    milestones: Array.isArray(raw?.milestones) ? raw.milestones : [],
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

// ─── Death Records ───────────────────────────────────────────────────────────

export function recordDeath(
  state: CampaignSimulationState,
  record: Omit<DeathRecord, 'triggeredAt'>,
): void {
  state.deaths.push({ ...record, triggeredAt: new Date().toISOString() });
  noteCampaignEvent(state, `${record.characterName} (${record.charClass} level ${record.level}) fell: ${record.cause}`);
}

export function getDeaths(state: CampaignSimulationState): DeathRecord[] {
  return state.deaths;
}

// ─── Milestones ──────────────────────────────────────────────────────────────

export const MILESTONE_DEFS: Record<string, { name: string; narration: string }> = {
  first_blood: {
    name: 'First Blood',
    narration: 'First blood is drawn. The dungeon is no longer a story — it\'s real.',
  },
  cleared: {
    name: 'Area Cleared',
    narration: 'The last enemy falls silent. A space that was hostile is now, for a moment, yours.',
  },
  bloodied: {
    name: 'Bloodied',
    narration: 'The party has fought hard enough to know this place means business.',
  },
  the_fallen: {
    name: 'The Fallen',
    narration: 'A companion has died. The party is smaller, quieter, and the weight of this place is heavier.',
  },
  rival: {
    name: 'Rival Noticed',
    narration: 'Word of the party\'s work has reached ears that prefer competition stayed buried.',
  },
  faction_standing: {
    name: 'Known Quantity',
    narration: 'The party has made enough of an impression that factions are starting to plan around them.',
  },
  revelation: {
    name: 'Revelation',
    narration: 'Something deeper has been uncovered. The picture is bigger than it first appeared.',
  },
  legendary: {
    name: 'Legendary',
    narration: 'Level 5. The party has moved past the threshold from unknown to formidable. Things that would have ignored them now pay attention.',
  },
  the_long_game: {
    name: 'The Long Game',
    narration: 'Ten sessions in. Most never make it this far. The dungeon knows you now.',
  },
};

/**
 * Check and award a milestone if not already granted.
 * Returns the milestone record if newly awarded, null if already known.
 */
export function checkAndAwardMilestone(
  state: CampaignSimulationState,
  milestoneId: string,
): MilestoneRecord | null {
  if (state.milestones.find((m) => m.id === milestoneId)) return null;
  const def = MILESTONE_DEFS[milestoneId];
  if (!def) return null;
  const record: MilestoneRecord = {
    id: milestoneId,
    name: def.name,
    narration: def.narration,
    triggeredAt: new Date().toISOString(),
  };
  state.milestones.push(record);
  noteCampaignEvent(state, `Milestone reached: ${def.name}`);
  return record;
}

export function getMilestones(state: CampaignSimulationState): MilestoneRecord[] {
  return state.milestones;
}

// ─── Delve Pressure Functions ─────────────────────────────────────────────────

const ENCUMBRANCE_THRESHOLD = 200;  // gp-weight before encumbered
const LIGHT_TORCH_TURNS    = 6;    // turns per torch

/**
 * Tick delve conditions each exploration turn.
 * Returns string notes for anything dramatic.
 */
export function tickDelveConditions(params: {
  state: CampaignSimulationState;
  explorationTurn: number;
  torchesCarried: number;
  rationsCarried: number;
  leaderName: string;
}): string[] {
  const { state, explorationTurn, torchesCarried, rationsCarried, leaderName } = params;
  const d = state.delve;
  const notes: string[] = [];

  // ── Light ──────────────────────────────────────────────────────────────────
  if (d.torchesLit > 0 && d.lightsOutAt > 0 && explorationTurn >= d.lightsOutAt) {
    // Torch burned out
    state.supply.torchesBurned += 1;
    d.torchesLit = Math.max(0, d.torchesLit - 1);
    if (torchesCarried > 0) {
      // Auto-light next
      d.lightsOutAt = explorationTurn + LIGHT_TORCH_TURNS;
      notes.push(`A torch gutters and dies. Another is lit. ${torchesCarried - 1} remain in the pack.`);
    } else {
      d.torchesLit = 0;
      d.lightsOutAt = 0;
      d.lightLevel = 'dark';
      notes.push(`The last torch dies. Darkness closes in. Scouting, mapping, and surprise checks now carry a heavy penalty.`);
    }
  }

  // Derive light level from torches + turns
  if (d.torchesLit > 0) {
    const turnsRemaining = d.lightsOutAt - explorationTurn;
    d.lightLevel = turnsRemaining <= 1 ? 'dim' : 'normal';
  } else if (d.torchesLit === 0 && torchesCarried === 0) {
    d.lightLevel = 'dark';
  } else {
    d.lightLevel = 'normal';
  }

  // ── Fatigue ────────────────────────────────────────────────────────────────
  const turnsSinceCamp = explorationTurn - d.campTurnNumber;
  const newFatigueTick = Math.floor(turnsSinceCamp / 4);
  if (newFatigueTick > d.fatigueTicks) {
    d.fatigueTicks = Math.min(5, newFatigueTick);
    if (d.fatigueTicks >= 3) {
      d.attritionHp += 1;
      notes.push(`Exhaustion is taking its toll on ${leaderName}'s company. The constant pace without real rest is costing them.`);
    }
    if (d.fatigueTicks >= 5) {
      notes.push(`The company is dangerously fatigued. Without camp soon, the attrition will become serious.`);
    }
  }

  // ── Hunger ────────────────────────────────────────────────────────────────
  if (explorationTurn > 0 && explorationTurn % 4 === 0 && rationsCarried === 0) {
    d.hungerTicks = Math.min(4, d.hungerTicks + 1);
    if (d.hungerTicks >= 2) {
      d.tensionFromSupply += 1;
      notes.push(`The company has gone without rations too long. The hunger is starting to show in shorter tempers and slower thinking.`);
    }
    if (d.hungerTicks >= 4) {
      d.attritionHp += 1;
      notes.push(`Going without food this long is becoming dangerous. Someone will need to eat or the company will break down.`);
    }
  }

  return notes;
}

/**
 * Light a torch explicitly. Returns result note.
 */
export function lightTorch(state: CampaignSimulationState, explorationTurn: number, torchesCarried: number): string {
  if (torchesCarried <= 0) return 'There are no torches left to light.';
  state.delve.torchesLit += 1;
  state.delve.lightsOutAt = explorationTurn + LIGHT_TORCH_TURNS;
  state.delve.lightLevel = 'normal';
  return `A torch is lit. It will last another ${LIGHT_TORCH_TURNS} turns of exploration.`;
}

/**
 * Record loot pickup; updates encumbrance state.
 */
export function addLootWeight(state: CampaignSimulationState, gpWeight: number): string[] {
  const d = state.delve;
  d.lootCarried += gpWeight;
  const notes: string[] = [];
  if (d.lootCarried >= ENCUMBRANCE_THRESHOLD && !d.encumbered) {
    d.encumbered = true;
    d.retreatPenalty = 1;
    notes.push(`The company is now loaded down with loot. Retreat speed and movement checks carry a penalty until they unload.`);
  }
  if (d.lootCarried >= ENCUMBRANCE_THRESHOLD * 2) {
    d.retreatPenalty = 2;
    notes.push(`The haul is getting seriously heavy. A tactical retreat now would be slow and costly \u2014 ideal ambush conditions for anything following.`);
  }
  if (d.lootCarried >= ENCUMBRANCE_THRESHOLD * 3) {
    d.retreatPenalty = 3;
    notes.push(`The company is critically over-laden. They cannot fight well, cannot move fast, and cannot easily retreat.`);
  }
  return notes;
}

/**
 * Make camp. Resets fatigue, updates camp quality, affects companions.
 */
export function makeCamp(params: {
  state: CampaignSimulationState;
  explorationTurn: number;
  rationsAvailable: number;
  sceneLight: string;
  fortified: boolean;
  leaderName: string;
}): string[] {
  const { state, explorationTurn, rationsAvailable, sceneLight, fortified, leaderName } = params;
  const d = state.delve;
  const notes: string[] = [];

  // Reset fatigue
  const fatigueReduction = fortified ? d.fatigueTicks : Math.floor(d.fatigueTicks / 2);
  d.fatigueTicks = Math.max(0, d.fatigueTicks - fatigueReduction);
  d.campTurnNumber = explorationTurn;

  // Camp quality
  if (fortified && rationsAvailable >= 1) {
    d.campQuality = 'fortified';
    d.tensionFromSupply = Math.max(0, d.tensionFromSupply - 2);
    notes.push(`${leaderName}'s company makes a proper camp \u2014 barred door, rationed food, a proper watch rotation. Everyone wakes steadier.`);
  } else if (rationsAvailable >= 1) {
    d.campQuality = 'good';
    d.tensionFromSupply = Math.max(0, d.tensionFromSupply - 1);
    notes.push(`Camp is rough but fed. The ration goes around and the company settles into a functional rest.`);
  } else if (sceneLight !== 'dark') {
    d.campQuality = 'adequate';
    notes.push(`Camp is made without food, but at least the light holds. Rest is partial at best.`);
  } else {
    d.campQuality = 'poor';
    d.tensionFromSupply += 1;
    notes.push(`Camp in the dark, unfed. The company rests poorly and wakes worse. The night sits heavy on morale.`);
  }

  // Reset hunger if rationed
  if (rationsAvailable >= 1 && d.hungerTicks > 0) {
    d.hungerTicks = Math.max(0, d.hungerTicks - 2);
  }

  return notes;
}

/**
 * Apply accumulated attrition HP to a character. Returns hp delta.
 */
export function applyAttritionDamage(state: CampaignSimulationState): number {
  const hp = state.delve.attritionHp;
  state.delve.attritionHp = 0;
  return -hp;  // negative = damage
}

/**
 * Get light-level modifiers for scouting/surprise.
 */
export function getLightModifiers(state: CampaignSimulationState): {
  scoutPenalty: number;
  surprisePenalty: number;
  mapPenalty: number;
  description: string;
} {
  switch (state.delve.lightLevel) {
    case 'bright':
      return { scoutPenalty: 0, surprisePenalty: 0, mapPenalty: 0, description: 'Full light — no penalties.' };
    case 'normal':
      return { scoutPenalty: 0, surprisePenalty: 0, mapPenalty: 0, description: 'Adequate torchlight.' };
    case 'dim':
      return { scoutPenalty: 1, surprisePenalty: 1, mapPenalty: 1, description: 'Guttering light — scouting and surprise checks penalised.' };
    case 'dark':
      return { scoutPenalty: 3, surprisePenalty: 3, mapPenalty: 3, description: 'Total darkness — scouting, mapping, and surprise are severely impaired.' };
  }
}
