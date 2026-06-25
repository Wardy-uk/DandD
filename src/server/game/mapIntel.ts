import type { Database } from 'sql.js';
import { all, get } from '../db/helpers.js';
import { buildSceneBlueprint } from './adventure.js';
import { describeBattlefield } from './encounters.js';

interface RawScene {
  id: string;
  name: string;
  brief?: string;
  light_level?: string;
  terrain_type?: string;
  connections?: string;
  visited?: number;
}

interface RawSceneState {
  scene_id: string;
  state_json?: string;
}

interface MapNode {
  id: string;
  name: string;
  discovered: boolean;
  current: boolean;
  depth: number;
  lane: number;
  terrainType?: string;
  lightLevel?: string;
  battlefield?: ReturnType<typeof describeBattlefield>;
  faction?: string;
  encounterTheme?: string;
  roomState?: {
    hiddenExitFound: boolean;
    trapTriggered: boolean;
    trapDisarmed: boolean;
    obstacleCleared: boolean;
    lockOpened: boolean;
    stashFound: boolean;
    secured: boolean;
    fallbackPoint: boolean;
    safeCamp: boolean;
    cleared: boolean;
    knownHazard: boolean;
    knownTreasure: boolean;
  };
}

interface MapEdge {
  from: string;
  to: string;
  direction: string;
  locked: boolean;
}

export function buildCampaignMapIntel(db: Database, campaignId: string) {
  const campaign = get(db, 'SELECT current_scene_id FROM campaigns WHERE id = ?', [campaignId]) as any;
  const currentSceneId = String(campaign?.current_scene_id || '');
  const scenes = all(db, 'SELECT * FROM scenes WHERE campaign_id = ?', [campaignId]) as RawScene[];
  const sceneStates = all(db, 'SELECT scene_id, state_json FROM scene_state WHERE campaign_id = ?', [campaignId]) as RawSceneState[];
  const stateByScene = new Map(sceneStates.map((row) => [row.scene_id, safeJson(row.state_json)]));
  const sceneById = new Map(scenes.map((scene) => [scene.id, scene]));

  const nodes = new Map<string, Omit<MapNode, 'depth' | 'lane'>>();
  const edges: MapEdge[] = [];

  for (const scene of scenes) {
    const visited = Boolean(scene.visited) || scene.id === currentSceneId;
    if (!visited) continue;
    const blueprint = buildSceneBlueprint(scene);
    nodes.set(scene.id, {
      id: scene.id,
      name: scene.name,
      discovered: true,
      current: scene.id === currentSceneId,
      terrainType: scene.terrain_type || 'indoor',
      lightLevel: scene.light_level || 'normal',
      battlefield: describeBattlefield(scene),
      faction: blueprint.faction,
      encounterTheme: blueprint.encounterTheme,
      roomState: normalizeRoomState(stateByScene.get(scene.id)),
    });

    for (const connection of parseConnections(scene).filter((entry) => !entry.hidden)) {
      const target = sceneById.get(connection.targetSceneId);
      if (!target) continue;
      const targetVisited = Boolean(target.visited) || target.id === currentSceneId;
      if (!nodes.has(target.id)) {
        nodes.set(target.id, targetVisited ? {
          id: target.id,
          name: target.name,
          discovered: true,
          current: target.id === currentSceneId,
          terrainType: target.terrain_type || 'indoor',
          lightLevel: target.light_level || 'normal',
          battlefield: describeBattlefield(target),
          faction: buildSceneBlueprint(target).faction,
          encounterTheme: buildSceneBlueprint(target).encounterTheme,
          roomState: normalizeRoomState(stateByScene.get(target.id)),
        } : {
          id: target.id,
          name: 'Unexplored',
          discovered: false,
          current: false,
        });
      }

      edges.push({
        from: scene.id,
        to: target.id,
        direction: connection.direction,
        locked: Boolean(connection.locked),
      });
    }
  }

  const laidOutNodes = layoutNodes(Array.from(nodes.values()), edges, currentSceneId);
  return {
    currentSceneId,
    nodes: laidOutNodes,
    edges,
  };
}

function layoutNodes(nodes: Omit<MapNode, 'depth' | 'lane'>[], edges: MapEdge[], currentSceneId: string): MapNode[] {
  const start = currentSceneId || nodes.find((node) => node.discovered)?.id || nodes[0]?.id || '';
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    if (!adjacency.has(edge.to)) adjacency.set(edge.to, []);
    adjacency.get(edge.from)!.push(edge.to);
    adjacency.get(edge.to)!.push(edge.from);
  }

  const depthById = new Map<string, number>();
  if (start) {
    const queue = [start];
    depthById.set(start, 0);
    while (queue.length > 0) {
      const current = queue.shift()!;
      const nextDepth = (depthById.get(current) || 0) + 1;
      for (const next of adjacency.get(current) || []) {
        if (!depthById.has(next)) {
          depthById.set(next, nextDepth);
          queue.push(next);
        }
      }
    }
  }

  let fallbackDepth = Math.max(0, ...Array.from(depthById.values()));
  const laneCounts = new Map<number, number>();
  return nodes
    .sort((a, b) => {
      const depthA = depthById.get(a.id) ?? 999;
      const depthB = depthById.get(b.id) ?? 999;
      return depthA - depthB || a.name.localeCompare(b.name);
    })
    .map((node) => {
      const depth = depthById.has(node.id) ? depthById.get(node.id)! : ++fallbackDepth;
      const lane = laneCounts.get(depth) || 0;
      laneCounts.set(depth, lane + 1);
      return { ...node, depth, lane };
    });
}

function parseConnections(scene: RawScene) {
  try {
    const parsed = JSON.parse(scene.connections || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeJson(raw?: string) {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

function normalizeRoomState(raw: any) {
  return {
    hiddenExitFound: Boolean(raw?.hiddenExitFound),
    trapTriggered: Boolean(raw?.trapTriggered),
    trapDisarmed: Boolean(raw?.trapDisarmed),
    obstacleCleared: Boolean(raw?.obstacleCleared),
    lockOpened: Boolean(raw?.lockOpened),
    stashFound: Boolean(raw?.stashFound),
    secured: Boolean(raw?.secured),
    fallbackPoint: Boolean(raw?.fallbackPoint),
    safeCamp: Boolean(raw?.safeCamp),
    cleared: Boolean(raw?.cleared),
    knownHazard: Boolean(raw?.knownHazard),
    knownTreasure: Boolean(raw?.knownTreasure),
  };
}
