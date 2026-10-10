import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { answerFast, FAST_MODEL } from '../lib/fast.js';
import { sealState, verifyState } from '../lib/assistant.js';
const env={GEMINI_API_KEY:'secret',SERPER_API_KEY:'search-secret'},logger={info(){}};
const req=(command,state={})=>({version:'1.0',session:{session_id:'fast-test',message_id:1,new:false},request:{type:'SimpleUtterance',command},state:{session:state},meta:{interfaces:{}}});
const ok=data=>({ok:true,json:async()=>data});
const done=text=>({candidates:[{content:{role:'model',parts:[{text}]}}]});
test('fast voice uses direct minimal Gemini without background or pending state',async()=>{
 let calls=0;
 const result=await answerFast(req('Как дела?',sealState({p:'old_task',t:Date.now()},'fast-test',env.GEMINI_API_KEY)),{env,logger,fetcher:async(url,options)=>{
  calls++;assert.match(url,new RegExp(FAST_MODEL));const body=JSON.parse(options.body);assert.equal(body.background,undefined);assert.equal(body.generationConfig.thinkingConfig.thinkingLevel,'minimal');return ok(done('На связи. Что обсудим?'));
 }});
 assert.equal(calls,1);assert.match(result.response.text,/На связи/);assert.equal(result.session_state.p,undefined);assert.equal(result.response.buttons,undefined);
});
test('signed compact context reaches the next question',async()=>{
 const first=await answerFast(req('Меня зовут Паша'),{env,logger,fetcher:async()=>ok(done('Запомнил.'))});
 const second=await answerFast(req('Как меня зовут?',first.session_state),{env,logger,fetcher:async(_,options)=>{
  const contents=JSON.parse(options.body).contents;assert.equal(contents[0].parts[0].text,'Меня зовут Паша');assert.equal(contents[1].role,'model');return ok(done('Паша.'));
 }});assert.equal(second.response.text,'Паша.');
});
test('failure clears legacy pending task instead of blocking next input',async()=>{
 const first=await answerFast(req('Вопрос',sealState({p:'old',t:Date.now()},'fast-test',env.GEMINI_API_KEY)),{env,logger,fetcher:async()=>({ok:false,status:429,json:async()=>({})})});
 assert.match(first.response.text,/квота/);assert.equal(first.session_state.p,undefined);
 const next=await answerFast(req('Другой вопрос',first.session_state),{env,logger,fetcher:async()=>ok(done('Ответ.'))});assert.equal(next.response.text,'Ответ.');
});
test('deadline returns without waiting loop or unhandled completion',async()=>{
 const start=Date.now();const result=await answerFast(req('Вопрос'),{env,logger,timeoutMs:20,fetcher:()=>new Promise(()=>{})});
 assert.ok(Date.now()-start<250);assert.match(result.response.text,/не успел/);assert.equal(result.session_state.p,undefined);
});
test('function call thought signatures and call IDs survive Serper continuation',async()=>{
 let calls=0;const result=await answerFast(req('Проверь новости'),{env,logger,fetcher:async(url,options)=>{
  calls++;if(calls===1)return ok({candidates:[{content:{role:'model',parts:[{thoughtSignature:'signature',functionCall:{id:'call',name:'web_search',args:{query:'новости'}}}]}}]});
  if(calls===2){assert.match(url,/serper/);return ok({organic:[{title:'Источник',snippet:'Новость',link:'https://example.org'}]});}
  const content=JSON.parse(options.body).contents;assert.equal(content.at(-2).parts[0].thoughtSignature,'signature');assert.equal(content.at(-1).parts[0].functionResponse.id,'call');return ok(done('Проверенная новость.'));
 }});assert.equal(calls,3);assert.equal(result.response.text,'Проверенная новость.');
});
test('voice-only startup/reset do not call Google',async()=>{
 const options={env,logger,fetcher:async()=>{throw new Error('unexpected');}};
 assert.match((await answerFast(req(''),options)).response.text,/на связи/);
 assert.match((await answerFast(req('начать заново'),options)).response.text,/заново/);
 assert.equal((await answerFast(req('выход'),options)).response.end_session,true);
});
test('incompressible history fits Yandex limit and Telegram keeps list formatting',async()=>{
 const long=randomBytes(2000).toString('base64');
 const result=await answerFast(req(long),{env,logger,channel:'telegram',fetcher:async()=>ok(done('- Молоко 1 л\n'+long))});
 assert.ok(Buffer.byteLength(JSON.stringify(result.session_state))<=950);assert.ok(verifyState(result.session_state,'fast-test',env.GEMINI_API_KEY).h);assert.match(result.response.text,/\n/);
});

test('recorded greeting plays only at empty voice session startup without Google',async()=>{
 const audio='dialogs-upload/skill-id/sound-id.opus';
 const options={env:{...env,ALICE_GREETING_AUDIO:audio},logger,fetcher:async()=>{throw new Error('unexpected');}};
 const body=req('');body.session.new=true;
 const result=await answerFast(body,options);
 assert.equal(result.response.tts,`<speaker audio="${audio}">`);
 assert.match(result.response.text,/Спасать мир/);assert.equal(result.response.end_session,false);
 body.session.new=false;
 assert.equal((await answerFast(body,options)).response.tts,(await answerFast(body,options)).response.text);
 body.session.new=true;
 assert.doesNotMatch((await answerFast(body,{...options,channel:'telegram'})).response.tts,/<speaker/);
 body.request.command='Сколько будет два плюс два?';
 assert.equal((await answerFast(body,{...options,fetcher:async()=>ok(done('Четыре.'))})).response.tts,'Четыре.');
});
test('greeting accepts copied Yandex tag but rejects URLs and injected TTS',async()=>{
 const body=req('');body.session.new=true;
 for(const audio of ['https://example.com/audio.mp3','dialogs-upload/skill/sound.opus"><speaker audio="evil','<speaker audio="dialogs-upload/skill/sound.opus">extra']) {
  const result=await answerFast(body,{env:{...env,ALICE_GREETING_AUDIO:audio},logger});
  assert.equal(result.response.tts,result.response.text);
 }
 const result=await answerFast(body,{env:{...env,ALICE_GREETING_AUDIO:"<speaker audio='dialogs-upload/skill/sound.opus'>"},logger});
 assert.equal(result.response.tts,'<speaker audio="dialogs-upload/skill/sound.opus">');
});
