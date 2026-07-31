// activity.js — durable, privacy-preserving hourly activity aggregates.

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DAY_MS = 86_400_000;
const VALID_DAYS = new Set([7, 30, 90]);

export class ActivityStore {
  constructor({ dbPath = ':memory:', retentionDays = 90, accessTokens = new Set(), userProfiles = new Map(), now = () => Date.now() } = {}) {
    this.now = now;
    this.retentionDays = retentionDays;
    this.profilesByToken = new Map();
    this.profilesById = new Map();
    this.formatters = new Map();
    this.lastCleanupAt = 0;

    for (const token of accessTokens) {
      const configured = userProfiles.get(token);
      const id = createHash('sha256').update(token).digest('hex').slice(0, 16);
      const profile = configured
        ? { id, name: configured.name, timeZone: configured.timeZone }
        : { id, name: `User ${id.slice(0, 6)}`, timeZone: 'UTC' };
      if (!configured) console.warn(`[activity] ${profile.name} has no USER_PROFILES_JSON entry; using UTC`);
      this.profilesByToken.set(token, profile);
      this.profilesById.set(id, profile);
    }

    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath, { timeout: 5000 });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS activity_hourly (
        user_id TEXT NOT NULL,
        bucket_utc INTEGER NOT NULL,
        kind TEXT NOT NULL,
        request_count INTEGER NOT NULL DEFAULT 0,
        anlas REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, bucket_utc, kind)
      );
      CREATE INDEX IF NOT EXISTS idx_activity_bucket ON activity_hourly(bucket_utc);
    `);
    this.upsert = this.db.prepare(`
      INSERT INTO activity_hourly(user_id, bucket_utc, kind, request_count, anlas)
      VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(user_id, bucket_utc, kind) DO UPDATE SET
        request_count = request_count + 1,
        anlas = anlas + excluded.anlas
    `);
    this.cleanup(true);
  }

  static validDays(value) {
    const days = Number(value);
    return VALID_DAYS.has(days) ? days : null;
  }

  record(token, { at, kind = 'generate', anlas = 0 } = {}) {
    const profile = this.profilesByToken.get(token);
    if (!profile) return false;
    const time = Number(at) || this.now();
    const bucket = Math.floor(time / 3_600_000) * 3_600_000;
    this.upsert.run(profile.id, bucket, kind, Number(anlas) || 0);
    this.cleanup();
    return true;
  }

  querySelf(token, days) {
    const profile = this.profilesByToken.get(token);
    return profile ? this._query(days, profile.id) : null;
  }

  profileForToken(token) {
    const p = this.profilesByToken.get(token);
    return p ? { id: p.id, name: p.name, timeZone: p.timeZone } : null;
  }

  queryAdmin(days, userId = 'all') {
    if (userId !== 'all' && !this.profilesById.has(userId)) return null;
    return this._query(days, userId, true);
  }

  _query(days, userId, includeUsers = false) {
    const now = this.now();
    const from = now - days * DAY_MS;
    const rows = userId === 'all'
      ? this.db.prepare('SELECT user_id, bucket_utc, request_count, anlas FROM activity_hourly WHERE bucket_utc >= ?').all(from)
      : this.db.prepare('SELECT user_id, bucket_utc, request_count, anlas FROM activity_hourly WHERE user_id = ? AND bucket_utc >= ?').all(userId, from);
    const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }));
    let requests = 0;
    let anlas = 0;
    for (const row of rows) {
      const profile = this.profilesById.get(row.user_id);
      if (!profile) continue;
      const hour = this._localHour(row.bucket_utc, profile.timeZone);
      hours[hour].count += Number(row.request_count) || 0;
      requests += Number(row.request_count) || 0;
      anlas += Number(row.anlas) || 0;
    }
    const profile = userId === 'all' ? null : this.profilesById.get(userId);
    const out = {
      generatedAt: new Date(now).toISOString(),
      range: { days, from: new Date(from).toISOString(), to: new Date(now).toISOString() },
      scope: profile
        ? { id: profile.id, name: profile.name, timeZone: profile.timeZone }
        : { id: 'all', name: 'All users', timeZone: 'local-per-user' },
      totals: { requests, anlas },
      hours,
    };
    if (includeUsers) {
      out.users = [...this.profilesById.values()].map((p) => ({ id: p.id, name: p.name, timeZone: p.timeZone }));
    }
    return out;
  }

  _localHour(timestamp, timeZone) {
    let fmt = this.formatters.get(timeZone);
    if (!fmt) {
      fmt = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hourCycle: 'h23' });
      this.formatters.set(timeZone, fmt);
    }
    const part = fmt.formatToParts(new Date(timestamp)).find((p) => p.type === 'hour');
    return Number(part?.value) % 24;
  }

  cleanup(force = false) {
    const now = this.now();
    if (!force && now - this.lastCleanupAt < DAY_MS) return;
    this.lastCleanupAt = now;
    this.db.prepare('DELETE FROM activity_hourly WHERE bucket_utc < ?').run(now - this.retentionDays * DAY_MS);
  }

  reset() {
    this.db.exec('DELETE FROM activity_hourly');
  }

  close() {
    if (this.db?.isOpen) this.db.close();
  }
}
