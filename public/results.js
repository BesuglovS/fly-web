'use strict';

(function(){
  const AUTH_BASE = 'https://auth.nayanovaacademy.ru';
  const elRefresh = document.getElementById('resRefresh');
  const elError = document.getElementById('resError');
  const elAuth = document.getElementById('resAuth');
  const elLogin = document.getElementById('resLogin');
  const elStatus = document.getElementById('resStatus');
  const elUpdated = document.getElementById('resUpdated');
  const elLeaderboard = document.querySelector('#resLeaderboard tbody');
  const elHistory = document.getElementById('resHistory');
  const elAdminLink = document.getElementById('resAdminLink');

  function escapeHtml(s){
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
  function fmtTime(ts){
    const n = Number(ts) || 0;
    if(!n) return '';
    const d = new Date(n > 1e12 ? n : n * 1000);
    try{
      return d.toLocaleString('ru-RU', { day:'2-digit', month:'2-digit', year:'2-digit', hour:'2-digit', minute:'2-digit' });
    }catch(_){ return d.toISOString().slice(0, 16).replace('T', ' '); }
  }
  const TRACK_NAMES = {
    utt1: 'Серпантин (UTT-1)', utt2: 'Цунами (UTT-2)', utt5: 'Спираль (UTT-5)',
    utt4: 'Высокое напряжение (UTT-4)', forest: 'Лесная дорога',
    city: 'Городская трасса', village: 'Деревенская дорога',
  };
  function trackName(t){
    return TRACK_NAMES[t] || (t ? t.toUpperCase() : '');
  }
  function showError(text){
    elError.hidden = false;
    elError.textContent = text;
  }
  function clearNotes(){
    elError.hidden = true;
    elError.textContent = '';
    elAuth.hidden = true;
    elStatus.hidden = true;
    elStatus.textContent = '';
  }

  async function fetchJson(url, opts){
    const res = await fetch(url, Object.assign({ credentials: 'include' }, opts || {}));
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if(res.status === 401){
      const err = new Error('auth');
      err.auth = true;
      throw err;
    }
    if(!res.ok){
      const err = new Error((data && data.error) || ('HTTP ' + res.status));
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async function loadPair(name, query){
    const q = query ? ('?' + query) : '';
    try{
      const local = await fetchJson('/api/results/' + name + q);
      return { data: local, local: true };
    }catch(err){
      if(err.auth) throw err;
      if(err.status && err.status !== 404 && err.status !== 405){
        /* локального API нет — пробуем сервер сайта */
      }
    }
    const data = await fetchJson('/api/results/' + name + '.php' + q);
    return { data, local: false };
  }

  function setAuthPrompt(){
    elAuth.hidden = false;
    const back = location.href;
    elLogin.href = AUTH_BASE + '/index.php?page=login&redirect=' + encodeURIComponent(back);
    elLeaderboard.innerHTML = '<tr><td colspan="8" class="res-empty">Войдите, чтобы увидеть рейтинг.</td></tr>';
    elHistory.innerHTML = '<div class="res-empty">История доступна после входа.</div>';
  }

  function renderLeaderboard(data, local, me){
    const rows = Array.isArray(data) ? data : [];
    if(!rows.length){
      elLeaderboard.innerHTML = '<tr><td colspan="8" class="res-empty">Рейтинг пока пуст: нужны рейтинговые гонки.</td></tr>';
      return;
    }
    const meId = me && me.user_id ? Number(me.user_id) : 0;
    elLeaderboard.innerHTML = rows.map((r) => {
      const isMe = meId && Number(r.user_id) === meId;
      return '<tr' + (isMe ? ' class="me"' : '') + '>' +
        '<td class="rank">' + Number(r.rank || 0) + '</td>' +
        '<td class="name">' + escapeHtml(r.name || '') +
          (r.provisional ? '<span class="res-pill">новичок</span>' : '') + '</td>' +
        '<td>' + escapeHtml(r.class_name || '—') + '</td>' +
        '<td class="rating">' + Number(r.rating || 0) + '</td>' +
        '<td class="num">' + Number(r.races || 0) + '</td>' +
        '<td class="num">' + Number(r.wins || 0) + '</td>' +
        '<td class="num">' + Number(r.podiums || 0) + '</td>' +
        '<td class="num">' + (r.avg_place != null ? Number(r.avg_place).toFixed(1) : '—') + '</td>' +
      '</tr>';
    }).join('');
    if(local){
      elStatus.hidden = false;
      elStatus.className = 'res-note res-status';
      elStatus.textContent = 'Локальный архив этого релея. Официальный рейтинг — на сайте после синхронизации.';
    }
  }

  function eventDate(e){
    return e.finishedAt || e.finished_at || 0;
  }
  function renderHistory(events){
    if(!Array.isArray(events) || !events.length){
      elHistory.innerHTML = '<div class="res-empty">Заездов пока нет.</div>';
      return;
    }
    elHistory.innerHTML = events.map((e) => {
      const rows = Array.isArray(e.rows) ? e.rows : [];
      const rated = !!e.rated;
      const title = e.title || (e.source === 'net' ? 'Сетевая гонка' : 'Заезд');
      const meta = [
        e.label || '',
        trackName(e.track) || '',
        fmtTime(eventDate(e)),
      ].filter(Boolean).join(' · ');
      return '<div class="res-event">' +
        '<div class="res-event-head">' +
          '<div class="res-event-title">' + escapeHtml(title) +
            '<span class="res-badge' + (rated ? ' rated' : '') + '">' +
              (rated ? 'рейтинговая' : 'тренировка') + '</span></div>' +
          '<div class="res-event-meta">' + escapeHtml(meta) + '</div>' +
        '</div>' +
        '<div class="res-rows">' + rows.map((r) => {
          const result = r.failed ? 'сход' :
            (r.fin != null ? Number(r.fin).toFixed(2) + ' с' :
              (r.done ? 'финиш' : (r.prog ? r.prog + '%' : '—')));
          return '<div class="res-row' + (r.failed ? ' fail' : '') + '">' +
            '<b>' + Number(r.place || 0) + '</b>' +
            '<span>' + escapeHtml(r.name || ('Участник ' + Number(r.user_id || 0))) + '</span>' +
            '<em>' + result + '</em>' +
          '</div>';
        }).join('') + '</div>' +
      '</div>';
    }).join('');
  }

  async function load(){
    clearNotes();
    elRefresh.disabled = true;
    try{
      const lb = await loadPair('leaderboard', 'limit=100');
      const data = lb.data || {};
      renderLeaderboard(data.leaderboard || [], lb.local, data.me || null);
      if(elAdminLink) elAdminLink.hidden = !data.isAdmin;
      if(!lb.local && data.me){
        elStatus.hidden = false;
        elStatus.className = 'res-note res-status';
        elStatus.textContent = 'Личный рейтинг: ' + Number(data.me.rating || 0) +
          ' · ' + Number(data.me.races || 0) + ' рейт. гонок' +
          (data.me.class_name ? ' · ' + data.me.class_name : '');
      }
      elUpdated.textContent = data.updatedAt ? ('обновлено ' + fmtTime(data.updatedAt)) : '';

      const hist = await loadPair('history', 'limit=30');
      renderHistory((hist.data && hist.data.events) || []);
    }catch(err){
      if(err && err.auth){
        setAuthPrompt();
      }else{
        showError('Не удалось загрузить рейтинг: ' + (err && err.message ? err.message : 'ошибка сети'));
      }
    }finally{
      elRefresh.disabled = false;
    }
  }

  elRefresh.addEventListener('click', load);
  load();
})();
