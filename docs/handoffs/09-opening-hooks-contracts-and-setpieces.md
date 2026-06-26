# Handoff 09: Opening Hooks, Contracts, and Set-Pieces

## What shipped
- Added persistent `setting_id` to campaigns so deterministic setting behaviour no longer depends on display text.
- Extended starter packs to seed:
  - first-town contract boards
  - setting-specific hire prospects
  - guaranteed once-only early set-piece reveals tied to specific opening scenes
- Added scene-aware starter set-piece resolution:
  - triggers only once
  - writes to scene state
  - updates pressure and faction posture
  - records a lore revelation
  - logs narration for the table immediately
- Upgraded town surfaces to expose the new hooks:
  - opening contracts are visibly marked
  - setting-specific prospects now surface stronger hooks in the town UI

## Files changed
- `src/server/db/schema.ts`
- `src/server/routes/campaign.ts`
- `src/server/routes/town.ts`
- `src/server/socket.ts`
- `src/server/game/starterPacks.ts`
- `src/server/game/town.ts`
- `src/client/components/TownView.tsx`

## Player-facing result
- A fresh campaign now starts with a more pointed “what do we do first?” loop instead of just broad atmosphere.
- The first job board is relevant to the chosen setting and pushes toward the opening conflict.
- The first town recruits feel more like people with useful local leverage rather than generic mercenaries.
- Early scene exploration now contains a deliberate reveal or escalation beat, so the first delve should spike harder and sooner.

## Build status
- `npm run build:server` passed
- `npm run build` passed

## Suggested future continuation
- Make opening contracts mechanically completable and pay out against discovered scenes, kills, relic recovery, or lore proof.
- Add first-session NPC anchors directly into the opening scenes instead of only town/tavern loops.
- Turn starter set-pieces into branching clocks with multiple outcomes instead of single reveals.
- Begin seeding small bespoke enemy groups per setting so opening encounters are as distinct as the contracts are.
