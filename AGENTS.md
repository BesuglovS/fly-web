# AGENTS.md — fly-web (симулятор полёта БПЛА)

Самодостаточная статическая страница-симулятор полёта (three.js, vanilla JS).

Прод: `https://fly.nayanovaacademy.ru` — nginx-статика, серверной части нет;
репозитория git нет (по решению владельца) — источник для правок: этот каталог.
Симулятор перенесён сюда из `C:\websites\na\pioneer-web\fly\` (там теперь только
редирект `/fly/` → этот домен; ссылки главной/гамбургера pioneer ведут сюда).

## Что это (функции)

- Полётный симулятор: физически-аркадная модель БПЛА, реалистичный acro.
- **Выбор БПЛА**: карточки 4 моделей, мгновенная пересборка меша.
- **Режимы полёта**: Angle (автостабилизация) / Acro (ставки угловых скоростей,
  без автовыравнивания, включая петли/роллы; кватернионная ориентация).
- **Обучающие упражнения**: 15 уровней с возрастающей сложностью (взлёт/посадка,
  рыскание, висение, слалом, развороты, точная посадка, полоса препятствий,
  восьмёрка, коридор, гонка на время (timeLimit), диагонали, узкие ворота
  (constraints.maxRoll), отказ мотора (emergency), свободный полёт).
- **Гонки на время** (`race:true`): 5 трасс — 4 по мотивам MultiGP
  Universal Time Trial — «Серпантин» (UTT-1), «Цунами» (UTT-2, вертикальные
  ворота), «Спираль» (UTT-5 Nautilus), «Высокое напряжение» (UTT-4), плюс
  лесная «Лесная дорога» (40 ворот, рельеф): `timeLimit`
  (звёзды по времени); 4 трассы UTT проходят внутри **стадиона** (`buildStadium`,
  `map:'stadium'`): тёмное поле с разметкой/логотипом, борта, LED-борта, трибуны
  с козырьком, мачты прожекторов и табло с названием трассы. Габариты арены
  подобраны так, что все четыре трассы целиком внутри поля (`ST_CX/ST_CZ/ST_HW/ST_HD`).
  Выбираются в старт-экране
  (шаг 1 → «🏁 Гонки на время» → шаг 2, список `LEVELS.filter(lv=>lv.race)`).
  Ворота трасс — детализированные квадратные рамы (`buildRaceGate`: рама,
  косынки, полупрозрачная сетка, шахматный баннер, номер), плюс арка
  «СТАРТ · ФИНИШ» (`buildStartGantry`), парные флажки у ворот и конусы вдоль
  линии (`buildRaceProps`); общий кэш материалов/геометрий — `getRaceAssets`,
  сбрасывается в `clearLevelRoot` (иначе dispose убьёт переиспользуемые текстуры).
  Для лесной трассы `buildRaceProps` не зовётся (арка/флажки ушли бы под рельеф) —
  вместо неё стартовая арка строится в `buildForest` по рельефу.
- **Свободный полёт**: карты Луг / Город / Каньон (процедурный декор).
- **Лесная трасса** (`terrain:'forest'`, `race:true` — в гоночном списке): длинная
   дорога-кольцо среди деревьев, **40 ворот**, рельеф поднимается и опускается.
   Высота задаётся `forestTerrain(x,z)`
   — общая для физики приземления (`groundHeightAt`) и расстановки объектов; деревья
   (`buildForestTrees`) — `InstancedMesh` (3 вызова отрисовки) со столкновениями по
   пространственной сетке (`resolveForestTrees`), дорога — лента `BufferGeometry`.
- **USB-пульт**: Gamepad API (BetaFPV и любой HID), калибровка/назначение осей
  и кнопок, config в localStorage; статус в HUD.
- **Клавиатура**: WASD + стрелки; **мышь/тач**: тянутся виртуальные стики
  (мультитач); сервисные клавиши: C — камера, F — режим, M — модель, R — заново,
  N — след. уровень, 1…9/0 — выбор уровня, Esc — меню.
- **FPV-вид** (4-й режим камеры): камера в носу, FOV 105°, canvas-оверлей:
  авиагоризонт (лестница тангажа), шкала крена-дуга, компас-лента,
  SPD/ALT/вариометр, «НИЗКАЯ ВЫСОТА». Рисуется ТОЛЬКО в режиме FPV.
- **Сетевая игра**: несколько комнат одновременно, mesh «каждый с каждым».
  Размер комнаты выбирает хост (`rooms.max`: 2/4/6/8, потолок 8 — для игры в
  локальной сети). В окне — список открытых игр и подключение к нужной (или
  «Быстрая игра»); первый участник — хост: выбирает карту (Луг/Город/Каньон или
  **Лесная дорога** — `forest`), режим (Angle/Acro) и размер и жмёт «Начать игру» — выбор и старт транслируются
  остальным. Сигналинг — HTTP-поллинг PHP-бэкенда (`server/` → `/api/signal/*`,
  вне webroot), авторизация по куке `auth_session`. После установки DataChannel
  трафик P2P; синхронизация 20 Гц (позиция + кватернион), аппарат соперника —
  клон меша с подписью имени (sprite/CanvasTexture). Ручных кодов нет.
  **Сетевой забег**: общий старт (хост ждёт «готов» всех → `go` → отсчёт 3-2-1,
  физика и таймер стоят), живое табло прогресса `#raceBoard` (кто сколько ворот
  прошёл), при финише/сходе — итоговое табло с местами и временами; хост может
  перезапустить гонку кнопкой «🔁 Перезапустить гонку» (`reset`).
- **Авторизация auth-web (SSO, опционально)**: клиентский `fetch` к
  `auth.nayanovaacademy.ru/api/check.php` (`credentials:'include'`, читает общую
  куку `auth_session`), вход/выход — навигацией на портал с `?redirect=`.
  Анонимный вход разрешён: `renderAuth()` (#authBox в панели «Управление» и
  `#stAuthBtn` на стартовом экране) только показывают имя и кнопки.
- **Мобильные**: крупнее тач-зона, авто-даунскейл разрешение (замер каждые 3 с),
  antialias выключен, тени 1024, подсказка о повороте (портрет), fullscreen.
  Интерфейс скрыт: остаётся 3D + стики + маленькая «☰» (правый верх):
  она открывает старт-экран со всем меню (модель, режим, камера, уровни/карты,
  пульт, сеть, fullscreen).

## ⚠ Критические правила

1. **Правки в `public/` (страница) и `server/` (PHP-сигналинг) — контента больше нигде нет:**
   - `index.html` — разметка UI (HUD `#hud`, строка уровня `#levelbar`,
     легенда `#legend` + кнопки, старт-экран `#startScreen` > `#stCard`,
     модалки `#gpModal`, `#cfgModal`, `#netModal`, `#overlay`, `#fpvHud`,
     стики `#stickLeft/#stickRight`, `#rotateHint`);
   - `style.css` — все стили (включая `@media (pointer: coarse)`-правила);
   - `app.js` — вся логика (см. «Конвенции» ниже);
   - `three.module.min.js` — локальная копия three.js r160 (670 КБ);
     не редактировать, не заменять на CDN.
   - `api/signal/*.php` — тонкие фронт-контроллеры, зовущие `../app` (см. `_bootstrap.php`).
   - `server/` (снаружи `public/`) — PHP-код сигналинга + `AuthClient`; деплоится в `../app`.
2. **Никаких inline `<style>`/`<script>`, importmap и внешних CDN** —
   CSP сервера строгая (`script-src/style-src 'self'`); inline-код заблокируется
   и сломает страницу в проде. three.js импортируется относительным путём
   `./three.module.min.js`. Раньше стоял importmap/unpkg — убран именно поэтому.
   **Единственное внешнее подключение — auth-web**: CSP `connect-src` в nginx
   содержит `https://auth.nayanovaacademy.ru` (security-набор и CSP дублируются
   в КАЖДОМ location, включая PHP-location `/api/`). Same-origin обращения к
   `/api/signal/*` покрываются `connect-src 'self'` — CSP из-за бэкенда не меняется.
   Парный гейт — `ALLOWED_ORIGINS` в `auth-web/config.php`:
   `https://fly.nayanovaacademy.ru` обязан там быть, иначе CORS не отдаст
   ответ `check.php` и вход «молча» не сработает. Анонимный вход не блокируем.
3. **Кэш**: файлы грузятся по именам БЕЗ content-hash (`?v=`) — любое долгое
   caching недопустимо; всё `no-cache, must-revalidate` (в nginx-конфиге есть
   и `.css|.js`, и `.html` location). НЕ переносите файлы под immutable-кэш —
   после деплоя браузеры навсегда останутся со старым `app.js` (ломаются кнопки
   без ошибок в консоли).
4. **Deploy nginx-конфиг** — только через sudo-хелпер: `deploy.ps1` вызывает
   `sudo -n /usr/local/sbin/deploy-nginx.sh fly.nayanovaacademy.ru`
   (whitelist имени — в самом хелпере на сервере; при добавлении новых сайтов
   расширяйте `case` там). Хелпер сам делает `nginx -t` и откатывает конфиг
   при ошибке (бэкап `/tmp/nginx-backup-<имя>`, если есть).
5. `.env` и `ssh-private.key` — никогда не печатать и не коммитить.
   Ключ подключён к root — не рассылать. Webroot на сервере: `/var/www/fly.nayanovaacademy.ru/public`
   (владелец `deploy:www-data`; при добавлении сайта с новым webroot не забудьте
   разово `mkdir -p + chown deploy:www-data`, у юзера `deploy` нет права создавать
   папки в `/var/www`).
6. **TURN/NAT**: игроки соединяются через собственный coturn
   (`fly.nayanovaacademy.ru:3478`, UDP/TCP) — STUN-only недостаточно при общем/
   симметричном NAT. Креденшелы временные (REST-авторизация, `use-auth-secret`);
   `static-auth-secret` хранится в `data/turn_secret` (`www-data` 640), клиенту НЕ
   отдаётся — только `ice.php` считает HMAC-SHA1. Не публиковать секрет и не
   отключать `denied-peer-ip` для приватных сетей (иначе открытый relay).
7. **Сигналинг (`server/`, `/api/signal/*`)** — серверный код, доверять только ему:
   авторизацию проверяем сервер-к-серверу через `AuthClient` (не принимаем `user_id`
   от клиента); только POST + `Content-Type: application/json` (отсекает CSRF-form);
   лимиты: ≤4 участников, SDP ≤ 32 КБ, rate-limit поллинга; SQLite — prepared
   statements, только в `../data` (вне webroot). В nginx исполняется только
   `/api/*.php`, любой другой `.php` → 404. Не ослаблять.

## 🏗 Структура

```
public/                 # webroot (см. правило 1); api/signal/*.php — фронт-контроллеры
relay/                  # LAN-релей (Node+ws): статика + WebSocket /ws, звезда O(N).
                        # НЕ деплоится на прод — запускается на машине в локальной сети.
server/                 # PHP-бэкенд сигналинга (деплой → ../app, ВНЕ webroot):
                        # auth-client/AuthClient.php, lib/Db.php+http.php,
                        # api/rooms+create+join+find+exchange+ice+leave.php
fly.nayanovaacademy.ru  # nginx-конфиг: 80→301; wildcard cert.pem/key.pem;
                        # location ~ ^/api/.*\.php$ → php8.1-fpm; прочий .php → 404;
                        # security-набор продублирован в каждом location с add_header
deploy.ps1              # public/ → webroot, server/ → app/; см. «Команды»
.env / .env.example     # DEPLOY_SSH_HOST/PORT/USER/KEY/DEPLOY_REMOTE_PATH
AGENTS.md               # этот файл
```

Разовая настройка на сервере (root, один раз): каталоги
`/var/www/fly.nayanovaacademy.ru/app` и `.../data` рядом с `public/`, владелец
`deploy:www-data`; `data/` — на запись PHP-FPM (`signaling.db`, переживает деплой).
У пользователя `deploy` нет прав создавать каталоги в `/var/www`.

## 🛠 Команды (Windows PowerShell)

```bash
.\deploy.ps1 -DryRun    # просмотр команд
.\deploy.ps1            # деплой: tar public/ | ssh rm -rf + mkdir + untar;
                        # затем scp nginx-конфиг → /tmp;
                        # ssh sudo deploy-nginx.sh fly.nayanovaacademy.ru;
                        # smoke-check HEAD 200 https://fly.nayanovaacademy.ru/
```

Билда нет: контент — готовая статика; правки в `public/` сразу уходят в прод.

## 💻 Конвенции app.js (структура кода)

1. **Константы/рендер**: `GROUND_REST`, `MAX_SPEED/MAX_CLIMB`, `MAX_PITCH/MAX_ROLL`,
   `WORLD_LIMIT`. `renderer` (`isMobile`-оптимизации), сцена, небо-купол (ShaderMaterial),
   свет/тени, земля (CanvasTexture), площадка, деревья, кольца.
   **Рельеф**: `terrainFn` (по умолчанию null → плоско) + `groundHeightAt(x,z)` и
   `aglAlt()` (высота над рельефом); приземление в `integrateDrone` и HUD/цели
   используют их, поэтому уровни без рельефа работают как раньше.
2. **Модель**: каталог `DRONE_MODELS` (Мини 2 / Базовый / FPV Racing / Гекса);
   узлы `MOTOR_OPTS / PROP_OPTS / BATTERY_OPTS`; пользовательская сборка — `cfg`,
   итоговые множители — `perf` (`updatePerf()`); меш — `makeDroneMesh(model)`
   (4 или 6 моторов, цвета-токены: перед красный / зад белый / борта зелено-синие);
   пересборка — `rebuildDroneModel()` (при смене модели/узлов — тоже).
   **Батарея**: `batteryCharge` (0..1), расход по газу, <15% — тяга падает до 25%;
   полный заряд на новом уровне; HUD-строка «Аккум.» краснеет <20% (класс `.bat-low`).
3. **Ориентация**: `state.quat` — кватернион (каноническая); в Angle — из Euler
   каждый кадр, в Acro — честная кватернионная интеграция:
   `quat.multiply(ΔQ(pitch/roll))` вокруг ЛОКАЛЬНЫХ осей; рыскание — тоже
   `multiply` вокруг ЛОКАЛЬНОЙ вертикали корпуса (Y=up), поэтому наклон
   учитывается (при крене/тангаже нос уводит по конусу); снос `biasYaw` при
   отказе — в той же локальной оси. Углы `pitch/yaw/roll` для HUD извлекаются
   `Euler('YXZ')` после шага.
   Автовыравнивание в Acro НЕТ; на земле — slerp к уровню (общий `integrateDrone`).
4. **Ввод**: указатель `setupStick` (pointer capture, мультитач) + клавиатура + пульт.
   Пульт: `gamepad` опрос каждый кадр + форс-рескан по жестам/интервал
   (Chrome скрывает устройства до первого действия!); автовыбор «живого» устройства
   + ручной селектор `#gpDevice`; оси `yaw/throttle/pitch/roll`, инверсия,
   мёртвая зона; кнопки cam/reset/next/arm; конфиг в localStorage
   `pioneer-web-fly-gamepad`. **WebHID-фолбэк** (`webhid`): для пультов,
   которые `joy.cpl` видит, а Gamepad API нет (нестандартный дескриптор,
   напр. BetaFPV) — кнопка в `#gpModal`, `navigator.hid.requestDevice({filters:[]})`,
   разбор `device.collections`, синтетический пэд `WEBHID_PAD_INDEX=1000` вливается
   в тот же `gamepad.axes/buttons` (калибровка общая); авто-реконнект через `getDevices()`.
5. **Уровни**: `LEVELS` (15 упражнений + 5 трасс-гонок `race:true`); ворота
   `ring|hover|heading|altitude|land`; ограничения
   `constraints.{maxAlt,maxSpeed,maxRoll}` / `timeLimit` / `emergency`;
   у трасс есть `map:'stadium'` и `race`; `buildLevelScene` зовёт по приоритету:
   `terrain:'forest'` → `buildForest()` (лесная трасса, `buildRaceProps` для неё
   пропускается), иначе `race` → `buildStadium(lv)` (арена: поле, борта, LED-борта,
   трибуны+козырёк, прожекторы, табло; коллайдеры — `stadiumSolids`), иначе —
   `buildMapDecor(lv.map, lv.gates)` (а `makeDecorClear` держит коридор вдоль ворот
   свободным); плюс `buildRaceProps` (арка, флажки, конусы) для не-лесных трасс; на
   трассах кольца рисуются квадратными рамами `buildRaceGate`; звёзды по времени;
   подсказка — голубой стрелкой-указателем; уровень-меню — через старт-экран.
   **Столкновения — ОТСКОК, не провал**: `resolveCollisions()` (звать из
   `integrateDrone` после переноса позиции) гоняет `resolveObstacle` (AABB по
   оси наименьшего проникновения) и `resolveGate`. `resolveGate` считает
   ближайшую точку осевой линии бруса в локальных осях ворот (`-faceYaw`):
   квадрат (гонки) или окружность (кольца); дрон — сфера `DRONE_R`, при
   `dist < barR+DRONE_R` выталкивается на поверхность, скорость отражается
   `bounceOff` (`BOUNCE_REST`, `BOUNCE_FRIC`). В свободном полёте (`free`) рамы
   ворот не сталкиваются.
6. **HUD**: телеметрия в `#hud` (обновление DOM ежекадрово — дешёво); строка уровня
   `#levelbar` (objective, лимит времени, предупреждения); FPV-оверлей —
   `drawFpvHud()` (canvas 2d поверх WebGL, только при `camMode===3`).
7. **Сеть**: `netRoom` — игр несколько, размер комнаты `rooms.max` (2/4/6/8,
   потолок 8) задаёт хост через `control.max` (нельзя ниже числа текущих
   участников). **Больше `FLY_PUBLIC_MAX=4` — только администратор**: сервер
   клампит (`flyClampMaxForUser`), а `maxOptions`/`maxHard` в снимке фильтруются
   по `is_admin`; UI показывает только разрешённые размеры. В LAN-релее то же
   через `ADMIN_KEY` (админ открывает `?lan&admin=<ключ>`). `peers: Map<userId, peer>`
   (mesh); каждая пара — свой `RTCPeerConnection` и DataChannel `fly`
   (ordered:false); инициатор пары — меньший `user_id` (один offer на пару).
   Сигналинг — `POST /api/signal/*`: `rooms`/`create`/`join`/`find` (лобби и вход),
   `exchange` (SDP + heartbeat + состав + host-`control`), `ice` (STUN+TURN),
   `leave`. Поллинг ~2 с + быстрый `netKick`; протокол
   `{t:'hello'|'st', p:[x,y,z], q:[x,y,z,w]}`, интерполяция lerp/slerp, 50 мс тики;
   сетевой забег — сообщения `ready|go|reset|race` (`netRaceHandle`/`netBroadcast`,
   в релее форвардятся так же, как `st`); `race` несёт `{name,prog,time,done,failed,fin}`.
   подписи имён — `THREE.Sprite` поверх клонов мини-2. Хост = `room.host_user_id`
   (первый; при уходе переназначается): карта (`CFG.map` / `info.map`) и режим (`setFlightMode`)
   применяются через `applyNetGame()` — у хоста сразу, у гостей при `started`;
   `map==='forest'` грузит лесную трассу (`LEVELS.findIndex(l=>l.terrain==='forest')`)
   вместо уровня свободного полёта, а `cfg.map` при этом не затирается;
   когда `started` впервые приходит, окно `#netModal` закрывается само, а у хоста
   для трасс с `timeLimit` уровень перезагружается, чтобы таймер стартовал с начала.    ICE-серверы
   берутся из `ice.php` (`netLoadIce()`) до создания соединений; `netPeerWatchdog`
   пересоздаёт связь у инициатора, если канал не открылся за ~7 с. Карта комнаты
   хранится на сервере. Комната живёт и для одного: можно летать одному.
   **LAN-режим** (`NET_RELAY`, авто на `http:` или `?lan`/`?relay=host`): транспорт —
   один WebSocket к `relay/` (звезда, O(N)), без auth-web/TURN; заполняются те же
   `netRoom`/`peers`, поэтому UI/`applyNetGame` общие, а `ensurePeer` в этом режиме
   не создаёт `RTCPeerConnection` (борт сразу виден).
   `players.slot` (0..3, наименьший свободный) — персональная точка спавна:
   `netSpawn(slot)` возвращает `{x,y,z}` — для плоских карт прежняя сетка `NET_SPAWNS`
   у нуля, для лесной трассы — точки вдоль дороги у старта на высоте рельефа
   (`GROUND_REST + forestTerrain`); при старте борта стоят рядом, а не в одной точке.
   `loadLevel()` сбрасывает дрон в `lv.start`, поэтому после него
   `netPlaceLocalAtSpawn()` переставляет местный борт в свой слот (и разворачивает по `lv.start.yaw`).
8. **Persist ключи**: `pioneer-web-fly-cfg` (сборка), `pioneer-web-fly-mode`
   (Angle/Acro), `pioneer-web-fly-gamepad` (расклад пульта).

## 🔒 Nginx сервера (не ломать) — `fly.nayanovaacademy.ru`

- `:80` → 301 https; `:443 ssl http2`; TLS 1.2/1.3 и шифры — как у pioneer.
- Wildcard-сертификат `/etc/ssl/certs/nayanovaacademy.ru/cert.pem` + `.../key.pem`.
- `root /var/www/fly.nayanovaacademy.ru/public; try_files $uri $uri/ =404; autoindex off;`
- Security-набор (HSTS, XFO DENY, nosniff, Referrer/Permissions-Policy, CSP
  default-src self …) дублируется В КАЖДОМ location со своим `add_header` —
  nginx не наследует add_header при наличии собственного.
- Скрытые файлы: `location ~ /\.` → deny.

## 🧪 Проверки (вручную; тестов и CI нет)

- Локально: `node --check public\app.js` (синтаксис), осмотр `style.css`-скобки,
  `php -l` по всем файлам `server/` и `public/api/`.
- Как минимум после каждого деплоя: `https://fly.nayanovaacademy.ru/` → 200,
  `Cache-Control: no-cache` на HTML и на `app.js` (иначе браузеры залипнут),
  `/app.js`, `/style.css`, `/three.module.min.js` → 200 c правильными MIME.
- Бэкенд: `POST /api/signal/*` (`rooms/create/join/find/exchange/ice/leave`)
  анонимно → `401`; direct-запрос любого другого `.php` → `404`. С валидной кукой:
  хост создаёт игру, 1–4 участника подключаются, хост меняет карту/режим и
  стартует — состав, имена и карта приходят всем, окно закрывается само; выход
  хоста переназначает хоста.
- TURN: `systemctl is-active coturn` → active, порт `3478` слушается, relay из
  `49160-49200` выделяется. Проверка авторизации: сгенерировать креденшел
  (`username = now+3600:uid`, `credential = base64(hmac-sha1(secret, username))`)
  и прогнать `turnutils_uclient -u <user> -w <cred> 127.0.0.1` — должно дойти до
  channel bind (`403 Forbidden IP` на loopback-пир — норма, значит auth прошёл).
- Регрессия-«горизонт»: линии горизонта FPV-HUD НЕ дублируются и не зеркалят
  (позади камеры — не рисуем).
- Регрессия-мобильный: `#help`/`#hud`/`#levelbar` скрыты на coarse; «☰» открывает
  всё меню; стики тянутся пальцем.

## Известные ловушки (уже решены, не повторять)

- inline-скрипт/importmap → CSP блокирует: страница молча не работает;
- immutable кэш на файлах без `?v=` → «кнопка не работает» после деплоя;
- `menuBtnEl` объявляется ниже по файлу, чем его обработчик инициализации —
  нельзя на неё ссылаться при module-init (использовать `getElementById` локально);
- Gamepad API: 2 устройства от одного пульта (дубль-интерфейс) — нужен
  автовыбор «живого» + ручной селектор;
- Windows PowerShell: inline-regex c backtick/каретками — писать патчи в .mjs-файлы.
