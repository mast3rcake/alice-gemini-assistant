import { deflateSync, inflateSync } from 'node:zlib';

export const MODEL = 'gemini-3.8-flash';
export const DEADLINE_MS = 3400;
export const ANSWER_CHARS = 600;
const STATE_BYTES = 950;
const FALLBACK = 'Сейчас не удалось получить ответ. Попробуйте ещё раз.';

export function cleanText(value, limit = ANSWER_CHARS) {
  const text = String(value ?? '').replace(/<[^>]*>/g, '').replace(/https?:\/\/\S+/g, '')
    .replace(/[*_#`]/g, '').replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit - 1);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return end > limit / 2 ? cut.slice(0, end + 1) : cut.slice(0, cut.lastIndexOf(' ') > 0 ? cut.lastIndexOf(' ') : cut.length) + '…';
}

export function readHistory(state) {
  try {
    if (state?.v !== 1 || typeof state.h !== 'string' || state.h.length > 1300) return [];
    const data = JSON.parse(inflateSync(Buffer.from(state.h, 'base64'), { maxOutputLength: 24000 }).toString());
    if (!Array.isArray(data)) return [];
    return data.filter(p => Array.isArray(p) && p.length === 2 && p.every(s => typeof s === 'string'))
      .slice(-8).map(([u, a]) => [u.slice(0, 450), a.slice(0, ANSWER_CHARS)]);
  } catch { return []; }
}

export function packHistory(history) {
  const pairs = history.slice(-8).map(([u, a]) => [String(u).slice(0, 450), String(a).slice(0, ANSWER_CHARS)]);
  const encode = () => ({ v: 1, h: deflateSync(Buffer.from(JSON.stringify(pairs))).toString('base64') });
  let state = encode();
  while (Buffer.byteLength(JSON.stringify(state)) > STATE_BYTES && pairs.length > 1) {
    pairs.shift(); state = encode();
  }
  while (Buffer.byteLength(JSON.stringify(state)) > STATE_BYTES && pairs.length) {
    pairs[0] = pairs[0].map(s => s.slice(0, Math.floor(s.length * 0.8)));
    state = encode();
  }
  return state;
}

export function reply(text, history, end = false, buttons = []) {
  const answer = cleanText(text) || FALLBACK;
  return { version: '1.0', response: { text: answer, tts: answer, end_session: end, ...(buttons.length ? { buttons } : {}) }, session_state: packHistory(history) };
}

