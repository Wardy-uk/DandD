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
  // Only pull the 4 most-recently-visited scenes to keep the prompt short
  const scenes = all(db,
    'SELECT * FROM scenes WHERE campaign_id = ? ORDER BY visited DESC, name ASC LIMIT 4',
    [campaignId]) as any[];

  // Try AI generation with a short focused prompt
  let plan: GrowthPlan = {};
  try {
    const prompt = buildSlimGrowthPrompt({ campaign, scenes, assessment });
    const rawPlan = await aiDirector.enqueueAndWait({
      campaignId,
      type: 'world_gen',
      priority: 5,
      prompt,
      format: 'json',
    });
    plan = parseGrowthPlan(rawPlan);
  } catch (err) {
    console.warn('[Growth] AI generation threw — falling back to procedural expansion:', err instanceof Error ? err.message : err);
  }

  // If AI produced no scenes, fall back to procedural generation so the world always grows
  if (!plan.scenes || plan.scenes.length === 0) {
    console.log('[Growth] Using procedural fallback for scene expansion');
    plan = generateFallbackPlan(scenes, campaign);
  }

  const allScenes = all(db, 'SELECT * FROM scenes WHERE campaign_id = ?', [campaignId]) as any[];
  applyGrowthPlan(db, campaignId, allScenes, plan);

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

/** Slim prompt — short enough for llama3.1:8b on Pi 5 to answer within timeout */
function buildSlimGrowthPrompt(params: {
  campaign: any;
  scenes: any[];
  assessment: GrowthAssessment;
}): string {
  const sceneList = params.scenes
    .map((s) => `${s.id}|${s.name}|${s.brief || 'no brief'}`)
    .join('\n');
  return `AD&D 2e dungeon expansion. Add 2 new connected areas.
Campaign: ${params.campaign.name} (${params.campaign.setting || 'classic fantasy'})
Existing scenes (id|name|brief):
${sceneList}

Return JSON only, no commentary:
{"summary":"one sentence","scenes":[{"name":"Area Name","brief":"One sentence gameable description.","lightLevel":"dim","terrainType":"dungeon","attachToSceneId":"<id from above>","connectionDirectionFromParent":"north","connectionBackDirection":"south"}]}

Add exactly 2 scenes. Use real scene ids from the list above for attachToSceneId.`;
}

const FALLBACK_SCENE_NAMES = [
  'Collapsed Passage', 'Flooded Antechamber', 'Guard Post Remnants', 'Narrow Crawlspace',
  'Fungal Grotto', 'Bone Pit', 'Abandoned Barracks', 'Ritual Chamber', 'Sewer Junction',
  'Hidden Alcove', 'Fortified Chamber', 'Rope Bridge', 'Sentry Post', 'Refuse Pit',
  'Flooded Cistern', 'Armoury Remnants', 'Deep Warren', 'Salt Cave', 'Sunken Hall',
  'Crumbling Tower Base', 'Smuggler Nook', 'Shard Chamber', 'Charnel Pit', 'Forgotten Chapel',
];
const DIRECTIONS = ['north', 'south', 'east', 'west', 'down', 'up', 'forward', 'left', 'right'];
const BACK: Record<string, string> = {
  north: 'south', south: 'north', east: 'west', west: 'east',
  down: 'up', up: 'down', forward: 'back', left: 'right', right: 'left',
};

function generateFallbackPlan(scenes: any[], campaign: any): GrowthPlan {
  const visitedScenes = scenes.filter((s) => s.visited);
  const attachTo = visitedScenes[0] || scenes[0];
  if (!attachTo) return {};

  const usedNames = new Set(scenes.map((s: any) => s.name));
  const freshNames = FALLBACK_SCENE_NAMES.filter((n) => !usedNames.has(n));

  const newScenes: GrowthPlan['scenes'] = [];
  let parentId = attachTo.id;

  for (let i = 0; i < 3 && freshNames.length > i; i++) {
    // Find a direction not already taken from this parent
    const parentScene = scenes.find((s: any) => s.id === parentId) || attachTo;
    let usedDirs: Set<string>;
    try {
      usedDirs = new Set(
        (JSON.parse(parentScene.connections || '[]') as any[]).map((c) => String(c.direction).toLowerCase())
      );
    } catch { usedDirs = new Set(); }
    const dir = DIRECTIONS.find((d) => !usedDirs.has(d)) || DIRECTIONS[i % DIRECTIONS.length];

    const sceneId = freshNames[i];
    newScenes.push({
      name: sceneId,
      brief: 'A previously unexplored area awaiting the party.',
      lightLevel: 'dim',
      terrainType: 'dungeon',
      attachToSceneId: parentId,
      connectionDirectionFromParent: dir,
      connectionBackDirection: BACK[dir] || 'back',
    });

    // Chain the next scene off this one (we'll look it up by name after insert)
    parentId = parentId; // keep same parent for safety — chaining by name is fragile
  }

  return {
    summary: `Procedural expansion added ${newScenes.length} new area(s) to explore.`,
    scenes: newScenes,
  };
}

function parseGrowthPlan(raw: string): GrowthPlan {
  try {
    const cleaned = raw.replace(/```json|```/gi, '').trim();
    return JSON.parse(cleaned) as GrowthPlan;
  } catch {
    console.warn('[Growth] AI returned non-JSON response — skipping plan:', raw.slice(0, 80));
    return {};
  }
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
