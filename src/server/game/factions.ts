/**
 * factions.ts — Faction Escalation Loops (Task 5)
 *
 * Patrol density, bounty/manhunt states, encounter mix by standing,
 * parley openings at positive rep, and friendly faction benefits.
 */

import type { Database } from 'sql.js';
import {
  getCampaignState,
  saveCampaignState,
  shiftFactionStanding,
  noteCampaignEvent,
  type CampaignSimulationState,
  type FactionStanding,
} from './campaignState.js';
import { get, all, run } from '../db/helpers.js';

// ── Escalation tiers ────────────────────────────────────────────────────────

export type EscalationLevel = 'quiet' | 'alert' | 'hunting' | 'manhunt';

export function getEscalationLevel(heat: number): EscalationLevel {
  if (heat >= 9) return 'manhunt';
  if (heat >= 6) return 'hunting';
  if (heat >= 3) return 'alert';
  return 'quiet';
}

/** Extra dice added to the d6 encounter roll, by escalation level. */
export function getPatrolModifier(escalation: EscalationLevel): number {
  return { quiet: 0, alert: 1, hunting: 2, manhunt: 3 }[escalation];
}

/** Whether the faction can offer parley given current standing. */
export function canParley(faction: FactionStanding): boolean {
  return faction.reputation >= 2;
}

/** Whether the faction actively hates the party enough to strike first. */
export function willAmbush(faction: FactionStanding): boolean {
  return faction.reputation <= -5 || faction.heat >= 9;
}

// ── Encounter flavour by escalation ────────────────────────────────────────

export function describeFactionEscalation(
  factionName: string,
  escalation: EscalationLevel,
  reputation: number,
): string {
  if (escalation === 'manhunt') {
    return reputation <= -5
      ? `${factionName} have put a price on the party. These are bounty hunters, not patrols.`
      : `${factionName} are not patrolling any more — they are looking for someone. Probably you.`;
  }
  if (escalation === 'hunting') {
    return `${factionName} patrols are running double-strength and checking faces. The heat is up.`;
  }
  if (escalation === 'alert') {
    return `${factionName} are moving more than usual. Something has them stirred up.`;
  }
  return '';
}

export function describeSurpriseByEscalation(
  escalation: EscalationLevel,
  factionName: string,
): string {
  if (escalation === 'manhunt') {
    return `They come in from two angles — whoever briefed them described the party well.`;
  }
  if (escalation === 'hunting') {
    return `They spot you first. ${factionName} patrols are running hot and have the numbers to be bold about it.`;
  }
  if (escalation === 'alert') {
    return `They are moving with purpose and they see you before you see them.`;
  }
  return `You have just enough warning to realise this danger has been stalking the same dark as you.`;
}

// ── Parley resolution ───────────────────────────────────────────────────────

export interface ParleyOutcome {
  resolved: boolean;
  notes: string[];
  heatDelta: number;
  repDelta: number;
}

export function resolveParley(params: {
  state: CampaignSimulationState;
  factionKey: string;
  leaderCha: number;
  parleyAction: string;
}): ParleyOutcome {
  const { state, factionKey, leaderCha, parleyAction } = params;
  const faction = state.factions[factionKey];
  if (!faction) return { resolved: false, notes: [], heatDelta: 0, repDelta: 0 };

  const escalation = getEscalationLevel(faction.heat);
  const chaBonus = Math.floor((leaderCha - 10) / 2);
  // Roll 1d20 + cha bonus, modified by reputation and escalation
  const roll = Math.floor(Math.random() * 20) + 1 + chaBonus + Math.floor(faction.reputation / 2);
  const dc = escalation === 'manhunt' ? 20
           : escalation === 'hunting' ? 16
           : escalation === 'alert' ? 12
           : 8;

  const isHostile = faction.reputation <= -3;
  const isFriendly = faction.reputation >= 3;

  const notes: string[] = [];

  if (roll >= dc) {
    // Success
    const heatDelta = -Math.floor(faction.heat / 4 + 1);
    const repDelta = isFriendly ? 0 : 1;
    if (isFriendly) {
      notes.push(`${faction.name} welcome the approach. The tension in the room drops a notch.`);
      notes.push(`They share what they know about the area ahead — useful if you listen.`);
    } else if (isHostile) {
      notes.push(`${faction.name} are not friendly, but they hear the party out. Reluctant restraint.`);
      notes.push(`They make it plain: one more crossed line and this ceases to be a conversation.`);
    } else {
      notes.push(`${faction.name} let the party speak. The standoff ends without bloodshed.`);
    }
    noteCampaignEvent(state, `Party parlayed successfully with ${faction.name}.`);
    return { resolved: true, notes, heatDelta, repDelta };
  } else {
    // Failure
    const heatDelta = isHostile ? 2 : 1;
    notes.push(`${faction.name} are not interested. The attempt to talk backfires.`);
    if (isHostile) {
      notes.push(`They take the approach as an insult. The heat just went up.`);
    }
    noteCampaignEvent(state, `Failed parley with ${faction.name} — relations worsened.`);
    return { resolved: false, notes, heatDelta, repDelta: -1 };
  }
}

// ── Friendly faction benefits ───────────────────────────────────────────────

export interface FactionBenefit {
  type: 'rumor' | 'safe_route' | 'supply_discount' | 'scout_intel' | 'safe_camp';
  note: string;
  scoutBonus?: number;
  hpRestore?: number;
  supplyBonus?: { item: string; quantity: number };
}

export function getFactionBenefits(
  state: CampaignSimulationState,
): FactionBenefit[] {
  const benefits: FactionBenefit[] = [];

  for (const [_key, faction] of Object.entries(state.factions)) {
    const rep = faction.reputation;
    if (rep <= 0) continue;

    if (rep >= 5) {
      benefits.push({
        type: 'safe_route',
        note: `${faction.name} contacts mark a safer path through their territory. The party can move without triggering patrol attention for the next two scenes.`,
        scoutBonus: 2,
      });
    }
    if (rep >= 4) {
      benefits.push({
        type: 'safe_camp',
        note: `${faction.name} have a safe house nearby. The party can rest here without fear of patrol.`,
        hpRestore: 4,
      });
    }
    if (rep >= 3) {
      benefits.push({
        type: 'scout_intel',
        note: `A contact from ${faction.name} tips the party off about what is ahead. You approach the next room with better information than you earned.`,
        scoutBonus: 1,
      });
    }
    if (rep >= 2) {
      benefits.push({
        type: 'rumor',
        note: `${faction.name} have been talking. There is a rumor circulating that maps to something in this dungeon — worth keeping in mind.`,
      });
    }
    if (rep >= 3) {
      benefits.push({
        type: 'supply_discount',
        note: `${faction.name} resupply: a trusted contact presses a torch into your hand. Take it.`,
        supplyBonus: { item: 'Torch', quantity: 1 },
      });
    }
  }

  return benefits;
}

// ── Scene-entry faction check ───────────────────────────────────────────────

/**
 * Called on every scene entry. Returns flavour notes about faction
 * patrol state and any immediate consequences.
 */
export function checkFactionSceneEntry(params: {
  db: Database;
  campaignId: string;
  sceneId: string;
  factionKey: string;
  explorationTurn: number;
  leaderName: string;
}): string[] {
  const { db, campaignId, factionKey, explorationTurn, leaderName } = params;
  const state = getCampaignState(db, campaignId);
  const faction = state.factions[factionKey];
  if (!faction) return [];

  const notes: string[] = [];
  const escalation = getEscalationLevel(faction.heat);

  // Only emit faction notes occasionally to avoid noise
  const shouldNote = explorationTurn % 3 === 0;

  if (escalation === 'manhunt' && shouldNote) {
    notes.push(describeFactionEscalation(faction.name, escalation, faction.reputation));
  } else if (escalation === 'hunting' && explorationTurn % 4 === 0) {
    notes.push(describeFactionEscalation(faction.name, escalation, faction.reputation));
  } else if (escalation === 'alert' && explorationTurn % 6 === 0) {
    notes.push(describeFactionEscalation(faction.name, escalation, faction.reputation));
  }

  // Friendly benefits on scene entry (rep ≥ 3, once every 5 turns)
  if (faction.reputation >= 3 && explorationTurn % 5 === 1) {
    const benefits = getFactionBenefits(state).filter(b => b.type === 'rumor' || b.type === 'scout_intel');
    if (benefits.length > 0) {
      notes.push(benefits[0].note);
    }
  }

  return notes;
}

// ── Parley action detection ─────────────────────────────────────────────────

export function isParleyAction(action: string): boolean {
  return /parley|negotiate|speak with|talk to|call out to|approach.*peacefully|wave.*off|stand down|hail.*patrol|hold.*hand|we.*mean.*no harm|we come in peace/i.test(action);
}

// ── Bounty hunter enemy injection ──────────────────────────────────────────

export interface BountyHunterSpec {
  name: string;
  level: number;
  thac0: number;
  ac: number;
  hp: number;
  damage: string;
  weaponSpeed: number;
  faction: string;
  isBountyHunter: true;
}

export function generateBountyHunter(
  faction: FactionStanding,
  baseLevel: number,
): BountyHunterSpec {
  const boost = Math.floor(faction.heat / 3);
  return {
    name: 'Bounty Hunter',
    level: baseLevel + boost,
    thac0: Math.max(10, 17 - baseLevel - boost),
    ac: 4,
    hp: 12 + baseLevel * 4 + boost * 3,
    damage: '1d8+2',
    weaponSpeed: 5,
    faction: faction.name,
    isBountyHunter: true,
  };
}
