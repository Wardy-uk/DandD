import { initDb, closeDb } from '../db/schema.js';
import { all } from '../db/helpers.js';
import { runNightlyGrowth } from '../ai/nightlyGrowth.js';

async function main() {
  const db = await initDb();
  const campaigns = all(db, `
    SELECT id, name
    FROM campaigns
    WHERE status = 'active' AND ai_growth_enabled = 1
  `) as Array<{ id: string; name: string }>;

  if (campaigns.length === 0) {
    console.log('[Nightly Growth] No active campaigns opted in.');
    closeDb();
    return;
  }

  for (const campaign of campaigns) {
    const result = await runNightlyGrowth(db, campaign.id);
    console.log(`[Nightly Growth] ${campaign.name}: ${result.summary}`);
  }

  closeDb();
}

main().catch((err) => {
  console.error('[Nightly Growth] Failed:', err);
  closeDb();
  process.exit(1);
});
