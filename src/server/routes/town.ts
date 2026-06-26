/**
 * Town routes — all town-phase services
 */

import { Router } from 'express';
import type { Database } from 'sql.js';
import type { Server as SocketServer } from 'socket.io';
import { get, all, run } from '../db/helpers.js';
import { authMiddleware, requireAuth } from './auth.js';
import {
  appraiseLoot,
  buySupplies,
  claimContractReward,
  evaluateContracts,
  expireStaleContracts,
  generateFollowUpContract,
  sniperRivalContracts,
  getCatalogue,
  getHealingQuote,
  generateContracts,
  getProspects,
  healInjuries,
  leaveForDungeon,
  resurrectCompanion,
  returnToTown,
  sellLoot,
} from '../game/town.js';
import { getPartyCompanions, processTownDowntime } from '../game/companions.js';
import { surfaceRumours } from '../game/nightlyGrowth.js';
import { getCampaignState, saveCampaignState } from '../game/campaignState.js';
import { v4 as uuid } from 'uuid';
import { buildCampaignMapIntel } from '../game/mapIntel.js';

export function createTownRoutes(db: Database, io: SocketServer): Router {
  const router = Router();
  router.use(authMiddleware(db));

  // ─── GET /town/:campaignId — full town state ──────────────────────

  router.get('/:campaignId', requireAuth, (req: any, res) => {
    const { campaignId } = req.params;
    const campaign = get(db, 'SELECT * FROM campaigns WHERE id = ?', [campaignId]) as any;
    if (!campaign) { res.json({ ok: false, error: 'Campaign not found' }); return; }

    const membership = get(db, 'SELECT * FROM campaign_players WHERE campaign_id = ? AND player_id = ?',
      [campaignId, req.player.id]) as any;
    if (!membership) { res.json({ ok: false, error: 'Not a member' }); return; }

    const char = get(db,
      'SELECT * FROM characters WHERE campaign_id = ? AND player_id = ? AND status != "dead"',
      [campaignId, req.player.id]) as any;

    const companions = getPartyCompanions(db, campaignId);
    const deadCompanions = all(db,
      'SELECT id, name, char_class, race, level, relationship_state FROM npcs WHERE campaign_id = ? AND alive = 0',
      [campaignId]) as any[];

    const state = getCampaignState(db, campaignId);
    const mapIntel = buildCampaignMapIntel(db, campaignId);
    const catalogue = getCatalogue(db, campaignId);

    const partyClasses = companions.filter(c => c.joinedParty).map(c => c.charClass);
    const sessionNumber = Number(campaign.session_number || 1);
    const settingId = String(campaign.setting_id || '');
    const prospects = getProspects(campaignId, partyClasses, sessionNumber, settingId);

    // Expire stale contracts before building town state
    const expirations = expireStaleContracts(db, campaignId);
    for (const { narration: expNarration } of expirations) {
      run(db, 'INSERT INTO game_log (id, campaign_id, type, actor, content) VALUES (?, ?, ?, ?, ?)',
        [uuid(), campaignId, 'narration', 'DM', expNarration]);
      io.to(`campaign:${campaignId}`).emit('game:narration', { actor: 'DM', content: expNarration });
    }

    // Rivals may have claimed untaken contracts while the party was away
    const snipes = sniperRivalContracts(db, campaignId);
    for (const { narration: snipeNarration } of snipes) {
      run(db, 'INSERT INTO game_log (id, campaign_id, type, actor, content) VALUES (?, ?, ?, ?, ?)',
        [uuid(), campaignId, 'narration', 'DM', snipeNarration]);
      io.to(`campaign:${campaignId}`).emit('game:narration', { actor: 'DM', content: snipeNarration });
    }

    let contracts: any[] = [];
    try {
      // Re-read after possible expiry / snipe mutations
      const freshRow = get(db, 'SELECT town_contracts FROM campaigns WHERE id = ?', [campaignId]) as any;
      contracts = JSON.parse(freshRow?.town_contracts || '[]');
    } catch {}
    if (contracts.length === 0) {
      contracts = generateContracts(state, String(campaign.name || ''), settingId, sessionNumber);
      run(db, 'UPDATE campaigns SET town_contracts = ? WHERE id = ?', [JSON.stringify(contracts), campaignId]);
    }

    contracts = evaluateContracts(db, campaignId, contracts);
    run(db, 'UPDATE campaigns SET town_contracts = ? WHERE id = ?', [JSON.stringify(contracts), campaignId]);

    const healQuote = char ? getHealingQuote(db, char.id) : { injuries: [], totalCost: 0 };
    const lootAppraisal = char ? appraiseLoot(db, campaignId, char.id) : { items: [], totalGp: 0 };

    res.json({
      ok: true,
      data: {
        phase: campaign.campaign_phase || 'dungeon',
        townName: campaign.town_name || '',
        sessionNumber,
        character: char ? {
          id: char.id,
          name: char.name,
          hp: char.hp,
          maxHp: char.max_hp,
          gold: Number(char.gold || 0),
          conditions: JSON.parse(char.conditions || '[]'),
          charClass: char.char_class,
        } : null,
        companions,
        deadCompanions: deadCompanions.map(n => ({ ...n, relationship: JSON.parse(n.relationship_state || '{}') })),
        catalogue,
        prospects,
        contracts,
        healQuote,
        lootAppraisal,
        expeditionSummary: {
          discoveredSites: mapIntel.stats?.discoveredSites || 0,
          fallbackPoints: mapIntel.stats?.fallbackPoints || 0,
          campReady: mapIntel.stats?.campReady || 0,
          hazardMarks: mapIntel.stats?.hazardMarks || 0,
          treasureMarks: mapIntel.stats?.treasureMarks || 0,
          encounterPressure: state.encounterPressure,
          recentEvents: [...state.recentEvents].slice(-4).reverse(),
        },
        factions: Object.entries(state.factions).map(([key, f]) => ({
          key,
          name: f.name,
          reputation: f.reputation,
          heat: f.heat,
          contractCooldownUntilSession: f.contractCooldownUntilSession ?? null,
        })),
      },
    });
  });

  // ─── POST /town/:campaignId/rumours ──────────────────────────────

  router.post('/:campaignId/rumours', requireAuth, (req: any, res) => {
    const { campaignId } = req.params;
    const count = Math.min(3, parseInt(req.body.count || '2'));
    const rumours = surfaceRumours(db, campaignId, count);

    const BARKEEP_FRAMES = [
      (r: string) => `The barkeep refills your cup without being asked. "Heard something today," he says, not looking up. "${r}"`,
      (r: string) => `A woman at the next table leans over. Nobody asked her. "${r}" She goes back to her drink.`,
      (r: string) => `The barkeep wipes down the bar and drops his voice. "For what it's worth — and it may be worth nothing — ${r.toLowerCase()}"`,
      (r: string) => `Between drinks, out of nowhere: "${r}" The source is a man who is clearly three cups past reliable. Still.`,
    ];

    const voiced = rumours.map((r, i) => {
      const frame = BARKEEP_FRAMES[i % BARKEEP_FRAMES.length];
      return frame(r);
    });

    if (voiced.length === 0) {
      voiced.push(`"Nothing new," the barkeep says. "Same old dungeon, same old trouble. Nobody comes through here with good news."`);
    }

    // Log
    for (const line of voiced) {
      run(db, 'INSERT INTO game_log (id, campaign_id, type, actor, content) VALUES (?, ?, ?, ?, ?)',
        [uuid(), campaignId, 'narration', 'Barkeep', line]);
      io.to(`campaign:${campaignId}`).emit('game:narration', { actor: 'Barkeep', content: line });
    }

    res.json({ ok: true, data: { rumours: voiced } });
  });

  // ─── POST /town/:campaignId/sell ─────────────────────────────────

  router.post('/:campaignId/sell', requireAuth, (req: any, res) => {
    const { campaignId } = req.params;
    const { items } = req.body; // optional array of item name strings

    const char = get(db,
      'SELECT id, char_class FROM characters WHERE campaign_id = ? AND player_id = ? AND status != "dead"',
      [campaignId, req.player.id]) as any;
    if (!char) { res.json({ ok: false, error: 'No active character' }); return; }

    const result = sellLoot(db, campaignId, char.id, items);

    // XP award log
    if (result.xpAwarded > 0) {
      const xpLine = `${result.xpAwarded} XP awarded for treasure converted — an old tradition, and a sound one.`;
      run(db, 'INSERT INTO game_log (id, campaign_id, type, actor, content) VALUES (?, ?, ?, ?, ?)',
        [uuid(), campaignId, 'narration', 'DM', xpLine]);
      io.to(`campaign:${campaignId}`).emit('game:narration', { actor: 'DM', content: xpLine });
    }

    run(db, 'INSERT INTO game_log (id, campaign_id, type, actor, content) VALUES (?, ?, ?, ?, ?)',
      [uuid(), campaignId, 'narration', 'Fence', result.narration]);
    io.to(`campaign:${campaignId}`).emit('game:narration', { actor: 'Fence', content: result.narration });

    const updatedChar = get(db, 'SELECT * FROM characters WHERE id = ?', [char.id]) as any;
    if (updatedChar) {
      io.to(`campaign:${campaignId}`).emit('game:state_update', { type: 'character_update', payload: updatedChar });
    }

    res.json({ ok: true, data: result });
  });

  // ─── POST /town/:campaignId/buy ──────────────────────────────────

  router.post('/:campaignId/buy', requireAuth, (req: any, res) => {
    const { campaignId } = req.params;
    const { order } = req.body; // Array<{ item: string; quantity: number }>

    if (!Array.isArray(order) || order.length === 0) {
      res.json({ ok: false, error: 'Order must be a non-empty array of { item, quantity }' });
      return;
    }

    const char = get(db,
      'SELECT id FROM characters WHERE campaign_id = ? AND player_id = ? AND status != "dead"',
      [campaignId, req.player.id]) as any;
    if (!char) { res.json({ ok: false, error: 'No active character' }); return; }

    const result = buySupplies(db, campaignId, char.id, order);
    if (!result.ok) {
      res.json({ ok: false, error: result.error });
      return;
    }

    run(db, 'INSERT INTO game_log (id, campaign_id, type, actor, content) VALUES (?, ?, ?, ?, ?)',
      [uuid(), campaignId, 'narration', 'DM', result.narration]);
    io.to(`campaign:${campaignId}`).emit('game:narration', { actor: 'DM', content: result.narration });

    const updatedChar = get(db, 'SELECT * FROM characters WHERE id = ?', [char.id]) as any;
    if (updatedChar) {
      io.to(`campaign:${campaignId}`).emit('game:state_update', { type: 'character_update', payload: updatedChar });
    }

    res.json({ ok: true, data: result });
  });

  // ─── POST /town/:campaignId/heal ─────────────────────────────────

  router.post('/:campaignId/heal', requireAuth, (req: any, res) => {
    const { campaignId } = req.params;

    const char = get(db,
      'SELECT id, char_class FROM characters WHERE campaign_id = ? AND player_id = ? AND status != "dead"',
      [campaignId, req.player.id]) as any;
    if (!char) { res.json({ ok: false, error: 'No active character' }); return; }

    const isPaladin = String(char.char_class || '').toLowerCase() === 'paladin';
    const result = healInjuries(db, char.id, isPaladin);
    if (!result.ok && result.error) {
      res.json({ ok: false, error: result.error });
      return;
    }

    run(db, 'INSERT INTO game_log (id, campaign_id, type, actor, content) VALUES (?, ?, ?, ?, ?)',
      [uuid(), campaignId, 'narration', 'Healer', result.narration]);
    io.to(`campaign:${campaignId}`).emit('game:narration', { actor: 'Healer', content: result.narration });

    const updatedChar = get(db, 'SELECT * FROM characters WHERE id = ?', [char.id]) as any;
    if (updatedChar) {
      io.to(`campaign:${campaignId}`).emit('game:state_update', { type: 'character_update', payload: updatedChar });
    }

    res.json({ ok: true, data: result });
  });

  // ─── POST /town/:campaignId/resurrect ────────────────────────────

  router.post('/:campaignId/resurrect', requireAuth, (req: any, res) => {
    const { campaignId } = req.params;
    const { npcId } = req.body;
    if (!npcId) { res.json({ ok: false, error: 'npcId required' }); return; }

    const char = get(db,
      'SELECT id FROM characters WHERE campaign_id = ? AND player_id = ? AND status != "dead"',
      [campaignId, req.player.id]) as any;
    if (!char) { res.json({ ok: false, error: 'No active character' }); return; }

    const result = resurrectCompanion(db, char.id, npcId);
    if (!result.ok) { res.json({ ok: false, error: result.error }); return; }

    run(db, 'INSERT INTO game_log (id, campaign_id, type, actor, content) VALUES (?, ?, ?, ?, ?)',
      [uuid(), campaignId, 'narration', 'Healer', result.narration]);
    io.to(`campaign:${campaignId}`).emit('game:narration', { actor: 'Healer', content: result.narration });

    io.to(`campaign:${campaignId}`).emit('game:state_update', {
      type: 'companions_update',
      payload: getPartyCompanions(db, campaignId),
    });

    const updatedChar = get(db, 'SELECT * FROM characters WHERE id = ?', [char.id]) as any;
    if (updatedChar) {
      io.to(`campaign:${campaignId}`).emit('game:state_update', { type: 'character_update', payload: updatedChar });
    }

    res.json({ ok: true, data: result });
  });

  // ─── POST /town/:campaignId/hire ──────────────────────────────────

  router.post('/:campaignId/hire', requireAuth, (req: any, res) => {
    const { campaignId } = req.params;
    const { prospectName } = req.body;
    if (!prospectName) { res.json({ ok: false, error: 'prospectName required' }); return; }

    const campaign = get(db, 'SELECT * FROM campaigns WHERE id = ?', [campaignId]) as any;
    const char = get(db,
      'SELECT id, gold FROM characters WHERE campaign_id = ? AND player_id = ? AND status != "dead"',
      [campaignId, req.player.id]) as any;
    if (!char) { res.json({ ok: false, error: 'No active character' }); return; }

    const partyClasses = getPartyCompanions(db, campaignId).filter(c => c.joinedParty).map(c => c.charClass);
    const sessionNumber = Number(campaign?.session_number || 1);
    const prospects = getProspects(campaignId, partyClasses, sessionNumber, String(campaign?.setting_id || ''));
    const prospect = prospects.find(p => p.name.toLowerCase() === prospectName.toLowerCase());
    if (!prospect) { res.json({ ok: false, error: 'Prospect not available' }); return; }

    const weeklyAsk = prospect.ask;
    if (Number(char.gold) < weeklyAsk) {
      res.json({ ok: false, error: `${prospect.name} asks ${weeklyAsk} GP/week. You have ${Number(char.gold).toFixed(1)} GP.` });
      return;
    }

    // Deduct first week's pay
    run(db, 'UPDATE characters SET gold = gold - ? WHERE id = ?', [weeklyAsk, char.id]);

    // Create NPC and immediately join party
    const npcId = uuid();
    const currentSceneId = campaign?.current_scene_id || null;
    run(db, `INSERT INTO npcs (id, campaign_id, name, race, char_class, level, personality, voice_notes, disposition, location_scene_id, stats, joined_party, companion_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'friendly', ?, ?, 1, ?)`,
      [
        npcId, campaignId, prospect.name, prospect.race, prospect.charClass, prospect.level,
        prospect.personality, prospect.voiceNotes,
        currentSceneId,
        JSON.stringify({ hp: prospect.level * 5, maxHp: prospect.level * 5, currentHp: prospect.level * 5, ac: 7, thac0: 20 - prospect.level }),
        10 + partyClasses.length,
      ]);

    const hireNarration = `${prospect.name} extends a hand. "First week up front, like we agreed." ${weeklyAsk} GP — it's a business arrangement. They'll be ready when you leave.`;
    run(db, 'INSERT INTO game_log (id, campaign_id, type, actor, content) VALUES (?, ?, ?, ?, ?)',
      [uuid(), campaignId, 'narration', 'DM', hireNarration]);
    io.to(`campaign:${campaignId}`).emit('game:narration', { actor: 'DM', content: hireNarration });
    io.to(`campaign:${campaignId}`).emit('game:state_update', {
      type: 'companions_update',
      payload: getPartyCompanions(db, campaignId),
    });

    const updatedChar = get(db, 'SELECT * FROM characters WHERE id = ?', [char.id]) as any;
    if (updatedChar) {
      io.to(`campaign:${campaignId}`).emit('game:state_update', { type: 'character_update', payload: updatedChar });
    }

    res.json({ ok: true, data: { npcId, name: prospect.name, weeklyAsk, hireNarration } });
  });

  // ─── GET /town/:campaignId/contracts — lightweight contract poll ─────────

  router.get('/:campaignId/contracts', requireAuth, (req: any, res) => {
    const { campaignId } = req.params;
    const campaign = get(db, 'SELECT town_contracts, setting_id FROM campaigns WHERE id = ?', [campaignId]) as any;
    if (!campaign) { res.json({ ok: false, error: 'Campaign not found' }); return; }
    const membership = get(db, 'SELECT 1 FROM campaign_players WHERE campaign_id = ? AND player_id = ?',
      [campaignId, req.player.id]) as any;
    if (!membership) { res.json({ ok: false, error: 'Not a member' }); return; }

    let contracts: any[] = [];
    try { contracts = JSON.parse(campaign.town_contracts || '[]'); } catch {}
    const evaluated = evaluateContracts(db, campaignId, contracts);
    // Only surface taken, unclaimed contracts — the active "jobs in progress"
    const active = evaluated.filter((c: any) => c.taken && !c.claimedAt);
    res.json({ ok: true, data: active });
  });

  // ─── POST /town/:campaignId/contract/take ────────────────────────

  router.post('/:campaignId/contract/take', requireAuth, (req: any, res) => {
    const { campaignId } = req.params;
    const { contractId } = req.body;
    if (!contractId) { res.json({ ok: false, error: 'contractId required' }); return; }

    const campaign = get(db, 'SELECT town_contracts FROM campaigns WHERE id = ?', [campaignId]) as any;
    let contracts: any[] = [];
    try { contracts = JSON.parse(campaign?.town_contracts || '[]'); } catch {}

    const contract = contracts.find((c: any) => c.id === contractId);
    if (!contract) { res.json({ ok: false, error: 'Contract not found' }); return; }
    if (contract.taken) { res.json({ ok: false, error: 'Already taken' }); return; }

    contract.taken = true;
    const turnRow = get(db, 'SELECT exploration_turn FROM campaigns WHERE id = ?', [campaignId]) as any;
    contract.takenAtTurn = Number(turnRow?.exploration_turn || 0);
    contracts = evaluateContracts(db, campaignId, contracts);
    run(db, 'UPDATE campaigns SET town_contracts = ? WHERE id = ?', [JSON.stringify(contracts), campaignId]);

    const contractNarration = `The garrison scribe marks it down. Contract accepted: ${contract.title}. Reward of ${contract.reward} GP on completion. "Don't come back empty-handed," the duty officer says, though they say that to everyone.`;
    run(db, 'INSERT INTO game_log (id, campaign_id, type, actor, content) VALUES (?, ?, ?, ?, ?)',
      [uuid(), campaignId, 'narration', 'DM', contractNarration]);
    io.to(`campaign:${campaignId}`).emit('game:narration', { actor: 'DM', content: contractNarration });

    res.json({ ok: true, data: { contract, narration: contractNarration } });
  });

  router.post('/:campaignId/contract/claim', requireAuth, (req: any, res) => {
    const { campaignId } = req.params;
    const { contractId } = req.body;
    if (!contractId) { res.json({ ok: false, error: 'contractId required' }); return; }

    const char = get(db,
      'SELECT id FROM characters WHERE campaign_id = ? AND player_id = ? AND status != "dead"',
      [campaignId, req.player.id]) as any;
    if (!char) { res.json({ ok: false, error: 'No active character' }); return; }

    const result = claimContractReward({ db, campaignId, characterId: char.id, contractId });
    if (!result.ok) {
      res.json({ ok: false, error: result.error });
      return;
    }

    // Chronicle entry for completed contract
    try {
      const campRow = get(db, 'SELECT session_number FROM campaigns WHERE id = ?', [campaignId]) as any;
      const sessionNum = Number(campRow?.session_number || 1);
      const successResult = result as { ok: true; reward: number; xpAward: number; contract: { title: string } };
      const xpAmt = successResult.xpAward;
      const gpAmt = successResult.reward;
      const contractTitle = successResult.contract?.title ?? contractId;
      run(db,
        `INSERT INTO chronicle (id, campaign_id, session_number, entry_type, content, created_at)
         VALUES (?, ?, ?, 'contract_complete', ?, datetime('now'))`,
        [uuid(), campaignId, sessionNum, `Contract "${contractTitle}" completed — ${gpAmt}gp, ${xpAmt}xp awarded.`],
      );
    } catch {}

    run(db, 'INSERT INTO game_log (id, campaign_id, type, actor, content) VALUES (?, ?, ?, ?, ?)',
      [uuid(), campaignId, 'narration', 'DM', result.narration]);
    io.to(`campaign:${campaignId}`).emit('game:narration', { actor: 'DM', content: result.narration });

    const updatedChar = get(db, 'SELECT * FROM characters WHERE id = ?', [char.id]) as any;
    if (updatedChar) {
      io.to(`campaign:${campaignId}`).emit('game:state_update', { type: 'character_update', payload: updatedChar });
    }

    // Generate faction follow-up contract
    let followUp: any = null;
    try {
      const campaignState = getCampaignState(db, campaignId);
      const successResult = result as { ok: true; contract: any; reward: number; xpAward: number; narration: string };
      const followUpResult = generateFollowUpContract(db, campaignId, successResult.contract, campaignState);
      if (followUpResult) {
        followUp = followUpResult.contract;
        const campRow = get(db, 'SELECT town_contracts FROM campaigns WHERE id = ?', [campaignId]) as any;
        let currentContracts: any[] = [];
        try { currentContracts = JSON.parse(campRow?.town_contracts || '[]'); } catch {}
        currentContracts.push(followUp);

        // Board cap — drop oldest non-taken contract when board exceeds 8
        const MAX_BOARD = 8;
        if (currentContracts.filter((c: any) => !c.claimedAt).length > MAX_BOARD) {
          const toDrop = currentContracts.find((c: any) => !c.claimedAt && !c.taken && c.id !== followUp.id);
          if (toDrop) {
            currentContracts = currentContracts.filter((c: any) => c.id !== toDrop.id);
            const dropNote = `The garrison board is full. The posting for "${toDrop.title}" has been scratched out — too many contracts, not enough hands.`;
            run(db, 'INSERT INTO game_log (id, campaign_id, type, actor, content) VALUES (?, ?, ?, ?, ?)',
              [uuid(), campaignId, 'narration', 'DM', dropNote]);
            io.to(`campaign:${campaignId}`).emit('game:narration', { actor: 'DM', content: dropNote });
          }
        }

        run(db, 'UPDATE campaigns SET town_contracts = ? WHERE id = ?', [JSON.stringify(currentContracts), campaignId]);
        run(db, 'INSERT INTO game_log (id, campaign_id, type, actor, content) VALUES (?, ?, ?, ?, ?)',
          [uuid(), campaignId, 'narration', 'DM', followUpResult.narration]);
        io.to(`campaign:${campaignId}`).emit('game:narration', { actor: 'DM', content: followUpResult.narration });
        io.to(`campaign:${campaignId}`).emit('game:contracts_updated', { followUpId: followUp.id });
      }
    } catch (err) {
      console.error('[Town] Follow-up contract generation failed:', err);
    }

    res.json({ ok: true, data: { ...result, followUp } });
  });

  // ─── POST /town/:campaignId/downtime ─────────────────────────────

  router.post('/:campaignId/downtime', requireAuth, (req: any, res) => {
    const { campaignId } = req.params;

    const char = get(db,
      'SELECT id, name FROM characters WHERE campaign_id = ? AND player_id = ? AND status != "dead"',
      [campaignId, req.player.id]) as any;
    if (!char) { res.json({ ok: false, error: 'No active character' }); return; }

    const notes = processTownDowntime(db, campaignId, char.name);

    for (const note of notes) {
      run(db, 'INSERT INTO game_log (id, campaign_id, type, actor, content) VALUES (?, ?, ?, ?, ?)',
        [uuid(), campaignId, 'narration', 'DM', note]);
      io.to(`campaign:${campaignId}`).emit('game:narration', { actor: 'DM', content: note });
    }

    io.to(`campaign:${campaignId}`).emit('game:state_update', {
      type: 'companions_update',
      payload: getPartyCompanions(db, campaignId),
    });

    res.json({ ok: true, data: { notes } });
  });

  // ─── POST /town/:campaignId/leave ────────────────────────────────

  router.post('/:campaignId/leave', requireAuth, (req: any, res) => {
    const { campaignId } = req.params;

    const char = get(db,
      'SELECT id FROM characters WHERE campaign_id = ? AND player_id = ? AND status != "dead"',
      [campaignId, req.player.id]) as any;
    if (!char) { res.json({ ok: false, error: 'No active character' }); return; }

    const { summary, finalRumour } = leaveForDungeon(db, campaignId, char.id);

    const departureLine = `The road back in is familiar, and that's not a comfort. ${finalRumour ? `As you leave, you catch a fragment of conversation: "${finalRumour}"` : 'The town falls quiet behind you.'}`;

    run(db, 'INSERT INTO game_log (id, campaign_id, type, actor, content) VALUES (?, ?, ?, ?, ?)',
      [uuid(), campaignId, 'narration', 'DM', departureLine]);
    io.to(`campaign:${campaignId}`).emit('game:narration', { actor: 'DM', content: departureLine });
    io.to(`campaign:${campaignId}`).emit('game:state_update', {
      type: 'phase_change',
      payload: { phase: 'dungeon' },
    });

    res.json({ ok: true, data: { phase: 'dungeon', summary, finalRumour, departureLine } });
  });

  return router;
}
