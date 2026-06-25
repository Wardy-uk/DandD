import { v4 as uuid } from 'uuid';
import type { Database } from 'sql.js';
import { all, get, run } from '../db/helpers.js';

export interface CompanionRelationshipState {
  trust: number;
  bond: number;
  tension: number;
  respect: number;
  romance: number;
  companionStatus: 'available' | 'joined' | 'departed' | 'refused';
  lastBeat: string;
}

interface CompanionRow {
  id: string;
  name: string;
  race: string;
  char_class: string;
  level: number;
  personality: string;
  disposition: string;
  location_scene_id: string;
  stats: string;
  relationship_state: string;
  joined_party: number;
  companion_role: string;
  companion_order: number;
  alive: number;
}

export function seedStarterCompanions(db: Database, campaignId: string) {
  const campaign = get(db, 'SELECT current_scene_id, setting, start_mode, starter_party_seeded FROM campaigns WHERE id = ?', [campaignId]) as any;
  if (!campaign || campaign.start_mode !== 'party' || Number(campaign.starter_party_seeded || 0) === 1) {
    return;
  }

  const currentSceneId = String(campaign.current_scene_id || '');
  const setting = String(campaign.setting || 'Classic Fantasy Frontier').toLowerCase();
  const roster = buildStarterRoster(setting);

  for (const [index, npc] of roster.entries()) {
    run(db, `
      INSERT INTO npcs (
        id, campaign_id, name, race, char_class, level, personality, appearance, voice_notes,
        disposition, location_scene_id, stats, inventory, memory, alive, relationship_state,
        joined_party, companion_role, companion_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 1, ?, ?)
    `, [
      uuid(),
      campaignId,
      npc.name,
      npc.race,
      npc.charClass,
      npc.level,
      npc.personality,
      npc.appearance,
      npc.voiceNotes,
      'friendly',
      currentSceneId,
      JSON.stringify(npc.stats),
      JSON.stringify(npc.inventory),
      JSON.stringify(npc.memory),
      JSON.stringify({
        trust: 2,
        bond: 1,
        tension: 0,
        respect: 1,
        romance: 0,
        companionStatus: 'joined',
        lastBeat: `${npc.name} joined as part of the original company.`,
      }),
      npc.role,
      index,
    ]);
  }

  run(db, 'UPDATE campaigns SET starter_party_seeded = 1 WHERE id = ?', [campaignId]);
}

export function getPartyCompanions(db: Database, campaignId: string) {
  const rows = all(db, `
    SELECT id, name, race, char_class, level, personality, disposition, location_scene_id,
      stats, relationship_state, joined_party, companion_role, companion_order, alive
    FROM npcs
    WHERE campaign_id = ? AND alive = 1
    ORDER BY joined_party DESC, companion_order ASC, name ASC
  `, [campaignId]) as any[];

  return rows.map((row) => {
    const stats = safeJson(row.stats);
    const relationship = normalizeRelationshipState(safeJson(row.relationship_state));
    return {
      id: row.id,
      name: row.name,
      race: row.race,
      charClass: row.char_class,
      level: row.level,
      personality: row.personality,
      disposition: row.disposition,
      locationSceneId: row.location_scene_id,
      joinedParty: Number(row.joined_party || 0) === 1,
      companionRole: row.companion_role || '',
      hp: Number(stats.currentHp ?? stats.hp ?? 0),
      maxHp: Number(stats.maxHp ?? stats.hp ?? 0),
      ac: Number(stats.ac ?? 8),
      relationship,
      relationshipLabel: describeRelationship(relationship),
    };
  });
}

export function getSceneNpcRoster(db: Database, campaignId: string, sceneId: string) {
  const rows = all(db, `
    SELECT id, name, race, char_class, level, personality, disposition, location_scene_id,
      stats, relationship_state, joined_party, companion_role, companion_order, alive
    FROM npcs
    WHERE campaign_id = ? AND location_scene_id = ? AND alive = 1
    ORDER BY joined_party DESC, companion_order ASC, name ASC
  `, [campaignId, sceneId]) as CompanionRow[];

  return rows.map((row) => {
    const relationship = normalizeRelationshipState(safeJson(row.relationship_state));
    return {
      id: row.id,
      name: row.name,
      race: row.race,
      charClass: row.char_class,
      level: row.level,
      personality: row.personality,
      disposition: row.disposition,
      joinedParty: Number(row.joined_party || 0) === 1,
      companionRole: row.companion_role || inferCompanionRole(row.char_class),
      relationshipLabel: describeRelationship(relationship),
      relationship,
      recruitHint: Number(row.joined_party || 0) === 1
        ? `${row.name} already travels with the company.`
        : relationship.tension >= 3
          ? `${row.name} is wary. Earn trust before pressing again.`
          : `Try “Ask ${row.name} to join us” when you want to recruit them.`,
    };
  });
}

export function syncCompanionsToScene(db: Database, campaignId: string, sceneId: string) {
  run(db,
    'UPDATE npcs SET location_scene_id = ? WHERE campaign_id = ? AND joined_party = 1 AND alive = 1',
    [sceneId, campaignId]);
}

export function tryRecruitNpc(params: {
  db: Database;
  npcId: string;
  leaderCha: number;
  action: string;
}): { ok: boolean; content: string } {
  const { db, npcId, leaderCha, action } = params;
  const npc = get(db, 'SELECT * FROM npcs WHERE id = ?', [npcId]) as any;
  if (!npc || Number(npc.alive || 0) !== 1) {
    return { ok: false, content: 'There is no recruitable soul here to answer you.' };
  }
  if (Number(npc.joined_party || 0) === 1) {
    return { ok: true, content: `${npc.name} is already part of the company and moves with the party.` };
  }

  const relationship = normalizeRelationshipState(safeJson(npc.relationship_state));
  const pressure = Math.floor((leaderCha - 10) / 2) + relationship.trust + relationship.respect + relationship.bond - relationship.tension;
  const threshold = /swear|pledge|travel with us|join us/.test(action) ? 2 : 3;
  if (pressure >= threshold || npc.disposition === 'friendly' || npc.disposition === 'enthusiastic') {
    relationship.companionStatus = 'joined';
    relationship.trust += 1;
    relationship.bond += 1;
    relationship.lastBeat = `${npc.name} agreed to travel with the company.`;
    run(db,
      'UPDATE npcs SET joined_party = 1, disposition = ?, relationship_state = ?, companion_role = COALESCE(NULLIF(companion_role, \'\'), ?), companion_order = COALESCE(companion_order, 50) WHERE id = ?',
      ['friendly', JSON.stringify(relationship), inferCompanionRole(npc.char_class), npcId]);
    return { ok: true, content: `${npc.name} agrees to join the company. The decision feels personal, not transactional.` };
  }

  relationship.tension += 1;
  relationship.lastBeat = `${npc.name} refused recruitment pressure.`;
  run(db, 'UPDATE npcs SET disposition = ?, relationship_state = ? WHERE id = ?',
    [relationship.tension >= 3 ? 'unfriendly' : npc.disposition || 'neutral', JSON.stringify(relationship), npcId]);
  return { ok: false, content: `${npc.name} refuses for now. They are not ready to tie their fate to the company.` };
}

export function updateCompanionRelationships(params: {
  db: Database;
  npcIds: string[];
  kind: 'victory' | 'rest' | 'hazard' | 'greed' | 'parley' | 'romance' | 'friction' | 'security';
  note: string;
}) {
  const { db, npcIds, kind, note } = params;
  for (const npcId of npcIds) {
    const npc = get(db, 'SELECT relationship_state, disposition FROM npcs WHERE id = ?', [npcId]) as any;
    if (!npc) continue;
    const state = normalizeRelationshipState(safeJson(npc.relationship_state));
    switch (kind) {
      case 'victory':
        state.respect += 1;
        state.bond += 1;
        break;
      case 'rest':
        state.trust += 1;
        break;
      case 'hazard':
        state.tension += 1;
        state.trust -= 1;
        break;
      case 'greed':
        state.tension += 1;
        break;
      case 'parley':
        state.trust += 1;
        state.respect += 1;
        break;
      case 'romance':
        state.romance += 1;
        state.bond += 1;
        break;
      case 'friction':
        state.tension += 2;
        break;
      case 'security':
        state.trust += 1;
        state.bond += 1;
        break;
    }
    state.lastBeat = note;
    const nextDisposition = deriveDisposition(state);
    run(db, 'UPDATE npcs SET relationship_state = ?, disposition = ? WHERE id = ?',
      [JSON.stringify(state), nextDisposition, npcId]);
  }
}

export function resolveCompanionDrama(params: {
  db: Database;
  campaignId: string;
  sceneId: string;
  action: string;
  leaderName: string;
}) {
  const { db, campaignId, sceneId, action, leaderName } = params;
  const campaign = get(db, 'SELECT exploration_turn FROM campaigns WHERE id = ?', [campaignId]) as any;
  const turn = Number(campaign?.exploration_turn || 0);
  const joined = all(db, `
    SELECT id, name, race, char_class, level, personality, disposition, location_scene_id,
      stats, relationship_state, joined_party, companion_role, companion_order, alive
    FROM npcs
    WHERE campaign_id = ? AND location_scene_id = ? AND joined_party = 1 AND alive = 1
    ORDER BY companion_order ASC, name ASC
  `, [campaignId, sceneId]) as CompanionRow[];

  if (joined.length === 0) return [];

  const lowered = action.toLowerCase();
  const notes: string[] = [];
  const eventSeed = hashValue(`${campaignId}:${sceneId}:${turn}:${lowered}`);

  for (const npc of joined) {
    const state = normalizeRelationshipState(safeJson(npc.relationship_state));
    if (state.tension >= 7 && state.trust <= 0 && state.bond <= 1) {
      state.companionStatus = 'departed';
      state.lastBeat = `${npc.name} walked away from the company after one strain too many.`;
      run(db, 'UPDATE npcs SET joined_party = 0, disposition = ?, relationship_state = ? WHERE id = ?',
        ['unfriendly', JSON.stringify(state), npc.id]);
      notes.push(`${npc.name} finally loses patience with ${leaderName}'s leadership and leaves the company.`);
      continue;
    }

    if ((/rest|camp|watch|comfort|confide/.test(lowered) || eventSeed % 7 === 0) && state.trust >= 3 && state.bond >= 3 && state.romance <= 2) {
      state.romance += 1;
      state.lastBeat = `${npc.name} opened up to the company around a quiet moment.`;
      run(db, 'UPDATE npcs SET disposition = ?, relationship_state = ? WHERE id = ?',
        [deriveDisposition(state), JSON.stringify(state), npc.id]);
      notes.push(`${npc.name} lets the guard slip for a moment, and the company feels more intimate afterwards.`);
      break;
    }
  }

  if (joined.length >= 2) {
    for (let index = 0; index < joined.length - 1; index += 1) {
      const left = joined[index];
      const right = joined[index + 1];
      const leftState = normalizeRelationshipState(safeJson(left.relationship_state));
      const rightState = normalizeRelationshipState(safeJson(right.relationship_state));
      const pairSeed = hashValue(`${left.id}:${right.id}:${turn}:${lowered}`);

      if ((/force|divide|loot|risk|trap|danger/.test(lowered) || pairSeed % 5 === 0) && (leftState.tension + rightState.tension) >= 5) {
        leftState.tension += 1;
        rightState.tension += 1;
        leftState.lastBeat = `${left.name} and ${right.name} argued about the risks the company is taking.`;
        rightState.lastBeat = leftState.lastBeat;
        run(db, 'UPDATE npcs SET disposition = ?, relationship_state = ? WHERE id = ?',
          [deriveDisposition(leftState), JSON.stringify(leftState), left.id]);
        run(db, 'UPDATE npcs SET disposition = ?, relationship_state = ? WHERE id = ?',
          [deriveDisposition(rightState), JSON.stringify(rightState), right.id]);
        notes.push(`${left.name} and ${right.name} snap at each other over the mounting pressure, and everyone feels it.`);
        break;
      }

      if ((/rest|camp|parley|share|celebrate|secure/.test(lowered) || pairSeed % 6 === 0) && leftState.trust >= 2 && rightState.trust >= 2) {
        leftState.bond += 1;
        rightState.bond += 1;
        leftState.lastBeat = `${left.name} and ${right.name} found an easier rhythm with one another.`;
        rightState.lastBeat = leftState.lastBeat;
        run(db, 'UPDATE npcs SET disposition = ?, relationship_state = ? WHERE id = ?',
          [deriveDisposition(leftState), JSON.stringify(leftState), left.id]);
        run(db, 'UPDATE npcs SET disposition = ?, relationship_state = ? WHERE id = ?',
          [deriveDisposition(rightState), JSON.stringify(rightState), right.id]);
        notes.push(`${left.name} and ${right.name} fall into an easy rhythm, like companions who are starting to choose each other.`);
        break;
      }
    }
  }

  return notes;
}

export function getJoinedCompanionIdsInScene(db: Database, campaignId: string, sceneId: string) {
  const rows = all(db,
    'SELECT id FROM npcs WHERE campaign_id = ? AND joined_party = 1 AND alive = 1 AND location_scene_id = ?',
    [campaignId, sceneId]) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

export function normalizeRelationshipState(raw: any): CompanionRelationshipState {
  return {
    trust: Number(raw?.trust || 0),
    bond: Number(raw?.bond || 0),
    tension: Number(raw?.tension || 0),
    respect: Number(raw?.respect || 0),
    romance: Number(raw?.romance || 0),
    companionStatus: raw?.companionStatus || 'available',
    lastBeat: String(raw?.lastBeat || ''),
  };
}

export function describeRelationship(state: CompanionRelationshipState) {
  if (state.romance >= 4 && state.tension <= 2) return 'romantic';
  if (state.tension >= 5) return 'volatile';
  if (state.bond >= 4 && state.trust >= 3) return 'loyal friend';
  if (state.trust >= 2) return 'steadily warming';
  if (state.tension >= 2) return 'strained';
  return 'uncertain';
}

function deriveDisposition(state: CompanionRelationshipState) {
  const score = state.trust + state.bond + state.respect + state.romance - state.tension;
  if (score >= 6) return 'enthusiastic';
  if (score >= 3) return 'friendly';
  if (score <= -1) return 'unfriendly';
  return 'neutral';
}

function inferCompanionRole(charClass: string) {
  const lowered = String(charClass || '').toLowerCase();
  if (/(fighter|paladin|ranger)/.test(lowered)) return 'vanguard';
  if (/(cleric|druid)/.test(lowered)) return 'warden';
  if (/(thief|bard)/.test(lowered)) return 'scout';
  if (/mage/.test(lowered)) return 'adept';
  return 'retainer';
}

function buildStarterRoster(setting: string) {
  const grim = setting.includes('grim') || setting.includes('haunted');
  return [
    {
      name: grim ? 'Mara Vex' : 'Mara Fen',
      race: 'human',
      charClass: 'fighter',
      level: 1,
      role: 'vanguard',
      personality: grim ? 'dry, sharp-eyed, protective when it counts' : 'steady, practical, bluntly loyal',
      appearance: 'scarred mail, travel-stained cloak, measured stance',
      voiceNotes: 'Low voice, clipped humour.',
      memory: ['They signed on to survive and to matter.'],
      inventory: [{ item: 'Spear', weight: 5, quantity: 1, equipped: true }],
      stats: { hp: 10, currentHp: 10, maxHp: 10, thac0: 20, ac: 6, str: 15, dex: 12, weaponSpeed: 6, damage: '1d8' },
    },
    {
      name: grim ? 'Tavish Reed' : 'Tavish Quick',
      race: 'half-elf',
      charClass: 'thief',
      level: 1,
      role: 'scout',
      personality: grim ? 'cautious, observant, quietly funny' : 'nimble, curious, always reading the room',
      appearance: 'soft boots, quick grin, too many pockets',
      voiceNotes: 'Light voice, easy sarcasm.',
      memory: ['They trust wit more than force.'],
      inventory: [{ item: 'Short Bow', weight: 3, quantity: 1, equipped: true }, { item: 'Arrow', weight: 0.1, quantity: 12, equipped: false }],
      stats: { hp: 7, currentHp: 7, maxHp: 7, thac0: 20, ac: 7, str: 11, dex: 16, weaponSpeed: 5, damage: '1d6' },
    },
  ];
}

function safeJson(raw?: string) {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

function hashValue(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash);
}
