/**
 * QUEST — AI Dungeon Master Server
 * Express + Socket.IO for async multiplayer AD&D 2e
 */

import express from 'express';
import { createServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

import { initDb, closeDb } from './db/schema.js';
import { createAuthRoutes } from './routes/auth.js';
import { createCampaignRoutes } from './routes/campaign.js';
import { createCharacterRoutes } from './routes/character.js';
import { createGameRoutes } from './routes/game.js';
import { createAiRoutes } from './routes/ai.js';
import { createAdminRoutes } from './routes/admin.js';
import { createTownRoutes } from './routes/town.js';
import { setupSocketHandlers } from './socket.js';
import { healthCheck as ollamaHealthCheck } from './ai/ollama.js';
import { startNightlyGrowthScheduler } from './ai/scheduler.js';
import type { ServerToClientEvents, ClientToServerEvents } from '../shared/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3002');

const app = express();
const httpServer = createServer(app);

const ALLOWED_ORIGINS = [
  process.env.FRONTEND_URL || 'http://localhost:5174',
  'https://dandd.nickward.co.uk',
  'https://quest-dandd.netlify.app',
];

const io = new SocketServer<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ['GET', 'POST'],
  },
  path: '/socket.io',
});

// ─── Middleware ──────────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json());

// ─── Async Startup ──────────────────────────────────────────────────────────

async function start() {
  // ─── Database ───────────────────────────────────────────────────────────────

  const db = await initDb();
  console.log('[QUEST] Database initialized');

  // ─── API Routes ─────────────────────────────────────────────────────────────

  app.use('/api/auth', createAuthRoutes(db));
  app.use('/api/campaigns', createCampaignRoutes(db, io));
  app.use('/api/characters', createCharacterRoutes(db));
  app.use('/api/game', createGameRoutes(db, io));
  app.use('/api/ai', createAiRoutes());
  app.use('/api/admin', createAdminRoutes(db));
  app.use('/api/town', createTownRoutes(db, io));

  // ─── Health ─────────────────────────────────────────────────────────────────

  app.get('/api/health', async (_req, res) => {
    const ollamaOk = await ollamaHealthCheck();
    res.json({
      ok: true,
      data: {
        server: true,
        database: true,
        ollama: ollamaOk,
        runtimeMode: 'deterministic',
        aiUsage: 'nightly_growth_only',
        version: process.env.npm_package_version || '0.1.0',
      },
    });
  });

  // ─── Socket.IO ──────────────────────────────────────────────────────────────

  setupSocketHandlers(io, db);
  startNightlyGrowthScheduler(db);

  // ─── Static Files (production) ──────────────────────────────────────────────

  const clientDist = path.resolve(__dirname, '../client');
  app.use(express.static(clientDist));
  app.get('/{*splat}', (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });

  // ─── Start ──────────────────────────────────────────────────────────────────

  httpServer.listen(PORT, () => {
    console.log(`[QUEST] Server running on port ${PORT}`);
    console.log(`[QUEST] Frontend: ${process.env.FRONTEND_URL || 'http://localhost:5174'}`);
  });

  // Pre-warm Ollama so first player request hits a loaded model
  (async () => {
    try {
      await new Promise(r => setTimeout(r, 3000)); // wait for server to fully start
      const { generate } = await import('./ai/ollama.js');
      await generate({
        prompt: 'Ready.',
        system: 'You are a DM. Say "ready" and nothing else.',
        maxTokens: 5,
        temperature: 0.1,
      });
      console.log('[Warmup] llama3.1:8b loaded and ready');
    } catch (err) {
      console.warn('[Warmup] Model pre-load failed (non-critical):', err);
    }
  })();
}

start().catch((err) => {
  console.error('[QUEST] Failed to start:', err);
  process.exit(1);
});

// ─── Shutdown ───────────────────────────────────────────────────────────────

function gracefulShutdown(signal: string) {
  console.log(`[QUEST] ${signal} received — shutting down gracefully...`);
  httpServer.close(() => {
    closeDb();
    console.log('[QUEST] Server closed.');
    process.exit(0);
  });
  // Force exit after 5s if close stalls
  setTimeout(() => {
    closeDb();
    process.exit(0);
  }, 5_000).unref();
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  console.error('[QUEST] Uncaught exception:', err);
  gracefulShutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  console.error('[QUEST] Unhandled rejection:', reason);
});
