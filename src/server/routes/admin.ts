/**
 * Admin routes — user management
 */

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import type { Database } from 'sql.js';
import { get, all, run } from '../db/helpers.js';
import { authMiddleware, requireAuth } from './auth.js';
import { assessCampaignReadiness, runNightlyGrowth as runContentGrowth } from '../ai/nightlyGrowth.js';
import { runNightlyGrowth as runWorldGrowth, getNightlyLog } from '../game/nightlyGrowth.js';
import { getAppSettings, updateAppSettings } from '../db/settings.js';
import { healthCheck, listModels } from '../ai/ollama.js';

function requireAdmin(req: any, res: any, next: any) {
  if (!req.player) {
    res.status(401).json({ ok: false, error: 'Authentication required' });
    return;
  }
  const player = get(req._db, 'SELECT role FROM players WHERE id = ?', [req.player.id]) as any;
  if (!player || player.role !== 'admin') {
    res.status(403).json({ ok: false, error: 'Admin access required' });
    return;
  }
  next();
}

export function createAdminRoutes(db: Database): Router {
  const router = Router();
  router.use(authMiddleware(db));
  // Attach db to req so requireAdmin can access it
  router.use((req: any, _res, next) => { req._db = db; next(); });

  // List all users
  router.get('/users', requireAuth, requireAdmin, (_req: any, res) => {
    const users = all(db,
      'SELECT id, username, display_name, role, created_at, last_seen FROM players ORDER BY created_at DESC');
    res.json({ ok: true, data: users });
  });

  router.get('/campaigns', requireAuth, requireAdmin, (_req: any, res) => {
    const campaigns = all(db, `
      SELECT
        c.*,
        (SELECT COUNT(*) FROM campaign_players WHERE campaign_id = c.id) as player_count,
        (SELECT COUNT(*) FROM characters WHERE campaign_id = c.id) as character_count,
        (SELECT COUNT(*) FROM scenes WHERE campaign_id = c.id) as scene_count,
        (SELECT COUNT(*) FROM npcs WHERE campaign_id = c.id AND alive = 1) as npc_count
      FROM campaigns c
      ORDER BY c.created_at DESC
    `);

    res.json({ ok: true, data: campaigns });
  });

  router.patch('/campaigns/:id', requireAuth, requireAdmin, (req: any, res) => {
    const campaign = get(db, 'SELECT * FROM campaigns WHERE id = ?', [req.params.id]) as any;
    if (!campaign) {
      res.status(404).json({ ok: false, error: 'Campaign not found' });
      return;
    }

    const {
      name,
      setting,
      status,
      aiGrowthEnabled,
      targetSceneBuffer,
      targetNpcBuffer,
    } = req.body;

    run(db, `
      UPDATE campaigns
      SET name = COALESCE(?, name),
          setting = COALESCE(?, setting),
          status = COALESCE(?, status),
          ai_growth_enabled = COALESCE(?, ai_growth_enabled),
          target_scene_buffer = COALESCE(?, target_scene_buffer),
          target_npc_buffer = COALESCE(?, target_npc_buffer)
      WHERE id = ?
    `, [
      typeof name === 'string' && name.trim() ? name.trim() : null,
      typeof setting === 'string' ? setting : null,
      ['active', 'paused', 'completed'].includes(status) ? status : null,
      typeof aiGrowthEnabled === 'boolean' ? (aiGrowthEnabled ? 1 : 0) : null,
      Number.isFinite(targetSceneBuffer) ? targetSceneBuffer : null,
      Number.isFinite(targetNpcBuffer) ? targetNpcBuffer : null,
      req.params.id,
    ]);

    res.json({ ok: true, data: { message: 'Campaign updated' } });
  });

  router.get('/settings', requireAuth, requireAdmin, async (_req: any, res) => {
    const settings = getAppSettings(db);
    const ollamaOk = await healthCheck();
    const models = ollamaOk ? await listModels() : [];

    res.json({
      ok: true,
      data: {
        settings,
        runtime: {
          ollamaReachable: ollamaOk,
          models,
          activeModel: process.env.OLLAMA_MODEL || 'qwen2.5:7b',
          fastModel: process.env.OLLAMA_FAST_MODEL || 'qwen2.5:3b',
          nightlyGrowthHourUtc: Number(process.env.NIGHTLY_GROWTH_HOUR_UTC || 3),
          runtimeMode: 'deterministic',
        },
      },
    });
  });

  router.patch('/settings', requireAuth, requireAdmin, (req: any, res) => {
    const next = updateAppSettings(db, {
      allowRegistration: typeof req.body.allowRegistration === 'boolean' ? req.body.allowRegistration : undefined,
      allowCampaignCreation: typeof req.body.allowCampaignCreation === 'boolean' ? req.body.allowCampaignCreation : undefined,
      defaultAiGrowthEnabled: typeof req.body.defaultAiGrowthEnabled === 'boolean' ? req.body.defaultAiGrowthEnabled : undefined,
      defaultTargetSceneBuffer: Number.isFinite(req.body.defaultTargetSceneBuffer) ? req.body.defaultTargetSceneBuffer : undefined,
      defaultTargetNpcBuffer: Number.isFinite(req.body.defaultTargetNpcBuffer) ? req.body.defaultTargetNpcBuffer : undefined,
    });

    res.json({ ok: true, data: next });
  });

  // Update user role
  router.patch('/users/:id/role', requireAuth, requireAdmin, (req: any, res) => {
    const { role } = req.body;
    if (!['player', 'admin'].includes(role)) {
      res.json({ ok: false, error: 'Invalid role. Use "player" or "admin".' });
      return;
    }

    const user = get(db, 'SELECT id, username FROM players WHERE id = ?', [req.params.id]) as any;
    if (!user) {
      res.json({ ok: false, error: 'User not found' });
      return;
    }

    run(db, 'UPDATE players SET role = ? WHERE id = ?', [role, req.params.id]);
    res.json({ ok: true, data: { id: user.id, username: user.username, role } });
  });

  // Update user display name
  router.patch('/users/:id', requireAuth, requireAdmin, (req: any, res) => {
    const { displayName } = req.body;
    if (!displayName) {
      res.json({ ok: false, error: 'displayName required' });
      return;
    }

    run(db, 'UPDATE players SET display_name = ? WHERE id = ?', [displayName, req.params.id]);
    res.json({ ok: true, data: { id: req.params.id, displayName } });
  });

  // Reset user password
  router.post('/users/:id/reset-password', requireAuth, requireAdmin, async (req: any, res) => {
    const { password } = req.body;
    if (!password || password.length < 4) {
      res.json({ ok: false, error: 'Password must be at least 4 characters' });
      return;
    }

    const hash = await bcrypt.hash(password, 10);
    run(db, 'UPDATE players SET password_hash = ? WHERE id = ?', [hash, req.params.id]);
    res.json({ ok: true, data: { message: 'Password reset' } });
  });

  // Delete user
  router.delete('/users/:id', requireAuth, requireAdmin, (req: any, res) => {
    // Prevent self-delete
    if (req.params.id === req.player.id) {
      res.json({ ok: false, error: 'Cannot delete yourself' });
      return;
    }

    run(db, 'DELETE FROM campaign_players WHERE player_id = ?', [req.params.id]);
    run(db, 'DELETE FROM characters WHERE player_id = ?', [req.params.id]);
    run(db, 'DELETE FROM players WHERE id = ?', [req.params.id]);
    res.json({ ok: true, data: { message: 'User deleted' } });
  });

  // Bootstrap: if no admins exist, promote the requesting user
  router.post('/bootstrap', requireAuth, (req: any, res) => {
    const adminCount = get(db, 'SELECT COUNT(*) as c FROM players WHERE role = "admin"') as any;
    if (adminCount && adminCount.c > 0) {
      res.json({ ok: false, error: 'Admin already exists' });
      return;
    }

    run(db, 'UPDATE players SET role = "admin" WHERE id = ?', [req.player.id]);
    res.json({ ok: true, data: { message: 'You are now admin. Log out and back in.' } });
  });

  router.get('/campaigns/:id/growth', requireAuth, requireAdmin, (req: any, res) => {
    const campaign = get(db, 'SELECT * FROM campaigns WHERE id = ?', [req.params.id]) as any;
    if (!campaign) {
      res.status(404).json({ ok: false, error: 'Campaign not found' });
      return;
    }

    res.json({
      ok: true,
      data: {
        campaign: {
          id: campaign.id,
          name: campaign.name,
          aiGrowthEnabled: Boolean(campaign.ai_growth_enabled),
          targetSceneBuffer: campaign.target_scene_buffer,
          targetNpcBuffer: campaign.target_npc_buffer,
          lastGrowthCheckAt: campaign.last_growth_check_at,
          lastGrowthBuildAt: campaign.last_growth_build_at,
        },
        assessment: assessCampaignReadiness(db, req.params.id),
      },
    });
  });

  // Existing: AI content buffer (scenes / NPCs / lore)
  router.post('/campaigns/:id/growth/run', requireAuth, requireAdmin, async (req: any, res) => {
    const campaign = get(db, 'SELECT * FROM campaigns WHERE id = ?', [req.params.id]) as any;
    if (!campaign) {
      res.status(404).json({ ok: false, error: 'Campaign not found' });
      return;
    }

    const result = await runContentGrowth(db, req.params.id);
    res.json({ ok: true, data: result });
  });

  // New: world simulation (factions / rivals / companions / events / rumours)
  router.post('/campaigns/:id/nightly/run', requireAuth, requireAdmin, async (req: any, res) => {
    const campaign = get(db, 'SELECT * FROM campaigns WHERE id = ?', [req.params.id]) as any;
    if (!campaign) {
      res.status(404).json({ ok: false, error: 'Campaign not found' });
      return;
    }

    const result = await runWorldGrowth(db, req.params.id);
    res.json({ ok: true, data: result });
  });

  // Get nightly world growth log for a campaign
  router.get('/campaigns/:id/nightly/log', requireAuth, requireAdmin, (req: any, res) => {
    const campaign = get(db, 'SELECT id FROM campaigns WHERE id = ?', [req.params.id]) as any;
    if (!campaign) {
      res.status(404).json({ ok: false, error: 'Campaign not found' });
      return;
    }

    const log = getNightlyLog(db, req.params.id);
    res.json({ ok: true, data: { campaignId: req.params.id, log } });
  });

  router.patch('/campaigns/:id/growth', requireAuth, requireAdmin, (req: any, res) => {
    const { aiGrowthEnabled, targetSceneBuffer, targetNpcBuffer } = req.body;
    const campaign = get(db, 'SELECT id FROM campaigns WHERE id = ?', [req.params.id]) as any;
    if (!campaign) {
      res.status(404).json({ ok: false, error: 'Campaign not found' });
      return;
    }

    run(db, `
      UPDATE campaigns
      SET ai_growth_enabled = COALESCE(?, ai_growth_enabled),
          target_scene_buffer = COALESCE(?, target_scene_buffer),
          target_npc_buffer = COALESCE(?, target_npc_buffer)
      WHERE id = ?
    `, [
      typeof aiGrowthEnabled === 'boolean' ? (aiGrowthEnabled ? 1 : 0) : null,
      Number.isFinite(targetSceneBuffer) ? targetSceneBuffer : null,
      Number.isFinite(targetNpcBuffer) ? targetNpcBuffer : null,
      req.params.id,
    ]);

    res.json({ ok: true, data: { message: 'Campaign growth settings updated' } });
  });

  return router;
}
