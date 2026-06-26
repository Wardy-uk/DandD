# Handoff 16: Heat Consequences, Rival Encounters, Companion Events

**Commit:** c23f0be  
**Date:** 2026-06-26

## What was built

### Heat Consequences
- Locals heat ≥3 → 25% surcharge on market and healer; ≥5 → 50%
- Watch heat ≥4 → garrison locked; ≥3 → being watched flag
- Shadows heat ≥3 → shadows unreliable flag
- `heatConsequences` object returned in town GET response
- Warning banners in market tab and healer tab; garrison locked banner in garrison tab
- `buySupplies` and `healInjuries` in `town.ts` read the heat multiplier from the calling route

### Rival Encounters
- `game:rival_encounter` socket event emitted when rivals detected in current scene (after `checkRivalPresence`)
- `game:rival_resolve` handler in `socket.ts` — accepts fight/parley/intimidate/ignore
- Calls existing `resolveRivalClash` from `rivals.ts`
- Emits `game:rival_resolved` + narration + campaign state refresh on completion
- Encounter panel in `GameView.tsx` with 4 choices, clears on resolution
- All three events (`rival_encounter`, `rival_resolve`, `rival_resolved`) added to shared socket types in `types.ts`

### Companion Relationship Events
- Server computes `companionEvents` on town GET — triggers: tension ≥4, morale ≤-1, bond ≥3 (once via `bondEventSeen`)
- `POST /:campaignId/companion/event` route handles choices: listen/dismiss (tension), rally/wait (morale_crisis), acknowledge (bond_milestone)
- Bond milestone sets `bondEventSeen: true` in NPC `relationship_state` JSON to prevent repeat
- Event cards in taproom tab with `dismissedEvents` Set for client-side dismiss without POST

## Files changed
- `src/shared/types.ts` — added `game:rival_encounter`, `game:rival_resolved` to ServerToClientEvents; `game:rival_resolve` to ClientToServerEvents
- `src/server/game/town.ts` — heat multipliers in `getHealingQuote`, `buySupplies`, `healInjuries`
- `src/server/routes/town.ts` — `heatConsequences` + `companionEvents` computed and returned in GET; heal POST passes `healMult`; new companion/event POST route
- `src/server/socket.ts` — `game:rival_encounter` emit after `checkRivalPresence`; `game:rival_resolve` handler
- `src/client/components/GameView.tsx` — rival encounter panel + socket listeners; `handleRivalChoice`
- `src/client/components/TownView.tsx` — `heatConsequences` type, companion events UI in taproom, heat warnings in market/healer tabs, garrison locked banner
