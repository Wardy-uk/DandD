# Handoff 13 — Faction Rep Visibility + Contract Board Cap

**Commit:** `b15e7c4`
**Date:** 2026-06-26

## What shipped

Two small changes to make the contract loop feel less disjointed.

### 1. Faction rep surfaced at contract claim

`claimContractReward()` (`src/server/game/town.ts`) already called `shiftFactionStanding` to bump faction reputation by +1 when a contract was settled — but the narration never mentioned it. Players had no feedback that their actions were building faction standing.

Added private helper `factionRepNote(factionKey, newRep)` that returns a one-line contextual note based on which faction and the new rep tier:

| Faction | Rep 1 | Rep 2 | Rep 3+ |
|---------|-------|-------|--------|
| watch | "The garrison notes your name." | "Word reaches the duty officer. Your reliability is on record now." | "The captain herself mentions you at briefing." |
| locals | "The locals are starting to know who you are." | "Word gets around. Your name is mentioned in the right company." | "People in this town are paying attention to what you do." |
| shadows | "The right people take note." | "Your arrangement deepens. Word passes through channels you'll never see." | "Certain conversations are happening about you. They are cautiously favourable." |
| delvers | "Your name goes up on the cartographers' board." | "The guild acknowledges the quality of your work." | "Senior cartographers start asking about your methods." |

The note is appended to the claim narration: `"...Word spreads quickly enough to count for another N XP. [rep note]"`

### 2. Contract board cap

In `POST /town/:campaignId/contract/claim` (`src/server/routes/town.ts`), when a follow-up contract is pushed onto the board, the unclaimed count is checked against `MAX_BOARD = 8`. If exceeded, the oldest non-taken contract is dropped with a flavour narration:

> "The garrison board is full. The posting for '[title]' has been scratched out — too many contracts, not enough hands."

**Drop logic:** only drops contracts where `!c.claimedAt && !c.taken` — never drops an in-progress contract the player has already accepted.

## Files changed

| File | Change |
|------|--------|
| `src/server/game/town.ts` | `factionRepNote()` helper; `claimContractReward()` reads new rep after `shiftFactionStanding` and appends note to narration |
| `src/server/routes/town.ts` | Board cap check after follow-up push; drops oldest non-taken contract if total unclaimed > 8 |

## Also deployed this session

- **Handoff 12 (TownView garrison highlight)** — completed the failed fourth edit to contract card highlighting
- **Movement handler try/catch** — wrapped `if (movementTarget)` block in try/catch; silent async freeze on "go north" (and any valid direction) now produces a recovery message instead of hanging the client

## Suggested next features

- **Contract expiry** — contracts auto-expire after N dungeon turns if unclaimed (uses `exploration_turn`), with a "posting went stale" narration
- **Rival party contracts** — a named rival group claims a contract before the player, surfaced as a taproom rumour
- **Faction scene benefits** — when the party enters a scene controlled by a faction they have high rep with, surface a minor positive note (guard nods them through, locals point out a hidden exit, shadows leave a supply cache)
- **Rep penalty on failure** — if an accepted contract expires without completion, faction rep drops -1
