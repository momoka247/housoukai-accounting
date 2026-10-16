"""LINE会計の永続化と会計規則。金額は整数円、時刻はJST。"""
import json
import sqlite3
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

JST = timezone(timedelta(hours=9))
CATEGORIES = json.loads(Path(__file__).with_name('categories.json').read_text(encoding='utf-8'))
ACCOUNTS = ('団体口座', '公金口座')


def now():
    return datetime.now(JST).isoformat(timespec='seconds')


def validate_money(value):
    if type(value) is not int or not 0 <= value <= 999999999999:
        raise ValueError('金額は0以上の整数円で入力してください。')
    return value


class Store:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.directory / 'accounting.db')
        self.db.row_factory = sqlite3.Row
        self.db.executescript('''
        PRAGMA journal_mode=WAL;
        PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS opening(account TEXT PRIMARY KEY, amount INTEGER, day TEXT);
        CREATE TABLE IF NOT EXISTS drafts(id TEXT PRIMARY KEY, owner TEXT, kind TEXT, body TEXT,
          state TEXT DEFAULT 'pending', created TEXT);
        CREATE TABLE IF NOT EXISTS transactions(id TEXT PRIMARY KEY, draft_id TEXT UNIQUE,
          day TEXT, account TEXT, direction TEXT, amount INTEGER, fee INTEGER,
          balance INTEGER, category TEXT, internal INTEGER, created TEXT, voided INTEGER DEFAULT 0);
        CREATE TABLE IF NOT EXISTS payments(id TEXT PRIMARY KEY, draft_id TEXT UNIQUE,
          company TEXT, amount INTEGER, due TEXT, status TEXT DEFAULT 'pending', completed TEXT);
        CREATE TABLE IF NOT EXISTS sources(hash TEXT PRIMARY KEY, draft_id TEXT);
        CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, body TEXT, state TEXT DEFAULT 'queued',
          attempts INTEGER DEFAULT 0);
        CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY, body TEXT, sent INTEGER DEFAULT 0);
        CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, actor TEXT, action TEXT, target TEXT, created TEXT);
        ''')
        self.db.commit()

    def audit(self, actor, action, target):
        self.db.execute('INSERT INTO audit(actor,action,target,created) VALUES(?,?,?,?)',
                        (actor, action, target, now()))

    def draft(self, owner, kind, body, source=None):
        with self.db:
            if source:
                existing = self.db.execute('SELECT draft_id FROM sources WHERE hash=?', (source,)).fetchone()
                if existing:
                    return existing[0], False
            ident = uuid.uuid4().hex[:12]
            self.db.execute('INSERT INTO drafts(id,owner,kind,body,created) VALUES(?,?,?,?,?)',
                            (ident, owner, kind, json.dumps(body, ensure_ascii=False), now()))
            if source:
                self.db.execute('INSERT INTO sources VALUES(?,?)', (source, ident))
            self.audit(owner, 'draft', ident)
        return ident, True

    def get_draft(self, ident, owner):
        row = self.db.execute('SELECT * FROM drafts WHERE id=?', (ident,)).fetchone()
        if not row or row['owner'] not in (owner, '*'):
            raise ValueError('この確認内容を操作できません。')
        if row['state'] != 'pending':
            raise ValueError('この確認内容は処理済みです。')
        return row, json.loads(row['body'])

    def revise(self, ident, owner, body):
        row, _ = self.get_draft(ident, owner)
        # 種別は作成時に固定し、自由入力からSQLや操作名を受け取らない。
        with self.db:
            self.db.execute('UPDATE drafts SET body=? WHERE id=?',
                            (json.dumps(body, ensure_ascii=False), ident))
            self.audit(owner, 'revise', ident)
        return row['kind']

    def confirm(self, ident, owner):
        row, b = self.get_draft(ident, owner)
        kind = row['kind']
        day = b.get('日付')
        with self.db:
            if kind == 'opening':
                date.fromisoformat(day)
                if self.db.execute('SELECT count(*) FROM opening').fetchone()[0]:
                    raise ValueError('開始残高は登録済みです。修正は管理者に依頼してください。')
                for account in ACCOUNTS:
                    self.db.execute('INSERT INTO opening VALUES(?,?,?)',
                                    (account, validate_money(b[account]), day))
            elif kind == 'payment':
                date.fromisoformat(b['期限'])
                if not isinstance(b['会社'], str) or not b['会社'].strip():
                    raise ValueError('会社名を確認してください。')
                self.db.execute('INSERT INTO payments(id,draft_id,company,amount,due) VALUES(?,?,?,?,?)',
                                (ident, ident, b['会社'][:200], validate_money(b['金額']), b['期限']))
            elif kind == 'transaction':
                opening = self.db.execute('SELECT * FROM opening').fetchall()
                if len(opening) != 2:
                    raise ValueError('先に「開始残高」を登録してください。')
                date.fromisoformat(day)
                if day < opening[0]['day']:
                    raise ValueError('開始日より前の取引は登録できません。')
                if b['口座'] not in ACCOUNTS or b['方向'] not in ('収入', '支出'):
                    raise ValueError('口座・方向を確認してください。')
                if b.get('_写真明細') and b.get('_入金額表記') and b['口座'] == '団体口座' and b['方向'] != '支出':
                    raise ValueError('三菱UFJ銀行の振込明細の「入金額」は支出として登録してください。')
                if type(b['内部振替']) is not bool:
                    raise ValueError('内部振替はtrueまたはfalseで指定してください。')
                amount, fee = validate_money(b['金額']), validate_money(b['手数料'])
                balance = validate_money(b['残高'])
                category = b.get('科目')
                if not b['内部振替']:
                    if category not in CATEGORIES or not category.startswith('収' if b['方向'] == '収入' else '支'):
                        raise ValueError('方向に合う科目を指定してください。')
                    if '繰越' in category or '期末残高/' in category:
                        raise ValueError('繰越金・期末残高は通常取引に指定できません。')
                    if category == '支．振込手数料' and fee:
                        raise ValueError('手数料単独の取引では金額に手数料を入れ、手数料欄は0にしてください。')
                self.db.execute('INSERT INTO transactions VALUES(?,?,?,?,?,?,?,?,?,?,?,0)',
                                (ident, ident, day, b['口座'], b['方向'], amount, fee, balance,
                                 category if not b['内部振替'] else '', int(b['内部振替']), now()))
            else:
                raise ValueError('未対応の登録内容です。')
            self.db.execute("UPDATE drafts SET state='confirmed' WHERE id=?", (ident,))
            self.audit(owner, 'confirm', ident)
        return kind

    def cancel(self, ident, owner):
        self.get_draft(ident, owner)
        with self.db:
            self.db.execute("UPDATE drafts SET state='cancelled' WHERE id=?", (ident,))
            self.audit(owner, 'cancel', ident)

    def complete(self, ident, owner):
        with self.db:
            changed = self.db.execute("UPDATE payments SET status='paid',completed=? WHERE id=? AND status='pending'",
                                      (now(), ident)).rowcount
            if changed:
                self.audit(owner, 'complete', ident)
        return bool(changed)

    def balance(self, account):
        row = self.db.execute('SELECT balance,day,created FROM transactions WHERE account=? AND voided=0 '
                              'ORDER BY day DESC,created DESC,rowid DESC LIMIT 1', (account,)).fetchone()
        if row:
            return row['balance'], row['day']
        row = self.db.execute('SELECT amount,day FROM opening WHERE account=?', (account,)).fetchone()
        return (row['amount'], row['day']) if row else (None, None)

    def ledger(self):
        rows = []
        opening = self.db.execute("SELECT * FROM opening ORDER BY CASE account WHEN '団体口座' THEN 0 ELSE 1 END").fetchall()
        for r in opening:
            rows.append((r['day'], '収．前年度繰越金/' + r['account'], r['amount'], 0))
        tx = self.db.execute('SELECT * FROM transactions WHERE voided=0 ORDER BY day,created,rowid').fetchall()
        for r in tx:
            if not r['internal']:
                rows.append((r['day'], r['category'], r['amount'] if r['direction'] == '収入' else 0,
                             (r['amount'] + r['fee']) if r['direction'] == '支出' else 0))
            if r['fee'] and (r['internal'] or r['direction'] == '収入'):
                rows.append((r['day'], '支．振込手数料', 0, r['fee']))
        return rows

    def void(self, ident, owner):
        with self.db:
            changed = self.db.execute('UPDATE transactions SET voided=1 WHERE id=? AND voided=0', (ident,)).rowcount
            if not changed:
                raise ValueError('取消対象の取引が見つかりません。')
            self.audit(owner, 'void', ident)
