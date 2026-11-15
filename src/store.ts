// =============
// 1. インポート
// =============
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { levelFromTotalXp } from "./util.js";

// ===================
// 2. 行データの型定義
// ===================
export interface WelcomeRow {
  guild_id: string;
  channel_id: string;
  message: string | null;
}

export interface XpRow {
  guild_id: string;
  user_id: string;
  xp: number;
  level: number;
  last_xp_at_ms: number;
}

export interface LevelRewardRow {
  guild_id: string;
  level: number;
  role_id: string;
}

export interface WarnRow {
  id: number;
  guild_id: string;
  user_id: string;
  moderator_id: string;
  reason: string;
  created_at_ms: number;
}

export interface PollRow {
  id: string;
  guild_id: string;
  channel_id: string;
  message_id: string;
  question: string;
  options: string[];
  ends_at_ms: number;
  created_by: string;
  closed: number;
}

export interface RecruitRow {
  id: string;
  guild_id: string;
  channel_id: string;
  message_id: string;
  title: string;
  max_members: number;
  starts_at_ms: number;
  description: string | null;
  created_by: string;
  closed: number;
}

export interface TimerRow {
  id: string;
  guild_id: string;
  channel_id: string;
  user_id: string;
  message: string;
  fires_at_ms: number;
  created_at_ms: number;
}

// SQLite store for the whole bot (Node built-in node:sqlite, no
// native dependency). One file: data/mabusaba.db

// =============
// 3. ストア本体
// =============
export class MabusabaStore {
  private db: DatabaseSync;

  // --- 初期化 ---
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, "mabusaba.db"));
    // WAL + NORMAL synchronous: cheaper commits and readers that do
    // not block the single writer (this bot's access pattern).
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    // Migrate the old single-role autorole table (PRIMARY KEY on
    // guild_id, one role per guild) to the multi-role table
    // (PRIMARY KEY on guild_id + role_id). Existing settings are kept.
    const autoroleSql = this.db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'autorole'",
      )
      .get() as { sql: string } | undefined;
    if (autoroleSql?.sql.includes("guild_id TEXT PRIMARY KEY")) {
      this.db.exec(`
        CREATE TABLE autorole_new (
          guild_id TEXT NOT NULL,
          role_id TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (guild_id, role_id)
        );
        INSERT INTO autorole_new (guild_id, role_id, updated_at)
          SELECT guild_id, role_id, updated_at FROM autorole;
        DROP TABLE autorole;
        ALTER TABLE autorole_new RENAME TO autorole;
      `);
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS welcome (
        guild_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        message TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS autorole (
        guild_id TEXT NOT NULL,
        role_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (guild_id, role_id)
      );
      CREATE TABLE IF NOT EXISTS xp_users (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        xp INTEGER NOT NULL DEFAULT 0,
        level INTEGER NOT NULL DEFAULT 0,
        last_xp_at_ms INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS level_rewards (
        guild_id TEXT NOT NULL,
        level INTEGER NOT NULL,
        role_id TEXT NOT NULL,
        PRIMARY KEY (guild_id, level)
      );
      CREATE TABLE IF NOT EXISTS warns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        moderator_id TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        created_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mod_log (
        guild_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS polls (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        question TEXT NOT NULL,
        options TEXT NOT NULL,
        ends_at_ms INTEGER NOT NULL,
        created_by TEXT NOT NULL,
        closed INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS poll_votes (
        poll_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        option_idx INTEGER NOT NULL,
        PRIMARY KEY (poll_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS recruits (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        title TEXT NOT NULL,
        max_members INTEGER NOT NULL,
        starts_at_ms INTEGER NOT NULL,
        description TEXT,
        created_by TEXT NOT NULL,
        closed INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS recruit_members (
        recruit_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        joined_at_ms INTEGER NOT NULL,
        PRIMARY KEY (recruit_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS timers (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        message TEXT NOT NULL,
        fires_at_ms INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_warns_guild_user ON warns (guild_id, user_id);
      CREATE INDEX IF NOT EXISTS idx_xp_guild_xp ON xp_users (guild_id, xp DESC);
      CREATE INDEX IF NOT EXISTS idx_polls_open ON polls (closed, ends_at_ms);
      CREATE INDEX IF NOT EXISTS idx_recruits_open ON recruits (closed, starts_at_ms);
    `);
  }

  // --- settings (bot-wide) ---

  // --- 設定 ---
  getSetting(key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, new Date().toISOString());
  }

  deleteSetting(key: string): void {
    this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }

  // --- welcome ---

  // --- ウェルカム・自動ロール ---
  getWelcome(guildId: string): WelcomeRow | null {
    const row = this.db
      .prepare(
        "SELECT guild_id, channel_id, message FROM welcome WHERE guild_id = ?",
      )
      .get(guildId) as WelcomeRow | undefined;
    return row ?? null;
  }

  setWelcome(guildId: string, channelId: string, message: string | null): void {
    this.db
      .prepare(
        `INSERT INTO welcome (guild_id, channel_id, message, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(guild_id) DO UPDATE SET channel_id = excluded.channel_id, message = excluded.message, updated_at = excluded.updated_at`,
      )
      .run(guildId, channelId, message, new Date().toISOString());
  }

  deleteWelcome(guildId: string): void {
    this.db.prepare("DELETE FROM welcome WHERE guild_id = ?").run(guildId);
  }

  // --- autorole (multiple roles per guild) ---
  getAutoroles(guildId: string): string[] {
    const rows = this.db
      .prepare(
        "SELECT role_id FROM autorole WHERE guild_id = ? ORDER BY updated_at, role_id",
      )
      .all(guildId) as Array<{ role_id: string }>;
    return rows.map((r) => r.role_id);
  }

  // Adds one role to the list. Returns false when it was already set.
  addAutorole(guildId: string, roleId: string): boolean {
    const result = this.db
      .prepare(
        "INSERT OR IGNORE INTO autorole (guild_id, role_id, updated_at) VALUES (?, ?, ?)",
      )
      .run(guildId, roleId, new Date().toISOString());
    return result.changes === 1;
  }

  // Removes one role from the list. Returns false when it was not set.
  removeAutorole(guildId: string, roleId: string): boolean {
    const result = this.db
      .prepare("DELETE FROM autorole WHERE guild_id = ? AND role_id = ?")
      .run(guildId, roleId);
    return result.changes === 1;
  }

  // Removes every autorole for the guild.
  deleteAutorole(guildId: string): void {
    this.db.prepare("DELETE FROM autorole WHERE guild_id = ?").run(guildId);
  }

  // --- XP / levels ---

  // --- XP・レベル ---
  getXp(guildId: string, userId: string): XpRow | null {
    const row = this.db
      .prepare(
        "SELECT guild_id, user_id, xp, level, last_xp_at_ms FROM xp_users WHERE guild_id = ? AND user_id = ?",
      )
      .get(guildId, userId) as XpRow | undefined;
    return row ?? null;
  }

  setXp(row: XpRow): void {
    this.db
      .prepare(
        `INSERT INTO xp_users (guild_id, user_id, xp, level, last_xp_at_ms) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(guild_id, user_id) DO UPDATE SET xp = excluded.xp, level = excluded.level, last_xp_at_ms = excluded.last_xp_at_ms`,
      )
      .run(row.guild_id, row.user_id, row.xp, row.level, row.last_xp_at_ms);
  }

  // Adds XP and returns the before/after rows. Caller decides the
  // level-up handling (message + reward roles). The stored `level`
  // is recomputed here in the same write, so readers of the column
  // (e.g. the leaderboard) can never disagree with the XP total.
  // `touchCooldown: false` grants XP without moving last_xp_at_ms —
  // used for game rewards, which must not reset the per-message XP
  // cooldown.
  addXp(
    guildId: string,
    userId: string,
    amount: number,
    opts: { now?: number; touchCooldown?: boolean } = {},
  ): { before: XpRow; after: XpRow } {
    const before: XpRow = this.getXp(guildId, userId) ?? {
      guild_id: guildId,
      user_id: userId,
      xp: 0,
      level: 0,
      last_xp_at_ms: 0,
    };
    const xp = before.xp + amount;
    const after: XpRow = {
      ...before,
      xp,
      level: levelFromTotalXp(xp).level,
      last_xp_at_ms:
        opts.touchCooldown === false
          ? before.last_xp_at_ms
          : (opts.now ?? Date.now()),
    };
    this.setXp(after);
    return { before, after };
  }

  setLevel(guildId: string, userId: string, level: number): void {
    this.db
      .prepare(
        "UPDATE xp_users SET level = ? WHERE guild_id = ? AND user_id = ?",
      )
      .run(level, guildId, userId);
  }

  topXp(guildId: string, limit: number): XpRow[] {
    return this.db
      .prepare(
        "SELECT guild_id, user_id, xp, level, last_xp_at_ms FROM xp_users WHERE guild_id = ? ORDER BY xp DESC LIMIT ?",
      )
      .all(guildId, limit) as unknown as XpRow[];
  }

  xpRank(guildId: string, userId: string): number | null {
    // A user with no XP row has no rank. The old query wrapped the
    // subquery in COALESCE(xp, 0), but a missing row makes the whole
    // scalar subquery NULL (COALESCE inside never sees a row), so
    // `xp > NULL` counted 0 users and everyone unranked showed 1st.
    const self = this.getXp(guildId, userId);
    if (!self) return null;
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM xp_users WHERE guild_id = ? AND xp > ?",
      )
      .get(guildId, self.xp) as { n: number } | undefined;
    return row ? row.n + 1 : null;
  }

  // --- level rewards ---

  // --- レベル報酬 ---
  getLevelRewards(guildId: string): LevelRewardRow[] {
    return this.db
      .prepare(
        "SELECT guild_id, level, role_id FROM level_rewards WHERE guild_id = ? ORDER BY level ASC",
      )
      .all(guildId) as unknown as LevelRewardRow[];
  }

  setLevelReward(guildId: string, level: number, roleId: string): void {
    this.db
      .prepare(
        `INSERT INTO level_rewards (guild_id, level, role_id) VALUES (?, ?, ?)
         ON CONFLICT(guild_id, level) DO UPDATE SET role_id = excluded.role_id`,
      )
      .run(guildId, level, roleId);
  }

  deleteLevelReward(guildId: string, level: number): void {
    this.db
      .prepare("DELETE FROM level_rewards WHERE guild_id = ? AND level = ?")
      .run(guildId, level);
  }

  // --- warns ---

  // --- 警告 ---
  addWarn(
    guildId: string,
    userId: string,
    moderatorId: string,
    reason: string,
    now = Date.now(),
  ): number {
    const info = this.db
      .prepare(
        "INSERT INTO warns (guild_id, user_id, moderator_id, reason, created_at_ms) VALUES (?, ?, ?, ?, ?)",
      )
      .run(guildId, userId, moderatorId, reason, now);
    return Number(info.lastInsertRowid);
  }

  listWarns(guildId: string, userId: string): WarnRow[] {
    return this.db
      .prepare(
        "SELECT id, guild_id, user_id, moderator_id, reason, created_at_ms FROM warns WHERE guild_id = ? AND user_id = ? ORDER BY created_at_ms DESC",
      )
      .all(guildId, userId) as unknown as WarnRow[];
  }

  countWarns(guildId: string, userId: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM warns WHERE guild_id = ? AND user_id = ?",
      )
      .get(guildId, userId) as { n: number };
    return row.n;
  }

  // --- mod log channel ---

  // --- モデレーションログ ---
  getModLog(guildId: string): string | null {
    const row = this.db
      .prepare("SELECT channel_id FROM mod_log WHERE guild_id = ?")
      .get(guildId) as { channel_id: string } | undefined;
    return row?.channel_id ?? null;
  }

  setModLog(guildId: string, channelId: string): void {
    this.db
      .prepare(
        `INSERT INTO mod_log (guild_id, channel_id, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(guild_id) DO UPDATE SET channel_id = excluded.channel_id, updated_at = excluded.updated_at`,
      )
      .run(guildId, channelId, new Date().toISOString());
  }

  deleteModLog(guildId: string): void {
    this.db.prepare("DELETE FROM mod_log WHERE guild_id = ?").run(guildId);
  }

  // --- polls ---

  // --- 投票 ---
  createPoll(poll: Omit<PollRow, "closed">): void {
    this.db
      .prepare(
        "INSERT INTO polls (id, guild_id, channel_id, message_id, question, options, ends_at_ms, created_by, closed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)",
      )
      .run(
        poll.id,
        poll.guild_id,
        poll.channel_id,
        poll.message_id,
        poll.question,
        JSON.stringify(poll.options),
        poll.ends_at_ms,
        poll.created_by,
      );
  }

  getPoll(id: string): PollRow | null {
    const row = this.db.prepare("SELECT * FROM polls WHERE id = ?").get(id) as
      Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      ...(row as unknown as PollRow),
      options: JSON.parse(String(row.options)) as string[],
    };
  }

  listOpenPolls(): PollRow[] {
    const rows = this.db
      .prepare("SELECT * FROM polls WHERE closed = 0 ORDER BY ends_at_ms")
      .all() as unknown as Record<string, unknown>[];
    return rows.map((r) => ({
      ...(r as unknown as PollRow),
      options: JSON.parse(String(r.options)) as string[],
    }));
  }

  closePoll(id: string): void {
    this.db.prepare("UPDATE polls SET closed = 1 WHERE id = ?").run(id);
  }

  setPollVote(pollId: string, userId: string, optionIdx: number): void {
    this.db
      .prepare(
        `INSERT INTO poll_votes (poll_id, user_id, option_idx) VALUES (?, ?, ?)
         ON CONFLICT(poll_id, user_id) DO UPDATE SET option_idx = excluded.option_idx`,
      )
      .run(pollId, userId, optionIdx);
  }

  pollVoteCounts(pollId: string, optionCount: number): number[] {
    const counts = new Array<number>(optionCount).fill(0);
    const rows = this.db
      .prepare(
        "SELECT option_idx, COUNT(*) AS n FROM poll_votes WHERE poll_id = ? GROUP BY option_idx",
      )
      .all(pollId) as unknown as Array<{ option_idx: number; n: number }>;
    for (const r of rows)
      if (r.option_idx >= 0 && r.option_idx < optionCount)
        counts[r.option_idx] = r.n;
    return counts;
  }

  pollTotalVotes(pollId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM poll_votes WHERE poll_id = ?")
      .get(pollId) as { n: number };
    return row.n;
  }

  // --- recruits ---

  // --- 募集 ---
  createRecruit(recruit: Omit<RecruitRow, "closed">): void {
    this.db
      .prepare(
        "INSERT INTO recruits (id, guild_id, channel_id, message_id, title, max_members, starts_at_ms, description, created_by, closed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
      )
      .run(
        recruit.id,
        recruit.guild_id,
        recruit.channel_id,
        recruit.message_id,
        recruit.title,
        recruit.max_members,
        recruit.starts_at_ms,
        recruit.description,
        recruit.created_by,
      );
  }

  getRecruit(id: string): RecruitRow | null {
    const row = this.db
      .prepare("SELECT * FROM recruits WHERE id = ?")
      .get(id) as RecruitRow | undefined;
    return row ?? null;
  }

  listOpenRecruits(): RecruitRow[] {
    return this.db
      .prepare("SELECT * FROM recruits WHERE closed = 0 ORDER BY starts_at_ms")
      .all() as unknown as RecruitRow[];
  }

  closeRecruit(id: string): void {
    this.db.prepare("UPDATE recruits SET closed = 1 WHERE id = ?").run(id);
  }

  addRecruitMember(recruitId: string, userId: string, now = Date.now()): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO recruit_members (recruit_id, user_id, joined_at_ms) VALUES (?, ?, ?)",
      )
      .run(recruitId, userId, now);
  }

  removeRecruitMember(recruitId: string, userId: string): void {
    this.db
      .prepare(
        "DELETE FROM recruit_members WHERE recruit_id = ? AND user_id = ?",
      )
      .run(recruitId, userId);
  }

  listRecruitMembers(recruitId: string): string[] {
    const rows = this.db
      .prepare(
        "SELECT user_id FROM recruit_members WHERE recruit_id = ? ORDER BY joined_at_ms",
      )
      .all(recruitId) as unknown as Array<{ user_id: string }>;
    return rows.map((r) => r.user_id);
  }

  // --- timers ---

  // --- タイマー ---
  createTimer(timer: TimerRow): void {
    this.db
      .prepare(
        "INSERT INTO timers (id, guild_id, channel_id, user_id, message, fires_at_ms, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        timer.id,
        timer.guild_id,
        timer.channel_id,
        timer.user_id,
        timer.message,
        timer.fires_at_ms,
        timer.created_at_ms,
      );
  }

  getTimer(id: string): TimerRow | null {
    const row = this.db.prepare("SELECT * FROM timers WHERE id = ?").get(id) as
      TimerRow | undefined;
    return row ?? null;
  }

  listTimers(guildId?: string): TimerRow[] {
    if (guildId) {
      return this.db
        .prepare("SELECT * FROM timers WHERE guild_id = ? ORDER BY fires_at_ms")
        .all(guildId) as unknown as TimerRow[];
    }
    return this.db
      .prepare("SELECT * FROM timers ORDER BY fires_at_ms")
      .all() as unknown as TimerRow[];
  }

  deleteTimer(id: string): void {
    this.db.prepare("DELETE FROM timers WHERE id = ?").run(id);
  }

  // --- 終了処理 ---
  close(): void {
    this.db.close();
  }
}
