/**
 * Auth routes — simple JWT auth for multiplayer
 */

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import type { Database } from 'sql.js';
import { get, all, run } from '../db/helpers.js';

const JWT_SECRET = process.env.JWT_SECRET || 'quest-dm-secret-change-in-production';

export function createAuthRoutes(db: Database): Router {
  const router = Router();

  // Register
  router.post('/register', async (req, res) => {
    try {
      const { username, password, displayName } = req.body;
      if (!username || !password) {
        res.json({ ok: false, error: 'Username and password required' });
        return;
      }

      const existing = get(db, 'SELECT id FROM players WHERE username = ?', [username]);
      if (existing) {
        res.json({ ok: false, error: 'Username already taken' });
        return;
      }

      const id = uuid();
      const passwordHash = await bcrypt.hash(password, 10);
      run(db,
        'INSERT INTO players (id, username, password_hash, display_name) VALUES (?, ?, ?, ?)',
        [id, username, passwordHash, displayName || username]);

      const token = jwt.sign({ id, username }, JWT_SECRET, { expiresIn: '30d' });
      res.json({ ok: true, data: { id, username, displayName: displayName || username, token } });
    } catch (err) {
      res.json({ ok: false, error: 'Registration failed' });
    }
  });

  // Login
  router.post('/login', async (req, res) => {
    try {
      const { username, password } = req.body;
      if (!username || !password) {
        res.json({ ok: false, error: 'Username and password required' });
        return;
      }

      const player = get(db, 'SELECT * FROM players WHERE username = ?', [username]) as any;
      if (!player) {
        res.json({ ok: false, error: 'Invalid credentials' });
        return;
      }

      const valid = await bcrypt.compare(password, player.password_hash);
      if (!valid) {
        res.json({ ok: false, error: 'Invalid credentials' });
        return;
      }

      run(db, 'UPDATE players SET last_seen = datetime("now") WHERE id = ?', [player.id]);

      const token = jwt.sign({ id: player.id, username: player.username }, JWT_SECRET, { expiresIn: '30d' });
      res.json({
        ok: true,
        data: {
          id: player.id,
          username: player.username,
          displayName: player.display_name || player.username,
          token,
        },
      });
    } catch (err) {
      res.json({ ok: false, error: 'Login failed' });
    }
  });

  // Verify token
  router.get('/me', (req, res) => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      res.json({ ok: false, error: 'No token' });
      return;
    }

    try {
      const decoded = jwt.verify(auth.slice(7), JWT_SECRET) as { id: string; username: string };
      const player = get(db, 'SELECT id, username, display_name FROM players WHERE id = ?', [decoded.id]) as any;
      if (!player) {
        res.json({ ok: false, error: 'Player not found' });
        return;
      }

      res.json({
        ok: true,
        data: { id: player.id, username: player.username, displayName: player.display_name },
      });
    } catch {
      res.json({ ok: false, error: 'Invalid token' });
    }
  });

  return router;
}

/** Middleware to extract player from JWT */
export function authMiddleware(db: Database) {
  return (req: any, _res: any, next: any) => {
    const auth = req.headers.authorization;
    const tokenParam = req.query?.token;
    const tokenStr = auth?.startsWith('Bearer ') ? auth.slice(7) : tokenParam;

    if (!tokenStr) {
      req.player = null;
      next();
      return;
    }

    try {
      const decoded = jwt.verify(tokenStr, JWT_SECRET) as { id: string; username: string };
      req.player = decoded;
    } catch {
      req.player = null;
    }
    next();
  };
}

export function requireAuth(req: any, res: any, next: any) {
  if (!req.player) {
    res.status(401).json({ ok: false, error: 'Authentication required' });
    return;
  }
  next();
}
