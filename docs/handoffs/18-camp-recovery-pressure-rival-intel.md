# Handoff 18: Camp HP Recovery, Pressure Events, Rival Intel Sharing

**Commit:** d696257  
**Date:** 2026-06-26

## What was built

### Camp HP Recovery
- When "make camp" / "rest" fires in a scene with `safeCamp: true`, characters and joined companions recover HP
- Recovery amount based on camp quality: fortified = 50% missing HP, good = 33%, adequate = 15%, poor = 0
- HP restore added after `makeCamp()` call in `socket.ts`, queries `scene_state` for safeCamp flag
- Narration emitted per character; companions silently recover
- `scene_state` safe-camp status set by the existing secure/fortify/fallbackPoint adventure logic

### Pressure Spike Events
- Added `lastPressureNarration: number` to `DelveState` interface in `campaignState.ts`
- `tickDelveConditions` now fires a narration note when `encounterPressure` crosses bands 5, 7, and 9
- Each band fires once (tracked by `lastPressureNarration`) and resets when pressure drops back
- Narrations escalate: atmospheric hint (5) → active threat (7) → critical (9)
- Note: `tickDelveConditions` runs every exploration action, so these are guaranteed to surface

### Rival Intel Sharing
- Added `'request_intel'` to `resolveRivalClash` clash type union in `rivals.ts`
- Allies/grudging allies share names of scenes they've looted (`lootedScenes` mapped to scene names via DB lookup)
- Non-allies refuse with a dismissive line
- `socket.ts` `game:rival_resolve` handler now accepts `request_intel` as valid choice
- `GameView.tsx` rival encounter panel conditionally shows "Request intel" button when `rivalRelation === 'ally' || 'grudging_ally'`

## Files changed
- `src/server/game/campaignState.ts` — added `lastPressureNarration` to `DelveState`; pressure events in `tickDelveConditions`; default value in state init
- `src/server/game/rivals.ts` — `request_intel` clash type + handler in `resolveRivalClash`
- `src/server/socket.ts` — camp HP recovery after `makeCamp`; `request_intel` in valid choices list
- `src/client/components/GameView.tsx` — conditional "Request intel" button in rival encounter panel
