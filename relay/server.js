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
 *   клиент → релей: hello{name,admin?,station?} | lobby | create{title,max,pair?,director?}
 *                   | join{roomId} | quick | control{map,mode,started,max,title,race?}
 *                   | comp_create{title,classId,className,track,adminName,students[],stations[]}
 *                   | comp_sync | comp_start | comp_finish | comp_next
 *                   | comp_set_track{track} | comp_set_stations{stations[]}
 *                   | comp_assign{heatId,station,sid} | comp_close | st{p,q} | leave
 *   релей → клиент: lobby{rooms,maps,races,maxOptions,maxHard,self}
 *                   | welcome{self,room,participants,maps,races,maxOptions,maxHard,isAdmin}
 *                   | room{room,participants} | st{id,p,q}
 *                   | comp{comp,self} (состояние турнира; comp=null — турнира нет)
 *                   | error{message,code?} | ready/go/reset/race
 *
 * Соревнование (competition) — отдельный режим комнаты-наблюдателя:
 *   - админ создаёт турнир, сервер строит сетку заездов (до 6 гонщиков в заезде);
 *   - ученики подключаются по метке компьютера (?station=R109-01) без логина;
 *   - перед заездом сервер назначает ученика на подключённый компьютер;
 *   - старт/завершение/следующий заезд — только с экрана администратора.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const results = require('./results');

const PORT = parseInt(process.env.PORT || '8080', 10);
const PUBDIR = path.join(__dirname, '..', 'public');

const MAPS = ['meadow', 'city', 'canyon', 'forest'];
const MODES = ['angle', 'acro'];
/* Гоночные трассы: стадионные UTT и лесная. ID общие с public/app.js. */
const RACES = ['utt1', 'utt2', 'utt5', 'utt4', 'forest', 'city', 'village', 'quarry', 'port', 'alpine'];
const MAX_OPTIONS = [2, 4, 6, 8];
const MAX_HARD = 8;
const PUBLIC_MAX = 4;                 // больше — только администратор
const PAIR_MAX = 3;                   // парная гонка: наблюдатель-админ + 2 гонщика
const DIRECTOR_MAX = 7;               // гонка с наблюдателем: админ + до 6 гонщиков
const DIRECTOR_RACERS = 6;
const ADMIN_KEY = process.env.ADMIN_KEY || ''; // ключ админа (если задан)
const NAME_MAX = 24;
const ST_RATE = 40;        // st-сообщений в секунду на клиента
const CTRL_RATE = 30;      // прочих в секунду
const PING_MS = 30000;

/* Компьютеры аудиторий: метка передаётся в ?station=... (без логина ученика).
   В аудитории 109 — 6 машин, в 110 — 7, в 114 — 24. */
const STATIONS = ['R114-01', 'R114-02', 'R114-03', 'R114-17', 'R114-18', 'R114-19'];
const STATION_ROOMS = ['109', '110', '114'];
const STATION_ROOM_MAX = { '109': 6, '110': 7, '114': 24 };
function stationSortKey(id) {
  const m = /^R(109|110|114)-(\d{1,2})$/.exec(String(id || ''));
  if (!m) return 99999;
  return STATION_ROOMS.indexOf(m[1]) * 1000 + Number(m[2]);
}
const COMP_MAX = 6;                 // одновременно в заезде
const COMP_STUDENTS_MAX = 64;       // предохранитель для класса
const COMP_CAMERA_PICK_MS = 10000;  // выбор камеры (C) перед отсчётом
const COMP_COUNTDOWN_MS = 5000;     // общий отсчёт до старта
const COMP_NAME_MAX = 60;
/* Форматы турнира:
   heats   — отборочные заезды с проходом лучших (режим по умолчанию);
   olympic — олимпийская сетка 1×1: в каждом заезде двое, проходит победитель;
   points  — накопление очков: заданное число раундов, все летают в каждом. */
const COMP_FORMATS = ['heats', 'olympic', 'points'];
const COMP_ROUNDS_MIN = 1;
const COMP_ROUNDS_MAX = 12;
const COMP_ROUNDS_DEFAULT = 3;
function sanitizeCompFormat(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return COMP_FORMATS.includes(s) ? s : 'heats';
}
function sanitizeCompRounds(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return COMP_ROUNDS_DEFAULT;
  return Math.max(COMP_ROUNDS_MIN, Math.min(COMP_ROUNDS_MAX, n));
}
const COMP_TIMEOUT = {             // страховка на случай «зависшего» заезда
  utt1: 130000, utt2: 110000, utt5: 120000, utt4: 120000,
  forest: 330000, city: 350000, village: 370000,
  quarry: 390000, port: 350000, alpine: 410000,
};
/* Турнир сохраняется между перезапусками релея (каталог data/ в .gitignore). */
const COMP_STATE_DIR = path.join(__dirname, 'data');
const COMP_STATE_FILE = path.join(COMP_STATE_DIR, 'competition.json');

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
  let urlObj = null;
  try { urlObj = new URL(req.url || '/', 'http://relay.local'); } catch (_) {}
  if (urlObj && results.handleHttp(req, res, urlObj)) return;
  serveStatic(req, res);
});

/* ───────────────────────── Состояние ───────────────────────── */
let userSeq = 0;
let roomSeq = 0;
const clients = new Map(); // ws -> client
const rooms = new Map();   // roomId -> room
let comp = null;           // активное соревнование (одно на релей)
let compHeatSeq = 0;

function sanitizeName(v, max = NAME_MAX) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, max);
}
function sanitizeMap(v) { return MAPS.includes(v) ? v : 'meadow'; }
function sanitizeMode(v) { return MODES.includes(v) ? v : 'angle'; }
function sanitizeRace(v) { return RACES.includes(v) ? v : ''; }
function sanitizeStation(v) {
  const s = String(v == null ? '' : v).trim().toUpperCase();
  const m = /^R(109|110|114)-(\d{1,2})$/.exec(s);
  if (!m) return '';
  const num = Number(m[2]);
  const max = STATION_ROOM_MAX[m[1]] || 0;
  if (!Number.isFinite(num) || num < 1 || num > max) return '';
  return 'R' + m[1] + '-' + String(num).padStart(2, '0');
}
function allowedOptions(isAdmin) { return isAdmin ? MAX_OPTIONS : MAX_OPTIONS.filter((n) => n <= PUBLIC_MAX); }
function sanitizeMax(v, isAdmin) {
  let n = parseInt(v, 10);
  if (!MAX_OPTIONS.includes(n)) n = 4;
  if (!isAdmin && n > PUBLIC_MAX) n = PUBLIC_MAX;
  return n;
}

/* ═══════════════════════════════════════════════════════════════════
   СОРЕВНОВАНИЕ
   Сервер строит турнирную сетку, назначает учеников на подключённые
   компьютеры и ведёт заезды (не более COMP_MAX гонщиков одновременно).
   ═══════════════════════════════════════════════════════════════════ */

function compFindHeat(heatId) {
  if (!comp) return null;
  const id = Number(heatId);
  for (const round of comp.rounds) {
    for (const heat of round.heats) {
      if (heat.id === id) return heat;
    }
  }
  return null;
}
function compAllHeats() {
  if (!comp) return [];
  const out = [];
  for (const round of comp.rounds) out.push(...round.heats);
  return out;
}
/* ─── Сохранение турнира между перезапусками релея ─── */
function compStateSnapshot() {
  if (!comp) return null;
  return {
    version: 1,
    savedAt: Date.now(),
    comp: {
      id: comp.id,
      title: comp.title,
      classId: comp.classId,
      className: comp.className,
      track: comp.track,
      mode: comp.mode,
      format: comp.format || 'heats',
      roundCount: Number(comp.roundCount) || 0,
      rated: !!comp.rated,
      adminName: comp.adminName,
      createdAt: comp.createdAt,
      stationIds: (comp.stationIds || STATIONS).slice(),
      heatSize: Number(comp.heatSize) || COMP_MAX,
      seatMap: Object.assign({}, comp.seatMap || {}),
      students: comp.students.map((s) => ({
        id: Number(s.id),
        name: String(s.name),
        className: String(s.className || ''),
      })),
      rounds: comp.rounds.map((r) => ({
        index: Number(r.index) || 1,
        name: String(r.name || ''),
        heats: r.heats.map((h) => ({
          id: Number(h.id),
          number: Number(h.number) || Number(h.id),
          round: Number(h.round) || Number(r.index) || 1,
          index: Number(h.index) || 1,
          label: String(h.label || ''),
          participants: h.participants.slice(),
          sources: h.sources.map((s) => ({ heatId: Number(s.heatId), place: Number(s.place) })),
          results: h.results.map((x) => ({
            sid: Number(x.sid),
            place: Number(x.place) || 0,
            fin: x.fin == null ? null : Number(x.fin),
            time: Number(x.time) || 0,
            prog: Number(x.prog) || 0,
            done: !!x.done,
            failed: !!x.failed,
          })),
          status: h.status,
          assignments: h.assignments ? Object.assign({}, h.assignments) : null,
          qualifiers: h.qualifiers.slice(),
          kind: String(h.kind || ''),
          skipped: !!h.skipped,
          finishedAt: Number(h.finishedAt) || 0,
          finishReason: String(h.finishReason || ''),
        })),
      })),
      currentHeatId: Number(comp.currentHeatId) || 0,
      nextHeatId: Number(comp.nextHeatId) || 0,
      activeHeatId: Number(comp.activeHeatId) || 0,
      lastHeatId: Number(comp.lastHeatId) || 0,
      phase: comp.phase,
      startAt: Number(comp.startAt) || 0,
      startsIn: Number(comp.startsIn) || 0,
    },
  };
}
function compClearState() {
  try { fs.rmSync(COMP_STATE_FILE, { force: true }); } catch (_) {}
}
function compSaveState() {
  try {
    if (!comp) { compClearState(); return; }
    fs.mkdirSync(COMP_STATE_DIR, { recursive: true });
    const text = JSON.stringify(compStateSnapshot());
    const tmp = COMP_STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, text, 'utf8');
    try {
      fs.renameSync(tmp, COMP_STATE_FILE);
    } catch (_) {
      try { fs.rmSync(COMP_STATE_FILE, { force: true }); } catch (__) {}
      fs.renameSync(tmp, COMP_STATE_FILE);
    }
  } catch (err) {
    console.warn('[comp] state save failed:', err && err.message ? err.message : err);
  }
}
/* Восстановление турнира при старте релея. Незавершённый заезд (countdown/
   running) перезапускается с подготовки: результаты такого заезда не считаем. */
function compRestoreState() {
  if (comp) return false;
  let data = null;
  try {
    if (!fs.existsSync(COMP_STATE_FILE)) return false;
    data = JSON.parse(fs.readFileSync(COMP_STATE_FILE, 'utf8'));
  } catch (err) {
    console.warn('[comp] state restore skipped:', err && err.message ? err.message : err);
    return false;
  }
  const saved = data && data.comp;
  if (!saved || !Array.isArray(saved.students) || !saved.students.length
    || !Array.isArray(saved.rounds) || !saved.rounds.length) {
    console.warn('[comp] state restore skipped: empty/invalid file');
    return false;
  }

  const students = [];
  const seen = new Set();
  for (const s of saved.students) {
    const id = Number(s && s.id);
    if (!Number.isFinite(id) || id === 0 || seen.has(id)) continue;
    const name = sanitizeName(s.name, COMP_NAME_MAX);
    if (!name) continue;
    seen.add(id);
    students.push({ id, name, className: sanitizeName(s.className || s.class_name || '', 60) });
  }
  if (!students.length) {
    console.warn('[comp] state restore skipped: no valid students');
    return false;
  }

  const rounds = [];
  let maxHeatId = 0;
  for (const r of saved.rounds) {
    if (!r || !Array.isArray(r.heats)) continue;
    const heats = [];
    for (const h of r.heats) {
      if (!h) continue;
      const id = Number(h.id);
      if (!Number.isFinite(id) || id <= 0) continue;
      maxHeatId = Math.max(maxHeatId, id);
      const status = ['pending', 'running', 'done'].includes(h.status) ? h.status : 'pending';
      const participants = (Array.isArray(h.participants) ? h.participants : [])
        .map(Number).filter((sid) => seen.has(sid));
      const sources = (Array.isArray(h.sources) ? h.sources : [])
        .map((s) => ({ heatId: Number(s && s.heatId), place: Number(s && s.place) }))
        .filter((s) => Number.isFinite(s.heatId) && s.heatId > 0 && Number.isFinite(s.place) && s.place > 0);
      const results = (Array.isArray(h.results) ? h.results : []).map((x) => {
        const sid = Number(x && x.sid);
        if (!seen.has(sid)) return null;
        return {
          sid,
          place: Number(x.place) || 0,
          fin: x.fin == null ? null : (Number(x.fin) || 0),
          time: Number(x.time) || 0,
          prog: Number(x.prog) || 0,
          done: !!x.done,
          failed: !!x.failed,
        };
      }).filter(Boolean);
      let assignments = null;
      if (h.assignments && typeof h.assignments === 'object') {
        assignments = {};
        for (const [sid, station] of Object.entries(h.assignments)) {
          const n = Number(sid);
          const st = sanitizeStation(station);
          if (seen.has(n) && st) assignments[n] = st;
        }
      }
      const qualifiers = (Array.isArray(h.qualifiers) ? h.qualifiers : [])
        .map(Number).filter((sid) => seen.has(sid));
      heats.push({
        id,
        number: Number(h.number) || id,
        round: Number(h.round) || Number(r.index) || 1,
        index: Number(h.index) || heats.length + 1,
        label: sanitizeName(h.label, 30) || ('Заезд ' + id),
        participants,
        sources,
        results,
        live: {},
        status,
        assignments,
        qualifiers,
        startToken: '',
        kind: sanitizeName(h.kind, 20),
        skipped: !!h.skipped,
        finishedAt: Number(h.finishedAt) || 0,
        finishReason: sanitizeName(h.finishReason, 40),
        finishScheduled: false,
      });
    }
    if (heats.length) {
      rounds.push({
        index: Number(r.index) || rounds.length + 1,
        name: sanitizeName(r.name, 40) || ('Раунд ' + (rounds.length + 1)),
        heats,
      });
    }
  }
  if (!rounds.length) {
    console.warn('[comp] state restore skipped: no valid heats');
    return false;
  }

  const stationIds = [];
  const rawStations = Array.isArray(saved.stationIds) ? saved.stationIds : STATIONS;
  for (const raw of rawStations) {
    const id = sanitizeStation(raw);
    if (id && stationIds.indexOf(id) < 0) stationIds.push(id);
  }
  stationIds.sort((a, b) => stationSortKey(a) - stationSortKey(b));
  if (!stationIds.length) stationIds.push(...STATIONS);
  let heatSize = Number(saved.heatSize) || Math.min(COMP_MAX, stationIds.length, students.length);
  heatSize = Math.max(1, Math.min(COMP_MAX, stationIds.length, students.length, heatSize));

  comp = {
    id: Number(saved.id) || Date.now(),
    title: sanitizeName(saved.title, 60) || 'Соревнование',
    classId: sanitizeName(saved.classId, 40),
    className: sanitizeName(saved.className, 60) || 'Класс',
    track: sanitizeRace(saved.track) || 'utt1',
    mode: sanitizeMode(saved.mode),
    format: sanitizeCompFormat(saved.format),
    roundCount: sanitizeCompRounds(saved.roundCount),
    rated: !!saved.rated,
    adminId: 0,
    adminName: sanitizeName(saved.adminName, COMP_NAME_MAX) || 'Учитель',
    createdAt: Number(saved.createdAt) || Date.now(),
    stationIds,
    heatSize,
    students,
    rounds,
    seatMap: {},
    currentHeatId: Number(saved.currentHeatId) || 0,
    nextHeatId: Number(saved.nextHeatId) || 0,
    activeHeatId: Number(saved.activeHeatId) || 0,
    lastHeatId: Number(saved.lastHeatId) || 0,
    phase: ['prep', 'countdown', 'running', 'heat_done', 'finished'].includes(saved.phase)
      ? saved.phase : 'prep',
    startAt: 0,
    startsIn: 0,
    roomId: 0,
    phaseTimer: null,
    heatTimer: null,
  };
  /* Постоянные места участников: ученик остаётся за своим ПК между заездами. */
  if (saved.seatMap && typeof saved.seatMap === 'object') {
    const allowed = new Set(comp.stationIds);
    const taken = new Set();
    for (const [rawSid, rawStation] of Object.entries(saved.seatMap)) {
      const sid = Number(rawSid);
      const station = sanitizeStation(rawStation);
      if (!seen.has(sid) || !station || !allowed.has(station) || taken.has(station)) continue;
      comp.seatMap[sid] = station;
      taken.add(station);
    }
  }

  compHeatSeq = Math.max(compHeatSeq, maxHeatId);
  compResolveAdvances();
  compSkipEmptyLaterHeats();
  results.archiveAllDone(comp);

  /* Прерванный заезд нельзя честно продолжить после перезапуска релея. */
  let interrupted = null;
  if (comp.phase === 'countdown' || comp.phase === 'running') {
    interrupted = compFindHeat(comp.activeHeatId) || compFindHeat(comp.currentHeatId);
  }
  if (!interrupted) {
    for (const h of compAllHeats()) {
      if (h.status === 'running') { interrupted = h; break; }
    }
  }
  if (interrupted) {
    interrupted.status = 'pending';
    interrupted.live = {};
    interrupted.results = [];
    interrupted.assignments = null;
    interrupted.qualifiers = [];
    interrupted.startToken = '';
    interrupted.skipped = false;
    interrupted.finishScheduled = false;
    if (comp.lastHeatId === interrupted.id) comp.lastHeatId = 0;
    comp.phase = 'prep';
    comp.currentHeatId = interrupted.id;
    comp.nextHeatId = interrupted.id;
    comp.activeHeatId = 0;
    comp.startAt = 0;
    comp.startsIn = 0;
  }

  if (!['prep', 'heat_done', 'finished'].includes(comp.phase)) comp.phase = 'prep';
  if (!compFindHeat(comp.currentHeatId)) comp.currentHeatId = 0;
  if (!compFindHeat(comp.nextHeatId)) comp.nextHeatId = 0;
  if (!compFindHeat(comp.lastHeatId)) comp.lastHeatId = 0;

  if (comp.phase === 'prep') {
    const cur = compFindHeat(comp.currentHeatId);
    if (!cur || cur.status !== 'pending') {
      const next = compNextPendingHeat();
      if (next) {
        comp.currentHeatId = next.id;
        comp.nextHeatId = next.id;
      } else {
        comp.phase = compAllHeatsDone() ? 'finished' : 'heat_done';
        comp.currentHeatId = 0;
        comp.nextHeatId = 0;
      }
    } else {
      comp.nextHeatId = cur.id;
    }
  }
  if (comp.phase === 'heat_done') {
    if (!comp.lastHeatId) {
      const done = compAllHeats().filter((h) => h.status === 'done');
      if (done.length) comp.lastHeatId = done[done.length - 1].id;
    }
    const next = compNextPendingHeat();
    comp.nextHeatId = next ? next.id : 0;
    if (!comp.nextHeatId && compAllHeatsDone()) comp.phase = 'finished';
  }
  if (comp.phase === 'finished') {
    comp.currentHeatId = 0;
    comp.nextHeatId = 0;
    comp.activeHeatId = 0;
  }
  comp.activeHeatId = 0;
  comp.startAt = 0;
  comp.startsIn = 0;

  const room = {
    id: ++roomSeq,
    title: comp.title,
    map: 'meadow',
    params: {
      mode: comp.mode,
      director: true,
      competition: true,
      racersMax: COMP_MAX,
      race: comp.track,
    },
    pair: false,
    director: true,
    started: comp.phase !== 'prep',
    max: DIRECTOR_MAX,
    hostId: 0,
    createdAt: Date.now(),
    members: new Map(),
  };
  rooms.set(room.id, room);
  comp.roomId = room.id;
  console.log('[comp] restored:', comp.title, '·', comp.phase, '·', comp.students.length, 'уч.');
  compSaveState();
  return true;
}
function compStudentName(sid) {
  if (!comp) return 'Ученик';
  const s = comp.students.find((x) => x.id === Number(sid));
  return s ? s.name : 'Ученик';
}
function compStationClient(station) {
  for (const c of clients.values()) {
    if (c.station === station && c.ws && c.ws.readyState === 1) return c;
  }
  return null;
}
function compConnectedStations() {
  const room = comp && rooms.get(comp.roomId);
  const allowed = (comp && Array.isArray(comp.stationIds) && comp.stationIds.length)
    ? comp.stationIds : STATIONS;
  return allowed.map((id) => {
    const client = compStationClient(id);
    return {
      id,
      connected: !!(client && room && client.roomId === room.id),
      client: client || null,
    };
  });
}
/* Разбить список на группы не больше COMP_MAX (по возможности равные). */
function compChunk(items, max) {
  const n = items.length;
  if (!n) return [];
  const count = Math.ceil(n / max);
  const base = Math.floor(n / count);
  const rem = n % count;
  const out = [];
  let pos = 0;
  for (let i = 0; i < count; i++) {
    const size = base + (i < rem ? 1 : 0);
    out.push(items.slice(pos, pos + size));
    pos += size;
  }
  return out;
}
function compNewHeat(round, index, participants, sources) {
  const number = ++compHeatSeq;
  return {
    id: number,
    number,
    round,
    index,
    label: 'Заезд ' + number,
    participants: participants.slice(),
    sources: (sources || []).slice(),
    kind: '',
    results: [],
    live: {},
    status: 'pending',
    assignments: null,
    qualifiers: [],
    startToken: '',
    finishReason: '',
  };
}
/* Сетка «заезды с отбором»: группы по heatSize, из каждого проходит
   floor(heatSize / число заездов) лучших; каждый выбывший получает место. */
function compBuildHeats(students) {
  compHeatSeq = 0;
  const ids = students.map((s) => s.id);
  let cap = Math.max(1, Math.min(COMP_MAX, Number(comp && comp.heatSize) || COMP_MAX));
  if (cap < 2 && ids.length > 1) cap = 2;   // защита от зацикливания; старт всё равно потребует 2 ПК
  const firstGroups = compChunk(ids, cap);
  const firstHeats = firstGroups.map((parts, i) => compNewHeat(1, i + 1, parts, []));
  const rounds = [{
    index: 1,
    name: firstHeats.length > 1 ? 'Отборочные заезды' : 'Финал',
    heats: firstHeats,
  }];
  let prev = firstHeats;
  let roundIndex = 1;
  while (prev.length > 1) {
    const q = Math.max(1, Math.floor(cap / prev.length));
    const sources = [];
    for (const heat of prev) {
      for (let place = 1; place <= q; place++) sources.push({ heatId: heat.id, place });
    }
    const groups = compChunk(sources, cap);
    const heats = groups.map((srcs, i) => compNewHeat(roundIndex + 1, i + 1, [], srcs));
    const isFinal = heats.length === 1;
    rounds.push({
      index: roundIndex + 1,
      name: isFinal ? 'Финал' : ('Раунд ' + (roundIndex + 1)),
      heats,
    });
    prev = heats;
    roundIndex++;
    if (isFinal) break;
  }
  return { rounds, heats: rounds.flatMap((r) => r.heats) };
}
/* Название раунда олимпийской сетки по числу заездов в нём. */
function compOlympicRoundName(heatsCount, round) {
  if (heatsCount <= 1) return 'Финал';
  if (heatsCount === 2) return '1/2 финала';
  if (heatsCount === 4) return '1/4 финала';
  if (heatsCount === 8) return '1/8 финала';
  return 'Раунд ' + (round || 1);
}
/* Олимпийская сетка 1×1: в заезде двое, дальше идёт только победитель.
   При нечётном числе участников один проходит без гонки (bye). */
function compBuildOlympic(students) {
  compHeatSeq = 0;
  const ids = students.map((s) => s.id);
  const rounds = [];
  let prev = [];
  for (let i = 0; i < ids.length; i += 2) {
    prev.push(compNewHeat(1, prev.length + 1, ids.slice(i, i + 2), []));
  }
  if (!prev.length) return { rounds: [], heats: [] };
  rounds.push({ index: 1, name: compOlympicRoundName(prev.length, 1), heats: prev });
  let round = 1;
  while (prev.length > 1) {
    round++;
    const next = [];
    for (let i = 0; i < prev.length; i += 2) {
      const srcs = [{ heatId: prev[i].id, place: 1 }];
      if (prev[i + 1]) srcs.push({ heatId: prev[i + 1].id, place: 1 });
      next.push(compNewHeat(round, next.length + 1, [], srcs));
    }
    rounds.push({ index: round, name: compOlympicRoundName(next.length, round), heats: next });
    prev = next;
  }
  /* Матч за 3-е место: между проигравшими полуфиналов, перед финалом. */
  if (rounds.length >= 2) {
    const finalRound = rounds[rounds.length - 1];
    const semiRound = rounds[rounds.length - 2];
    if (finalRound.heats.length === 1 && semiRound.heats.length === 2) {
      const bronze = compNewHeat(semiRound.index + 1, 1, [], [
        { heatId: semiRound.heats[0].id, place: 2 },
        { heatId: semiRound.heats[1].id, place: 2 },
      ]);
      bronze.kind = 'bronze';
      bronze.label = 'Заезд за 3-е место';
      finalRound.index += 1;
      finalRound.heats[0].round = finalRound.index;
      finalRound.heats[0].kind = 'final';
      finalRound.heats[0].label = 'Финал';
      rounds.splice(rounds.length - 1, 0, {
        index: bronze.round,
        name: 'За 3-е место',
        heats: [bronze],
      });
    }
  }
  return { rounds, heats: rounds.flatMap((r) => r.heats) };
}
/* Ключ пары участников — чтобы помнить, кто с кем уже летал. */
function compPairKey(a, b) {
  const x = Number(a);
  const y = Number(b);
  return x < y ? x + ':' + y : y + ':' + x;
}
/* Разбить участников на группы так, чтобы в этом раунде было как можно
   меньше повторных соперников: каждый следующий участник идёт в группу,
   где он меньше всех встречался, при равных условиях — в меньшую. */
function compPointsGroups(ids, cap, met) {
  const count = Math.max(1, Math.ceil(ids.length / cap));
  const groups = Array.from({ length: count }, () => []);
  for (const sid of ids) {
    let best = -1;
    let bestScore = Infinity;
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      if (g.length >= cap) continue;
      let repeats = 0;
      for (const other of g) {
        if (met.has(compPairKey(sid, other))) repeats++;
      }
      const score = repeats * 100 + g.length / cap;
      if (score < bestScore) { bestScore = score; best = gi; }
    }
    if (best < 0) {
      best = 0;
      for (let gi = 1; gi < groups.length; gi++) {
        if (groups[gi].length < groups[best].length) best = gi;
      }
    }
    groups[best].push(sid);
  }
  return groups.filter((g) => g.length);
}
/* Локальное улучшение групп: меняем участников местами между группами,
   пока это уменьшает число повторных соперников в этом раунде. */
function compSwapImprove(groups, met) {
  const groupCost = (g) => {
    let c = 0;
    for (let i = 0; i < g.length; i++) {
      for (let j = i + 1; j < g.length; j++) {
        const n = (met.get(compPairKey(g[i], g[j])) || 0) + 1;
        c += n * n;   // выпуклая цена: третья встреча дороже двух вторых
      }
    }
    return c;
  };
  for (let pass = 0; pass < 20; pass++) {
    let improved = false;
    for (let a = 0; a < groups.length; a++) {
      for (let b = a + 1; b < groups.length; b++) {
        for (let i = 0; i < groups[a].length; i++) {
          for (let j = 0; j < groups[b].length; j++) {
            const before = groupCost(groups[a]) + groupCost(groups[b]);
            const p = groups[a][i];
            const q = groups[b][j];
            groups[a][i] = q;
            groups[b][j] = p;
            if (groupCost(groups[a]) + groupCost(groups[b]) < before) {
              improved = true;
            } else {
              groups[a][i] = p;
              groups[b][j] = q;
            }
          }
        }
      }
    }
    if (!improved) break;
  }
  return groups;
}
/* Глобальная донастройка расписания: перестановки между группами одного
   раунда, уменьшающие число повторных встреч (выпуклая цена c²). */
function compOptimizePoints(rounds) {
  const counts = new Map();
  const bump = (a, b, d) => {
    const k = compPairKey(a, b);
    const c = (counts.get(k) || 0) + d;
    if (c <= 0) counts.delete(k); else counts.set(k, c);
  };
  for (const round of rounds) {
    for (const h of round.heats) {
      const p = h.participants;
      for (let i = 0; i < p.length; i++) {
        for (let j = i + 1; j < p.length; j++) bump(p[i], p[j], +1);
      }
    }
  }
  let seed = 1234567;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const cost = (c) => c * c;
  let idle = 0;
  for (let attempt = 0; attempt < 20000 && idle < 4000; attempt++) {
    const round = rounds[Math.floor(rnd() * rounds.length)];
    if (!round || round.heats.length < 2) { idle++; continue; }
    const ai = Math.floor(rnd() * round.heats.length);
    let bi = Math.floor(rnd() * round.heats.length);
    if (bi === ai) bi = (bi + 1) % round.heats.length;
    const A = round.heats[ai].participants;
    const B = round.heats[bi].participants;
    if (!A.length || !B.length) { idle++; continue; }
    const i = Math.floor(rnd() * A.length);
    const j = Math.floor(rnd() * B.length);
    const p = A[i];
    const q = B[j];
    const moves = [];
    for (const x of A) if (x !== p) moves.push([p, x, -1]);
    for (const y of B) if (y !== q) moves.push([q, y, -1]);
    for (const x of A) if (x !== p) moves.push([q, x, +1]);
    for (const y of B) if (y !== q) moves.push([p, y, +1]);
    let delta = 0;
    for (const [u, v, d] of moves) {
      const c = counts.get(compPairKey(u, v)) || 0;
      delta += cost(c + d) - cost(c);
    }
    if (delta < 0) {
      for (const [u, v, d] of moves) bump(u, v, d);
      A[i] = q;
      B[j] = p;
      idle = 0;
    } else {
      idle++;
    }
  }
  return rounds;
}
/* Накопление очков: заданное число раундов, в каждом летают все участники.
   Группы пересобираются от раунда к раунду так, чтобы соперники менялись. */
function compBuildPoints(students) {
  compHeatSeq = 0;
  const cap = Math.max(2, Math.min(COMP_MAX, Number(comp && comp.heatSize) || COMP_MAX));
  const roundCount = Math.max(COMP_ROUNDS_MIN,
    Math.min(COMP_ROUNDS_MAX, Number(comp && comp.roundCount) || COMP_ROUNDS_DEFAULT));
  const ids = students.map((s) => s.id);
  const met = new Map();
  const rounds = [];
  for (let r = 1; r <= roundCount; r++) {
    let groups;
    if (r === 1) {
      groups = compChunk(ids, cap);
    } else {
      groups = compPointsGroups(ids, cap, met);
      compSwapImprove(groups, met);
    }
    const heats = groups.map((parts, i) => compNewHeat(r, i + 1, parts, []));
    rounds.push({ index: r, name: roundCount > 1 ? ('Раунд ' + r) : 'Заезды', heats });
    for (const g of groups) {
      for (let i = 0; i < g.length; i++) {
        for (let j = i + 1; j < g.length; j++) {
          const k = compPairKey(g[i], g[j]);
          met.set(k, (met.get(k) || 0) + 1);
        }
      }
    }
  }
  compOptimizePoints(rounds);
  return { rounds, heats: rounds.flatMap((x) => x.heats) };
}
function compBuildBracket(students) {
  const format = (comp && comp.format) || 'heats';
  if (format === 'olympic') return compBuildOlympic(students);
  if (format === 'points') return compBuildPoints(students);
  return compBuildHeats(students);
}
/* Заполнить участников следующего раунда по результатам source-заездов.
   Возвращает true, если состав какого-то заезда изменился. */
function compFillSourcesOnce() {
  if (!comp) return false;
  let changed = false;
  for (const heat of compAllHeats()) {
    if (!heat.sources.length) continue;
    const sourceHeats = heat.sources.map((s) => compFindHeat(s.heatId));
    if (!sourceHeats.every((h) => h && h.status === 'done')) {
      if (heat.participants.length) { heat.participants = []; changed = true; }
      continue;
    }
    const parts = [];
    for (const src of heat.sources) {
      const sh = compFindHeat(src.heatId);
      const res = sh && sh.results.find((r) => r.place === src.place);
      if (res && !res.failed) parts.push(res.sid);
    }
    if (parts.join(',') !== heat.participants.join(',')) {
      heat.participants = parts;
      changed = true;
    }
  }
  return changed;
}
/* Олимпийская сетка: если в заезде остался один участник — он проходит без гонки. */
function compAutoFinishByes() {
  if (!comp || (comp.format || 'heats') !== 'olympic') return false;
  let changed = false;
  for (const heat of compAllHeats()) {
    if (heat.status !== 'pending' || heat.participants.length !== 1) continue;
    const sid = heat.participants[0];
    heat.status = 'done';
    heat.finishedAt = Date.now();
    heat.finishReason = 'bye';
    heat.results = [{ sid, place: 1, fin: null, time: 0, prog: 0, done: true, failed: false }];
    heat.qualifiers = [sid];
    changed = true;
  }
  return changed;
}
/* Досчитать проходы и bye-заезды до устойчивого состояния. */
function compResolveAdvances() {
  if (!comp) return;
  for (let guard = 0; guard < 100; guard++) {
    const filled = compFillSourcesOnce();
    const byes = compAutoFinishByes();
    if (!filled && !byes) break;
  }
}
function compNextPendingHeat() {
  if (!comp) return null;
  for (const round of comp.rounds) {
    for (const heat of round.heats) {
      if (heat.status === 'pending' && heat.participants.length) return heat;
    }
  }
  return null;
}
/* Пропустить заезд, в который никто не прошёл (все источники завершены,
   но участников нет). Иначе турнир зависнет на пустом финале. */
function compSkipEmptyLaterHeats() {
  if (!comp) return;
  for (const h of compAllHeats()) {
    if (h.status !== 'pending' || !h.sources.length || h.participants.length) continue;
    const sourcesDone = h.sources.every((src) => {
      const sh = compFindHeat(src.heatId);
      return !!(sh && sh.status === 'done');
    });
    if (!sourcesDone) continue;
    h.status = 'done';
    h.skipped = true;
    h.results = [];
    h.qualifiers = [];
  }
}
function compAllHeatsDone() {
  return compAllHeats().every((h) => h.status === 'done');
}
/* ─── Постоянные места: участник сидит за своим ПК во всех заездах ─── */
/* Компьютеров, выделенных соревнованию (в т.ч. временно отключённых). */
function compSeatCount() {
  if (!comp) return 0;
  const ids = Array.isArray(comp.stationIds) && comp.stationIds.length
    ? comp.stationIds : STATIONS;
  return ids.length;
}
/* Места имеет смысл закреплять, когда участников не больше, чем компьютеров:
   каждому ученику хватает отдельного ПК на весь турнир. */
function compSeatsStable() {
  return !!comp && comp.students.length <= compSeatCount();
}
/* Запомнить, кто за каким ПК сидел в заезде. При ручной пересадке занятый ПК
   меняет владельцев местами, чтобы постоянные места не конфликтовали. */
function compRememberSeats(assignments) {
  if (!comp || !assignments) return;
  const seats = Object.assign({}, comp.seatMap || {});
  for (const [rawSid, rawStation] of Object.entries(assignments)) {
    const sid = Number(rawSid);
    const station = sanitizeStation(rawStation);
    if (!sid || !station) continue;
    const prevStation = sanitizeStation(seats[sid]);
    const holder = Object.keys(seats).find((other) => Number(other) !== sid && seats[other] === station);
    if (holder != null) {
      if (prevStation) seats[holder] = prevStation;
      else delete seats[holder];
    }
    seats[sid] = station;
  }
  comp.seatMap = seats;
}
/* Предварительное назначение учеников на подключённые ПК (до старта).
   Если админ уже расставил участников вручную (heat.assignments), уважаем
   его выбор: недостающие места не заполняем автоматически, пока он сам
   не посадит всех участников заезда. */
function compPreviewAssignments(heat) {
  const connected = compConnectedStations().filter((s) => s.connected);
  const map = {};
  const missing = [];
  if (heat) {
    const manual = heat.assignments && typeof heat.assignments === 'object' ? heat.assignments : null;
    if (manual) {
      const used = new Set();
      heat.participants.forEach((sid) => {
        const st = sanitizeStation(manual[sid]);
        if (st && connected.some((s) => s.id === st) && !used.has(st)) {
          map[sid] = st;
          used.add(st);
        } else {
          missing.push(sid);
        }
      });
    } else {
      const used = new Set();
      const seats = compSeatsStable() ? (comp.seatMap || {}) : {};
      /* Сначала — прежние места участников этого заезда. */
      heat.participants.forEach((sid) => {
        const st = sanitizeStation(seats[sid]);
        if (st && !used.has(st) && connected.some((s) => s.id === st)) {
          map[sid] = st;
          used.add(st);
        }
      });
      /* Остальным — свободные компьютеры по порядку. */
      heat.participants.forEach((sid) => {
        if (map[sid]) return;
        const free = connected.find((s) => !used.has(s.id));
        if (free) {
          map[sid] = free.id;
          used.add(free.id);
        } else {
          missing.push(sid);
        }
      });
    }
  }
  return { map, missing, ready: !!heat && heat.participants.length > 0 && missing.length === 0, connected };
}
function compHeatAssignments(heat) {
  if (!heat) return {};
  if (heat.status === 'pending') return compPreviewAssignments(heat).map;
  if (heat.assignments) return heat.assignments;
  return {};
}
function compAssignmentForStation(station) {
  if (!comp) return 0;
  let heat = compFindHeat(comp.activeHeatId);
  if (!heat && comp.phase === 'prep') heat = compFindHeat(comp.currentHeatId);
  if (!heat) heat = compFindHeat(comp.lastHeatId);
  let map = compHeatAssignments(heat);
  for (const [sid, st] of Object.entries(map)) {
    if (st === station) return Number(sid);
  }
  /* После заезда/финала: последний ученик, который сидел за этим ПК. */
  if (comp.phase === 'heat_done' || comp.phase === 'finished') {
    let bestHeat = null;
    let bestSid = 0;
    for (const h of compAllHeats()) {
      if (!h.assignments) continue;
      for (const [sid, st] of Object.entries(h.assignments)) {
        if (st === station && (!bestHeat || h.id > bestHeat.id)) {
          bestHeat = h;
          bestSid = Number(sid);
        }
      }
    }
    if (bestSid) return bestSid;
  }
  return 0;
}
function compParticipantName(room, client) {
  if (!comp) return client.name;
  if (client.id === comp.adminId) return comp.adminName || client.name;
  if (!client.station) return client.name;
  const sid = compAssignmentForStation(client.station);
  return sid ? compStudentName(sid) : client.station;
}
function compClearClientAssignments() {
  if (!comp) return;
  const room = rooms.get(comp.roomId);
  if (!room) return;
  for (const c of room.members.values()) {
    c.compHeatId = 0;
    c.compSid = 0;
  }
}
function compClientActive(client, room) {
  return !!(comp && comp.activeHeatId && room && client.roomId === room.id
    && client.compHeatId === comp.activeHeatId && client.compSid);
}
/* Очки в режиме накопления: фиксированная таблица по месту в заезде,
   чтобы нечётные по размеру заезды не давали преимущества. */
const COMP_POINTS = [25, 22, 20, 18, 16, 15];
function compPointsForPlace(place) {
  const p = Math.max(1, Math.round(Number(place) || 99));
  return COMP_POINTS[p - 1] != null ? COMP_POINTS[p - 1] : 10;
}
function compPointsStandings() {
  if (!comp) return [];
  const totals = new Map();
  for (const heat of compAllHeats()) {
    if (heat.status !== 'done') continue;
    for (const r of heat.results) {
      const t = totals.get(r.sid) || { points: 0, time: 0, races: 0, wins: 0, dnf: 0 };
      t.races += 1;
      if (r.failed) {
        t.dnf += 1;
      } else {
        t.points += compPointsForPlace(r.place);
        if (r.fin != null) t.time += Number(r.fin) || 0;
        if (Number(r.place) === 1) t.wins += 1;
      }
      totals.set(r.sid, t);
    }
  }
  const rows = comp.students.map((s) => {
    const t = totals.get(s.id) || { points: 0, time: 0, races: 0, wins: 0, dnf: 0 };
    return {
      sid: s.id,
      name: s.name,
      status: 'points',
      note: t.points + ' очк.',
      points: t.points,
      time: t.time,
      races: t.races,
      wins: t.wins,
      dnf: t.dnf,
      fin: null,
    };
  });
  rows.sort((a, b) => (b.points - a.points)
    || (a.dnf - b.dnf)
    || (a.time - b.time)
    || a.name.localeCompare(b.name, 'ru'));
  return rows.map((r, i) => Object.assign(r, { place: i + 1 }));
}
function compStandings() {
  if (!comp) return [];
  if ((comp.format || 'heats') === 'points') return compPointsStandings();
  return compElimStandings();
}
function compElimStandings() {
  if (!comp) return [];
  const finalRound = comp.rounds[comp.rounds.length - 1];
  const finalHeat = finalRound && finalRound.heats[0];
  const finalDone = !!(finalHeat && finalHeat.status === 'done');
  const finalSids = new Set(finalDone ? finalHeat.results.map((r) => r.sid) : []);

  /* Последний завершённый результат и следующий (незавершённый) заезд. */
  const latest = new Map();
  const pending = new Map();
  for (const heat of compAllHeats()) {
    if (heat.status === 'done') {
      for (const r of heat.results) {
        const prev = latest.get(r.sid);
        if (!prev || heat.id > prev.heat.id) latest.set(r.sid, { result: r, heat });
      }
    } else {
      for (const sid of heat.participants) {
        if (!pending.has(sid)) pending.set(sid, heat);
      }
    }
  }

  const rows = [];
  for (const student of comp.students) {
    const sid = student.id;
    const name = student.name;
    if (finalDone && finalSids.has(sid)) {
      const r = finalHeat.results.find((x) => x.sid === sid);
      rows.push({
        sid, name,
        status: 'final',
        note: r && r.failed ? 'сход в финале' : 'финал',
        fin: r ? r.fin : null,
        time: r ? r.time : 0,
        prog: r ? r.prog : 0,
        _s: { kind: 0, round: finalHeat.round, place: r ? r.place : 99, fin: r ? r.fin : null, prog: r ? r.prog : 0 },
      });
      continue;
    }

    const p = pending.get(sid);
    const last = latest.get(sid);
    if (p) {
      const live = p.live && p.live[sid];
      const livePlace = live ? (live.done ? 1 : (live.failed ? 99 : 10)) : (last ? last.result.place : 99);
      rows.push({
        sid, name,
        status: 'active',
        note: live ? (live.done ? 'финиш' : (live.failed ? 'сход' : 'в игре'))
          : (p.status === 'running' ? 'в игре' : 'ожидание'),
        fin: live ? live.fin : (last ? last.result.fin : null),
        time: live ? live.time : 0,
        prog: live ? live.prog : 0,
        _s: { kind: 0, round: p.round, place: livePlace, fin: live ? live.fin : null, prog: live ? live.prog : 0 },
      });
      continue;
    }

    const qualified = !finalDone && last && last.heat.qualifiers
      && last.heat.qualifiers.some((q) => Number(q) === Number(sid));
    if (qualified) {
      rows.push({
        sid, name,
        status: 'active',
        note: 'прошёл дальше',
        fin: last.result.fin,
        time: last.result.time,
        prog: last.result.prog,
        _s: { kind: 0, round: last.heat.round + 1, place: last.result.place, fin: last.result.fin, prog: last.result.prog },
      });
      continue;
    }

    if (last) {
      const bronze = last.heat.kind === 'bronze';
      const olympic = (comp.format || 'heats') === 'olympic';
      const roundMeta = comp.rounds.find((r) => r.heats.some((h) => h.id === last.heat.id));
      const roundName = olympic
        ? ((roundMeta && roundMeta.name) || ('раунд ' + last.heat.round))
        : (last.heat.round === 1 ? 'отбор' : ('раунд ' + last.heat.round));
      rows.push({
        sid, name,
        status: 'out',
        note: bronze
          ? (last.result.place === 1 ? '3-е место' : '4-е место')
          : ('выбыл · ' + roundName + ' · ' + last.result.place + '-е'),
        fin: last.result.fin,
        time: last.result.time,
        prog: last.result.prog,
        _s: { kind: 1, round: last.heat.round, place: last.result.place, fin: last.result.fin, prog: last.result.prog },
      });
      continue;
    }

    rows.push({
      sid, name,
      status: 'active',
      note: 'ожидание',
      fin: null, time: 0, prog: 0,
      _s: { kind: 0, round: 0, place: 99, fin: null, prog: 0 },
    });
  }

  rows.sort((a, b) => a._s.kind - b._s.kind
    || b._s.round - a._s.round
    || a._s.place - b._s.place
    || ((a._s.fin == null ? 1e9 : a._s.fin) - (b._s.fin == null ? 1e9 : b._s.fin))
    || (b._s.prog - a._s.prog));
  return rows.map((r, i) => ({
    sid: r.sid,
    name: r.name,
    place: i + 1,
    status: r.status,
    note: r.note,
    fin: r.fin,
    time: r.time,
    prog: r.prog,
  }));
}
function compHeatPublic(heat) {
  if (!heat) return null;
  const preview = (heat.status === 'pending' && (heat.id === comp.currentHeatId || heat.id === comp.nextHeatId))
    ? compPreviewAssignments(heat) : null;
  return {
    id: heat.id,
    number: heat.number,
    round: heat.round,
    index: heat.index,
    label: heat.label,
    kind: heat.kind || '',
    status: heat.status,
    participants: heat.participants.slice(),
    sources: heat.sources.map((s) => ({ heatId: s.heatId, place: s.place })),
    results: heat.results.map((r) => ({
      sid: r.sid, place: r.place, fin: r.fin, time: r.time,
      prog: r.prog, done: r.done, failed: r.failed,
    })),
    qualifiers: heat.qualifiers.slice(),
    assignments: Object.assign({}, heat.assignments || (preview ? preview.map : {})),
    assignmentsReady: preview ? preview.ready : heat.status !== 'pending',
    missingStations: preview ? preview.missing : [],
    startToken: heat.startToken,
  };
}
function compPublic() {
  if (!comp) return null;
  const current = compFindHeat(comp.currentHeatId);
  const active = compFindHeat(comp.activeHeatId);
  const next = compFindHeat(comp.nextHeatId);
  const last = compFindHeat(comp.lastHeatId);
  const stations = compConnectedStations().map((s) => ({
    id: s.id,
    connected: s.connected,
    sid: compAssignmentForStation(s.id) || 0,
  }));
  const startedOnce = compAllHeats().some((h) => h.status !== 'pending' || h.results.length > 0);
  return {
    id: comp.id,
    title: comp.title,
    classId: comp.classId,
    className: comp.className,
    track: comp.track,
    mode: comp.mode,
    format: comp.format || 'heats',
    roundCount: Number(comp.roundCount) || 0,
    rated: !!comp.rated,
    phase: comp.phase,
    capacity: COMP_MAX,
    heatSize: Number(comp.heatSize) || COMP_MAX,
    stationIds: (comp.stationIds || STATIONS).slice(),
    createdAt: comp.createdAt,
    startsInMs: comp.phase === 'countdown' ? Math.max(0, comp.startAt - Date.now()) : 0,
    pickMs: COMP_CAMERA_PICK_MS,
    countdownMs: COMP_COUNTDOWN_MS,
    picking: comp.phase === 'countdown' && comp.startAt - Date.now() > COMP_COUNTDOWN_MS,
    pickLeftMs: comp.phase === 'countdown'
      ? Math.max(0, comp.startAt - Date.now() - COMP_COUNTDOWN_MS) : 0,
    startedOnce,
    rounds: comp.rounds.map((r) => ({
      index: r.index,
      name: r.name,
      heats: r.heats.map((h) => compHeatPublic(h)),
    })),
    students: comp.students.map((s) => ({
      id: s.id,
      name: s.name,
      className: s.className || '',
      rating: results.ratingFor(s.id),
    })),
    ratingTop: results.ratingTop(10),
    currentHeat: compHeatPublic(current || active),
    activeHeat: compHeatPublic(active),
    nextHeat: compHeatPublic(next),
    lastHeat: compHeatPublic(last),
    finalHeatId: comp.rounds.length
      ? comp.rounds[comp.rounds.length - 1].heats[comp.rounds[comp.rounds.length - 1].heats.length - 1].id
      : 0,
    standings: compStandings(),
    stations,
  };
}
function compSelfFor(client) {
  const base = {
    id: client.id,
    station: client.station || '',
    role: client.isAdmin ? 'admin' : 'student',
    sid: 0,
    name: client.station || client.name,
    active: false,
    allowed: true,
    heatId: 0,
    heatLabel: '',
  };
  if (!comp) return base;
  if (client.id === comp.adminId) {
    return Object.assign(base, {
      role: 'admin',
      name: comp.adminName || client.name,
      station: '',
      allowed: true,
    });
  }
  base.allowed = !!client.station
    && (!comp.stationIds || !comp.stationIds.length || comp.stationIds.indexOf(client.station) >= 0);
  let heat = compFindHeat(comp.activeHeatId);
  if (!heat && comp.phase === 'prep') heat = compFindHeat(comp.currentHeatId);
  if (!heat) heat = compFindHeat(comp.lastHeatId);
  if (heat) {
    const map = compHeatAssignments(heat);
    for (const [sid, st] of Object.entries(map)) {
      if (st === (client.station || '')) {
        base.sid = Number(sid);
        base.name = compStudentName(base.sid);
        break;
      }
    }
    base.heatId = heat.id;
    base.heatLabel = heat.label;
  }
  base.active = compClientActive(client, rooms.get(comp.roomId))
    && (comp.phase === 'countdown' || comp.phase === 'running');
  base.role = base.active ? 'racer' : 'idle';
  if (base.sid) {
    const row = compStandings().find((r) => Number(r.sid) === Number(base.sid));
    if (row) {
      base.place = row.place;
      base.status = row.status;
      base.note = row.note;
    }
  }
  return base;
}
function compSendState(client) {
  if (!client || !client.ws || client.ws.readyState !== 1) return;
  if (comp) {
    send(client.ws, { t: 'comp', comp: compPublic(), self: compSelfFor(client) });
  } else if (client.station || client.isAdmin) {
    send(client.ws, {
      t: 'comp',
      comp: null,
      self: {
        id: client.id,
        station: client.station || '',
        role: client.isAdmin ? 'admin' : 'student',
        sid: 0,
        name: client.station || client.name,
        active: false,
      },
    });
  }
}
function compBroadcast() {
  if (!comp) return;
  const room = rooms.get(comp.roomId);
  const targets = new Set();
  if (room) for (const c of room.members.values()) targets.add(c);
  for (const c of clients.values()) {
    if (c.station || (c.isAdmin && c.id === comp.adminId)) targets.add(c);
  }
  for (const c of targets) compSendState(c);
}
function compTryJoin(client, quiet) {
  if (!comp || !comp.roomId) return false;
  const room = rooms.get(comp.roomId);
  if (!room) return false;
  if (client.isAdmin && client.compAdmin && client.id !== comp.adminId) {
    /* Переподключение доски: новый администратор забирает управление
       (например, после обновления страницы). Старую вкладку отключаем. */
    const oldAdmin = comp.adminId
      ? [...clients.values()].find((c) => c.id === comp.adminId && c.ws && c.ws.readyState === 1)
      : null;
    if (oldAdmin && oldAdmin.id !== client.id) {
      room.members.delete(oldAdmin.id);
      oldAdmin.roomId = 0;
      oldAdmin.slot = -1;
      oldAdmin.compHeatId = 0;
      oldAdmin.compSid = 0;
      send(oldAdmin.ws, {
        t: 'error',
        code: 'comp_admin_replaced',
        message: 'Доска соревнования открыта в другой вкладке',
      });
    }
    comp.adminId = client.id;
    if (!comp.adminName) comp.adminName = client.name;
    room.hostId = client.id;
    if (client.roomId !== room.id) joinRoom(client, room);
    welcome(client.ws, client, room);
    pushRoom(room);
    compSendState(client);
    if (!quiet) compBroadcast();
    compSaveState();
    return true;
  }
  if (client.isAdmin && !client.compAdmin && client.id !== comp.adminId) return false;
  if (client.id === comp.adminId) {
    if (!quiet) compSendState(client);
    return true;
  }
  if (client.station && comp.stationIds && comp.stationIds.length
    && comp.stationIds.indexOf(client.station) < 0) {
    send(client.ws, {
      t: 'error',
      code: 'comp_station_inactive',
      message: 'Этот компьютер не задействован в соревновании',
    });
    return false;
  }
  if (client.roomId === room.id) {
    if (!quiet) compSendState(client);
    return true;
  }
  if (room.members.size >= room.max) {
    send(client.ws, { t: 'error', code: 'comp_full', message: 'Нет свободного места в соревновании' });
    return false;
  }
  if (!joinRoom(client, room)) {
    send(client.ws, { t: 'error', code: 'comp_full', message: 'Не удалось войти в соревнование' });
    return false;
  }
  welcome(client.ws, client, room);
  pushRoom(room);
  compSendState(client);
  if (!quiet) compBroadcast();
  return true;
}
function compEnterPrep(heatId) {
  if (!comp) return;
  if (comp.phaseTimer) { clearTimeout(comp.phaseTimer); comp.phaseTimer = null; }
  if (comp.heatTimer) { clearTimeout(comp.heatTimer); comp.heatTimer = null; }
  comp.phase = 'prep';
  comp.currentHeatId = Number(heatId) || 0;
  comp.nextHeatId = comp.currentHeatId;
  comp.activeHeatId = 0;
  comp.startAt = 0;
  comp.startsIn = 0;
  compClearClientAssignments();
  compSaveState();
  compBroadcast();
}
function compClose(reason, exceptId) {
  if (!comp) return;
  const old = comp;
  if (old.phaseTimer) { clearTimeout(old.phaseTimer); old.phaseTimer = null; }
  if (old.heatTimer) { clearTimeout(old.heatTimer); old.heatTimer = null; }
  results.archiveAllDone(old);
  results.archiveInterrupted(old, 'closed');
  const room = rooms.get(old.roomId);
  if (room) {
    for (const c of room.members.values()) {
      c.roomId = 0;
      c.slot = -1;
      c.compHeatId = 0;
      c.compSid = 0;
      if (exceptId == null || c.id !== exceptId) {
        send(c.ws, {
          t: 'error',
          code: 'comp_closed',
          message: reason || 'Соревнование закрыто администратором',
        });
      }
    }
    rooms.delete(room.id);
  }
  comp = null;
  for (const c of clients.values()) {
    if (c.station || c.isAdmin) compSendState(c);
  }
  broadcastLobby();
  compClearState();
}
function compCreate(adminClient, msg) {
  if (!adminClient || !adminClient.isAdmin) {
    send(adminClient.ws, { t: 'error', message: 'Создать соревнование может только администратор' });
    return;
  }
  if (comp && comp.phase !== 'finished') {
    compSendState(adminClient);
    send(adminClient.ws, {
      t: 'error',
      code: 'comp_exists',
      message: 'Соревнование уже создано. Закройте его, чтобы начать новое.',
    });
    return;
  }

  const raw = Array.isArray(msg.students) ? msg.students : [];
  const seen = new Set();
  const students = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const id = Number(item.id);
    if (!Number.isFinite(id) || id === 0 || seen.has(id)) continue;
    const name = sanitizeName(item.name, COMP_NAME_MAX);
    if (!name) continue;
    seen.add(id);
    const className = sanitizeName(item.className || item.class_name || '', 60);
    students.push({ id, name, className });
    if (students.length >= COMP_STUDENTS_MAX) break;
  }
  if (!students.length) {
    send(adminClient.ws, { t: 'error', message: 'В соревновании нет ни одного участника' });
    return;
  }
  const stationIds = [];
  const hasStationSelection = Array.isArray(msg.stations);
  const rawStations = hasStationSelection ? msg.stations : STATIONS;
  for (const rawStation of rawStations) {
    const id = sanitizeStation(rawStation);
    if (id && stationIds.indexOf(id) < 0) stationIds.push(id);
  }
  stationIds.sort((a, b) => stationSortKey(a) - stationSortKey(b));
  if (!stationIds.length) {
    send(adminClient.ws, {
      t: 'error',
      code: 'comp_bad_stations',
      message: 'Выберите хотя бы один компьютер для соревнования',
    });
    return;
  }
  if (stationIds.length > COMP_MAX) {
    send(adminClient.ws, {
      t: 'error',
      code: 'comp_bad_stations',
      message: 'Можно выбрать не более ' + COMP_MAX + ' компьютеров',
    });
    return;
  }
  if (students.length > 1 && stationIds.length < 2) {
    send(adminClient.ws, {
      t: 'error',
      code: 'comp_bad_stations',
      message: 'Для нескольких участников нужно минимум два компьютера',
    });
    return;
  }
  const heatSize = Math.max(1, Math.min(COMP_MAX, stationIds.length, students.length));
  const format = sanitizeCompFormat(msg.format);
  const roundCount = format === 'points'
    ? sanitizeCompRounds(msg.rounds != null ? msg.rounds : msg.roundCount)
    : 0;
  if (format === 'olympic' && students.length < 2) {
    send(adminClient.ws, {
      t: 'error',
      code: 'comp_bad_format',
      message: 'Для олимпийской сетки нужно минимум два участника',
    });
    return;
  }
  const track = sanitizeRace(msg.track) || 'utt1';
  const className = sanitizeName(msg.className, 60) || 'Класс';
  const title = sanitizeName(msg.title, 60) || ('Соревнование · ' + className);
  const classId = sanitizeName(msg.classId, 40);

  if (comp) compClose('Соревнование заменено новым', adminClient.id);
  comp = {
    id: Date.now(),
    title,
    classId,
    className,
    track,
    mode: sanitizeMode(msg.mode),
    format,
    roundCount,
    rated: !!msg.rated,
    adminId: adminClient.id,
    adminName: sanitizeName(msg.adminName, COMP_NAME_MAX) || adminClient.name,
    createdAt: Date.now(),
    stationIds,
    heatSize,
    students,
    rounds: [],
    seatMap: {},
    currentHeatId: 0,
    nextHeatId: 0,
    activeHeatId: 0,
    lastHeatId: 0,
    phase: 'prep',
    startAt: 0,
    startsIn: 0,
    roomId: 0,
    phaseTimer: null,
    heatTimer: null,
  };
  const bracket = compBuildBracket(students);
  comp.rounds = bracket.rounds;
  compResolveAdvances();
  if (!compAllHeats().some((h) => h.status === 'pending')
    && !compAllHeats().some((h) => h.status === 'running')) {
    comp.phase = 'finished';
  }

  const room = newRoom(adminClient, title, DIRECTOR_MAX, false, true);
  room.params = { mode: 'angle', director: true, competition: true, racersMax: COMP_MAX, race: track };
  room.title = title;
  room.started = false;
  room.max = DIRECTOR_MAX;
  comp.roomId = room.id;
  joinRoom(adminClient, room);

  const first = compNextPendingHeat();
  comp.currentHeatId = first ? first.id : 0;
  comp.nextHeatId = comp.currentHeatId;

  compSaveState();
  welcome(adminClient.ws, adminClient, room);
  pushRoom(room);
  for (const c of [...clients.values()]) {
    if (c !== adminClient && c.station) compTryJoin(c, true);
  }
  compBroadcast();
  broadcastLobby();
}
function compStartHeat(adminClient) {
  if (!comp) return;
  if (!adminClient.isAdmin || adminClient.id !== comp.adminId) {
    send(adminClient.ws, { t: 'error', message: 'Старт заезда доступен только администратору' });
    return;
  }
  if (comp.phase !== 'prep') {
    send(adminClient.ws, { t: 'error', message: 'Сейчас нельзя начать заезд' });
    return;
  }
  const heat = compFindHeat(comp.currentHeatId);
  if (!heat || heat.status !== 'pending') {
    send(adminClient.ws, { t: 'error', message: 'Нет подготовленного заезда' });
    return;
  }
  compResolveAdvances();
  if (!heat.participants.length) {
    send(adminClient.ws, { t: 'error', message: 'В заезде нет участников' });
    return;
  }
  const preview = compPreviewAssignments(heat);
  if (!preview.ready) {
    const names = preview.missing.map(compStudentName).join(', ');
    send(adminClient.ws, {
      t: 'error',
      code: 'comp_no_stations',
      message: 'Не распределены по компьютерам: ' + names,
    });
    compBroadcast();
    return;
  }

  const room = rooms.get(comp.roomId);
  if (!room) return;
  compClearClientAssignments();
  const assignments = {};
  const byStation = new Map(preview.connected.map((s) => [s.id, s]));
  heat.participants.forEach((sid) => {
    const station = preview.map[sid];
    if (!station) return;
    assignments[sid] = station;
    const slot = byStation.get(station);
    const client = slot && slot.client;
    if (client) {
      client.compSid = sid;
      client.compHeatId = heat.id;
    }
  });
  heat.assignments = assignments;
  compRememberSeats(assignments);
  heat.live = {};
  heat.results = [];
  heat.status = 'running';
  heat.startToken = heat.id + ':' + Date.now();
  heat.finishReason = '';
  heat.finishScheduled = false;

  comp.phase = 'countdown';
  comp.activeHeatId = heat.id;
  comp.currentHeatId = heat.id;
  comp.nextHeatId = 0;
  comp.lastHeatId = 0;
  const prestartMs = COMP_CAMERA_PICK_MS + COMP_COUNTDOWN_MS;
  comp.startAt = Date.now() + prestartMs;
  comp.startsIn = prestartMs;
  room.params.race = comp.track;
  room.params.mode = comp.mode;
  room.started = true;

  if (comp.phaseTimer) clearTimeout(comp.phaseTimer);
  comp.phaseTimer = setTimeout(() => {
    if (!comp || comp.activeHeatId !== heat.id || comp.phase !== 'countdown') return;
    comp.phase = 'running';
    comp.startAt = 0;
    comp.startsIn = 0;
    compSaveState();
    compBroadcast();
  }, prestartMs);

  if (comp.heatTimer) clearTimeout(comp.heatTimer);
  const timeout = (COMP_TIMEOUT[comp.track] || 150000) + prestartMs;
  comp.heatTimer = setTimeout(() => {
    if (!comp || comp.activeHeatId !== heat.id) return;
    const h = compFindHeat(heat.id);
    if (h && h.status === 'running') compFinalizeHeat(h, 'timeout');
  }, timeout);

  compSaveState();
  compBroadcast();
  pushRoom(room);
}
function compFinalizeHeat(heat, reason) {
  if (!comp || !heat || heat.status !== 'running') return;
  if (comp.phaseTimer) { clearTimeout(comp.phaseTimer); comp.phaseTimer = null; }
  if (comp.heatTimer) { clearTimeout(comp.heatTimer); comp.heatTimer = null; }

  const rows = heat.participants.map((sid) => {
    const live = (heat.live && heat.live[sid]) || {};
    const done = !!live.done;
    const failed = !!live.failed;
    return {
      sid,
      done,
      failed,
      fin: done ? (Number(live.fin) || Number(live.time) || 0) : null,
      time: Number(live.time) || 0,
      prog: Math.max(0, Math.min(1000, Number(live.prog) || 0)),
    };
  });
  rows.sort((a, b) => {
    if (a.done !== b.done) return a.done ? -1 : 1;
    if (a.done) return (a.fin || 0) - (b.fin || 0);
    if (a.failed !== b.failed) return a.failed ? 1 : -1;
    return (b.prog - a.prog) || (a.time - b.time);
  });
  rows.forEach((r, i) => { r.place = i + 1; });
  heat.results = rows;
  heat.status = 'done';
  heat.finishedAt = Date.now();
  heat.finishReason = reason || '';

  const format = comp.format || 'heats';
  if (format === 'olympic') {
    /* В олимпийской сетке дальше идёт только победитель заезда. */
    const winner = rows.find((r) => !r.failed && r.place === 1);
    heat.qualifiers = winner ? [winner.sid] : [];
  } else if (format === 'points') {
    /* Накопление очков: выбывших нет, каждый летает все раунды. */
    heat.qualifiers = rows.filter((r) => !r.failed).map((r) => r.sid);
  } else {
    const round = comp.rounds.find((r) => r.heats.includes(heat));
    const nextRound = round ? comp.rounds[round.index] : null;
    if (nextRound) {
      const cap = Math.max(1, Math.min(COMP_MAX, Number(comp.heatSize) || COMP_MAX));
      const q = Math.max(1, Math.floor(cap / round.heats.length));
      heat.qualifiers = rows.filter((r) => !r.failed && r.place <= q).map((r) => r.sid);
    } else {
      heat.qualifiers = rows.map((r) => r.sid);
    }
  }

  comp.activeHeatId = 0;
  comp.lastHeatId = heat.id;
  comp.currentHeatId = heat.id;
  comp.startAt = 0;
  comp.startsIn = 0;
  compClearClientAssignments();
  compResolveAdvances();
  compSkipEmptyLaterHeats();
  const next = compNextPendingHeat();
  comp.nextHeatId = next ? next.id : 0;
  comp.phase = (compAllHeatsDone() && !next) ? 'finished' : 'heat_done';
  if (comp.phase === 'finished') comp.currentHeatId = 0;

  results.archiveCompHeat(comp, heat, reason || heat.finishReason || 'admin');
  compSaveState();
  compBroadcast();
  const room = rooms.get(comp.roomId);
  if (room) pushRoom(room);
}
function compNext(adminClient) {
  if (!comp) return;
  if (!adminClient.isAdmin || adminClient.id !== comp.adminId) return;
  if (comp.phase !== 'heat_done') return;
  if (comp.nextHeatId) {
    compEnterPrep(comp.nextHeatId);
  } else if (compAllHeatsDone()) {
    comp.phase = 'finished';
    comp.currentHeatId = 0;
    comp.nextHeatId = 0;
    compSaveState();
    compBroadcast();
  }
}
/* Сменить тип турнира (рейтинговый/тренировка) можно только до первого старта. */
function compSetRated(adminClient, rated) {
  if (!comp) return;
  if (!adminClient.isAdmin || adminClient.id !== comp.adminId) return;
  const started = compAllHeats().some((h) => h.status !== 'pending' || h.results.length > 0);
  if (started) {
    send(adminClient.ws, {
      t: 'error',
      message: 'Тип турнира нельзя менять после первого заезда',
    });
    return;
  }
  comp.rated = !!rated;
  compSaveState();
  compBroadcast();
}
function compSetTrack(adminClient, track) {
  if (!comp) return;
  if (!adminClient.isAdmin || adminClient.id !== comp.adminId) return;
  const started = compAllHeats().some((h) => h.status !== 'pending' || h.results.length > 0);
  if (started) {
    send(adminClient.ws, { t: 'error', message: 'Трассу нельзя менять после первого заезда' });
    return;
  }
  const r = sanitizeRace(track);
  if (!r) return;
  comp.track = r;
  compSaveState();
  const room = rooms.get(comp.roomId);
  if (room) {
    room.params.race = r;
    pushRoom(room);
  }
  compBroadcast();
}
/* Сменить набор компьютеров между заездами (prep / heat_done). */
function compSetStations(adminClient, rawStations) {
  if (!comp) return;
  if (!adminClient.isAdmin || adminClient.id !== comp.adminId) return;
  if (comp.phase !== 'prep' && comp.phase !== 'heat_done') {
    send(adminClient.ws, {
      t: 'error',
      message: 'Менять компьютеры можно только между заездами',
    });
    return;
  }
  const ids = [];
  for (const raw of (Array.isArray(rawStations) ? rawStations : [])) {
    const id = sanitizeStation(raw);
    if (id && ids.indexOf(id) < 0) ids.push(id);
  }
  ids.sort((a, b) => stationSortKey(a) - stationSortKey(b));
  if (!ids.length) {
    send(adminClient.ws, { t: 'error', message: 'Выберите хотя бы один компьютер' });
    return;
  }
  if (ids.length > COMP_MAX) {
    send(adminClient.ws, { t: 'error', message: 'Можно выбрать не более ' + COMP_MAX + ' компьютеров' });
    return;
  }
  const pending = compAllHeats().filter((h) => h.status === 'pending' && h.participants.length);
  const need = pending.reduce((max, h) => Math.max(max, h.participants.length), 0);
  if (ids.length < need) {
    send(adminClient.ws, {
      t: 'error',
      message: 'Для заезда нужно минимум ' + need + ' компьютеров',
    });
    return;
  }

  const room = rooms.get(comp.roomId);
  if (room) {
    for (const c of [...room.members.values()]) {
      if (c.id === room.hostId) continue;
      if (c.station && ids.indexOf(c.station) < 0) {
        room.members.delete(c.id);
        c.roomId = 0;
        c.slot = -1;
        c.compHeatId = 0;
        c.compSid = 0;
        send(c.ws, {
          t: 'error',
          code: 'comp_station_inactive',
          message: 'Компьютер больше не задействован в соревновании',
        });
      }
    }
  }
  comp.stationIds = ids;
  /* Места учеников за снятыми компьютерами больше не актуальны. */
  const seatMap = {};
  for (const [sid, station] of Object.entries(comp.seatMap || {})) {
    if (ids.indexOf(station) >= 0) seatMap[sid] = station;
  }
  comp.seatMap = seatMap;
  compSaveState();
  for (const c of clients.values()) {
    if (c.station && ids.indexOf(c.station) >= 0) compTryJoin(c, true);
  }
  if (room) pushRoom(room);
  compBroadcast();
}
/* Ручная расстановка участников заезда по компьютерам (только админ).
   Если выбранный ПК занят другим участником этого заезда — они меняются
   местами; пустое значение освобождает компьютер. */
function compAssignStation(adminClient, msg) {
  if (!comp) return;
  if (!adminClient || !adminClient.isAdmin || adminClient.id !== comp.adminId) return;
  if (comp.phase !== 'prep' && comp.phase !== 'heat_done') {
    send(adminClient.ws, {
      t: 'error',
      message: 'Распределять участников можно только перед заездом',
    });
    return;
  }
  const heatId = Number(msg.heatId)
    || (comp.phase === 'heat_done' ? comp.nextHeatId : comp.currentHeatId);
  const heat = compFindHeat(heatId);
  if (!heat || heat.status !== 'pending') {
    send(adminClient.ws, { t: 'error', message: 'Этот заезд уже нельзя изменить' });
    return;
  }
  const targetHeatId = comp.phase === 'heat_done' ? comp.nextHeatId : comp.currentHeatId;
  if (heat.id !== targetHeatId) {
    send(adminClient.ws, {
      t: 'error',
      message: 'Сейчас можно распределять только участников текущего заезда',
    });
    return;
  }
  const station = sanitizeStation(msg.station);
  const allowed = Array.isArray(comp.stationIds) && comp.stationIds.length ? comp.stationIds : STATIONS;
  if (!station || allowed.indexOf(station) < 0) {
    send(adminClient.ws, { t: 'error', message: 'Этот компьютер не выбран для соревнования' });
    return;
  }
  const connectedIds = new Set(
    compConnectedStations().filter((s) => s.connected).map((s) => s.id),
  );
  if (!connectedIds.has(station)) {
    send(adminClient.ws, { t: 'error', message: 'Компьютер ' + station + ' не подключён' });
    return;
  }
  const sid = Number(msg.sid) || 0;
  if (sid && !heat.participants.includes(sid)) {
    send(adminClient.ws, { t: 'error', message: 'Участник не входит в этот заезд' });
    return;
  }

  const map = Object.assign({}, compPreviewAssignments(heat).map);
  let prevStation = '';
  for (const [rawSid, st] of Object.entries(map)) {
    if (Number(rawSid) === sid) prevStation = st;
  }
  let occupant = 0;
  for (const [rawSid, st] of Object.entries(map)) {
    if (st === station) occupant = Number(rawSid);
  }
  if (!sid) {
    if (occupant) delete map[occupant];
  } else {
    map[sid] = station;
    if (occupant && occupant !== sid) {
      if (prevStation) map[occupant] = prevStation;
      else delete map[occupant];
    }
  }

  heat.assignments = {};
  for (const [rawSid, st] of Object.entries(map)) {
    const n = Number(rawSid);
    if (heat.participants.includes(n) && sanitizeStation(st)) heat.assignments[n] = st;
  }
  compSaveState();
  const room = rooms.get(comp.roomId);
  if (room) pushRoom(room);
  compBroadcast();
}
function compHandleRace(client, msg) {
  if (!comp || comp.phase !== 'running') return;
  const heat = compFindHeat(comp.activeHeatId);
  if (!heat || heat.status !== 'running') return;
  if (client.compHeatId !== heat.id || !client.compSid) return;
  const sid = Number(client.compSid);
  if (!heat.participants.includes(sid)) return;
  const time = Math.max(0, Math.min(3600, Number(msg.time) || 0));
  const rec = {
    done: !!msg.done,
    failed: !!msg.failed,
    fin: msg.done ? (Number(msg.fin) || time) : null,
    time,
    prog: Math.max(0, Math.min(1000, Number(msg.prog) || 0)),
  };
  heat.live[sid] = rec;
  const out = {
    t: 'race',
    id: client.id,
    name: compStudentName(sid),
    prog: rec.prog,
    time: rec.time,
    done: rec.done,
    failed: rec.failed,
    fin: rec.fin,
  };
  const room = rooms.get(comp.roomId);
  if (room) {
    for (const c of room.members.values()) {
      if (c.ws === client.ws) continue;
      if (c.id === room.hostId || compClientActive(c, room)) send(c.ws, out);
    }
  }
  const allDone = heat.participants.every((s) => {
    const l = heat.live[s];
    return !!(l && (l.done || l.failed));
  });
  if (allDone && !heat.finishScheduled) {
    heat.finishScheduled = true;
    setTimeout(() => {
      if (!comp || comp.activeHeatId !== heat.id) return;
      const h = compFindHeat(heat.id);
      if (h && h.status === 'running') compFinalizeHeat(h, 'all-done');
    }, 150);
  }
}


function lobbyList() {
  const out = [];
  for (const room of rooms.values()) {
    /* Комнаты соревнования не показываем в общем лобби: ученики входят по метке ПК. */
    if (room.params && room.params.competition) continue;
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
    pair: !!room.pair,
    director: !!room.director,
    competition: !!(room.params && room.params.competition),
    host_user_id: room.hostId,
    host_name: host ? host.name : '',
    started: room.started,
    max: room.max,
  };
}
function participants(room) {
  const isComp = !!(room.params && room.params.competition);
  return [...room.members.values()]
    .sort((a, b) => a.joined - b.joined || a.id - b.id)
    .map((c) => {
      let role;
      if (isComp) {
        if (c.id === room.hostId) role = 'spectator';
        else if (compClientActive(c, room)) role = 'racer';
        else role = 'idle';
      } else {
        role = (room.pair || room.director) && c.id === room.hostId ? 'spectator' : 'racer';
      }
      return {
        user_id: c.id,
        name: isComp ? compParticipantName(room, c) : c.name,
        station: c.station || '',
        slot: c.slot,
        role,
      };
    });
}
function lobbyMessage(client) {
  const isAdmin = !!(client && client.isAdmin);
  return {
    t: 'lobby',
    rooms: lobbyList(),
    maps: MAPS,
    races: RACES,
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
function newRoom(client, title, max, pair, director) {
  pair = !!pair && !!client.isAdmin;          // комнаты с наблюдателем создаёт только админ
  director = !!director && !pair && !!client.isAdmin;
  const spectate = pair || director;
  const room = {
    id: ++roomSeq,
    title: title || (pair ? 'Парная гонка' : (director ? 'Гонка с наблюдателем' : ('Игра: ' + client.name))),
    map: 'meadow',
    params: pair
      ? { mode: 'angle', pair: true, race: 'utt1' }
      : (director
        ? { mode: 'angle', director: true, racersMax: DIRECTOR_RACERS, race: 'utt1' }
        : { mode: 'angle' }),
    pair: pair,
    director: director,
    started: false,
    max: spectate ? (pair ? PAIR_MAX : DIRECTOR_MAX) : sanitizeMax(max, client.isAdmin),
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
  const wasHost = room.hostId === client.id;
  const isComp = !!(room.params && room.params.competition);
  room.members.delete(client.id);

  /* Соревнование: уход администратора не уничтожает турнир (доска может
     вернуться); уход гонщика в активном заезде фиксируется как сход. */
  if (isComp) {
    if (wasHost) {
      /* Доска закрыта/обновлена: турнир не уничтожаем, чтобы администратор
         мог вернуться по той же ссылке. Станции ждут; новый админ забирает
         управление при подключении. */
      comp.adminId = 0;
      room.hostId = 0;
      pushRoom(room);
      compBroadcast();
      broadcastLobby();
      return;
    }
    if (comp && comp.roomId === room.id && comp.activeHeatId
      && client.compHeatId === comp.activeHeatId && client.compSid) {
      const heat = compFindHeat(comp.activeHeatId);
      if (heat && heat.status === 'running') {
        const sid = Number(client.compSid);
        heat.live[sid] = { done: false, failed: true, fin: null, time: 0, prog: 0 };
        const allDone = heat.participants.every((s) => {
          const l = heat.live[s];
          return !!(l && (l.done || l.failed));
        });
        if (allDone && !heat.finishScheduled) {
          heat.finishScheduled = true;
          setTimeout(() => {
            if (!comp || comp.activeHeatId !== heat.id) return;
            const h = compFindHeat(heat.id);
            if (h && h.status === 'running') compFinalizeHeat(h, 'disconnect');
          }, 300);
        }
      }
    }
    client.compHeatId = 0;
    client.compSid = 0;
    pushRoom(room);
    compBroadcast();
    return;
  }

  /* В комнате с наблюдателем админ обязателен: без него комната закрывается. */
  if ((room.pair || room.director) && wasHost) {
    rooms.delete(room.id);
    for (const c of room.members.values()) {
      c.roomId = 0;
      c.slot = -1;
      send(c.ws, { t: 'error', code: 'room_closed', message: 'Гонка закрыта администратором' });
    }
    broadcastLobby();
    return;
  }
  if (room.members.size === 0) {
    rooms.delete(room.id);
  } else {
    if (wasHost) {
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
  if ('race' in ctrl) {
    const r = sanitizeRace(ctrl.race);
    if (r) { room.params = room.params || {}; room.params.race = r; }
  }
  if ('started' in ctrl) room.started = !!ctrl.started;
  if ('title' in ctrl) { const t = sanitizeName(ctrl.title, 60); if (t) room.title = t; }
  if ('max' in ctrl && !room.pair && !room.director) {
    const m = sanitizeMax(ctrl.max, client.isAdmin);
    if (m >= room.members.size) room.max = m;
  }
}
function welcome(ws, client, room) {
  const isAdmin = !!client.isAdmin;
  const isComp = !!(room.params && room.params.competition);
  let role;
  if (isComp) {
    if (room.hostId === client.id) role = 'spectator';
    else role = compClientActive(client, room) ? 'racer' : 'idle';
  } else {
    role = (room.pair || room.director) && room.hostId === client.id ? 'spectator' : 'racer';
  }
  send(ws, {
    t: 'welcome',
    self: {
      id: client.id,
      name: isComp ? compParticipantName(room, client) : client.name,
      station: client.station || '',
      slot: client.slot,
      isAdmin,
      role,
    },
    room: roomInfo(room),
    participants: participants(room),
    maps: MAPS,
    races: RACES,
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
    compAdmin: false,
    station: '',
    ws,
    roomId: 0,
    slot: -1,
    compHeatId: 0,
    compSid: 0,
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
      case 'hello': {
        client.name = sanitizeName(msg.name) || client.name;
        client.isAdmin = ADMIN_KEY !== '' && String(msg.admin || '') === ADMIN_KEY;
        client.compAdmin = !!msg.compadmin && client.isAdmin;
        const station = sanitizeStation(msg.station);
        if (station && station !== client.station) {
          for (const other of clients.values()) {
            if (other === client || other.station !== station) continue;
            other.station = '';
            if (other.roomId) leaveRoom(other);
            send(other.ws, {
              t: 'error',
              code: 'station_taken',
              message: 'Этот компьютер уже подключён в другой вкладке',
            });
          }
          client.station = station;
        }
        send(ws, { t: 'hello', self: { id: client.id, name: client.name, isAdmin: client.isAdmin, station: client.station } });
        if (client.station || client.compAdmin) {
          if (!(comp && compTryJoin(client))) compSendState(client);
        }
        broadcastLobby();
        break;
      }

      case 'lobby':
        send(ws, lobbyMessage(client));
        break;

      case 'create': {
        const pair = msg.pair === true || msg.pair === 1 || msg.pair === '1';
        const director = msg.director === true || msg.director === 1 || msg.director === '1';
        if (pair && director) {
          send(ws, { t: 'error', message: 'Выберите один режим: пара или гонка с наблюдателем' });
          break;
        }
        if ((pair || director) && !client.isAdmin) {
          send(ws, { t: 'error', message: 'Режим наблюдателя доступен только администратору' });
          break;
        }
        const room = newRoom(client, sanitizeName(msg.title, 60), msg.max, pair, director);
        joinRoom(client, room);
        welcome(ws, client, room);
        pushRoom(room);
        break;
      }

      case 'quick': {
        let room = [...rooms.values()].find((r) => !r.pair && !r.director && r.members.size < r.max);
        if (!room) room = newRoom(client, '', 4, false, false);
        joinRoom(client, room);
        welcome(ws, client, room);
        pushRoom(room);
        break;
      }

      case 'join': {
        const room = rooms.get(Number(msg.roomId));
        if (!room) { send(ws, { t: 'error', message: 'Комната не найдена' }); break; }
        const roomComp = !!(room.params && room.params.competition);
        if (roomComp && !client.isAdmin && !client.station) {
          send(ws, { t: 'error', message: 'В соревнование входят с компьютеров класса' });
          break;
        }
        if (!roomComp && (room.pair || room.director) && room.started) {
          send(ws, { t: 'error', message: 'Гонка уже идёт' });
          break;
        }
        if (room.members.size >= room.max) { send(ws, { t: 'error', message: 'Комната заполнена' }); break; }
        joinRoom(client, room);
        welcome(ws, client, room);
        pushRoom(room);
        if (roomComp) { compSendState(client); compBroadcast(); }
        break;
      }

      case 'control': {
        const room = rooms.get(client.roomId);
        if (room) { applyControl(room, client, msg); pushRoom(room); }
        break;
      }

      /* ── соревнование ── */
      case 'comp_sync':
        compSendState(client);
        break;

      case 'comp_create':
        compCreate(client, msg);
        break;

      case 'comp_start':
        compStartHeat(client);
        break;

      case 'comp_finish': {
        if (!comp || !client.isAdmin || client.id !== comp.adminId) break;
        const heat = compFindHeat(comp.activeHeatId);
        if (heat && (comp.phase === 'running' || comp.phase === 'countdown')) {
          compFinalizeHeat(heat, 'admin');
        }
        break;
      }

      case 'comp_next':
        compNext(client);
        break;

      case 'comp_set_track':
        compSetTrack(client, msg.track);
        break;

      case 'comp_set_rated':
        compSetRated(client, msg.rated);
        break;

      case 'comp_set_stations':
        compSetStations(client, msg.stations);
        break;

      case 'comp_assign':
        compAssignStation(client, msg);
        break;

      case 'comp_close':
        if (client.isAdmin && comp && client.id === comp.adminId) compClose('Соревнование закрыто администратором');
        break;

      case 'st': {
        const room = rooms.get(client.roomId);
        if (!room || !validVec(msg.p, 3) || !validVec(msg.q, 4)) break;
        if (room.params && room.params.competition) {
          if (!comp || comp.phase !== 'running' || !compClientActive(client, room)) break;
          const out = { t: 'st', id: client.id, p: msg.p, q: msg.q };
          for (const c of room.members.values()) {
            if (c.ws === ws) continue;
            if (c.id === room.hostId || compClientActive(c, room)) send(c.ws, out);
          }
          break;
        }
        const out = { t: 'st', id: client.id, p: msg.p, q: msg.q };
        for (const c of room.members.values()) if (c.ws !== ws) send(c.ws, out);
        break;
      }

      case 'race_result': {
        const room = rooms.get(client.roomId);
        if (!room || room.hostId !== client.id) break;
        if (room.params && room.params.competition) break;
        const rows = (Array.isArray(msg.rows) ? msg.rows : []).slice(0, 8).map((r) => {
          const uid = Number(r && r.user_id) || 0;
          const member = room.members.get(uid);
          return {
            user_id: uid,
            name: member ? member.name : String((r && r.name) || '').slice(0, 60),
            place: Number(r && r.place) || 0,
            fin: r && r.fin != null ? Number(r.fin) : null,
            time: Number(r && r.time) || 0,
            prog: Number(r && r.prog) || 0,
            done: !!(r && r.done),
            failed: !!(r && r.failed),
          };
        });
        const track = sanitizeRace(msg.track) || sanitizeRace(room.params && room.params.race);
        results.archiveNetEvent({
          roomId: room.id,
          title: room.title,
          track,
          mode: (room.params && room.params.mode) || 'angle',
          raceKey: msg.race_key,
          rows,
        });
        break;
      }

      case 'race': {
        const room = rooms.get(client.roomId);
        if (!room) break;
        if (room.params && room.params.competition) {
          compHandleRace(client, msg);
          break;
        }
        const out = Object.assign({}, msg, { id: client.id });
        for (const c of room.members.values()) if (c.ws !== ws) send(c.ws, out);
        break;
      }

      /* сетевой старт/прогресс/результаты: пересылаем как есть остальным в комнате */
      case 'ready':
      case 'go':
      case 'reset': {
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

/* Архив результатов и рейтинг (локально + синхронизация на сайт). */
results.initResults({
  dataDir: COMP_STATE_DIR,
  syncUrl: process.env.FLY_SYNC_URL || 'https://fly.nayanovaacademy.ru',
  syncToken: process.env.FLY_SYNC_TOKEN || '',
});

/* Восстановить турнир, сохранённый предыдущим запуском релея. */
compRestoreState();

server.listen(PORT, () => {
  console.log(`fly LAN relay: http://0.0.0.0:${PORT}  (WebSocket ws://<host>:${PORT}/ws)`);
  console.log(`static: ${PUBDIR}`);
  console.log(`competition state: ${COMP_STATE_FILE}`);
});
