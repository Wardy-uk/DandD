export const CAMPAIGN_START_MODES = [
  {
    id: 'solo',
    name: 'Solo Delver',
    summary: 'Start alone and build your company in play.',
  },
  {
    id: 'party',
    name: 'Starter Company',
    summary: 'Begin with a small NPC adventuring company already at your side.',
  },
] as const;

export type CampaignStartMode = typeof CAMPAIGN_START_MODES[number]['id'];

export const DEFAULT_CAMPAIGN_START_MODE: CampaignStartMode = 'solo';

export function isCampaignStartMode(value: string | undefined | null): value is CampaignStartMode {
  return CAMPAIGN_START_MODES.some((mode) => mode.id === value);
}
