# Handoff 05: Roster-Class Depth

## What shipped
- Added stronger deterministic class-shaped actions:
  - `lay on hands`
  - `track / read the trail`
  - `check supplies`
  - `study spellbook`
- Paladin:
  - can now use `lay on hands` in the field
  - heal scales with level
  - daily use tracked via condition flag
  - resets on return to town / day advance
- Ranger / scout play:
  - tracking now produces actionable trail intel
  - can reduce encounter pressure
  - can sometimes imply a quieter route
- Thief / expedition logistics feel:
  - `check supplies` now gives a direct delve-read of the consumables that actually matter
- Mage:
  - `study spellbook` can re-ready a usable memorised spell when the wizard has gone dry
  - otherwise gives a clean read of what is currently prepared

## Files changed
- `src/server/game/adventure.ts`
- `src/server/game/town.ts`

## Player-facing result
- The class buttons and prompts now cash out into table-feeling actions.
- Paladins feel like holy warriors rather than just fighters with a label.
- Rangers feel like fieldcraft specialists.
- Mages can interact with the spellbook as a real tool.
- The delve is becoming more identity-rich without sliding back into slow AI dependence.

## Build status
- `npm run build:server` passed
- `npm run build` passed

## Suggested future continuation
- Expand class depth further with:
  - paladin vow pressure and fallen-state risk
  - ranger quarry/favoured-foe memory
  - thief infiltration and scouting phases
  - cleric/druid stronger ritual and camp-shaping actions
  - mage spell acquisition, scribing, and memorisation choices in UI
