/**
 * AI routes — direct AI interaction, queue status, model info
 */

import { Router } from 'express';
import { aiDirector } from '../ai/director.js';
import { healthCheck, listModels } from '../ai/ollama.js';

export function createAiRoutes(): Router {
  const router = Router();

  // AI queue status
  router.get('/status', (_req, res) => {
    const status = aiDirector.getStatus();
    res.json({ ok: true, data: status });
  });

  // Ollama health
  router.get('/health', async (_req, res) => {
    const ok = await healthCheck();
    const models = ok ? await listModels() : [];
    res.json({ ok: true, data: { ollama: ok, models } });
  });

  return router;
}
