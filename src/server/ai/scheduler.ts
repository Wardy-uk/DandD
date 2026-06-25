import type { Database } from 'sql.js';
import { all } from '../db/helpers.js';
import { runNightlyGrowth } from './nightlyGrowth.js';

const CHECK_INTERVAL_MS = 15 * 60 * 1000;

export function startNightlyGrowthScheduler(db: Database) {
  const nightlyHourUtc = Number(process.env.NIGHTLY_GROWTH_HOUR_UTC || 3);

  const tick = async () => {
    const now = new Date();
    if (now.getUTCHours() !== nightlyHourUtc) {
      return;
    }

    const campaigns = all(db, `
      SELECT id, name, last_growth_check_at
      FROM campaigns
      WHERE status = 'active' AND ai_growth_enabled = 1
    `) as any[];

    const today = now.toISOString().slice(0, 10);
    for (const campaign of campaigns) {
      const lastRunDate = typeof campaign.last_growth_check_at === 'string'
        ? String(campaign.last_growth_check_at).slice(0, 10)
        : '';
      if (lastRunDate === today) {
        continue;
      }

      try {
        const result = await runNightlyGrowth(db, campaign.id);
        console.log(`[Nightly Growth] ${campaign.name}: ${result.summary}`);
      } catch (err) {
        console.error(`[Nightly Growth] Failed for ${campaign.name}:`, err);
      }
    }
  };

  void tick();
  return setInterval(() => {
    void tick();
  }, CHECK_INTERVAL_MS);
}
