"""ブラウザーでGoogle認証後、refresh tokenを.envに保存するローカルヘルパー。"""
import base64
import hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
import os
from pathlib import Path
import secrets
import time
import urllib.parse

from integrations import request
from server import load_env


def main():
    load_env()
    if not os.environ.get('GOOGLE_CLIENT_ID') or not os.environ.get('GOOGLE_CLIENT_SECRET'):
        raise SystemExit('先に.envのGOOGLE_CLIENT_IDとGOOGLE_CLIENT_SECRETを設定してください。')
    state = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
    result = {}

    class Callback(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            parsed = urllib.parse.urlparse(self.path)
            query = urllib.parse.parse_qs(parsed.query)
            if parsed.path != '/oauth/callback' or query.get('state', [''])[0] != state:
                self.send_error(400)
                return
            if query.get('code'):
                result['code'] = query['code'][0]
            else:
                result['error'] = True
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.end_headers()
            self.wfile.write('認証画面を閉じてターミナルに戻ってください。'.encode())

    http = HTTPServer(('127.0.0.1', 0), Callback)
    http.timeout = 1
    redirect = f'http://127.0.0.1:{http.server_port}/oauth/callback'
    query = urllib.parse.urlencode({
        'client_id': os.environ['GOOGLE_CLIENT_ID'], 'redirect_uri': redirect,
        'response_type': 'code', 'scope': 'https://www.googleapis.com/auth/gmail.readonly',
        'access_type': 'offline', 'prompt': 'consent', 'state': state,
        'code_challenge': challenge, 'code_challenge_method': 'S256',
        'login_hint': os.environ.get('GMAIL_ACCOUNT', 'tbahousoukai@gmail.com')})
    print('次のURLをブラウザーで開き、放送会のアカウントで許可してください（10分以内）。')
    print('https://accounts.google.com/o/oauth2/v2/auth?' + query)
    until = time.monotonic() + 600
    try:
        while not result and time.monotonic() < until:
            http.handle_request()
    finally:
        http.server_close()
    if not result.get('code'):
        raise SystemExit('認証は完了しませんでした。')
    token = request('https://oauth2.googleapis.com/token', {
        'code': result['code'], 'client_id': os.environ['GOOGLE_CLIENT_ID'],
        'client_secret': os.environ['GOOGLE_CLIENT_SECRET'], 'redirect_uri': redirect,
        'grant_type': 'authorization_code', 'code_verifier': verifier}, form=True)
    if not token.get('refresh_token'):
        raise SystemExit('refresh tokenを取得できませんでした。Googleの接続設定を確認してください。')
    profile = request('https://gmail.googleapis.com/gmail/v1/users/me/profile',
                      headers={'Authorization': 'Bearer ' + token['access_token']})
    if profile['emailAddress'].lower() != os.environ.get('GMAIL_ACCOUNT', 'tbahousoukai@gmail.com').lower():
        raise SystemExit('指定された放送会アカウントと一致しないため保存しませんでした。')
    path = Path('.env')
    lines = path.read_text(encoding='utf-8-sig').splitlines() if path.exists() else []
    lines = [line for line in lines if not line.startswith('GOOGLE_REFRESH_TOKEN=')]
    lines.append('GOOGLE_REFRESH_TOKEN=' + token['refresh_token'])
    path.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print('認証が完了しました。.envに保存しました。トークンは共有しないでください。')


if __name__ == '__main__':
    main()
