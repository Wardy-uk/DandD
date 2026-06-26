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
import { resolveStarterSetPiece } from './game/starterPacks.js';

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

          // ── A: Combat aftermath narration (async, fire-and-forget) ────────
          (async () => {
            try {
              const afterScene = get(db, 'SELECT * FROM scenes WHERE id = ?', [campaign.current_scene_id]) as any;
              const afterBlueprint = afterScene ? buildSceneBlueprint(afterScene) : null;
              const hpPct = character.max_hp > 0 ? character.hp / character.max_hp : 1;
              const cost = hpPct <= 0.25 ? 'badly wounded, barely on their feet'
                : hpPct <= 0.5 ? 'bloodied and bruised'
                : hpPct <= 0.75 ? 'shaken but functional'
                : 'relatively intact';
              const killedEnemies = resolution.combatResults
                .filter((r: any) => r.defenderKilled)
                .map((r: any) => r.defender)
                .filter(Boolean)
                .slice(0, 3)
                .join(', ');
              const afterContext = [
                `Scene: ${afterScene?.name || 'the dungeon'}`,
                afterBlueprint ? `Atmosphere: ${afterBlueprint.roomAmbience}` : '',
                killedEnemies ? `Defeated: ${killedEnemies}` : 'The enemy is defeated',
                `Survivor: ${character.name} (${character.char_class}), condition: ${cost} (${character.hp}/${character.max_hp} HP)`,
              ].filter(Boolean).join('. ');
              const afterNarration = await Promise.race([
                generate({
                  system: `You are a masterful AD&D Dungeon Master narrating the immediate aftermath of a fight. 3-4 sentences, vivid present tense. Think Witcher 3 — specific, atmospheric, the silence after violence.
Rules:
- Begin with the sudden quiet after the last enemy falls, or the last blow landing
- Describe something concrete: what the body looks like, what the room smells like now, what the light reveals
- Note the physical cost — what the survivor carries out of this moment
- End on something that pulls forward: a sound, a shape, a reason to keep moving or to be afraid
- Voice: unflinching and specific, no sentiment`,
                  prompt: `${afterContext}.\nDescribe the immediate aftermath of this fight.`,
                  maxTokens: 280,
                  temperature: 0.85,
                }),
                new Promise<string>((_, reject) => setTimeout(() => reject(new Error('aftermath timeout')), 12_000)),
              ]) as string;
              if (afterNarration?.trim()) {
                run(db, 'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
                  [crypto.randomUUID(), campaignId, 1, 'narration', 'DM', afterNarration.trim()]);
                io.to(`campaign:${campaignId}`).emit('game:narration', { content: afterNarration.trim(), actor: 'DM' });
              }
            } catch {}
          })();
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
        const campRow = get(db, 'SELECT dominant_faction, current_scene_id FROM campaigns WHERE id = ?', [campaignId]) as any;
        const sceneFactionRow = campRow?.current_scene_id
          ? get(db, 'SELECT dominant_faction FROM scenes WHERE id = ?', [campRow.current_scene_id]) as any
          : null;
        const parleyFactionKey = sceneFactionRow?.dominant_faction || campRow?.dominant_faction || 'locals';
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
        try {
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
        // Surface rival encounters as interactive events
        if (rivalPresence.rivals.length > 0) {
          for (const rival of rivalPresence.rivals) {
            io.to(`campaign:${campaignId}`).emit('game:rival_encounter', {
              rivalId: rival.id,
              rivalName: rival.name,
              rivalSize: rival.size,
              rivalRelation: rival.relation,
              rivalStrength: rival.strength,
              leaderName: character.name,
            });
          }
        }

        // ── Faction patrol check on scene entry ─────────────────────────
        const campaignRowFaction = get(db, 'SELECT dominant_faction, exploration_turn FROM campaigns WHERE id = ?', [campaignId]) as any;
        const sceneFactionRow = get(db, 'SELECT dominant_faction FROM scenes WHERE id = ?', [nextScene.id]) as any;
        const sceneFactionKey = sceneFactionRow?.dominant_faction || campaignRowFaction?.dominant_faction || 'locals';
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

        const starterSetPieceNotes = resolveStarterSetPiece({ db, campaignId, sceneId: nextScene.id });
        for (const note of starterSetPieceNotes) {
          run(db, 'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
            [crypto.randomUUID(), campaignId, 1, 'narration', 'DM', note]);
          io.to(`campaign:${campaignId}`).emit('game:narration', { actor: 'DM', content: note });
        }
        if (starterSetPieceNotes.length > 0) {
          emitCampaignState(io, db, campaignId);
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

        // ── B: Scene-specific contextual action chips ────────────────────────
        try {
          const sceneActBlueprint = buildSceneBlueprint(nextScene);
          const ctxActions: Array<{ label: string; action: string; hint: string }> = [];
          // Exits first — most likely immediate action
          connections.forEach((c: any) => {
            ctxActions.push({ label: `Go ${c.direction}`, action: `I go ${c.direction}`, hint: c.description || `Head ${c.direction}` });
          });
          // NPCs present
          npcsInScene.slice(0, 2).forEach((npc: any) => {
            ctxActions.push({ label: `Speak to ${npc.name}`, action: `I speak to ${npc.name}`, hint: String(npc.personality || 'Approach and talk').slice(0, 60) });
          });
          // Room-specific affordances from blueprint
          if (sceneActBlueprint.roomSpecificFind) {
            ctxActions.push({ label: 'Examine the find', action: `I examine it: ${sceneActBlueprint.roomSpecificFind}`, hint: sceneActBlueprint.roomSpecificFind.slice(0, 60) });
          }
          if (sceneActBlueprint.tracks) {
            ctxActions.push({ label: 'Read the signs', action: 'I read the signs and tracks carefully', hint: sceneActBlueprint.tracks.slice(0, 60) });
          }
          if (sceneActBlueprint.clue) {
            ctxActions.push({ label: 'Investigate', action: `I investigate what I can see`, hint: sceneActBlueprint.clue.slice(0, 60) });
          }
          if (sceneActBlueprint.trap.kind && sceneActBlueprint.trap.kind !== 'none' && sceneActBlueprint.trap.kind !== 'None') {
            ctxActions.push({ label: 'Check for traps', action: 'I probe ahead carefully for traps', hint: `Something feels wrong here` });
          }
          if (sceneActBlueprint.obstacle && sceneActBlueprint.obstacle !== 'none' && sceneActBlueprint.obstacle !== 'None') {
            ctxActions.push({ label: 'Study the obstacle', action: `I study ${sceneActBlueprint.obstacle} carefully`, hint: 'Look for weaknesses or a way through' });
          }
          if (sceneActBlueprint.lock.kind && sceneActBlueprint.lock.kind !== 'none' && sceneActBlueprint.lock.kind !== 'None') {
            ctxActions.push({ label: 'Pick the lock', action: `I attempt to pick ${sceneActBlueprint.lock.kind}`, hint: 'Delicate work' });
          }
          // Always available
          ctxActions.push({ label: 'Look around', action: 'Look around', hint: 'Survey your surroundings' });
          ctxActions.push({ label: 'Listen carefully', action: 'Listen carefully', hint: 'What moves in the dark?' });
          io.to(`campaign:${campaignId}`).emit('game:scene_actions', { actions: ctxActions.slice(0, 9) });
        } catch {}

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

        // ── Cinematic entry narration for first-time rooms (async, fire-and-forget) ──
        if (wasUnvisited) {
          (async () => {
            try {
              io.to(`campaign:${campaignId}`).emit('game:narration', { content: '…', actor: 'DM', thinking: true });
              const entryBlueprint = buildSceneBlueprint(nextScene);
              const entryContext = [
                `Room: ${nextScene.name}${nextScene.brief ? ` — ${nextScene.brief}` : ''}`,
                `Atmosphere: ${entryBlueprint.roomAmbience}`,
                entryBlueprint.clue ? `Detail visible: ${entryBlueprint.clue}` : '',
                entryBlueprint.tracks ? `Signs of activity: ${entryBlueprint.tracks}` : '',
                `Hazard type: ${entryBlueprint.trap.kind}`,
                `Light: ${nextScene.light_level || 'normal'}`,
                `Exits: ${JSON.parse(nextScene.connections || '[]').filter((c: any) => !c.hidden).map((c: any) => c.direction).join(', ') || 'none'}`,
                npcsInScene.length > 0 ? `Occupants: ${npcsInScene.map((n: any) => n.name).join(', ')}` : '',
                `Party: ${character.name} (${character.char_class} level ${character.level})`,
              ].filter(Boolean);
              const entryNarration = await Promise.race([
                generate({
                  system: `You are a masterful AD&D Dungeon Master describing a room the party has never entered before. Write 4-6 immersive sentences. Think Witcher 3 — specific, atmospheric, alive with texture and unease.
Rules:
- Begin mid-sensation or with a concrete sensory detail — NOT "you enter" or "you step into"
- Flood the senses: the cold, the smell of rot or stone, how sound moves in this space, what the light picks out
- Name specific architectural features, stains, damage, objects, marks left by previous occupants
- Hint at history — what happened here, what lived here, how long ago
- Plant one anomaly or detail that begs investigation: a shape in shadow, a sound that should not be, a surface worn wrong
- Never open with "The chamber opens up" or "You find yourself"
- Voice: baroque and strange, as if the dungeon itself has opinions`,
                  prompt: `${entryContext.join('. ')}.\nDescribe the party entering this room for the first time.`,
                  maxTokens: 380,
                  temperature: 0.88,
                }),
                new Promise<string>((_, reject) => setTimeout(() => reject(new Error('entry AI timeout')), 14_000)),
              ]) as string;
              if (entryNarration?.trim()) {
                run(db, 'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
                  [crypto.randomUUID(), campaignId, 1, 'narration', 'DM', entryNarration.trim()]);
                io.to(`campaign:${campaignId}`).emit('game:narration', { content: entryNarration.trim(), actor: 'DM' });
              }
            } catch { io.to(`campaign:${campaignId}`).emit('game:narration', { content: '', actor: 'DM' }); }
          })();
        }

        return;
        } catch (moveErr) {
          console.error('[movement handler error]', moveErr);
          io.to(`campaign:${campaignId}`).emit('game:narration', {
            actor: 'DM',
            content: `The way ${movementTarget.direction} is passable — but something went wrong in the passage. Try again.`,
          });
          emitCampaignState(io, db, campaignId);
          return;
        }
      }
      // ── Orientation queries — any question asking "where am I / what do I see" ─
      // Note: "look around" intentionally excluded here — resolveRichExploration handles it with variety
      const isOrientationQuery = /(where\s+(am\s+i|are\s+we)|what\s+(is|'?s|are)\s+(this\s+place|this\s+room|here)|what\s+(do\s+i|can\s+i)\s+see|what'?s\s+(here|around\s+(me|us))|describe\s+(this\s+place|the\s+room|where\s+(i\s+am|we\s+are))|tell\s+me\s+about\s+this\s+place)/i.test(action);
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
        const companions = getPartyCompanions(db, campaignId).filter((c: any) => c.joinedParty);
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

      // ── Movement intent with no matching exit (prevents AI freeze on "go north") ──
      if (!outcome) {
        const movementMatch = /^(?:go|head|move|walk|travel|march|proceed|i\s+(?:go|head|move))\s+(\w+)/i.exec(action.trim());
        if (movementMatch) {
          const triedDir = movementMatch[1].toLowerCase();
          const availableExits = (JSON.parse(scene.connections || '[]') as any[])
            .filter((c) => !c.hidden)
            .map((c) => c.direction);
          if (availableExits.length > 0) {
            const noExitMsg = `No way ${triedDir} from ${scene.name}. You can go: ${availableExits.join(', ')}.`;
            run(db, 'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
              [crypto.randomUUID(), campaignId, 1, 'narration', 'DM', noExitMsg]);
            io.to(`campaign:${campaignId}`).emit('game:narration', { actor: 'DM', content: noExitMsg });
            emitCampaignState(io, db, campaignId);
            return;
          }
        }
      }

      if (!outcome) {
        // ── B: Spell resolution — mechanical handling for cast actions ──────────
        const spellCastMatch = /^(?:i\s+)?(?:cast|invoke|channel|use)\s+(?:the\s+spell\s+)?(.+?)(?:\s+(?:at|on|upon|targeting|into|to)\s+.+)?$/i.exec(action.trim());
        if (spellCastMatch) {
          const spellName = spellCastMatch[1].trim();
          // Spell table: name pattern → { brief description, dice, school }
          const SPELL_TABLE: Record<string, { desc: string; heal?: { dice: number; sides: number; bonus: number }; isHeal?: boolean }> = {
            'cure light wounds':    { desc: 'Channels divine energy to close wounds', heal: { dice: 1, sides: 8, bonus: 0 }, isHeal: true },
            'cure serious wounds':  { desc: 'A deeper healing that knits bone and tissue', heal: { dice: 2, sides: 8, bonus: 1 }, isHeal: true },
            'cure critical wounds': { desc: 'A surge of divine power that reverses grievous harm', heal: { dice: 3, sides: 8, bonus: 3 }, isHeal: true },
            'magic missile':  { desc: '1d4+1 force damage, auto-hits, no save' },
            'sleep':          { desc: 'Drops 2d4 HD of creatures into magical slumber, lowest HD first, no save' },
            'charm person':   { desc: 'Target sees caster as trusted friend — save vs spell negates' },
            'shield':         { desc: 'Magical barrier: AC 2 vs melee, AC 4 vs missiles until dispelled' },
            'detect magic':   { desc: 'Reveals magical auras in a 10×60 ft path for 2 turns' },
            'light':          { desc: 'Creates a 20 ft globe of torchlight, duration 6 turns/level' },
            'read magic':     { desc: 'Deciphers magical inscriptions and scrolls for 2 rounds/level' },
            'hold portal':    { desc: 'Seals a door or gate as if locked for 1 round/level' },
            'fireball':       { desc: '1d6 fire damage per caster level in 20 ft radius, save vs spell for half' },
            'lightning bolt': { desc: '1d6 lightning per caster level in a line, save vs spell for half' },
            'web':            { desc: 'Sticky webs fill area, entangling all within for 2 turns/level' },
            'invisibility':   { desc: 'Caster becomes invisible until they attack or cast another spell' },
            'fly':            { desc: 'Grants flight at movement rate 18 for 1 turn/level' },
            'knock':          { desc: 'Opens any stuck, locked, or magically held door or container' },
            'bless':          { desc: '+1 to hit and saves vs fear for all allies within 50 ft, 6 turns' },
            'detect evil':    { desc: 'Reveals evil auras and intentions in a 10×120 ft path, 1 turn/level' },
            'find traps':     { desc: 'Reveals all traps — mechanical and magical — within 30 ft, 3 turns' },
            'silence':        { desc: 'No sound in a 15 ft radius around target for 2 rounds/level' },
            'slow poison':    { desc: 'Delays poison effects until cured or Slow Poison expires, 1 hour/level' },
            'protection from evil': { desc: '+2 AC and saves vs evil; blocks bodily contact from summoned creatures, 2 rounds/level' },
            'sanctuary':      { desc: 'Enemies save vs spell to attack you; broken if you attack, 1 round/level' },
            'spiritual hammer': { desc: 'Magic hammer attacks at THAC0 level for 1d4+1 damage, 1 round/level' },
          };
          const spellKey = spellName.toLowerCase().replace(/\s+/g, ' ');
          const matchedSpell = Object.entries(SPELL_TABLE).find(([k]) => spellKey.includes(k));

          if (matchedSpell) {
            const [matchedName, spellDef] = matchedSpell;
            actionLocks.add(campaignId);
            io.to(`campaign:${campaignId}`).emit('game:narration', { content: '…', actor: 'DM', thinking: true });
            try {
              let mechanicalNote = '';
              let hpRestored = 0;

              if (spellDef.isHeal && spellDef.heal) {
                // Roll healing
                let total = spellDef.heal.bonus;
                for (let d = 0; d < spellDef.heal.dice; d++) total += Math.ceil(Math.random() * spellDef.heal.sides);
                hpRestored = Math.min(character.max_hp - character.hp, total);
                if (hpRestored > 0) {
                  run(db, 'UPDATE characters SET hp = MIN(max_hp, hp + ?) WHERE id = ?', [hpRestored, character.id]);
                  const updChar = get(db, 'SELECT * FROM characters WHERE id = ?', [character.id]) as any;
                  if (updChar) io.to(`campaign:${campaignId}`).emit('game:state_update', { type: 'character_update', payload: updChar });
                }
                mechanicalNote = `Rolled ${total} healing; ${hpRestored > 0 ? `${hpRestored} HP restored (${character.hp + hpRestored}/${character.max_hp})` : 'already at full HP'}`;
              } else {
                mechanicalNote = `Effect: ${spellDef.desc}`;
              }

              const spellContext = [
                `Scene: ${scene.name}${scene.brief ? ` — ${scene.brief}` : ''}`,
                `Character: ${character.name} (${character.char_class} level ${character.level})`,
                `Spell: ${spellName}`,
                `Mechanical result: ${mechanicalNote}`,
                `Scene light: ${scene.light_level || 'normal'}`,
              ].join('. ');

              const spellNarration = await Promise.race([
                generate({
                  system: `You are a masterful AD&D Dungeon Master narrating a spell being cast. 3-4 vivid sentences, present tense.
Rules:
- Describe the casting: the words, gestures, what the magic looks and feels like in this specific room
- Incorporate the mechanical result naturally — healing spells close wounds, light spells fill the room, utility spells change something tangible
- Do not list game statistics; the effect should be felt, not stated
- Voice: specific, atmospheric, the magic feels real and earned`,
                  prompt: `${spellContext}.\nPlayer action: "${action}". Narrate the spell and its effect.`,
                  maxTokens: 260,
                  temperature: 0.85,
                }),
                new Promise<string>((_, reject) => setTimeout(() => reject(new Error('spell timeout')), 12_000)),
              ]) as string;

              if (spellNarration?.trim()) {
                run(db, 'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
                  [crypto.randomUUID(), campaignId, 1, 'narration', 'DM', spellNarration.trim()]);
                io.to(`campaign:${campaignId}`).emit('game:narration', { content: spellNarration.trim(), actor: 'DM' });
              }
              // Ignore matchedName lint warning — used for key lookup above
              void matchedName;
            } catch {
              io.to(`campaign:${campaignId}`).emit('game:narration', { content: `The words of ${spellName} take shape. Something in the air responds.`, actor: 'DM' });
            } finally {
              actionLocks.delete(campaignId);
            }
            emitCampaignState(io, db, campaignId);
            return;
          }
        }

        // ── C: NPC voice — directed speech at a named NPC ───────────────────
        const npcVoiceTarget = npcsInScene.find((npc: any) => {
          const npcLower = String(npc.name || '').toLowerCase();
          return npcLower.length > 2 && action.toLowerCase().includes(npcLower)
            && /\b(talk|speak|ask|address|say|tell|question|greet|approach|i talk|i speak|i ask|what does|converse)\b/i.test(action);
        });
        if (npcVoiceTarget) {
          actionLocks.add(campaignId);
          io.to(`campaign:${campaignId}`).emit('game:narration', { content: '…', actor: 'DM', thinking: true });
          try {
            const npcRelation = (() => {
              try { return JSON.parse(npcVoiceTarget.relationship_state || '{}'); } catch { return {}; }
            })();
            const trust = npcRelation.trust ?? 5;
            const bond = npcRelation.bond ?? 0;
            const tension = npcRelation.tension ?? 0;
            const relDesc = bond >= 3 ? 'a trusted ally' : tension >= 3 ? 'uneasy, friction between you' : trust >= 6 ? 'cautiously open' : 'a stranger';
            const npcContext = [
              `NPC: ${npcVoiceTarget.name} (${npcVoiceTarget.race || ''} ${npcVoiceTarget.char_class || ''})`.trim(),
              `Personality: ${npcVoiceTarget.personality || 'guarded and watchful'}`,
              `Disposition: ${npcVoiceTarget.disposition || 'neutral'}`,
              `Faction affiliation: ${npcVoiceTarget.faction || 'none declared'}`,
              `Relationship with ${character.name}: ${relDesc}`,
              `Scene: ${scene.name}${scene.brief ? ` — ${scene.brief}` : ''}`,
              `Situation: exploration phase, no active encounter`,
            ].filter(Boolean).join('. ');
            const npcNarrationPromise = generate({
              system: `You are roleplaying as a specific NPC in an AD&D dungeon. Respond in their voice — direct speech plus brief action beats. 2-4 sentences total.
Rules:
- Stay completely in character; speak AS the NPC, first person
- Let their personality and disposition shape every word — a hostile NPC is hostile, a cagey one deflects
- React to the specific question or statement being directed at them
- Include one small physical action or tell (a look, a gesture, a pause) to make them feel present
- Do not summarise or narrate in third person
- Keep it tight — NPCs speak, they don't monologue`,
              prompt: `${npcContext}.\nPlayer says to ${npcVoiceTarget.name}: "${action}"\nRespond as ${npcVoiceTarget.name}.`,
              maxTokens: 200,
              temperature: 0.88,
            });
            const npcTimeoutPromise = new Promise<string>((_, reject) =>
              setTimeout(() => reject(new Error('npc voice timeout')), 12_000));
            const npcResponse = (await Promise.race([npcNarrationPromise, npcTimeoutPromise])).trim();
            if (npcResponse) {
              run(db, 'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
                [crypto.randomUUID(), campaignId, 1, 'narration', npcVoiceTarget.name, npcResponse]);
              io.to(`campaign:${campaignId}`).emit('game:narration', { content: npcResponse, actor: npcVoiceTarget.name });
            }
          } catch {
            io.to(`campaign:${campaignId}`).emit('game:narration', {
              content: `${npcVoiceTarget.name} regards you for a moment but says nothing.`,
              actor: 'DM',
            });
          } finally {
            actionLocks.delete(campaignId);
          }
          emitCampaignState(io, db, campaignId);
          return;
        }

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
          const aiGeneratePromise = generate({
            system: `You are a masterful AD&D Dungeon Master narrating in vivid present tense. Write 4-6 rich, immersive sentences. Think Witcher 3 storytelling in D&D form — specific textures, smells, sounds, consequences that land with weight.
Rules:
- Address the player as "you" or by their character name (${character.name})
- Flood the senses: name specific objects, materials, sounds, smells, temperature. Never be vague
- Show consequence and stakes — what shifted, what was risked, what the world did in response
- Never say "nothing happens" or "the moment passes"
- Never open with "The party" or "You find yourself"
- If the action fails, describe the cost vividly — pain, noise, wasted time, something stirred in the dark
- NPCs react with genuine personality, not script; they have their own read on what just happened
- End on tension or forward pull — there is always more lurking, always a reason to push deeper
- Voice: atmospheric and specific, like a DM who finds this world genuinely strange and still surprising`,
            prompt: `${contextParts.join('. ')}.\n${(getCampaignState(db, campaignId)?.recentEvents || []).slice(-3).filter(Boolean).length > 0 ? `Recent events: ${(getCampaignState(db, campaignId)?.recentEvents || []).slice(-3).filter(Boolean).join('; ')}.` : ''}\nPlayer action: "${action}". Narrate the outcome with full sensory immersion.`,
            maxTokens: 420,
            temperature: 0.82,
          });
          // Hard 12-second timeout — prevents Ollama latency from freezing the game
          const aiTimeoutPromise = new Promise<string>((_, reject) =>
            setTimeout(() => reject(new Error('AI timeout')), 12_000));
          aiMsg = (await Promise.race([aiGeneratePromise, aiTimeoutPromise])).trim() || aiMsg;
        } catch (aiErr) {
          console.error('[AI fallback error]', aiErr);
          // Ollama unreachable or timed out — still give something real
          aiMsg = `${aiBlueprint.roomAmbience} The attempt registers. The room shifts, just slightly.`;
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

      // ── A: Loot description — give found items a voice (async, fire-and-forget) ──
      const lootFindMatch = /reveals?\s+(.+?),\s+along with|you also recover\s+(.+?),\s+enough/i.exec(outcome.content);
      if (lootFindMatch) {
        const foundItem = (lootFindMatch[1] || lootFindMatch[2] || '').trim();
        if (foundItem) {
          (async () => {
            try {
              const lootBlueprint = buildSceneBlueprint(scene);
              const lootNarration = await Promise.race([
                generate({
                  system: `You are a masterful AD&D Dungeon Master giving a found object its moment. Exactly 2 sentences.
Rules:
- Describe physical details: material, weight, condition, marks, smell, temperature
- Imply history — who owned it, how long it has been here, what it witnessed
- No game statistics, no "you find", no mechanical language
- Voice: specific, weighted, atmospheric`,
                  prompt: `Room: ${scene.name} — ${lootBlueprint.roomAmbience}. Found: "${foundItem}". Describe this object.`,
                  maxTokens: 110,
                  temperature: 0.9,
                }),
                new Promise<string>((_, reject) => setTimeout(() => reject(new Error('loot timeout')), 10_000)),
              ]) as string;
              if (lootNarration?.trim()) {
                run(db, 'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
                  [crypto.randomUUID(), campaignId, 1, 'narration', 'DM', lootNarration.trim()]);
                io.to(`campaign:${campaignId}`).emit('game:narration', { content: lootNarration.trim(), actor: 'DM' });
              }
            } catch {}
          })();
        }
      }

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

        // HP recovery at camp — only in safe-camp scenes
        try {
          const sceneStateRow = get(db, 'SELECT state_json FROM scene_state WHERE scene_id = ? AND campaign_id = ?', [scene.id, campaignId]) as any;
          const sceneRoomState = sceneStateRow ? JSON.parse(sceneStateRow.state_json || '{}') : {};
          if (sceneRoomState.safeCamp) {
            const campQ = delveState.delve.campQuality;
            const restoreRatio = campQ === 'fortified' ? 0.5 : campQ === 'good' ? 0.33 : campQ === 'adequate' ? 0.15 : 0;
            if (restoreRatio > 0 && character.id) {
              const maxHp = Number(character.max_hp);
              const restore = Math.min(maxHp - Number(character.hp), Math.floor(maxHp * restoreRatio));
              if (restore > 0) {
                run(db, 'UPDATE characters SET hp = MIN(max_hp, hp + ?) WHERE id = ?', [restore, character.id]);
                const updChar = get(db, 'SELECT * FROM characters WHERE id = ?', [character.id]) as any;
                if (updChar) io.to(`campaign:${campaignId}`).emit('game:state_update', { type: 'character_update', payload: updChar });
                const restNote = campQ === 'fortified'
                  ? `Proper rest in a secured position. ${character.name} recovers ${restore} hit point${restore === 1 ? '' : 's'}.`
                  : `The rest helps. ${character.name} recovers ${restore} hit point${restore === 1 ? '' : 's'}.`;
                run(db, 'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
                  [crypto.randomUUID(), campaignId, 1, 'narration', 'DM', restNote]);
                io.to(`campaign:${campaignId}`).emit('game:narration', { actor: 'DM', content: restNote });
              }
              // Companions also recover
              const joinedNpcs = all(db, 'SELECT id, hp, max_hp FROM npcs WHERE campaign_id = ? AND joined_party = 1 AND alive = 1', [campaignId]) as any[];
              for (const npc of joinedNpcs) {
                const npcRestore = Math.min(Number(npc.max_hp) - Number(npc.hp), Math.floor(Number(npc.max_hp) * restoreRatio));
                if (npcRestore > 0) run(db, 'UPDATE npcs SET hp = MIN(max_hp, hp + ?) WHERE id = ?', [npcRestore, npc.id]);
              }
            }
          }
        } catch {}

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
      // ── Async atmospheric expansion — adds sensory depth to short outcomes ──
      if (outcome.content.length < 200) {
        (async () => {
          try {
            const expBlueprint = buildSceneBlueprint(scene);
            const recentCtx = (getCampaignState(db, campaignId).recentEvents || []).slice(-3).filter(Boolean).join('; ');
            const expansionNarration = await Promise.race([
              generate({
                system: `You are a masterful AD&D Dungeon Master adding atmospheric depth to a moment. Write exactly 2-3 sentences.
Rules:
- Do NOT repeat what was just narrated — add what follows in the senses
- Specific: a texture, a smell, a sound, a temperature shift, a weight in the gut
- Show consequence: what shifted in the world, what the character notices in their body
- End on forward pull — a detail that hangs in the air, unexplained
- Voice: Witcher 3 — strange, weighted, specific
- No cheerful language. This dungeon is indifferent at best`,
                prompt: `Scene: ${scene.name}. ${expBlueprint.roomAmbience}
Character: ${character.name} (${character.char_class}, ${character.hp}/${character.max_hp} HP)
${recentCtx ? `Recent events: ${recentCtx}` : ''}
Action: "${action}"
What just happened: "${outcome.content}"
Add 2-3 sentences of sensory depth and consequence. Do not repeat the above — extend it.`,
                maxTokens: 140,
                temperature: 0.88,
              }),
              new Promise<string>((_, reject) => setTimeout(() => reject(new Error('expansion timeout')), 10_000)),
            ]) as string;
            if (expansionNarration?.trim()) {
              run(db, 'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
                [crypto.randomUUID(), campaignId, 1, 'narration', 'DM', expansionNarration.trim()]);
              io.to(`campaign:${campaignId}`).emit('game:narration', { content: expansionNarration.trim(), actor: 'DM' });
            }
          } catch {}
        })();
      }
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

      // ── World pulse — ambient dungeon observation, 1-in-8 chance ─────────
      if (Math.floor(Math.random() * 8) === 0 && !outcome.encounter) {
        (async () => {
          try {
            await new Promise((r) => setTimeout(r, 16_000));
            const pulseBlueprint = buildSceneBlueprint(scene);
            const pulseNarration = await Promise.race([
              generate({
                system: `You are a masterful AD&D DM adding an unprompted ambient observation. Write exactly 2 sentences.
Rules:
- Something in the environment shifts — a sound, a smell, a light change, movement in shadow
- The party didn't cause it. The dungeon just... does something
- Do NOT say what it means or suggest what to do
- Voice: quiet, ominous, specific — like the dungeon breathing`,
                prompt: `Scene: ${scene.name}. ${pulseBlueprint.roomAmbience}. ${pulseBlueprint.themePressure || ''}
Describe one unprompted environmental detail or ambient change the party notices.`,
                maxTokens: 90,
                temperature: 0.92,
              }),
              new Promise<string>((_, reject) => setTimeout(() => reject(new Error('pulse timeout')), 12_000)),
            ]) as string;
            if (pulseNarration?.trim()) {
              run(db, 'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
                [crypto.randomUUID(), campaignId, 1, 'narration', 'DM', pulseNarration.trim()]);
              io.to(`campaign:${campaignId}`).emit('game:narration', { content: pulseNarration.trim(), actor: 'DM' });
            }
          } catch {}
        })();
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

    // ─── Rival encounter resolution ───────────────────────────────────

    socket.on('game:rival_resolve', (data: { campaignId: string; rivalId: string; choice: string }) => {
      try {
        const { campaignId, rivalId, choice } = data;
        const leaderChar = get(db,
          'SELECT name FROM characters WHERE campaign_id = ? AND status = "active" LIMIT 1',
          [campaignId]) as any;
        const companions = getPartyCompanions(db, campaignId).filter((c: any) => c.joinedParty);
        const partyStrength = companions.length + 2; // PC + party size
        const validChoice = ['fight', 'parley', 'intimidate', 'ignore', 'request_intel'].includes(choice)
          ? choice as 'fight' | 'parley' | 'intimidate' | 'ignore' | 'request_intel'
          : 'ignore';

        const result = resolveRivalClash({
          db, campaignId, rivalId,
          partyStrength,
          leaderName: leaderChar?.name || 'the party',
          clashType: validChoice,
        });

        for (const note of result.notes) {
          run(db, 'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
            [crypto.randomUUID(), campaignId, 1, 'narration', 'DM', note]);
          io.to(`campaign:${campaignId}`).emit('game:narration', { actor: 'DM', content: note });
        }
        io.to(`campaign:${campaignId}`).emit('game:rival_resolved', {
          rivalId,
          rivalName: result.rival?.name,
        });
        emitCampaignState(io, db, campaignId);
      } catch (e) {
        console.error('[game:rival_resolve error]', e);
      }
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
