import { verifyState, sealState } from './assistant.js';
import { answerFast as answerAlice } from './fast.js';

// Sending is authorized by the actual utterance, never by model/tool output.
export function wantsTelegram(body) {
  const text = body.request?.type === 'ButtonPressed' ? body.request.payload?.command : body.request?.command ?? body.request?.original_utterance;
  return typeof text === 'string' && /(?:отправ\S*|пришл\S*|присл\S*|скинь\S*|вышл\S*)[\s\S]{0,180}(?:телеграм\S*|telegram)/iu.test(text) && !/(?:не|не надо|не нужно)\s+(?:отправ|пришл|присл|скинь|вышл)/iu.test(text);
}

export async function sendTelegram(text, { env = process.env, fetcher = fetch } = {}) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) throw Object.assign(new Error('telegram_not_configured'), { code: 'NOT_CONFIGURED' });
  // Fixed destination from environment; neither Gemini nor the request chooses it.
  const response = await fetcher(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', signal: AbortSignal.timeout(8000), headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: String(text).slice(0, 4000), link_preview_options: { is_disabled: true } })
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    const description = String(data.description ?? '').toLowerCase();
    const reason = description.includes('chat not found') ? 'CHAT_NOT_FOUND' : description.includes('blocked') ? 'BOT_BLOCKED' : description.includes('chat_id') ? 'INVALID_CHAT_ID' : description.includes('unauthorized') ? 'INVALID_TOKEN' : description.includes('too many requests') ? 'RATE_LIMIT' : 'API_REJECTED';
    throw Object.assign(new Error('telegram_delivery_failed'), { code: Number(data.error_code ?? response.status), reason });
  }
  return { messageId: data.result?.message_id };
}

const jobs = new Map();
export function claimTelegramJob(body, now = Date.now()) {
  for (const [key, expires] of jobs) if (expires < now) jobs.delete(key);
  const key = JSON.stringify([body.session.session_id, body.session.message_id]);
  if (jobs.has(key)) return false;
  if (jobs.size >= 200) jobs.delete(jobs.keys().next().value);
  jobs.set(key, now + 240000); return true;
}

export function telegramReceipt(body, env = process.env) {
  const prior = body.session.new ? {} : verifyState(body.state?.session, body.session.session_id, env.GEMINI_API_KEY);
  const text = 'Принял. Подготовлю ответ и пришлю в Telegram. Если Gemini недоступен, сообщу об этом там.';
  return { version: '1.0', response: { text, tts: text, end_session: false }, session_state: sealState(prior.h ? { h: prior.h } : {}, body.session.session_id, env.GEMINI_API_KEY) };
}

export async function runTelegramJob(body, { env = process.env, fetcher = fetch, logger = console, answer = answerAlice, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), budgetMs = 110000, now = Date.now } = {}) {
  const started = now(); let request = structuredClone(body), outcome = 'error', text;
  const prior = body.session.new ? {} : verifyState(body.state?.session, body.session.session_id, env.GEMINI_API_KEY);
  // A Telegram command starts its own task; do not send an unrelated pending answer.
  if (prior.p) request.state = { session: sealState(prior.c ? { c: prior.c } : {}, body.session.session_id, env.GEMINI_API_KEY) };
  try {
    // Integration smoke test independent of Gemini availability or quota.
    const command = body.request.command ?? body.request.payload?.command ?? '';
    if (/^(?:отправь|пришли)\s+(?:в\s+)?(?:телеграм|telegram)\s+тестовое сообщение[.!?]?$/iu.test(command.trim())) {
      text = 'Проверка связи: навык Алисы подключён к Telegram. Можно отправлять списки покупок, рецепты и планы.'; outcome = 'test';
    } else {
      while (now() - started < budgetMs - 12000) {
        let metrics;
        const result = await answer(request, { env, fetcher, logger, channel: 'telegram', timeoutMs: Math.min(20000, budgetMs - (now() - started) - 10000), onMetrics: m => { metrics = m; } });
        outcome = metrics?.outcome ?? 'error';
        if (outcome !== 'pending') {
          text = result.response.text;
          if (outcome.startsWith('gemini')) {
            const urls = result.response.buttons?.filter(b => b.url).map(b => b.url) ?? [];
            if (urls.length) text += '\n\nИсточники:\n' + urls.join('\n');
          }
          break;
        }
        request = { ...request, session: { ...request.session, new: false }, request: { type: 'SimpleUtterance', command: 'готово?' }, state: { session: result.session_state } };
        await sleep(6000);
      }
      if (!text) { outcome = 'generation_timeout'; text = 'Gemini не успел подготовить ответ за отведённое время. Повторите команду позже.'; }
    }
    await sendTelegram(text, { env, fetcher });
    logger.info(JSON.stringify({ event: 'telegram_delivery', outcome, status: 'sent', duration_ms: now() - started }));
    return { status: 'sent', outcome };
  } catch (error) {
    // Do not retry sendMessage: a network timeout can mean it was delivered.
    const code = /^[A-Za-z0-9_]{1,40}$/.test(String(error.code ?? 'NETWORK_ERROR')) ? String(error.code ?? 'NETWORK_ERROR') : 'DELIVERY_ERROR';
    logger.info(JSON.stringify({ event: 'telegram_delivery', status: 'failed', code, reason: error.reason, duration_ms: now() - started }));
    return { status: 'failed', code };
  }
}
