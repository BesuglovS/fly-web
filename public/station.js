'use strict';

(function () {
  const STATIONS = ['R114-01', 'R114-02', 'R114-03', 'R114-17', 'R114-18', 'R114-19'];
  const KEY = 'fly-lan-station';
  const grid = document.getElementById('stationGrid');
  const currentEl = document.getElementById('stationCurrent');
  const openBtn = document.getElementById('stationOpen');
  let selected = '';

  function readSaved() {
    const q = new URLSearchParams(location.search).get('station') || '';
    if (STATIONS.indexOf(q) >= 0) return q;
    try {
      const s = localStorage.getItem(KEY) || '';
      return STATIONS.indexOf(s) >= 0 ? s : '';
    } catch (_) {
      return '';
    }
  }

  function render() {
    currentEl.textContent = selected || 'не выбрана';
    openBtn.disabled = !selected || location.protocol === 'https:';
    grid.querySelectorAll('button[data-station]').forEach(function (b) {
      b.classList.toggle('sel', b.dataset.station === selected);
    });
  }

  function select(station) {
    selected = STATIONS.indexOf(station) >= 0 ? station : '';
    if (selected) {
      try { localStorage.setItem(KEY, selected); } catch (_) {}
    } else {
      try { localStorage.removeItem(KEY); } catch (_) {}
    }
    render();
  }

  STATIONS.forEach(function (st) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.station = st;
    b.textContent = st;
    b.addEventListener('click', function () { select(st); });
    grid.appendChild(b);
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
