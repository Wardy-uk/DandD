/**
 * nightlyGrowth.ts — World Simulation Engine
 *
 * Runs between sessions. Makes the world feel like it keeps moving
 * whether the player is there or not.
 *
 * The AI content buffer (new scenes / NPCs / lore) lives in ai/nightlyGrowth.ts.
 * This file owns world *state* changes:
 *   - Faction drift
 *   - Rival delver movement
 *   - Companion developments
 *   - World events
 *   - Rumour generation
 *   - Lore reveals
 */

import { v4 as uuid } from 'uuid';
import type { Database } from 'sql.js';
import { get, all, run } from '../db/helpers.js';
import {
  getCampaignState,
  saveCampaignState,
  noteCampaignEvent,
  type CampaignSimulationState,
  type NightlyWorldEvent,
} from './campaignState.js';
import { getAllRivals } from './rivals.js';
import { getEscalationLevel } from './factions.js';
import { aiDirector } from '../ai/director.js';

// ─── Public result type ────────────────────────────────────────────────────────

export interface NightlyGrowthResult {
  campaignId: string;
  factionChanges: string[];
  rivalUpdates: string[];
  companionBeats: string[];
  worldEvents: NightlyWorldEvent[];
  rumourCount: number;
  loreReveal: boolean;
  dawnSummary: string;
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export async function runNightlyGrowth(
  db: Database,
  campaignId: string,
): Promise<NightlyGrowthResult> {
  const campaign = get(db, 'SELECT * FROM campaigns WHERE id = ?', [campaignId]) as any;
  if (!campaign) throw new Error(`Campaign ${campaignId} not found`);

  const state = getCampaignState(db, campaignId);

  const result: NightlyGrowthResult = {
    campaignId,
    factionChanges: [],
    rivalUpdates: [],
    companionBeats: [],
    worldEvents: [],
    rumourCount: 0,
    loreReveal: false,
    dawnSummary: '',
  };

  // ── 1. Faction drift ────────────────────────────────────────────────────────
  result.factionChanges = applyFactionDrift(state);

  // ── 2. Rival overnight movement ─────────────────────────────────────────────
  result.rivalUpdates = advanceRivalsOvernight(db, campaignId, campaign, state);

  // ── 3. Companion developments ───────────────────────────────────────────────
  result.companionBeats = processCompanionDevelopments(db, campaignId, state);

  // ── 4. Save deterministic state changes ─────────────────────────────────────
  saveCampaignState(db, campaignId, state);

  // ── 5. AI: world events + rumours + possible lore reveal ────────────────────
  try {
    const aiContent = await generateOvernightContent(db, campaignId, campaign, state, result);
    result.worldEvents = aiContent.events;
    result.rumourCount = aiContent.rumourCount;
    result.loreReveal = aiContent.loreReveal;

    // Store world events in campaign state for injection on next scene entry
    state.nightlyGrowth.pendingWorldEvents.push(...aiContent.events);
    if (state.nightlyGrowth.pendingWorldEvents.length > 4) {
      state.nightlyGrowth.pendingWorldEvents = state.nightlyGrowth.pendingWorldEvents.slice(-4);
    }
  } catch (aiErr) {
    console.error('[Nightly Growth] AI generation failed:', aiErr);
    // Non-fatal — deterministic changes already applied above
  }

  // ── 6. Dawn summary ─────────────────────────────────────────────────────────
  result.dawnSummary = buildDawnSummary(result, campaign);

  // Store in campaign state for surface on next session join
  state.nightlyGrowth.pendingDawnSummary = result.dawnSummary || null;

  // Rolling log (keep last 5 nights)
  state.nightlyGrowth.nightlyLog.push({
    at: new Date().toISOString(),
    summary: result.dawnSummary,
    details: [
      ...result.factionChanges,
      ...result.rivalUpdates,
      ...result.companionBeats,
      ...result.worldEvents.map((e) => e.text),
    ],
  });
  if (state.nightlyGrowth.nightlyLog.length > 5) {
    state.nightlyGrowth.nightlyLog = state.nightlyGrowth.nightlyLog.slice(-5);
  }

  saveCampaignState(db, campaignId, state);

  // ── 7. Write to game log ─────────────────────────────────────────────────────
  if (result.dawnSummary) {
    run(db,
      'INSERT INTO game_log (id, campaign_id, type, actor, content) VALUES (?, ?, ?, ?, ?)',
      [uuid(), campaignId, 'system', 'World', `[Overnight] ${result.dawnSummary}`]);
  }

  // ── 8. Mark run timestamp ────────────────────────────────────────────────────
  run(db, 'UPDATE campaigns SET last_nightly_run_at = datetime("now") WHERE id = ?', [campaignId]);

  return result;
}

// ─── Faction drift ────────────────────────────────────────────────────────────

function applyFactionDrift(state: CampaignSimulationState): string[] {
  const changes: string[] = [];

  for (const [key, faction] of Object.entries(state.factions)) {
    const escalation = getEscalationLevel(faction.heat);
    const wasEngagedRecently = state.recentEvents.some((e) =>
      e.toLowerCase().includes(faction.name.toLowerCase()) ||
      e.toLowerCase().includes(key.toLowerCase()),
    );

    // Heat management
    if (faction.heat > 0 && !wasEngagedRecently) {
      // Cooling off — no pressure, heat drops
      const coolBy = escalation === 'manhunt' ? 1 : escalation === 'hunting' ? 1 : 1;
      faction.heat = Math.max(0, faction.heat - coolBy);
      if (faction.heat < 6 && escalation === 'hunting') {
        changes.push(`${faction.name} patrols ease off. The search slows down.`);
      }
    } else if (faction.heat >= 7 && wasEngagedRecently) {
      // Still on the boil — escalate further
      faction.heat = Math.min(12, faction.heat + 1);
      changes.push(`${faction.name} are burning hotter. Word has spread.`);
    }

    // Reputation drift toward neutral if no recent positive contact
    if (faction.reputation > 3 && !wasEngagedRecently) {
      faction.reputation = Math.max(3, faction.reputation - 1);
    } else if (faction.reputation < -3 && !wasEngagedRecently) {
      // Long-standing hatred softens very slowly
      if (Math.random() < 0.15) {
        faction.reputation = Math.min(-3, faction.reputation + 1);
      }
    }

    state.factions[key] = faction;
  }

  // Alliance/rivalry shifts — check if two factions have strongly diverged standings
  const factionList = Object.entries(state.factions);
  for (let i = 0; i < factionList.length; i++) {
    for (let j = i + 1; j < factionList.length; j++) {
      const [keyA, fA] = factionList[i];
      const [keyB, fB] = factionList[j];
      const repGap = Math.abs(fA.reputation - fB.reputation);
      if (repGap >= 8) {
        // Factions with wildly different standings toward the party start moving against each other
        const dominant = fA.reputation > fB.reputation ? fA : fB;
        const weaker   = fA.reputation > fB.reputation ? fB : fA;
        noteCampaignEvent(state, `Tension between ${dominant.name} and ${weaker.name} grows — the party's choices have split them.`);
      }
    }
  }

  return changes;
}

// ─── Rival overnight movement ─────────────────────────────────────────────────

function advanceRivalsOvernight(
  db: Database,
  campaignId: string,
  campaign: any,
  state: CampaignSimulationState,
): string[] {
  const notes: string[] = [];
  const rivals = getAllRivals(db, campaignId);
  const currentTurn = Number(campaign.exploration_turn || 0);
  const currentSceneId = campaign.current_scene_id || '';

  for (const rival of rivals) {
    if (rival.status === 'defeated') continue;

    if (rival.status === 'retreated') {
      if (currentTurn + 8 >= rival.returnsAtTurn) {
        // Returning soon — leave a trace
        notes.push(`Tracks near the entrance. ${rival.name} is working their way back in.`);
      }
      continue;
    }

    // Active rivals make 2-3 moves overnight — simulate by looting nearby scenes
    const unvisited = getUnvisitedScenes(db, campaignId, currentSceneId, 4);
    let moved = 0;
    for (const scene of unvisited.slice(0, 2 + Math.floor(Math.random() * 2))) {
      if (rivalLootedAlready(rival, scene.id)) continue;

      // Loot this scene
      const lootGained = markSceneRivalLooted(db, scene.id, rival.strength);
      if (lootGained > 0) {
        rival.lootedScenes = [...(rival.lootedScenes || []), scene.id];
        rival.treasure = (rival.treasure || 0) + lootGained;
        moved++;
      }
    }

    if (moved > 0) {
      notes.push(`${rival.name} has been through ${moved} area${moved > 1 ? 's' : ''} ahead of you — expect thin pickings.`);
    }

    // Heavy-laden rivals retreat overnight
    if ((rival.treasure || 0) >= (rival.strength || 1) * 50) {
      run(db, `
        UPDATE rival_parties
        SET state_json = json_patch(state_json, json('{"status":"retreated","returnsAtTurn":${currentTurn + 6},"retreatCount":${(rival.retreatCount || 0) + 1}}'))
        WHERE id = ?
      `, [rival.id]);
      notes.push(`${rival.name} pulls out before dawn, packs heavy. They will be back.`);
    } else if (moved > 0) {
      // Save the loot/scene updates
      const updatedState = { ...rival };
      run(db, 'UPDATE rival_parties SET state_json = ?, updated_at = datetime("now") WHERE id = ?',
        [JSON.stringify(updatedState), rival.id]);
    }
  }

  return notes;
}

function getUnvisitedScenes(
  db: Database,
  campaignId: string,
  avoidSceneId: string,
  limit: number,
): Array<{ id: string; name: string }> {
  return all(db,
    'SELECT id, name FROM scenes WHERE campaign_id = ? AND visited = 0 AND id != ? LIMIT ?',
    [campaignId, avoidSceneId, limit]) as any[];
}

function rivalLootedAlready(rival: any, sceneId: string): boolean {
  const looted: string[] = rival.lootedScenes || [];
  return looted.includes(sceneId);
}

function markSceneRivalLooted(db: Database, sceneId: string, strength: number): number {
  const scene = get(db, 'SELECT notes FROM scenes WHERE id = ?', [sceneId]) as any;
  if (!scene) return 0;
  if ((scene.notes || '').includes('[RIVAL_LOOTED]')) return 0;
  const loot = Math.max(0, 10 + (strength || 1) * 5 + Math.floor(Math.random() * 20));
  const note = `${scene.notes || ''} [RIVAL_LOOTED:${loot}gp]`.trim();
  run(db, 'UPDATE scenes SET notes = ? WHERE id = ?', [note, sceneId]);
  return loot;
}

// ─── Companion developments ───────────────────────────────────────────────────

function processCompanionDevelopments(
  db: Database,
  campaignId: string,
  state: CampaignSimulationState,
): string[] {
  const companions = all(db,
    'SELECT * FROM npcs WHERE campaign_id = ? AND joined_party = 1 AND alive = 1',
    [campaignId]) as any[];

  const beats: string[] = [];

  for (const comp of companions) {
    let rel: any = {};
    try { rel = JSON.parse(comp.relationship_state || '{}'); } catch {}

    let changed = false;

    // Tension recovery overnight — a night's rest takes the edge off
    if ((rel.tension || 0) > 0) {
      rel.tension = Math.max(0, (rel.tension || 0) - 1);
      changed = true;
    }

    // Morale shift based on last camp quality
    if (state.delve.campQuality === 'fortified' || state.delve.campQuality === 'good') {
      if ((rel.morale || 5) < 8) {
        rel.morale = Math.min(8, (rel.morale || 5) + 1);
        changed = true;
      }
    } else if (state.delve.campQuality === 'poor') {
      if ((rel.morale || 5) > 2) {
        rel.morale = Math.max(2, (rel.morale || 5) - 1);
        changed = true;
      }
    }

    // Personal quest slow burn — 12% chance per night to edge forward
    if (!rel.personalQuestResolved && (rel.personalQuestProgress || 0) < 3) {
      if (Math.random() < 0.12) {
        rel.personalQuestProgress = (rel.personalQuestProgress || 0) + 1;
        const progressNote = buildCompanionQuestBeat(comp, rel);
        rel.lastBeat = progressNote;  // surfaces in companion panel
        beats.push(progressNote);
        changed = true;
      }
    }

    // Morale-driven note — companion makes a request or sends a signal
    if ((rel.morale || 5) >= 8 && (rel.trust || 0) >= 4 && Math.random() < 0.15) {
      const note = buildCompanionHighMoraleNote(comp);
      rel.lastBeat = note;
      beats.push(note);
      changed = true;
    } else if ((rel.morale || 5) <= 2 && Math.random() < 0.20) {
      const note = buildCompanionLowMoraleNote(comp);
      rel.lastBeat = note;
      beats.push(note);
      changed = true;
    }

    if (changed) {
      run(db, 'UPDATE npcs SET relationship_state = ? WHERE id = ?',
        [JSON.stringify(rel), comp.id]);
    }
  }

  return beats;
}

function buildCompanionQuestBeat(comp: any, rel: any): string {
  const progress = rel.personalQuestProgress || 1;
  const quest = comp.personality ? ` (${comp.personality.split('.')[0].trim()})` : '';
  if (progress === 1) return `${comp.name} is quiet through the night${quest}. Something personal is weighing on them.`;
  if (progress === 2) return `${comp.name} brings it up in the small hours. The path forward on their quest is getting clearer.`;
  return `${comp.name} is ready. Their personal matter comes to a head — they will need the party's help soon.`;
}

function buildCompanionHighMoraleNote(comp: any): string {
  const lines = [
    `${comp.name} is in good spirits. They leave a note with the watch: they are ready for whatever is ahead.`,
    `${comp.name} sharpens their gear before dawn. High morale — this one is locked in.`,
    `${comp.name} seeks you out before the others wake. They have an idea. It is worth hearing.`,
  ];
  return lines[Math.floor(Math.random() * lines.length)];
}

function buildCompanionLowMoraleNote(comp: any): string {
  const lines = [
    `${comp.name} barely slept. They are holding together, but the cracks are showing.`,
    `${comp.name} is distant this morning. Something is eating at them — they will not say what yet.`,
    `${comp.name} asks quietly whether the party intends to press on or cut losses. They are not threatening. Just asking.`,
  ];
  return lines[Math.floor(Math.random() * lines.length)];
}

// ─── AI: world events + rumours + lore reveal ─────────────────────────────────

interface OvernightAIContent {
  events: NightlyWorldEvent[];
  rumourCount: number;
  loreReveal: boolean;
}

async function generateOvernightContent(
  db: Database,
  campaignId: string,
  campaign: any,
  state: CampaignSimulationState,
  result: NightlyGrowthResult,
): Promise<OvernightAIContent> {
  const loreFragments = all(db,
    'SELECT category, title, content FROM world_lore WHERE campaign_id = ? ORDER BY created_at DESC LIMIT 10',
    [campaignId]) as any[];

  const recentLog = all(db,
    'SELECT actor, content FROM game_log WHERE campaign_id = ? ORDER BY timestamp DESC LIMIT 8',
    [campaignId]) as any[];

  const factionSummary = Object.entries(state.factions)
    .map(([k, f]) => `${f.name}: rep ${f.reputation}, heat ${f.heat} (${getEscalationLevel(f.heat)})`)
    .join('\n');

  const loreSummary = loreFragments.length > 0
    ? loreFragments.map((l) => `[${l.category}] ${l.title}: ${l.content.slice(0, 80)}…`).join('\n')
    : 'None yet.';

  const recentPlay = recentLog.reverse()
    .map((l: any) => `${l.actor}: ${String(l.content).slice(0, 60)}`)
    .join('\n');

  const prompt = `You are the world engine for an AD&D 2e campaign — ${campaign.name}.
The party rested overnight. Generate what changed in the world while they slept.

SETTING: ${campaign.setting || 'Classic fantasy frontier'}
SESSION: ${campaign.session_number || 1}

RECENT PLAY (last session):
${recentPlay || 'No log yet.'}

FACTION STATE:
${factionSummary}

LORE FRAGMENTS (${loreFragments.length}):
${loreSummary}

Return STRICT JSON — no markdown, no commentary:
{
  "events": [
    {
      "type": "collapse|merchant|bounty|wanderer|omen",
      "text": "2-4 sentences. DM voice. Present tense. Punchy. No passive voice. Specific detail."
    }
  ],
  "rumours": [
    {
      "text": "One sentence. What someone is saying in town or camp. Specific.",
      "truth": "true|false|partial"
    }
  ],
  "lore_reveal": null
}

RULES:
- Max 2 events. Can be 0 if nothing plausible.
- 1-3 rumours. Some true, some false, some half-right.
- lore_reveal: null unless ${loreFragments.length} >= 3 — then 2-3 sentences connecting threads, DM voice.
- Every sentence sounds like a DM speaking at a table.
- Short sentences. Active voice. Present tense.`;

  const raw = await aiDirector.enqueueAndWait({
    campaignId,
    type: 'world_gen',
    priority: 5,
    prompt,
    format: 'json',
  });

  const parsed = parseOvernightJSON(raw);

  // Store world events
  const events: NightlyWorldEvent[] = (parsed.events || []).slice(0, 2).map((e: any) => ({
    id: uuid(),
    type: String(e.type || 'event'),
    text: String(e.text || ''),
    injected: false,
    createdAt: new Date().toISOString(),
  }));

  // Store rumours in DB
  const rumours: Array<{ text: string; truth: string }> = (parsed.rumours || []).slice(0, 3);
  for (const r of rumours) {
    if (!r.text) continue;
    run(db,
      'INSERT INTO campaign_rumours (id, campaign_id, text, truth_level, discovered, source) VALUES (?, ?, ?, ?, 0, ?)',
      [uuid(), campaignId, String(r.text), String(r.truth || 'partial'), 'nightly']);
  }

  // Lore reveal — store in world_lore
  let loreReveal = false;
  if (parsed.lore_reveal && typeof parsed.lore_reveal === 'string' && loreFragments.length >= 3) {
    run(db,
      'INSERT INTO world_lore (id, campaign_id, category, title, content) VALUES (?, ?, ?, ?, ?)',
      [uuid(), campaignId, 'revelation', 'A Thread Becomes Clear', parsed.lore_reveal]);
    loreReveal = true;
  }

  return { events, rumourCount: rumours.length, loreReveal };
}

function parseOvernightJSON(raw: string): any {
  try {
    const cleaned = raw.replace(/```json|```/gi, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return { events: [], rumours: [], lore_reveal: null };
  }
}

// ─── Dawn summary ─────────────────────────────────────────────────────────────

function buildDawnSummary(result: NightlyGrowthResult, campaign: any): string {
  const parts: string[] = [];

  if (result.factionChanges.length > 0) parts.push(result.factionChanges[0]);
  if (result.rivalUpdates.length > 0)   parts.push(result.rivalUpdates[0]);
  if (result.worldEvents.length > 0)    parts.push(result.worldEvents[0].text);
  if (result.companionBeats.length > 0) parts.push(result.companionBeats[0]);

  if (result.rumourCount > 0) {
    parts.push(`Word is moving. ${result.rumourCount} rumour${result.rumourCount > 1 ? 's' : ''} worth listening for.`);
  }
  if (result.loreReveal) {
    parts.push('Something that was hidden is starting to make sense.');
  }

  if (parts.length === 0) return '';

  const name = campaign?.name ? `In ${campaign.name}: ` : '';
  return `${name}Dawn breaks. ${parts.join(' ')}`;
}

// ─── Rumour surfacing (called from socket.ts on rest / NPC talk) ──────────────

/**
 * Pull up to `count` undiscovered rumours and mark them discovered.
 * Returns the rumour texts for narration.
 */
export function surfaceRumours(db: Database, campaignId: string, count = 1): string[] {
  const rumours = all(db,
    'SELECT id, text FROM campaign_rumours WHERE campaign_id = ? AND discovered = 0 ORDER BY created_at ASC LIMIT ?',
    [campaignId, count]) as any[];

  if (rumours.length === 0) return [];

  for (const r of rumours) {
    run(db, 'UPDATE campaign_rumours SET discovered = 1 WHERE id = ?', [r.id]);
  }

  return rumours.map((r: any) => String(r.text));
}

/**
 * Pop and return the pending world events that haven't been injected yet.
 * Marks them injected. Call on scene entry.
 */
export function popPendingWorldEvents(db: Database, campaignId: string): string[] {
  const state = getCampaignState(db, campaignId);
  const pending = state.nightlyGrowth.pendingWorldEvents.filter((e) => !e.injected);
  if (pending.length === 0) return [];

  // Inject the first one only — don't dump everything at once
  const toInject = pending[0];
  toInject.injected = true;
  saveCampaignState(db, campaignId, state);

  return [toInject.text];
}

/**
 * Pop and clear the pending dawn summary.
 * Call when player joins a campaign session.
 */
export function popDawnSummary(db: Database, campaignId: string): string | null {
  const state = getCampaignState(db, campaignId);
  const summary = state.nightlyGrowth.pendingDawnSummary;
  if (!summary) return null;

  state.nightlyGrowth.pendingDawnSummary = null;
  saveCampaignState(db, campaignId, state);
  return summary;
}

/**
 * Get the nightly log for admin/diagnostic use.
 */
export function getNightlyLog(db: Database, campaignId: string) {
  const state = getCampaignState(db, campaignId);
  return state.nightlyGrowth.nightlyLog;
}
