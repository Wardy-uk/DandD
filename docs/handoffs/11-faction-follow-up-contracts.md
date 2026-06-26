# Handoff 11: Faction Follow-Up Contracts

**Commit:** `b2db9ea`  
**Status:** Deployed (server + client)

## What was built

When a player claims a completed contract (`POST /town/:campaignId/contract/claim`), the issuing faction now evaluates the outcome and posts a new, escalating follow-up contract to the board.

### Behaviour

- Each of the four factions (watch, locals, shadows, delvers) has a 2-step follow-up chain
- Follow-up reward = previous reward × 1.35–1.6, rounded up to nearest 5 GP
- Higher chain steps gate behind minimum faction reputation (rep 2 or 3)
- Skip conditions:
  - Chain is exhausted (both steps already claimed)
  - An unclaimed contract from this faction already exists on the board
  - Rep too low for that chain tier
- If generated: narration is logged to `game_log` and emitted via `game:narration`
- Socket event `game:contracts_updated` fires with `{ followUpId }` so the client can react

### Faction chains

| Faction | Step 0 | Step 1 |
|---------|--------|--------|
| watch | Secure the second passage (×1.4, 2 scenes) | Hold the front corridor (×1.5, 3 scenes, rep≥2) |
| locals | Retrieve the surveyor's documentation (×1.35, 5 sites) | Full survey of the northern sectors (×1.5, 8 sites, rep≥3) |
| shadows | Locate the second seal (×1.5, 3 treasure marks) | Identify the contractor (×1.6, 1 revelation, rep≥2) |
| delvers | Chart the mid-dungeon approaches (×1.4, 3 fallbacks) | Document the deep ways (×1.6, 5 fallbacks, rep≥3) |

### Data model change

`TownContract` interface gains `followUpOf?: string` — the ID of the contract this one follows up on. Useful for chronicle/map display later.

### API change

`POST /town/:campaignId/contract/claim` response now includes `followUp: TownContract | null` in the payload alongside the existing result fields.

## Files changed

- `src/server/game/town.ts` — `TownContract` interface, `FOLLOW_UP_CHAINS`, `generateFollowUpContract()` export
- `src/server/routes/town.ts` — import + call after successful claim; log narration, emit socket events

## Suggested next continuation

1. **Client: surface the follow-up in TownView** — when claim response includes `followUp`, briefly highlight the new posting on the contract board with a "New contract posted" banner
2. **Chronicle entries for follow-up contracts** — `getChronicle()` could detect `followUpOf` chains and render them as a "campaign arc" section showing the progression watch → "Secure the second passage" → "Hold the front corridor"
3. **Named objective contracts** — use scene names and NPC names from the current campaign state in follow-up contract titles rather than generic descriptions (e.g. "Return to the Weeping Hall" instead of "Secure the second passage")
4. **Rival interference** — when a rival party claims a contract first, it generates a different follow-up ("The [rival name] took the job. The garrison is short on options…") that adjusts tone and reward
