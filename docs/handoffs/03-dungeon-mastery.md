# Handoff 03: Dungeon Mastery

## What shipped
- Expanded persistent scene-state handling with:
  - `trapStudied`
  - `lockStudied`
  - `obstaclePrepared`
  - `ropeRigged`
- Added new procedural prep actions:
  - study a trap
  - study a lock
  - prepare to force an obstacle
- Those prep states now materially improve later checks:
  - studying locks improves lockpicking
  - studying traps improves disarming
  - preparing force improves obstacle clearing
  - rigged rope helps with hazard handling
- Rope rigging now consumes an actual `Rope (50 ft)` from inventory and leaves a permanent scene advantage behind.
- Failed trap disarm attempts after proper prep no longer always spring immediately; preparation can turn catastrophe into a live but controlled problem.

## Files changed
- `src/server/game/adventure.ts`

## Player-facing result
- Dungeon play now rewards procedure.
- The correct approach is no longer just "roll the same thing again."
- Players can:
  - study first
  - set up properly
  - spend real gear to change the room
  - trade resources for safer execution

## Build status
- `npm run build:server` passed
- `npm run build` passed

## Recommended next step
- Move to `04 map and expedition payoff`
- Focus on:
  - stronger map annotations
  - expedition route memory
  - visible fallback/camp/hazard route markers
  - better end-of-expedition summary and payoff
