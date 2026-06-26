/**
 * chronicle.ts — Campaign Chronicle assembler
 *
 * Pulls together everything meaningful that has happened in a campaign
 * into a chronological array of events the player can read back.
 */

import type { Database } from 'sql.js';
import { all, get } from '../db/helpers.js';
import { getCampaignState } from './campaignState.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ChronicleEventType =
  | 'milestone'
  | 'death'
  | 'lore'
  | 'rival'
  | 'faction'
  | 'nightly'
  | 'session';

export interface ChronicleEvent {
  type: ChronicleEventType;
  timestamp: string;   // ISO 8601
  heading: string;
  body: string;
  icon: string;
}

export interface Chronicle {
  campaignName: string;
  dayCount: number;
  sessionCount: number;
  events: ChronicleEvent[];
}

// ─── Icon map ─────────────────────────────────────────────────────────────────

const ICONS: Record<ChronicleEventType, string> = {
  milestone: '⭐',
  death:     '💀',
  lore:      '📜',
  rival:     '🗡️',
  faction:   '🏛️',
  nightly:   '🌙',
  session:   '⚔️',
};

// ─── Default faction notes (set at campaign creation — not chronicle events) ──

const DEFAULT_FACTION_NOTES = new Set([
  'townsfolk, guides, and the ordinary people living near the danger',
  'rival treasure-seekers and opportunists working the same frontier',
  'soldiers, guards, templars, and authority figures trying to contain the region',
  'hidden cults, smugglers, beasts, and things that profit from chaos',
]);

// ─── Main assembler ───────────────────────────────────────────────────────────

export function getChronicle(db: Database, campaignId: string): Chronicle {
  const campaign = get(db, 'SELECT name, exploration_turn, created_at FROM campaigns WHERE id = ?', [campaignId]) as any;
  if (!campaign) throw new Error('Campaign not found');

  const state = getCampaignState(db, campaignId);
  const events: ChronicleEvent[] = [];

  // ── 1. Deaths ────────────────────────────────────────────────────────────────
  for (const death of state.deaths) {
    events.push({
      type: 'death',
      timestamp: death.triggeredAt,
      heading: `${death.characterName} falls`,
      body: death.cause
        ? `${death.charClass} level ${death.level}, lost in ${death.sceneName}. ${death.cause}`
        : `${death.charClass} level ${death.level}, lost in ${death.sceneName}.`,
      icon: ICONS.death,
    });
  }

  // ── 2. Milestones ────────────────────────────────────────────────────────────
  for (const ms of state.milestones) {
    events.push({
      type: 'milestone',
      timestamp: ms.triggeredAt,
      heading: ms.name,
      body: ms.narration,
      icon: ICONS.milestone,
    });
  }

  // ── 3. Lore revelations (world_lore table, category='revelation') ─────────────
  const loreRows = all(db,
    `SELECT title, content, created_at FROM world_lore
     WHERE campaign_id = ? AND category = 'revelation'
     ORDER BY created_at ASC`,
    [campaignId],
  ) as any[];

  for (const row of loreRows) {
    events.push({
      type: 'lore',
      timestamp: row.created_at,
      heading: row.title || 'A thread becomes clear',
      body: row.content,
      icon: ICONS.lore,
    });
  }

  // ── 4. Rival encounters ───────────────────────────────────────────────────────
  const rivalRows = all(db,
    'SELECT state_json, updated_at FROM rival_parties WHERE campaign_id = ?',
    [campaignId],
  ) as any[];

  for (const row of rivalRows) {
    let rival: any;
    try { rival = JSON.parse(row.state_json); } catch { continue; }

    // Only include if the rival has actually been encountered
    if (!rival.clashCount && rival.relation === 'unknown') continue;

    const relationLabel = describeRelationBriefly(rival.relation);
    const memorySnippet = rival.memory?.length
      ? rival.memory[rival.memory.length - 1]
      : '';

    events.push({
      type: 'rival',
      timestamp: row.updated_at || campaign.created_at,
      heading: rival.name
        ? `${rival.name} — ${relationLabel}`
        : 'Rival delvers spotted',
      body: rival.clashCount > 0
        ? `${rival.clashCount} clash${rival.clashCount !== 1 ? 'es' : ''} with this company.${memorySnippet ? ' ' + memorySnippet : ''}`
        : memorySnippet || `${rival.name} is working the same dungeon.`,
      icon: ICONS.rival,
    });
  }

  // ── 5. Faction standing shifts ────────────────────────────────────────────────
  // Emit a faction event for any faction whose reputation has moved from neutral
  // or whose notes have been overwritten by a shift (i.e. not the campaign default).
  for (const [key, faction] of Object.entries(state.factions)) {
    if (faction.reputation === 0 && faction.heat === 0) continue;
    if (DEFAULT_FACTION_NOTES.has(faction.notes)) continue;

    const directionWord = faction.reputation >= 3
      ? 'allies with'
      : faction.reputation > 0
        ? 'favoured by'
        : faction.reputation <= -3
          ? 'hunted by'
          : 'watched by';

    events.push({
      type: 'faction',
      // No per-change timestamps; use campaign_state updated_at
      timestamp: getFactionTimestamp(db, campaignId, campaign.created_at),
      heading: `${capitaliseFaction(faction.name || key)} stir`,
      body: `The party stands ${directionWord} the ${faction.name || key}. Rep ${faction.reputation > 0 ? '+' : ''}${faction.reputation}, heat ${faction.heat}. ${faction.notes}`,
      icon: ICONS.faction,
    });
  }

  // ── 6. Nightly log entries ────────────────────────────────────────────────────
  for (const entry of state.nightlyGrowth.nightlyLog) {
    events.push({
      type: 'nightly',
      timestamp: entry.at,
      heading: 'Night passes',
      body: entry.summary || entry.details?.join(' ') || 'The world moves while the party rests.',
      icon: ICONS.nightly,
    });
  }

  // ── 7. Session markers (from game_log) ───────────────────────────────────────
  const sessionRows = all(db,
    `SELECT session_number, MIN(timestamp) as first_at
     FROM game_log WHERE campaign_id = ?
     GROUP BY session_number
     ORDER BY session_number ASC`,
    [campaignId],
  ) as any[];

  for (const srow of sessionRows) {
    events.push({
      type: 'session',
      timestamp: srow.first_at,
      heading: `Session ${srow.session_number} begins`,
      body: `The party takes to the dungeon once more.`,
      icon: ICONS.session,
    });
  }

  // ── Sort newest first ─────────────────────────────────────────────────────────
  events.sort((a, b) => {
    const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
    const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
    return tb - ta;
  });

  // ── Session count ─────────────────────────────────────────────────────────────
  const sessionCountRow = get(db,
    'SELECT COUNT(DISTINCT session_number) as cnt FROM game_log WHERE campaign_id = ?',
    [campaignId],
  ) as any;
  const sessionCount = Number(sessionCountRow?.cnt ?? 0);

  return {
    campaignName: campaign.name,
    dayCount: Number(campaign.exploration_turn ?? 0),
    sessionCount,
    events,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getFactionTimestamp(db: Database, campaignId: string, fallback: string): string {
  const row = get(db,
    'SELECT updated_at FROM campaign_state WHERE campaign_id = ?',
    [campaignId],
  ) as any;
  return row?.updated_at || fallback;
}

function describeRelationBriefly(relation: string): string {
  switch (relation) {
    case 'hated':        return 'enemies';
    case 'hostile':      return 'hostile';
    case 'wary':         return 'wary';
    case 'neutral':      return 'neutral';
    case 'unknown':      return 'unknown';
    case 'grudging_ally': return 'grudging allies';
    case 'ally':         return 'allies';
    default:             return relation;
  }
}

function capitaliseFaction(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}
