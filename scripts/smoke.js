import assert from 'node:assert/strict';
const base = process.env.BASE_URL || 'http://127.0.0.1:3000';
const url = new URL('/api', base);
const get = await fetch(url, { signal: AbortSignal.timeout(20000) });
assert.equal(get.status, 200); assert.equal((await get.json()).status, 'ok');
const body = { version: '1.0', session: { session_id: 'setup-smoke-' + Date.now(), message_id: 0, new: true }, request: { type: 'SimpleUtterance', command: '' }, meta: { interfaces: {} } };
const post = async request => {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(25000) });
  assert.equal(r.status, 200); const data = await r.json();
  assert.equal(data.version, '1.0'); assert.equal(typeof data.response.text, 'string');
  assert.ok(Buffer.byteLength(JSON.stringify(data.session_state || {})) <= 1024);
  return { data, outcome: r.headers.get('X-Assistant-Outcome') };
};
await post(body);
const bad = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(bad.status, 400);
if (process.argv.includes('--live')) {
  const result = await post({ ...body, request: { type: 'SimpleUtterance', command: 'Ответь только числом: сколько будет 17 умножить на 23?' } });
  assert.equal(result.outcome, 'gemini'); assert.equal(result.data.response.text.trim(), '391');
  console.log('Live Gemini check passed');
}
console.log('Health, greeting, state and invalid request checks passed');
