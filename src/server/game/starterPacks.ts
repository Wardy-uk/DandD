import { v4 as uuid } from 'uuid';
import type { Database } from 'sql.js';
import { run } from '../db/helpers.js';
import { getCampaignState, noteCampaignEvent, saveCampaignState } from './campaignState.js';

interface StarterConnection {
  direction: string;
  targetIndex: number;
  description: string;
}

interface StarterScene {
  name: string;
  brief: string;
  aiDescription: string;
  lightLevel: 'dark' | 'dim' | 'normal' | 'bright';
  terrainType: 'indoor' | 'dungeon' | 'cave' | 'forest' | 'town' | 'ruins';
  dominantFaction: 'locals' | 'delvers' | 'watch' | 'shadows';
  notes: string;
  connections: StarterConnection[];
}

interface StarterPack {
  townName: string;
  dominantFaction: 'locals' | 'delvers' | 'watch' | 'shadows';
  dangerLevel: number;
  encounterPressure: number;
  openingLog: string[];
  rumours: Array<{ text: string; truth: 'true' | 'partial' | 'false'; source: string }>;
  lore: Array<{ category: string; title: string; content: string }>;
  factionOverrides: Partial<Record<'locals' | 'delvers' | 'watch' | 'shadows', {
    name: string;
    reputation: number;
    heat: number;
    notes: string;
  }>>;
  scenes: StarterScene[];
}

const STARTER_PACKS: Record<string, StarterPack> = {
  'classic-fantasy-frontier': {
    townName: 'Blackbarrow Keep',
    dominantFaction: 'delvers',
    dangerLevel: 2,
    encounterPressure: 2,
    openingLog: [
      'The frontier is holding, but only just. Surveyors, goblins, and grave-robbers are all testing the same weak seams.',
      'Your first lead points toward an old watch-barrow beyond the keep road, where something has started using the dead stones again.',
    ],
    rumours: [
      { text: 'The old barrow road is safe until moonrise. After that, the goblins start moving.', truth: 'partial', source: 'teamster' },
      { text: 'A rival crew found silver nails and came back without their lantern-bearer.', truth: 'true', source: 'ostler' },
      { text: 'The keep reeve is paying double for maps of any dry route under the hill.', truth: 'true', source: 'reeve clerk' },
    ],
    lore: [
      { category: 'history', title: 'The March Barrows', content: 'The frontier burials were once warded with iron nails, saint-signs, and oath-stones. Most of that work has been looted away.' },
      { category: 'faction', title: 'Keep Interests', content: 'The keep wants the roads kept open, the local farmers want raids to stop, and rival delvers want first claim on whatever lies under the hill.' },
    ],
    factionOverrides: {
      locals: { name: 'keepfolk and settlers', reputation: 1, heat: 0, notes: 'The frontier people want practical results and have no patience for theatrics.' },
      delvers: { name: 'march delvers', reputation: 0, heat: 2, notes: 'Other treasure-seekers are already moving around the barrow lanes and will not welcome competition.' },
      watch: { name: 'the border watch', reputation: 0, heat: 1, notes: 'The watch needs help, but resents anyone who makes the roads louder.' },
      shadows: { name: 'barrow raiders', reputation: -1, heat: 2, notes: 'Goblin scouts and grave-robbers are testing the route every night.' },
    },
    scenes: [
      {
        name: 'Cold Road Gate',
        brief: 'A weathered gatehouse watches the road north toward the old barrows.',
        aiDescription: 'The keep road narrows between ditch and thorn hedge. A gatehouse stands to one side, half-military and half-worksite, with chalked warnings about missing teamsters and night movement. Beyond it, the old barrow path climbs toward dark turf mounds and broken standing stones.',
        lightLevel: 'normal',
        terrainType: 'ruins',
        dominantFaction: 'watch',
        notes: 'The border watch use this as a mustering point. The road ahead leads toward barrows and goblin spoor.',
        connections: [
          { direction: 'north', targetIndex: 1, description: 'the barrow path' },
          { direction: 'east', targetIndex: 2, description: 'a collapsed survey cut' },
        ],
      },
      {
        name: 'The Black Barrow Mouth',
        brief: 'A reopened barrow entrance breathes cold air over cut turf and pry-marks.',
        aiDescription: 'The turf has been hacked open recently. Someone has widened the old barrow mouth with shovels and bad judgement, leaving pry-bars, boot marks, and an offering bowl smashed at the threshold. The air from below is still and cold. Something is using this place now, not merely haunting it.',
        lightLevel: 'dim',
        terrainType: 'dungeon',
        dominantFaction: 'shadows',
        notes: 'This barrow entrance has been disturbed by raiders and would-be explorers alike.',
        connections: [
          { direction: 'south', targetIndex: 0, description: 'back to the road gate' },
          { direction: 'down', targetIndex: 2, description: 'the opened shaft' },
        ],
      },
      {
        name: 'Surveyor\'s Breach',
        brief: 'A narrow cut driven into the hill by desperate surveyors before they gave up.',
        aiDescription: 'Timbers brace a narrow breach in the hillside where some practical soul tried to get under the tomb without using the front door. Tool marks compete with claw scrapes, and the whole cut smells of wet earth, lamp smoke, and human nerves. It looks like the clever way in, which usually means it has already gone wrong for someone else.',
        lightLevel: 'dim',
        terrainType: 'dungeon',
        dominantFaction: 'delvers',
        notes: 'A rival delver route into the hill. Good for theft, ambushes, and bad assumptions.',
        connections: [
          { direction: 'west', targetIndex: 0, description: 'the cut back to the gate' },
          { direction: 'north', targetIndex: 1, description: 'a worked passage toward the barrow core' },
        ],
      },
    ],
  },
  'grim-border-kingdoms': {
    townName: 'Greybanner Ford',
    dominantFaction: 'watch',
    dangerLevel: 3,
    encounterPressure: 3,
    openingLog: [
      'The roads are still open, but only because nobody has yet managed to close them by force.',
      'Your first work begins near a battered shrine and bridge-fort where deserters, toll-takers, and frightened villagers all claim the same strip of safety.',
    ],
    rumours: [
      { text: 'A lord’s colours mean nothing on the south road now. Men wear whoever’s tabard fed them last.', truth: 'true', source: 'veteran drover' },
      { text: 'The shrine bell rings before raids, though nobody goes near enough to pull it.', truth: 'partial', source: 'washerwoman' },
      { text: 'Someone is quietly buying lamp oil, arrows, and burial cloth in bulk.', truth: 'true', source: 'quartermaster clerk' },
    ],
    lore: [
      { category: 'history', title: 'The Border Truce', content: 'No side won the last campaign. The roads merely filled with people too armed to farm and too hungry to go home.' },
      { category: 'faction', title: 'Greybanner Interests', content: 'Every authority claims to protect the ford. In practice, villagers, soldiers, raiders, and smugglers each hold a piece of it.' },
    ],
    factionOverrides: {
      locals: { name: 'ford villagers', reputation: 1, heat: 0, notes: 'The locals respect protection that works and despise speeches that do not.' },
      delvers: { name: 'camp followers and salvagers', reputation: 0, heat: 2, notes: 'Battlefield scavengers and opportunists work behind every banner.' },
      watch: { name: 'march wardens', reputation: 1, heat: 3, notes: 'The wardens are short-handed and treating every stranger as potential trouble.' },
      shadows: { name: 'deserters and toll-bandits', reputation: -2, heat: 2, notes: 'The road predators here know how to look like soldiers until the knife comes out.' },
    },
    scenes: [
      {
        name: 'Broken Shrine Causeway',
        brief: 'A saint-shrine, a bridge approach, and too many places for a levy to fail.',
        aiDescription: 'The causeway to the ford crosses churned mud between a cracked roadside shrine and the remains of old fieldworks. Prayer ribbons hang beside warning notices, and both look equally temporary. This is the kind of place where aid, extortion, and military discipline all wear the same boots.',
        lightLevel: 'normal',
        terrainType: 'ruins',
        dominantFaction: 'watch',
        notes: 'A border choke point where official control is visibly fraying.',
        connections: [
          { direction: 'north', targetIndex: 1, description: 'the bridge-fort lane' },
          { direction: 'west', targetIndex: 2, description: 'the shrine undercroft stairs' },
        ],
      },
      {
        name: 'Greybanner Bridge-Fort',
        brief: 'A half-held fortlet overlooking the ford and the toll road beyond it.',
        aiDescription: 'The bridge-fort is still manned, but barely. Spare shields lean beside empty ration crates, and watchfires are set where archers should be. Whoever holds this place controls the crossing for a night at a time, which is just enough to make it worth killing for.',
        lightLevel: 'normal',
        terrainType: 'indoor',
        dominantFaction: 'watch',
        notes: 'Authority still exists here, but only in exhausted patches.',
        connections: [
          { direction: 'south', targetIndex: 0, description: 'back to the causeway' },
          { direction: 'down', targetIndex: 2, description: 'the shrine cellar route' },
        ],
      },
      {
        name: 'Shrine Undercroft',
        brief: 'A hidden undercroft where offerings, messages, and desperate bargains have been crossing paths.',
        aiDescription: 'Beneath the broken shrine lies an undercroft that should have held relics and wine. Instead it holds contraband, blood on the flagstones, and signs that people have been using sacred space as neutral ground until recently. Something has upset even that compromise.',
        lightLevel: 'dim',
        terrainType: 'dungeon',
        dominantFaction: 'shadows',
        notes: 'A covert meeting place gone sour; deserters and smugglers know it well.',
        connections: [
          { direction: 'east', targetIndex: 0, description: 'the stair back to the shrine' },
          { direction: 'up', targetIndex: 1, description: 'a ladder toward the fort cellar' },
        ],
      },
    ],
  },
  'haunted-empire': {
    townName: 'Ninth Lantern Ward',
    dominantFaction: 'shadows',
    dangerLevel: 3,
    encounterPressure: 4,
    openingLog: [
      'In the old imperial quarter, law survives mostly as architecture and ghosts.',
      'Your first descent begins under a basilica district where tomb-cults, wardens, and ambitious scavengers have all started asking the same questions.',
    ],
    rumours: [
      { text: 'The magistrate sealed the lower crypts, which is how everyone knows there is something worth stealing down there.', truth: 'true', source: 'grave clerk' },
      { text: 'A dead advocate has been seen walking with a lantern and a writ tube.', truth: 'partial', source: 'street preacher' },
      { text: 'The old basilica vaults connect to forgotten legal archives beneath the ward.', truth: 'true', source: 'copyist' },
    ],
    lore: [
      { category: 'history', title: 'The Ninth Basilica', content: 'The basilica quarter buried saints, judges, and imperial officers together. That was considered symbolic at the time.' },
      { category: 'faction', title: 'Ward Politics', content: 'The wardens want order, tomb-cults want access, and scavengers want anything portable before either side takes full control.' },
    ],
    factionOverrides: {
      locals: { name: 'ward residents', reputation: 0, heat: 1, notes: 'The people of the quarter are used to ritual, law, and sudden disappearances.' },
      delvers: { name: 'vault scavengers', reputation: 0, heat: 2, notes: 'Professional scavengers are already looking for archive access, saint-bones, and silverwork.' },
      watch: { name: 'wardens and beadles', reputation: 0, heat: 3, notes: 'Official authority in the ward is legalistic, nervous, and one bad night from panic.' },
      shadows: { name: 'tomb-cults and revenants', reputation: -1, heat: 4, notes: 'The dead are not the only ones using the lower ways. The living cults are worse.' },
    },
    scenes: [
      {
        name: 'Basilica Steps',
        brief: 'Broad imperial steps descend toward sealed crypt access and watch-cordons.',
        aiDescription: 'The basilica façade still knows how to dominate a street. Its steps are cracked, censers hang cold, and cordons mark off sections of the stair where wardens have recently dragged something out or chased something back in. The city above is decayed but functioning; the city below is neither.',
        lightLevel: 'normal',
        terrainType: 'ruins',
        dominantFaction: 'watch',
        notes: 'Public face of an underground crisis in a haunted quarter.',
        connections: [
          { direction: 'down', targetIndex: 1, description: 'the sealed stair mouth' },
          { direction: 'east', targetIndex: 2, description: 'the archive side-entry' },
        ],
      },
      {
        name: 'Lantern Crypt',
        brief: 'A ceremonial crypt whose vigil lamps have not entirely gone out.',
        aiDescription: 'The crypt was built for solemn processions, not panic. Stone lantern niches line the passage, some still burning with chemical blue light that nobody has maintained in a century. Sarcophagi have been opened in a hurry. The question is whether the looters fled the dead, or the dead fled first.',
        lightLevel: 'dim',
        terrainType: 'dungeon',
        dominantFaction: 'shadows',
        notes: 'Undead pressure and cult movement both centre on this crypt route.',
        connections: [
          { direction: 'up', targetIndex: 0, description: 'back to the steps' },
          { direction: 'north', targetIndex: 2, description: 'an archive breach' },
        ],
      },
      {
        name: 'Judges\' Archive Breach',
        brief: 'A split in the old record vault where legal archives and tomb tunnels now intersect.',
        aiDescription: 'Shelves of rotten scroll tubes and broken seal-boxes run along one wall, while the opposite side has collapsed clean through into funerary stone. Paper dust mixes with tomb air. This is the kind of place where forgotten names and forbidden doors share a hinge.',
        lightLevel: 'dim',
        terrainType: 'dungeon',
        dominantFaction: 'delvers',
        notes: 'Information and treasure routes cross here; everyone wants something from it.',
        connections: [
          { direction: 'west', targetIndex: 0, description: 'the side-entry back to the street' },
          { direction: 'south', targetIndex: 1, description: 'the breach into the crypt' },
        ],
      },
    ],
  },
  'wildwood-mythic': {
    townName: 'Thornwell',
    dominantFaction: 'locals',
    dangerLevel: 2,
    encounterPressure: 2,
    openingLog: [
      'The wood is not hostile in a simple way. It notices, weighs, remembers, and bargains.',
      'Your first route leads through a half-kept boundary where old stones, faerie traffic, and missing hunters have begun overlapping again.',
    ],
    rumours: [
      { text: 'The moonwell path moves if you lie while walking it.', truth: 'partial', source: 'charcoal burner' },
      { text: 'The circle stones are taking offerings again, but not from the people who leave them.', truth: 'true', source: 'shepherd girl' },
      { text: 'A wounded hart has been leading armed men into bog water for three nights running.', truth: 'true', source: 'woodsman' },
    ],
    lore: [
      { category: 'history', title: 'The Boundary Stones', content: 'The forest edge was once kept by rites, songs, and regular offerings. Neglect has made every old path more conditional.' },
      { category: 'faction', title: 'Woodland Interests', content: 'Villagers want safety, circles want balance, and the hidden things of the wood want promises kept precisely.' },
    ],
    factionOverrides: {
      locals: { name: 'woodlanders and wardens', reputation: 1, heat: 0, notes: 'The people near the wood value competence, respect, and not insulting what they fear.' },
      delvers: { name: 'truffle-hunters and relic-seekers', reputation: 0, heat: 1, notes: 'A few practical opportunists work the fringes for old stone, amber, and forgotten shrines.' },
      watch: { name: 'circle keepers', reputation: 0, heat: 2, notes: 'Druids, wardens, and oath-keepers are watching for anyone who worsens the balance.' },
      shadows: { name: 'faerie hunters', reputation: -1, heat: 2, notes: 'Not everything in the wood is malicious, but the things that are never announce themselves early.' },
    },
    scenes: [
      {
        name: 'Thorn Boundary',
        brief: 'A ring of old stones and cutthorn where the safe path stops pretending to be simple.',
        aiDescription: 'The boundary stones are older than the cottages behind you and better respected than most lords. Twine offerings, antlers, and wax drippings cluster around them. The path beyond is visible, but it does not feel guaranteed. Every step in the wood seems like it should count for more than one.',
        lightLevel: 'normal',
        terrainType: 'forest',
        dominantFaction: 'locals',
        notes: 'The last reliable threshold before the wood starts negotiating.',
        connections: [
          { direction: 'north', targetIndex: 1, description: 'the moonwell track' },
          { direction: 'east', targetIndex: 2, description: 'the deer run' },
        ],
      },
      {
        name: 'Moonwell Track',
        brief: 'A root-bound track leading toward a disturbed moonwell and old circle stones.',
        aiDescription: 'The track bends around white-barked trees and shallow standing water until the air feels cooler for no honest reason. Signs of travel are present, but not all of them were made by boots. The moonwell ahead has been visited by people who wanted answers and by things that never ask twice.',
        lightLevel: 'dim',
        terrainType: 'forest',
        dominantFaction: 'watch',
        notes: 'Druidic and faerie tensions overlap here around the circle route.',
        connections: [
          { direction: 'south', targetIndex: 0, description: 'back to the boundary stones' },
          { direction: 'west', targetIndex: 2, description: 'a mossy side path' },
        ],
      },
      {
        name: 'Hollow Stag Run',
        brief: 'A game trail skirting a hollow where offerings, bones, and spoor have started mixing.',
        aiDescription: 'The deer run keeps to higher ground above a dark hollow full of fern and old roots. Offerings have been left in the crooks of trees, but some were accepted and some were torn down. Tracks say hunter, beast, and something lighter-footed than either are all using the same corridor.',
        lightLevel: 'dim',
        terrainType: 'forest',
        dominantFaction: 'shadows',
        notes: 'The wood’s predatory side is testing the boundary here.',
        connections: [
          { direction: 'west', targetIndex: 0, description: 'back to the thorn boundary' },
          { direction: 'north', targetIndex: 1, description: 'toward the moonwell' },
        ],
      },
    ],
  },
  'sword-and-sorcery-city-states': {
    townName: 'Saltglass Port',
    dominantFaction: 'shadows',
    dangerLevel: 3,
    encounterPressure: 3,
    openingLog: [
      'In the city-states, everybody knows where the money is. The tension comes from who thinks they deserve it first.',
      'Your opening run begins in a port quarter where temple vault rumours, gang muscle, and respectable patrons are all pointing toward the same hole in the earth.',
    ],
    rumours: [
      { text: 'The idol under the wine district is red stone, old enough to make priests nervous and thieves wealthy.', truth: 'partial', source: 'dockside bravo' },
      { text: 'A smuggler crew found a dry route in through a cistern but lost it after a knife dispute.', truth: 'true', source: 'boatman' },
      { text: 'One magistrate is quietly financing expeditions and buying back only the written records.', truth: 'true', source: 'scribe for hire' },
    ],
    lore: [
      { category: 'history', title: 'The Saltglass Vaults', content: 'The quarter has been rebuilt on top of older temples twice. Every cellar owner assumes there is money under someone else’s floor.' },
      { category: 'faction', title: 'Port Interests', content: 'Smugglers, patrons, cults, and mercenaries all want deniable access to the lower ways before the magistrates seal them.' },
    ],
    factionOverrides: {
      locals: { name: 'port traders', reputation: 0, heat: 1, notes: 'The quarter respects profit, nerve, and people who do not attract the wrong kind of guard.' },
      delvers: { name: 'treasure crews', reputation: 0, heat: 3, notes: 'Other crews are already racing for whatever lies below the quarter.' },
      watch: { name: 'harbour guards', reputation: 0, heat: 2, notes: 'The guards mostly care who causes visible trouble and who can pay for it afterward.' },
      shadows: { name: 'cult muscle and smugglers', reputation: -1, heat: 3, notes: 'The under-city routes are already being used by people with knives and reasons.' },
    },
    scenes: [
      {
        name: 'Brass Lantern Alley',
        brief: 'A vice-ridden alley behind taverns and counting houses where everyone is pretending not to watch everyone else.',
        aiDescription: 'The alley is warm with kitchen smoke, lamp oil, and bad intentions. Drunks, couriers, and knife-hands all move as if they belong here, which most of them probably do. Beneath the noise runs a more interesting fact: somebody recently reopened an old under-stairs entry and then tried to hide it under freight crates.',
        lightLevel: 'normal',
        terrainType: 'town',
        dominantFaction: 'shadows',
        notes: 'Street-level access point where smugglers and cult agents cross paths.',
        connections: [
          { direction: 'down', targetIndex: 1, description: 'the cellar stair' },
          { direction: 'east', targetIndex: 2, description: 'the old cistern route' },
        ],
      },
      {
        name: 'Wine Cellar Vault',
        brief: 'A merchant cellar punched through into older sacred masonry.',
        aiDescription: 'Rack after rack of cheap wine ends where the merchant’s wall should be. Someone has broken through into older dressed stone bearing worn reliefs and soot-black niches. The air below smells like stale incense, wet copper, and opportunities nobody intends to share peacefully.',
        lightLevel: 'dim',
        terrainType: 'dungeon',
        dominantFaction: 'delvers',
        notes: 'An illegal dig turned accidental temple access and immediate competition.',
        connections: [
          { direction: 'up', targetIndex: 0, description: 'back to the alley' },
          { direction: 'south', targetIndex: 2, description: 'the cistern breach' },
        ],
      },
      {
        name: 'Salt Cistern Galleries',
        brief: 'A dry cistern loop now being used as a covert approach to deeper vaults.',
        aiDescription: 'The cistern galleries are broad enough for contraband traffic and narrow enough for murder. Old salt crust marks the walls above your head, and ropes, hooks, and chalk arrows show that crews have been feeling their way through recently. Whatever lies deeper has already convinced smarter people than you to come armed.',
        lightLevel: 'dim',
        terrainType: 'dungeon',
        dominantFaction: 'shadows',
        notes: 'Smuggler infrastructure turned heist corridor toward the deeper temple route.',
        connections: [
          { direction: 'west', targetIndex: 0, description: 'the alley ascent' },
          { direction: 'north', targetIndex: 1, description: 'the wine-cellar breach' },
        ],
      },
    ],
  },
};

export function seedCampaignStarterPack(params: {
  db: Database;
  campaignId: string;
  startSceneId: string;
  settingId: string;
  campaignName: string;
}) {
  const { db, campaignId, startSceneId, settingId, campaignName } = params;
  const pack = STARTER_PACKS[settingId] || STARTER_PACKS['classic-fantasy-frontier'];
  const sceneIds = pack.scenes.map((_scene, index) => index === 0 ? startSceneId : uuid());

  run(db,
    'UPDATE campaigns SET town_name = ?, danger_level = ?, dominant_faction = ? WHERE id = ?',
    [pack.townName, pack.dangerLevel, pack.dominantFaction, campaignId]);

  for (const [index, scene] of pack.scenes.entries()) {
    const sceneId = sceneIds[index];
    const connections = scene.connections.map((entry) => ({
      direction: entry.direction,
      targetSceneId: sceneIds[entry.targetIndex],
      description: entry.description,
    }));

    if (index === 0) {
      run(db, `
        UPDATE scenes
        SET name = ?, brief = ?, ai_description = ?, light_level = ?, terrain_type = ?, connections = ?, visited = 1, notes = ?, dominant_faction = ?
        WHERE id = ?
      `, [
        scene.name,
        scene.brief,
        scene.aiDescription,
        scene.lightLevel,
        scene.terrainType,
        JSON.stringify(connections),
        scene.notes,
        scene.dominantFaction,
        sceneId,
      ]);
    } else {
      run(db, `
        INSERT INTO scenes (id, campaign_id, name, brief, ai_description, light_level, terrain_type, connections, visited, notes, dominant_faction)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      `, [
        sceneId,
        campaignId,
        scene.name,
        scene.brief,
        scene.aiDescription,
        scene.lightLevel,
        scene.terrainType,
        JSON.stringify(connections),
        scene.notes,
        scene.dominantFaction,
      ]);
    }
  }

  const state = getCampaignState(db, campaignId);
  state.encounterPressure = pack.encounterPressure;
  for (const [key, override] of Object.entries(pack.factionOverrides)) {
    if (!override) continue;
    state.factions[key] = {
      name: override.name,
      reputation: override.reputation,
      heat: override.heat,
      notes: override.notes,
    };
  }

  noteCampaignEvent(state, `${campaignName} begins at ${pack.scenes[0].name}.`);
  for (const line of pack.openingLog) {
    noteCampaignEvent(state, line);
  }
  saveCampaignState(db, campaignId, state);

  for (const line of pack.openingLog) {
    run(db,
      'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, 1, ?, ?, ?)',
      [uuid(), campaignId, 'narration', 'DM', line]);
  }
  run(db,
    'INSERT INTO game_log (id, campaign_id, session_number, type, actor, content) VALUES (?, ?, 1, ?, ?, ?)',
    [uuid(), campaignId, 'scene_enter', 'DM', pack.scenes[0].aiDescription]);

  for (const rumour of pack.rumours) {
    run(db,
      'INSERT INTO campaign_rumours (id, campaign_id, text, truth_level, discovered, source) VALUES (?, ?, ?, ?, 0, ?)',
      [uuid(), campaignId, rumour.text, rumour.truth, rumour.source]);
  }

  for (const lore of pack.lore) {
    run(db,
      'INSERT INTO world_lore (id, campaign_id, category, title, content) VALUES (?, ?, ?, ?, ?)',
      [uuid(), campaignId, lore.category, lore.title, lore.content]);
  }
}
