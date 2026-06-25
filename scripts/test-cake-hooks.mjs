/**
 * test-cake-hooks.mjs
 * Sends "Give me 5 hooks for my cake business" 3 times, applies hookValidator
 * to each response, and reports whether violations are gone.
 *
 * Usage: node scripts/test-cake-hooks.mjs
 */

import { applyHookCorrections, isHookBlock } from '../artifacts/ib-ai-v2/src/utils/hookValidator.js';

const API = 'http://localhost:8099';
const PROMPT = 'Give me 5 hooks for my cake business';
const RUNS = 3;

// ── Auth ──────────────────────────────────────────────────────────────────────
async function login() {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'ibaiceo', password: process.env.CEO_PASSWORD }),
  });
  const body = await res.json();
  return body.token ?? body.data?.token ?? null;
}

// ── Chat (handles both JSON and SSE stream) ───────────────────────────────────
async function chat(token, userMessage) {
  const res = await fetch(`${API}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: userMessage }],
    }),
    signal: AbortSignal.timeout(45_000),
  });

  const raw = await res.text();

  // Try plain JSON first
  try {
    const j = JSON.parse(raw);
    return j.content ?? j.message ?? j.reply ?? '';
  } catch {
    // SSE stream — accumulate data: lines
    return raw
      .split('\n')
      .filter(l => l.startsWith('data:') && !l.includes('[DONE]'))
      .map(l => { try { return JSON.parse(l.slice(5)).content ?? ''; } catch { return ''; } })
      .join('');
  }
}

// ── Detect banned openers in raw text (for reporting) ────────────────────────
const BANNED = ['imagine', 'have you ever', 'picture yourself', 'what if you could',
  'what if ', 'close your eyes', 'what would it feel', 'dream of', 'envision', 'think about'];

function findRawViolations(content) {
  const violations = [];
  for (const line of content.split('\n')) {
    const stripped = line.replace(/^\s*(?:\*{1,2})?(?:\d+[\.\)\-]\s*)?(?:\*{1,2})?[\w-]+(?:\*{1,2})?:?\s*(?:\*{1,2})?/, '').trim().toLowerCase();
    for (const banned of BANNED) {
      if (stripped.startsWith(banned) && !/[a-z]/.test(stripped[banned.length] ?? '')) {
        violations.push({ line: line.trim().slice(0, 80), opener: banned });
        break;
      }
    }
  }
  return violations;
}

// ── Main ──────────────────────────────────────────────────────────────────────
console.log('Authenticating...');
const token = await login();
if (!token) { console.error('Login failed — check CEO_PASSWORD'); process.exit(1); }
console.log(`Token OK (${token.length} chars)\n`);

let totalRawViolations = 0;
let totalCorrected = 0;

for (let i = 1; i <= RUNS; i++) {
  console.log(`${'━'.repeat(60)}`);
  console.log(`RUN ${i} — "${PROMPT}"`);
  console.log('━'.repeat(60));

  const content = await chat(token, PROMPT);
  if (!content) { console.log('  ⚠️  Empty response'); continue; }

  const detected = isHookBlock(content);
  const rawViols = findRawViolations(content);
  const { content: fixed, corrections } = applyHookCorrections(content);

  console.log(`\n[RAW MODEL OUTPUT]\n${content}\n`);
  console.log(`[isHookBlock] ${detected ? '✅ detected' : '⚠️  not detected as hook block'}`);
  if (rawViols.length > 0) {
    console.log(`[RAW VIOLATIONS] ${rawViols.length} found:`);
    rawViols.forEach(v => console.log(`  ⚠️  "${v.opener}" opener in: "${v.line}"`));
    totalRawViolations += rawViols.length;
  } else {
    console.log('[RAW VIOLATIONS] none — model output is clean');
  }
  if (corrections.length > 0) {
    console.log(`[VALIDATOR] ${corrections.length} correction(s) applied:`);
    corrections.forEach(c => console.log(`  ✂️  "${c.original.slice(0, 50)}" → "${c.fixed.slice(0, 50)}" (${c.reasons.join(', ')})`));
    totalCorrected += corrections.length;
  } else if (detected) {
    console.log('[VALIDATOR] ✅ no corrections needed');
  } else {
    console.log('[VALIDATOR] ⚠️  format not detected — validator not applied');
  }
  console.log('');

  if (i < RUNS) await new Promise(r => setTimeout(r, 4000));
}

console.log('━'.repeat(60));
console.log('SUMMARY');
console.log('━'.repeat(60));
console.log(`Raw model violations found : ${totalRawViolations}`);
console.log(`Validator corrections made : ${totalCorrected}`);
console.log(`Violations surviving output: ${Math.max(0, totalRawViolations - totalCorrected)}`);
if (totalRawViolations === 0) {
  console.log('\n✅ CLEAN — model produced no violations in any run');
} else if (totalCorrected >= totalRawViolations) {
  console.log('\n✅ VALIDATOR caught all violations — output to user is clean');
} else {
  console.log('\n⚠️  Some violations may reach the user — check format detection');
}
