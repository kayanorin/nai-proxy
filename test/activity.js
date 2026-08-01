import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActivityStore } from '../activity.js';
import { loadConfig } from '../config.js';

function assert(cond, msg) { if (!cond) throw new Error(msg); }

const dir = mkdtempSync(join(tmpdir(), 'nai-activity-'));
const path = join(dir, 'stats.sqlite');
const nowMs = Date.parse('2026-11-03T12:00:00Z');
const tokens = new Set(['west-token', 'east-token', 'utc-token']);
const profiles = new Map([
  ['west-token', { name: 'West', timeZone: 'America/Los_Angeles' }],
  ['east-token', { name: 'East', timeZone: 'Asia/Shanghai' }],
  ['utc-token', { name: 'UTC User', timeZone: 'UTC' }],
]);

try {
  let store = new ActivityStore({ dbPath: path, accessTokens: tokens, userProfiles: profiles, now: () => nowMs });
  // DST fall-back: both UTC instants are 01:30 in Los Angeles and must land in hour 1.
  store.record('west-token', { at: Date.parse('2026-11-01T08:30:00Z'), kind: 'generate', anlas: 7 });
  store.record('west-token', { at: Date.parse('2026-11-01T08:45:00Z'), kind: 'generate', anlas: 1 });
  store.record('west-token', { at: Date.parse('2026-11-01T09:30:00Z'), kind: 'encode-vibe', anlas: 2 });
  // 16:30 UTC is 00:30 the next day in Shanghai.
  store.record('east-token', { at: Date.parse('2026-11-02T16:30:00Z'), kind: 'generate', anlas: 5 });
  store.record('utc-token', { at: Date.parse('2026-11-02T12:30:00Z'), kind: 'generate', anlas: 3 });
  // Deliberately insert an expired bucket; reopening must perform startup retention cleanup.
  store.record('east-token', { at: Date.parse('2026-06-01T00:30:00Z'), kind: 'generate', anlas: 99 });
  const west = store.querySelf('west-token', 7);
  assert(west.hours[1].count === 3, `DST hour should contain 3, got ${west.hours[1].count}`);
  assert(west.totals.requests === 3 && west.totals.anlas === 10, 'West totals mismatch');
  const east = store.querySelf('east-token', 7);
  assert(east.hours[0].count === 1, 'Shanghai local hour should be 0');
  assert(store.querySelf('utc-token', 7).hours[12].count === 1, 'UTC local hour should be 12');
  const westRows = store.db.prepare('SELECT kind, request_count FROM activity_hourly WHERE user_id = ? ORDER BY kind').all(west.scope.id);
  assert(westRows.length === 2, 'Kinds should have separate rows');
  assert(westRows.some((r) => r.kind === 'generate' && r.request_count === 2), 'Same hour/kind should upsert');
  const all = store.queryAdmin(7, 'all');
  assert(all.totals.requests === 5 && all.users.length === 3, 'Admin aggregate mismatch');
  assert(all.hours[1].count === 3 && all.hours[0].count === 1 && all.hours[12].count === 1, 'Admin aggregate must use each user local timezone');
  store.close();

  store = new ActivityStore({ dbPath: path, accessTokens: tokens, userProfiles: profiles, now: () => nowMs });
  assert(store.queryAdmin(7, 'all').totals.requests === 5, 'History did not survive reopen');
  assert(store.db.prepare('SELECT COUNT(*) AS n FROM activity_hourly').get().n === 4, 'Startup retention did not delete expired rows');
  store.reset();
  assert(store.queryAdmin(7, 'all').totals.requests === 0, 'Reset did not clear history');
  store.close();

  const raw = readFileSync(path);
  assert(!raw.includes(Buffer.from('west-token')) && !raw.includes(Buffer.from('east-token')) && !raw.includes(Buffer.from('utc-token')), 'Raw access token leaked into SQLite');

  const springNow = Date.parse('2026-03-09T12:00:00Z');
  const spring = new ActivityStore({ dbPath: ':memory:', accessTokens: new Set(['west-token']), userProfiles: new Map([['west-token', profiles.get('west-token')]]), now: () => springNow });
  spring.record('west-token', { at: Date.parse('2026-03-08T09:30:00Z') }); // 01:30 PST
  spring.record('west-token', { at: Date.parse('2026-03-08T10:30:00Z') }); // 03:30 PDT
  const springHours = spring.querySelf('west-token', 7).hours;
  assert(springHours[1].count === 1 && springHours[2].count === 0 && springHours[3].count === 1, 'DST spring-forward mapping mismatch');
  spring.close();

  for (const [label, env] of [
    ['malformed JSON', { ACCESS_TOKENS: 'a', USER_PROFILES_JSON: '{' }],
    ['unknown token', { ACCESS_TOKENS: 'a', USER_PROFILES_JSON: '{"b":{"name":"B","timeZone":"UTC"}}' }],
    ['duplicate name', { ACCESS_TOKENS: 'a,b', USER_PROFILES_JSON: '{"a":{"name":"Same","timeZone":"UTC"},"b":{"name":"Same","timeZone":"UTC"}}' }],
    ['bad timezone', { ACCESS_TOKENS: 'a', USER_PROFILES_JSON: '{"a":{"name":"A","timeZone":"Moon/Base"}}' }],
  ]) {
    let threw = false;
    try { loadConfig(env); } catch { threw = true; }
    assert(threw, `Config should reject ${label}`);
  }
  console.log('✓ activity storage / timezone / persistence / privacy');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
