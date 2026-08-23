// resources.js — shared NovelAI resource accounting for friends on one account.
//
// NovelAI owns the physical balances. This store keeps a fair, durable virtual
// ledger on top: equal personal pools, a shared overflow pool, and borrow debt.
// Every reconciliation is constrained back to the authoritative account totals.

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const BATTERY_CAP = 100;
const EXPIRY_SHARE_WINDOW_MS = 72 * 60 * 60 * 1000;
const RESOURCES = ['battery', 'subscription', 'purchased'];

export function isV5Model(model) {
  return /^nai-diffusion-5-(?:full|curated)(?:-inpainting)?$/.test(String(model || ''));
}

export function isFreeV5Request(body) {
  if (!isV5Model(body?.model) || body?.action === 'infill') return false;
  const p = body?.parameters || {};
  const width = finite(p.width);
  const height = finite(p.height);
  const steps = finite(p.steps);
  const samples = Math.max(1, finite(p.n_samples) || 1);
  return samples === 1 && !p.image && width * height > 0 && width * height <= 1024 * 1024 && steps <= 28;
}

export class ResourceStore {
  constructor({ dbPath = ':memory:', accessTokens = new Set(), userProfiles = new Map(), now = () => Date.now() } = {}) {
    this.now = now;
    this.profilesByToken = new Map();
    this.profilesById = new Map();
    for (const token of accessTokens) {
      const configured = userProfiles.get(token);
      const id = createHash('sha256').update(token).digest('hex').slice(0, 16);
      const profile = { id, name: configured?.name || `User ${id.slice(0, 6)}` };
      this.profilesByToken.set(token, profile);
      this.profilesById.set(id, profile);
    }
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath, { timeout: 5000 });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS resource_users (
        user_id TEXT PRIMARY KEY,
        battery_balance REAL NOT NULL DEFAULT 0,
        battery_debt REAL NOT NULL DEFAULT 0,
        subscription_balance REAL NOT NULL DEFAULT 0,
        subscription_debt REAL NOT NULL DEFAULT 0,
        purchased_balance REAL NOT NULL DEFAULT 0,
        purchased_debt REAL NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS resource_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS resource_transactions (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        resource TEXT NOT NULL,
        amount REAL NOT NULL,
        personal REAL NOT NULL DEFAULT 0,
        shared REAL NOT NULL DEFAULT 0,
        borrowed REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        UNIQUE(job_id, resource)
      );
      CREATE INDEX IF NOT EXISTS idx_resource_tx_user_at ON resource_transactions(user_id, created_at);
    `);
    this._ensureUsers();
    this.state = this._readState();
  }

  _ensureUsers() {
    const insert = this.db.prepare(`
      INSERT INTO resource_users(user_id, updated_at) VALUES (?, ?)
      ON CONFLICT(user_id) DO NOTHING
    `);
    for (const id of this.profilesById.keys()) insert.run(id, this.now());
    if (this.profilesById.size) {
      const marks = [...this.profilesById.keys()].map(() => '?').join(',');
      this.db.prepare(`DELETE FROM resource_users WHERE user_id NOT IN (${marks})`).run(...this.profilesById.keys());
    }
  }

  _readState() {
    const rows = this.db.prepare('SELECT key, value FROM resource_state').all();
    const values = Object.fromEntries(rows.map((r) => {
      try { return [r.key, JSON.parse(r.value)]; } catch { return [r.key, null]; }
    }));
    return {
      initialized: !!values.initialized,
      members: Array.isArray(values.members) ? values.members : [],
      shared: normalizeBalances(values.shared),
      caps: normalizeBalances(values.caps),
      account: values.account || null,
      paidPaused: !!values.paidPaused,
    };
  }

  _writeState(key, value) {
    this.db.prepare(`
      INSERT INTO resource_state(key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(key, JSON.stringify(value), this.now());
  }

  _users() {
    return this.db.prepare('SELECT * FROM resource_users ORDER BY user_id').all();
  }

  reconcile(subscription) {
    if (!subscription) return this.snapshot();
    const next = normalizeAccount(subscription, this.now());
    const totals = accountTotals(next);
    const users = this._users();
    if (!users.length) return this.snapshot();

    const members = users.map((u) => u.user_id);
    const membershipChanged = members.length !== this.state.members.length
      || members.some((id, index) => id !== this.state.members[index]);
    if (!this.state.initialized || membershipChanged) {
      this._rebalance(totals, users);
      this.state.initialized = true;
      this.state.members = members;
      this.state.account = next;
      this._writeState('initialized', true);
      this._writeState('members', members);
      this._writeState('account', next);
      return this.snapshot();
    }

    for (const resource of RESOURCES) {
      const previous = finite(accountTotals(this.state.account)[resource]);
      const current = finite(totals[resource]);
      const delta = current - previous;
      this.state.caps[resource] = Math.max(finite(this.state.caps[resource]), current);
      if (delta > 1e-6) this._credit(resource, delta, users);
      else if (delta < -1e-6) this._externalDebit(resource, -delta, users);
      this._constrain(resource, current, users);
    }
    this.state.account = next;
    this._writeState('account', next);
    this._writeState('shared', this.state.shared);
    this._writeState('caps', this.state.caps);
    return this.snapshot();
  }

  _rebalance(totals, users = this._users()) {
    const n = users.length || 1;
    const update = this.db.prepare(`UPDATE resource_users SET
      battery_balance=?, battery_debt=0,
      subscription_balance=?, subscription_debt=0,
      purchased_balance=?, purchased_debt=0,
      updated_at=? WHERE user_id=?`);
    const shares = Object.fromEntries(RESOURCES.map((r) => [r, finite(totals[r]) / n]));
    for (const u of users) update.run(shares.battery, shares.subscription, shares.purchased, this.now(), u.user_id);
    this.state.shared = normalizeBalances();
    this.state.caps = { ...totals };
    this._writeState('shared', this.state.shared);
    this._writeState('caps', this.state.caps);
  }

  rebuild(subscription) {
    const next = normalizeAccount(subscription, this.now());
    this._rebalance(accountTotals(next));
    this.state.initialized = true;
    this.state.members = this._users().map((u) => u.user_id);
    this.state.account = next;
    this._writeState('initialized', true);
    this._writeState('members', this.state.members);
    this._writeState('account', next);
    return this.snapshot();
  }

  _credit(resource, amount, users) {
    let left = amount;
    const debtCol = `${resource}_debt`;
    const balanceCol = `${resource}_balance`;
    const cap = resource === 'battery'
      ? BATTERY_CAP / users.length
      : Math.max(finite(this.state.caps[resource]), finite(accountTotals(this.state.account)[resource]) + amount) / users.length;
    const update = this.db.prepare(`UPDATE resource_users SET ${balanceCol}=?, ${debtCol}=?, updated_at=? WHERE user_id=?`);

    for (const u of [...users].sort((a, b) => finite(b[debtCol]) - finite(a[debtCol]))) {
      if (left <= 1e-6) break;
      const paid = Math.min(left, finite(u[debtCol]));
      if (!paid) continue;
      u[debtCol] -= paid;
      u[balanceCol] += paid;
      left -= paid;
      update.run(u[balanceCol], u[debtCol], this.now(), u.user_id);
    }
    while (left > 1e-6) {
      const eligible = users.filter((u) => finite(u[balanceCol]) < cap - 1e-6);
      if (!eligible.length) break;
      const each = left / eligible.length;
      let used = 0;
      for (const u of eligible) {
        const add = Math.min(each, cap - finite(u[balanceCol]));
        u[balanceCol] += add;
        used += add;
        update.run(u[balanceCol], u[debtCol], this.now(), u.user_id);
      }
      if (used <= 1e-6) break;
      left -= used;
    }
    this.state.shared[resource] += Math.max(0, left);
  }

  _externalDebit(resource, amount, users) {
    let left = amount;
    const balanceCol = `${resource}_balance`;
    const fromShared = Math.min(left, this.state.shared[resource]);
    this.state.shared[resource] -= fromShared;
    left -= fromShared;
    if (left <= 1e-6) return;
    const total = users.reduce((s, u) => s + finite(u[balanceCol]), 0);
    const update = this.db.prepare(`UPDATE resource_users SET ${balanceCol}=?, updated_at=? WHERE user_id=?`);
    for (const u of users) {
      const take = total > 0 ? Math.min(finite(u[balanceCol]), left * finite(u[balanceCol]) / total) : 0;
      u[balanceCol] -= take;
      update.run(u[balanceCol], this.now(), u.user_id);
    }
  }

  _constrain(resource, authoritativeTotal, users = this._users()) {
    const balanceCol = `${resource}_balance`;
    const ledger = this.state.shared[resource] + users.reduce((s, u) => s + finite(u[balanceCol]), 0);
    const diff = authoritativeTotal - ledger;
    if (diff > 1e-5) this._credit(resource, diff, users);
    else if (diff < -1e-5) this._externalDebit(resource, -diff, users);
  }

  safetyFloor() {
    const users = Math.max(1, this.profilesById.size);
    const recent = this.db.prepare(`
      SELECT amount FROM resource_transactions
      WHERE resource='battery' AND amount > 0 AND created_at >= ? ORDER BY amount
    `).all(this.now() - 30 * 86_400_000).map((r) => finite(r.amount));
    const p95 = recent.length ? recent[Math.min(recent.length - 1, Math.floor(recent.length * 0.95))] : 1;
    return Math.min(20, Math.max(1, p95) * users);
  }

  canUseBattery(token, estimated = 1) {
    const user = this._userForToken(token);
    const total = finite(this.state.account?.usage?.chargePercent);
    if (!user || this.state.account?.usage?.isNegative || total <= 0) return { ok: false, reason: 'empty' };
    const own = finite(user.battery_balance);
    const floor = this.safetyFloor();
    if (own >= estimated) return { ok: true, source: 'personal', floor };
    if (total - estimated >= floor) return { ok: true, source: 'shared', floor };
    return { ok: false, reason: 'reserved', floor };
  }

  canSpendAnlas(token, amount) {
    if (this.state.paidPaused) return { ok: false, reason: 'paused' };
    const view = this.forToken(token);
    const available = view.anlas.subscription.personal + view.anlas.subscription.shared
      + view.anlas.purchased.personal + view.anlas.purchased.shared;
    return { ok: available + 1e-6 >= amount, available, reason: available >= amount ? null : 'insufficient' };
  }

  fairnessPriority(token, resource = 'battery') {
    const user = this._userForToken(token);
    if (!user) return Number.POSITIVE_INFINITY;
    const since = this.now() - 30 * 86_400_000;
    const recent = this.db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS total FROM resource_transactions
      WHERE user_id=? AND resource=? AND created_at>=?
    `).get(user.user_id, resource, since);
    const cap = Math.max(1, finite(this.state.caps[resource]));
    return finite(user[`${resource}_debt`]) + finite(recent?.total) / cap;
  }

  settle(job, { battery = 0, subscription = 0, purchased = 0 } = {}) {
    const result = {};
    if (!job?.token || !job?.id) return result;
    if (battery > 0) result.battery = this._spend(job.token, 'battery', battery, job.id);
    if (subscription > 0) result.subscription = this._spend(job.token, 'subscription', subscription, job.id);
    if (purchased > 0) result.purchased = this._spend(job.token, 'purchased', purchased, job.id);
    return result;
  }

  settleAuthoritative(job, beforeValue, afterValue) {
    const before = normalizeAccount(beforeValue, this.now());
    const after = normalizeAccount(afterValue, this.now());
    const batteryObserved = Math.max(0, finite(before.usage.chargePercent) - finite(after.usage.chargePercent));
    const battery = job?.billingMode === 'v5-battery' ? Math.max(0.25, batteryObserved) : 0;
    const subscription = Math.max(0, finite(before.anlas.subscription) - finite(after.anlas.subscription));
    const purchased = Math.max(0, finite(before.anlas.purchased) - finite(after.anlas.purchased));
    const settled = this.settle(job, { battery, subscription, purchased });
    this.state.account = after;
    const totals = accountTotals(after);
    for (const resource of RESOURCES) this._constrain(resource, totals[resource]);
    this._writeState('account', after);
    this._writeState('shared', this.state.shared);
    return {
      battery,
      batteryBorrowed: finite(settled.battery?.borrowed),
      subscription,
      subscriptionBorrowed: finite(settled.subscription?.borrowed),
      purchased,
      purchasedBorrowed: finite(settled.purchased?.borrowed),
      anlas: subscription + purchased,
    };
  }

  _spend(token, resource, amount, jobId) {
    const profile = this.profilesByToken.get(token);
    if (!profile || amount <= 0) return null;
    const existing = this.db.prepare('SELECT 1 FROM resource_transactions WHERE job_id=? AND resource=?').get(jobId, resource);
    if (existing) return null;
    const users = this._users();
    const user = users.find((u) => u.user_id === profile.id);
    const balanceCol = `${resource}_balance`;
    const debtCol = `${resource}_debt`;
    let left = amount;
    const personal = Math.min(left, finite(user[balanceCol]));
    user[balanceCol] -= personal;
    left -= personal;
    const shared = Math.min(left, this.state.shared[resource]);
    this.state.shared[resource] -= shared;
    left -= shared;
    let borrowed = 0;
    if (left > 1e-6) {
      const lenders = users.filter((u) => u.user_id !== user.user_id && finite(u[balanceCol]) > 0);
      for (const lender of lenders) {
        if (left <= 1e-6) break;
        const take = Math.min(left, finite(lender[balanceCol]));
        lender[balanceCol] -= take;
        left -= take;
        borrowed += take;
        this.db.prepare(`UPDATE resource_users SET ${balanceCol}=?, updated_at=? WHERE user_id=?`).run(lender[balanceCol], this.now(), lender.user_id);
      }
      user[debtCol] += borrowed;
    }
    this.db.prepare(`UPDATE resource_users SET ${balanceCol}=?, ${debtCol}=?, updated_at=? WHERE user_id=?`)
      .run(Math.max(0, user[balanceCol]), user[debtCol], this.now(), user.user_id);
    this._writeState('shared', this.state.shared);
    this.db.prepare(`INSERT INTO resource_transactions(id, job_id, user_id, resource, amount, personal, shared, borrowed, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), jobId, user.user_id, resource, amount - Math.max(0, left), personal, shared, borrowed, this.now());
    return { amount: amount - Math.max(0, left), personal, shared, borrowed };
  }

  setPaidPaused(value) {
    this.state.paidPaused = !!value;
    this._writeState('paidPaused', this.state.paidPaused);
  }

  forToken(token) {
    const user = this._userForToken(token);
    if (!user) return null;
    const expiryMs = finite(this.state.account?.expiresAt) * 1000;
    const useItOrLoseIt = expiryMs > 0 && expiryMs - this.now() <= EXPIRY_SHARE_WINDOW_MS;
    const subscriptionShared = finite(this.state.shared.subscription)
      + (useItOrLoseIt ? this._otherBalances('subscription', user.user_id) : 0);
    const freeGate = this.canUseBattery(token, 1);
    const batteryPercent = finite(this.state.account?.usage?.percent);
    const nextPercentSeconds = finite(this.state.account?.usage?.timeUntilNextPercent);
    const remainingWholePercents = Math.max(0, Math.ceil(100 - batteryPercent) - 1);
    const estimatedFullAt = batteryPercent >= 100
      ? new Date(this.now()).toISOString()
      : new Date(this.now() + (nextPercentSeconds + remainingWholePercents * 6048) * 1000).toISOString();
    return {
      generatedAt: new Date(this.now()).toISOString(),
      v5: {
        chargePercent: finite(this.state.account?.usage?.chargePercent),
        percent: finite(this.state.account?.usage?.percent),
        isNegative: !!this.state.account?.usage?.isNegative,
        timeUntilNextPercent: finite(this.state.account?.usage?.timeUntilNextPercent),
        estimatedFullAt,
        personal: finite(user.battery_balance),
        shared: finite(this.state.shared.battery),
        borrowed: finite(user.battery_debt),
        safetyFloor: this.safetyFloor(),
        canGenerateFree: freeGate.ok,
        blockedReason: freeGate.ok ? null : freeGate.reason,
      },
      anlas: {
        subscription: {
          personal: useItOrLoseIt ? 0 : finite(user.subscription_balance),
          shared: subscriptionShared + (useItOrLoseIt ? finite(user.subscription_balance) : 0),
          borrowed: finite(user.subscription_debt),
        },
        purchased: {
          personal: finite(user.purchased_balance),
          shared: finite(this.state.shared.purchased),
          borrowed: finite(user.purchased_debt),
        },
        paidPaused: this.state.paidPaused,
      },
      subscription: {
        active: !!this.state.account?.active,
        tier: this.state.account?.tier ?? null,
        expiresAt: expiryMs ? new Date(expiryMs).toISOString() : null,
        useItOrLoseIt,
      },
    };
  }

  snapshot() {
    return {
      generatedAt: new Date(this.now()).toISOString(),
      account: this.state.account,
      shared: { ...this.state.shared },
      caps: { ...this.state.caps },
      paidPaused: this.state.paidPaused,
      safetyFloor: this.safetyFloor(),
      users: this._users().map((u) => ({
        id: u.user_id,
        name: this.profilesById.get(u.user_id)?.name || u.user_id,
        battery: { personal: finite(u.battery_balance), borrowed: finite(u.battery_debt) },
        subscription: { personal: finite(u.subscription_balance), borrowed: finite(u.subscription_debt) },
        purchased: { personal: finite(u.purchased_balance), borrowed: finite(u.purchased_debt) },
      })),
    };
  }

  _userForToken(token) {
    const id = this.profilesByToken.get(token)?.id;
    return id ? this.db.prepare('SELECT * FROM resource_users WHERE user_id=?').get(id) : null;
  }

  _otherBalances(resource, userId) {
    const col = `${resource}_balance`;
    return this._users().filter((u) => u.user_id !== userId).reduce((s, u) => s + finite(u[col]), 0);
  }

  close() {
    if (this.db?.isOpen) this.db.close();
  }
}

export function normalizeSubscriptionResponse(value, now = Date.now()) {
  return normalizeAccount(value, now);
}

function normalizeAccount(value, now) {
  const subscription = value || {};
  const fixed = finite(subscription?.trainingStepsLeft?.fixedTrainingStepsLeft);
  const purchased = finite(subscription?.trainingStepsLeft?.purchasedTrainingSteps);
  const percent = clamp(finite(subscription?.usage?.percent), 0, 100);
  const nextSeconds = Math.max(0, finite(subscription?.usage?.timeUntilNextPercent));
  // Full refill is approximately seven days, therefore one percentage point is
  // roughly 6048 seconds. The API's next-percent countdown lets us retain the
  // useful fractional part without pretending it is exact billing data.
  const fraction = percent >= 100 ? 0 : clamp(1 - nextSeconds / 6048, 0, 0.999999);
  return {
    active: !!subscription.active,
    tier: subscription.tier ?? null,
    expiresAt: finite(subscription.expiresAt),
    usage: {
      percent,
      chargePercent: clamp(percent + fraction, 0, 100),
      isNegative: !!subscription?.usage?.isNegative,
      timeUntilNextPercent: nextSeconds,
    },
    anlas: { subscription: fixed, purchased, total: fixed + purchased },
    fetchedAt: now,
  };
}

function accountTotals(account) {
  return {
    battery: finite(account?.usage?.chargePercent),
    subscription: finite(account?.anlas?.subscription),
    purchased: finite(account?.anlas?.purchased),
  };
}

function normalizeBalances(value = {}) {
  return Object.fromEntries(RESOURCES.map((r) => [r, Math.max(0, finite(value?.[r]))]));
}

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
