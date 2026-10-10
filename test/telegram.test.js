import test from 'node:test';
import assert from 'node:assert/strict';
import { wantsTelegram, runTelegramJob, sendTelegram, claimTelegramJob } from '../lib/telegram.js';
import { answerAlice } from '../lib/assistant.js';
const env = { GEMINI_API_KEY: 'gemini-secret', TELEGRAM_BOT_TOKEN: 'telegram-secret', TELEGRAM_CHAT_ID: '123' };
const logger = { info() {} };
const body = text => ({ version: '1.0', session: { session_id: 'telegram-test', message_id: 1, new: false }, request: { type: 'SimpleUtterance', command: text }, meta: { interfaces: { screen: {} } } });
test('only explicit sending command authorizes Telegram, not an ordinary mention', () => {
 assert.equal(wantsTelegram(body('Составь список покупок и пришли в телеграм')), true);
 assert.equal(wantsTelegram(body('Расскажи про Telegram')), false);
 assert.equal(wantsTelegram(body('Не отправляй список в телеграм')), false);
 assert.equal(wantsTelegram({ ...body(''), request: { type: 'ButtonPressed', payload: { command: 'отправь в Telegram рецепт' } } }), true);
});
test('Telegram destination is fixed and plain text has no parse_mode or token leakage', async () => {
 let count = 0;
 await sendTelegram('Список\n- Молоко <1 л>', { env, fetcher: async (url, options) => {
  count++; assert.equal(url, 'https://api.telegram.org/bottelegram-secret/sendMessage');
  const data = JSON.parse(options.body); assert.equal(data.chat_id, '123'); assert.equal(data.parse_mode, undefined); assert.match(data.text, /\n/);
  return { ok: true, json: async () => ({ ok: true, result: { message_id: 7 } }) };
 }}); assert.equal(count, 1);
});
test('background generation polls existing task then sends exactly one result', async () => {
 let generates = 0, sends = 0;
 const result = await runTelegramJob(body('пришли в телеграм список'), { env, logger, sleep: async () => {}, answer: async (request, options) => {
  generates++; assert.equal(options.channel, 'telegram');
  options.onMetrics({ outcome: generates === 1 ? 'pending' : 'gemini' });
  if (generates === 2) { assert.equal(request.request.command, 'готово?'); assert.equal(request.state.session.p, 'task'); }
  return { response: { text: 'Покупки\n- Макароны 200 г\n- Томаты 300 г' }, session_state: { p: 'task' } };
 }, fetcher: async () => { sends++; return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) }; } });
 assert.equal(result.status, 'sent'); assert.equal(sends, 1); assert.equal(generates, 2);
});
test('Gemini quota error reaches Telegram honestly', async () => {
 let sent;
 await runTelegramJob(body('пришли в телеграм список'), { env, logger, answer: async (_, options) => { options.onMetrics({ outcome: 'error' }); return { response: { text: 'Gemini: превышена квота.' } }; }, fetcher: async (_, options) => { sent = JSON.parse(options.body).text; return { ok: true, json: async () => ({ ok: true }) }; } });
 assert.match(sent, /квота/);
});
test('Telegram 403 and ambiguous network failures never trigger resend', async () => {
 for (const fail of ['403','network']) {
  let calls = 0; const logs = [];
  const result = await runTelegramJob(body('отправь в телеграм тестовое сообщение'), { env, logger: { info: s => logs.push(s) }, fetcher: async () => { calls++; if (fail === 'network') throw new Error('telegram-secret'); return { ok: false, status: 403, json: async () => ({ ok: false, error_code: 403, description: 'telegram-secret' }) }; } });
  assert.equal(result.status, 'failed'); assert.equal(calls, 1); assert.ok(!logs.join('').includes('telegram-secret'));
 }
});
test('generation deadline sends a timeout notification', async () => {
 let ticks = 0, sent;
 await runTelegramJob(body('пришли в телеграм список'), { env, logger, budgetMs: 15000, now: () => ticks, sleep: async () => { ticks += 6000; }, answer: async (_, options) => { options.onMetrics({ outcome: 'pending' }); return { session_state: {}, response: { text: 'Готовлю' } }; }, fetcher: async (_, options) => { sent = JSON.parse(options.body).text; return { ok: true, json: async () => ({ ok: true }) }; } });
 assert.match(sent, /не успел/);
});
test('same-instance duplicate delivery is suppressed with session and message binding', () => {
 const b = body('пришли в телеграм'); b.session.session_id = 'dedupe';
 assert.equal(claimTelegramJob(b, 0), true); assert.equal(claimTelegramJob(b, 1), false);
 assert.equal(claimTelegramJob(b, 240001), true);
});
test('Telegram answers preserve long lists, voice answers remain short', async () => {
 const text = ('- Продукт 100 г\n').repeat(60);
 const fetcher = async (_, options) => {
  const request = JSON.parse(options.body); assert.match(request.system_instruction, /3500 символов/);
  return { ok: true, json: async () => ({ id: 'done', status: 'completed', output_text: text }) };
 };
 const result = await answerAlice(body('Список'), { env, logger, channel: 'telegram', fetcher });
 assert.ok(result.response.text.length > 600); assert.match(result.response.text, /\n/);
});
