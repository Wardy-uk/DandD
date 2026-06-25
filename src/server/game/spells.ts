/**
 * AD&D 2nd Edition Spell Definitions
 * Magic-User (L1-5), Cleric (L1-5), Druid (L1-3)
 *
 * Each spell's resolve() function applies mechanical effects to game state
 * and returns a narration string in DM voice.
 */

import { rollNotation } from '../engine/dice.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type SpellClass = 'mage' | 'cleric' | 'druid' | 'ranger';
export type SpellSchool =
  | 'abjuration' | 'alteration' | 'conjuration' | 'divination'
  | 'enchantment' | 'evocation' | 'illusion' | 'necromancy'
  | 'universal' | 'invocation';

export interface SpellTarget {
  id: string;
  name: string;
  hp: number;
  maxHp: number;
  ac: number;
  isUndead?: boolean;
  isMindless?: boolean;
  isLarge?: boolean;
  conditions?: string[];
}

export interface SpellState {
  casterLevel: number;
  casterName: string;
  sceneName?: string;
  lightLevel?: string;
  isInCombat?: boolean;
  seed?: number;
}

export interface SpellEffect {
  hpDelta?: number;           // positive = heal, negative = damage
  targetConditions?: string[]; // conditions to add to target
  casterConditions?: string[]; // conditions to add to caster
  removeConditions?: string[]; // conditions to clear
  targetsRemoved?: boolean;    // undead fled/destroyed
  lightGranted?: boolean;      // Light spells
  doorOpened?: boolean;        // Knock
  narration: string;           // DM-voice description
  mechanicalDetail?: string;   // brief mechanical summary for log
}

export interface SpellDefinition {
  name: string;
  level: number;
  class: SpellClass;
  school: SpellSchool;
  castingTime: string;   // '1 segment', '3 rounds', etc.
  range: string;         // '0', '60 yards', 'Touch', etc.
  duration: string;      // '1 round/level', 'Instantaneous', etc.
  aoe: string;           // Area of effect
  description: string;   // Mechanical description (brief)
  dmNarration: string;   // Flavour cue for narration
  resolve: (state: SpellState, target?: SpellTarget) => SpellEffect;
}

// ─── Deterministic dice helper ────────────────────────────────────────────────
// seeded so the engine is reproducible in tests; live play uses Date.now()

function seedRoll(sides: number, seed?: number): number {
  if (seed !== undefined) {
    // Simple LCG — good enough for seeded replay
    const s = (seed * 1664525 + 1013904223) & 0xffffffff;
    return (Math.abs(s) % sides) + 1;
  }
  return Math.floor(Math.random() * sides) + 1;
}

function rollDice(count: number, sides: number, seed?: number): number {
  let total = 0;
  for (let i = 0; i < count; i++) {
    total += seedRoll(sides, seed !== undefined ? seed + i * 31 : undefined);
  }
  return total;
}

// ─── Spell caster-level dice ───────────────────────────────────────────────

function missileCount(level: number) {
  return 1 + Math.floor((level - 1) / 2); // +1 per 2 levels above 1st → 1/3/5/7...
}

// ─── MAGIC-USER SPELLS ────────────────────────────────────────────────────────

// Level 1 ─────────────────────────────────────────────────────────────────────

const MAGIC_MISSILE: SpellDefinition = {
  name: 'Magic Missile',
  level: 1,
  class: 'mage',
  school: 'evocation',
  castingTime: '1 segment',
  range: '60 yards + 10 yards/level',
  duration: 'Instantaneous',
  aoe: '1-5 targets',
  description: '1d4+1 per missile; +1 missile per 2 levels above 1st. Auto-hits.',
  dmNarration: 'Darts of crackling force streak from the caster\'s outstretched fingers.',
  resolve(state, target) {
    const missiles = missileCount(state.casterLevel);
    let total = 0;
    for (let i = 0; i < missiles; i++) {
      total += rollDice(1, 4, state.seed !== undefined ? state.seed + i : undefined) + 1;
    }
    const missilePlural = missiles === 1 ? 'missile' : 'missiles';
    const targetName = target?.name || 'the target';
    return {
      hpDelta: -total,
      narration: `${state.casterName}'s hands move through the sigil. The air folds. ${missiles === 1 ? 'A dart' : `${missiles} darts`} of cold force streak from ${state.casterName}'s fingertips${target ? ` and find ${targetName}` : ''}, unerring.`,
      mechanicalDetail: `Magic Missile: ${missiles} ${missilePlural}, ${total} damage`,
    };
  },
};

const SLEEP: SpellDefinition = {
  name: 'Sleep',
  level: 1,
  class: 'mage',
  school: 'enchantment',
  castingTime: '1 segment',
  range: '30 yards',
  duration: '5 rounds/level',
  aoe: '15-foot cube; 2d4 HD creatures',
  description: 'Puts 2d4 HD of creatures to sleep. No save. Does not affect undead or creatures >4 HD.',
  dmNarration: 'A wave of drowsy purple light rolls over the targets.',
  resolve(state, target) {
    const hdAffected = rollDice(2, 4, state.seed);
    const targetName = target?.name || 'the targets';
    if (target?.isUndead || target?.isMindless) {
      return {
        narration: `The Sleep takes shape, but ${targetName} have no mind to still. The spell unravels on the air.`,
        mechanicalDetail: 'Sleep: no effect on undead/mindless',
      };
    }
    return {
      targetConditions: ['sleeping'],
      narration: `The word leaves ${state.casterName}'s lips and the light shifts — just slightly, to something softer. ${targetName} slump, one after another, pulled under without sound.`,
      mechanicalDetail: `Sleep: up to ${hdAffected} HD of creatures affected`,
    };
  },
};

const CHARM_PERSON: SpellDefinition = {
  name: 'Charm Person',
  level: 1,
  class: 'mage',
  school: 'enchantment',
  castingTime: '1 segment',
  range: '120 yards',
  duration: 'Special',
  aoe: '1 person',
  description: 'Target regards caster as trusted friend. Save vs spells negates.',
  dmNarration: 'The caster\'s eyes hold the target\'s with unusual intensity.',
  resolve(state, target) {
    const targetName = target?.name || 'the target';
    return {
      targetConditions: ['charmed'],
      narration: `${state.casterName} meets ${targetName}'s gaze and holds it — there is a moment where something in ${targetName}'s expression shifts, like a key turning in a lock.`,
      mechanicalDetail: 'Charm Person: target must save vs spell or regard caster as friend',
    };
  },
};

const SHIELD: SpellDefinition = {
  name: 'Shield',
  level: 1,
  class: 'mage',
  school: 'abjuration',
  castingTime: '1 segment',
  range: '0',
  duration: '5 rounds/level',
  aoe: 'Caster',
  description: 'AC 4 vs missiles, AC 2 vs melee, blocks Magic Missiles entirely.',
  dmNarration: 'A faint shimmer coalesces around the caster like a second skin.',
  resolve(state) {
    return {
      casterConditions: ['shielded'],
      narration: `${state.casterName} speaks the ward word and the air around ${state.casterName} thickens — not visibly, but something about it has changed. Less inviting to blades.`,
      mechanicalDetail: 'Shield: AC 4 vs missile, AC 2 vs melee; absorbs Magic Missile',
    };
  },
};

const DETECT_MAGIC_MU: SpellDefinition = {
  name: 'Detect Magic',
  level: 1,
  class: 'mage',
  school: 'divination',
  castingTime: '1 segment',
  range: '0',
  duration: '2 rounds/level',
  aoe: '10 × 60 ft path',
  description: 'Detects magical radiations in a 10×60 ft path ahead.',
  dmNarration: 'The caster\'s eyes glow faintly with a blue-white light.',
  resolve(state) {
    return {
      casterConditions: ['detecting-magic'],
      narration: `${state.casterName} mutters the detection sequence. For a breath or two, ${state.casterName}'s eyes hold a pale inner light — reading the unseen weave of magic in the space ahead.`,
      mechanicalDetail: 'Detect Magic: 10×60 ft path, 2 rounds/level',
    };
  },
};

const LIGHT_MU: SpellDefinition = {
  name: 'Light',
  level: 1,
  class: 'mage',
  school: 'alteration',
  castingTime: '1 segment',
  range: '60 yards',
  duration: '1 turn/level',
  aoe: '20-foot radius globe',
  description: 'Creates a globe of light equivalent to torchlight. Can blind a creature (save negates).',
  dmNarration: 'A small sphere of cold white light blinks into existence.',
  resolve(state, target) {
    if (target) {
      return {
        targetConditions: ['blinded'],
        narration: `The light snaps into existence directly before ${target.name}'s eyes — searing, absolute, no place to look away. ${target.name} must save or be left blind until the spell fades.`,
        mechanicalDetail: 'Light: cast on creature, blinded if save fails',
      };
    }
    return {
      lightGranted: true,
      narration: `${state.casterName} traces a small circle in the air and the darkness pulls back. Not much, but enough — a globe of cold white light settles and holds.`,
      mechanicalDetail: 'Light: 20 ft radius, 1 turn/level',
    };
  },
};

const READ_MAGIC: SpellDefinition = {
  name: 'Read Magic',
  level: 1,
  class: 'mage',
  school: 'divination',
  castingTime: '1 segment',
  range: '0',
  duration: '2 rounds/level',
  aoe: 'Caster',
  description: 'Allows the caster to read magical inscriptions on objects, spellbooks, scrolls.',
  dmNarration: 'The caster\'s eyes trace runes that others see only as decoration.',
  resolve(state) {
    return {
      casterConditions: ['reading-magic'],
      narration: `${state.casterName} speaks the reader's word. The glyphs and notations on the page stop being marks and start being language — pulling meaning through like water through a sieve.`,
      mechanicalDetail: 'Read Magic: magical writing legible for 2 rounds/level',
    };
  },
};

const HOLD_PORTAL: SpellDefinition = {
  name: 'Hold Portal',
  level: 1,
  class: 'mage',
  school: 'alteration',
  castingTime: '1 segment',
  range: '20 yards',
  duration: '1 round/level',
  aoe: '80 sq ft/level',
  description: 'Magically holds a door, gate, or similar closure as if it were locked.',
  dmNarration: 'The door rattles but will not open — held fast by invisible force.',
  resolve(state) {
    return {
      narration: `${state.casterName} points at the door and speaks the binding. Something — not a lock, but something older than locks — takes hold. The door is closed now in a way that has nothing to do with hinges.`,
      mechanicalDetail: 'Hold Portal: door/gate held for 1 round/level',
    };
  },
};

// Level 2 ─────────────────────────────────────────────────────────────────────

const WEB: SpellDefinition = {
  name: 'Web',
  level: 2,
  class: 'mage',
  school: 'evocation',
  castingTime: '2 segments',
  range: '5 yards/level',
  duration: '2 turns/level',
  aoe: '8000 cubic feet',
  description: 'Creates a web of thick sticky strands. Creatures are entangled; must escape based on STR.',
  dmNarration: 'Thick ropes of magical webbing fill the area, binding all within.',
  resolve(state, target) {
    const targetName = target?.name || 'the area';
    return {
      targetConditions: ['webbed'],
      narration: `The spell erupts outward in gouts of sticky white cable, filling the space between walls and floor and ceiling. ${target ? `${target.name} is caught in it before ${target.name} can react.` : 'Anyone caught in it will find movement a matter of strength and patience.'}`,
      mechanicalDetail: 'Web: entangles creatures; STR check to escape each round',
    };
  },
};

const INVISIBILITY: SpellDefinition = {
  name: 'Invisibility',
  level: 2,
  class: 'mage',
  school: 'illusion',
  castingTime: '2 segments',
  range: 'Touch',
  duration: 'Special',
  aoe: 'Creature touched',
  description: 'Target becomes invisible. Ends if target attacks or casts.',
  dmNarration: 'The subject simply ceases to be visible, fading like smoke.',
  resolve(state, target) {
    const subject = target?.name || state.casterName;
    return {
      targetConditions: target ? ['invisible'] : undefined,
      casterConditions: target ? undefined : ['invisible'],
      narration: `${state.casterName} lays ${target ? `a hand on ${target.name}` : 'both hands together'} and speaks the conceal-word. ${subject} fades — not all at once, but the way a figure fades into a dark doorway. Present, but absent.`,
      mechanicalDetail: 'Invisibility: invisible until attack or spell cast',
    };
  },
};

const MIRROR_IMAGE: SpellDefinition = {
  name: 'Mirror Image',
  level: 2,
  class: 'mage',
  school: 'illusion',
  castingTime: '2 segments',
  range: '0',
  duration: '3 rounds/level',
  aoe: 'Caster',
  description: 'Creates 1d4+1 images of the caster. Attackers hit images instead of the caster.',
  dmNarration: 'Several perfect copies of the caster shimmer into being around the original.',
  resolve(state) {
    const images = rollDice(1, 4, state.seed) + 1;
    return {
      casterConditions: ['mirror-image'],
      narration: `${state.casterName} steps sideways and keeps stepping — except the copies don't follow. ${images} versions of ${state.casterName} fill the space, identical in every detail, moving just slightly out of phase.`,
      mechanicalDetail: `Mirror Image: ${images} images created`,
    };
  },
};

const KNOCK: SpellDefinition = {
  name: 'Knock',
  level: 2,
  class: 'mage',
  school: 'alteration',
  castingTime: '1 segment',
  range: '60 yards',
  duration: 'Special',
  aoe: '10 sq ft/level',
  description: 'Opens stuck, locked, or magically held doors. One use per casting.',
  dmNarration: 'A sharp sound like a key turning echoes through the door.',
  resolve(state) {
    return {
      doorOpened: true,
      narration: `${state.casterName} says a single word at the door — the word for opening, the oldest one — and the mechanism, whatever it was, yields. There is a sound like a heavy exhale, and the door swings free.`,
      mechanicalDetail: 'Knock: opens locked, stuck, or held door/chest',
    };
  },
};

const LEVITATE: SpellDefinition = {
  name: 'Levitate',
  level: 2,
  class: 'mage',
  school: 'alteration',
  castingTime: '2 segments',
  range: '20 yards/level',
  duration: '1 turn/level',
  aoe: '1 creature or object',
  description: 'Target can move up/down at 20 ft/round. No horizontal movement from spell.',
  dmNarration: 'The target lifts smoothly from the ground, weightless.',
  resolve(state, target) {
    const subject = target?.name || state.casterName;
    return {
      targetConditions: target ? ['levitating'] : undefined,
      casterConditions: target ? undefined : ['levitating'],
      narration: `${state.casterName} extends ${target ? `a finger at ${target.name}` : 'both arms'} and speaks the word for weightlessness. ${subject} rises — slowly, smoothly, with no particular urgency — as if gravity had simply lost interest.`,
      mechanicalDetail: 'Levitate: vertical movement 20 ft/round for 1 turn/level',
    };
  },
};

const DETECT_INVISIBILITY: SpellDefinition = {
  name: 'Detect Invisibility',
  level: 2,
  class: 'mage',
  school: 'divination',
  castingTime: '2 segments',
  range: '10 yards/level',
  duration: '5 rounds/level',
  aoe: '10 × 10 ft path',
  description: 'Caster can see invisible, hidden, ethereal, and astral creatures.',
  dmNarration: 'The caster\'s eyes take on a distant, searching quality.',
  resolve(state) {
    return {
      casterConditions: ['detecting-invisibility'],
      narration: `${state.casterName} opens the second sight — the one that reads the spaces between things. The visible world goes flat while everything hidden in it becomes sharp-edged and present.`,
      mechanicalDetail: 'Detect Invisibility: sees all hidden/invisible for 5 rounds/level',
    };
  },
};

const ESP: SpellDefinition = {
  name: 'ESP',
  level: 2,
  class: 'mage',
  school: 'divination',
  castingTime: '2 segments',
  range: '0',
  duration: '1 round/level',
  aoe: '5 yards/level',
  description: 'Detects surface thoughts of creatures within range. Concentration required.',
  dmNarration: 'The caster grows still, head tilted, listening to something no one else can hear.',
  resolve(state, target) {
    const targetName = target?.name || 'nearby creatures';
    return {
      casterConditions: ['ESP-active'],
      narration: `${state.casterName} goes quiet in a particular way — the silence of someone listening very hard. Whatever ${targetName} ${target ? 'is' : 'are'} thinking right now is leaking through in fragments: images, feeling, half-formed intent.`,
      mechanicalDetail: 'ESP: surface thoughts of 1 creature/round; concentration required',
    };
  },
};

// Level 3 ─────────────────────────────────────────────────────────────────────

const FIREBALL: SpellDefinition = {
  name: 'Fireball',
  level: 3,
  class: 'mage',
  school: 'invocation',
  castingTime: '3 segments',
  range: '10 yards + 10 yards/level',
  duration: 'Instantaneous',
  aoe: '20-foot radius',
  description: '1d6/level fire damage in 20-foot radius. Save vs spell for half.',
  dmNarration: 'A bead of fire arcs out and detonates in a roiling sphere of orange flame.',
  resolve(state, target) {
    const dice = Math.min(state.casterLevel, 10); // caps at 10d6
    const dmg = rollDice(dice, 6, state.seed);
    const targetName = target?.name || 'the area';
    return {
      hpDelta: -dmg,
      narration: `${state.casterName} draws back and releases the bead — it arcs out, small and unremarkable, then the world turns orange. The fireball doesn't announce itself. It simply fills the space. ${target ? `${target.name} is inside the radius when it detonates.` : ''}`,
      mechanicalDetail: `Fireball: ${dice}d6 = ${dmg} fire damage; save vs spell for half`,
    };
  },
};

const LIGHTNING_BOLT: SpellDefinition = {
  name: 'Lightning Bolt',
  level: 3,
  class: 'mage',
  school: 'invocation',
  castingTime: '3 segments',
  range: '40 yards + 10 yards/level',
  duration: 'Instantaneous',
  aoe: '10×40 ft bolt or 5×80 ft bolt',
  description: '1d6/level lightning damage. Save vs spell for half. Bolt bounces off walls.',
  dmNarration: 'A blinding crack of electricity tears through the air.',
  resolve(state, target) {
    const dice = Math.min(state.casterLevel, 10);
    const dmg = rollDice(dice, 6, state.seed);
    const targetName = target?.name || 'the corridor';
    return {
      hpDelta: -dmg,
      narration: `${state.casterName} traces the path and speaks the discharge. The bolt is not a light — it is a sound and a burning and a pressure all at once. It scorches a black line through ${targetName} and the echo takes a long moment to fade.`,
      mechanicalDetail: `Lightning Bolt: ${dice}d6 = ${dmg} lightning damage; save vs spell for half`,
    };
  },
};

const FLY: SpellDefinition = {
  name: 'Fly',
  level: 3,
  class: 'mage',
  school: 'alteration',
  castingTime: '3 segments',
  range: 'Touch',
  duration: '1 turn/level + 1d6 turns',
  aoe: 'Creature touched',
  description: 'Subject flies at 18 movement (MC: B). Duration is imprecise to prevent exploitation.',
  dmNarration: 'The subject lifts from the ground and moves freely through the air.',
  resolve(state, target) {
    const bonus = rollDice(1, 6, state.seed);
    const subject = target?.name || state.casterName;
    return {
      targetConditions: target ? ['flying'] : undefined,
      casterConditions: target ? undefined : ['flying'],
      narration: `${state.casterName} speaks the ward against gravity and lays it on ${subject}. The ground releases its claim. ${subject} rises — not like a bird, which earns it, but like something that has simply decided to be elsewhere than the floor.`,
      mechanicalDetail: `Fly: MV 18 for ${state.casterLevel} turns + ${bonus} additional turns`,
    };
  },
};

const HASTE: SpellDefinition = {
  name: 'Haste',
  level: 3,
  class: 'mage',
  school: 'alteration',
  castingTime: '3 segments',
  range: '60 yards',
  duration: '3 rounds + 1 round/level',
  aoe: '40-foot cube; 1 creature/level',
  description: 'Affected creatures move and attack at double speed. Ages subject 1 year.',
  dmNarration: 'The affected creatures begin moving in a blur, faster than the eye can comfortably track.',
  resolve(state, target) {
    const targetName = target?.name || 'the targets';
    return {
      targetConditions: target ? ['hasted'] : undefined,
      casterConditions: target ? undefined : ['hasted'],
      narration: `The Haste settles over ${targetName} like a second wind they didn't know they needed. Movement sharpens. Reactions snap faster. The world briefly seems to move through something thick while ${targetName} ${target ? 'moves' : 'move'} clean.`,
      mechanicalDetail: 'Haste: double movement/attacks for 3+level rounds; ages 1 year',
    };
  },
};

const HOLD_PERSON_MU: SpellDefinition = {
  name: 'Hold Person',
  level: 3,
  class: 'mage',
  school: 'enchantment',
  castingTime: '3 segments',
  range: '120 yards',
  duration: '2 rounds/level',
  aoe: '1-4 persons',
  description: 'Holds 1-4 human/demi-human targets rigid. Save vs spell negates.',
  dmNarration: 'The targets freeze mid-motion, locked in rigid paralysis.',
  resolve(state, target) {
    const targetName = target?.name || 'the targets';
    return {
      targetConditions: target ? ['held'] : undefined,
      narration: `${state.casterName} spreads two fingers at ${targetName} and the Hold arrives without ceremony. ${targetName} ${target ? 'stops' : 'stop'} — not slowly, not struggling. Just stops, like a fire with the air removed.`,
      mechanicalDetail: 'Hold Person: 1-4 persons rigid; save vs spell negates; 2 rounds/level',
    };
  },
};

const DISPEL_MAGIC_MU: SpellDefinition = {
  name: 'Dispel Magic',
  level: 3,
  class: 'mage',
  school: 'abjuration',
  castingTime: '3 segments',
  range: '120 yards',
  duration: 'Instantaneous',
  aoe: '30-foot cube',
  description: 'Cancels magical spells and effects in area. Success based on caster level comparison.',
  dmNarration: 'The magical energies in the area unravel suddenly, like yarn caught on a nail.',
  resolve(state, target) {
    return {
      removeConditions: ['charmed', 'held', 'sleeping', 'webbed', 'hasted', 'slowed', 'shielded', 'levitating', 'flying', 'invisible', 'mirror-image'],
      narration: `${state.casterName} pulls the threads apart. The Dispel doesn't destroy magic — it just removes the architecture that was holding it in place. Effects in the area collapse without drama, the way lights go out when power fails.`,
      mechanicalDetail: 'Dispel Magic: ends active spell effects in 30-foot cube',
    };
  },
};

const SLOW: SpellDefinition = {
  name: 'Slow',
  level: 3,
  class: 'mage',
  school: 'alteration',
  castingTime: '3 segments',
  range: '90 yards + 10 yards/level',
  duration: '3 rounds + 1 round/level',
  aoe: '40-foot cube; 1 creature/level',
  description: 'Affected creatures move and attack at half speed. Counters Haste.',
  dmNarration: 'The affected creatures wade through invisible resistance, every movement laboured.',
  resolve(state, target) {
    const targetName = target?.name || 'the targets';
    return {
      targetConditions: target ? ['slowed'] : undefined,
      narration: `The Slow descends on ${targetName} like a hand pressing down on the top of the world. ${targetName} ${target ? 'keeps moving' : 'keep moving'}, but at half the cost of effort — which is to say, at twice the cost.`,
      mechanicalDetail: 'Slow: half movement/attacks; counters Haste; 3+level rounds',
    };
  },
};

// Level 4 ─────────────────────────────────────────────────────────────────────

const POLYMORPH_OTHER: SpellDefinition = {
  name: 'Polymorph Other',
  level: 4,
  class: 'mage',
  school: 'alteration',
  castingTime: '4 segments',
  range: '5 yards/level',
  duration: 'Permanent',
  aoe: '1 creature',
  description: 'Transforms target into another creature. Target must save vs polymorph or adopt new creature\'s mentality.',
  dmNarration: 'The target\'s form reshapes itself violently into something else entirely.',
  resolve(state, target) {
    const targetName = target?.name || 'the target';
    return {
      targetConditions: target ? ['polymorphed'] : undefined,
      narration: `The Polymorph reaches into ${targetName}'s shape and finds the seams. What steps out of the change is technically alive, but it remembers being ${targetName} the way a dreamer remembers a dream — faintly, and then not at all.`,
      mechanicalDetail: 'Polymorph Other: target assumes new form; save vs polymorph or mentality shifts',
    };
  },
};

const ICE_STORM: SpellDefinition = {
  name: 'Ice Storm',
  level: 4,
  class: 'mage',
  school: 'evocation',
  castingTime: '4 segments',
  range: '10 yards/level',
  duration: '1 round',
  aoe: '40-foot diameter',
  description: 'Hail of ice deals 3d10 bludgeoning/cold damage. No save.',
  dmNarration: 'A torrent of massive hailstones hammers down from nowhere.',
  resolve(state, target) {
    const dmg = rollDice(3, 10, state.seed);
    const targetName = target?.name || 'the area';
    return {
      hpDelta: -dmg,
      narration: `The sky inside the effect forgets it is indoors. Chunks of ice the size of fists hammer down onto ${targetName} — not falling but slamming, like the ceiling itself has decided to participate.`,
      mechanicalDetail: `Ice Storm: 3d10 = ${dmg} cold/bludgeoning damage, no save`,
    };
  },
};

const CONFUSION: SpellDefinition = {
  name: 'Confusion',
  level: 4,
  class: 'mage',
  school: 'enchantment',
  castingTime: '4 segments',
  range: '120 yards',
  duration: '2 rounds + 1 round/level',
  aoe: '40-foot cube; 2d4 creatures',
  description: 'Affected creatures act randomly: wander, attack allies, stand stunned, or flee.',
  dmNarration: 'The affected creatures\' expressions go blank, then alarmed, then lost.',
  resolve(state, target) {
    const targetName = target?.name || 'the group';
    return {
      targetConditions: target ? ['confused'] : undefined,
      narration: `The Confusion spreads through ${targetName} quietly — not violently. One moment they knew their purpose. The next, purpose itself seems like someone else's problem. They mill. They second-guess. One of them raises a weapon at a companion and seems surprised to notice this.`,
      mechanicalDetail: 'Confusion: 2d4 creatures; random actions each round for 2+level rounds',
    };
  },
};

const DIMENSION_DOOR: SpellDefinition = {
  name: 'Dimension Door',
  level: 4,
  class: 'mage',
  school: 'alteration',
  castingTime: '1 segment',
  range: '0',
  duration: 'Instantaneous',
  aoe: 'Caster',
  description: 'Teleports caster up to 30 yards/level instantly and accurately.',
  dmNarration: 'The caster vanishes, then reappears at the destination with a faint pop of displaced air.',
  resolve(state) {
    return {
      narration: `${state.casterName} folds. The space between here and there collapses for the length of a heartbeat. When it opens again, ${state.casterName} is elsewhere, and the air where ${state.casterName} stood smells briefly of somewhere far away.`,
      mechanicalDetail: `Dimension Door: teleport up to ${state.casterLevel * 30} yards`,
    };
  },
};

const WALL_OF_FIRE: SpellDefinition = {
  name: 'Wall of Fire',
  level: 4,
  class: 'mage',
  school: 'evocation',
  castingTime: '4 segments',
  range: '60 yards',
  duration: 'Concentration + 1 round/level',
  aoe: 'Up to 20 sq ft/level',
  description: 'Wall of fire deals 2d4+level damage to those passing through; 1d4 within 10 ft.',
  dmNarration: 'A curtain of roaring flame erupts from the ground, searing anything that approaches.',
  resolve(state, target) {
    const passThrough = rollDice(2, 4, state.seed) + state.casterLevel;
    const targetName = target?.name || 'those passing through';
    return {
      hpDelta: target ? -passThrough : undefined,
      narration: `The Wall goes up like a curtain being drawn, except the curtain is fire and the sound is wrong — it roars and pops and settles into something that will be there until ${state.casterName} stops willing it.${target ? ` ${target.name} is on the wrong side of it.` : ''}`,
      mechanicalDetail: `Wall of Fire: ${passThrough} damage to pass through; 1d4 within 10 ft`,
    };
  },
};

const FEAR: SpellDefinition = {
  name: 'Fear',
  level: 4,
  class: 'mage',
  school: 'illusion',
  castingTime: '4 segments',
  range: '0',
  duration: 'Special',
  aoe: '60-foot cone',
  description: 'Creatures in cone flee in terror for 1 round/level. Save vs spell negates.',
  dmNarration: 'Something vast and wrong radiates from the caster, and every instinct screams to run.',
  resolve(state, target) {
    const targetName = target?.name || 'creatures in the cone';
    return {
      targetConditions: target ? ['feared'] : undefined,
      narration: `${state.casterName} opens the door to something old and patient, and lets a sliver of it through. ${targetName} feel it before they understand it — not danger, but wrongness, deep and total. ${target ? `${target.name} runs.` : 'They run.'}`,
      mechanicalDetail: 'Fear: cone 60 ft, flee for 1 round/level; save vs spell negates',
    };
  },
};

// Level 5 ─────────────────────────────────────────────────────────────────────

const CLOUDKILL: SpellDefinition = {
  name: 'Cloudkill',
  level: 5,
  class: 'mage',
  school: 'evocation',
  castingTime: '5 segments',
  range: '10 yards',
  duration: '1 round/level',
  aoe: '40-foot diameter',
  description: 'Poisonous vapour kills creatures with <4+1 HD outright; others save or die.',
  dmNarration: 'A heavy, bile-yellow cloud rolls out from the caster, crawling along the floor.',
  resolve(state, target) {
    const targetName = target?.name || 'those caught in the cloud';
    return {
      hpDelta: target ? -20 : undefined, // Symbolic; actual death is based on HD
      targetConditions: target ? ['poisoned'] : undefined,
      narration: `The cloud is almost gentle — the way it creeps rather than rushes. It finds ${targetName} and settles around ${target ? target.name : 'them'} like it has nowhere better to be. The smell is wrong. The air is wrong. The choices narrow very quickly.`,
      mechanicalDetail: 'Cloudkill: kills <4+1 HD; save vs poison for 5-6 HD; unaffected above',
    };
  },
};

const CONE_OF_COLD: SpellDefinition = {
  name: 'Cone of Cold',
  level: 5,
  class: 'mage',
  school: 'evocation',
  castingTime: '5 segments',
  range: '0',
  duration: 'Instantaneous',
  aoe: "5-foot-wide cone, 1'/level long",
  description: '1d4+1/level cold damage in cone. Save vs spell for half.',
  dmNarration: 'A blast of absolute cold screams out from the caster\'s palms, freezing everything it touches.',
  resolve(state, target) {
    const dice = Math.min(state.casterLevel, 12);
    const dmg = rollDice(dice, 4, state.seed) + dice;
    const targetName = target?.name || 'the cone';
    return {
      hpDelta: -dmg,
      narration: `${state.casterName}'s hands spread apart and the cold between them finds its shape — not winter cold, not frost cold, but the cold of the void between stars. It takes the cone's path and everything it touches stops being warm.${target ? ` ${target.name} is directly in its path.` : ''}`,
      mechanicalDetail: `Cone of Cold: ${dice}d4+${dice} = ${dmg} cold damage; save vs spell for half`,
    };
  },
};

const TELEPORT: SpellDefinition = {
  name: 'Teleport',
  level: 5,
  class: 'mage',
  school: 'alteration',
  castingTime: '2 segments',
  range: '0',
  duration: 'Instantaneous',
  aoe: 'Caster + 250 lbs/level',
  description: 'Instantly transports caster to known location. Risk of mishap based on familiarity.',
  dmNarration: 'The caster and anything they carry simply cease to be here.',
  resolve(state) {
    return {
      narration: `${state.casterName} holds the destination in mind until it becomes more real than this room. Then steps into it. The space where ${state.casterName} stood is briefly colder than it should be, and then that too fades.`,
      mechanicalDetail: 'Teleport: instantaneous transit to known location; mishap risk by familiarity',
    };
  },
};

const HOLD_MONSTER: SpellDefinition = {
  name: 'Hold Monster',
  level: 5,
  class: 'mage',
  school: 'enchantment',
  castingTime: '5 segments',
  range: '5 yards/level',
  duration: '1 round/level',
  aoe: '1-4 creatures',
  description: 'Holds 1-4 monsters rigid. Save vs spell negates. Works on most creature types.',
  dmNarration: 'The creatures freeze in place, muscles locked by invisible force.',
  resolve(state, target) {
    const targetName = target?.name || 'the targets';
    return {
      targetConditions: target ? ['held'] : undefined,
      narration: `${state.casterName} draws the Hold tight and casts it wide — a net of compulsion that asks for nothing except stillness. ${targetName} ${target ? 'cannot answer that' : 'cannot answer that'} with anything but compliance.`,
      mechanicalDetail: 'Hold Monster: 1-4 creatures rigid; save vs spell negates; 1 round/level',
    };
  },
};

const ANIMATE_DEAD: SpellDefinition = {
  name: 'Animate Dead',
  level: 5,
  class: 'mage',
  school: 'necromancy',
  castingTime: '5 rounds',
  range: '10 yards',
  duration: 'Permanent',
  aoe: 'Special',
  description: 'Creates skeletons or zombies from corpses. 1 HD/level animated.',
  dmNarration: 'The corpses twitch, then rise, hollow-eyed and purposeful.',
  resolve(state) {
    const controlled = state.casterLevel;
    return {
      narration: `${state.casterName} makes the gesture of calling-back and the bodies hear it in whatever way dead things hear. They don't wake. They resume. ${controlled} of them, moving with the patience of things that have forgotten hurry.`,
      mechanicalDetail: `Animate Dead: up to ${controlled} HD of undead raised`,
    };
  },
};

const FEEBLEMIND: SpellDefinition = {
  name: 'Feeblemind',
  level: 5,
  class: 'mage',
  school: 'enchantment',
  castingTime: '5 segments',
  range: '10 yards/level',
  duration: 'Permanent',
  aoe: '1 creature',
  description: 'Target\'s INT and WIS reduced to near zero permanently. Affects spellcasters hardest.',
  dmNarration: 'The target\'s expression empties, the light behind their eyes flickering out.',
  resolve(state, target) {
    const targetName = target?.name || 'the target';
    return {
      targetConditions: target ? ['feebleminded'] : undefined,
      narration: `${state.casterName} reaches into ${targetName}'s mind and finds the word for emptying. It isn't violent. The light in ${targetName}'s eyes just — goes elsewhere. What remains is present, alive, and very far away.`,
      mechanicalDetail: 'Feeblemind: INT/WIS ≈ 1; permanent; spellcasters save at −4',
    };
  },
};

// ─── CLERIC SPELLS ────────────────────────────────────────────────────────────

// Level 1 ─────────────────────────────────────────────────────────────────────

const CURE_LIGHT_WOUNDS: SpellDefinition = {
  name: 'Cure Light Wounds',
  level: 1,
  class: 'cleric',
  school: 'necromancy',
  castingTime: '5 segments',
  range: 'Touch',
  duration: 'Permanent',
  aoe: 'Creature touched',
  description: 'Heals 1d8 HP.',
  dmNarration: 'The cleric\'s hands glow faintly as the wounds beneath them close.',
  resolve(state, target) {
    const healed = rollDice(1, 8, state.seed);
    const targetName = target?.name || 'the wounded';
    return {
      hpDelta: healed,
      narration: `${state.casterName} lays both hands over the wound and closes ${state.casterName}'s eyes. The prayer is short — the ones that matter usually are. When ${state.casterName} lifts ${state.casterName}'s hands, the worst of it is gone. ${targetName} breathes easier.`,
      mechanicalDetail: `Cure Light Wounds: heals 1d8 = ${healed} HP`,
    };
  },
};

const BLESS: SpellDefinition = {
  name: 'Bless',
  level: 1,
  class: 'cleric',
  school: 'conjuration',
  castingTime: '1 round',
  range: '60 yards',
  duration: '6 rounds',
  aoe: '50-foot cube',
  description: 'All allies in area gain +1 to hit and +1 to saves vs fear.',
  dmNarration: 'A warmth settles over the party, steadying their hands and stiffening their resolve.',
  resolve(state) {
    return {
      casterConditions: ['blessed'],
      narration: `${state.casterName}'s voice carries the Blessing outward through the company. It isn't loud, but it settles somewhere beneath the noise — in the hands, in the jaw, in the part of the spine that keeps a person upright when things go badly.`,
      mechanicalDetail: 'Bless: +1 attack, +1 save vs fear for all allies in 50-ft cube; 6 rounds',
    };
  },
};

const COMMAND: SpellDefinition = {
  name: 'Command',
  level: 1,
  class: 'cleric',
  school: 'enchantment',
  castingTime: '1 segment',
  range: '10 yards',
  duration: '1 round',
  aoe: '1 creature',
  description: 'One-word command that target must obey. Undead and creatures with >5 INT are immune.',
  dmNarration: 'The cleric speaks a single word with terrible authority and the target obeys.',
  resolve(state, target) {
    const targetName = target?.name || 'the target';
    return {
      targetConditions: target ? ['commanded'] : undefined,
      narration: `${state.casterName} speaks one word — just one, with the weight of a closed fist — and ${targetName} hears it not as a request but as a fact. For one heartbeat, ${targetName}'s will isn't ${target ? target.name + '\'s' : 'their own'}.`,
      mechanicalDetail: 'Command: 1-word obedience for 1 round; save vs spell negates',
    };
  },
};

const DETECT_EVIL: SpellDefinition = {
  name: 'Detect Evil',
  level: 1,
  class: 'cleric',
  school: 'divination',
  castingTime: '1 round',
  range: '0',
  duration: '1 turn + 5 rounds/level',
  aoe: '10 × 120 ft path',
  description: 'Detects emanations of evil in a 10×120 ft path ahead. Shows intensity, not details.',
  dmNarration: 'The cleric holds their holy symbol forward and scans the darkness ahead.',
  resolve(state) {
    return {
      casterConditions: ['detecting-evil'],
      narration: `${state.casterName} lifts the holy symbol and reads the dark ahead of it. Evil doesn't hide well from this — not its presence, anyway. Its intentions are another matter.`,
      mechanicalDetail: 'Detect Evil: 10×120 ft path; intensity visible; 1 turn + 5 rounds/level',
    };
  },
};

const PROTECTION_FROM_EVIL: SpellDefinition = {
  name: 'Protection from Evil',
  level: 1,
  class: 'cleric',
  school: 'abjuration',
  castingTime: '4 segments',
  range: 'Touch',
  duration: '3 rounds/level',
  aoe: 'Creature touched',
  description: '+2 to AC and saves vs evil creatures. Blocks mental control. Bars bodily contact by summoned/conjured creatures.',
  dmNarration: 'A faint nimbus of holy light surrounds the protected creature.',
  resolve(state, target) {
    const subject = target?.name || state.casterName;
    return {
      targetConditions: target ? ['protected-from-evil'] : undefined,
      casterConditions: target ? undefined : ['protected-from-evil'],
      narration: `${state.casterName} speaks the ward over ${subject}. The prayer isn't a wall — it's a declaration. It tells evil things that this one is spoken for, and the world takes note of that in its own way.`,
      mechanicalDetail: 'Protection from Evil: +2 AC/saves vs evil; bars mental control; 3 rounds/level',
    };
  },
};

const SANCTUARY: SpellDefinition = {
  name: 'Sanctuary',
  level: 1,
  class: 'cleric',
  school: 'abjuration',
  castingTime: '4 segments',
  range: 'Touch',
  duration: '2 rounds + 1 round/level',
  aoe: 'Creature touched',
  description: 'Enemies must save vs spell to attack the protected creature. Ends if protected creature attacks.',
  dmNarration: 'The cleric is enveloped in an aura of inviolable calm that enemies seem unable to breach.',
  resolve(state, target) {
    const subject = target?.name || state.casterName;
    return {
      targetConditions: target ? ['sanctuary'] : undefined,
      casterConditions: target ? undefined : ['sanctuary'],
      narration: `The Sanctuary settles around ${subject} like a held breath. Enemies look at ${subject} and lose the thread of their aggression — not because ${subject} is invisible, but because something in them keeps asking whether this is the right moment.`,
      mechanicalDetail: 'Sanctuary: enemies save vs spell to attack; ends on offensive action',
    };
  },
};

const LIGHT_CLERIC: SpellDefinition = {
  name: 'Light',
  level: 1,
  class: 'cleric',
  school: 'alteration',
  castingTime: '4 segments',
  range: '120 yards',
  duration: '1 turn/level',
  aoe: '20-foot radius globe',
  description: 'Creates light equal to torchlight for 1 turn/level.',
  dmNarration: 'A warm light blooms from the point the cleric indicates.',
  resolve(state, target) {
    if (target) {
      return {
        targetConditions: ['blinded'],
        narration: `${state.casterName} directs the light directly into ${target.name}'s face. The god does not look away.`,
        mechanicalDetail: 'Light (Cleric): aimed at creature, blinded if save fails',
      };
    }
    return {
      lightGranted: true,
      narration: `${state.casterName} speaks the prayer and the darkness pulls back. Not much. But enough. The light holds, patient and still.`,
      mechanicalDetail: 'Light (Cleric): 20 ft radius, 1 turn/level',
    };
  },
};

// Level 2 ─────────────────────────────────────────────────────────────────────

const HOLD_PERSON_CLERIC: SpellDefinition = {
  name: 'Hold Person',
  level: 2,
  class: 'cleric',
  school: 'enchantment',
  castingTime: '5 segments',
  range: '60 yards',
  duration: '4 rounds + 1 round/level',
  aoe: '1-3 persons',
  description: 'Holds 1-3 humanoid targets rigid. Save vs spell negates.',
  dmNarration: 'The targets seize up, locked in paralysis.',
  resolve(state, target) {
    const targetName = target?.name || 'the targets';
    return {
      targetConditions: target ? ['held'] : undefined,
      narration: `${state.casterName} raises the symbol and holds it steady. ${targetName} ${target ? 'tries' : 'try'} to move and ${target ? 'discovers' : 'discover'} that moving is no longer something ${target ? target.name + ' does' : 'they do'}.`,
      mechanicalDetail: 'Hold Person (Cleric): 1-3 humanoids rigid; save vs spell; 4+level rounds',
    };
  },
};

const SILENCE: SpellDefinition = {
  name: 'Silence',
  level: 2,
  class: 'cleric',
  school: 'alteration',
  castingTime: '5 segments',
  range: '120 yards',
  duration: '2 rounds/level',
  aoe: '15-foot radius',
  description: 'Complete magical silence in area. Prevents verbal spell components. No save for area.',
  dmNarration: 'All sound is swallowed in the affected area — footsteps, voices, even the creak of armour.',
  resolve(state, target) {
    const targetName = target?.name || 'the area';
    return {
      targetConditions: target ? ['silenced'] : undefined,
      narration: `The Silence drops like a curtain. Around ${targetName} the air keeps moving, torches keep burning — but all the sounds that should be there are not. Spellcasters caught in it reach for their words and find nothing to hold onto.`,
      mechanicalDetail: 'Silence: no sound in 15-ft radius; verbal spells impossible; 2 rounds/level',
    };
  },
};

const SPIRITUAL_HAMMER: SpellDefinition = {
  name: 'Spiritual Hammer',
  level: 2,
  class: 'cleric',
  school: 'invocation',
  castingTime: '5 segments',
  range: '30 yards',
  duration: '1 round/level',
  aoe: '1 creature',
  description: 'Creates a magic hammer that attacks as a +1 weapon for 1 round/level. Counts as +3 vs undead.',
  dmNarration: 'A hammer of pure force materialises and strikes the target.',
  resolve(state, target) {
    const dmg = rollDice(1, 6, state.seed) + 1;
    const targetName = target?.name || 'the target';
    const vsUndead = target?.isUndead;
    return {
      hpDelta: -dmg,
      narration: `${state.casterName} extends the faith outward and it takes shape — a hammer of condensed intent, forged from whatever ${state.casterName} believes hard enough. It strikes ${targetName}${vsUndead ? ', and undead things feel spiritual weapons differently — with something like fear' : ''}.`,
      mechanicalDetail: `Spiritual Hammer: ${dmg} damage${vsUndead ? ' (+3 vs undead)' : ''}; 1 round/level`,
    };
  },
};

const FIND_TRAPS: SpellDefinition = {
  name: 'Find Traps',
  level: 2,
  class: 'cleric',
  school: 'divination',
  castingTime: '5 segments',
  range: '0',
  duration: '3 turns',
  aoe: '10 × 30 ft path',
  description: 'Detects all traps in path — magical and mechanical.',
  dmNarration: 'The cleric moves slowly, reading the hidden warnings in the dungeon\'s architecture.',
  resolve(state) {
    return {
      casterConditions: ['finding-traps'],
      narration: `${state.casterName} moves carefully, with the focus of someone reading a language most people never learned. The dungeon's traps glow faintly in ${state.casterName}'s sight — not bright, but enough to know where not to step.`,
      mechanicalDetail: 'Find Traps: all traps visible in 10×30 ft path for 3 turns',
    };
  },
};

const SLOW_POISON: SpellDefinition = {
  name: 'Slow Poison',
  level: 2,
  class: 'cleric',
  school: 'necromancy',
  castingTime: '1 segment',
  range: 'Touch',
  duration: '1 hour/level',
  aoe: 'Creature touched',
  description: 'Slows the effects of poison for duration. Does not cure it — just buys time.',
  dmNarration: 'The cleric\'s touch stops the poison\'s progress through the victim\'s veins.',
  resolve(state, target) {
    const targetName = target?.name || 'the poisoned';
    return {
      removeConditions: ['poisoned'],
      targetConditions: target ? ['poison-slowed'] : undefined,
      narration: `${state.casterName} presses both hands to ${targetName}'s chest and holds them there. The poison doesn't leave — it just stops racing. ${targetName} has time now. Not much, but time.`,
      mechanicalDetail: `Slow Poison: poison effects halted for ${state.casterLevel} hours; doesn't cure`,
    };
  },
};

const SPEAK_WITH_ANIMALS_CLERIC: SpellDefinition = {
  name: 'Speak with Animals',
  level: 2,
  class: 'cleric',
  school: 'alteration',
  castingTime: '5 segments',
  range: '0',
  duration: '2 rounds/level',
  aoe: '1 animal',
  description: 'Allows communication with animals. Animals may be helpful but aren\'t compelled.',
  dmNarration: 'The cleric crouches and speaks softly, and the animal seems to genuinely listen.',
  resolve(state, target) {
    const targetName = target?.name || 'the animal';
    return {
      casterConditions: ['speaking-with-animals'],
      narration: `${state.casterName} lowers their voice to something else entirely and ${targetName} responds to it. The exchange isn't human — it's simpler than that, and more honest. Animals don't lie about what they've seen.`,
      mechanicalDetail: 'Speak with Animals: 2 rounds/level; animals may assist but are not compelled',
    };
  },
};

// Level 3 ─────────────────────────────────────────────────────────────────────

const CURE_DISEASE: SpellDefinition = {
  name: 'Cure Disease',
  level: 3,
  class: 'cleric',
  school: 'necromancy',
  castingTime: '1 round',
  range: 'Touch',
  duration: 'Permanent',
  aoe: 'Creature touched',
  description: 'Cures all diseases, including parasites and magical diseases.',
  dmNarration: 'The cleric\'s touch draws the disease out of the patient\'s body entirely.',
  resolve(state, target) {
    const targetName = target?.name || 'the patient';
    return {
      removeConditions: ['diseased'],
      narration: `${state.casterName} speaks the long prayer over ${targetName} — the one for things that have taken root and grown where they weren't invited. When it ends, the disease is simply gone. The body remembers it, but the thing itself isn't there anymore.`,
      mechanicalDetail: 'Cure Disease: all diseases removed permanently',
    };
  },
};

const PRAYER: SpellDefinition = {
  name: 'Prayer',
  level: 3,
  class: 'cleric',
  school: 'conjuration',
  castingTime: '6 segments',
  range: '0',
  duration: '1 round/level',
  aoe: '60-foot radius',
  description: 'Allies gain +1 to hit, damage, saves. Enemies take −1 to same.',
  dmNarration: 'The cleric\'s voice rises in supplication and something answers.',
  resolve(state) {
    return {
      casterConditions: ['praying'],
      narration: `${state.casterName}'s voice lifts into the prayer and the response comes — not in words, but in the way the air changes, the way the company stands a little straighter. Enemies feel it differently. Something in the room is paying attention, and it isn't paying attention to them.`,
      mechanicalDetail: 'Prayer: allies +1 hit/dmg/saves; enemies −1; 1 round/level, 60 ft radius',
    };
  },
};

const REMOVE_CURSE: SpellDefinition = {
  name: 'Remove Curse',
  level: 3,
  class: 'cleric',
  school: 'abjuration',
  castingTime: '6 segments',
  range: 'Touch',
  duration: 'Permanent',
  aoe: 'Special',
  description: 'Removes most curses from person or object.',
  dmNarration: 'The curse unravels visibly, dark threads of magic dissolving under the cleric\'s hands.',
  resolve(state, target) {
    const targetName = target?.name || 'the cursed';
    return {
      removeConditions: ['cursed'],
      narration: `${state.casterName} traces the curse's shape — it has edges, once you know how to feel for them — and works the prayer against each one until they give way. ${targetName} is lighter when it's done, in the way that bodies are lighter when they stop carrying something they didn't know had weight.`,
      mechanicalDetail: 'Remove Curse: all curses removed permanently',
    };
  },
};

const DISPEL_MAGIC_CLERIC: SpellDefinition = {
  name: 'Dispel Magic',
  level: 3,
  class: 'cleric',
  school: 'abjuration',
  castingTime: '6 segments',
  range: '60 yards',
  duration: 'Instantaneous',
  aoe: '30-foot cube',
  description: 'Cancels magical spells and effects in area.',
  dmNarration: 'The magical energies in the area collapse and fade.',
  resolve(state, target) {
    return {
      removeConditions: ['charmed', 'held', 'sleeping', 'webbed', 'hasted', 'slowed', 'shielded', 'levitating', 'flying', 'invisible'],
      narration: `${state.casterName} names the prayer of unmaking and the active magic in the area loses its footing. Effects that were holding dissipate — not catastrophically, just inevitably, the way all borrowed things are eventually returned.`,
      mechanicalDetail: 'Dispel Magic (Cleric): ends active spell effects in 30-foot cube',
    };
  },
};

const CONTINUAL_LIGHT: SpellDefinition = {
  name: 'Continual Light',
  level: 3,
  class: 'cleric',
  school: 'alteration',
  castingTime: '6 segments',
  range: '120 yards',
  duration: 'Permanent',
  aoe: '60-foot radius',
  description: 'Permanent light equivalent to daylight in a 60-foot radius.',
  dmNarration: 'A permanent sphere of brilliant daylight blazes into existence.',
  resolve(state) {
    return {
      lightGranted: true,
      narration: `${state.casterName} makes the light permanent — not a torch, not a lantern, but something that will still be here when ${state.casterName} is long gone. The chamber fills with a clean, honest brightness. No shadows.`,
      mechanicalDetail: 'Continual Light: permanent 60-ft radius daylight',
    };
  },
};

const SPEAK_WITH_DEAD: SpellDefinition = {
  name: 'Speak with Dead',
  level: 3,
  class: 'cleric',
  school: 'necromancy',
  castingTime: '1 turn',
  range: '1 foot',
  duration: '1 round/level',
  aoe: '1 corpse',
  description: 'Asks 2+ questions of a corpse. Answers are truthful but may be cryptic.',
  dmNarration: 'The corpse\'s jaw moves and something that isn\'t quite the dead person answers.',
  resolve(state, target) {
    const targetName = target?.name || 'the corpse';
    return {
      narration: `${state.casterName} speaks the summoning over ${targetName}'s remains and waits. What comes back isn't ${targetName} — it's something wearing ${targetName}'s memories like a coat found in a closet. It will answer. Whether those answers help is a different question.`,
      mechanicalDetail: 'Speak with Dead: 2+ questions; truthful but cryptic; 1 round/level',
    };
  },
};

// Level 4 ─────────────────────────────────────────────────────────────────────

const CURE_SERIOUS_WOUNDS: SpellDefinition = {
  name: 'Cure Serious Wounds',
  level: 4,
  class: 'cleric',
  school: 'necromancy',
  castingTime: '7 segments',
  range: 'Touch',
  duration: 'Permanent',
  aoe: 'Creature touched',
  description: 'Heals 2d8+1 HP.',
  dmNarration: 'The cleric\'s hands pulse with healing energy, closing serious wounds.',
  resolve(state, target) {
    const healed = rollDice(2, 8, state.seed) + 1;
    const targetName = target?.name || 'the wounded';
    return {
      hpDelta: healed,
      narration: `${state.casterName} spreads both hands over the worst of it and gives the prayer everything it needs. More comes back than went in, the way it sometimes does when the faith runs clean. ${targetName} breathes, and the breath is steadier.`,
      mechanicalDetail: `Cure Serious Wounds: heals 2d8+1 = ${healed} HP`,
    };
  },
};

const NEUTRALIZE_POISON: SpellDefinition = {
  name: 'Neutralize Poison',
  level: 4,
  class: 'cleric',
  school: 'necromancy',
  castingTime: '7 segments',
  range: 'Touch',
  duration: 'Permanent',
  aoe: 'Creature or object touched',
  description: 'Completely neutralises poison in or on a creature or object.',
  dmNarration: 'The poison is drawn harmlessly out of the creature\'s system.',
  resolve(state, target) {
    const targetName = target?.name || 'the poisoned';
    return {
      removeConditions: ['poisoned', 'poison-slowed'],
      narration: `${state.casterName} closes ${state.casterName}'s hands around ${targetName}'s wrist and holds them until the prayer completes. The poison doesn't slow — it reverses. ${targetName}'s colour returns. Breathing steadies. The danger was real, and now it isn't.`,
      mechanicalDetail: 'Neutralize Poison: poison completely removed',
    };
  },
};

const PROTECTION_FROM_EVIL_10: SpellDefinition = {
  name: "Protection from Evil 10'",
  level: 4,
  class: 'cleric',
  school: 'abjuration',
  castingTime: '7 segments',
  range: 'Touch',
  duration: '1 round/level',
  aoe: "10-foot radius around creature",
  description: '+2 AC and saves vs evil for all within 10-foot radius. Bars bodily contact by summoned creatures.',
  dmNarration: 'A bubble of holy protection surrounds the cleric and all those nearby.',
  resolve(state) {
    return {
      casterConditions: ['protected-from-evil-10'],
      narration: `${state.casterName} extends the protection outward to encompass the company — a wider ward, more costly, but right now the cost feels appropriate. The hostile things outside it will find the boundary.`,
      mechanicalDetail: "Protection from Evil 10': 10-ft radius, +2 AC/saves vs evil; 1 round/level",
    };
  },
};

const STICKS_TO_SNAKES: SpellDefinition = {
  name: 'Sticks to Snakes',
  level: 4,
  class: 'cleric',
  school: 'alteration',
  castingTime: '7 segments',
  range: '30 yards',
  duration: '2 rounds/level',
  aoe: '1d4+2 sticks/level',
  description: 'Turns 1d4+2 sticks per level into snakes (50% venomous) that obey the caster.',
  dmNarration: 'The sticks in the area writhe and twist, becoming serpents.',
  resolve(state) {
    const count = rollDice(1, 4, state.seed) + 2;
    return {
      narration: `${state.casterName} speaks the old word and the sticks on the floor remember what wood was before it became sticks. ${count} of them uncoil slowly, find their heads, and look to ${state.casterName} for instruction.`,
      mechanicalDetail: `Sticks to Snakes: ${count} snakes; 50% venomous; obey caster; 2 rounds/level`,
    };
  },
};

// Level 5 ─────────────────────────────────────────────────────────────────────

const CURE_CRITICAL_WOUNDS: SpellDefinition = {
  name: 'Cure Critical Wounds',
  level: 5,
  class: 'cleric',
  school: 'necromancy',
  castingTime: '8 segments',
  range: 'Touch',
  duration: 'Permanent',
  aoe: 'Creature touched',
  description: 'Heals 3d8+3 HP.',
  dmNarration: 'The cleric pours everything into the healing, and even grievous wounds close.',
  resolve(state, target) {
    const healed = rollDice(3, 8, state.seed) + 3;
    const targetName = target?.name || 'the grievously wounded';
    return {
      hpDelta: healed,
      narration: `${state.casterName} gives it everything — puts both hands on ${targetName} and holds the prayer open until the god finishes speaking through it. The wounds close. Not quickly, not painlessly, but completely. ${targetName} looks surprised to still be here.`,
      mechanicalDetail: `Cure Critical Wounds: heals 3d8+3 = ${healed} HP`,
    };
  },
};

const FLAME_STRIKE: SpellDefinition = {
  name: 'Flame Strike',
  level: 5,
  class: 'cleric',
  school: 'invocation',
  castingTime: '8 segments',
  range: '60 yards',
  duration: 'Instantaneous',
  aoe: '5-foot diameter column',
  description: '6d8 divine fire damage. Save vs spell for half.',
  dmNarration: 'A column of divine fire crashes down from above onto the target.',
  resolve(state, target) {
    const dmg = rollDice(6, 8, state.seed);
    const targetName = target?.name || 'the target';
    return {
      hpDelta: -dmg,
      narration: `${state.casterName} calls the judgment down, and it comes — a pillar of fire from somewhere that isn't the ceiling, with a sound like a closed door being kicked open. ${targetName} is inside it when it arrives. There is nothing diplomatic about this spell.`,
      mechanicalDetail: `Flame Strike: 6d8 = ${dmg} divine fire damage; save vs spell for half`,
    };
  },
};

const RAISE_DEAD: SpellDefinition = {
  name: 'Raise Dead',
  level: 5,
  class: 'cleric',
  school: 'necromancy',
  castingTime: '1 round',
  range: '30 yards',
  duration: 'Permanent',
  aoe: '1 person',
  description: 'Restores life to a dead person. Subject loses 1 CON permanently. Must survive a system shock.',
  dmNarration: 'The dead one gasps, their eyes opening with the look of someone returning from far away.',
  resolve(state, target) {
    const targetName = target?.name || 'the fallen';
    return {
      narration: `${state.casterName} speaks the prayer for return — the long one, the one that makes the words feel like effort — and ${targetName} answers. Not all the way, not yet. But the breath comes back, and the eyes open, and somewhere between there and here ${targetName} decides to stay.`,
      mechanicalDetail: "Raise Dead: restores life; -1 CON permanent; system shock check required",
    };
  },
};

const TRUE_SEEING: SpellDefinition = {
  name: 'True Seeing',
  level: 5,
  class: 'cleric',
  school: 'divination',
  castingTime: '8 segments',
  range: 'Touch',
  duration: '1 round/level',
  aoe: '60-foot range',
  description: 'Subject sees through illusions, polymorphs, disguises, invisibility, and into ethereal plane.',
  dmNarration: 'The subject\'s eyes take on a distant, all-knowing clarity.',
  resolve(state, target) {
    const subject = target?.name || state.casterName;
    return {
      casterConditions: target ? undefined : ['true-seeing'],
      targetConditions: target ? ['true-seeing'] : undefined,
      narration: `${state.casterName} anoints ${subject}'s eyes with the prayer and opens the second sight entirely — not just magic-sight, not just hidden-sight, but the sight that reads what things actually are behind what they're willing to appear as. Nothing in the room looks the same.`,
      mechanicalDetail: 'True Seeing: sees all illusions/polymorphs/invisibility; 1 round/level',
    };
  },
};

const COMMUNE: SpellDefinition = {
  name: 'Commune',
  level: 5,
  class: 'cleric',
  school: 'divination',
  castingTime: '1 turn',
  range: '0',
  duration: 'Special',
  aoe: 'Caster',
  description: 'Asks deity 1 yes/no question/level. Three uses per week maximum.',
  dmNarration: 'The cleric falls silent, communing with their deity, and then speaks the questions aloud.',
  resolve(state) {
    const questions = state.casterLevel;
    return {
      narration: `${state.casterName} goes still in the way that silence goes still — not empty, but full of something listening. ${questions} questions, spoken carefully into the space between prayer and answer. The responses come not in language but in certainty, and ${state.casterName} opens their eyes with the look of someone who has been told.`,
      mechanicalDetail: `Commune: ${questions} yes/no questions answered; 3 uses/week max`,
    };
  },
};

// ─── DRUID SPELLS ─────────────────────────────────────────────────────────────

// Level 1 ─────────────────────────────────────────────────────────────────────

const ENTANGLE: SpellDefinition = {
  name: 'Entangle',
  level: 1,
  class: 'druid',
  school: 'alteration',
  castingTime: '4 segments',
  range: '80 yards',
  duration: '1 turn',
  aoe: '40-foot cube',
  description: 'Plants in area grab and hold creatures. Save vs spell at −2 or entangled.',
  dmNarration: 'The roots, grasses, and vines in the area surge upward, grasping at everything that moves.',
  resolve(state, target) {
    const targetName = target?.name || 'those in the area';
    return {
      targetConditions: target ? ['entangled'] : undefined,
      narration: `${state.casterName} calls to the green things — the roots, the creepers, the patient grasses — and they answer in the way nature answers: completely and without hesitation. ${targetName} ${target ? 'finds' : 'find'} the floor less cooperative than before.`,
      mechanicalDetail: 'Entangle: save vs spell −2 or entangled for 1 turn',
    };
  },
};

const FAERIE_FIRE: SpellDefinition = {
  name: 'Faerie Fire',
  level: 1,
  class: 'druid',
  school: 'evocation',
  castingTime: '4 segments',
  range: '80 yards',
  duration: '4 rounds/level',
  aoe: '5-foot radius/level',
  description: 'Outlines targets in pale fire. Attack rolls gain +2. Targets can\'t hide or use Invisibility.',
  dmNarration: 'A pale blue-green glow silhouettes the targets, making them easy to see and hit.',
  resolve(state, target) {
    const targetName = target?.name || 'the targets';
    return {
      targetConditions: target ? ['faerie-fire'] : undefined,
      narration: `${state.casterName} paints the air with old light — the kind that belongs to bogs and deep forests — and it finds ${targetName}, settling around the edges of ${target ? target.name : 'them'} like a second shadow made of cold green fire. ${target ? target.name : 'They'} can't hide now. Not from this.`,
      mechanicalDetail: 'Faerie Fire: +2 to attacks vs affected; no Invisibility or hiding; 4 rounds/level',
    };
  },
};

const SPEAK_WITH_ANIMALS_DRUID: SpellDefinition = {
  name: 'Speak with Animals',
  level: 1,
  class: 'druid',
  school: 'alteration',
  castingTime: '4 segments',
  range: '0',
  duration: '2 rounds/level',
  aoe: '1 animal',
  description: 'Allows two-way communication with natural animals.',
  dmNarration: 'The druid speaks in the animal\'s own language and is clearly understood.',
  resolve(state, target) {
    return {
      casterConditions: ['speaking-with-animals'],
      narration: `${state.casterName} lowers to the animal's level and speaks in the old tongue — not words exactly, but the intention behind them. The animal listens. Animals are good at that.`,
      mechanicalDetail: 'Speak with Animals: 2-way communication; 2 rounds/level',
    };
  },
};

const DETECT_MAGIC_DRUID: SpellDefinition = {
  name: 'Detect Magic',
  level: 1,
  class: 'druid',
  school: 'divination',
  castingTime: '4 segments',
  range: '0',
  duration: '12 rounds',
  aoe: '10 × 30 ft path',
  description: 'Detects magical emanations in a 10×30 ft path.',
  dmNarration: 'The druid scans the area with eyes that read the weave of natural and supernatural forces.',
  resolve(state) {
    return {
      casterConditions: ['detecting-magic'],
      narration: `${state.casterName} slows and reads the space ahead — the druidic sight doesn't distinguish between nature's magic and a wizard's; it feels the same pulse in both. Something in this area breathes with a different rhythm than it should.`,
      mechanicalDetail: 'Detect Magic (Druid): 10×30 ft path, 12 rounds',
    };
  },
};

const PURIFY_FOOD_AND_DRINK: SpellDefinition = {
  name: 'Purify Food & Drink',
  level: 1,
  class: 'druid',
  school: 'alteration',
  castingTime: '4 segments',
  range: '30 yards',
  duration: 'Permanent',
  aoe: '1 cubic foot/level',
  description: 'Makes spoiled, rotten, or poisoned food and water safe to consume.',
  dmNarration: 'The taint drains from the food and water, leaving them clean and wholesome.',
  resolve(state) {
    return {
      removeConditions: ['poisoned'],
      narration: `${state.casterName} passes both hands over the food and speaks the word for clean. The rot and the taint are removed — not cleaned out, but unmade, as if they were never there. What remains is honest and safe.`,
      mechanicalDetail: 'Purify Food & Drink: removes rot, poison, spoilage from food/water',
    };
  },
};

// Level 2 ─────────────────────────────────────────────────────────────────────

const BARKSKIN: SpellDefinition = {
  name: 'Barkskin',
  level: 2,
  class: 'druid',
  school: 'alteration',
  castingTime: '5 segments',
  range: 'Touch',
  duration: '4 rounds + 1 round/level',
  aoe: 'Creature touched',
  description: 'Grants AC 6 (or improves existing AC by 1 per 4 levels). Tough but flexible.',
  dmNarration: 'The subject\'s skin hardens and textures like bark, without limiting movement.',
  resolve(state, target) {
    const subject = target?.name || state.casterName;
    return {
      targetConditions: target ? ['barkskin'] : undefined,
      casterConditions: target ? undefined : ['barkskin'],
      narration: `${state.casterName} calls the oak's patience into ${subject}'s skin. It doesn't look different, exactly — but when a hand presses against it, it gives like bark, not flesh. The forest is protective in its own way.`,
      mechanicalDetail: `Barkskin: AC 6 minimum; +1 AC per 4 levels; 4+level rounds`,
    };
  },
};

const CHARM_PERSON_OR_MAMMAL: SpellDefinition = {
  name: 'Charm Person or Mammal',
  level: 2,
  class: 'druid',
  school: 'enchantment',
  castingTime: '5 segments',
  range: '80 yards',
  duration: 'Special',
  aoe: '1 person or mammal',
  description: 'Target regards druid as trusted friend. Save vs spell negates.',
  dmNarration: 'The target relaxes, regarding the druid with sudden trust and warmth.',
  resolve(state, target) {
    const targetName = target?.name || 'the target';
    return {
      targetConditions: target ? ['charmed'] : undefined,
      narration: `${state.casterName} speaks in the oldest register — the one that runs under language to something older. ${targetName} hears it and the wariness in ${target ? target.name : 'them'} resolves into something closer to welcome.`,
      mechanicalDetail: 'Charm Person or Mammal: target regards druid as friend; save vs spell',
    };
  },
};

const OBSCUREMENT: SpellDefinition = {
  name: 'Obscurement',
  level: 2,
  class: 'druid',
  school: 'alteration',
  castingTime: '5 segments',
  range: '0',
  duration: '4 rounds/level',
  aoe: '10-foot cube/level',
  description: 'Fills area with mist, reducing visibility to 2d4 feet.',
  dmNarration: 'Thick mist boils up from the ground, blanketing the area in an impenetrable grey.',
  resolve(state) {
    const visibility = rollDice(2, 4, state.seed);
    return {
      narration: `The mist rises at ${state.casterName}'s call — not like weather, but with a direction and a purpose. Within moments the air is heavy and white and vision drops to nothing useful. Whatever was clear a moment ago is now a matter of memory.`,
      mechanicalDetail: `Obscurement: visibility reduced to ${visibility} feet; 4 rounds/level`,
    };
  },
};

const PRODUCE_FLAME: SpellDefinition = {
  name: 'Produce Flame',
  level: 2,
  class: 'druid',
  school: 'alteration',
  castingTime: '5 segments',
  range: '0',
  duration: '2 rounds/level',
  aoe: 'Special',
  description: 'Creates a flame in hand that can be thrown or held. 1d4+1 damage on touch or throw.',
  dmNarration: 'A flickering flame springs up in the druid\'s palm.',
  resolve(state, target) {
    const dmg = rollDice(1, 4, state.seed) + 1;
    if (target) {
      return {
        hpDelta: -dmg,
        narration: `${state.casterName} cups the flame and throws it — the old way, the way that predates torches. It catches ${target.name} cleanly and the fire makes its point.`,
        mechanicalDetail: `Produce Flame: ${dmg} fire damage on throw`,
      };
    }
    return {
      casterConditions: ['flame-in-hand'],
      narration: `A flame appears in ${state.casterName}'s palm, burning without consuming. It gives light. It gives heat. In ${state.casterName}'s grip it is obedient.`,
      mechanicalDetail: 'Produce Flame: flame in palm; 2 rounds/level; 1d4+1 thrown',
    };
  },
};

// Level 3 ─────────────────────────────────────────────────────────────────────

const CALL_LIGHTNING: SpellDefinition = {
  name: 'Call Lightning',
  level: 3,
  class: 'druid',
  school: 'alteration',
  castingTime: '1 turn',
  range: '360 yards',
  duration: '1 turn/level',
  aoe: '10-foot diameter bolt',
  description: '2d8+1d8/level lightning per bolt. One bolt per turn. Only outdoors or with storm present.',
  dmNarration: 'The sky darkens as the druid calls lightning down with terrifying precision.',
  resolve(state, target) {
    const dice = 2 + state.casterLevel;
    const dmg = rollDice(dice, 8, state.seed);
    const targetName = target?.name || 'the target point';
    return {
      hpDelta: target ? -dmg : undefined,
      narration: `${state.casterName} calls to the sky and the sky answers — not its own lightning, but lightning shaped by will, given a target. It finds ${targetName} with the indifference of weather and the precision of purpose.`,
      mechanicalDetail: `Call Lightning: ${dice}d8 = ${dmg} lightning; save vs spell for half`,
    };
  },
};

const CURE_DISEASE_DRUID: SpellDefinition = {
  name: 'Cure Disease',
  level: 3,
  class: 'druid',
  school: 'necromancy',
  castingTime: '1 round',
  range: 'Touch',
  duration: 'Permanent',
  aoe: 'Creature touched',
  description: 'Cures all diseases in the touched creature.',
  dmNarration: 'The druid draws the disease from the patient with the patience of forest medicine.',
  resolve(state, target) {
    const targetName = target?.name || 'the patient';
    return {
      removeConditions: ['diseased'],
      narration: `${state.casterName} places both hands on ${targetName} and lets the forest's patience work through the prayer. The disease is drawn out the way a splinter is drawn — carefully, completely, with no part left behind.`,
      mechanicalDetail: 'Cure Disease (Druid): all diseases removed',
    };
  },
};

const HOLD_ANIMAL: SpellDefinition = {
  name: 'Hold Animal',
  level: 3,
  class: 'druid',
  school: 'enchantment',
  castingTime: '6 segments',
  range: '80 yards',
  duration: '2 rounds/level',
  aoe: '1-4 animals',
  description: 'Holds 1-4 animals completely immobile. Save vs spell negates.',
  dmNarration: 'The animals freeze, locked in rigid immobility.',
  resolve(state, target) {
    const targetName = target?.name || 'the animals';
    return {
      targetConditions: target ? ['held'] : undefined,
      narration: `${state.casterName} speaks the word of stillness to ${targetName} — not a command, but a reminder of the state that came before motion. ${target ? target.name : 'They'} remembers it and stops.`,
      mechanicalDetail: 'Hold Animal: 1-4 animals held rigid; save vs spell; 2 rounds/level',
    };
  },
};

const PLANT_GROWTH: SpellDefinition = {
  name: 'Plant Growth',
  level: 3,
  class: 'druid',
  school: 'alteration',
  castingTime: '1 round',
  range: '160 yards',
  duration: 'Permanent',
  aoe: '100 sq ft/level',
  description: 'Causes all plants in area to grow into a dense tangle, impassable without 1 ft/round movement.',
  dmNarration: 'The vegetation in the area erupts in explosive growth, forming an impenetrable thicket.',
  resolve(state) {
    return {
      narration: `${state.casterName} calls the growth and the plants answer by growing years in seconds. What was clearable ground is now a thicket that closes behind anyone trying to push through it, thorns and roots and stems all collaborating.`,
      mechanicalDetail: 'Plant Growth: area becomes impassable thicket; 1 ft/round movement; permanent',
    };
  },
};

const SUMMON_INSECTS: SpellDefinition = {
  name: 'Summon Insects',
  level: 3,
  class: 'druid',
  school: 'conjuration',
  castingTime: '1 round',
  range: '30 yards',
  duration: '1 round/level',
  aoe: '1 creature',
  description: 'Summons a swarm that attacks one creature. 2 HP/round; −4 to attack rolls; −2 to saves.',
  dmNarration: 'A cloud of stinging insects descends on the target in an angry, biting mass.',
  resolve(state, target) {
    const targetName = target?.name || 'the target';
    return {
      hpDelta: -2, // Per round; actual sustained damage applied each round
      targetConditions: target ? ['insect-swarm'] : undefined,
      narration: `${state.casterName} calls the swarm — every stinging, crawling, biting thing within reach of the call — and directs them at ${targetName}. The cloud is dense enough to breathe in by accident. ${targetName} will have a hard time concentrating on anything else.`,
      mechanicalDetail: 'Summon Insects: 2 HP/round; −4 attack, −2 saves; 1 round/level',
    };
  },
};

// ─── Spell Registry ───────────────────────────────────────────────────────────

export const SPELLS: SpellDefinition[] = [
  // Magic-User L1
  MAGIC_MISSILE, SLEEP, CHARM_PERSON, SHIELD, DETECT_MAGIC_MU, LIGHT_MU, READ_MAGIC, HOLD_PORTAL,
  // Magic-User L2
  WEB, INVISIBILITY, MIRROR_IMAGE, KNOCK, LEVITATE, DETECT_INVISIBILITY, ESP,
  // Magic-User L3
  FIREBALL, LIGHTNING_BOLT, FLY, HASTE, HOLD_PERSON_MU, DISPEL_MAGIC_MU, SLOW,
  // Magic-User L4
  POLYMORPH_OTHER, ICE_STORM, CONFUSION, DIMENSION_DOOR, WALL_OF_FIRE, FEAR,
  // Magic-User L5
  CLOUDKILL, CONE_OF_COLD, TELEPORT, HOLD_MONSTER, ANIMATE_DEAD, FEEBLEMIND,

  // Cleric L1
  CURE_LIGHT_WOUNDS, BLESS, COMMAND, DETECT_EVIL, PROTECTION_FROM_EVIL, SANCTUARY, LIGHT_CLERIC,
  // Cleric L2
  HOLD_PERSON_CLERIC, SILENCE, SPIRITUAL_HAMMER, FIND_TRAPS, SLOW_POISON, SPEAK_WITH_ANIMALS_CLERIC,
  // Cleric L3
  CURE_DISEASE, PRAYER, REMOVE_CURSE, DISPEL_MAGIC_CLERIC, CONTINUAL_LIGHT, SPEAK_WITH_DEAD,
  // Cleric L4
  CURE_SERIOUS_WOUNDS, NEUTRALIZE_POISON, PROTECTION_FROM_EVIL_10, STICKS_TO_SNAKES,
  // Cleric L5
  CURE_CRITICAL_WOUNDS, FLAME_STRIKE, RAISE_DEAD, TRUE_SEEING, COMMUNE,

  // Druid L1
  ENTANGLE, FAERIE_FIRE, SPEAK_WITH_ANIMALS_DRUID, DETECT_MAGIC_DRUID, PURIFY_FOOD_AND_DRINK,
  // Druid L2
  BARKSKIN, CHARM_PERSON_OR_MAMMAL, OBSCUREMENT, PRODUCE_FLAME,
  // Druid L3
  CALL_LIGHTNING, CURE_DISEASE_DRUID, HOLD_ANIMAL, PLANT_GROWTH, SUMMON_INSECTS,
];

// ─── Lookup helpers ──────────────────────────────────────────────────────────

/** Find a spell by name (case-insensitive, partial match) */
export function findSpell(query: string): SpellDefinition | null {
  const q = query.toLowerCase().trim();
  // Exact match first
  let found = SPELLS.find(s => s.name.toLowerCase() === q);
  if (found) return found;
  // Partial match
  found = SPELLS.find(s => s.name.toLowerCase().includes(q));
  return found || null;
}

/** Get all spells for a given class */
export function getClassSpells(charClass: SpellClass): SpellDefinition[] {
  return SPELLS.filter(s => s.class === charClass);
}

/** Get spells of a given level for a class */
export function getSpellsForLevel(charClass: SpellClass, level: number): SpellDefinition[] {
  return SPELLS.filter(s => s.class === charClass && s.level === level);
}

/** Get starting spellbook for a Magic-User (Read Magic + 3 random L1 spells) */
export function getStartingSpellbook(seed?: number): string[] {
  const l1 = getSpellsForLevel('mage', 1).filter(s => s.name !== 'Read Magic');
  // Deterministic shuffle
  const shuffled = l1.slice().sort((a, b) => {
    const sa = seedRoll(100, seed ? seed + a.name.charCodeAt(0) : undefined);
    const sb = seedRoll(100, seed ? seed + b.name.charCodeAt(0) : undefined);
    return sa - sb;
  });
  return ['Read Magic', ...shuffled.slice(0, 3).map(s => s.name)];
}
