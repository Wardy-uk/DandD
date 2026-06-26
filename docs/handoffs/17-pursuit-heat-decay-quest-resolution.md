# Handoff 17: Rival Pursuit Mode, Heat Decay, Companion Quest Resolution

**Commit:** 8075ffc  
**Date:** 2026-06-26

## What was built

### Rival Pursuit Mode
- Hated rivals (`relation === 'hated'` && `clashCount >= 3`) now enter pursuit mode in `tickRivals`
- Instead of moving to unvisited scenes, they always move to `currentSceneId` (wherever the player is)
- Generates a distinct narration note when they first enter the scene in pursuit
- `checkRivalPresence` has a special encounter note for hated rivals — more menacing than neutral/hostile
- No new DB fields — pursuit derived from existing `relation` + `clashCount`

### Heat Decay
- New export `applyHeatCool` in `src/server/game/town.ts`
- Two methods:
  - `shadows_contact` — costs 20 GP, requires shadows rep ≥ 0, reduces locals and watch heat by 1
  - `lay_low` — free, reduces all faction heat by 1
- New route `POST /:campaignId/heat/cool`
- Watch faction contracts now auto-reduce watch heat by 1 on claim (`contract/claim` route)
- Heat cooling buttons appear inline in the existing Heat panel in the garrison tab

### Companion Personal Quest Resolution
- New route `POST /:campaignId/companion/resolve-quest`
- Sets `personalQuestResolved = true` in NPC `relationship_state` JSON
- Gives +1 loyalty and +1 bond on resolution
- Emits narration + `companions_update` socket event
- `TownCompanionCard` now accepts `onResolveQuest` prop — shows "Mark quest resolved" button in expanded view when quest is unresolved
- Resolved quests show as "Quest resolved: [title]" in green
- `handleResolveQuest` wired in taproom "With you" section for joined companions

## Files changed
- `src/server/game/rivals.ts` — pursuit mode in `tickRivals`; enhanced hated-rival note in `checkRivalPresence`
- `src/server/game/town.ts` — added `applyHeatCool` export
- `src/server/routes/town.ts` — imported `applyHeatCool`; Watch contract heat reduction on claim; new `heat/cool` and `companion/resolve-quest` POST routes
- `src/client/components/TownView.tsx` — `handleHeatCool` and `handleResolveQuest` handlers; heat cooling buttons in garrison heat panel; `TownCompanionCard` quest resolve prop and display
