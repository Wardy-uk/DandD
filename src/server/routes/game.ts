/**
 * Game routes — the main gameplay loop
 * Handles actions, combat, scene transitions, exploration
 */

import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import type { Database } from 'sql.js';
import type { Server as SocketServer } from 'socket.io';
import { get, all, run } from '../db/helpers.js';
import { authMiddleware, requireAuth } from './auth.js';
import {
  resolveAttack, resolveMissileAttack,
  makeSavingThrow, checkMorale, turnUndead,
  type Combatant,
} from '../engine/combat.js';
import { roll, rollNotation, d20, d100, roll2d6 } from '../engine/dice.js';
import type { SavingThrows } from '../engine/tables.js';
import { describeScene, describeNpcResponse, describeCombatNarration } from '../game/deterministic.js';
import { createEncounterRecord, emitEncounterStart, resolveEncounterAction } from '../game/encounters.js';

export function createGameRoutes(db: Database, io: SocketServer): Router {
  const router = Router();
  router.use(authMiddleware(db));

  // ─── Scene Management ───────────────────────────────────────────────

  // Enter a scene (move to a new location)
  router.post('/scene/enter', requireAuth, (req: any, res) => {
    const { campaignId, sceneId } = req.body;

    const scene = get(db, 'SELECT * FROM scenes WHERE id = ? AND campaign_id = ?',
      [sceneId, campaignId]) as any;
    if (!scene) {
      res.json({ ok: false, error: 'Scene not found' });
      return;
    }

    // Update campaign current scene
    run(db, 'UPDATE campaigns SET current_scene_id = ? WHERE id = ?', [sceneId, campaignId]);

    // Mark scene as visited
    run(db, 'UPDATE scenes SET visited = 1 WHERE id = ?', [sceneId]);

    const connections = JSON.parse(scene.connections || '[]').filter((entry: any) => !entry.hidden);
    const npcsInScene = all(db,
      'SELECT name, personality FROM npcs WHERE campaign_id = ? AND location_scene_id = ? AND alive = 1',
      [campaignId, sceneId]) as any[];

    const characters = all(db,
      'SELECT name, level, race, char_class FROM characters WHERE campaign_id = ? AND status = "active"',
      [campaignId]) as any[];

    const description = describeScene({
      scene,
      npcs: npcsInScene,
      party: characters,
    });

    // Log it
    run(db,
      'INSERT INTO game_log (id, campaign_id, type, actor, content) VALUES (?, ?, ?, ?, ?)',
      [uuid(), campaignId, 'scene_enter', 'DM', description]);

    io.to(`campaign:${campaignId}`).emit('game:scene_enter', {
      scene: { ...scene, connections },
      description,
    });

    res.json({ ok: true, data: { scene, description } });
  });

  // ─── NPC Interaction ────────────────────────────────────────────────

  router.post('/npc/talk', requireAuth, (req: any, res) => {
    const { campaignId, npcId, characterId, message } = req.body;

    const npc = get(db, 'SELECT * FROM npcs WHERE id = ?', [npcId]) as any;
    const character = get(db, 'SELECT * FROM characters WHERE id = ?', [characterId]) as any;
    if (!npc || !character) {
      res.json({ ok: false, error: 'NPC or character not found' });
      return;
    }

    const scene = get(db,
      'SELECT * FROM scenes WHERE id = (SELECT current_scene_id FROM campaigns WHERE id = ?)',
      [campaignId]) as any;

    const response = describeNpcResponse({
      npc,
      character,
      message,
      sceneName: scene?.name,
    });

    // Update NPC memory
    const memory = JSON.parse(npc.memory || '[]');
    memory.push(`${character.name} said: "${message.substring(0, 100)}"`);
    if (memory.length > 20) memory.shift();
    run(db, 'UPDATE npcs SET memory = ? WHERE id = ?', [JSON.stringify(memory), npcId]);

    // Log
    run(db,
      'INSERT INTO game_log (id, campaign_id, type, actor, content) VALUES (?, ?, ?, ?, ?)',
      [uuid(), campaignId, 'dialogue', character.name, `To ${npc.name}: "${message}"`]);
    run(db,
      'INSERT INTO game_log (id, campaign_id, type, actor, content) VALUES (?, ?, ?, ?, ?)',
      [uuid(), campaignId, 'dialogue', npc.name, response]);

    io.to(`campaign:${campaignId}`).emit('game:narration', {
      content: response,
      actor: npc.name,
    });

    res.json({ ok: true, data: { npcName: npc.name, response } });
  });

  // ─── Combat ─────────────────────────────────────────────────────────

  // Start an encounter
  router.post('/combat/start', requireAuth, (req: any, res) => {
    const { campaignId, sceneId, enemies, initiativeType } = req.body;

    const started = createEncounterRecord({
      db,
      campaignId,
      sceneId,
      enemies,
      initiativeType,
    });

    emitEncounterStart(io, campaignId, started);
    io.to(`campaign:${campaignId}`).emit('game:narration', {
      actor: 'DM',
      content: started.surpriseSummary,
    });

    res.json({ ok: true, data: started });
  });

  // Resolve a combat attack
  router.post('/combat/attack', requireAuth, (req: any, res) => {
    const { campaignId, encounterId, characterId, action, attackerId, defenderId } = req.body;
    const fallbackAction = action || (attackerId && defenderId ? `attack ${defenderId}` : 'attack');
    const resolution = resolveEncounterAction({
      db,
      campaignId,
      encounterId,
      action: fallbackAction,
      actingCharacterId: characterId || null,
    });

    if (!resolution.ok) {
      res.json({ ok: false, error: resolution.error || 'Combat action failed' });
      return;
    }

    for (const result of resolution.combatResults) {
      run(db,
        'INSERT INTO game_log (id, campaign_id, type, actor, content, mechanical_detail) VALUES (?, ?, ?, ?, ?, ?)',
        [uuid(), campaignId, 'combat', result.attacker, result.description, JSON.stringify(result)]);
      io.to(`campaign:${campaignId}`).emit('game:combat_result', { result });
    }

    for (const note of resolution.narration) {
      io.to(`campaign:${campaignId}`).emit('game:narration', note);
    }

    if (resolution.encounterUpdate) {
      io.to(`campaign:${campaignId}`).emit('game:encounter_update', resolution.encounterUpdate);
    }
    if (resolution.turnPrompt) {
      io.to(`campaign:${campaignId}`).emit('game:turn_prompt', resolution.turnPrompt);
    }

    res.json({ ok: true, data: resolution });
  });

  // ─── Dice Rolling ───────────────────────────────────────────────────

  router.post('/roll', requireAuth, (req: any, res) => {
    const { notation, reason } = req.body;
    try {
      const result = rollNotation(notation || '1d20');
      const { campaignId } = req.body;

      if (campaignId) {
        run(db,
          'INSERT INTO game_log (id, campaign_id, type, actor, content, mechanical_detail) VALUES (?, ?, ?, ?, ?, ?)',
          [uuid(), campaignId, 'roll', req.player.username, `Rolled ${notation}: ${result.total}${reason ? ` (${reason})` : ''}`, JSON.stringify(result)]);

        io.to(`campaign:${campaignId}`).emit('game:log_entry', {
          id: uuid(),
          campaignId,
          sessionNumber: 0,
          timestamp: new Date().toISOString(),
          type: 'roll',
          actor: req.player.username,
          content: `Rolled ${notation}: ${result.total}${reason ? ` (${reason})` : ''}`,
          mechanicalDetail: result,
        });
      }

      res.json({ ok: true, data: result });
    } catch (err) {
      res.json({ ok: false, error: 'Invalid dice notation' });
    }
  });

  // ─── Saving Throw ──────────────────────────────────────────────────

  router.post('/save', requireAuth, (req: any, res) => {
    const { characterId, saveType, modifier, campaignId } = req.body;

    const char = get(db, 'SELECT * FROM characters WHERE id = ?', [characterId]) as any;
    if (!char) {
      res.json({ ok: false, error: 'Character not found' });
      return;
    }

    const result = makeSavingThrow(char.char_class, char.level, saveType, modifier || 0);

    if (campaignId) {
      const saveNames: Record<string, string> = {
        paralysis: 'Paralyzation/Poison/Death',
        rod: 'Rod/Staff/Wand',
        petrify: 'Petrification/Polymorph',
        breath: 'Breath Weapon',
        spell: 'Spell',
      };

      run(db,
        'INSERT INTO game_log (id, campaign_id, type, actor, content, mechanical_detail) VALUES (?, ?, ?, ?, ?, ?)',
        [uuid(), campaignId, 'roll', char.name,
        `Saving throw vs ${saveNames[saveType] || saveType}: rolled ${result.rolled}, needed ${result.needed}. ${result.success ? 'SAVED!' : 'FAILED!'}`,
        JSON.stringify(result)]);
    }

    res.json({ ok: true, data: result });
  });

  // ─── Admin: Seed scenes & NPCs ─────────────────────────────────────

  router.post('/seed', requireAuth, (req: any, res) => {
    const { campaignId, scenes, npcs } = req.body;
    if (!campaignId) { res.json({ ok: false, error: 'campaignId required' }); return; }

    const created = { scenes: 0, npcs: 0 };

    if (scenes) {
      for (const s of scenes) {
        run(db, `INSERT OR REPLACE INTO scenes (id, campaign_id, name, brief, light_level, terrain_type, connections, visited)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [s.id || uuid(), campaignId, s.name, s.brief || '', s.lightLevel || 'normal',
           s.terrainType || 'indoor', JSON.stringify(s.connections || []), 0]);
        created.scenes++;
      }
    }

    if (npcs) {
      for (const n of npcs) {
        run(db, `INSERT OR REPLACE INTO npcs (id, campaign_id, name, race, char_class, level, personality, appearance, voice_notes, disposition, location_scene_id, stats, inventory, memory)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [n.id || uuid(), campaignId, n.name, n.race || 'human', n.charClass || '', n.level || 1,
           n.personality || '', n.appearance || '', n.voiceNotes || '', n.disposition || 'neutral',
           n.locationSceneId || null, JSON.stringify(n.stats || {}), JSON.stringify(n.inventory || []), '[]']);
        created.npcs++;
      }
    }

    res.json({ ok: true, data: created });
  });

  return router;
}
