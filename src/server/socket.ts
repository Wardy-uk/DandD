/**
 * Socket.IO handler for async multiplayer
 * Players can join/leave campaigns at any time.
 * Actions are broadcast to all connected players in the same campaign.
 */

import type { Server as SocketServer, Socket } from 'socket.io';
import type { Database } from 'sql.js';
import type { ServerToClientEvents, ClientToServerEvents } from '../shared/types.js';
import { get, all, run } from './db/helpers.js';
import { aiDirector } from './ai/director.js';
import { storyReactionPrompt, DM_SYSTEM_PROMPT } from './ai/prompts.js';

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

        // Send recent game log
        const recentLogs = all(db,
          'SELECT * FROM game_log WHERE campaign_id = ? ORDER BY timestamp DESC LIMIT 50',
          [campaignId]);
        socket.emit('game:state_update', { type: 'recent_logs', payload: recentLogs.reverse() });

        // If there's an active scene, send it
        if (campaign.current_scene_id) {
          const scene = get(db, 'SELECT * FROM scenes WHERE id = ?', [campaign.current_scene_id]) as any;
          if (scene) {
            socket.emit('game:scene_enter', {
              scene: {
                ...scene,
                connections: JSON.parse(scene.connections || '[]'),
              },
              description: scene.ai_description || scene.brief,
            });
          }
        }

        // If there's an active encounter, send it
        const encounter = get(db,
          'SELECT * FROM encounters WHERE campaign_id = ? AND status = "active"',
          [campaignId]) as any;
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

    socket.on('game:action', async (data) => {
      const { campaignId, action, details } = data;
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

      // Tell everyone the DM is thinking
      io.to(`campaign:${campaignId}`).emit('game:dm_thinking', {
        status: 'The DM considers your action...',
      });

      // Get context for the AI
      const campaign = get(db, 'SELECT * FROM campaigns WHERE id = ?', [campaignId]) as any;
      const scene = campaign?.current_scene_id
        ? get(db, 'SELECT * FROM scenes WHERE id = ?', [campaign.current_scene_id]) as any
        : null;
      const recentLogs = all(db,
        'SELECT content FROM game_log WHERE campaign_id = ? ORDER BY timestamp DESC LIMIT 10',
        [campaignId]) as any[];

      // Ask the AI DM to respond
      const prompt = storyReactionPrompt({
        playerAction: action,
        sceneContext: scene ? `${scene.name}: ${scene.brief}` : 'Unknown location',
        partyContext: `${character.name}, level ${character.level} ${character.race} ${character.char_class}`,
        recentEvents: recentLogs.map(l => l.content).reverse(),
        campaignSetting: campaign?.setting || 'A classic fantasy world',
      });

      aiDirector.enqueue({
        campaignId,
        type: 'story_react',
        priority: 1,
        prompt,
        callback: (result) => {
          // Log the DM response
          const dmLogId = crypto.randomUUID();
          run(db,
            'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
            [dmLogId, campaignId, 1, 'dm_response', 'DM', result]);

          // Broadcast to all players
          io.to(`campaign:${campaignId}`).emit('game:narration', {
            content: result,
            actor: 'DM',
          });

          io.to(`campaign:${campaignId}`).emit('game:log_entry', {
            id: dmLogId,
            campaignId,
            sessionNumber: 1,
            timestamp: new Date().toISOString(),
            type: 'dm_response',
            actor: 'DM',
            content: result,
          });
        },
      });
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
