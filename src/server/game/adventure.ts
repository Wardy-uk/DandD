import type { Database } from 'sql.js';
import { get, run } from '../db/helpers.js';
import { d6, d20, roll, roll2d6 } from '../engine/dice.js';
import { getCharismaReactionAdj, getReactionResult, getStrengthMods, THIEF_SKILLS_BASE } from '../engine/tables.js';
import { getCampaignState, noteCampaignEvent, saveCampaignState, shiftFactionStanding, type CampaignSimulationState } from './campaignState.js';
import { getCompanionPartyModifiers, updateCompanionRelationships } from './companions.js';

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
  'A faint metallic tang hangs in the air, as though old violence stained the stone.',
  'Every scrape seems to echo too far, suggesting the dungeon carries sound into unseen reaches.',
  'Dust lies thick enough to preserve old movement, but not so thick that you trust it.',
  'The place feels used in irregular bursts, not abandoned.',
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
  'small clawed tracks leading toward deeper dark',
  'hobnailed boot marks over older, softer footprints',
  'drag marks where something heavy was hauled recently',
  'the shuffle and scrape of nervous sentries changing post',
];
const obstacleTable = [
  'a swollen oak door that must be forced',
  'a jammed portcullis mechanism gritted with rust',
  'a fallen slab leaving only a narrow crawlspace to clear',
  'a chained iron-bound hatch with a stubborn locking bar',
];
const pressureTable = [
  'You get the sense that staying loud here will bring trouble.',
  'Whatever lives nearby is not far enough away to ignore repeated disturbances.',
  'This area feels close to a patrol route, even if the patrol is currently elsewhere.',
  'The longer you work here, the more likely you are to be noticed.',
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
  const seed = hash(scene.id);
  return {
    ambience: ambienceTable[seed % ambienceTable.length],
    clue: clueTable[(seed >> 2) % clueTable.length],
    stash: {
      item: stashItems[(seed >> 4) % stashItems.length],
      gold: 8 + (seed % 5) * 7,
      xp: 25 + (seed % 4) * 20,
    },
    trap: {
      kind: trapKinds[(seed >> 6) % trapKinds.length],
      damage: ['1d4', '1d6', '1d6+1', '2d4'][(seed >> 8) % 4],
      dc: 11 + (seed % 5),
    },
    tracks: tracksTable[(seed >> 12) % tracksTable.length],
    obstacle: obstacleTable[(seed >> 14) % obstacleTable.length],
    hiddenExitDirection: directions[(seed >> 16) % directions.length],
    hiddenExitDescription: 'revealed by a draft and a faint seam in the stonework',
    pressure: pressureTable[(seed >> 18) % pressureTable.length],
    lock: {
      kind: lockTable[(seed >> 20) % lockTable.length],
      dc: 12 + ((seed >> 22) % 5),
    },
    faction: factionKeys[(seed >> 24) % factionKeys.length],
    encounterTheme: encounterThemes[(seed >> 26) % encounterThemes.length],
    salvage: salvageTable[(seed >> 28) % salvageTable.length],
  };
}

export function describeSceneDepth(scene: SceneRecord): string {
  const blueprint = buildSceneBlueprint(scene);
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

    if (!state.trapTriggered && !state.trapDisarmed && searchScore <= 8) {
      state.trapTriggered = true;
      state.knownHazard = true;
      const trap = triggerTrap(db, character, inventory, blueprint, campaignState);
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
      content: `You draw the group into stillness and listen. After the room settles, you pick out ${detail}.`,
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
    const trap = triggerTrap(db, character, inventory, blueprint, campaignState);
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
      content: 'You mark this place in the party’s working memory as a fallback point: not safe exactly, but dependable enough to matter under pressure.',
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
        : `${character.name} takes a quiet moment to center the group. It is more discipline than miracle, but even that matters in a place like this.`,
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
        ? 'You manage a careful, controlled advance, shifting the party’s presence from obvious intrusion to measured threat.'
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
): AdventureActionOutcome {
  const saveRoll = d20() + Math.floor((character.dex - 10) / 2);
  const half = saveRoll >= blueprint.trap.dc;
  const damage = rollDamage(blueprint.trap.damage);
  const finalDamage = half ? Math.max(1, Math.floor(damage / 2)) : damage;
  applyHp(db, character.id, character.hp - finalDamage);
  if (consumeItem(db, character.id, inventory, 'Bandage Roll', 1)) {
    campaignState.supply.bandagesUsed += 1;
  }
  shiftFactionStanding(campaignState, blueprint.faction, { heat: 2 });
  noteCampaignEvent(campaignState, `${character.name} triggered ${blueprint.trap.kind}.`);
  return {
    content: `Your probing search wakes ${blueprint.trap.kind}. ${character.name} ${half ? 'partly avoids the worst of it' : 'takes the full force'} and suffers ${finalDamage} damage.`,
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
  const encounterChance = Math.min(5, 1 + Math.floor(campaignState.encounterPressure / 2) + Math.floor(heat / 3) + (noisy ? 1 : 0));
  if (canEncounter && d6() <= encounterChance) {
    const encounter = generateProceduralEncounter(blueprint, turn.turn, campaignState.encounterPressure, action);
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
  pressure: number,
  action: string,
): AdventureActionOutcome['encounter'] {
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
  const enemyCount = Math.min(3, 1 + Math.floor(pressure / 3));
  const enemies = Array.from({ length: enemyCount }, (_, index) => ({ ...roster[index % roster.length], name: enemyCount > 1 ? `${roster[index % roster.length].name} ${index + 1}` : roster[index % roster.length].name }));
  const initiativeType = pressure >= 5 ? 'individual' : 'group';
  const surprise = pressure >= 5 || /force|bash|shoot|charge/.test(action)
    ? 'The contact comes on hard and fast before the party can fully control the terms.'
    : 'You have just enough warning to realise this danger has been stalking the same dark as you.';

  return {
    enemies,
    initiativeType,
    description: `${enemies.map((enemy) => enemy.name).join(', ')} emerge from the dark under the banner of ${faction}.`,
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
