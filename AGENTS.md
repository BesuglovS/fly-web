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
- **Свободный полёт**: карты Луг / Город / Каньон (процедурный декор).
- **USB-пульт**: Gamepad API (BetaFPV и любой HID), калибровка/назначение осей
  и кнопок, config в localStorage; статус в HUD.
- **Клавиатура**: WASD + стрелки; **мышь/тач**: тянутся виртуальные стики
  (мультитач); сервисные клавиши: C — камера, F — режим, M — модель, R — заново,
  N — след. уровень, 1…9/0 — выбор уровня, Esc — меню.
- **FPV-вид** (4-й режим камеры): камера в носу, FOV 105°, canvas-оверлей:
  авиагоризонт (лестница тангажа), шкала крена-дуга, компас-лента,
  SPD/ALT/вариометр, «НИЗКАЯ ВЫСОТА». Рисуется ТОЛЬКО в режиме FPV.
- **Сетевая игра**: WebRTC DataChannel без сервера (обмен кодами offer/answer),
  синхронизация аппаратов 20 Гц (позиция + кватернион), аппарат соперника — клон меша.
- **Мобильные**: крупнее тач-зона, авто-даунскейл разрешение (замер каждые 3 с),
  antialias выключен, тени 1024, подсказка о повороте (портрет), fullscreen.
  Интерфейс скрыт: остаётся 3D + стики + маленькая «☰» (правый верх):
  она открывает старт-экран со всем меню (модель, режим, камера, уровни/карты,
  пульт, сеть, fullscreen).

## ⚠ Критические правила

1. **Правки только в `public/`** — там весь контент:
   - `index.html` — разметка UI (HUD `#hud`, строка уровня `#levelbar`,
     легенда `#legend` + кнопки, старт-экран `#startScreen` > `#stCard`,
     модалки `#gpModal`, `#cfgModal`, `#netModal`, `#overlay`, `#fpvHud`,
     стики `#stickLeft/#stickRight`, `#rotateHint`);
   - `style.css` — все стили (включая `@media (pointer: coarse)`-правила);
   - `app.js` — вся логика (см. «Конвенции» ниже);
   - `three.module.min.js` — локальная копия three.js r160 (670 КБ);
     не редактировать, не заменять на CDN.
2. **Никаких inline `<style>`/`<script>`, importmap и внешних CDN** —
   CSP сервера строгая (`script-src/style-src 'self'`); inline-код заблокируется
   и сломает страницу в проде. three.js импортируется относительным путём
   `./three.module.min.js`. Раньше стоял importmap/unpkg — убран именно поэтому.
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

## 🏗 Структура

```
public/                 # вся страница (см. правило 1)
fly.nayanovaacademy.ru  # nginx-конфиг: 80→301; wildcard cert.pem/key.pem;
                        # security-набор продублирован в каждом location с add_header
deploy.ps1              # см. «Команды»
.env / .env.example     # DEPLOY_SSH_HOST/PORT/USER/KEY/DEPLOY_REMOTE_PATH
AGENTS.md               # этот файл
```

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
2. **Модель**: каталог `DRONE_MODELS` (Мини 2 / Базовый / FPV Racing / Гекса);
   узлы `MOTOR_OPTS / PROP_OPTS / BATTERY_OPTS`; пользовательская сборка — `cfg`,
   итоговые множители — `perf` (`updatePerf()`); меш — `makeDroneMesh(model)`
   (4 или 6 моторов, цвета-токены: перед красный / зад белый / борта зелено-синие);
   пересборка — `rebuildDroneModel()` (при смене модели/узлов — тоже).
   **Батарея**: `batteryCharge` (0..1), расход по газу, <15% — тяга падает до 25%;
   полный заряд на новом уровне; HUD-строка «Аккум.» краснеет <20% (класс `.bat-low`).
3. **Ориентация**: `state.quat` — кватернион (каноническая); в Angle — из Euler
   каждый кадр, в Acro — честная кватернионная интеграция:
   `quat.multiply(ΔQ(pitch/roll))` вокруг ЛОКАЛЬНЫХ осей, рыскание —
   `premultiply` вокруг МИРОВОЙ вертикали (включая снос `biasYaw` при отказе);
   углы `pitch/yaw/roll` для HUD извлекаются `Euler('YXZ')` после шага.
   Автовыравнивание в Acro НЕТ; на земле — slerp к уровню (общий `integrateDrone`).
4. **Ввод**: указатель `setupStick` (pointer capture, мультитач) + клавиатура + пульт.
   Пульт: `gamepad` опрос каждый кадр + форс-рескан по жестам/интервал
   (Chrome скрывает устройства до первого действия!); автовыбор «живого» устройства
   + ручной селектор `#gpDevice`; оси `yaw/throttle/pitch/roll`, инверсия,
   мёртвая зона; кнопки cam/reset/next/arm; конфиг в localStorage
   `pioneer-web-fly-gamepad`.
5. **Уровни**: `LEVELS` (15 шт.); ворота `ring|hover|heading|altitude|land`;
   ограничения `constraints.{maxAlt,maxSpeed,maxRoll}` / `timeLimit` / `emergency`;
   звёзды по времени; подсказка — голубой стрелкой-указателем;
   уровень-меню — через старт-экран.
6. **HUD**: телеметрия в `#hud` (обновление DOM ежекадрово — дешёво); строка уровня
   `#levelbar` (objective, лимит времени, предупреждения); FPV-оверлей —
   `drawFpvHud()` (canvas 2d поверх WebGL, только при `camMode===3`).
7. **Сеть**: `net`-объект; роль host/guest; DataChannel `fly` (ordered:false);
   протокол JSON `{t:'hello'|'st', p:[x,y,z], q:[x,y,z,w]}`; peer-меш — клон
   мини-2, интерполяция lerp/slerp, 50 мс тики приёма/отправки; без соединения скрыт.
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

- Локально: `node --check public\app.js` (синтаксис), осмотр `style.css`-скобки.
- Как минимум после каждого деплоя: `https://fly.nayanovaacademy.ru/` → 200,
  `Cache-Control: no-cache` на HTML и на `app.js` (иначе браузеры залипнут),
  `/app.js`, `/style.css`, `/three.module.min.js` → 200 c правильными MIME.
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
