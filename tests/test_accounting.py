import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import tempfile
import unittest
from datetime import datetime
from unittest.mock import patch
import xml.etree.ElementTree as ET
import zipfile

from accounting import Store, JST
from bot import Bot
from integrations import valid_signature, receipt_draft, suggest_category
from excel_export import export, Q


class AccountingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(self.temp.name)
        self.bot = Bot(self.store)
        self.env = patch.dict(os.environ, {'LINE_ALLOWED_USER_IDS': 'Utest', 'LINE_NOTIFICATION_TARGET': 'Utest'})
        self.env.start()
        self.register('opening', {'日付': '2027-04-01', '団体口座': 10000, '公金口座': 20000})

    def tearDown(self):
        self.env.stop()
        self.store.db.close()
        self.temp.cleanup()

    def register(self, kind, body):
        ident, _ = self.store.draft('Utest', kind, body)
        self.store.confirm(ident, 'Utest')
        return ident

    def tx(self, **patches):
        body = {'日付': '2027-04-02', '口座': '団体口座', '方向': '支出', '金額': 1000,
                '手数料': 110, '残高': 8890, '内部振替': False, '科目': '支．消耗品費'}
        body.update(patches)
        return body

    def test_external_fee_same_row(self):
        self.register('transaction', self.tx())
        ledger = self.store.ledger()
        self.assertEqual(len(ledger), 3)
        self.assertEqual(ledger[-1], ('2027-04-02', '支．消耗品費', 0, 1110))
        self.assertEqual(sum(r[2]-r[3] for r in ledger), 28890)

    def test_internal_principal_excluded_fee_only(self):
        self.register('transaction', self.tx(口座='公金口座', 内部振替=True, 科目=None, 金額=5000, 残高=14890))
        self.register('transaction', self.tx(方向='収入', 内部振替=True, 科目=None, 金額=5000, 手数料=0, 残高=15000))
        ledger = self.store.ledger()
        self.assertEqual(ledger[-1][1:], ('支．振込手数料', 0, 110))
        self.assertEqual(sum(r[2]-r[3] for r in ledger), 29890)
        self.assertEqual(self.store.balance('公金口座')[0], 14890)
        self.assertEqual(self.store.balance('団体口座')[0], 15000)

    def test_mufg_receipt_incoming_label_is_expense(self):
        body = receipt_draft('2027/04/02\n入金額 1,000円\n手数料 110円\n残高 8,890円')
        ident, _ = self.store.draft('Utest', 'transaction', body)
        event = {'type': 'message', 'message': {'type': 'text', 'text': '修正 ' + ident + ' ' + json.dumps(
            {'口座': '団体口座', '内部振替': False, '科目': '支．消耗品費'}, ensure_ascii=False)}}
        self.bot.respond(event, 'Utest')
        _, changed = self.store.get_draft(ident, 'Utest')
        self.assertEqual(changed['方向'], '支出')
        self.store.confirm(ident, 'Utest')
        self.assertEqual(self.store.ledger()[-1][3], 1110)

    def test_real_income_not_reversed(self):
        self.register('transaction', self.tx(方向='収入', 科目='収．部費', 手数料=0, 残高=11000))
        self.assertEqual(self.store.ledger()[-1][2:], (1000, 0))

    def test_missing_category_and_unknown_fee_block(self):
        for body in [self.tx(科目=None), self.tx(手数料=None), self.tx(内部振替=None), self.tx(金額=-1)]:
            ident, _ = self.store.draft('Utest', 'transaction', body)
            with self.assertRaises(ValueError):
                self.store.confirm(ident, 'Utest')
        self.assertEqual(len(self.store.ledger()), 2)

    def test_duplicate_confirmation_and_source(self):
        ident, fresh = self.store.draft('Utest', 'transaction', self.tx(), 'image:abc')
        duplicate, fresh2 = self.store.draft('Utest', 'transaction', self.tx(), 'image:abc')
        self.assertEqual(ident, duplicate)
        self.assertTrue(fresh)
        self.assertFalse(fresh2)
        self.store.confirm(ident, 'Utest')
        with self.assertRaises(ValueError):
            self.store.confirm(ident, 'Utest')

    def test_authorization(self):
        ident, _ = self.store.draft('Utest', 'transaction', self.tx())
        with self.assertRaises(ValueError):
            self.store.confirm(ident, 'stranger')
        self.bot.handle({'source': {'userId': 'stranger'}, 'type': 'postback', 'postback': {'data': 'confirm:' + ident}})
        self.assertEqual(len(self.store.ledger()), 2)

    def test_void_restores_balance_and_ledger(self):
        ident = self.register('transaction', self.tx())
        self.store.void(ident, 'Utest')
        self.assertEqual(len(self.store.ledger()), 2)
        self.assertEqual(self.store.balance('団体口座')[0], 10000)

    def test_reminders_unique_and_done_stops_queued(self):
        ident = self.register('payment', {'会社': 'テスト株式会社', '金額': 1000, '期限': '2027-04-10'})
        for day in (7, 7, 9, 10):
            self.bot.reminders(datetime(2027, 4, day, 9, tzinfo=JST))
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM outbox').fetchone()[0], 3)
        self.assertTrue(self.store.complete(ident, 'Utest'))
        self.assertFalse(self.store.complete(ident, 'Utest'))
        with patch('bot.line_push') as push:
            self.bot.flush()
            push.assert_not_called()

    def test_signature(self):
        body = b'{"events":[]}'
        signature = base64.b64encode(hmac.new(b'secret', body, hashlib.sha256).digest()).decode()
        self.assertTrue(valid_signature(body, signature, 'secret'))
        self.assertFalse(valid_signature(body + b' ', signature, 'secret'))

    def test_usage_guide_does_not_change_accounting(self):
        before = self.store.ledger()
        messages = self.bot.respond({'type': 'message', 'message': {'type': 'text', 'text': '使い方'}}, 'Utest')
        self.assertEqual(len(messages), 1)
        self.assertIn('「事前申請」→ 購入前に申請する手順', messages[0]['text'])
        self.assertIn('「未払い」→ 支払予定と「完了」ボタン', messages[0]['text'])
        self.assertEqual(self.store.ledger(), before)

    def test_reader_can_view_public_balance(self):
        self.bot.handle({'source': {'type': 'user', 'userId': 'reader'}, 'type': 'message',
                         'webhookEventId': 'public-balance', 'replyToken': 'reader-token',
                         'message': {'type': 'text', 'text': '団体口座　残高'}})
        with patch('bot.line_reply') as reply, patch('bot.line_push') as push:
            self.bot.flush()
            self.assertIn('10,000', reply.call_args.args[1][0]['text'])
            push.assert_not_called()

    def test_reader_cannot_complete_payment_or_register_photo(self):
        ident = self.register('payment', {'会社': 'テスト', '金額': 1000, '期限': '2027-04-10'})
        self.bot.handle({'source': {'type': 'user', 'userId': 'reader'}, 'type': 'postback',
                         'webhookEventId': 'denied-payment', 'replyToken': 'reader-token',
                         'postback': {'data': 'done:' + ident}})
        with patch('bot.line_image') as image:
            self.bot.handle({'source': {'type': 'user', 'userId': 'reader'}, 'type': 'message',
                             'webhookEventId': 'denied-photo', 'replyToken': 'reader-token2',
                             'message': {'type': 'image', 'id': 'photo'}})
            image.assert_not_called()
        self.assertEqual(self.store.db.execute('SELECT status FROM payments WHERE id=?', (ident,)).fetchone()[0], 'pending')

    def test_category_only_when_unambiguous(self):
        self.assertEqual(suggest_category('切手代', '支出'), '支．通信費')
        self.assertEqual(suggest_category('部費', '収入'), '収．部費')
        self.assertIsNone(suggest_category('切手代と印刷代', '支出'))
        self.assertIsNone(suggest_category('マイク購入', '支出'))
        self.assertIsNone(suggest_category('切手代', None))

    def test_short_correction_flow(self):
        body = receipt_draft('2027/04/02\n入金額 1,000円\n手数料 110円\n残高 8,890円')
        ident, _ = self.store.draft('Utest', 'transaction', body)
        for text in ('口座 団体口座', '内部振替 いいえ', '内容 切手代'):
            self.bot.respond({'type': 'message', 'message': {'type': 'text', 'text': text}}, 'Utest')
        self.store.confirm(ident, 'Utest')
        self.assertEqual(self.store.ledger()[-1], ('2027-04-02', '支．通信費', 0, 1110))

    def test_normal_response_uses_reply_without_push(self):
        self.bot.handle({'source': {'type': 'user', 'userId': 'Utest'}, 'type': 'message',
                         'webhookEventId': 'reply-test', 'replyToken': 'test-token',
                         'message': {'type': 'text', 'text': '事前申請'}})
        with patch('bot.line_reply') as reply, patch('bot.line_push') as push:
            self.bot.flush()
            reply.assert_called_once()
            push.assert_not_called()

    def test_expired_reply_does_not_fall_back_to_push(self):
        import urllib.error
        self.bot.queue('Utest', [{'type': 'text', 'text': 'test'}], 'expired', 'expired-token')
        with patch('bot.line_reply', side_effect=urllib.error.HTTPError('https://api.line.me', 400, 'invalid token', {}, None)), patch('bot.line_push') as push:
            self.bot.flush()
            push.assert_not_called()

    def test_export_grows_and_preserves_blank_columns(self):
        for i in range(45):
            self.register('transaction', self.tx(金額=100, 手数料=10))
        path = export(self.store)
        with zipfile.ZipFile(path) as z:
            xml = ET.fromstring(z.read('xl/worksheets/sheet1.xml'))
            cells = {c.get('r'): c for c in xml.findall('.//' + Q('c'))}
            self.assertEqual(cells['E9'].find(Q('v')).text, '110')
            self.assertEqual(cells['F9'].find(Q('f')).text, 'F8+D9-E9')
            self.assertEqual(cells['F53'].find(Q('v')).text, str(30000 - 45*110))
            for ref, cell in cells.items():
                if ref[0] in 'GH' and int(ref[1:]) >= 7:
                    self.assertIsNone(cell.find(Q('v')))
                    self.assertIsNone(cell.find(Q('is')))


if __name__ == '__main__':
    unittest.main()
