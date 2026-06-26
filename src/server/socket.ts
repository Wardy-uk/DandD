/**
 * Socket.IO handler for async multiplayer
 * Players can join/leave campaigns at any time.
 * Actions are broadcast to all connected players in the same campaign.
 */

import type { Server as SocketServer, Socket } from 'socket.io';
import type { Database } from 'sql.js';
import type { ServerToClientEvents, ClientToServerEvents } from '../shared/types.js';
import { get, all, run } from './db/helpers.js';
import { describeScene, findMovementTarget } from './game/deterministic.js';
import { resolveRichExploration, buildSceneBlueprint } from './game/adventure.js';
import { addLootWeight, applyAttritionDamage, getCampaignState, getCampaignStateSnapshot, getLightModifiers, lightTorch, makeCamp, saveCampaignState, shiftFactionStanding, tickDelveConditions } from './game/campaignState.js';
import { createEncounterRecord, describeBattlefield, emitEncounterStart, getActiveEncounter, resolveEncounterAction } from './game/encounters.js';
import { awardExplorationXp } from './engine/progression.js';
import { buildCampaignMapIntel } from './game/mapIntel.js';
import {
  checkRivalPresence,
  getAllRivals,
  resolveRivalClash,
  seedRivalPartyIfNeeded,
  tickRivals,
} from './game/rivals.js';
import { popDawnSummary, popPendingWorldEvents, surfaceRumours } from './game/nightlyGrowth.js';
import { checkFactionSceneEntry, isParleyAction, resolveParley } from './game/factions.js';
import {
  checkCompanionRefusals,
  checkJealousyTriggers,
  checkRecruitmentFriction,
  getCompanionPartyModifiers,
  getJoinedCompanionIdsInScene,
  getPartyCompanions,
  logCompanionDisagreement,
  progressCompanionArcs,
  recordRiskyDecision,
  getSceneNpcRoster,
  resolveCompanionDrama,
  resolveCompanionInteraction,
  syncCompanionsToScene,
  tryRecruitNpc,
  updateCompanionRelationships,
} from './game/companions.js';
import { returnToTown } from './game/town.js';
import { generate } from './ai/ollama.js';
import { getCompanionReaction, inferReactionTrigger } from './game/companionReactions.js';

interface ConnectedPlayer {
  socketId: string;
  playerId: string;
  playerName: string;
  campaignId: string | null;
}

const connectedPlayers = new Map<string, ConnectedPlayer>();
const actionLocks = new Set<string>(); // prevent concurrent action processing per campaign

function emitCampaignState(io: SocketServer<ClientToServerEvents, ServerToClientEvents>, db: Database, campaignId: string) {
  io.to(`campaign:${campaignId}`).emit('game:state_update', {
    type: 'campaign_state',
    payload: getCampaignStateSnapshot(getCampaignState(db, campaignId)),
  });
}

export function setupSocketHandlers(
  io: SocketServer<ClientToServerEvents, ServerToClientEvents>,
  db: Database,
) {
  io.on('connection', (socket: Socket<ClientToServerEvents, ServerToClientEvents>) => {
    console.log(`[Socket] Client connected: ${socket.id}`);

    // ─── Join Campaign ────────────────────────────────────────────────

    socket.on('game:join', (data) => {
      const { campaignId, playerId } = data;

      // Look up player
      const player = get(db, 'SELECT * FROM players WHERE id = ?', [playerId]) as any;
      if (!player) {
        socket.emit('game:state_update', { type: 'error', payload: 'Player not found' });
        return;
      }

      // Join the campaign room
      socket.join(`campaign:${campaignId}`);

      connectedPlayers.set(socket.id, {
        socketId: socket.id,
        playerId,
        playerName: player.display_name || player.username,
        campaignId,
      });

      // Update last_seen
      run(db, 'UPDATE players SET last_seen = datetime("now") WHERE id = ?', [playerId]);

      // Notify other players
      socket.to(`campaign:${campaignId}`).emit('game:player_joined', {
        playerId,
        playerName: player.display_name || player.username,
      });

      // Send current game state to joining player
      const campaign = get(db, 'SELECT * FROM campaigns WHERE id = ?', [campaignId]) as any;
      if (campaign) {
        socket.emit('game:state_update', { type: 'campaign', payload: campaign });
        const joinedCharacter = get(db,
          'SELECT * FROM characters WHERE campaign_id = ? AND player_id = ? AND status != "dead"',
          [campaignId, playerId]) as any;
        if (joinedCharacter) {
          socket.emit('game:state_update', { type: 'character_update', payload: joinedCharacter });
        }

        // Send recent game log
        const recentLogs = all(db,
          'SELECT * FROM game_log WHERE campaign_id = ? ORDER BY timestamp DESC LIMIT 50',
          [campaignId]);
        socket.emit('game:state_update', { type: 'recent_logs', payload: recentLogs.reverse() });
        socket.emit('game:state_update', {
          type: 'companions_update',
          payload: getPartyCompanions(db, campaignId),
        });
        socket.emit('game:state_update', {
          type: 'campaign_state',
          payload: getCampaignStateSnapshot(getCampaignState(db, campaignId)),
        });
        if (campaign.current_scene_id) {
          socket.emit('game:state_update', {
            type: 'scene_npcs_update',
            payload: getSceneNpcRoster(db, campaignId, campaign.current_scene_id),
          });
        }

        // If there's an active scene, send it
        if (campaign.current_scene_id) {
          const scene = get(db, 'SELECT * FROM scenes WHERE id = ?', [campaign.current_scene_id]) as any;
          if (scene) {
            const npcsInScene = all(db,
              'SELECT name, personality FROM npcs WHERE campaign_id = ? AND location_scene_id = ? AND alive = 1',
              [campaignId, scene.id]) as any[];
            const characters = all(db,
              'SELECT name, level, race, char_class FROM characters WHERE campaign_id = ? AND status = "active"',
              [campaignId]) as any[];
            socket.emit('game:scene_enter', {
              scene: {
                ...scene,
                connections: JSON.parse(scene.connections || '[]').filter((entry: any) => !entry.hidden),
              },
              description: describeScene({
                scene,
                npcs: npcsInScene,
                party: characters,
              }),
            });
            socket.emit('game:state_update', {
              type: 'battlefield_update',
              payload: {
                sceneId: scene.id,
                profile: describeBattlefield(scene),
              },
            });
          }
        }
        socket.emit('game:state_update', {
          type: 'map_update',
          payload: buildCampaignMapIntel(db, campaignId),
        });

        // If there's an active encounter, send it
        const encounter = getActiveEncounter(db, campaignId);
        if (encounter) {
          socket.emit('game:encounter_start', {
            ...encounter,
            turnOrder: JSON.parse(encounter.turn_order || '[]'),
          });
        }

        // ── Dawn summary — surface overnight world changes ────────────
        try {
          const dawnSummary = popDawnSummary(db, campaignId);
          if (dawnSummary) {
            run(db,
              'INSERT INTO game_log (id, campaign_id, type, actor, content) VALUES (?, ?, ?, ?, ?)',
              [crypto.randomUUID(), campaignId, 'narration', 'DM', dawnSummary]);
            socket.emit('game:narration', { actor: 'DM', content: dawnSummary });
          }
        } catch {}
      }

      console.log(`[Socket] ${player.display_name || player.username} joined campaign ${campaignId}`);
    });

    // ─── Player Action (exploration/roleplay) ─────────────────────────

    socket.on('game:action', async (data) => {
      const { campaignId, action } = data;
      const player = connectedPlayers.get(socket.id);
      if (!player) return;
      // Prevent concurrent action processing - queue would be complex so just drop duplicates
      if (actionLocks.has(campaignId)) {
        socket.emit('game:narration', { content: 'A moment passes... (please wait)', actor: 'DM' });
        return;
      }

      // Get player's character in this campaign
      const character = get(db,
        'SELECT * FROM characters WHERE campaign_id = ? AND player_id = ? AND status != "dead"',
        [campaignId, player.playerId]) as any;
      if (!character) return;

      // Dying characters can't take exploration actions (unconscious and bleeding)
      if (character.status === 'dying') {
        const activeEncounter = getActiveEncounter(db, campaignId);
        // Allow first aid and combat actions during an active encounter
        const isFirstAid = /first aid|stabilise|stabilize|bind wounds|help the dying|help/.test(action.toLowerCase());
        if (!activeEncounter || (!isFirstAid && !/attack|shoot|cast|turn undead|lay on hands|rally|retreat|parley/.test(action.toLowerCase()))) {
          socket.emit('game:narration', {
            actor: 'DM',
            content: `${character.name} is unconscious and bleeding. They cannot act. Another party member needs to reach them with first aid, or the encounter must end.`,
          });
          return;
        }
      }

      // Broadcast the action to all players
      io.to(`campaign:${campaignId}`).emit('game:player_action', {
        playerId: player.playerId,
        playerName: character.name,
        action,
      });

      // Log it
      const logId = crypto.randomUUID();
      run(db,
        'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
        [logId, campaignId, 1, 'player_action', character.name, action]);

      const campaign = get(db, 'SELECT * FROM campaigns WHERE id = ?', [campaignId]) as any;
      const activeEncounter = getActiveEncounter(db, campaignId);
      if (activeEncounter) {
        const resolution = resolveEncounterAction({
          db,
          campaignId,
          encounterId: activeEncounter.id,
          action,
          actingCharacterId: character.id,
        });

        if (!resolution.ok) {
          io.to(`campaign:${campaignId}`).emit('game:narration', {
            actor: 'DM',
            content: resolution.error || 'That combat action cannot be resolved right now.',
          });
          return;
        }

        for (const result of resolution.combatResults) {
          run(db,
            'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content, mechanical_detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [crypto.randomUUID(), campaignId, 1, 'combat', result.attacker, result.description, JSON.stringify(result)]);
          io.to(`campaign:${campaignId}`).emit('game:combat_result', { result });
        }

        for (const note of resolution.narration) {
          run(db,
            'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
            [crypto.randomUUID(), campaignId, 1, 'narration', note.actor, note.content]);
          io.to(`campaign:${campaignId}`).emit('game:narration', note);
        }

        for (const updatedCharacterId of resolution.updatedCharacterIds) {
          const updatedCharacter = get(db, 'SELECT * FROM characters WHERE id = ?', [updatedCharacterId]) as any;
          if (updatedCharacter) {
            io.to(`campaign:${campaignId}`).emit('game:state_update', {
              type: 'character_update',
              payload: updatedCharacter,
            });
          }
        }

        if (resolution.encounterUpdate) {
          io.to(`campaign:${campaignId}`).emit('game:encounter_update', resolution.encounterUpdate);
        }
        io.to(`campaign:${campaignId}`).emit('game:state_update', {
          type: 'companions_update',
          payload: getPartyCompanions(db, campaignId),
        });
        if (campaign.current_scene_id) {
          io.to(`campaign:${campaignId}`).emit('game:state_update', {
            type: 'scene_npcs_update',
            payload: getSceneNpcRoster(db, campaignId, campaign.current_scene_id),
          });
        }
        io.to(`campaign:${campaignId}`).emit('game:state_update', {
          type: 'map_update',
          payload: buildCampaignMapIntel(db, campaignId),
        });
        emitCampaignState(io, db, campaignId);
        if (resolution.encounterUpdate?.status === 'resolved' && campaign.current_scene_id) {
          const companionIds = getJoinedCompanionIdsInScene(db, campaignId, campaign.current_scene_id);
          updateCompanionRelationships({
            db,
            npcIds: companionIds,
            kind: 'victory',
            note: `${character.name} led the company through a live fight.`,
          });
          const dramaNotes = resolveCompanionDrama({
            db,
            campaignId,
            sceneId: campaign.current_scene_id,
            action: `victory ${action}`,
            leaderName: character.name,
          });
          for (const note of dramaNotes) {
            io.to(`campaign:${campaignId}`).emit('game:narration', { actor: 'DM', content: note });
          }
          io.to(`campaign:${campaignId}`).emit('game:state_update', {
            type: 'companions_update',
            payload: getPartyCompanions(db, campaignId),
          });
          // ── Companion reaction: combat resolved ──────────────────────────
          try {
            const killCompanions = getPartyCompanions(db, campaignId).filter((c) => c.joinedParty);
            const killReaction = getCompanionReaction('combat_kill', killCompanions, character.name);
            if (killReaction) {
              run(db,
                'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
                [crypto.randomUUID(), campaignId, 1, 'narration', killReaction.companion.name, killReaction.line]);
              io.to(`campaign:${campaignId}`).emit('game:narration', {
                content: killReaction.line,
                actor: killReaction.companion.name,
              });
            }
          } catch {}
        }
        if (resolution.turnPrompt) {
          io.to(`campaign:${campaignId}`).emit('game:turn_prompt', resolution.turnPrompt);
        }
        return;
      }

      // ── Return to town ────────────────────────────────────────────────
      if (/return to town|head back to town|leave the dungeon|make for town|back to (the )?town|retreat to town|we head back|leave for town/i.test(action)) {
        try {
          const { townName, arrivalNarration, dawnSummary } = returnToTown(db, campaignId);
          const arrivalLogId = crypto.randomUUID();
          run(db, 'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
            [arrivalLogId, campaignId, 1, 'narration', 'DM', arrivalNarration]);
          io.to(`campaign:${campaignId}`).emit('game:narration', { actor: 'DM', content: arrivalNarration });
          if (dawnSummary) {
            run(db, 'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
              [crypto.randomUUID(), campaignId, 1, 'narration', 'DM', dawnSummary]);
            io.to(`campaign:${campaignId}`).emit('game:narration', { actor: 'DM', content: dawnSummary });
          }
          io.to(`campaign:${campaignId}`).emit('game:state_update', {
            type: 'phase_change',
            payload: { phase: 'town', townName },
          });
          emitCampaignState(io, db, campaignId);
        } catch (err) {
          console.error('[town transition error]', err);
          io.to(`campaign:${campaignId}`).emit('game:narration', {
            actor: 'DM',
            content: 'The road to town is clear. Head there when ready.',
          });
        }
        return;
      }

      const scene = campaign?.current_scene_id
        ? get(db, 'SELECT * FROM scenes WHERE id = ?', [campaign.current_scene_id]) as any
        : null;
      if (!scene) {
        io.to(`campaign:${campaignId}`).emit('game:narration', {
          actor: 'DM',
          content: 'The campaign has no current scene yet. Enter or seed a location first so the adventure has somewhere concrete to happen.',
        });
        return;
      }

      if (/read the battlefield|survey the battlefield|tactical read|read the room for a fight/.test(action.toLowerCase())) {
        io.to(`campaign:${campaignId}`).emit('game:narration', {
          actor: 'DM',
          content: describeBattlefield(scene).summary,
        });
        io.to(`campaign:${campaignId}`).emit('game:state_update', {
          type: 'battlefield_update',
          payload: {
            sceneId: scene.id,
            profile: describeBattlefield(scene),
          },
        });
        return;
      }

      const npcsInScene = all(db,
        'SELECT * FROM npcs WHERE campaign_id = ? AND location_scene_id = ? AND alive = 1',
        [campaignId, scene.id]) as any[];

      // ── Companion refusals (won't do that again / low-trust blocks) ──
      const refusals = checkCompanionRefusals({
        db, campaignId, sceneId: scene.id, action, leaderName: character.name,
      });
      if (refusals.length > 0) {
        for (const r of refusals) {
          const refusalLogId = crypto.randomUUID();
          run(db,
            'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
            [refusalLogId, campaignId, 1, 'narration', r.companion, r.reason]);
          io.to(`campaign:${campaignId}`).emit('game:narration', { actor: r.companion, content: r.reason });
        }
        io.to(`campaign:${campaignId}`).emit('game:state_update', {
          type: 'companions_update', payload: getPartyCompanions(db, campaignId),
        });
        return;
      }

      const companionInteraction = resolveCompanionInteraction({
        db,
        campaignId,
        sceneId: scene.id,
        character,
        action,
      });
      if (companionInteraction?.handled) {
        for (const content of companionInteraction.narration) {
          io.to(`campaign:${campaignId}`).emit('game:narration', { actor: 'DM', content });
        }
        if (companionInteraction.characterUpdated) {
          const updatedCharacter = get(db, 'SELECT * FROM characters WHERE id = ?', [character.id]) as any;
          if (updatedCharacter) {
            io.to(`campaign:${campaignId}`).emit('game:state_update', {
              type: 'character_update',
              payload: updatedCharacter,
            });
          }
        }
        io.to(`campaign:${campaignId}`).emit('game:state_update', {
          type: 'companions_update',
          payload: getPartyCompanions(db, campaignId),
        });
        io.to(`campaign:${campaignId}`).emit('game:state_update', {
          type: 'scene_npcs_update',
          payload: getSceneNpcRoster(db, campaignId, scene.id),
        });
        emitCampaignState(io, db, campaignId);
        return;
      }

      if (/join us|travel with us|come with us|recruit|enlist|hire/.test(action.toLowerCase()) && npcsInScene.length > 0) {
        const targetNpc = npcsInScene.find((npc) => action.toLowerCase().includes(String(npc.name || '').toLowerCase())) || npcsInScene[0];
        const recruit = tryRecruitNpc({ db, npcId: targetNpc.id, leaderCha: Number(character.cha || 10), action: action.toLowerCase() });
        io.to(`campaign:${campaignId}`).emit('game:narration', { actor: 'DM', content: recruit.content });
        if (recruit.ok) {
          // Existing companions may react to the new addition
          const frictionNotes = checkRecruitmentFriction({
            db, campaignId, sceneId: scene.id,
            newNpcId: targetNpc.id, newNpcName: targetNpc.name,
            newNpcClass: targetNpc.char_class || '', leaderName: character.name,
          });
          for (const note of frictionNotes) {
            run(db,
              'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
              [crypto.randomUUID(), campaignId, 1, 'narration', 'DM', note]);
            io.to(`campaign:${campaignId}`).emit('game:narration', { actor: 'DM', content: note });
          }
        }
        io.to(`campaign:${campaignId}`).emit('game:state_update', {
          type: 'companions_update',
          payload: getPartyCompanions(db, campaignId),
        });
        io.to(`campaign:${campaignId}`).emit('game:state_update', {
          type: 'scene_npcs_update',
          payload: getSceneNpcRoster(db, campaignId, scene.id),
        });
        emitCampaignState(io, db, campaignId);
        return;
      }

      // ── Faction parley ───────────────────────────────────────────────
      if (isParleyAction(action)) {
        const campRow = get(db, 'SELECT * FROM campaigns WHERE id = ?', [campaignId]) as any;
        const parleyFactionKey = campRow?.dominant_faction || 'locals';
        const parleyState = getCampaignState(db, campaignId);
        const parleyResult = resolveParley({
          state: parleyState,
          factionKey: parleyFactionKey,
          leaderCha: Number(character.cha || 10),
          parleyAction: action,
        });
        if (parleyResult.heatDelta !== 0 || parleyResult.repDelta !== 0) {
          shiftFactionStanding(parleyState, parleyFactionKey, {
            heat: parleyResult.heatDelta,
            reputation: parleyResult.repDelta,
          });
        }
        saveCampaignState(db, campaignId, parleyState);
        for (const note of parleyResult.notes) {
          run(db, 'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
            [crypto.randomUUID(), campaignId, 1, 'narration', 'DM', note]);
          io.to(`campaign:${campaignId}`).emit('game:narration', { actor: 'DM', content: note });
        }
        emitCampaignState(io, db, campaignId);
        return;
      }

      // ── Rival clash actions (fight/parley/intimidate) ─────────────────
      const explorationTurnNow = Number((get(db, 'SELECT exploration_turn FROM campaigns WHERE id = ?', [campaignId]) as any)?.exploration_turn || 0);
      const sceneRivals = getAllRivals(db, campaignId).filter(
        (r) => r.status === 'active' && r.currentSceneId === scene.id,
      );
      if (sceneRivals.length > 0) {
        const clashPattern = /fight|attack|drive off|confront|intimidate|parley|talk to them|ignore them|leave them alone/i;
        if (clashPattern.test(action)) {
          const rival = sceneRivals[0];
          const partyMods = getCompanionPartyModifiers(db, campaignId, scene.id);
          const partyStrength = 5 + Math.floor(partyMods.morale / 3) + partyMods.vanguardBonus;
          const clashType: 'fight' | 'parley' | 'intimidate' | 'ignore' =
            /fight|attack|drive off|confront/.test(action.toLowerCase()) ? 'fight'
            : /parley|talk to them/.test(action.toLowerCase()) ? 'parley'
            : /intimidate/.test(action.toLowerCase()) ? 'intimidate'
            : 'ignore';
          const clashResult = resolveRivalClash({
            db, campaignId, rivalId: rival.id, partyStrength, leaderName: character.name, clashType,
          });
          for (const note of clashResult.notes) {
            run(db, 'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
              [crypto.randomUUID(), campaignId, 1, 'narration', 'DM', note]);
            io.to(`campaign:${campaignId}`).emit('game:narration', { actor: 'DM', content: note });
          }
          emitCampaignState(io, db, campaignId);
          return;
        }
      }

      const movementTarget = findMovementTarget(action, scene);
      if (movementTarget) {
        const nextScene = get(db, 'SELECT * FROM scenes WHERE id = ? AND campaign_id = ?',
          [movementTarget.targetSceneId, campaignId]) as any;
        if (!nextScene) {
          io.to(`campaign:${campaignId}`).emit('game:narration', {
            actor: 'DM',
            content: `The way ${movementTarget.direction} leads nowhere usable yet.`,
          });
          return;
        }

        const wasUnvisited = !nextScene.visited;
        run(db, 'UPDATE campaigns SET current_scene_id = ? WHERE id = ?', [nextScene.id, campaignId]);
        run(db, 'UPDATE scenes SET visited = 1 WHERE id = ?', [nextScene.id]);
        syncCompanionsToScene(db, campaignId, nextScene.id);
        // Exploration XP for entering a new (previously unvisited) scene
        if (wasUnvisited) {
          const levelUps = awardExplorationXp(db, campaignId);
          for (const lu of levelUps) {
            if (lu.narration) {
              run(db, 'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
                [crypto.randomUUID(), campaignId, 1, 'level_up', 'DM', lu.narration]);
              io.to(`campaign:${campaignId}`).emit('game:narration', { actor: 'DM', content: lu.narration });
            }
          }
          // Push updated character stats to clients after XP award
          const updatedChars = all(db,
            'SELECT * FROM characters WHERE campaign_id = ? AND status NOT IN ("dead")',
            [campaignId]) as any[];
          for (const uc of updatedChars) {
            io.to(`campaign:${campaignId}`).emit('game:state_update', {
              type: 'character_update',
              payload: uc,
            });
          }
        }

        // ── Rival tick: advance all active rivals when party moves ──
        const explorationTurn = Number((get(db, 'SELECT exploration_turn FROM campaigns WHERE id = ?', [campaignId]) as any)?.exploration_turn || 0);
        const campaignRow = get(db, 'SELECT danger_level FROM campaigns WHERE id = ?', [campaignId]) as any;
        const dangerLevel = Number(campaignRow?.danger_level || 2);

        const rivalTickNotes = tickRivals({ db, campaignId, currentSceneId: nextScene.id, explorationTurn });
        for (const note of rivalTickNotes) {
          run(db, 'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
            [crypto.randomUUID(), campaignId, 1, 'narration', 'DM', note]);
          io.to(`campaign:${campaignId}`).emit('game:narration', { actor: 'DM', content: note });
        }

        // Spawn a new rival if conditions are right
        seedRivalPartyIfNeeded({ db, campaignId, currentSceneId: nextScene.id, explorationTurn, dangerLevel });

        // Check rival presence in the new scene
        const rivalPresence = checkRivalPresence({ db, campaignId, sceneId: nextScene.id, explorationTurn });
        for (const note of rivalPresence.notes) {
          run(db, 'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
            [crypto.randomUUID(), campaignId, 1, 'narration', 'DM', note]);
          io.to(`campaign:${campaignId}`).emit('game:narration', { actor: 'DM', content: note });
        }

        // ── Faction patrol check on scene entry ─────────────────────────
        const campaignRowFaction = get(db, 'SELECT * FROM campaigns WHERE id = ?', [campaignId]) as any;
        const sceneFactionKey = campaignRowFaction?.dominant_faction || 'locals';
        const factionEntryNotes = checkFactionSceneEntry({
          db, campaignId, sceneId: nextScene.id, factionKey: sceneFactionKey,
          explorationTurn: Number(campaignRowFaction?.exploration_turn || 0),
          leaderName: character.name,
        });
        for (const note of factionEntryNotes) {
          run(db, 'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
            [crypto.randomUUID(), campaignId, 1, 'narration', 'DM', note]);
          io.to(`campaign:${campaignId}`).emit('game:narration', { actor: 'DM', content: note });
        }

        const npcsInScene = all(db,
          'SELECT name, personality FROM npcs WHERE campaign_id = ? AND location_scene_id = ? AND alive = 1',
          [campaignId, nextScene.id]) as any[];
        const characters = all(db,
          'SELECT name, level, race, char_class FROM characters WHERE campaign_id = ? AND status = "active"',
          [campaignId]) as any[];
        const description = describeScene({
          scene: nextScene,
          npcs: npcsInScene,
          party: characters,
        });
        const connections = JSON.parse(nextScene.connections || '[]').filter((entry: any) => !entry.hidden);

        run(db,
          'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
          [crypto.randomUUID(), campaignId, 1, 'scene_enter', 'DM', description]);
        io.to(`campaign:${campaignId}`).emit('game:scene_enter', {
          scene: { ...nextScene, connections },
          description,
        });
        io.to(`campaign:${campaignId}`).emit('game:state_update', {
          type: 'battlefield_update',
          payload: {
            sceneId: nextScene.id,
            profile: describeBattlefield(nextScene),
          },
        });
        io.to(`campaign:${campaignId}`).emit('game:state_update', {
          type: 'map_update',
          payload: buildCampaignMapIntel(db, campaignId),
        });
        io.to(`campaign:${campaignId}`).emit('game:state_update', {
          type: 'companions_update',
          payload: getPartyCompanions(db, campaignId),
        });

        // ── World events: inject one pending event as ambient narration ──
        try {
          const worldEventTexts = popPendingWorldEvents(db, campaignId);
          for (const eventText of worldEventTexts) {
            run(db, 'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
              [crypto.randomUUID(), campaignId, 1, 'narration', 'DM', eventText]);
            io.to(`campaign:${campaignId}`).emit('game:narration', { actor: 'DM', content: eventText });
          }
        } catch {}
        io.to(`campaign:${campaignId}`).emit('game:state_update', {
          type: 'scene_npcs_update',
          payload: getSceneNpcRoster(db, campaignId, nextScene.id),
        });
        emitCampaignState(io, db, campaignId);
        return;
      }
      // ── Orientation queries — any question asking "where am I / what do I see" ─
      const isOrientationQuery = /(where\s+(am\s+i|are\s+we)|what\s+(is|'?s|are)\s+(this\s+place|this\s+room|here)|what\s+(do\s+i|can\s+i)\s+see|what'?s\s+(here|around\s+(me|us))|describe\s+(this\s+place|the\s+room|where\s+(i\s+am|we\s+are))|tell\s+me\s+about\s+this\s+place|look\s+around)/i.test(action);
      if (isOrientationQuery) {
        const orientChars = all(db,
          'SELECT name, level, race, char_class FROM characters WHERE campaign_id = ? AND status = "active"',
          [campaignId]) as any[];
        const orientDesc = describeScene({ scene, npcs: npcsInScene, party: orientChars });
        run(db,
          'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
          [crypto.randomUUID(), campaignId, 1, 'narration', 'DM', orientDesc]);
        io.to(`campaign:${campaignId}`).emit('game:narration', { content: orientDesc, actor: 'DM' });
        // ── Companion reaction: darkness ──────────────────────────────────
        if ((scene.light_level || 'normal') === 'dark') {
          try {
            const darkCompanions = getPartyCompanions(db, campaignId).filter((c) => c.joinedParty);
            const darkReaction = getCompanionReaction('darkness', darkCompanions, character.name);
            if (darkReaction) {
              run(db,
                'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
                [crypto.randomUUID(), campaignId, 1, 'narration', darkReaction.companion.name, darkReaction.line]);
              io.to(`campaign:${campaignId}`).emit('game:narration', {
                content: darkReaction.line,
                actor: darkReaction.companion.name,
              });
            }
          } catch {}
        }
        emitCampaignState(io, db, campaignId);
        return;
      }

      const outcome = resolveRichExploration({
        db,
        campaignId,
        scene,
        character,
        npcs: npcsInScene,
        action,
        connections: JSON.parse(scene.connections || '[]'),
      });

      // Party/companion query — answer deterministically, never hit Ollama for this
      const partyQueryRx = /who('?s| is) with (me|us)|who are my (companions|party|allies)|who do i have|tell me (about my|who('?s in|are in)) (my )?(party|group|companions)|list (my |the )?(party|companions)/i;
      if (!outcome && partyQueryRx.test(action)) {
        const cs = getCampaignState(db, campaignId);
        const companions = (cs.companions || []) as any[];
        let partyMsg: string;
        if (companions.length === 0) {
          partyMsg = 'You are travelling alone.';
        } else {
          const names = companions.map((c: any) => {
            const hpNote = c.hp !== undefined && c.maxHp !== undefined
              ? ` (${c.hp}/${c.maxHp} HP)`
              : '';
            const morale = c.morale !== undefined ? `, morale ${c.morale}` : '';
            return `${c.name}${hpNote}${morale}`;
          });
          partyMsg = `With you: ${names.join('; ')}.`;
        }
        run(db, 'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
          [crypto.randomUUID(), campaignId, 1, 'narration', 'DM', partyMsg]);
        io.to(`campaign:${campaignId}`).emit('game:narration', { content: partyMsg, actor: 'DM' });
        emitCampaignState(io, db, campaignId);
        return;
      }

      if (!outcome) {
        // Unknown action — AI resolves it. No action ever gets a dead rejection.
        const sceneExits = JSON.parse(scene.connections || '[]')
          .filter((c: any) => !c.hidden)
          .map((c: any) => c.direction).join(', ') || 'none';
        const sceneNpcNames = npcsInScene.map((n: any) => n.name).join(', ');
        const sceneBlurb = [
          scene.name,
          scene.brief ? `— ${scene.brief}` : scene.ai_description ? `— ${String(scene.ai_description).slice(0, 120)}` : '',
        ].filter(Boolean).join(' ');

        // Build richer scene context for the AI
        const aiBlueprint = buildSceneBlueprint(scene);
        const aiCampaignState = getCampaignState(db, campaignId);

        // Character condition
        const hpPct = character.max_hp > 0 ? character.hp / character.max_hp : 1;
        const charCondition = hpPct <= 0.25 ? 'badly wounded' : hpPct <= 0.5 ? 'injured' : hpPct <= 0.75 ? 'lightly wounded' : 'healthy';

        // Faction heat — surface the highest heat faction if it matters
        const hotFactions = Object.entries(aiCampaignState.factions)
          .filter(([, f]) => (f as any).heat >= 3)
          .map(([k]) => k);

        // Encounter pressure cue
        const pressure = aiCampaignState.encounterPressure;
        const pressureCue = pressure >= 7 ? 'imminent danger — something is closing in'
          : pressure >= 4 ? 'tension is building — the dungeon is aware of them'
          : 'quiet';

        const contextParts: string[] = [
          `Scene: ${sceneBlurb}`,
          `Ambience: ${aiBlueprint.roomAmbience}`,
          `Hazard present: ${aiBlueprint.trap.kind}`,
          aiBlueprint.clue ? `Notable detail: ${aiBlueprint.clue}` : '',
          aiBlueprint.tracks ? `Tracks/signs: ${aiBlueprint.tracks}` : '',
          `Light: ${scene.light_level || 'normal'}`,
          `Exits: ${sceneExits}`,
          sceneNpcNames ? `Present: ${sceneNpcNames}` : '',
          `Character: ${character.name} (${character.char_class} level ${character.level}), condition: ${charCondition} (${character.hp}/${character.max_hp} HP)`,
          hotFactions.length ? `Faction alert: ${hotFactions.join(', ')} are actively hostile` : '',
          `Dungeon mood: ${pressureCue}`,
        ].filter(Boolean);

        let aiMsg = 'The moment passes without clear resolution — but it was not wasted.';

        // Signal to client that AI is processing
        io.to(`campaign:${campaignId}`).emit('game:narration', { content: '…', actor: 'DM', thinking: true });
        actionLocks.add(campaignId);
        try {
          aiMsg = (await generate({
            system: `You are a terse AD&D Dungeon Master narrating in present tense. One short paragraph, 2-3 sentences.
Rules:
- Address the player as "you" or by their character name (${character.name})
- Be specific — name objects, textures, sounds, smells drawn from the scene details provided
- Never say "nothing happens" or "the moment passes"
- Never open with "The party" or "You find yourself"
- If the action is impossible, describe why vividly rather than refusing
- Voice: dry, wry, like a DM who has seen it all but still enjoys the theatre`,
            prompt: `${contextParts.join('. ')}.\nPlayer action: "${action}". Narrate the outcome.`,
            maxTokens: 180,
            temperature: 0.75,
          })).trim() || aiMsg;
        } catch (aiErr) {
          console.error('[AI fallback error]', aiErr);
          // Ollama unreachable — still give something real
          aiMsg = `${aiBlueprint.roomAmbience} The attempt registers. Nothing dramatic shifts, but the room has noted it.`;
        } finally {
          actionLocks.delete(campaignId);
        }

        run(db, 'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
          [crypto.randomUUID(), campaignId, 1, 'narration', 'DM', aiMsg]);
        io.to(`campaign:${campaignId}`).emit('game:narration', { content: aiMsg, actor: 'DM' });
        // ── Companion reaction: strange/fallback action ───────────────────
        try {
          const strangeCompanions = getPartyCompanions(db, campaignId).filter((c) => c.joinedParty);
          const strangeReaction = getCompanionReaction('strange_action', strangeCompanions, character.name);
          if (strangeReaction) {
            run(db,
              'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
              [crypto.randomUUID(), campaignId, 1, 'narration', strangeReaction.companion.name, strangeReaction.line]);
            io.to(`campaign:${campaignId}`).emit('game:narration', {
              content: strangeReaction.line,
              actor: strangeReaction.companion.name,
            });
          }
        } catch {}
        emitCampaignState(io, db, campaignId);
        return;
      }

      const dmLogId = crypto.randomUUID();
      run(db,
        'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
        [dmLogId, campaignId, 1, 'dm_response', 'DM', outcome.content]);

      if (outcome.sceneConnections) {
        io.to(`campaign:${campaignId}`).emit('game:state_update', {
          type: 'scene_update',
          payload: {
            id: scene.id,
            connections: outcome.sceneConnections,
          },
        });
      }
      io.to(`campaign:${campaignId}`).emit('game:state_update', {
        type: 'battlefield_update',
        payload: {
          sceneId: scene.id,
          profile: describeBattlefield(scene),
        },
      });
      io.to(`campaign:${campaignId}`).emit('game:state_update', {
        type: 'map_update',
        payload: buildCampaignMapIntel(db, campaignId),
      });
      emitCampaignState(io, db, campaignId);

      const companionIds = getJoinedCompanionIdsInScene(db, campaignId, scene.id);

      // ── Delve pressure tick ───────────────────────────────────────────
      try {
      const delveState = getCampaignState(db, campaignId);
      const charInventory = typeof character.inventory === 'string'
        ? JSON.parse(character.inventory || '[]') : (character.inventory || []);
      const torchCount = charInventory.filter((i: any) => i.item === 'Torch').reduce((n: number, i: any) => n + Number(i.quantity || 0), 0);
      const rationCount = charInventory.filter((i: any) => i.item === 'Ration').reduce((n: number, i: any) => n + Number(i.quantity || 0), 0);
      const campTurn = Number((get(db, 'SELECT exploration_turn FROM campaigns WHERE id = ?', [campaignId]) as any)?.exploration_turn || 0);

      const delveNotes = tickDelveConditions({
        state: delveState,
        explorationTurn: campTurn,
        torchesCarried: torchCount,
        rationsCarried: rationCount,
        leaderName: character.name,
      });

      // Handle "light a torch" action
      if (/light a torch|light the torch/.test(action.toLowerCase())) {
        const torchNote = lightTorch(delveState, campTurn, torchCount);
        delveNotes.push(torchNote);
      }

      // Handle camp/rest resolution
      if (/^rest$|make camp|set camp|camp here|secure and rest/.test(action.toLowerCase())) {
        const campNotes = makeCamp({
          state: delveState,
          explorationTurn: campTurn,
          rationsAvailable: rationCount,
          sceneLight: scene.light_level || 'normal',
          fortified: /secure|barricade|bar the|fortified/.test(action.toLowerCase()),
          leaderName: character.name,
        });
        delveNotes.push(...campNotes);

        // Surface a rumour at camp — something the company picks up while resting
        try {
          const rumours = surfaceRumours(db, campaignId, 1);
          for (const rumour of rumours) {
            const rumourNarration = `Word around the camp: ${rumour}`;
            run(db, 'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
              [crypto.randomUUID(), campaignId, 1, 'narration', 'DM', rumourNarration]);
            io.to(`campaign:${campaignId}`).emit('game:narration', { actor: 'DM', content: rumourNarration });
          }
        } catch {}
      }

      // Surface a rumour when asking around (NPC talk, crowd, market)
      if (/ask around|ask about|what.*heard|any news|rumour|rumor|what.*say|talk.*town|talk.*tavern|ask.*locals|ask.*people/.test(action.toLowerCase())) {
        try {
          const askRumours = surfaceRumours(db, campaignId, 1);
          for (const rumourText of askRumours) {
            const rumourNarration = `You hear it mentioned: ${rumourText}`;
            run(db, 'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
              [crypto.randomUUID(), campaignId, 1, 'narration', 'DM', rumourNarration]);
            io.to(`campaign:${campaignId}`).emit('game:narration', { actor: 'DM', content: rumourNarration });
          }
        } catch {}
      }

      // Apply any accumulated attrition to the character HP
      const attritionDelta = applyAttritionDamage(delveState);
      if (attritionDelta < 0 && character.id) {
        run(db, 'UPDATE characters SET hp = MAX(1, hp + ?) WHERE id = ?', [attritionDelta, character.id]);
        const updatedChar = get(db, 'SELECT * FROM characters WHERE id = ?', [character.id]) as any;
        if (updatedChar) {
          io.to(`campaign:${campaignId}`).emit('game:state_update', { type: 'character_update', payload: updatedChar });
        }
      }

      saveCampaignState(db, campaignId, delveState);

      for (const note of delveNotes) {
        run(db, 'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
          [crypto.randomUUID(), campaignId, 1, 'narration', 'DM', note]);
        io.to(`campaign:${campaignId}`).emit('game:narration', { actor: 'DM', content: note });
      }

      // Apply companion tension from supply shortages
      if (delveState.delve.tensionFromSupply > 0) {
        const companionTensionIds = getJoinedCompanionIdsInScene(db, campaignId, scene.id);
        if (companionTensionIds.length > 0) {
          updateCompanionRelationships({
            db,
            npcIds: companionTensionIds,
            kind: 'hazard',
            note: 'Supply shortages and poor conditions are grinding on the company.',
          });
        }
      }
      } catch (delveErr) {
        console.error('[delve tick error]', delveErr);
      }

      // ── Risky decision accumulation ───────────────────────────────────
      const riskyNotes = recordRiskyDecision({
        db, campaignId, sceneId: scene.id, action, leaderName: character.name,
      });

      // ── Disagreement logging (role-vs-order mismatches) ─────────────
      const disagreementNotes = logCompanionDisagreement({
        db, campaignId, sceneId: scene.id, action, leaderName: character.name,
      });

      if (/rest|camp|secure|fallback|mark fallback point|parley|negotiate/.test(action.toLowerCase())) {
        updateCompanionRelationships({
          db,
          npcIds: companionIds,
          kind: /parley|negotiate/.test(action.toLowerCase()) ? 'parley' : /secure|fallback/.test(action.toLowerCase()) ? 'security' : 'rest',
          note: `${character.name} shaped the company with: ${action}`,
        });
      }
      if (/force|bash|trap|hazard/.test(action.toLowerCase()) || (outcome.hpDelta || 0) < 0) {
        updateCompanionRelationships({
          db,
          npcIds: companionIds,
          kind: 'hazard',
          note: `${character.name} led the company into a dangerous beat: ${action}`,
        });
      }
      const dramaNotes = resolveCompanionDrama({
        db,
        campaignId,
        sceneId: scene.id,
        action,
        leaderName: character.name,
      });
      const arcNotes = progressCompanionArcs({
        db,
        campaignId,
        sceneId: scene.id,
        action,
        leaderName: character.name,
      });
      io.to(`campaign:${campaignId}`).emit('game:state_update', {
        type: 'companions_update',
        payload: getPartyCompanions(db, campaignId),
      });
      io.to(`campaign:${campaignId}`).emit('game:state_update', {
        type: 'scene_npcs_update',
        payload: getSceneNpcRoster(db, campaignId, scene.id),
      });
      emitCampaignState(io, db, campaignId);

      const updatedCharacter = get(db, 'SELECT * FROM characters WHERE id = ?', [character.id]) as any;
      if (updatedCharacter) {
        io.to(`campaign:${campaignId}`).emit('game:state_update', {
          type: 'character_update',
          payload: updatedCharacter,
        });
      }

      io.to(`campaign:${campaignId}`).emit('game:narration', {
        content: outcome.content,
        actor: outcome.actor || 'DM',
      });
      // ── Companion reaction: exploration outcome ───────────────────────────
      try {
        const explCompanions = getPartyCompanions(db, campaignId).filter((c) => c.joinedParty);
        const hpPct = updatedCharacter && updatedCharacter.max_hp > 0
          ? updatedCharacter.hp / updatedCharacter.max_hp
          : 1;
        const trigger = inferReactionTrigger(
          action,
          outcome.content,
          outcome.hpDelta ?? 0,
          hpPct,
          scene.light_level || 'normal',
        );
        if (trigger) {
          const explReaction = getCompanionReaction(trigger, explCompanions, character.name);
          if (explReaction) {
            run(db,
              'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
              [crypto.randomUUID(), campaignId, 1, 'narration', explReaction.companion.name, explReaction.line]);
            io.to(`campaign:${campaignId}`).emit('game:narration', {
              content: explReaction.line,
              actor: explReaction.companion.name,
            });
          }
        }
      } catch {}
      for (const note of riskyNotes) {
        run(db,
          'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',          [crypto.randomUUID(), campaignId, 1, 'narration', 'DM', note]);
        io.to(`campaign:${campaignId}`).emit('game:narration', { content: note, actor: 'DM' });
      }
      for (const note of disagreementNotes) {
        run(db,
          'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
          [crypto.randomUUID(), campaignId, 1, 'narration', 'DM', note]);
        io.to(`campaign:${campaignId}`).emit('game:narration', { content: note, actor: 'DM' });
      }
      for (const note of dramaNotes) {
        io.to(`campaign:${campaignId}`).emit('game:narration', {
          content: note,
          actor: 'DM',
        });
      }
      for (const note of arcNotes) {
        io.to(`campaign:${campaignId}`).emit('game:narration', {
          content: note,
          actor: 'DM',
        });
      }

      if (outcome.encounter) {
        const activeEncounter = getActiveEncounter(db, campaignId);
        if (!activeEncounter) {
          const started = createEncounterRecord({
            db,
            campaignId,
            sceneId: scene.id,
            enemies: outcome.encounter.enemies,
            initiativeType: outcome.encounter.initiativeType,
          });
          run(db,
            'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
            [crypto.randomUUID(), campaignId, 1, 'narration', 'DM',
              `${outcome.encounter.description} ${started.surpriseSummary}`]);
          io.to(`campaign:${campaignId}`).emit('game:narration', {
            actor: 'DM',
            content: `${outcome.encounter.description} ${started.surpriseSummary}`,
          });
          emitEncounterStart(io, campaignId, started);
          // ── Companion reaction: combat starting ──────────────────────────
          try {
            const startCompanions = getPartyCompanions(db, campaignId).filter((c) => c.joinedParty);
            const startReaction = getCompanionReaction('combat_start', startCompanions, character.name);
            if (startReaction) {
              run(db,
                'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
                [crypto.randomUUID(), campaignId, 1, 'narration', startReaction.companion.name, startReaction.line]);
              io.to(`campaign:${campaignId}`).emit('game:narration', {
                content: startReaction.line,
                actor: startReaction.companion.name,
              });
            }
          } catch {}
        }
      }
    });

    // ─── Combat Action ────────────────────────────────────────────────

    socket.on('game:combat_action', (data) => {
      const { campaignId, encounterId, action, targetId } = data;
      const player = connectedPlayers.get(socket.id);
      if (!player) return;

      // Combat actions are handled by the game route/engine
      // This socket event is just for real-time notification
      io.to(`campaign:${campaignId}`).emit('game:state_update', {
        type: 'combat_action_pending',
        payload: { playerId: player.playerId, action, targetId },
      });
    });

    // ─── Chat (out-of-character) ──────────────────────────────────────

    socket.on('game:chat', (data) => {
      const { campaignId, message } = data;
      const player = connectedPlayers.get(socket.id);
      if (!player) return;

      io.to(`campaign:${campaignId}`).emit('game:log_entry', {
        id: crypto.randomUUID(),
        campaignId,
        sessionNumber: 0,
        timestamp: new Date().toISOString(),
        type: 'system',
        actor: player.playerName,
        content: `[OOC] ${message}`,
      });
    });

    // ─── Leave Campaign ───────────────────────────────────────────────

    socket.on('game:leave', (data) => {
      const { campaignId } = data;
      const player = connectedPlayers.get(socket.id);
      if (!player) return;

      socket.leave(`campaign:${campaignId}`);
      socket.to(`campaign:${campaignId}`).emit('game:player_left', {
        playerId: player.playerId,
        playerName: player.playerName,
      });

      player.campaignId = null;
      console.log(`[Socket] ${player.playerName} left campaign ${campaignId}`);
    });

    // ─── Disconnect ───────────────────────────────────────────────────

    socket.on('disconnect', () => {
      const player = connectedPlayers.get(socket.id);
      if (player?.campaignId) {
        socket.to(`campaign:${player.campaignId}`).emit('game:player_left', {
          playerId: player.playerId,
          playerName: player.playerName,
        });
      }
      connectedPlayers.delete(socket.id);
      console.log(`[Socket] Client disconnected: ${socket.id}`);
    });
  });
}

/** Get list of players currently in a campaign */
export function getOnlinePlayers(campaignId: string): ConnectedPlayer[] {
  return Array.from(connectedPlayers.values()).filter(p => p.campaignId === campaignId);
}
