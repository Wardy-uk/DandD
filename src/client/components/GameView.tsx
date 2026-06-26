import { useState, useEffect, useRef, useCallback } from 'react';
import type { Socket } from 'socket.io-client';
import CharacterSheet from './CharacterSheet.js';
import CampaignMap from './CampaignMap.js';
import TownView from './TownView.js';
import { playSound, setAmbience } from '../audio/audioEngine.js';

// ─── Narration text analysis ──────────────────────────────────────────────────

function detectSoundFromNarration(text: string): 'attack_hit' | 'attack_miss' | 'enemy_defeated' | 'level_up' | 'trap_trigger' | 'torch_light' | 'search_find' | null {
  const t = text.toLowerCase();
  if (/\b(level up|gain(s)? a level|levelled up)\b/.test(t)) return 'level_up';
  if (/\b(slain|defeat(?:ed|s)|kill(?:ed|s)|falls dead|collapses|crumples|drops dead)\b/.test(t)) return 'enemy_defeated';
  if (/\btrap\b.{0,30}\b(trigger|snap|click|spring|activate|fires?)\b|\b(dart|spike|blade|pit)\b/.test(t)) return 'trap_trigger';
  if (/\b(torch|candle|lantern)\b.{0,20}\b(lit|light|ignit|flicker)\b/.test(t)) return 'torch_light';
  if (/\b(find|found|discover|spot|notice)\b.{0,30}\b(hidden|secret|passage|door|chest|cache)\b/.test(t)) return 'search_find';
  if (/\b(misses?|dodges?|parri(?:ed|es)|deflects?|avoids?|goes wide)\b/.test(t)) return 'attack_miss';
  if (/\b(hits?|strikes?|wounds?|slashes?|cuts?|smites?|cracks?|crushes?|lands? a blow)\b/.test(t)) return 'attack_hit';
  return null;
}

interface LogEntry {
  id: string;
  type: string;
  actor: string;
  content: string;
  timestamp: string;
}

interface Scene {
  id: string;
  name: string;
  brief: string;
  connections: { direction: string; targetSceneId: string; description: string }[];
}

interface BattlefieldProfile {
  visibility: 'clear' | 'murky' | 'dark';
  cover: boolean;
  chokepoint: boolean;
  hazard: string | null;
  footing: 'stable' | 'uneven' | 'treacherous';
  pressure: string;
  summary: string;
  tacticalAdvice: string[];
}

interface CampaignMapData {
  currentSceneId: string;
  nodes: any[];
  edges: any[];
}

interface Companion {
  id: string;
  name: string;
  race: string;
  charClass: string;
  level: number;
  personality: string;
  disposition: string;
  joinedParty: boolean;
  companionRole: string;
  duty: string;
  aspiration: string;
  grievance: string;
  personalQuestTitle: string;
  personalQuestNeed: string;
  personalQuestProgress: number;
  personalQuestResolved: boolean;
  hp: number;
  maxHp: number;
  relationshipLabel: string;
  relationship: {
    trust: number;
    bond: number;
    tension: number;
    respect: number;
    romance: number;
    loyalty: number;
    morale: number;
    lastBeat: string;
  };
}

interface DelveConditionsView {
  torchesLit: number;
  lightsOutAt: number;
  lightLevel: 'bright' | 'normal' | 'dim' | 'dark';
  fatigueTicks: number;
  hungerTicks: number;
  attritionHp: number;
  lootCarried: number;
  encumbered: boolean;
  retreatPenalty: number;
  campQuality: 'poor' | 'adequate' | 'good' | 'fortified';
  tensionFromSupply: number;
}

interface CampaignStateView {
  encounterPressure: number;
  supply: {
    torchesBurned: number;
    rationsSpent: number;
    lockpicksBroken: number;
    arrowsSpent: number;
    bandagesUsed: number;
  };
  delve?: DelveConditionsView;
  factions: Array<{
    key: string;
    name: string;
    reputation: number;
    heat: number;
    summary: string;
    notes: string;
  }>;
  recentEvents: string[];
}

interface SceneNpc {
  id: string;
  name: string;
  race: string;
  charClass: string;
  level: number;
  personality: string;
  disposition: string;
  joinedParty: boolean;
  companionRole: string;
  duty: string;
  aspiration: string;
  grievance: string;
  personalQuestTitle: string;
  personalQuestNeed: string;
  personalQuestProgress: number;
  personalQuestResolved: boolean;
  relationshipLabel: string;
  recruitHint: string;
}

interface InventoryEntry {
  item: string;
  weight: number;
  quantity: number;
  equipped: boolean;
}

const COMPANION_DUTIES = [
  { key: 'scout', label: 'Scout', command: 'to scout ahead' },
  { key: 'vanguard', label: 'Vanguard', command: 'to take point' },
  { key: 'warden', label: 'Warden', command: 'to tend wounds' },
  { key: 'envoy', label: 'Envoy', command: 'to handle the talking' },
  { key: 'watch', label: 'Watch', command: 'to keep watch' },
  { key: 'torch', label: 'Torch', command: 'to carry the torch' },
] as const;

type MobilePanel = null | 'character' | 'spells' | 'company' | 'scene' | 'expedition' | 'map';

interface ActiveContract {
  id: string;
  title: string;
  reward: number;
  objectiveTarget: number;
  objectiveLabel: string;
  progress: number;
  progressText: string;
  readyToClaim: boolean;
  completedAt: string | null;
}

// ─── Spell catalog (client-side lookup for display) ───────────────────────────

const SPELL_CATALOG: Record<string, { level: number; school: string; desc: string }> = {
  // Magic-User L1
  'Magic Missile':          { level: 1, school: 'Evocation',    desc: '1d4+1/missile, auto-hits.' },
  'Sleep':                  { level: 1, school: 'Enchantment',  desc: '2d4 HD sleep, no save. Not undead.' },
  'Charm Person':           { level: 1, school: 'Enchantment',  desc: 'Target treats caster as friend. Save negates.' },
  'Shield':                 { level: 1, school: 'Abjuration',   desc: 'AC 4 vs missiles, AC 2 vs melee.' },
  'Detect Magic':           { level: 1, school: 'Divination',   desc: 'Detects magic in 10×60 ft path.' },
  'Light':                  { level: 1, school: 'Alteration',   desc: 'Torchlight globe 20 ft. Can blind a target.' },
  'Read Magic':             { level: 1, school: 'Divination',   desc: 'Read magical inscriptions and scrolls.' },
  'Hold Portal':            { level: 1, school: 'Alteration',   desc: 'Holds door shut for 1 round/level.' },
  // Magic-User L2
  'Web':                    { level: 2, school: 'Evocation',    desc: 'Sticky webs entangle all within area.' },
  'Invisibility':           { level: 2, school: 'Illusion',     desc: 'Invisible until attacking or casting.' },
  'Mirror Image':           { level: 2, school: 'Illusion',     desc: '1d4+1 decoy images of caster.' },
  'Knock':                  { level: 2, school: 'Alteration',   desc: 'Opens stuck or locked doors.' },
  'Levitate':               { level: 2, school: 'Alteration',   desc: 'Vertical movement 20 ft/round.' },
  'Detect Invisibility':    { level: 2, school: 'Divination',   desc: 'See invisible, hidden, ethereal creatures.' },
  'ESP':                    { level: 2, school: 'Divination',   desc: 'Read surface thoughts within range.' },
  // Magic-User L3
  'Fireball':               { level: 3, school: 'Invocation',   desc: '1d6/level fire in 20 ft radius. Save halves.' },
  'Lightning Bolt':         { level: 3, school: 'Invocation',   desc: '1d6/level lightning. Save halves.' },
  'Fly':                    { level: 3, school: 'Alteration',   desc: 'Fly at speed 18.' },
  'Haste':                  { level: 3, school: 'Alteration',   desc: 'Double speed and attacks. Ages 1 year.' },
  'Hold Person':            { level: 3, school: 'Enchantment',  desc: 'Holds human/demi-human targets rigid. Save negates.' },
  'Dispel Magic':           { level: 3, school: 'Abjuration',   desc: 'Cancels spells and effects in area.' },
  'Slow':                   { level: 3, school: 'Alteration',   desc: 'Halves speed and attacks. Counters Haste.' },
  // Magic-User L4
  'Polymorph Other':        { level: 4, school: 'Alteration',   desc: 'Transforms target into another creature.' },
  'Ice Storm':              { level: 4, school: 'Evocation',    desc: '3d10 bludgeoning/cold. No save.' },
  'Confusion':              { level: 4, school: 'Enchantment',  desc: 'Targets act randomly each round.' },
  'Dimension Door':         { level: 4, school: 'Alteration',   desc: 'Teleport up to 30 yards/level.' },
  'Wall of Fire':           { level: 4, school: 'Evocation',    desc: '2d4+level damage to those passing through.' },
  'Fear':                   { level: 4, school: 'Illusion',     desc: 'Cone — targets flee 1 round/level.' },
  // Magic-User L5
  'Cloudkill':              { level: 5, school: 'Evocation',    desc: 'Kills <4+1 HD; others save or die.' },
  'Cone of Cold':           { level: 5, school: 'Evocation',    desc: '1d4+1/level cold in cone. Save halves.' },
  'Teleport':               { level: 5, school: 'Alteration',   desc: 'Instant transport to known location.' },
  'Hold Monster':           { level: 5, school: 'Enchantment',  desc: 'Holds 1-4 monsters rigid. Save negates.' },
  'Animate Dead':           { level: 5, school: 'Necromancy',   desc: '1 HD/level skeletons or zombies.' },
  'Feeblemind':             { level: 5, school: 'Enchantment',  desc: 'INT and WIS reduced to near zero.' },
  // Cleric L1
  'Cure Light Wounds':      { level: 1, school: 'Necromancy',   desc: 'Heals 1d8 HP.' },
  'Bless':                  { level: 1, school: 'Conjuration',  desc: '+1 to hit and saves vs fear for allies.' },
  'Command':                { level: 1, school: 'Enchantment',  desc: 'One-word command target must obey.' },
  'Detect Evil':            { level: 1, school: 'Divination',   desc: 'Detects evil in 10×120 ft path.' },
  'Protection from Evil':   { level: 1, school: 'Abjuration',   desc: '+2 AC and saves vs evil.' },
  'Sanctuary':              { level: 1, school: 'Abjuration',   desc: 'Enemies save to attack you. Ends if you attack.' },
  // Cleric L2
  'Silence':                { level: 2, school: 'Alteration',   desc: 'No sound in area. Blocks verbal spells.' },
  'Spiritual Hammer':       { level: 2, school: 'Invocation',   desc: 'Magic hammer attacks for 1 round/level.' },
  'Find Traps':             { level: 2, school: 'Divination',   desc: 'Detects all traps — magical and mechanical.' },
  'Slow Poison':            { level: 2, school: 'Necromancy',   desc: 'Delays poison effects. Buys time.' },
  'Speak with Animals':     { level: 2, school: 'Alteration',   desc: 'Two-way communication with animals.' },
  // Cleric L3
  'Cure Disease':           { level: 3, school: 'Necromancy',   desc: 'Cures all diseases.' },
  'Prayer':                 { level: 3, school: 'Conjuration',  desc: '+1 allies, −1 enemies to hit/damage/saves.' },
  'Remove Curse':           { level: 3, school: 'Abjuration',   desc: 'Removes most curses.' },
  'Continual Light':        { level: 3, school: 'Alteration',   desc: 'Permanent daylight 60 ft radius.' },
  'Speak with Dead':        { level: 3, school: 'Necromancy',   desc: 'Ask 2+ questions of a corpse.' },
  // Cleric L4
  'Cure Serious Wounds':    { level: 4, school: 'Necromancy',   desc: 'Heals 2d8+1 HP.' },
  'Neutralize Poison':      { level: 4, school: 'Necromancy',   desc: 'Completely neutralises poison.' },
  "Protection from Evil 10' Radius": { level: 4, school: 'Abjuration', desc: '+2 AC/saves vs evil for all within 10 ft.' },
  'Sticks to Snakes':       { level: 4, school: 'Alteration',   desc: '1d4+2/level sticks become snakes.' },
  // Cleric L5
  'Cure Critical Wounds':   { level: 5, school: 'Necromancy',   desc: 'Heals 3d8+3 HP.' },
  'Flame Strike':           { level: 5, school: 'Invocation',   desc: '6d8 divine fire. Save halves.' },
  'Raise Dead':             { level: 5, school: 'Necromancy',   desc: 'Restores life. Subject loses 1 CON.' },
  'True Seeing':            { level: 5, school: 'Divination',   desc: 'See through illusions, invisibility, ethereal.' },
  'Commune':                { level: 5, school: 'Divination',   desc: 'Ask deity yes/no questions.' },
  // Druid L1
  'Entangle':               { level: 1, school: 'Alteration',   desc: 'Plants hold creatures. Save at −2.' },
  'Faerie Fire':            { level: 1, school: 'Evocation',    desc: 'Outlines targets. +2 attack rolls vs them.' },
  'Purify Food & Drink':    { level: 1, school: 'Alteration',   desc: 'Makes spoiled or poisoned food safe.' },
  // Druid L2
  'Barkskin':               { level: 2, school: 'Alteration',   desc: 'Grants AC 6. Improves by 1 per 4 levels.' },
  'Charm Person or Mammal': { level: 2, school: 'Enchantment',  desc: 'Mammal treats druid as friend. Save negates.' },
  'Obscurement':            { level: 2, school: 'Alteration',   desc: 'Mist reduces visibility to 2d4 feet.' },
  'Produce Flame':          { level: 2, school: 'Alteration',   desc: '1d4+1 fire, touchable or throwable.' },
  // Druid L3
  'Call Lightning':         { level: 3, school: 'Alteration',   desc: '2d8+1d8/level lightning per bolt. Outdoors only.' },
  'Hold Animal':            { level: 3, school: 'Enchantment',  desc: 'Holds 1-4 animals immobile. Save negates.' },
  'Plant Growth':           { level: 3, school: 'Alteration',   desc: 'Plants tangle area to near-impassable density.' },
  'Summon Insects':         { level: 3, school: 'Conjuration',  desc: 'Swarm: 2 HP/round, −4 attacks, −2 saves.' },
};

// Overrides for spells that share a name across classes but differ in level
const SPELL_OVERRIDES: Record<string, { level: number; school: string; desc: string }> = {
  'Hold Person|cleric': { level: 2, school: 'Enchantment',  desc: 'Holds 1-3 humanoids rigid. Save negates.' },
  'Speak with Animals|druid': { level: 1, school: 'Alteration', desc: 'Two-way communication with natural animals.' },
};

interface Props {
  apiUrl: string;
  player: { id: string; token: string; displayName: string };
  campaignId: string;
  characterId: string | null;
  socket: Socket;
  onBack: () => void;
}

export default function GameView({ apiUrl, player, campaignId, characterId, socket, onBack }: Props) {
  const [gameLog, setGameLog] = useState<LogEntry[]>([]);
  const [currentScene, setCurrentScene] = useState<Scene | null>(null);
  const [character, setCharacter] = useState<any>(null);
  const [inputText, setInputText] = useState('');
  const [dmThinking, setDmThinking] = useState('');
  const [showSheet, setShowSheet] = useState(false);
  const [onlinePlayers, setOnlinePlayers] = useState<string[]>([]);
  const [battlefield, setBattlefield] = useState<BattlefieldProfile | null>(null);
  const [encounterActive, setEncounterActive] = useState(false);
  const [campaignMap, setCampaignMap] = useState<CampaignMapData | null>(null);
  const [companions, setCompanions] = useState<Companion[]>([]);
  const [sceneNpcs, setSceneNpcs] = useState<SceneNpc[]>([]);
  const [campaignState, setCampaignState] = useState<CampaignStateView | null>(null);
  const [openPanel, setOpenPanel] = useState<MobilePanel>(null);
  const [showDeathModal, setShowDeathModal] = useState(false);
  const [campaignPhase, setCampaignPhase] = useState<'dungeon' | 'town'>('dungeon');
  const [townName, setTownName] = useState<string>('');
  const [activeContracts, setActiveContracts] = useState<ActiveContract[]>([]);
  const [contractsOpen, setContractsOpen] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  const headers = { Authorization: `Bearer ${player.token}`, 'Content-Type': 'application/json' };

  const fetchContracts = useCallback(async () => {
    try {
      const res = await fetch(`${apiUrl}/api/town/${campaignId}/contracts`, { headers });
      const data = await res.json();
      if (data.ok) setActiveContracts(data.data || []);
    } catch {}
  }, [campaignId, apiUrl]);

  // Initial fetch + refresh on scene changes (which update discovered/cleared counts)
  useEffect(() => {
    fetchContracts();
    const onSceneChange = () => fetchContracts();
    socket.on('game:scene_enter', onSceneChange);
    return () => { socket.off('game:scene_enter', onSceneChange); };
  }, [fetchContracts, socket]);

  useEffect(() => {
    socket.emit('game:join', { campaignId, playerId: player.id });
    return () => { socket.emit('game:leave', { campaignId }); };
  }, [campaignId, player.id, socket]);

  useEffect(() => {
    if (!characterId) return;
    fetch(`${apiUrl}/api/characters/${characterId}`, { headers })
      .then(r => r.json())
      .then(data => { if (data.ok) setCharacter(data.data); });
  }, [characterId]);

  useEffect(() => {
    fetch(`${apiUrl}/api/campaigns/${campaignId}/map`, { headers })
      .then(r => r.json())
      .then(data => { if (data.ok) setCampaignMap(data.data); })
      .catch(() => {});
  }, [campaignId]);

  useEffect(() => {
    const onNarration = (data: { content: string; actor: string; thinking?: boolean }) => {
      if (data.thinking) {
        // AI is processing — show indicator without adding to log
        setDmThinking('The DM considers…');
        return;
      }
      setDmThinking('');
      addLogEntry('narration', data.actor, data.content);
      // Analyse DM narration for combat/environmental sounds
      const detected = detectSoundFromNarration(data.content);
      if (detected) playSound(detected);
    };
    const onSceneEnter = (data: { scene: Scene; description: string }) => {
      setCurrentScene(data.scene);
      setEncounterActive(false);
      setDmThinking('');
      addLogEntry('scene_enter', 'DM', data.description);
      playSound('scene_enter');
    };
    const onPlayerAction = (data: { playerId: string; playerName: string; action: string }) => {
      addLogEntry('player_action', data.playerName, data.action);
    };
    const onDmThinking = (data: { status: string }) => {
      setDmThinking(data.status);
    };
    const onLogEntry = (data: LogEntry) => {
      addLogEntry(data.type, data.actor, data.content);
    };
    const onStateUpdate = (data: { type: string; payload: any }) => {
      if (data.type === 'recent_logs') {
        setGameLog(data.payload.map((l: any) => ({
          id: l.id, type: l.type, actor: l.actor, content: l.content, timestamp: l.timestamp,
        })));
      } else if (data.type === 'character_update') {
        setCharacter((prev: any) => {
          if (prev?.status !== 'dead' && data.payload?.status === 'dead') {
            setShowDeathModal(true);
          }
          return data.payload;
        });
      } else if (data.type === 'scene_update') {
        setCurrentScene(prev => prev && prev.id === data.payload.id
          ? { ...prev, connections: data.payload.connections || prev.connections }
          : prev);
      } else if (data.type === 'battlefield_update') {
        setBattlefield(data.payload.profile || null);
      } else if (data.type === 'map_update') {
        setCampaignMap(data.payload || null);
      } else if (data.type === 'companions_update') {
        setCompanions(data.payload || []);
      } else if (data.type === 'scene_npcs_update') {
        setSceneNpcs(data.payload || []);
      } else if (data.type === 'campaign_state') {
        setCampaignState(data.payload || null);
      } else if (data.type === 'phase_change') {
        setCampaignPhase(data.payload?.phase || 'dungeon');
        if (data.payload?.townName) setTownName(data.payload.townName);
        if (data.payload?.phase === 'town') setAmbience('town_day');
        else setAmbience('dungeon_quiet');
      } else if (data.type === 'campaign') {
        if (data.payload?.campaign_phase) {
          setCampaignPhase(data.payload.campaign_phase);
          if (data.payload.campaign_phase === 'town') setAmbience('town_day');
          else setAmbience('dungeon_quiet');
        }
        if (data.payload?.town_name) setTownName(data.payload.town_name);
      }
    };
    const onPlayerJoined = (data: { playerId: string; playerName: string }) => {
      setOnlinePlayers(prev => [...new Set([...prev, data.playerName])]);
      addLogEntry('system', '', `${data.playerName} has joined the adventure.`);
    };
    const onPlayerLeft = (data: { playerId: string; playerName: string }) => {
      setOnlinePlayers(prev => prev.filter(p => p !== data.playerName));
      addLogEntry('system', '', `${data.playerName} has departed.`);
    };
    const onCombatResult = (data: { result: any }) => {
      addLogEntry('combat', data.result.attacker, data.result.description);
    };
    const onEncounterStart = (data: { round: number }) => {
      setEncounterActive(true);
      addLogEntry('system', '', `Encounter joined. Round ${data.round} begins.`);
      playSound('combat_start');
      setAmbience('dungeon_combat');
    };
    const onTurnPrompt = (data: { name: string; round: number }) => {
      addLogEntry('system', '', `${data.name} has the initiative in round ${data.round}.`);
    };
    const onEncounterUpdate = (data: { status?: string; round?: number }) => {
      if (data.status === 'resolved') {
        setEncounterActive(false);
        addLogEntry('system', '', 'The encounter is resolved.');
        setAmbience('dungeon_quiet');
      } else if (data.status === 'fled') {
        setEncounterActive(false);
        addLogEntry('system', '', 'The encounter breaks apart as one side flees.');
        setAmbience('dungeon_quiet');
      } else if (data.round) {
        addLogEntry('system', '', `Combat pressure shifts into round ${data.round}.`);
      }
    };

    socket.on('game:narration', onNarration);
    socket.on('game:scene_enter', onSceneEnter);
    socket.on('game:player_action', onPlayerAction);
    socket.on('game:dm_thinking', onDmThinking);
    socket.on('game:log_entry', onLogEntry);
    socket.on('game:state_update', onStateUpdate);
    socket.on('game:player_joined', onPlayerJoined);
    socket.on('game:player_left', onPlayerLeft);
    socket.on('game:combat_result', onCombatResult);
    socket.on('game:encounter_start', onEncounterStart);
    socket.on('game:encounter_update', onEncounterUpdate);
    socket.on('game:turn_prompt', onTurnPrompt);

    return () => {
      socket.off('game:narration', onNarration);
      socket.off('game:scene_enter', onSceneEnter);
      socket.off('game:player_action', onPlayerAction);
      socket.off('game:dm_thinking', onDmThinking);
      socket.off('game:log_entry', onLogEntry);
      socket.off('game:state_update', onStateUpdate);
      socket.off('game:player_joined', onPlayerJoined);
      socket.off('game:player_left', onPlayerLeft);
      socket.off('game:combat_result', onCombatResult);
      socket.off('game:encounter_start', onEncounterStart);
      socket.off('game:encounter_update', onEncounterUpdate);
      socket.off('game:turn_prompt', onTurnPrompt);
    };
  }, [socket]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [gameLog, dmThinking]);

  // Set dungeon ambience when game view mounts (deferred until first user interaction)
  useEffect(() => {
    setAmbience('dungeon_quiet');
    return () => { setAmbience('silence'); };
  }, []);

  const addLogEntry = (type: string, actor: string, content: string) => {
    setGameLog(prev => [...prev, {
      id: crypto.randomUUID(), type, actor, content,
      timestamp: new Date().toISOString(),
    }]);
  };

  const sendAction = () => {
    if (!inputText.trim()) return;
    playSound('action_submit');
    socket.emit('game:action', { campaignId, action: inputText });
    setInputText('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendAction();
    }
  };

  const quickAction = (action: string) => {
    socket.emit('game:action', { campaignId, action });
  };

  const recruitableNpc = sceneNpcs.find((npc) => !npc.joinedParty);
  const leadCompanion = companions.find((companion) => companion.joinedParty);
  const inventory: InventoryEntry[] = character?.inventory
    ? (typeof character.inventory === 'string' ? JSON.parse(character.inventory) : character.inventory)
    : [];
  const getItemCount = (itemName: string) => inventory
    .filter((item) => item.item === itemName)
    .reduce((total, item) => total + Number(item.quantity || 0), 0);
  const carriedSupplies = {
    torches: getItemCount('Torch'),
    rations: getItemCount('Ration'),
    bandages: getItemCount('Bandage Roll'),
    arrows: getItemCount('Arrow'),
    rope: getItemCount('Rope (50 ft)'),
    holySymbol: getItemCount('Holy Symbol'),
  };
  const className = String(character?.char_class || '').toLowerCase();
  const classAction = encounterActive
    ? className === 'paladin' ? 'Lay on hands'
      : className === 'cleric' ? 'Turn undead'
      : className === 'druid' ? 'Lead a prayer'
      : className === 'ranger' ? 'Rally the line'
      : className === 'thief' ? 'Check supplies'
      : className === 'fighter' ? 'Rally the line'
      : 'Take stock'
    : className === 'paladin' ? 'Lead a prayer'
      : className === 'cleric' || className === 'druid' ? 'Bless the company'
      : className === 'ranger' ? 'Read their intent'
      : className === 'thief' ? 'Check supplies'
      : 'Take stock';
  const classActionTwo = encounterActive
    ? className === 'paladin' ? 'Smite evil'
      : className === 'cleric' ? 'Call for quarter'
      : className === 'thief' ? 'Take cover and aim'
      : className === 'ranger' ? 'Take cover and aim'
      : className === 'fighter' ? 'Hold the doorway'
      : null
    : className === 'paladin' ? 'Sense evil'
      : className === 'cleric' || className === 'druid' ? 'Lead a prayer'
      : className === 'thief' ? 'Share supplies'
      : className === 'ranger' ? 'Read their intent'
      : null;
  const classRail = buildClassActionRail({
    className,
    encounterActive,
    leadCompanionName: leadCompanion?.name || null,
    recruitableNpcName: recruitableNpc?.name || null,
  });
  const signatureActions = [
    classAction,
    classActionTwo,
    encounterActive ? 'Brace and hold' : 'Read the battlefield',
    leadCompanion && !leadCompanion.personalQuestResolved
      ? leadCompanion.personalQuestNeed
      : null,
  ].filter(Boolean) as string[];

  const quickActions = dedupeActions([
    'Look around',
    'Listen carefully',
    'Read the battlefield',
    ...signatureActions,
    leadCompanion && !leadCompanion.personalQuestResolved
      ? leadCompanion.personalQuestNeed
      : (leadCompanion ? `Ask ${leadCompanion.name} to scout ahead` : (recruitableNpc ? `Ask ${recruitableNpc.name} to join us` : (encounterActive ? 'Hold the doorway' : 'Search for traps'))),
    leadCompanion ? `Ask ${leadCompanion.name} to scout ahead` : (recruitableNpc ? `Ask ${recruitableNpc.name} to join us` : (encounterActive ? 'Hold the doorway' : 'Search for traps')),
    leadCompanion ? `Comfort ${leadCompanion.name}` : (encounterActive ? 'Take cover and aim' : 'Search for hidden doors'),
    recruitableNpc ? `Ask ${recruitableNpc.name} to join us` : (encounterActive ? 'Hold the doorway' : 'Search for traps'),
    encounterActive ? 'Drive them into the hazard' : 'Secure this room',
    encounterActive ? 'Fall back to cover' : 'Mark fallback point',
    !encounterActive ? 'Probe floor ahead' : null,
    !encounterActive ? 'Set ambush' : null,
    !encounterActive ? 'Bar the door' : null,
    !encounterActive ? 'Loot carefully' : null,
    !encounterActive && carriedSupplies.bandages > 0 ? 'Use bandage' : null,
    !encounterActive && carriedSupplies.torches > 0 ? 'Light a torch' : null,
    !encounterActive && carriedSupplies.rope > 0 ? 'Set rope' : null,
    !encounterActive && carriedSupplies.holySymbol > 0 ? 'Present holy symbol' : null,
    encounterActive ? 'Brace and hold' : 'Rest',
  ]);

  const secondaryQuickActions = quickActions.filter((action) => !signatureActions.includes(action));

  const joinedCompanions = companions.filter(c => c.joinedParty);
  const expeditionBadges = [
    encounterActive ? `Combat live` : null,
    campaignState ? `Pressure ${campaignState.encounterPressure}/10` : null,
    campaignState?.delve ? `Light ${campaignState.delve.lightLevel}` : null,
    joinedCompanions.length > 0 ? `Company ${joinedCompanions.length}` : null,
    carriedSupplies.torches > 0 ? `${carriedSupplies.torches} torches` : null,
  ].filter(Boolean) as string[];
  const mobilePanels: Array<{ key: NonNullable<MobilePanel>; label: string; icon: string; show: boolean; badge: number }> = [
    { key: 'character', label: 'Char',  icon: '⚔',  show: !!character,                                  badge: 0 },
    { key: 'spells',    label: 'Spells',icon: '✦',  show: !!character?.spellSlots || !!character?.spell_slots, badge: 0 },
    { key: 'company',   label: 'Party', icon: '⛨',  show: joinedCompanions.length > 0,                  badge: joinedCompanions.length },
    { key: 'scene',     label: 'Scene', icon: '◈',  show: sceneNpcs.length > 0 || !!battlefield,         badge: sceneNpcs.length },
    { key: 'expedition',label: 'Delve', icon: '⚖',  show: !!campaignState,                              badge: 0 },
    { key: 'map',       label: 'Map',   icon: '◎',  show: !!campaignMap,                                badge: 0 },
  ].filter(p => p.show) as Array<{ key: NonNullable<MobilePanel>; label: string; icon: string; show: boolean; badge: number }>;

  const panelTitle = openPanel === 'character' ? (character?.name || 'Character')
    : openPanel === 'spells' ? 'Spells'
    : openPanel === 'company' ? 'Company'
    : openPanel === 'scene' ? 'In This Scene'
    : openPanel === 'expedition' ? 'Expedition'
    : 'Map';

  const renderLogEntries = () => {
    // Build companion name set for O(1) actor detection
    const companionNames = new Set(companions.map((c) => c.name));

    return (
    <>
      {gameLog.length === 0 && (
        <div className="text-center py-16 text-ink-faint font-body italic">
          <p>The adventure awaits...</p>
          <p className="text-xs mt-2">Type an action below to begin.</p>
        </div>
      )}
      {gameLog.map(entry => {
        // Companion speech: narration whose actor is a companion, not the DM
        const isCompanionSpeech =
          entry.type === 'narration' &&
          entry.actor !== '' &&
          entry.actor !== 'DM' &&
          entry.actor !== 'System' &&
          companionNames.has(entry.actor);

        return (
        <div
          key={entry.id}
          className={`animate-fade-in ${
            isCompanionSpeech
              ? 'pl-5 ml-2 border-l-2 border-amber-400/30'
              : getLogEntryClass(entry.type)
          }`}
        >
          {entry.actor && entry.type !== 'system' && (
            <span className={`font-heading font-bold text-xs uppercase tracking-wide ${
              isCompanionSpeech
                ? 'text-amber-400'
                : entry.type === 'narration' || entry.type === 'dm_response' || entry.type === 'scene_enter'
                  ? 'text-leather'
                  : entry.type === 'combat'
                    ? 'text-blood'
                    : 'text-ink-light'
            }`}>
              {entry.actor}
            </span>
          )}
          <p className={`font-body text-sm leading-relaxed ${
            isCompanionSpeech
              ? 'text-amber-200 italic'
              : entry.type === 'narration' || entry.type === 'dm_response' || entry.type === 'scene_enter'
                ? 'text-ink-light italic'
                : entry.type === 'combat'
                  ? 'text-ink font-mono text-xs'
                  : entry.type === 'roll'
                    ? 'text-silver font-mono text-xs'
                    : entry.type === 'system'
                      ? 'text-ink-faint italic text-xs'
                      : 'text-ink'
          }`}>
            {entry.content}
          </p>
        </div>
        );
      })}
      {dmThinking && (
        <div className="animate-fade-in">
          <p className="text-sm text-leather/60 font-body italic flex items-center gap-2">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-leather/40 animate-pulse" />
            {dmThinking}
          </p>
        </div>
      )}
      <div ref={logEndRef} />
    </>
  );
  };

  // ── Town phase: hand off to TownView ────────────────────────────────────
  if (campaignPhase === 'town') {
    return (
      <TownView
        apiUrl={apiUrl}
        player={player}
        campaignId={campaignId}
        socket={socket}
        onBack={onBack}
        onLeave={() => setCampaignPhase('dungeon')}
      />
    );
  }

  return (
    <div className="relative">

      {/* ═══════════════════════════════════════════════════
          MOBILE LAYOUT  (< lg)
          Intentionally designed for iPhone:
            • thin top bar — name + HP only
            • scene strip — location + exits
            • log — fills the screen
            • sticky bottom — quick actions + input + tab bar
          ═══════════════════════════════════════════════════ */}
      <div className="lg:hidden flex flex-col" style={{ height: '100dvh' }}>

        {/* ── Top bar ── */}
        <div className="flex-shrink-0 flex items-center gap-2 border-b border-leather/15 bg-parchment-light/80 px-3 py-2.5">
          <button
            onClick={onBack}
            className="flex-shrink-0 text-base text-leather font-body pr-1 py-1 -ml-1 touch-manipulation"
            aria-label="Leave campaign"
          >
            ←
          </button>

          {character ? (
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-heading text-sm font-bold text-leather-dark truncate leading-tight">
                  {character.name}
                </span>
                <span className="hidden min-[360px]:inline text-[10px] font-heading uppercase tracking-wide text-ink-faint">
                  L{character.level} {character.char_class}
                </span>
                {encounterActive && (
                  <span className="flex-shrink-0 text-[9px] font-heading font-bold bg-blood text-parchment-light px-1.5 py-0.5 rounded uppercase tracking-wide">
                    Combat
                  </span>
                )}
                <span className={`flex-shrink-0 text-xs font-heading font-bold ml-auto ${
                  character.hp <= character.max_hp * 0.25 ? 'text-blood' : 'text-ink-faint'
                }`}>
                  {character.hp}/{character.max_hp}
                </span>
              </div>
              <div className="mt-1 h-1 rounded-full bg-parchment-dark/30 overflow-hidden">
                <div className="h-full rounded-full transition-all" style={{
                  width: `${Math.min(100, (character.hp / character.max_hp) * 100)}%`,
                  backgroundColor: character.hp > character.max_hp * 0.5 ? '#2d5a1e'
                    : character.hp > character.max_hp * 0.25 ? '#c49a2a' : '#8b1a1a',
                }} />
              </div>
            </div>
          ) : (
            <span className="flex-1 font-heading text-sm text-ink-faint">Adventure</span>
          )}
        </div>

        {/* ── Scene strip ── */}
        {currentScene && (
          <div className="flex-shrink-0 flex items-center gap-2 px-3 py-2 border-b border-leather/10 bg-parchment/50 overflow-x-auto">
            <span className="font-heading font-bold text-leather-dark text-xs flex-shrink-0 truncate max-w-[45%]">
              {currentScene.name}
            </span>
            {currentScene.connections.length > 0 && (
              <div className="flex gap-1.5 flex-nowrap">
                {currentScene.connections.map((c, i) => (
                  <button
                    key={i}
                    onClick={() => quickAction(`I go ${c.direction}`)}
                    className="flex-shrink-0 text-[11px] px-2.5 py-1 rounded-full border border-leather/25 text-leather font-heading whitespace-nowrap active:bg-leather/10 touch-manipulation"
                  >
                    {c.direction}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {expeditionBadges.length > 0 && (
          <div className="flex-shrink-0 overflow-x-auto border-b border-leather/10 bg-parchment-light/60 px-3 py-2">
            <div className="flex gap-1.5">
              {expeditionBadges.map((badge) => (
                <span
                  key={badge}
                  className="whitespace-nowrap rounded-full border border-leather/15 bg-parchment px-2.5 py-1 text-[10px] font-heading uppercase tracking-wide text-ink-faint"
                >
                  {badge}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* ── Active contracts strip ── */}
        {activeContracts.length > 0 && (
          <div className="flex-shrink-0 border-b border-leather/10 bg-parchment/60">
            <button
              className="w-full flex items-center justify-between px-3 py-1.5 text-left"
              onClick={() => setContractsOpen(o => !o)}
            >
              <span className="text-[10px] font-heading uppercase tracking-wider text-leather">
                📋 Jobs ({activeContracts.length})
              </span>
              <span className="text-[10px] font-heading text-ink-faint">
                {contractsOpen ? '▲' : '▼'}
              </span>
            </button>
            {contractsOpen && (
              <div className="px-3 pb-2 space-y-1.5">
                {activeContracts.map((c) => (
                  <div key={c.id} className="rounded-lg border border-leather/15 bg-parchment-light/60 px-2.5 py-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-heading font-semibold text-leather-dark truncate min-w-0">{c.title}</span>
                      {c.readyToClaim && (
                        <span className="flex-shrink-0 text-[9px] font-heading font-bold bg-forest/20 text-forest px-1.5 py-0.5 rounded uppercase">Done</span>
                      )}
                    </div>
                    <div className="mt-1">
                      <div className="flex justify-between text-[10px] font-body text-ink-faint mb-0.5">
                        <span>{c.progressText}</span>
                        <span>{c.reward} GP</span>
                      </div>
                      <div className="h-1 rounded-full bg-parchment-dark/30 overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all"
                          style={{
                            width: `${Math.min(100, (c.progress / c.objectiveTarget) * 100)}%`,
                            backgroundColor: c.readyToClaim ? '#2d5a1e' : '#8b5e2a',
                          }}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Game log — dominant surface ── */}
        <div className="flex-1 min-h-0 overflow-y-auto px-3 pt-3 pb-2 space-y-3 bg-[radial-gradient(circle_at_top,rgba(255,248,231,0.55),rgba(246,238,221,0)_55%)]">
          {renderLogEntries()}
        </div>

        {/* ── Sticky bottom action area ── */}
        <div className="flex-shrink-0 border-t border-leather/15 bg-parchment-light/80 backdrop-blur-sm">

          {classRail.actions.length > 0 && (
            <div className="border-b border-leather/8 bg-[linear-gradient(180deg,rgba(107,68,35,0.08),rgba(107,68,35,0))] px-3 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-base leading-none">{classRail.icon}</span>
                    <p className="truncate text-[11px] font-heading font-bold uppercase tracking-[0.18em] text-leather-dark">
                      {classRail.title}
                    </p>
                  </div>
                  <p className="mt-0.5 text-[11px] font-body italic text-ink-faint">{classRail.summary}</p>
                </div>
                <span className="shrink-0 rounded-full border border-leather/15 bg-parchment px-2 py-1 text-[9px] font-heading uppercase tracking-wide text-ink-faint">
                  {encounterActive ? 'battle rhythm' : 'delve rhythm'}
                </span>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {classRail.actions.map((entry) => (
                  <button
                    key={entry.action}
                    onClick={() => quickAction(entry.action)}
                    className="rounded-xl border border-leather/15 bg-parchment/85 px-3 py-2.5 text-left shadow-sm transition-colors active:bg-leather/10 touch-manipulation"
                  >
                    <div className="flex items-start gap-2">
                      <span className="mt-0.5 text-sm leading-none">{entry.icon}</span>
                      <div className="min-w-0">
                        <div className="truncate text-xs font-heading font-semibold text-leather-dark">{entry.label}</div>
                        <div className="mt-0.5 text-[10px] font-body leading-relaxed text-ink-faint">{entry.hint}</div>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Quick actions — horizontal scroll, touch-friendly */}
          <div className="space-y-2 border-b border-leather/8 px-3 py-2">
            {signatureActions.length > 0 && (
              <div className="overflow-x-auto">
                <div className="flex gap-2 flex-nowrap">
                  {signatureActions.map(action => (
                    <button
                      key={action}
                      onClick={() => quickAction(action)}
                      className="flex-shrink-0 whitespace-nowrap rounded-full bg-leather px-3 py-2 text-xs font-heading font-semibold text-parchment-light shadow-sm active:bg-leather-dark touch-manipulation"
                    >
                      {action}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="overflow-x-auto">
              <div className="flex gap-2 flex-nowrap">
              {secondaryQuickActions.map(action => (
                <button
                  key={action}
                  onClick={() => quickAction(action)}
                  className="flex-shrink-0 text-xs px-3 py-2 rounded-full border border-leather/20 text-leather font-heading whitespace-nowrap active:bg-leather/10 transition-colors touch-manipulation"
                >
                  {action}
                </button>
              ))}
              </div>
            </div>
          </div>

          {/* Input row */}
          <div className="flex gap-2 px-3 py-2.5">
            <input
              type="text"
              value={inputText}
              onChange={e => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="What do you do?"
              className="flex-1 px-4 py-3 rounded-xl border border-leather/20 bg-parchment font-body text-sm text-ink placeholder:text-ink-faint/50 focus:outline-none focus:border-leather/50 focus:ring-1 focus:ring-leather/20"
            />
            <button
              onClick={sendAction}
              disabled={!inputText.trim()}
              className="rounded-xl bg-leather px-5 py-3 text-sm font-heading font-semibold text-parchment-light hover:bg-leather-dark disabled:opacity-30 active:bg-leather-dark flex-shrink-0 touch-manipulation"
            >
              Act
            </button>
          </div>

          {/* Bottom tab bar — panel navigation */}
          {mobilePanels.length > 0 && (
            <div
              className="flex border-t border-leather/10"
              style={{ paddingBottom: 'max(4px, env(safe-area-inset-bottom, 4px))' }}
            >
              {mobilePanels.map(({ key, label, icon, badge }) => {
                const active = openPanel === key;
                return (
                  <button
                    key={key}
                    onClick={() => setOpenPanel(active ? null : key)}
                    className={`relative flex-1 flex flex-col items-center justify-center py-2 gap-0.5 transition-colors touch-manipulation ${
                      active
                        ? 'text-leather-dark bg-leather/8'
                        : 'text-ink-faint active:text-leather'
                    }`}
                  >
                    <span className="text-base leading-none">{icon}</span>
                    <span className="text-[9px] font-heading uppercase tracking-wider leading-none">{label}</span>
                    {badge > 0 && !active && (
                      <span className="absolute top-1.5 right-[18%] w-3.5 h-3.5 rounded-full bg-leather text-parchment-light text-[7px] font-bold flex items-center justify-center leading-none">
                        {badge > 9 ? '9+' : badge}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════
          DESKTOP LAYOUT  (≥ lg)
          Sidebar + log panel — unchanged from before
          ═══════════════════════════════════════════════════ */}
      <div className="hidden lg:flex gap-4 h-[calc(100vh-120px)]">

        {/* ─ Desktop Sidebar ─ */}
        <div className="w-72 flex-shrink-0 flex flex-col gap-3 overflow-y-auto pr-1">
          <button onClick={onBack} className="text-xs text-leather hover:text-leather-dark font-body">
            &larr; Leave Campaign
          </button>

          {character && (
            <div className="rounded-lg border border-leather/15 bg-parchment-light/40 p-3 sm:p-4">
              <button onClick={() => setShowSheet(!showSheet)} className="w-full text-left">
                <h3 className="font-heading font-bold text-leather-dark text-lg tracking-wide">
                  {character.name}
                </h3>
                <p className="text-xs text-ink-faint font-body">
                  Level {character.level} {character.race} {character.char_class}
                </p>
              </button>
              <div className="h-px bg-leather/10 my-3" />
              <div className="mb-3">
                <div className="flex justify-between text-xs font-heading mb-1">
                  <span className="text-ink-faint">HP</span>
                  <span className={character.hp <= character.max_hp * 0.25 ? 'text-blood font-bold' : 'text-ink-light'}>
                    {character.hp}/{character.max_hp}
                  </span>
                </div>
                <div className="h-2 bg-parchment-dark/30 rounded-full overflow-hidden">
                  <div className="h-full rounded-full transition-all" style={{
                    width: `${(character.hp / character.max_hp) * 100}%`,
                    backgroundColor: character.hp > character.max_hp * 0.5 ? '#2d5a1e'
                      : character.hp > character.max_hp * 0.25 ? '#c49a2a' : '#8b1a1a',
                  }} />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-1 text-center mb-3">
                <div className="text-xs"><span className="text-ink-faint font-heading">AC</span> <span className="font-bold font-heading">{character.ac}</span></div>
                <div className="text-xs"><span className="text-ink-faint font-heading">THAC0</span> <span className="font-bold font-heading">{character.thac0}</span></div>
                <div className="text-xs"><span className="text-ink-faint font-heading">Mv</span> <span className="font-bold font-heading">{character.base_movement || character.baseMovement}</span></div>
              </div>
              <div className="grid grid-cols-3 gap-1 text-center mb-3">
                {[['STR', character.str], ['DEX', character.dex], ['CON', character.con],
                  ['INT', character.int], ['WIS', character.wis], ['CHA', character.cha]].map(([label, val]) => (
                  <div key={label as string} className="text-xs">
                    <span className="text-ink-faint font-heading">{label}</span>{' '}
                    <span className="font-heading font-semibold">{val}</span>
                    {label === 'STR' && character.str_percentile && (
                      <span className="text-ink-faint">/{character.str_percentile}</span>
                    )}
                  </div>
                ))}
              </div>
              <div className="text-xs space-y-0.5">
                <div className="font-heading font-bold text-ink-faint uppercase tracking-wider text-[10px] mb-1">Saving Throws</div>
                {[['PP', character.save_paralysis], ['RW', character.save_rod],
                  ['Ptr', character.save_petrify], ['BW', character.save_breath], ['Sp', character.save_spell]]
                  .map(([label, val]) => (
                    <div key={label as string} className="flex justify-between">
                      <span className="text-ink-faint">{label}</span>
                      <span className="font-heading font-semibold">{val}</span>
                    </div>
                  ))}
              </div>
              <div className="h-px bg-leather/10 my-3" />
              <div className="flex justify-between text-xs">
                <span className="text-ink-faint font-heading">Gold</span>
                <span className="font-heading font-bold text-gold">{character.gold}</span>
              </div>
              <div className="flex justify-between text-xs mt-1">
                <span className="text-ink-faint font-heading">XP</span>
                <span className="font-heading font-semibold">{character.xp}/{character.xp_next || character.xpNext}</span>
              </div>
            </div>
          )}

          {onlinePlayers.length > 0 && (
            <div className="border border-leather/15 rounded-lg p-3 bg-parchment-light/40">
              <div className="text-[10px] font-heading font-bold text-ink-faint uppercase tracking-wider mb-2">Adventurers Present</div>
              {onlinePlayers.map(name => (
                <div key={name} className="text-xs font-body text-ink-light flex items-center gap-1.5">
                  <div className="w-1.5 h-1.5 rounded-full bg-heal" />
                  {name}
                </div>
              ))}
            </div>
          )}

          {battlefield && (
            <div className="border border-leather/15 rounded-lg p-3 bg-parchment-light/40">
              <div className="text-[10px] font-heading font-bold text-ink-faint uppercase tracking-wider mb-2">Battlefield Read</div>
              <p className="text-xs font-body italic text-ink-light leading-relaxed">{battlefield.summary}</p>
              <div className="grid grid-cols-2 gap-1 mt-3 text-[11px] font-body text-ink-faint">
                <div>Sight: <span className="text-ink-light">{battlefield.visibility}</span></div>
                <div>Footing: <span className="text-ink-light">{battlefield.footing}</span></div>
                <div>Cover: <span className="text-ink-light">{battlefield.cover ? 'usable' : 'poor'}</span></div>
                <div>Line: <span className="text-ink-light">{battlefield.chokepoint ? 'narrow' : 'open'}</span></div>
              </div>
              {battlefield.hazard && (
                <div className="mt-2 text-[11px] font-body text-blood">Hazard: {battlefield.hazard}</div>
              )}
              <div className="mt-3 space-y-1">
                {battlefield.tacticalAdvice.slice(0, 3).map((tip) => (
                  <p key={tip} className="text-[11px] font-body text-ink-faint">{tip}</p>
                ))}
              </div>
            </div>
          )}

          {campaignState && (
            <div className="border border-leather/15 rounded-lg p-3 bg-parchment-light/40">
              <div className="text-[10px] font-heading font-bold text-ink-faint uppercase tracking-wider mb-2">Expedition State</div>
              <div className="mb-2">
                <div className="flex justify-between text-[11px] font-body text-ink-faint">
                  <span>Pressure</span>
                  <span className="text-ink-light">{campaignState.encounterPressure}/10</span>
                </div>
                <div className="mt-1 h-2 rounded-full bg-parchment-dark/30 overflow-hidden">
                  <div className="h-full rounded-full transition-all" style={{
                    width: `${Math.min(100, campaignState.encounterPressure * 10)}%`,
                    backgroundColor: campaignState.encounterPressure >= 7 ? '#8b1a1a'
                      : campaignState.encounterPressure >= 4 ? '#c49a2a' : '#2d5a1e',
                  }} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-1 text-[11px] font-body text-ink-faint">
                <div>Torches: <span className="text-ink-light">{carriedSupplies.torches} on hand</span></div>
                <div>Rations: <span className="text-ink-light">{carriedSupplies.rations} on hand</span></div>
                <div>Arrows: <span className="text-ink-light">{carriedSupplies.arrows} on hand</span></div>
                <div>Bandages: <span className="text-ink-light">{carriedSupplies.bandages} on hand</span></div>
                <div>Spent torches: <span className="text-ink-light">{campaignState.supply.torchesBurned}</span></div>
                <div>Spent rations: <span className="text-ink-light">{campaignState.supply.rationsSpent}</span></div>
                <div>Spent arrows: <span className="text-ink-light">{campaignState.supply.arrowsSpent}</span></div>
                <div>Used bandages: <span className="text-ink-light">{campaignState.supply.bandagesUsed}</span></div>
              </div>
              <div className="mt-3 space-y-2">
                {campaignState.factions.slice(0, 4).map((faction) => (
                  <div key={faction.key} className="rounded-lg border border-leather/10 bg-parchment/60 p-2">
                    <div className="flex items-center justify-between text-[11px] font-heading">
                      <span className="text-leather-dark">{faction.name}</span>
                      <span className="text-ink-faint">Rep {faction.reputation} · Heat {faction.heat}</span>
                    </div>
                    <div className="mt-1 text-[11px] font-body text-ink-faint">{faction.summary}</div>
                  </div>
                ))}
              </div>
              {campaignState.recentEvents.length > 0 && (
                <div className="mt-3 space-y-1">
                  {campaignState.recentEvents.slice(0, 3).map((event) => (
                    <p key={event} className="text-[11px] font-body text-ink-faint italic">{event}</p>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeContracts.length > 0 && (
            <div className="border border-leather/15 rounded-lg p-3 bg-parchment-light/40">
              <div className="text-[10px] font-heading font-bold text-ink-faint uppercase tracking-wider mb-2">Active Contracts</div>
              <div className="space-y-2">
                {activeContracts.map((c) => (
                  <div key={c.id} className="rounded-lg border border-leather/10 bg-parchment/60 p-2">
                    <div className="flex items-start justify-between gap-1">
                      <span className="text-[11px] font-heading font-semibold text-leather-dark leading-tight">{c.title}</span>
                      {c.readyToClaim && (
                        <span className="flex-shrink-0 text-[8px] font-heading font-bold bg-forest/20 text-forest px-1 py-0.5 rounded uppercase">Ready</span>
                      )}
                    </div>
                    <div className="mt-1.5">
                      <div className="flex justify-between text-[10px] font-body text-ink-faint mb-1">
                        <span>{c.progressText}</span>
                        <span className="text-amber-700 font-semibold">{c.reward} GP</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-parchment-dark/30 overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all"
                          style={{
                            width: `${Math.min(100, (c.progress / c.objectiveTarget) * 100)}%`,
                            backgroundColor: c.readyToClaim ? '#2d5a1e' : '#8b5e2a',
                          }}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {companions.length > 0 && (
            <div className="border border-leather/15 rounded-lg p-3 bg-parchment-light/40">
              <div className="text-[10px] font-heading font-bold text-ink-faint uppercase tracking-wider mb-2">Company</div>
              <div className="space-y-2">
                {companions.filter((c) => c.joinedParty).map((companion) => (
                  <CompanionCard key={companion.id} companion={companion} quickAction={quickAction} />
                ))}
              </div>
            </div>
          )}

          {sceneNpcs.length > 0 && (
            <div className="border border-leather/15 rounded-lg p-3 bg-parchment-light/40">
              <div className="text-[10px] font-heading font-bold text-ink-faint uppercase tracking-wider mb-2">In This Scene</div>
              <div className="space-y-2">
                {sceneNpcs.map((npc) => (
                  <SceneNpcCard key={npc.id} npc={npc} quickAction={quickAction} />
                ))}
              </div>
            </div>
          )}

          <CampaignMap mapData={campaignMap} />
        </div>

        {/* ─ Desktop Log Panel ─ */}
        <div className="flex-1 flex flex-col overflow-hidden rounded-lg border border-leather/15 bg-parchment-light/30">

          {/* Scene header */}
          {currentScene && (
            <div className="flex-shrink-0 border-b border-leather/10 bg-parchment-light/40 px-5 py-3">
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-heading font-bold tracking-wide text-leather-dark text-base truncate min-w-0">
                  {currentScene.name}
                </h2>
                {currentScene.connections.length > 0 && (
                  <div className="flex-shrink-0 flex gap-1.5 overflow-x-auto max-w-[55%]">
                    {currentScene.connections.map((c, i) => (
                      <button key={i} onClick={() => quickAction(`I go ${c.direction}`)}
                        className="flex-shrink-0 text-xs px-2 py-1 rounded border border-leather/15 text-leather font-heading hover:bg-leather/5 whitespace-nowrap">
                        {c.direction}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Game log */}
          <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-3">
            {renderLogEntries()}
          </div>

          {/* Desktop input area */}
          <div className="flex-shrink-0 border-t border-leather/10 bg-parchment-light/40 p-4">
            <div className="mb-3 -mx-1 overflow-x-auto">
              <div className="flex gap-2 flex-nowrap px-1 sm:flex-wrap">
                {quickActions.map(action => (
                  <button key={action} onClick={() => quickAction(action)}
                    className="flex-shrink-0 text-xs px-3 py-1.5 rounded-full border border-leather/15 text-leather font-heading hover:bg-leather/5 transition-colors whitespace-nowrap">
                    {action}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={inputText}
                onChange={e => setInputText(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="What do you do?"
                className="flex-1 px-4 py-3 rounded-lg border border-leather/20 bg-parchment font-body text-sm text-ink placeholder:text-ink-faint/50 focus:outline-none focus:border-leather/50 focus:ring-1 focus:ring-leather/20"
              />
              <button onClick={sendAction} disabled={!inputText.trim()}
                className="rounded-lg bg-leather px-5 py-3 text-sm font-heading font-semibold text-parchment-light transition-colors hover:bg-leather-dark disabled:opacity-30 flex-shrink-0">
                Act
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════
          MOBILE PANEL DRAWER (bottom sheet — shared)
          ═══════════════════════════════════════════════════ */}
      {openPanel && (
        <div className="fixed inset-0 z-50 lg:hidden" aria-modal="true">
          <div
            className="absolute inset-0 bg-ink/40 backdrop-blur-sm"
            onClick={() => setOpenPanel(null)}
          />
          <div
            className="absolute inset-x-0 bottom-0 flex flex-col bg-parchment rounded-t-2xl shadow-2xl"
            style={{ maxHeight: '82vh', paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex-shrink-0 flex items-center justify-between border-b border-leather/15 px-4 py-3">
              <h3 className="font-heading font-bold text-leather-dark">{panelTitle}</h3>
              <button
                onClick={() => setOpenPanel(null)}
                className="text-xs font-heading text-ink-faint hover:text-ink px-3 py-1.5 rounded border border-leather/15 hover:border-leather/30 transition-colors touch-manipulation"
              >
                Close
              </button>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto">
              {openPanel === 'character' && character && (
                <MobileCharacterPanel
                  character={character}
                  onOpenSheet={() => { setOpenPanel(null); setShowSheet(true); }}
                />
              )}
              {openPanel === 'spells' && character && (
                <SpellsPanel
                  character={character}
                  charClass={className}
                  quickAction={(a) => { quickAction(a); setOpenPanel(null); }}
                />
              )}
              {openPanel === 'company' && (
                <div className="p-4 space-y-3">
                  {joinedCompanions.length === 0 ? (
                    <p className="text-sm font-body text-ink-faint italic">No companions in your company yet.</p>
                  ) : (
                    joinedCompanions.map(c => (
                      <CompanionCard key={c.id} companion={c} quickAction={(a) => { quickAction(a); setOpenPanel(null); }} />
                    ))
                  )}
                </div>
              )}
              {openPanel === 'scene' && (
                <div className="p-4 space-y-3">
                  {battlefield && (
                    <div className="rounded-lg border border-leather/15 bg-parchment-light/40 p-3">
                      <div className="text-[10px] font-heading font-bold text-ink-faint uppercase tracking-wider mb-2">Battlefield Read</div>
                      <p className="text-sm font-body italic text-ink-light leading-relaxed">{battlefield.summary}</p>
                      <div className="grid grid-cols-2 gap-1 mt-3 text-xs font-body text-ink-faint">
                        <div>Sight: <span className="text-ink-light">{battlefield.visibility}</span></div>
                        <div>Footing: <span className="text-ink-light">{battlefield.footing}</span></div>
                        <div>Cover: <span className="text-ink-light">{battlefield.cover ? 'usable' : 'poor'}</span></div>
                        <div>Line: <span className="text-ink-light">{battlefield.chokepoint ? 'narrow' : 'open'}</span></div>
                      </div>
                      {battlefield.hazard && (
                        <div className="mt-2 text-xs font-body text-blood">Hazard: {battlefield.hazard}</div>
                      )}
                      {battlefield.tacticalAdvice.length > 0 && (
                        <div className="mt-3 space-y-1">
                          {battlefield.tacticalAdvice.slice(0, 3).map(tip => (
                            <p key={tip} className="text-xs font-body text-ink-faint">{tip}</p>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  {sceneNpcs.length === 0 && !battlefield && (
                    <p className="text-sm font-body text-ink-faint italic">No notable figures in this scene.</p>
                  )}
                  {sceneNpcs.map(npc => (
                    <SceneNpcCard key={npc.id} npc={npc} quickAction={(a) => { quickAction(a); setOpenPanel(null); }} />
                  ))}
                </div>
              )}
              {openPanel === 'expedition' && campaignState && (
                <div className="p-4 space-y-4">
                  <div>
                    <div className="flex justify-between text-sm font-heading text-ink-faint mb-1">
                      <span>Encounter Pressure</span>
                      <span className="text-ink-light font-bold">{campaignState.encounterPressure}/10</span>
                    </div>
                    <div className="h-3 rounded-full bg-parchment-dark/30 overflow-hidden">
                      <div className="h-full rounded-full transition-all" style={{
                        width: `${Math.min(100, campaignState.encounterPressure * 10)}%`,
                        backgroundColor: campaignState.encounterPressure >= 7 ? '#8b1a1a'
                          : campaignState.encounterPressure >= 4 ? '#c49a2a' : '#2d5a1e',
                      }} />
                    </div>
                  </div>
                  {campaignState.delve && (
                    <div>
                      <div className="text-[10px] font-heading font-bold text-ink-faint uppercase tracking-wider mb-2">Delve Conditions</div>
                      <div className="grid grid-cols-2 gap-2 text-sm font-body text-ink-faint">
                        <div className="flex items-center gap-1">
                          <span>{campaignState.delve.lightLevel === 'dark' ? '🕯' : campaignState.delve.lightLevel === 'dim' ? '🕯' : '🔦'}</span>
                          <span>Light: <span className={`font-semibold ${campaignState.delve.lightLevel === 'dark' ? 'text-red-600' : campaignState.delve.lightLevel === 'dim' ? 'text-amber-600' : 'text-ink-light'}`}>{campaignState.delve.lightLevel}</span></span>
                        </div>
                        <div>Fatigue: <span className={`font-semibold ${campaignState.delve.fatigueTicks >= 4 ? 'text-red-600' : campaignState.delve.fatigueTicks >= 2 ? 'text-amber-600' : 'text-ink-light'}`}>{campaignState.delve.fatigueTicks}/5</span></div>
                        <div>Hunger: <span className={`font-semibold ${campaignState.delve.hungerTicks >= 3 ? 'text-red-600' : campaignState.delve.hungerTicks >= 2 ? 'text-amber-600' : 'text-ink-light'}`}>{campaignState.delve.hungerTicks}/4</span></div>
                        <div>Load: <span className={`font-semibold ${campaignState.delve.encumbered ? 'text-amber-600' : 'text-ink-light'}`}>{campaignState.delve.lootCarried} gp{campaignState.delve.encumbered ? ' ⚠' : ''}</span></div>
                        {campaignState.delve.retreatPenalty > 0 && (
                          <div className="col-span-2 text-amber-700 font-semibold text-xs">⚠ Retreat speed −{campaignState.delve.retreatPenalty}</div>
                        )}
                        {campaignState.delve.campQuality !== 'adequate' && (
                          <div>Camp: <span className="text-ink-light font-semibold capitalize">{campaignState.delve.campQuality}</span></div>
                        )}
                        {campaignState.delve.tensionFromSupply > 0 && (
                          <div className="col-span-2 text-red-700 text-xs font-semibold">Supply strain: tension +{campaignState.delve.tensionFromSupply}</div>
                        )}
                      </div>
                    </div>
                  )}
                  <div>
                    <div className="text-[10px] font-heading font-bold text-ink-faint uppercase tracking-wider mb-2">Supplies on Hand</div>
                    <div className="grid grid-cols-2 gap-2 text-sm font-body text-ink-faint">
                      <div>Torches: <span className="text-ink-light font-semibold">{carriedSupplies.torches}</span></div>
                      <div>Rations: <span className="text-ink-light font-semibold">{carriedSupplies.rations}</span></div>
                      <div>Arrows: <span className="text-ink-light font-semibold">{carriedSupplies.arrows}</span></div>
                      <div>Bandages: <span className="text-ink-light font-semibold">{carriedSupplies.bandages}</span></div>
                      <div>Rope: <span className="text-ink-light font-semibold">{carriedSupplies.rope}</span></div>
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] font-heading font-bold text-ink-faint uppercase tracking-wider mb-2">Spent This Run</div>
                    <div className="grid grid-cols-2 gap-2 text-sm font-body text-ink-faint">
                      <div>Torches: <span className="text-ink-light">{campaignState.supply.torchesBurned}</span></div>
                      <div>Rations: <span className="text-ink-light">{campaignState.supply.rationsSpent}</span></div>
                      <div>Arrows: <span className="text-ink-light">{campaignState.supply.arrowsSpent}</span></div>
                      <div>Bandages: <span className="text-ink-light">{campaignState.supply.bandagesUsed}</span></div>
                    </div>
                  </div>
                  {campaignState.factions.length > 0 && (
                    <div>
                      <div className="text-[10px] font-heading font-bold text-ink-faint uppercase tracking-wider mb-2">Factions</div>
                      <div className="space-y-2">
                        {campaignState.factions.map((faction) => (
                          <div key={faction.key} className="rounded-lg border border-leather/10 bg-parchment/60 p-3">
                            <div className="flex items-center justify-between text-sm font-heading">
                              <span className="text-leather-dark font-bold">{faction.name}</span>
                              <span className="text-ink-faint text-xs">Rep {faction.reputation} · Heat {faction.heat}</span>
                            </div>
                            <p className="mt-1 text-xs font-body text-ink-faint">{faction.summary}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {campaignState.recentEvents.length > 0 && (
                    <div>
                      <div className="text-[10px] font-heading font-bold text-ink-faint uppercase tracking-wider mb-2">Recent Events</div>
                      <div className="space-y-1">
                        {campaignState.recentEvents.slice(0, 5).map((event) => (
                          <p key={event} className="text-xs font-body text-ink-faint italic">{event}</p>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
              {openPanel === 'map' && (
                <div className="p-3">
                  <CampaignMap mapData={campaignMap} />
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Character Sheet Modal */}
      {showSheet && character && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 p-2 backdrop-blur-sm sm:items-center" onClick={() => setShowSheet(false)}>
          <div className="max-h-[88vh] w-full max-w-2xl overflow-y-auto" onClick={e => e.stopPropagation()}>
            <CharacterSheet character={character} onClose={() => setShowSheet(false)} />
          </div>
        </div>
      )}

      {/* Death modal */}
      {showDeathModal && character && (
        <div className="fixed inset-0 z-60 flex items-center justify-center bg-ink/70 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-xl border border-blood/30 bg-parchment p-6 shadow-2xl text-center">
            <div className="mb-4 text-blood text-4xl">✦</div>
            <h2 className="text-xl font-heading font-bold text-leather-dark mb-2">
              {character.name} is Dead
            </h2>
            <p className="text-sm font-body text-ink-faint mb-1">
              Level {character.level} {character.char_class}. The dungeon took them.
            </p>
            <p className="text-sm font-body text-ink mb-6">
              The company will remember them. Whether that changes anything is another matter.
            </p>
            <div className="space-y-2">
              <button
                onClick={() => {
                  setShowDeathModal(false);
                  onBack();
                }}
                className="w-full rounded-lg bg-leather px-4 py-3 text-sm font-heading font-bold text-parchment-light hover:bg-leather-dark transition-colors"
              >
                Continue with a new character
              </button>
              <button
                onClick={() => setShowDeathModal(false)}
                className="w-full rounded-lg border border-leather/20 px-4 py-2 text-sm font-body text-ink-faint hover:text-ink transition-colors"
              >
                Stay and watch the survivors
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function MobileCharacterPanel({ character, onOpenSheet }: { character: any; onOpenSheet: () => void }) {
  return (
    <div className="p-4 space-y-4">
      <div>
        <p className="text-sm font-body text-ink-faint">
          Level {character.level} {character.race} {character.char_class}
        </p>
        <button onClick={onOpenSheet} className="mt-2 text-xs font-heading text-leather underline underline-offset-2">
          Open full character sheet →
        </button>
      </div>
      <div>
        <div className="flex justify-between text-sm font-heading mb-1">
          <span className="text-ink-faint">HP</span>
          <span className={character.hp <= character.max_hp * 0.25 ? 'text-blood font-bold' : 'text-ink-light font-semibold'}>
            {character.hp} / {character.max_hp}
          </span>
        </div>
        <div className="h-3 bg-parchment-dark/30 rounded-full overflow-hidden">
          <div className="h-full rounded-full transition-all" style={{
            width: `${(character.hp / character.max_hp) * 100}%`,
            backgroundColor: character.hp > character.max_hp * 0.5 ? '#2d5a1e'
              : character.hp > character.max_hp * 0.25 ? '#c49a2a' : '#8b1a1a',
          }} />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2 text-center">
        {[['AC', character.ac], ['THAC0', character.thac0], ['Move', character.base_movement || character.baseMovement]].map(([label, val]) => (
          <div key={label as string} className="rounded-lg border border-leather/10 bg-parchment/60 p-2">
            <div className="text-[10px] font-heading text-ink-faint uppercase tracking-wide">{label}</div>
            <div className="text-lg font-heading font-bold text-leather-dark">{val}</div>
          </div>
        ))}
      </div>
      <div>
        <div className="text-[10px] font-heading font-bold text-ink-faint uppercase tracking-wider mb-2">Ability Scores</div>
        <div className="grid grid-cols-3 gap-2">
          {[['STR', character.str], ['DEX', character.dex], ['CON', character.con],
            ['INT', character.int], ['WIS', character.wis], ['CHA', character.cha]].map(([label, val]) => (
            <div key={label as string} className="flex items-center justify-between rounded border border-leather/10 bg-parchment/60 px-2 py-1.5">
              <span className="text-xs font-heading text-ink-faint">{label}</span>
              <span className="text-sm font-heading font-bold text-ink">
                {val}{label === 'STR' && character.str_percentile ? `/${character.str_percentile}` : ''}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div>
        <div className="text-[10px] font-heading font-bold text-ink-faint uppercase tracking-wider mb-2">Saving Throws</div>
        <div className="grid grid-cols-2 gap-1.5">
          {[['Paralysis/Poison', character.save_paralysis], ['Rod/Staff/Wand', character.save_rod],
            ['Petrify/Polymorph', character.save_petrify], ['Breath Weapon', character.save_breath],
            ['Spell', character.save_spell]].map(([label, val]) => (
            <div key={label as string} className="flex justify-between rounded border border-leather/10 bg-parchment/60 px-2 py-1">
              <span className="text-ink-faint text-xs">{label}</span>
              <span className="font-heading font-bold text-ink text-xs">{val}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg border border-leather/10 bg-parchment/60 p-2 text-center">
          <div className="text-[10px] font-heading text-ink-faint uppercase tracking-wide">Gold</div>
          <div className="text-base font-heading font-bold text-gold">{character.gold}</div>
        </div>
        <div className="rounded-lg border border-leather/10 bg-parchment/60 p-2 text-center">
          <div className="text-[10px] font-heading text-ink-faint uppercase tracking-wide">XP</div>
          <div className="text-base font-heading font-bold text-ink-light">{character.xp}</div>
        </div>
      </div>
    </div>
  );
}

function CompanionCard({ companion, quickAction }: { companion: Companion; quickAction: (a: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded-lg border border-leather/10 bg-parchment/60 p-3">
      <button className="w-full text-left" onClick={() => setExpanded(!expanded)}>
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <div className="font-heading text-sm font-bold text-leather-dark">{companion.name}</div>
            <div className="text-xs font-body text-ink-faint italic">
              {companion.race} {companion.charClass} · {companion.companionRole} · {companion.relationshipLabel}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0 ml-2">
            {companion.relationship.lastBeat && (
              <span title="Overnight development" className="text-xs text-amber-600 font-heading font-bold">●</span>
            )}
            <span className={`text-xs font-heading font-bold ${companion.hp <= companion.maxHp * 0.25 ? 'text-blood' : 'text-ink-faint'}`}>
              {companion.hp}/{companion.maxHp}
            </span>
            <span className="text-ink-faint text-xs">{expanded ? '▲' : '▼'}</span>
          </div>
        </div>
        <div className="mt-1 text-xs font-body text-ink-faint">
          Trust {companion.relationship.trust} · Bond {companion.relationship.bond} · Tension {companion.relationship.tension}
        </div>
      </button>
      {expanded && (
        <div className="mt-3 space-y-3 border-t border-leather/10 pt-3">
          <div className="text-xs font-body text-ink-faint">
            <span className="font-heading text-ink-light">Duty:</span> {companion.duty || 'unset'}
          </div>
          {companion.aspiration && (
            <div className="text-xs font-body text-ink-faint">
              <span className="font-heading text-ink-light">Wants:</span> {companion.aspiration}
            </div>
          )}
          {companion.grievance && (
            <div className="text-xs font-body text-ink-faint">
              <span className="font-heading text-ink-light">Resents:</span> {companion.grievance}
            </div>
          )}
          {companion.personalQuestTitle && (
            <div className="text-xs font-body text-ink-faint">
              <span className="font-heading text-ink-light">Quest:</span> {companion.personalQuestTitle}{' '}
              {companion.personalQuestResolved ? '(resolved)' : `(${Math.min(companion.personalQuestProgress, 3)}/3)`}
            </div>
          )}
          {companion.relationship.lastBeat && (
            <div className="rounded border border-amber-600/20 bg-amber-50/30 px-2 py-1">
              <p className="text-xs font-body text-ink-faint italic">{companion.relationship.lastBeat}</p>
            </div>
          )}
          <div className="flex flex-wrap gap-1.5">
            <button type="button" onClick={() => quickAction(`Put ${companion.name} first in the marching order`)}
              className="rounded-full border border-leather/15 px-2.5 py-1 text-xs font-heading text-leather hover:bg-leather/5">Forward</button>
            <button type="button" onClick={() => quickAction(`Put ${companion.name} last in the marching order`)}
              className="rounded-full border border-leather/15 px-2.5 py-1 text-xs font-heading text-leather hover:bg-leather/5">Back</button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {COMPANION_DUTIES.map(duty => (
              <button key={duty.key} type="button"
                onClick={() => quickAction(`Tell ${companion.name} ${duty.command}`)}
                className={`rounded-full border px-2.5 py-1 text-xs font-heading transition-colors ${
                  companion.duty === duty.key
                    ? 'border-leather bg-leather/10 text-leather-dark'
                    : 'border-leather/15 text-leather hover:bg-leather/5'
                }`}>
                {duty.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5">
            <button type="button" onClick={() => quickAction(`Comfort ${companion.name}`)}
              className="rounded-full border border-leather/15 px-2.5 py-1 text-xs font-heading text-leather hover:bg-leather/5">Comfort</button>
            <button type="button" onClick={() => quickAction(`Share food with ${companion.name}`)}
              className="rounded-full border border-leather/15 px-2.5 py-1 text-xs font-heading text-leather hover:bg-leather/5">Share Food</button>
            <button type="button" onClick={() => quickAction(`Share 10 gp with ${companion.name}`)}
              className="rounded-full border border-leather/15 px-2.5 py-1 text-xs font-heading text-leather hover:bg-leather/5">Gift Coin</button>
            <button type="button" onClick={() => quickAction(`Dismiss ${companion.name} from the company`)}
              className="rounded-full border border-blood/20 px-2.5 py-1 text-xs font-heading text-blood hover:bg-blood/5">Dismiss</button>
          </div>
        </div>
      )}
    </div>
  );
}

function SceneNpcCard({ npc, quickAction }: { npc: SceneNpc; quickAction: (a: string) => void }) {
  return (
    <div className="rounded-lg border border-leather/10 bg-parchment/60 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-heading text-sm font-bold text-leather-dark">{npc.name}</div>
          <div className="text-xs font-body text-ink-faint italic">
            {npc.race} {npc.charClass} · {npc.joinedParty ? `${npc.companionRole} · ${npc.duty}` : npc.disposition}
          </div>
        </div>
        <button type="button"
          onClick={() => quickAction(npc.joinedParty ? `Talk to ${npc.name}` : `Ask ${npc.name} to join us`)}
          className="flex-shrink-0 rounded-full border border-leather/15 px-2.5 py-1 text-xs font-heading text-leather hover:bg-leather/5">
          {npc.joinedParty ? 'Talk' : 'Recruit'}
        </button>
      </div>
      {npc.personality && (
        <p className="mt-1.5 text-xs font-body text-ink-faint">{npc.personality}</p>
      )}
      <p className="mt-1 text-xs font-body text-ink-light">{npc.relationshipLabel} · {npc.recruitHint}</p>
      {!npc.joinedParty && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          <button type="button" onClick={() => quickAction(`Ask ${npc.name} to join us`)}
            className="rounded-full border border-leather/15 px-2.5 py-1 text-xs font-heading text-leather hover:bg-leather/5">Recruit</button>
          <button type="button" onClick={() => quickAction(`Talk to ${npc.name}`)}
            className="rounded-full border border-leather/15 px-2.5 py-1 text-xs font-heading text-leather hover:bg-leather/5">Talk</button>
          <button type="button" onClick={() => quickAction(`Read ${npc.name}s intent`)}
            className="rounded-full border border-leather/15 px-2.5 py-1 text-xs font-heading text-leather hover:bg-leather/5">Read Intent</button>
        </div>
      )}
      {npc.joinedParty && npc.aspiration && (
        <p className="mt-1.5 text-xs font-body text-ink-faint">Wants: {npc.aspiration}</p>
      )}
      {npc.joinedParty && npc.personalQuestTitle && (
        <p className="mt-1 text-xs font-body text-ink-light">
          Quest: {npc.personalQuestTitle} {npc.personalQuestResolved ? '(resolved)' : `(${Math.min(npc.personalQuestProgress, 3)}/3)`}
        </p>
      )}
    </div>
  );
}

// ─── Spell lookup ─────────────────────────────────────────────────────────────

function lookupSpell(name: string, charClass: string) {
  return SPELL_OVERRIDES[`${name}|${charClass}`] || SPELL_CATALOG[name] || null;
}

// ─── Spells Panel ─────────────────────────────────────────────────────────────

function SpellsPanel({ character, charClass, quickAction }: {
  character: any;
  charClass: string;
  quickAction: (a: string) => void;
}) {
  // Handle both parsed (spellSlots) and raw DB (spell_slots) formats
  const rawSlots = character.spellSlots ?? (() => {
    try { return character.spell_slots ? JSON.parse(character.spell_slots) : null; } catch { return null; }
  })();
  const memorisedSpells: string[] = (() => {
    if (Array.isArray(character.memorisedSpells)) return character.memorisedSpells;
    try { return character.memorised_spells ? JSON.parse(character.memorised_spells) : []; } catch { return []; }
  })();

  if (!rawSlots) {
    return (
      <div className="p-4">
        <p className="text-sm font-body text-ink-faint italic">You have no spells prepared.</p>
      </div>
    );
  }

  const slotEntries = Object.entries(rawSlots as Record<string, any>)
    .sort(([a], [b]) => Number(a) - Number(b));

  return (
    <div className="p-4 space-y-4">

      {/* Slot summary */}
      <div>
        <div className="text-[10px] font-heading font-bold text-ink-faint uppercase tracking-wider mb-2">Spell Slots</div>
        <div className="grid grid-cols-3 gap-2">
          {slotEntries.map(([lvl, entry]) => {
            const isRich = typeof entry === 'object' && entry !== null;
            const max: number  = isRich ? entry.max  : entry;
            const used: number = isRich ? entry.used : 0;
            const remaining = max - used;
            return (
              <div key={lvl} className="rounded-lg border border-leather/10 bg-parchment/60 px-2 py-2 text-center">
                <div className="text-[10px] font-heading text-ink-faint uppercase tracking-wide">Level {lvl}</div>
                <div className={`text-base font-heading font-bold mt-0.5 ${remaining === 0 ? 'text-blood' : 'text-ink'}`}>
                  {remaining}/{max}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Prepared spells */}
      <div>
        <div className="text-[10px] font-heading font-bold text-ink-faint uppercase tracking-wider mb-2">Prepared Spells</div>
        {memorisedSpells.length === 0 ? (
          <p className="text-sm font-body text-ink-faint italic">No spells prepared.</p>
        ) : (
          <div className="space-y-2">
            {memorisedSpells.map((spellName, i) => {
              const info = lookupSpell(spellName, charClass);
              return (
                <div key={i} className="rounded-lg border border-leather/10 bg-parchment/60 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="font-heading text-sm font-bold text-leather-dark">{spellName}</div>
                      {info && (
                        <div className="text-[10px] font-heading text-ink-faint uppercase tracking-wide mt-0.5">
                          L{info.level} · {info.school}
                        </div>
                      )}
                      {info && (
                        <p className="text-xs font-body text-ink-faint mt-0.5 leading-relaxed">{info.desc}</p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => quickAction(`cast ${spellName}`)}
                      className="flex-shrink-0 rounded-full border border-leather/25 bg-leather/5 px-3 py-1.5 text-xs font-heading text-leather hover:bg-leather/15 active:bg-leather/20 touch-manipulation"
                    >
                      Cast
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function getLogEntryClass(type: string): string {
  switch (type) {
    case 'narration':
    case 'dm_response':
    case 'scene_enter':
      return 'pl-3 border-l-2 border-leather/20';
    case 'combat':
      return 'pl-3 border-l-2 border-blood/30 bg-blood/3 rounded-r';
    case 'dialogue':
      return 'pl-3 border-l-2 border-gold/30';
    case 'roll':
      return 'pl-3 border-l border-silver/20';
    case 'system':
      return 'text-center';
    default:
      return '';
  }
}

function dedupeActions(actions: Array<string | null | undefined>) {
  const seen = new Set<string>();
  return actions.filter((action): action is string => {
    if (!action || seen.has(action)) return false;
    seen.add(action);
    return true;
  });
}

function buildClassActionRail({
  className,
  encounterActive,
  leadCompanionName,
  recruitableNpcName,
}: {
  className: string;
  encounterActive: boolean;
  leadCompanionName: string | null;
  recruitableNpcName: string | null;
}) {
  const defaults = {
    icon: '⚔',
    title: 'Adventurer Tempo',
    summary: encounterActive ? 'Stay alive, read the room, and push your edge.' : 'Drive the expedition with caution and initiative.',
    actions: [
      { action: encounterActive ? 'Brace and hold' : 'Read the battlefield', label: encounterActive ? 'Brace and Hold' : 'Read the Battlefield', icon: '⚔', hint: encounterActive ? 'Stabilise the line before things go wrong.' : 'Take a tactical read before you commit.' },
      { action: encounterActive ? 'Hold the doorway' : 'Search for traps', label: encounterActive ? 'Hold the Doorway' : 'Search for Traps', icon: '◎', hint: encounterActive ? 'Control space and buy everyone time.' : 'Keep the company from blundering into pain.' },
    ],
  };

  switch (className) {
    case 'paladin':
      return {
        icon: '✠',
        title: 'Paladin Command',
        summary: encounterActive ? 'Anchor the line with courage, mercy, and righteous pressure.' : 'Read the moral weather before steel leaves the scabbard.',
        actions: [
          { action: encounterActive ? 'Lay on hands' : 'Sense evil', label: encounterActive ? 'Lay on Hands' : 'Sense Evil', icon: '✠', hint: encounterActive ? 'Stabilise an ally and keep the vow alive.' : 'Test the scene for hidden corruption.' },
          { action: encounterActive ? 'Smite evil' : 'Lead a prayer', label: encounterActive ? 'Smite Evil' : 'Lead a Prayer', icon: '☼', hint: encounterActive ? 'Turn conviction into pressure on the wicked.' : 'Set the company’s spirit before danger.' },
        ],
      };
    case 'cleric':
      return {
        icon: '☼',
        title: 'Cleric Command',
        summary: encounterActive ? 'Control fear, preserve the wounded, and dictate the spiritual terms.' : 'Bless, interpret, and keep the group under divine order.',
        actions: [
          { action: encounterActive ? 'Turn undead' : 'Bless the company', label: encounterActive ? 'Turn Undead' : 'Bless Company', icon: '☼', hint: encounterActive ? 'Break the nerve of unclean things.' : 'Put holy stru