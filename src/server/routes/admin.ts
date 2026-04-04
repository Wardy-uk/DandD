/**
 * Admin routes — user management
 */

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import type { Database } from 'sql.js';
import { get, all, run } from '../db/helpers.js';
import { authMiddleware, requireAuth } from './auth.js';

function requireAdmin(req: any, res: any, next: any) {
  if (!req.player) {
    res.status(401).json({ ok: false, error: 'Authentication required' });
    return;
  }
  const player = get(req._db, 'SELECT role FROM players WHERE id = ?', [req.player.id]) as any;
  if (!player || player.role !== 'admin') {
    res.status(403).json({ ok: false, error: 'Admin access required' });
    return;
  }
  next();
}

export function createAdminRoutes(db: Database): Router {
  const router = Router();
  router.use(authMiddleware(db));
  // Attach db to req so requireAdmin can access it
  router.use((req: any, _res, next) => { req._db = db; next(); });

  // List all users
  router.get('/users', requireAuth, requireAdmin, (_req: any, res) => {
    const users = all(db,
      'SELECT id, username, display_name, role, created_at, last_seen FROM players ORDER BY created_at DESC');
    res.json({ ok: true, data: users });
  });

  // Update user role
  router.patch('/users/:id/role', requireAuth, requireAdmin, (req: any, res) => {
    const { role } = req.body;
    if (!['player', 'admin'].includes(role)) {
      res.json({ ok: false, error: 'Invalid role. Use "player" or "admin".' });
      return;
    }

    const user = get(db, 'SELECT id, username FROM players WHERE id = ?', [req.params.id]) as any;
    if (!user) {
      res.json({ ok: false, error: 'User not found' });
      return;
    }

    run(db, 'UPDATE players SET role = ? WHERE id = ?', [role, req.params.id]);
    res.json({ ok: true, data: { id: user.id, username: user.username, role } });
  });

  // Update user display name
  router.patch('/users/:id', requireAuth, requireAdmin, (req: any, res) => {
    const { displayName } = req.body;
    if (!displayName) {
      res.json({ ok: false, error: 'displayName required' });
      return;
    }

    run(db, 'UPDATE players SET display_name = ? WHERE id = ?', [displayName, req.params.id]);
    res.json({ ok: true, data: { id: req.params.id, displayName } });
  });

  // Reset user password
  router.post('/users/:id/reset-password', requireAuth, requireAdmin, async (req: any, res) => {
    const { password } = req.body;
    if (!password || password.length < 4) {
      res.json({ ok: false, error: 'Password must be at least 4 characters' });
      return;
    }

    const hash = await bcrypt.hash(password, 10);
    run(db, 'UPDATE players SET password_hash = ? WHERE id = ?', [hash, req.params.id]);
    res.json({ ok: true, data: { message: 'Password reset' } });
  });

  // Delete user
  router.delete('/users/:id', requireAuth, requireAdmin, (req: any, res) => {
    // Prevent self-delete
    if (req.params.id === req.player.id) {
      res.json({ ok: false, error: 'Cannot delete yourself' });
      return;
    }

    run(db, 'DELETE FROM campaign_players WHERE player_id = ?', [req.params.id]);
    run(db, 'DELETE FROM characters WHERE player_id = ?', [req.params.id]);
    run(db, 'DELETE FROM players WHERE id = ?', [req.params.id]);
    res.json({ ok: true, data: { message: 'User deleted' } });
  });

  return router;
}
