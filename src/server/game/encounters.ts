import { v4 as uuid } from 'uuid';
import type { Database } from 'sql.js';
import type { Server as SocketServer } from 'socket.io';
import { all, get, run } from '../db/helpers.js';
import {
  checkMorale,
  resolveAttack,
  resolveMissileAttack,
  rollGroupInitiative,
  rollIndividualInitiative,
  rollSurpriseCheck,
  type Combatant,
} from '../engine/combat.js';
import type { ProceduralEnemy } from './adventure.js';

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

export function createEncounterRecord(params: {
  db: Database;
  campaignId: string;
  sceneId: string;
  enemies: ProceduralEnemy[];
  initiativeType?: 'group' | 'individual';
}): StartedEncounter {
  const { db, campaignId, sceneId, enemies, initiativeType } = params;
  const encounterId = uuid();

  const partyChars = all(db,
    'SELECT * FROM characters WHERE campaign_id = ? AND status = "active"',
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

  const allCombatants = [...partyCombatants, ...enemyCombatants];
  const initiative = initiativeType === 'individual'
    ? rollIndividualInitiative(allCombatants)
    : rollGroupInitiative(partyCombatants, enemyCombatants);
  const surprise = rollSurpriseCheck();

  run(db, `
    INSERT INTO encounters (id, campaign_id, scene_id, status, round, initiative_type, turn_order, current_turn_index)
    VALUES (?, ?, ?, 'active', 1, ?, ?, 0)
  `, [encounterId, campaignId, sceneId, initiativeType || 'group', JSON.stringify(initiative.order.map((o) => o.id))]);

  for (const c of allCombatants) {
    const orderEntry = initiative.order.find((o) => o.id === c.id);
    const isSurprised = c.side === 'party' ? surprise.partySurprised : surprise.enemySurprised;
    run(db, `
      INSERT INTO combatants (id, encounter_id, character_id, npc_id, name, side, initiative_roll, weapon_speed, final_initiative, current_hp, max_hp, thac0, ac, conditions, is_surprised)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      c.id,
      encounterId,
      c.side === 'party' ? partyChars.find((pc) => pc.name === c.name)?.id : null,
      null,
      c.name,
      c.side,
      orderEntry?.initiative || 0,
      c.weaponSpeed,
      orderEntry?.initiative || 0,
      c.hp,
      c.maxHp,
      c.thac0,
      c.ac,
      JSON.stringify(c.conditions || []),
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

  return { encounter, initiative, surpriseSummary };
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

export function resolveEncounterAction(params: {
  db: Database;
  campaignId: string;
  encounterId: string;
  action: string;
  actingCharacterId?: string | null;
}): EncounterActionResolution {
  const { db, campaignId, encounterId, action, actingCharacterId } = params;
  const encounter = get(db, 'SELECT * FROM encounters WHERE id = ?', [encounterId]) as any;
  if (!encounter || encounter.status !== 'active') {
    return { ok: false, error: 'No active encounter.', narration: [], combatResults: [], updatedCharacterIds: [] };
  }

  const combatants = getEncounterCombatants(db, encounterId);
  const current = getCurrentTurnCombatant(encounter, combatants);
  if (!current) {
    return { ok: false, error: 'Encounter has no valid turn holder.', narration: [], combatResults: [], updatedCharacterIds: [] };
  }
  if (current.side !== 'party') {
    return { ok: false, error: `It is ${current.name}'s turn, and the party is still under pressure.`, narration: [], combatResults: [], updatedCharacterIds: [] };
  }
  if (actingCharacterId && current.character_id && current.character_id !== actingCharacterId) {
    return { ok: false, error: `It is ${current.name}'s turn right now.`, narration: [], combatResults: [], updatedCharacterIds: [] };
  }

  const lowered = action.toLowerCase();
  const narration: { actor: string; content: string }[] = [];
  const combatResults: any[] = [];
  const updatedCharacterIds = new Set<string>();

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

  const playerStrike = resolveAttackExchange(db, encounter.id, current, target, lowered);
  combatResults.push(playerStrike.result);
  narration.push({
    actor: 'DM',
    content: describeRolePressure(target, false),
  });
  if (current.character_id) updatedCharacterIds.add(current.character_id);
  if (target.character_id) updatedCharacterIds.add(target.character_id);

  if (playerStrike.killReward) {
    narration.push({ actor: 'DM', content: playerStrike.killReward });
  }

  const enemyState = evaluateEnemyState(db, encounter, combatants, target, current);
  narration.push(...enemyState.narration);

  if (enemyState.ended) {
    return finishResolution(db, encounter.id, narration, combatResults, updatedCharacterIds);
  }

  let advanced = advanceEncounterTurn(db, encounter.id);
  let loopGuard = 0;
  while (advanced.prompt && advanced.current?.side === 'enemy' && loopGuard < 8) {
    const enemyActor = advanced.current;
    const partyTarget = chooseEnemyTarget(combatants);
    if (!partyTarget) {
      break;
    }
    const enemyStrike = resolveAttackExchange(db, encounter.id, enemyActor, partyTarget, inferEnemyAction(enemyActor));
    combatResults.push(enemyStrike.result);
    narration.push({
      actor: 'DM',
      content: `${describeRolePressure(enemyActor, true)} ${enemyStrike.result.description}`,
    });
    if (partyTarget.character_id) updatedCharacterIds.add(partyTarget.character_id);
    const partyState = evaluatePartyState(db, encounter, combatants, partyTarget);
    narration.push(...partyState.narration);
    if (partyState.ended) {
      return finishResolution(db, encounter.id, narration, combatResults, updatedCharacterIds);
    }
    advanced = advanceEncounterTurn(db, encounter.id);
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

function chooseTargetFromAction(action: string, combatants: any[], side: 'enemy' | 'party') {
  const living = combatants.filter((c) => c.side === side && c.current_hp > 0);
  if (!living.length) return null;
  const exact = living.find((c) => action.includes(c.name.toLowerCase()));
  return exact || living[0];
}

function chooseEnemyTarget(combatants: any[]) {
  const party = combatants
    .filter((c) => c.side === 'party' && c.current_hp > 0)
    .sort((a, b) => a.current_hp - b.current_hp || a.ac - b.ac);
  return party[0] || null;
}

function resolveAttackExchange(db: Database, encounterId: string, attacker: any, defender: any, action: string) {
  const ranged = /shoot|fire|arrow|bolt|throw/.test(action);
  const attackerCombatant = buildCombatantProfile(db, attacker);
  const defenderCombatant = buildCombatantProfile(db, defender);
  const result = ranged
    ? resolveMissileAttack(attackerCombatant, defenderCombatant, 'short')
    : resolveAttack(attackerCombatant, defenderCombatant);

  if (result.hit && result.defenderHpAfter !== undefined) {
    const remaining = Math.max(0, result.defenderHpAfter);
    run(db, 'UPDATE combatants SET current_hp = ?, conditions = ? WHERE id = ?',
      [remaining, JSON.stringify(updateConditions(defender.conditions, remaining <= 0 ? 'down' : 'wounded')), defender.id]);
    if (defender.character_id) {
      run(db, 'UPDATE characters SET hp = ?, status = ? WHERE id = ?',
        [remaining, remaining <= 0 ? 'dead' : 'active', defender.character_id]);
    }
  }

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
  return {
    id: row.id,
    name: row.name,
    charClass: character?.char_class || 'fighter',
    level: character?.level || 1,
    thac0: row.thac0,
    ac: row.ac,
    hp: row.current_hp,
    maxHp: row.max_hp,
    str: character?.str || 10,
    strPercentile: character?.str_percentile || undefined,
    dex: character?.dex || 10,
    weaponSpeed: row.weapon_speed || 5,
    weaponDamageSm: inferWeaponDamage(row),
    weaponDamageLg: inferWeaponDamage(row),
    isLargeTarget: false,
    conditions: JSON.parse(row.conditions || '[]'),
    side: row.side,
  };
}

function inferWeaponDamage(row: any) {
  const name = String(row.name || '').toLowerCase();
  if (/wight|guard|hunter|handler/.test(name)) return '1d8';
  if (/archer|crossbow|skirmisher|scout/.test(name)) return '1d6';
  if (/swarm/.test(name)) return '1d4';
  return '1d6';
}

function updateConditions(raw: string, next: string) {
  let conditions: string[] = [];
  try { conditions = JSON.parse(raw || '[]'); } catch {}
  if (!conditions.includes(next)) conditions.push(next);
  return conditions;
}

function evaluateEnemyState(db: Database, encounter: any, combatants: any[], defender: any, attacker: any) {
  const narration: { actor: string; content: string }[] = [];
  const refreshed = getEncounterCombatants(db, encounter.id);
  const enemies = refreshed.filter((c) => c.side === 'enemy');
  const livingEnemies = enemies.filter((c) => c.current_hp > 0);
  const fallenEnemies = enemies.length - livingEnemies.length;

  if (livingEnemies.length === 0) {
    concludeEncounter(db, encounter.id, 'resolved');
    narration.push({ actor: 'DM', content: 'The last of the opposition falls. The room belongs to the party, for the moment.' });
    return { ended: true, narration };
  }

  const leaderDropped = defender.side === 'enemy' && defender.current_hp > 0 && refreshed.find((c) => c.id === defender.id)?.current_hp <= 0 && /guard|handler|wight|acolyte/i.test(defender.name);
  const shouldTestMorale = fallenEnemies >= Math.ceil(enemies.length / 2) || leaderDropped;
  if (shouldTestMorale) {
    const moraleBase = averageEnemyMorale(enemies);
    const morale = checkMorale(moraleBase, fallenEnemies >= Math.ceil(enemies.length / 2) ? -2 : -1);
    if (!morale.holds) {
      const outcome = attacker.side === 'party' && /parley|quarter|yield/i.test(attacker.name)
        ? 'resolved'
        : 'fled';
      concludeEncounter(db, encounter.id, outcome);
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
  if (livingParty.length === 0) {
    concludeEncounter(db, encounter.id, 'resolved');
    narration.push({ actor: 'DM', content: 'The party is overwhelmed. The encounter is decided in the enemy’s favor.' });
    return { ended: true, narration };
  }

  if (defender.character_id && refreshed.find((c) => c.id === defender.id)?.current_hp <= 0) {
    narration.push({
      actor: 'DM',
      content: `${attacker?.name || 'The enemy'} drops ${defender.name}. The rest of the party suddenly has to decide whether this is still a fight or the start of a retreat.`,
    });
  } else if (livingParty.length <= Math.ceil(party.length / 2)) {
    narration.push({ actor: 'DM', content: 'The party is bloodied now. Every exchanged blow is starting to cost campaign-level momentum.' });
  }

  return { ended: false, narration };
}

function averageEnemyMorale(enemies: any[]) {
  const values = enemies.map((enemy) => inferMorale(enemy));
  return Math.max(4, Math.min(11, Math.round(values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length))));
}

function inferMorale(enemy: any) {
  const name = String(enemy.name || '').toLowerCase();
  if (/wight|fanatic|guard/.test(name)) return 9;
  if (/scout|skirmisher|hunter|goblin/.test(name)) return 6;
  if (/swarm|rat|lizard/.test(name)) return 7;
  return 7;
}

function concludeEncounter(db: Database, encounterId: string, status: 'resolved' | 'fled') {
  run(db, 'UPDATE encounters SET status = ? WHERE id = ?', [status, encounterId]);
}

function advanceEncounterTurn(db: Database, encounterId: string) {
  const encounter = get(db, 'SELECT * FROM encounters WHERE id = ?', [encounterId]) as any;
  if (!encounter || encounter.status !== 'active') return { prompt: undefined, current: undefined };
  const combatants = getEncounterCombatants(db, encounterId);
  const turnOrder: string[] = JSON.parse(encounter.turn_order || '[]');
  const aliveIds = new Set(combatants.filter((c) => c.current_hp > 0).map((c) => c.id));
  if (!aliveIds.size) return { prompt: undefined, current: undefined };

  let index = Number(encounter.current_turn_index || 0);
  let round = Number(encounter.round || 1);
  for (let steps = 0; steps < turnOrder.length; steps++) {
    index = (index + 1) % turnOrder.length;
    if (index === 0) round += 1;
    const nextId = turnOrder[index];
    if (!aliveIds.has(nextId)) continue;
    const current = combatants.find((c) => c.id === nextId);
    if (!current) continue;
    run(db, 'UPDATE encounters SET current_turn_index = ?, round = ? WHERE id = ?', [index, round, encounterId]);
    return {
      current,
      prompt: { combatantId: current.id, name: current.name, round },
    };
  }
  return { prompt: undefined, current: undefined };
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
  const character = get(db, 'SELECT inventory FROM characters WHERE id = ?', [characterId]) as any;
  let inventory: any[] = [];
  try { inventory = JSON.parse(character?.inventory || '[]'); } catch {}
  const existing = inventory.find((entry) => entry.item === item);
  if (existing) existing.quantity += 1;
  else inventory.push({ item, weight: 1, quantity: 1, equipped: false });
  run(db, 'UPDATE characters SET xp = xp + ?, gold = gold + ?, inventory = ? WHERE id = ?',
    [xp, gold, JSON.stringify(inventory), characterId]);
  run(db,
    'INSERT INTO game_log (id, campaign_id, type, actor, content) VALUES (?, (SELECT campaign_id FROM encounters WHERE id = ?), ?, ?, ?)',
    [uuid(), encounterId, 'system', 'DM', `Spoils claimed: ${gold} gp value, ${xp} xp, and ${item}.`]);
  return `Victory has weight: you strip ${gold} gp in useful value, learn ${xp} xp worth of hard lessons, and recover ${item}.`;
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
  const enemyPressure = enemies.length + averageEnemyMorale(enemies);
  const partyPressure = combatants.filter((c) => c.side === 'party' && c.current_hp > 0).length + Math.max(0, current.current_hp);
  if (partyPressure >= enemyPressure - 1) {
    concludeEncounter(db, encounter.id, 'fled');
    return { narration: [{ actor: 'DM', content: 'The party disengages in rough order, giving ground but keeping most of its shape intact.' }] };
  }
  return { narration: [{ actor: 'DM', content: 'The retreat comes too late to be clean. The enemy presses close and the fight remains hot.' }] };
}

function attemptQuarter(db: Database, encounter: any, combatants: any[], current: any) {
  const enemies = combatants.filter((c) => c.side === 'enemy' && c.current_hp > 0);
  const morale = checkMorale(averageEnemyMorale(enemies), -3);
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

function inferEnemyAction(enemy: any) {
  const name = String(enemy.name || '').toLowerCase();
  if (/scout|skirmisher|crossbow/.test(name)) return 'shoot';
  return 'attack';
}
