import type { Database } from 'sql.js';
import { get, run } from '../db/helpers.js';

export interface FactionStanding {
  name: string;
  reputation: number;
  heat: number;
  notes: string;
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
  encounterPressure: number;
  lastEncounterTurn: number;
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
    encounterPressure: 2,
    lastEncounterTurn: 0,
    recentEvents: [],
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
    encounterPressure: Number(raw?.encounterPressure ?? base.encounterPressure),
    lastEncounterTurn: Number(raw?.lastEncounterTurn ?? base.lastEncounterTurn),
    recentEvents: Array.isArray(raw?.recentEvents) ? raw.recentEvents.slice(0, 12) : [],
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
