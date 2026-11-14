'use strict';

(function () {
  /* Компьютеры аудиторий: 109 — 6 машин, 110 — 7, 114 — 24. */
  const ROOMS = ['109', '110', '114'];
  const ROOM_MAX = { '109': 6, '110': 7, '114': 24 };
  const KEY = 'fly-lan-station';
  const grid = document.getElementById('stationGrid');
  const currentEl = document.getElementById('stationCurrent');
  const openBtn = document.getElementById('stationOpen');
  let selected = '';

  function normalizeStation(id) {
    const m = /^R(109|110|114)-(\d{1,2})$/i.exec(String(id == null ? '' : id).trim());
    if (!m) return '';
    const n = Number(m[2]);
    const max = ROOM_MAX[m[1]] || 0;
    if (!Number.isFinite(n) || n < 1 || n > max) return '';
    return 'R' + m[1] + '-' + String(n).padStart(2, '0');
  }

  function readSaved() {
    const q = normalizeStation(new URLSearchParams(location.search).get('station') || '');
    if (q) return q;
    try {
      return normalizeStation(localStorage.getItem(KEY) || '');
    } catch (_) {
      return '';
    }
  }

  function select(station) {
    selected = normalizeStation(station);
    if (selected) {
      try { localStorage.setItem(KEY, selected); } catch (_) {}
    } else {
      try { localStorage.removeItem(KEY); } catch (_) {}
    }
    render();
  }

  function render() {
    currentEl.textContent = selected || 'не выбрана';
    openBtn.disabled = !selected || location.protocol === 'https:';
    document.querySelectorAll('button[data-station]').forEach(function (b) {
      b.classList.toggle('sel', normalizeStation(b.dataset.station) === selected);
    });
  }

  ROOMS.forEach(function (room) {
    const block = document.createElement('div');
    block.className = 'station-room';
    const title = document.createElement('div');
    title.className = 'station-room-title';
    title.textContent = 'Аудитория ' + room + ' · ' + ROOM_MAX[room] + ' ПК';
    const roomGrid = document.createElement('div');
    roomGrid.className = 'station-grid';
    for (let n = 1; n <= ROOM_MAX[room]; n++) {
      const id = 'R' + room + '-' + String(n).padStart(2, '0');
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.station = id;
      b.textContent = String(n).padStart(2, '0');
      b.addEventListener('click', function () { select(id); });
      roomGrid.appendChild(b);
    }
    block.appendChild(title);
    block.appendChild(roomGrid);
    grid.appendChild(block);
  });

  openBtn.addEventListener('click', function () {
    if (!selected) return;
    try { localStorage.setItem(KEY, selected); } catch (_) {}
    location.href = '/?lan&station=' + encodeURIComponent(selected);
  });

  const noComp = document.getElementById('stationNoComp');
  if (noComp) {
    noComp.addEventListener('click', function () {
      try { localStorage.removeItem(KEY); } catch (_) {}
    });
  }

  selected = readSaved();
  if (location.protocol === 'https:') {
    openBtn.disabled = true;
    const hint = document.querySelector('.station-hint');
    if (hint) hint.textContent = 'Эта страница работает на релее. Откройте её по адресу http://<IP-релея>:8080/station.html — на сайте соревнование создаёт учитель.';
  }
  render();
}());
