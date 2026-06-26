import { d6, d20 } from '../engine/dice.js';
import { describeSceneDepth } from './adventure.js';
import {
  detectRoomType,
  getDungeonTheme,
  getRoomOpener,
  getRoomAmbience,
} from './dungeonVariety.js';

interface SceneConnection {
  direction: string;
  targetSceneId: string;
  description?: string;
  locked?: boolean;
  hidden?: boolean;
}

interface SceneRecord {
  id: string;
  campaign_id?: string;
  name: string;
  brief?: string;
  ai_description?: string;
  light_level?: string;
  terrain_type?: string;
  connections?: string;
  visited?: number;
}

interface NpcRecord {
  id: string;
  name: string;
  personality?: string;
  appearance?: string;
  voice_notes?: string;
  disposition?: string;
  memory?: string;
}

interface CharacterRecord {
  id: string;
  name: string;
  level: number;
  race: string;
  char_class: string;
  dex?: number;
  int?: number;
  wis?: number;
}

export interface DeterministicActionResult {
  type: 'scene_enter' | 'narration';
  actor: string;
  content: string;
  scene?: SceneRecord & { connections: SceneConnection[] };
  updatedConnections?: SceneConnection[];
}

// Light phrases — short, present-tense, no passive voice
const lightText: Record<string, string> = {
  dark:   "Your torch is out. Shapes blur past arm's reach.",
  dim:    "Your torch reaches maybe ten feet. Beyond that, guess.",
  normal: 'The light holds. You can read the room.',
  bright: "Well-lit. Whatever's here, you'll see it.",
};

// Fallback terrain openers for non-dungeon terrain (cave, forest, town, ruins).
// Dungeon/indoor rooms use named room-type openers from dungeonVariety instead.
const terrainOpenersFallback: Record<string, string[]> = {
  cave: [
    'Natural rock, unworked. Water has been through here.',
    'The floor is uneven. Watch your footing.',
    'Mineral smell, damp. The walls glisten.',
    'This place predates anything human.',
  ],
  forest: [
    'Roots everywhere. The ground shifts underfoot.',
    "Trees close enough that you can't see far in any direction.",
    'Something moves in the canopy. Wind, probably.',
    'The light comes through in broken patches.',
  ],
  town: [
    "Signs of recent use — ash in a hearth, a mug still on the table.",
    'Built for people. Still feels that way.',
    'Narrow streets, close buildings. A dozen places to disappear.',
    'The kind of place that gets loud at night.',
  ],
  ruins: [
    'Half the ceiling is gone. Sky where stone should be.',
    "Whatever this was, it's been abandoned long enough to forget.",
    'Rubble. Old mortar. Plants reclaiming the floor.',
    'The walls still stand, barely.',
  ],
};

function parseConnections(scene: SceneRecord): SceneConnection[] {
  try {
    const parsed = JSON.parse(scene.connections || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function joinList(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

export function describeScene(params: {
  scene: SceneRecord;
  npcs: Array<Pick<NpcRecord, 'name' | 'personality'>>;
  party: Array<Pick<CharacterRecord, 'name' | 'level' | 'race' | 'char_class'>>;
}): string {
  const { scene, npcs } = params;
  const connections = parseConnections(scene).filter((c) => !c.hidden);

  if (scene.ai_description) {
    return scene.ai_description;
  }

  // Seed for picking variants without randomness (same scene = same description)
  const s = scene.id.split('').reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const terrainKey = scene.terrain_type || 'indoor';

  // Brief — skip placeholder text from campaign creation
  const rawBrief = scene.brief?.trim() ?? '';
  const isPlaceholder = !rawBrief
    || rawBrief.toLowerCase().includes('dm will describe')
    || rawBrief.toLowerCase().includes('adventure begins here');
  const briefSentence = isPlaceholder ? '' : rawBrief;

  // Exits — one blunt sentence
  let exitLine: string;
  if (connections.length === 0) {
    exitLine = 'No exits are obvious from here.';
  } else if (connections.length === 1) {
    exitLine = `One way out: ${connections[0].direction}.`;
  } else {
    exitLine = `You count ${connections.length} ways forward — ${connections.map((c) => c.direction).join(', ')}.`;
  }

  // NPCs — name them, don't catalogue them
  let npcLine = '';
  if (npcs.length === 1) {
    npcLine = `${npcs[0].name} is here.${npcs[0].personality ? ` ${npcs[0].personality.charAt(0).toUpperCase() + npcs[0].personality.slice(1)}.` : ''}`;
  } else if (npcs.length > 1) {
    npcLine = `${joinList(npcs.map((n) => n.name))} are here.`;
  }

  const light = lightText[scene.light_level || 'normal'] ?? 'The light is workable.';

  // Dungeon/indoor rooms get a named room-type opener + room ambience for distinct identity.
  // Other terrain types fall back to generic terrain openers + describeSceneDepth.
  if (terrainKey === 'indoor' || terrainKey === 'dungeon') {
    const roomType = detectRoomType(scene.name, scene.id);
    const dungeonTheme = getDungeonTheme(scene.campaign_id || scene.id);
    const opener = getRoomOpener(roomType, scene.id);
    const roomAmbienceStr = getRoomAmbience(roomType, dungeonTheme, scene.id);
    const parts = [opener, light, briefSentence, roomAmbienceStr, npcLine, exitLine].filter(Boolean);
    return parts.join(' ');
  }

  const fallbackOpeners = terrainOpenersFallback[terrainKey] ?? terrainOpenersFallback.cave;
  const opener = fallbackOpeners[s % fallbackOpeners.length];
  const depth = describeSceneDepth(scene);
  const parts = [opener, light, briefSentence, depth, npcLine, exitLine].filter(Boolean);
  return parts.join(' ');
}

export function findMovementTarget(action: string, scene: SceneRecord): SceneConnection | null {
  const trimmed = action.trim().toLowerCase();
  const connections = parseConnections(scene).filter((c) => !c.hidden);

  for (const connection of connections) {
    const direction = connection.direction.toLowerCase();
    const description = (connection.description || '').toLowerCase();
    const patterns = [
      `go ${direction}`,
      `i go ${direction}`,
      `head ${direction}`,
      `i head ${direction}`,
      `move ${direction}`,
      direction,
    ];

    if (patterns.includes(trimmed) || description && trimmed.includes(description)) {
      return connection;
    }
  }

  return null;
}

export function resolveExplorationAction(params: {
  action: string;
  scene: SceneRecord;
  character: CharacterRecord;
  npcs: NpcRecord[];
}): DeterministicActionResult {
  const action = params.action.trim();
  const lowered = action.toLowerCase();
  const visibleConnections = parseConnections(params.scene).filter((c) => !c.hidden);
  const hiddenConnections = parseConnections(params.scene).filter((c) => c.hidden);

  if (/(look|examine|survey)/.test(lowered)) {
    return {
      type: 'narration',
      actor: 'DM',
      content: describeScene({
        scene: params.scene,
        npcs: params.npcs,
        party: [params.character],
      }),
    };
  }

  if (/listen/.test(lowered)) {
    const cues = [];
    if (params.npcs.length > 0) cues.push(`the faint movement of ${params.npcs[0].name}`);
    if (visibleConnections.length > 0) cues.push(`a draft drifting from the way ${visibleConnections[0].direction}`);
    const detail = cues.length > 0 ? joinList(cues) : 'only your own careful breathing';

    return {
      type: 'narration',
      actor: 'DM',
      content: `You hold still and listen. After a tense pause, you catch ${detail}.`,
    };
  }

  if (/search.*trap|trap/.test(lowered)) {
    const roll = d20() + Math.floor(((params.character.int || 10) - 10) / 2);
    const success = roll >= 13;
    return {
      type: 'narration',
      actor: 'DM',
      content: success
        ? 'A careful inspection turns up no immediate trap mechanism, which is reassuring but never final.'
        : 'You spend a few tense moments checking for tampered stone and hidden catches, but find nothing certain.',
    };
  }

  if (/search.*hidden|hidden.*door|secret/.test(lowered)) {
    if (hiddenConnections.length === 0) {
      return {
        type: 'narration',
        actor: 'DM',
        content: 'You methodically sound the walls and probe the edges, but no secret way yields itself.',
      };
    }

    const searchRoll = d6();
    const success = searchRoll <= 2;
    if (!success) {
      return {
        type: 'narration',
        actor: 'DM',
        content: 'You search for concealed seams and hollow spaces, but the room keeps its secrets for now.',
      };
    }

    const revealed = hiddenConnections[0];
    const updatedConnections = parseConnections(params.scene).map((connection) =>
      connection.targetSceneId === revealed.targetSceneId && connection.direction === revealed.direction
        ? { ...connection, hidden: false }
        : connection);

    return {
      type: 'narration',
      actor: 'DM',
      updatedConnections,
      content: `Your search pays off: a concealed way ${revealed.direction} becomes apparent${revealed.description ? `, ${revealed.description}` : ''}.`,
    };
  }

  if (/rest|camp|wait/.test(lowered)) {
    return {
      type: 'narration',
      actor: 'DM',
      content: 'You slow the pace and take a cautious pause, using the moment to gather yourselves without fully dropping your guard.',
    };
  }

  if (/talk|hail|call out|speak/.test(lowered)) {
    const npc = params.npcs[0];
    return {
      type: 'narration',
      actor: 'DM',
      content: npc
        ? `${npc.name} looks your way, waiting to hear what you have to say.`
        : 'Your voice carries through the area, but no immediate answer comes back.',
    };
  }

  if (/attack|charge|strike/.test(lowered)) {
    return {
      type: 'narration',
      actor: 'DM',
      content: 'Violence seems imminent. If there is a clear foe here, start an encounter so the engine can resolve it cleanly.',
    };
  }

  return {
    type: 'narration',
    actor: 'DM',
    content: `You attempt to ${action.replace(/^i\s+/i, '')}. The world answers in practical terms rather than dramatic flourish: tell the table exactly what you are testing, examining, or using, and the engine can keep pushing forward.`,
  };
}

export function describeNpcResponse(params: {
  npc: NpcRecord;
  character: CharacterRecord;
  message: string;
  sceneName?: string;
}): string {
  const disposition = (params.npc.disposition || 'neutral').toLowerCase();
  const message = params.message.trim();
  const lowered = message.toLowerCase();
  const memory = safeArray(params.npc.memory);

  if (/name|who are you/.test(lowered)) {
    return `"I'm ${params.npc.name}," ${voiceCue(params.npc)} says${params.sceneName ? ` in ${params.sceneName}` : ''}.`;
  }

  if (/hello|greetings|hail/.test(lowered)) {
    return disposition.includes('hostile')
      ? `${params.npc.name} narrows their eyes. "Make your business plain, ${params.character.name}."`
      : `${params.npc.name} gives ${params.character.name} a measured nod. "Well met. Speak, then."`;
  }

  if (/rumou|heard|know|what happened|news/.test(lowered)) {
    const remembered = memory[0];
    return remembered
      ? `${params.npc.name} folds their arms. "${remembered}. That's what I have for you."`
      : `${params.npc.name} considers the question. "I know little for certain, but trouble rarely stays buried long around here."`;
  }

  if (/help|aid|assist/.test(lowered)) {
    if (disposition.includes('friendly') || disposition.includes('enthusiastic')) {
      return `${params.npc.name} nods. "If your cause is honest, I can offer what guidance I have."`;
    }
    return `${params.npc.name} shakes their head. "You'll need to earn that kind of help."`;
  }

  if (/bye|farewell|leave/.test(lowered)) {
    return `${params.npc.name} gives a curt parting gesture. "Go carefully."`;
  }

  return disposition.includes('hostile')
    ? `${params.npc.name} answers with clipped restraint. "Choose your next words carefully."`
    : `${params.npc.name} listens, then replies in an even tone. "I hear you. Say what matters most."`;
}

export function describeCombatNarration(actionDescription: string, sceneName?: string): string {
  const opener = sceneName ? `In ${sceneName},` : 'In the clash,';
  return `${opener} ${actionDescription.charAt(0).toLowerCase()}${actionDescription.slice(1)} The exchange is quick, brutal, and leaves no doubt about the danger of staying exposed.`;
}

function voiceCue(npc: NpcRecord): string {
  return npc.voice_notes ? ` ${npc.voice_notes}` : '';
}

function safeArray(raw?: string): string[] {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}
