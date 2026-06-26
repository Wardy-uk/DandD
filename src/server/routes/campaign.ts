/**
 * Campaign routes — create, join, list, manage campaigns
 */

import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import type { Database } from 'sql.js';
import type { Server as SocketServer } from 'socket.io';
import { get, all, run } from '../db/helpers.js';
import { authMiddleware, requireAuth } from './auth.js';
import { getAppSettings } from '../db/settings.js';
import {
  CAMPAIGN_SETTING_OPTIONS,
  DEFAULT_CAMPAIGN_SETTING_ID,
  findCampaignSettingOption,
} from '../../shared/campaignSettings.js';
import {
  CAMPAIGN_START_MODES,
  DEFAULT_CAMPAIGN_START_MODE,
  isCampaignStartMode,
} from '../../shared/campaignModes.js';
import { buildCampaignMapIntel } from '../game/mapIntel.js';
import { getChronicle } from '../game/chronicle.js';
import { generate } from '../ai/ollama.js';
import { seedCampaignStarterPack } from '../game/starterPacks.js';

export function createCampaignRoutes(db: Database, io: SocketServer): Router {
  const router = Router();
  router.use(authMiddleware(db));

  // List campaigns for current player
  router.get('/', requireAuth, (req: any, res) => {
    const campaigns = all(db, `
      SELECT c.*, cp.is_owner,
        (SELECT COUNT(*) FROM characters WHERE campaign_id = c.id) as character_count,
        (SELECT COUNT(*) FROM campaign_players WHERE campaign_id = c.id) as player_count
      FROM campaigns c
      JOIN campaign_players cp ON cp.campaign_id = c.id
      WHERE cp.player_id = ?
      ORDER BY c.created_at DESC
    `, [req.player.id]);

    res.json({ ok: true, data: campaigns });
  });

  // Browse available campaigns (ones the player is NOT already in)
  router.get('/browse', requireAuth, (req: any, res) => {
    const campaigns = all(db, `
      SELECT c.id, c.name, c.setting, c.status, c.created_at,
        (SELECT COUNT(*) FROM campaign_players WHERE campaign_id = c.id) as player_count,
        (SELECT COUNT(*) FROM characters WHERE campaign_id = c.id) as character_count
      FROM campaigns c
      WHERE c.status = 'active'
        AND c.id NOT IN (SELECT campaign_id FROM campaign_players WHERE player_id = ?)
      ORDER BY c.created_at DESC
    `, [req.player.id]);

    res.json({ ok: true, data: campaigns });
  });

  router.get('/settings', requireAuth, (_req: any, res) => {
    res.json({
      ok: true,
      data: {
        options: CAMPAIGN_SETTING_OPTIONS,
        defaultSettingId: DEFAULT_CAMPAIGN_SETTING_ID,
        startModes: CAMPAIGN_START_MODES,
        defaultStartMode: DEFAULT_CAMPAIGN_START_MODE,
      },
    });
  });

  // Get single campaign with full state
  router.get('/:id', requireAuth, (req: any, res) => {
    const campaign = get(db, 'SELECT * FROM campaigns WHERE id = ?', [req.params.id]) as any;
    if (!campaign) {
      res.json({ ok: false, error: 'Campaign not found' });
      return;
    }

    // Check player is a member
    const membership = get(db,
      'SELECT * FROM campaign_players WHERE campaign_id = ? AND player_id = ?',
      [campaign.id, req.player.id]);
    if (!membership) {
      res.json({ ok: false, error: 'Not a member of this campaign' });
      return;
    }

    // Get characters, scenes, NPCs
    const characters = all(db, 'SELECT * FROM characters WHERE campaign_id = ?', [campaign.id]);
    const scenes = all(db, 'SELECT * FROM scenes WHERE campaign_id = ?', [campaign.id]);
    const npcs = all(db, 'SELECT * FROM npcs WHERE campaign_id = ? AND alive = 1', [campaign.id]);
    const players = all(db, `
      SELECT p.id, p.username, p.display_name, p.last_seen
      FROM players p
      JOIN campaign_players cp ON cp.player_id = p.id
      WHERE cp.campaign_id = ?
    `, [campaign.id]);

    // Parse JSON fields
    const parsedChars = (characters as any[]).map(c => ({
      ...c,
      multiClass: c.multi_class ? JSON.parse(c.multi_class) : null,
      weaponProfs: JSON.parse(c.weapon_profs || '[]'),
      nonweaponProfs: JSON.parse(c.nonweapon_profs || '[]'),
      spellSlots: c.spell_slots ? JSON.parse(c.spell_slots) : null,
      memorisedSpells: c.memorised_spells ? JSON.parse(c.memorised_spells) : null,
      spellbook: c.spellbook ? JSON.parse(c.spellbook) : null,
      priestSpheres: c.priest_spheres ? JSON.parse(c.priest_spheres) : null,
      thiefSkills: c.thief_skills ? JSON.parse(c.thief_skills) : null,
      inventory: JSON.parse(c.inventory || '[]'),
      conditions: JSON.parse(c.conditions || '[]'),
    }));

    res.json({
      ok: true,
      data: {
        campaign,
        characters: parsedChars,
        scenes: (scenes as any[]).map(s => ({ ...s, connections: JSON.parse(s.connections || '[]') })),
        npcs: (npcs as any[]).map(n => ({
          ...n,
          inventory: JSON.parse(n.inventory || '[]'),
          memory: JSON.parse(n.memory || '[]'),
        })),
        players,
      },
    });
  });

  router.get('/:id/map', requireAuth, (req: any, res) => {
    const campaign = get(db, 'SELECT id FROM campaigns WHERE id = ?', [req.params.id]) as any;
    if (!campaign) {
      res.json({ ok: false, error: 'Campaign not found' });
      return;
    }
    const membership = get(db,
      'SELECT * FROM campaign_players WHERE campaign_id = ? AND player_id = ?',
      [req.params.id, req.player.id]);
    if (!membership) {
      res.json({ ok: false, error: 'Not a member of this campaign' });
      return;
    }

    res.json({ ok: true, data: buildCampaignMapIntel(db, req.params.id) });
  });

  // Create campaign
  router.post('/', requireAuth, (req: any, res) => {
    const settings = getAppSettings(db);
    if (!settings.allowCampaignCreation) {
      res.json({ ok: false, error: 'Campaign creation is currently disabled by an administrator' });
      return;
    }

    const { name, settingId, startMode } = req.body;
    const selectedSetting = findCampaignSettingOption(settingId || DEFAULT_CAMPAIGN_SETTING_ID);
    if (!selectedSetting) {
      res.json({ ok: false, error: 'Please choose one of the available settings' });
      return;
    }
    const chosenStartMode = isCampaignStartMode(startMode) ? startMode : DEFAULT_CAMPAIGN_START_MODE;
    const campaignName = String(name || '').trim()
      || selectedSetting.suggestedNames[0]
      || `${selectedSetting.name} ${chosenStartMode === 'party' ? 'Company' : 'Expedition'}`;

    const id = uuid();
    const startSceneId = uuid();

    run(db,
      `INSERT INTO campaigns (
        id, name, setting, setting_id, current_scene_id, created_by,
        ai_growth_enabled, target_scene_buffer, target_npc_buffer, start_mode
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        campaignName,
        selectedSetting.name,
        selectedSetting.id,
        startSceneId,
        req.player.id,
        settings.defaultAiGrowthEnabled ? 1 : 0,
        settings.defaultTargetSceneBuffer,
        settings.defaultTargetNpcBuffer,
        chosenStartMode,
      ]);

    // Add creator as campaign member
    run(db,
      'INSERT INTO campaign_players (campaign_id, player_id, is_owner) VALUES (?, ?, 1)',
      [id, req.player.id]);

    // Create placeholder starting scene, then replace it with a setting-specific opening pack.
    run(db,
      'INSERT INTO scenes (id, campaign_id, name, brief) VALUES (?, ?, ?, ?)',
      [startSceneId, id, 'Starting Location', '']);

    try {
      seedCampaignStarterPack({
        db,
        campaignId: id,
        startSceneId,
        settingId: selectedSetting.id,
        campaignName,
      });
    } catch (err) {
      console.error('[Campaign] seedCampaignStarterPack failed:', err);
      // Campaign row exists but starter pack failed — still return ok so the
      // player can enter and play; the opening scenes/contracts will be absent
      // but the campaign is not broken.
    }

    res.json({ ok: true, data: { id, name: campaignName, setting: selectedSetting.name, settingId: selectedSetting.id, startMode: chosenStartMode } });
  });

  // Join campaign (by invite code / ID)
  router.post('/:id/join', requireAuth, (req: any, res) => {
    const campaignId = req.params.id;

    const campaign = get(db, 'SELECT * FROM campaigns WHERE id = ?', [campaignId]);
    if (!campaign) {
      res.json({ ok: false, error: 'Campaign not found' });
      return;
    }

    const existing = get(db,
      'SELECT * FROM campaign_players WHERE campaign_id = ? AND player_id = ?',
      [campaignId, req.player.id]);
    if (existing) {
      res.json({ ok: true, data: { message: 'Already a member' } });
      return;
    }

    run(db,
      'INSERT INTO campaign_players (campaign_id, player_id) VALUES (?, ?)',
      [campaignId, req.player.id]);

    res.json({ ok: true, data: { message: 'Joined campaign' } });
  });

  // Get campaign chronicle
  router.get('/:id/chronicle', requireAuth, (req: any, res) => {
    const campaign = get(db, 'SELECT id FROM campaigns WHERE id = ?', [req.params.id]) as any;
    if (!campaign) {
      res.json({ ok: false, error: 'Campaign not found' });
      return;
    }
    const membership = get(db,
      'SELECT * FROM campaign_players WHERE campaign_id = ? AND player_id = ?',
      [req.params.id, req.player.id]);
    if (!membership) {
      res.json({ ok: false, error: 'Not a member of this campaign' });
      return;
    }
    try {
      const chronicle = getChronicle(db, req.params.id);
      res.json({ ok: true, data: chronicle });
    } catch (err) {
      res.json({ ok: false, error: 'Failed to build chronicle' });
    }
  });

  // Generate AI session journal
  router.post('/:id/journal/generate', requireAuth, async (req: any, res) => {
    const campaign = get(db, 'SELECT * FROM campaigns WHERE id = ?', [req.params.id]) as any;
    if (!campaign) { res.json({ ok: false, error: 'Campaign not found' }); return; }
    const membership = get(db, 'SELECT * FROM campaign_players WHERE campaign_id = ? AND player_id = ?', [req.params.id, req.player.id]);
    if (!membership) { res.json({ ok: false, error: 'Not a member' }); return; }

    try {
      const logs = all(db,
        'SELECT type, actor, content FROM game_log WHERE campaign_id = ? AND type IN (\'scene_enter\',\'narration\',\'dm_response\',\'combat\',\'player_action\',\'level_up\') ORDER BY timestamp DESC LIMIT 80',
        [req.params.id]) as any[];
      if (logs.length < 5) { res.json({ ok: false, error: 'Not enough log entries yet' }); return; }

      const logText = logs.reverse().map((l: any) => {
        if (l.type === 'player_action') return `> ${l.actor}: ${l.content}`;
        if (l.type === 'scene_enter') return `[Entered: ${l.content.split('.')[0]}]`;
        if (l.type === 'level_up') return `[${l.content}]`;
        return l.content;
      }).join('\n').slice(0, 3500);

      const character = get(db, 'SELECT name, char_class, level FROM characters WHERE campaign_id = ? AND status != \'dead\' LIMIT 1', [req.params.id]) as any;
      const charNote = character ? `${character.name}, a level ${character.level} ${character.char_class}` : 'an adventurer';

      const journal = await generate({
        system: `You are writing an in-world journal entry for ${charNote} in an AD&D campaign. 3-4 paragraphs, first person past tense, as if written at day's end by candlelight.
Rules:
- Voice the character's perspective: what they feared, what surprised them, what cost them something
- Name specific moments: a room entered, an enemy faced, a companion's reaction, something found
- Include texture and atmosphere — this is a personal record, not a report
- End on a mood: cautious hope, grim resolve, or unease about what comes next
- Do not list statistics or mechanics`,
        prompt: `Recent session log:\n${logText}\n\nWrite the journal entry.`,
        maxTokens: 520,
        temperature: 0.88,
      });

      res.json({ ok: true, data: { journal, sessionNumber: logs.length } });
    } catch (err) {
      res.json({ ok: false, error: 'Journal generation failed' });
    }
  });

  // Get game log
  router.get('/:id/log', requireAuth, (req: any, res) => {
    const limit = Number(req.query.limit) || 100;
    const offset = Number(req.query.offset) || 0;

    const logs = all(db,
      'SELECT * FROM game_log WHERE campaign_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?',
      [req.params.id, limit, offset]);

    res.json({ ok: true, data: logs.reverse() });
  });

  // Delete campaign (owner only) — cascades all related data
  router.delete('/:id', requireAuth, (req: any, res) => {
    const campaignId = req.params.id;

    const membership = get(db,
      'SELECT * FROM campaign_players WHERE campaign_id = ? AND player_id = ? AND is_owner = 1',
      [campaignId, req.player.id]);
    if (!membership) {
      res.status(403).json({ ok: false, error: 'Only the campaign owner can delete it' });
      return;
    }

    // Delete combatants via encounter ids first
    const encounterIds = (all(db, 'SELECT id FROM encounters WHERE campaign_id = ?', [campaignId]) as any[]).map((e: any) => e.id);
    if (encounterIds.length > 0) {
      const placeholders = encounterIds.map(() => '?').join(',');
      run(db, `DELETE FROM combatants WHERE encounter_id IN (${placeholders})`, encounterIds);
    }

    const tables: Array<[string, string]> = [
      ['encounters', 'campaign_id'],
      ['game_log', 'campaign_id'],
      ['scene_state', 'campaign_id'],
      ['world_lore', 'campaign_id'],
      ['campaign_rumours', 'campaign_id'],
      ['chronicle', 'campaign_id'],
      ['rival_parties', 'campaign_id'],
      ['campaign_state', 'campaign_id'],
      ['ai_queue', 'campaign_id'],
      ['npcs', 'campaign_id'],
      ['characters', 'campaign_id'],
      ['scenes', 'campaign_id'],
      ['campaign_players', 'campaign_id'],
      ['campaigns', 'id'],
    ];

    for (const [table, col] of tables) {
      run(db, `DELETE FROM ${table} WHERE ${col} = ?`, [campaignId]);
    }

    res.json({ ok: true });
  });

  return router;
}
