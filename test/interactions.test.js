import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { answerAlice, sealState, verifyState, cleanText, packHistory, readHistory, MODEL } from '../lib/assistant.js';
import handler from '../api/index.js';
import { FAST_MODEL } from '../lib/fast.js';
const env = { GEMINI_API_KEY: 'private-gemini', SERPER_API_KEY: 'private-serper' }, logger = { info() {} };
const req = (command = 'Вопрос', state = {}) => ({ version: '1.0', session: { session_id: 'test-session', message_id: 1, new: false }, request: { type: 'SimpleUtterance', command }, meta: { interfaces: { screen: {} } }, state: { session: state } });
const ok = data => ({ ok: true, json: async () => data });
const done = (text = 'Ответ.', id = 'interaction_done') => ({ id, status: 'completed', model: MODEL, steps: [{ type: 'model_output', content: [{ type: 'text', text }] }] });
const opts = fetcher => ({ env, logger, fetcher });
const signed = value => sealState(value, 'test-session', env.GEMINI_API_KEY);

test('latest Gemini is primary and uses supported Interactions configuration', async () => {
 let metrics;
 const out = await answerAlice(req('17 умножить на 23'), { ...opts(async (url, options) => {
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
  const b = JSON.parse(options.body);
  assert.equal(b.model, MODEL); assert.equal(b.background, true); assert.equal(b.store, true);
  assert.equal(b.generation_config.thinking_level, 'low'); assert.equal(b.input, '17 умножить на 23');
  assert.match(b.system_instruction, /Приоритеты: точность/);
  return ok(done('391'));
 }), onMetrics: m => { metrics = m; } });
 assert.equal(out.response.text, '391'); assert.equal(metrics.outcome, 'gemini');
 assert.equal(verifyState(out.session_state, 'test-session', env.GEMINI_API_KEY).c, 'interaction_done');
});
test('pending task survives independent request and poll gets result without regeneration', async () => {
 const first = await answerAlice(req(), { ...opts(async () => ok({ id: 'pending_task', status: 'in_progress' })), timeoutMs: 80 });
 assert.match(first.response.text, /Готовлю/); assert.equal(first.response.buttons[0].title, 'Готово?');
 let calls = 0;
 const second = await answerAlice(req('готово?', first.session_state), opts(async (url, options) => {
  calls++; assert.equal(options.method, 'GET'); assert.ok(url.endsWith('/pending_task')); return ok(done('Результат готов.', 'pending_task'));
 }));
 assert.equal(second.response.text, 'Результат готов.'); assert.equal(calls, 1);
});
test('in-progress tasks use one upstream call per voice request', async () => {
 for (const state of [{}, signed({ p: 'pending_task', t: Date.now() })]) {
  let calls = 0;
  const out = await answerAlice(req(state.p ? 'готово?' : 'Вопрос', state), opts(async () => {
   calls++; return ok({ id: 'pending_task', status: 'in_progress' });
  }));
  assert.equal(calls, 1); assert.match(out.response.text, /Готовлю/);
 }
});
test('next turn links full Gemini context with previous_interaction_id', async () => {
 const out = await answerAlice(req('Как меня зовут?', signed({ c: 'prior_turn' })), opts(async (_, options) => {
  assert.equal(JSON.parse(options.body).previous_interaction_id, 'prior_turn'); return ok(done('Паша.'));
 }));
 assert.equal(out.response.text, 'Паша.');
});
test('Gemini tool selection routes Serper and returns matching function result', async () => {
 let calls = 0;
 const out = await answerAlice(req('Проверь погоду'), opts(async (url, options) => {
  calls++;
  if (calls === 1) return ok({ id: 'tool_turn', status: 'requires_action', steps: [{ type: 'function_call', id: 'call1', name: 'web_search', arguments: { query: 'погода Москва' } }] });
  if (calls === 2) { assert.ok(url.includes('serper')); assert.equal(options.headers['X-API-KEY'], env.SERPER_API_KEY); return ok({ organic: [{ title: 'Погода', snippet: '+10', link: 'https://example.org/weather' }] }); }
  const b = JSON.parse(options.body); assert.equal(b.previous_interaction_id, 'tool_turn'); assert.equal(b.input[0].call_id, 'call1');
  assert.match(b.input[0].result[0].text, /\+10/); assert.equal(b.tools, undefined);
  return ok(done('Около десяти градусов.'));
 }));
 assert.equal(calls, 3); assert.equal(out.response.buttons[0].url, 'https://example.org/weather');
});
test('search continuation preserves pending result and sources across requests', async () => {
 let call = 0;
 const first = await answerAlice(req('Новости'), { ...opts(async url => {
  if (url.includes('serper')) return ok({ organic: [{ link: 'https://example.org/news', snippet: 'Новость' }] });
  if (++call === 1) return ok({ id: 'tool', status: 'requires_action', steps: [{ type: 'function_call', id: 'call', name: 'web_search', arguments: { query: 'новости' } }] });
  return ok({ id: 'final_pending', status: 'in_progress' });
 }), timeoutMs: 100 });
 const second = await answerAlice(req('готово', first.session_state), opts(async () => ok(done('Есть свежая новость.', 'final_pending'))));
 assert.equal(second.response.buttons[0].url, 'https://example.org/news');
});
test('missing Serper key explicitly informs Gemini', async () => {
 let call = 0;
 await answerAlice(req(), { ...opts(async (_, options) => {
  if (++call === 1) return ok({ id: 'tool', status: 'requires_action', steps: [{ type: 'function_call', id: 'call', name: 'web_search', arguments: { query: 'новости' } }] });
  assert.match(JSON.parse(options.body).input[0].result[0].text, /не настроен/); return ok(done('Поиск недоступен.'));
 }), env: { GEMINI_API_KEY: env.GEMINI_API_KEY } });
 assert.equal(call, 2);
});
test('Serper 403 is diagnosed and Gemini gets error data', async () => {
 let call = 0, metrics;
 await answerAlice(req(), { ...opts(async (url, options) => {
  if (url.includes('serper')) return { ok: false, status: 403, json: async () => ({ error: { status: 'PERMISSION_DENIED' } }) };
  if (++call === 1) return ok({ id: 'tool', status: 'requires_action', steps: [{ type: 'function_call', id: 'call', name: 'web_search', arguments: { query: 'новости' } }] });
  assert.match(JSON.parse(options.body).input[0].result[0].text, /недоступен/); return ok(done());
 }), onMetrics: m => { metrics = m; } });
 assert.equal(metrics.search_status, 403);
});
test('Gemini 429 is reported without leaking API key or error body', async () => {
 let metrics;
 const out = await answerAlice(req(), { ...opts(async () => ({ ok: false, status: 429, json: async () => ({ error: { status: 'RESOURCE_EXHAUSTED', message: env.GEMINI_API_KEY } }) })), onMetrics: m => { metrics = m; } });
 assert.match(out.response.text, /квота/); assert.equal(metrics.error_status, 429);
 assert.ok(!JSON.stringify(metrics).includes(env.GEMINI_API_KEY));
});
test('failed background task clears pending ID and reports failure', async () => {
 const out = await answerAlice(req('готово', signed({ p: 'task', t: Date.now() })), opts(async () => ok({ status: 'failed', error: { code: 429, status: 'RESOURCE_EXHAUSTED' } })));
 assert.match(out.response.text, /квота/); assert.equal(out.session_state.p, undefined);
});
test('reset, exit and Yandex goodbye operate independently of Gemini', async () => {
 assert.equal((await answerAlice(req('выход'), { env, logger })).response.end_session, true);
 const b = req('пока'); b.request.nlu = { intents: { 'YANDEX.GOODBYE': {} } };
 assert.equal((await answerAlice(b, { env, logger })).response.end_session, true);
 const reset = req(); reset.request = { type: 'ButtonPressed', payload: { command: 'начать заново' } };
 assert.deepEqual(verifyState((await answerAlice(reset, { env, logger })).session_state, 'test-session', env.GEMINI_API_KEY), { v: 2 });
});
test('question button is passed to Gemini', async () => {
 const b = req(); b.request = { type: 'ButtonPressed', payload: { command: 'Два плюс два?' } };
 const out = await answerAlice(b, opts(async (_, options) => { assert.equal(JSON.parse(options.body).input, 'Два плюс два?'); return ok(done('4')); }));
 assert.equal(out.response.text, '4');
});
test('pending task does not silently replace a new user question', async () => {
 const out = await answerAlice(req('Новый вопрос', signed({ p: 'task', t: Date.now() })), opts(async () => { throw new Error('must not call'); }));
 assert.match(out.response.text, /предыдущий/);
});
test('state signature rejects tampering, other session, wrong key and expiry', () => {
 const state = signed({ c: 'old', p: 'task', t: Date.now() });
 assert.equal(verifyState(state, 'test-session', env.GEMINI_API_KEY).p, 'task');
 assert.deepEqual(verifyState({ ...state, p: 'other' }, 'test-session', env.GEMINI_API_KEY), {});
 assert.deepEqual(verifyState(state, 'other-session', env.GEMINI_API_KEY), {});
 assert.deepEqual(verifyState(state, 'test-session', 'other-key'), {});
 assert.deepEqual(verifyState(signed({ c: 'old', p: 'task', t: Date.now() - 1000000 }), 'test-session', env.GEMINI_API_KEY), { c: 'old' });
});
test('state below Yandex 1 KB and legacy history imports safely', async () => {
 const state = signed({ c: 'a'.repeat(220), p: 'b'.repeat(220), t: Date.now(), r: ['https://example.org/'+ 'x'.repeat(150), 'https://example.org/'+ 'y'.repeat(150)] });
 assert.ok(Buffer.byteLength(JSON.stringify(state)) <= 950);
 const legacy = packHistory([['Меня зовут Паша', 'Привет, Паша.']]);
 await answerAlice(req('Как меня зовут?', legacy), opts(async (_, options) => { assert.match(JSON.parse(options.body).input, /Меня зовут Паша/); return ok(done('Паша.')); }));
 const random = packHistory(Array.from({ length: 8 }, () => [randomBytes(300).toString('base64'), randomBytes(300).toString('base64')]));
 assert.ok(Buffer.byteLength(JSON.stringify(random)) <= 950); assert.ok(readHistory(random).length);
});
test('new session ignores old context; invalid timezone is safe', async () => {
 const b = req('Вопрос', signed({ c: 'old' })); b.session.new = true; b.meta.timezone = 'invalid';
 await answerAlice(b, opts(async (_, options) => { assert.equal(JSON.parse(options.body).previous_interaction_id, undefined); return ok(done()); }));
});
test('missing Gemini key and empty/blocked output return valid voice responses', async () => {
 assert.match((await answerAlice(req(), { env: {}, logger })).response.text, /ключ Gemini/);
 const out = await answerAlice(req(), opts(async () => ok({ id: 'blocked', status: 'completed', steps: [] })));
 assert.match(out.response.text, /Не удалось/); assert.equal(out.response.end_session, false);
});
test('server deadline returns promptly even when network ignores cancellation', async () => {
 const start = Date.now();
 const out = await answerAlice(req(), { ...opts(() => new Promise(() => {})), timeoutMs: 30 });
 assert.ok(Date.now() - start < 200); assert.match(out.response.text, /вовремя/);
});
test('text normalization and voice-only responses meet protocol limits', async () => {
 const b = req(); b.meta.interfaces = {};
 const out = await answerAlice(b, opts(async () => ok(done('**Ответ** <speaker> https://example.org '+ 'длинное объяснение '.repeat(70)))));
 assert.ok(out.response.text.length <= 600); assert.equal(out.response.tts, out.response.text);
 assert.equal(out.response.buttons, undefined); assert.ok(!out.response.text.includes('<'));
 assert.equal(cleanText('391'), '391');
});
test('unknown tool and parallel tool calls are bounded', async () => {
 let step = 0;
 await answerAlice(req(), opts(async (_, options) => {
  if (++step === 1) return ok({ id: 'tool', status: 'requires_action', steps: [{ type: 'function_call', id: 'call', name: 'execute_shell', arguments: {} }] });
  assert.match(JSON.parse(options.body).input[0].result[0].text, /Некорректный/);return ok(done());
 }));
 assert.equal(step, 2);
});
test('two search calls return matched results and no repeated tool round', async () => {
 let create = 0, searches = 0;
 await answerAlice(req(), opts(async (url, options) => {
  if (url.includes('serper')) { searches++; return ok({ organic: [] }); }
  if (++create === 1) return ok({ id: 'tools', status: 'requires_action', steps: ['a','b'].map(id => ({ type:'function_call', id, name:'web_search', arguments:{ query:id } })) });
  const b=JSON.parse(options.body);
  assert.deepEqual(b.input.map(r => r.call_id), ['a','b']);
  assert.equal(b.tools,undefined); return ok(done());
 }));
 assert.equal(searches,2); assert.equal(create,2);
});
test('cached Serper result is reused if Gemini continuation previously timed out', async () => {
 const { deflateSync } = await import('node:zlib');
 const results=[{ type:'function_result',name:'web_search',call_id:'call',result:[{type:'text',text:JSON.stringify({results:[{snippet:'Проверенные сведения'}]})}] }];
 const state=signed({p:'tool_turn',t:Date.now(),n:0,x:deflateSync(Buffer.from(JSON.stringify(results))).toString('base64')});
 let calls=0;
 await answerAlice(req('готово',state),opts(async (url,options)=>{
  calls++; assert.ok(!url.includes('serper'));
  if(options.method==='GET')return ok({id:'tool_turn',status:'requires_action',steps:[{type:'function_call',id:'call',name:'web_search',arguments:{query:'новости'}}]});
  assert.match(JSON.parse(options.body).input[0].result[0].text,/Проверенные/);return ok(done());
 }));
 assert.equal(calls,2);
});
test('HTTP health, methods, version, JSON and body size', async () => {
 const invoke = async (body, method = 'POST') => {
  const res = { headers: {}, setHeader(k,v) { this.headers[k]=v; }, status(n) { this.code=n; return this; }, json(v) { this.body=v; return this; } };
  await handler({ method, body }, res);return res;
 };
 assert.equal((await invoke(undefined,'GET')).body.model, FAST_MODEL);
 assert.equal((await invoke(undefined,'PUT')).code,405);
 assert.equal((await invoke('{')).code,400);
 assert.equal((await invoke({ version:'2.0' })).code,400);
 const large=req();large.extra='x'.repeat(17000);assert.equal((await invoke(large)).code,413);
 assert.equal((await invoke(JSON.stringify(req('')))).code,200);
});
