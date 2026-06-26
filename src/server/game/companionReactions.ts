/**
 * Live companion reaction system.
 *
 * getCompanionReaction() returns a one-line spoken reaction from a single
 * companion, or null (~50% chance of silence so reactions don't spam every turn).
 *
 * inferReactionTrigger() is a helper for socket.ts to map action text + outcome
 * metadata into the right trigger type.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type ReactionTrigger =
  | 'search'
  | 'trap_found'
  | 'trap_triggered'
  | 'combat_start'
  | 'combat_kill'
  | 'low_health'
  | 'darkness'
  | 'loot_found'
  | 'rest'
  | 'strange_action';

type PersonalityTag = 'stoic' | 'wry' | 'nervous' | 'earnest';

export interface CompanionSnapshot {
  id: string;
  name: string;
  personality: string;
  companionRole: string;
  joinedParty: boolean;
  relationship: {
    morale: number;
    trust: number;
    loyalty: number;
  };
}

export interface CompanionReactionResult {
  companion: { name: string };
  line: string;
}

// ─── Line pools ───────────────────────────────────────────────────────────────

type LinePool = Record<PersonalityTag, string[]>;

const LINES: Record<ReactionTrigger, LinePool> = {
  search: {
    stoic:   [
      'Watch your step in here.',
      'Something feels wrong about that wall.',
      "I don't like this room.",
      'Keep your eyes up.',
      'Move careful. This place has teeth.',
    ],
    wry:     [
      'Sure, touch the weird thing. Great plan.',
      'Nothing ominous about this at all.',
      "I'd check twice before you reach.",
      'Lovely spot. Very murdery.',
      "Something's off. Could just be me.",
    ],
    nervous: [
      'Go carefully. Please.',
      "I don't like this — not one bit.",
      "Something's wrong here. I can feel it.",
      'Wait — let me look first.',
      'Are you sure about this?',
    ],
    earnest: [
      "I've got your back.",
      'Tell me what you need.',
      "I'm watching the room.",
      'Stay alert. Both of us.',
      'We do this together.',
    ],
  },

  trap_found: {
    stoic:   [
      "Good eyes. I'd have walked straight into that.",
      'Step back — let me look at it.',
      'Noted. Mark it and move around.',
      "That would have hurt.",
      'Smart catch.',
    ],
    wry:     [
      'Well spotted. Prefer that over the alternative.',
      'Ah. Someone really wanted us dead here.',
      'Nice find. Very nearly not.',
      "Architecture with opinions.",
      "Good catch. That one had imagination.",
    ],
    nervous: [
      "I saw it too — don't go near it.",
      'Step back. Please. Step back.',
      'That would have been bad. Really bad.',
      "Oh that's — yeah. That's a trap.",
      'How many more do you think there are?',
    ],
    earnest: [
      "Sharp eye. We'll go around.",
      "Good catch. I'll mark the spot.",
      "Stay clear — I'll check if it can be disarmed.",
      'That could have ended badly.',
      'Thank you for seeing that.',
    ],
  },

  trap_triggered: {
    stoic:   [
      'Are you all right?',
      'Walk it off. Keep moving.',
      'That one had teeth.',
      'On me — now.',
      'We keep going.',
    ],
    wry:     [
      'Well. That happened.',
      'Technically still alive.',
      "And that's why we check first.",
      'Very educational.',
      "I was going to warn you. Mostly.",
    ],
    nervous: [
      'Are you all right?! Are you hurt?!',
      'Back! Everyone back!',
      'Oh no — are you okay?',
      "That's blood. That's your blood.",
      "I knew it. I knew something was wrong.",
    ],
    earnest: [
      "I've got you. How bad is it?",
      'Stay still — let me see.',
      "Lean on me. We'll get you through this.",
      "I'm here. Just breathe.",
      "We're not leaving you here.",
    ],
  },

  combat_start: {
    stoic:   [
      'Blades out.',
      'Here we go.',
      'Stay close.',
      'On my mark.',
      'Hold the line.',
    ],
    wry:     [
      'Lovely. Company.',
      'And there it is.',
      'Right, then. Work to do.',
      "I was wondering when this would happen.",
      'Friendly lot.',
    ],
    nervous: [
      'Weapons! Draw weapons!',
      "They're here — they're actually here.",
      "Don't let them surround us.",
      'There — watch your left!',
      "I need a moment — no. No, I don't. Let's go.",
    ],
    earnest: [
      'Together. We do this together.',
      "I'm with you. Right here.",
      'Stay tight and we get through this.',
      "On your left — I've got your right.",
      "For the company!",
    ],
  },

  combat_kill: {
    stoic:   [
      'Clean.',
      'Move.',
      'One down.',
      "Don't stop.",
      'Next.',
    ],
    wry:     [
      "Don't celebrate yet.",
      'They have friends, usually.',
      'One down, room to go.',
      "Nice work. Don't get cocky.",
      'Good. Keep going.',
    ],
    nervous: [
      'Is it dead? Is it dead?',
      'Oh thank the gods.',
      'Keep watching — there might be more.',
      "We got it. We actually got it.",
      "Don't let your guard down.",
    ],
    earnest: [
      'Good hit.',
      'Press the advantage.',
      'We can do this.',
      'Stay with me.',
      'For the fallen — keep going.',
    ],
  },

  low_health: {
    stoic:   [
      "You're bleeding. Don't be a hero.",
      'Fall back. Now.',
      'Get behind me.',
      "You're no good dead. Pull back.",
      'Keep pressure on it.',
    ],
    wry:     [
      "You look terrible, for what it's worth.",
      'Might want to address that.',
      "You're leaking. Thought you should know.",
      'Maybe stand behind someone sturdier.',
      "The bleeding is, shall we say, sub-optimal.",
    ],
    nervous: [
      'Hold on — hold on.',
      'Stay with me. Stay with me!',
      "You're hurt — get clear!",
      'Someone help them. Please.',
      "Don't you dare give up.",
    ],
    earnest: [
      "I've got you. Lean on me.",
      "You're not done yet. Neither are we.",
      "Stay close — I'm not letting you fall.",
      "Right here. I've got you.",
      "We're getting you through this.",
    ],
  },

  darkness: {
    stoic:   [
      'Someone light a torch. Now.',
      "I can't see a damn thing.",
      'We move blind, we die.',
      'Light. We need light.',
      'No torch, no advance.',
    ],
    wry:     [
      'Terrific. Completely blind in a dungeon.',
      "I'd say I see something, but I'd be lying.",
      'Lovely time to forget the torches.',
      'The dark is very atmospheric. Also fatal.',
      "At least the monsters can't see us either. Probably.",
    ],
    nervous: [
      "I can't see. I can't see anything.",
      'Get a light. Right now. Please.',
      'Something moved. I heard something move.',
      "I really don't like this.",
      'Light a torch before something notices us.',
    ],
    earnest: [
      'Stay together. Nobody moves.',
      "Keep contact — I'm right here.",
      "We hold until we have light.",
      "Don't panic. We get a torch, we move.",
      "I'm right beside you.",
    ],
  },

  loot_found: {
    stoic:   [
      'Split it equal.',
      'Take what you can carry.',
      "Don't linger.",
      'Good.',
      'Noted. Keep moving.',
    ],
    wry:     [
      "That'll buy a round at least.",
      'Look at that. Actual treasure.',
      'Finally, something worth the trip.',
      'Nice. Very nice.',
      "Someone's having a better day.",
    ],
    nervous: [
      "Take it and go. Don't stay here.",
      "Good — now let's leave before something notices.",
      'Is it cursed? It looks cursed.',
      'Take it. Carefully.',
      "Great. Can we go now?",
    ],
    earnest: [
      'We share it evenly.',
      "That's ours. We earned it.",
      'Worth every step.',
      "Mark it down. We split at camp.",
      'Good find.',
    ],
  },

  rest: {
    stoic:   [
      "I'll take first watch.",
      "Don't get comfortable.",
      'Sleep light.',
      "Two hours. Then I'm waking you.",
      "I'll be on the door.",
    ],
    wry:     [
      "Try not to snore. The echoes are terrible.",
      "Yes, let's sleep in the dungeon. Excellent decision.",
      "I'll keep watch. Pretend we're not underground.",
      "I've had worse beds. Not many.",
      "Rest well. I'll be here being quietly terrified.",
    ],
    nervous: [
      "I'll watch. I don't think I could sleep anyway.",
      'Stay alert. Even sleeping.',
      'What if something comes?',
      "Someone has to stay awake. I volunteer.",
      "Rest. I'll listen.",
    ],
    earnest: [
      "Rest. You've earned it.",
      "I've got the watch. Sleep.",
      "We're safe here. For now.",
      "I'll wake you if anything moves.",
      "Close your eyes. I'm here.",
    ],
  },

  strange_action: {
    stoic:   [
      "...What are you doing?",
      "I'll pretend I didn't see that.",
      'Is this a plan?',
      'Sure.',
      'Right.',
    ],
    wry:     [
      "That's... one way to do it.",
      'Bold strategy.',
      'Inspired. Genuinely inspired.',
      "I wouldn't have thought of that. Mostly because it's insane.",
      "Can't argue with the logic. Whatever that was.",
    ],
    nervous: [
      'Is that — are we doing that now?',
      'Should I be concerned?',
      'What does that accomplish exactly?',
      'Wait — why?',
      'I have questions. Many questions.',
    ],
    earnest: [
      'Okay. I trust you.',
      "I'll back you up. Whatever this is.",
      'If you say so.',
      'Together, then.',
      'Lead the way.',
    ],
  },
};

// ─── Personality detection ────────────────────────────────────────────────────

function derivePersonalityTag(personality: string): PersonalityTag {
  const p = personality.toLowerCase();
  if (/cautious|observant|nervous|timid|wary|anxious/.test(p)) return 'nervous';
  if (/wry|sarcastic|humou?r|funny|wit|quick|sardonic/.test(p)) return 'wry';
  if (/steady|practical|protective|blunt|serious|resolute|stoic|sharp.eyed|dry/.test(p)) return 'stoic';
  return 'earnest';
}

// ─── Companion selection ──────────────────────────────────────────────────────

const ROLE_PREFERENCE: Partial<Record<ReactionTrigger, string>> = {
  trap_found:     'scout',
  trap_triggered: 'scout',
  search:         'scout',
  combat_start:   'vanguard',
  combat_kill:    'vanguard',
  low_health:     'warden',
};

function pickCompanion(
  trigger: ReactionTrigger,
  companions: CompanionSnapshot[],
): CompanionSnapshot | null {
  const joined = companions.filter((c) => c.joinedParty);
  if (joined.length === 0) return null;

  const preferred = ROLE_PREFERENCE[trigger];
  if (preferred) {
    const match = joined.find((c) => c.companionRole === preferred);
    if (match) return match;
  }

  // Fallback: highest morale companion
  return joined.reduce((best, c) =>
    c.relationship.morale > best.relationship.morale ? c : best,
    joined[0],
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function rollD6(): number {
  return Math.floor(Math.random() * 6) + 1;
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Returns a companion reaction line, or null.
 * Fires ~50% of the time (d6 > 3) to avoid spamming every action.
 */
export function getCompanionReaction(
  trigger: ReactionTrigger,
  companions: CompanionSnapshot[],
  _characterName: string,
): CompanionReactionResult | null {
  // ~50% chance
  if (rollD6() <= 3) return null;

  const companion = pickCompanion(trigger, companions);
  if (!companion) return null;

  const tag = derivePersonalityTag(companion.personality);
  const pool = LINES[trigger][tag];
  const line = pickRandom(pool);

  return { companion: { name: companion.name }, line };
}

// ─── Trigger inference (used by socket.ts) ────────────────────────────────────

/**
 * Derives a reaction trigger from action text, outcome metadata, and scene state.
 * Returns null if no trigger maps cleanly.
 */
export function inferReactionTrigger(
  action: string,
  outcomeContent: string,
  hpDelta: number,
  characterHpPct: number,
  sceneLightLevel: string,
): ReactionTrigger | null {
  const lowerAction = action.toLowerCase();
  const lowerContent = outcomeContent.toLowerCase();

  // ── Low health (urgent — check regardless of action) ──────────────────────
  if (characterHpPct < 0.3) return 'low_health';

  // ── Trap triggered (HP loss in trap context) ───────────────────────────────
  if (hpDelta < 0 && /trap|dart|spike|blade|pit|needle|gas|pendulum|snare/.test(lowerContent)) {
    return 'trap_triggered';
  }

  // ── Trap found (mentioned in outcome without HP loss) ─────────────────────
  if (
    /trap/.test(lowerContent) &&
    /(found|spot|notice|detect|see|there is|you see|catch sight)/.test(lowerContent)
  ) {
    return 'trap_found';
  }

  // ── Darkness (look/describe action in a dark scene) ───────────────────────
  if (
    /look|what.*see|where.*am|describe|glance/.test(lowerAction) &&
    sceneLightLevel === 'dark'
  ) {
    return 'darkness';
  }

  // ── Loot found (treasure language in outcome) ─────────────────────────────
  if (
    /(found|discover|uncover|contain|hold|reward|pick up|take)/.test(lowerContent) &&
    /(gold|gp|silver|coin|treasure|chest|stash|cache|loot|gem|pouch|purse)/.test(lowerContent)
  ) {
    return 'loot_found';
  }

  // ── Rest / make camp ───────────────────────────────────────────────────────
  if (/^rest$|make camp|set camp|camp here|secure and rest/.test(lowerAction)) {
    return 'rest';
  }

  // ── Search / exploration (catch-all for probe/examine actions) ────────────
  if (/search|probe|check|examine|feel|tap|inspect|look for|look around/.test(lowerAction)) {
    return 'search';
  }

  return null;
}
