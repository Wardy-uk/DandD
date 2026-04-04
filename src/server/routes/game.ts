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
import { aiDirector } from '../ai/director.js';
import {
  sceneDescriptionPrompt, npcDialoguePrompt, combatNarrationPrompt, rulingPrompt,
} from '../ai/prompts.js';
import {
  resolveAttack, resolveMissileAttack, rollGroupInitiative, rollIndividualInitiative,
  makeSavingThrow, checkMorale, turnUndead, rollSurpriseCheck,
  type Combatant,
} from '../engine/combat.js';
import { roll, rollNotation, d20, d100, roll2d6 } from '../engine/dice.js';
import type { SavingThrows } from '../engine/tables.js';

export function createGameRoutes(db: Database, io: SocketServer): Router {
  const router = Router();
  router.use(authMiddleware(db));

  // ─── Scene Management ───────────────────────────────────────────────

  // Enter a scene (move to a new location)
  router.post('/scene/enter', requireAuth, async (req: any, res) => {
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

    const connections = JSON.parse(scene.connections || '[]');
    const npcsInScene = all(db,
      'SELECT name, personality FROM npcs WHERE campaign_id = ? AND location_scene_id = ? AND alive = 1',
      [campaignId, sceneId]) as any[];

    // Get party context
    const characters = all(db,
      'SELECT name, level, race, char_class FROM characters WHERE campaign_id = ? AND status = "active"',
      [campaignId]) as any[];
    const partyContext = characters.map(c => `${c.name} (Level ${c.level} ${c.race} ${c.char_class})`).join(', ');

    // If scene already has an AI description, use it; otherwise generate
    if (scene.ai_description) {
      io.to(`campaign:${campaignId}`).emit('game:scene_enter', {
        scene: { ...scene, connections },
        description: scene.ai_description,
      });
      res.json({ ok: true, data: { scene, description: scene.ai_description } });
      return;
    }

    // Generate description via AI
    io.to(`campaign:${campaignId}`).emit('game:dm_thinking', {
      status: 'The DM surveys the new location...',
    });

    const prompt = sceneDescriptionPrompt({
      sceneName: scene.name,
      sceneBrief: scene.brief,
      lightLevel: scene.light_level,
      terrainType: scene.terrain_type,
      connections: connections.map((c: any) => c.direction),
      npcsPresent: npcsInScene.map(n => `${n.name} (${n.personality})`),
      partyContext,
    });

    const description = await aiDirector.enqueueAndWait({
      campaignId,
      type: 'scene',
      priority: 1,
      prompt,
    });

    // Cache the description
    run(db, 'UPDATE scenes SET ai_description = ? WHERE id = ?', [description, sceneId]);

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

  router.post('/npc/talk', requireAuth, async (req: any, res) => {
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

    io.to(`campaign:${campaignId}`).emit('game:dm_thinking', {
      status: `${npc.name} considers their response...`,
    });

    const prompt = npcDialoguePrompt({
      npcName: npc.name,
      npcPersonality: npc.personality,
      npcAppearance: npc.appearance,
      npcVoiceNotes: npc.voice_notes,
      npcDisposition: npc.disposition,
      npcMemory: JSON.parse(npc.memory || '[]'),
      playerCharName: character.name,
      playerSaid: message,
      sceneContext: scene ? `${scene.name}: ${scene.brief}` : 'Unknown',
    });

    const response = await aiDirector.enqueueAndWait({
      campaignId,
      type: 'npc_dialogue',
      priority: 1,
      prompt,
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

    const encounterId = uuid();

    // Get party characters
    const partyChars = all(db,
      'SELECT * FROM characters WHERE campaign_id = ? AND status = "active"',
      [campaignId]) as any[];

    // Build combatant lists
    const partyCombatants: Combatant[] = partyChars.map(c => ({
      id: uuid(),
      name: c.name,
      charClass: c.char_class,
      level: c.level,
      thac0: c.thac0,
      ac: c.ac,
      hp: c.hp,
      maxHp: c.max_hp,
      str: c.str,
      strPercentile: c.str_percentile,
      dex: c.dex,
      weaponSpeed: 5, // Default, should come from equipped weapon
      weaponDamageSm: '1d6', // Default
      weaponDamageLg: '1d6',
      isLargeTarget: false,
      conditions: JSON.parse(c.conditions || '[]'),
      side: 'party' as const,
    }));

    const enemyCombatants: Combatant[] = (enemies || []).map((e: any) => ({
      id: uuid(),
      name: e.name,
      charClass: 'fighter',
      level: e.level || 1,
      thac0: e.thac0 || 20,
      ac: e.ac || 7,
      hp: e.hp || 8,
      maxHp: e.hp || 8,
      str: e.str || 10,
      dex: e.dex || 10,
      weaponSpeed: e.weaponSpeed || 5,
      weaponDamageSm: e.damage || '1d6',
      weaponDamageLg: e.damage || '1d6',
      isLargeTarget: e.size === 'L' || e.size === 'H' || e.size === 'G',
      conditions: [],
      side: 'enemy' as const,
    }));

    // Roll initiative
    const allCombatants = [...partyCombatants, ...enemyCombatants];
    const initiative = initiativeType === 'individual'
      ? rollIndividualInitiative(allCombatants)
      : rollGroupInitiative(partyCombatants, enemyCombatants);

    // Create encounter
    run(db, `
      INSERT INTO encounters (id, campaign_id, scene_id, status, round, initiative_type, turn_order, current_turn_index)
      VALUES (?, ?, ?, 'active', 1, ?, ?, 0)
    `, [encounterId, campaignId, sceneId, initiativeType || 'group', JSON.stringify(initiative.order.map(o => o.id))]);

    // Insert combatants
    for (const c of allCombatants) {
      const orderEntry = initiative.order.find(o => o.id === c.id);
      run(db, `
        INSERT INTO combatants (id, encounter_id, character_id, npc_id, name, side, initiative_roll, weapon_speed, final_initiative, current_hp, max_hp, thac0, ac)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        c.id, encounterId,
        c.side === 'party' ? partyChars.find(pc => pc.name === c.name)?.id : null,
        null, c.name, c.side,
        orderEntry?.initiative || 0, c.weaponSpeed, orderEntry?.initiative || 0,
        c.hp, c.maxHp, c.thac0, c.ac,
      ]);
    }

    const encounter = {
      id: encounterId,
      campaignId,
      sceneId,
      status: 'active' as const,
      round: 1,
      segment: 0,
      initiativeType: (initiativeType || 'group') as 'group' | 'individual',
      turnOrder: initiative.order.map(o => o.id),
      currentTurnIndex: 0,
    };

    io.to(`campaign:${campaignId}`).emit('game:encounter_start', encounter);

    // Prompt first combatant's turn
    const firstTurn = initiative.order[0];
    if (firstTurn) {
      io.to(`campaign:${campaignId}`).emit('game:turn_prompt', {
        combatantId: firstTurn.id,
        name: firstTurn.name,
        round: 1,
      });
    }

    res.json({ ok: true, data: { encounter, initiative } });
  });

  // Resolve a combat attack
  router.post('/combat/attack', requireAuth, async (req: any, res) => {
    const { campaignId, encounterId, attackerId, defenderId, ranged, range } = req.body;

    const attacker = get(db, 'SELECT * FROM combatants WHERE id = ?', [attackerId]) as any;
    const defender = get(db, 'SELECT * FROM combatants WHERE id = ?', [defenderId]) as any;
    if (!attacker || !defender) {
      res.json({ ok: false, error: 'Combatant not found' });
      return;
    }

    const attackerCombatant: Combatant = {
      id: attacker.id, name: attacker.name, charClass: 'fighter', level: 1,
      thac0: attacker.thac0, ac: attacker.ac, hp: attacker.current_hp, maxHp: attacker.max_hp,
      str: 10, dex: 10, weaponSpeed: attacker.weapon_speed,
      weaponDamageSm: '1d8', weaponDamageLg: '1d8',
      isLargeTarget: false, conditions: [], side: attacker.side,
    };

    const defenderCombatant: Combatant = {
      id: defender.id, name: defender.name, charClass: 'fighter', level: 1,
      thac0: defender.thac0, ac: defender.ac, hp: defender.current_hp, maxHp: defender.max_hp,
      str: 10, dex: 10, weaponSpeed: defender.weapon_speed,
      weaponDamageSm: '1d8', weaponDamageLg: '1d8',
      isLargeTarget: false, conditions: [], side: defender.side,
    };

    const result = ranged
      ? resolveMissileAttack(attackerCombatant, defenderCombatant, range || 'short')
      : resolveAttack(attackerCombatant, defenderCombatant);

    // Update defender HP
    if (result.hit && result.defenderHpAfter !== undefined) {
      run(db, 'UPDATE combatants SET current_hp = ? WHERE id = ?',
        [Math.max(0, result.defenderHpAfter), defender.id]);

      // Update character HP if party member
      if (defender.character_id) {
        run(db, 'UPDATE characters SET hp = ? WHERE id = ?',
          [Math.max(0, result.defenderHpAfter), defender.character_id]);
      }
    }

    // Log mechanical result
    run(db,
      'INSERT INTO game_log (id, campaign_id, type, actor, content, mechanical_detail) VALUES (?, ?, ?, ?, ?, ?)',
      [uuid(), campaignId, 'combat', attacker.name, result.description, JSON.stringify(result)]);

    // Get AI narration for the attack
    const scene = get(db,
      'SELECT * FROM scenes WHERE id = (SELECT scene_id FROM encounters WHERE id = ?)',
      [encounterId]) as any;

    aiDirector.enqueue({
      campaignId,
      type: 'combat_narration',
      priority: 2,
      prompt: combatNarrationPrompt({
        sceneContext: scene?.name || 'battlefield',
        round: 1,
        actionDescription: result.description,
      }),
      callback: (narration) => {
        io.to(`campaign:${campaignId}`).emit('game:narration', {
          content: narration,
          actor: 'DM',
        });
      },
    });

    io.to(`campaign:${campaignId}`).emit('game:combat_result', { result });

    res.json({ ok: true, data: result });
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

  return router;
}
