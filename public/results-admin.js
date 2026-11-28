'use strict';

(function(){
  const AUTH_BASE = 'https://auth.nayanovaacademy.ru';
  const elForm = document.getElementById('histFilters');
  const elClass = document.getElementById('fClass');
  const elTrack = document.getElementById('fTrack');
  const elRated = document.getElementById('fRated');
  const elSource = document.getElementById('fSource');
  const elFrom = document.getElementById('fFrom');
  const elTo = document.getElementById('fTo');
  const elQ = document.getElementById('fQ');
  const elPer = document.getElementById('fPer');
  const elRefresh = document.getElementById('histRefresh');
  const elReset = document.getElementById('histReset');
  const elAuth = document.getElementById('histAuth');
  const elLogin = document.getElementById('histLogin');
  const elError = document.getElementById('histError');
  const elSummary = document.getElementById('histSummary');
  const elList = document.getElementById('histList');
  const elPager = document.getElementById('histPager');

  let page = 1;
  let pages = 1;

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
      return d.toLocaleString('ru-RU', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
    }catch(_){ return d.toISOString().slice(0, 16).replace('T', ' '); }
  }
  function sourceName(s){
    return s === 'comp' ? 'соревнование' : (s === 'net' ? 'сетевая' : (s || '—'));
  }
  const TRACK_NAMES = {
    utt1: 'Серпантин (UTT-1)', utt2: 'Цунами (UTT-2)', utt5: 'Спираль (UTT-5)',
    utt4: 'Высокое напряжение (UTT-4)', forest: 'Лесная дорога',
    city: 'Городская трасса', village: 'Деревенская дорога',
  };
  function trackName(t){
    return TRACK_NAMES[t] || (t ? t.toUpperCase() : '—');
  }
  function resultText(r){
    if(r.failed) return 'сход';
    if(r.fin != null) return Number(r.fin).toFixed(2) + ' с';
    return r.done ? 'финиш' : (r.prog ? Number(r.prog) + '%' : '—');
  }
  function deltaText(r){
    if(!r.rating_delta) return '—';
    const d = Number(r.rating_delta);
    return (d > 0 ? '+' : '') + d.toFixed(1);
  }

  function showAuth(){
    elAuth.hidden = false;
    elLogin.href = AUTH_BASE + '/index.php?page=login&redirect=' + encodeURIComponent(location.href);
    elList.innerHTML = '<div class="adm-empty">Войдите как администратор, чтобы открыть полную историю.</div>';
    elSummary.textContent = '';
    elPager.innerHTML = '';
  }
  function showError(text){
    elError.hidden = false;
    elError.textContent = text;
  }
  function clearNotes(){
    elError.hidden = true;
    elError.textContent = '';
    elAuth.hidden = true;
  }

  function fillSelect(el, values, allLabel){
    const cur = el.value;
    el.innerHTML = '<option value="">' + allLabel + '</option>' +
      values.map((v) => '<option value="' + escapeHtml(v) + '">' + escapeHtml(v) + '</option>').join('');
    if(values.indexOf(cur) >= 0) el.value = cur;
  }
  function applyFacets(facets){
    if(!facets) return;
    fillSelect(elClass, facets.classes || [], 'Все классы');
    fillSelect(elTrack, facets.tracks || [], 'Все трассы');
  }

  function buildQuery(){
    const p = new URLSearchParams();
    if(elClass.value) p.set('class', elClass.value);
    if(elTrack.value) p.set('track', elTrack.value);
    if(elRated.value !== '') p.set('rated', elRated.value);
    if(elSource.value) p.set('source', elSource.value);
    if(elFrom.value) p.set('from', elFrom.value);
    if(elTo.value) p.set('to', elTo.value);
    if(elQ.value.trim()) p.set('q', elQ.value.trim());
    p.set('per', elPer.value || '25');
    p.set('page', String(page));
    return p;
  }

  function renderEvents(events){
    if(!Array.isArray(events) || !events.length){
      elList.innerHTML = '<div class="adm-empty">По выбранным фильтрам заездов нет.</div>';
      return;
    }
    elList.innerHTML = events.map((e) => {
      const rows = Array.isArray(e.rows) ? e.rows : [];
      const badges = [
        '<span class="adm-badge ' + (e.rated ? 'gold' : '') + '">' + (e.rated ? 'рейтинговая' : 'тренировка') + '</span>',
        '<span class="adm-badge">' + escapeHtml(sourceName(e.source)) + '</span>',
        e.track ? '<span class="adm-badge green">' + escapeHtml(trackName(e.track)) + '</span>' : '',
        e.class_name ? '<span class="adm-badge">' + escapeHtml(e.class_name) + '</span>' : '',
      ].join('');
      const rowsHtml = rows.map((r) => {
        const d = Number(r.rating_delta) || 0;
        const dCls = d > 0 ? ' plus' : (d < 0 ? ' minus' : '');
        return '<tr>' +
          '<td class="place">' + Number(r.place || 0) + '</td>' +
          '<td class="name">' + escapeHtml(r.name || ('Участник ' + Number(r.user_id || 0))) +
            (r.class_name ? ' <span class="res-pill">' + escapeHtml(r.class_name) + '</span>' : '') + '</td>' +
          '<td class="' + (r.failed ? 'fail' : '') + '">' + escapeHtml(resultText(r)) + '</td>' +
          '<td class="num">' + (r.points ? Number(r.points) : '—') + '</td>' +
          '<td class="num hide-sm">' + (r.rating_before ? Math.round(Number(r.rating_before)) : '—') + '</td>' +
          '<td class="num">' + (r.rating_after ? Math.round(Number(r.rating_after)) : '—') + '</td>' +
          '<td class="delta num' + dCls + '">' + escapeHtml(deltaText(r)) + '</td>' +
        '</tr>';
      }).join('');
      return '<article class="adm-event">' +
        '<div class="adm-event-head">' +
          '<div><div class="adm-event-title">' + escapeHtml(e.title || 'Заезд') +
            (e.label ? ' · ' + escapeHtml(e.label) : '') + '</div>' +
            '<div class="adm-badges">' + badges + '</div></div>' +
          '<div class="adm-event-meta">' + escapeHtml(fmtTime(e.finished_at)) + '</div>' +
        '</div>' +
        '<div class="res-table-wrap"><table class="adm-table">' +
          '<thead><tr><th>#</th><th>Участник</th><th>Результат</th><th>Очки</th>' +
            '<th class="hide-sm">Было</th><th>Стало</th><th>Δ</th></tr></thead>' +
          '<tbody>' + rowsHtml + '</tbody>' +
        '</table></div>' +
      '</article>';
    }).join('');
  }

  function renderPager(){
    if(pages <= 1){
      elPager.innerHTML = '';
      return;
    }
    const buttons = [];
    const add = (p, label, cls) => {
      buttons.push('<button type="button" class="res-btn ' + (cls || '') + '" data-page="' + p + '">' + label + '</button>');
    };
    add(Math.max(1, page - 1), '←');
    const start = Math.max(1, page - 3);
    const end = Math.min(pages, page + 3);
    if(start > 1) add(1, '1');
    if(start > 2) buttons.push('<span class="res-muted">…</span>');
    for(let p = start; p <= end; p++){
      add(p, String(p), p === page ? 'cur' : '');
    }
    if(end < pages - 1) buttons.push('<span class="res-muted">…</span>');
    if(end < pages) add(pages, String(pages));
    add(Math.min(pages, page + 1), '→');
    elPager.innerHTML = buttons.join('');
    elPager.querySelectorAll('button[data-page]').forEach((b) => {
      b.addEventListener('click', () => {
        page = Math.max(1, Math.min(pages, Number(b.dataset.page) || 1));
        load(false);
      });
    });
  }

  async function load(resetPage){
    clearNotes();
    if(resetPage) page = 1;
    elRefresh.disabled = true;
    try{
      const res = await fetch('/api/results/admin_history.php?' + buildQuery().toString(), {
        credentials: 'include',
        headers: { 'Accept': 'application/json' },
      });
      let data = null;
      try { data = await res.json(); } catch (_) {}
      if(res.status === 401){ showAuth(); return; }
      if(res.status === 403){
        showError('Полная история доступна только администратору. Войдите под администраторской учётной записью.');
        elList.innerHTML = '';
        elSummary.textContent = '';
        elPager.innerHTML = '';
        return;
      }
      if(!res.ok){
        throw new Error((data && data.error) || ('HTTP ' + res.status));
      }
      applyFacets(data.facets);
      pages = Math.max(1, Number(data.pages) || 1);
      page = Math.max(1, Math.min(pages, Number(data.page) || 1));
      elSummary.textContent = 'Найдено заездов: ' + (Number(data.total) || 0) +
        ' · страница ' + page + ' из ' + pages +
        (data.updatedAt ? ' · ' + fmtTime(data.updatedAt) : '');
      renderEvents(data.events || []);
      renderPager();
    }catch(err){
      showError('Не удалось загрузить историю: ' + (err && err.message ? err.message : 'ошибка сети'));
    }finally{
      elRefresh.disabled = false;
    }
  }

  elForm.addEventListener('submit', (e) => {
    e.preventDefault();
    load(true);
  });
  elReset.addEventListener('click', () => {
    elClass.value = '';
    elTrack.value = '';
    elRated.value = '';
    elSource.value = '';
    elFrom.value = '';
    elTo.value = '';
    elQ.value = '';
    elPer.value = '25';
    load(true);
  });
  elRefresh.addEventListener('click', () => load(false));
  elPer.addEventListener('change', () => load(true));

  load(true);
})();
