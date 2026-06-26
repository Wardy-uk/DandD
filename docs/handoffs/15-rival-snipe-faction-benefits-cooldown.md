# Handoff 15 — Rival snipe, faction benefits UI, contract cooldown

## What shipped

Three features in one commit (`0797439`).

---

### A. Rival party contracts (snipe)

Active rivals can claim untaken contracts from the board while the party is away.

**Mechanic:**
- New export: `sniperRivalContracts(db, campaignId)` in `game/town.ts`
- Called in `routes/town.ts` GET route, after expiry check, before contracts are read
- A contract qualifies for snipe if: not taken, not expired, not claimed, has `postedAtSession` set, and is at least 2 sessions old (i.e. survived one full expedition untaken)
- 35% chance per qualifying contract per town visit
- Sniped contracts are removed from the board entirely; narration names an active rival if one exists
- Narration is logged to `game_log` and emitted via socket

**New field on `TownContract`:** `postedAtSession?: number` — set in both `generateContracts` and `generateFollowUpContract`. Legacy contracts without this field are skipped by the sniper.

---

### B. Faction scene benefits in UI

Garrison tab now shows a "Faction standing" panel listing unlocked rep-gated benefits per faction.

**Benefit tiers (mirrors `getFactionBenefits()` in `factions.ts`):**
- rep ≥ 2: Rumour contacts
- rep ≥ 3: Scout intel, Supply discount
- rep ≥ 4: Safe house rest
- rep ≥ 5: Safe route

**Where:** below the Heat panel in the Garrison tab, above Active contracts. Only shown if any faction has rep > 0 or is on cooldown.

Includes a "not posting work" label if `contractCooldownUntilSession` is active. Shows "Rep N unlocks X" progress hint for factions below max.

**No server changes needed** — faction data already in TownData response. `contractCooldownUntilSession` added to factions array in GET response.

---

### C. Contract cooldown after expiry

When a contract expires (`expireStaleContracts`), the faction goes quiet for 3 sessions.

**Implementation:**
- `FactionStanding` in `campaignState.ts` gets `contractCooldownUntilSession?: number`
- `expireStaleContracts` now reads `session_number` from campaigns and sets `factionState.contractCooldownUntilSession = currentSession + 3` on expiry
- `generateFollowUpContract` checks cooldown before posting: returns `null` if `currentSession < factionCooldown`

---

## Files changed

| File | Change |
|------|--------|
| `src/server/game/campaignState.ts` | Add `contractCooldownUntilSession?: number` to `FactionStanding` |
| `src/server/game/town.ts` | Add `postedAtSession` to `TownContract`; update `generateContracts` (new param + stamp); update `generateFollowUpContract` (cooldown check + stamp); update `expireStaleContracts` (read session, set cooldown); add `sniperRivalContracts` export |
| `src/server/routes/town.ts` | Import `sniperRivalContracts`; call after expiry in GET; pass `sessionNumber` to `generateContracts`; expose `contractCooldownUntilSession` in factions response |
| `src/client/components/TownView.tsx` | Add `postedAtSession` and `contractCooldownUntilSession` to types; add faction standing & benefits panel in Garrison tab |

---

## Notes

- No DB schema changes — everything stored in existing JSON columns
- Legacy contracts (no `postedAtSession`) are never sniped — safe for existing campaigns
- Legacy contracts (no `takenAtTurn`) still don't expire — unchanged from handoff 14
- Cooldown persists in `state_json` via `CampaignSimulationState.factions`
