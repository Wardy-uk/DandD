/**
 * Dungeon variety system — named location types, lore fragments, tone sets, signposting.
 * Everything here is deterministic on scene/campaign ID so a given room always
 * gets the same identity without needing a DB column.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type RoomType =
  | 'guardroom'
  | 'ossuary'
  | 'flooded_passage'
  | 'collapsed_hall'
  | 'kitchen'
  | 'shrine'
  | 'vault'
  | 'barracks'
  | 'torture_chamber'
  | 'alchemist_corner'
  | 'watchtower'
  | 'secret_chamber'
  | 'generic';

export type DungeonTheme =
  | 'ancient'
  | 'recently_fled'
  | 'still_occupied'
  | 'contested'
  | 'cursed'
  | 'flooded';

export interface RoomIdentity {
  type: RoomType;
  label: string;
  openers: string[];
  ambience: string[];
  verbs: RegExp;       // action pattern that triggers room-specific response
  specificFind: string[];
  specificHazard: string[];
}

export interface ThemeTone {
  theme: DungeonTheme;
  label: string;
  ambienceModifier: string[];
  pressureLines: string[];
}

// ─── Room Identities ──────────────────────────────────────────────────────────

const ROOM_IDENTITIES: Record<RoomType, RoomIdentity> = {
  guardroom: {
    type: 'guardroom',
    label: 'Guardroom',
    openers: [
      'Arrow slits on two walls. Whatever came through here was expected.',
      "An old duty roster, pinned and half-legible. One name is crossed out in different ink.",
      'A weapons rack against the far wall — some slots empty, some not. Someone made choices here.',
      'There is a duty bell near the door, dented but still mounted. Nobody rang it in time.',
      'The room smells of old iron and unwashed kit. The straw underfoot was changed, once.',
    ],
    ambience: [
      "A thin grey light comes through the arrow slits. The sound of wind, nothing more.",
      'Tally marks scratched into the wall beside the duty stool. Shifts, maybe.',
      'A duty stool knocked over near the far passage. Left in a hurry.',
    ],
    verbs: /check.*roster|examine.*rack|ring.*bell|check.*slit|look.*roster|inspect.*post/,
    specificFind: [
      "A lockbox under the duty table, unlocked. Whoever left didn't have time for it.",
      'A ring of keys on a peg — six keys, three different sizes.',
      'A small flask, still sealed. The seal is wax, not cork.',
    ],
    specificHazard: [
      'A crossbow trap mounted behind an arrow slit, still loaded and cocked.',
      'A trip-cord across the inner doorway, ankle height and nearly invisible against the stone.',
      'The floor just inside the second door gives slightly — a pressure plate.',
    ],
  },

  ossuary: {
    type: 'ossuary',
    label: 'Ossuary',
    openers: [
      'Stacked bones on wooden shelves, floor to ceiling. Someone organized this with care.',
      'Votive candles were here recently — the wax drips are still soft at the edges.',
      'Something disturbed the back rows. The skulls there are scattered, not stacked.',
      'A name scratched into a stone plinth near the center: ALDRIC. Below it, a date.',
      'The ceiling is low. The bones go back a long way into the dark.',
    ],
    ambience: [
      'Quiet here in a different way than the rest of the dungeon.',
      'The air smells of old stone and ash. Nothing rotting — just settled.',
      'A few bones at the far end are newer than the others.',
    ],
    verbs: /examine.*bones|read.*plinth|check.*candle|look.*inscription|inspect.*shelf/,
    specificFind: [
      'A sealed funeral casket behind the stacked shelves — small, iron, locked.',
      'Votive offerings tucked between skulls: a coin, a carved bird, a small knife with a broken blade.',
      'An inscription in the floor tiles, half-covered by scattered remains.',
    ],
    specificHazard: [
      'The shelving is structural. Disturbing it could bring the whole wall down.',
      'The disturbed remains at the back were disturbed from underneath.',
      'Several skulls face inward toward a central point. They were placed that way deliberately.',
    ],
  },

  flooded_passage: {
    type: 'flooded_passage',
    label: 'Flooded Passage',
    openers: [
      "Ankle-deep water, black and still. Sound travels strangely in here.",
      "The floor is submerged. Your torchlight cuts out at the water's surface.",
      'Water coming in from somewhere above — a slow, steady seep.',
      'The passage walls are stained with high-water marks. This floods higher sometimes.',
      'Cold water, knee-deep at the center. The far side is darker than it should be.',
    ],
    ambience: [
      'Everything echoes strangely. A whisper would carry twenty feet.',
      'The water smells of mineral and rust. Older than any sewer.',
      'Your torches will not last as long in here. The air is too damp.',
    ],
    verbs: /wade|check.*depth|test.*water|look.*dry route|examine.*channel/,
    specificFind: [
      'Something visible at the bottom of the deeper section — faint, but there.',
      'A waterlogged pack wedged against the wall, partially submerged.',
      'Iron rungs set into the wall, going up. Original to the construction.',
    ],
    specificHazard: [
      'The current picks up near the far wall — something is draining below.',
      'A rusted lock mechanism on the far door. You will need to force it or accept the noise.',
      'The floor slopes away sharply at the center point. No warning markers.',
    ],
  },

  collapsed_hall: {
    type: 'collapsed_hall',
    label: 'Collapsed Hall',
    openers: [
      'Half the ceiling is down. Rubble across most of the floor, old mortar still in the air.',
      'You can see through to an upper level — the collapse opened a gap two people could use.',
      'Whatever this hall was, the fall was recent enough to leave everything sharp-edged.',
      'A partial arch still stands on the far side. Everything else came down at once.',
      'Rubble and bent ironwork. Something structural failed here, not fire — stone fell inward.',
    ],
    ambience: [
      'Wind through the collapse. Something above is exposed to outside air.',
      'The rubble shifts underfoot. Not all of it is settled.',
      'A blocked passage under the fall — maybe passable, maybe not.',
    ],
    verbs: /climb.*rubble|check.*upper|clear.*rubble|examine.*arch|look.*passage|scale.*debris/,
    specificFind: [
      'Trapped beneath a large slab: a leather case, intact. The slab can be shifted.',
      'The upper level is accessible. Something up there has not been disturbed.',
      'A passage that was not obvious before the collapse, now visible through the gap.',
    ],
    specificHazard: [
      'The partial arch is holding more weight than it looks capable of.',
      'Shifting the wrong piece of rubble will bring more down. The wrong piece is not obvious.',
      'Something is balanced near the top of the debris pile. It will fall if disturbed.',
    ],
  },

  kitchen: {
    type: 'kitchen',
    label: 'Kitchen',
    openers: [
      'Old grease and cold ash. The hearth has not been used in some time, but the smell persists.',
      'A still-warm hearth — banked embers, not fully cold. Someone was here within the last day.',
      'Vermin signs everywhere: gnawed sacking, droppings, something that got into the flour.',
      'Smoke damage runs up the back wall from a grease fire, years ago. The ceiling is black.',
      'The larder shelves are stripped. What remains is spoiled or turned.',
    ],
    ambience: [
      'Something has been living in here. The signs are recent.',
      'The larder door was forced from the inside.',
      'A heavy cleaver buried in the prep block. It has not moved in a long time.',
    ],
    verbs: /check.*larder|examine.*hearth|look.*food|search.*store|check.*fire|inspect.*kitchen/,
    specificFind: [
      'A sealed clay pot behind the shelving — preserves of some kind, still edible.',
      'A small cache of rations hidden behind the flour barrels.',
      'A key on a hook, overlooked in the mess. Rust-flecked but functional.',
    ],
    specificHazard: [
      'Grease on the floor near the hearth. Slippery and flammable.',
      'The vermin here are larger than normal. Not rats.',
      'The banked embers look stable but are not. A draft would bring them up fast.',
    ],
  },

  shrine: {
    type: 'shrine',
    label: 'Shrine',
    openers: [
      'A faction crest above the altar, worn but legible. The party may or may not know it.',
      'Desecrated — the altar stones overturned, offerings scattered. Whoever did it was angry.',
      'Intact, and that is unusual. Someone has been maintaining this place.',
      'The divine presence here is uncertain. The air does not feel wrong, but it does not feel blessed.',
      'Candles in the niches, burned to stubs. The ash on the altar is recent.',
    ],
    ambience: [
      'The acoustics are wrong for the size. Voices carry strangely upward.',
      'A draft from somewhere below the altar stone.',
      'The floor tiles form a pattern. There is a center point everything faces toward.',
    ],
    verbs: /examine.*altar|read.*crest|inspect.*offering|look.*symbol|check.*niche|study.*shrine/,
    specificFind: [
      "A reliquary behind the altar panel — small, silver, with a saint's mark.",
      "Offerings left recently: coin, a flower, a torn piece of cloth.",
      'A passage behind the rear shrine panel, concealed but not locked.',
    ],
    specificHazard: [
      'The altar stone is trapped. Moving the offering plate triggers a pressure switch.',
      'The divine ward here reacts to alignment. Some in the party will feel it.',
      'Something lives in the passage below the altar draft.',
    ],
  },

  vault: {
    type: 'vault',
    label: 'Vault',
    openers: [
      'A heavy door, standing open. The lock was worked from the inside.',
      'A strong room, sealed. Iron door with three locking points, all engaged.',
      'Signs of prior breach — the door frame is scarred, one hinge replaced more recently than the others.',
      'The door is heavy enough that two people would need effort to move it.',
      'Empty. The shelves have marks where things sat for years. Whatever it held is gone.',
    ],
    ambience: [
      'The air inside is dry and still in a way the rest of the dungeon is not.',
      'Marks on the floor where something was moved, and recently.',
      'The smell of metal and old leather.',
    ],
    verbs: /examine.*door|check.*shelf|look.*compartment|examine.*floor|inspect.*lock|open.*vault/,
    specificFind: [
      'A false bottom in the central shelf. Something was left here intentionally.',
      'A ledger, locked, listing contents and dates — the last entry is recent.',
      'A small compartment behind a loose stone in the back wall, still sealed.',
    ],
    specificHazard: [
      'The vault is trapped against the last line of retreat. The door mechanism locks from the outside.',
      'The shelving is wired. Removing items in the wrong order triggers something.',
      'Gas trap in the ceiling niches — activated by weight on the floor center.',
    ],
  },

  barracks: {
    type: 'barracks',
    label: 'Barracks',
    openers: [
      'Bunks, eight of them, most with bedrolls still on. The personal effects suggest a hasty departure.',
      'Rank markers on the wall above each bunk. Two of them scratched out.',
      'A gaming board on the central table, pieces still in mid-game. Somebody left in a hurry.',
      'Weapons racked neatly on the west wall. Personal items less so.',
      'Signs of a fight in the corner: overturned bunk, blood on the floor, old enough to be dry.',
    ],
    ambience: [
      'Unwashed gear and old lamp oil.',
      "The bunk at the end is different — slightly better fittings, curtain rod still mounted.",
      'The muster board still has names chalked on it. Several are marked "gone".',
    ],
    verbs: /check.*bunk|read.*roster|search.*effect|examine.*rack|look.*muster|search.*barracks/,
    specificFind: [
      "A locked footlocker under the sergeant's bunk — personal effects and coin.",
      'A letter, half-written and abandoned, under a pillow.',
      'A floor cache under a loose flagstone, dry and intact.',
    ],
    specificHazard: [
      'The weapons rack is loaded and tripwired. Someone left in a hurry but not without care.',
      'Something moved in from under the bunks when the far end was disturbed.',
      "The barracks connects directly to the officer's quarters. That room may not be empty.",
    ],
  },

  torture_chamber: {
    type: 'torture_chamber',
    label: 'Torture Chamber',
    openers: [
      'The restraints are occupied. Were occupied. The remains are old.',
      'Well-maintained instruments, carefully arranged. Whoever used this room was proud of their work.',
      'Recent use — the straw on the floor is not ancient, and the water in the basin is not stale.',
      'A rack on the far wall, frame intact, cranks still functional. This did not fall out of use naturally.',
      'The door has a bolt on the outside only.',
    ],
    ambience: [
      'No windows. No sound from outside.',
      'Iron smell, and something else — a chemical the party may or may not recognize.',
      'The floor drains into a channel that goes somewhere deeper.',
    ],
    verbs: /examine.*instrument|check.*restraint|look.*drain|search.*chamber|check.*rack|inspect.*tool/,
    specificFind: [
      'A ledger on the side table: names, dates, outcomes. The last entry is recent.',
      'A key on a hook by the door — small, brass, distinctive.',
      'A hidden release behind the instrument rack. A concealed passage.',
    ],
    specificHazard: [
      'The drain connects to something active below.',
      'One instrument is still set and primed.',
      'Someone is watching through the peephole in the door. It closes as you notice it.',
    ],
  },

  alchemist_corner: {
    type: 'alchemist_corner',
    label: "Alchemist's Corner",
    openers: [
      'Residue on the stone benches — staining that took years to build up. Someone worked here a long time.',
      'The smell hits first. Sharp, organic, with something underneath that has no name.',
      'Unstable containers on the shelf. Two of them are swollen at the seams.',
      'Partial recipes in several hands, tacked to the wall above the work surface.',
      'The work surface is scorched in three places. The largest scorch is old. The smallest is not.',
    ],
    ambience: [
      'The air is faintly wrong. Not poisonous — just not quite right.',
      'A slow drip from one of the sealed vessels, hitting the bench with a quiet tick.',
      'Equipment left mid-process: a flame still glowing under a vessel, heat still in the metal.',
    ],
    verbs: /examine.*container|read.*recipe|check.*equipment|identify.*substance|look.*note|inspect.*vessel/,
    specificFind: [
      'A complete batch of something useful — oil of slipperiness or lamp oil — in sealed jars.',
      'Partial notes on a compound the party has encountered before.',
      'A hidden compartment in the bench holding something the alchemist considered valuable.',
    ],
    specificHazard: [
      'One of the swollen containers is close to rupture. Moving it is risky.',
      'The largest sealed vessel is under pressure. A sharp blow would be bad.',
      'The residue on the bench is mildly corrosive. Bare skin on it for any length of time does damage.',
    ],
  },

  watchtower: {
    type: 'watchtower',
    label: 'Watchtower Room',
    openers: [
      'Arrow loops on three walls. From here, you can see a long way in any direction you choose.',
      'A signal mirror, mounted and angled. Someone has been using it recently.',
      'The lookout marks on the floor show where sentries stood. The wear is real.',
      'A rope signal mechanism — pull cord, distant bell. Still functional.',
      'Height and clear sightlines — the best tactical position the party has found.',
    ],
    ambience: [
      'Wind through the arrow loops. Louder than expected.',
      'The visibility from here is significant. You can see back the way you came.',
      'A shuttered lantern on a bracket — for signals, not for working by.',
    ],
    verbs: /look.*loop|examine.*mirror|check.*view|use.*signal|examine.*position|look.*outside/,
    specificFind: [
      'A range-finding map pinned to the inner wall, annotated in two different hands.',
      'A logbook of patrol routes, observations, and schedule.',
      'A cached supply of bolts and ammunition, locked in a box mounted to the wall.',
    ],
    specificHazard: [
      'The signal equipment is rigged to alert a distant post if disturbed incorrectly.',
      'The arrow loops give excellent visibility inward — the party is now visible from certain angles outside.',
      'A body in the corner, recently placed, with a signal flag still in its hand.',
    ],
  },

  secret_chamber: {
    type: 'secret_chamber',
    label: 'Secret Chamber',
    openers: [
      'This room was not meant to be found. Everything about it says so.',
      'No doors in the ordinary sense. The concealed way is the only entrance visible.',
      'Too clean. Everything is too deliberately placed. This room was maintained, not abandoned.',
      'Smaller than expected, and intentionally so. Built for a specific purpose, not general use.',
      'The concealment was not rushed. Whoever sealed this room meant it to stay sealed.',
    ],
    ambience: [
      'Completely still air. The room has been sealed for some time.',
      'No evidence of incidental use. Everything here was placed deliberately.',
      'The construction is of different quality to the surrounding dungeon.',
    ],
    verbs: /examine.*room|look.*mechanism|search.*content|check.*wall|inspect.*purpose/,
    specificFind: [
      'The contents are significant — this is why the room was hidden.',
      'Documents or artifacts that the original owner did not want found.',
      'Evidence of what this place really was, before the story you have been told.',
    ],
    specificHazard: [
      'The concealment mechanism is also a lock — and now the party is on the inside.',
      'Something was sealed in here with the contents.',
      'The room has a fail-state: disturb certain items and the concealment triggers a collapse.',
    ],
  },

  generic: {
    type: 'generic',
    label: 'Chamber',
    openers: [
      'Worked stone. Someone built this to last.',
      "The air is stale and old. This room hasn't seen use in a while.",
      'Stone walls, low ceiling, and enough shadow to keep secrets.',
      'Cold from the floor up. Not the cold of outside — the cold of below.',
    ],
    ambience: [
      'Nothing remarkable at first pass.',
      'The sort of room that rewards a careful second look.',
      'Quiet in here. The kind of quiet that waits.',
    ],
    verbs: /^$/, // never matches — falls through to generic handlers
    specificFind: [],
    specificHazard: [],
  },
};

// ─── Dungeon Themes ───────────────────────────────────────────────────────────

const THEME_TONES: Record<DungeonTheme, ThemeTone> = {
  ancient: {
    theme: 'ancient',
    label: 'Ancient/Abandoned',
    ambienceModifier: [
      'Centuries of silence. The stone has forgotten what it held.',
      'Old beyond reckoning. The air tastes of time.',
      'Whatever this was, it stopped being that long before living memory.',
    ],
    pressureLines: [
      'The threat here is not sentient. Something old woke.',
      'Whatever guards this place does not patrol. It waits.',
      'Time has done its own damage. The structure itself is a hazard.',
    ],
  },

  recently_fled: {
    theme: 'recently_fled',
    label: 'Recently Fled',
    ambienceModifier: [
      "Signs of hasty departure everywhere. Someone left in a hurry and didn't plan to.",
      'Still-warm evidence of recent occupation. Whatever cleared this place did it fast.',
      'Food on the table. Fire in the hearth. Nobody here.',
    ],
    pressureLines: [
      'They left because of something. It may still be here.',
      "The ones who ran know this dungeon. They might come back.",
      'A flight like this leaves useful things and dangerous things behind.',
    ],
  },

  still_occupied: {
    theme: 'still_occupied',
    label: 'Still Occupied',
    ambienceModifier: [
      'Evidence of current use. This place is not abandoned.',
      'Someone is maintaining this. The signs of care are recent.',
      'Occupied and functional. The party is the intrusion here.',
    ],
    pressureLines: [
      'Noise carries here. The occupants will notice.',
      'Patrols make sense in this dungeon. Assume they are happening.',
      'Whoever is here is organized. They have routes and schedules.',
    ],
  },

  contested: {
    theme: 'contested',
    label: 'Contested',
    ambienceModifier: [
      'Two sets of marks. Two factions have been through here and neither holds it cleanly.',
      'Fresh damage over older damage. The fighting here has been ongoing.',
      'Territorial markers from at least two groups, overlapping in places.',
    ],
    pressureLines: [
      'The factions here will not be distracted by each other for long.',
      'Being caught in the middle of this territorial dispute is bad for everyone.',
      'Both sides will see the party as an opportunity or a threat.',
    ],
  },

  cursed: {
    theme: 'cursed',
    label: 'Cursed/Corrupted',
    ambienceModifier: [
      'Something is wrong with this place in a way that is hard to name precisely.',
      'The light behaves slightly incorrectly. Shadows fall where they should not.',
      'Flora here grows against its nature. Fauna avoids this room.',
    ],
    pressureLines: [
      'The wrongness here is not physical. It will affect the party in ways hard to predict.',
      'Something here resists being understood. The more you look, the less you know.',
      'Whatever corrupted this place is still doing it.',
    ],
  },

  flooded: {
    theme: 'flooded',
    label: 'Flooded/Decayed',
    ambienceModifier: [
      'Water damage throughout. This structure has been fighting moisture for years and losing.',
      'Visibility is limited by mineral haze and damp air. Everything reflects strangely.',
      'The decay is structural as well as aesthetic. Watch where you step.',
    ],
    pressureLines: [
      'Movement here is slower and noisier than on dry ground.',
      'The damp is eating the torches. They will not last as long.',
      'Something in the water makes a sound that does not match what water should make.',
    ],
  },
};

// ─── Lore Fragments ───────────────────────────────────────────────────────────

const LORE_FRAGMENTS: Record<string, string[]> = {
  guardroom: [
    'A duty roster pinned to the wall. One name is crossed out in a different hand, more recently than the rest.',
    '"Third watch, south corridor — do not open the lower door for any reason. —Sgt. Aldric." The note is old.',
    'Tally marks scratched into the wall beside the duty stool. Forty-seven marks. Then a long gap. Then three more in a hurried hand.',
    'A name carved into the weapons rack: TOLVAR. Below it, a date that is eight months old.',
  ],
  ossuary: [
    '"They came from below. We sealed the lower door. Aldric didn\'t make it back." Scratched into a plinth in a shaking hand.',
    'A child\'s drawing scratched into the wall near the floor — a stick figure and what might be a dog. Near what used to be quarters.',
    'A broken wax seal on the floor, bearing a faction crest. The party may or may not recognise it.',
    'One of the skulls has been marked on the forehead with a symbol the party might know from somewhere else.',
  ],
  flooded_passage: [
    '"High water mark — Year of the Black Frost." Scratched into the wall at about chest height.',
    '"PASSAGE CLEAR — DO NOT TRUST THE FLOOR AT CENTER." In chalk on the dry section, already blurring.',
    'Waterlogged remains of a note in a sealed pouch, lodged in a crack. Most of it is lost.',
  ],
  collapsed_hall: [
    '"HERE STOOD THE HALL OF THE THIRD COMPACT." Carved into a stone now lying sideways in the rubble. The date beneath it is illegible.',
    'A body in the rubble, very old, still clutching a chisel. Someone was trying to clear a passage when the rest came down.',
    'Fresh marks where someone has been shifting rubble. Recently. They did not clear much.',
  ],
  kitchen: [
    'A cook\'s notes on a slate near the hearth — rations for thirty, dated two weeks ago. Below it: "LAST BATCH."',
    '"FOR WHOEVER FINDS THIS — THE SOUTH LARDER HAS A FLOOR CACHE. WORTH FINDING." Carved into the prep table.',
    'A child\'s cup, small and painted, on a high shelf out of the way of the working surfaces.',
  ],
  shrine: [
    '"That we may be judged by what we guarded, not by what we failed to guard." Prayer carved into the base of the altar.',
    'Offerings include a small portrait, carefully wrapped. The face in it looks like someone the party may have met.',
    'The desecration here was targeted. Whoever did this knew which symbols to remove and left the others alone.',
  ],
  vault: [
    '"Contents transferred by order of the Compact, Year 14. Recipient not recorded." The rest of the ledger is blank.',
    '"ALREADY EMPTY WHEN I FOUND IT." Scratched into the inside of the vault door. Handwriting different from any official inscription.',
    'A receipt for a very large sum, made out to a name, dated eleven months ago. No counterpart document.',
  ],
  barracks: [
    '"If someone reads this, we didn\'t make it to the gate. The thing in the lower hall comes every third night." A letter, never sent, under a pillow.',
    '"Garrison record — active duty 27, sick 3, missing 2, deserted 1." The "deserted" entry is crossed out and replaced with "dead."',
    'Personal effects on a bunk: a lock of hair, a coin with a hole in it, a carved bird. Someone was coming back for these.',
  ],
  torture_chamber: [
    'A ledger of sessions, dates, and outcomes. The last entry is two weeks old. The outcome column for it is blank.',
    '"I told them everything I knew on the first day. They kept going anyway." Scratched into the wall beside the restraints in tiny, precise letters.',
    'A name scratched into the floor near the drain, deep enough to have taken time. The name is one the party may recognise.',
  ],
  alchemist_corner: [
    '"Formula works. Side effects inconsistent. Do not use near open flame — TESTED THE HARD WAY." Partial notes in the margin of a recipe.',
    'A list of ingredients, one crossed out and replaced with something that is itself then crossed out. The final answer is circled.',
    'A symbol in the corner of several notes — the same symbol, drawn as if automatically, not intentionally.',
  ],
  watchtower: [
    '"Patrol schedule changed — new route avoids the lower wing. Nobody will say why." Noted in a logbook, dated three weeks ago.',
    '"HERE they will mass if pushed." A range-finding annotation on the wall map. The arrow points back toward where the party came from.',
    '"If you see THIS sequence, do not respond. Get out." A signal sequence written on the wall.',
  ],
  secret_chamber: [
    'A document explaining why this room was sealed — but the document itself has been defaced.',
    '"I built this room and I sealed it and I am the last person who should have the key. — R." The key is not here.',
    'A list of people who knew about this room. All the names have been crossed out.',
  ],
  generic: [
    '"They came from below. We sealed the lower door. Aldric didn\'t make it back."',
    'A child\'s drawing scratched into the stone near the floor — a figure and what might be a door.',
    'A broken wax seal bearing a crest the party may or may not recognise.',
    'Tally marks: forty-seven, then nothing. Then three more in a different hand.',
    '"Do not rest here. Move deeper or move out. Do not rest here." Scratched twice.',
    'A name, and a date that is not old enough.',
    '"The thing in the lower hall is not a creature. Do not engage it. Do not look at it. Move past it."',
  ],
};

// ─── Signpost Details ─────────────────────────────────────────────────────────

const SIGNPOST_DETAILS: Record<DungeonTheme, string[]> = {
  ancient: [
    'Cold air from the passage ahead — steady and deliberate. Something is open that way.',
    'The floor tilts subtly toward the eastern corridor. Whatever it drained toward matters.',
    'A corridor that angles wrong for this level. Worth noting.',
  ],
  recently_fled: [
    'Drag marks heading deeper. Something was moved through here in a hurry.',
    'Boot prints heading in one direction and not coming back.',
    'A dropped flask, still leaking slightly, pointing east.',
  ],
  still_occupied: [
    'Movement sounds from further in — regular, patterned. A patrol route.',
    'The echo changes around the corner — a larger space, or more occupants.',
    'Light from further in. Moving steadily. Someone is making rounds.',
  ],
  contested: [
    'Two sets of marks on the floor ahead — one group was following the other.',
    'Fresh blood on the east wall, heading deeper.',
    "The graffiti of one faction is scratched over the other's, and it keeps going that way.",
  ],
  cursed: [
    'The passage ahead is colder than it should be, in the specific way that means something.',
    'The light does not reach as far in the next section. Not a torch problem.',
    'Something ahead does not want to be approached. You can feel it without seeing it.',
  ],
  flooded: [
    'Water flowing in the east passage — moving water, which means a source or a drain.',
    'The ceiling ahead shows stress fractures. The passage is newer than this section.',
    'The water level is lower in the north corridor. Something is different there.',
  ],
};

// ─── Cleared Room Descriptions ────────────────────────────────────────────────

export const CLEARED_ROOM_NOTES: string[] = [
  'You\'ve been through this one. The room has given what it had.',
  'Cleared. Nothing useful left that the party hasn\'t already taken.',
  'The room feels exhausted of secrets. Your earlier work stripped it.',
  'You know this room. Whatever it held, you have it.',
];

// ─── Helper Functions ─────────────────────────────────────────────────────────

/**
 * Derive room type from scene name (DM-named rooms) or fall back to ID hash.
 */
export function detectRoomType(name: string, id: string): RoomType {
  const lower = name.toLowerCase();
  if (/guard|sentry|watch.?post|gatehouse/.test(lower)) return 'guardroom';
  if (/ossuary|crypt|bone.?room|charnel/.test(lower)) return 'ossuary';
  if (/flood|sewer|drain(age)?|canal|submerged/.test(lower)) return 'flooded_passage';
  if (/collapses?|ruin|rubble/.test(lower)) return 'collapsed_hall';
  if (/kitchen|larder|pantry|cook.?room|stores?/.test(lower)) return 'kitchen';
  if (/shrine|chapel|altar|temple|sanctum|nave/.test(lower)) return 'shrine';
  if (/vault|strong.?room|treasury|armoury/.test(lower)) return 'vault';
  if (/barrack|bunk.?room|dormitory|quarters/.test(lower)) return 'barracks';
  if (/torture|rack.?room|oubliette/.test(lower)) return 'torture_chamber';
  if (/alchemist|laborator|workshop|forge/.test(lower)) return 'alchemist_corner';
  if (/tower|watchtower|lookout|battlement/.test(lower)) return 'watchtower';
  if (/secret|hidden|concealed|sealed/.test(lower)) return 'secret_chamber';
  // Stable hash fallback — same scene always gets same type
  const h = fnvHash(id) >>> 0;
  const types: RoomType[] = [
    'guardroom', 'ossuary', 'flooded_passage', 'collapsed_hall',
    'kitchen', 'shrine', 'vault', 'barracks', 'torture_chamber',
    'alchemist_corner', 'watchtower', 'secret_chamber',
  ];
  return types[h % types.length];
}

/**
 * Derive dungeon theme from campaign ID — stable per campaign, no DB column needed.
 */
export function getDungeonTheme(campaignId: string): DungeonTheme {
  const h = fnvHash(campaignId) >>> 0;
  const themes: DungeonTheme[] = [
    'ancient', 'recently_fled', 'still_occupied', 'contested', 'cursed', 'flooded',
  ];
  return themes[h % themes.length];
}

export function getRoomIdentity(type: RoomType): RoomIdentity {
  return ROOM_IDENTITIES[type] ?? ROOM_IDENTITIES.generic;
}

export function getThemeTone(theme: DungeonTheme): ThemeTone {
  return THEME_TONES[theme];
}

/**
 * Deterministic room-type opener for a given scene.
 */
export function getRoomOpener(type: RoomType, sceneId: string): string {
  const identity = getRoomIdentity(type);
  const h = fnvHash(sceneId) >>> 0;
  return identity.openers[h % identity.openers.length];
}

/**
 * Deterministic ambient line — mixes room type and dungeon theme.
 */
export function getRoomAmbience(type: RoomType, theme: DungeonTheme, sceneId: string): string {
  const identity = getRoomIdentity(type);
  const tone = getThemeTone(theme);
  const h = fnvHash(sceneId) >>> 0;
  // Every third scene pulls from theme modifier instead of room ambience
  if (h % 3 === 0 && tone.ambienceModifier.length > 0) {
    return tone.ambienceModifier[(h >>> 4) % tone.ambienceModifier.length];
  }
  if (identity.ambience.length > 0) {
    return identity.ambience[(h >>> 2) % identity.ambience.length];
  }
  return tone.ambienceModifier[0] ?? '';
}

/**
 * Theme-appropriate pressure line for a given scene.
 */
export function getThemePressure(theme: DungeonTheme, sceneId: string): string {
  const tone = getThemeTone(theme);
  const h = fnvHash(sceneId) >>> 0;
  return tone.pressureLines[(h >>> 6) % tone.pressureLines.length];
}

/**
 * Signpost detail hinting at what lies further in.
 */
export function getSignpostDetail(theme: DungeonTheme, sceneId: string): string {
  const pool = SIGNPOST_DETAILS[theme] ?? SIGNPOST_DETAILS.ancient;
  const h = fnvHash(sceneId) >>> 0;
  return pool[(h >>> 8) % pool.length];
}

/**
 * Room-specific find for a given scene (deterministic selection).
 */
export function getRoomSpecificFind(type: RoomType, sceneId: string): string | null {
  const identity = getRoomIdentity(type);
  if (identity.specificFind.length === 0) return null;
  const h = fnvHash(sceneId) >>> 0;
  return identity.specificFind[h % identity.specificFind.length];
}

/**
 * Room-specific hazard for a given scene (deterministic selection).
 */
export function getRoomSpecificHazard(type: RoomType, sceneId: string): string | null {
  const identity = getRoomIdentity(type);
  if (identity.specificHazard.length === 0) return null;
  const h = fnvHash(sceneId) >>> 0;
  return identity.specificHazard[(h >>> 10) % identity.specificHazard.length];
}

/**
 * Draw a lore fragment from the room pool, excluding already-found ones.
 * Returns null if the pool is exhausted or if the caller should suppress this find.
 */
export function getLoreFragment(
  roomType: RoomType,
  alreadyFound: string[],
): string | null {
  const pool = [
    ...(LORE_FRAGMENTS[roomType] ?? []),
    ...LORE_FRAGMENTS.generic,
  ].filter((f) => !alreadyFound.includes(f));
  if (pool.length === 0) return null;
  // Use Math.random here — lore finds should feel genuinely unpredictable
  return pool[Math.floor(Math.random() * pool.length)];
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function fnvHash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h >>> 0);
}
