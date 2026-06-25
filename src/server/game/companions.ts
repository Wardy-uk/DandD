import { v4 as uuid } from 'uuid';
import type { Database } from 'sql.js';
import { all, get, run } from '../db/helpers.js';
import { getCampaignState } from './campaignState.js';

export interface CompanionRelationshipState {
  trust: number;
  bond: number;
  tension: number;
  respect: number;
  romance: number;
  loyalty: number;
  morale: number;
  companionStatus: 'available' | 'joined' | 'departed' | 'refused';
  currentDuty: string;
  aspiration: string;
  grievance: string;
  personalQuestTitle: string;
  personalQuestNeed: string;
  personalQuestProgress: number;
  personalQuestResolved: boolean;
  lastBeat: string;
  // Human behaviour extensions
  riskyDecisionCount: number;   // reckless calls the leader has made (accumulates)
  refusalHistory: string[];     // action-category slugs this companion won't repeat
  disagreementCount: number;    // total logged disagreements (degrades bond over time)
}

type CompanionDuty = 'scout' | 'vanguard' | 'warden' | 'envoy' | 'watch' | 'torch';

interface CompanionRow {
  id: string;
  campaign_id: string;
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
        loyalty: 2,
        morale: 1,
        companionStatus: 'joined',
        currentDuty: npc.role,
        aspiration: npc.aspiration,
        grievance: npc.grievance,
        personalQuestTitle: npc.personalQuestTitle,
        personalQuestNeed: npc.personalQuestNeed,
        personalQuestProgress: 0,
        personalQuestResolved: false,
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
    const relationship = hydrateRelationshipState(row);
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
      companionOrder: Number(row.companion_order || 0),
      hp: Number(stats.currentHp ?? stats.hp ?? 0),
      maxHp: Number(stats.maxHp ?? stats.hp ?? 0),
      ac: Number(stats.ac ?? 8),
      duty: relationship.currentDuty,
      aspiration: relationship.aspiration,
      grievance: relationship.grievance,
      personalQuestTitle: relationship.personalQuestTitle,
      personalQuestNeed: relationship.personalQuestNeed,
      personalQuestProgress: relationship.personalQuestProgress,
      personalQuestResolved: relationship.personalQuestResolved,
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
    const relationship = hydrateRelationshipState(row);
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
      companionOrder: Number(row.companion_order || 0),
      duty: relationship.currentDuty,
      aspiration: relationship.aspiration,
      grievance: relationship.grievance,
      personalQuestTitle: relationship.personalQuestTitle,
      personalQuestNeed: relationship.personalQuestNeed,
      personalQuestProgress: relationship.personalQuestProgress,
      personalQuestResolved: relationship.personalQuestResolved,
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

  const relationship = hydrateRelationshipState(npc as CompanionRow);
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
    const npc = get(db, `
      SELECT id, name, race, char_class, level, personality, disposition, location_scene_id,
        stats, relationship_state, joined_party, companion_role, companion_order, alive
      FROM npcs WHERE id = ?
    `, [npcId]) as CompanionRow | undefined;
    if (!npc) continue;
    const state = normalizeRelationshipState(JSON.parse(npc.relationship_state || '{}'));
    switch (kind) {
      case 'victory':
        state.respect += 1;
        state.bond += 1;
        state.loyalty += 1;
        state.morale += 1;
        break;
      case 'rest':
        state.trust += 1;
        state.morale += 1;
        break;
      case 'hazard':
        state.tension += 1;
        state.trust -= 1;
        state.morale -= 1;
        break;
      case 'greed':
        state.tension += 1;
        state.loyalty -= 1;
        break;
      case 'parley':
        state.trust += 1;
        state.respect += 1;
        break;
      case 'romance':
        state.romance += 1;
        state.bond += 1;
        state.loyalty += 1;
        break;
      case 'friction':
        state.tension += 2;
        state.morale -= 1;
        break;
      case 'security':
        state.trust += 1;
        state.bond += 1;
        state.morale += 1;
        break;
    }
    state.lastBeat = note;
    const nextDisposition = deriveDisposition(state);
    run(db, 'UPDATE npcs SET relationship_state = ?, disposition = ? WHERE id = ?',
      [JSON.stringify(state), nextDisposition, npcId]);
  }
}

export function resolveCompanionInteraction(params: {
  db: Database;
  campaignId: string;
  sceneId: string;
  character: {
    id: string;
    name: string;
    cha?: number;
    gold?: number;
    inventory?: string | null;
  };
  action: string;
}) {
  const { db, campaignId, sceneId, character, action } = params;
  const lowered = action.toLowerCase();
  const npcs = all(db, `
    SELECT id, campaign_id, name, race, char_class, level, personality, disposition, location_scene_id,
      stats, relationship_state, joined_party, companion_role, companion_order, alive
    FROM npcs
    WHERE campaign_id = ? AND location_scene_id = ? AND alive = 1
    ORDER BY joined_party DESC, companion_order ASC, name ASC
  `, [campaignId, sceneId]) as CompanionRow[];

  if (!npcs.length) return null;

  const target = npcs.find((npc) => lowered.includes(String(npc.name || '').toLowerCase()))
    || (npcs.length === 1 ? npcs[0] : null);
  if (!target) return null;

  const state = hydrateRelationshipState(target);

  const dutyMap: Array<{ duty: CompanionDuty; pattern: RegExp }> = [
    { duty: 'scout', pattern: /scout|range ahead|check ahead|search ahead|check for traps/ },
    { duty: 'vanguard', pattern: /take point|front rank|hold the line|lead the way/ },
    { duty: 'warden', pattern: /tend wounds|healer|watch over us|keep us steady/ },
    { duty: 'envoy', pattern: /speak for us|handle the talking|parley for us/ },
    { duty: 'watch', pattern: /keep watch|watch the rear|guard camp|hold the rear/ },
    { duty: 'torch', pattern: /carry the torch|take the light|hold the lamp/ },
  ];
  const matchedDuty = dutyMap.find((entry) => entry.pattern.test(lowered));
  if (matchedDuty && /ask|tell|order|have|set|put/.test(lowered)) {
    return assignCompanionDuty(db, target, state, matchedDuty.duty, character.name);
  }

  if (/put .* first|move .* up|take point|front of the marching order/.test(lowered)) {
    return updateCompanionOrder(db, target, state, 'front', character.name);
  }

  if (/put .* last|move .* back|fall back|rear of the marching order/.test(lowered)) {
    return updateCompanionOrder(db, target, state, 'rear', character.name);
  }

  if (/comfort|confide|apologize|apologise|praise|thank/.test(lowered)) {
    state.trust += 1;
    state.bond += 1;
    state.morale += 1;
    state.lastBeat = `${character.name} took time to speak to ${target.name} as a person, not just a piece on the board.`;
    persistRelationshipState(db, target.id, state);
    return {
      handled: true,
      narration: [`${target.name} visibly settles under the attention. The bond feels more deliberate afterwards.`],
      characterUpdated: false,
    };
  }

  if (/flirt|admire|kiss|romance/.test(lowered)) {
    state.romance += state.trust >= 2 ? 1 : 0;
    state.tension += state.trust < 2 ? 1 : 0;
    state.lastBeat = `${character.name} tested the line between camaraderie and attraction with ${target.name}.`;
    persistRelationshipState(db, target.id, state);

    // Jealousy: other companions with romantic investment notice
    const jealousyNotes = checkJealousyTriggers({
      db, campaignId, sceneId, targetNpcId: target.id, leaderName: character.name,
    });
    const romanticLine = state.trust >= 2
      ? `${target.name} meets the moment instead of dodging it. Something warmer now hangs in the air between you.`
      : `${target.name} reads the moment badly and pulls back. The camp mood tightens instead of softening.`;
    return {
      handled: true,
      narration: [romanticLine, ...jealousyNotes],
      characterUpdated: false,
    };
  }

  if (/argue|insult|threaten|berate|dress down/.test(lowered)) {
    state.tension += 2;
    state.respect -= 1;
    state.morale -= 1;
    state.lastBeat = `${character.name} pushed ${target.name} hard in front of the company.`;
    persistRelationshipState(db, target.id, state);
    return {
      handled: true,
      narration: [`${target.name} takes the rebuke badly. The company can feel the crack in discipline and trust.`],
      characterUpdated: false,
    };
  }

  if (/share loot|pay|cut .* in|give .* gold|bonus/.test(lowered)) {
    const goldOffer = extractGoldAmount(action) || 5;
    const currentGold = Number(character.gold || 0);
    if (currentGold < goldOffer) {
      return {
        handled: true,
        narration: [`You mean to pay ${target.name}, but the purse does not back the gesture.`],
        characterUpdated: false,
      };
    }
    run(db, 'UPDATE characters SET gold = gold - ? WHERE id = ?', [goldOffer, character.id]);
    state.trust += 1;
    state.respect += 1;
    state.loyalty += 1;
    state.lastBeat = `${character.name} shared ${goldOffer} gp with ${target.name}.`;
    persistRelationshipState(db, target.id, state);
    return {
      handled: true,
      narration: [`${target.name} accepts ${goldOffer} gp with a look that says the gesture mattered as much as the coin.`],
      characterUpdated: true,
    };
  }

  if (/give .* ration|share food|offer food/.test(lowered)) {
    if (!consumeInventoryItem(db, character.id, character.inventory, 'Ration', 1)) {
      return {
        handled: true,
        narration: [`You offer food to ${target.name}, but the packs are thinner than the gesture requires.`],
        characterUpdated: false,
      };
    }
    state.trust += 1;
    state.loyalty += 1;
    state.morale += 1;
    state.lastBeat = `${character.name} shared supplies with ${target.name} instead of hoarding them.`;
    persistRelationshipState(db, target.id, state);
    return {
      handled: true,
      narration: [`${target.name} eats without pretending not to notice the kindness. That sort of thing gets remembered underground.`],
      characterUpdated: true,
    };
  }

  if (/dismiss|send away|leave the company/.test(lowered) && Number(target.joined_party || 0) === 1) {
    state.companionStatus = 'departed';
    state.trust -= 1;
    state.loyalty -= 2;
    state.lastBeat = `${character.name} dismissed ${target.name} from the company.`;
    run(db, 'UPDATE npcs SET joined_party = 0, disposition = ?, relationship_state = ? WHERE id = ?',
      [deriveDisposition(state), JSON.stringify(state), target.id]);
    return {
      handled: true,
      narration: [`${target.name} leaves the company with very little ceremony, which somehow makes it feel harsher.`],
      characterUpdated: false,
    };
  }

  return null;
}

export function getCompanionPartyModifiers(db: Database, campaignId: string, sceneId: string) {
  const rows = all(db, `
    SELECT id, name, race, char_class, level, personality, disposition, location_scene_id,
      stats, relationship_state, joined_party, companion_role, companion_order, alive
    FROM npcs
    WHERE campaign_id = ? AND location_scene_id = ? AND joined_party = 1 AND alive = 1
  `, [campaignId, sceneId]) as CompanionRow[];

  const modifiers = {
    scoutBonus: 0,
    vanguardBonus: 0,
    wardenBonus: 0,
    envoyBonus: 0,
    watchBonus: 0,
    morale: 0,
    frontlineGuard: 0,
    rearGuard: 0,
    frontlineName: '',
    rearGuardName: '',
    cohesion: 0,
    fractureRisk: 0,
    loyalCore: 0,
    volatileCount: 0,
  };

  const ordered = [...rows].sort((left, right) => Number(left.companion_order || 0) - Number(right.companion_order || 0));
  const front = ordered[0];
  const rear = ordered[ordered.length - 1];
  if (front) {
    const role = String(front.companion_role || inferCompanionRole(front.char_class)).toLowerCase();
    const state = hydrateRelationshipState(front);
    modifiers.frontlineName = front.name;
    modifiers.frontlineGuard = role === 'vanguard' || state.currentDuty === 'vanguard' ? 2 : 1;
  }
  if (rear) {
    const role = String(rear.companion_role || inferCompanionRole(rear.char_class)).toLowerCase();
    const state = hydrateRelationshipState(rear);
    modifiers.rearGuardName = rear.name;
    modifiers.rearGuard = state.currentDuty === 'watch' || role === 'scout' || role === 'vanguard' ? 1 : 0;
  }

  for (const row of ordered) {
    const state = hydrateRelationshipState(row);
    const role = String(row.companion_role || inferCompanionRole(row.char_class)).toLowerCase();
    const duty = String(state.currentDuty || '').toLowerCase();
    if (role === 'scout' || duty === 'scout') modifiers.scoutBonus += duty === 'scout' ? 2 : 1;
    if (role === 'vanguard' || duty === 'vanguard') modifiers.vanguardBonus += duty === 'vanguard' ? 2 : 1;
    if (role === 'warden' || duty === 'warden') modifiers.wardenBonus += duty === 'warden' ? 2 : 1;
    if (duty === 'envoy') modifiers.envoyBonus += 2;
    if (duty === 'watch' || duty === 'torch') modifiers.watchBonus += 1;
    modifiers.morale += state.loyalty + state.morale + state.bond + state.respect - state.tension;
    modifiers.cohesion += state.trust + state.bond + state.loyalty + state.respect - state.tension;
    modifiers.fractureRisk += Math.max(0, state.tension - state.trust) + (state.morale <= 0 ? 1 : 0);
    if (state.loyalty >= 4 || state.bond >= 4) modifiers.loyalCore += 1;
    if (state.tension >= 5 || state.loyalty <= 0) modifiers.volatileCount += 1;
  }

  return modifiers;
}

export function progressCompanionArcs(params: {
  db: Database;
  campaignId: string;
  sceneId: string;
  action: string;
  leaderName: string;
}) {
  const { db, campaignId, sceneId, action, leaderName } = params;
  const lowered = action.toLowerCase();
  const campaignState = getCampaignState(db, campaignId);
  const rows = all(db, `
    SELECT id, name, race, char_class, level, personality, disposition, location_scene_id,
      stats, relationship_state, joined_party, companion_role, companion_order, alive
    FROM npcs
    WHERE campaign_id = ? AND location_scene_id = ? AND joined_party = 1 AND alive = 1
    ORDER BY companion_order ASC, name ASC
  `, [campaignId, sceneId]) as CompanionRow[];

  const notes: string[] = [];
  const factionPressure = Math.max(
    campaignState.factions.locals?.heat || 0,
    campaignState.factions.delvers?.heat || 0,
    campaignState.factions.watch?.heat || 0,
    campaignState.factions.shadows?.heat || 0,
  );

  for (const row of rows) {
    const state = hydrateRelationshipState(row);
    const role = String(row.companion_role || inferCompanionRole(row.char_class)).toLowerCase();
    const directMatch = state.personalQuestNeed
      .toLowerCase()
      .split(/[\s,.;:]+/)
      .filter((part) => part.length > 4)
      .some((part) => lowered.includes(part));

    const supportsQuest = directMatch
      || (/parley|negotiate|talk/.test(lowered) && role === 'envoy')
      || (/search|scout|trap|hidden/.test(lowered) && role === 'scout')
      || (/secure|rest|heal|camp/.test(lowered) && role === 'warden')
      || (/force|hold|fight|brace|doorway/.test(lowered) && role === 'vanguard');

    if (!state.personalQuestResolved && supportsQuest) {
      state.personalQuestProgress += directMatch ? 2 : 1;
      state.trust += 1;
      state.respect += 1;
      state.lastBeat = `${leaderName} moved ${row.name}'s private concern forward.`;
      if (state.personalQuestProgress >= 3) {
        state.personalQuestResolved = true;
        state.loyalty += 2;
        state.morale += 2;
        state.lastBeat = `${leaderName} helped resolve ${row.name}'s personal concern: ${state.personalQuestTitle}.`;
        realizeCompanionWorldHook(db, campaignId, sceneId, row, state);
        notes.push(`${row.name} sees one of their private concerns finally answered. The loyalty that follows feels real.`);
      } else {
        notes.push(`${row.name} notices the company moving closer to what they quietly wanted all along.`);
      }
      persistRelationshipState(db, row.id, state);
      continue;
    }

    if (!state.personalQuestResolved && factionPressure >= 6 && /rest|loot|fallback|camp/.test(lowered)) {
      state.tension += 1;
      state.grievance = sharpenGrievance(state.grievance, row.name);
      state.lastBeat = `${row.name}'s unresolved concerns are starting to fester under pressure.`;
      persistRelationshipState(db, row.id, state);
      notes.push(`${row.name} is getting harder to reassure. Something unresolved is starting to sour into resentment.`);
    }
  }

  return notes;
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
    const state = normalizeRelationshipState(JSON.parse(npc.relationship_state || '{}'));
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
      const leftState = hydrateRelationshipState(left);
      const rightState = hydrateRelationshipState(right);
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
    loyalty: Number(raw?.loyalty || 0),
    morale: Number(raw?.morale || 0),
    companionStatus: raw?.companionStatus || 'available',
    currentDuty: String(raw?.currentDuty || ''),
    aspiration: String(raw?.aspiration || ''),
    grievance: String(raw?.grievance || ''),
    personalQuestTitle: String(raw?.personalQuestTitle || ''),
    personalQuestNeed: String(raw?.personalQuestNeed || ''),
    personalQuestProgress: Number(raw?.personalQuestProgress || 0),
    personalQuestResolved: Boolean(raw?.personalQuestResolved),
    lastBeat: String(raw?.lastBeat || ''),
    riskyDecisionCount: Number(raw?.riskyDecisionCount || 0),
    refusalHistory: Array.isArray(raw?.refusalHistory) ? raw.refusalHistory : [],
    disagreementCount: Number(raw?.disagreementCount || 0),
  };
}

export function describeRelationship(state: CompanionRelationshipState) {
  if (state.romance >= 4 && state.tension <= 2) return 'romantic';
  if (state.tension >= 5) return 'volatile';
  if (state.loyalty >= 5 && state.respect >= 3) return 'sworn';
  if (state.personalQuestResolved && state.loyalty >= 3) return 'proven';
  if (state.bond >= 4 && state.trust >= 3) return 'loyal friend';
  if (state.trust >= 2) return 'steadily warming';
  if (state.tension >= 2) return 'strained';
  return 'uncertain';
}

// ─── Human Behaviour: Refusals, Risky Decisions, Jealousy, Friction ──────────

// Risk action categories that get remembered if refused or repeated
const RISKY_ACTION_PATTERNS: Array<{ slug: string; pattern: RegExp; label: string }> = [
  { slug: 'sacrifice',    pattern: /sacrifice|leave .* behind|abandon .* to/i,           label: 'being left behind' },
  { slug: 'blind_charge', pattern: /charge in blind|rush in|charge straight|press on without/i, label: 'charging in blind' },
  { slug: 'no_retreat',   pattern: /no retreat|hold to the last|fight to the death|no fallback/i, label: 'refusing to retreat' },
  { slug: 'trap_gamble',  pattern: /ignore the trap|chance the trap|walk through anyway/i, label: 'ignoring known traps' },
  { slug: 'reckless',     pattern: /reckless|damn the risk|forget the danger|throw caution/i, label: 'throwing caution aside' },
];

// Low-trust / high-tension thresholds that gate refusal
function willRefuse(state: CompanionRelationshipState, slug: string): boolean {
  if (state.refusalHistory.includes(slug)) return true;   // "won't do that again" memory
  if (state.loyalty <= -1 && state.tension >= 4) return true;
  if (state.trust <= -1 && state.tension >= 5) return true;
  return false;
}

/**
 * Check whether any joined companions refuse the current order before it executes.
 * Returns an array of refusal objects (empty = all comply).
 * Callers should inject these as narration notes and skip/modify the action as appropriate.
 */
export function checkCompanionRefusals(params: {
  db: Database;
  campaignId: string;
  sceneId: string;
  action: string;
  leaderName: string;
}): Array<{ companion: string; reason: string }> {
  const { db, campaignId, sceneId, action, leaderName } = params;
  const joined = all(db, `
    SELECT id, campaign_id, name, race, char_class, level, personality, disposition, location_scene_id,
      stats, relationship_state, joined_party, companion_role, companion_order, alive
    FROM npcs
    WHERE campaign_id = ? AND location_scene_id = ? AND joined_party = 1 AND alive = 1
    ORDER BY companion_order ASC
  `, [campaignId, sceneId]) as CompanionRow[];

  const refusals: Array<{ companion: string; reason: string }> = [];

  for (const npc of joined) {
    const state = normalizeRelationshipState(JSON.parse(npc.relationship_state || '{}'));
    for (const cat of RISKY_ACTION_PATTERNS) {
      if (!cat.pattern.test(action)) continue;
      if (!willRefuse(state, cat.slug)) continue;

      const wasRemembered = state.refusalHistory.includes(cat.slug);
      const reason = wasRemembered
        ? `${npc.name} has been through ${cat.label} before and flatly refuses to go through it again.`
        : `${npc.name} draws the line here — their trust in ${leaderName}'s judgement does not extend this far.`;

      // Log disagreement
      state.disagreementCount += 1;
      state.bond -= 1;
      state.lastBeat = `${npc.name} refused: ${cat.label}.`;
      persistRelationshipState(db, npc.id, state);

      refusals.push({ companion: npc.name, reason });
      break; // one refusal reason per companion per action
    }
  }

  return refusals;
}

/**
 * Record that the leader made a risky call.
 * Accumulates per-companion; at thresholds, companions push back mechanically.
 * Returns narration lines to inject.
 */
export function recordRiskyDecision(params: {
  db: Database;
  campaignId: string;
  sceneId: string;
  action: string;
  leaderName: string;
}): string[] {
  const { db, campaignId, sceneId, action, leaderName } = params;
  const matched = RISKY_ACTION_PATTERNS.find((cat) => cat.pattern.test(action));
  if (!matched) return [];

  const joined = all(db, `
    SELECT id, campaign_id, name, race, char_class, level, personality, disposition, location_scene_id,
      stats, relationship_state, joined_party, companion_role, companion_order, alive
    FROM npcs
    WHERE campaign_id = ? AND location_scene_id = ? AND joined_party = 1 AND alive = 1
  `, [campaignId, sceneId]) as CompanionRow[];

  const notes: string[] = [];

  for (const npc of joined) {
    const state = normalizeRelationshipState(JSON.parse(npc.relationship_state || '{}'));
    state.riskyDecisionCount += 1;
    const count = state.riskyDecisionCount;

    if (count === 2) {
      state.tension += 1;
      state.morale -= 1;
      state.lastBeat = `${npc.name} is watching ${leaderName}'s pattern of risky calls with growing unease.`;
      notes.push(`${npc.name} says nothing, but the set of their jaw says they're counting.`);
    } else if (count === 4) {
      state.loyalty -= 1;
      state.tension += 1;
      state.lastBeat = `${npc.name}'s loyalty to ${leaderName} is eroding under repeated reckless calls.`;
      notes.push(`${npc.name} keeps pace, but the light behind their eyes has changed. Too many bad calls have a weight.`);
    } else if (count >= 6) {
      state.loyalty -= 1;
      state.morale -= 1;
      // Lock the refusal memory — they won't follow this category again
      if (!state.refusalHistory.includes(matched.slug)) {
        state.refusalHistory = [...state.refusalHistory, matched.slug];
      }
      state.lastBeat = `${npc.name} has decided they won't follow ${leaderName} into ${matched.label} again.`;
      notes.push(`${npc.name} looks at ${leaderName} with something colder than anger. The next time ${matched.label} comes up, they will not follow.`);
    }

    persistRelationshipState(db, npc.id, state);
  }

  return notes;
}

/**
 * Log a companion disagreement — when a companion's role/values clash with an order.
 * Does not prevent the action, but degrades bond over time and logs clearly.
 */
export function logCompanionDisagreement(params: {
  db: Database;
  campaignId: string;
  sceneId: string;
  action: string;
  leaderName: string;
}): string[] {
  const { db, campaignId, sceneId, action, leaderName } = params;
  const lowered = action.toLowerCase();
  const joined = all(db, `
    SELECT id, campaign_id, name, race, char_class, level, personality, disposition, location_scene_id,
      stats, relationship_state, joined_party, companion_role, companion_order, alive
    FROM npcs
    WHERE campaign_id = ? AND location_scene_id = ? AND joined_party = 1 AND alive = 1
    ORDER BY companion_order ASC
  `, [campaignId, sceneId]) as CompanionRow[];

  const notes: string[] = [];

  for (const npc of joined) {
    const state = normalizeRelationshipState(JSON.parse(npc.relationship_state || '{}'));
    const role = String(npc.companion_role || inferCompanionRole(npc.char_class)).toLowerCase();

    let disagreement = '';
    if (role === 'scout' && /charge|rush|no check|straight through/.test(lowered) && state.tension >= 2) {
      disagreement = `${npc.name} thinks the ground ahead has not been read yet, and says so quietly.`;
    } else if (role === 'warden' && /press on|no rest|keep moving|ignore wounds/.test(lowered) && state.tension >= 2) {
      disagreement = `${npc.name} points out that someone needs tending before the company moves again.`;
    } else if (role === 'envoy' && /threaten|force|intimidate|demand/.test(lowered) && state.trust >= 1) {
      disagreement = `${npc.name} believes a softer approach here would cost less than ${leaderName} is about to spend.`;
    } else if (role === 'vanguard' && /run|flee|retreat now|fall back immediately/.test(lowered) && state.respect >= 2) {
      disagreement = `${npc.name} holds their ground a beat too long before following the retreat order.`;
    }

    if (!disagreement) continue;

    state.disagreementCount += 1;
    state.tension += 1;
    if (state.disagreementCount % 3 === 0) {
      state.bond -= 1;  // every 3rd disagreement erodes bond
      disagreement += ` This is the third time ${npc.name} has had to push back.`;
    }
    state.lastBeat = `${npc.name} disagreed with ${leaderName}'s call.`;
    persistRelationshipState(db, npc.id, state);
    notes.push(disagreement);
  }

  return notes;
}

/**
 * Check for jealousy when a romance/bond interaction targets one companion
 * while others in the party have existing romantic investment.
 */
export function checkJealousyTriggers(params: {
  db: Database;
  campaignId: string;
  sceneId: string;
  targetNpcId: string;
  leaderName: string;
}): string[] {
  const { db, campaignId, sceneId, targetNpcId, leaderName } = params;
  const others = all(db, `
    SELECT id, campaign_id, name, race, char_class, level, personality, disposition, location_scene_id,
      stats, relationship_state, joined_party, companion_role, companion_order, alive
    FROM npcs
    WHERE campaign_id = ? AND location_scene_id = ? AND joined_party = 1 AND alive = 1 AND id != ?
  `, [campaignId, sceneId, targetNpcId]) as CompanionRow[];

  const notes: string[] = [];

  for (const npc of others) {
    const state = normalizeRelationshipState(JSON.parse(npc.relationship_state || '{}'));
    if (state.romance < 2) continue;  // no investment, no jealousy

    state.tension += 1;
    state.morale -= 1;
    state.lastBeat = `${npc.name} noticed ${leaderName}'s attention go elsewhere and felt the shift.`;
    persistRelationshipState(db, npc.id, state);

    if (state.romance >= 4) {
      notes.push(`${npc.name}'s expression closes. They say nothing, but the silence has an edge that was not there before.`);
    } else {
      notes.push(`${npc.name} makes themselves busy elsewhere in the camp. The mood shift is subtle but visible.`);
    }
  }

  return notes;
}

/**
 * Check whether existing companions push back against recruiting a new NPC.
 * Returns friction narration notes; does not block recruitment.
 */
export function checkRecruitmentFriction(params: {
  db: Database;
  campaignId: string;
  sceneId: string;
  newNpcId: string;
  newNpcName: string;
  newNpcClass: string;
  leaderName: string;
}): string[] {
  const { db, campaignId, sceneId, newNpcId, newNpcName, newNpcClass, leaderName } = params;
  const existing = all(db, `
    SELECT id, campaign_id, name, race, char_class, level, personality, disposition, location_scene_id,
      stats, relationship_state, joined_party, companion_role, companion_order, alive
    FROM npcs
    WHERE campaign_id = ? AND location_scene_id = ? AND joined_party = 1 AND alive = 1
  `, [campaignId, sceneId]) as CompanionRow[];

  const notes: string[] = [];
  const newRole = inferCompanionRole(newNpcClass);

  for (const npc of existing) {
    const state = normalizeRelationshipState(JSON.parse(npc.relationship_state || '{}'));
    const existingRole = String(npc.companion_role || inferCompanionRole(npc.char_class)).toLowerCase();
    const roleConflict = existingRole === newRole;

    // High-tension companions push back harder
    if (state.tension >= 4) {
      state.tension += 1;
      state.lastBeat = `${npc.name} was cold to the idea of ${newNpcName} joining.`;
      persistRelationshipState(db, npc.id, state);
      notes.push(`${npc.name} is openly cold about the new addition. The company already feels stretched, and ${newNpcName} is another unknown.`);
    } else if (roleConflict && state.respect >= 2) {
      // Territorial about their role when they're respected in it
      state.tension += 1;
      state.lastBeat = `${npc.name} was quietly territorial about ${newNpcName} taking a similar role.`;
      persistRelationshipState(db, npc.id, state);
      notes.push(`${npc.name} watches ${newNpcName} with the careful attention of someone assessing competition. They are not hostile — not yet — but they are watching.`);
    }
  }

  return notes;
}


function deriveDisposition(state: CompanionRelationshipState) {
  const score = state.trust + state.bond + state.respect + state.romance + state.loyalty - state.tension;
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
      aspiration: 'Stand in front when the trouble turns real.',
      grievance: 'Despises leaders who freeze when a decision has to be made.',
      personalQuestTitle: 'Hold the line cleanly',
      personalQuestNeed: 'Break an obstacle or win a hard fight without panic or hesitation.',
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
      aspiration: 'Be the one who spots the angle no one else saw.',
      grievance: 'Hates blundering into traps that patience would have beaten.',
      personalQuestTitle: 'Map a safer road',
      personalQuestNeed: 'Find hidden routes, expose traps, and prove caution pays.',
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

function hydrateRelationshipState(row: CompanionRow) {
  const state = normalizeRelationshipState(safeJson(row.relationship_state));
  const innerLife = buildInnerLife(row);
  return {
    ...state,
    loyalty: state.loyalty || innerLife.loyalty,
    morale: state.morale || innerLife.morale,
    currentDuty: state.currentDuty || innerLife.currentDuty,
    aspiration: state.aspiration || innerLife.aspiration,
    grievance: state.grievance || innerLife.grievance,
    personalQuestTitle: state.personalQuestTitle || innerLife.personalQuestTitle,
    personalQuestNeed: state.personalQuestNeed || innerLife.personalQuestNeed,
  };
}

function buildInnerLife(row: CompanionRow) {
  const role = String(row.companion_role || inferCompanionRole(row.char_class)).toLowerCase();
  const loweredPersonality = String(row.personality || '').toLowerCase();
  if (role === 'scout') {
    return {
      loyalty: 1,
      morale: 1,
      currentDuty: 'scout',
      aspiration: loweredPersonality.includes('curious') ? 'Find something no one else spotted first.' : 'Stay useful by being first to danger, not last to notice it.',
      grievance: 'Hates being marched blind into obvious risk.',
      personalQuestTitle: 'Map a safer road',
      personalQuestNeed: 'Find hidden routes, expose traps, and prove caution pays.',
    };
  }
  if (role === 'warden') {
    return {
      loyalty: 1,
      morale: 1,
      currentDuty: 'warden',
      aspiration: 'Keep the company alive long enough to matter.',
      grievance: 'Resents wasteful risk and sloppy camp discipline.',
      personalQuestTitle: 'Make camp mean something',
      personalQuestNeed: 'Secure rooms, rest safely, and keep people alive instead of merely lucky.',
    };
  }
  if (role === 'vanguard') {
    return {
      loyalty: 2,
      morale: 1,
      currentDuty: 'vanguard',
      aspiration: 'Stand where the line might break and keep it from breaking.',
      grievance: 'Will not quietly accept cowardice or dithering under pressure.',
      personalQuestTitle: 'Hold the line cleanly',
      personalQuestNeed: 'Break an obstacle or win a hard fight without panic or hesitation.',
    };
  }
  return {
    loyalty: 1,
    morale: 0,
    currentDuty: 'watch',
    aspiration: 'Earn a secure place in the company.',
    grievance: 'Dislikes being treated as disposable.',
    personalQuestTitle: 'Earn a place',
    personalQuestNeed: 'Be trusted with real responsibility and see the company stand by them.',
  };
}

function assignCompanionDuty(
  db: Database,
  target: CompanionRow,
  state: CompanionRelationshipState,
  duty: CompanionDuty,
  leaderName: string,
) {
  const role = String(target.companion_role || inferCompanionRole(target.char_class)).toLowerCase();
  const suited = role === duty || (role === 'scout' && duty === 'watch') || (role === 'vanguard' && duty === 'watch');
  state.currentDuty = duty;
  state.respect += suited ? 1 : 0;
  state.trust += suited ? 1 : 0;
  state.tension += suited ? 0 : 1;
  state.lastBeat = `${leaderName} assigned ${target.name} to ${duty}.`;
  persistRelationshipState(db, target.id, state);
  return {
    handled: true,
    narration: [suited
      ? `${target.name} takes the ${duty} duty with the look of someone who feels seen and used well.`
      : `${target.name} accepts the ${duty} duty, but not without a flicker of doubt about whether this is really where they belong.`],
    characterUpdated: false,
  };
}

function updateCompanionOrder(
  db: Database,
  target: CompanionRow,
  state: CompanionRelationshipState,
  placement: 'front' | 'rear',
  leaderName: string,
) {
  const bounds = get(db, `
    SELECT MIN(companion_order) AS min_order, MAX(companion_order) AS max_order
    FROM npcs
    WHERE campaign_id = ? AND joined_party = 1 AND alive = 1
  `, [target.campaign_id]) as any;
  const nextOrder = placement === 'front'
    ? Number(bounds?.min_order ?? 0) - 1
    : Number(bounds?.max_order ?? 0) + 1;

  state.respect += 1;
  state.lastBeat = `${leaderName} moved ${target.name} to the ${placement === 'front' ? 'front' : 'rear'} of the company order.`;
  run(db, 'UPDATE npcs SET companion_order = ?, relationship_state = ?, disposition = ? WHERE id = ?',
    [nextOrder, JSON.stringify(state), deriveDisposition(state), target.id]);

  return {
    handled: true,
    narration: [placement === 'front'
      ? `${target.name} shifts forward in the marching order and starts carrying themselves like they expect first contact.`
      : `${target.name} falls back in the company order, taking a position better suited to reserve, watch, or caution.`],
    characterUpdated: false,
  };
}

function persistRelationshipState(db: Database, npcId: string, state: CompanionRelationshipState) {
  run(db, 'UPDATE npcs SET relationship_state = ?, disposition = ? WHERE id = ?',
    [JSON.stringify(state), deriveDisposition(state), npcId]);
}

function extractGoldAmount(action: string) {
  const match = action.match(/(\d+)\s*gp/i) || action.match(/(\d+)\s*gold/i);
  return match ? Number(match[1]) : 0;
}

function consumeInventoryItem(db: Database, characterId: string, rawInventory: string | null | undefined, itemName: string, quantity: number) {
  const inventory = parseInventory(rawInventory);
  const item = inventory.find((entry) => entry.item === itemName);
  if (!item || item.quantity < quantity) return false;
  item.quantity -= quantity;
  const trimmed = inventory.filter((entry) => entry.quantity > 0);
  run(db, 'UPDATE characters SET inventory = ? WHERE id = ?', [JSON.stringify(trimmed), characterId]);
  return true;
}

function parseInventory(raw: string | null | undefined) {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function sharpenGrievance(grievance: string, name: string) {
  if (grievance.includes('again')) return grievance;
  return `${grievance} ${name} is starting to think it may happen again.`;
}

function realizeCompanionWorldHook(
  db: Database,
  campaignId: string,
  sceneId: string,
  row: CompanionRow,
  state: CompanionRelationshipState,
) {
  const existingLore = get(db,
    'SELECT id FROM world_lore WHERE campaign_id = ? AND title = ?',
    [campaignId, state.personalQuestTitle]) as any;
  if (!existingLore) {
    run(db,
      'INSERT INTO world_lore (id, campaign_id, category, title, content) VALUES (?, ?, ?, ?, ?)',
      [
        uuid(),
        campaignId,
        'companion',
        state.personalQuestTitle,
        `${row.name}'s concern was answered through play: ${state.personalQuestNeed}`,
      ]);
  }

  const scene = get(db, 'SELECT * FROM scenes WHERE id = ?', [sceneId]) as any;
  if (!scene) return;
  const connections = safeJsonArray(scene.connections);

  if (/map a safer road/i.test(state.personalQuestTitle)) {
    ensureHookScene(db, campaignId, scene, connections, {
      name: `${row.name}'s Quiet Way`,
      brief: `A safer route marked by ${row.name}'s eye for angles and caution.`,
      direction: 'through the quiet way',
      backDirection: 'back to the main route',
      terrainType: 'ruins',
      lightLevel: 'dim',
      notes: `${row.name} helped identify this route as a safer passage.`,
    });
  } else if (/make camp mean something/i.test(state.personalQuestTitle)) {
    ensureHookScene(db, campaignId, scene, connections, {
      name: `${row.name}'s Shelter`,
      brief: `A defensible nook that can serve as a genuine camp rather than a desperate pause.`,
      direction: 'toward the shelter',
      backDirection: 'back to the main chamber',
      terrainType: 'indoor',
      lightLevel: 'normal',
      notes: `${row.name} shaped this place into a camp-worthy refuge.`,
    });
  } else if (/hold the line cleanly/i.test(state.personalQuestTitle)) {
    ensureHookScene(db, campaignId, scene, connections, {
      name: `${row.name}'s Stand`,
      brief: `A hard little killing ground where a determined company can hold without panic.`,
      direction: 'toward the stand',
      backDirection: 'back to the safer rear',
      terrainType: 'dungeon',
      lightLevel: 'normal',
      notes: `${row.name} identified this position as a place to meet violence on better terms.`,
    });
  } else if (/earn a place/i.test(state.personalQuestTitle)) {
    ensureHookScene(db, campaignId, scene, connections, {
      name: `${row.name}'s Find`,
      brief: `A small annex or stash-space proving ${row.name} can uncover value the company would otherwise miss.`,
      direction: 'into the side-find',
      backDirection: 'back to the main route',
      terrainType: 'ruins',
      lightLevel: 'dim',
      notes: `${row.name} proved their place by discovering this useful side pocket.`,
    });
  }
}

function ensureHookScene(
  db: Database,
  campaignId: string,
  parentScene: any,
  parentConnections: any[],
  hook: {
    name: string;
    brief: string;
    direction: string;
    backDirection: string;
    terrainType: string;
    lightLevel: string;
    notes: string;
  },
) {
  const existing = get(db, 'SELECT id FROM scenes WHERE campaign_id = ? AND name = ?', [campaignId, hook.name]) as any;
  const targetSceneId = existing?.id || uuid();
  if (!existing) {
    run(db, `
      INSERT INTO scenes (id, campaign_id, name, brief, light_level, terrain_type, connections, visited, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
    `, [
      targetSceneId,
      campaignId,
      hook.name,
      hook.brief,
      hook.lightLevel,
      hook.terrainType,
      '[]',
      hook.notes,
    ]);
  }

  if (!parentConnections.some((entry) => entry.targetSceneId === targetSceneId)) {
    parentConnections.push({
      direction: hook.direction,
      targetSceneId,
      description: hook.brief,
      locked: false,
      hidden: false,
    });
    run(db, 'UPDATE scenes SET connections = ? WHERE id = ?', [JSON.stringify(parentConnections), parentScene.id]);
  }

  const child = get(db, 'SELECT connections FROM scenes WHERE id = ?', [targetSceneId]) as any;
  const childConnections = safeJsonArray(child?.connections);
  if (!childConnections.some((entry) => entry.targetSceneId === parentScene.id)) {
    childConnections.push({
      direction: hook.backDirection,
      targetSceneId: parentScene.id,
      description: `The way back to ${parentScene.name}.`,
      locked: false,
      hidden: false,
    });
    run(db, 'UPDATE scenes SET connections = ? WHERE id = ?', [JSON.stringify(childConnections), targetSceneId]);
  }
}

function safeJsonArray(raw?: string) {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
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

// ─── Town Downtime ───────────────────────────────────────────────────────────

/**
 * Process companion downtime in town.
 * Called once per town visit. Returns narration notes for each companion.
 */
export function processTownDowntime(db: Database, campaignId: string, leaderName: string): string[] {
  const joined = getPartyCompanions(db, campaignId).filter(c => c.joinedParty);
  const notes: string[] = [];

  for (const comp of joined) {
    const npc = get(db, 'SELECT id, name, char_class, relationship_state FROM npcs WHERE id = ?', [comp.id]) as any;
    if (!npc) continue;

    const state = normalizeRelationshipState(JSON.parse(npc.relationship_state || '{}'));
    let changed = false;

    // ── High-trust companions bond further ─────────────────────────
    if (state.trust >= 3 && state.morale >= 1) {
      state.bond += 1;
      state.morale += 1;
      state.lastBeat = `Spent downtime with ${leaderName} in town — trust deepening.`;
      changed = true;
      notes.push(`${comp.name} finds ${leaderName} in the common room after supper. They share a drink and say almost nothing. It's the kind of silence that means something. Bond grows stronger.`);
    }

    // ── Low-morale companions seek distraction ─────────────────────
    if (state.morale <= -1 && state.trust < 2) {
      state.tension += 1;
      state.morale -= 1;
      state.lastBeat = 'Town downtime went poorly — drinking and distance.';
      changed = true;
      notes.push(`${comp.name} spends the night apart. Word gets back that they've been drinking at the other end of the bar. Something is wearing on them — the kind of thing town doesn't fix.`);
    }

    // ── Personal quest beat ────────────────────────────────────────
    if (state.personalQuestTitle && !state.personalQuestResolved && state.personalQuestProgress >= 2) {
      state.personalQuestProgress += 1;
      changed = true;
      notes.push(`${comp.name} disappears for a few hours. They come back quieter than they left. The thing they've been carrying — ${state.personalQuestNeed || 'their own business'} — has moved a step forward, or backward. They don't say which.`);
      if (state.personalQuestProgress >= 4) {
        state.personalQuestResolved = true;
        state.loyalty += 2;
        state.bond += 1;
        notes.push(`${comp.name} returns with something settled in their face. Whatever they needed from this town, they found it. Personal quest resolved. The weight is off — you can see it in how they hold themselves.`);
      }
    }

    // ── Romance / jealousy dynamics ────────────────────────────────
    if (state.romance >= 3 && state.tension <= 1) {
      state.bond += 1;
      changed = true;
      notes.push(`${comp.name} and ${leaderName} find time away from the others. Nothing is said directly, but something shifts — a steadiness that wasn't quite there before.`);
    } else if (state.romance >= 2 && state.tension >= 3) {
      state.tension += 1;
      state.morale -= 1;
      changed = true;
      notes.push(`${comp.name} is distant tonight. They're polite when pressed. Whatever is between them and ${leaderName} is tangled, and town hasn't untangled it.`);
    }

    // ── Loyalty warning — may leave ───────────────────────────────
    if (state.loyalty <= -2 && state.tension >= 4) {
      changed = true;
      notes.push(`${comp.name} pulls ${leaderName} aside before the night is out. "I've been thinking," they say. The rest of it is quiet and direct: they're not sure they're going back in. If this is going to change, it needs to change now.`);
    }

    // Apply clamp limits
    state.bond = Math.max(-5, Math.min(10, state.bond));
    state.trust = Math.max(-5, Math.min(10, state.trust));
    state.morale = Math.max(-5, Math.min(10, state.morale));
    state.tension = Math.max(0, Math.min(10, state.tension));
    state.loyalty = Math.max(-5, Math.min(10, state.loyalty));

    if (changed) {
      const nextDisposition = deriveDisposition(state);
      run(db, 'UPDATE npcs SET relationship_state = ?, disposition = ? WHERE id = ?',
        [JSON.stringify(state), nextDisposition, npc.id]);
    }
  }

  if (notes.length === 0 && joined.length > 0) {
    notes.push(`The company settles in for the night. Food, a roof, no monsters. It does what it can.`);
  } else if (joined.length === 0) {
    notes.push(`You're alone tonight. The common room is full enough, but it's not company. You drink your drink and turn in early.`);
  }

  return notes;
}

