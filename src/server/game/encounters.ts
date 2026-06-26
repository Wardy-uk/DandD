import { v4 as uuid } from 'uuid';
import type { Database } from 'sql.js';
import type { Server as SocketServer } from 'socket.io';
import { all, get, run } from '../db/helpers.js';
import { getCampaignState, noteCampaignEvent, saveCampaignState, shiftFactionStanding, recordDeath, checkAndAwardMilestone } from './campaignState.js';
import { awardXp, rollInjury, addInjuryToCharacter } from '../engine/progression.js';
import { getCompanionPartyModifiers } from './companions.js';
import {
  checkMorale,
  resolveAttack,
  resolveMissileAttack,
  rollGroupInitiative,
  rollIndividualInitiative,
  rollSurpriseCheck,
  turnUndead,
  type Combatant,
} from '../engine/combat.js';
import { buildSceneBlueprint, type ProceduralEnemy } from './adventure.js';

interface StartedEncounter {
  encounter: {
    id: string;
    campaignId: string;
    sceneId: string;
    status: 'active';
    round: number;
    segment: number;
    initiativeType: 'group' | 'individual';
    turnOrder: string[];
    currentTurnIndex: number;
  };
  initiative: ReturnType<typeof rollGroupInitiative> | ReturnType<typeof rollIndividualInitiative>;
  surpriseSummary: string;
}

interface TurnPrompt {
  combatantId: string;
  name: string;
  round: number;
}

interface EncounterActionResolution {
  ok: boolean;
  error?: string;
  narration: { actor: string; content: string }[];
  combatResults: any[];
  turnPrompt?: TurnPrompt;
  encounterUpdate?: any;
  updatedCharacterIds: string[];
}

interface BattlefieldProfile {
  visibility: 'clear' | 'murky' | 'dark';
  cover: boolean;
  chokepoint: boolean;
  hazard: string | null;
  footing: 'stable' | 'uneven' | 'treacherous';
  pressure: string;
}

interface EncounterSetupProfile {
  partySurpriseModifier: number;
  enemySurpriseModifier: number;
  partyInitiativeShift: number;
  enemyInitiativeShift: number;
  partyConditions: string[];
  enemyConditions: string[];
  openingNotes: string[];
}

interface TacticalIntent {
  ranged: boolean;
  defensive: boolean;
  flanking: boolean;
  usingCover: boolean;
  forcingHazard: boolean;
  steadyingShot: boolean;
  chokeControl: boolean;
}

interface SpecialActionResult {
  narration: { actor: string; content: string }[];
  combatResults: any[];
  updatedCharacterIds: string[];
  ended?: boolean;
}

export function createEncounterRecord(params: {
  db: Database;
  campaignId: string;
  sceneId: string;
  enemies: ProceduralEnemy[];
  initiativeType?: 'group' | 'individual';
}): StartedEncounter {
  const { db, campaignId, sceneId, enemies, initiativeType } = params;
  const encounterId = uuid();
  const scene = get(db, 'SELECT * FROM scenes WHERE id = ?', [sceneId]) as any;
  const battlefield = buildBattlefieldProfile(scene);
  const sceneState = safeJsonObject(get(db, 'SELECT state_json FROM scene_state WHERE scene_id = ?', [sceneId])?.state_json);
  const setup = buildEncounterSetupProfile(sceneState, battlefield);

  const partyChars = all(db,
    'SELECT * FROM characters WHERE campaign_id = ? AND status = "active"',
    [campaignId]) as any[];
  const companionNpcs = all(db,
    'SELECT * FROM npcs WHERE campaign_id = ? AND joined_party = 1 AND alive = 1',
    [campaignId]) as any[];

  const partyCombatants: Combatant[] = partyChars.map((c) => ({
    id: uuid(),
    name: c.name,
    charClass: c.char_class,
    level: c.level,
    thac0: c.thac0,
    ac: c.ac,
    hp: c.hp,
    maxHp: c.max_hp,
    str: c.str,
    strPercentile: c.str_percentile,
    dex: c.dex,
    weaponSpeed: 5,
    weaponDamageSm: '1d6',
    weaponDamageLg: '1d6',
    isLargeTarget: false,
    conditions: JSON.parse(c.conditions || '[]'),
    side: 'party',
  }));
  const companionCombatants: Combatant[] = companionNpcs.map((npc) => {
    const stats = safeJsonObject(npc.stats);
    return {
      id: uuid(),
      name: npc.name,
      charClass: npc.char_class || 'fighter',
      level: npc.level || 1,
      thac0: Number(stats.thac0 ?? 20),
      ac: Number(stats.ac ?? 7),
      hp: Number(stats.currentHp ?? stats.hp ?? 6),
      maxHp: Number(stats.maxHp ?? stats.hp ?? 6),
      str: Number(stats.str ?? 12),
      dex: Number(stats.dex ?? 12),
      weaponSpeed: Number(stats.weaponSpeed ?? 5),
      weaponDamageSm: String(stats.damage || '1d6'),
      weaponDamageLg: String(stats.damage || '1d6'),
      isLargeTarget: false,
      conditions: [],
      side: 'party',
    };
  });

  const enemyCombatants: Combatant[] = (enemies || []).map((e) => ({
    id: uuid(),
    name: e.name,
    charClass: 'fighter',
    level: e.level || 1,
    thac0: e.thac0 || 20,
    ac: e.ac || 7,
    hp: e.hp || 8,
    maxHp: e.hp || 8,
    str: 10,
    dex: 10,
    weaponSpeed: e.weaponSpeed || 5,
    weaponDamageSm: e.damage || '1d6',
    weaponDamageLg: e.damage || '1d6',
    isLargeTarget: e.size === 'L',
    conditions: [],
    side: 'enemy',
  }));

  const allCombatants = [...partyCombatants, ...companionCombatants, ...enemyCombatants];
  const rolledInitiative = initiativeType === 'individual'
    ? rollIndividualInitiative(allCombatants)
    : rollGroupInitiative([...partyCombatants, ...companionCombatants], enemyCombatants);
  const initiative = applyInitiativeSetup(rolledInitiative, setup);
  const surprise = rollSurpriseCheck(setup.partySurpriseModifier, setup.enemySurpriseModifier);

  run(db, `
    INSERT INTO encounters (id, campaign_id, scene_id, status, round, initiative_type, turn_order, current_turn_index)
    VALUES (?, ?, ?, 'active', 1, ?, ?, 0)
  `, [encounterId, campaignId, sceneId, initiativeType || 'group', JSON.stringify(initiative.order.map((o) => o.id))]);

  for (const c of allCombatants) {
    const orderEntry = initiative.order.find((o) => o.id === c.id);
    const isSurprised = c.side === 'party' ? surprise.partySurprised : surprise.enemySurprised;
    const openingConditions = c.side === 'party' ? setup.partyConditions : setup.enemyConditions;
    run(db, `
      INSERT INTO combatants (id, encounter_id, character_id, npc_id, name, side, initiative_roll, weapon_speed, final_initiative, current_hp, max_hp, thac0, ac, conditions, is_surprised)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      c.id,
      encounterId,
      c.side === 'party' ? partyChars.find((pc) => pc.name === c.name)?.id || null : null,
      c.side === 'party' ? companionNpcs.find((npc) => npc.name === c.name)?.id || null : null,
      c.name,
      c.side,
      orderEntry?.initiative || 0,
      c.weaponSpeed,
      orderEntry?.initiative || 0,
      c.hp,
      c.maxHp,
      c.thac0,
      c.ac,
      JSON.stringify(appendConditionList(c.conditions || [], openingConditions)),
      isSurprised ? 1 : 0,
    ]);
  }

  const encounter = {
    id: encounterId,
    campaignId,
    sceneId,
    status: 'active' as const,
    round: 1,
    segment: 0,
    initiativeType: (initiativeType || 'group') as 'group' | 'individual',
    turnOrder: initiative.order.map((o) => o.id),
    currentTurnIndex: 0,
  };

  const surpriseSummary = surprise.partySurprised && !surprise.enemySurprised
    ? `The party is surprised for ${surprise.surpriseSegments || 1} segment${surprise.surpriseSegments === 1 ? '' : 's'}.`
    : surprise.enemySurprised && !surprise.partySurprised
      ? `The enemy is surprised for ${surprise.surpriseSegments || 1} segment${surprise.surpriseSegments === 1 ? '' : 's'}.`
      : 'Neither side is caught fully off guard.';

  return {
    encounter,
    initiative,
    surpriseSummary: `${surpriseSummary} ${setup.openingNotes.join(' ')} ${describeBattlefieldOpening(battlefield)}`.trim(),
  };
}

export function emitEncounterStart(
  io: SocketServer,
  campaignId: string,
  started: StartedEncounter,
) {
  io.to(`campaign:${campaignId}`).emit('game:encounter_start', started.encounter as any);
  const firstTurn = started.initiative.order[0];
  if (firstTurn) {
    io.to(`campaign:${campaignId}`).emit('game:turn_prompt', {
      combatantId: firstTurn.id,
      name: firstTurn.name,
      round: 1,
    });
  }
}

export function getActiveEncounter(db: Database, campaignId: string) {
  return get(db,
    'SELECT * FROM encounters WHERE campaign_id = ? AND status = "active"',
    [campaignId]) as any;
}

export function describeBattlefield(scene: any) {
  const battlefield = buildBattlefieldProfile(scene);
  return {
    ...battlefield,
    summary: describeBattlefieldOpening(battlefield),
    tacticalAdvice: buildTacticalAdvice(battlefield),
  };
}

export function resolveEncounterAction(params: {
  db: Database;
  campaignId: string;
  encounterId: string;
  action: string;
  actingCharacterId?: string | null;
}): EncounterActionResolution {
  const { db, encounterId, action, actingCharacterId } = params;
  const encounter = get(db, 'SELECT * FROM encounters WHERE id = ?', [encounterId]) as any;
  if (!encounter || encounter.status !== 'active') {
    return { ok: false, error: 'No active encounter.', narration: [], combatResults: [], updatedCharacterIds: [] };
  }

  const scene = get(db, 'SELECT * FROM scenes WHERE id = ?', [encounter.scene_id]) as any;
  const battlefield = buildBattlefieldProfile(scene);
  let combatants = getEncounterCombatants(db, encounterId);
  let current = getCurrentTurnCombatant(encounter, combatants);
  const narration: { actor: string; content: string }[] = [];
  const combatResults: any[] = [];
  const updatedCharacterIds = new Set<string>();

  let automated = autoResolveNonPlayerTurns(db, encounter, current, battlefield, combatResults, narration, updatedCharacterIds);
  if (automated.ended) {
    return finishResolution(db, encounter.id, narration, combatResults, updatedCharacterIds, automated.prompt);
  }
  if (automated.current) {
    current = automated.current;
    combatants = getEncounterCombatants(db, encounterId);
  }
  if (!current) {
    return { ok: false, error: 'Encounter has no valid turn holder.', narration: [], combatResults: [], updatedCharacterIds: [] };
  }
  if (current.side !== 'party') {
    return { ok: false, error: `It is ${current.name}'s turn, and the party is still under pressure.`, narration: [], combatResults: [], updatedCharacterIds: [] };
  }
  if (current.npc_id && !current.character_id) {
    return { ok: false, error: `${current.name} is still acting on instinct. Give the moment a beat and try again.`, narration: [], combatResults: [], updatedCharacterIds: [] };
  }
  if (actingCharacterId && current.character_id && current.character_id !== actingCharacterId) {
    return { ok: false, error: `It is ${current.name}'s turn right now.`, narration: [], combatResults: [], updatedCharacterIds: [] };
  }

  const lowered = action.toLowerCase();

  if (/retreat|withdraw|fall back|run/.test(lowered)) {
    const retreat = attemptRetreat(db, encounter, combatants, current);
    narration.push(...retreat.narration);
    return finishResolution(db, encounter.id, narration, combatResults, updatedCharacterIds);
  }

  if (/parley|surrender|yield|call for quarter/.test(lowered)) {
    const quarter = attemptQuarter(db, encounter, combatants, current);
    narration.push(...quarter.narration);
    return finishResolution(db, encounter.id, narration, combatResults, updatedCharacterIds);
  }

  const specialAction = resolveSpecialCombatAction(db, encounter, combatants, current, lowered, battlefield);
  if (specialAction) {
    narration.push(...specialAction.narration);
    combatResults.push(...specialAction.combatResults);
    for (const id of specialAction.updatedCharacterIds) updatedCharacterIds.add(id);
    if (specialAction.ended) {
      return finishResolution(db, encounter.id, narration, combatResults, updatedCharacterIds);
    }

    let advanced = advanceEncounterTurn(db, encounter.id);
    if (advanced.bleedingNarration) narration.push(...advanced.bleedingNarration);
    let loopGuard = 0;
    while (advanced.prompt && advanced.current && (advanced.current.side === 'enemy' || (advanced.current.side === 'party' && advanced.current.npc_id && !advanced.current.character_id)) && loopGuard < 8) {
      const enemyActor = advanced.current;
      const refreshedCombatants = getEncounterCombatants(db, encounter.id);
      const target = enemyActor.side === 'enemy'
        ? chooseEnemyTarget(enemyActor, refreshedCombatants, battlefield)
        : chooseTargetFromAction('', refreshedCombatants, 'enemy');
      if (!target) break;
      const enemyAction = enemyActor.side === 'enemy'
        ? inferEnemyAction(enemyActor, battlefield)
        : inferCompanionAction(enemyActor, battlefield);
      const enemyStrike = resolveAttackExchange(db, encounter.id, enemyActor, target, enemyAction, battlefield);
      combatResults.push(enemyStrike.result);
      narration.push({
        actor: 'DM',
        content: `${describeRolePressure(enemyActor, true)} ${describeBattlefieldPressure(battlefield, enemyAction, true)} ${enemyStrike.result.description}`,
      });
      if (target.character_id) updatedCharacterIds.add(target.character_id);

      if (enemyActor.side === 'enemy') {
        const partyState = evaluatePartyState(db, encounter, target, enemyActor);
        narration.push(...partyState.narration);
        if (partyState.ended) {
          return finishResolution(db, encounter.id, narration, combatResults, updatedCharacterIds);
        }
      } else {
        const enemyState = evaluateEnemyState(db, encounter, target, enemyActor);
        narration.push(...enemyState.narration);
        if (enemyState.ended) {
          return finishResolution(db, encounter.id, narration, combatResults, updatedCharacterIds);
        }
      }

      advanced = advanceEncounterTurn(db, encounter.id);
      if (advanced.bleedingNarration) narration.push(...advanced.bleedingNarration);
      loopGuard += 1;
    }

    return finishResolution(db, encounter.id, narration, combatResults, updatedCharacterIds, advanced.prompt);
  }

  const target = chooseTargetFromAction(lowered, combatants, 'enemy');
  if (!target) {
    return {
      ok: false,
      error: 'No enemy target is available. The encounter may already be ending.',
      narration,
      combatResults,
      updatedCharacterIds: [],
    };
  }

  const playerStrike = resolveAttackExchange(db, encounter.id, current, target, lowered, battlefield);
  combatResults.push(playerStrike.result);
  narration.push({
    actor: 'DM',
    content: `${describeRolePressure(target, false)} ${describeBattlefieldPressure(battlefield, lowered, false)}`,
  });
  if (current.character_id) updatedCharacterIds.add(current.character_id);
  if (target.character_id) updatedCharacterIds.add(target.character_id);
  if (playerStrike.killReward) {
    narration.push({ actor: 'DM', content: playerStrike.killReward });
  }

  const enemyState = evaluateEnemyState(db, encounter, target, current);
  narration.push(...enemyState.narration);
  if (enemyState.ended) {
    return finishResolution(db, encounter.id, narration, combatResults, updatedCharacterIds);
  }

  let advanced = advanceEncounterTurn(db, encounter.id);
  if (advanced.bleedingNarration) narration.push(...advanced.bleedingNarration);
  let loopGuard = 0;
  while (advanced.prompt && advanced.current && (advanced.current.side === 'enemy' || (advanced.current.side === 'party' && advanced.current.npc_id && !advanced.current.character_id)) && loopGuard < 8) {
    const enemyActor = advanced.current;
    const refreshedCombatants = getEncounterCombatants(db, encounter.id);
    const target = enemyActor.side === 'enemy'
      ? chooseEnemyTarget(enemyActor, refreshedCombatants, battlefield)
      : chooseTargetFromAction('', refreshedCombatants, 'enemy');
    if (!target) break;
    const enemyAction = enemyActor.side === 'enemy'
      ? inferEnemyAction(enemyActor, battlefield)
      : inferCompanionAction(enemyActor, battlefield);
    const enemyStrike = resolveAttackExchange(db, encounter.id, enemyActor, target, enemyAction, battlefield);
    combatResults.push(enemyStrike.result);
    narration.push({
      actor: 'DM',
      content: `${describeRolePressure(enemyActor, true)} ${describeBattlefieldPressure(battlefield, enemyAction, true)} ${enemyStrike.result.description}`,
    });
    if (target.character_id) updatedCharacterIds.add(target.character_id);

    if (enemyActor.side === 'enemy') {
      const partyState = evaluatePartyState(db, encounter, target, enemyActor);
      narration.push(...partyState.narration);
      if (partyState.ended) {
        return finishResolution(db, encounter.id, narration, combatResults, updatedCharacterIds);
      }
    } else {
      const enemyState = evaluateEnemyState(db, encounter, target, enemyActor);
      narration.push(...enemyState.narration);
      if (enemyState.ended) {
        return finishResolution(db, encounter.id, narration, combatResults, updatedCharacterIds);
      }
    }

    advanced = advanceEncounterTurn(db, encounter.id);
    if (advanced.bleedingNarration) narration.push(...advanced.bleedingNarration);
    loopGuard += 1;
  }

  return finishResolution(db, encounter.id, narration, combatResults, updatedCharacterIds, advanced.prompt);
}

function finishResolution(
  db: Database,
  encounterId: string,
  narration: { actor: string; content: string }[],
  combatResults: any[],
  updatedCharacterIds: Set<string>,
  turnPrompt?: TurnPrompt,
): EncounterActionResolution {
  const encounterUpdate = get(db, 'SELECT * FROM encounters WHERE id = ?', [encounterId]) as any;
  return {
    ok: true,
    narration,
    combatResults,
    turnPrompt,
    encounterUpdate: encounterUpdate ? hydrateEncounter(encounterUpdate) : undefined,
    updatedCharacterIds: Array.from(updatedCharacterIds),
  };
}

function getEncounterCombatants(db: Database, encounterId: string): any[] {
  return all(db, 'SELECT * FROM combatants WHERE encounter_id = ?', [encounterId]) as any[];
}

function getCurrentTurnCombatant(encounter: any, combatants: any[]) {
  const turnOrder = JSON.parse(encounter.turn_order || '[]');
  const currentId = turnOrder[Number(encounter.current_turn_index || 0)];
  return combatants.find((c) => c.id === currentId && c.current_hp > 0);
}

function autoResolveNonPlayerTurns(
  db: Database,
  encounter: any,
  current: any,
  battlefield: BattlefieldProfile,
  combatResults: any[],
  narration: { actor: string; content: string }[],
  updatedCharacterIds: Set<string>,
) {
  let active = current;
  let prompt: TurnPrompt | undefined;
  let loopGuard = 0;
  while (active && loopGuard < 8 && ((active.side === 'enemy') || (active.side === 'party' && active.npc_id && !active.character_id))) {
    const combatants = getEncounterCombatants(db, encounter.id);
    const target = active.side === 'enemy'
      ? chooseEnemyTarget(active, combatants, battlefield)
      : chooseTargetFromAction('', combatants, 'enemy');
    if (!target) return { ended: true, prompt };
    const action = active.side === 'enemy' ? inferEnemyAction(active, battlefield) : inferCompanionAction(active, battlefield);
    const strike = resolveAttackExchange(db, encounter.id, active, target, action, battlefield);
    combatResults.push(strike.result);
    narration.push({
      actor: 'DM',
      content: `${describeRolePressure(active, true)} ${describeBattlefieldPressure(battlefield, action, true)} ${strike.result.description}`,
    });
    if (target.character_id) updatedCharacterIds.add(target.character_id);

    const state = active.side === 'enemy'
      ? evaluatePartyState(db, encounter, target, active)
      : evaluateEnemyState(db, encounter, target, active);
    narration.push(...state.narration);
    if (state.ended) return { ended: true, prompt };

    const advanced = advanceEncounterTurn(db, encounter.id);
    if (advanced.bleedingNarration) narration.push(...advanced.bleedingNarration);
    prompt = advanced.prompt;
    active = advanced.current;
    loopGuard += 1;
  }
  return { ended: false, current: active, prompt };
}

function chooseTargetFromAction(action: string, combatants: any[], side: 'enemy' | 'party') {
  const living = combatants.filter((c) => c.side === side && c.current_hp > 0);
  if (!living.length) return null;
  const exact = living.find((c) => action.includes(String(c.name || '').toLowerCase()));
  return exact || living[0];
}

function chooseEnemyTarget(enemyActor: any, combatants: any[], battlefield: BattlefieldProfile) {
  const party = combatants.filter((c) => c.side === 'party' && c.current_hp > 0);
  if (!party.length) return null;

  const role = inferEnemyRole(enemyActor.name);
  const wounded = [...party].sort((a, b) =>
    (a.current_hp / Math.max(1, a.max_hp)) - (b.current_hp / Math.max(1, b.max_hp)) || a.ac - b.ac);
  const lightlyArmoured = [...party].sort((a, b) => b.ac - a.ac || a.current_hp - b.current_hp);
  const sturdy = [...party].sort((a, b) => a.ac - b.ac || b.current_hp - a.current_hp);

  if (role === 'skirmisher') return lightlyArmoured[0] || wounded[0] || party[0];
  if (role === 'zealot') return wounded[0] || lightlyArmoured[0] || party[0];
  if (role === 'brute') return battlefield.chokepoint ? sturdy[0] || wounded[0] : wounded[0] || sturdy[0];
  return wounded[0] || party[0];
}

function chooseAllyTargetFromAction(action: string, combatants: any[], current: any) {
  const living = combatants.filter((c) => c.side === 'party' && c.current_hp > 0);
  if (!living.length) return current;
  const exact = living.find((c) => action.includes(String(c.name || '').toLowerCase()));
  if (exact) return exact;
  const wounded = living
    .filter((c) => c.current_hp < c.max_hp)
    .sort((a, b) => (a.current_hp / Math.max(1, a.max_hp)) - (b.current_hp / Math.max(1, b.max_hp)));
  return wounded[0] || current;
}

function resolveSpecialCombatAction(
  db: Database,
  encounter: any,
  combatants: any[],
  current: any,
  action: string,
  battlefield: BattlefieldProfile,
): SpecialActionResult | null {
  const charClass = String(current.char_class || buildCombatantProfile(db, current).charClass || '').toLowerCase();
  const currentConditions = safeConditions(current.conditions);

  if (/lay on hands|healing touch/.test(action)) {
    if (charClass !== 'paladin') {
      return {
        narration: [{ actor: 'DM', content: `${current.name} reaches for grace they do not truly command. In this ruleset, lay on hands belongs to paladins.` }],
        combatResults: [],
        updatedCharacterIds: current.character_id ? [current.character_id] : [],
      };
    }
    if (currentConditions.includes('lay_on_hands_used')) {
      return {
        narration: [{ actor: 'DM', content: `${current.name} has already spent their lay on hands in this fight.` }],
        combatResults: [],
        updatedCharacterIds: current.character_id ? [current.character_id] : [],
      };
    }
    const ally = chooseAllyTargetFromAction(action, combatants, current);
    const healAmount = Math.max(2, 2 + Math.floor(buildCombatantProfile(db, current).level / 2));
    const nextHp = Math.min(Number(ally.max_hp || ally.current_hp), Number(ally.current_hp || 0) + healAmount);
    const actualHeal = nextHp - Number(ally.current_hp || 0);
    if (actualHeal <= 0) {
      return {
        narration: [{ actor: 'DM', content: `${ally.name} is already as whole as the moment allows. ${current.name}'s healing touch would be wasted.` }],
        combatResults: [],
        updatedCharacterIds: [current.character_id, ally.character_id].filter(Boolean) as string[],
      };
    }
    setCombatantHp(db, ally, nextHp);
    setCombatantConditions(db, current, appendConditionList(currentConditions, ['lay_on_hands_used']));
    return {
      narration: [{
        actor: 'DM',
        content: `${current.name} lays on hands upon ${ally.name}, forcing a pocket of calm and holy resolve into the chaos. ${ally.name} recovers ${actualHeal} hit point${actualHeal === 1 ? '' : 's'}.`,
      }],
      combatResults: [],
      updatedCharacterIds: [current.character_id, ally.character_id].filter(Boolean) as string[],
    };
  }

  if (/turn undead|rebuke undead|drive back the dead/.test(action)) {
    if (charClass !== 'cleric') {
      return {
        narration: [{ actor: 'DM', content: `${current.name} calls against the dead, but only a true cleric can turn undead in this system.` }],
        combatResults: [],
        updatedCharacterIds: current.character_id ? [current.character_id] : [],
      };
    }
    const undead = combatants
      .filter((c) => c.side === 'enemy' && c.current_hp > 0)
      .map((enemy) => ({ enemy, undeadType: inferUndeadType(enemy.name) }))
      .filter((entry) => entry.undeadType);
    if (!undead.length) {
      return {
        narration: [{ actor: 'DM', content: `${current.name} raises a holy symbol, but there is no undead presence here for the rite to seize.` }],
        combatResults: [],
        updatedCharacterIds: current.character_id ? [current.character_id] : [],
      };
    }

    const result = turnUndead(buildCombatantProfile(db, current).level, undead[0].undeadType!);
    if (result.result === 'cannot_turn' || result.result === 'no_effect') {
      return {
        narration: [{ actor: 'DM', content: `${current.name}'s invocation rings out, but the dead do not yield. ${result.roll ? `The turning roll comes up ${result.roll}.` : 'The rite finds no purchase.'}` }],
        combatResults: [],
        updatedCharacterIds: current.character_id ? [current.character_id] : [],
      };
    }

    const affected = undead.slice(0, Math.max(1, Math.min(result.numAffected || 1, undead.length)));
    for (const { enemy } of affected) {
      if (result.result === 'destroyed') {
        setCombatantHp(db, enemy, 0);
        setCombatantConditions(db, enemy, appendConditionList(safeConditions(enemy.conditions), ['down', 'turned_to_dust']));
      } else {
        setCombatantConditions(db, enemy, appendConditionList(safeConditions(enemy.conditions), ['turned', 'off_balance']));
      }
    }

    const refreshedEncounter = get(db, 'SELECT * FROM encounters WHERE id = ?', [encounter.id]) as any;
    const enemyState = evaluateEnemyState(db, refreshedEncounter, affected[0].enemy, current);
    return {
      narration: [{
        actor: 'DM',
        content: result.result === 'destroyed'
          ? `${current.name} brandishes faith like a weapon. ${affected.map(({ enemy }) => enemy.name).join(', ')} ${affected.length === 1 ? 'is' : 'are'} blasted apart by the turning.`
          : `${current.name} drives the holy command into the room. ${affected.map(({ enemy }) => enemy.name).join(', ')} recoil${affected.length === 1 ? 's' : ''}, forced back by the power of the rite.`,
      }, ...enemyState.narration],
      combatResults: [],
      updatedCharacterIds: current.character_id ? [current.character_id] : [],
      ended: enemyState.ended,
    };
  }

  if (/rally the line|rally the company|hold fast|steady us/.test(action)) {
    if (!/fighter|paladin|ranger/.test(charClass)) {
      return {
        narration: [{ actor: 'DM', content: `${current.name} tries to rally the line, but the command lacks the hard authority of a trained war leader.` }],
        combatResults: [],
        updatedCharacterIds: current.character_id ? [current.character_id] : [],
      };
    }
    const allies = combatants.filter((c) => c.side === 'party' && c.current_hp > 0);
    for (const ally of allies) {
      const next = appendConditionList(
        safeConditions(ally.conditions).filter((condition) => condition !== 'off_balance'),
        battlefield.chokepoint ? ['holding_choke', 'braced'] : ['braced'],
      );
      setCombatantConditions(db, ally, next);
    }
    return {
      narration: [{
        actor: 'DM',
        content: `${current.name} barks the sort of order that cuts through panic. Shields rise, footing improves, and the company remembers how to fight together instead of merely survive apart.`,
      }],
      combatResults: [],
      updatedCharacterIds: allies.map((ally) => ally.character_id).filter(Boolean) as string[],
    };
  }

  if (/first aid|bind wounds|stabilise|stabilize|help the dying|help/.test(action)) {
    // Find a dying ally (negative HP, not yet dead)
    const dyingAlly = combatants.find((c) =>
      c.side === 'party' && Number(c.current_hp) <= 0 && Number(c.current_hp) > -10 && c.character_id
      && !safeConditions(c.conditions).includes('stabilised')
      && (action.includes(String(c.name || '').toLowerCase()) || true), // target named or auto-pick
    );
    if (!dyingAlly) {
      return {
        narration: [{ actor: 'DM', content: 'No one in reach is dying. Save the bandage.' }],
        combatResults: [],
        updatedCharacterIds: current.character_id ? [current.character_id] : [],
      };
    }
    // Consume a bandage from inventory
    const actorChar = current.character_id
      ? get(db, 'SELECT inventory FROM characters WHERE id = ?', [current.character_id]) as any
      : null;
    let inventory: any[] = [];
    try { inventory = JSON.parse(actorChar?.inventory || '[]'); } catch {}
    const bandageIdx = inventory.findIndex((item: any) =>
      /bandage|binding|medic|field dressing/i.test(String(item.item || '')));
    const hasBandage = bandageIdx !== -1 && (inventory[bandageIdx].quantity || 1) > 0;
    if (!hasBandage) {
      return {
        narration: [{
          actor: 'DM',
          content: `${current.name} reaches for a bandage and finds none. ${dyingAlly.name} keeps bleeding.`,
        }],
        combatResults: [],
        updatedCharacterIds: current.character_id ? [current.character_id] : [],
      };
    }
    // Use the bandage
    if (inventory[bandageIdx].quantity > 1) {
      inventory[bandageIdx].quantity -= 1;
    } else {
      inventory.splice(bandageIdx, 1);
    }
    if (current.character_id) {
      run(db, 'UPDATE characters SET inventory = ? WHERE id = ?', [JSON.stringify(inventory), current.character_id]);
    }
    // Stabilise the dying ally
    const dyingConditions = safeConditions(dyingAlly.conditions);
    setCombatantConditions(db, dyingAlly, appendConditionList(dyingConditions, ['stabilised']));
    if (dyingAlly.character_id) {
      const existingConditions = JSON.parse(
        (get(db, 'SELECT conditions FROM characters WHERE id = ?', [dyingAlly.character_id]) as any)?.conditions || '[]'
      );
      run(db, 'UPDATE characters SET conditions = ? WHERE id = ?',
        [JSON.stringify([...existingConditions, 'stabilised']), dyingAlly.character_id]);
    }
    return {
      narration: [{
        actor: 'DM',
        content: `${current.name} tears a bandage open and works fast — pressing it into the wound, binding tight. ${dyingAlly.name} stops losing blood. Unconscious, wounded, but not dying anymore. They'll need camp rest to recover, but the clock has stopped.`,
      }],
      combatResults: [],
      updatedCharacterIds: [current.character_id, dyingAlly.character_id].filter(Boolean) as string[],
    };
  }

  return null;
}

function resolveAttackExchange(
  db: Database,
  encounterId: string,
  attacker: any,
  defender: any,
  action: string,
  battlefield: BattlefieldProfile,
) {
  const intent = parseTacticalIntent(action, battlefield);
  const attackerProfile = applyAttackAdjustments(buildCombatantProfile(db, attacker), attacker, defender, battlefield, intent);
  const defenderProfile = applyDefenseAdjustments(buildCombatantProfile(db, defender), defender, battlefield);
  const result = intent.ranged
    ? resolveMissileAttack(attackerProfile, defenderProfile, 'short')
    : resolveAttack(attackerProfile, defenderProfile);

  if (attackerProfile.charClass === 'paladin' && /smite|holy strike|oath/.test(action) && isProfaneTarget(defender.name) && result.hit) {
    const bonus = 2;
    result.totalDamage = (result.totalDamage || 0) + bonus;
    result.defenderHpAfter = (result.defenderHpAfter ?? defender.current_hp) - bonus;
    result.defenderKilled = (result.defenderHpAfter ?? 1) <= 0;
    result.description += ` The smiting oath lands true, adding ${bonus} holy damage against an unclean foe.`;
  }

  let remainingHp = defender.current_hp;
  let nextConditions = safeConditions(defender.conditions);
  if (result.hit && result.defenderHpAfter !== undefined) {
    const prevHp = Number(defender.current_hp);
    const defenderMaxHp = Number(defender.max_hp || 1);
    // Party characters use AD&D dying system — allow negative HP
    const rawHp = result.defenderHpAfter;
    remainingHp = defender.character_id ? rawHp : Math.max(0, rawHp);
    nextConditions = appendConditionList(nextConditions, [remainingHp <= 0 ? 'down' : 'wounded']);
    if (intent.forcingHazard && battlefield.hazard && remainingHp > -10) {
      const hazardDamage = rollHazardDamage(battlefield);
      remainingHp = defender.character_id ? remainingHp - hazardDamage : Math.max(0, remainingHp - hazardDamage);
      nextConditions = appendConditionList(nextConditions, ['off_balance', `hazard:${slugify(battlefield.hazard)}`]);
      result.description += ` The position collapses into ${battlefield.hazard}, adding ${hazardDamage} more damage.`;
      result.defenderHpAfter = remainingHp;
      result.defenderKilled = remainingHp <= -10;
    }
    run(db, 'UPDATE combatants SET current_hp = ?, conditions = ? WHERE id = ?',
      [remainingHp, JSON.stringify(nextConditions), defender.id]);
    if (defender.character_id) {
      const newStatus = remainingHp <= -10 ? 'dead' : remainingHp <= 0 ? 'dying' : 'active';
      run(db, 'UPDATE characters SET hp = ?, status = ? WHERE id = ?',
        [remainingHp, newStatus, defender.character_id]);
      // Injury: on crit, or single hit drops character from >25% to ≤25% max HP
      const critHit = result.natural20;
      const brokeThreshold = prevHp > defenderMaxHp * 0.25 && remainingHp <= defenderMaxHp * 0.25;
      if ((critHit || brokeThreshold) && remainingHp > -10 && newStatus !== 'dead') {
        const injury = rollInjury();
        addInjuryToCharacter(db, defender.character_id, injury);
        result.description += ` ${injury.name}: ${injury.description}`;
      }
    }
    if (defender.npc_id) {
      const npc = get(db, 'SELECT stats FROM npcs WHERE id = ?', [defender.npc_id]) as any;
      const stats = safeJsonObject(npc?.stats);
      stats.currentHp = remainingHp;
      stats.maxHp = stats.maxHp ?? stats.hp ?? remainingHp;
      stats.hp = stats.maxHp;
      run(db, 'UPDATE npcs SET stats = ?, alive = ? WHERE id = ?',
        [JSON.stringify(stats), remainingHp <= 0 ? 0 : 1, defender.npc_id]);
    }
  }

  applyActorStance(db, attacker, intent);

  let killReward: string | undefined;
  if (result.defenderKilled && attacker.character_id && defender.side === 'enemy') {
    killReward = awardVictorySpoils(db, attacker.character_id, defender, encounterId);
  }

  return { result, killReward };
}

function buildCombatantProfile(db: Database, row: any): Combatant {
  const character = row.character_id
    ? get(db, 'SELECT * FROM characters WHERE id = ?', [row.character_id]) as any
    : null;
  const npc = row.npc_id
    ? get(db, 'SELECT * FROM npcs WHERE id = ?', [row.npc_id]) as any
    : null;
  const npcStats = safeJsonObject(npc?.stats);
  return {
    id: row.id,
    name: row.name,
    charClass: character?.char_class || npc?.char_class || 'fighter',
    level: character?.level || npc?.level || 1,
    thac0: row.thac0,
    ac: row.ac,
    hp: row.current_hp,
    maxHp: row.max_hp,
    str: character?.str || npcStats.str || 10,
    strPercentile: character?.str_percentile || undefined,
    dex: character?.dex || npcStats.dex || 10,
    weaponSpeed: row.weapon_speed || 5,
    weaponDamageSm: String(npcStats.damage || inferWeaponDamage(row)),
    weaponDamageLg: String(npcStats.damage || inferWeaponDamage(row)),
    isLargeTarget: false,
    conditions: safeConditions(row.conditions),
    side: row.side,
  };
}

function applyAttackAdjustments(
  profile: Combatant,
  attacker: any,
  defender: any,
  battlefield: BattlefieldProfile,
  intent: TacticalIntent,
): Combatant {
  const adjusted = { ...profile };
  let shift = 0;

  if (intent.flanking && !battlefield.chokepoint) shift -= 2;
  if (intent.steadyingShot && battlefield.visibility !== 'clear') shift -= 1;
  if (intent.chokeControl && battlefield.chokepoint) shift -= 1;
  if (intent.defensive) shift += 1;
  if (battlefield.visibility === 'dark') shift += 2;
  else if (battlefield.visibility === 'murky') shift += 1;
  if (battlefield.footing === 'treacherous') shift += 1;
  if (battlefield.footing === 'uneven' && intent.ranged) shift += 1;
  if (battlefield.cover && intent.ranged && !intent.steadyingShot) shift += 1;

  const attackerConditions = safeConditions(attacker.conditions);
  const defenderConditions = safeConditions(defender.conditions);
  if (attackerConditions.includes('off_balance')) shift += 1;
  if (attackerConditions.includes('shaken')) shift += 1;
  if (defenderConditions.includes('off_balance')) shift -= 1;
  if (defenderConditions.includes('wounded')) shift -= 1;

  adjusted.thac0 += shift;
  return adjusted;
}

function applyDefenseAdjustments(
  profile: Combatant,
  defender: any,
  battlefield: BattlefieldProfile,
): Combatant {
  const adjusted = { ...profile };
  const conditions = safeConditions(defender.conditions);
  if (battlefield.cover && conditions.includes('in_cover')) adjusted.ac -= 2;
  if (battlefield.chokepoint && conditions.includes('holding_choke')) adjusted.ac -= 1;
  if (conditions.includes('braced')) adjusted.ac -= 1;
  if (conditions.includes('off_balance')) adjusted.ac += 2;
  if (conditions.includes('shaken')) adjusted.ac += 1;
  if (battlefield.footing === 'treacherous') adjusted.ac += 1;
  return adjusted;
}

function applyActorStance(db: Database, attacker: any, intent: TacticalIntent) {
  let next = safeConditions(attacker.conditions)
    .filter((condition) => !['in_cover', 'braced', 'holding_choke'].includes(condition));
  if (intent.usingCover) next = appendConditionList(next, ['in_cover']);
  if (intent.defensive) next = appendConditionList(next, ['braced']);
  if (intent.chokeControl) next = appendConditionList(next, ['holding_choke']);
  run(db, 'UPDATE combatants SET conditions = ? WHERE id = ?', [JSON.stringify(next), attacker.id]);
}

function appendConditionList(current: string[], extras: string[]) {
  const merged = [...current];
  for (const extra of extras) {
    if (!merged.includes(extra)) merged.push(extra);
  }
  return merged;
}

function buildEncounterSetupProfile(sceneState: any, battlefield: BattlefieldProfile): EncounterSetupProfile {
  const secured = Boolean(sceneState?.secured);
  const fallbackPoint = Boolean(sceneState?.fallbackPoint);
  const knownHazard = Boolean(sceneState?.knownHazard);
  const trapDisarmed = Boolean(sceneState?.trapDisarmed);
  const obstacleCleared = Boolean(sceneState?.obstacleCleared);

  const profile: EncounterSetupProfile = {
    partySurpriseModifier: 0,
    enemySurpriseModifier: 0,
    partyInitiativeShift: 0,
    enemyInitiativeShift: 0,
    partyConditions: [],
    enemyConditions: [],
    openingNotes: [],
  };

  if (secured) {
    profile.partySurpriseModifier += 2;
    profile.enemySurpriseModifier -= 2;
    profile.partyInitiativeShift -= 1;
    profile.openingNotes.push('The party meets contact from prepared ground instead of panic.');
    profile.partyConditions = appendConditionList(profile.partyConditions, ['braced']);
  }

  if (fallbackPoint) {
    profile.partySurpriseModifier += 1;
    profile.partyInitiativeShift -= 1;
    profile.openingNotes.push('A marked fallback lane keeps the company from bunching when steel comes out.');
    if (battlefield.cover) {
      profile.partyConditions = appendConditionList(profile.partyConditions, ['in_cover']);
    }
    if (battlefield.chokepoint) {
      profile.partyConditions = appendConditionList(profile.partyConditions, ['holding_choke']);
    }
  }

  if (knownHazard) {
    profile.enemySurpriseModifier -= 1;
    profile.enemyInitiativeShift += 1;
    profile.openingNotes.push('The company already knows where the floor, edge, or trap line becomes lethal.');
    profile.enemyConditions = appendConditionList(profile.enemyConditions, ['off_balance']);
  }

  if (trapDisarmed || obstacleCleared) {
    profile.partyInitiativeShift -= 1;
    profile.openingNotes.push('The route is already worked open, so the party can react without scrambling through its own mess.');
  }

  return profile;
}

function applyInitiativeSetup(
  initiative: ReturnType<typeof rollGroupInitiative> | ReturnType<typeof rollIndividualInitiative>,
  setup: EncounterSetupProfile,
) {
  const adjustedOrder = initiative.order
    .map((entry) => ({
      ...entry,
      initiative: entry.initiative + (entry.side === 'party' ? setup.partyInitiativeShift : setup.enemyInitiativeShift),
    }))
    .sort((left, right) => left.initiative - right.initiative);

  return {
    ...initiative,
    partyRoll: typeof initiative.partyRoll === 'number' ? initiative.partyRoll + setup.partyInitiativeShift : initiative.partyRoll,
    enemyRoll: typeof initiative.enemyRoll === 'number' ? initiative.enemyRoll + setup.enemyInitiativeShift : initiative.enemyRoll,
    order: adjustedOrder,
  };
}

function safeConditions(raw: any) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw || '[]') : raw;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function setCombatantConditions(db: Database, combatant: any, conditions: string[]) {
  run(db, 'UPDATE combatants SET conditions = ? WHERE id = ?', [JSON.stringify(conditions), combatant.id]);
}

function setCombatantHp(db: Database, combatant: any, nextHp: number) {
  const remainingHp = Math.max(0, nextHp);
  run(db, 'UPDATE combatants SET current_hp = ? WHERE id = ?', [remainingHp, combatant.id]);
  if (combatant.character_id) {
    run(db, 'UPDATE characters SET hp = ?, status = ? WHERE id = ?',
      [remainingHp, remainingHp <= 0 ? 'dead' : 'active', combatant.character_id]);
  }
  if (combatant.npc_id) {
    const npc = get(db, 'SELECT stats FROM npcs WHERE id = ?', [combatant.npc_id]) as any;
    const stats = safeJsonObject(npc?.stats);
    stats.currentHp = remainingHp;
    stats.maxHp = stats.maxHp ?? stats.hp ?? remainingHp;
    stats.hp = stats.maxHp;
    run(db, 'UPDATE npcs SET stats = ?, alive = ? WHERE id = ?',
      [JSON.stringify(stats), remainingHp <= 0 ? 0 : 1, combatant.npc_id]);
  }
}

function inferWeaponDamage(row: any) {
  const name = String(row.name || '').toLowerCase();
  if (/wight|guard|hunter|handler/.test(name)) return '1d8';
  if (/archer|crossbow|skirmisher|scout/.test(name)) return '1d6';
  if (/swarm/.test(name)) return '1d4';
  return '1d6';
}

function inferUndeadType(name: string): string | null {
  const lowered = String(name || '').toLowerCase();
  if (/skeleton/.test(lowered)) return 'Skeleton';
  if (/zombie/.test(lowered)) return 'Zombie';
  if (/ghoul/.test(lowered)) return 'Ghoul';
  if (/shadow/.test(lowered)) return 'Shadow';
  if (/wight/.test(lowered)) return 'Wight';
  if (/ghast/.test(lowered)) return 'Ghast';
  if (/wraith/.test(lowered)) return 'Wraith';
  if (/mummy/.test(lowered)) return 'Mummy';
  if (/spectre/.test(lowered)) return 'Spectre';
  if (/vampire/.test(lowered)) return 'Vampire';
  if (/ghost/.test(lowered)) return 'Ghost';
  if (/lich/.test(lowered)) return 'Lich';
  if (/restless dead/.test(lowered)) return 'Skeleton';
  return null;
}

function isProfaneTarget(name: string) {
  return /wight|undead|skeleton|zombie|acolyte|fanatic|cult|demon|shadow|wraith|ghost|lich/i.test(String(name || ''));
}

function evaluateEnemyState(db: Database, encounter: any, defender: any, attacker: any) {
  const narration: { actor: string; content: string }[] = [];
  const refreshed = getEncounterCombatants(db, encounter.id);
  const enemies = refreshed.filter((c) => c.side === 'enemy');
  const livingEnemies = enemies.filter((c) => c.current_hp > 0);
  const fallenEnemies = enemies.length - livingEnemies.length;
  const campaignState = getCampaignState(db, encounter.campaign_id);

  if (livingEnemies.length === 0) {
    concludeEncounter(db, encounter.id, 'resolved');
    rewardFactionAfterEncounter(db, encounter.campaign_id, enemies, 'defeated');
    narration.push({ actor: 'DM', content: 'The last of the opposition falls. The room belongs to the party, for the moment.' });
    return { ended: true, narration };
  }

  const leaderDropped = defender.side === 'enemy'
    && refreshed.find((c) => c.id === defender.id)?.current_hp <= 0
    && /guard|handler|wight|acolyte/i.test(defender.name);
  const shouldTestMorale = fallenEnemies >= Math.ceil(enemies.length / 2) || leaderDropped;
  if (shouldTestMorale) {
    const moraleBase = averageEnemyMorale(enemies, campaignState.factions);
    const moralePenalty = fallenEnemies >= Math.ceil(enemies.length / 2) ? -2 : -1;
    const morale = checkMorale(moraleBase, moralePenalty);
    if (!morale.holds) {
      const outcome = /rival delver|treasure hunter|skirmisher|scout/i.test(enemies.map((enemy) => enemy.name).join(' '))
        ? 'fled'
        : attacker.side === 'party' && /parley|quarter|yield/i.test(attacker.name)
          ? 'resolved'
          : 'fled';
      concludeEncounter(db, encounter.id, outcome);
      rewardFactionAfterEncounter(db, encounter.campaign_id, enemies, outcome === 'resolved' ? 'routed' : 'bloodied');
      narration.push({
        actor: 'DM',
        content: outcome === 'fled'
          ? 'Enemy morale breaks. The survivors scatter, drag back, or vanish into safer dark rather than die to the last.'
          : 'The shaken survivors throw down the fight and beg for quarter.',
      });
      return { ended: true, narration };
    }
    narration.push({ actor: 'DM', content: 'The enemy line wavers but holds. Fear is in them now, even if discipline has not fully cracked.' });
  }

  return { ended: false, narration };
}

function evaluatePartyState(db: Database, encounter: any, defender: any, attacker?: any) {
  const narration: { actor: string; content: string }[] = [];
  const refreshed = getEncounterCombatants(db, encounter.id);
  const party = refreshed.filter((c) => c.side === 'party');
  const livingParty = party.filter((c) => c.current_hp > 0);
  const dyingParty = party.filter((c) => c.current_hp <= 0 && c.current_hp > -10 && c.character_id);
  const encounterScene = get(db, 'SELECT scene_id, campaign_id FROM encounters WHERE id = ?', [encounter.id]) as any;
  const campaignId: string = encounterScene?.campaign_id || '';
  const companionMods = getCompanionPartyModifiers(db, campaignId, encounterScene?.scene_id);

  if (livingParty.length === 0) {
    concludeEncounter(db, encounter.id, 'resolved');
    if (dyingParty.length > 0) {
      const names = dyingParty.map((c) => c.name).join(', ');
      narration.push({ actor: 'DM', content: `The last fighter still standing drops. ${names} ${dyingParty.length === 1 ? 'lies' : 'lie'} bleeding on the stone — dying, not yet dead. Without aid, the clock is running.` });
    } else {
      narration.push({ actor: 'DM', content: "The party is overwhelmed. The encounter is decided in the enemy's favor." });
    }
    return { ended: true, narration };
  }

  const defenderRefreshed = refreshed.find((c) => c.id === defender.id);
  if (defender.character_id && defenderRefreshed && defenderRefreshed.current_hp <= 0) {
    const charRecord = get(db, 'SELECT * FROM characters WHERE id = ?', [defender.character_id]) as any;
    const isDead = charRecord?.status === 'dead' || defenderRefreshed.current_hp <= -10;
    if (isDead) {
      // Record death
      const scene = get(db, 'SELECT name FROM scenes WHERE id = ?', [encounterScene?.scene_id]) as any;
      if (campaignId && charRecord) {
        const state = getCampaignState(db, campaignId);
        const campaign = get(db, 'SELECT session_number FROM campaigns WHERE id = ?', [campaignId]) as any;
        recordDeath(state, {
          characterName: charRecord.name,
          charClass: charRecord.char_class,
          level: charRecord.level,
          cause: `Slain by ${attacker?.name || 'the enemy'} in combat`,
          sceneName: scene?.name || 'the dungeon',
          sessionNumber: campaign?.session_number || 1,
        });
        checkAndAwardMilestone(state, 'the_fallen');
        // Faction heat: rivals may increase their activity
        shiftFactionStanding(state, 'delvers', { heat: 1 }, 'Rival delvers heard a party member fell. The heat is up.');
        saveCampaignState(db, campaignId, state);
      }
      narration.push({
        actor: 'DM',
        content: `${defender.name} is dead. Not downed — dead. The room is quieter for it in a way that has nothing to do with sound.`,
      });
      // Deep companion grief
      const fracture = resolveCompanionFracture(db, campaignId, encounterScene?.scene_id, refreshed, companionMods, true);
      narration.push(...fracture.narration);
      if (companionMods.cohesion > 0) {
        narration.push({ actor: 'DM', content: `The companions who are still standing fight on, but the loss of ${defender.name} has changed something. They will carry this.` });
      }
    } else {
      // Dying (0 to -9 HP)
      narration.push({
        actor: 'DM',
        content: `${attacker?.name || 'The enemy'} brings down ${defender.name}. Unconscious, bleeding — dying. Someone needs to reach them before the blood runs out.`,
      });
      const fracture = resolveCompanionFracture(db, campaignId, encounterScene?.scene_id, refreshed, companionMods, true);
      narration.push(...fracture.narration);
    }
    // Bloodied milestone
    if (campaignId) {
      const state = getCampaignState(db, campaignId);
      const milestone = checkAndAwardMilestone(state, 'bloodied');
      if (milestone) {
        narration.push({ actor: 'DM', content: milestone.narration });
        saveCampaignState(db, campaignId, state);
      }
    }
  } else if (livingParty.length <= Math.ceil(party.length / 2)) {
    narration.push({ actor: 'DM', content: 'The party is bloodied now. Every exchanged blow is starting to cost campaign-level momentum.' });
    const fracture = resolveCompanionFracture(db, campaignId, encounterScene?.scene_id, refreshed, companionMods, false);
    narration.push(...fracture.narration);
  }

  return { ended: false, narration };
}

function averageEnemyMorale(enemies: any[], factions?: Record<string, { heat?: number; reputation?: number }>) {
  const values = enemies.map((enemy) => inferMorale(enemy, factions?.[inferEnemyFactionKey(enemy)]));
  return Math.max(4, Math.min(11, Math.round(values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length))));
}

function inferMorale(enemy: any, faction?: { heat?: number; reputation?: number }) {
  const name = String(enemy.name || '').toLowerCase();
  let morale = 7;
  if (/wight|fanatic|guard/.test(name)) morale = 9;
  else if (/scout|skirmisher|hunter|goblin/.test(name)) morale = 6;
  else if (/swarm|rat|lizard/.test(name)) morale = 7;
  if (faction?.heat && faction.heat >= 6) morale += 1;
  if (faction?.reputation && faction.reputation <= -4) morale += 1;
  return Math.max(4, Math.min(11, morale));
}

function concludeEncounter(db: Database, encounterId: string, status: 'resolved' | 'fled') {
  const encounter = get(db, 'SELECT scene_id FROM encounters WHERE id = ?', [encounterId]) as any;
  if (encounter?.scene_id) {
    const existing = get(db, 'SELECT state_json, campaign_id FROM scene_state WHERE scene_id = ?', [encounter.scene_id]) as any;
    const state = safeJsonObject(existing?.state_json);
    state.cleared = status === 'resolved';
    state.secured = status === 'resolved' ? Boolean(state.secured) : false;
    run(db,
      'INSERT OR REPLACE INTO scene_state (scene_id, campaign_id, state_json, updated_at) VALUES (?, ?, ?, datetime(\"now\"))',
      [encounter.scene_id, existing?.campaign_id || get(db, 'SELECT campaign_id FROM encounters WHERE id = ?', [encounterId])?.campaign_id || '', JSON.stringify(state)]);
  }
  run(db, 'UPDATE encounters SET status = ? WHERE id = ?', [status, encounterId]);
}

function advanceEncounterTurn(db: Database, encounterId: string): {
  current: any;
  prompt?: TurnPrompt;
  bleedingNarration?: { actor: string; content: string }[];
} {
  const encounter = get(db, 'SELECT * FROM encounters WHERE id = ?', [encounterId]) as any;
  if (!encounter || encounter.status !== 'active') return { current: undefined };
  const combatants = getEncounterCombatants(db, encounterId);
  const turnOrder: string[] = JSON.parse(encounter.turn_order || '[]');
  const aliveIds = new Set(combatants.filter((c) => c.current_hp > 0).map((c) => c.id));
  if (!aliveIds.size) return { current: undefined };

  let index = Number(encounter.current_turn_index || 0);
  let round = Number(encounter.round || 1);
  let bleedingNarration: { actor: string; content: string }[] | undefined;

  for (let steps = 0; steps < turnOrder.length; steps++) {
    index = (index + 1) % turnOrder.length;
    if (index === 0) {
      round += 1;
      bleedingNarration = processDyingCharacters(db, encounterId, combatants, encounter.campaign_id);
    }
    const nextId = turnOrder[index];
    if (!aliveIds.has(nextId)) continue;
    const current = combatants.find((c) => c.id === nextId);
    if (!current) continue;
    clearTransientConditions(db, current);
    run(db, 'UPDATE encounters SET current_turn_index = ?, round = ? WHERE id = ?', [index, round, encounterId]);
    return {
      current,
      prompt: { combatantId: current.id, name: current.name, round },
      bleedingNarration,
    };
  }
  return { current: undefined, bleedingNarration };
}

function processDyingCharacters(db: Database, encounterId: string, combatants: any[], campaignId: string) {
  const notes: { actor: string; content: string }[] = [];
  const dying = combatants.filter((c) =>
    c.side === 'party' && c.character_id && Number(c.current_hp) <= 0 && Number(c.current_hp) > -10,
  );
  for (const c of dying) {
    const conditions = safeConditions(c.conditions);
    if (conditions.includes('stabilised')) continue; // First aid held the bleeding
    const newHp = Number(c.current_hp) - 1;
    run(db, 'UPDATE combatants SET current_hp = ? WHERE id = ?', [newHp, c.id]);
    if (newHp <= -10) {
      // Crossed into death
      run(db, 'UPDATE characters SET hp = ?, status = ? WHERE id = ?', [newHp, 'dead', c.character_id]);
      notes.push({ actor: 'DM', content: `${c.name} bleeds out. The last breath goes, and does not return.` });
      // Record death
      const charRecord = get(db, 'SELECT * FROM characters WHERE id = ?', [c.character_id]) as any;
      const state = getCampaignState(db, campaignId);
      const campaign = get(db, 'SELECT session_number, current_scene_id FROM campaigns WHERE id = ?', [campaignId]) as any;
      const scene = campaign?.current_scene_id
        ? get(db, 'SELECT name FROM scenes WHERE id = ?', [campaign.current_scene_id]) as any
        : null;
      recordDeath(state, {
        characterName: charRecord?.name || c.name,
        charClass: charRecord?.char_class || 'unknown',
        level: charRecord?.level || 1,
        cause: 'Bled out — no one reached them in time',
        sceneName: scene?.name || 'the dungeon',
        sessionNumber: campaign?.session_number || 1,
      });
      checkAndAwardMilestone(state, 'the_fallen');
      saveCampaignState(db, campaignId, state);
    } else {
      run(db, 'UPDATE characters SET hp = ? WHERE id = ?', [newHp, c.character_id]);
      notes.push({ actor: 'DM', content: `${c.name} loses another HP to blood loss. ${Math.abs(newHp)} points below zero. ${-newHp >= 8 ? 'The end is close.' : 'Time is running out.'}` });
    }
  }
  return notes.length > 0 ? notes : undefined;
}

function clearTransientConditions(db: Database, combatant: any) {
  const current = safeConditions(combatant.conditions);
  const kept = current.filter((condition) => !['in_cover', 'braced', 'holding_choke', 'off_balance'].includes(condition));
  if (kept.length !== current.length) {
    run(db, 'UPDATE combatants SET conditions = ? WHERE id = ?', [JSON.stringify(kept), combatant.id]);
  }
}

function hydrateEncounter(encounter: any) {
  return {
    ...encounter,
    turnOrder: JSON.parse(encounter.turn_order || '[]'),
  };
}

function awardVictorySpoils(db: Database, characterId: string, defender: any, encounterId: string) {
  const xp = Math.max(15, Number(defender.max_hp || 1) * 10);
  const gold = Math.max(3, Math.floor(Number(defender.max_hp || 1) / 2) + inferMorale(defender));
  const item = inferLoot(defender);
  const character = get(db, 'SELECT * FROM characters WHERE id = ?', [characterId]) as any;
  if (!character) return '';
  const campaignId: string = get(db, 'SELECT campaign_id FROM encounters WHERE id = ?', [encounterId])?.campaign_id || '';
  let inventory: any[] = [];
  try { inventory = JSON.parse(character?.inventory || '[]'); } catch {}
  const existing = inventory.find((entry: any) => entry.item === item);
  if (existing) existing.quantity += 1;
  else inventory.push({ item, weight: 1, quantity: 1, equipped: false });
  run(db, 'UPDATE characters SET gold = gold + ?, inventory = ? WHERE id = ?',
    [gold, JSON.stringify(inventory), characterId]);
  // Award kill XP through progression system (handles level-up)
  const levelResult = awardXp(db, characterId, xp, 'kill', campaignId);
  // First-blood milestone
  if (campaignId) {
    const state = getCampaignState(db, campaignId);
    const milestone = checkAndAwardMilestone(state, 'first_blood');
    if (milestone) {
      run(db, 'INSERT INTO game_log (id, campaign_id, type, actor, content) VALUES (?, ?, ?, ?, ?)',
        [uuid(), campaignId, 'milestone', 'DM', milestone.narration]);
      saveCampaignState(db, campaignId, state);
    }
  }
  run(db,
    'INSERT INTO game_log (id, campaign_id, type, actor, content) VALUES (?, ?, ?, ?, ?)',
    [uuid(), campaignId, 'system', 'DM', `Spoils claimed: ${gold} gp value, ${xp} xp, and ${item}.`]);
  let reward = `Victory has weight: you strip ${gold} gp in useful value, learn ${xp} xp worth of hard lessons, and recover ${item}.`;
  if (levelResult.levelled && levelResult.narration) {
    reward += ` ${levelResult.narration}`;
  }
  return reward;
}

function inferLoot(defender: any) {
  const name = String(defender.name || '').toLowerCase();
  if (/scout|skirmisher/.test(name)) return 'Bundle of Arrows';
  if (/guard|hunter|handler/.test(name)) return 'Serviceable Weapon Parts';
  if (/acolyte|fanatic/.test(name)) return 'Ritual Tokens';
  if (/wight|skeleton/.test(name)) return 'Grave Trinkets';
  return 'Monster Trophies';
}

function attemptRetreat(db: Database, encounter: any, combatants: any[], current: any) {
  const enemies = combatants.filter((c) => c.side === 'enemy' && c.current_hp > 0);
  const scene = get(db, 'SELECT * FROM scenes WHERE id = ?', [encounter.scene_id]) as any;
  const battlefield = buildBattlefieldProfile(scene);
  const enemyPressure = enemies.length + averageEnemyMorale(enemies, getCampaignState(db, encounter.campaign_id).factions);
  const terrainTax = battlefield.chokepoint ? 1 : battlefield.footing === 'treacherous' ? 2 : 0;
  const partyPressure = combatants.filter((c) => c.side === 'party' && c.current_hp > 0).length + Math.max(0, current.current_hp) - terrainTax;
  if (partyPressure >= enemyPressure - 1) {
    concludeEncounter(db, encounter.id, 'fled');
    return { narration: [{ actor: 'DM', content: 'The party disengages in rough order, giving ground but keeping most of its shape intact.' }] };
  }
  return { narration: [{ actor: 'DM', content: 'The retreat comes too late to be clean. The enemy presses close and the fight remains hot.' }] };
}

function attemptQuarter(db: Database, encounter: any, combatants: any[], current: any) {
  const enemies = combatants.filter((c) => c.side === 'enemy' && c.current_hp > 0);
  const morale = checkMorale(averageEnemyMorale(enemies, getCampaignState(db, encounter.campaign_id).factions), -3);
  if (!morale.holds) {
    concludeEncounter(db, encounter.id, 'resolved');
    return { narration: [{ actor: 'DM', content: 'The offer of quarter lands on shaken nerves. Weapons lower, curses replace lunges, and the combat breaks apart into surrender.' }] };
  }
  return { narration: [{ actor: 'DM', content: `${current.name} calls for quarter, but the enemy is still too committed to stop.` }] };
}

function describeRolePressure(combatant: any, attacking: boolean) {
  const name = String(combatant.name || '').toLowerCase();
  if (/scout|skirmisher/.test(name)) {
    return attacking
      ? `${combatant.name} fights like a skirmisher, testing angles and softer targets.`
      : `${combatant.name} looks like the kind of foe who wins by movement and bad positioning, not pure force.`;
  }
  if (/guard|hunter|handler/.test(name)) {
    return attacking
      ? `${combatant.name} presses with disciplined brutality, forcing the line instead of dancing around it.`
      : `${combatant.name} carries themselves like a front-line threat that wants to pin and punish.`;
  }
  if (/acolyte|fanatic|wight/.test(name)) {
    return attacking
      ? `${combatant.name} advances with unnerving commitment, as if morale costs them less than it should.`
      : `${combatant.name} has the air of a controller or zealot, the sort that can make a small fight feel wrong.`;
  }
  return attacking
    ? `${combatant.name} surges forward, turning pressure into immediate danger.`
    : `${combatant.name} adds weight to the room simply by being willing to close.`;
}

function inferEnemyRole(name: string) {
  const lowered = String(name || '').toLowerCase();
  if (/scout|skirmisher|crossbow|hunter|goblin/.test(lowered)) return 'skirmisher';
  if (/guard|handler|wolf|wight/.test(lowered)) return 'brute';
  if (/acolyte|fanatic|cult/.test(lowered)) return 'zealot';
  return 'raider';
}

function inferEnemyFactionKey(enemy: any) {
  const direct = String(enemy?.faction || '').toLowerCase();
  if (direct) return direct;
  const lowered = String(enemy?.name || '').toLowerCase();
  if (/acolyte|fanatic|wight|shadow/.test(lowered)) return 'shadows';
  if (/treasure|delver|skirmisher/.test(lowered)) return 'delvers';
  if (/guard|watch/.test(lowered)) return 'watch';
  return 'locals';
}

function resolveCompanionFracture(
  db: Database,
  campaignId: string,
  sceneId: string,
  combatants: any[],
  companionMods: ReturnType<typeof getCompanionPartyModifiers>,
  leaderDropped: boolean,
) {
  if (companionMods.volatileCount <= 0 && companionMods.fractureRisk <= 2) {
    return { narration: [] as Array<{ actor: string; content: string }> };
  }

  const companions = combatants.filter((combatant) => combatant.side === 'party' && combatant.npc_id && combatant.current_hp > 0);
  if (!companions.length) {
    return { narration: [] as Array<{ actor: string; content: string }> };
  }

  const shaky = companions.find((combatant) => /thief|bard|scout|retainer/i.test(String(combatant.name || ''))) || companions[0];
  const currentConditions = safeConditions(shaky.conditions);
  if (leaderDropped && companionMods.fractureRisk >= 4 && !currentConditions.includes('off_balance')) {
    setCombatantConditions(db, shaky, appendConditionList(currentConditions, ['off_balance']));
    return {
      narration: [{
        actor: 'DM',
        content: `${shaky.name} visibly cracks for a moment when the line loses someone important. The hesitation costs the party shape as much as courage.`,
      }],
    };
  }

  if (!leaderDropped && companionMods.cohesion <= 2 && companionMods.volatileCount >= 1 && !currentConditions.includes('shaken')) {
    setCombatantConditions(db, shaky, appendConditionList(currentConditions, ['off_balance', 'shaken']));
    return {
      narration: [{
        actor: 'DM',
        content: `${shaky.name} is still physically in the fight, but not emotionally in step with the company. The fracture shows in the way they give ground and second-guess.`,
      }],
    };
  }

  return { narration: [] as Array<{ actor: string; content: string }> };
}

function rewardFactionAfterEncounter(
  db: Database,
  campaignId: string,
  enemies: any[],
  outcome: 'defeated' | 'bloodied' | 'routed',
) {
  if (!enemies.length) return;
  const factionKey = inferEnemyFactionKey(enemies[0]);
  const state = getCampaignState(db, campaignId);
  if (outcome === 'defeated') {
    shiftFactionStanding(state, factionKey, { heat: 1, reputation: -1 }, `${factionKey} lost people to the party and will remember it.`);
  } else if (outcome === 'bloodied') {
    shiftFactionStanding(state, factionKey, { heat: 2 }, `${factionKey} survivors escaped and are spreading alarm.`);
  } else {
    shiftFactionStanding(state, factionKey, { heat: 1 }, `${factionKey} retreated and will regroup warier than before.`);
  }
  noteCampaignEvent(state, `Encounter with ${factionKey} ended ${outcome}.`);
  saveCampaignState(db, campaignId, state);
}

function inferEnemyAction(enemy: any, battlefield: BattlefieldProfile) {
  const name = String(enemy.name || '').toLowerCase();
  const role = inferEnemyRole(name);
  if (role === 'skirmisher') {
    if (battlefield.cover) return 'steadying shot from cover';
    if (!battlefield.chokepoint) return 'flank and shoot';
    return 'shoot';
  }
  if (role === 'brute') {
    return battlefield.chokepoint ? 'hold doorway and attack' : 'press attack';
  }
  if (role === 'zealot') {
    return battlefield.hazard ? 'drive them into hazard' : 'relentless attack';
  }
  return battlefield.chokepoint ? 'brace and attack' : 'attack';
}

function inferCompanionAction(companion: any, battlefield: BattlefieldProfile) {
  const role = String(companion.name || '').toLowerCase();
  if (/thief|quick|scout|bard/.test(role)) {
    return battlefield.cover ? 'take cover and aim' : battlefield.hazard ? 'flank and drive them into the hazard' : 'flank and strike';
  }
  if (/cleric|warden|druid/.test(role)) {
    return battlefield.chokepoint ? 'brace and hold' : 'steady attack';
  }
  return battlefield.chokepoint ? 'hold doorway and attack' : 'press attack';
}

function buildBattlefieldProfile(scene: any): BattlefieldProfile {
  const loweredBrief = String(scene?.brief || '').toLowerCase();
  const terrain = String(scene?.terrain_type || 'indoor').toLowerCase();
  const light = String(scene?.light_level || 'normal').toLowerCase();
  const blueprint = scene ? buildSceneBlueprint(scene) : null;

  const visibility = light === 'dark' ? 'dark' : light === 'dim' ? 'murky' : 'clear';
  const cover = /pillar|rubble|crate|altar|stalag|wagon|statue|barricade/.test(loweredBrief)
    || terrain === 'ruins'
    || terrain === 'town';
  const chokepoint = /narrow|crawlspace|bridge|hatch|door|portcullis|hallway|passage/.test(loweredBrief)
    || Boolean(blueprint?.obstacle && /portcullis|crawlspace|hatch/.test(blueprint.obstacle));
  const footing = terrain === 'cave' || /slope|slick|dust|broken|loose|debris/.test(loweredBrief)
    ? 'uneven'
    : terrain === 'ruins' || /spike|ledge|pit|fractured/.test(loweredBrief)
      ? 'treacherous'
      : 'stable';
  const hazard = /pit|brazi|fire|ledge|acid|spike/.test(loweredBrief)
    ? extractHazard(loweredBrief)
    : blueprint?.trap?.kind || null;

  return {
    visibility,
    cover,
    chokepoint,
    hazard,
    footing,
    pressure: blueprint?.pressure || 'The space itself keeps pushing decisions toward risk.',
  };
}

function buildTacticalAdvice(battlefield: BattlefieldProfile): string[] {
  const advice: string[] = [];
  if (battlefield.chokepoint) advice.push('Holding the line or forcing a doorway matters here.');
  if (battlefield.cover) advice.push('Cover is worth claiming before trading ranged attacks.');
  if (battlefield.hazard) advice.push(`Shoves and bad footing can spill someone into ${battlefield.hazard}.`);
  if (battlefield.visibility !== 'clear') advice.push('Aimed shots and careful positioning beat reckless speed.');
  if (battlefield.footing !== 'stable') advice.push('Uneven ground makes movement and missile work less reliable.');
  if (advice.length === 0) advice.push('This is a cleaner battlefield; tempo and target choice matter most.');
  return advice;
}

function describeBattlefieldOpening(battlefield: BattlefieldProfile) {
  const parts = [battlefield.pressure];
  if (battlefield.chokepoint) parts.push('The ground favors whoever controls the narrow line.');
  if (battlefield.cover) parts.push('There is enough cover here for ranged pressure and cautious movement to matter.');
  if (battlefield.hazard) parts.push(`A nearby environmental threat matters here: ${battlefield.hazard}.`);
  if (battlefield.visibility !== 'clear') parts.push('Sightlines are imperfect, so certainty comes at a cost.');
  return parts.join(' ');
}

function describeBattlefieldPressure(battlefield: BattlefieldProfile, action: string, attacking: boolean) {
  if (/flank/.test(action) && !battlefield.chokepoint) {
    return attacking
      ? 'They use the room to widen the angle and threaten a flank.'
      : 'The space leaves enough room for flanking pressure if you let them spread out.';
  }
  if (/cover/.test(action) && battlefield.cover) {
    return attacking
      ? 'They keep part of their body hidden behind the room itself while they work.'
      : 'The battlefield offers cover worth fighting over.';
  }
  if (/hazard|push|shove|drive/.test(action) && battlefield.hazard) {
    return `The fight keeps threatening to spill into ${battlefield.hazard}.`;
  }
  if (battlefield.chokepoint) {
    return 'Control of the narrow ground matters almost as much as the swing itself.';
  }
  if (battlefield.visibility !== 'clear') {
    return 'Poor sight and broken lines keep everyone half a step less certain.';
  }
  return battlefield.pressure;
}

function parseTacticalIntent(action: string, battlefield: BattlefieldProfile): TacticalIntent {
  return {
    ranged: /shoot|fire|arrow|bolt|throw/.test(action),
    defensive: /defend|brace|guard|hold/.test(action),
    flanking: /flank|circle|side|around/.test(action),
    usingCover: battlefield.cover && /cover|behind|pillar|rubble|duck/.test(action),
    forcingHazard: Boolean(battlefield.hazard) && /shove|push|drive|hazard|pit|fire|ledge|spike/.test(action),
    steadyingShot: /aim|steady|careful shot/.test(action),
    chokeControl: battlefield.chokepoint && /door|gate|hall|bridge|hold line|doorway/.test(action),
  };
}

function rollHazardDamage(battlefield: BattlefieldProfile) {
  if (!battlefield.hazard) return 0;
  if (/spike|pit/.test(battlefield.hazard)) return 4;
  if (/fire|brazi/.test(battlefield.hazard)) return 3;
  if (/ledge|drop/.test(battlefield.hazard)) return 5;
  return 2;
}

function extractHazard(brief: string) {
  if (/pit/.test(brief)) return 'an open pit';
  if (/fire|brazi/.test(brief)) return 'open flame and hot iron';
  if (/ledge|drop/.test(brief)) return 'a dangerous drop';
  if (/spike/.test(brief)) return 'exposed spikes';
  if (/acid/.test(brief)) return 'corrosive runoff';
  return 'bad footing and sharp ruin';
}

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function safeJsonObject(raw?: string) {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
