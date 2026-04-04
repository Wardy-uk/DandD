import { z } from 'zod';

// ─── Enums ──────────────────────────────────────────────────────────────────

export const RaceEnum = z.enum(['human', 'elf', 'half-elf', 'dwarf', 'gnome', 'halfling']);
export type Race = z.infer<typeof RaceEnum>;

export const ClassEnum = z.enum(['fighter', 'paladin', 'ranger', 'cleric', 'druid', 'thief', 'bard', 'mage']);
export type CharClass = z.infer<typeof ClassEnum>;

export const AlignmentEnum = z.enum([
  'Lawful Good', 'Neutral Good', 'Chaotic Good',
  'Lawful Neutral', 'True Neutral', 'Chaotic Neutral',
  'Lawful Evil', 'Neutral Evil', 'Chaotic Evil',
]);
export type Alignment = z.infer<typeof AlignmentEnum>;

export const CharacterStatusEnum = z.enum(['active', 'camp', 'autopilot', 'dead']);
export type CharacterStatus = z.infer<typeof CharacterStatusEnum>;

export const CampaignStatusEnum = z.enum(['active', 'paused', 'completed']);
export type CampaignStatus = z.infer<typeof CampaignStatusEnum>;

export const GameActionTypeEnum = z.enum([
  'move', 'attack', 'cast_spell', 'use_item', 'talk', 'search',
  'listen', 'hide', 'sneak', 'pick_lock', 'disarm_trap', 'turn_undead',
  'rest', 'camp', 'custom',
]);
export type GameActionType = z.infer<typeof GameActionTypeEnum>;

// ─── Ability Scores ─────────────────────────────────────────────────────────

export const AbilityScoresSchema = z.object({
  str: z.number().min(1).max(25),
  strPercentile: z.number().min(1).max(100).optional(),
  dex: z.number().min(1).max(25),
  con: z.number().min(1).max(25),
  int: z.number().min(1).max(25),
  wis: z.number().min(1).max(25),
  cha: z.number().min(1).max(25),
});
export type AbilityScores = z.infer<typeof AbilityScoresSchema>;

// ─── Saving Throws ──────────────────────────────────────────────────────────

export const SavingThrowsSchema = z.object({
  paralysis: z.number(),
  rod: z.number(),
  petrify: z.number(),
  breath: z.number(),
  spell: z.number(),
});
export type SavingThrows = z.infer<typeof SavingThrowsSchema>;

// ─── Character ──────────────────────────────────────────────────────────────

export const InventoryItemSchema = z.object({
  item: z.string(),
  weight: z.number(),
  quantity: z.number().default(1),
  equipped: z.boolean().default(false),
});

export const WeaponProfSchema = z.object({
  weapon: z.string(),
  specialized: z.boolean().default(false),
});

export const NonweaponProfSchema = z.object({
  name: z.string(),
  ability: z.string(),
  modifier: z.number().default(0),
});

export const CharacterSchema = z.object({
  id: z.string(),
  campaignId: z.string(),
  playerId: z.string(),
  playerName: z.string(),
  name: z.string().min(1).max(100),
  race: RaceEnum,
  charClass: ClassEnum,
  multiClass: z.array(ClassEnum).optional(),
  alignment: AlignmentEnum,
  level: z.number().min(1).max(30),
  xp: z.number().min(0),
  xpNext: z.number(),

  str: z.number(), strPercentile: z.number().optional(),
  dex: z.number(), con: z.number(), int: z.number(), wis: z.number(), cha: z.number(),

  thac0: z.number(),
  ac: z.number(),
  hp: z.number(),
  maxHp: z.number(),
  baseMovement: z.number(),

  saves: SavingThrowsSchema,

  weaponProfSlots: z.number(),
  nonweaponProfSlots: z.number(),
  weaponProfs: z.array(WeaponProfSchema),
  nonweaponProfs: z.array(NonweaponProfSchema),

  spellSlots: z.record(z.string(), z.number()).optional(),
  memorisedSpells: z.array(z.string()).optional(),
  spellbook: z.array(z.string()).optional(),
  priestSpheres: z.array(z.string()).optional(),
  thiefSkills: z.record(z.string(), z.number()).optional(),

  inventory: z.array(InventoryItemSchema),
  gold: z.number().default(0),
  silver: z.number().default(0),
  copper: z.number().default(0),
  electrum: z.number().default(0),
  platinum: z.number().default(0),

  conditions: z.array(z.string()),
  notes: z.string().default(''),
  status: CharacterStatusEnum.default('active'),
});
export type Character = z.infer<typeof CharacterSchema>;

// ─── Campaign ───────────────────────────────────────────────────────────────

export const CampaignSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(200),
  setting: z.string().default(''),
  dmNotes: z.string().default(''),
  currentSceneId: z.string().nullable(),
  sessionNumber: z.number().default(1),
  calendarDate: z.string().default(''), // In-game date
  status: CampaignStatusEnum.default('active'),
  createdAt: z.string(),
  createdBy: z.string(),
});
export type Campaign = z.infer<typeof CampaignSchema>;

// ─── Scene (Location/Room) ──────────────────────────────────────────────────

export const SceneConnectionSchema = z.object({
  direction: z.string(), // 'north', 'east', 'a narrow passage', etc.
  targetSceneId: z.string(),
  description: z.string().default(''),
  locked: z.boolean().default(false),
  hidden: z.boolean().default(false),
});

export const SceneSchema = z.object({
  id: z.string(),
  campaignId: z.string(),
  name: z.string(),
  brief: z.string().default(''),           // Short template description
  aiDescription: z.string().default(''),    // AI-generated rich description
  lightLevel: z.string().default('normal'), // 'dark', 'dim', 'normal', 'bright'
  terrainType: z.string().default('indoor'),
  connections: z.array(SceneConnectionSchema),
  visited: z.boolean().default(false),
  notes: z.string().default(''),
});
export type Scene = z.infer<typeof SceneSchema>;

// ─── NPC ────────────────────────────────────────────────────────────────────

export const NpcSchema = z.object({
  id: z.string(),
  campaignId: z.string(),
  name: z.string(),
  race: z.string().default('human'),
  charClass: z.string().default(''),
  level: z.number().default(1),
  personality: z.string().default(''),
  appearance: z.string().default(''),
  voiceNotes: z.string().default(''),     // How the AI should voice this NPC
  disposition: z.string().default('neutral'), // hostile, unfriendly, neutral, friendly, enthusiastic
  locationSceneId: z.string().nullable(),
  stats: z.any().optional(),               // Combat stats if needed
  inventory: z.array(InventoryItemSchema).default([]),
  memory: z.array(z.string()).default([]), // What this NPC knows about the party
  alive: z.boolean().default(true),
});
export type Npc = z.infer<typeof NpcSchema>;

// ─── Monster Template ───────────────────────────────────────────────────────

export const MonsterTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  thac0: z.number(),
  ac: z.number(),
  hitDice: z.string(),       // e.g. "3+1", "1/2"
  hpRange: z.string(),       // e.g. "3-24"
  numAttacks: z.number(),
  damage: z.array(z.string()), // e.g. ["1d6", "1d6", "1d10"]
  specialAttacks: z.array(z.string()).default([]),
  specialDefences: z.array(z.string()).default([]),
  movement: z.number(),
  morale: z.number(),        // 2-12 range
  xpValue: z.number(),
  treasureType: z.string(),
  size: z.string(),          // 'T', 'S', 'M', 'L', 'H', 'G'
  intelligence: z.string(),  // 'non', 'animal', 'low', 'average', 'high', etc.
  alignment: z.string(),
  description: z.string().default(''),
});
export type MonsterTemplate = z.infer<typeof MonsterTemplateSchema>;

// ─── Game Log Entry ─────────────────────────────────────────────────────────

export const GameLogTypeEnum = z.enum([
  'narration', 'combat', 'dialogue', 'roll', 'system',
  'player_action', 'dm_response', 'scene_enter', 'level_up',
]);

export const GameLogSchema = z.object({
  id: z.string(),
  campaignId: z.string(),
  sessionNumber: z.number(),
  timestamp: z.string(),
  type: GameLogTypeEnum,
  actor: z.string().default(''),       // Character name, NPC name, or 'DM'
  content: z.string(),
  mechanicalDetail: z.any().optional(), // Dice rolls, combat results, etc.
});
export type GameLog = z.infer<typeof GameLogSchema>;

// ─── Encounter ──────────────────────────────────────────────────────────────

export const EncounterStatusEnum = z.enum(['pending', 'active', 'resolved', 'fled']);

export const CombatantSchema = z.object({
  id: z.string(),
  encounterId: z.string(),
  characterId: z.string().nullable(),
  npcId: z.string().nullable(),
  name: z.string(),
  side: z.enum(['party', 'enemy']),
  initiativeRoll: z.number().default(0),
  weaponSpeed: z.number().default(5),
  finalInitiative: z.number().default(0),
  currentHp: z.number(),
  maxHp: z.number(),
  thac0: z.number(),
  ac: z.number(),
  conditions: z.array(z.string()).default([]),
  isSurprised: z.boolean().default(false),
});
export type Combatant = z.infer<typeof CombatantSchema>;

export const EncounterSchema = z.object({
  id: z.string(),
  campaignId: z.string(),
  sceneId: z.string(),
  status: EncounterStatusEnum,
  round: z.number().default(0),
  segment: z.number().default(0),
  initiativeType: z.enum(['group', 'individual']).default('group'),
  turnOrder: z.array(z.string()).default([]),
  currentTurnIndex: z.number().default(0),
});
export type Encounter = z.infer<typeof EncounterSchema>;

// ─── Player / Auth ──────────────────────────────────────────────────────────

export const PlayerSchema = z.object({
  id: z.string(),
  username: z.string().min(1).max(50),
  passwordHash: z.string(),
  displayName: z.string().default(''),
  createdAt: z.string(),
  lastSeen: z.string().optional(),
  isOnline: z.boolean().default(false),
});
export type Player = z.infer<typeof PlayerSchema>;

// ─── API Response ───────────────────────────────────────────────────────────

export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

// ─── Socket Events ──────────────────────────────────────────────────────────

export interface ServerToClientEvents {
  'game:narration': (data: { content: string; actor: string }) => void;
  'game:combat_result': (data: { result: unknown }) => void;
  'game:scene_enter': (data: { scene: Scene; description: string }) => void;
  'game:player_action': (data: { playerId: string; playerName: string; action: string }) => void;
  'game:dm_thinking': (data: { status: string }) => void;
  'game:log_entry': (data: GameLog) => void;
  'game:state_update': (data: { type: string; payload: unknown }) => void;
  'game:player_joined': (data: { playerId: string; playerName: string }) => void;
  'game:player_left': (data: { playerId: string; playerName: string }) => void;
  'game:encounter_start': (data: Encounter) => void;
  'game:encounter_update': (data: Encounter) => void;
  'game:turn_prompt': (data: { combatantId: string; name: string; round: number }) => void;
}

export interface ClientToServerEvents {
  'game:join': (data: { campaignId: string; playerId: string }) => void;
  'game:leave': (data: { campaignId: string }) => void;
  'game:action': (data: { campaignId: string; action: string; details?: unknown }) => void;
  'game:combat_action': (data: { campaignId: string; encounterId: string; action: string; targetId?: string }) => void;
  'game:chat': (data: { campaignId: string; message: string }) => void;
}
