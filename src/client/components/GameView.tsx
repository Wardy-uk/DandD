import { useState, useEffect, useRef } from 'react';
import type { Socket } from 'socket.io-client';
import CharacterSheet from './CharacterSheet.js';
import CampaignMap from './CampaignMap.js';

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

interface CampaignStateView {
  encounterPressure: number;
  supply: {
    torchesBurned: number;
    rationsSpent: number;
    lockpicksBroken: number;
    arrowsSpent: number;
    bandagesUsed: number;
  };
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
  const logEndRef = useRef<HTMLDivElement>(null);

  const headers = { Authorization: `Bearer ${player.token}`, 'Content-Type': 'application/json' };

  // Join campaign socket room
  useEffect(() => {
    socket.emit('game:join', { campaignId, playerId: player.id });

    return () => {
      socket.emit('game:leave', { campaignId });
    };
  }, [campaignId, player.id, socket]);

  // Fetch character data
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

  // Socket listeners
  useEffect(() => {
    const onNarration = (data: { content: string; actor: string }) => {
      setDmThinking('');
      addLogEntry('narration', data.actor, data.content);
    };

    const onSceneEnter = (data: { scene: Scene; description: string }) => {
      setCurrentScene(data.scene);
       setEncounterActive(false);
      setDmThinking('');
      addLogEntry('scene_enter', 'DM', data.description);
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
      if (data.type === 'campaign') {
        // Campaign state received
      } else if (data.type === 'recent_logs') {
        setGameLog(data.payload.map((l: any) => ({
          id: l.id,
          type: l.type,
          actor: l.actor,
          content: l.content,
          timestamp: l.timestamp,
        })));
      } else if (data.type === 'character_update') {
        setCharacter(data.payload);
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
    };

    const onTurnPrompt = (data: { name: string; round: number }) => {
      addLogEntry('system', '', `${data.name} has the initiative in round ${data.round}.`);
    };

    const onEncounterUpdate = (data: { status?: string; round?: number }) => {
      if (data.status === 'resolved') {
        setEncounterActive(false);
        addLogEntry('system', '', 'The encounter is resolved.');
      } else if (data.status === 'fled') {
        setEncounterActive(false);
        addLogEntry('system', '', 'The encounter breaks apart as one side flees.');
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

  // Auto-scroll log
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [gameLog, dmThinking]);

  const addLogEntry = (type: string, actor: string, content: string) => {
    setGameLog(prev => [...prev, {
      id: crypto.randomUUID(),
      type, actor, content,
      timestamp: new Date().toISOString(),
    }]);
  };

  const sendAction = () => {
    if (!inputText.trim()) return;
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
  const className = String(character?.char_class || '').toLowerCase();
  const classAction = encounterActive
    ? className === 'paladin'
      ? 'Lay on hands'
      : className === 'cleric'
        ? 'Turn undead'
        : className === 'druid'
          ? 'Lead a prayer'
        : className === 'ranger'
          ? 'Rally the line'
          : className === 'thief'
            ? 'Check supplies'
            : className === 'fighter'
              ? 'Rally the line'
              : 'Take stock'
    : className === 'paladin'
      ? 'Lead a prayer'
      : className === 'cleric' || className === 'druid'
        ? 'Bless the company'
        : className === 'ranger'
          ? 'Read their intent'
          : className === 'thief'
            ? 'Check supplies'
          : 'Take stock';
  const classActionTwo = encounterActive
    ? className === 'paladin'
      ? 'Smite evil'
      : className === 'cleric'
        ? 'Call for quarter'
        : className === 'thief'
          ? 'Take cover and aim'
          : className === 'ranger'
            ? 'Take cover and aim'
            : className === 'fighter'
              ? 'Hold the doorway'
              : null
    : className === 'paladin'
      ? 'Sense evil'
      : className === 'cleric' || className === 'druid'
        ? 'Lead a prayer'
        : className === 'thief'
          ? 'Share supplies'
          : className === 'ranger'
            ? 'Read their intent'
            : null;
  const quickActions = [
    'Look around',
    'Listen carefully',
    'Read the battlefield',
    classAction,
    classActionTwo,
    leadCompanion && !leadCompanion.personalQuestResolved
      ? leadCompanion.personalQuestNeed
      : (leadCompanion ? `Ask ${leadCompanion.name} to scout ahead` : (recruitableNpc ? `Ask ${recruitableNpc.name} to join us` : (encounterActive ? 'Hold the doorway' : 'Search for traps'))),
    leadCompanion ? `Ask ${leadCompanion.name} to scout ahead` : (recruitableNpc ? `Ask ${recruitableNpc.name} to join us` : (encounterActive ? 'Hold the doorway' : 'Search for traps')),
    leadCompanion ? `Comfort ${leadCompanion.name}` : (encounterActive ? 'Take cover and aim' : 'Search for hidden doors'),
    recruitableNpc ? `Ask ${recruitableNpc.name} to join us` : (encounterActive ? 'Hold the doorway' : 'Search for traps'),
    encounterActive ? 'Drive them into the hazard' : 'Secure this room',
    encounterActive ? 'Fall back to cover' : 'Mark fallback point',
    encounterActive ? 'Brace and hold' : 'Rest',
  ].filter(Boolean) as string[];

  return (
    <div className="flex gap-4 h-[calc(100vh-120px)]">
      {/* Left Sidebar — Character Panel */}
      <div className="w-64 flex-shrink-0 flex flex-col gap-3">
        <button onClick={onBack} className="text-xs text-leather hover:text-leather-dark font-body">
          &larr; Leave Campaign
        </button>

        {character && (
          <div className="border border-leather/15 rounded-lg p-4 bg-parchment-light/40">
            <button onClick={() => setShowSheet(!showSheet)} className="w-full text-left">
              <h3 className="font-heading font-bold text-leather-dark text-lg tracking-wide">
                {character.name}
              </h3>
              <p className="text-xs text-ink-faint font-body">
                Level {character.level} {character.race} {character.char_class}
              </p>
            </button>

            <div className="h-px bg-leather/10 my-3" />

            {/* HP Bar */}
            <div className="mb-3">
              <div className="flex justify-between text-xs font-heading mb-1">
                <span className="text-ink-faint">HP</span>
                <span className={character.hp <= character.max_hp * 0.25 ? 'text-blood font-bold' : 'text-ink-light'}>
                  {character.hp}/{character.max_hp}
                </span>
              </div>
              <div className="h-2 bg-parchment-dark/30 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${(character.hp / character.max_hp) * 100}%`,
                    backgroundColor: character.hp > character.max_hp * 0.5 ? '#2d5a1e'
                      : character.hp > character.max_hp * 0.25 ? '#c49a2a' : '#8b1a1a',
                  }}
                />
              </div>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-3 gap-1 text-center mb-3">
              <div className="text-xs"><span className="text-ink-faint font-heading">AC</span> <span className="font-bold font-heading">{character.ac}</span></div>
              <div className="text-xs"><span className="text-ink-faint font-heading">THAC0</span> <span className="font-bold font-heading">{character.thac0}</span></div>
              <div className="text-xs"><span className="text-ink-faint font-heading">Mv</span> <span className="font-bold font-heading">{character.base_movement || character.baseMovement}</span></div>
            </div>

            {/* Abilities */}
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

            {/* Saves */}
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

            {/* Gold */}
            <div className="h-px bg-leather/10 my-3" />
            <div className="flex justify-between text-xs">
              <span className="text-ink-faint font-heading">Gold</span>
              <span className="font-heading font-bold text-gold">{character.gold}</span>
            </div>

            {/* XP */}
            <div className="flex justify-between text-xs mt-1">
              <span className="text-ink-faint font-heading">XP</span>
              <span className="font-heading font-semibold">{character.xp}/{character.xp_next || character.xpNext}</span>
            </div>
          </div>
        )}

        {/* Online Players */}
        {onlinePlayers.length > 0 && (
          <div className="border border-leather/15 rounded-lg p-3 bg-parchment-light/40">
            <div className="text-[10px] font-heading font-bold text-ink-faint uppercase tracking-wider mb-2">
              Adventurers Present
            </div>
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
            <div className="text-[10px] font-heading font-bold text-ink-faint uppercase tracking-wider mb-2">
              Battlefield Read
            </div>
            <p className="text-xs font-body italic text-ink-light leading-relaxed">
              {battlefield.summary}
            </p>
            <div className="grid grid-cols-2 gap-1 mt-3 text-[11px] font-body text-ink-faint">
              <div>Sight: <span className="text-ink-light">{battlefield.visibility}</span></div>
              <div>Footing: <span className="text-ink-light">{battlefield.footing}</span></div>
              <div>Cover: <span className="text-ink-light">{battlefield.cover ? 'usable' : 'poor'}</span></div>
              <div>Line: <span className="text-ink-light">{battlefield.chokepoint ? 'narrow' : 'open'}</span></div>
            </div>
            {battlefield.hazard && (
              <div className="mt-2 text-[11px] font-body text-blood">
                Hazard: {battlefield.hazard}
              </div>
            )}
            <div className="mt-3 space-y-1">
              {battlefield.tacticalAdvice.slice(0, 3).map((tip) => (
                <p key={tip} className="text-[11px] font-body text-ink-faint">
                  {tip}
                </p>
              ))}
            </div>
          </div>
        )}

        {campaignState && (
          <div className="border border-leather/15 rounded-lg p-3 bg-parchment-light/40">
            <div className="text-[10px] font-heading font-bold text-ink-faint uppercase tracking-wider mb-2">
              Expedition State
            </div>
            <div className="mb-2">
              <div className="flex justify-between text-[11px] font-body text-ink-faint">
                <span>Pressure</span>
                <span className="text-ink-light">{campaignState.encounterPressure}/10</span>
              </div>
              <div className="mt-1 h-2 rounded-full bg-parchment-dark/30 overflow-hidden">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${Math.min(100, campaignState.encounterPressure * 10)}%`,
                    backgroundColor: campaignState.encounterPressure >= 7 ? '#8b1a1a'
                      : campaignState.encounterPressure >= 4 ? '#c49a2a' : '#2d5a1e',
                  }}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-1 text-[11px] font-body text-ink-faint">
              <div>Torches: <span className="text-ink-light">{campaignState.supply.torchesBurned} burned</span></div>
              <div>Rations: <span className="text-ink-light">{campaignState.supply.rationsSpent} spent</span></div>
              <div>Arrows: <span className="text-ink-light">{campaignState.supply.arrowsSpent} spent</span></div>
              <div>Bandages: <span className="text-ink-light">{campaignState.supply.bandagesUsed} used</span></div>
            </div>
            <div className="mt-3 space-y-2">
              {campaignState.factions.slice(0, 4).map((faction) => (
                <div key={faction.key} className="rounded-lg border border-leather/10 bg-parchment/60 p-2">
                  <div className="flex items-center justify-between text-[11px] font-heading">
                    <span className="text-leather-dark">{faction.name}</span>
                    <span className="text-ink-faint">Rep {faction.reputation} • Heat {faction.heat}</span>
                  </div>
                  <div className="mt-1 text-[11px] font-body text-ink-faint">{faction.summary}</div>
                </div>
              ))}
            </div>
            {campaignState.recentEvents.length > 0 && (
              <div className="mt-3 space-y-1">
                {campaignState.recentEvents.slice(0, 3).map((event) => (
                  <p key={event} className="text-[11px] font-body text-ink-faint italic">
                    {event}
                  </p>
                ))}
              </div>
            )}
          </div>
        )}

        {companions.length > 0 && (
          <div className="border border-leather/15 rounded-lg p-3 bg-parchment-light/40">
            <div className="text-[10px] font-heading font-bold text-ink-faint uppercase tracking-wider mb-2">
              Company
            </div>
            <div className="space-y-2">
              {companions.filter((companion) => companion.joinedParty).map((companion) => (
                <div key={companion.id} className="rounded-lg border border-leather/10 bg-parchment/60 p-2">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-heading text-xs font-bold text-leather-dark">{companion.name}</div>
                      <div className="text-[11px] font-body text-ink-faint italic">
                        {companion.race} {companion.charClass} • {companion.companionRole} • {companion.relationshipLabel}
                      </div>
                    </div>
                    <div className="text-[11px] font-heading text-ink-light">
                      {companion.hp}/{companion.maxHp} HP
                    </div>
                  </div>
                  <div className="mt-1 text-[11px] font-body text-ink-light">
                    Duty: {companion.duty || 'unset'}
                  </div>
                  <div className="mt-1 text-[11px] font-body text-ink-faint">
                    Wants: {companion.aspiration}
                  </div>
                  <div className="mt-1 text-[11px] font-body text-ink-faint">
                    Resents: {companion.grievance}
                  </div>
                  <div className="mt-1 text-[11px] font-body text-ink-light">
                    Lead: {companion.personalQuestTitle} {companion.personalQuestResolved ? '(resolved)' : `(${Math.min(companion.personalQuestProgress, 3)}/3)`}
                  </div>
                  <div className="mt-1 text-[11px] font-body text-ink-faint">
                    {companion.personalQuestNeed}
                  </div>
                  {companion.relationship.lastBeat && (
                    <p className="mt-1 text-[11px] font-body text-ink-faint">
                      {companion.relationship.lastBeat}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {sceneNpcs.length > 0 && (
          <div className="border border-leather/15 rounded-lg p-3 bg-parchment-light/40">
            <div className="text-[10px] font-heading font-bold text-ink-faint uppercase tracking-wider mb-2">
              In This Scene
            </div>
            <div className="space-y-2">
              {sceneNpcs.map((npc) => (
                <div key={npc.id} className="rounded-lg border border-leather/10 bg-parchment/60 p-2">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-heading text-xs font-bold text-leather-dark">{npc.name}</div>
                      <div className="text-[11px] font-body text-ink-faint italic">
                        {npc.race} {npc.charClass} • {npc.joinedParty ? `${npc.companionRole} • ${npc.duty}` : npc.disposition}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => quickAction(npc.joinedParty ? `Talk to ${npc.name}` : `Ask ${npc.name} to join us`)}
                      className="rounded-full border border-leather/15 px-2 py-1 text-[10px] font-heading text-leather hover:bg-leather/5"
                    >
                      {npc.joinedParty ? 'Talk' : 'Recruit'}
                    </button>
                  </div>
                  <div className="mt-1 text-[11px] font-body text-ink-faint">
                    {npc.personality}
                  </div>
                  <div className="mt-1 text-[11px] font-body text-ink-light">
                    {npc.relationshipLabel} • {npc.recruitHint}
                  </div>
                  {npc.joinedParty && (
                    <>
                      <div className="mt-1 text-[11px] font-body text-ink-faint">
                        Wants: {npc.aspiration}
                      </div>
                      <div className="mt-1 text-[11px] font-body text-ink-light">
                        Lead: {npc.personalQuestTitle} {npc.personalQuestResolved ? '(resolved)' : `(${Math.min(npc.personalQuestProgress, 3)}/3)`}
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        <CampaignMap mapData={campaignMap} />
      </div>

      {/* Main Panel — Game Log & Input */}
      <div className="flex-1 flex flex-col border border-leather/15 rounded-lg bg-parchment-light/30 overflow-hidden">
        {/* Scene Header */}
        {currentScene && (
          <div className="px-5 py-3 border-b border-leather/10 bg-parchment-light/40">
            <div className="flex items-center justify-between">
              <h2 className="font-heading font-bold text-leather-dark tracking-wide">
                {currentScene.name}
              </h2>
              {currentScene.connections.length > 0 && (
                <div className="flex gap-2">
                  {currentScene.connections.map((c, i) => (
                    <button key={i} onClick={() => quickAction(`I go ${c.direction}`)}
                      className="text-xs px-2 py-1 rounded border border-leather/15 text-leather font-heading hover:bg-leather/5">
                      {c.direction}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Game Log */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {gameLog.length === 0 && (
            <div className="text-center py-16 text-ink-faint font-body italic">
              <p>The adventure awaits...</p>
              <p className="text-xs mt-2">Type an action below to begin.</p>
            </div>
          )}

          {gameLog.map(entry => (
            <div key={entry.id} className={`animate-fade-in ${getLogEntryClass(entry.type)}`}>
              {entry.actor && entry.type !== 'system' && (
                <span className={`font-heading font-bold text-xs uppercase tracking-wide ${
                  entry.type === 'narration' || entry.type === 'dm_response' || entry.type === 'scene_enter'
                    ? 'text-leather'
                    : entry.type === 'combat'
                      ? 'text-blood'
                      : 'text-ink-light'
                }`}>
                  {entry.actor}
                </span>
              )}
              <p className={`font-body text-sm leading-relaxed ${
                entry.type === 'narration' || entry.type === 'dm_response' || entry.type === 'scene_enter'
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
          ))}

          {/* DM Thinking indicator */}
          {dmThinking && (
            <div className="animate-fade-in">
              <p className="text-sm text-leather/60 font-body italic flex items-center gap-2">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-leather/40 animate-pulse" />
                {dmThinking}
              </p>
            </div>
          )}

          <div ref={logEndRef} />
        </div>

        {/* Input Area */}
        <div className="border-t border-leather/10 p-4 bg-parchment-light/40">
          {/* Quick Actions */}
          <div className="flex gap-2 mb-3 flex-wrap">
            {quickActions.map(action => (
              <button key={action} onClick={() => quickAction(action)}
                className="text-xs px-3 py-1.5 rounded-full border border-leather/15 text-leather font-heading hover:bg-leather/5 transition-colors">
                {action}
              </button>
            ))}
          </div>

          <div className="flex gap-3">
            <input
              type="text"
              value={inputText}
              onChange={e => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="What do you do?"
              className="flex-1 px-4 py-3 rounded-lg border border-leather/20 bg-parchment font-body text-sm text-ink placeholder:text-ink-faint/50 focus:outline-none focus:border-leather/50 focus:ring-1 focus:ring-leather/20"
            />
            <button onClick={sendAction} disabled={!inputText.trim()}
              className="px-6 py-3 rounded-lg bg-leather text-parchment-light font-heading font-semibold text-sm hover:bg-leather-dark disabled:opacity-30 transition-colors">
              Act
            </button>
          </div>
        </div>
      </div>

      {/* Character Sheet Modal */}
      {showSheet && character && (
        <div className="fixed inset-0 bg-ink/40 backdrop-blur-sm flex items-center justify-center z-50" onClick={() => setShowSheet(false)}>
          <div className="max-w-2xl w-full max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <CharacterSheet character={character} onClose={() => setShowSheet(false)} />
          </div>
        </div>
      )}
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
