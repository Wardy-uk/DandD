/**
 * rivals.ts — Rival Delver Party System
 *
 * NPC rival parties that behave like actual dungeon competitors:
 *  - Loot rooms the player hasn't reached
 *  - Retreat with treasure when threatened
 *  - Return persistently; remember prior clashes
 *  - Become hated rivals or grudging allies based on history
 *  - Connect into faction heat / reputation (delvers faction)
 *
 * Deterministic-first. AI used only for narration enrichment.
 */

import { v4 as uuid } from 'uuid';
import type { Database } from 'sql.js';
import { all, get, run } from '../db/helpers.js';
import { getCampaignState, saveCampaignState, shiftFactionStanding, noteCampaignEvent } from './campaignState.js';
import { d20, roll } from '../engine/dice.js';

// ─── Types ────────────────────────────────────────────────────────────────────

type RivalRelation = 'unknown' | 'neutral' | 'wary' | 'hostile' | 'hated' | 'grudging_ally' | 'ally';
type RivalStatus   = 'active' | 'retreated' | 'defeated' | 'parleying';

export interface RivalParty {
  id: string;
  campaignId: string;
  name: string;                   // e.g. "The Iron Spur Company"
  size: number;                   // 2–5 delvers
  strength: number;               // 1–10 combat effectiveness
  treasure: number;               // gp-equivalent loot carried
  currentSceneId: string | null;  // where they are right now
  status: RivalStatus;
  relation: RivalRelation;
  clashCount: number;             // number of direct confrontations
  retreatCount: number;           // times they've fled from the party
  lootedScenes: string[];         // scene IDs they've stripped
  memory: string[];               // up to 6 memorable beats
  lastSeenTurn: number;           // exploration turn when last encountered
  returnsAtTurn: number;          // earliest turn they may re-enter
}

// ─── Schema migration (call from initDb or runMigrations) ────────────────────

export function migrateRivalSchema(db: Database) {
  db.run(`
    CREATE TABLE IF NOT EXISTS rival_parties (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      state_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
  try { db.run('CREATE INDEX IF NOT EXISTS idx_rivals_campaign ON rival_parties(campaign_id)'); } catch {}
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

function saveRival(db: Database, rival: RivalParty) {
  run(db, `
    INSERT OR REPLACE INTO rival_parties (id, campaign_id, state_json, updated_at)
    VALUES (?, ?, ?, datetime('now'))
  `, [rival.id, rival.campaignId, JSON.stringify(rival)]);
}

function loadRivals(db: Database, campaignId: string): RivalParty[] {
  const rows = all(db, 'SELECT state_json FROM rival_parties WHERE campaign_id = ?', [campaignId]) as any[];
  return rows.map((r) => JSON.parse(r.state_json) as RivalParty);
}

function loadRival(db: Database, rivalId: string): RivalParty | null {
  const row = get(db, 'SELECT state_json FROM rival_parties WHERE id = ?', [rivalId]) as any;
  return row ? JSON.parse(row.state_json) as RivalParty : null;
}

// ─── Name generation ─────────────────────────────────────────────────────────

const RIVAL_ADJECTIVES = [
  'Iron', 'Broken', 'Scarred', 'Grey', 'Black', 'Gilded', 'Pale', 'Cracked', 'Hollow',
  'Brass', 'Copper', 'Ash', 'Salt', 'Stone', 'Red', 'Rust', 'Murky',
];
const RIVAL_NOUNS = [
  'Spur', 'Company', 'Hand', 'Lance', 'Badge', 'Warrant', 'Brand', 'Sigil',
  'Hook', 'Pact', 'Venture', 'Charter', 'Guild', 'Delve', 'Crew',
];

function generateRivalName(seed: number): string {
  const adj = RIVAL_ADJECTIVES[seed % RIVAL_ADJECTIVES.length];
  const noun = RIVAL_NOUNS[Math.floor(seed / RIVAL_ADJECTIVES.length) % RIVAL_NOUNS.length];
  return `The ${adj} ${noun}`;
}

// ─── Spawning ─────────────────────────────────────────────────────────────────

/**
 * Seed a rival party into the campaign if fewer than maxRivals exist.
 * Called on scene entry or at turn thresholds.
 */
export function seedRivalPartyIfNeeded(params: {
  db: Database;
  campaignId: string;
  currentSceneId: string;
  explorationTurn: number;
  dangerLevel: number;
  maxRivals?: number;
}): RivalParty | null {
  const { db, campaignId, currentSceneId, explorationTurn, dangerLevel, maxRivals = 2 } = params;

  const existing = loadRivals(db, campaignId).filter((r) => r.status === 'active' || r.status === 'retreated');
  if (existing.length >= maxRivals) return null;

  // Spawn chance: base 15%, +5% per danger level, capped at 60%
  const spawnChance = Math.min(60, 15 + (dangerLevel - 1) * 5);
  if ((d20() * 5) > spawnChance) return null;   // d20*5 gives 5–100

  const seed = hashSeed(`${campaignId}:${explorationTurn}:${existing.length}`);
  const size = 2 + (seed % 4);                  // 2–5
  const strength = Math.max(1, Math.min(10, dangerLevel + (seed % 4) - 1));

  const rival: RivalParty = {
    id: uuid(),
    campaignId,
    name: generateRivalName(seed),
    size,
    strength,
    treasure: 0,
    currentSceneId: null,  // start off-map; moves in next turn
    status: 'active',
    relation: 'unknown',
    clashCount: 0,
    retreatCount: 0,
    lootedScenes: [],
    memory: [`${generateRivalName(seed)} was spotted working the same dungeon.`],
    lastSeenTurn: explorationTurn,
    returnsAtTurn: explorationTurn,
  };

  saveRival(db, rival);
  return rival;
}

// ─── Rival movement (called each exploration turn) ───────────────────────────

/**
 * Advance all active rivals: move them around the map, loot rooms, maybe retreat.
 * Returns narration notes for anything that affects the player.
 */
export function tickRivals(params: {
  db: Database;
  campaignId: string;
  currentSceneId: string;
  explorationTurn: number;
}): string[] {
  const { db, campaignId, currentSceneId, explorationTurn } = params;

  const rivals = loadRivals(db, campaignId);
  const notes: string[] = [];

  for (const rival of rivals) {
    // Retreated rivals return after a cooldown
    if (rival.status === 'retreated') {
      if (explorationTurn >= rival.returnsAtTurn) {
        rival.status = 'active';
        rival.currentSceneId = null;  // re-enter from off-map
        rival.memory.push(`${rival.name} regrouped and came back.`);
        trimMemory(rival);
        saveRival(db, rival);
        notes.push(`Tracks and tool-marks in the dust suggest ${rival.name} has returned to work the dungeon again.`);
      }
      continue;
    }

    if (rival.status !== 'active') continue;

    // Pursuit mode: hated rivals track the player directly
    if (rival.relation === 'hated' && rival.clashCount >= 3) {
      const wasHere = rival.currentSceneId === currentSceneId;
      rival.currentSceneId = currentSceneId;
      rival.lastSeenTurn = explorationTurn;
      if (!wasHere) {
        notes.push(`${rival.name} has not forgotten what happened between you. They are in the same dungeon — and this time they came looking.`);
      }
      saveRival(db, rival);
      continue;
    }

    // Move rival to an adjacent unvisited scene if possible
    const candidateScenes = findUnvisitedAdjacentScenes(db, campaignId, rival.currentSceneId, currentSceneId);

    if (candidateScenes.length > 0) {
      const targetScene = candidateScenes[explorationTurn % candidateScenes.length];
      rival.currentSceneId = targetScene.id;
      rival.lastSeenTurn = explorationTurn;

      // Loot the scene if not already looted and not the player's current scene
      if (targetScene.id !== currentSceneId && !rival.lootedScenes.includes(targetScene.id)) {
        const lootGained = lootScene(db, campaignId, targetScene.id, rival.strength);
        if (lootGained > 0) {
          rival.treasure += lootGained;
          rival.lootedScenes.push(targetScene.id);
          notes.push(`${rival.name} has been through ${targetScene.name} ahead of you — pickings there will be thin.`);
        }
      }
    }

    // Heavy-laden rivals retreat: carrying more than strength × 50 gp
    if (rival.treasure >= rival.strength * 50 && rival.status === 'active') {
      rival.status = 'retreated';
      rival.returnsAtTurn = explorationTurn + 4 + (rival.retreatCount * 2);
      rival.retreatCount += 1;
      rival.memory.push(`${rival.name} withdrew with a heavy load — ${rival.treasure} gp equivalent.`);
      trimMemory(rival);
      if (rival.currentSceneId === currentSceneId) {
        notes.push(`${rival.name} moves through quickly, loaded down with loot. They are not looking for a fight today.`);
      } else {
        notes.push(`Signs suggest ${rival.name} pulled out recently, packs full.`);
      }
    }

    saveRival(db, rival);
  }

  return notes;
}

// ─── Clash resolution ─────────────────────────────────────────────────────────

/**
 * Resolve a confrontation between the player party and a rival party in the same scene.
 * Returns narration + relation shifts.
 */
export function resolveRivalClash(params: {
  db: Database;
  campaignId: string;
  rivalId: string;
  partyStrength: number;      // derived from party modifiers
  leaderName: string;
  clashType: 'fight' | 'parley' | 'intimidate' | 'ignore' | 'request_intel';
}): { notes: string[]; rival: RivalParty } {
  const { db, campaignId, rivalId, partyStrength, leaderName, clashType } = params;
  const rival = loadRival(db, rivalId);
  if (!rival) return { notes: [], rival: { id: rivalId } as any };

  const notes: string[] = [];
  const state = getCampaignState(db, campaignId);

  rival.clashCount += 1;
  rival.lastSeenTurn = Number((get(db, 'SELECT exploration_turn FROM campaigns WHERE id = ?', [campaignId]) as any)?.exploration_turn || 0);

  if (clashType === 'fight') {
    const partyWins = partyStrength >= rival.strength;
    if (partyWins) {
      rival.treasure = Math.floor(rival.treasure * 0.5);  // half their loot spills
      rival.strength = Math.max(1, rival.strength - 1);
      rival.status = 'retreated';
      rival.returnsAtTurn = rival.lastSeenTurn + 6 + rival.retreatCount * 2;
      rival.retreatCount += 1;
      rival.memory.push(`Driven off by ${leaderName}'s company in a hard clash. Lost half the haul.`);

      if (rival.clashCount >= 3) {
        rival.relation = rival.relation === 'grudging_ally' ? 'grudging_ally' : 'hated';
        notes.push(`${rival.name} retreats in disorder, having learned what ${leaderName}'s company costs them. The hatred between the groups is now mutual and known.`);
      } else {
        rival.relation = shiftRelation(rival.relation, -1);
        notes.push(`${rival.name} breaks and retreats with what they can carry. The fight was real, and they will remember it.`);
      }

      // Spilled loot becomes treasure in the scene
      if (rival.treasure > 0) {
        notes.push(`${rival.name} left behind roughly ${Math.floor(rival.treasure * 0.5)} gp worth of loot in their haste.`);
        injectSceneLoot(db, campaignId, rival.currentSceneId, Math.floor(rival.treasure * 0.5));
        rival.treasure = Math.floor(rival.treasure * 0.5);
      }

      shiftFactionStanding(state, 'delvers', { heat: 2 }, `Drove off ${rival.name}`);
    } else {
      rival.relation = shiftRelation(rival.relation, -2);
      notes.push(`${rival.name} holds their ground and pushes your company back — they are better at this than they look.`);
      shiftFactionStanding(state, 'delvers', { heat: 1 }, `Clashed with ${rival.name} and came off worse`);
    }
  } else if (clashType === 'parley') {
    if (rival.relation === 'hated' || rival.relation === 'hostile') {
      notes.push(`${rival.name} does not parley with ${leaderName}. The history between you is too sharp for that now.`);
    } else {
      rival.relation = shiftRelation(rival.relation, +1);
      rival.memory.push(`Talked terms with ${leaderName}'s company instead of fighting.`);
      notes.push(`${rival.name} and ${leaderName}'s company exchange brief, careful words. Nothing is settled, but the knives stay sheathed.`);
      if (rival.relation === 'grudging_ally' || rival.relation === 'ally') {
        notes.push(`${rival.name} shares a quick tip about what is ahead — not generosity, exactly, but pragmatism.`);
        shiftFactionStanding(state, 'delvers', { reputation: 1 }, `Parleyed successfully with ${rival.name}`);
      }
    }
  } else if (clashType === 'intimidate') {
    const succeeds = partyStrength > rival.strength + 2;
    if (succeeds) {
      rival.status = 'retreated';
      rival.returnsAtTurn = rival.lastSeenTurn + 3;
      rival.relation = shiftRelation(rival.relation, -1);
      notes.push(`${rival.name} reads the room correctly and gives ground without making it a fight. They are not gone, just out of the way for now.`);
    } else {
      rival.relation = shiftRelation(rival.relation, -1);
      notes.push(`${rival.name} does not scare easily. The attempt to intimidate them lands badly.`);
    }
  } else if (clashType === 'request_intel') {
    if (rival.relation === 'ally' || rival.relation === 'grudging_ally') {
      const sceneNames = rival.lootedScenes
        .map(sId => (get(db, 'SELECT name FROM scenes WHERE id = ?', [sId]) as any)?.name)
        .filter(Boolean) as string[];
      if (sceneNames.length > 0) {
        const sceneList = sceneNames.slice(0, 4).join(', ');
        const coverage = sceneNames.length >= 3 ? 'Most of it stripped already.' : 'Limited coverage so far.';
        notes.push(`${rival.name} pauses. "We've worked through ${sceneList}. ${coverage} Your call on what's left."`);
      } else {
        notes.push(`${rival.name} shrugs. "Nothing worth reporting. We haven't found much ourselves."`);
      }
      rival.memory.push(`Shared scene intel with ${leaderName}.`);
    } else {
      notes.push(`${rival.name} looks at you like you've asked for their purse. Information is not something they're giving away.`);
    }
  } else {
    // ignore — neither side engages
    notes.push(`${leaderName}'s company and ${rival.name} move around each other with studied disinterest.`);
  }

  trimMemory(rival);
  saveRival(db, rival);
  saveCampaignState(db, campaignId, state);
  noteCampaignEvent(state, `Encounter with ${rival.name} — ${clashType}`);

  return { notes, rival };
}

// ─── Rival presence check (call on scene entry) ──────────────────────────────

/**
 * Check whether any active rival is in the player's current scene.
 * Returns any rivals present + presence narration.
 */
export function checkRivalPresence(params: {
  db: Database;
  campaignId: string;
  sceneId: string;
  explorationTurn: number;
}): { rivals: RivalParty[]; notes: string[] } {
  const { db, campaignId, sceneId, explorationTurn } = params;

  const rivals = loadRivals(db, campaignId).filter(
    (r) => r.status === 'active' && r.currentSceneId === sceneId,
  );
  const notes: string[] = [];

  for (const rival of rivals) {
    const relationDesc = describeRelation(rival.relation);
    if (rival.relation === 'hated') {
      notes.push(`${rival.name} is here. They are not in a talking mood. After everything between you, this was always going to end badly.`);
    } else if (rival.relation === 'unknown') {
      notes.push(`Another delver company is here — ${rival.name}, ${rival.size} strong. ${rival.size >= 4 ? 'They look capable.' : 'They look stretched.'} You have not crossed paths before.`);
    } else {
      notes.push(`${rival.name} is here. ${relationDesc} The air between the two companies shifts the moment eyes meet.`);
    }
    rival.lastSeenTurn = explorationTurn;
    saveRival(db, rival);
  }

  return { rivals, notes };
}

// ─── Public query ─────────────────────────────────────────────────────────────

export function getAllRivals(db: Database, campaignId: string): RivalParty[] {
  return loadRivals(db, campaignId);
}

export function getRivalById(db: Database, rivalId: string): RivalParty | null {
  return loadRival(db, rivalId);
}

// ─── Private helpers ──────────────────────────────────────────────────────────

function findUnvisitedAdjacentScenes(
  db: Database,
  campaignId: string,
  fromSceneId: string | null,
  avoidSceneId: string,
): Array<{ id: string; name: string }> {
  // If rival has no location yet, find any unvisited scene
  if (!fromSceneId) {
    const rows = all(db,
      'SELECT id, name FROM scenes WHERE campaign_id = ? AND visited = 0 AND id != ? LIMIT 4',
      [campaignId, avoidSceneId]) as any[];
    return rows;
  }

  const scene = get(db, 'SELECT connections FROM scenes WHERE id = ?', [fromSceneId]) as any;
  if (!scene) return [];

  let connections: Array<{ targetSceneId: string }> = [];
  try { connections = JSON.parse(scene.connections || '[]'); } catch { return []; }

  const candidates: Array<{ id: string; name: string }> = [];
  for (const conn of connections) {
    if (!conn.targetSceneId || conn.targetSceneId === avoidSceneId) continue;
    const target = get(db, 'SELECT id, name, visited FROM scenes WHERE id = ?', [conn.targetSceneId]) as any;
    if (target && !target.visited) candidates.push({ id: target.id, name: target.name });
  }

  // Fall back to any unvisited scene in the campaign
  if (candidates.length === 0) {
    const rows = all(db,
      'SELECT id, name FROM scenes WHERE campaign_id = ? AND visited = 0 AND id != ? LIMIT 3',
      [campaignId, avoidSceneId]) as any[];
    return rows;
  }

  return candidates;
}

function lootScene(db: Database, campaignId: string, sceneId: string, strength: number): number {
  // Mark the scene as partially looted via its notes; return gp value removed
  const scene = get(db, 'SELECT notes FROM scenes WHERE id = ? AND campaign_id = ?', [sceneId, campaignId]) as any;
  if (!scene) return 0;
  if ((scene.notes || '').includes('[RIVAL_LOOTED]')) return 0;  // already stripped

  const loot = Math.max(0, 10 + strength * 5 + Math.floor(Math.random() * 20));
  const note = `${scene.notes || ''} [RIVAL_LOOTED:${loot}gp]`.trim();
  run(db, 'UPDATE scenes SET notes = ? WHERE id = ?', [note, sceneId]);
  return loot;
}

function injectSceneLoot(db: Database, campaignId: string, sceneId: string | null, gp: number) {
  if (!sceneId) return;
  const scene = get(db, 'SELECT notes FROM scenes WHERE id = ?', [sceneId]) as any;
  if (!scene) return;
  const note = `${scene.notes || ''} [SPILLED_LOOT:${gp}gp]`.trim();
  run(db, 'UPDATE scenes SET notes = ? WHERE id = ?', [note, sceneId]);
}

function shiftRelation(current: RivalRelation, delta: number): RivalRelation {
  const scale: RivalRelation[] = ['hated', 'hostile', 'wary', 'neutral', 'unknown', 'grudging_ally', 'ally'];
  const idx = scale.indexOf(current);
  const next = Math.max(0, Math.min(scale.length - 1, idx + delta));
  return scale[next];
}

function describeRelation(relation: RivalRelation): string {
  switch (relation) {
    case 'hated':        return 'You have driven them off before, and they have not forgotten it.';
    case 'hostile':      return 'There is bad blood here — not yet at open war, but close.';
    case 'wary':         return 'They are cautious around you, and you around them.';
    case 'neutral':      return 'Neither side has given the other strong reason for friendship or enmity.';
    case 'unknown':      return 'You have not met before.';
    case 'grudging_ally': return 'You have reached a grudging mutual understanding. It is not friendship.';
    case 'ally':         return 'A genuine working trust has developed between the two companies.';
  }
}

function trimMemory(rival: RivalParty) {
  if (rival.memory.length > 6) rival.memory = rival.memory.slice(-6);
}

function hashSeed(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) - hash) + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}
