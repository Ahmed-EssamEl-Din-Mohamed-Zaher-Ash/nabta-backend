// Automated API integration test: creates the RBAC test accounts through the
// real HTTP API and proves POST /api/users rejects unauthorized callers.
//
// Usage:  node scripts/create-test-users.js
// Env:    API_URL              (default http://localhost:4000)
//         TEST_ADMIN_EMAIL / TEST_ADMIN_PASSWORD
//                              (default: ADMIN_EMAIL / ADMIN_PASSWORD from .env)

import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });

const BASE_URL = process.env.API_URL || 'http://localhost:4000';
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL || process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD;
const TEST_PASSWORD = 'password123';

// Role values must match STAFF_ROLES in src/controllers/userController.ts
const TEST_USERS = [
  { email: 'sales@example.com',      name: 'Sales User',      role: 'sales' },
  { email: 'account@example.com',    name: 'Account Manager', role: 'account' },
  { email: 'ops@example.com',        name: 'Operations User', role: 'ops' },
  { email: 'accounting@example.com', name: 'Accounting User', role: 'finance' },
  { email: 'driver@example.com',     name: 'Driver User',     role: 'driver' },
];

let failures = 0;

const ok = (msg) => console.log(`  ✅ ${msg}`);
const warn = (msg) => console.log(`  ⚠️  ${msg}`);
const fail = (msg) => { failures += 1; console.log(`  ❌ ${msg}`); };

async function api(path, { token, ...init } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON response */ }
  return { status: res.status, body };
}

async function login(email, password) {
  const { status, body } = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  return { status, token: body?.token ?? null, error: body?.error };
}

function createUser(token, user) {
  return api('/api/users', {
    method: 'POST',
    token,
    body: JSON.stringify({ ...user, password: TEST_PASSWORD, active: true }),
  });
}

async function main() {
  console.log(`\nRBAC integration test — ${BASE_URL}\n`);

  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.error('❌ ADMIN_EMAIL / ADMIN_PASSWORD not found in backend/.env (and no TEST_ADMIN_* overrides set).');
    process.exit(1);
  }

  // ── Step 1: authenticate as admin ──────────────────────────────────────
  console.log(`[1/3] Logging in as admin (${ADMIN_EMAIL})...`);
  let adminToken;
  try {
    const result = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    if (result.status !== 200 || !result.token) {
      fail(`Admin login failed (HTTP ${result.status}): ${result.error ?? 'no token in response'}`);
      if (result.status === 401) {
        console.log('     Hint: seed the admin account first  →  npx prisma db seed');
      }
      process.exit(1);
    }
    adminToken = result.token;
    ok('Admin JWT received.');
  } catch (err) {
    console.error(`  ❌ Could not reach the API: ${err.cause?.code ?? err.message}`);
    console.log('     Is the backend running?  →  npm run dev  (in new/backend)');
    process.exit(1);
  }

  // ── Step 2: create the 5 role accounts ─────────────────────────────────
  console.log('\n[2/3] Creating test users via POST /api/users...');
  for (const user of TEST_USERS) {
    const { status, body } = await createUser(adminToken, user);
    if (status === 201) {
      ok(`${user.email}  (role: ${body.user.role}, id: ${body.user.id})`);
    } else if (status === 409) {
      warn(`${user.email}  already exists — skipped (re-run is fine)`);
    } else {
      fail(`${user.email}  HTTP ${status}: ${body?.error ?? 'unknown error'}`);
    }
  }

  // ── Step 3: prove the route rejects unauthorized callers ───────────────
  console.log('\n[3/3] Security assertions on POST /api/users...');
  const intruder = { name: 'Intruder', email: 'intruder@example.com', role: 'admin' };

  const assertStatus = (label, actual, expected) => {
    if (actual === expected) ok(`PASS  ${label} → HTTP ${actual} (expected ${expected})`);
    else fail(`FAIL  ${label} → HTTP ${actual} (expected ${expected})`);
  };

  const noToken = await createUser(null, intruder);
  assertStatus('no token         ', noToken.status, 401);

  const badToken = await createUser('not-a-real-jwt', intruder);
  assertStatus('garbage token    ', badToken.status, 401);

  const salesLogin = await login('sales@example.com', TEST_PASSWORD);
  if (salesLogin.token) {
    const nonAdmin = await createUser(salesLogin.token, intruder);
    assertStatus('non-admin (sales)', nonAdmin.status, 403);
  } else {
    fail(`could not log in as sales@example.com to test the non-admin case (HTTP ${salesLogin.status})`);
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log(`\n${failures === 0 ? '✅ All checks passed.' : `❌ ${failures} check(s) failed.`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
