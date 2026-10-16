/* Googleサービスに依存しない会計処理。Core.test.mjsで同じコードを検証する。 */
var AccountingCore = (function () {
  'use strict';
  const ACCOUNTS = ['団体口座', '公金口座'];
  const CATEGORIES = [
    '収．前年度繰越金/団体口座','収．前年度繰越金/公金口座','収．援助金/分配金','収．援助金/学事援助金','収．援助金/イベント援助金','収．援助金/後援会補助','収．援助金/そのほか',
    '収．顕彰・奨励/五島育英基金','収．顕彰・奨励/学内表彰','収．顕彰・奨励/学外表彰','収．顕彰・奨励/強化指定','収．顕彰・奨励/そのほか','収．部費','収．イベント売上金/学祭売上金','収．イベント売上金/個別イベント売上金','収．広告収入','収．謝金','収．寄付金','収．受取利息','収．雑収入',
    '支．連盟加盟費','支．大会・イベント参加費','支．会場使用料','支．諸使用料','支．保険料','支．備品費','支．消耗品費','支．維持・修繕費','支．図書費','支．印刷製本費','支．会議費','支．通信費','支．旅費・交通費','支．懇親会費','支．謝金','支．業務委託費','支．振込手数料','支．雑費',
    '支．上期末残高/団体口座','支．上期末残高/公金口座','支．次年度繰越金/団体口座','支．次年度繰越金/公金口座'
  ];
  const GUIDES = {
    '事後申請':'① 団体口座または自費で購入\n② ご利用明細と購入品の請求書を学士（1号館）に提出\n③ 金額確認後、公金口座の通帳を受領\n④ 公金口座から団体口座へ送金\n⑤ 16:30までに公金口座の通帳を学士に返却',
    '事前申請':'① 請求書を印刷\n② 学士に提出\n③ 公金口座から団体口座へ送金（16:30までに通帳を学士に返却）\n④ 団体口座から各会社へ送金\n⑤ ご利用明細を学士に提出',
    '団体口座':'三菱UFJ銀行\n①「通帳記入」\n②「お振込み」\n③ 暗証番号は会計に聞く\n④ 振込したい銀行を選択\n⑤ 金額入力\n⑥ 名前等は登録しない\n⑦ ご利用明細書発行（金額印字）\n⑧「通帳記入」'
  };
  function text(s) { return {type:'text', text:String(s).slice(0,4900)}; }
  function buttons(s, actions) {
    return {type:'template',altText:s.slice(0,400),template:{type:'buttons',text:s.slice(0,160),
      actions:actions.map(a=>({type:'postback',label:a[0],data:a[1],displayText:a[0]}))}};
  }
  function money(n) {
    if (!Number.isSafeInteger(n) || n < 0 || n > 999999999999) throw new Error('金額・残高は0以上の整数円で確認してください。');
    return n;
  }
  function day(s) {
    if (typeof s !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(Date.parse(s+'T00:00:00Z')) ||
        new Date(s+'T00:00:00Z').toISOString().slice(0,10)!==s) throw new Error('日付は実在する日をYYYY-MM-DD形式で入力してください。');
    return s;
  }
  function audit(db, actor, action, target, ctx) { db.put('audit',ctx.id(),{actor,action,target,created:ctx.now()}); }
  function draft(db, owner, kind, body, source, ctx) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('入力形式を確認してください。');
    if (source && db.get('source',source)) return db.get('draft',db.get('source',source).id);
    const d={id:ctx.id(),owner,kind,body,state:'pending',created:ctx.now()};
    db.put('draft',d.id,d);
    if(source) db.put('source',source,{id:d.id});
    audit(db,owner,'draft',d.id,ctx);
    return d;
  }
  function getDraft(db,id,user) {
    const d=db.get('draft',id);
    if(!d || ![user,'*'].includes(d.owner)) throw new Error('この確認内容を操作できません。');
    if(d.state!=='pending') throw new Error('この確認内容は処理済みです。');
    return d;
  }
  function normalize(b) {
    if(b._写真明細 && b._入金額表記 && b.口座==='団体口座') b.方向='支出';
    return b;
  }
  function confirm(db,id,user,ctx) {
    const d=getDraft(db,id,user), b=normalize(d.body);
    if(d.kind==='opening') {
      day(b.日付); ACCOUNTS.forEach(a=>money(b[a]));
      if(db.get('opening','initial')) throw new Error('開始残高は登録済みです。');
      db.put('opening','initial',b);
    } else if(d.kind==='payment') {
      day(b.期限); money(b.金額);
      if(typeof b.会社!=='string' || !b.会社.trim() || b.会社.length>200) throw new Error('会社名を確認してください。');
      db.put('payment',id,{id,company:b.会社,amount:b.金額,due:b.期限,status:'pending'});
    } else if(d.kind==='transaction') {
      const opening=db.get('opening','initial');
      if(!opening) throw new Error('先に「開始残高」を登録してください。');
      day(b.日付);
      if(b.日付<opening.日付) throw new Error('開始日より前の取引は登録できません。');
      if(!ACCOUNTS.includes(b.口座) || !['収入','支出'].includes(b.方向) || typeof b.内部振替!=='boolean') throw new Error('口座・方向・内部振替を確認してください。');
      money(b.金額); money(b.手数料); money(b.残高);
      if(!b.内部振替) {
        if(!CATEGORIES.includes(b.科目) || b.科目[0]!== (b.方向==='収入'?'収':'支')) throw new Error('方向に合う会計科目を指定してください。');
        if(/繰越|期末残高\//.test(b.科目)) throw new Error('繰越・締めの科目は通常取引に指定できません。');
        if(b.科目==='支．振込手数料' && b.手数料!==0) throw new Error('手数料単独の取引では金額に手数料を入れ、手数料欄は0にしてください。');
      }
      db.put('transaction',id,{id,body:b,created:ctx.now(),sequence:db.list('transaction').length+1,voided:false});
    } else if(d.kind==='void') {
      const t=db.get('transaction',b.取引ID);
      if(!t || t.voided) throw new Error('取消対象の取引が見つかりません。');
      t.voided=true; db.put('transaction',t.id,t);
    } else throw new Error('登録種別が無効です。');
    d.state='confirmed'; db.put('draft',id,d); audit(db,user,'confirm',id,ctx);
    if(['opening','transaction','void'].includes(d.kind)) db.put('meta','export',{dirty:true});
    return d;
  }
  function ledger(db) {
    const result=[], opening=db.get('opening','initial');
    if(opening) ACCOUNTS.forEach(a=>result.push([opening.日付,'収．前年度繰越金/'+a,opening[a],0]));
    db.list('transaction').filter(t=>!t.voided).sort((a,b)=>a.body.日付.localeCompare(b.body.日付)||a.sequence-b.sequence).forEach(t=>{
      const b=t.body;
      if(!b.内部振替) result.push([b.日付,b.科目,b.方向==='収入'?b.金額:0,b.方向==='支出'?b.金額+b.手数料:0]);
      if(b.手数料 && (b.内部振替||b.方向==='収入')) result.push([b.日付,'支．振込手数料',0,b.手数料]);
    });
    return result;
  }
  function balance(db,account) {
    const tx=db.list('transaction').filter(t=>!t.voided&&t.body.口座===account).sort((a,b)=>b.body.日付.localeCompare(a.body.日付)||b.sequence-a.sequence)[0];
    if(tx) return [tx.body.残高,tx.body.日付];
    const o=db.get('opening','initial'); return o?[o[account],o.日付]:null;
  }
  function suggest(description,direction) {
    if(typeof description!=='string'||!['収入','支出'].includes(direction)) return null;
    const rules=direction==='収入'?{'収．部費':['部費'],'収．受取利息':['受取利息','預金利息'],'収．寄付金':['寄付金'],'収．広告収入':['広告掲載料']}:
      {'支．連盟加盟費':['連盟加盟費'],'支．大会・イベント参加費':['大会参加費','イベント参加費'],'支．保険料':['スポーツ安全保険','保険料'],
       '支．図書費':['図書代','書籍代','新聞購読料','雑誌代'],'支．印刷製本費':['印刷代','製本代'],'支．通信費':['切手代','郵送料','電話代'],
       '支．旅費・交通費':['宿泊費','電車代','バス代'],'支．維持・修繕費':['修理代','修繕費']};
    const hits=Object.keys(rules).filter(k=>rules[k].some(w=>description.includes(w)));
    return hits.length===1?hits[0]:null;
  }
  function revise(db,d,patch,user,ctx) {
    if(!patch || typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).some(k=>k.startsWith('_')||!Object.prototype.hasOwnProperty.call(d.body,k))) throw new Error('表示された項目名を指定してください。');
    Object.assign(d.body,patch); normalize(d.body);
    if('内容' in patch&&!d.body.科目) d.body.科目=suggest(d.body.内容,d.body.方向);
    db.put('draft',d.id,d); audit(db,user,'revise',d.id,ctx); return d;
  }
  function preview(d) {
    if(d.state!=='pending') return [text('この確認内容は処理済みです。ID: '+d.id)];
    const b=Object.fromEntries(Object.entries(d.body).filter(([k])=>!k.startsWith('_')));
    const sum=d.kind==='transaction'&&b.方向==='支出'&&!b.内部振替&&Number.isSafeInteger(b.金額)&&Number.isSafeInteger(b.手数料)?'\nExcelの支出金額: '+(b.金額+b.手数料).toLocaleString('ja-JP')+'円':'';
    return [text('確認ID: '+d.id+'\n'+JSON.stringify(b,null,2)+sum+'\n未入力は確認が必要です。「口座 団体口座」「内部振替 いいえ」「科目 支．消耗品費」などで修正してください。複数件ある場合は「修正 ID {…}」を使います。'),
      buttons('内容を確認して登録してください。',[['登録','confirm:'+d.id],['破棄','cancel:'+d.id]])];
  }
  function paymentMessage(p,prefix) { return buttons((prefix||'支払予定')+'\n'+p.company.slice(0,50)+'\n'+p.amount.toLocaleString('ja-JP')+'円\n期限: '+p.due,[['完了','done:'+p.id]]); }
  function pendingPayments(db) { return db.list('payment').filter(p=>p.status==='pending').sort((a,b)=>a.due.localeCompare(b.due)); }
  function dueReminders(db,today) {
    day(today);
    return pendingPayments(db).map(p=>({payment:p,days:Math.round((Date.parse(p.due+'T00:00:00Z')-Date.parse(today+'T00:00:00Z'))/86400000)})).filter(r=>[3,1,0].includes(r.days));
  }
  function extractDate(s) {
    const matches=Array.from(s.matchAll(/(20\d{2})[年/.-](\d{1,2})[月/.-](\d{1,2})日?/g));
    if(matches.length!==1) return null;
    const m=matches[0], value=m[1]+'-'+m[2].padStart(2,'0')+'-'+m[3].padStart(2,'0');
    try{return day(value);}catch{return null;}
  }
  function singleMoney(s,label) {
    const hits=Array.from(s.matchAll(new RegExp(label+'\\s*[:：]?\\s*[¥￥]?\\s*([0-9][0-9,]*)\\s*円?','g')));
    return hits.length===1?Number(hits[0][1].replace(/,/g,'')):null;
  }
  function receipt(raw) {
    const s=raw.normalize('NFKC'), income=singleMoney(s,'(?:お預入金額|入金額)'), expense=singleMoney(s,'(?:お振込金額|振込金額|お引出金額)');
    return {日付:extractDate(s),口座:null,方向:expense!==null&&income===null?'支出':null,金額:income!==null&&expense===null?income:expense!==null&&income===null?expense:null,
      手数料:singleMoney(s,'(?:振込手数料|手数料)'),残高:singleMoney(s,'(?:お取引後残高|お取引後の残高|残高)'),内部振替:null,科目:null,内容:null,_写真明細:true,_入金額表記:income!==null&&expense===null};
  }
  const HELP='放送会 会計サポート\n事前申請／事後申請／団体口座／公金口座\n団体口座 残高／公金口座 残高\n写真を送る→読取候補を確認→登録\n科目一覧／未払い／確認待ち／会計ファイル／利用状況\n\n開始残高 {"日付":"2027-04-01","団体口座":0,"公金口座":0}\n取引 {"日付":"2027-04-02","口座":"団体口座","方向":"支出","金額":1000,"手数料":110,"残高":0,"内部振替":false,"科目":"支．消耗品費","内容":null}\n支払登録 {"会社":"会社名","金額":1000,"期限":"2027-04-10"}\n例の日付・金額は実際の値に置き換えてください。';
  function respond(db,event,user,config,ctx) {
    if(event.type==='postback') {
      const match=/^(confirm|cancel|done):([a-f0-9]{12})$/.exec(event.postback.data);
      if(!match) throw new Error('操作IDが無効です。');
      const action=match[1],id=match[2];
      if(action==='done') {
        const p=db.get('payment',id);
        if(!p||p.status!=='pending') return [text('この支払いは処理済みか、見つかりません。')];
        p.status='paid';p.completed=ctx.now();db.put('payment',id,p);audit(db,user,'complete',id,ctx);
        return [text('支払済みにしました。以降の通知を停止します。実際の明細写真は別途送ってください。')];
      }
      if(action==='cancel') {const d=getDraft(db,id,user);d.state='cancelled';db.put('draft',id,d);audit(db,user,'cancel',id,ctx);return [text('確認内容を破棄しました。')];}
      confirm(db,id,user,ctx); return [text('登録しました。ID: '+id+'\nExcelは次の定期処理で更新します。')];
    }
    if(event.type!=='message') return [];
    if(event.message.type!=='text') return [text('文字または利用明細の写真を送ってください。')];
    const s=event.message.text.trim(), compact=s.replace(/[\s　]+/g,'');
    if(GUIDES[compact]) return [text(GUIDES[compact])];
    if(compact==='公金口座') return [text(config.TRANSFER_BRANCH&&config.TRANSFER_ACCOUNT?'みずほ銀行\n①「通帳記入」\n②「お振込み」\n③「三菱UFJ銀行 '+config.TRANSFER_BRANCH+'」\n④ 口座番号（'+config.TRANSFER_ACCOUNT+'）\n⑤ 暗証番号は会計に聞く\n⑥ 金額入力\n⑦ ご利用明細書発行（金額印字）\n⑧「通帳記入」':'振込先設定を会計担当者に確認してください。')];
    for(const a of ACCOUNTS) if(compact===a+'残高') {const v=balance(db,a);return [text(v?a+': '+v[0].toLocaleString('ja-JP')+'円\n明細日: '+v[1]+'\n登録済み明細の残高です。':'開始残高が未登録です。')];}
    if(compact==='科目一覧') return [text(CATEGORIES.join('\n'))];
    if(compact==='未払い') {const p=pendingPayments(db);return p.length?p.slice(0,4).map(p=>paymentMessage(p)):[text('未払いはありません。')];}
    if(compact==='確認待ち') {const d=db.list('draft').filter(d=>d.state==='pending'&&[user,'*'].includes(d.owner));return d.length?d.slice(0,2).flatMap(preview):[text('確認待ちはありません。')];}
    if(compact==='会計ファイル') {
      db.put('meta','export',{dirty:true});const f=db.get('meta','excel');
      return [text(f?'会計ファイル（Googleへのログインが必要です）\nhttps://drive.google.com/file/d/'+f.id+'/view\n更新待ちの取引は次の定期処理で反映します。':'会計ファイルを準備しています。数分後にもう一度送ってください。')];
    }
    if(compact==='利用状況') {const u=db.get('meta','pushUsage');return [text('定期通知・写真の結果は無料枠の上限前に停止します。\n'+(u?'LINE配信数: '+u.used+' / '+u.limit+'（'+u.checked+'時点）':'配信数は次の定期処理で確認します。')+'\n通常の返信は無料枠の配信数に含まれません。')];}
    let m=/^修正\s+([a-f0-9]{12})\s+([\s\S]+)$/.exec(s);
    if(m) return preview(revise(db,getDraft(db,m[1],user),JSON.parse(m[2]),user,ctx));
    m=/^取消\s+([a-f0-9]{12})$/.exec(s);
    if(m) return preview(draft(db,user,'void',{取引ID:m[1]},'event:'+event.webhookEventId,ctx));
    m=/^(開始残高|取引|支払登録)\s+([\s\S]+)$/.exec(s);
    if(m) return preview(draft(db,user,{'開始残高':'opening','取引':'transaction','支払登録':'payment'}[m[1]],JSON.parse(m[2]),'event:'+event.webhookEventId,ctx));
    m=/^(口座|方向|金額|手数料|残高|日付|科目|内容|内部振替|会社|期限)\s+([\s\S]+)$/.exec(s);
    if(m) {
      const pending=db.list('draft').filter(d=>d.state==='pending'&&[user,'*'].includes(d.owner));
      if(pending.length!==1) throw new Error('「確認待ち」でIDを確認し、「修正 ID {…}」で対象を指定してください。');
      let v=m[2];
      if(['金額','手数料','残高'].includes(m[1])) {if(!/^[0-9,]+円?$/.test(v))throw new Error('整数円で入力してください。');v=Number(v.replace(/[,円]/g,''));}
      if(m[1]==='内部振替') {if(!['はい','いいえ'].includes(v))throw new Error('「内部振替 はい」または「内部振替 いいえ」と送ってください。');v=v==='はい';}
      return preview(revise(db,pending[0],{[m[1]]:v},user,ctx));
    }
    return [text(HELP)];
  }
  return {ACCOUNTS,CATEGORIES,text,buttons,money,day,draft,getDraft,confirm,revise,ledger,balance,suggest,preview,paymentMessage,pendingPayments,dueReminders,extractDate,singleMoney,receipt,respond,audit};
})();
