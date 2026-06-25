import type { Database } from 'sql.js';
import { all } from '../db/helpers.js';
import { runNightlyGrowth as runContentGrowth } from './nightlyGrowth.js';
import { runNightlyGrowth as runWorldGrowth } from '../game/nightlyGrowth.js';

// Check every 15 minutes — fires the growth jobs only during the target hour
const CHECK_INTERVAL_MS = 15 * 60 * 1000;

// Campaigns must have had activity within this window to qualify
const ACTIVE_WITHIN_DAYS = 7;

export function startNightlyGrowthScheduler(db: Database) {
  const nightlyHourUtc = Number(process.env.NIGHTLY_GROWTH_HOUR_UTC || 3);

  const tick = async () => {
    const now = new Date();
    if (now.getUTCHours() !== nightlyHourUtc) return;

    // Campaigns that are active AND had player activity in the last 7 days
    const campaigns = all(db, `
      SELECT c.id, c.name, c.last_growth_check_at, c.last_nightly_run_at
      FROM campaigns c
      WHERE c.status = 'active'
        AND c.ai_growth_enabled = 1
        AND EXISTS (
          SELECT 1 FROM game_log gl
          WHERE gl.campaign_id = c.id
            AND gl.timestamp >= datetime('now', '-${ACTIVE_WITHIN_DAYS} days')
        )
    `) as any[];

    const today = now.toISOString().slice(0, 10);

    for (const campaign of campaigns) {
      // ── AI content buffer (scenes / NPCs / lore) ─────────────────────
      const lastContentRun = typeof campaign.last_growth_check_at === 'string'
        ? String(campaign.last_growth_check_at).slice(0, 10)
        : '';
      if (lastContentRun !== today) {
        try {
          const result = await runContentGrowth(db, campaign.id);
          console.log(`[Content Growth] ${campaign.name}: ${result.summary}`);
        } catch (err) {
          console.error(`[Content Growth] Failed for ${campaign.name}:`, err);
        }
      }

      // ── World simulation (factions / rivals / rumours / events) ──────
      const lastWorldRun = typeof campaign.last_nightly_run_at === 'string'
        ? String(campaign.last_nightly_run_at).slice(0, 10)
        : '';
      if (lastWorldRun !== today) {
        try {
          const result = await runWorldGrowth(db, campaign.id);
          console.log(`[World Growth] ${campaign.name}: ${result.dawnSummary || 'done'}`);
        } catch (err) {
          console.error(`[World Growth] Failed for ${campaign.name}:`, err);
        }
      }
    }
  };

  // Run once immediately on startup (only fires if it's the right hour)
  void tick();

  return setInterval(() => { void tick(); }, CHECK_INTERVAL_MS);
}
