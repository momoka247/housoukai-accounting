"""1プロセスで実行。HTTPSリバースプロキシの背後に置く。"""
import json
import logging
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
import sqlite3
import threading
import time
from pathlib import Path

from accounting import Store
from bot import Bot
from excel_export import export
from integrations import valid_signature

LOG = logging.getLogger('housoukai')


def load_env():
    path = Path('.env')
    if path.exists():
        for line in path.read_text(encoding='utf-8-sig').splitlines():
            if line.strip() and not line.lstrip().startswith('#') and '=' in line:
                key, value = line.split('=', 1)
                os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def send(self, code, body=b''):
        self.send_response(code)
        self.send_header('Content-Type', 'text/plain; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.send(200 if self.path == '/health' else 404, b'ok' if self.path == '/health' else b'')

    def do_POST(self):
        if self.path != '/webhook':
            self.send(404)
            return
        try:
            size = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            self.send(400)
            return
        if not 0 < size <= 1024 * 1024:
            self.send(413)
            return
        body = self.rfile.read(size)
        if not valid_signature(body, self.headers.get('X-Line-Signature'), os.environ.get('LINE_CHANNEL_SECRET', '')):
            self.send(403)
            return
        try:
            parsed = json.loads(body)
            events = parsed['events']
            if not isinstance(events, list):
                raise ValueError()
            store = Store(os.environ.get('DATA_DIR', 'data'))
            try:
                with store.db:
                    for event in events:
                        ident = event['webhookEventId']
                        store.db.execute('INSERT OR IGNORE INTO events(id,body) VALUES(?,?)',
                                         (ident, json.dumps(event, ensure_ascii=False)))
            finally:
                store.db.close()
        except (ValueError, KeyError, TypeError):
            self.send(400)
            return
        self.send(200)


def worker(stop):
    store = Store(os.environ.get('DATA_DIR', 'data'))
    bot = Bot(store, export)
    last_gmail = 0
    while not stop.is_set():
        for row in store.db.execute("SELECT * FROM events WHERE state='queued' AND attempts<3 ORDER BY rowid LIMIT 10").fetchall():
            try:
                bot.handle(json.loads(row['body']))
                with store.db:
                    store.db.execute("UPDATE events SET state='done',body='{}' WHERE id=?", (row['id'],))
            except Exception as e:
                with store.db:
                    store.db.execute('UPDATE events SET attempts=attempts+1 WHERE id=?', (row['id'],))
                LOG.error('event failed id=%s type=%s', row['id'], type(e).__name__)
        try:
            bot.reminders()
            bot.flush()
        except Exception as e:
            LOG.error('LINE delivery failed type=%s', type(e).__name__)
        if time.monotonic() - last_gmail > 900:
            last_gmail = time.monotonic()
            try:
                bot.gmail_sync()
            except Exception as e:
                LOG.error('Gmail sync failed type=%s', type(e).__name__)
        stop.wait(3)
    store.db.close()


if __name__ == '__main__':
    load_env()
    required = ['LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN', 'LINE_ALLOWED_USER_IDS', 'LINE_NOTIFICATION_TARGET']
    missing = [key for key in required if not os.environ.get(key)]
    if missing:
        raise SystemExit('設定が必要です: ' + ', '.join(missing))
    logging.basicConfig(level=logging.INFO)
    stop = threading.Event()
    thread = threading.Thread(target=worker, args=(stop,), daemon=True)
    thread.start()
    server = HTTPServer(('0.0.0.0', int(os.environ.get('PORT', '8080'))), Handler)
    server.timeout = 15
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        thread.join(timeout=45)
        server.server_close()
