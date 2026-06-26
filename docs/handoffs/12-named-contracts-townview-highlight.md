# Handoff 12 — Named Contracts + TownView Garrison Highlight

**Commit:** `eb8481f`
**Date:** 2026-06-26

## What shipped

Two features building on the faction follow-up contract system from handoff 11.

### 1. Named contracts

Follow-up contract templates now pull real scene and NPC names from the campaign database to personalise the contract text. A "haunted mill" visited earlier becomes the specific location named in a Watch patrol contract. A living NPC becomes the source of a Shadows mystery.

**Query logic in `generateFollowUpContract()` (`src/server/game/town.ts`):**

1. **Scene name** — first tries uncleared visited scenes (`cleared != 1` in `scene_state`), so the faction points players back toward incomplete locations. Falls back to any visited scene, then to a generic title if none visited.
2. **NPC name** — living, non-party NPCs from the campaign. Used in Shadows chain to make the contract feel like it's watching the specific campaign.

Context keys added to `FollowUpContext`:
```typescript
sceneName?: string;
npcName?: string;
```

All 8 chain templates updated to use `ctx.sceneName` / `ctx.npcName` where appropriate.

### 2. TownView garrison highlight

When a follow-up contract arrives via `game:contracts_updated` socket event, the Garrison tab:

- Auto-switches to the garrison tab (`setTab('garrison')`)
- Highlights the new contract card for 15 seconds with leather-coloured ring + border + tinted background
- Shows a pulsing `New` badge on the card
- Shows a quieter `follow-up` badge on subsequent views (after the 15s highlight expires, or on other follow-up contracts that aren't the newest)

**State:** `const [newContractId, setNewContractId] = useState<string | null>(null);`

**Socket listener** (added after `game:narration` useEffect in `TownView.tsx`):
```typescript
useEffect(() => {
  const onContractsUpdated = (data: { followUpId: string }) => {
    setNewContractId(data.followUpId);
    setTab('garrison');
    fetchTownData();
    setTimeout(() => setNewContractId(null), 15_000);
  };
  socket.on('game:contracts_updated', onContractsUpdated);
  return () => { socket.off('game:contracts_updated', onContractsUpdated); };
}, [socket, fetchTownData]);
```

**Contract card diff** — conditional border/ring + badge pills:
```tsx
className={`p-3 rounded-lg border transition-colors ${
  contract.id === newContractId
    ? 'border-leather/50 bg-leather/8 ring-1 ring-leather/25'
    : contract.taken ? 'border-green-600/30 bg-green-50/30'
    : 'border-leather/15 bg-parchment/40'
}`}
```

## Data model

No schema changes. `followUpOf` is a string field on the `TownContract` JSON stored in `campaigns.town_contracts`. The `Contract` interface in `TownView.tsx` mirrors it:
```typescript
followUpOf?: string;
```

## Files changed

| File | Change |
|------|--------|
| `src/server/game/town.ts` | Added `sceneName`/`npcName` to `FollowUpContext`; query logic in `generateFollowUpContract()`; all chain templates updated |
| `src/client/components/TownView.tsx` | `newContractId` state, socket listener, contract card highlight + badges |

## Suggested next features

- **Contract expiry** — contracts auto-expire after N dungeon runs if unclaimed, with a narration event
- **Rival party contracts** — competing adventurer group (named) takes a contract before the player can, surfaced as a rumour in the taproom
- **Faction rep rewards on claim** — claiming a contract increases rep with that faction (minor), unlocks better follow-up chains at higher rep tiers
- **Contract board limit** — cap at 6–8 contracts; oldest unclaimed contracts drop off with a flavour message when the board fills
