export interface CampaignSettingOption {
  id: string;
  name: string;
  summary: string;
  tone: string;
}

export const CAMPAIGN_SETTING_OPTIONS: CampaignSettingOption[] = [
  {
    id: 'classic-fantasy-frontier',
    name: 'Classic Fantasy Frontier',
    summary: 'Border keeps, ruins, goblin pressure, treasure maps, and practical dungeon delving.',
    tone: 'Adventurous, perilous, and grounded in old-school exploration.',
  },
  {
    id: 'grim-border-kingdoms',
    name: 'Grim Border Kingdoms',
    summary: 'Feuding lords, hungry roads, broken shrines, and opportunists circling every stronghold.',
    tone: 'Low-trust, war-torn, and heavy with hard choices.',
  },
  {
    id: 'haunted-empire',
    name: 'Haunted Empire',
    summary: 'Decaying imperial cities, tomb-cults, ancient law, ghosts, and power buried under ritual.',
    tone: 'Gothic, political, and rich in secrets with undead menace.',
  },
  {
    id: 'wildwood-mythic',
    name: 'Wildwood Mythic',
    summary: 'Faerie bargains, druid circles, beast trails, old stones, and forgotten forest sanctuaries.',
    tone: 'Mythic, uncanny, and strong on wonder mixed with danger.',
  },
  {
    id: 'sword-and-sorcery-city-states',
    name: 'Sword and Sorcery City-States',
    summary: 'Treasure hunters, vice-ridden ports, doomed temples, mercenary intrigue, and fast violence.',
    tone: 'Pulp, sharp-edged, and full of ambition and betrayal.',
  },
];

export const DEFAULT_CAMPAIGN_SETTING_ID = CAMPAIGN_SETTING_OPTIONS[0].id;

export function findCampaignSettingOption(settingId: string | undefined | null) {
  return CAMPAIGN_SETTING_OPTIONS.find((option) => option.id === settingId) || null;
}
