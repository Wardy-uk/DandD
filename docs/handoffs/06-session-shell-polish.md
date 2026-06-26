# Handoff 06: Session Shell Polish

## What shipped
- Reworked new campaign creation so it starts with choosing a setting rather than free-writing a world.
- Campaign titles are now optional:
  - the server can generate a fitting default title from the chosen setting
  - each setting exposes multiple suggested names
  - the client lets the player tap a suggested title instead of inventing one
- Tightened the PWA prompt:
  - smaller visual footprint
  - less intrusive on mobile
  - still keeps `Full Refresh` visible outside live play
- Reclaimed space for actual play on phones:
  - app header now hides during mobile in-session play
  - game view runs full-bleed on mobile
- Improved the in-session mobile shell:
  - added an adventure status strip for pressure, light, company size, and supplies
  - split actions into class/signature actions versus general actions
  - de-duplicated repeated quick-action chips
  - made the live log feel like the dominant surface again

## Files changed
- `src/shared/campaignSettings.ts`
- `src/server/routes/campaign.ts`
- `src/client/components/CampaignList.tsx`
- `src/client/components/PwaPrompt.tsx`
- `src/client/App.tsx`
- `src/client/components/GameView.tsx`

## Player-facing result
- New campaign creation now feels like choosing an adventure box and marching order, not filling out a generic CMS form.
- Mobile play is less claustrophobic and more game-first.
- Class identity lands faster because your most thematic actions are promoted above the generic options.
- The PWA controls are still there, but they stop bullying the rest of the interface.

## Build status
- `npm run build:server` passed
- `npm run build` passed

## Suggested future continuation
- Turn the campaign picker into an even richer “setting dossier” with sample threats, factions, and likely treasure themes.
- Give each class a bespoke mobile action rail with stronger iconography and context-sensitive verbs.
- Add a proper mobile town summary strip so the return-to-town loop feels as polished as the dungeon loop.
- Start surfacing “party drama now in motion” alerts when relationships are close to breaking or deepening.
