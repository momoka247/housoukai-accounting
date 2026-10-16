import hashlib
import json
import os
import re
import uuid
from datetime import datetime, date

from accounting import ACCOUNTS, JST, CATEGORIES
from integrations import line_image, ocr, receipt_draft, gmail_candidates, line_push, suggest_category

GUIDES = {
    '事後申請': '① 団体口座または自費で購入\n② ご利用明細と購入品の請求書を学士（1号館）に提出\n③ 金額確認後、公金口座の通帳を受領\n④ 公金口座から団体口座へ送金\n⑤ 16:30までに学士に公金口座の通帳を返却',
    '事前申請': '① 請求書を印刷\n② 学士に提出\n③ 公金口座から団体口座へ送金（16:30までに通帳を学士に返却）\n④ 団体口座から各会社に送金\n⑤ ご利用明細を学士に提出',
    '団体口座': '三菱UFJ銀行\n①「通帳記入」\n②「お振込み」\n③ 暗証番号は会計に聞く\n④ 振込したい銀行を選択\n⑤ 金額入力\n⑥ 名前等は登録しない\n⑦ ご利用明細書発行（金額印字）\n⑧「通帳記入」',
}

HELP = '''放送会 会計サポート
事前申請／事後申請／団体口座／公金口座
団体口座 残高／公金口座 残高
写真を送る → 読取候補を確認・修正 → 登録
科目一覧／未払い／確認待ち／会計ファイル

初回：開始残高 {"日付":"2027-04-01","団体口座":0,"公金口座":0}
手入力：取引 {"日付":"2027-04-02","口座":"団体口座","方向":"支出","金額":1000,"手数料":110,"残高":0,"内部振替":false,"科目":"支．消耗品費"}
支払予定：支払登録 {"会社":"会社名","金額":1000,"期限":"2027-04-10"}
修正：修正 確認ID {"口座":"団体口座","科目":"支．消耗品費"}
取引取消：取消 取引ID（確認ボタンあり）
例の金額・残高は実額に置き換えてください。'''


def text_message(text):
    return {'type': 'text', 'text': text[:4900]}


def buttons(text, actions):
    return {'type': 'template', 'altText': text[:400], 'template': {
        'type': 'buttons', 'text': text[:160], 'actions': [
            {'type': 'postback', 'label': label, 'data': data, 'displayText': label}
            for label, data in actions]}}


class Bot:
    def __init__(self, store, exporter=None):
        self.store = store
        self.exporter = exporter

    def queue(self, target, messages, key=None):
        key = key or uuid.uuid4().hex
        body = json.dumps({'target': target, 'messages': messages}, ensure_ascii=False)
        with self.store.db:
            self.store.db.execute('INSERT OR IGNORE INTO outbox VALUES(?,?,0)', (key, body))

    def preview(self, ident, kind, body):
        detail = json.dumps({k: v for k, v in body.items() if not k.startswith('_')}, ensure_ascii=False, indent=2)
        return [text_message(f'確認ID: {ident}\n{detail}\n未入力（null）や誤読がある場合は「修正 {ident} {{...}}」で変更してください。\n金額は振込本体、手数料は別に入力します。外部への支出は本体＋手数料をExcelの同じ行へ記録します。科目に迷う場合は「科目一覧」を確認してください。'),
                buttons('内容を確認して登録してください。', [('登録', 'confirm:' + ident), ('破棄', 'cancel:' + ident)])]

    def handle(self, event):
        source = event.get('source', {})
        user = source.get('userId', '')
        allowed = set(filter(None, os.environ.get('LINE_ALLOWED_USER_IDS', '').split(',')))
        if user not in allowed:
            return
        target = source.get('groupId') or source.get('roomId') or user
        configured = os.environ.get('LINE_NOTIFICATION_TARGET', '')
        if source.get('type') != 'user' and target != configured:
            return
        try:
            messages = self.respond(event, user)
        except (ValueError, KeyError, TypeError, json.JSONDecodeError) as e:
            # 入力例や秘密情報を含む例外詳細は返信しない。
            message = str(e) if isinstance(e, ValueError) and not isinstance(e, json.JSONDecodeError) else '入力項目・JSON形式を確認してください。「ヘルプ」で入力例を表示します。'
            messages = [text_message(message)]
        if messages:
            self.queue(target, messages, 'event:' + event['webhookEventId'])

    def respond(self, event, user):
        if event['type'] == 'postback':
            action, ident = event['postback']['data'].split(':', 1)
            if not re.fullmatch('[a-f0-9]{12}', ident):
                raise ValueError('確認IDが無効です。')
            if action == 'done':
                changed = self.store.complete(ident, user)
                return [text_message('支払済みにしました。以降の通知を停止します。明細写真は別途送ってください。' if changed else 'この支払いは処理済みか、見つかりません。')]
            if action == 'confirm':
                row, body = self.store.get_draft(ident, user)
                if row['kind'] == 'void':
                    self.store.void(body['取引ID'], user)
                    self.store.cancel(ident, user)
                else:
                    self.store.confirm(ident, user)
                if self.exporter:
                    try:
                        self.exporter(self.store)
                    except Exception:
                        # 登録成功とExcel出力失敗を明確に区別。再登録を誘発しない。
                        return [text_message('登録しました。ただしExcelの更新に失敗しました。ファイルを閉じて「会計ファイル」で再出力してください。')]
                return [text_message('登録しました。ID: ' + ident)]
            if action == 'cancel':
                self.store.cancel(ident, user)
                return [text_message('確認内容を破棄しました。')]
            return []
        if event['type'] != 'message':
            return []
        msg = event['message']
        if msg['type'] == 'image':
            image = line_image(msg['id'])
            digest = 'image:' + hashlib.sha256(image).hexdigest()
            existing = self.store.db.execute('SELECT draft_id FROM sources WHERE hash=?', (digest,)).fetchone()
            if existing:
                return [text_message('同じ写真は受付済みです。確認ID: ' + existing[0])]
            body = receipt_draft(ocr(image))
            ident, _ = self.store.draft(user, 'transaction', body, digest)
            return self.preview(ident, 'transaction', body)
        if msg['type'] != 'text':
            return [text_message('文字または利用明細の写真を送ってください。')]
        text = msg['text'].strip()
        compact = re.sub(r'[\s　]+', '', text)
        if compact in GUIDES:
            return [text_message(GUIDES[compact])]
        if compact == '公金口座':
            branch, account = os.environ.get('TRANSFER_BRANCH'), os.environ.get('TRANSFER_ACCOUNT')
            if not branch or not account:
                return [text_message('公金口座の振込先設定が未完了です。会計担当者に確認してください。')]
            return [text_message(f'みずほ銀行\n①「通帳記入」\n②「お振込み」\n③「三菱UFJ銀行 {branch}」\n④ 口座番号（{account}）\n⑤ 暗証番号は会計に聞く\n⑥ 金額入力\n⑦ ご利用明細書発行（金額印字）\n⑧「通帳記入」')]
        for account in ACCOUNTS:
            if compact == account + '残高':
                balance, day = self.store.balance(account)
                return [text_message(f'{account}: {balance:,}円\n明細日: {day}\n登録済み明細に基づく残高です。' if balance is not None else '開始残高が未登録です。')]
        if ' ' in text:
            field, raw = text.split(maxsplit=1)
            if field in ('口座', '方向', '金額', '手数料', '残高', '日付', '科目', '内容', '内部振替', '会社', '期限'):
                pending = self.store.db.execute("SELECT * FROM drafts WHERE state='pending' AND owner IN (?, '*') ORDER BY created", (user,)).fetchall()
                if len(pending) != 1:
                    raise ValueError('確認待ちが複数あるか、ありません。「確認待ち」でIDを確認し、「修正 ID {…}」を使ってください。')
                ident = pending[0]['id']
                _, body = self.store.get_draft(ident, user)
                if field not in body:
                    raise ValueError('この確認内容にない項目です。')
                if field in ('金額', '手数料', '残高'):
                    value = int(raw.replace(',', '').replace('円', ''))
                elif field == '内部振替':
                    if raw not in ('はい', 'いいえ'):
                        raise ValueError('「内部振替 はい」または「内部振替 いいえ」と送ってください。')
                    value = raw == 'はい'
                else:
                    value = raw
                body[field] = value
                if body.get('_写真明細') and body.get('_入金額表記') and body.get('口座') == '団体口座':
                    body['方向'] = '支出'
                if field == '内容' and not body.get('科目'):
                    body['科目'] = suggest_category(value, body.get('方向'))
                self.store.revise(ident, user, body)
                return self.preview(ident, pending[0]['kind'], body)
        if compact == '科目一覧':
            return [text_message('\n'.join(CATEGORIES))]
        if compact == '未払い':
            rows = self.store.db.execute("SELECT * FROM payments WHERE status='pending' ORDER BY due LIMIT 4").fetchall()
            return [self.payment_message(r) for r in rows] or [text_message('未払いはありません。')]
        if compact == '確認待ち':
            rows = self.store.db.execute("SELECT * FROM drafts WHERE state='pending' AND owner IN (?, '*') ORDER BY created LIMIT 2", (user,)).fetchall()
            return [m for r in rows for m in self.preview(r['id'], r['kind'], json.loads(r['body']))] or [text_message('確認待ちはありません。')]
        if compact == '会計ファイル':
            if self.exporter:
                self.exporter(self.store)
                return [text_message('会計ファイルを更新しました。サーバーのdata/会計ファイル.xlsxから取得できます。')]
            return [text_message('Excel出力が設定されていません。')]
        if text.startswith('修正 '):
            _, ident, raw = text.split(maxsplit=2)
            row, body = self.store.get_draft(ident, user)
            patch = json.loads(raw)
            if not isinstance(patch, dict) or set(patch) - {k for k in body if not k.startswith('_')}:
                raise ValueError('表示された項目名を指定してください。')
            body.update(patch)
            if body.get('_写真明細') and body.get('_入金額表記') and body.get('口座') == '団体口座':
                body['方向'] = '支出'
            if '内容' in patch and not body.get('科目'):
                body['科目'] = suggest_category(body['内容'], body.get('方向'))
            self.store.revise(ident, user, body)
            return self.preview(ident, row['kind'], body)
        if text.startswith('取消 '):
            ident = text.split(maxsplit=1)[1]
            body = {'取引ID': ident}
            draft_id, _ = self.store.draft(user, 'void', body, 'event:' + event['webhookEventId'])
            return self.preview(draft_id, 'void', body)
        for command, kind in [('開始残高', 'opening'), ('取引', 'transaction'), ('支払登録', 'payment')]:
            if text.startswith(command + ' '):
                body = json.loads(text[len(command):].strip())
                if not isinstance(body, dict):
                    raise ValueError('JSONオブジェクトを入力してください。')
                ident, _ = self.store.draft(user, kind, body, 'event:' + event['webhookEventId'])
                return self.preview(ident, kind, body)
        return [text_message(HELP)]

    @staticmethod
    def payment_message(row, prefix='支払予定'):
        return buttons(f'{prefix}\n{row["company"][:50]}\n{row["amount"]:,}円\n期限: {row["due"]}', [('完了', 'done:' + row['id'])])

    def reminders(self, current=None):
        current = current or datetime.now(JST)
        if current.hour < int(os.environ.get('REMINDER_HOUR_JST', '9')):
            return
        target = os.environ.get('LINE_NOTIFICATION_TARGET')
        if not target:
            return
        rows = self.store.db.execute("SELECT * FROM payments WHERE status='pending'").fetchall()
        for row in rows:
            days = (date.fromisoformat(row['due']) - current.date()).days
            if days in (3, 1, 0):
                key = f'remind:{row["id"]}:{days}'
                self.queue(target, [self.payment_message(row, '本日が支払期限です' if days == 0 else f'支払期限の{days}日前です')], key)

    def gmail_sync(self):
        target = os.environ.get('LINE_NOTIFICATION_TARGET')
        if not target or not os.environ.get('GOOGLE_REFRESH_TOKEN'):
            return
        for source, body in gmail_candidates():
            ident, fresh = self.store.draft('*', 'payment', body, 'gmail:' + source)
            if fresh:
                self.queue(target, self.preview(ident, 'payment', body), 'gmail:' + source)

    def flush(self):
        for row in self.store.db.execute('SELECT * FROM outbox WHERE sent=0 ORDER BY rowid LIMIT 20').fetchall():
            if row['id'].startswith('remind:'):
                ident = row['id'].split(':')[1]
                state = self.store.db.execute('SELECT status FROM payments WHERE id=?', (ident,)).fetchone()
                if not state or state[0] == 'paid':
                    with self.store.db:
                        self.store.db.execute('UPDATE outbox SET sent=1 WHERE id=?', (row['id'],))
                    continue
            b = json.loads(row['body'])
            # LINE retry key is stable even after process restart.
            line_push(b['target'], b['messages'], str(uuid.uuid5(uuid.NAMESPACE_URL, row['id'])))
            with self.store.db:
                self.store.db.execute('UPDATE outbox SET sent=1 WHERE id=?', (row['id'],))
