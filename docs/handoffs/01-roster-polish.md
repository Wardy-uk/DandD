# Handoff 01: Roster Polish

## What shipped
- Added persistent lineage metadata for characters:
  - `root_character_id`
  - `root_character_name`
  - `root_campaign_id`
  - `source_character_id`
  - `source_campaign_id`
- New characters now record themselves as the root build.
- Imported characters now preserve their root hero and mark the campaign they were copied from.
- `/api/characters/roster` now returns:
  - root hero details
  - source campaign details
  - `isCampaignCopy`
- Added a dedicated `My Adventurers` stable screen.
- Campaign list now exposes a direct `My Adventurers` button.
- Character import cards in campaign entry now show whether a roster entry is:
  - `Original Build`
  - `Campaign Copy`

## Files changed
- `src/server/db/schema.ts`
- `src/server/routes/character.ts`
- `src/client/App.tsx`
- `src/client/components/CampaignList.tsx`
- `src/client/components/CharacterCreate.tsx`
- `src/client/components/AdventurerRoster.tsx`

## Player-facing result
- Characters now feel like a persistent stable of heroes rather than isolated one-off records.
- Campaign copies are clearly marked.
- The stable view shows the original hero line plus all campaign branches derived from it.

## Build status
- `npm run build:server` passed
- `npm run build` passed

## Recommended next step
- Move to `02 NPC social depth`
- Focus on:
  - companion-to-companion affinity/rivalry
  - breakup / friendship / loyalty fracture beats
  - desertion and reconciliation thresholds
  - stronger emotional consequences for risky leadership
