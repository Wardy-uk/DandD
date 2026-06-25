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
import { resolveRichExploration } from './game/adventure.js';
import { createEncounterRecord, describeBattlefield, emitEncounterStart, getActiveEncounter, resolveEncounterAction } from './game/encounters.js';
import { buildCampaignMapIntel } from './game/mapIntel.js';

interface ConnectedPlayer {
  socketId: string;
  playerId: string;
  playerName: string;
  campaignId: string | null;
}

const connectedPlayers = new Map<string, ConnectedPlayer>();

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
      }

      console.log(`[Socket] ${player.display_name || player.username} joined campaign ${campaignId}`);
    });

    // ─── Player Action (exploration/roleplay) ─────────────────────────

    socket.on('game:action', (data) => {
      const { campaignId, action } = data;
      const player = connectedPlayers.get(socket.id);
      if (!player) return;

      // Get player's character in this campaign
      const character = get(db,
        'SELECT * FROM characters WHERE campaign_id = ? AND player_id = ? AND status != "dead"',
        [campaignId, player.playerId]) as any;
      if (!character) return;

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
          type: 'map_update',
          payload: buildCampaignMapIntel(db, campaignId),
        });
        if (resolution.turnPrompt) {
          io.to(`campaign:${campaignId}`).emit('game:turn_prompt', resolution.turnPrompt);
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

        run(db, 'UPDATE campaigns SET current_scene_id = ? WHERE id = ?', [nextScene.id, campaignId]);
        run(db, 'UPDATE scenes SET visited = 1 WHERE id = ?', [nextScene.id]);

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
        return;
      }

      const npcsInScene = all(db,
        'SELECT * FROM npcs WHERE campaign_id = ? AND location_scene_id = ? AND alive = 1',
        [campaignId, scene.id]) as any[];
      const outcome = resolveRichExploration({
        db,
        campaignId,
        scene,
        character,
        npcs: npcsInScene,
        action,
        connections: JSON.parse(scene.connections || '[]'),
      });

      if (!outcome) {
        io.to(`campaign:${campaignId}`).emit('game:narration', {
          content: 'That action needs a little more specificity before the engine can resolve it. Try naming what you inspect, force, search, or attempt to negotiate with.',
          actor: 'DM',
        });
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
