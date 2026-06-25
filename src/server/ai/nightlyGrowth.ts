import { v4 as uuid } from 'uuid';
import type { Database } from 'sql.js';
import { get, all, run } from '../db/helpers.js';
import { aiDirector } from './director.js';

interface GrowthAssessment {
  campaignId: string;
  totalScenes: number;
  unexploredScenes: number;
  totalNpcs: number;
  loreEntries: number;
  targetSceneBuffer: number;
  targetNpcBuffer: number;
  needsGrowth: boolean;
  reasons: string[];
}

interface GrowthPlan {
  summary?: string;
  scenes?: Array<{
    name: string;
    brief: string;
    lightLevel?: string;
    terrainType?: string;
    attachToSceneId?: string;
    connectionDirectionFromParent?: string;
    connectionBackDirection?: string;
    description?: string;
    notes?: string;
  }>;
  npcs?: Array<{
    name: string;
    race?: string;
    charClass?: string;
    level?: number;
    personality?: string;
    appearance?: string;
    voiceNotes?: string;
    disposition?: string;
    locationSceneName?: string;
    locationSceneId?: string;
    memory?: string[];
  }>;
  lore?: Array<{
    category?: string;
    title: string;
    content: string;
  }>;
}

export function assessCampaignReadiness(db: Database, campaignId: string): GrowthAssessment {
  const campaign = get(db,
    'SELECT target_scene_buffer, target_npc_buffer FROM campaigns WHERE id = ?',
    [campaignId]) as any;
  const targetSceneBuffer = Number(campaign?.target_scene_buffer || 6);
  const targetNpcBuffer = Number(campaign?.target_npc_buffer || 4);

  const sceneStats = get(db, `
    SELECT
      COUNT(*) as totalScenes,
      SUM(CASE WHEN visited = 0 THEN 1 ELSE 0 END) as unexploredScenes
    FROM scenes
    WHERE campaign_id = ?
  `, [campaignId]) as any;
  const npcStats = get(db, 'SELECT COUNT(*) as totalNpcs FROM npcs WHERE campaign_id = ? AND alive = 1', [campaignId]) as any;
  const loreStats = get(db, 'SELECT COUNT(*) as loreEntries FROM world_lore WHERE campaign_id = ?', [campaignId]) as any;

  const unexploredScenes = Number(sceneStats?.unexploredScenes || 0);
  const totalScenes = Number(sceneStats?.totalScenes || 0);
  const totalNpcs = Number(npcStats?.totalNpcs || 0);
  const loreEntries = Number(loreStats?.loreEntries || 0);

  const reasons: string[] = [];
  if (unexploredScenes < targetSceneBuffer) {
    reasons.push(`Only ${unexploredScenes} unexplored scenes remain; target buffer is ${targetSceneBuffer}.`);
  }
  if (totalNpcs < targetNpcBuffer) {
    reasons.push(`Only ${totalNpcs} active NPCs exist; target buffer is ${targetNpcBuffer}.`);
  }
  if (loreEntries < Math.max(3, Math.floor(targetSceneBuffer / 2))) {
    reasons.push(`World lore is thin at ${loreEntries} entries.`);
  }
  if (totalScenes === 0) {
    reasons.push('The campaign has no authored scenes yet.');
  }

  return {
    campaignId,
    totalScenes,
    unexploredScenes,
    totalNpcs,
    loreEntries,
    targetSceneBuffer,
    targetNpcBuffer,
    needsGrowth: reasons.length > 0,
    reasons,
  };
}

export async function runNightlyGrowth(db: Database, campaignId: string): Promise<{
  assessment: GrowthAssessment;
  applied: boolean;
  summary: string;
}> {
  const assessment = assessCampaignReadiness(db, campaignId);
  run(db, 'UPDATE campaigns SET last_growth_check_at = datetime("now") WHERE id = ?', [campaignId]);

  if (!assessment.needsGrowth) {
    return {
      assessment,
      applied: false,
      summary: 'Campaign already has enough authored gameplay buffered for the next session.',
    };
  }

  const campaign = get(db, 'SELECT * FROM campaigns WHERE id = ?', [campaignId]) as any;
  const scenes = all(db, 'SELECT * FROM scenes WHERE campaign_id = ? ORDER BY visited ASC, name ASC LIMIT 12', [campaignId]) as any[];
  const npcs = all(db, 'SELECT * FROM npcs WHERE campaign_id = ? AND alive = 1 ORDER BY name ASC LIMIT 12', [campaignId]) as any[];
  const recentLogs = all(db,
    'SELECT actor, content FROM game_log WHERE campaign_id = ? ORDER BY timestamp DESC LIMIT 12',
    [campaignId]) as any[];
  const lore = all(db,
    'SELECT category, title, content FROM world_lore WHERE campaign_id = ? ORDER BY created_at DESC LIMIT 8',
    [campaignId]) as any[];

  const prompt = buildGrowthPrompt({
    campaign,
    assessment,
    scenes,
    npcs,
    recentLogs: recentLogs.reverse(),
    lore,
  });

  const rawPlan = await aiDirector.enqueueAndWait({
    campaignId,
    type: 'world_gen',
    priority: 5,
    prompt,
    format: 'json',
  });
  const plan = parseGrowthPlan(rawPlan);
  applyGrowthPlan(db, campaignId, scenes, plan);

  run(db, 'UPDATE campaigns SET last_growth_build_at = datetime("now") WHERE id = ?', [campaignId]);
  run(db,
    'INSERT INTO game_log (id, campaign_id, type, actor, content) VALUES (?, ?, ?, ?, ?)',
    [uuid(), campaignId, 'system', 'Nightly Builder', plan.summary || 'Expanded campaign content for the next session.']);

  return {
    assessment,
    applied: true,
    summary: plan.summary || 'Nightly growth added new scenes, NPCs, or lore.',
  };
}

function buildGrowthPrompt(params: {
  campaign: any;
  assessment: GrowthAssessment;
  scenes: any[];
  npcs: any[];
  recentLogs: any[];
  lore: any[];
}): string {
  return `You are building offline campaign content for an AD&D 2e game.
The live session is deterministic and code-driven. Your job is to expand the world between sessions, not to run the table.

CAMPAIGN
Name: ${params.campaign.name}
Setting: ${params.campaign.setting || 'Classic fantasy'}
Current session: ${params.campaign.session_number || 1}

READINESS GAP
${params.assessment.reasons.join('\n')}

EXISTING SCENES
${params.scenes.map((scene) => `- ${scene.id}: ${scene.name} | ${scene.brief || 'No brief'} | visited=${scene.visited}`).join('\n')}

EXISTING NPCS
${params.npcs.map((npc) => `- ${npc.name} (${npc.disposition || 'neutral'}) in ${npc.location_scene_id || 'unknown scene'}`).join('\n')}

RECENT PLAY
${params.recentLogs.map((log) => `- ${log.actor}: ${log.content}`).join('\n')}

LORE
${params.lore.map((entry) => `- [${entry.category}] ${entry.title}: ${entry.content}`).join('\n')}

Return strict JSON with this shape:
{
  "summary": "one sentence",
  "scenes": [
    {
      "name": "new scene name",
      "brief": "short actionable description for deterministic play",
      "lightLevel": "dark|dim|normal|bright",
      "terrainType": "indoor|dungeon|cave|forest|town|ruins",
      "attachToSceneId": "existing parent scene id",
      "connectionDirectionFromParent": "north/east/etc",
      "connectionBackDirection": "south/west/etc",
      "description": "optional richer prewritten text",
      "notes": "practical gameplay note"
    }
  ],
  "npcs": [
    {
      "name": "npc name",
      "race": "human",
      "charClass": "fighter",
      "level": 1,
      "personality": "brief traits",
      "appearance": "brief appearance",
      "voiceNotes": "speech style",
      "disposition": "friendly|neutral|unfriendly|hostile|enthusiastic",
      "locationSceneName": "must match a new or existing scene name",
      "memory": ["one fact", "one concern"]
    }
  ],
  "lore": [
    {
      "category": "rumour|history|faction|quest",
      "title": "short title",
      "content": "1-3 sentences"
    }
  ]
}

Keep additions grounded, gameable, and immediately useful next session.`;
}

function parseGrowthPlan(raw: string): GrowthPlan {
  const cleaned = raw.replace(/```json|```/gi, '').trim();
  const parsed = JSON.parse(cleaned) as GrowthPlan;
  return parsed;
}

function applyGrowthPlan(db: Database, campaignId: string, existingScenes: any[], plan: GrowthPlan) {
  const sceneIdsByName = new Map<string, string>(
    existingScenes.map((scene) => [String(scene.name).toLowerCase(), scene.id]),
  );

  for (const scene of plan.scenes || []) {
    const sceneId = uuid();
    const parentId = scene.attachToSceneId || existingScenes[0]?.id || null;
    run(db, `
      INSERT INTO scenes (id, campaign_id, name, brief, ai_description, light_level, terrain_type, connections, visited, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `, [
      sceneId,
      campaignId,
      scene.name,
      scene.brief,
      scene.description || '',
      scene.lightLevel || 'normal',
      scene.terrainType || 'indoor',
      '[]',
      scene.notes || '',
    ]);
    sceneIdsByName.set(scene.name.toLowerCase(), sceneId);

    if (parentId) {
      connectScenes(db, parentId, sceneId, scene.connectionDirectionFromParent || 'forward', scene.connectionBackDirection || 'back');
    }
  }

  for (const npc of plan.npcs || []) {
    const sceneId = npc.locationSceneId
      || sceneIdsByName.get((npc.locationSceneName || '').toLowerCase())
      || existingScenes[0]?.id
      || null;
    run(db, `
      INSERT INTO npcs (id, campaign_id, name, race, char_class, level, personality, appearance, voice_notes, disposition, location_scene_id, stats, inventory, memory, alive)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `, [
      uuid(),
      campaignId,
      npc.name,
      npc.race || 'human',
      npc.charClass || '',
      npc.level || 1,
      npc.personality || '',
      npc.appearance || '',
      npc.voiceNotes || '',
      npc.disposition || 'neutral',
      sceneId,
      '{}',
      '[]',
      JSON.stringify(npc.memory || []),
    ]);
  }

  for (const lore of plan.lore || []) {
    run(db,
      'INSERT INTO world_lore (id, campaign_id, category, title, content) VALUES (?, ?, ?, ?, ?)',
      [uuid(), campaignId, lore.category || 'general', lore.title, lore.content]);
  }
}

function connectScenes(db: Database, fromSceneId: string, toSceneId: string, forward: string, back: string) {
  appendConnection(db, fromSceneId, {
    direction: forward,
    targetSceneId: toSceneId,
    description: '',
    locked: false,
    hidden: false,
  });
  appendConnection(db, toSceneId, {
    direction: back,
    targetSceneId: fromSceneId,
    description: '',
    locked: false,
    hidden: false,
  });
}

function appendConnection(db: Database, sceneId: string, connection: {
  direction: string;
  targetSceneId: string;
  description: string;
  locked: boolean;
  hidden: boolean;
}) {
  const scene = get(db, 'SELECT connections FROM scenes WHERE id = ?', [sceneId]) as any;
  const existing = safeJsonArray(scene?.connections);
  const alreadyExists = existing.some((entry: any) =>
    entry.targetSceneId === connection.targetSceneId && String(entry.direction).toLowerCase() === connection.direction.toLowerCase());
  if (alreadyExists) return;

  existing.push(connection);
  run(db, 'UPDATE scenes SET connections = ? WHERE id = ?', [JSON.stringify(existing), sceneId]);
}

function safeJsonArray(raw: string | null | undefined): any[] {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
