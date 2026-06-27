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
import { generate, generateStream } from './ai/ollama.js';
import { aiDirector } from './ai/director.js';
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
// NPC conversation memory: campaignId → npcName → last 3 exchanges
const npcConversationMemory = new Map<string, Map<string, string[]>>();

/** Pick the best companion to speak for a given trigger. Returns null if no companions joined. */
function pickCompanionForTrigger(companions: any[], preferredRole?: string): any | null {
  const joined = companions.filter((c: any) => c.joinedParty);
  if (joined.length === 0) return null;
  if (preferredRole) {
    const match = joined.find((c: any) => c.companionRole === preferredRole);
    if (match) return match;
  }
  return joined.reduce((best: any, c: any) =>
    c.relationship?.morale > best.relationship?.morale ? c : best, joined[0]);
}

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
            {
              const joinDesc = describeScene({ scene, npcs: npcsInScene, party: characters });
              // Only include description if it's not already the most recent scene entry in the log
              // (prevents duplicate on reconnect — recent_logs already shows it)
              const lastSceneLog = recentLogs.find(
                (l: any) => l.type === 'scene_enter' && l.content === joinDesc
              );
              socket.emit('game:scene_enter', {
                scene: {
                  ...scene,
                  connections: JSON.parse(scene.connections || '[]').filter((entry: any) => !entry.hidden),
                },
                description: lastSceneLog ? '' : joinDesc,
              });
            }
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
            // ── AI dawn narration: atmospheric version of the overnight briefing ──
            aiDirector.enqueue({
              campaignId,
              type: 'scene',
              priority: 3,
              temperature: 0.88,
              system: `You are a masterful AD&D DM opening a new session after overnight events. Write exactly 2-3 sentences.
Rules:
- Describe the specific quality of this new watch or morning in the dungeon — not generic dawn, but something sensory and specific to the underground
- Weave in one concrete detail from the overnight events that the party would actually perceive
- Let the world show rather than tell what changed — no direct exposition
- Voice: atmospheric, quiet, specific. Like the first paragraph of a new chapter.`,
              prompt: `Overnight events summary: ${dawnSummary}
Open the session with a brief atmospheric narration of what this new watch feels like.`,
              callback: (aiDawn) => {
                if (aiDawn?.trim() && !aiDawn.startsWith('[The DM pauses')) {
                  run(db, 'INSERT INTO game_log (id, campaign_id, type, actor, content) VALUES (?, ?, ?, ?, ?)',
                    [crypto.randomUUID(), campaignId, 'narration', 'DM', aiDawn.trim()]);
                  socket.emit('game:narration', { actor: 'DM', content: aiDawn.trim() });
                }
              },
            });
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

      // ── D: emitSceneActions — regenerate contextual action chips ─────────
      function emitSceneActions(
        targetScene: any,
        targetNpcs: any[],
        targetConnections: any[],
        context: 'post_combat' | 'post_loot' | 'movement' | 'default' = 'default',
      ) {
        try {
          const sceneActBlueprint = buildSceneBlueprint(targetScene);
          const ctxActions: Array<{ label: string; action: string; hint: string }> = [];

          // Context-specific priority chips
          if (context === 'post_combat') {
            ctxActions.push({ label: 'Search the bodies', action: 'I search the bodies', hint: 'Strip the fallen of anything useful' });
            ctxActions.push({ label: 'Tend wounds', action: 'I tend to my wounds', hint: 'Bind injuries before moving on' });
            ctxActions.push({ label: 'Listen for more', action: 'Listen carefully', hint: 'Is there anything else coming?' });
          } else if (context === 'post_loot') {
            ctxActions.push({ label: 'Examine the find', action: 'I examine what I found', hint: 'Look it over properly' });
          }

          targetConnections.forEach((c: any) => {
            ctxActions.push({ label: `Go ${c.direction}`, action: `I go ${c.direction}`, hint: c.description || `Head ${c.direction}` });
          });
          targetNpcs.slice(0, 2).forEach((npc: any) => {
            ctxActions.push({ label: `Speak to ${npc.name}`, action: `I speak to ${npc.name}`, hint: String(npc.personality || 'Approach and talk').slice(0, 60) });
          });
          if (context !== 'post_loot' && sceneActBlueprint.roomSpecificFind) {
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
          if (context !== 'post_combat') {
            ctxActions.push({ label: 'Look around', action: 'Look around', hint: 'Survey your surroundings' });
            ctxActions.push({ label: 'Listen carefully', action: 'Listen carefully', hint: 'What moves in the dark?' });
          }
          io.to(`campaign:${campaignId}`).emit('game:scene_actions', { actions: ctxActions.slice(0, 9) });
        } catch {}
      }

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

        let expansionsThisRound = 0;
        for (const note of resolution.narration) {
          run(db,
            'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
            [crypto.randomUUID(), campaignId, 1, 'narration', note.actor, note.content]);
          io.to(`campaign:${campaignId}`).emit('game:narration', note);
          if (note.content.length < 120 && expansionsThisRound < 2) {
            expansionsThisRound++;
            const combatScene = campaign.current_scene_id
              ? get(db, 'SELECT * FROM scenes WHERE id = ?', [campaign.current_scene_id]) as any
              : null;
            const combatBlueprint = combatScene ? buildSceneBlueprint(combatScene) : null;
            aiDirector.enqueue({
              campaignId,
              type: 'combat_narration',
              priority: 4,
              temperature: 0.85,
              system: `You are a masterful AD&D DM narrating a single combat moment. Write exactly 1-2 sentences.
Rules:
- Describe the physical reality of the hit or miss — what the weapon felt like, the sound, the impact site, the attacker's expression
- If a kill: one vivid sentence of how the creature falls
- If a miss: what went wrong, how the attacker overcorrects, what the defender does
- No game terms like "hit points", "damage", "roll". Pure physical description
- Voice: brutal, specific, immediate — no dramatic flourishes`,
              prompt: `Scene: ${combatScene?.name ?? 'Unknown'}. ${combatBlueprint?.roomAmbience ?? ''}
Combat: "${note.content}"
Add 1-2 sentences of physical combat description.`,
              callback: (result) => {
                if (result?.trim() && !result.startsWith('[The DM pauses')) {
                  run(db, 'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
                    [crypto.randomUUID(), campaignId, 1, 'narration', 'DM', result.trim()]);
                  io.to(`campaign:${campaignId}`).emit('game:narration', { content: result.trim(), actor: 'DM' });
                }
              },
            });
          }
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

        // ── Near-death AI narration ────────────────────────────────────────
        for (const uid of resolution.updatedCharacterIds) {
          const fallenChar = get(db, 'SELECT * FROM characters WHERE id = ?', [uid]) as any;
          if (fallenChar?.status === 'dying') {
            const ndScene = campaign.current_scene_id
              ? get(db, 'SELECT * FROM scenes WHERE id = ?', [campaign.current_scene_id]) as any
              : null;
            const ndBlueprint = ndScene ? buildSceneBlueprint(ndScene) : null;
            aiDirector.enqueue({
              campaignId,
              type: 'combat_narration',
              priority: 2,
              temperature: 0.90,
              system: `You are a masterful AD&D DM narrating the moment a hero falls in combat. Write exactly 3 sentences.
Rules:
- First: the physical reality of the fall — what hit them, how they land, what they can no longer do
- Second: what they perceive from the ground — sounds, light, the stone floor, ally voices
- Third: the fragile thread — not dead, not yet, but barely
- Voice: quiet, precise, present tense. No melodrama. No reassurance.`,
              prompt: `Scene: ${ndScene?.name || 'the dungeon'}. ${ndBlueprint?.roomAmbience || ''}
${fallenChar.name} (${fallenChar.char_class} level ${fallenChar.level}) just dropped to ${fallenChar.hp} HP — dying.
Narrate the moment they fall.`,
              callback: (ndResult) => {
                if (ndResult?.trim() && !ndResult.startsWith('[The DM pauses')) {
                  run(db, 'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
                    [crypto.randomUUID(), campaignId, 1, 'narration', 'DM', ndResult.trim()]);
                  io.to(`campaign:${campaignId}`).emit('game:narration', { content: ndResult.trim(), actor: 'DM' });
                }
              },
            });
            break; // narrate once per round even if multiple go down
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
            const killSpeaker = pickCompanionForTrigger(killCompanions, 'vanguard');
            if (killSpeaker && Math.random() > 0.5) {
              aiDirector.enqueue({
                campaignId,
                type: 'npc_dialogue',
                priority: 4,
                temperature: 0.88,
                system: `You are roleplaying as ${killSpeaker.name}, a companion in an AD&D adventuring party. Write exactly 1 short line of spoken dialogue — 8-18 words.
Personality: ${killSpeaker.personality}
Rules:
- Speak in first person, directly — no action beats or narration
- React specifically to this moment (enemy just killed in combat)
- Match their personality fully — sarcasm, steadiness, nerves, warmth
- Do NOT use quotation marks in your response`,
                prompt: `${killSpeaker.name} reacts after their party just killed an enemy in combat. What do they say?`,
                callback: (result) => {
                  if (result?.trim() && !result.startsWith('[The DM pauses')) {
                    const line = result.trim().replace(/^["'`]|["'`]$/g, '');
                    run(db, 'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
                      [crypto.randomUUID(), campaignId, 1, 'narration', killSpeaker.name, line]);
                    io.to(`campaign:${campaignId}`).emit('game:narration', { content: line, actor: killSpeaker.name });
                  }
                },
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
              const afterStreamId = crypto.randomUUID();
              io.to(`campaign:${campaignId}`).emit('game:narration_stream', { id: afterStreamId, chunk: '', actor: 'DM' });
              const afterNarration = await generateStream({
                system: `You are a masterful AD&D Dungeon Master narrating the immediate aftermath of a fight. 3-4 sentences, vivid present tense. Think Witcher 3 — specific, atmospheric, the silence after violence.
Rules:
- Begin with the sudden quiet after the last enemy falls, or the last blow landing
- Describe something concrete: what the body looks like, what the room smells like now, what the light reveals
- Note the physical cost — what the survivor carries out of this moment
- End on something that pulls forward: a sound, a shape, a reason to keep moving or to be afraid
- Voice: unflinching and specific, no sentiment`,
                prompt: `${afterContext}.\nDescribe the immediate aftermath of this fight.`,
                maxTokens: 130,
                temperature: 0.85,
                timeoutMs: 40_000,
                onChunk: (c) => io.to(`campaign:${campaignId}`).emit('game:narration_stream', { id: afterStreamId, chunk: c, actor: 'DM' }),
              });
              io.to(`campaign:${campaignId}`).emit('game:narration_stream', { id: afterStreamId, chunk: '', actor: 'DM', done: true });
              if (afterNarration?.trim()) {
                run(db, 'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
                  [crypto.randomUUID(), campaignId, 1, 'narration', 'DM', afterNarration.trim()]);
                io.to(`campaign:${campaignId}`).emit('game:narration', { content: afterNarration.trim(), actor: 'DM' });
              }
            } catch {}
          })();
          // ── D: Refresh action chips post-combat ──────────────────────────
          const postCombatScene = get(db, 'SELECT * FROM scenes WHERE id = ?', [campaign.current_scene_id]) as any;
          if (postCombatScene) {
            const postCombatNpcs = all(db,
              'SELECT name, personality FROM npcs WHERE campaign_id = ? AND location_scene_id = ? AND alive = 1',
              [campaignId, postCombatScene.id]) as any[];
            emitSceneActions(postCombatScene, postCombatNpcs, JSON.parse(postCombatScene.connections || '[]').filter((c: any) => !c.hidden), 'post_combat');
          }
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
          // ── AI return-to-town narration (context-aware, follows deterministic line) ──
          {
            const rtHpPct = character.max_hp > 0 ? character.hp / character.max_hp : 1;
            const rtCondition = rtHpPct <= 0.25 ? 'badly wounded, barely on their feet'
              : rtHpPct <= 0.5 ? 'bloodied and bruised'
              : rtHpPct <= 0.75 ? 'shaken but moving'
              : 'relatively intact';
            const rtLog = all(db,
              "SELECT actor, content FROM game_log WHERE campaign_id = ? AND type IN ('narration','dm_response') ORDER BY created_at DESC LIMIT 5",
              [campaignId]) as Array<{actor: string; content: string}>;
            const rtContext = rtLog.reverse().map(r => `${r.actor}: ${r.content.slice(0, 110)}`).join('\n');
            aiDirector.enqueue({
              campaignId,
              type: 'scene',
              priority: 2,
              temperature: 0.88,
              system: `You are a masterful AD&D DM narrating a delver's return to town. Write exactly 3 sentences.
Rules:
- Describe the specific physical experience of crossing back into civilisation — what THIS person feels, not generic town atmosphere
- Acknowledge their condition and what they carry (or don't). Be honest about the cost.
- End on one grounded, specific sensory detail: the smell of a hearth, noise they didn't realise they'd missed, how the cobblestones feel
- Voice: unflinching, present tense, earned. No clichés.`,
              prompt: `Character: ${character.name} (${character.char_class} level ${character.level}), ${rtCondition} (${character.hp}/${character.max_hp} HP).
Town: ${townName}.
Final expedition moments:
${rtContext}
Narrate their return to town.`,
              callback: (rtResult) => {
                if (rtResult?.trim() && !rtResult.startsWith('[The DM pauses')) {
                  run(db, 'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
                    [crypto.randomUUID(), campaignId, 1, 'narration', 'DM', rtResult.trim()]);
                  io.to(`campaign:${campaignId}`).emit('game:narration', { actor: 'DM', content: rtResult.trim() });
                }
              },
            });
          }
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
        // ── AI faction parley narration ─────────────────────────────────
        {
          const parleyBlueprint = buildSceneBlueprint(scene);
          const parleyOutcome = parleyResult.resolved ? 'resolved in their favour' : 'failed or worsened tensions';
          aiDirector.enqueue({
            campaignId,
            type: 'scene',
            priority: 3,
            temperature: 0.88,
            system: `You are a masterful AD&D DM narrating a diplomatic encounter with a dungeon faction. Write exactly 3 sentences.
Rules:
- Describe the physical reality: how the faction members respond — body language, what they do with their hands, how they look at the party
- Capture what is unspoken — the power balance, what was gained or conceded
- End on something concrete: a concession made, a warning issued, a charged silence
- Voice: tense, grounded. No archness or fantasy cliché.`,
            prompt: `Scene: ${scene.name}. ${parleyBlueprint.roomAmbience}
Faction: ${parleyFactionKey}. Player action: "${action}". Outcome: ${parleyOutcome}.
${parleyResult.notes.join(' ')}
Narrate the parley exchange.`,
            callback: (parleyNarration) => {
              if (parleyNarration?.trim() && !parleyNarration.startsWith('[The DM pauses')) {
                run(db, 'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
                  [crypto.randomUUID(), campaignId, 1, 'narration', 'DM', parleyNarration.trim()]);
                io.to(`campaign:${campaignId}`).emit('game:narration', { content: parleyNarration.trim(), actor: 'DM' });
              }
            },
          });
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
              // ── AI level-up narration ──────────────────────────────────
              aiDirector.enqueue({
                campaignId,
                type: 'scene',
                priority: 2,
                temperature: 0.90,
                system: `You are a masterful AD&D DM narrating the moment a character crosses a level threshold. Write exactly 3 sentences.
Rules:
- Describe the felt, physical reality of levelling — not glowing or abstract, but something in the body, the reflexes, the eyes
- Name ONE concrete change: how their sword arm moves differently, what they notice in the room that they missed before
- End with what the dungeon cost to earn this — honest and specific
- Voice: precise, understated, earned. No triumphant tone. No light effects.`,
                prompt: `Character: ${character.name}, ${character.char_class}, just reached level ${lu.newLevel ?? '?'}.
HP gained: ${lu.hpGain ?? 0}. ${lu.classAnnouncement ?? ''}
Scene: ${nextScene.name}.
Narrate the moment the level break happens.`,
                callback: (luResult) => {
                  if (luResult?.trim() && !luResult.startsWith('[The DM pauses')) {
                    run(db, 'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
                      [crypto.randomUUID(), campaignId, 1, 'narration', 'DM', luResult.trim()]);
                    io.to(`campaign:${campaignId}`).emit('game:narration', { content: luResult.trim(), actor: 'DM' });
                  }
                },
              });
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
          // ── AI rival encounter narration ──────────────────────────────
          const firstRival = rivalPresence.rivals[0];
          const rivalSceneBlueprint = buildSceneBlueprint(nextScene);
          aiDirector.enqueue({
            campaignId,
            type: 'scene',
            priority: 3,
            temperature: 0.90,
            system: `You are a masterful AD&D DM narrating the moment two delving parties discover each other in a dungeon. Write exactly 3 sentences.
Rules:
- Describe the physical moment of recognition: torchlight catching faces, weapons half-raised, the pause before anyone speaks
- Give the rival company a distinct presence: their gear, their bearing, what they have been through
- Capture the specific weight of their relationship — unknown strangers, bitter rivals, wary contacts
- Voice: immediate, specific, grounded. No fantasy cliché.`,
            prompt: `Scene: ${nextScene.name}. ${rivalSceneBlueprint.roomAmbience}
Rival party: ${firstRival.name} (${firstRival.size} members, relation: ${firstRival.relation}, strength: ${firstRival.strength})
${character.name}'s party enters and finds them here.
Narrate the moment of encounter.`,
            callback: (rivalResult) => {
              if (rivalResult?.trim() && !rivalResult.startsWith('[The DM pauses')) {
                run(db, 'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
                  [crypto.randomUUID(), campaignId, 1, 'narration', 'DM', rivalResult.trim()]);
                io.to(`campaign:${campaignId}`).emit('game:narration', { content: rivalResult.trim(), actor: 'DM' });
              }
            },
          });
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
        emitSceneActions(nextScene, npcsInScene, connections, 'movement');

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

        // ── NPC proactive dialogue on scene entry ────────────────────────
        if (npcsInScene.length > 0 && Math.random() < 0.4) {
          const proactiveNpc = npcsInScene[Math.floor(Math.random() * npcsInScene.length)];
          const proactiveBlueprint = buildSceneBlueprint(nextScene);
          const proactiveLog = all(db,
            "SELECT actor, content FROM game_log WHERE campaign_id = ? AND type IN ('narration','dm_response') ORDER BY created_at DESC LIMIT 3",
            [campaignId]) as Array<{actor: string; content: string}>;
          const proactiveCtx = proactiveLog.reverse().map(r => `${r.actor}: ${r.content.slice(0, 100)}`).join('\n');
          aiDirector.enqueue({
            campaignId,
            type: 'npc_dialogue',
            priority: 5,
            temperature: 0.88,
            system: `You are roleplaying as a specific NPC in an AD&D dungeon. The party just entered your location. Write exactly 1 short line of spontaneous dialogue — 8-18 words.
Rules:
- Speak unprompted — something they say as the party walks in
- React to the location, the moment, or something specific about the arrivals
- Match their personality fully — not a generic greeting
- Do NOT use quotation marks in your response`,
            prompt: `NPC: ${proactiveNpc.name}. Personality: ${proactiveNpc.personality || 'guarded and watchful'}.
Scene: ${nextScene.name}. ${proactiveBlueprint.roomAmbience}
${proactiveCtx ? `Recent events:\n${proactiveCtx}\n` : ''}${proactiveNpc.name} notices the party arrive. What do they say?`,
            callback: (result) => {
              if (result?.trim() && !result.startsWith('[The DM pauses')) {
                const line = result.trim().replace(/^["'\`]|["'\`]$/g, '');
                run(db, 'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
                  [crypto.randomUUID(), campaignId, 1, 'narration', proactiveNpc.name, line]);
                io.to(`campaign:${campaignId}`).emit('game:narration', { content: line, actor: proactiveNpc.name });
              }
            },
          });
        }

        // ── Cinematic entry narration for first-time rooms (async, fire-and-forget) ──
        if (wasUnvisited) {
          (async () => {
            try {
              const entryStreamId = crypto.randomUUID();
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
              const entryRecentLog = all(db,
                "SELECT actor, content FROM game_log WHERE campaign_id = ? AND type IN ('narration','dm_response') ORDER BY created_at DESC LIMIT 3",
                [campaignId]
              ) as Array<{ actor: string; content: string }>;
              const entryRecentHistory = entryRecentLog.reverse()
                .map(r => `${r.actor}: ${r.content.slice(0, 150)}`)
                .join('\n');
              io.to(`campaign:${campaignId}`).emit('game:narration_stream', { id: entryStreamId, chunk: '', actor: 'DM' });
              const entryNarration = await generateStream({
                system: `You are a masterful AD&D Dungeon Master describing a room the party has never entered before. Write 4-6 immersive sentences. Think Witcher 3 — specific, atmospheric, alive with texture and unease.
Rules:
- Begin mid-sensation or with a concrete sensory detail — NOT "you enter" or "you step into"
- Flood the senses: the cold, the smell of rot or stone, how sound moves in this space, what the light picks out
- Name specific architectural features, stains, damage, objects, marks left by previous occupants
- Hint at history — what happened here, what lived here, how long ago
- Plant one anomaly or detail that begs investigation: a shape in shadow, a sound that should not be, a surface worn wrong
- Never open with "The chamber opens up" or "You find yourself"
- Voice: baroque and strange, as if the dungeon itself has opinions`,
                prompt: `${entryContext.join('. ')}.${entryRecentHistory ? `\nRecent session history:\n${entryRecentHistory}` : ''}\nDescribe the party entering this room for the first time.`,
                maxTokens: 160,
                temperature: 0.88,
                timeoutMs: 45_000,
                onChunk: (c) => io.to(`campaign:${campaignId}`).emit('game:narration_stream', { id: entryStreamId, chunk: c, actor: 'DM' }),
              });
              io.to(`campaign:${campaignId}`).emit('game:narration_stream', { id: entryStreamId, chunk: '', actor: 'DM', done: true });
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
        // Async AI expansion for scene description — fires for all orientation queries
        {
          const orientBlueprint = buildSceneBlueprint(scene);
          aiDirector.enqueue({
            campaignId,
            type: 'scene',
            priority: 4,
            temperature: 0.88,
            system: `You are a masterful AD&D DM adding one final atmospheric observation. Write exactly 2 sentences.
Rules:
- The party is pausing to take stock — describe one specific detail they notice on closer inspection
- Something that wasn't obvious at first glance: a smell, a marking, a sound from inside the walls
- Implies history or threat without naming either
- Voice: specific, weighted, like the room is keeping a secret`,
            prompt: `Room: ${scene.name}. ${orientBlueprint.roomAmbience}
${orientBlueprint.clue ? `Detail: ${orientBlueprint.clue}` : ''}
${orientBlueprint.tracks ? `Signs: ${orientBlueprint.tracks}` : ''}
Add one final close-inspection detail the party notices.`,
            callback: (result) => {
              if (result?.trim() && !result.startsWith('[The DM pauses')) {
                run(db, 'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
                  [crypto.randomUUID(), campaignId, 1, 'narration', 'DM', result.trim()]);
                io.to(`campaign:${campaignId}`).emit('game:narration', { content: result.trim(), actor: 'DM' });
              }
            },
          });
        }
        // ── Companion reaction: darkness ──────────────────────────────────
        if ((scene.light_level || 'normal') === 'dark') {
          try {
            const darkCompanions = getPartyCompanions(db, campaignId).filter((c) => c.joinedParty);
            const darkSpeaker = pickCompanionForTrigger(darkCompanions);
            if (darkSpeaker && Math.random() > 0.5) {
              aiDirector.enqueue({
                campaignId,
                type: 'npc_dialogue',
                priority: 4,
                temperature: 0.88,
                system: `You are roleplaying as ${darkSpeaker.name}, a companion in an AD&D adventuring party. Write exactly 1 short line of spoken dialogue — 8-18 words.
Personality: ${darkSpeaker.personality}
Rules:
- Speak in first person, directly — no action beats or narration
- React specifically to exploring in complete darkness
- Match their personality — unease, dry humour, professional calm
- Do NOT use quotation marks in your response`,
                prompt: `${darkSpeaker.name} comments on the party exploring in total darkness. What do they say?`,
                callback: (result) => {
                  if (result?.trim() && !result.startsWith('[The DM pauses')) {
                    const line = result.trim().replace(/^["'`]|["'`]$/g, '');
                    run(db, 'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
                      [crypto.randomUUID(), campaignId, 1, 'narration', darkSpeaker.name, line]);
                    io.to(`campaign:${campaignId}`).emit('game:narration', { content: line, actor: darkSpeaker.name });
                  }
                },
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
            const spellStreamId = crypto.randomUUID();
            io.to(`campaign:${campaignId}`).emit('game:narration_stream', { id: spellStreamId, chunk: '', actor: 'DM' });
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

              const spellNarration = await generateStream({
                system: `You are a masterful AD&D Dungeon Master narrating a spell being cast. 3-4 vivid sentences, present tense.
Rules:
- Describe the casting: the words, gestures, what the magic looks and feels like in this specific room
- Incorporate the mechanical result naturally — healing spells close wounds, light spells fill the room, utility spells change something tangible
- Do not list game statistics; the effect should be felt, not stated
- Voice: specific, atmospheric, the magic feels real and earned`,
                prompt: `${spellContext}.\nPlayer action: "${action}". Narrate the spell and its effect.`,
                maxTokens: 120,
                temperature: 0.85,
                timeoutMs: 45_000,
                onChunk: (c) => io.to(`campaign:${campaignId}`).emit('game:narration_stream', { id: spellStreamId, chunk: c, actor: 'DM' }),
              });

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
              io.to(`campaign:${campaignId}`).emit('game:narration_stream', { id: spellStreamId, chunk: '', actor: 'DM', done: true });
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
          const npcStreamId = crypto.randomUUID();
          io.to(`campaign:${campaignId}`).emit('game:narration_stream', { id: npcStreamId, chunk: '', actor: npcVoiceTarget.name });
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
            if (!npcConversationMemory.has(campaignId)) npcConversationMemory.set(campaignId, new Map());
            const npcMem = npcConversationMemory.get(campaignId)!;
            const priorExchanges = npcMem.get(npcVoiceTarget.name) || [];
            const priorContext = priorExchanges.length > 0
              ? `Prior exchanges with this character:\n${priorExchanges.join('\n')}`
              : '';
            const npcResponse = (await generateStream({
              system: `You are roleplaying as a specific NPC in an AD&D dungeon. Respond in their voice — direct speech plus brief action beats. 2-4 sentences total.
Rules:
- Stay completely in character; speak AS the NPC, first person
- Let their personality and disposition shape every word — a hostile NPC is hostile, a cagey one deflects
- React to the specific question or statement being directed at them
- Include one small physical action or tell (a look, a gesture, a pause) to make them feel present
- Do not summarise or narrate in third person
- Keep it tight — NPCs speak, they don't monologue`,
              prompt: `${npcContext}.\n${priorContext ? priorContext + '\n' : ''}Player says to ${npcVoiceTarget.name}: "${action}"\nRespond as ${npcVoiceTarget.name}.`,
              maxTokens: 120,
              temperature: 0.88,
              timeoutMs: 35_000,
              onChunk: (c) => io.to(`campaign:${campaignId}`).emit('game:narration_stream', { id: npcStreamId, chunk: c, actor: npcVoiceTarget.name }),
            })).trim();
            io.to(`campaign:${campaignId}`).emit('game:narration_stream', { id: npcStreamId, chunk: '', actor: npcVoiceTarget.name, done: true });
            if (npcResponse) {
              run(db, 'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
                [crypto.randomUUID(), campaignId, 1, 'narration', npcVoiceTarget.name, npcResponse]);
              io.to(`campaign:${campaignId}`).emit('game:narration', { content: npcResponse, actor: npcVoiceTarget.name });
              priorExchanges.push(`Player: "${action}" → ${npcVoiceTarget.name}: "${npcResponse.slice(0, 100)}"`);
              if (priorExchanges.length > 3) priorExchanges.shift();
              npcMem.set(npcVoiceTarget.name, priorExchanges);
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

        // Pull last 5 narrations for narrative continuity
        const recentLog = all(db, "SELECT actor, content FROM game_log WHERE campaign_id = ? AND type IN ('narration','dm_response') ORDER BY created_at DESC LIMIT 5", [campaignId]) as Array<{actor: string; content: string}>;
        const recentHistory = recentLog.reverse().map(r => `${r.actor}: ${r.content.slice(0, 150)}`).join('\n');

        const mainStreamId = crypto.randomUUID();
        actionLocks.add(campaignId);
        io.to(`campaign:${campaignId}`).emit('game:narration_stream', { id: mainStreamId, chunk: '', actor: 'DM' });
        try {
          aiMsg = (await generateStream({
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
            prompt: `${contextParts.join('. ')}.\n${(getCampaignState(db, campaignId)?.recentEvents || []).slice(-3).filter(Boolean).length > 0 ? `Recent events: ${(getCampaignState(db, campaignId)?.recentEvents || []).slice(-3).filter(Boolean).join('; ')}.` : ''}${recentHistory ? `\nRecent session history:\n${recentHistory}` : ''}\nPlayer action: "${action}". Narrate the outcome with full sensory immersion.`,
            maxTokens: 200,
            temperature: 0.82,
            timeoutMs: 55_000,
            onChunk: (c) => io.to(`campaign:${campaignId}`).emit('game:narration_stream', { id: mainStreamId, chunk: c, actor: 'DM' }),
          })).trim() || aiMsg;
        } catch (aiErr) {
          console.error('[AI fallback error]', aiErr);
          // Ollama unreachable or timed out — still give something real
          aiMsg = `${aiBlueprint.roomAmbience} The attempt registers. The room shifts, just slightly.`;
        } finally {
          io.to(`campaign:${campaignId}`).emit('game:narration_stream', { id: mainStreamId, chunk: '', actor: 'DM', done: true });
          actionLocks.delete(campaignId);
        }

        run(db, 'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
          [crypto.randomUUID(), campaignId, 1, 'narration', 'DM', aiMsg]);
        io.to(`campaign:${campaignId}`).emit('game:narration', { content: aiMsg, actor: 'DM' });
        // ── Companion reaction: strange/fallback action ───────────────────
        try {
          const strangeCompanions = getPartyCompanions(db, campaignId).filter((c) => c.joinedParty);
          const strangeSpeaker = pickCompanionForTrigger(strangeCompanions);
          if (strangeSpeaker && Math.random() > 0.5) {
            aiDirector.enqueue({
              campaignId,
              type: 'npc_dialogue',
              priority: 4,
              temperature: 0.9,
              system: `You are roleplaying as ${strangeSpeaker.name}, a companion in an AD&D adventuring party. Write exactly 1 short line of spoken dialogue — 8-18 words.
Personality: ${strangeSpeaker.personality}
Rules:
- Speak in first person, directly — no action beats or narration
- React to a peculiar or unexpected action by the party leader
- Match their personality — dry comment, cautious question, loyal support
- Do NOT use quotation marks in your response`,
              prompt: `${strangeSpeaker.name} reacts after ${character.name} just tried: "${action}". What do they say?`,
              callback: (result) => {
                if (result?.trim() && !result.startsWith('[The DM pauses')) {
                  const line = result.trim().replace(/^["'`]|["'`]$/g, '');
                  run(db, 'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
                    [crypto.randomUUID(), campaignId, 1, 'narration', strangeSpeaker.name, line]);
                  io.to(`campaign:${campaignId}`).emit('game:narration', { content: line, actor: strangeSpeaker.name });
                }
              },
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
          const lootBlueprint = buildSceneBlueprint(scene);
          aiDirector.enqueue({
            campaignId,
            type: 'scene',
            priority: 4,
            temperature: 0.9,
            system: `You are a masterful AD&D Dungeon Master giving a found object its moment. Exactly 2 sentences.
Rules:
- Describe physical details: material, weight, condition, marks, smell, temperature
- Imply history — who owned it, how long it has been here, what it witnessed
- No game statistics, no "you find", no mechanical language
- Voice: specific, weighted, atmospheric`,
            prompt: `Room: ${scene.name} — ${lootBlueprint.roomAmbience}. Found: "${foundItem}". Describe this object.`,
            callback: (result) => {
              if (result?.trim() && !result.startsWith('[The DM pauses')) {
                run(db, 'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
                  [crypto.randomUUID(), campaignId, 1, 'narration', 'DM', result.trim()]);
                io.to(`campaign:${campaignId}`).emit('game:narration', { content: result.trim(), actor: 'DM' });
              }
            },
          });
        }
        // ── D: Refresh action chips after loot found ─────────────────────
        emitSceneActions(scene, npcsInScene, JSON.parse(scene.connections || '[]').filter((c: any) => !c.hidden), 'post_loot');
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

      // ── AI escalation for critical delve moments ─────────────────────────────
      if (delveState.delve.lightLevel === 'dark' && torchCount === 0) {
        // Torch just burned out with no spares — total darkness
        const darkBlueprint = buildSceneBlueprint(scene);
        aiDirector.enqueue({
          campaignId,
          type: 'scene',
          priority: 3,
          temperature: 0.92,
          system: `You are a masterful AD&D Dungeon Master narrating the moment a dungeon party loses their last light. Write exactly 3 sentences.
Rules:
- Describe the exact moment: the flame guttering, what the last light reveals before it dies, the quality of the darkness that follows
- The darkness is not just absence of light — it has weight, temperature, sound
- End on immediate threat: the dungeon is still there, and now they can't see it
- Voice: visceral, cold, no reassurance`,
          prompt: `Scene: ${scene.name}. ${darkBlueprint.roomAmbience}
The last torch just burned out. ${character.name} has no more torches.
Narrate the moment darkness takes the dungeon.`,
          callback: (result) => {
            if (result?.trim() && !result.startsWith('[The DM pauses')) {
              run(db, 'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
                [crypto.randomUUID(), campaignId, 1, 'narration', 'DM', result.trim()]);
              io.to(`campaign:${campaignId}`).emit('game:narration', { content: result.trim(), actor: 'DM' });
            }
          },
        });
      } else if (delveState.delve.hungerTicks >= 4) {
        // Critical hunger — becoming dangerous
        aiDirector.enqueue({
          campaignId,
          type: 'scene',
          priority: 4,
          temperature: 0.88,
          system: `You are a masterful AD&D Dungeon Master narrating the physical reality of starvation in a dungeon. Write exactly 2 sentences.
Rules:
- Describe what hunger does to a body: the shaking hands, the cold sweat, the way judgement starts to slip
- Connect it to the dungeon — this is the worst place to be weak
- Voice: clinical and frightening, not melodramatic`,
          prompt: `${character.name} and their company have gone dangerously long without food. Hunger ticks: ${delveState.delve.hungerTicks}/4.
Narrate the physical toll of starvation starting to bite.`,
          callback: (result) => {
            if (result?.trim() && !result.startsWith('[The DM pauses')) {
              run(db, 'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
                [crypto.randomUUID(), campaignId, 1, 'narration', 'DM', result.trim()]);
              io.to(`campaign:${campaignId}`).emit('game:narration', { content: result.trim(), actor: 'DM' });
            }
          },
        });
      }

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

        // ── AI camp narration — the moment of rest in a hostile dungeon ──────
        {
          const campBlueprint = buildSceneBlueprint(scene);
          const isFortified = /secure|barricade|bar the|fortified/.test(action.toLowerCase());
          const campQuality = delveState.delve.campQuality || 'adequate';
          aiDirector.enqueue({
            campaignId,
            type: 'scene',
            priority: 4,
            temperature: 0.88,
            system: `You are a masterful AD&D Dungeon Master narrating a moment of rest deep in a dungeon. Write exactly 3 sentences.
Rules:
- Describe the act of stopping: how the party settles, what they do with their hands, the quality of the silence
- One sentence about what the dungeon does while they rest — a sound, a smell, what the dark holds
- End on the fragility of the moment — rest is not safety, just a pause
- Voice: quiet, weighted, like a fire that might not last the night`,
            prompt: `Scene: ${scene.name}. ${campBlueprint.roomAmbience}
Camp quality: ${campQuality}. ${isFortified ? 'Position fortified — door barred, perimeter set.' : 'Open camp — exposed to the corridor.'}
Character: ${character.name} (${character.char_class}, ${character.hp}/${character.max_hp} HP). Fatigue ticks: ${delveState.delve.fatigueTicks || 0}.
Narrate the party making camp in the dungeon.`,
            callback: (result) => {
              if (result?.trim() && !result.startsWith('[The DM pauses')) {
                run(db, 'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
                  [crypto.randomUUID(), campaignId, 1, 'narration', 'DM', result.trim()]);
                io.to(`campaign:${campaignId}`).emit('game:narration', { content: result.trim(), actor: 'DM' });
              }
            },
          });
        }

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
        const expBlueprint = buildSceneBlueprint(scene);
        const recentCtx = (getCampaignState(db, campaignId).recentEvents || []).slice(-3).filter(Boolean).join('; ');
        aiDirector.enqueue({
          campaignId,
          type: 'scene',
          priority: 4,
          temperature: 0.88,
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
          callback: (result) => {
            if (result?.trim() && !result.startsWith('[The DM pauses')) {
              run(db, 'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
                [crypto.randomUUID(), campaignId, 1, 'narration', 'DM', result.trim()]);
              io.to(`campaign:${campaignId}`).emit('game:narration', { content: result.trim(), actor: 'DM' });
            }
          },
        });
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
          const TRIGGER_ROLE: Partial<Record<string, string>> = {
            trap_found: 'scout', trap_triggered: 'scout', search: 'scout', low_health: 'warden',
          };
          const TRIGGER_CONTEXT: Record<string, string> = {
            search: 'the party is searching the area',
            trap_found: 'a trap was just spotted before it triggered',
            trap_triggered: 'a trap just went off and hurt someone',
            low_health: `${character.name} is badly wounded`,
            loot_found: 'the party just found treasure',
            rest: 'the party is making camp to rest',
            strange_action: `${character.name} just did something unexpected`,
            darkness: 'the party is exploring in total darkness',
            combat_start: 'combat just broke out',
            combat_kill: 'an enemy was just killed in combat',
          };
          const explSpeaker = pickCompanionForTrigger(explCompanions, TRIGGER_ROLE[trigger]);
          if (explSpeaker && Math.random() > 0.5) {
            aiDirector.enqueue({
              campaignId,
              type: 'npc_dialogue',
              priority: 4,
              temperature: 0.88,
              system: `You are roleplaying as ${explSpeaker.name}, a companion in an AD&D adventuring party. Write exactly 1 short line of spoken dialogue — 8-18 words.
Personality: ${explSpeaker.personality}
Rules:
- Speak in first person, directly — no action beats or narration
- React specifically to the current situation
- Match their personality — they are not a generic adventurer
- Do NOT use quotation marks in your response`,
              prompt: `Context: ${TRIGGER_CONTEXT[trigger] || trigger}
${explSpeaker.name} reacts. What do they say?`,
              callback: (result) => {
                if (result?.trim() && !result.startsWith('[The DM pauses')) {
                  const line = result.trim().replace(/^["'`]|["'`]$/g, '');
                  run(db, 'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
                    [crypto.randomUUID(), campaignId, 1, 'narration', explSpeaker.name, line]);
                  io.to(`campaign:${campaignId}`).emit('game:narration', { content: line, actor: explSpeaker.name });
                }
              },
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
        const pulseBlueprint = buildSceneBlueprint(scene);
        aiDirector.enqueue({
          campaignId,
          type: 'world_gen',
          priority: 5,
          temperature: 0.92,
          system: `You are a masterful AD&D DM adding an unprompted ambient observation. Write exactly 2 sentences.
Rules:
- Something in the environment shifts — a sound, a smell, a light change, movement in shadow
- The party didn't cause it. The dungeon just... does something
- Do NOT say what it means or suggest what to do
- Voice: quiet, ominous, specific — like the dungeon breathing`,
          prompt: `Scene: ${scene.name}. ${pulseBlueprint.roomAmbience}. ${(pulseBlueprint as any).themePressure || ''}
Describe one unprompted environmental detail or ambient change the party notices.`,
          callback: (result) => {
            if (result?.trim() && !result.startsWith('[The DM pauses')) {
              run(db, 'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
                [crypto.randomUUID(), campaignId, 1, 'narration', 'DM', result.trim()]);
              io.to(`campaign:${campaignId}`).emit('game:narration', { content: result.trim(), actor: 'DM' });
            }
          },
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
          // Emit deterministic fallback immediately so UI isn't blank
          run(db,
            'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
            [crypto.randomUUID(), campaignId, 1, 'narration', 'DM',
              `${outcome.encounter.description} ${started.surpriseSummary}`]);
          io.to(`campaign:${campaignId}`).emit('game:narration', {
            actor: 'DM',
            content: `${outcome.encounter.description} ${started.surpriseSummary}`,
          });
          emitEncounterStart(io, campaignId, started);
          // ── Streaming encounter-start narration ──────────────────────────
          (async () => {
            try {
              const combatStreamId = crypto.randomUUID();
              const combatBlueprint = buildSceneBlueprint(scene);
              const enemyList = (outcome.encounter?.enemies ?? [])
                .map((e: any) => e.name || e.type || 'unknown creature').join(', ');
              const hpPct2 = character.max_hp > 0 ? character.hp / character.max_hp : 1;
              const charCond = hpPct2 <= 0.25 ? 'badly wounded' : hpPct2 <= 0.5 ? 'injured' : hpPct2 <= 0.75 ? 'lightly wounded' : 'healthy';
              io.to(`campaign:${campaignId}`).emit('game:narration_stream', { id: combatStreamId, chunk: '', actor: 'DM' });
              const combatNarration = await generateStream({
                system: `You are a masterful AD&D Dungeon Master narrating the moment combat erupts. Write 3-4 sentences.
Rules:
- Describe the instant before violence — the body going cold, the sound that triggers it, what the eyes catch first
- Name the enemies specifically; give each one a physical detail that makes them distinct
- Capture the sensory chaos: movement, sound, the air changing, weapon drawn
- End on immediate threat — not what might happen, what IS happening right now
- Voice: visceral, urgent, present tense. No dramatic pauses. No "suddenly".`,
                prompt: `Scene: ${scene.name}. ${combatBlueprint.roomAmbience}
Enemies: ${enemyList}
${started.surpriseSummary}
Character: ${character.name} (${character.char_class} level ${character.level}), ${charCond}
Narrate the moment combat begins.`,
                maxTokens: 130,
                temperature: 0.88,
                timeoutMs: 40_000,
                onChunk: (c) => io.to(`campaign:${campaignId}`).emit('game:narration_stream', { id: combatStreamId, chunk: c, actor: 'DM' }),
              });
              io.to(`campaign:${campaignId}`).emit('game:narration_stream', { id: combatStreamId, chunk: '', actor: 'DM', done: true });
              if (combatNarration?.trim()) {
                run(db, 'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
                  [crypto.randomUUID(), campaignId, 1, 'narration', 'DM', combatNarration.trim()]);
              }
            } catch {}
          })();
          // ── Companion reaction: combat starting ──────────────────────────
          try {
            const startCompanions = getPartyCompanions(db, campaignId).filter((c) => c.joinedParty);
            const startSpeaker = pickCompanionForTrigger(startCompanions, 'vanguard');
            if (startSpeaker && Math.random() > 0.5) {
              aiDirector.enqueue({
                campaignId,
                type: 'npc_dialogue',
                priority: 3,
                temperature: 0.88,
                system: `You are roleplaying as ${startSpeaker.name}, a companion in an AD&D adventuring party. Write exactly 1 short line of spoken dialogue — 8-18 words.
Personality: ${startSpeaker.personality}
Rules:
- Speak in first person, directly — no action beats or narration
- React to combat erupting — weapons out, enemies closing in
- Match their personality — battle cry, cold focus, panicked warning, grim readiness
- Do NOT use quotation marks in your response`,
                prompt: `${startSpeaker.name} reacts as combat suddenly breaks out. Enemies: ${(outcome.encounter?.enemies ?? []).map((e: any) => e.name || e.type).join(', ')}. What do they say?`,
                callback: (result) => {
                  if (result?.trim() && !result.startsWith('[The DM pauses')) {
                    const line = result.trim().replace(/^["'`]|["'`]$/g, '');
                    run(db, 'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
                      [crypto.randomUUID(), campaignId, 1, 'narration', startSpeaker.name, line]);
                    io.to(`campaign:${campaignId}`).emit('game:narration', { content: line, actor: startSpeaker.name });
                  }
                },
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
        // ── AI rival clash outcome narration ───────────────────────────
        {
          const resolveRow = get(db, 'SELECT current_scene_id FROM campaigns WHERE id = ?', [campaignId]) as any;
          const resolveScene = resolveRow?.current_scene_id
            ? get(db, 'SELECT * FROM scenes WHERE id = ?', [resolveRow.current_scene_id]) as any
            : null;
          const resolveBlueprint = resolveScene ? buildSceneBlueprint(resolveScene) : null;
          aiDirector.enqueue({
            campaignId,
            type: 'scene',
            priority: 3,
            temperature: 0.90,
            system: `You are a masterful AD&D DM narrating the aftermath of a confrontation between two delving parties. Write exactly 3 sentences.
Rules:
- Describe what the rival party does immediately after: how they move, what they say as they leave or settle, what their hands do
- Capture the emotional residue — what it cost or gained on both sides
- End with something concrete about what changed between the groups
- Voice: tight, unsentimental, specific.`,
            prompt: `Scene: ${resolveScene?.name || 'the dungeon'}. ${resolveBlueprint?.roomAmbience || ''}
Rival: ${result.rival?.name || 'the rival party'}. Confrontation type: ${validChoice}.
${result.notes.join(' ')}
Narrate the immediate aftermath.`,
            callback: (clashNarration) => {
              if (clashNarration?.trim() && !clashNarration.startsWith('[The DM pauses')) {
                run(db, 'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, ?, ?, ?, ?)',
                  [crypto.randomUUID(), campaignId, 1, 'narration', 'DM', clashNarration.trim()]);
                io.to(`campaign:${campaignId}`).emit('game:narration', { content: clashNarration.trim(), actor: 'DM' });
              }
            },
          });
        }
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

    // ─── Disconnect ──────────────────────────────────────────────────────

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
