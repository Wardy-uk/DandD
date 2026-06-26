export interface CampaignSettingOption {
  id: string;
  name: string;
  summary: string;
  tone: string;
  suggestedNames: string[];
  openingSituation: string;
  gameplayFocus: string[];
  signatureThreats: string[];
  treasureStyle: string[];
  partyFit: string[];
}

export const CAMPAIGN_SETTING_OPTIONS: CampaignSettingOption[] = [
  {
    id: 'classic-fantasy-frontier',
    name: 'Classic Fantasy Frontier',
    summary: 'Border keeps, ruins, goblin pressure, treasure maps, and practical dungeon delving.',
    tone: 'Adventurous, perilous, and grounded in old-school exploration.',
    suggestedNames: ['The Black Barrow March', 'Keep on the Cold Road', 'Ashfall on the Border'],
    openingSituation: 'A thin line of keeps and trade roads is failing. Old barrows are waking up, raiders smell weakness, and the next good party could decide whether the frontier hardens or burns.',
    gameplayFocus: ['hex-crawl exploration', 'dungeon pressure', 'hirelings and marching order'],
    signatureThreats: ['goblin warbands', 'ruined barrow cults', 'hungry roadside beasts'],
    treasureStyle: ['buried caches', 'map-led treasure', 'functional dungeon gear'],
    partyFit: ['paladin', 'ranger', 'fighter', 'thief'],
  },
  {
    id: 'grim-border-kingdoms',
    name: 'Grim Border Kingdoms',
    summary: 'Feuding lords, hungry roads, broken shrines, and opportunists circling every stronghold.',
    tone: 'Low-trust, war-torn, and heavy with hard choices.',
    suggestedNames: ['The Broken Oath Roads', 'War Under Grey Banners', 'The Last Quiet Keep'],
    openingSituation: 'The realm is not at peace, merely exhausted. Lords hire adventurers to do ugly work, villages barter loyalty for protection, and every victory creates a new enemy.',
    gameplayFocus: ['faction pressure', 'escorts and relief missions', 'hard resource tradeoffs'],
    signatureThreats: ['mercenary deserters', 'bandit captains', 'corrupted shrine-keepers'],
    treasureStyle: ['war spoils', 'ransoms', 'oath-bound relics'],
    partyFit: ['paladin', 'cleric', 'fighter', 'bard'],
  },
  {
    id: 'haunted-empire',
    name: 'Haunted Empire',
    summary: 'Decaying imperial cities, tomb-cults, ancient law, ghosts, and power buried under ritual.',
    tone: 'Gothic, political, and rich in secrets with undead menace.',
    suggestedNames: ['Ashes of the Ninth Basilica', 'The Ghost Court Below', 'Empire of Open Tombs'],
    openingSituation: 'In the shadow of dead emperors, every district serves a patron, every tomb hides a claimant, and the city remembers debts better than it remembers mercy.',
    gameplayFocus: ['urban intrigue', 'undead delves', 'ritual secrets and obligations'],
    signatureThreats: ['restless magistrates', 'tomb-cults', 'imperial revenants'],
    treasureStyle: ['funerary gold', 'forbidden libraries', 'saint-bones and legal seals'],
    partyFit: ['cleric', 'paladin', 'mage', 'thief'],
  },
  {
    id: 'wildwood-mythic',
    name: 'Wildwood Mythic',
    summary: 'Faerie bargains, druid circles, beast trails, old stones, and forgotten forest sanctuaries.',
    tone: 'Mythic, uncanny, and strong on wonder mixed with danger.',
    suggestedNames: ['The Briar Crown Paths', 'Moonwell Under Thorn', 'Song of the Green Threshold'],
    openingSituation: 'The wood is older than the roads around it. Circles are failing, old pacts are going sour, and every path offers either revelation or enchantment at a price.',
    gameplayFocus: ['mystery travel', 'omens and bargains', 'terrain and survival play'],
    signatureThreats: ['faerie hunters', 'angered beast-spirits', 'thorn-bound guardians'],
    treasureStyle: ['living relics', 'oath-gifts', 'enchanted wayfinding tools'],
    partyFit: ['druid', 'ranger', 'bard', 'thief'],
  },
  {
    id: 'sword-and-sorcery-city-states',
    name: 'Sword and Sorcery City-States',
    summary: 'Treasure hunters, vice-ridden ports, doomed temples, mercenary intrigue, and fast violence.',
    tone: 'Pulp, sharp-edged, and full of ambition and betrayal.',
    suggestedNames: ['Knives of the Brass Port', 'The Red Idol Circuit', 'Mercy Dies in Saltglass'],
    openingSituation: 'Ports glitter, alleys stink, and everyone is one score away from greatness or a knife in the ribs. Temples crack open beneath wine shops, and every captain wants deniable talent.',
    gameplayFocus: ['fast missions', 'heists and escapes', 'glory versus greed'],
    signatureThreats: ['cult enforcers', 'slavers', 'temple guardians and assassins'],
    treasureStyle: ['idols and gems', 'smuggled contraband', 'cursed luxury gear'],
    partyFit: ['thief', 'bard', 'fighter', 'mage'],
  },
];

export const DEFAULT_CAMPAIGN_SETTING_ID = CAMPAIGN_SETTING_OPTIONS[0].id;

export function findCampaignSettingOption(settingId: string | undefined | null) {
  return CAMPAIGN_SETTING_OPTIONS.find((option) => option.id === settingId) || null;
}
