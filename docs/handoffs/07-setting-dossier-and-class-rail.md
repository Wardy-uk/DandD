# Handoff 07: Setting Dossier and Class Rail

## What shipped
- Expanded campaign setting definitions with richer deterministic metadata:
  - opening situation
  - gameplay focus
  - signature threats
  - treasure style
  - best party fit
- Upgraded new campaign creation into a proper adventure picker:
  - each setting now shows its play focus at selection time
  - the right-hand dossier panel sells the tone and likely session texture
  - suggested titles remain one-tap usable
  - starting mode is reflected in the dossier header
- Reworked the mobile in-session action surface:
  - each class now gets a bespoke two-card command rail
  - rail entries include icon, label, and “why this matters now” hint text
  - the rail changes meaningfully between combat and exploration states

## Files changed
- `src/shared/campaignSettings.ts`
- `src/client/components/CampaignList.tsx`
- `src/client/components/GameView.tsx`

## Player-facing result
- Starting a campaign now feels much closer to choosing a boxed campaign premise than filling in a blank form.
- The setting picker gives immediate confidence about what sort of adventure you are buying into.
- On mobile, class identity reads faster because the first actions you see are now role-shaped, not just generic verbs.
- The game feels a bit more like a human DM is framing the table and a bit less like a utility interface.

## Build status
- `npm run build:server` passed
- `npm run build` passed

## Suggested future continuation
- Add setting-specific opening hooks so the first scene differs mechanically by setting.
- Let class rails unlock or change based on level, vows, companions, and current pressure.
- Surface “why this matters” in the log after a class-rail action lands, so the payoff is visible immediately.
- Bring the same dossier quality to town contracts and recruitable NPC introductions.
