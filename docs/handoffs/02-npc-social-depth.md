# Handoff 02: NPC Social Depth

## What shipped
- Extended companion relationship state with:
  - `socialBonds`
  - `socialFriction`
  - `heartbreak`
- Companion drama now supports:
  - active reconciliation beats after strain
  - pair friendship growth between companions
  - pair rivalry escalation between companions
  - romance strain becoming actual heartbreak
  - true desertion when loyalty and tension collapse too far
- Town downtime now reinforces social consequences:
  - stressed romances can break instead of hovering forever
  - leaders and companions can partially reconcile
  - pair friendships and rivalries continue evolving off-camera

## Files changed
- `src/server/game/companions.ts`

## Player-facing result
- Companions now feel more like a living company and less like parallel individual meters.
- People can become proper friends with each other.
- Rivalries can form inside the party and poison morale.
- Romantic tension can sour into heartbreak instead of staying in a permanent almost-state.
- A bad enough leadership pattern can now actually cost the player a companion.

## Build status
- `npm run build:server` passed
- `npm run build` passed

## Recommended next step
- Move to `03 dungeon mastery`
- Focus on:
  - more persistent obstacle states
  - multi-step trap handling
  - better force / lock / tool tradeoffs
  - stronger resource loss and delve consequences
