import { answerFast as answerAlice, FAST_MODEL as MODEL, greetingAudio } from '../lib/fast.js';
import { wantsTelegram, claimTelegramJob, telegramReceipt, runTelegramJob } from '../lib/telegram.js';
import { waitUntil } from '@vercel/functions';

export default async function handler(req, res, { schedule = waitUntil } = {}) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') return res.status(200).json({ service: 'alice-gemini-assistant', status: 'ok', webhook: '/api', model: MODEL, revision: 'gemini-primary-v6-greeting', api: 'generateContent', greeting_audio: Boolean(greetingAudio(process.env.ALICE_GREETING_AUDIO)), telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) });
  if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'Method not allowed' }); }
  let body = req.body;
  try {
    if (typeof body === 'string' || Buffer.isBuffer(body)) body = JSON.parse(body.toString());
    if (Buffer.byteLength(JSON.stringify(body ?? {})) > 16384) return res.status(413).json({ error: 'Request too large' });
  } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  if (body?.version !== '1.0' || typeof body?.session?.session_id !== 'string' || !body.session.session_id ||
      !Number.isInteger(body.session.message_id) || typeof body.session.new !== 'boolean' ||
      !['SimpleUtterance', 'ButtonPressed'].includes(body?.request?.type)) return res.status(400).json({ error: 'Invalid Alice request' });
  if (wantsTelegram(body)) {
    if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
      const text = 'Telegram пока не настроен. Добавьте токен бота и идентификатор чата в настройках сервера.';
      return res.status(200).json({ version: '1.0', response: { text, tts: text, end_session: false } });
    }
    if (claimTelegramJob(body)) schedule(runTelegramJob(body));
    res.setHeader('X-Assistant-Outcome', 'telegram_queued');
    return res.status(200).json(telegramReceipt(body));
  }
  const result = await answerAlice(body, { onMetrics: metrics => {
    res.setHeader('X-Assistant-Model', MODEL);
    res.setHeader('X-Assistant-Outcome', metrics.outcome);
    res.setHeader('X-Assistant-Duration-Ms', String(metrics.duration_ms));
    res.setHeader('X-Assistant-Search-Calls', String(metrics.search_calls));
  } });
  return res.status(200).json(result);
}
