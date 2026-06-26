import type { Database } from 'sql.js';
import { get, run } from '../db/helpers.js';
import { d6, d20, roll, roll2d6 } from '../engine/dice.js';
import { getCharismaReactionAdj, getReactionResult, getStrengthMods, THIEF_SKILLS_BASE } from '../engine/tables.js';
import { getCampaignState, noteCampaignEvent, saveCampaignState, shiftFactionStanding, type CampaignSimulationState } from './campaignState.js';
import {
  canParley, generateBountyHunter, getEscalationLevel, getPatrolModifier,
  describeSurpriseByEscalation, willAmbush, resolveParley, isParleyAction,
  type ParleyOutcome,
} from './factions.js';
import { getCompanionPartyModifiers, updateCompanionRelationships } from './companions.js';
import {
  detectRoomType,
  getDungeonTheme,
  getRoomOpener,
  getRoomAmbience,
  getThemePressure,
  getSignpostDetail,
  getRoomSpecificFind,
  getRoomSpecificHazard,
  getLoreFragment,
  CLEARED_ROOM_NOTES,
  type RoomType,
  type DungeonTheme,
} from './dungeonVariety.js';

interface SceneRecord {
  id: string;
  campaign_id?: string;
  name: string;
  brief?: string;
  connections?: string;
  light_level?: string;
  terrain_type?: string;
}

interface CharacterRecord {
  id: string;
  name: string;
  char_class: string;
  level: number;
  hp: number;
  max_hp: number;
  str: number;
  str_percentile?: number;
  dex: number;
  int: number;
  wis: number;
  cha: number;
  gold: number;
  xp: number;
  status?: string;
  thief_skills?: string | null;
  inventory?: string | null;
}

interface NpcRecord {
  id: string;
  name: string;
  disposition?: string;
  personality?: string;
}

interface SceneState {
  searched: boolean;
  listened: boolean;
  hiddenExitFound: boolean;
  stashFound: boolean;
  trapTriggered: boolean;
  clueFound: boolean;
  obstacleCleared: boolean;
  tracksFound: boolean;
  lockOpened: boolean;
  trapDisarmed: boolean;
  scavengedParts: boolean;
  secured: boolean;
  fallbackPoint: boolean;
  safeCamp: boolean;
  cleared: boolean;
  knownHazard: boolean;
  knownTreasure: boolean;
  restCount: number;
  loreFragmentsFound: string[];
}

interface SceneBlueprint {
  ambience: string;
  clue: string;
  stash: { item: string; gold: number; xp: number };
  trap: { kind: string; damage: string; dc: number };
  tracks: string;
  obstacle: string;
  hiddenExitDirection: string;
  hiddenExitDescription: string;
  pressure: string;
  lock: { kind: string; dc: number };
  faction: string;
  encounterTheme: string;
  salvage: string;
  // Dungeon variety
  roomType: RoomType;
  dungeonTheme: DungeonTheme;
  roomOpener: string;
  roomAmbience: string;
  themePressure: string;
  signpostDetail: string;
  roomSpecificFind: string | null;
  roomSpecificHazard: string | null;
}

interface InventoryItem {
  item: string;
  weight: number;
  quantity: number;
  equipped: boolean;
}

export interface ProceduralEnemy {
  name: string;
  level: number;
  thac0: number;
  ac: number;
  hp: number;
  damage: string;
  weaponSpeed: number;
  size?: 'S' | 'M' | 'L';
  morale?: number;
  faction?: string;
}

export interface AdventureActionOutcome {
  content: string;
  type?: 'narration' | 'scene_enter';
  actor?: string;
  sceneConnections?: any[];
  xpDelta?: number;
  goldDelta?: number;
  hpDelta?: number;
  explorationTurnAdvanced?: number;
  extraLogs?: string[];
  encounter?: {
    enemies: ProceduralEnemy[];
    initiativeType: 'group' | 'individual';
    description: string;
    surprise: string;
  };
}

const directions = ['north', 'south', 'east', 'west', 'down', 'up', 'behind the collapsed masonry'];
const ambienceTable = [
  'Metal and old damp. The stone holds onto both.',
  'Sound carries wrong in here. Your footsteps come back half a beat late.',
  'Dust, but not undisturbed. Someone or something has been through.',
  'The air moves slightly. Something nearby is breathing, or there is a gap somewhere.',
  'Cold from the floor up. Not the cold of outside — the cold of below.',
  'Smoke residue on the ceiling. Fire, and not recently.',
];
const clueTable = [
  'Someone was moving supplies through here in a hurry, and left their route imperfectly concealed.',
  'This chamber once mattered to the complex above it; the workmanship says it guarded something worth keeping.',
  'The signs here point to a safer route and a deadlier one, though telling them apart takes care.',
  'There is evidence of scavengers working around a greater threat they do not want to wake.',
];
const stashItems = [
  'a leather satchel of old silvered spikes',
  'a wrapped bundle of lamp oil and wax tapers',
  'a velvet purse holding mixed coin and a signet',
  'a bone tube containing a sketched route fragment',
];
const trapKinds = [
  'a sprung dart slit hidden in the wall',
  'a treacherous loose flagstone that drops weight into spikes',
  'a choking burst of dust and lime from the ceiling',
  'a concealed snare that yanks the unwary off balance',
];
const tracksTable = [
  'small clawed prints, heading deeper. Recent.',
  'boot marks — hobnailed, heavy — over older, softer ones',
  'drag marks. Something was hauled this way, and not gently',
  'the scuff pattern of a nervous sentry on a short route',
  'blood, dried dark, smeared toward the far wall',
];
const obstacleTable = [
  'a swollen oak door that must be forced',
  'a jammed portcullis mechanism gritted with rust',
  'a fallen slab leaving only a narrow crawlspace to clear',
  'a chained iron-bound hatch with a stubborn locking bar',
];
const pressureTable = [
  'Keep it quiet. Something nearby is paying attention.',
  'You are not alone in this wing. Not yet.',
  'A patrol has been through here. Might be back.',
  'Move fast. This room does not feel like somewhere to linger.',
  'The door behind you is the only way out. Worth remembering.',
];
const lockTable = [
  'a tricky warded chest-hasp',
  'a corroded iron door lock',
  'a stiff chain-and-hasp mechanism',
  'a hidden latch requiring patient fingers',
];
const factionKeys = ['locals', 'delvers', 'watch', 'shadows'] as const;
const encounterThemes = ['vermin', 'cultists', 'rival delvers', 'restless dead', 'hungry scouts'];
const salvageTable = [
  'usable iron spikes and chain links',
  'scraps of oilcloth and lamp fittings',
  'repairable buckles, hooks, and cord',
  'old alchemical jars and corks worth reusing',
];

export function ensureSceneState(db: Database, campaignId: string, sceneId: string): SceneState {
  const existing = get(db, 'SELECT state_json FROM scene_state WHERE scene_id = ?', [sceneId]) as any;
  if (existing?.state_json) return normalizeState(parseJson(existing.state_json));
  const initial = normalizeState({});
  saveSceneState(db, campaignId, sceneId, initial);
  return initial;
}

export function saveSceneState(db: Database, campaignId: string, sceneId: string, state: SceneState) {
  run(db,
    'INSERT OR REPLACE INTO scene_state (scene_id, campaign_id, state_json, updated_at) VALUES (?, ?, ?, datetime("now"))',
    [sceneId, campaignId, JSON.stringify(state)]);
}

export function buildSceneBlueprint(scene: SceneRecord): SceneBlueprint {
  // Use >>> (unsigned right-shift) so negative seeds never produce negative indices.
  const s = hash(scene.id) >>> 0;
  const roomType = detectRoomType(scene.name, scene.id);
  const dungeonTheme = getDungeonTheme(scene.campaign_id || scene.id);
  return {
    ambience: ambienceTable[s % ambienceTable.length],
    clue: clueTable[(s >>> 2) % clueTable.length],
    stash: {
      item: stashItems[(s >>> 4) % stashItems.length],
      gold: 8 + (s % 5) * 7,
      xp: 25 + (s % 4) * 20,
    },
    trap: {
      kind: trapKinds[(s >>> 6) % trapKinds.length],
      damage: ['1d4', '1d6', '1d6+1', '2d4'][(s >>> 8) % 4],
      dc: 11 + (s % 5),
    },
    tracks: tracksTable[(s >>> 12) % tracksTable.length],
    obstacle: obstacleTable[(s >>> 14) % obstacleTable.length],
    hiddenExitDirection: directions[(s >>> 16) % directions.length],
    hiddenExitDescription: 'revealed by a draft and a faint seam in the stonework',
    pressure: pressureTable[(s >>> 18) % pressureTable.length],
    lock: {
      kind: lockTable[(s >>> 20) % lockTable.length],
      dc: 12 + ((s >>> 22) % 5),
    },
    faction: factionKeys[(s >>> 24) % factionKeys.length],
    encounterTheme: encounterThemes[(s >>> 26) % encounterThemes.length],
    salvage: salvageTable[(s >>> 28) % salvageTable.length],
    // Dungeon variety
    roomType,
    dungeonTheme,
    roomOpener: getRoomOpener(roomType, scene.id),
    roomAmbience: getRoomAmbience(roomType, dungeonTheme, scene.id),
    themePressure: getThemePressure(dungeonTheme, scene.id),
    signpostDetail: getSignpostDetail(dungeonTheme, scene.id),
    roomSpecificFind: getRoomSpecificFind(roomType, scene.id),
    roomSpecificHazard: getRoomSpecificHazard(roomType, scene.id),
  };
}

export function describeSceneDepth(scene: SceneRecord): string {
  const blueprint = buildSceneBlueprint(scene);
  // Dungeon/indoor: room-type ambience + theme pressure for distinct character.
  // Other terrain: generic tables as before.
  const terrain = scene.terrain_type || 'indoor';
  if (terrain === 'indoor' || terrain === 'dungeon') {
    return `${blueprint.roomAmbience} ${blueprint.themePressure}`;
  }
  return `${blueprint.ambience} ${blueprint.pressure}`;
}

export function resolveRichExploration(params: {
  db: Database;
  campaignId: string;
  scene: SceneRecord;
  character: CharacterRecord;
  npcs: NpcRecord[];
  action: string;
  connections: any[];
}): AdventureActionOutcome | null {
  const { db, campaignId, scene, character, npcs, action, connections } = params;
  const lowered = action.trim().toLowerCase();
  const state = ensureSceneState(db, campaignId, scene.id);
  const blueprint = buildSceneBlueprint(scene);
  const campaignState = getCampaignState(db, campaignId);
  const inventory = getInventory(character);
  const companionMods = getCompanionPartyModifiers(db, campaignId, scene.id);

  if (/search(?!.*hidden)|inspect|examine room|check the room|scavenge/.test(lowered)) {
    const turn = advanceExplorationTurn(db, campaignId, campaignState, inventory, character.id);
    const searchScore = d20() + Math.floor((character.int - 10) / 2) + thiefBonus(character, 'find_traps') + companionMods.scoutBonus;
    const lines: string[] = [];

    if (!state.clueFound && searchScore >= 12) {
      state.clueFound = true;
      lines.push(`You uncover a useful read of the room: ${blueprint.clue}`);
      shiftFactionStanding(campaignState, blueprint.faction, { heat: 1 }, `The party has been probing ${blueprint.faction} territory.`);
    }

    if (!state.stashFound && searchScore >= 15) {
      state.stashFound = true;
      state.knownTreasure = true;
      awardGoldAndXp(db, character, blueprint.stash.gold, blueprint.stash.xp);
      lines.push(`Your careful search reveals ${blueprint.stash.item}, along with ${blueprint.stash.gold} gp in salvageable value.`);
    }

    if (!state.scavengedParts && searchScore >= 14) {
      state.scavengedParts = true;
      addInventoryItem(db, character.id, inventory, { item: `Salvage: ${blueprint.salvage}`, weight: 2, quantity: 1, equipped: false });
      lines.push(`You also recover ${blueprint.salvage}, enough to matter on a hard road.`);
    }

    // Lore fragment — ~1-in-3 chance per search, never repeats, room-type aware
    if (d6() <= 2) {
      const fragment = getLoreFragment(blueprint.roomType, state.loreFragmentsFound);
      if (fragment) {
        state.loreFragmentsFound.push(fragment);
        lines.push(fragment);
      }
    }

    if (!state.trapTriggered && !state.trapDisarmed && searchScore <= 8) {
      state.trapTriggered = true;
      state.knownHazard = true;
      const trap = triggerTrap(db, character, inventory, blueprint, campaignState, companionMods);
      lines.push(trap.content);
      saveSceneState(db, campaignId, scene.id, state);
      saveCampaignState(db, campaignId, campaignState);
      return withPulse({ ...trap, content: lines.join(' ') }, turn.pulse);
    }

    if (lines.length === 0) {
      lines.push('You spend several focused minutes working the edges of the chamber. Nothing immediate turns up, but you leave with a clearer sense of how this place is being used.');
    }

    saveSceneState(db, campaignId, scene.id, state);
    saveCampaignState(db, campaignId, campaignState);
    return finalizeOutcome(db, campaignId, { content: lines.join(' '), explorationTurnAdvanced: turn.turn }, turn, campaignState, blueprint, action);
  }

  if (/listen|press.*ear|hold still/.test(lowered)) {
    const turn = advanceExplorationTurn(db, campaignId, campaignState, inventory, character.id);
    state.listened = true;
    state.tracksFound = true;
    saveSceneState(db, campaignId, scene.id, state);
    const listenScore = d20() + Math.floor((character.wis - 10) / 2) + thiefBonus(character, 'detect_noise') + companionMods.watchBonus;
    const detail = listenScore >= 13 ? blueprint.tracks : blueprint.pressure;
    noteCampaignEvent(campaignState, `${character.name} listened in ${scene.name} and heard ${detail}.`);
    saveCampaignState(db, campaignId, campaignState);
    return finalizeOutcome(db, campaignId, {
      content: `You go still and listen. After the room settles, you pick out ${detail}.`,
      explorationTurnAdvanced: turn.turn,
    }, turn, campaignState, blueprint, action);
  }

  if (/pick lock|pick the lock|unlock|work the lock/.test(lowered)) {
    const turn = advanceExplorationTurn(db, campaignId, campaignState, inventory, character.id);
    if (state.lockOpened) {
      return finalizeOutcome(db, campaignId, { content: 'The lock here has already been worked open.', explorationTurnAdvanced: turn.turn }, turn, campaignState, blueprint, action);
    }
    const tools = inventory.find((item) => item.item === 'Lockpick Set');
    if (!tools || tools.quantity <= 0) {
      return finalizeOutcome(db, campaignId, { content: `You study ${blueprint.lock.kind}, but without proper picks you can only guess at its weaknesses.`, explorationTurnAdvanced: turn.turn }, turn, campaignState, blueprint, action);
    }

    const pickScore = d20() + Math.floor((character.dex - 10) / 2) + thiefBonus(character, 'open_locks') + companionMods.scoutBonus;
    if (pickScore >= blueprint.lock.dc) {
      state.lockOpened = true;
      state.cleared = false;
      saveSceneState(db, campaignId, scene.id, state);
      awardXp(db, character, 25);
      shiftFactionStanding(campaignState, 'delvers', { reputation: 1 }, 'The party solved a lock cleanly instead of smashing it.');
      saveCampaignState(db, campaignId, campaignState);
      return finalizeOutcome(db, campaignId, {
        content: `With a patient touch, you defeat ${blueprint.lock.kind}. The mechanism yields with a quiet, deeply satisfying click.`,
        xpDelta: 25,
        explorationTurnAdvanced: turn.turn,
      }, turn, campaignState, blueprint, action);
    }

    if (d6() <= 2) {
      decrementInventory(db, character.id, inventory, 'Lockpick Set', 1);
      campaignState.supply.lockpicksBroken += 1;
      noteCampaignEvent(campaignState, `${character.name} broke a lockpick set in ${scene.name}.`);
    }
    saveCampaignState(db, campaignId, campaignState);
    return finalizeOutcome(db, campaignId, {
      content: `You work at ${blueprint.lock.kind}, but it resists you. The failure costs time and may have cost you a useful pick.`,
      explorationTurnAdvanced: turn.turn,
    }, turn, campaignState, blueprint, action);
  }

  if (/disarm trap|disable trap|jam the trap/.test(lowered)) {
    const turn = advanceExplorationTurn(db, campaignId, campaignState, inventory, character.id);
    if (state.trapDisarmed) {
      return finalizeOutcome(db, campaignId, { content: 'Whatever trap was here has already been neutralised.', explorationTurnAdvanced: turn.turn }, turn, campaignState, blueprint, action);
    }

    const disarmScore = d20() + Math.floor((character.dex - 10) / 2) + thiefBonus(character, 'find_traps') + companionMods.scoutBonus;
    if (disarmScore >= blueprint.trap.dc) {
      state.trapDisarmed = true;
      state.knownHazard = true;
      saveSceneState(db, campaignId, scene.id, state);
      awardXp(db, character, 30);
      saveCampaignState(db, campaignId, campaignState);
      return finalizeOutcome(db, campaignId, {
        content: `You identify the working heart of ${blueprint.trap.kind} and disable it before it can punish the party.`,
        xpDelta: 30,
        explorationTurnAdvanced: turn.turn,
      }, turn, campaignState, blueprint, action);
    }

    state.trapTriggered = true;
    state.knownHazard = true;
    const trap = triggerTrap(db, character, inventory, blueprint, campaignState, companionMods);
    saveSceneState(db, campaignId, scene.id, state);
    saveCampaignState(db, campaignId, campaignState);
    return finalizeOutcome(db, campaignId, { ...trap, explorationTurnAdvanced: turn.turn }, turn, campaignState, blueprint, action);
  }

  if (/search.*hidden|hidden.*door|secret/.test(lowered)) {
    const hasHiddenConnections = connections.some((entry: any) => entry.hidden);
    const turn = advanceExplorationTurn(db, campaignId, campaignState, inventory, character.id);
    if (state.hiddenExitFound && hasHiddenConnections) {
      return finalizeOutcome(db, campaignId, { content: `The concealed way ${blueprint.hiddenExitDirection} is already exposed.`, explorationTurnAdvanced: turn.turn }, turn, campaignState, blueprint, action);
    }

    const searchRoll = d6();
    const skillEdge = thiefBonus(character, 'find_traps') > 0 || character.dex >= 15 || character.wis >= 14;
    const success = searchRoll <= (skillEdge ? 3 : 2) + Math.min(1, companionMods.scoutBonus);
    if (!success) {
      saveCampaignState(db, campaignId, campaignState);
      return finalizeOutcome(db, campaignId, { content: 'You trace mortar lines and test the stonework, but the walls keep their secrets for now.', explorationTurnAdvanced: turn.turn }, turn, campaignState, blueprint, action);
    }

    state.hiddenExitFound = true;
    if (!hasHiddenConnections) {
      state.clueFound = true;
      saveSceneState(db, campaignId, scene.id, state);
      awardXp(db, character, 15);
      saveCampaignState(db, campaignId, campaignState);
      return finalizeOutcome(db, campaignId, {
        content: `Your search uncovers no literal secret door, but it does expose a subtle truth about the area: ${blueprint.clue}`,
        xpDelta: 15,
        explorationTurnAdvanced: turn.turn,
      }, turn, campaignState, blueprint, action);
    }

    const updatedConnections = revealHiddenConnection(connections);
    saveSceneState(db, campaignId, scene.id, state);
    run(db, 'UPDATE scenes SET connections = ? WHERE id = ?', [JSON.stringify(updatedConnections), scene.id]);
    shiftFactionStanding(campaignState, 'shadows', { heat: 1 }, 'The party keeps unmasking hidden routes.');
    saveCampaignState(db, campaignId, campaignState);
    return finalizeOutcome(db, campaignId, {
      content: `Your patience pays off. A concealed route ${blueprint.hiddenExitDirection} reveals itself, ${blueprint.hiddenExitDescription}.`,
      sceneConnections: updatedConnections.filter((entry: any) => !entry.hidden),
      explorationTurnAdvanced: turn.turn,
    }, turn, campaignState, blueprint, action);
  }

  if (/force|bash|shoulder|open.*door|lift.*gate|clear.*slab/.test(lowered)) {
    const turn = advanceExplorationTurn(db, campaignId, campaignState, inventory, character.id);
    if (state.obstacleCleared) {
      return finalizeOutcome(db, campaignId, { content: 'The way is already clear enough to pass.', explorationTurnAdvanced: turn.turn }, turn, campaignState, blueprint, action);
    }
    const strMods = getStrengthMods(character.str, character.str_percentile);
    const effort = d20() + strMods.hitAdj + Math.floor((character.level - 1) / 2) + companionMods.vanguardBonus;
    if (effort >= 13) {
      state.obstacleCleared = true;
      state.secured = false;
      saveSceneState(db, campaignId, scene.id, state);
      awardXp(db, character, 20);
      shiftFactionStanding(campaignState, blueprint.faction, { heat: 2 }, 'The party is forcing their way through loudly.');
      saveCampaignState(db, campaignId, campaignState);
      return finalizeOutcome(db, campaignId, {
        content: `With a committed effort, you overcome ${blueprint.obstacle}. The noise is terrible, but the path yields.`,
        xpDelta: 20,
        explorationTurnAdvanced: turn.turn,
      }, turn, campaignState, blueprint, action, true);
    }
    const bruise = Math.min(2, Math.max(1, roll(1, 3).total - 1));
    applyHp(db, character.id, character.hp - bruise);
    shiftFactionStanding(campaignState, blueprint.faction, { heat: 1 });
    saveSceneState(db, campaignId, scene.id, state);
    saveCampaignState(db, campaignId, campaignState);
    return finalizeOutcome(db, campaignId, {
      content: `You throw your weight against ${blueprint.obstacle}, but it holds. The failed effort leaves you sore and noisy.`,
      hpDelta: -bruise,
      explorationTurnAdvanced: turn.turn,
    }, turn, campaignState, blueprint, action, true);
  }

  if (/rest|bind wounds|catch our breath|take a breather|camp/.test(lowered)) {
    const turn = advanceExplorationTurn(db, campaignId, campaignState, inventory, character.id);
    const heal = state.restCount === 0 ? Math.min(character.max_hp - character.hp, 1 + Math.floor((character.level + 1) / 3) + Math.min(1, companionMods.wardenBonus)) : 0;
    state.restCount += 1;
    if (heal > 0) {
      applyHp(db, character.id, character.hp + heal);
      if (consumeItem(db, character.id, inventory, 'Bandage Roll', 1)) {
        campaignState.supply.bandagesUsed += 1;
      }
    }
    if (state.secured || state.obstacleCleared || state.trapDisarmed) {
      state.safeCamp = true;
    }
    saveSceneState(db, campaignId, scene.id, state);
    saveCampaignState(db, campaignId, campaignState);
    const riskText = d6() <= Math.max(1, Math.min(5, turn.dangerLevel + state.restCount - Math.min(1, companionMods.watchBonus)))
      ? 'Your pause buys recovery, but it also gives nearby threats time to adjust around you.'
      : 'You manage a brief, disciplined pause without giving too much away.';
    return finalizeOutcome(db, campaignId, {
      content: `${heal > 0 ? `You patch wounds and recover ${heal} hit point${heal === 1 ? '' : 's'}. ` : ''}${riskText}`,
      hpDelta: heal,
      explorationTurnAdvanced: turn.turn,
    }, turn, campaignState, blueprint, action);
  }

  if (/secure|barricade|fortify|hold this room/.test(lowered)) {
    const turn = advanceExplorationTurn(db, campaignId, campaignState, inventory, character.id);
    state.secured = true;
    state.cleared = true;
    if (state.trapDisarmed || state.obstacleCleared) {
      state.safeCamp = true;
    }
    campaignState.encounterPressure = Math.max(0, campaignState.encounterPressure - 1);
    saveSceneState(db, campaignId, scene.id, state);
    saveCampaignState(db, campaignId, campaignState);
    return finalizeOutcome(db, campaignId, {
      content: 'You spend time making the room defensible, noting angles, choke points, and what would need to move fast if you had to fall back here.',
      explorationTurnAdvanced: turn.turn,
    }, turn, campaignState, blueprint, action);
  }

  if (/fallback|rally point|mark this room|base camp/.test(lowered)) {
    const turn = advanceExplorationTurn(db, campaignId, campaignState, inventory, character.id);
    state.fallbackPoint = true;
    if (state.secured) state.safeCamp = true;
    saveSceneState(db, campaignId, scene.id, state);
    saveCampaignState(db, campaignId, campaignState);
    return finalizeOutcome(db, campaignId, {
      content: 'You mark this place as a fallback point: not safe exactly, but dependable enough to matter under pressure.',
      explorationTurnAdvanced: turn.turn,
    }, turn, campaignState, blueprint, action);
  }

  if (/map the room|sketch the room|chart this place|make a map/.test(lowered)) {
    const turn = advanceExplorationTurn(db, campaignId, campaignState, inventory, character.id);
    state.searched = true;
    saveSceneState(db, campaignId, scene.id, state);
    saveCampaignState(db, campaignId, campaignState);
    return finalizeOutcome(db, campaignId, {
      content: 'You take a few disciplined minutes to sketch routes, rough dimensions, and memorable hazards so the next decision can be made from something better than fear.',
      xpDelta: 10,
      explorationTurnAdvanced: turn.turn,
    }, turn, campaignState, blueprint, action);
  }

  if (/probe.*floor|test.*floor|tap.*ahead|prod.*ahead|use.*pole/.test(lowered)) {
    const turn = advanceExplorationTurn(db, campaignId, campaignState, inventory, character.id);
    if (!state.knownHazard) {
      state.knownHazard = true;
      saveSceneState(db, campaignId, scene.id, state);
      saveCampaignState(db, campaignId, campaignState);
      return finalizeOutcome(db, campaignId, {
        content: `You slow the expedition down and test the route before trusting it. The caution pays off: signs of ${blueprint.trap.kind} show themselves before anyone commits full weight to the ground.`,
        explorationTurnAdvanced: turn.turn,
      }, turn, campaignState, blueprint, action);
    }

    saveCampaignState(db, campaignId, campaignState);
    return finalizeOutcome(db, campaignId, {
      content: 'You check the next few steps the hard way instead of the fast way, which is often the difference between caution and a funeral.',
      explorationTurnAdvanced: turn.turn,
    }, turn, campaignState, blueprint, action);
  }

  if (/set ambush|prepare ambush|hold an ambush|ready an ambush/.test(lowered)) {
    const turn = advanceExplorationTurn(db, campaignId, campaignState, inventory, character.id);
    state.secured = true;
    campaignState.encounterPressure = Math.max(0, campaignState.encounterPressure - 2);
    saveSceneState(db, campaignId, scene.id, state);
    noteCampaignEvent(campaignState, `${character.name} prepared an ambush in ${scene.name}.`);
    saveCampaignState(db, campaignId, campaignState);
    return finalizeOutcome(db, campaignId, {
      content: `The company chooses ground, lanes of fire, and the angle of first contact instead of waiting to be surprised. If trouble comes next, it will find a readier party.`,
      xpDelta: 15,
      explorationTurnAdvanced: turn.turn,
    }, turn, campaignState, blueprint, action);
  }

  if (/bar the door|spike the door|jam the door|wedge the door/.test(lowered)) {
    const turn = advanceExplorationTurn(db, campaignId, campaignState, inventory, character.id);
    state.secured = true;
    state.safeCamp = state.safeCamp || state.trapDisarmed || state.obstacleCleared;
    campaignState.encounterPressure = Math.max(0, campaignState.encounterPressure - 1);
    saveSceneState(db, campaignId, scene.id, state);
    noteCampaignEvent(campaignState, `${character.name} denied an easy approach in ${scene.name}.`);
    saveCampaignState(db, campaignId, campaignState);
    return finalizeOutcome(db, campaignId, {
      content: 'You physically deny the easiest line of approach, buying the company the kind of ugly little safety that matters underground.',
      explorationTurnAdvanced: turn.turn,
    }, turn, campaignState, blueprint, action);
  }

  if (/loot carefully|search the bodies|search corpse|loot the dead|check the bodies/.test(lowered)) {
    const turn = advanceExplorationTurn(db, campaignId, campaignState, inventory, character.id);
    if (!state.cleared && !state.stashFound) {
      saveCampaignState(db, campaignId, campaignState);
      return finalizeOutcome(db, campaignId, {
        content: 'You start thinking about loot before the room is truly yours. The instinct is understandable, but that is how delvers die richer than they lived.',
        explorationTurnAdvanced: turn.turn,
      }, turn, campaignState, blueprint, action, true);
    }

    if (state.scavengedParts && state.knownTreasure) {
      saveCampaignState(db, campaignId, campaignState);
      return finalizeOutcome(db, campaignId, {
        content: 'You work the aftermath with a professional eye, but the best salvage has already been taken.',
        explorationTurnAdvanced: turn.turn,
      }, turn, campaignState, blueprint, action);
    }

    const gold = 6 + d6() * 3;
    const xp = 15 + d6() * 5;
    state.scavengedParts = true;
    state.knownTreasure = true;
    awardGoldAndXp(db, character, gold, xp);
    addInventoryItem(db, character.id, inventory, { item: `Recovered Trophies from ${blueprint.encounterTheme}`, weight: 1, quantity: 1, equipped: false });
    saveSceneState(db, campaignId, scene.id, state);
    noteCampaignEvent(campaignState, `${character.name} stripped useful spoils in ${scene.name}.`);
    saveCampaignState(db, campaignId, campaignState);
    return finalizeOutcome(db, campaignId, {
      content: `You loot with care instead of greed, turning the aftermath into ${gold} gp in value and a bundle of useful trophies or salvage.`,
      xpDelta: xp,
      goldDelta: gold,
      explorationTurnAdvanced: turn.turn,
    }, turn, campaignState, blueprint, action);
  }

  if (/check supplies|count supplies|take stock|inventory check|share supplies|redistribute gear/.test(lowered)) {
    const turn = advanceExplorationTurn(db, campaignId, campaignState, inventory, character.id);
    const torches = getItemQuantity(inventory, 'Torch');
    const rations = getItemQuantity(inventory, 'Ration');
    const bandages = getItemQuantity(inventory, 'Bandage Roll');
    const arrows = getItemQuantity(inventory, 'Arrow');
    const supportText = /share supplies|redistribute gear/.test(lowered)
      ? 'The company shifts weight and essentials around so nobody is carrying panic in their pack.'
      : 'You pause long enough to count what will matter when the delve gets meaner.';
    saveCampaignState(db, campaignId, campaignState);
    return finalizeOutcome(db, campaignId, {
      content: `${supportText} On hand: ${torches} torches, ${rations} rations, ${bandages} bandages, ${arrows} arrows, and ${character.gold} gp. The expedition has already burned ${campaignState.supply.torchesBurned} torches and spent ${campaignState.supply.rationsSpent} rations this run.`,
      explorationTurnAdvanced: turn.turn,
    }, turn, campaignState, blueprint, action);
  }

  if (/lead a prayer|offer a prayer|pray|invoke.*oath|call on.*oath|bless the company/.test(lowered)) {
    const turn = advanceExplorationTurn(db, campaignId, campaignState, inventory, character.id);
    const divineClass = /paladin|cleric|druid/.test(character.char_class);
    const lawfulHeart = character.char_class === 'paladin' || character.wis >= 13;
    const relief = divineClass ? 1 : 0;
    const heal = divineClass ? Math.min(character.max_hp - character.hp, character.char_class === 'paladin' ? 2 : 1) : 0;
    if (relief > 0) {
      campaignState.encounterPressure = Math.max(0, campaignState.encounterPressure - relief);
    }
    if (heal > 0) {
      applyHp(db, character.id, character.hp + heal);
    }
    if (lawfulHeart) {
      shiftFactionStanding(campaignState, 'watch', { reputation: 1 }, `${character.name} projected discipline and purpose under pressure.`);
      shiftFactionStanding(campaignState, 'locals', { reputation: 1 }, `${character.name} kept the expedition steady instead of desperate.`);
    }
    noteCampaignEvent(campaignState, `${character.name} steadied the company with prayer in ${scene.name}.`);
    saveCampaignState(db, campaignId, campaignState);
    return finalizeOutcome(db, campaignId, {
      content: divineClass
        ? `${character.name} gathers the company, sets fear in order, and leads a hard little prayer fit for dangerous ground. The mood steadies, pressure eases, and ${heal > 0 ? `${heal} hit point${heal === 1 ? '' : 's'} return with the renewed resolve.` : 'the company finds its nerve again.'}`
        : `${character.name} takes a quiet moment to center the mind. It is more discipline than miracle, but even that matters in a place like this.`,
      hpDelta: heal,
      explorationTurnAdvanced: turn.turn,
    }, turn, campaignState, blueprint, action);
  }

  if (/sense evil|read their intent|judge their intent|test their intent/.test(lowered)) {
    const turn = advanceExplorationTurn(db, campaignId, campaignState, inventory, character.id);
    const talent = character.char_class === 'paladin' || character.wis >= 14;
    const factionStanding = campaignState.factions[blueprint.faction];
    const npcHint = npcs[0]
      ? `${npcs[0].name} feels ${npcs[0].disposition || 'guarded'}, with the emotional weight of someone tied to ${blueprint.faction}.`
      : `The scene itself carries the fingerprints of ${blueprint.faction}.`;
    const deeper = talent
      ? `Your instincts separate surface manner from underlying motive: ${blueprint.clue} ${describeFactionResult(campaignState, blueprint.faction)}`
      : `You catch only broad emotional weather, but it is enough to tell this place is not morally blank.`;
    saveCampaignState(db, campaignId, campaignState);
    return finalizeOutcome(db, campaignId, {
      content: `${npcHint} ${deeper}`,
      explorationTurnAdvanced: turn.turn,
    }, turn, campaignState, blueprint, action);
  }

  if ((/talk|parley|hail|negotiate|bargain/.test(lowered) || npcs.length > 0) && npcs.length > 0) {
    const turn = advanceExplorationTurn(db, campaignId, campaignState, inventory, character.id);
    const factionStanding = campaignState.factions[blueprint.faction];
    const reactionRoll = roll2d6().total
      + Math.max(-2, Math.min(2, Math.floor(getCharismaReactionAdj(character.cha) / 2)))
      + Math.max(-2, Math.min(2, Math.floor((factionStanding?.reputation || 0) / 3)))
      + Math.min(2, companionMods.envoyBonus);
    const reaction = getReactionResult(reactionRoll);
    const npcName = npcs[0].name;
    const responseMap: Record<string, string> = {
      hostile: `${npcName} takes your approach as a threat and reaches for violence or retreat.`,
      unfriendly: `${npcName} keeps distance and answers curtly, offering nothing without leverage.`,
      indifferent: `${npcName} hears you out but gives away only what costs little.`,
      friendly: `${npcName} softens and offers a useful warning, route, or rumor.`,
      enthusiastic: `${npcName} quickly decides you are worth helping and volunteers more than you asked.`,
    };
    const xp = reaction === 'friendly' || reaction === 'enthusiastic' ? 15 : 0;
    if (xp > 0) awardXp(db, character, xp);
    updateCompanionRelationships({
      db,
      npcIds: [npcs[0].id],
      kind: /flirt|comfort|confide|admire/.test(lowered)
        ? 'romance'
        : /insult|threaten|argue|accuse/.test(lowered)
          ? 'friction'
          : 'parley',
      note: `${character.name} spoke to ${npcName}: ${action}`,
    });
    shiftFactionStanding(campaignState, blueprint.faction, {
      reputation: reaction === 'friendly' ? 1 : reaction === 'enthusiastic' ? 2 : reaction === 'hostile' ? -2 : reaction === 'unfriendly' ? -1 : 0,
      heat: reaction === 'hostile' ? 2 : 0,
    }, `${character.name} parleyed in ${scene.name}.`);
    saveCampaignState(db, campaignId, campaignState);
    return finalizeOutcome(db, campaignId, {
      content: `${responseMap[reaction]} ${describeFactionResult(campaignState, blueprint.faction)} (Reaction ${reactionRoll}: ${reaction}.)`,
      xpDelta: xp,
      explorationTurnAdvanced: turn.turn,
    }, turn, campaignState, blueprint, action, reaction === 'hostile');
  }

  if (/sneak|hide|creep|move silently/.test(lowered)) {
    const turn = advanceExplorationTurn(db, campaignId, campaignState, inventory, character.id);
    const stealth = d20() + Math.floor((character.dex - 10) / 2) + thiefBonus(character, 'move_silently') + Math.min(2, companionMods.scoutBonus);
    const good = stealth >= 13;
    if (good) {
      campaignState.encounterPressure = Math.max(0, campaignState.encounterPressure - 1);
    } else {
      shiftFactionStanding(campaignState, blueprint.faction, { heat: 1 });
    }
    saveCampaignState(db, campaignId, campaignState);
    return finalizeOutcome(db, campaignId, {
      content: good
        ? 'You manage a careful, controlled advance, shifting from obvious intrusion to measured threat.'
        : 'You try to move like a rumor, but the place answers with enough scrape and clatter to remind you that stealth here is earned.',
      explorationTurnAdvanced: turn.turn,
    }, turn, campaignState, blueprint, action, !good);
  }

  if (/shoot|fire|loose an arrow|throw dagger/.test(lowered)) {
    const turn = advanceExplorationTurn(db, campaignId, campaignState, inventory, character.id);
    const spentArrow = consumeItem(db, character.id, inventory, 'Arrow', 1);
    if (spentArrow) {
      campaignState.supply.arrowsSpent += 1;
    }
    saveCampaignState(db, campaignId, campaignState);
    return finalizeOutcome(db, campaignId, {
      content: spentArrow
        ? 'You ready missile fire and spend ammunition in the process, a small cost that starts to matter over a long delve.'
        : 'You go to ready missile fire and realise your ammunition is running thin enough to matter.',
      explorationTurnAdvanced: turn.turn,
    }, turn, campaignState, blueprint, action, true);
  }

  if (/use bandage|bind.*wound|treat.*wound|dress.*wound/.test(lowered)) {
    const turn = advanceExplorationTurn(db, campaignId, campaignState, inventory, character.id);
    if (character.hp >= character.max_hp) {
      saveCampaignState(db, campaignId, campaignState);
      return finalizeOutcome(db, campaignId, {
        content: 'You check the worst of the bruises and cuts, but nothing needs a fresh bandage right now.',
        explorationTurnAdvanced: turn.turn,
      }, turn, campaignState, blueprint, action);
    }

    if (!consumeItem(db, character.id, inventory, 'Bandage Roll', 1)) {
      saveCampaignState(db, campaignId, campaignState);
      return finalizeOutcome(db, campaignId, {
        content: 'You reach for bandages and come up empty. The expedition is starting to feel that shortage.',
        explorationTurnAdvanced: turn.turn,
      }, turn, campaignState, blueprint, action);
    }

    const heal = Math.min(character.max_hp - character.hp, Math.max(1, Math.floor((character.level + 2) / 3)));
    applyHp(db, character.id, character.hp + heal);
    campaignState.supply.bandagesUsed += 1;
    noteCampaignEvent(campaignState, `${character.name} used field bandages in ${scene.name}.`);
    saveCampaignState(db, campaignId, campaignState);
    return finalizeOutcome(db, campaignId, {
      content: `You take a disciplined minute to bind the worst of the damage and recover ${heal} hit point${heal === 1 ? '' : 's'}.`,
      hpDelta: heal,
      explorationTurnAdvanced: turn.turn,
    }, turn, campaignState, blueprint, action);
  }

  if (/light.*torch|raise.*torch|burn a torch|set a torch/.test(lowered)) {
    const turn = advanceExplorationTurn(db, campaignId, campaignState, inventory, character.id);
    if (!consumeItem(db, character.id, inventory, 'Torch', 1)) {
      saveCampaignState(db, campaignId, campaignState);
      return finalizeOutcome(db, campaignId, {
        content: 'You go to raise more light and realise the company is out of spare torches.',
        explorationTurnAdvanced: turn.turn,
      }, turn, campaignState, blueprint, action);
    }

    campaignState.supply.torchesBurned += 1;
    let reveal = 'The new flame pushes the room back into understandable shapes and gives everyone a cleaner read on the ground.';
    if (!state.clueFound) {
      state.clueFound = true;
      reveal += ` In the steadier light, you catch something you had missed before: ${blueprint.clue}`;
    } else if (!state.knownHazard) {
      state.knownHazard = true;
      reveal += ` The better light also makes the local danger easier to read, including signs of ${blueprint.trap.kind}.`;
    }
    saveSceneState(db, campaignId, scene.id, state);
    noteCampaignEvent(campaignState, `${character.name} spent a torch to improve visibility in ${scene.name}.`);
    saveCampaignState(db, campaignId, campaignState);
    return finalizeOutcome(db, campaignId, {
      content: reveal,
      explorationTurnAdvanced: turn.turn,
    }, turn, campaignState, blueprint, action);
  }

  if (/holy symbol|consecrate|ward this place|bless this room|present the symbol/.test(lowered)) {
    const turn = advanceExplorationTurn(db, campaignId, campaignState, inventory, character.id);
    const hasSymbol = inventory.some((item) => item.item === 'Holy Symbol' && item.quantity > 0);
    if (!hasSymbol) {
      saveCampaignState(db, campaignId, campaignState);
      return finalizeOutcome(db, campaignId, {
        content: 'You try to invoke a sacred ward, but without a holy symbol the gesture has little force behind it.',
        explorationTurnAdvanced: turn.turn,
      }, turn, campaignState, blueprint, action);
    }

    const divineAuthority = /paladin|cleric|druid/.test(character.char_class);
    if (divineAuthority) {
      campaignState.encounterPressure = Math.max(0, campaignState.encounterPressure - (/restless dead|cultists/.test(blueprint.encounterTheme) ? 2 : 1));
      shiftFactionStanding(campaignState, 'watch', { reputation: 1 }, `${character.name} sanctified dangerous ground with clear purpose.`);
    }
    state.secured = true;
    if (/restless dead|cultists/.test(blueprint.encounterTheme)) {
      state.knownHazard = true;
    }
    saveSceneState(db, campaignId, scene.id, state);
    noteCampaignEvent(campaignState, `${character.name} raised a holy ward in ${scene.name}.`);
    saveCampaignState(db, campaignId, campaignState);
    return finalizeOutcome(db, campaignId, {
      content: divineAuthority
        ? `You raise the holy symbol and push a brief but forceful sense of order through the room. The place does not become safe, but it does become less eager to close its teeth around you.`
        : 'You raise the symbol more in hope than authority, but even that small ritual steadies the room a little.',
      explorationTurnAdvanced: turn.turn,
    }, turn, campaignState, blueprint, action);
  }

  if (/set.*rope|secure.*rope|rope the hazard|fix a rope/.test(lowered)) {
    const turn = advanceExplorationTurn(db, campaignId, campaignState, inventory, character.id);
    const hasRope = inventory.some((item) => item.item === 'Rope (50 ft)' && item.quantity > 0);
    if (!hasRope) {
      saveCampaignState(db, campaignId, campaignState);
      return finalizeOutcome(db, campaignId, {
        content: 'You would need rope for that, and the company has none ready to hand.',
        explorationTurnAdvanced: turn.turn,
      }, turn, campaignState, blueprint, action);
    }

    state.fallbackPoint = true;
    state.knownHazard = true;
    state.secured = true;
    if (!state.obstacleCleared && /slab|hatch|portcullis|crawlspace/.test(blueprint.obstacle)) {
      state.obstacleCleared = true;
    }
    saveSceneState(db, campaignId, scene.id, state);
    noteCampaignEvent(campaignState, `${character.name} rigged rope lines in ${scene.name}.`);
    saveCampaignState(db, campaignId, campaignState);
    return finalizeOutcome(db, campaignId, {
      content: `You rig rope where it matters, turning dangerous ground into manageable ground. The route is manageable now.`,
      xpDelta: 10,
      explorationTurnAdvanced: turn.turn,
    }, turn, campaignState, blueprint, action);
  }


  // ── LOOK AROUND / SURVEY ────────────────────────────────────────────
  // Matches any general observation action — never rejected, always narrated.
  if (/^look$|^l$|look around|look about|survey|scan the room|scan the area|examine room|examine the room|examine the area|study the room|study the area|take in the room|take a look|peer around|observe|take stock of|glance around|sweep the room|assess the room|case the room|get a read|read the room|size.up the room|where am i|where are we|what is this place|what is this room|what do i see|what can i see|what is here|describe this|describe the room|describe where i am|what is around|tell me about this place|what kind of place|what sort of place/i.test(lowered)) {
    const lines: string[] = [];

    // Light condition
    const lightLevel = campaignState.delve?.lightLevel;
    if (lightLevel === 'dark') {
      lines.push(`Torches out. You can barely see your hand.`);
    } else if (lightLevel === 'dim') {
      lines.push(`Your torch is low. The far end of the room is guesswork.`);
    }

    // Lead with an active-observation framing line, not the entry description verbatim
    const lookLeadins = [
      'You pause and take it in.',
      'You make a deliberate sweep of the room.',
      'You stop and look — really look.',
      'You slow your breathing and take stock.',
      'You cast your eye across the room again.',
    ];
    const leadIn = lookLeadins[(d6() - 1) % lookLeadins.length];
    lines.push(`${leadIn} ${blueprint.roomAmbience}`);

    // Atmospheric details — pick by perception roll, not everything at once
    const atmosphericDetails: string[] = [];
    if (!state.clueFound && blueprint.clue) {
      atmosphericDetails.push(blueprint.clue);
    }
    if (blueprint.tracks) {
      atmosphericDetails.push(`The floor: ${blueprint.tracks}.`);
    }
    if (!state.knownHazard && blueprint.themePressure) {
      atmosphericDetails.push(blueprint.themePressure);
    }

    const perceptionRoll = d20() + Math.floor((character.wis - 10) / 2) + companionMods.watchBonus;
    const detailCount = perceptionRoll >= 15 ? Math.min(2, atmosphericDetails.length)
                      : perceptionRoll >= 8  ? Math.min(1, atmosphericDetails.length)
                      : 0;
    for (let i = 0; i < detailCount; i++) {
      lines.push(atmosphericDetails[i]);
    }

    // Lore fragment — ~1-in-3 chance, room-type specific, never repeats
    if (d6() <= 2) {
      const fragment = getLoreFragment(blueprint.roomType, state.loreFragmentsFound);
      if (fragment) {
        state.loreFragmentsFound.push(fragment);
        lines.push(fragment);
      }
    }

    // Exits — blunt
    const visibleConnections = connections.filter((c: any) => !c.hidden);
    if (visibleConnections.length === 0) {
      lines.push(`No exits are obvious.`);
    } else if (visibleConnections.length === 1) {
      lines.push(`One way out: ${visibleConnections[0].direction || 'the passage ahead'}.`);
    } else {
      const dirs = visibleConnections.map((c: any) => c.direction || 'a passage').join(', ');
      lines.push(`${visibleConnections.length} ways forward: ${dirs}.`);
    }

    // Signpost — "further in" signal when perception is sharp and exits exist
    if (perceptionRoll >= 15 && visibleConnections.length > 0) {
      lines.push(blueprint.signpostDetail);
    }

    // Cleared room — this place has given what it had
    if (state.stashFound && state.scavengedParts && state.clueFound) {
      const noteIdx = Math.abs(scene.id.split('').reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7)) % CLEARED_ROOM_NOTES.length;
      lines.push(CLEARED_ROOM_NOTES[noteIdx]);
    }

    // NPCs
    if (npcs.length > 0) {
      const npcNames = npcs.map((n: any) => n.name).join(' and ');
      lines.push(`${npcNames} ${npcs.length === 1 ? 'is' : 'are'} here.`);
    }

    // Known treasure reminder
    if (state.knownTreasure) {
      lines.push(`The valuables you found earlier are still here.`);
    }

    saveSceneState(db, campaignId, scene.id, state);
    saveCampaignState(db, campaignId, campaignState);
    return finalizeOutcome(db, campaignId, {
      content: lines.filter(Boolean).join(' '),

    }, { turn: 0, pulse: null } as any, campaignState, blueprint, action);
  }


  // ── TARGETED EXAMINATION — "look at X", "examine X", "inspect X" ──────────
  if (/^(look at|examine|inspect|study|peer at|peer into|check out|check the|look inside|look behind|look under|look through|feel the|feel around|run.*hand|stare at|scrutinize|investigate|take a closer look at)\b/i.test(lowered)) {
    const turn = advanceExplorationTurn(db, campaignId, campaignState, inventory, character.id);
    const perceptionRoll = d20() + Math.floor((character.int - 10) / 2) + thiefBonus(character, 'find_traps') + companionMods.watchBonus;
    const lines: string[] = [];

    if (!state.clueFound && perceptionRoll >= 12) {
      state.clueFound = true;
      lines.push(`Closer examination reveals: ${blueprint.clue}`);
      saveSceneState(db, campaignId, scene.id, state);
    } else if (!state.knownHazard && perceptionRoll >= 10) {
      state.knownHazard = true;
      lines.push(`On closer inspection, signs of ${blueprint.trap.kind} resolve themselves. Worth knowing.`);
      saveSceneState(db, campaignId, scene.id, state);
    } else {
      const examResponses = [
        `It holds up under scrutiny, but nothing new resolves from looking harder. ${blueprint.roomAmbience}`,
        `You take a long look. The room offers the same information twice: ${blueprint.signpostDetail}`,
        `Worth examining. It gives away nothing beyond what the room already told you, but examining it was still the right instinct.`,
      ];
      lines.push(examResponses[Math.abs(hash(action + scene.id)) % examResponses.length]);
    }

    saveCampaignState(db, campaignId, campaignState);
    return finalizeOutcome(db, campaignId, { content: lines.join(' '), explorationTurnAdvanced: turn.turn }, turn, campaignState, blueprint, action);
  }

  // ── MOVEMENT / APPROACH — "walk toward X", "approach X", "go toward X" ───
  if (/^(walk toward|move toward|head toward|approach|go toward|follow the|follow|creep toward|inch toward|step toward|advance toward|make.*way toward|make.*way to|head to|move to|go to|move deeper|press deeper|push forward|advance|move forward|head forward|go deeper|go further|press on|continue)\b/i.test(lowered)) {
    const turn = advanceExplorationTurn(db, campaignId, campaignState, inventory, character.id);
    const stealth = d20() + Math.floor((character.dex - 10) / 2) + thiefBonus(character, 'move_silently') + Math.min(1, companionMods.scoutBonus);
    if (!state.tracksFound) {
      state.tracksFound = true;
      state.listened = true;
      saveSceneState(db, campaignId, scene.id, state);
    }
    const noisy = stealth < 8;
    if (noisy) shiftFactionStanding(campaignState, blueprint.faction, { heat: 1 });
    saveCampaignState(db, campaignId, campaignState);
    return finalizeOutcome(db, campaignId, {
      content: noisy
        ? `You move that way, but the floor and your kit are not cooperating. The advance is not quiet. ${blueprint.pressure}`
        : `You advance carefully. The room gives way as you push deeper into it. ${blueprint.tracks ? `The ground here says: ${blueprint.tracks}` : blueprint.roomAmbience}`,
      explorationTurnAdvanced: turn.turn,
    }, turn, campaignState, blueprint, action, noisy);
  }

  // ── ITEM PICKUP — "pick up X", "grab X", "take X" ─────────────────────────
  if (/^(pick up|grab|take the|pocket|collect|retrieve|snatch)\b/i.test(lowered) || (/^take\b/i.test(lowered) && !/^take a\b/i.test(lowered))) {
    const turn = advanceExplorationTurn(db, campaignId, campaignState, inventory, character.id);
    if (!state.stashFound && !state.scavengedParts) {
      const luckRoll = d6();
      if (luckRoll >= 4) {
        state.stashFound = true;
        state.knownTreasure = true;
        const goldFound = 4 + d6() * 2;
        awardGoldAndXp(db, character, goldFound, 10);
        saveSceneState(db, campaignId, scene.id, state);
        saveCampaignState(db, campaignId, campaignState);
        return finalizeOutcome(db, campaignId, {
          content: `Your hand finds ${blueprint.stash.item}, along with ${goldFound} gp in mixed coin. A worthwhile stop.`,
          goldDelta: goldFound, xpDelta: 10, explorationTurnAdvanced: turn.turn,
        }, turn, campaignState, blueprint, action);
      }
    }
    saveCampaignState(db, campaignId, campaignState);
    return finalizeOutcome(db, campaignId, {
      content: state.scavengedParts
        ? `What you're reaching for isn't there anymore, or wasn't worth taking. The room has been worked.`
        : `You reach for it. What looked useful proves not to be — too heavy, already claimed, or not quite what it appeared.`,
      explorationTurnAdvanced: turn.turn,
    }, turn, campaignState, blueprint, action);
  }

  // ── OBJECT INTERACTION — "open X", "push X", "pull X", "touch X" ──────────
  if (/^(open the|open a|push the|push a|pull the|pull a|touch the|touch a|poke|prod|tap the|press the|turn the|try the|try a|operate|activate)\b/i.test(lowered)) {
    const turn = advanceExplorationTurn(db, campaignId, campaignState, inventory, character.id);
    if (/door|gate|hatch|portcullis|slab/i.test(lowered)) {
      if (!state.obstacleCleared) {
        const effort = d20() + Math.floor((character.str - 10) / 2) + Math.floor((character.level - 1) / 2);
        if (effort >= 13) {
          state.obstacleCleared = true;
          saveSceneState(db, campaignId, scene.id, state);
          saveCampaignState(db, campaignId, campaignState);
          return finalizeOutcome(db, campaignId, {
            content: `You try it and it opens — either unlocked or not as stuck as it looked. The space beyond it waits.`,
            xpDelta: 10, explorationTurnAdvanced: turn.turn,
          }, turn, campaignState, blueprint, action);
        }
        saveCampaignState(db, campaignId, campaignState);
        return finalizeOutcome(db, campaignId, {
          content: `You try. It doesn't move. The resistance is real — this will need force, a key, or patience.`,
          explorationTurnAdvanced: turn.turn,
        }, turn, campaignState, blueprint, action);
      }
      saveCampaignState(db, campaignId, campaignState);
      return finalizeOutcome(db, campaignId, { content: 'Already open.', explorationTurnAdvanced: turn.turn }, turn, campaignState, blueprint, action);
    }
    const interactRoll = d6();
    const responses = [
      `You interact with it carefully. It responds the way things down here do: ambiguously. ${blueprint.signpostDetail}`,
      `Nothing breaks, nothing triggers, nothing transforms. Whatever it was for, it keeps that to itself. ${blueprint.roomAmbience}`,
      `You touch it and the room registers that. Nothing dramatic, but something shifted slightly.`,
      `It moves, a little. The mechanism underneath is older than anything that should still work. Best leave it found the way you found it.`,
    ];
    saveCampaignState(db, campaignId, campaignState);
    return finalizeOutcome(db, campaignId, {
      content: responses[interactRoll % responses.length],
      explorationTurnAdvanced: turn.turn,
    }, turn, campaignState, blueprint, action);
  }

  // ── SOCIAL / NOISE — "call out", "shout", "yell", "knock" ────────────────
  if (/^(call out|call for|shout|yell|cry out|hail|whistle|speak up|make noise|bang on|bang the|knock on|knock the|knock)\b/i.test(lowered)) {
    const turn = advanceExplorationTurn(db, campaignId, campaignState, inventory, character.id);
    shiftFactionStanding(campaignState, blueprint.faction, { heat: 2 }, `${character.name} made noise in ${scene.name}.`);
    noteCampaignEvent(campaignState, `${character.name} made noise in ${scene.name}: ${action}`);
    campaignState.encounterPressure = Math.min(10, campaignState.encounterPressure + 1);
    saveCampaignState(db, campaignId, campaignState);
    const npcName = npcs[0]?.name;
    return finalizeOutcome(db, campaignId, {
      content: npcName
        ? `Your voice fills the space and ${npcName} reacts to it. Whatever else heard it is harder to measure, but the noise has carried.`
        : `Your voice goes out and the dungeon takes it in. Whatever listens down here now has a bearing on you. ${blueprint.pressure}`,
      explorationTurnAdvanced: turn.turn,
    }, turn, campaignState, blueprint, action, true);
  }

  // ── GENERAL ATTEMPT — "try to X", "attempt to X" ─────────────────────────
  if (/^(try to|attempt to)\b/i.test(lowered)) {
    const turn = advanceExplorationTurn(db, campaignId, campaignState, inventory, character.id);
    const effortRoll = d20() + Math.floor((character.level - 1) / 2);
    const succeeded = effortRoll >= 12;
    const responses = succeeded
      ? [
          `The attempt works, more or less. The room doesn't give ground easily, but the effort lands. ${blueprint.signpostDetail}`,
          `It takes longer than it should, but you manage it. Progress yields to persistence if not elegance.`,
          `Done. Not cleanly, but done. You are a step further forward.`,
        ]
      : [
          `The attempt falls short. Not by much, but by enough. The obstacle stays an obstacle.`,
          `You try, but the room holds. A different approach, or better luck, would help.`,
          `It resists. You're not outmatched, just not prepared for this particular problem.`,
        ];
    saveCampaignState(db, campaignId, campaignState);
    return finalizeOutcome(db, campaignId, {
      content: responses[effortRoll % responses.length],
      explorationTurnAdvanced: turn.turn,
    }, turn, campaignState, blueprint, action);
  }


  // -- SEARCH / TRAP CHECK — "search room", "look for traps", "check for traps"
  if (/^(search room|search the room|search carefully|look for traps|check for traps|check the floor|feel the walls|sweep the room for|scout for traps|hunt for traps)$/.test(lowered)) {
    const turn = advanceExplorationTurn(db, campaignId, campaignState, inventory, character.id);
    const searchScore = d20() + Math.floor((character.int - 10) / 2) + thiefBonus(character, 'find_traps') + companionMods.scoutBonus;
    const lines: string[] = [];

    if (!state.knownHazard && searchScore >= 10) {
      state.knownHazard = true;
      const hazardFind = blueprint.roomSpecificHazard || blueprint.trap.kind;
      lines.push(`Your search turns up something worth knowing: signs of ${hazardFind} here. Worth remembering before anyone commits weight to the wrong surface.`);
      saveSceneState(db, campaignId, scene.id, state);
    }

    if (!state.clueFound && searchScore >= 13) {
      state.clueFound = true;
      const roomFind = blueprint.roomSpecificFind || blueprint.clue;
      if (/ossuary|crypt|bone|tomb/.test(scene.name.toLowerCase())) {
        lines.push(`Bone dust coats a hidden niche low in the far wall — easy to miss. Inside: ${roomFind}`);
      } else if (/flood|water|cistern|well|sump/.test(scene.name.toLowerCase())) {
        lines.push(`Below the waterline, half-submerged, something catches your eye: ${roomFind}`);
      } else if (/guard|barracks|watch|post/.test(scene.name.toLowerCase())) {
        lines.push(`Behind the duty roster scratched into the wall, someone hid a note: ${roomFind}`);
      } else {
        lines.push(`Patient work pays off. ${roomFind}`);
      }
      saveSceneState(db, campaignId, scene.id, state);
    }

    if (!state.trapTriggered && !state.trapDisarmed && searchScore <= 7) {
      state.trapTriggered = true;
      state.knownHazard = true;
      const trap = triggerTrap(db, character, inventory, blueprint, campaignState, companionMods);
      lines.push(trap.content);
      saveSceneState(db, campaignId, scene.id, state);
      saveCampaignState(db, campaignId, campaignState);
      return withPulse({ ...trap, content: lines.join(' ') }, turn.pulse);
    }

    if (lines.length === 0) {
      lines.push(`You work the room with method — corners, seams, disturbed flagstones. ${blueprint.roomAmbience} Nothing new emerges, but you leave knowing what is not there.`);
    }

    saveSceneState(db, campaignId, scene.id, state);
    saveCampaignState(db, campaignId, campaignState);
    return finalizeOutcome(db, campaignId, { content: lines.join(' '), explorationTurnAdvanced: turn.turn }, turn, campaignState, blueprint, action);
  }

  // -- LISTEN AT DOOR / LISTEN CAREFULLY
  if (/^(listen carefully|listen at the door|listen at door|press.*ear.*door|press.*ear.*wall|hold.*breath.*listen|listen at)/.test(lowered)) {
    const turn = advanceExplorationTurn(db, campaignId, campaignState, inventory, character.id);
    const listenScore = d20() + Math.floor((character.wis - 10) / 2) + thiefBonus(character, 'detect_noise') + companionMods.watchBonus;
    state.listened = true;
    saveSceneState(db, campaignId, scene.id, state);

    let result: string;
    if (listenScore >= 18) {
      result = `Muffled voices — two, maybe three — on the other side. They are not moving. ${blueprint.pressure}`;
    } else if (listenScore >= 14) {
      result = `Something is moving beyond the door. Not fast, not slow. Pacing, or patrolling. ${blueprint.tracks}`;
    } else if (listenScore >= 10) {
      result = `Distant scraping, like stone on stone, then silence. Could be structural. Could not be. ${blueprint.roomAmbience}`;
    } else if (listenScore >= 6) {
      result = `Dripping water, the creak of the place settling. Nothing obviously alive, but nothing obviously safe.`;
    } else {
      result = `Nothing — or nothing you can separate from your own blood in your ears. The door keeps its secrets.`;
    }

    noteCampaignEvent(campaignState, `${character.name} listened at a threshold in ${scene.name}.`);
    saveCampaignState(db, campaignId, campaignState);
    return finalizeOutcome(db, campaignId, { content: result, explorationTurnAdvanced: turn.turn }, turn, campaignState, blueprint, action);
  }

  // -- STEAL / PICKPOCKET
  if (/^(steal|pickpocket|lift from|filch from|cut the purse|take from)\b/.test(lowered)) {
    const turn = advanceExplorationTurn(db, campaignId, campaignState, inventory, character.id);
    if (npcs.length === 0) {
      saveCampaignState(db, campaignId, campaignState);
      return finalizeOutcome(db, campaignId, {
        content: `Fingers ready, but there is no one here to steal from. The room holds no pockets.`,
        explorationTurnAdvanced: turn.turn,
      }, turn, campaignState, blueprint, action);
    }

    const target = npcs[0];
    const dexRoll = d20() + Math.floor((character.dex - 10) / 2) + thiefBonus(character, 'pick_pockets');
    const awareness = 10 + Math.floor(((target as any).level || 1) / 2);
    if (dexRoll >= awareness) {
      const goldLifted = 2 + d6() * 2;
      awardGoldAndXp(db, character, goldLifted, 10);
      noteCampaignEvent(campaignState, `${character.name} lightened ${target.name}'s purse in ${scene.name}.`);
      saveCampaignState(db, campaignId, campaignState);
      return finalizeOutcome(db, campaignId, {
        content: `${target.name} notices nothing. Your fingers return with ${goldLifted} gp in mixed coin — enough to matter, taken cleanly.`,
        goldDelta: goldLifted, xpDelta: 10, explorationTurnAdvanced: turn.turn,
      }, turn, campaignState, blueprint, action);
    }

    shiftFactionStanding(campaignState, blueprint.faction, { heat: 3, reputation: -1 }, `${character.name} was caught stealing from ${target.name}.`);
    campaignState.encounterPressure = Math.min(10, campaignState.encounterPressure + 2);
    saveCampaignState(db, campaignId, campaignState);
    return finalizeOutcome(db, campaignId, {
      content: `${target.name}'s hand closes around your wrist before you clear the purse. The moment turns cold fast. The room knows what just happened.`,
      explorationTurnAdvanced: turn.turn,
    }, turn, campaignState, blueprint, action, true);
  }

  // -- FORCE / TRY THE LOCK / OPEN (without tools)
  if (/^(force the lock|force lock|try the lock|try to open|try the door|try the gate|jimmy the lock|wrench the lock)$/.test(lowered)) {
    const turn = advanceExplorationTurn(db, campaignId, campaignState, inventory, character.id);
    if (state.lockOpened || state.obstacleCleared) {
      saveCampaignState(db, campaignId, campaignState);
      return finalizeOutcome(db, campaignId, { content: 'Already open — the mechanism was dealt with earlier.', explorationTurnAdvanced: turn.turn }, turn, campaignState, blueprint, action);
    }
    const hasTools = inventory.some((item) => item.item === 'Lockpick Set' && item.quantity > 0);
    if (hasTools) {
      saveCampaignState(db, campaignId, campaignState);
      return finalizeOutcome(db, campaignId, {
        content: `You have picks. Use them properly — say "pick lock" to work ${blueprint.lock.kind} with any skill.`,
        explorationTurnAdvanced: turn.turn,
      }, turn, campaignState, blueprint, action);
    }
    const forceRoll = d20() + Math.floor((character.str - 10) / 2);
    if (forceRoll >= 16) {
      state.lockOpened = true;
      shiftFactionStanding(campaignState, blueprint.faction, { heat: 1 });
      saveSceneState(db, campaignId, scene.id, state);
      saveCampaignState(db, campaignId, campaignState);
      return finalizeOutcome(db, campaignId, {
        content: `Brute persuasion works where finesse won't. ${blueprint.lock.kind} gives with a crack that echoes further than you'd like. The way is open.`,
        xpDelta: 10, explorationTurnAdvanced: turn.turn,
      }, turn, campaignState, blueprint, action, true);
    }
    const bruise = Math.max(1, roll(1, 3).total - 1);
    applyHp(db, character.id, character.hp - bruise);
    saveCampaignState(db, campaignId, campaignState);
    return finalizeOutcome(db, campaignId, {
      content: `${blueprint.lock.kind} holds. The mechanism clicked once, maybe twice, but it does not give. Your shoulder knows the cost.`,
      hpDelta: -bruise, explorationTurnAdvanced: turn.turn,
    }, turn, campaignState, blueprint, action);
  }

  // -- HIDE / PRESS INTO SHADOWS
  if (/^(hide|hide in shadows|press into shadows|slip into shadows|melt into the shadows|take cover|find cover|seek cover|crouch|duck behind)/.test(lowered)) {
    const turn = advanceExplorationTurn(db, campaignId, campaignState, inventory, character.id);
    const hideRoll = d20() + Math.floor((character.dex - 10) / 2) + thiefBonus(character, 'hide_in_shadows') + companionMods.scoutBonus;
    const lightPenalty = (campaignState.delve?.lightLevel === 'normal') ? -2 : 0;
    const adjusted = hideRoll + lightPenalty;
    const coverFeature = blueprint.roomSpecificFind ? blueprint.roomSpecificFind : blueprint.roomAmbience;

    if (adjusted >= 13) {
      campaignState.encounterPressure = Math.max(0, campaignState.encounterPressure - 1);
      saveCampaignState(db, campaignId, campaignState);
      return finalizeOutcome(db, campaignId, {
        content: `You find the angle the room offers and use it. ${coverFeature} — against that backdrop, you become background. Whatever comes through here next will look past you.`,
        explorationTurnAdvanced: turn.turn,
      }, turn, campaignState, blueprint, action);
    }

    saveCampaignState(db, campaignId, campaignState);
    return finalizeOutcome(db, campaignId, {
      content: `The shadows here are shallow. You find a workable spot, but it would not survive a deliberate search. ${blueprint.pressure}`,
      explorationTurnAdvanced: turn.turn,
    }, turn, campaignState, blueprint, action);
  }

  // -- CHECK BODY / LOOT THE BODY
  if (/^(check body|check the body|search the body|search corpse|search the corpse|loot the body|loot the corpse|strip the body|go through.*pockets|pat down)/.test(lowered)) {
    const turn = advanceExplorationTurn(db, campaignId, campaignState, inventory, character.id);
    if (state.scavengedParts) {
      saveCampaignState(db, campaignId, campaignState);
      return finalizeOutcome(db, campaignId, {
        content: `The body has been gone through. Whatever it carried is already in your kit or gone to someone who moved faster.`,
        explorationTurnAdvanced: turn.turn,
      }, turn, campaignState, blueprint, action);
    }

    const copperRoll = d6();
    const silverRoll = d6() <= 3 ? d6() : 0;
    const goldFound = Math.floor(copperRoll / 3) + Math.floor(silverRoll / 5);
    state.scavengedParts = true;
    if (goldFound > 0) {
      awardGoldAndXp(db, character, goldFound, 5);
      state.knownTreasure = true;
    }

    const bodyFinds = [
      `a worn knife, a couple of corroded copper pieces, and a folded scrap of something that might be a map`,
      `nothing of obvious value — but the boots are good quality if you can stomach wearing them`,
      `a handful of copper, a cracked lantern, and a ring with the crest filed off`,
      `odds and ends: chalk stub, a bent spike, and ${blueprint.stash.item}`,
    ];
    const findDesc = bodyFinds[Math.abs(hash(scene.id)) % bodyFinds.length];
    saveSceneState(db, campaignId, scene.id, state);
    noteCampaignEvent(campaignState, `${character.name} searched a body in ${scene.name}.`);
    saveCampaignState(db, campaignId, campaignState);
    return finalizeOutcome(db, campaignId, {
      content: `You work quickly and without sentiment. The body yields: ${findDesc}.${goldFound > 0 ? ` Net value: ${goldFound} gp.` : ' Nothing worth carrying, but nothing missed.'}`,
      goldDelta: goldFound > 0 ? goldFound : undefined,
      xpDelta: goldFound > 0 ? 5 : undefined,
      explorationTurnAdvanced: turn.turn,
    }, turn, campaignState, blueprint, action);
  }

  // -- PRAY / KNEEL / OFFER PRAYER
  if (/^(pray|kneel|kneel and pray|offer prayer|offer a prayer|say a prayer|bow.*head|give thanks|invoke.*gods|ask.*gods|petition.*gods)/.test(lowered)) {
    const turn = advanceExplorationTurn(db, campaignId, campaignState, inventory, character.id);
    const divineClass = /paladin|cleric|druid/.test(character.char_class);

    if (divineClass) {
      const omens = [
        `A faint warmth settles in the hollow of your chest — not heat, but the absence of cold. ${scene.name} doesn't feel friendlier, but it feels witnessed.`,
        `The air shifts slightly, as though something very far away exhaled. Your god offers no promises here, only presence.`,
        `Something in the room's ambient noise drops a half-tone. Brief, unmistakable. The divine is not absent from ${scene.name} — it is just choosing its moment.`,
        `The flame on your torch stabilises. Your god is listening. That will have to be enough.`,
      ];
      const omen = omens[Math.abs(hash(character.id + scene.id)) % omens.length];
      shiftFactionStanding(campaignState, 'watch', { reputation: 1 }, `${character.name} showed discipline in ${scene.name}.`);
      noteCampaignEvent(campaignState, `${character.name} prayed in ${scene.name} and received an omen.`);
      saveCampaignState(db, campaignId, campaignState);
      return finalizeOutcome(db, campaignId, { content: omen, explorationTurnAdvanced: turn.turn }, turn, campaignState, blueprint, action);
    }

    const silences = [
      `You kneel and speak the words. The room does not answer. The dungeon is not a place that rewards prayer, only preparation — but you feel marginally steadier for having said it.`,
      `Stone under your knees, dark above. Whatever you asked for disappears into the ambient indifference of ${scene.name}. Not all prayers are answered. Not all go unheard.`,
      `The rafters creak once, somewhere in the middle of your petition. It probably means nothing. Probably.`,
    ];
    const silence = silences[Math.abs(hash(character.id + scene.id)) % silences.length];
    saveCampaignState(db, campaignId, campaignState);
    return finalizeOutcome(db, campaignId, { content: silence, explorationTurnAdvanced: turn.turn }, turn, campaignState, blueprint, action);
  }

  return null;
}

export function describeFactionSummary(db: Database, campaignId: string): string[] {
  const state = getCampaignState(db, campaignId);
  return Object.values(state.factions).map((faction) => describeFactionResult(state, findFactionKey(state, faction.name)));
}

function advanceExplorationTurn(
  db: Database,
  campaignId: string,
  campaignState: CampaignSimulationState,
  inventory: InventoryItem[],
  characterId: string,
): { turn: number; dangerLevel: number; pulse?: string } {
  const campaign = get(db, 'SELECT exploration_turn, danger_level FROM campaigns WHERE id = ?', [campaignId]) as any;
  const turn = Number(campaign?.exploration_turn || 0) + 1;
  const dangerLevel = Number(campaign?.danger_level || 2);
  run(db, 'UPDATE campaigns SET exploration_turn = ? WHERE id = ?', [turn, campaignId]);

  if (turn % 2 === 0 && consumeItem(db, characterId, inventory, 'Torch', 1)) {
    campaignState.supply.torchesBurned += 1;
    noteCampaignEvent(campaignState, 'A torch burned down during exploration.');
  }
  if (turn % 6 === 0 && consumeItem(db, characterId, inventory, 'Ration', 1)) {
    campaignState.supply.rationsSpent += 1;
    noteCampaignEvent(campaignState, 'Supplies are being eaten away by the delve.');
  }

  const torchesOnHand = getItemQuantity(inventory, 'Torch');
  const rationsOnHand = getItemQuantity(inventory, 'Ration');
  if (torchesOnHand <= 1) {
    campaignState.encounterPressure = Math.min(10, campaignState.encounterPressure + 1);
    if (turn % 2 === 1) noteCampaignEvent(campaignState, 'Torchlight is running thin, and the party knows it.');
  }
  if (rationsOnHand === 0 && turn >= 4) {
    campaignState.encounterPressure = Math.min(10, campaignState.encounterPressure + 1);
    if (turn % 3 === 0) noteCampaignEvent(campaignState, 'The company is pushing on without proper rations.');
  }

  campaignState.encounterPressure = Math.min(10, campaignState.encounterPressure + 1);

  let pulse: string | undefined;
  if (turn % 3 === 0) {
    const rollResult = d6();
    if (rollResult <= Math.min(5, dangerLevel + Math.floor(campaignState.encounterPressure / 2))) {
      pulse = [
        'You hear movement in the deeper passages: whatever roams here is drawing nearer.',
        'A distant clang and answering hush suggest the dungeon has noticed your presence.',
        'The silence tightens. Somewhere beyond sight, something repositions itself.',
      ][turn % 3];
    }
  }

  return { turn, dangerLevel, pulse };
}

function triggerTrap(
  db: Database,
  character: CharacterRecord,
  inventory: InventoryItem[],
  blueprint: SceneBlueprint,
  campaignState: CampaignSimulationState,
  companionMods: ReturnType<typeof getCompanionPartyModifiers>,
): AdventureActionOutcome {
  const saveRoll = d20() + Math.floor((character.dex - 10) / 2);
  const half = saveRoll >= blueprint.trap.dc;
  const damage = rollDamage(blueprint.trap.damage);
  const cushionedDamage = Math.max(1, damage - Math.min(2, companionMods.frontlineGuard || 0));
  const finalDamage = half ? Math.max(1, Math.floor(cushionedDamage / 2)) : cushionedDamage;
  applyHp(db, character.id, character.hp - finalDamage);
  if (consumeItem(db, character.id, inventory, 'Bandage Roll', 1)) {
    campaignState.supply.bandagesUsed += 1;
  }
  shiftFactionStanding(campaignState, blueprint.faction, { heat: 2 });
  noteCampaignEvent(campaignState, `${character.name} triggered ${blueprint.trap.kind}.`);
  return {
    content: `Your probing search wakes ${blueprint.trap.kind}. ${companionMods.frontlineName ? `${companionMods.frontlineName} is far enough forward to bark a warning and spoil the worst of the setup. ` : ''}${character.name} ${half ? 'partly avoids the worst of it' : 'takes the full force'} and suffers ${finalDamage} damage.`,
    hpDelta: -finalDamage,
  };
}

function finalizeOutcome(
  db: Database,
  campaignId: string,
  base: AdventureActionOutcome,
  turn: { turn: number; dangerLevel: number; pulse?: string },
  campaignState: CampaignSimulationState,
  blueprint: SceneBlueprint,
  action: string,
  noisy = false,
): AdventureActionOutcome {
  let outcome = withPulse(base, turn.pulse);

  const canEncounter = turn.turn - campaignState.lastEncounterTurn >= 2;
  const heat = campaignState.factions[blueprint.faction]?.heat || 0;
  const factionReputation = campaignState.factions[blueprint.faction]?.reputation || 0;
  const factionObj = campaignState.factions[blueprint.faction];
  const escalation = getEscalationLevel(heat);
  const patrolMod = getPatrolModifier(escalation);
  const encounterChance = Math.min(5, 1 + Math.floor(campaignState.encounterPressure / 2) + patrolMod + (noisy ? 1 : 0) + (factionReputation <= -4 ? 1 : 0));
  if (canEncounter && d6() <= encounterChance) {
    const encounter = generateProceduralEncounter(blueprint, turn.turn, campaignState, action);
    if (!encounter) {
      saveCampaignState(db, campaignId, campaignState);
      return outcome;
    }
    campaignState.lastEncounterTurn = turn.turn;
    campaignState.encounterPressure = Math.max(1, campaignState.encounterPressure - 2);
    noteCampaignEvent(campaignState, `Hostile contact: ${encounter.description}`);
    saveCampaignState(db, campaignId, campaignState);
    outcome = {
      ...outcome,
      content: `${outcome.content} ${encounter.surprise}`,
      encounter,
    };
  } else {
    saveCampaignState(db, campaignId, campaignState);
  }

  return outcome;
}

function generateProceduralEncounter(
  blueprint: SceneBlueprint,
  turn: number,
  campaignState: CampaignSimulationState,
  action: string,
): AdventureActionOutcome['encounter'] {
  const pressure = campaignState.encounterPressure;
  const factionStanding = campaignState.factions[blueprint.faction];
  const heat = factionStanding?.heat || 0;
  const hostility = factionStanding?.reputation || 0;
  const baseLevel = 1 + Math.min(4, Math.floor((pressure + turn % 5) / 2));
  const faction = blueprint.faction;
  const themed: Record<string, ProceduralEnemy[]> = {
    vermin: [
      { name: 'Tunnel Rat Swarm', level: baseLevel, thac0: 20 - baseLevel, ac: 8, hp: 4 + baseLevel * 2, damage: '1d4', weaponSpeed: 4, size: 'S', faction },
      { name: 'Cave Lizard', level: baseLevel, thac0: 19 - baseLevel, ac: 7, hp: 6 + baseLevel * 2, damage: '1d6', weaponSpeed: 5, size: 'M', faction },
    ],
    cultists: [
      { name: 'Cloaked Acolyte', level: baseLevel, thac0: 20 - baseLevel, ac: 7, hp: 5 + baseLevel * 3, damage: '1d6', weaponSpeed: 5, faction },
      { name: 'Fanatic Guard', level: baseLevel + 1, thac0: 19 - baseLevel, ac: 6, hp: 8 + baseLevel * 3, damage: '1d8', weaponSpeed: 6, faction },
    ],
    'rival delvers': [
      { name: 'Treasure Hunter', level: baseLevel, thac0: 20 - baseLevel, ac: 6, hp: 7 + baseLevel * 3, damage: '1d6+1', weaponSpeed: 5, faction },
      { name: 'Crossbow Skirmisher', level: baseLevel, thac0: 20 - baseLevel, ac: 7, hp: 6 + baseLevel * 2, damage: '1d6', weaponSpeed: 7, faction },
    ],
    'restless dead': [
      { name: 'Restless Skeleton', level: baseLevel, thac0: 20 - baseLevel, ac: 7, hp: 5 + baseLevel * 2, damage: '1d6', weaponSpeed: 5, faction },
      { name: 'Barrow Wight', level: baseLevel + 1, thac0: 18 - baseLevel, ac: 5, hp: 10 + baseLevel * 3, damage: '1d8', weaponSpeed: 6, size: 'M', faction },
    ],
    'hungry scouts': [
      { name: 'Goblin Scout', level: baseLevel, thac0: 20 - baseLevel, ac: 7, hp: 5 + baseLevel * 2, damage: '1d6', weaponSpeed: 4, faction },
      { name: 'Wolf Handler', level: baseLevel + 1, thac0: 19 - baseLevel, ac: 6, hp: 8 + baseLevel * 2, damage: '1d8', weaponSpeed: 5, faction },
    ],
  };
  const roster = themed[blueprint.encounterTheme] || themed.vermin;
  const enemyCount = Math.min(4, 1 + Math.floor(pressure / 3) + (heat >= 6 ? 1 : 0));
  const levelShift = hostility <= -4 ? 1 : hostility >= 3 ? -1 : 0;
  const enemies = Array.from({ length: enemyCount }, (_, index) => {
    const template = roster[index % roster.length];
    return {
      ...template,
      level: Math.max(1, template.level + levelShift),
      thac0: Math.max(12, (template.thac0 || 20) - levelShift),
      hp: Math.max(3, (template.hp || 6) + (levelShift * 2) + (heat >= 6 ? 2 : 0)),
      name: enemyCount > 1 ? `${template.name} ${index + 1}` : template.name,
      faction,
    };
  });
  // Inject bounty hunter at manhunt tier
  const factionStandingObj = campaignState.factions[blueprint.faction];
  const escalation = getEscalationLevel(heat);
  if (escalation === 'manhunt' && factionStandingObj) {
    enemies.push(generateBountyHunter(factionStandingObj, baseLevel) as any);
  }

  const initiativeType = pressure >= 5 || heat >= 6 ? 'individual' : 'group';
  const surprise = describeSurpriseByEscalation(escalation, blueprint.faction);
  const ambushOpener = (willAmbush(factionStandingObj || { reputation: 0, heat: 0, name: '', notes: '' }))
    ? ' They came for you specifically.'
    : '';

  return {
    enemies,
    initiativeType,
    description: `${enemies.map((enemy) => enemy.name).join(', ')} emerge from the dark under the banner of ${faction}.${escalation !== 'quiet' ? ` ${describeSurpriseByEscalation(escalation, faction)}` : ''}${ambushOpener}`,
    surprise,
  };
}

function revealHiddenConnection(connections: any[]) {
  if (!connections.some((entry) => entry.hidden)) return connections;
  return connections.map((entry) => entry.hidden ? { ...entry, hidden: false } : entry);
}

function thiefBonus(character: CharacterRecord, skill: string): number {
  try {
    const parsed = character.thief_skills ? JSON.parse(character.thief_skills) : null;
    const value = parsed?.[skill];
    if (typeof value === 'number') return Math.floor(value / 20);
  } catch {}
  if (character.char_class === 'thief' || character.char_class === 'bard') {
    const table = THIEF_SKILLS_BASE[skill];
    if (table) return Math.floor((table[Math.min(20, character.level)] || 0) / 25);
  }
  return 0;
}

function getInventory(character: CharacterRecord): InventoryItem[] {
  try {
    const parsed = character.inventory ? JSON.parse(character.inventory) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveInventory(db: Database, characterId: string, inventory: InventoryItem[]) {
  run(db, 'UPDATE characters SET inventory = ? WHERE id = ?', [JSON.stringify(inventory), characterId]);
}

function consumeItem(db: Database, characterId: string, inventory: InventoryItem[], itemName: string, quantity: number): boolean {
  const item = inventory.find((entry) => entry.item === itemName);
  if (!item || item.quantity < quantity) return false;
  item.quantity -= quantity;
  if (item.quantity <= 0) {
    const idx = inventory.indexOf(item);
    if (idx >= 0) inventory.splice(idx, 1);
  }
  saveInventory(db, characterId, inventory);
  return true;
}

function getItemQuantity(inventory: InventoryItem[], itemName: string): number {
  return inventory
    .filter((item) => item.item === itemName)
    .reduce((total, item) => total + Number(item.quantity || 0), 0);
}

function decrementInventory(db: Database, characterId: string, inventory: InventoryItem[], itemName: string, quantity: number) {
  consumeItem(db, characterId, inventory, itemName, quantity);
}

function addInventoryItem(db: Database, characterId: string, inventory: InventoryItem[], newItem: InventoryItem) {
  const existing = inventory.find((entry) => entry.item === newItem.item && entry.equipped === newItem.equipped);
  if (existing) {
    existing.quantity += newItem.quantity;
  } else {
    inventory.push(newItem);
  }
  saveInventory(db, characterId, inventory);
}

function awardGoldAndXp(db: Database, character: CharacterRecord, goldDelta: number, xpDelta: number) {
  run(db, 'UPDATE characters SET gold = gold + ?, xp = xp + ? WHERE id = ?', [goldDelta, xpDelta, character.id]);
}

function awardXp(db: Database, character: CharacterRecord, xpDelta: number) {
  run(db, 'UPDATE characters SET xp = xp + ? WHERE id = ?', [xpDelta, character.id]);
}

function applyHp(db: Database, characterId: string, hp: number) {
  run(db, 'UPDATE characters SET hp = ? WHERE id = ?', [Math.max(0, hp), characterId]);
}

function rollDamage(notation: string): number {
  if (!notation.includes('d')) return Number(notation);
  const match = notation.match(/^(\d+)d(\d+)([+-]\d+)?$/);
  if (!match) return 0;
  const numDice = Number(match[1]);
  const sides = Number(match[2]);
  const modifier = Number(match[3] || 0);
  let total = modifier;
  for (let i = 0; i < numDice; i++) total += roll(1, sides).rolls[0] || 1;
  return total;
}

function normalizeState(state: Partial<SceneState>): SceneState {
  return {
    searched: Boolean(state.searched),
    listened: Boolean(state.listened),
    hiddenExitFound: Boolean(state.hiddenExitFound),
    stashFound: Boolean(state.stashFound),
    trapTriggered: Boolean(state.trapTriggered),
    clueFound: Boolean(state.clueFound),
    obstacleCleared: Boolean(state.obstacleCleared),
    tracksFound: Boolean(state.tracksFound),
    lockOpened: Boolean((state as any).lockOpened),
    trapDisarmed: Boolean((state as any).trapDisarmed),
    scavengedParts: Boolean((state as any).scavengedParts),
    secured: Boolean((state as any).secured),
    fallbackPoint: Boolean((state as any).fallbackPoint),
    safeCamp: Boolean((state as any).safeCamp),
    cleared: Boolean((state as any).cleared),
    knownHazard: Boolean((state as any).knownHazard),
    knownTreasure: Boolean((state as any).knownTreasure),
    restCount: Number(state.restCount || 0),
    loreFragmentsFound: Array.isArray((state as any).loreFragmentsFound)
      ? (state as any).loreFragmentsFound
      : [],
  };
}

function parseJson(raw: string) {
  try { return JSON.parse(raw); } catch { return {}; }
}

function withPulse(outcome: AdventureActionOutcome, pulse?: string): AdventureActionOutcome {
  if (!pulse) return outcome;
  return { ...outcome, content: `${outcome.content} ${pulse}` };
}

function describeFactionResult(state: CampaignSimulationState, factionKey: string): string {
  const faction = state.factions[factionKey];
  if (!faction) return '';
  if (faction.reputation >= 4) return `${faction.name} are starting to treat the party as allies.`;
  if (faction.reputation >= 1) return `${faction.name} have taken the party's measure and lean favorable.`;
  if (faction.reputation <= -4) return `${faction.name} now have every reason to move against the party.`;
  if (faction.reputation <= -1) return `${faction.name} are growing wary and resentful.`;
  return `${faction.name} remain watchful and undecided.`;
}

function findFactionKey(state: CampaignSimulationState, name: string): string {
  for (const [key, faction] of Object.entries(state.factions)) {
    if (faction.name === name) return key;
  }
  return name;
}

function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h >>> 0);
}
