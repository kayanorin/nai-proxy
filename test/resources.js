import assert from 'node:assert/strict';
import { ResourceStore, isFreeV5Request } from '../resources.js';

let now = Date.parse('2026-08-23T12:00:00Z');
const tokens = new Set(['alice-token', 'bob-token']);
const profiles = new Map([
  ['alice-token', { name: 'Alice', timeZone: 'UTC' }],
  ['bob-token', { name: 'Bob', timeZone: 'UTC' }],
]);

function subscription({ battery = 100, fixed = 10000, purchased = 2000, expiresIn = 30 * 86_400_000 } = {}) {
  return {
    active: true,
    tier: 3,
    expiresAt: Math.floor((now + expiresIn) / 1000),
    usage: { percent: battery, isNegative: battery <= 0, timeUntilNextPercent: battery >= 100 ? 0 : 6048 },
    trainingStepsLeft: { fixedTrainingStepsLeft: fixed, purchasedTrainingSteps: purchased },
  };
}

const store = new ResourceStore({ dbPath: ':memory:', accessTokens: tokens, userProfiles: profiles, now: () => now });
store.reconcile(subscription());

assert.equal(store.forToken('alice-token').v5.personal, 50, 'battery should initialize equally');
assert.equal(store.forToken('bob-token').anlas.subscription.personal, 5000, 'subscription Anlas should initialize equally');
assert.equal(store.forToken('alice-token').anlas.purchased.personal, 1000, 'purchased Anlas should initialize equally');

store.settle({ id: 'battery-job-1', token: 'alice-token' }, { battery: 55 });
let alice = store.forToken('alice-token');
let bob = store.forToken('bob-token');
assert.equal(alice.v5.personal, 0, 'personal pool should be spent first');
assert.equal(alice.v5.borrowed, 5, 'borrowed battery should become debt');
assert.equal(bob.v5.personal, 45, 'idle friend pool should be lendable');

store.reconcile(subscription({ battery: 50 }));
alice = store.forToken('alice-token');
assert(alice.v5.borrowed <= 5, 'reconciliation must not increase debt');

store.rebuild(subscription({ fixed: 100, purchased: 20, expiresIn: 60 * 60 * 1000 }));
alice = store.forToken('alice-token');
assert.equal(alice.subscription.useItOrLoseIt, true, 'last 72 hours should release subscription reserves');
assert.equal(alice.anlas.subscription.personal, 0, 'expiring personal subscription pool should be shared');
assert.equal(alice.anlas.subscription.shared, 100, 'all expiring subscription Anlas should be available');

assert.equal(isFreeV5Request({
  model: 'nai-diffusion-5-full',
  action: 'generate',
  parameters: { width: 1024, height: 1024, steps: 28, n_samples: 1 },
}), true);
assert.equal(isFreeV5Request({
  model: 'nai-diffusion-5-full',
  action: 'generate',
  parameters: { width: 1024, height: 1024, steps: 29, n_samples: 1 },
}), false);

store.close();
console.log('✓ resource ledger tests');
