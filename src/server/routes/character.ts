/**
 * Character routes — creation, management, levelling
 */

import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import type { Database } from 'sql.js';
import { get, all, run } from '../db/helpers.js';
import { authMiddleware, requireAuth } from './auth.js';
import {
  generateAbilities3d6, generateAbilities4d6, generateAbilitiesForClass,
  getEligibleClasses, getEligibleMultiClasses,
  getValidAlignments, assembleCharacter, applyRacialAdjustments,
  getAvailableClasses, meetsClassRequirements, getMissingClassRequirements,
} from '../engine/character.js';
import type { Race, CharClass, Alignment } from '../engine/tables.js';
import { seedStarterCompanions } from '../game/companions.js';

export function createCharacterRoutes(db: Database): Router {
  const router = Router();
  router.use(authMiddleware(db));

  router.get('/roster', requireAuth, (req: any, res) => {
    const rows = all(db, `
      SELECT ch.*, c.name AS campaign_name
      FROM characters ch
      LEFT JOIN campaigns c ON c.id = ch.campaign_id
      WHERE ch.player_id = ?
      ORDER BY ch.created_at DESC
    `, [req.player.id]) as any[];

    res.json({
      ok: true,
      data: rows.map((char) => ({
        id: char.id,
        name: char.name,
        race: char.race,
        charClass: char.char_class,
        alignment: char.alignment,
        level: Number(char.level || 1),
        xp: Number(char.xp || 0),
        hp: Number(char.hp || 0),
        maxHp: Number(char.max_hp || 0),
        status: char.status,
        campaignId: char.campaign_id,
        campaignName: char.campaign_name || 'Unknown campaign',
        rootCharacterId: char.root_character_id || char.id,
        rootCharacterName: char.root_character_name || char.name,
        rootCampaignId: char.root_campaign_id || char.campaign_id,
        sourceCharacterId: char.source_character_id || null,
        sourceCampaignId: char.source_campaign_id || null,
        isCampaignCopy: Boolean(char.source_character_id),
        createdAt: char.created_at,
      })),
    });
  });

  // Roll ability scores
  router.post('/roll-abilities', requireAuth, (req: any, res) => {
    const method = req.body.method === '3d6' ? '3d6' : '4d6kh3';
    const chosenClass = String(req.body.chosenClass || '').toLowerCase();
    const validClasses = ['fighter', 'paladin', 'ranger', 'cleric', 'druid', 'thief', 'bard', 'mage'];
    const result = validClasses.includes(chosenClass)
      ? generateAbilitiesForClass(method, chosenClass as CharClass)
      : (method === '3d6' ? generateAbilities3d6() : generateAbilities4d6());
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
    const availableClasses = getAvailableClasses(race as Race).map(charClass => ({
      charClass,
      eligible: meetsClassRequirements(adjusted, charClass),
      missingRequirements: getMissingClassRequirements(adjusted, charClass),
    }));

    res.json({
      ok: true,
      data: {
        adjustedScores: adjusted,
        singleClasses,
        multiClasses,
        availableClasses,
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

    const adjusted = applyRacialAdjustments(scores, race as Race);
    if (!getAvailableClasses(race as Race).includes(charClass as CharClass)) {
      res.json({ ok: false, error: 'That class is not available for the chosen race' });
      return;
    }

    if (!meetsClassRequirements(adjusted, charClass as CharClass)) {
      const missing = getMissingClassRequirements(adjusted, charClass as CharClass);
      res.json({
        ok: false,
        error: `That class needs ${missing.join(', ')}`,
      });
      return;
    }

    if (!getValidAlignments(charClass as CharClass).includes(alignment as Alignment)) {
      res.json({ ok: false, error: 'That alignment is not valid for the chosen class' });
      return;
    }

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
        conditions, notes, status,
        root_character_id, root_character_name, root_campaign_id, source_character_id, source_campaign_id
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?, ?
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
      character.id, character.name, campaignId, null, null,
    ]);

    seedStarterCompanions(db, campaignId);

    res.json({ ok: true, data: character });
  });

  router.post('/import', requireAuth, (req: any, res) => {
    const { campaignId, sourceCharacterId } = req.body;

    if (!campaignId || !sourceCharacterId) {
      res.json({ ok: false, error: 'campaignId and sourceCharacterId are required' });
      return;
    }

    const membership = get(db,
      'SELECT * FROM campaign_players WHERE campaign_id = ? AND player_id = ?',
      [campaignId, req.player.id]);
    if (!membership) {
      res.json({ ok: false, error: 'Not a member of this campaign' });
      return;
    }

    const existing = get(db,
      'SELECT id FROM characters WHERE campaign_id = ? AND player_id = ? AND status != "dead"',
      [campaignId, req.player.id]) as any;
    if (existing) {
      res.json({ ok: false, error: 'You already have an active character in this campaign' });
      return;
    }

    const source = get(db,
      'SELECT * FROM characters WHERE id = ? AND player_id = ?',
      [sourceCharacterId, req.player.id]) as any;
    if (!source) {
      res.json({ ok: false, error: 'Character not found or not yours' });
      return;
    }
    if (source.status === 'dead') {
      res.json({ ok: false, error: 'Dead characters cannot be imported into a new campaign' });
      return;
    }

    const player = get(db, 'SELECT * FROM players WHERE id = ?', [req.player.id]) as any;
    const clonedId = uuid();
    const sourceConditions = JSON.parse(source.conditions || '[]');
    const sourceInventory = JSON.parse(source.inventory || '[]');
    const sourceWeaponProfs = JSON.parse(source.weapon_profs || '[]');
    const sourceNonweaponProfs = JSON.parse(source.nonweapon_profs || '[]');
    const sourceSpellSlots = source.spell_slots ? JSON.parse(source.spell_slots) : null;
    const sourceMemorisedSpells = source.memorised_spells ? JSON.parse(source.memorised_spells) : null;
    const sourceSpellbook = source.spellbook ? JSON.parse(source.spellbook) : null;
    const sourcePriestSpheres = source.priest_spheres ? JSON.parse(source.priest_spheres) : null;
    const sourceThiefSkills = source.thief_skills ? JSON.parse(source.thief_skills) : null;
    const sourceInjuries = source.injuries ? JSON.parse(source.injuries) : [];
    const rootCharacterId = source.root_character_id || source.id;
    const rootCharacterName = source.root_character_name || source.name;
    const rootCampaignId = source.root_campaign_id || source.campaign_id;

    run(db, `
      INSERT INTO characters (
        id, campaign_id, player_id, player_name, name, race, char_class, multi_class, alignment,
        level, xp, xp_next, str, str_percentile, dex, con, int, wis, cha,
        thac0, ac, hp, max_hp, base_movement,
        save_paralysis, save_rod, save_petrify, save_breath, save_spell,
        weapon_prof_slots, nonweapon_prof_slots, weapon_profs, nonweapon_profs,
        spell_slots, memorised_spells, spellbook, priest_spheres, thief_skills,
        inventory, gold, silver, copper, electrum, platinum,
        conditions, notes, status, injuries,
        root_character_id, root_character_name, root_campaign_id, source_character_id, source_campaign_id
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?
      )
    `, [
      clonedId, campaignId, req.player.id, player.display_name || player.username,
      source.name, source.race, source.char_class, source.multi_class, source.alignment,
      source.level, source.xp, source.xp_next, source.str, source.str_percentile,
      source.dex, source.con, source.int, source.wis, source.cha,
      source.thac0, source.ac, source.hp, source.max_hp, source.base_movement,
      source.save_paralysis, source.save_rod, source.save_petrify, source.save_breath, source.save_spell,
      source.weapon_prof_slots, source.nonweapon_prof_slots, JSON.stringify(sourceWeaponProfs), JSON.stringify(sourceNonweaponProfs),
      sourceSpellSlots ? JSON.stringify(sourceSpellSlots) : null,
      sourceMemorisedSpells ? JSON.stringify(sourceMemorisedSpells) : null,
      sourceSpellbook ? JSON.stringify(sourceSpellbook) : null,
      sourcePriestSpheres ? JSON.stringify(sourcePriestSpheres) : null,
      sourceThiefSkills ? JSON.stringify(sourceThiefSkills) : null,
      JSON.stringify(sourceInventory), source.gold, source.silver, source.copper, source.electrum, source.platinum,
      JSON.stringify(sourceConditions), source.notes, 'active', JSON.stringify(sourceInjuries),
      rootCharacterId, rootCharacterName, rootCampaignId, source.id, source.campaign_id,
    ]);

    seedStarterCompanions(db, campaignId);

    const cloned = get(db, 'SELECT * FROM characters WHERE id = ?', [clonedId]) as any;
    res.json({
      ok: true,
      data: {
        ...cloned,
        inventory: sourceInventory,
        conditions: sourceConditions,
        weaponProfs: sourceWeaponProfs,
        nonweaponProfs: sourceNonweaponProfs,
        spellSlots: sourceSpellSlots,
        memorisedSpells: sourceMemorisedSpells,
        spellbook: sourceSpellbook,
        priestSpheres: sourcePriestSpheres,
        thiefSkills: sourceThiefSkills,
        importedFromCharacterId: source.id,
      },
    });
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
