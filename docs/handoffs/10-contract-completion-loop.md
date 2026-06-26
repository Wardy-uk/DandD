# Handoff 10: Contract Completion Loop

## What shipped
- Contracts now carry deterministic objectives instead of being flavour-only notices.
- Added measurable contract objective types:
  - discovered sites
  - cleared scenes
  - fallback routes marked
  - treasure leads secured
  - lore proofs gathered
  - major revelations
- Town now evaluates contract progress against live campaign state and scene state.
- Completed contracts can now be claimed for GP and XP through a dedicated route.
- Claiming a contract:
  - pays the active character
  - grants XP
  - records campaign history
  - improves faction reputation with the issuing side
- Starter contracts now seed their own objective metadata instead of only title/description.
- Town UI now shows:
  - progress text
  - progress bar
  - `Taken`, `Complete`, and `Paid` states
  - a `Claim` button when the contract is ready

## Files changed
- `src/server/game/town.ts`
- `src/server/game/starterPacks.ts`
- `src/server/routes/town.ts`
- `src/client/components/TownView.tsx`

## Player-facing result
- The first session now has a proper loop:
  - take a job
  - delve with purpose
  - satisfy a measurable condition
  - come back and get paid
- Contracts now help structure play instead of only decorating it.
- The board tells the player why a contract is or is not ready, which makes the game feel much more like a referee tracking real table consequences.

## Build status
- `npm run build:server` passed
- `npm run build` passed

## Suggested future continuation
- Add contract objective types tied to specific scenes, enemy groups, or named relics.
- Surface contract progress in the dungeon UI, not just in town.
- Mark fulfilled contracts on the campaign map and chronicle.
- Let factions generate follow-up contracts based on how the previous one resolved.
