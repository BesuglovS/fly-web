'use strict';

/**
 * LAN-релей для сетевой игры fly-web.
 *
 * Что делает:
 *  - отдаёт статику игры (../public) — одна машина в локальной сети поднимает всё;
 *  - по WebSocket /ws принимает состояние игроков и раздаёт его всем в комнате.
 *
 * Топология «звезда»: у каждого клиента ОДНО соединение (с релеем), число
 * соединений O(N) — стабильно для десятков участников в в локальной сети.
 * Без auth-web/TURN и без интернета: всё локально, идентификация по имени.
 *
 * Протокол (JSON):
 *   клиент → релей: hello{name} | lobby | create{title,max} | join{roomId}
 *                   | quick | control{map,mode,started,max,title} | st{p,q} | leave
 *   релей → клиент: lobby{rooms,maps,maxOptions,maxHard,self}
 *                   | welcome{self,room,participants,maps,maxOptions,maxHard}
 *                   | room{room,participants} | st{id,p,q} | error{message}
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT || '8080', 10);
const PUBDIR = path.join(__dirname, '..', 'public');

const MAPS = ['meadow', 'city', 'canyon', 'forest'];
const MODES = ['angle', 'acro'];
const MAX_OPTIONS = [2, 4, 6, 8];
const MAX_HARD = 8;
const PUBLIC_MAX = 4;                 // больше — только администратор
const ADMIN_KEY = process.env.ADMIN_KEY || ''; // ключ админа (если задан)
const NAME_MAX = 24;
const ST_RATE = 40;        // st-сообщений в секунду на клиента
const CTRL_RATE = 30;      // прочих в секунду
const PING_MS = 30000;

/* ───────────────────────── HTTP: статика игры ───────────────────────── */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res) {
  let rel = decodeURIComponent((req.url || '/').split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.normalize(path.join(PUBDIR, rel));
  if (!filePath.startsWith(PUBDIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA-фолбэк на index.html для несуществующих путей без расширения
      if (!path.extname(filePath)) {
        fs.readFile(path.join(PUBDIR, 'index.html'), (e2, d2) => {
          if (e2) { res.writeHead(404); res.end('Not found'); return; }
          res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
          res.end(d2);
        });
        return;
      }
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache, must-revalidate' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  serveStatic(req, res);
});

/* ───────────────────────── Состояние ───────────────────────── */
let userSeq = 0;
let roomSeq = 0;
const clients = new Map(); // ws -> client
const rooms = new Map();   // roomId -> room

function sanitizeName(v, max = NAME_MAX) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, max);
}
function sanitizeMap(v) { return MAPS.includes(v) ? v : 'meadow'; }
function sanitizeMode(v) { return MODES.includes(v) ? v : 'angle'; }
function allowedOptions(isAdmin) { return isAdmin ? MAX_OPTIONS : MAX_OPTIONS.filter((n) => n <= PUBLIC_MAX); }
function sanitizeMax(v, isAdmin) {
  let n = parseInt(v, 10);
  if (!MAX_OPTIONS.includes(n)) n = 4;
  if (!isAdmin && n > PUBLIC_MAX) n = PUBLIC_MAX;
  return n;
}

function lobbyList() {
  const out = [];
  for (const room of rooms.values()) {
    const host = room.members.get(room.hostId);
    out.push({
      id: room.id,
      title: room.title,
      host_name: host ? host.name : '',
      map: room.map,
      params: room.params,
      started: room.started,
      count: room.members.size,
      max: room.max,
      created_at: room.createdAt,
    });
  }
  out.sort((a, b) => b.created_at - a.created_at);
  return out.slice(0, 50);
}
function roomInfo(room) {
  const host = room.members.get(room.hostId);
  return {
    id: room.id,
    title: room.title,
    map: room.map,
    params: room.params,
    host_user_id: room.hostId,
    host_name: host ? host.name : '',
    started: room.started,
    max: room.max,
  };
}
function participants(room) {
  return [...room.members.values()]
    .sort((a, b) => a.joined - b.joined || a.id - b.id)
    .map((c) => ({ user_id: c.id, name: c.name, slot: c.slot }));
}
function lobbyMessage(client) {
  const isAdmin = !!(client && client.isAdmin);
  return {
    t: 'lobby',
    rooms: lobbyList(),
    maps: MAPS,
    maxOptions: allowedOptions(isAdmin),
    maxHard: isAdmin ? MAX_HARD : PUBLIC_MAX,
    self: client ? { id: client.id, name: client.name, isAdmin } : null,
  };
}

function send(ws, obj) {
  try { ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); } catch (_) {}
}
function broadcastAll(obj) {
  for (const c of clients.values()) send(c.ws, obj);
}
function broadcastLobby() {
  for (const c of clients.values()) send(c.ws, lobbyMessage(c));
}
function pushRoom(room) {
  const info = roomInfo(room);
  const parts = participants(room);
  for (const c of room.members.values()) send(c.ws, { t: 'room', room: info, participants: parts });
  broadcastLobby();
}

/* ───────────────────────── Комнаты ───────────────────────── */
function newRoom(client, title, max) {
  const room = {
    id: ++roomSeq,
    title: title || ('Игра: ' + client.name),
    map: 'meadow',
    params: { mode: 'angle' },
    started: false,
    max: sanitizeMax(max, client.isAdmin),
    hostId: client.id,
    createdAt: Date.now(),
    members: new Map(),
  };
  rooms.set(room.id, room);
  return room;
}
function assignSlot(room, exceptId) {
  const used = new Set();
  for (const c of room.members.values()) if (c.id !== exceptId) used.add(c.slot);
  for (let s = 0; s < room.max; s++) if (!used.has(s)) return s;
  return -1;
}
function joinRoom(client, room) {
  if (room.members.size >= room.max) return false;
  if (client.roomId) leaveRoom(client);
  const slot = assignSlot(room, client.id);
  if (slot < 0) return false;
  client.roomId = room.id;
  client.slot = slot;
  client.joined = Date.now();
  room.members.set(client.id, client);
  return true;
}
function leaveRoom(client) {
  const room = rooms.get(client.roomId);
  client.roomId = 0;
  client.slot = -1;
  if (!room) return;
  room.members.delete(client.id);
  if (room.members.size === 0) {
    rooms.delete(room.id);
  } else {
    if (room.hostId === client.id) {
      const next = [...room.members.values()].sort((a, b) => a.joined - b.joined)[0];
      room.hostId = next.id;
    }
    pushRoom(room);
  }
  broadcastLobby();
}
function applyControl(room, client, ctrl) {
  if (room.hostId !== client.id) return;
  if ('map' in ctrl) room.map = sanitizeMap(ctrl.map);
  if ('mode' in ctrl) { room.params = room.params || {}; room.params.mode = sanitizeMode(ctrl.mode); }
  if ('started' in ctrl) room.started = !!ctrl.started;
  if ('title' in ctrl) { const t = sanitizeName(ctrl.title, 60); if (t) room.title = t; }
  if ('max' in ctrl) { const m = sanitizeMax(ctrl.max, client.isAdmin); if (m >= room.members.size) room.max = m; }
}
function welcome(ws, client, room) {
  const isAdmin = !!client.isAdmin;
  send(ws, {
    t: 'welcome',
    self: { id: client.id, name: client.name, slot: client.slot, isAdmin },
    room: roomInfo(room),
    participants: participants(room),
    maps: MAPS,
    maxOptions: allowedOptions(isAdmin),
    maxHard: isAdmin ? MAX_HARD : PUBLIC_MAX,
    isAdmin,
  });
}

/* ───────────────────────── WebSocket ───────────────────────── */
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

function makeClient(ws) {
  return {
    id: ++userSeq,
    name: 'Пилот-' + userSeq,
    isAdmin: false,
    ws,
    roomId: 0,
    slot: -1,
    joined: 0,
    windowStart: Date.now(),
    stCount: 0,
    ctrlCount: 0,
  };
}
function allow(client, type) {
  const now = Date.now();
  if (now - client.windowStart > 1000) {
    client.windowStart = now;
    client.stCount = 0;
    client.ctrlCount = 0;
  }
  if (type === 'st') {
    client.stCount += 1;
    return client.stCount <= ST_RATE;
  }
  client.ctrlCount += 1;
  return client.ctrlCount <= CTRL_RATE;
}
function validVec(v, n) {
  return Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number' && isFinite(x));
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  const client = makeClient(ws);
  clients.set(ws, client);
  send(ws, lobbyMessage(client));

  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', () => {});

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
    if (!allow(client, msg.t)) return;

    switch (msg.t) {
      case 'hello':
        client.name = sanitizeName(msg.name) || client.name;
        client.isAdmin = ADMIN_KEY !== '' && String(msg.admin || '') === ADMIN_KEY;
        send(ws, { t: 'hello', self: { id: client.id, name: client.name, isAdmin: client.isAdmin } });
        broadcastLobby();
        break;

      case 'lobby':
        send(ws, lobbyMessage(client));
        break;

      case 'create': {
        const room = newRoom(client, sanitizeName(msg.title, 60), msg.max);
        joinRoom(client, room);
        welcome(ws, client, room);
        pushRoom(room);
        break;
      }

      case 'quick': {
        let room = [...rooms.values()].find((r) => r.members.size < r.max);
        if (!room) room = newRoom(client, '', 4);
        joinRoom(client, room);
        welcome(ws, client, room);
        pushRoom(room);
        break;
      }

      case 'join': {
        const room = rooms.get(Number(msg.roomId));
        if (!room) { send(ws, { t: 'error', message: 'Комната не найдена' }); break; }
        if (room.members.size >= room.max) { send(ws, { t: 'error', message: 'Комната заполнена' }); break; }
        joinRoom(client, room);
        welcome(ws, client, room);
        pushRoom(room);
        break;
      }

      case 'control': {
        const room = rooms.get(client.roomId);
        if (room) { applyControl(room, client, msg); pushRoom(room); }
        break;
      }

      case 'st': {
        const room = rooms.get(client.roomId);
        if (room && validVec(msg.p, 3) && validVec(msg.q, 4)) {
          const out = { t: 'st', id: client.id, p: msg.p, q: msg.q };
          for (const c of room.members.values()) if (c.ws !== ws) send(c.ws, out);
        }
        break;
      }

      /* сетевой старт/прогресс/результаты: пересылаем как есть остальным в комнате */
      case 'ready':
      case 'go':
      case 'reset':
      case 'race': {
        const room = rooms.get(client.roomId);
        if (!room) break;
        const out = Object.assign({}, msg, { id: client.id });
        for (const c of room.members.values()) if (c.ws !== ws) send(c.ws, out);
        break;
      }

      case 'leave':
        leaveRoom(client);
        send(ws, lobbyMessage(client));
        break;

      default:
        break;
    }
  });

  ws.on('close', () => {
    leaveRoom(client);
    clients.delete(ws);
    broadcastLobby();
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  }
}, PING_MS);

server.listen(PORT, () => {
  console.log(`fly LAN relay: http://0.0.0.0:${PORT}  (WebSocket ws://<host>:${PORT}/ws)`);
  console.log(`static: ${PUBDIR}`);
});
