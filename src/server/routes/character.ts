/**
 * Character routes — creation, management, levelling
 */

import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import type { Database } from 'sql.js';
import { get, all, run } from '../db/helpers.js';
import { authMiddleware, requireAuth } from './auth.js';
import {
  generateAbilities3d6, generateAbilities4d6,
  getEligibleClasses, getEligibleMultiClasses,
  getValidAlignments, assembleCharacter, applyRacialAdjustments,
} from '../engine/character.js';
import type { Race, CharClass, Alignment } from '../engine/tables.js';

export function createCharacterRoutes(db: Database): Router {
  const router = Router();
  router.use(authMiddleware(db));

  // Roll ability scores
  router.post('/roll-abilities', requireAuth, (req: any, res) => {
    const method = req.body.method === '3d6' ? '3d6' : '4d6kh3';
    const result = method === '3d6' ? generateAbilities3d6() : generateAbilities4d6();
    res.json({ ok: true, data: result });
  });

  // Get eligible classes for race + scores
  router.post('/eligible-classes', requireAuth, (req: any, res) => {
    const { race, scores } = req.body;
    if (!race || !scores) {
      res.json({ ok: false, error: 'Race and scores required' });
      return;
    }

    const adjusted = applyRacialAdjustments(scores, race as Race);
    const singleClasses = getEligibleClasses(race as Race, adjusted);
    const multiClasses = getEligibleMultiClasses(race as Race, adjusted);

    res.json({
      ok: true,
      data: {
        adjustedScores: adjusted,
        singleClasses,
        multiClasses,
      },
    });
  });

  // Get valid alignments for a class
  router.get('/alignments/:charClass', (req, res) => {
    const alignments = getValidAlignments(req.params.charClass as CharClass);
    res.json({ ok: true, data: alignments });
  });

  // Create character
  router.post('/', requireAuth, (req: any, res) => {
    const { campaignId, name, race, charClass, alignment, scores } = req.body;

    if (!campaignId || !name || !race || !charClass || !alignment || !scores) {
      res.json({ ok: false, error: 'All fields required' });
      return;
    }

    // Verify player is in the campaign
    const membership = get(db,
      'SELECT * FROM campaign_players WHERE campaign_id = ? AND player_id = ?',
      [campaignId, req.player.id]);
    if (!membership) {
      res.json({ ok: false, error: 'Not a member of this campaign' });
      return;
    }

    // Check player doesn't already have an active character in this campaign
    const existing = get(db,
      'SELECT id FROM characters WHERE campaign_id = ? AND player_id = ? AND status != "dead"',
      [campaignId, req.player.id]) as any;
    if (existing) {
      res.json({ ok: false, error: 'You already have an active character in this campaign' });
      return;
    }

    // Get player info
    const player = get(db, 'SELECT * FROM players WHERE id = ?', [req.player.id]) as any;

    const character = assembleCharacter({
      id: uuid(),
      campaignId,
      playerId: req.player.id,
      playerName: player.display_name || player.username,
      name,
      race: race as Race,
      charClass: charClass as CharClass,
      alignment: alignment as Alignment,
      scores,
    });

    // Insert into DB
    run(db, `
      INSERT INTO characters (
        id, campaign_id, player_id, player_name, name, race, char_class, alignment,
        level, xp, xp_next, str, str_percentile, dex, con, int, wis, cha,
        thac0, ac, hp, max_hp, base_movement,
        save_paralysis, save_rod, save_petrify, save_breath, save_spell,
        weapon_prof_slots, nonweapon_prof_slots, weapon_profs, nonweapon_profs,
        spell_slots, memorised_spells, spellbook, priest_spheres, thief_skills,
        inventory, gold, silver, copper, electrum, platinum,
        conditions, notes, status
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?
      )
    `, [
      character.id, character.campaignId, character.playerId, character.playerName,
      character.name, character.race, character.charClass, character.alignment,
      character.level, character.xp, character.xpNext,
      character.str, character.strPercentile || null,
      character.dex, character.con, character.int, character.wis, character.cha,
      character.thac0, character.ac, character.hp, character.maxHp, character.baseMovement,
      character.saves.paralysis, character.saves.rod, character.saves.petrify,
      character.saves.breath, character.saves.spell,
      character.weaponProfSlots, character.nonweaponProfSlots,
      JSON.stringify(character.weaponProfs), JSON.stringify(character.nonweaponProfs),
      character.spellSlots ? JSON.stringify(character.spellSlots) : null,
      character.memorisedSpells ? JSON.stringify(character.memorisedSpells) : null,
      character.spellbook ? JSON.stringify(character.spellbook) : null,
      character.priestSpheres ? JSON.stringify(character.priestSpheres) : null,
      character.thiefSkills ? JSON.stringify(character.thiefSkills) : null,
      JSON.stringify(character.inventory), character.gold, character.silver,
      character.copper, character.electrum, character.platinum,
      JSON.stringify(character.conditions), character.notes, character.status,
    ]);

    res.json({ ok: true, data: character });
  });

  // Get character
  router.get('/:id', requireAuth, (req: any, res) => {
    const char = get(db, 'SELECT * FROM characters WHERE id = ?', [req.params.id]) as any;
    if (!char) {
      res.json({ ok: false, error: 'Character not found' });
      return;
    }

    res.json({
      ok: true,
      data: {
        ...char,
        multiClass: char.multi_class ? JSON.parse(char.multi_class) : null,
        weaponProfs: JSON.parse(char.weapon_profs || '[]'),
        nonweaponProfs: JSON.parse(char.nonweapon_profs || '[]'),
        spellSlots: char.spell_slots ? JSON.parse(char.spell_slots) : null,
        memorisedSpells: char.memorised_spells ? JSON.parse(char.memorised_spells) : null,
        spellbook: char.spellbook ? JSON.parse(char.spellbook) : null,
        priestSpheres: char.priest_spheres ? JSON.parse(char.priest_spheres) : null,
        thiefSkills: char.thief_skills ? JSON.parse(char.thief_skills) : null,
        inventory: JSON.parse(char.inventory || '[]'),
        conditions: JSON.parse(char.conditions || '[]'),
      },
    });
  });

  // Update character status (active/camp/autopilot)
  router.patch('/:id/status', requireAuth, (req: any, res) => {
    const { status } = req.body;
    if (!['active', 'camp', 'autopilot'].includes(status)) {
      res.json({ ok: false, error: 'Invalid status' });
      return;
    }

    // Verify ownership
    const char = get(db, 'SELECT * FROM characters WHERE id = ? AND player_id = ?',
      [req.params.id, req.player.id]) as any;
    if (!char) {
      res.json({ ok: false, error: 'Character not found or not yours' });
      return;
    }

    run(db, 'UPDATE characters SET status = ? WHERE id = ?', [status, req.params.id]);
    res.json({ ok: true, data: { id: req.params.id, status } });
  });

  // List characters for a campaign
  router.get('/campaign/:campaignId', requireAuth, (req: any, res) => {
    const characters = all(db,
      'SELECT * FROM characters WHERE campaign_id = ?',
      [req.params.campaignId]);

    res.json({
      ok: true,
      data: (characters as any[]).map(c => ({
        ...c,
        inventory: JSON.parse(c.inventory || '[]'),
        conditions: JSON.parse(c.conditions || '[]'),
        weaponProfs: JSON.parse(c.weapon_profs || '[]'),
        nonweaponProfs: JSON.parse(c.nonweapon_profs || '[]'),
      })),
    });
  });

  return router;
}
