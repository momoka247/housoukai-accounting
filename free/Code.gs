/* Apps Scriptサーバー。設定値はスクリプトプロパティにだけ保存する。 */
function config_() { return PropertiesService.getScriptProperties().getProperties(); }
function context_() { return {id:()=>Utilities.getUuid().replace(/-/g,'').slice(0,12),now:()=>new Date().toISOString()}; }
function output_(body) { return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON); }
function safeEqual_(a,b) { if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;let n=0;for(let i=0;i<a.length;i++)n|=a.charCodeAt(i)^b.charCodeAt(i);return n===0; }
function mac_(secret,s) { return Utilities.base64Encode(Utilities.computeHmacSha256Signature(s,secret,Utilities.Charset.UTF_8)); }

class Database_ {
  constructor() {
    const id=config_().DATABASE_ID;
    if(!id)throw new Error('setupを先に実行してください。');
    this.sheet=SpreadsheetApp.openById(id).getSheets()[0];
    this.rows=new Map();this.dirty=new Set();
    if(this.sheet.getLastRow()>1) this.sheet.getRange(2,1,this.sheet.getLastRow()-1,2).getValues().forEach((r,i)=>{
      if(r[0])this.rows.set(String(r[0]),{row:i+2,json:String(r[1])});
    });
  }
  key(kind,id) {return kind+':'+id;}
  get(kind,id) {const r=this.rows.get(this.key(kind,id));return r?JSON.parse(r.json):null;}
  list(kind) {return Array.from(this.rows).filter(([k])=>k.startsWith(kind+':')).map(([,r])=>JSON.parse(r.json));}
  put(kind,id,value) {
    const key=this.key(kind,id),json=JSON.stringify(value);
    if(json.length>45000)throw new Error('1件のデータが長すぎます。');
    const existing=this.rows.get(key);this.rows.set(key,{row:existing?existing.row:null,json});this.dirty.add(key);
  }
  flush() {
    const add=[];
    for(const key of this.dirty) {
      const r=this.rows.get(key);
      if(r.row)this.sheet.getRange(r.row,2).setValue(r.json);else add.push([key,r.json]);
    }
    if(add.length) {
      const first=this.sheet.getLastRow()+1;
      if(first+add.length-1>this.sheet.getMaxRows())this.sheet.insertRowsAfter(this.sheet.getMaxRows(),first+add.length-1-this.sheet.getMaxRows());
      this.sheet.getRange(first,1,add.length,2).setValues(add);
      add.forEach((r,i)=>{this.rows.get(r[0]).row=first+i;});
    }
    SpreadsheetApp.flush();this.dirty.clear();
  }
}

function setup() {
  const c=config_(),p=PropertiesService.getScriptProperties();
  ['LINE_CHANNEL_ACCESS_TOKEN','LINE_ALLOWED_USER_IDS','LINE_NOTIFICATION_TARGET','GATEWAY_SHARED_SECRET','EXCEL_TEMPLATE_FILE_ID'].forEach(k=>{if(!c[k])throw new Error(k+'を設定してください。');});
  if(c.GATEWAY_SHARED_SECRET.length<32)throw new Error('共通秘密鍵は32文字以上にしてください。');
  const expected=c.GMAIL_ACCOUNT||'tbahousoukai@gmail.com';
  if(Session.getEffectiveUser().getEmail().toLowerCase()!==expected.toLowerCase())throw new Error('放送会アカウントで実行してください。');
  let folder;
  if(c.OUTPUT_FOLDER_ID)folder=DriveApp.getFolderById(c.OUTPUT_FOLDER_ID);
  else {folder=DriveApp.createFolder('放送会会計（非公開）');p.setProperty('OUTPUT_FOLDER_ID',folder.getId());}
  if(!c.DATABASE_ID) {
    const db=SpreadsheetApp.create('放送会会計 内部記録');
    db.getSheets()[0].setName('records').getRange(1,1,1,2).setValues([['key','json']]);
    DriveApp.getFileById(db.getId()).moveTo(folder);p.setProperty('DATABASE_ID',db.getId());
  }
  if(!c.LEDGER_ID) {
    const source=DriveApp.getFileById(c.EXCEL_TEMPLATE_FILE_ID);
    const converted=Drive.Files.create({name:'放送会 会計ファイル（原本）',mimeType:'application/vnd.google-apps.spreadsheet',parents:[folder.getId()]},source.getBlob(),{fields:'id'});
    p.setProperty('LEDGER_ID',converted.id);
  }
  // 既存の他の関数のトリガーには触れず、重複を避ける。
  if(!ScriptApp.getProjectTriggers().some(t=>t.getHandlerFunction()==='tick'))ScriptApp.newTrigger('tick').timeBased().everyMinutes(5).create();
  console.log('設定完了。ファイルはマイドライブの「放送会会計（非公開）」にあります。');
}

function doGet() {return output_({ok:true,service:'housoukai-accounting'});}

function doPost(e) {
  const c=config_();let envelope,body;
  try {
    if(!e||!e.postData||e.postData.contents.length>400000)throw new Error();
    envelope=JSON.parse(e.postData.contents);
    if(!c.GATEWAY_SHARED_SECRET||typeof envelope.rawBody!=='string'||!/^\d{13}$/.test(envelope.timestamp)||Math.abs(Date.now()-Number(envelope.timestamp))>300000)throw new Error();
    if(!safeEqual_(mac_(c.GATEWAY_SHARED_SECRET,envelope.timestamp+'\n'+envelope.rawBody),envelope.mac))throw new Error();
    body=JSON.parse(envelope.rawBody);if(!Array.isArray(body.events))throw new Error();
  } catch(_) {return output_({ok:false});}
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(1500))return output_({ok:false}); // LINE再送で再試行する
  try {
    const db=new Database_(),ctx=context_();
    for(const event of body.events) {
      const source=event.source||{},user=source.userId;
      const target=source.groupId||source.roomId||user;
      if(!target)continue;
      const publicEvent=AccountingCore.isPublicEvent(event);
      const editor=AccountingCore.isEditor(user,c);
      if(!publicEvent&&(!editor||(source.type!=='user'&&target!==c.LINE_NOTIFICATION_TARGET))) {
        if(event.replyToken&&(event.type==='message'||event.type==='postback')) {
          lineCall_('/message/reply',{replyToken:event.replyToken,messages:[AccountingCore.text('この操作は指定の会計担当者のみ利用できます。担当者は個別トークまたは設定済みの会計用グループで操作してください。\n\n全員が使える機能は「使い方」と送ると確認できます。')]});
        }
        continue;
      }
      if(typeof event.webhookEventId!=='string'||event.webhookEventId.length>150)continue;
      // 操作の保存と返信を分離。再送で会計の登録を繰り返さない。
      let saved=db.get('event',event.webhookEventId);
      if(saved&&saved.replied)continue;
      let messages=saved?saved.messages:[];
      if(!saved) {
        if(event.type==='message'&&event.message.type==='image') {
          db.put('photo',event.message.id,{id:event.message.id,owner:user,target,state:'pending',created:ctx.now()});
          messages=[AccountingCore.text('写真を受け付けました。数分後に読み取り結果をお送りします。無料配信枠に達した場合は「確認待ち」で結果を確認できます。')];
        } else {
          try {messages=AccountingCore.respond(db,event,user,c,ctx);}
          catch(error) {messages=[AccountingCore.text(error instanceof SyntaxError?'入力形式を確認してください。「ヘルプ」で例を表示します。':error.message||'入力内容を確認してください。')];}
        }
        saved={id:event.webhookEventId,messages,replied:false,created:ctx.now()};
        db.put('event',event.webhookEventId,saved);db.flush();
      }
      if(messages.length&&event.replyToken) {
        const code=lineCall_('/message/reply',{replyToken:event.replyToken,messages:messages.slice(0,5)}).getResponseCode();
        if(code!==200&&code!==400)throw new Error('LINE応答エラー');
        // token期限切れ・使用済みでもPushに切り替えず、無料枠を消費しない。
      }
      saved.replied=true;saved.messages=[];db.put('event',event.webhookEventId,saved);db.flush();
    }
    return output_({ok:true});
  } catch(_) {console.error('Webhook処理に失敗しました。認証情報・本文はログに記録していません。');return output_({ok:false});}
  finally {lock.releaseLock();}
}

function lineCall_(path,body,retry) {
  const options={method:body?'post':'get',muteHttpExceptions:true,headers:{Authorization:'Bearer '+config_().LINE_CHANNEL_ACCESS_TOKEN}};
  if(body){options.contentType='application/json';options.payload=JSON.stringify(body);}
  if(retry)options.headers['X-Line-Retry-Key']=retry;
  return UrlFetchApp.fetch('https://api.line.me/v2/bot'+path,options);
}
function queuePush_(db,key,target,messages,meta) {
  if(!db.get('outbox',key))db.put('outbox',key,{id:key,target,messages,meta:meta||{},state:'pending',retry:Utilities.getUuid()});
}
function flushPush_(db,c) {
  const pending=db.list('outbox').filter(o=>o.state==='pending');
  if(!pending.length)return;
  const quota=lineCall_('/message/quota'),consumption=lineCall_('/message/quota/consumption');
  if(quota.getResponseCode()!==200||consumption.getResponseCode()!==200)return; // 不明時は送らない
  const q=JSON.parse(quota.getContentText()),usage=JSON.parse(consumption.getContentText());
  // 公式LINEが有料でもこのアプリは月180通以下。無料枠200通に余裕を残す。
  const limit=Math.min(180,Number(c.LINE_PUSH_BUDGET||180),q.type==='limited'?q.value:180);
  let used=usage.totalUsage;
  if(!Number.isFinite(used)||!Number.isFinite(limit)||limit<0)return;
  const today=Utilities.formatDate(new Date(),'Asia/Tokyo','yyyy-MM-dd');
  for(const o of pending.slice(0,5)) {
    if(o.meta.payment) {
      const p=db.get('payment',o.meta.payment);
      if(!p||p.status==='paid'||o.meta.day!==today){o.state='skipped';db.put('outbox',o.id,o);continue;}
    }
    if(used>=limit)break;
    db.flush(); // 送信前にretry keyを永続化
    const response=lineCall_('/message/push',{to:o.target,messages:o.messages.slice(0,5)},o.retry),code=response.getResponseCode();
    const headers=response.getAllHeaders();
    if(code===200||(code===409&&Object.keys(headers).some(k=>k.toLowerCase()==='x-line-accepted-request-id'))) {
      o.state='sent';o.messages=[];db.put('outbox',o.id,o);used++;db.flush();
    } else if(code===429)break;
    else if(code>=400&&code<500){o.state='failed';db.put('outbox',o.id,o);}
    else break;
  }
  db.put('meta','pushUsage',{used,limit,checked:Utilities.formatDate(new Date(),'Asia/Tokyo','yyyy-MM-dd HH:mm')});
}

function photoWork_(db,c,ctx) {
  const photo=db.list('photo').find(p=>p.state==='pending');
  if(!photo)return;
  try {
    const response=UrlFetchApp.fetch('https://api-data.line.me/v2/bot/message/'+encodeURIComponent(photo.id)+'/content',
      {headers:{Authorization:'Bearer '+c.LINE_CHANNEL_ACCESS_TOKEN},muteHttpExceptions:true});
    if(response.getResponseCode()!==200)throw new Error('写真を再送してください。');
    const blob=response.getBlob();
    if(blob.getBytes().length>2*1024*1024)throw new Error('写真を2MB以下にして再送してください。');
    const hash=Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,blob.getBytes()));
    const existing=db.get('source','image:'+hash);
    let d;
    if(existing)d=db.get('draft',existing.id);
    else {
      let docId;
      try {
        const doc=Drive.Files.create({name:'明細OCR（一時）',mimeType:'application/vnd.google-apps.document',parents:[c.OUTPUT_FOLDER_ID]},blob.setName('receipt.jpg'),{ocrLanguage:'ja',fields:'id'});
        docId=doc.id;
        const raw=DocumentApp.openById(docId).getBody().getText();
        d=AccountingCore.draft(db,photo.owner,'transaction',AccountingCore.receipt(raw),'image:'+hash,ctx);
      } finally {if(docId)DriveApp.getFileById(docId).setTrashed(true);}
    }
    queuePush_(db,'photo:'+photo.id,photo.target,AccountingCore.preview(d));
    photo.state='done';
  } catch(error) {
    queuePush_(db,'photo-error:'+photo.id,photo.target,[AccountingCore.text('写真を読み取れませんでした。2MB以下の鮮明な画像を再送するか、「取引」で入力してください。')]);
    photo.state='failed';
  }
  db.put('photo',photo.id,photo);
}

function gmailWork_(db,c,ctx) {
  const profile=Gmail.Users.getProfile('me');
  if(profile.emailAddress.toLowerCase()!==(c.GMAIL_ACCOUNT||'tbahousoukai@gmail.com').toLowerCase())throw new Error('Gmail接続先が異なります。');
  const listed=Gmail.Users.Messages.list('me',{q:'newer_than:60d {請求 支払 振込 入金}',maxResults:50});let processed=0;
  for(const item of listed.messages||[]) {
    if(db.get('source','gmail:'+item.id))continue;
    if(processed++>=5)break;
    const m=Gmail.Users.Messages.get('me',item.id,{format:'full'}),headers={};
    (m.payload.headers||[]).forEach(h=>{headers[h.name.toLowerCase()]=h.value;});
    const parts=[];
    function walk(p) {if(p.mimeType==='text/plain'&&p.body&&p.body.data)parts.push(Utilities.newBlob(Utilities.base64DecodeWebSafe(p.body.data)).getDataAsString('UTF-8'));(p.parts||[]).forEach(walk);}
    walk(m.payload);const body=(parts.join('\n')||m.snippet||'').normalize('NFKC').slice(0,100000);
    const deadlines=Array.from(body.matchAll(/(?:支払期限|お支払期限|振込期限|入金期限)[^\n]{0,12}?(20\d{2}[年/.-]\d{1,2}[月/.-]\d{1,2}日?)/g));
    const value={会社:null,金額:AccountingCore.singleMoney(body,'(?:ご請求金額|請求金額|お支払金額)'),期限:deadlines.length===1?AccountingCore.extractDate(deadlines[0][1]):null,
      メール件名:(headers.subject||'').slice(0,250),差出人:(headers.from||'').slice(0,250)};
    const d=AccountingCore.draft(db,'*','payment',value,'gmail:'+item.id,ctx);
    queuePush_(db,'gmail:'+item.id,c.LINE_NOTIFICATION_TARGET,AccountingCore.preview(d));
  }
}

function exportExcel_(db,c) {
  const data=AccountingCore.ledger(db),book=SpreadsheetApp.openById(c.LEDGER_ID),sheet=book.getSheets()[0];
  const count=Math.max(37,data.length),last=6+count,total=last+1;
  if(total>sheet.getMaxRows())sheet.insertRowsAfter(sheet.getMaxRows(),total-sheet.getMaxRows());
  const working=sheet.getRange(7,1,sheet.getMaxRows()-6,8);
  working.breakApart().clearContent();
  sheet.getRange('A9:H9').copyFormatToRange(sheet,1,8,7,total);
  const values=[],formulas=[];
  for(let i=0;i<count;i++) {
    const r=data[i];
    values.push(r?[i+1,new Date(r[0]+'T00:00:00+09:00'),r[1],r[2]||'',r[3]||'','','','']:['','','','','','','','']);
    formulas.push([r?(i===0?'=D7-E7':'=F'+(i+6)+'+D'+(i+7)+'-E'+(i+7)):'']);
  }
  sheet.getRange(7,1,count,8).setValues(values);sheet.getRange(7,6,count,1).setFormulas(formulas);
  sheet.getRange(7,2,count,1).setNumberFormat('yyyy年m月d日');sheet.getRange(7,4,count+1,3).setNumberFormat('#,##0');
  sheet.getRange(total,2).setValue('合計');
  if(data.length)sheet.getRange(total,4,1,3).setFormulas([['=SUM(D7:D'+last+')','=SUM(E7:E'+last+')','=D'+total+'-E'+total]]);
  // 申請欄はデータも入力規則も空白にする。
  sheet.getRange(7,7,count+1,2).clearContent().clearDataValidations();SpreadsheetApp.flush();
  const mime='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const response=UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(c.LEDGER_ID)+'/export?mimeType='+encodeURIComponent(mime),
    {headers:{Authorization:'Bearer '+ScriptApp.getOAuthToken()},muteHttpExceptions:true});
  if(response.getResponseCode()!==200)throw new Error('Excel出力を再試行してください。');
  const blob=response.getBlob().setName('会計ファイル.xlsx'),previous=db.get('meta','excel');
  let id;
  if(previous){Drive.Files.update({name:'会計ファイル.xlsx'},previous.id,blob);id=previous.id;}
  else {id=Drive.Files.create({name:'会計ファイル.xlsx',parents:[c.OUTPUT_FOLDER_ID]},blob,{fields:'id'}).id;}
  db.put('meta','excel',{id,updated:new Date().toISOString()});db.put('meta','export',{dirty:false});
}

function tick() {
  const lock=LockService.getScriptLock();if(!lock.tryLock(1000))return;
  try {
    const db=new Database_(),c=config_(),ctx=context_();
    const run=function(name,work){try{work();db.flush();}catch(_){db.put('meta','error:'+name,{at:ctx.now(),message:name+'の処理を再確認してください。'});db.flush();console.error(name+'の処理に失敗しました。');}};
    run('写真',()=>photoWork_(db,c,ctx));
    const last=db.get('meta','gmailSync');
    if(!last||Date.now()-last.at>=15*60000)run('Gmail',()=>{gmailWork_(db,c,ctx);db.put('meta','gmailSync',{at:Date.now()});});
    run('Excel',()=>{if((db.get('meta','export')||{}).dirty)exportExcel_(db,c);});
    run('通知',()=>{
      const today=Utilities.formatDate(new Date(),'Asia/Tokyo','yyyy-MM-dd'),hour=Number(Utilities.formatDate(new Date(),'Asia/Tokyo','H'));
      if(hour>=9)AccountingCore.dueReminders(db,today).forEach(r=>queuePush_(db,'remind:'+r.payment.id+':'+r.days,c.LINE_NOTIFICATION_TARGET,
        [AccountingCore.paymentMessage(r.payment,r.days===0?'本日が支払期限です':'支払期限の'+r.days+'日前です')],{payment:r.payment.id,day:today}));
      flushPush_(db,c);
    });
  } finally {lock.releaseLock();}
}
