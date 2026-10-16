// LINEからの原文署名を検証し、署名付きでApps Scriptへ転送するだけの無料Worker。
const encoder = new TextEncoder();

export function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signature(secret, text) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret),
    {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(text)));
  return btoa(String.fromCharCode(...bytes));
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/health' && request.method === 'GET') return new Response('ok');
    if (path !== '/webhook') return new Response('Not found', {status: 404});
    if (request.method !== 'POST') return new Response('Method not allowed', {status: 405});
    if (!env.LINE_CHANNEL_SECRET || !env.GATEWAY_SHARED_SECRET || !env.APPS_SCRIPT_URL) {
      return new Response('Not configured', {status: 503});
    }
    // 匿名の第三者が送った巨大bodyを読み込まない。chunkedにも実サイズ制限を適用。
    if (Number(request.headers.get('content-length') || 0) > 262144) return new Response('', {status: 413});
    const reader = request.body?.getReader();
    if (!reader) return new Response('', {status: 400});
    const chunks = []; let size = 0;
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 262144) { await reader.cancel(); return new Response('', {status: 413}); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const rawBody = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
    if (!equal(await signature(env.LINE_CHANNEL_SECRET, rawBody), request.headers.get('x-line-signature'))) {
      return new Response('', {status: 403});
    }
    let parsed;
    try { parsed = JSON.parse(rawBody); } catch { return new Response('', {status: 400}); }
    if (!Array.isArray(parsed.events)) return new Response('', {status: 400});
    // LINEの接続検証はイベントを含まないため、Googleの呼び出しを省略する。
    if (parsed.events.length === 0) return new Response('ok');
    const timestamp = String(Date.now());
    const mac = await signature(env.GATEWAY_SHARED_SECRET, timestamp + '\n' + rawBody);
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(env.APPS_SCRIPT_URL)) {
      return new Response('Invalid backend URL', {status: 503});
    }
    try {
      const response = await fetch(env.APPS_SCRIPT_URL, {method: 'POST', redirect: 'follow',
        headers: {'Content-Type': 'application/json'}, body: JSON.stringify({timestamp, rawBody, mac}),
        signal: AbortSignal.timeout(45000)});
      const result = await response.json();
      if (!response.ok || result.ok !== true) return new Response('Backend unavailable', {status: 503});
      return new Response('ok');
    } catch { return new Response('Backend unavailable', {status: 503}); }
  }
};
