'use strict';

/**
 * Архив результатов заездов и рейтинг Elo для LAN-релея.
 *
 * Файлы (в relay/data, вне git):
 *   results.json      — все завершённые заезды соревнований;
 *   sync-state.json   — какие записи уже отправлены на сайт;
 *   ratings.json      — снимок локального рейтинга (для диагностики).
 *
 * На сайт записи отправляются пачками на POST /api/results/ingest.php,
 * если задан FLY_SYNC_TOKEN (или файл data/sync-token). Без токена архив
 * и рейтинг работают локально.
 */

const fs = require('fs');
const path = require('path');

const RATING_START = 1200;
const RATING_K = 24;
const RATING_PROV_K = 32;
const RATING_PROV_RACES = 5;
const RATING_MIN_PLAYERS = 2;
const POINTS = [25, 22, 20, 18, 16, 15];
const SYNC_INTERVAL_MS = 30000;
const SYNC_BATCH = 25;

const state = {
  dataDir: '',
  syncUrl: '',
  syncToken: '',
  archive: { version: 1, updatedAt: 0, events: [] },
  eventKeys: new Set(),
  pending: new Set(),
  ratings: new Map(),
  syncBusy: false,
  syncTimer: null,
  lastSyncAt: 0,
  lastSyncOk: false,
  lastSyncError: '',
};

function filePath(name) {
  return path.join(state.dataDir, name);
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const text = fs.readFileSync(file, 'utf8');
    if (!text.trim()) return fallback;
    return JSON.parse(text);
  } catch (err) {
    console.warn('[results] read failed:', file, err && err.message ? err.message : err);
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    try {
      fs.renameSync(tmp, file);
    } catch (_) {
      try { fs.rmSync(file, { force: true }); } catch (__) {}
      fs.renameSync(tmp, file);
    }
    return true;
  } catch (err) {
    console.warn('[results] write failed:', file, err && err.message ? err.message : err);
    return false;
  }
}

function validEvent(e) {
  return !!(e && typeof e === 'object'
    && typeof e.key === 'string' && e.key.length > 0 && e.key.length <= 160
    && Array.isArray(e.rows));
}

function normalizeEvent(e) {
  return {
    key: String(e.key).slice(0, 160),
    source: String(e.source || 'comp').slice(0, 20),
    compId: String(e.compId || '').slice(0, 80),
    roomId: Number(e.roomId) || 0,
    title: String(e.title || '').slice(0, 80),
    classId: String(e.classId || '').slice(0, 40),
    className: String(e.className || '').slice(0, 60),
    track: String(e.track || '').slice(0, 20),
    mode: e.mode === 'acro' ? 'acro' : 'angle',
    format: ['heats', 'olympic', 'points'].includes(e.format) ? e.format : 'heats',
    rated: !!e.rated,
    heatId: Number(e.heatId) || 0,
    round: Number(e.round) || 0,
    label: String(e.label || '').slice(0, 40),
    finishedAt: Number(e.finishedAt) || Date.now(),
    reason: String(e.reason || '').slice(0, 40),
    rows: e.rows.slice(0, 64).map((r) => ({
      user_id: Number(r && (r.user_id != null ? r.user_id : r.sid)) || 0,
      name: String((r && r.name) || '').slice(0, 60),
      class_name: String((r && (r.class_name != null ? r.class_name : r.className)) || '').slice(0, 60),
      place: Number(r && r.place) || 0,
      fin: r && r.fin != null && Number.isFinite(Number(r.fin)) ? Number(r.fin) : null,
      time: Number(r && r.time) || 0,
      prog: Math.max(0, Math.min(1000, Number(r && r.prog) || 0)),
      done: !!(r && r.done),
      failed: !!(r && r.failed),
      points: Number(r && r.points) || 0,
    })),
  };
}

function saveArchive() {
  state.archive.updatedAt = Date.now();
  return writeJsonAtomic(filePath('results.json'), state.archive);
}

function saveSyncState() {
  writeJsonAtomic(filePath('sync-state.json'), {
    version: 1,
    pending: [...state.pending],
    lastSyncAt: state.lastSyncAt,
    lastSyncOk: state.lastSyncOk,
    lastSyncError: state.lastSyncError,
  });
}

function saveRatingsSnapshot() {
  writeJsonAtomic(filePath('ratings.json'), {
    version: 1,
    updatedAt: Date.now(),
    provisionalRaces: RATING_PROV_RACES,
    ratings: leaderboard(200),
  });
}

function rowScore(a, b) {
  const af = !!a.failed;
  const bf = !!b.failed;
  if (af && bf) return 0.5;
  if (af) return 0;
  if (bf) return 1;
  const ap = Number(a.place) || 0;
  const bp = Number(b.place) || 0;
  if (ap > 0 && bp > 0) return ap < bp ? 1 : (ap > bp ? 0 : 0.5);
  return 0.5;
}

function rebuildRatings() {
  const map = new Map();
  const events = state.archive.events
    .filter((e) => e && e.rated && Array.isArray(e.rows) && e.rows.length >= RATING_MIN_PLAYERS)
    .slice()
    .sort((a, b) => (a.finishedAt - b.finishedAt) || String(a.key).localeCompare(String(b.key)));

  for (const event of events) {
    const rows = event.rows
      .filter((r) => Number(r.user_id) > 0)
      .slice()
      .sort((a, b) => (a.place || 99) - (b.place || 99));
    if (rows.length < RATING_MIN_PLAYERS) continue;
    const entries = rows.map((r) => {
      const id = Number(r.user_id);
      let rec = map.get(id);
      if (!rec) {
        rec = {
          user_id: id,
          name: r.name || ('Ученик ' + id),
          class_name: r.class_name || event.className || '',
          rating: RATING_START,
          races: 0,
          wins: 0,
          podiums: 0,
          place_sum: 0,
          last_event_at: 0,
        };
        map.set(id, rec);
      }
      if (r.name) rec.name = r.name;
      if (r.class_name) rec.class_name = r.class_name;
      return { row: r, rec, delta: 0 };
    });

    const n = entries.length;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = entries[i];
        const b = entries[j];
        const expectedA = 1 / (1 + Math.pow(10, (b.rec.rating - a.rec.rating) / 400));
        const scoreA = rowScore(a.row, b.row);
        const kA = a.rec.races < RATING_PROV_RACES ? RATING_PROV_K : RATING_K;
        const kB = b.rec.races < RATING_PROV_RACES ? RATING_PROV_K : RATING_K;
        a.delta += (kA / (n - 1)) * (scoreA - expectedA);
        b.delta += (kB / (n - 1)) * ((1 - scoreA) - (1 - expectedA));
      }
    }

    for (const ent of entries) {
      const rec = ent.rec;
      rec.rating = Math.round((rec.rating + ent.delta) * 10) / 10;
      rec.races += 1;
      const place = Number(ent.row.place) || 0;
      if (!ent.row.failed && place > 0) {
        rec.place_sum += place;
        if (place === 1) rec.wins += 1;
        if (place <= 3) rec.podiums += 1;
      }
      rec.last_event_at = Math.max(rec.last_event_at, event.finishedAt || 0);
    }
  }

  state.ratings = map;
  saveRatingsSnapshot();
  return map;
}

function leaderboard(limit) {
  const rows = [...state.ratings.values()]
    .sort((a, b) => (b.rating - a.rating) || (b.races - a.races) || (b.wins - a.wins)
      || String(a.name).localeCompare(String(b.name), 'ru'))
    .slice(0, Math.max(1, Number(limit) || 50));
  return rows.map((r, i) => ({
    rank: i + 1,
    user_id: r.user_id,
    name: r.name,
    class_name: r.class_name,
    rating: Math.round(r.rating),
    races: r.races,
    wins: r.wins,
    podiums: r.podiums,
    avg_place: r.races ? Math.round((r.place_sum / r.races) * 10) / 10 : 0,
    provisional: r.races < RATING_PROV_RACES,
    last_event_at: r.last_event_at,
  }));
}

function ratingFor(sid) {
  return state.ratings.get(Number(sid)) || null;
}

function history(limit) {
  return state.archive.events
    .slice()
    .sort((a, b) => (b.finishedAt - a.finishedAt) || String(b.key).localeCompare(String(a.key)))
    .slice(0, Math.max(1, Number(limit) || 30));
}

function shouldRate(event, reason) {
  if (!event || !event.rated) return false;
  if (reason === 'closed') return false;   // брошенный заезд не меняет рейтинг
  return event.rows.length >= RATING_MIN_PLAYERS;
}

function pointsForPlace(place) {
  const p = Math.max(1, Math.round(Number(place) || 99));
  return POINTS[p - 1] != null ? POINTS[p - 1] : 0;
}

function studentOf(comp, sid) {
  return comp && Array.isArray(comp.students)
    ? comp.students.find((s) => Number(s.id) === Number(sid)) || null
    : null;
}

function makeEvent(comp, heat, opts) {
  const reason = (opts && opts.reason) || 'admin';
  const rows = (opts && opts.rows) ? opts.rows : (heat.results || []).map((r) => {
    const st = studentOf(comp, r.sid) || {};
    return {
      user_id: Number(r.sid) || 0,
      name: st.name || ('Ученик ' + r.sid),
      class_name: st.className || comp.className || '',
      place: Number(r.place) || 0,
      fin: r.fin == null ? null : Number(r.fin),
      time: Number(r.time) || 0,
      prog: Number(r.prog) || 0,
      done: !!r.done,
      failed: !!r.failed,
      points: r.failed ? 0 : pointsForPlace(r.place),
    };
  });
  return normalizeEvent({
    key: 'comp:' + comp.id + ':' + heat.id,
    source: 'comp',
    compId: comp.id,
    title: comp.title,
    classId: comp.classId,
    className: comp.className,
    track: comp.track,
    mode: comp.mode,
    format: comp.format,
    rated: shouldRate({ rated: comp.rated, rows }, reason),
    heatId: heat.id,
    round: heat.round,
    label: heat.label,
    finishedAt: heat.finishedAt || Date.now(),
    reason,
    rows,
  });
}

function addEvent(event, localOnly) {
  if (!validEvent(event)) return false;
  if (state.eventKeys.has(event.key)) return false;
  state.eventKeys.add(event.key);
  state.archive.events.push(event);
  if (!localOnly) state.pending.add(event.key);
  saveArchive();
  rebuildRatings();
  if (!localOnly) saveSyncState();
  if (!localOnly) scheduleSync(1500);
  return true;
}

function archiveCompHeat(comp, heat, reason) {
  if (!comp || !heat || !Array.isArray(heat.results) || !heat.results.length) return false;
  return addEvent(makeEvent(comp, heat, { reason: reason || heat.finishReason || 'admin' }));
}

/* Итог сетевой гонки на LAN-рееле: тренировочная запись только для
   локальной истории (без auth ID и без влияния на рейтинг). */
function archiveNetEvent(data) {
  if (!data || typeof data !== 'object') return false;
  const roomId = Number(data.roomId) || 0;
  const raceKey = String(data.raceKey || '').replace(/[^A-Za-z0-9:_\-.]/g, '').slice(0, 80);
  if (roomId <= 0 || !raceKey) return false;
  const rows = (Array.isArray(data.rows) ? data.rows : []).map((r) => ({
    user_id: Number(r && r.user_id) || 0,
    name: String((r && r.name) || '').slice(0, 60),
    class_name: '',
    place: Number(r && r.place) || 0,
    fin: r && r.fin != null ? Number(r.fin) : null,
    time: Number(r && r.time) || 0,
    prog: Number(r && r.prog) || 0,
    done: !!(r && r.done),
    failed: !!(r && r.failed),
    points: 0,
  })).filter((r) => r.name || r.user_id);
  if (rows.length < 2) return false;
  return addEvent(normalizeEvent({
    key: 'lan:' + roomId + ':' + raceKey,
    source: 'lan',
    roomId,
    title: String(data.title || 'Сетевая гонка').slice(0, 80),
    track: String(data.track || '').slice(0, 20),
    mode: data.mode === 'acro' ? 'acro' : 'angle',
    format: 'race',
    rated: false,
    label: 'Сетевая гонка',
    finishedAt: Date.now(),
    reason: 'finish',
    rows,
  }), true);
}

function archiveAllDone(comp) {
  if (!comp || !Array.isArray(comp.rounds)) return;
  let changed = false;
  for (const round of comp.rounds) {
    for (const heat of round.heats || []) {
      if (heat.status === 'done' && heat.results && heat.results.length) {
        if (archiveCompHeat(comp, heat, heat.finishReason || 'done')) changed = true;
      }
    }
  }
  return changed;
}

function archiveInterrupted(comp, reason) {
  if (!comp) return false;
  const heats = [];
  for (const round of comp.rounds || []) {
    for (const heat of round.heats || []) {
      if (heat.status === 'running') heats.push({ heat, round });
    }
  }
  let changed = false;
  for (const { heat, round } of heats) {
    const live = heat.live || {};
    const participants = (heat.participants || []).slice();
    const rows = participants.map((sid) => {
      const rec = live[sid] || {};
      const st = studentOf(comp, sid) || {};
      return {
        user_id: Number(sid) || 0,
        name: st.name || ('Ученик ' + sid),
        class_name: st.className || comp.className || '',
        place: 0,
        fin: rec.fin != null ? Number(rec.fin) : null,
        time: Number(rec.time) || 0,
        prog: Math.max(0, Math.min(1000, Number(rec.prog) || 0)),
        done: !!rec.done,
        failed: !rec.done,
        points: 0,
      };
    }).sort((a, b) => {
      if (a.done !== b.done) return a.done ? -1 : 1;
      return (b.prog - a.prog) || (a.time - b.time);
    });
    rows.forEach((r, i) => { r.place = i + 1; });
    const event = normalizeEvent({
      key: 'comp:' + comp.id + ':' + heat.id,
      source: 'comp',
      compId: comp.id,
      title: comp.title,
      classId: comp.classId,
      className: comp.className,
      track: comp.track,
      mode: comp.mode,
      format: comp.format,
      rated: false,
      heatId: heat.id,
      round: round.index,
      label: heat.label,
      finishedAt: Date.now(),
      reason: reason || 'closed',
      rows,
    });
    if (addEvent(event)) changed = true;
  }
  return changed;
}

function syncConfigured() {
  return !!(state.syncToken && state.syncUrl);
}

function syncStatus() {
  return {
    configured: syncConfigured(),
    pending: state.pending.size,
    total: state.archive.events.length,
    lastSyncAt: state.lastSyncAt,
    lastSyncOk: state.lastSyncOk,
    lastSyncError: state.lastSyncError,
  };
}

function scheduleSync(delay) {
  if (!syncConfigured()) return;
  if (state.syncTimer) clearTimeout(state.syncTimer);
  state.syncTimer = setTimeout(() => { trySync(); }, Math.max(500, Number(delay) || 1000));
}

async function trySync() {
  if (!syncConfigured() || state.syncBusy) return;
  const events = state.archive.events
    .filter((e) => state.pending.has(e.key))
    .slice(0, SYNC_BATCH);
  if (!events.length) return;
  state.syncBusy = true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const url = state.syncUrl.replace(/\/+$/, '') + '/api/results/ingest.php';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + state.syncToken,
        'X-Fly-Sync-Token': state.syncToken,
      },
      body: JSON.stringify({ events }),
      signal: controller.signal,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) {}
    if (!res.ok) {
      throw new Error('HTTP ' + res.status + (data && data.error ? ': ' + data.error : ''));
    }
    const accepted = Array.isArray(data && data.accepted) ? data.accepted : [];
    const duplicates = Array.isArray(data && data.duplicates) ? data.duplicates : [];
    for (const key of accepted.concat(duplicates)) {
      state.pending.delete(String(key));
    }
    if (Array.isArray(data && data.errors)) {
      for (const item of data.errors) {
        if (item && item.key) state.lastSyncError = String(item.error || 'rejected');
      }
    }
    state.lastSyncAt = Date.now();
    state.lastSyncOk = true;
    state.lastSyncError = '';
    saveSyncState();
  } catch (err) {
    state.lastSyncAt = Date.now();
    state.lastSyncOk = false;
    state.lastSyncError = err && err.message ? err.message : String(err);
    saveSyncState();
  } finally {
    clearTimeout(timer);
    state.syncBusy = false;
  }
}

function initResults(opts) {
  const dataDir = (opts && opts.dataDir) || path.join(__dirname, 'data');
  state.dataDir = dataDir;
  state.syncUrl = String((opts && opts.syncUrl) || 'https://fly.nayanovaacademy.ru');
  let token = String((opts && opts.syncToken) || '').trim();
  if (!token) {
    try {
      token = fs.readFileSync(path.join(dataDir, 'sync-token'), 'utf8').trim();
    } catch (_) {}
  }
  state.syncToken = token;

  fs.mkdirSync(dataDir, { recursive: true });
  const raw = readJson(filePath('results.json'), null);
  const events = raw && Array.isArray(raw.events) ? raw.events.filter(validEvent) : [];
  state.archive = { version: 1, updatedAt: Number(raw && raw.updatedAt) || Date.now(), events };
  state.eventKeys = new Set(events.map((e) => e.key));

  const sync = readJson(filePath('sync-state.json'), null);
  const lanKeys = new Set(events.filter((e) => e.source === 'lan').map((e) => e.key));
  if (sync && Array.isArray(sync.pending)) {
    state.pending = new Set(sync.pending.filter((k) => state.eventKeys.has(k) && !lanKeys.has(k)));
    state.lastSyncAt = Number(sync.lastSyncAt) || 0;
    state.lastSyncOk = !!sync.lastSyncOk;
    state.lastSyncError = String(sync.lastSyncError || '');
  } else {
    state.pending = new Set(events.filter((e) => e.source !== 'lan').map((e) => e.key));
  }

  rebuildRatings();
  if (syncConfigured()) {
    scheduleSync(2500);
    setInterval(() => { trySync(); }, SYNC_INTERVAL_MS).unref?.();
  }
  console.log('[results] archive:', events.length, 'events, ratings:', state.ratings.size,
    syncConfigured() ? '(sync on)' : '(local only)');
}

function writeJson(res, code, data) {
  try {
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(data));
  } catch (_) {}
}

function handleHttp(req, res, urlObj) {
  const pathname = urlObj.pathname;
  if (!pathname.startsWith('/api/results/')) return false;
  if (req.method !== 'GET') {
    writeJson(res, 405, { error: 'Method not allowed' });
    return true;
  }
  if (pathname === '/api/results/leaderboard') {
    writeJson(res, 200, {
      source: 'local',
      updatedAt: state.archive.updatedAt,
      leaderboard: leaderboard(Number(urlObj.searchParams.get('limit')) || 50),
    });
    return true;
  }
  if (pathname === '/api/results/history') {
    writeJson(res, 200, {
      source: 'local',
      updatedAt: state.archive.updatedAt,
      events: history(Number(urlObj.searchParams.get('limit')) || 30),
    });
    return true;
  }
  if (pathname === '/api/results/student') {
    const sid = Number(urlObj.searchParams.get('sid')) || 0;
    writeJson(res, 200, { rating: ratingFor(sid) ? {
      user_id: Number(sid),
      name: ratingFor(sid).name,
      class_name: ratingFor(sid).class_name,
      rating: Math.round(ratingFor(sid).rating),
      races: ratingFor(sid).races,
      wins: ratingFor(sid).wins,
      podiums: ratingFor(sid).podiums,
    } : null });
    return true;
  }
  if (pathname === '/api/results/status') {
    writeJson(res, 200, syncStatus());
    return true;
  }
  if (pathname === '/api/results/export') {
    writeJson(res, 200, state.archive);
    return true;
  }
  writeJson(res, 404, { error: 'Not found' });
  return true;
}

function compRatingPublic() {
  const top = leaderboard(10);
  const byId = {};
  for (const r of top) byId[r.user_id] = r;
  return { leaderboard: top, byId };
}

module.exports = {
  initResults,
  handleHttp,
  archiveCompHeat,
  archiveAllDone,
  archiveInterrupted,
  archiveNetEvent,
  leaderboard,
  history,
  ratingFor,
  ratingTop: leaderboard,
  compRatingPublic,
  syncStatus,
  trySync,
  RATING_START,
  RATING_PROV_RACES,
};
