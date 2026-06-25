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
import { buildCampaignMapIntel } from '../game/mapIntel.js';

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

    const { name, settingId } = req.body;
    if (!name) {
      res.json({ ok: false, error: 'Campaign name required' });
      return;
    }
    const selectedSetting = findCampaignSettingOption(settingId || DEFAULT_CAMPAIGN_SETTING_ID);
    if (!selectedSetting) {
      res.json({ ok: false, error: 'Please choose one of the available settings' });
      return;
    }

    const id = uuid();
    const startSceneId = uuid();

    run(db,
      `INSERT INTO campaigns (
        id, name, setting, current_scene_id, created_by,
        ai_growth_enabled, target_scene_buffer, target_npc_buffer
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        name,
        selectedSetting.name,
        startSceneId,
        req.player.id,
        settings.defaultAiGrowthEnabled ? 1 : 0,
        settings.defaultTargetSceneBuffer,
        settings.defaultTargetNpcBuffer,
      ]);

    // Add creator as campaign member
    run(db,
      'INSERT INTO campaign_players (campaign_id, player_id, is_owner) VALUES (?, ?, 1)',
      [id, req.player.id]);

    // Create starting scene
    run(db,
      'INSERT INTO scenes (id, campaign_id, name, brief) VALUES (?, ?, ?, ?)',
      [startSceneId, id, 'Starting Location', 'The adventure begins here. The DM will describe this location.']);

    res.json({ ok: true, data: { id, name, setting: selectedSetting.name, settingId: selectedSetting.id } });
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

  // Get game log
  router.get('/:id/log', requireAuth, (req: any, res) => {
    const limit = parseInt(req.query.limit as string) || 100;
    const offset = parseInt(req.query.offset as string) || 0;

    const logs = all(db,
      'SELECT * FROM game_log WHERE campaign_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?',
      [req.params.id, limit, offset]);

    res.json({ ok: true, data: logs.reverse() });
  });

  return router;
}
