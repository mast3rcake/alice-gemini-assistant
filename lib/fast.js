import { deflateSync } from 'node:zlib';
import { sealState, verifyState } from './assistant.js';
import { cleanText, readHistory } from './state.js';
import { INSTRUCTIONS } from './prompt.js';
export const FAST_MODEL = 'gemini-3.5-flash-lite';
export function greetingAudio(value) {
  if (typeof value !== 'string') return '';
  const source = value.trim();
  const path = source.match(/^<speaker audio=["'](dialogs-upload\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.opus)["']>$/)?.[1] ?? source;
  return /^dialogs-upload\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.opus$/.test(path) ? path : '';
}
const declaration = { name: 'web_search', description: 'Поиск свежих сведений через Serper.', parameters: { type: 'OBJECT', properties: { query: { type: 'STRING' } }, required: ['query'] } };

export async function answerFast(body, { env = process.env, fetcher = fetch, logger = console, onMetrics = () => {}, timeoutMs = 3200, channel = 'voice' } = {}) {
  const started = Date.now(), sid = body.session.session_id;
  const signed = body.session.new ? {} : verifyState(body.state?.session, sid, env.GEMINI_API_KEY);
  let history = body.session.new ? [] : readHistory(signed.h ? { v: 1, h: signed.h } : body.state?.session);
  const metrics = { event: 'assistant_request', model: FAST_MODEL, api: 'generateContent', channel, surface: body.meta?.interfaces?.screen ? 'screen' : 'voice', new_session: body.session.new, gemini_calls: 0, search_calls: 0, outcome: 'local' };
  const save = () => {
    const pairs = history.slice(-6).map(([u,a]) => [String(u).slice(0,350),String(a).slice(0,500)]);
    while (true) {
      const h = deflateSync(Buffer.from(JSON.stringify(pairs))).toString('base64');
      try { return sealState({ h },sid,env.GEMINI_API_KEY); } catch {
        if (pairs.length > 1) pairs.shift();
        else if (pairs.length) pairs[0] = pairs[0].map(s => s.slice(0,Math.floor(s.length*.7)));
        else return sealState({},sid,env.GEMINI_API_KEY);
      }
    }
  };
  const output = (value, end = false, urls = [], audio = '') => {
    const text = channel === 'telegram' ? String(value).trim().slice(0,3500) : cleanText(value);
    metrics.duration_ms = Date.now()-started; onMetrics({...metrics}); logger.info(JSON.stringify(metrics));
    return { version:'1.0',response:{text,tts:audio ? `<speaker audio="${audio}">` : channel==='telegram'?cleanText(text):text,end_session:end,...(body.meta?.interfaces?.screen && urls.length ? {buttons:urls.slice(0,2).map((url,i)=>({title:`Источник ${i+1}`,url,hide:true}))}: {})},session_state:save() };
  };
  const input = body.request.type === 'ButtonPressed' ? body.request.payload?.command : body.request.command ?? body.request.original_utterance;
  const query = typeof input === 'string' ? input.trim().slice(0,3000) : '';
  const normalized=query.toLowerCase().replace(/[.!?]+$/g,'').trim();
  if (body.request.nlu?.intents?.['YANDEX.GOODBYE'] || ['выход','стоп','хватит','до свидания','заверши разговор'].includes(normalized)) { history=[]; return output('До встречи!',true); }
  if (['сброс','начать заново','очисти историю','забудь разговор'].includes(normalized)) { history=[]; return output('Начнём заново. О чём поговорим?'); }
  if (!query) {
    const audio = body.session.new && channel === 'voice' ? greetingAudio(env.ALICE_GREETING_AUDIO) : '';
    return audio
      ? output('На связи. Спасать мир сегодня не обещаю. С остальным разберёмся.', false, [], audio)
      : output('Я на связи. Задайте вопрос или попросите прислать результат в Telegram.');
  }
  if (['готово','ответ','проверить ответ'].includes(normalized)) return output('Режим ожидания отключён. Задайте вопрос ещё раз — отвечу напрямую.');
  if (!env.GEMINI_API_KEY) { metrics.outcome='missing_gemini_key'; return output('Помощник пока не настроен: нужен ключ Gemini.'); }
  const controller=new AbortController();let timer;
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('deadline'));},timeoutMs);});
  let tz=body.meta?.timezone??'Europe/Moscow';try{new Intl.DateTimeFormat('ru',{timeZone:tz});}catch{tz='Europe/Moscow';}
  const today=new Intl.DateTimeFormat('ru',{timeZone:tz,dateStyle:'full'}).format(new Date());
  const contents=history.flatMap(([u,a])=>[{role:'user',parts:[{text:u}]},{role:'model',parts:[{text:a}]}]);contents.push({role:'user',parts:[{text:query}]});
  let urls=[];
  const api=async(url,payload,service='gemini')=>{
    const response=await fetcher(url,{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json',...(service==='gemini'?{'x-goog-api-key':env.GEMINI_API_KEY}:{'X-API-KEY':env.SERPER_API_KEY})},body:JSON.stringify(payload)});
    const data=await response.json();if(!response.ok)throw Object.assign(new Error('api_error'),{service,status:response.status});return data;
  };
  const generate=async(allowTools)=>{
    metrics.gemini_calls++;
    const system=INSTRUCTIONS.replace('{today}',today)+(channel==='telegram'?'\nОтвет для Telegram: вместо ограничения 600 символов дай структурированный текст до 3500 символов с переносами и списками, продукты с количествами. Доставку выполняет сервер, не утверждай что уже отправил.':'\nГолосовой ответ: по возможности одно-два коротких предложения.');
    return api(`https://generativelanguage.googleapis.com/v1beta/models/${FAST_MODEL}:generateContent`,{contents,systemInstruction:{parts:[{text:system}]},generationConfig:{thinkingConfig:{thinkingLevel:'minimal'},temperature:.7,maxOutputTokens:channel==='telegram'?2048:512},...(allowTools?{tools:[{functionDeclarations:[declaration]}]}:{})});
  };
  const work=async()=>{
    let data=await generate(true),parts=data.candidates?.[0]?.content?.parts??[];
    const calls=parts.filter(p=>p.functionCall).map(p=>p.functionCall);
    if(calls.length){
      if(calls.length>2)throw new Error('tool_limit');
      const responses=await Promise.all(calls.map(async call=>{
        let result={error:'Поиск недоступен. Не выдумывай актуальные сведения.'};
        if(call.name==='web_search' && typeof call.args?.query==='string' && env.SERPER_API_KEY){
          try{metrics.search_calls++;const search=await api('https://google.serper.dev/search',{q:call.args.query.slice(0,400),hl:'ru',num:3},'serper');
            const organic=Array.isArray(search.organic)?search.organic.slice(0,3):[];result={answerBox:search.answerBox,results:organic.map(r=>({title:r.title,snippet:r.snippet,link:r.link}))};
            urls.push(...organic.map(r=>r.link).filter(u=>typeof u==='string'&&/^https:\/\//.test(u)&&Buffer.byteLength(u)<=180));
          }catch(error){if(controller.signal.aborted)throw error;metrics.search_status=error.status;}
        }
        return {functionResponse:{name:call.name,response:result,...(call.id?{id:call.id}:{})}};
      }));
      contents.push({role:'model',parts},{role:'user',parts:responses});data=await generate(false);parts=data.candidates?.[0]?.content?.parts??[];
    }
    if(controller.signal.aborted)throw new Error('deadline');
    const raw=parts.filter(p=>typeof p.text==='string'&&!p.thought).map(p=>p.text).join('');if(!raw.trim())throw new Error('empty_answer');
    const answer=channel==='telegram'?raw.slice(0,3500):cleanText(raw);history.push([query,answer]);metrics.outcome=metrics.search_calls?'gemini_with_search':'gemini';
    return output(answer,false,urls);
  };
  try{return await Promise.race([work(),deadline]);}
  catch(error){metrics.outcome=controller.signal.aborted?'deadline':'error';metrics.error_service=error.service??'assistant';metrics.error_status=error.status;
    return output(error.status===429?'Gemini ограничил запросы: превышена квота. Попробуйте позже.':controller.signal.aborted?'Gemini не успел ответить. Попробуйте задать вопрос короче или попросите прислать ответ в Telegram.':'Сейчас не удалось получить ответ от Gemini. Попробуйте ещё раз.');
  }finally{clearTimeout(timer);controller.abort();}
}
