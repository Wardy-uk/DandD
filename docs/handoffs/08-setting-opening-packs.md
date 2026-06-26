# Handoff 08: Setting Opening Packs

## What shipped
- Replaced the generic blank campaign opener with deterministic setting-specific starter packs.
- Each setting now seeds:
  - a named starting town
  - a dominant campaign faction
  - a danger level and opening encounter pressure
  - a three-scene opening network with bespoke names, descriptions, terrain, and faction ownership
  - initial rumours
  - initial lore entries
  - opening narration beats in the game log
- Added persistent `dominant_faction` support on both campaigns and scenes.
- Updated faction-sensitive flow so:
  - parley uses the current scene’s faction where available
  - scene-entry faction pressure uses the scene’s faction before falling back to campaign default

## Files changed
- `src/server/db/schema.ts`
- `src/server/game/starterPacks.ts`
- `src/server/routes/campaign.ts`
- `src/server/socket.ts`

## Player-facing result
- Choosing a setting now materially changes the first session.
- New campaigns begin in different places with different political texture, threat posture, and implied play patterns.
- The first few decisions should feel more authored and more table-like because the dungeon entrance, rumour field, and local pressure are all shaped by code before any nightly AI growth ever touches them.
- Talking your way through a scene now better reflects where you actually are, not just a campaign-wide default faction.

## Build status
- `npm run build:server` passed
- `npm run build` passed

## Suggested future continuation
- Add setting-specific first contracts and first recruitable NPCs.
- Seed one guaranteed early mechanical set-piece per setting:
  - frontier ambush route
  - border hostage dilemma
  - imperial undead legal guardian
  - faerie bargain crossing
  - city-state heist clock
- Let nightly growth extend the seeded premise instead of growing from a neutral baseline.
