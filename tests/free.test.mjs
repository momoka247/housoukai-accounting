import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import gateway,{signature} from '../free/gateway/worker.mjs';

if(!globalThis.crypto)globalThis.crypto=webcrypto;
const sandbox=vm.createContext({console});
vm.runInContext(fs.readFileSync(new URL('../free/Core.gs',import.meta.url),'utf8'),sandbox);
const core=sandbox.AccountingCore;
const plain=v=>JSON.parse(JSON.stringify(v));
function memory() {
  const map=new Map();
  return {get:(k,id)=>map.has(k+':'+id)?plain(map.get(k+':'+id)):null,
    put:(k,id,v)=>map.set(k+':'+id,plain(v)),list:k=>Array.from(map).filter(([key])=>key.startsWith(k+':')).map(([,v])=>plain(v))};
}
function fixture() {
  let seq=0;
  const db=memory(),ctx={id:()=>(++seq).toString(16).padStart(12,'0'),now:()=>new Date('2027-04-02T00:00:00Z').toISOString()};
  const register=(kind,body)=>{const d=core.draft(db,'user',kind,body,null,ctx);core.confirm(db,d.id,'user',ctx);return d.id;};
  register('opening',{日付:'2027-04-01',団体口座:10000,公金口座:20000});
  return {db,ctx,register};
}
const transaction=patch=>({日付:'2027-04-02',口座:'団体口座',方向:'支出',金額:1000,手数料:110,残高:8890,内部振替:false,科目:'支．消耗品費',...patch});

test('使い方は1通の説明書を返し会計データを操作しない',()=>{
  const messages=core.respond({}, {type:'message',message:{type:'text',text:' 使い方　'}},'user',{},{});
  assert.equal(messages.length,1);assert.equal(messages[0].type,'text');
  for(const word of ['事前申請','事後申請','団体口座 残高','公金口座 残高','写真','科目一覧','確認待ち','未払い','会計ファイル','完了','ヘルプ'])assert.ok(messages[0].text.includes(word));
  assert.ok(messages[0].text.length<1000);
});

test('無料版の科目は元の全科目と一致する',()=>{
  assert.deepEqual(plain(core.CATEGORIES),JSON.parse(fs.readFileSync(new URL('../categories.json',import.meta.url),'utf8')));
});
test('外部支出は本体と手数料が同じ行で差し引かれる',()=>{
  const {db,register}=fixture();register('transaction',transaction());
  assert.deepEqual(plain(core.ledger(db)),[['2027-04-01','収．前年度繰越金/団体口座',10000,0],['2027-04-01','収．前年度繰越金/公金口座',20000,0],['2027-04-02','支．消耗品費',0,1110]]);
});
test('口座間の送金を二重計上せず手数料だけ引く',()=>{
  const {db,register}=fixture();
  register('transaction',transaction({口座:'公金口座',内部振替:true,金額:5000,残高:14890,科目:null}));
  register('transaction',transaction({方向:'収入',内部振替:true,金額:5000,手数料:0,残高:15000,科目:null}));
  assert.equal(core.ledger(db).reduce((s,r)=>s+r[2]-r[3],0),29890);
  assert.equal(core.balance(db,'公金口座')[0],14890);assert.equal(core.balance(db,'団体口座')[0],15000);
});
test('UFJの振込明細の入金額を支出として科目へ分類できる',()=>{
  const {db,ctx}=fixture(),body=core.receipt('2027/04/02\n入金額 1,000円\n手数料 110円\n残高 8,890円');
  let d=core.draft(db,'user','transaction',body,'image:abc',ctx);
  d=core.revise(db,d,{口座:'団体口座',内部振替:false,内容:'切手代'},'user',ctx);
  assert.equal(d.body.方向,'支出');assert.equal(d.body.科目,'支．通信費');
  core.confirm(db,d.id,'user',ctx);assert.equal(core.ledger(db).at(-1)[3],1110);
});
test('本当の受取入金は収入として増える',()=>{
  const {db,register}=fixture();register('transaction',transaction({方向:'収入',科目:'収．部費',手数料:0,残高:11000}));
  assert.deepEqual(plain(core.ledger(db).at(-1)).slice(2),[1000,0]);
});
test('未入力・負数・不正な日付・曖昧な科目を登録しない',()=>{
  const {db,ctx}=fixture();
  for(const patch of [{科目:null},{金額:-1},{手数料:null},{内部振替:null},{日付:'2027-02-30'}]) {
    const d=core.draft(db,'user','transaction',transaction(patch),null,ctx);
    assert.throws(()=>core.confirm(db,d.id,'user',ctx));
  }
  assert.equal(core.ledger(db).length,2);
  assert.equal(core.suggest('機材を購入','支出'),null);
  assert.equal(core.suggest('切手代と印刷代','支出'),null);
});
test('再送・登録連打・他人の確認操作で重複しない',()=>{
  const {db,ctx}=fixture(),d=core.draft(db,'user','transaction',transaction(),'image:abc',ctx);
  assert.equal(core.draft(db,'user','transaction',transaction(),'image:abc',ctx).id,d.id);
  assert.throws(()=>core.confirm(db,d.id,'stranger',ctx),/操作できません/);
  core.confirm(db,d.id,'user',ctx);assert.throws(()=>core.confirm(db,d.id,'user',ctx),/処理済み/);
  assert.equal(core.ledger(db).length,3);
});
test('完了すると3日前・1日前・当日の通知候補から外れる',()=>{
  const {db,ctx,register}=fixture(),id=register('payment',{会社:'テスト会社',金額:1000,期限:'2027-04-10'});
  for(const day of ['2027-04-07','2027-04-09','2027-04-10'])assert.equal(core.dueReminders(db,day).length,1);
  assert.equal(core.dueReminders(db,'2027-04-08').length,0);
  core.respond(db,{type:'postback',postback:{data:'done:'+id}},'user',{},ctx);
  assert.equal(core.dueReminders(db,'2027-04-10').length,0);
  assert.equal(core.ledger(db).length,2);
});
test('取消で出納帳と口座残高が元へ戻る',()=>{
  const {db,ctx,register}=fixture(),id=register('transaction',transaction());
  const d=core.draft(db,'user','void',{取引ID:id},null,ctx);core.confirm(db,d.id,'user',ctx);
  assert.equal(core.ledger(db).length,2);assert.equal(core.balance(db,'団体口座')[0],10000);
});
test('45件に増えても手数料と残高を正しく計算する',()=>{
  const {db,register}=fixture();for(let i=0;i<45;i++)register('transaction',transaction({金額:100,手数料:10}));
  const rows=core.ledger(db);assert.equal(rows.length,47);assert.equal(rows.reduce((s,r)=>s+r[2]-r[3],0),25050);
});

const env={LINE_CHANNEL_SECRET:'line-secret',GATEWAY_SHARED_SECRET:'shared-secret-with-at-least-32-characters',APPS_SCRIPT_URL:'https://script.google.com/macros/s/deploymentId/exec'};
function req(body,sig) {return new Request('https://example.workers.dev/webhook',{method:'POST',headers:{'x-line-signature':sig},body});}
test('Workerは偽署名・改ざんを拒否し、Googleへ送らない',async()=>{
  const raw='{"events":[]}',sig=await signature(env.LINE_CHANNEL_SECRET,raw);
  assert.equal((await gateway.fetch(req(raw+' ',sig),env)).status,403);
  assert.equal((await gateway.fetch(req(raw,'wrong'),env)).status,403);
});
test('Workerは接続検証に無料で応答する',async()=>{
  const raw='{"events":[]}';assert.equal((await gateway.fetch(req(raw,await signature(env.LINE_CHANNEL_SECRET,raw)),env)).status,200);
});
test('Workerの中継には改ざん検出用HMACが付き、失敗を成功扱いしない',async()=>{
  const previous=globalThis.fetch,raw=JSON.stringify({events:[{webhookEventId:'one'}]});
  try {
    globalThis.fetch=async(url,options)=>{
      const body=JSON.parse(options.body);
      assert.equal(body.rawBody,raw);
      assert.equal(body.mac,await signature(env.GATEWAY_SHARED_SECRET,body.timestamp+'\n'+raw));
      return Response.json({ok:true});
    };
    assert.equal((await gateway.fetch(req(raw,await signature(env.LINE_CHANNEL_SECRET,raw)),env)).status,200);
    globalThis.fetch=async()=>Response.json({ok:false});
    assert.equal((await gateway.fetch(req(raw,await signature(env.LINE_CHANNEL_SECRET,raw)),env)).status,503);
  } finally {globalThis.fetch=previous;}
});
test('Workerは大きすぎるbodyと未設定の転送先を拒否する',async()=>{
  assert.equal((await gateway.fetch(req('x'.repeat(262145),'bad'),env)).status,413);
  assert.equal((await gateway.fetch(req('{}','bad'),{})).status,503);
});

test('Apps Scriptは古い・改ざんされた直接呼出しを拒否する',()=>{
  const api=vm.createContext({AccountingCore:core,PropertiesService:{getScriptProperties:()=>({getProperties:()=>({GATEWAY_SHARED_SECRET:env.GATEWAY_SHARED_SECRET})})},
    Utilities:{Charset:{UTF_8:'UTF-8'},base64Encode:b=>Buffer.from(b).toString('base64'),computeHmacSha256Signature:()=>[1]},
    ContentService:{MimeType:{JSON:'json'},createTextOutput:text=>({setMimeType:()=>JSON.parse(text)})}});
  vm.runInContext(fs.readFileSync(new URL('../free/Code.gs',import.meta.url),'utf8'),api);
  const result=api.doPost({postData:{contents:JSON.stringify({timestamp:'1000000000000',rawBody:'{}',mac:'bad'})}});
  assert.equal(result.ok,false);
});

function backendSandbox(db,call) {
  const api=vm.createContext({AccountingCore:core,console,Utilities:{formatDate:()=> '2027-04-10',getUuid:()=> 'test-retry-key'},
    PropertiesService:{getScriptProperties:()=>({getProperties:()=>({})})}});
  vm.runInContext(fs.readFileSync(new URL('../free/Code.gs',import.meta.url),'utf8'),api);
  api.lineCall_=call;db.flush=()=>{};
  return api;
}
const response=(code,body={})=>({getResponseCode:()=>code,getContentText:()=>JSON.stringify(body),getAllHeaders:()=>({})});
test('無料Push上限では送信せず、利用状況を保存する',()=>{
  const db=memory();db.put('outbox','one',{id:'one',state:'pending',messages:[core.text('test')],meta:{}});
  const calls=[];
  const api=backendSandbox(db,(path)=>{calls.push(path);return response(200,path.endsWith('consumption')?{totalUsage:180}:{type:'limited',value:200});});
  api.flushPush_(db,{});
  assert.equal(calls.includes('/message/push'),false);
  assert.equal(db.get('outbox','one').state,'pending');assert.equal(db.get('meta','pushUsage').limit,180);
});
test('Pushの再試行は同じretry keyを使い、送信後は再送しない',()=>{
  const db=memory();db.put('outbox','one',{id:'one',state:'pending',target:'user',messages:[core.text('test')],meta:{},retry:'same-key'});
  const retries=[];let succeeds=false;
  const api=backendSandbox(db,(path,body,retry)=>{
    if(path==='/message/push'){retries.push(retry);return response(succeeds?200:500);}
    return response(200,path.endsWith('consumption')?{totalUsage:0}:{type:'limited',value:200});
  });
  api.flushPush_(db,{});assert.equal(db.get('outbox','one').state,'pending');
  succeeds=true;api.flushPush_(db,{});api.flushPush_(db,{});
  assert.deepEqual(retries,['same-key','same-key']);assert.equal(db.get('outbox','one').state,'sent');
});
test('完了済み・期限の過ぎた予約通知をPushで送らない',()=>{
  const db=memory();db.put('payment','p',{status:'paid'});
  db.put('outbox','done',{id:'done',state:'pending',meta:{payment:'p',day:'2027-04-10'}});
  db.put('payment','q',{status:'pending'});
  db.put('outbox','old',{id:'old',state:'pending',meta:{payment:'q',day:'2027-04-09'}});
  const paths=[];
  const api=backendSandbox(db,path=>{paths.push(path);return response(200,path.endsWith('consumption')?{totalUsage:0}:{type:'limited',value:200});});
  api.flushPush_(db,{});
  assert.equal(paths.includes('/message/push'),false);
  assert.equal(db.get('outbox','done').state,'skipped');assert.equal(db.get('outbox','old').state,'skipped');
});

test('Gmail候補は同一メールを再登録せず、複数期限は確認する',()=>{
  const {db,ctx}=fixture(),api=backendSandbox(db,()=>{throw new Error('unexpected LINE call');});
  api.Gmail={Users:{getProfile:()=>({emailAddress:'tbahousoukai@gmail.com'}),Messages:{
    list:()=>({messages:[{id:'invoice-1'}]}),
    get:()=>({payload:{headers:[{name:'subject',value:'テスト請求書'}]},snippet:'請求金額 1,000円\n支払期限 2027/04/10\n振込期限 2027/04/11'})}}};
  api.gmailWork_(db,{LINE_NOTIFICATION_TARGET:'user'},ctx);
  const d=db.list('draft').find(d=>d.kind==='payment');
  assert.equal(d.body.金額,1000);assert.equal(d.body.期限,null);assert.equal(d.body.会社,null);
  api.gmailWork_(db,{LINE_NOTIFICATION_TARGET:'user'},ctx);
  assert.equal(db.list('draft').filter(d=>d.kind==='payment').length,1);
  assert.equal(db.list('outbox').length,1);
});
test('Gmailは放送会以外の接続先を拒否する',()=>{
  const {db,ctx}=fixture(),api=backendSandbox(db,()=>{});
  api.Gmail={Users:{getProfile:()=>({emailAddress:'other@example.invalid'})}};
  assert.throws(()=>api.gmailWork_(db,{},ctx),/接続先/);
});
