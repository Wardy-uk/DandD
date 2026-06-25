import { v4 as uuid } from 'uuid';
import type { Database } from 'sql.js';
import type { Server as SocketServer } from 'socket.io';
import { all, get, run } from '../db/helpers.js';
import {
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
