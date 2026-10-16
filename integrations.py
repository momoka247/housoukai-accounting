"""LINE・Google REST API。本文や認証情報をログに出さない。"""
import base64
import hashlib
import hmac
import json
import os
import re
import unicodedata
import urllib.parse
import urllib.request
import urllib.error
from datetime import date


def request(url, data=None, headers=None, form=False):
    headers = dict(headers or {})
    if data is not None:
        data = (urllib.parse.urlencode(data).encode() if form else json.dumps(data).encode())
        headers['Content-Type'] = 'application/x-www-form-urlencoded' if form else 'application/json'
    with urllib.request.urlopen(urllib.request.Request(url, data, headers), timeout=40) as response:
        raw = response.read(16 * 1024 * 1024 + 1)
        if len(raw) > 16 * 1024 * 1024:
            raise ValueError('応答サイズが上限を超えました。')
        return json.loads(raw) if raw else {}


def valid_signature(body, signature, secret):
    expected = base64.b64encode(hmac.new(secret.encode(), body, hashlib.sha256).digest()).decode()
    return bool(secret) and hmac.compare_digest(expected, signature or '')


def line_push(target, messages, retry_key):
    try:
        return request('https://api.line.me/v2/bot/message/push', {'to': target, 'messages': messages},
                       {'Authorization': 'Bearer ' + os.environ['LINE_CHANNEL_ACCESS_TOKEN'],
                        'X-Line-Retry-Key': retry_key})
    except urllib.error.HTTPError as error:
        if error.code == 409 and error.headers.get('X-Line-Accepted-Request-Id'):
            return {}  # 同一retry keyによる送信がすでに受理されている
        raise


def line_reply(reply_token, messages):
    return request('https://api.line.me/v2/bot/message/reply',
                   {'replyToken': reply_token, 'messages': messages},
                   {'Authorization': 'Bearer ' + os.environ['LINE_CHANNEL_ACCESS_TOKEN']})


def line_image(ident):
    url = 'https://api-data.line.me/v2/bot/message/' + urllib.parse.quote(ident, safe='') + '/content'
    with urllib.request.urlopen(urllib.request.Request(url, headers={
            'Authorization': 'Bearer ' + os.environ['LINE_CHANNEL_ACCESS_TOKEN']}), timeout=40) as response:
        image = response.read(10 * 1024 * 1024 + 1)
    if len(image) > 10 * 1024 * 1024:
        raise ValueError('画像は10MB以下にしてください。')
    return image


def ocr(image):
    key = os.environ.get('GOOGLE_VISION_API_KEY')
    if not key:
        raise ValueError('写真の読み取り設定が未完了です。「取引」コマンドで手入力できます。')
    result = request('https://vision.googleapis.com/v1/images:annotate',
                     {'requests': [{'image': {'content': base64.b64encode(image).decode()},
                                    'features': [{'type': 'DOCUMENT_TEXT_DETECTION'}],
                                    'imageContext': {'languageHints': ['ja']}}]}, {'X-Goog-Api-Key': key})
    response = result['responses'][0]
    if response.get('error'):
        raise ValueError('写真を読み取れませんでした。「取引」コマンドで入力できます。')
    return response.get('fullTextAnnotation', {}).get('text', '')


def single_money(text, label):
    # 桁区切りと整数円のみ。ラベルが重複する・候補が複数ある場合は決めない。
    values = re.findall(label + r'\s*[:：]?\s*[¥￥]?\s*([0-9][0-9,]*)\s*円?', text)
    return int(values[0].replace(',', '')) if len(values) == 1 else None


def extract_date(text):
    hits = re.findall(r'(20\d{2})[年/.-](\d{1,2})[月/.-](\d{1,2})日?', text)
    if len(hits) != 1:
        return None
    try:
        return date(*map(int, hits[0])).isoformat()
    except ValueError:
        return None


def receipt_draft(text):
    text = unicodedata.normalize('NFKC', text)
    # 振込先銀行が印字されるため銀行名だけで出金元口座を決めない。
    income = single_money(text, r'(?:お預入金額|入金額)')
    expense = single_money(text, r'(?:お振込金額|振込金額|お引出金額)')
    direction = '収入' if income is not None and expense is None else '支出' if expense is not None and income is None else None
    return {'日付': extract_date(text), '口座': None, '方向': None if income is not None else direction,
            '金額': income if direction == '収入' else expense if direction == '支出' else None,
            '手数料': single_money(text, r'(?:振込手数料|手数料)'),
            '残高': single_money(text, r'(?:お取引後残高|お取引後の残高|残高)'),
            '内部振替': None, '科目': None,
            '内容': None, '_入金額表記': income is not None and expense is None, '_写真明細': True}


def suggest_category(description, direction):
    """一意に根拠がある科目だけ提案。備品/消耗品・援助金の推測はしない。"""
    if not isinstance(description, str) or not description or direction not in ('収入', '支出'):
        return None
    rules = ({'収．部費': ('部費',), '収．受取利息': ('受取利息', '預金利息'),
              '収．広告収入': ('広告掲載料', '広告収入'), '収．寄付金': ('寄付金',)}
             if direction == '収入' else {
                 '支．連盟加盟費': ('連盟加盟費',), '支．大会・イベント参加費': ('大会参加費', 'イベント参加費'),
                 '支．保険料': ('スポーツ安全保険', '保険料'), '支．維持・修繕費': ('修理代', '修繕費'),
                 '支．図書費': ('図書代', '書籍代', '新聞購読料', '雑誌代'),
                 '支．印刷製本費': ('印刷代', '製本代', '印刷製本費'),
                 '支．通信費': ('切手代', '郵送料', '電話代'),
                 '支．旅費・交通費': ('宿泊費', '電車代', 'バス代', '旅費・交通費')})
    hits = [category for category, terms in rules.items() if any(term in description for term in terms)]
    return hits[0] if len(hits) == 1 else None


def gmail_token():
    return request('https://oauth2.googleapis.com/token', {
        'client_id': os.environ['GOOGLE_CLIENT_ID'], 'client_secret': os.environ['GOOGLE_CLIENT_SECRET'],
        'refresh_token': os.environ['GOOGLE_REFRESH_TOKEN'], 'grant_type': 'refresh_token'}, form=True)['access_token']


def gmail_candidates():
    token = gmail_token()
    headers = {'Authorization': 'Bearer ' + token}
    root = 'https://gmail.googleapis.com/gmail/v1/users/me/'
    profile = request(root + 'profile', headers=headers)
    if profile['emailAddress'].lower() != os.environ.get('GMAIL_ACCOUNT', 'tbahousoukai@gmail.com').lower():
        raise ValueError('Gmailの接続先が放送会アカウントと一致しません。')
    query = urllib.parse.urlencode({'q': 'newer_than:60d {請求 支払 振込 入金}', 'maxResults': 50})
    result = request(root + 'messages?' + query, headers=headers)
    for m in result.get('messages', []):
        full = request(root + 'messages/' + m['id'] + '?format=full', headers=headers)
        payload = full.get('payload', {})
        hs = {h['name'].lower(): h['value'] for h in payload.get('headers', [])}
        text_parts = []

        def walk(part):
            if part.get('mimeType') == 'text/plain' and part.get('body', {}).get('data'):
                encoded = part['body']['data']
                text_parts.append(base64.urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4)).decode('utf-8', errors='replace'))
            for child in part.get('parts', []):
                walk(child)

        walk(payload)
        text = unicodedata.normalize('NFKC', '\n'.join(text_parts) or full.get('snippet', ''))
        # 年のない期限・添付PDF・複数候補は空欄として確認を依頼する。
        deadline = re.search(r'(?:支払期限|お支払期限|振込期限|入金期限)[^\n]{0,12}?(20\d{2}[年/.-]\d{1,2}[月/.-]\d{1,2}日?)', text)
        body = {'会社': None, '金額': single_money(text, r'(?:ご請求金額|請求金額|お支払金額)'),
                '期限': extract_date(deadline[1]) if deadline else None,
                'メール件名': hs.get('subject', '')[:250], '差出人': hs.get('from', '')[:250]}
        yield m['id'], body
