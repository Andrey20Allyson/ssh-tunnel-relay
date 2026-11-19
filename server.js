'use strict';

/*
 * Relay de tunel TCP sobre WebSocket (feito para SSH, mas serve para qualquer TCP).
 *
 * Tudo passa por uma unica porta HTTP (80), entao funciona atras do proxy do
 * Easypanel/Traefik usando o dominio normal (https://...).
 *
 * Cada WebSocket em /ws manda como PRIMEIRA mensagem um JSON dizendo quem ele e:
 *
 *   { "role": "serve",   "id": "casa", "secret": "..." }  -> computador que sera acessado (canal de controle)
 *   { "role": "connect", "id": "casa", "secret": "..." }  -> quem quer acessar o computador "casa"
 *   { "role": "accept",  "session": "<id da sessao>" }     -> canal de dados aberto pelo "serve" para uma sessao
 *
 * Fluxo de uma conexao:
 *   1. connect chega -> relay gera um id de sessao e manda {type:"open",session} pelo canal de controle do serve
 *   2. serve abre a porta local (ex.: 127.0.0.1:22) e um novo WebSocket com {role:"accept",session}
 *   3. relay manda {type:"connected"} para o connect e a partir dai so repassa bytes (frames binarios)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT) || 80;
const SECRET = process.env.TUNNEL_SECRET || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const HELLO_TIMEOUT_MS = 10_000;
const PAIR_TIMEOUT_MS = 15_000;
const PING_INTERVAL_MS = 25_000;
const MAX_BUFFERED = 8 * 1024 * 1024;

if (!SECRET) {
  console.error('[relay] defina a variavel de ambiente TUNNEL_SECRET');
  process.exit(1);
}

const readScript = (f) => fs.readFileSync(path.join(__dirname, 'scripts', f), 'utf8');
const TUNNEL_CS = readScript('Tunnel.cs');
const HOME_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
const TEMPLATES = {
  '/serve.ps1': readScript('serve.ps1'),
  '/connect.ps1': readScript('connect.ps1'),
};

const log = (...a) => console.log(new Date().toISOString(), ...a);

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
const SECRET_DIGEST = digest(SECRET);
const checkSecret = (s) => typeof s === 'string' && crypto.timingSafeEqual(digest(s), SECRET_DIGEST);

const ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const USER_RE = /^[A-Za-z0-9_.@\\ -]{1,64}$/;
const HOST_RE = /^[A-Za-z0-9.:[\]-]{1,255}$/;

/** id -> WebSocket de controle do computador que esta servindo */
const hosts = new Map();
/** sessionId -> { client, hostId, hostWs, timer } */
const pending = new Map();
let activeSessions = 0;

// ---------------------------------------------------------------- helpers ws

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function fail(ws, message, { fatal = false, code = 4000 } = {}) {
  send(ws, { type: fatal ? 'fatal' : 'error', message });
  ws.close(code, Buffer.from(message).subarray(0, 120).toString());
}

function takePending(sid) {
  const p = pending.get(sid);
  if (p) {
    clearTimeout(p.timer);
    pending.delete(sid);
  }
  return p;
}

/** Repassa frames binarios de `from` para `to`, com controle de fluxo simples. */
function pipe(from, to) {
  from.on('message', (data, isBinary) => {
    if (!isBinary || to.readyState !== WebSocket.OPEN) return;
    to.send(data, { binary: true });
    if (to.bufferedAmount > MAX_BUFFERED && !from.isPaused) {
      from.pause();
      to._socket.once('drain', () => from.resume());
    }
  });
}

// ---------------------------------------------------------------- papeis

function onServe(ws, msg) {
  if (!ID_RE.test(msg.id || '')) {
    return fail(ws, 'id invalido (use letras, numeros, ponto, _ ou -)', { fatal: true });
  }
  const id = msg.id;
  const old = hosts.get(id);
  if (old && old !== ws) {
    fail(old, 'outra conexao assumiu este id', { code: 4002 });
  }
  hosts.set(id, ws);
  log(`[serve] '${id}' online (${ws.remote})`);
  send(ws, { type: 'ready', id });

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.type === 'reject' && typeof m.session === 'string') {
      const p = pending.get(m.session);
      if (p && p.hostWs === ws) {
        takePending(m.session);
        fail(p.client, m.message || `'${id}' recusou a conexao`);
      }
    }
  });

  ws.on('close', () => {
    if (hosts.get(id) === ws) {
      hosts.delete(id);
      log(`[serve] '${id}' offline`);
    }
    for (const [sid, p] of pending) {
      if (p.hostWs === ws) {
        takePending(sid);
        fail(p.client, `'${id}' desconectou`);
      }
    }
  });
}

function onConnect(ws, msg) {
  if (!ID_RE.test(msg.id || '')) return fail(ws, 'id invalido', { fatal: true });
  const hostWs = hosts.get(msg.id);
  if (!hostWs) return fail(ws, `nenhum computador online com id '${msg.id}'`);

  const sid = crypto.randomBytes(16).toString('hex');
  const timer = setTimeout(() => {
    if (takePending(sid)) fail(ws, `'${msg.id}' nao respondeu a tempo`);
  }, PAIR_TIMEOUT_MS);
  pending.set(sid, { client: ws, hostId: msg.id, hostWs, timer });
  ws.on('close', () => takePending(sid));

  log(`[connect] ${ws.remote} -> '${msg.id}' (sessao ${sid.slice(0, 8)})`);
  send(hostWs, { type: 'open', session: sid });
}

function onAccept(ws, msg) {
  const p = typeof msg.session === 'string' ? takePending(msg.session) : undefined;
  if (!p || p.client.readyState !== WebSocket.OPEN) {
    return ws.close(4004, 'sessao inexistente ou expirada');
  }
  const client = p.client;
  const short = msg.session.slice(0, 8);

  send(client, { type: 'connected' });
  pipe(client, ws);
  pipe(ws, client);
  activeSessions++;
  log(`[sessao ${short}] aberta ('${p.hostId}')`);

  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    activeSessions--;
    client.close();
    ws.close();
    log(`[sessao ${short}] encerrada`);
  };
  client.on('close', end);
  ws.on('close', end);
}

// ---------------------------------------------------------------- websocket

const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });

wss.on('connection', (ws, req) => {
  ws.remote = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', (e) => log(`[ws] erro (${ws.remote}): ${e.message}`));

  const helloTimer = setTimeout(() => ws.terminate(), HELLO_TIMEOUT_MS);

  ws.once('message', (data, isBinary) => {
    clearTimeout(helloTimer);
    let msg = null;
    if (!isBinary) {
      try { msg = JSON.parse(data.toString()); } catch { /* invalido */ }
    }
    if (!msg || typeof msg !== 'object') {
      return fail(ws, 'a primeira mensagem deve ser um JSON {"role": ...}', { fatal: true });
    }

    switch (msg.role) {
      case 'serve':
      case 'connect':
        if (!checkSecret(msg.secret)) {
          log(`[auth] secret invalido de ${ws.remote} (role=${msg.role})`);
          // pequeno atraso para dificultar forca bruta
          return setTimeout(() => fail(ws, 'secret invalido', { fatal: true, code: 4003 }), 1000);
        }
        return msg.role === 'serve' ? onServe(ws, msg) : onConnect(ws, msg);
      case 'accept':
        return onAccept(ws, msg);
      default:
        return fail(ws, "role desconhecido (use 'serve' ou 'connect')", { fatal: true });
    }
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, PING_INTERVAL_MS);

// ---------------------------------------------------------------- http

function publicBase(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const first = (v) => (v || '').split(',')[0].trim();
  const proto = first(req.headers['x-forwarded-proto']) === 'https' ? 'https' : 'http';
  let host = first(req.headers['x-forwarded-host']) || first(req.headers.host);
  if (!HOST_RE.test(host)) host = 'localhost';
  return `${proto}://${host}`;
}

/** Parametros opcionais da URL (?id=&user=&port=), ja validados (seguros para embutir nos scripts). */
function scriptParams(q) {
  const pick = (name, re) => (re.test(q.get(name) || '') ? q.get(name) : '');
  const port = Number(q.get('port'));
  return {
    id: pick('id', ID_RE),
    user: pick('user', USER_RE),
    port: Number.isInteger(port) && port > 0 && port < 65536 ? String(port) : '',
  };
}

function renderScript(template, base, q) {
  const p = scriptParams(q);
  const vars = [
    ['__RELAY_URL__', base],
    ['__DEFAULT_ID__', p.id],
    ['__DEFAULT_USER__', p.user],
    ['__DEFAULT_PORT__', p.port],
    ['__TUNNEL_CS__', TUNNEL_CS], // por ultimo: o C# nao deve ser alterado pelas outras trocas
  ];
  let out = template;
  for (const [k, v] of vars) out = out.split(k).join(v);
  return out;
}

/** Arquivo .cmd (duplo clique ou cmd) que chama o .ps1 correspondente com os mesmos parametros. */
function renderCmd(name, base, q) {
  const p = scriptParams(q);
  const qs = new URLSearchParams(Object.entries(p).filter(([, v]) => v)).toString();
  const ps1 = `${base}/${name}.ps1${qs ? `?${qs}` : ''}`;
  const lines = [
    '@echo off',
    `title ssh-tunnel ${name}${p.id ? ` - ${p.id}` : ''}`,
    `rem Gerado por ${base}/${name}.cmd`,
    'rem Para nao digitar o secret: set "TUNNEL_SECRET=..." antes de rodar este arquivo.',
    `powershell -NoProfile -Command "& ([scriptblock]::Create((irm '${ps1}')))"`,
    'echo.',
    'pause',
  ];
  // em arquivos .cmd o % precisa ser duplicado (ex.: %5C de um usuario DOMINIO\nome)
  return lines.join('\r\n').replace(/%/g, '%%') + '\r\n';
}

function usage(base) {
  const ps = (path) => `irm "${base}${path}" | iex`;
  const cmd = (path) => `powershell -NoProfile -Command "& ([scriptblock]::Create((irm '${base}${path}')))"`;
  return `SSH tunnel relay

== Computador que sera acessado (servir) ==
  PowerShell : ${ps('/serve.ps1?id=casa')}
  cmd        : ${cmd('/serve.ps1?id=casa')}
  arquivo    : curl -o tunnel-serve.cmd "${base}/serve.cmd?id=casa" && .\\tunnel-serve.cmd
               (ou abra ${base}/serve.cmd?id=casa no navegador e de dois cliques)

== Computador que vai acessar (conectar) ==
  PowerShell : ${ps('/connect.ps1?id=casa&user=SEU_USUARIO')}
  cmd        : ${cmd('/connect.ps1?id=casa&user=SEU_USUARIO')}
  arquivo    : curl -o tunnel-connect.cmd "${base}/connect.cmd?id=casa&user=SEU_USUARIO" && .\\tunnel-connect.cmd

Os dois pedem o secret na tela, ou leem a variavel TUNNEL_SECRET:
  PowerShell : $env:TUNNEL_SECRET = '...'
  cmd        : set "TUNNEL_SECRET=..."

Parametros na URL: id, user, port (porta local do connect, padrao 2222).

Com parametros do PowerShell:
  & ([scriptblock]::Create((irm ${base}/serve.ps1))) -Id casa -TargetPort 22
  & ([scriptblock]::Create((irm ${base}/connect.ps1))) -Id casa -User SEU_USUARIO -LocalPort 2222 [-NoSsh]

Saude: ${base}/health
`;
}

const CMD_ROUTES = { '/serve.cmd': 'serve', '/connect.cmd': 'connect' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://relay');
  const reply = (status, type, body, extraHeaders = {}) => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...extraHeaders });
    res.end(body);
  };

  if (req.method !== 'GET' && req.method !== 'HEAD') return reply(405, 'text/plain', 'method not allowed\n');

  if (url.pathname === '/health') {
    return reply(200, 'application/json', JSON.stringify({
      status: 'ok',
      hostsOnline: hosts.size,
      activeSessions,
      pendingSessions: pending.size,
      uptimeSeconds: Math.round(process.uptime()),
    }) + '\n');
  }

  if (TEMPLATES[url.pathname]) {
    return reply(200, 'text/plain; charset=utf-8',
      renderScript(TEMPLATES[url.pathname], publicBase(req), url.searchParams));
  }

  if (CMD_ROUTES[url.pathname]) {
    const name = CMD_ROUTES[url.pathname];
    const { id } = scriptParams(url.searchParams);
    return reply(200, 'application/octet-stream',
      renderCmd(name, publicBase(req), url.searchParams),
      { 'content-disposition': `attachment; filename="tunnel-${name}${id ? `-${id}` : ''}.cmd"` });
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    // navegador -> pagina com botoes de copiar; curl/irm -> texto simples
    if ((req.headers.accept || '').includes('text/html')) return reply(200, 'text/html; charset=utf-8', HOME_HTML);
    return reply(200, 'text/plain; charset=utf-8', usage(publicBase(req)));
  }

  reply(404, 'text/plain', 'not found\n');
});

server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://relay').pathname !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

server.listen(PORT, () => log(`[relay] ouvindo na porta ${PORT}`));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log(`[relay] ${sig} recebido, encerrando`);
    for (const ws of wss.clients) ws.terminate();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
