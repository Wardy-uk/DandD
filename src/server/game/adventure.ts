import type { Database } from 'sql.js';
import { get, run } from '../db/helpers.js';
import { d6, d20, roll, roll2d6 } from '../engine/dice.js';
import { getCharismaReactionAdj, getReactionResult, getStrengthMods, THIEF_SKILLS_BASE } from '../engine/tables.js';

interface SceneRecord {
  id: string;
  campaign_id?: string;
  name: string;
  brief?: string;
  connections?: string;
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
}

interface NpcRecord {
  id: string;
  name: string;
  disposition?: string;
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
  restCount: number;
}

interface SceneBlueprint {
  ambience: string;
  clue: string;
  stash: { item: string; gold: number; xp: number };
  trap: { kind: string; damage: string; save: 'breath' | 'spell' | 'petrify'; dc: number };
  tracks: string;
  obstacle: string;
  hiddenExitDirection: string;
  hiddenExitDescription: string;
  pressure: string;
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

export function ensureSceneState(db: Database, campaignId: string, sceneId: string): SceneState {
  const existing = get(db, 'SELECT state_json FROM scene_state WHERE scene_id = ?', [sceneId]) as any;
  if (existing?.state_json) {
    return normalizeState(parseJson(existing.state_json));
  }

  const initial = normalizeState({});
  run(db,
    'INSERT OR REPLACE INTO scene_state (scene_id, campaign_id, state_json, updated_at) VALUES (?, ?, ?, datetime("now"))',
    [sceneId, campaignId, JSON.stringify(initial)]);
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
      save: (['breath', 'spell', 'petrify'] as const)[(seed >> 10) % 3],
      dc: 11 + (seed % 5),
    },
    tracks: tracksTable[(seed >> 12) % tracksTable.length],
    obstacle: obstacleTable[(seed >> 14) % obstacleTable.length],
    hiddenExitDirection: directions[(seed >> 16) % directions.length],
    hiddenExitDescription: 'revealed by a draft and a faint seam in the stonework',
    pressure: pressureTable[(seed >> 18) % pressureTable.length],
  };
}

export function describeSceneDepth(scene: SceneRecord): string {
  const blueprint = buildSceneBlueprint(scene);
  return `${blueprint.ambience} ${blueprint.pressure}`;
}

export function advanceExplorationTurn(db: Database, campaignId: string): { turn: number; dangerLevel: number; pulse?: string } {
  const campaign = get(db, 'SELECT exploration_turn, danger_level FROM campaigns WHERE id = ?', [campaignId]) as any;
  const turn = Number(campaign?.exploration_turn || 0) + 1;
  const dangerLevel = Number(campaign?.danger_level || 2);
  run(db, 'UPDATE campaigns SET exploration_turn = ? WHERE id = ?', [turn, campaignId]);

  let pulse: string | undefined;
  if (turn % 3 === 0) {
    const rollResult = d6();
    if (rollResult <= Math.min(5, dangerLevel + 1)) {
      pulse = [
        'You hear movement in the deeper passages: whatever roams here is drawing nearer.',
        'A distant clang and answering hush suggest the dungeon has noticed your presence.',
        'The silence tightens. Somewhere beyond sight, something repositions itself.',
      ][turn % 3];
    }
  }

  return { turn, dangerLevel, pulse };
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
  const { db, campaignId, scene, character, npcs, action } = params;
  const lowered = action.trim().toLowerCase();
  const state = ensureSceneState(db, campaignId, scene.id);
  const blueprint = buildSceneBlueprint(scene);

  if (/search(?!.*hidden)|inspect|examine room|check the room|scavenge/.test(lowered)) {
    const turn = advanceExplorationTurn(db, campaignId);
    const searchScore = d20() + Math.floor((character.int - 10) / 2) + thiefBonus(character, 'find_traps');
    const lines = [];

    if (!state.clueFound && searchScore >= 12) {
      state.clueFound = true;
      lines.push(`You uncover a useful read of the room: ${blueprint.clue}`);
    }

    if (!state.stashFound && searchScore >= 15) {
      state.stashFound = true;
      awardGoldAndXp(db, character, blueprint.stash.gold, blueprint.stash.xp);
      lines.push(`Your careful search reveals ${blueprint.stash.item}, along with ${blueprint.stash.gold} gp in salvageable value.`);
    }

    if (!state.trapTriggered && searchScore <= 8) {
      state.trapTriggered = true;
      const trap = triggerTrap(db, character, blueprint);
      lines.push(trap.content);
      saveSceneState(db, campaignId, scene.id, state);
      return withPulse({ content: lines.join(' '), hpDelta: trap.hpDelta, xpDelta: trap.xpDelta, goldDelta: trap.goldDelta }, turn.pulse);
    }

    if (lines.length === 0) {
      lines.push('You spend several focused minutes working the edges of the chamber, and while nothing immediately rewarding turns up, you leave with a clearer sense of its rhythms.');
    }

    saveSceneState(db, campaignId, scene.id, state);
    return withPulse({ content: lines.join(' '), explorationTurnAdvanced: turn.turn }, turn.pulse);
  }

  if (/listen|press.*ear|hold still/.test(lowered)) {
    const turn = advanceExplorationTurn(db, campaignId);
    state.listened = true;
    saveSceneState(db, campaignId, scene.id, state);
    const listenScore = d20() + Math.floor((character.wis - 10) / 2) + thiefBonus(character, 'detect_noise');
    const detail = listenScore >= 13 ? blueprint.tracks : blueprint.pressure;
    return withPulse({
      content: `You draw the group into stillness and listen. After the room settles, you pick out ${detail}.`,
      explorationTurnAdvanced: turn.turn,
    }, turn.pulse);
  }

  if (/search.*hidden|hidden.*door|secret/.test(lowered)) {
    const hasHiddenConnections = params.connections.some((entry: any) => entry.hidden);
    const turn = advanceExplorationTurn(db, campaignId);
    if (state.hiddenExitFound && hasHiddenConnections) {
      return withPulse({
        content: `The concealed way ${blueprint.hiddenExitDirection} is already exposed.`,
        explorationTurnAdvanced: turn.turn,
      }, turn.pulse);
    }

    const searchRoll = d6();
    const skillEdge = thiefBonus(character, 'find_traps') > 0 || character.dex >= 15 || character.wis >= 14;
    const success = searchRoll <= (skillEdge ? 3 : 2);
    if (!success) {
      return withPulse({
        content: 'You trace mortar lines and test the stonework, but the walls keep their secrets for now.',
        explorationTurnAdvanced: turn.turn,
      }, turn.pulse);
    }

    state.hiddenExitFound = true;
    if (!hasHiddenConnections) {
      state.clueFound = true;
      saveSceneState(db, campaignId, scene.id, state);
      awardXp(db, character, 15);
      return withPulse({
        content: `Your search uncovers no literal secret door, but it does expose a subtle truth about the area: ${blueprint.clue}`,
        xpDelta: 15,
        explorationTurnAdvanced: turn.turn,
      }, turn.pulse);
    }

    const updatedConnections = revealHiddenConnection(params.connections);
    saveSceneState(db, campaignId, scene.id, state);
    run(db, 'UPDATE scenes SET connections = ? WHERE id = ?', [JSON.stringify(updatedConnections), scene.id]);
    return withPulse({
      content: `Your patience pays off. A concealed route ${blueprint.hiddenExitDirection} reveals itself, ${blueprint.hiddenExitDescription}.`,
      sceneConnections: updatedConnections.filter((entry: any) => !entry.hidden),
      explorationTurnAdvanced: turn.turn,
    }, turn.pulse);
  }

  if (/force|bash|shoulder|open.*door|lift.*gate|clear.*slab/.test(lowered)) {
    const turn = advanceExplorationTurn(db, campaignId);
    if (state.obstacleCleared) {
      return withPulse({
        content: 'The way is already clear enough to pass.',
        explorationTurnAdvanced: turn.turn,
      }, turn.pulse);
    }

    const strMods = getStrengthMods(character.str, character.str_percentile);
    const effort = d20() + strMods.hitAdj + Math.floor((character.level - 1) / 2);
    if (effort >= 13) {
      state.obstacleCleared = true;
      saveSceneState(db, campaignId, scene.id, state);
      awardXp(db, character, 20);
      return withPulse({
        content: `With a committed effort, you overcome ${blueprint.obstacle}. The noise is terrible, but the path yields.`,
        xpDelta: 20,
        explorationTurnAdvanced: turn.turn,
      }, turn.pulse);
    }

    const bruise = Math.min(2, Math.max(1, roll(1, 3).total - 1));
    applyHp(db, character.id, character.hp - bruise);
    saveSceneState(db, campaignId, scene.id, state);
    return withPulse({
      content: `You throw your weight against ${blueprint.obstacle}, but it holds. The failed effort leaves you sore and noisy.`,
      hpDelta: -bruise,
      explorationTurnAdvanced: turn.turn,
    }, turn.pulse);
  }

  if (/rest|bind wounds|catch our breath|take a breather|camp/.test(lowered)) {
    const turn = advanceExplorationTurn(db, campaignId);
    const heal = state.restCount === 0 ? Math.min(character.max_hp - character.hp, 1 + Math.floor((character.level + 1) / 3)) : 0;
    state.restCount += 1;
    saveSceneState(db, campaignId, scene.id, state);

    if (heal > 0) {
      applyHp(db, character.id, character.hp + heal);
    }

    const riskRoll = d6();
    const danger = turn.dangerLevel + state.restCount;
    const riskText = riskRoll <= Math.min(5, danger)
      ? 'Your pause buys recovery, but it also gives nearby threats time to adjust around you.'
      : 'You manage a brief, disciplined pause without giving too much away.';
    return withPulse({
      content: `${heal > 0 ? `You patch wounds and recover ${heal} hit point${heal === 1 ? '' : 's'}. ` : ''}${riskText}`,
      hpDelta: heal,
      explorationTurnAdvanced: turn.turn,
    }, turn.pulse);
  }

  if ((/talk|parley|hail|negotiate/.test(lowered) || npcs.length > 0) && npcs.length > 0) {
    const turn = advanceExplorationTurn(db, campaignId);
    const reactionRoll = roll2d6().total + Math.max(-2, Math.min(2, Math.floor(getCharismaReactionAdj(character.cha) / 2)));
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
    return withPulse({
      content: `${responseMap[reaction]} (Reaction ${reactionRoll}: ${reaction}.)`,
      xpDelta: xp,
      explorationTurnAdvanced: turn.turn,
    }, turn.pulse);
  }

  if (/sneak|hide|creep|move silently/.test(lowered)) {
    const turn = advanceExplorationTurn(db, campaignId);
    const stealth = d20() + Math.floor((character.dex - 10) / 2) + thiefBonus(character, 'move_silently');
    const text = stealth >= 13
      ? 'You manage a careful, controlled advance, shifting the party’s presence from obvious intrusion to measured threat.'
      : 'You try to move like a rumor, but the place answers with enough scrape and clatter to remind you that stealth here is earned.';
    return withPulse({ content: text, explorationTurnAdvanced: turn.turn }, turn.pulse);
  }

  return null;
}

function triggerTrap(db: Database, character: CharacterRecord, blueprint: SceneBlueprint): AdventureActionOutcome {
  const saveRoll = d20() + Math.floor((character.dex - 10) / 2);
  const half = saveRoll >= blueprint.trap.dc;
  const damage = rollDamage(blueprint.trap.damage);
  const finalDamage = half ? Math.max(1, Math.floor(damage / 2)) : damage;
  applyHp(db, character.id, character.hp - finalDamage);

  return {
    content: `Your probing search wakes ${blueprint.trap.kind}. ${character.name} ${half ? 'partly avoids the worst of it' : 'takes the full force'} and suffers ${finalDamage} damage.`,
    hpDelta: -finalDamage,
  };
}

function revealHiddenConnection(connections: any[]) {
  if (!connections.some((entry) => entry.hidden)) {
    return connections;
  }

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
  return notation.includes('d') ? rollNotationLocal(notation) : Number(notation);
}

function rollNotationLocal(notation: string): number {
  const match = notation.match(/^(\d+)d(\d+)([+-]\d+)?$/);
  if (!match) return 0;
  const numDice = Number(match[1]);
  const sides = Number(match[2]);
  const modifier = Number(match[3] || 0);
  let total = modifier;
  for (let i = 0; i < numDice; i++) {
    total += rollDieFromSides(sides);
  }
  return total;
}

function rollDieFromSides(sides: number): number {
  return roll(1, sides).rolls[0] || 1;
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
    restCount: Number(state.restCount || 0),
  };
}

function parseJson(raw: string) {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function withPulse(outcome: AdventureActionOutcome, pulse?: string): AdventureActionOutcome {
  if (!pulse) return outcome;
  return {
    ...outcome,
    content: `${outcome.content} ${pulse}`,
  };
}

function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h >>> 0);
}
