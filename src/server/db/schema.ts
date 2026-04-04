/**
 * Database schema — sql.js (in-memory SQLite, flushed to disk)
 * Same pattern as NOVA — proven on Pi 5.
 */

import initSqlJs, { type Database } from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../../../quest.db');
const SAVE_INTERVAL = 15_000; // 15 seconds

let db: Database;
let saveTimer: ReturnType<typeof setInterval>;

export async function initDb(): Promise<Database> {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
    console.log('[DB] Loaded existing database');
  } else {
    db = new SQL.Database();
    console.log('[DB] Created new database');
  }

  runMigrations();

  // Auto-save periodically
  saveTimer = setInterval(() => saveDb(), SAVE_INTERVAL);

  return db;
}

export function getDb(): Database {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

export function saveDb() {
  if (!db) return;
  try {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
  } catch (err) {
    console.error('[DB] Save failed:', err);
  }
}

export function closeDb() {
  if (saveTimer) clearInterval(saveTimer);
  saveDb();
  if (db) db.close();
}

function runMigrations() {
  db.run(`
    CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      last_seen TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      setting TEXT DEFAULT '',
      dm_notes TEXT DEFAULT '',
      current_scene_id TEXT,
      session_number INTEGER DEFAULT 1,
      calendar_date TEXT DEFAULT '',
      calendar_time TEXT DEFAULT '',
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now')),
      created_by TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS campaign_players (
      campaign_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      joined_at TEXT DEFAULT (datetime('now')),
      is_owner INTEGER DEFAULT 0,
      PRIMARY KEY (campaign_id, player_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS characters (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      player_name TEXT DEFAULT '',
      name TEXT NOT NULL,
      race TEXT NOT NULL,
      char_class TEXT NOT NULL,
      multi_class TEXT,
      alignment TEXT NOT NULL,
      level INTEGER DEFAULT 1,
      xp INTEGER DEFAULT 0,
      xp_next INTEGER DEFAULT 0,
      str INTEGER NOT NULL,
      str_percentile INTEGER,
      dex INTEGER NOT NULL,
      con INTEGER NOT NULL,
      int INTEGER NOT NULL,
      wis INTEGER NOT NULL,
      cha INTEGER NOT NULL,
      thac0 INTEGER NOT NULL,
      ac INTEGER DEFAULT 10,
      hp INTEGER NOT NULL,
      max_hp INTEGER NOT NULL,
      base_movement INTEGER DEFAULT 12,
      save_paralysis INTEGER NOT NULL,
      save_rod INTEGER NOT NULL,
      save_petrify INTEGER NOT NULL,
      save_breath INTEGER NOT NULL,
      save_spell INTEGER NOT NULL,
      weapon_prof_slots INTEGER DEFAULT 0,
      nonweapon_prof_slots INTEGER DEFAULT 0,
      weapon_profs TEXT DEFAULT '[]',
      nonweapon_profs TEXT DEFAULT '[]',
      spell_slots TEXT,
      memorised_spells TEXT,
      spellbook TEXT,
      priest_spheres TEXT,
      thief_skills TEXT,
      inventory TEXT DEFAULT '[]',
      gold REAL DEFAULT 0,
      silver REAL DEFAULT 0,
      copper REAL DEFAULT 0,
      electrum REAL DEFAULT 0,
      platinum REAL DEFAULT 0,
      conditions TEXT DEFAULT '[]',
      notes TEXT DEFAULT '',
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS scenes (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      name TEXT NOT NULL,
      brief TEXT DEFAULT '',
      ai_description TEXT DEFAULT '',
      light_level TEXT DEFAULT 'normal',
      terrain_type TEXT DEFAULT 'indoor',
      connections TEXT DEFAULT '[]',
      visited INTEGER DEFAULT 0,
      notes TEXT DEFAULT ''
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS npcs (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      name TEXT NOT NULL,
      race TEXT DEFAULT 'human',
      char_class TEXT DEFAULT '',
      level INTEGER DEFAULT 1,
      personality TEXT DEFAULT '',
      appearance TEXT DEFAULT '',
      voice_notes TEXT DEFAULT '',
      disposition TEXT DEFAULT 'neutral',
      location_scene_id TEXT,
      stats TEXT,
      inventory TEXT DEFAULT '[]',
      memory TEXT DEFAULT '[]',
      alive INTEGER DEFAULT 1
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS monster_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      thac0 INTEGER NOT NULL,
      ac INTEGER NOT NULL,
      hit_dice TEXT NOT NULL,
      hp_range TEXT DEFAULT '',
      num_attacks INTEGER DEFAULT 1,
      damage TEXT DEFAULT '[]',
      special_attacks TEXT DEFAULT '[]',
      special_defences TEXT DEFAULT '[]',
      movement INTEGER DEFAULT 12,
      morale INTEGER DEFAULT 7,
      xp_value INTEGER DEFAULT 0,
      treasure_type TEXT DEFAULT '',
      size TEXT DEFAULT 'M',
      intelligence TEXT DEFAULT 'average',
      alignment TEXT DEFAULT 'True Neutral',
      description TEXT DEFAULT ''
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS encounters (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      scene_id TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      round INTEGER DEFAULT 0,
      segment INTEGER DEFAULT 0,
      initiative_type TEXT DEFAULT 'group',
      turn_order TEXT DEFAULT '[]',
      current_turn_index INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS combatants (
      id TEXT PRIMARY KEY,
      encounter_id TEXT NOT NULL,
      character_id TEXT,
      npc_id TEXT,
      name TEXT NOT NULL,
      side TEXT NOT NULL,
      initiative_roll INTEGER DEFAULT 0,
      weapon_speed INTEGER DEFAULT 5,
      final_initiative INTEGER DEFAULT 0,
      current_hp INTEGER NOT NULL,
      max_hp INTEGER NOT NULL,
      thac0 INTEGER NOT NULL,
      ac INTEGER NOT NULL,
      conditions TEXT DEFAULT '[]',
      is_surprised INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS game_log (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      session_number INTEGER DEFAULT 1,
      timestamp TEXT DEFAULT (datetime('now')),
      type TEXT NOT NULL,
      actor TEXT DEFAULT '',
      content TEXT NOT NULL,
      mechanical_detail TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS ai_cache (
      id TEXT PRIMARY KEY,
      prompt_hash TEXT NOT NULL,
      context_hash TEXT DEFAULT '',
      response TEXT NOT NULL,
      model TEXT DEFAULT '',
      tokens_used INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS ai_queue (
      id TEXT PRIMARY KEY,
      campaign_id TEXT,
      type TEXT NOT NULL,
      priority INTEGER DEFAULT 5,
      prompt TEXT NOT NULL,
      context TEXT DEFAULT '',
      status TEXT DEFAULT 'queued',
      result TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS world_lore (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      category TEXT DEFAULT 'general',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Indexes
  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_characters_campaign ON characters(campaign_id)',
    'CREATE INDEX IF NOT EXISTS idx_characters_player ON characters(player_id)',
    'CREATE INDEX IF NOT EXISTS idx_scenes_campaign ON scenes(campaign_id)',
    'CREATE INDEX IF NOT EXISTS idx_npcs_campaign ON npcs(campaign_id)',
    'CREATE INDEX IF NOT EXISTS idx_game_log_campaign ON game_log(campaign_id)',
    'CREATE INDEX IF NOT EXISTS idx_ai_queue_status ON ai_queue(status, priority)',
    'CREATE INDEX IF NOT EXISTS idx_encounters_campaign ON encounters(campaign_id)',
    'CREATE INDEX IF NOT EXISTS idx_combatants_encounter ON combatants(encounter_id)',
    'CREATE INDEX IF NOT EXISTS idx_campaign_players ON campaign_players(player_id)',
  ];

  for (const idx of indexes) {
    db.run(idx);
  }

  console.log('[DB] Migrations complete');
}
