/**
 * Prompt templates for the AI Dungeon Master
 * All prompts are structured to get focused, concise responses from the LLM
 */

// ─── System Prompt (always included) ────────────────────────────────────────

export const DM_SYSTEM_PROMPT = `You are an experienced Dungeon Master running an Advanced Dungeons & Dragons 2nd Edition campaign. You narrate in a rich, literary style reminiscent of classic fantasy — Tolkien, Leiber, Howard, Vance.

RULES YOU MUST FOLLOW:
- You NEVER calculate combat rolls, damage, saving throws, or THAC0. The game engine handles all mechanics. You narrate the RESULTS provided to you.
- You describe scenes with atmospheric detail — sounds, smells, light, mood, texture.
- You roleplay NPCs with distinct personalities, speech patterns, and motivations.
- You make fair rulings when players attempt creative actions.
- You track story threads and reference earlier events naturally.
- You respect the tone of AD&D 2e — the world is dangerous, magic is wondrous and rare, victories are earned through wit and courage.
- You address the party in second person ("You see...", "The orc lunges at you...").
- Keep responses to 1-4 paragraphs unless a major scene demands more.
- Do NOT include game mechanics, dice rolls, or numbers in your narration. Those appear separately.
- Never break character. You are the DM, not an AI assistant.`;

// ─── Scene Description ──────────────────────────────────────────────────────

export function sceneDescriptionPrompt(params: {
  sceneName: string;
  sceneBrief: string;
  lightLevel: string;
  terrainType: string;
  connections: string[];
  npcsPresent: string[];
  partyContext: string;
  previousScene?: string;
}): string {
  const exits = params.connections.length > 0
    ? `Exits: ${params.connections.join(', ')}`
    : 'This appears to be a dead end.';

  const npcs = params.npcsPresent.length > 0
    ? `Present: ${params.npcsPresent.join(', ')}`
    : '';

  return `The party enters a new location. Describe what they see, hear, and feel.

LOCATION: ${params.sceneName}
DETAILS: ${params.sceneBrief}
LIGHT: ${params.lightLevel}
TERRAIN: ${params.terrainType}
${exits}
${npcs}
${params.previousScene ? `COMING FROM: ${params.previousScene}` : ''}
PARTY: ${params.partyContext}

Describe this location in 2-3 paragraphs. Include sensory details. If there are NPCs present, briefly note their presence but do not initiate dialogue. If there are obvious exits, weave them naturally into the description.`;
}

// ─── NPC Dialogue ───────────────────────────────────────────────────────────

export function npcDialoguePrompt(params: {
  npcName: string;
  npcPersonality: string;
  npcAppearance: string;
  npcVoiceNotes: string;
  npcDisposition: string;
  npcMemory: string[];
  playerCharName: string;
  playerSaid: string;
  sceneContext: string;
}): string {
  const memory = params.npcMemory.length > 0
    ? `MEMORY: ${params.npcMemory.join('; ')}`
    : '';

  return `Roleplay the following NPC responding to a player character.

NPC: ${params.npcName}
PERSONALITY: ${params.npcPersonality}
APPEARANCE: ${params.npcAppearance}
VOICE: ${params.npcVoiceNotes}
DISPOSITION: ${params.npcDisposition} toward the party
${memory}
SCENE: ${params.sceneContext}

${params.playerCharName} says: "${params.playerSaid}"

Respond AS the NPC in 1-3 sentences. Stay in character. Use their speech patterns. If hostile, they may lie, threaten, or refuse to speak. If friendly, they may offer help or information. Do not include narration — only the NPC's spoken words and brief action cues in italics.`;
}

// ─── Combat Narration ───────────────────────────────────────────────────────

export function combatNarrationPrompt(params: {
  sceneContext: string;
  round: number;
  actionDescription: string;
}): string {
  return `Narrate the following combat action in 1-2 vivid sentences.

SCENE: ${params.sceneContext}
ROUND: ${params.round}
ACTION: ${params.actionDescription}

Describe what this looks like in the fiction. Be visceral and specific. Do NOT include any numbers, dice results, or mechanical terms — those are shown separately.`;
}

// ─── Story Reaction ─────────────────────────────────────────────────────────

export function storyReactionPrompt(params: {
  playerAction: string;
  sceneContext: string;
  partyContext: string;
  recentEvents: string[];
  campaignSetting: string;
}): string {
  const recent = params.recentEvents.length > 0
    ? `RECENT: ${params.recentEvents.join('; ')}`
    : '';

  return `The party has taken an action. Describe what happens next.

SETTING: ${params.campaignSetting}
SCENE: ${params.sceneContext}
PARTY: ${params.partyContext}
${recent}

PLAYER ACTION: "${params.playerAction}"

Respond as the DM in 2-3 paragraphs. Describe the consequences of their action. Include sensory details. If appropriate, present a new choice or complication. If the action requires a skill check or ability test, state what check is needed (e.g., "This requires a Strength check" or "Make a saving throw vs. Petrification") so the game engine can resolve it.`;
}

// ─── Encounter Design ───────────────────────────────────────────────────────

export function encounterDesignPrompt(params: {
  partyLevel: number;
  partySize: number;
  sceneContext: string;
  theme: string;
  difficulty: 'easy' | 'moderate' | 'hard' | 'deadly';
}): string {
  return `Design a combat encounter for an AD&D 2e party.

PARTY: ${params.partySize} characters, average level ${params.partyLevel}
SCENE: ${params.sceneContext}
THEME: ${params.theme}
DIFFICULTY: ${params.difficulty}

Respond in JSON format:
{
  "description": "Brief setup narration",
  "monsters": [{"name": "monster name", "count": 1, "notes": "any special behaviour"}],
  "tactics": "How the monsters fight",
  "terrain_features": ["any environmental elements that affect combat"],
  "treasure_notes": "What loot they carry"
}`;
}

// ─── Ruling Request ─────────────────────────────────────────────────────────

export function rulingPrompt(params: {
  playerAction: string;
  characterInfo: string;
  sceneContext: string;
}): string {
  return `A player wants to attempt something creative. Make a ruling as the DM.

CHARACTER: ${params.characterInfo}
SCENE: ${params.sceneContext}
PLAYER WANTS TO: "${params.playerAction}"

Respond in JSON format:
{
  "allowed": true/false,
  "check_type": "ability_check" | "proficiency_check" | "saving_throw" | "automatic" | "impossible",
  "ability": "str" | "dex" | "con" | "int" | "wis" | "cha" (if ability check),
  "modifier": 0 (any situational modifier, negative = harder),
  "narration": "Brief DM narration of the attempt setup"
}`;
}

// ─── World Building ─────────────────────────────────────────────────────────

export function generateRumourPrompt(params: {
  setting: string;
  currentLocation: string;
  existingLore: string[];
}): string {
  return `Generate a tavern rumour for the party to hear.

SETTING: ${params.setting}
LOCATION: ${params.currentLocation}
KNOWN LORE: ${params.existingLore.join('; ')}

Create one rumour in 1-2 sentences. It should be intriguing and potentially adventure-hook worthy. It may or may not be true. Respond with just the rumour text, as spoken by an NPC.`;
}

export function generateNpcPrompt(params: {
  setting: string;
  location: string;
  role: string; // innkeeper, merchant, guard, etc.
}): string {
  return `Generate an NPC for the party to interact with.

SETTING: ${params.setting}
LOCATION: ${params.location}
ROLE: ${params.role}

Respond in JSON format:
{
  "name": "NPC name",
  "race": "human/elf/dwarf/etc",
  "appearance": "2-3 sentences of physical description",
  "personality": "2-3 key personality traits",
  "voice_notes": "How they speak — accent, cadence, verbal tics",
  "disposition": "friendly/neutral/unfriendly",
  "secret": "Something they know or are hiding (may never come up)"
}`;
}
