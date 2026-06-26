# Handoff 04: Map And Expedition Payoff

## What shipped
- Map intel now includes summary stats:
  - discovered sites
  - fallback points
  - camp-ready rooms
  - hazard marks
  - treasure marks
  - secret routes
- Map room state now surfaces more procedural information:
  - trap studied
  - lock studied
  - obstacle prepared
  - rope rigged
- `CampaignMap` now shows:
  - expedition stat pills at the top
  - richer room markers for studied/rigged states
  - stronger current-room operational read
- Town data now includes an `expeditionSummary`.
- `TownView` now renders a `Last Expedition` summary card so returning to town has a clearer sense of payoff.

## Files changed
- `src/server/game/mapIntel.ts`
- `src/server/routes/town.ts`
- `src/client/components/CampaignMap.tsx`
- `src/client/components/TownView.tsx`

## Player-facing result
- The map now remembers more than just where rooms are.
- It now reflects what kind of work was done there.
- Returning to town gives the player a compact read of what the delve actually accomplished instead of dropping them straight into services.

## Build status
- `npm run build:server` passed
- `npm run build` passed

## Recommended next step
- Move to `05 roster-class depth`
- Focus on:
  - paladin pressure and vows
  - ranger tracking / intent edge
  - thief infiltration advantages
  - caster identity through spells and class actions
