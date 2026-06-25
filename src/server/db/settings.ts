import type { Database } from 'sql.js';
import { all, get, run } from './helpers.js';

export interface AppSettings {
  allowRegistration: boolean;
  allowCampaignCreation: boolean;
  defaultAiGrowthEnabled: boolean;
  defaultTargetSceneBuffer: number;
  defaultTargetNpcBuffer: number;
}

const DEFAULT_SETTINGS: AppSettings = {
  allowRegistration: true,
  allowCampaignCreation: true,
  defaultAiGrowthEnabled: true,
  defaultTargetSceneBuffer: 6,
  defaultTargetNpcBuffer: 4,
};

const DEFAULT_ADMIN = {
  id: 'admin-nickdm',
  username: 'NickDM',
  displayName: 'NickDM',
  role: 'admin',
  passwordHash: '$2a$10$6xTc8tVENWsMe8bKy52WGegjjXKEX0t9gqhdg640ONffX3sUDG/c2',
  passwordLabel: 'Alchemy12/',
};

export function getAppSettings(db: Database): AppSettings {
  const rows = all(db, 'SELECT key, value FROM app_settings') as Array<{ key: string; value: string }>;
  const raw = new Map(rows.map((row) => [row.key, row.value]));

  return {
    allowRegistration: parseBoolean(raw.get('allow_registration'), DEFAULT_SETTINGS.allowRegistration),
    allowCampaignCreation: parseBoolean(raw.get('allow_campaign_creation'), DEFAULT_SETTINGS.allowCampaignCreation),
    defaultAiGrowthEnabled: parseBoolean(raw.get('default_ai_growth_enabled'), DEFAULT_SETTINGS.defaultAiGrowthEnabled),
    defaultTargetSceneBuffer: parseNumber(raw.get('default_target_scene_buffer'), DEFAULT_SETTINGS.defaultTargetSceneBuffer),
    defaultTargetNpcBuffer: parseNumber(raw.get('default_target_npc_buffer'), DEFAULT_SETTINGS.defaultTargetNpcBuffer),
  };
}

export function updateAppSettings(db: Database, partial: Partial<AppSettings>): AppSettings {
  const next = {
    ...getAppSettings(db),
    ...partial,
  };

  const entries: Array<[string, string]> = [
    ['allow_registration', next.allowRegistration ? '1' : '0'],
    ['allow_campaign_creation', next.allowCampaignCreation ? '1' : '0'],
    ['default_ai_growth_enabled', next.defaultAiGrowthEnabled ? '1' : '0'],
    ['default_target_scene_buffer', String(next.defaultTargetSceneBuffer)],
    ['default_target_npc_buffer', String(next.defaultTargetNpcBuffer)],
  ];

  for (const [key, value] of entries) {
    run(db, 'INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', [key, value]);
  }

  return next;
}

export function ensureAppSettings(db: Database) {
  const exists = get(db, 'SELECT COUNT(*) as count FROM app_settings') as { count?: number } | null;
  if (Number(exists?.count || 0) > 0) {
    return;
  }

  updateAppSettings(db, DEFAULT_SETTINGS);
}

export function ensureDefaultAdmin(db: Database) {
  const existing = get(db, 'SELECT id FROM players WHERE username = ?', [DEFAULT_ADMIN.username]) as { id?: string } | null;

  if (!existing) {
    run(db, `
      INSERT INTO players (id, username, password_hash, display_name, role)
      VALUES (?, ?, ?, ?, ?)
    `, [
      DEFAULT_ADMIN.id,
      DEFAULT_ADMIN.username,
      DEFAULT_ADMIN.passwordHash,
      DEFAULT_ADMIN.displayName,
      DEFAULT_ADMIN.role,
    ]);
    return;
  }

  run(db, `
    UPDATE players
    SET password_hash = ?,
        display_name = ?,
        role = ?
    WHERE username = ?
  `, [
    DEFAULT_ADMIN.passwordHash,
    DEFAULT_ADMIN.displayName,
    DEFAULT_ADMIN.role,
    DEFAULT_ADMIN.username,
  ]);
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === '1' || value.toLowerCase() === 'true';
}

function parseNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
