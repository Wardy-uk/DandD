# Handoff 14 — Contract Expiry

## What shipped

Contracts taken into the dungeon now auto-expire if they sit uncompleted for too long. The mechanism is turn-based, cheap to check, and surfaces cleanly in the UI.

---

## How it works

### Turn stamp on take
`/contract/take` now records the current `campaigns.exploration_turn` as `takenAtTurn` on the contract JSON. This is the single source of truth for the expiry clock.

### Expiry detection on town GET
Every `GET /api/town/:campaignId` call now runs `expireStaleContracts(db, campaignId)` before building the response. It:
1. Reads `exploration_turn` from `campaigns`
2. Loops taken, incomplete, unclaimed, unexpired contracts with a `takenAtTurn`
3. Expires any where `currentTurn - takenAtTurn >= 15`
4. Sets `expiredAt` timestamp on the contract
5. Applies `shiftFactionStanding(..., { reputation: -1 })` for the relevant faction
6. Returns narration lines — the route logs them and emits `game:narration` via socket

The 15-turn threshold (`CONTRACT_EXPIRY_TURNS`) is a constant in `game/town.ts` — easy to tune.

### Faction-specific expiry narrations
Each faction has its own tone:
- **watch**: Cold, administrative — "it will be noted"
- **locals**: Disappointed, assumes the worst
- **shadows**: Terse, transactional — "alternative arrangements found"
- **delvers**: Guild-record language — "the failure is marked"

---

## Files changed

| File | Change |
|------|--------|
| `src/server/game/town.ts` | Added `expiredAt`, `takenAtTurn` to `TownContract` interface; added `expireStaleContracts()` export |
| `src/server/routes/town.ts` | Imported `expireStaleContracts`; called it on GET; stamped `takenAtTurn` on `/contract/take` |
| `src/client/components/TownView.tsx` | Added `expiredAt` to `Contract` interface; Expired badge (red); muted card style; excluded from active contracts summary |

---

## UI behaviour

- Expired contracts show a red **Expired** badge in place of the action button
- Card border/bg is muted (`opacity-70`, red tint) to signal inactivity
- The "Active contracts" summary footer now filters out expired and claimed contracts
- Expiry narrations arrive via `game:narration` socket so they appear in the log stream immediately when the player opens town

---

## Edge cases / design decisions

- **Legacy contracts** (no `takenAtTurn`) are ignored — they'll never expire. This is intentional to avoid surprising existing campaigns.
- **Completed but unclaimed** contracts don't expire — `completedAt` is set, so the check skips them. Players can still claim after the fact.
- **Rep penalty is immediate** — the faction standing drops on first town visit after expiry, even if the player doesn't notice the narration.
- **Turn clock only ticks in the dungeon** (`adventure.ts` increments `exploration_turn` on every `resolveRichExploration`). Town time doesn't count. 15 exploration turns ≈ several dungeon rooms, which feels like a meaningful but not punishing window.

---

## Suggested next features

- **Rival party contracts** — rivals can pick up the same contracts from the board; if they complete it first, the contract disappears and the party gets a heat bump
- **Faction scene benefits** — rep-gated benefits already exist in `factions.ts`; surface them in the UI (safe passage, discounts, scout intel)
- **Contract cooldown** — after expiry, that faction won't post new contracts for 2-3 town visits (grace period before they forgive)
