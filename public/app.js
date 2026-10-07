import * as THREE from './three.module.min.js';

/* ============================================================
   Константы симуляции
   ============================================================ */
const GROUND_REST   = 0.6;     // высота покоя корпуса над землёй
const HOVER_THROTTLE = 0.5;    // газ, при котором дрон висит
const MAX_SPEED     = 14;      // м/с по горизонтали
const MAX_CLIMB     = 6;       // м/с по вертикали
const MAX_YAW_RATE  = 1.9;     // рад/с
const MAX_PITCH     = 0.55;    // рад (~31°)
const MAX_ROLL      = 0.65;    // рад (~37°)
const LEVEL_RATE    = 9.0;     // скорость авто-выравнивания (повышена — меньше инерции)
const ACCEL_RATE    = 5.5;     // сглаживание горизонтальной скорости (меньше инерции/выбега)
const CLIMB_RATE    = 4.5;     // сглаживание вертикальной скорости (меньше инерции)
const WORLD_LIMIT   = 240;

/* ============================================================
   Мобильные устройства: определения и оптимизации рендера
   ============================================================ */
const isMobile = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
let renderScale = isMobile ? 1.25 : 1.5;
/* статистика кадров для адаптивного качества */
let qFrames = 0, qTime = 0;

/* ============================================================
   Авторизация через портал auth-web (SSO)
   Кука auth_session домена .nayanovaacademy.ru валидируется браузерным
   запросом к /api/check.php (CORS+credentials). Вход/выход — навигацией
   на портал с редиректом обратно. Анонимный вход разрешён: симулятор
   полностью доступен и без авторизации.
   ============================================================ */
const AUTH_BASE   = 'https://auth.nayanovaacademy.ru';
const AUTH_CHECK  = AUTH_BASE + '/api/check.php';
let authUser = null;         // {id,login,display_name,is_admin} | null
let authUnavailable = false; // true — auth-web не ответил/ошибка сети

function authLoginUrl(){
  return AUTH_BASE + '/index.php?page=login&redirect=' + encodeURIComponent(location.href);
}
function authLogoutUrl(){
  return AUTH_BASE + '/api/logout.php?redirect=' + encodeURIComponent(location.href);
}

/* Проверка сессии. Возвращает профиль пользователя либо null. */
async function checkAuth(){
  try{
    const res = await fetch(AUTH_CHECK, { credentials:'include', headers:{ 'Accept':'application/json' } });
    if(!res.ok){ authUnavailable = true; return null; }
    const data = await res.json();
    if(data && data.authenticated && data.user) return data.user;
    return null;
  }catch(_){
    authUnavailable = true;
    return null;
  }
}

/* Отрисовка состояния входа в панели «Управление» и на стартовом экране. */
function renderAuth(){
  const nameEl   = document.getElementById('authName');
  const loginEl  = document.getElementById('authLogin');
  const logoutEl = document.getElementById('authLogout');
  const boxEl    = document.getElementById('authBox');

  if(authUser){
    if(nameEl) nameEl.textContent = authUser.display_name || authUser.login || 'Пользователь';
    if(loginEl) loginEl.classList.add('auth-hidden');
    if(logoutEl){ logoutEl.classList.remove('auth-hidden'); logoutEl.href = authLogoutUrl(); }
  }else{
    if(nameEl) nameEl.textContent = authUnavailable ? 'Портал входа недоступен' : 'Гость';
    if(loginEl){ loginEl.classList.remove('auth-hidden'); loginEl.href = authLoginUrl(); }
    if(logoutEl) logoutEl.classList.add('auth-hidden');
  }
  if(boxEl) boxEl.classList.toggle('auth-unavailable', authUnavailable && !authUser);

  const stBtn = document.getElementById('stAuthBtn');
  if(stBtn){
    if(authUser){
      stBtn.textContent = '👤 ' + (authUser.display_name || authUser.login) + ' — выйти';
      stBtn.href = authLogoutUrl();
    }else if(authUnavailable){
      stBtn.textContent = '⚠ Портал входа временно недоступен';
      stBtn.href = AUTH_BASE;
    }else{
      stBtn.textContent = '🔑 Войти через портал';
      stBtn.href = authLoginUrl();
    }
  }
}

async function initAuth(){
  authUser = await checkAuth();
  renderAuth();
}
renderAuth();   // немедленно проставляем ссылки входа/название «Гость»
initAuth();     // фоновая проверка сессии — не блокирует запуск симулятора

/* ============================================================
   Рендерер / сцена / камера
   ============================================================ */
const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias:!isMobile, powerPreference:'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, renderScale));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.domElement.style.touchAction = 'none';
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xaec9e6, 120, 320);

const camera = new THREE.PerspectiveCamera(62, innerWidth/innerHeight, 0.1, 1200);
camera.position.set(0, 4, -9);

/* ---------- Небо (градиентный купол) ---------- */
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(600, 32, 16),
  new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite:false,
    uniforms:{ top:{value:new THREE.Color(0x2b6fd6)}, bottom:{value:new THREE.Color(0xdcecff)} },
    vertexShader:`varying vec3 vP; void main(){ vP=(modelMatrix*vec4(position,1.0)).xyz; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);} `,
    fragmentShader:`varying vec3 vP; uniform vec3 top; uniform vec3 bottom;
      void main(){ float h=clamp(normalize(vP).y*0.5+0.5,0.0,1.0); gl_FragColor=vec4(mix(bottom,top,pow(h,0.8)),1.0);} `
  })
);
scene.add(sky);

/* ---------- Свет ---------- */
scene.add(new THREE.HemisphereLight(0xdff0ff, 0x3a5a3a, 1.05));
const sun = new THREE.DirectionalLight(0xfff3d6, 1.9);
sun.position.set(60, 90, 40);
sun.castShadow = true;
sun.shadow.mapSize.set(isMobile?1024:2048, isMobile?1024:2048);
const sc = sun.shadow.camera;
sc.left=-90; sc.right=90; sc.top=90; sc.bottom=-90; sc.near=1; sc.far=300;
sc.updateProjectionMatrix();
sun.shadow.bias = -0.0005;
scene.add(sun);
scene.add(sun.target);

/* ============================================================
   Земля и ориентиры
   ============================================================ */
function makeGroundTexture(){
  const s=256, c=document.createElement('canvas'); c.width=c.height=s;
  const g=c.getContext('2d');
  g.fillStyle='#3f6b43'; g.fillRect(0,0,s,s);
  g.fillStyle='#467a4a'; g.fillRect(0,0,s/2,s/2); g.fillRect(s/2,s/2,s/2,s/2);
  g.strokeStyle='rgba(255,255,255,.10)'; g.lineWidth=2; g.strokeRect(0,0,s,s);
  g.strokeStyle='rgba(0,0,0,.12)'; g.beginPath(); g.moveTo(s/2,0); g.lineTo(s/2,s); g.moveTo(0,s/2); g.lineTo(s,s/2); g.stroke();
  const t=new THREE.CanvasTexture(c);
  t.wrapS=t.wrapT=THREE.RepeatWrapping; t.repeat.set(160,160);
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(1200,1200),
  new THREE.MeshStandardMaterial({ map:makeGroundTexture(), roughness:1, metalness:0 })
);
ground.rotation.x = -Math.PI/2;
ground.receiveShadow = true;
scene.add(ground);

/* ---------- Посадочная площадка в центре ---------- */
const pad = new THREE.Mesh(
  new THREE.CylinderGeometry(5,5,0.12,48),
  new THREE.MeshStandardMaterial({ color:0x2a3440, roughness:.9 })
);
pad.position.y = 0.06; pad.receiveShadow = true; scene.add(pad);
const padRing = new THREE.Mesh(
  new THREE.TorusGeometry(4.6,0.16,10,64),
  new THREE.MeshStandardMaterial({ color:0xffd23f, emissive:0x6b5200, roughness:.5 })
);
padRing.rotation.x = Math.PI/2; padRing.position.y=0.14; scene.add(padRing);

/* ---------- Деревья ---------- */
function makeTree(x,z,s=1){
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.18*s,0.24*s,1.6*s,7),
    new THREE.MeshStandardMaterial({ color:0x6b4b2a, roughness:1 })
  );
  trunk.position.y = 0.8*s; trunk.castShadow=true; g.add(trunk);
  const leafMat = new THREE.MeshStandardMaterial({ color:0x2f7d3a, roughness:1 });
  for(let i=0;i<2;i++){
    const cone = new THREE.Mesh(new THREE.ConeGeometry(1.5*s-i*0.4*s, 2.2*s, 8), leafMat);
    cone.position.y = 1.9*s + i*1.1*s; cone.castShadow=true; g.add(cone);
  }
  g.position.set(x,0,z);
  return g;
}

/* ---------- Кольца-ворота ---------- */
function makeRing(x,y,z,color){
  const g = new THREE.Group();
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(3.1,0.28,12,48),
    new THREE.MeshStandardMaterial({ color, emissive:color, emissiveIntensity:.35, roughness:.4 })
  );
  ring.castShadow = true;
  g.add(ring);
  g.position.set(x,y,z);
  return g;
}

/* Детерминированный псевдослучайный генератор */
let seed = 1337;
function rnd(){ seed = (seed*1664525 + 1013904223) % 4294967296; return seed/4294967296; }

/* Корень для объектов текущего уровня (перестраивается при загрузке) */
const levelRoot = new THREE.Group();
scene.add(levelRoot);

/* ============================================================
   Модель БПЛА — с чёткой ориентацией
   Локальные оси: +Z = ПЕРЕД, +X = ЛЕВО, -X = ПРАВО, -Z = ЗАД
   ============================================================ */

const DRONE_MODELS = [
  { id:'mini2',  name:'Мини', desc:'Образовательный: спокойный и послушный.',
    scale:1.0,  bodyColor:0x2c3138, thrustMul:1.0,  speedMul:1.0,  climbMul:1.0,  dragMul:1.0,  baseCap:3500 },
  { id:'base',   name:'Базовый', desc:'Платформа-конструктор: устойчивый, тяговитый.',
    scale:1.22, bodyColor:0x252d38, thrustMul:1.25, speedMul:0.82, climbMul:0.92, dragMul:1.12, baseCap:5200 },
  { id:'racing', name:'FPV Racing', desc:'Гоночный: резкий отклик, максимальная скорость.',
    scale:0.85, bodyColor:0x1a1e26, thrustMul:1.5,  speedMul:1.55, climbMul:1.4,  dragMul:0.55, baseCap:1300 },
  { id:'hexa',   name:'Гекса-разведчик', desc:'6 моторов: инерционный, большой запас тяги.',
    scale:1.35, bodyColor:0x394855, thrustMul:1.7,  speedMul:0.72, climbMul:0.78, dragMul:1.4,  baseCap:7000 },
];

/* узлы: моторы / винты / аккумуляторы */
const MOTOR_OPTS = [
  { id:'0802', name:'0802 · лёгкие',      thrust:0.62, rate:1.15, mass:0.8  },
  { id:'2306', name:'2306 · стандартные', thrust:1.0,  rate:1.0,  mass:1.0  },
  { id:'2807', name:'2807 · тяговитые',   thrust:1.45, rate:0.8,  mass:1.35 },
];
const PROP_OPTS = [
  { id:'2', name:'2" скоростные',    thrust:0.7,  drag:0.8,  rad:0.35 },
  { id:'3', name:'3" универсальные', thrust:1.0,  drag:1.0,  rad:0.5  },
  { id:'5', name:'5" дальнего полёта', thrust:1.3, drag:1.35, rad:0.68 },
];
const BATTERY_OPTS = [
  { id:'2s', name:'2S (7.4 В, 5200 мА·ч)',  thrust:0.7,  cap:1.25 },
  { id:'3s', name:'3S (11.1 В, 3000 мА·ч)', thrust:0.88, cap:1.0  },
  { id:'4s', name:'4S (14.8 В, 1500 мА·ч)', thrust:1.06, cap:0.8  },
  { id:'6s', name:'6S (22.2 В, 650 мА·ч)',  thrust:1.3,  cap:0.5  },
];

/* --- пользовательская сборка (localStorage) --- */
const CFG_KEY = 'pioneer-web-fly-cfg';
const DEFAULT_CFG = { model:0, motor:1, prop:1, battery:2, map:'meadow' };
function loadCfg(){
  try{
    const raw = localStorage.getItem(CFG_KEY);
    if(!raw) return { ...DEFAULT_CFG };
    return { ...DEFAULT_CFG, ...(JSON.parse(raw)||{}) };
  }catch(_){ return { ...DEFAULT_CFG }; }
}
function saveCfg(){
  try{ localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); }catch(_){}
}
const cfg = loadCfg();

let batteryCharge = 1;   // 0..1 (0 — пустая батарея)
const BASE_ENDURANCE = 540;   // сек полёта на полном заряде для эталонной сборки

function model(){
  const idx = Math.max(0, Math.min(DRONE_MODELS.length-1, cfg.model|0));
  return DRONE_MODELS[idx] || DRONE_MODELS[0];
}

/* расчётные характеристики текущей сборки */
const perf = { thrust:1, maxSpeed:1, climb:1, drag:1, rate:1, cap:1 };
function updatePerf(){
  const m  = model();
  const mt = MOTOR_OPTS[cfg.motor] || MOTOR_OPTS[1];
  const pr = PROP_OPTS[cfg.prop]   || PROP_OPTS[1];
  const bt = BATTERY_OPTS[cfg.battery] || BATTERY_OPTS[2];
  perf.thrust   = m.thrustMul * mt.thrust * pr.thrust * bt.thrust;
  perf.maxSpeed = m.speedMul * (0.72 + 0.28 * pr.thrust);
  perf.climb    = m.climbMul * (0.75 + 0.25 * pr.thrust) * (0.8 + 0.2 * bt.thrust);
  perf.drag     = m.dragMul * pr.drag;
  perf.rate     = mt.rate;
  perf.cap      = bt.cap * (0.55 + 0.45 * m.scale) * (m.baseCap / 3500);
}

let drone = new THREE.Group();
drone.rotation.order = 'YXZ';
scene.add(drone);

function makeSideStripe(g, sign, color, s){
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(0.04*s,0.13*s,0.86*s),
    new THREE.MeshStandardMaterial({ color, emissive:color, emissiveIntensity:.45, roughness:.5 })
  );
  m.position.set(sign*0.27*s,0,0);
  g.add(m);
}

/* цвета ориентации: перед/зад/лево/право */
const COL_FRONT = 0xff3b30;
const COL_BACK  = 0xf2f2f2;
const COL_LEFT  = 0x39d353;
const COL_RIGHT = 0x3b9dff;

function makeArmMesh(g, from, to, color){
  const dir = to.clone().sub(from);
  const len = dir.length();
  const arm = new THREE.Mesh(
    new THREE.CylinderGeometry(0.055,0.07,len,8),
    new THREE.MeshStandardMaterial({ color, emissive:color, emissiveIntensity:.25, metalness:.3, roughness:.5 })
  );
  arm.position.copy(from).add(to).multiplyScalar(0.5);
  arm.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0), dir.normalize());
  arm.castShadow = true;
  g.add(arm);
}

function makeDroneMesh(m){
  const g = new THREE.Group();
  g.rotation.order = 'YXZ';
  const s = m.scale;
  const props = [];

  /* корпус */
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.52*s,0.24*s,1.05*s),
    new THREE.MeshStandardMaterial({ color:m.bodyColor, metalness:.45, roughness:.45 })
  );
  body.castShadow = true; body.receiveShadow = true; g.add(body);

  makeSideStripe(g,  1, COL_LEFT,  s);
  makeSideStripe(g, -1, COL_RIGHT, s);

  /* нос — красный конус вперед (+Z) */
  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(0.2*s,0.42*s,16),
    new THREE.MeshStandardMaterial({ color:COL_FRONT, emissive:COL_FRONT, emissiveIntensity:.3, roughness:.4 })
  );
  nose.rotation.x = Math.PI/2;
  nose.position.set(0,0,0.7*s); nose.castShadow = true; g.add(nose);

  /* камера-гимбал под носом */
  const gimbal = new THREE.Mesh(
    new THREE.SphereGeometry(0.13*s,18,14),
    new THREE.MeshStandardMaterial({ color:0x0a0e12, metalness:.6, roughness:.2 })
  );
  gimbal.position.set(0,-0.16*s,0.64*s); g.add(gimbal);
  const lens = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05*s,0.05*s,0.05*s,14),
    new THREE.MeshStandardMaterial({ color:0x66ccff, emissive:0x1a5f8f, emissiveIntensity:.8 })
  );
  lens.rotation.x = Math.PI/2; lens.position.set(0,-0.16*s,0.77*s); g.add(lens);

  /* моторы: 4 (X-схема: два спереди, два сзади) или 6, по кругу;
     передние — красные, задние — белые */
  const hexa = (m.id === 'hexa');
  const armLen = (hexa ? 0.78 : 0.62) * s;
  const cnt = hexa ? 6 : 4;
  const conf = [];
  for(let i=0;i<cnt;i++){
    /* у квадрокоптера сдвигаем на полшага — моторы встают по диагоналям */
    const a = (i + (hexa ? 0 : 0.5)) * (Math.PI*2/cnt);
    const x = Math.sin(a)*armLen, z = Math.cos(a)*armLen;
    conf.push({ pos:new THREE.Vector3(x,0.12*s,z), front: z>0, dir: (i%2===0?1:-1) });
  }
  conf.forEach(mo=>{
    const c = mo.front ? COL_FRONT : COL_BACK;
    makeArmMesh(g, new THREE.Vector3(0,0,0), mo.pos, c);

    const motor = new THREE.Mesh(
      new THREE.CylinderGeometry(0.11*s,0.11*s,0.16*s,14),
      new THREE.MeshStandardMaterial({ color:0x1b1f24, metalness:.6, roughness:.4 })
    );
    motor.position.copy(mo.pos); motor.castShadow = true; g.add(motor);

    const hub = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05*s,0.05*s,0.06*s,10),
      new THREE.MeshStandardMaterial({ color:0x555b63, metalness:.7, roughness:.35 })
    );
    hub.position.copy(mo.pos).add(new THREE.Vector3(0,0.1*s,0)); g.add(hub);

    const propScale = (PROP_OPTS[cfg.prop] ? PROP_OPTS[cfg.prop].rad : 0.5) * 1.56;
    const blLen = 0.78 * propScale;
    const bladeMat = new THREE.MeshStandardMaterial({
      color: mo.front ? COL_FRONT : COL_BACK,
      emissive: mo.front ? COL_FRONT : COL_BACK,
      emissiveIntensity: mo.front ? 0.35 : 0.12, roughness:.5 });
    const prop = new THREE.Group();
    const b1 = new THREE.Mesh(new THREE.BoxGeometry(blLen,0.02*s,0.09*s), bladeMat);
    const b2 = new THREE.Mesh(new THREE.BoxGeometry(blLen,0.02*s,0.09*s), bladeMat);
    b2.rotation.y = Math.PI/2;
    prop.add(b1,b2);
    prop.position.copy(mo.pos).add(new THREE.Vector3(0,0.14*s,0));
    prop.userData.dir = mo.dir;
    g.add(prop);
    props.push(prop);
  });

  /* навигационные огни: лево — зелёный, право — синий, хвост — белый */
  conf.forEach(mo=>{
    const l = new THREE.Mesh(
      new THREE.SphereGeometry(0.07*s,10,8),
      new THREE.MeshStandardMaterial({
        color: mo.pos.x>0 ? COL_LEFT : COL_RIGHT,
        emissive: mo.pos.x>0 ? COL_LEFT : COL_RIGHT,
        emissiveIntensity:1.2 })
    );
    l.position.set(mo.pos.x,0.2*s,mo.pos.z); g.add(l);
  });
  const tail = new THREE.Mesh(
    new THREE.SphereGeometry(0.06*s,10,8),
    new THREE.MeshStandardMaterial({ color:0xffffff, emissive:0xffffff, emissiveIntensity:1.2 })
  );
  tail.position.set(0, 0.06*s, -0.56*s); g.add(tail);

  return { group: g, props };
}

let propellers = [];
function rebuildDroneModel(){
  const built = makeDroneMesh(model());
  scene.remove(drone);
  disposeTree(drone);
  drone = built.group;
  propellers = built.props;
  scene.add(drone);
}

updatePerf();
rebuildDroneModel();

/* тень-пятно под дроном для лучшего ощущения высоты */
const shadowBlob = new THREE.Mesh(
  new THREE.CircleGeometry(1.2,32),
  new THREE.MeshBasicMaterial({ color:0x000000, transparent:true, opacity:0.28, depthWrite:false })
);
shadowBlob.rotation.x = -Math.PI/2;
shadowBlob.position.y = 0.02;
scene.add(shadowBlob);

/* ============================================================
   Состояние дрона
   ============================================================ */
const state = {
  pos: new THREE.Vector3(0, GROUND_REST, 0),
  vel: new THREE.Vector3(),
  yaw: 0, pitch: 0, roll: 0,
  quat: new THREE.Quaternion()   // каноническая ориентация (acro — кватернионная интеграция)
};

/* ============================================================
   Режимы полёта: 'angle' (автостабилизация) и 'acro'
   ============================================================ */
const FM_KEY = 'pioneer-web-fly-mode';
const FLIGHT_MODES = { angle:'Angle', acro:'Acro' };
let flightMode = 'angle';
try{ const sv = localStorage.getItem(FM_KEY); if(sv && FLIGHT_MODES[sv]) flightMode = sv; }catch(_){}

function setFlightMode(m){
  if(!FLIGHT_MODES[m] || m === flightMode) return;
  flightMode = m;
  try{ localStorage.setItem(FM_KEY, m); }catch(_){}
  updateFlightModeUI();
}

function updateFlightModeUI(){
  const btn = document.getElementById('modeBtn');
  if(btn) btn.textContent = 'Режим: ' + FLIGHT_MODES[flightMode];
}
function toggleFlightMode(){ setFlightMode(flightMode === 'angle' ? 'acro' : 'angle'); }

/* ============================================================
   Ввод: виртуальные стики (мышь + тач) + клавиатура
   ============================================================ */
const stickL = { x:0, y:0 };
const stickR = { x:0, y:0 };
const keys = {};
const sticks = [];

function knobRadius(el){
  return Math.max(1, el.getBoundingClientRect().width/2 - 16);
}

function setupStick(el, out){
  const knob = el.querySelector('.knob');
  let activeId = null;
  let dragging = false;

  function apply(e){
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width/2, cy = r.top + r.height/2;
    const max = r.width/2 - 16;
    let dx = e.clientX - cx, dy = e.clientY - cy;
    const d = Math.hypot(dx,dy);
    if(d > max){ dx = dx/d*max; dy = dy/d*max; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    out.x = dx/max;
    out.y = -dy/max;   // вверх = +1
  }
  function reset(){
    activeId = null;
    dragging = false;
    knob.style.transform = 'translate(0,0)';
    out.x = 0; out.y = 0;
  }

  el.addEventListener('pointerdown', e=>{
    if(activeId !== null) return;
    activeId = e.pointerId;
    dragging = true;
    try{ el.setPointerCapture(e.pointerId); }catch(_){}
    apply(e); e.preventDefault();
  });
  el.addEventListener('pointermove', e=>{
    if(e.pointerId !== activeId) return;
    apply(e); e.preventDefault();
  });
  const end = e=>{ if(e.pointerId === activeId) reset(); };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('lostpointercapture', end);

  sticks.push({ el, knob, out, isDragging: ()=>dragging });
}
setupStick(document.getElementById('stickLeft'), stickL);
setupStick(document.getElementById('stickRight'), stickR);

// Отрисовка положения ручек с учётом суммарного ввода (стик + клавиатура).
// Пока стик перетаскивают мышью/пальцем — не трогаем (им управляет pointermove).
function syncStickVisuals(lx, ly, rx, ry){
  const pairs = [[lx,ly],[rx,ry]];
  sticks.forEach((s, i)=>{
    if(s.isDragging()) return;
    const [x, y] = pairs[i];
    const max = knobRadius(s.el);
    s.knob.style.transform = `translate(${x*max}px, ${-y*max}px)`;
  });
}

addEventListener('keydown', e=>{
  /* пока открыт стартовый экран — игровые клавиши не работают (кроме Esc) */
  if(stStep !== 0 && e.code !== 'Escape') return;
  keys[e.code] = true;
  if(e.code === 'KeyC') cycleCamera();
  if(e.code === 'KeyR') resetDrone();
  if(e.code === 'KeyN') nextLevel();
  if(e.code === 'KeyF') toggleFlightMode();
  if(e.code === 'KeyM') openCfgModal();
  if(e.code === 'Escape') closeLevelMenu();
  if(e.code.startsWith('Digit')){
    const n = parseInt(e.code.slice(5),10);
    /* 1…9 — уровни 1–9, 0 — уровень 10; далее — клавиша N или меню */
    const idx = (n === 0) ? 9 : n - 1;
    if(idx >= 0 && idx < LEVELS.length) loadLevel(idx);
  }
  if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) e.preventDefault();
});
addEventListener('keyup', e=>{ keys[e.code] = false; });
addEventListener('blur', ()=>{ for(const k in keys) keys[k]=false; });

const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));
const deadzone = (v, dz)=>Math.abs(v) < dz ? 0 : (v - Math.sign(v)*dz) / (1 - dz);

/* ============================================================
   Пульт (Gamepad API) — BetaFPV и любой USB-джойстик/HID
   Расклад по умолчанию: Mode 2 (левый стик — газ/рыскание,
   правый — тангаж/крен). Значения осей для каждого пульта
   уточняются в окне калибровки и хранятся в localStorage.
   ============================================================ */
const GP_KEY = 'pioneer-web-fly-gamepad';

// Смысловые каналы: какую ось Джойстика во что превращаем.
const GP_CHANNELS = [
  { id:'yaw',      label:'Рыскание',  group:'left',  def: 0,     invert:false },
  { id:'throttle', label:'Газ',       group:'left',  def: 1,     invert:true  },
  { id:'pitch',    label:'Тангаж',    group:'right', def: 3,     invert:true  },
  { id:'roll',     label:'Крен',      group:'right', def: 2,     invert:false },
];

const DEFAULT_GP = {
  enabled: true,
  axes: { yaw:0, throttle:1, pitch:3, roll:2 },
  invert: { yaw:false, throttle:true, pitch:true, roll:false },
  deadzone: 0.06,
  throttleMode: 'centered',   // 'centered' — самовозвратный стик (Mode 2), 'full' — от края до края
  armButton: -1,              // кнопка «взвести» (значение индекса Gamepad API), -1 = без кнопки
};

function gpClone(o){ return JSON.parse(JSON.stringify(o)); }

function loadGpConfig(){
  try{
    const raw = localStorage.getItem(GP_KEY);
    if(!raw) return gpClone(DEFAULT_GP);
    const saved = JSON.parse(raw);
    return {
      ...gpClone(DEFAULT_GP),
      ...saved,
      axes:   { ...DEFAULT_GP.axes,   ...(saved.axes||{}) },
      invert: { ...DEFAULT_GP.invert, ...(saved.invert||{}) },
    };
  }catch(_){ return gpClone(DEFAULT_GP); }
}
function saveGpConfig(cfg){
  try{ localStorage.setItem(GP_KEY, JSON.stringify(cfg)); }catch(_){}
}

const gamepad = {
  config: loadGpConfig(),
  raw: null,          // Gamepad из навигатора (сырой)
  list: [],           // все активные устройства [{index, id, axes, buttons, moved}]
  connected: false,
  id: '',
  axisIndex: -1,      // индекс выбранного устройства
  preferredIndex: null, // ручной выбор устройства (или авто)
  axes: [],           // сырые значения осей выбранного устройства
  buttons: [],        // сырые значения кнопок выбранного устройства
  active: false,      // используется ли пульт как источник управления
  armLatch: false,    // для кнопки arm — фиксируем нажатие
  count: 0,           // сколько активных устройств видит браузер
  lastActivity: 0,
};
let gpCalOpen = false;
let gpAssigning = null;   // канал, ожидающий назначения оси

/* ============================================================
   WebHID — прямое чтение HID-отчётов в обход Gamepad API.
   Нужен для пультов (BetaFPV и др.), которые Windows видит
   (joy.cpl), но Chrome в gamepad-список не добавляет из-за
   нестандартного дескриптора. Пульт подключается кнопкой в
   окне «Настройка пульта» и далее используется как обычное
   устройство — калибровка осей и кнопок работает так же.
   ============================================================ */
const WEBHID_PAD_INDEX = 1000;   // синтетический индекс «устройства»
const HID_AXIS_USAGES = new Set([0x30,0x31,0x32,0x33,0x34,0x35,0x36,0x37,0x38]);

const webhid = {
  supported: !!(navigator.hid && navigator.hid.addEventListener),
  device: null,
  opened: false,
  id: '',
  axes: [],
  buttons: [],
  layouts: null,      // Map<reportId, layout>
  moved: false,
  lastActivity: 0,
};

function webhidConnected(){ return webhid.opened && !!webhid.device; }

/* Отдаёт WebHID-пульт в том же виде, что и Gamepad из навигатора. */
function webhidPseudoPad(){
  if(!webhidConnected()) return null;
  return {
    index: WEBHID_PAD_INDEX,
    id: webhid.id || 'USB HID пульт',
    connected: true,
    axes: webhid.axes,
    buttons: webhid.buttons,
    moved: webhid.moved,
  };
}

/* Разбираем дескриптор: какие биты каждого отчёта — это оси и кнопки. */
function webhidBuildLayouts(device){
  const layouts = new Map();
  const seen = new Set();
  const visit = (cols)=>{
    for(const c of (cols || [])){
      for(const r of (c.inputReports || [])){
        if(seen.has(r.reportId)) continue;
        seen.add(r.reportId);
        let layout = webhidBuildReport(r, false);
        /* Нестандартный дескриптор (vendor usage) — пробуем по размеру полей. */
        if(!layout.axisCount && !layout.buttonCount) layout = webhidBuildReport(r, true);
        layouts.set(r.reportId, layout);
      }
      if(c.children && c.children.length) visit(c.children);
    }
  };
  visit(device.collections || []);
  return layouts;
}

function webhidBuildReport(report, loose){
  let bit = 0, axisIdx = 0, btnIdx = 0;
  const fields = [];
  for(const item of (report.items || [])){
    const size  = item.reportSize  | 0;
    const count = item.reportCount | 0;
    if(size <= 0 || count <= 0) continue;
    if(!item.isConstant){
      const up = item.usagePage, us = item.usage;
      const isAxis = loose ? (size > 1) : (up === 0x01 && HID_AXIS_USAGES.has(us));
      const isBtn  = loose ? (size === 1) : (up === 0x09);
      if(isAxis){
        for(let k=0;k<count;k++){
          fields.push({ t:'a', bit:bit+k*size, size, min:item.logicalMinimum, max:item.logicalMaximum, idx:axisIdx++ });
        }
      } else if(isBtn){
        for(let k=0;k<count;k++){
          fields.push({ t:'b', bit:bit+k*size, size, min:item.logicalMinimum, max:item.logicalMaximum, idx:btnIdx++ });
        }
      }
    }
    bit += size * count;
  }
  return { fields, totalBits:bit, dataBytes:Math.ceil(bit/8), axisCount:axisIdx, buttonCount:btnIdx };
}

function webhidReadBits(data, bitOff, size, signed){
  let v = 0;
  for(let i=0;i<size;i++){
    const b = bitOff + i;
    const byte = b >> 3, bit = b & 7;
    if(byte < data.byteLength) v += ((data.getUint8(byte) >> bit) & 1) * Math.pow(2, i);
  }
  if(signed && size > 1){
    const half = Math.pow(2, size - 1);
    if(v >= half) v -= Math.pow(2, size);
  }
  return v;
}

function webhidDecode(reportId, data){
  const layout = webhid.layouts && webhid.layouts.get(reportId);
  if(!layout) return;
  /* Chrome обычно отдаёт data без байта reportId, но подстрахуемся. */
  const shift = (reportId !== 0 && data.byteLength > layout.dataBytes) ? 8 : 0;
  if(webhid.axes.length    !== layout.axisCount)   webhid.axes    = new Array(layout.axisCount).fill(0);
  if(webhid.buttons.length !== layout.buttonCount) webhid.buttons = new Array(layout.buttonCount).fill(0);
  let changed = false;
  for(const f of layout.fields){
    const raw = webhidReadBits(data, f.bit + shift, f.size, f.min < 0);
    if(f.t === 'a'){
      const half = (f.max - f.min) / 2 || 1;
      const val = clamp((raw - (f.min + f.max) / 2) / half, -1, 1);
      if(Math.abs(val - webhid.axes[f.idx]) > 0.001) changed = true;
      webhid.axes[f.idx] = val;
    } else {
      const val = raw > 0 ? 1 : 0;
      if(val !== webhid.buttons[f.idx]) changed = true;
      webhid.buttons[f.idx] = val;
    }
  }
  if(changed){ webhid.moved = true; webhid.lastActivity = performance.now(); }
}

function webhidOnReport(e){
  try{ webhidDecode(e.reportId, e.data); }catch(_){}
}

function webhidOnNativeDisconnect(e){
  if(e && e.device && e.device === webhid.device) webhidCloseDevice();
}

async function webhidOpenDevice(device, quiet){
  if(!webhid.supported || !device) return;
  if(webhid.device === device && webhid.opened) return;
  await webhidCloseDevice(true);
  try{ await device.open(); }
  catch(_){ if(!quiet) webhidUpdateUi('Нет доступа к устройству'); return; }
  webhid.device = device;
  webhid.opened = true;
  webhid.id = 'HID: ' + (device.productName || ('0x' + device.vendorId.toString(16)));
  webhid.layouts = webhidBuildLayouts(device);
  let nAx = 0, nBtn = 0;
  for(const L of webhid.layouts.values()){ nAx = Math.max(nAx, L.axisCount); nBtn = Math.max(nBtn, L.buttonCount); }
  webhid.axes = new Array(nAx).fill(0);
  webhid.buttons = new Array(nBtn).fill(0);
  webhid.moved = true;
  device.addEventListener('inputreport', webhidOnReport);
  gamepad.preferredIndex = WEBHID_PAD_INDEX;
  webhidUpdateUi();
  gpPoll();
  updateGamepadHud();
  if(gpCalOpen){ buildGpAxesLive(); buildGpButtonSelects(); updateGpCalibrationLive(); }
  if(!nAx && !nBtn) webhidUpdateUi('Дескриптор не распознан');
}

async function webhidCloseDevice(silent){
  const d = webhid.device;
  if(d){
    try{ d.removeEventListener('inputreport', webhidOnReport); }catch(_){}
    try{ await d.close(); }catch(_){}
  }
  webhid.device = null;
  webhid.opened = false;
  webhid.id = '';
  webhid.axes = [];
  webhid.buttons = [];
  webhid.layouts = null;
  if(gamepad.preferredIndex === WEBHID_PAD_INDEX) gamepad.preferredIndex = null;
  if(!silent){
    webhidUpdateUi();
    gpPoll();
    updateGamepadHud();
    if(gpCalOpen) updateGpCalibrationLive();
  }
}

async function webhidRequest(){
  if(!webhid.supported){ webhidUpdateUi('Браузер не поддерживает WebHID'); return; }
  let devices = [];
  try{ devices = await navigator.hid.requestDevice({ filters: [] }) || []; }
  catch(err){
    if(err && err.name === 'TypeError'){
      /* некоторые версии Chrome не принимают пустой filters */
      try{
        devices = await navigator.hid.requestDevice({ filters: [
          { usagePage:0x01, usage:0x04 }, { usagePage:0x01, usage:0x05 },
          { usagePage:0x01, usage:0x06 }, { usagePage:0x01, usage:0x08 },
          { vendorId:0x0483 },
        ]}) || [];
      }catch(_){ webhidUpdateUi('Выбор отменён'); return; }
    } else { webhidUpdateUi('Выбор отменён'); return; }
  }
  if(!devices.length){ webhidUpdateUi('Устройство не выбрано'); return; }
  await webhidOpenDevice(devices[0]);
}

async function webhidAutoReconnect(){
  if(!webhid.supported) return;
  try{
    const granted = await navigator.hid.getDevices();
    if(granted && granted.length){ await webhidOpenDevice(granted[0], true); webhidUpdateUi(); }
  }catch(_){}
}

function webhidUpdateUi(msg){
  const st  = document.getElementById('webhidStatus');
  const con = document.getElementById('webhidConnect');
  const dis = document.getElementById('webhidDisconnect');
  if(!st) return;
  if(!webhid.supported){
    st.textContent = '○ Не поддерживается этим браузером';
    st.className = '';
    if(con) con.disabled = true;
    if(dis) dis.style.display = 'none';
    return;
  }
  if(webhidConnected()){
    const nm = (webhid.device && webhid.device.productName) || webhid.id || 'HID-устройство';
    st.textContent = '● ' + String(nm).slice(0, 36);
    st.className = 'ok';
    if(con) con.textContent = '🔌 Подключить другое';
    if(dis) dis.style.display = '';
  } else {
    st.textContent = '○ ' + (msg || 'Не подключено');
    st.className = '';
    if(con) con.textContent = '🔌 Подключить напрямую';
    if(dis) dis.style.display = 'none';
  }
}

function gpPoll(){
  const pads = (navigator.getGamepads && navigator.getGamepads()) || [];
  /* список всех активных устройств */
  const list = [];
  for(let i=0; i<pads.length; i++){
    const p = pads[i];
    if(p && p.axes && p.axes.length){
      const axes = Array.from(p.axes);
      const buttons = Array.from(p.buttons || []).map(b => (typeof b === 'number' ? b : b.value));
      const prev = gamepad.list.find(g => g.index === p.index);
      /* «живое» устройство — у которого оси/кнопки реально меняются */
      const moved = prev
        ? prev.moved || prev.axes.some((v, k) => Math.abs(v - (axes[k] ?? 0)) > 0.01)
            || prev.buttons.some((v, k) => Math.abs(v - (buttons[k] ?? 0)) > 0.01)
        : false;
      list.push({ index: p.index, id: p.id || ('Пульт ' + p.index), connected: p.connected !== false, axes, buttons, moved });
    }
  }
  /* WebHID-пульт (подключён напрямую) — в общем списке устройств. */
  const hidPad = webhidPseudoPad();
  if(hidPad) list.push(hidPad);
  gamepad.list = list;
  gamepad.count = list.length;

  /* текущее устройство: ручной выбор > автопоиск «живого» > первое доступное */
  let pad = null;
  if(gamepad.preferredIndex != null){
    pad = list.find(g => g.index === gamepad.preferredIndex) || null;
    if(!pad) gamepad.preferredIndex = null;      /* устройство отпало */
  }
  if(!pad){
    pad = list.find(g => g.moved) || null;
    if(pad) gamepad.preferredIndex = pad.index;  /* захватываем «живое» */
  }
  if(!pad && list.length){ pad = list[0]; }

  gamepad.raw = pad;
  const wasConnected = gamepad.connected;
  gamepad.connected = !!pad;
  gamepad.id = pad ? pad.id : '';
  gamepad.axisIndex = pad ? pad.index : -1;
  if(pad){
    gamepad.axes = pad.axes;
    gamepad.buttons = pad.buttons;
  } else {
    gamepad.axes = [];
    gamepad.buttons = [];
    gamepad.active = false;
    gamepad.armLatch = false;
  }
  if(wasConnected !== gamepad.connected) onGamepadConnectionChange();
  if(gpCalOpen){
    /* пересобираем селектор только когда состав устройств изменился */
    const sig = list.map(g => g.index + ':' + g.id).join('|') + '#' + gamepad.axisIndex;
    if(sig !== gamepad._listSig){
      gamepad._listSig = sig;
      buildGpDeviceList();
    }
  }
  /* moved-флаги живут один кадр, сбросим */
  list.forEach(g => { g.moved = false; });
  webhid.moved = false;
}

/* Gamepad API в Chrome/Edge скрывает устройства до первого действия пользователя
   (нажатия кнопки/движения стика) и не всегда сообщает о пульте, подключённом до
   загрузки страницы. Поэтому принудительно перечитываем список по любому жесту. */
function gpForceRescan(){
  gpPoll();
  updateGamepadHud();
  if(gpCalOpen) updateGpCalibrationLive();
}
addEventListener('pointerdown', gpForceRescan, { passive:true });
addEventListener('keydown', gpForceRescan);
addEventListener('focus', gpForceRescan);
setInterval(gpForceRescan, 1500);

function onGamepadConnectionChange(){
  updateGamepadHud();
  updateGpCalibrationLive();
}

// Активен ли пульт: подключён, включён и «взведён» (если назначена кнопка arm).
function gpIsActive(){
  if(!gamepad.connected || !gamepad.config.enabled) return false;
  const armed = gamepad.config.armButton >= 0 ? gamepad.armLatch : true;
  return armed;
}

// Преобразование сырых осей пульта в стики (в диапазоне [-1..1]).
function gpReadSticks(){
  const c = gamepad.config;
  const ax = i => (i >= 0 && i < gamepad.axes.length) ? gamepad.axes[i] : 0;
  const inv = (id, v) => c.invert[id] ? -v : v;

  const yawRaw   = inv('yaw',      ax(c.axes.yaw));
  const pitchRaw = inv('pitch',    ax(c.axes.pitch));
  const rollRaw  = inv('roll',     ax(c.axes.roll));
  const thrRaw   = inv('throttle', ax(c.axes.throttle));

  const yaw   = clamp(deadzone(yawRaw,   c.deadzone), -1, 1);
  const pitch = clamp(deadzone(pitchRaw, c.deadzone), -1, 1);
  const roll  = clamp(deadzone(rollRaw,  c.deadzone), -1, 1);

  // Газ: 'centered' — стик самовозвратный (центр = висение),
  //       'full'     — стик-растяжка: -1 = минимум, +1 = максимум.
  // В обоих случаях физика трактует ly как -1..1, а throttle=(ly+1)/2.
  const thrInput = clamp(deadzone(thrRaw, c.deadzone), -1, 1);

  return {
    L: { x: yaw, y: thrInput },
    R: { x: roll, y: pitch },
  };
}

// Обработка кнопки arm (взведение) и сервисных кнопок пульта.
function gpHandleButtons(){
  const c = gamepad.config;
  if(c.armButton >= 0){
    const b = gamepad.buttons[c.armButton] || 0;
    if(b > 0.5){ gamepad.armLatch = true; }
  }
}

// Кнопки пульта для действий (камера / заново / следующий уровень).
let gpPrevButtons = [];
function gpServiceButtons(){
  const pressed = gamepad.buttons.map(v => v > 0.5);
  const hit = i => pressed[i] && !gpPrevButtons[i];
  const b = gamepad.config;
  if(hit(b.btnCamera)) cycleCamera();
  if(hit(b.btnReset))  resetDrone();
  if(hit(b.btnNext))   nextLevel();
  gpPrevButtons = pressed;
}

addEventListener('gamepadconnected', e=>{
  gamepad.active = gamepad.config.enabled;
  gpPoll();
  updateGamepadHud();
  if(gpCalOpen) updateGpCalibrationLive();
});
addEventListener('gamepaddisconnected', ()=>{ gpPoll(); updateGamepadHud(); });

/* --- отрисовка состояния пульта в HUD/легенде --- */
function updateGamepadHud(){
  const el = document.getElementById('gpStatus');
  if(!el) return;
  if(!gamepad.connected){
    el.textContent = gamepad.count > 0
      ? `○ Пульт не в режиме джойстика`
      : '○ Пульт не найден';
    el.classList.remove('ok');
    return;
  }
  const name = gamepad.id.replace(/\(.*?\)/g,'').replace(/\s+/g,' ').trim().slice(0, 34);
  if(!gamepad.config.enabled){
    el.textContent = `◌ ${name} (выкл.)`;
    el.classList.remove('ok');
    return;
  }
  if(gamepad.config.armButton >= 0 && !gamepad.armLatch){
    el.textContent = `⚠ ${name} — нажмите «взвести»`;
    el.classList.remove('ok');
    return;
  }
  el.textContent = `● ${name}` + (gamepad.count > 1
    ? (gamepad.axisIndex === WEBHID_PAD_INDEX ? ' (HID)' : ` (#${gamepad.axisIndex})`)
    : '');
  el.classList.add('ok');
}

/* --- применение пульта к управлению каждый кадр --- */
function gpUpdate(){
  gpPoll();
  if(!gamepad.connected){ return; }
  gpHandleButtons();
  if(gpIsActive()){
    const s = gpReadSticks();
    stickL.x = s.L.x; stickL.y = s.L.y;
    stickR.x = s.R.x; stickR.y = s.R.y;
  }
  gpServiceButtons();
  if(gpCalOpen) updateGpCalibrationLive();
  updateGamepadHud();
}

/* --- кнопки пульта по умолчанию (индексы Gamepad API) --- */
Object.assign(DEFAULT_GP, { btnCamera:3, btnReset:1, btnNext:0 });
gamepad.config.btnCamera ??= 3;
gamepad.config.btnReset  ??= 1;
gamepad.config.btnNext   ??= 0;

/* ============================================================
   UI калибровки пульта
   ============================================================ */
const gpModalEl   = document.getElementById('gpModal');
const gpBtnEl     = document.getElementById('gpBtn');
const gpStatusEl  = document.getElementById('gpStatus');
const gpAxesLiveEl= document.getElementById('gpAxesLive');
const gpMapEl     = document.getElementById('gpMap');
const gpModalStatusEl = document.getElementById('gpModalStatus');
const gpModalCountEl  = document.getElementById('gpModalCount');
const gpRescanEl      = document.getElementById('gpRescan');
const gpDeviceEl      = document.getElementById('gpDevice');
const gpThrModeEl = document.getElementById('gpThrMode');
const gpDzEl      = document.getElementById('gpDz');
const gpDzValEl   = document.getElementById('gpDzVal');
const gpArmEl     = document.getElementById('gpArm');
const gpBtnCamEl  = document.getElementById('gpBtnCam');
const gpBtnRstEl  = document.getElementById('gpBtnRst');
const gpBtnNxtEl  = document.getElementById('gpBtnNxt');
const gpEnableEl  = document.getElementById('gpEnable');

const GP_AXIS_NAMES = ['Ось 0','Ось 1','Ось 2','Ось 3','Ось 4','Ось 5','Ось 6','Ось 7'];

function gpOpenModal(){
  gpCalOpen = true;
  gpModalEl.classList.add('show');
  gpModalEl.setAttribute('aria-hidden','false');
  makeCollapsible(gpModalEl);
  expandWindow(gpModalEl);
  buildGpDeviceList();
  buildGpAxesLive();
  buildGpMap();
  buildGpButtonSelects();
  syncGpControls();
  gpShownDevice = gamepad.preferredIndex != null ? gamepad.preferredIndex
                : (gamepad.axisIndex >= 0 ? gamepad.axisIndex : null);
  updateGpCalibrationLive();
}
function gpCloseModal(){
  gpCalOpen = false;
  gpAssigning = null;
  gpModalEl.classList.remove('show');
  gpModalEl.setAttribute('aria-hidden','true');
  saveGpConfig(gamepad.config);
  updateGamepadHud();
}

let gpShownDevice = null;   // устройство, чьи оси сейчас показываются

function shortGpName(id, index){
  return (id || 'Пульт ' + index).replace(/\(.*?\)/g,'').replace(/\s+/g,' ').trim().slice(0, 36);
}

/* Список устройств в селекторе; ожившее «движение» подсвечивается автопереключением */
function buildGpDeviceList(){
  if(!gpDeviceEl) return;
  const active = gamepad.axisIndex;
  const opts = gamepad.list.map(g =>
    `<option value="${g.index}" ${g.index===active?'selected':''}>${shortGpDeviceLabel(g)}</option>`
  ).join('');
  gpDeviceEl.innerHTML = opts || '<option value="-1">— нет устройств —</option>';
  // если текущее устройство отсутствует в списке, добавим его, чтобы не терять выбор
  if(active >= 0 && !gamepad.list.some(g => g.index === active)){
    const fallback = document.createElement('option');
    fallback.value = active;
    fallback.textContent = 'Отключено #' + active;
    gpDeviceEl.appendChild(fallback);
  }
}
function shortGpDeviceLabel(g){
  return shortGpName(g.id, g.index) + (g.moved ? ' ●' : '');
}
function gpShowDevice(){
  gpShownDevice = gamepad.preferredIndex;
}
gpDeviceEl.addEventListener('change', ()=>{
  const v = parseInt(gpDeviceEl.value, 10);
  if(!isNaN(v) && v >= 0){
    gamepad.preferredIndex = v;
    gpPoll();                // немедленно переключаемся на выбранное устройство
    gpShownDevice = v;
    updateGpCalibrationLive();
  }
});

function buildGpAxesLive(){
  const n = Math.max(8, gamepad.axes.length);
  gpAxesLiveEl.innerHTML = '';
  for(let i=0;i<n;i++){
    const row = document.createElement('div');
    row.className = 'gp-axis';
    row.dataset.axis = i;
    row.innerHTML = `<span>${GP_AXIS_NAMES[i]||('Ось '+i)}</span>
      <span class="bar"><i></i><b></b></span>
      <span class="val">0.00</span>`;
    gpAxesLiveEl.appendChild(row);
  }
}

function buildGpMap(){
  gpMapEl.innerHTML = '';
  for(const ch of GP_CHANNELS){
    const box = document.createElement('div');
    box.className = 'gp-chan';
    const opts = GP_AXIS_NAMES.map((nm,i)=>
      `<option value="${i}" ${gamepad.config.axes[ch.id]===i?'selected':''}>${nm}</option>`).join('');
    box.innerHTML = `<span>${ch.label}</span>
      <select data-chan="${ch.id}">${opts}</select>
      <label class="gp-inv"><input type="checkbox" data-inv="${ch.id}" ${gamepad.config.invert[ch.id]?'checked':''}> инвертировать</label>
      <button type="button" class="gp-learn" data-learn="${ch.id}">Определить движением</button>`;
    gpMapEl.appendChild(box);
  }
  gpMapEl.querySelectorAll('select[data-chan]').forEach(sel=>{
    sel.addEventListener('change', ()=>{
      gamepad.config.axes[sel.dataset.chan] = parseInt(sel.value,10);
      saveGpConfig(gamepad.config);
    });
  });
  gpMapEl.querySelectorAll('input[data-inv]').forEach(cb=>{
    cb.addEventListener('change', ()=>{
      gamepad.config.invert[cb.dataset.inv] = cb.checked;
      saveGpConfig(gamepad.config);
    });
  });
  gpMapEl.querySelectorAll('button[data-learn]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      gpAssigning = btn.dataset.learn;
      btn.textContent = 'Двигайте стик…';
      btn.classList.add('learning');
    });
  });
}

function buildGpButtonSelects(){
  const maxBtn = Math.max(16, gamepad.buttons.length);
  const opts = (sel)=> [`<option value="-1" ${sel<0?'selected':''}>— нет —</option>`]
    .concat(Array.from({length:maxBtn},(_,i)=>`<option value="${i}" ${sel===i?'selected':''}>Кнопка ${i}</option>`))
    .join('');
  gpArmEl.innerHTML  = opts(gamepad.config.armButton);
  gpBtnCamEl.innerHTML = opts(gamepad.config.btnCamera ?? -1);
  gpBtnRstEl.innerHTML = opts(gamepad.config.btnReset ?? -1);
  gpBtnNxtEl.innerHTML = opts(gamepad.config.btnNext ?? -1);
}
function syncGpControls(){
  gpThrModeEl.value = gamepad.config.throttleMode;
  gpDzEl.value = gamepad.config.deadzone;
  gpDzValEl.textContent = Number(gamepad.config.deadzone).toFixed(2);
  gpEnableEl.textContent = gamepad.config.enabled ? 'Выключить пульт' : 'Включить пульт';
}

// Живое обновление значений осей и авто-назначение при обучении.
function updateGpCalibrationLive(){
  if(!gpCalOpen) return;
  const rows = gpAxesLiveEl.querySelectorAll('.gp-axis');
  rows.forEach(row=>{
    const i = parseInt(row.dataset.axis,10);
    const v = (gamepad.axes[i] != null) ? gamepad.axes[i] : 0;
    row.querySelector('.val').textContent = v.toFixed(2);
    const b = row.querySelector('b');
    const pct = Math.abs(v)*50;
    b.style.width = pct + '%';
    b.style.left = v >= 0 ? '50%' : (50-pct) + '%';
    row.classList.toggle('hot', Math.abs(v) > 0.35);
    // авто-назначение: пользователь выбрал «Определить движением» и сильно отклонил ось
    if(gpAssigning && Math.abs(v) > 0.6){
      gamepad.config.axes[gpAssigning] = i;
      gpAssigning = null;
      saveGpConfig(gamepad.config);
      buildGpMap();
    }
  });
  // статус в модалке
  const name = gamepad.connected ? gamepad.id.replace(/\(.*?\)/g,'').trim().slice(0,40) : '';
  gpModalStatusEl.textContent = gamepad.connected ? ('● ' + name) : '○ Пульт не найден';
  gpModalStatusEl.className = gamepad.connected ? 'ok' : '';
  if(gpModalCountEl) gpModalCountEl.textContent = String(gamepad.count || 0);
}

gpBtnEl.addEventListener('click', (e)=>{ e.stopPropagation(); openGpModalSafe(); });
function openGpModalSafe(){ closeLevelMenu(); gpOpenModal(); }
document.getElementById('gpClose').addEventListener('click', gpCloseModal);
document.getElementById('gpDefaults').addEventListener('click', ()=>{
  gamepad.config = { ...gpClone(DEFAULT_GP),
    axes:{...DEFAULT_GP.axes}, invert:{...DEFAULT_GP.invert},
    btnCamera:3, btnReset:1, btnNext:0 };
  saveGpConfig(gamepad.config);
  buildGpMap(); buildGpButtonSelects(); syncGpControls(); updateGamepadHud();
});
gpEnableEl.addEventListener('click', ()=>{
  gamepad.config.enabled = !gamepad.config.enabled;
  saveGpConfig(gamepad.config);
  syncGpControls(); updateGamepadHud();
});
gpThrModeEl.addEventListener('change', ()=>{
  gamepad.config.throttleMode = gpThrModeEl.value; saveGpConfig(gamepad.config);
});
gpDzEl.addEventListener('input', ()=>{
  gamepad.config.deadzone = parseFloat(gpDzEl.value);
  gpDzValEl.textContent = Number(gamepad.config.deadzone).toFixed(2); saveGpConfig(gamepad.config);
});
gpArmEl.addEventListener('change', ()=>{
  gamepad.config.armButton = parseInt(gpArmEl.value,10);
  gamepad.armLatch = false; saveGpConfig(gamepad.config); updateGamepadHud();
});
gpBtnCamEl.addEventListener('change', ()=>{ gamepad.config.btnCamera = parseInt(gpBtnCamEl.value,10); saveGpConfig(gamepad.config); });
gpBtnRstEl.addEventListener('change', ()=>{ gamepad.config.btnReset  = parseInt(gpBtnRstEl.value,10); saveGpConfig(gamepad.config); });
gpBtnNxtEl.addEventListener('change', ()=>{ gamepad.config.btnNext   = parseInt(gpBtnNxtEl.value,10); saveGpConfig(gamepad.config); });
gpModalEl.addEventListener('click', (e)=>{ if(e.target === gpModalEl) gpCloseModal(); });
addEventListener('keydown', e=>{ if(e.code === 'Escape' && gpCalOpen) gpCloseModal(); });

/* Инициализация статуса пульта (без ожидания события). */
gpPoll();
updateGamepadHud();

/* WebHID: кнопки, авто-восстановление доступа и слушатель отключения. */
const webhidConnectEl    = document.getElementById('webhidConnect');
const webhidDisconnectEl = document.getElementById('webhidDisconnect');
if(webhidConnectEl)    webhidConnectEl.addEventListener('click', webhidRequest);
if(webhidDisconnectEl) webhidDisconnectEl.addEventListener('click', ()=>webhidCloseDevice());
function webhidInit(){
  webhidUpdateUi();
  if(!webhid.supported) return;
  navigator.hid.addEventListener('disconnect', webhidOnNativeDisconnect);
  webhidAutoReconnect();
}
webhidInit();

/* Кнопка и клавиша переключения режима полёта (Angle/Acro). */
document.getElementById('modeBtn').addEventListener('click', e=>{
  e.stopPropagation(); toggleFlightMode();
});
updateFlightModeUI();
/* Кнопка камеры в легенде; текст кнопки обновляется при переключении. */
const camBtnEl = document.getElementById('camBtn');
if(camBtnEl) camBtnEl.addEventListener('click', e=>{ e.stopPropagation(); cycleCamera(); });
function updateCamBtn(){
  const el = document.getElementById('camBtn');
  if(el) el.textContent = 'Камера: ' + CAM_MODES[camMode];
}

/* ============================================================
   Модалка «Модель и оборудование»
   ============================================================ */
let cfgOpen = false;
const cfgModalEl = document.getElementById('cfgModal');
const cfgBtnEl   = document.getElementById('cfgBtn');
const cfgModelsEl= document.getElementById('cfgModels');
const cfgMotorEl = document.getElementById('cfgMotor');
const cfgPropEl  = document.getElementById('cfgProp');
const cfgBatteryEl = document.getElementById('cfgBattery');
const cfgMapEl   = document.getElementById('cfgMap');
const cfgStatsEl = document.getElementById('cfgStats');
const cfgMaps = [
  { id:'meadow', name:'Луг' },
  { id:'city',   name:'Город' },
  { id:'canyon', name:'Каньон' },
];

function buildCfgModels(){
  cfgModelsEl.innerHTML = DRONE_MODELS.map((m,i)=>
    `<button type="button" class="cfg-card ${i===cfg.model?'sel':''}" data-model="${i}">
      <b>${m.name}</b>${m.desc}</button>`).join('');
  cfgModelsEl.querySelectorAll('button[data-model]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      cfg.model = parseInt(btn.dataset.model,10);
      saveCfg(); updatePerf(); rebuildDroneModel();
      buildCfgModels(); updateCfgStats();
    });
  });
}
function buildCfgSelects(){
  const opts = (list, key) => list.map((o,i)=>
    `<option value="${i}" ${i===cfg[key]?'selected':''}>${o.name}</option>`).join('');
  cfgMotorEl.innerHTML   = opts(MOTOR_OPTS, 'motor');
  cfgPropEl.innerHTML    = opts(PROP_OPTS, 'prop');
  cfgBatteryEl.innerHTML = opts(BATTERY_OPTS, 'battery');
  cfgMapEl.innerHTML     = cfgMaps.map(o =>
    `<option value="${o.id}" ${o.id===cfg.map?'selected':''}>${o.name}</option>`).join('');
}
function updateCfgStats(){
  const m = model();
  cfgStatsEl.textContent = [
    'Модель: ' + m.name,
    'макс. скорость ~' + (MAX_SPEED*perf.maxSpeed).toFixed(1) + ' м/с',
    'вертикаль ~' + (MAX_CLIMB*perf.climb).toFixed(1) + ' м/с',
    'тяга ×' + perf.thrust.toFixed(2),
    'полёт ~' + (BASE_ENDURANCE*perf.cap/60).toFixed(0) + ' мин',
  ].join(' · ');
}
function openCfgModal(){
  cfgOpen = true;
  cfgModalEl.classList.add('show');
  cfgModalEl.setAttribute('aria-hidden','false');
  makeCollapsible(cfgModalEl);
  expandWindow(cfgModalEl);
  buildCfgModels(); buildCfgSelects(); updateCfgStats();
}
function closeCfgModal(){
  cfgOpen = false;
  cfgModalEl.classList.remove('show');
  cfgModalEl.setAttribute('aria-hidden','true');
}
cfgBtnEl.addEventListener('click', e=>{ e.stopPropagation(); closeLevelMenu(); openCfgModal(); });
document.getElementById('cfgClose').addEventListener('click', closeCfgModal);
cfgModalEl.addEventListener('click', e=>{ if(e.target === cfgModalEl) closeCfgModal(); });
addEventListener('keydown', e=>{ if(e.code === 'Escape' && cfgOpen) closeCfgModal(); });

function applyPartSelect(cfgKey, selEl){
  selEl.addEventListener('change', ()=>{
    cfg[cfgKey] = parseInt(selEl.value,10);
    saveCfg(); updatePerf(); rebuildDroneModel(); updateCfgStats();
  });
}
applyPartSelect('motor', cfgMotorEl);
applyPartSelect('prop', cfgPropEl);
applyPartSelect('battery', cfgBatteryEl);
cfgMapEl.addEventListener('change', ()=>{
  cfg.map = cfgMapEl.value;
  saveCfg();
  const lv = LEVELS[currentLevelIndex];
  if(lv && lv.free) loadLevel(currentLevelIndex);
});

/* ============================================================
   Стартовый экран: шаг 1 — БПЛА + режим, шаг 2 — упражнения/карта
   ============================================================ */
const startScreenEl = document.getElementById('startScreen');
const stCardEl      = document.getElementById('stCard');
let stStep = 0;            // 0 — закрыт, 1 — выбор модели/режима, 2 — выбор упражнения/карты
let stTarget = '';         // 'lessons' | 'free'
let stOpened = false;      // уже открывался старт-экран (для надписи «Продолжить»)

function showStart(step, target){
  stStep = step;
  stTarget = target || stTarget;
  stOpened = true;
  startScreenEl.classList.add('show');
  startScreenEl.setAttribute('aria-hidden','false');
  paused = true;
  if(stStep === 1) renderStart1();
  else renderStart2();
  expandWindow(startScreenEl);
}
function hideStart(){
  stStep = 0;
  startScreenEl.classList.remove('show');
  startScreenEl.setAttribute('aria-hidden','true');
  paused = false;
}
function renderStart1(){
  stCardEl.innerHTML = `
    <p class="st-title">Симулятор полёта БПЛА</p>
    <p class="st-sub">Шаг 1 из 2 — выберите аппарат и режим</p>
    <p class="st-h3">БПЛА</p>
    <div class="st-models">
      ${DRONE_MODELS.map((m,i)=>
        `<button type="button" class="cfg-card ${i===cfg.model?'sel':''}" data-model="${i}">
          <b>${m.name}</b>${m.desc}</button>`).join('')}
    </div>
    <p class="st-h3">Режим и камера</p>
    <div class="st-modes">
      <button type="button" class="st-mode st-small" id="stModeBtn">${FLIGHT_MODES[flightMode] === 'Acro' ? '🌀 Acro' : '🎯 Angle'}</button>
      <button type="button" class="st-mode st-small" id="stCamBtn">📹 ${CAM_MODES[camMode]}</button>
    </div>
    <p class="st-h3">Что делаем?</p>
    <div class="st-modes">
      <button type="button" class="st-mode" data-target="lessons">🎯 Обучающие упражнения
        <small>15 уровней: взлёт, висение, слалом, гонка, отказ мотора…</small></button>
      <button type="button" class="st-mode" data-target="races">🏁 Гонки на время
        <small>Трассы по мотивам MultiGP: серпантин, цунами, спираль…</small></button>
      <button type="button" class="st-mode" data-target="free">🛩️ Свободный полёт
        <small>Просто летайте: Луг, Город или Каньон</small></button>
    </div>
    <p class="st-h3">Ещё</p>
    <div class="st-modes">
      <button type="button" class="st-mode st-small" id="stNetBtn">🌐 Сетевая игра</button>
      <button type="button" class="st-mode st-small" id="stFsBtn">⛶ Полный экран</button>
    </div>
    <p class="st-h3">Аккаунт</p>
    <div class="st-modes">
      <a class="st-mode st-small" id="stAuthBtn" href="#">🔑 Войти через портал</a>
    </div>
    <div class="st-foot">
      <div class="gp-sec"><button type="button" class="st-gpbtn" id="stGpBtn">🎮 Настроить пульт</button></div>
      <button type="button" class="st-back" id="stQuit">${stOpened ? 'Продолжить' : 'Не сейчас'}</button>
    </div>`;
  stCardEl.querySelectorAll('button[data-model]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      cfg.model = parseInt(btn.dataset.model,10);
      saveCfg(); updatePerf(); rebuildDroneModel();
      renderStart1();
    });
  });
  stCardEl.querySelectorAll('button[data-target]').forEach(btn=>{
    btn.addEventListener('click', ()=> showStart(2, btn.dataset.target));
  });
  document.getElementById('stModeBtn').addEventListener('click', ()=>{
    toggleFlightMode(); renderStart1();
  });
  document.getElementById('stCamBtn').addEventListener('click', ()=>{
    cycleCamera(); renderStart1();
  });
  document.getElementById('stNetBtn').addEventListener('click', ()=>{
    startScreenEl.classList.remove('show');
    openNetModal();
  });
  document.getElementById('stFsBtn').addEventListener('click', ()=>{
    toggleFullscreen(); renderStart1();
  });
  document.getElementById('stGpBtn').addEventListener('click', e=>{
    e.stopPropagation(); openGpFromStart();
  });
  document.getElementById('stQuit').addEventListener('click', ()=> hideStart());
  renderAuth();
  makeCollapsible(startScreenEl);
}
function renderStart2(){
  if(stTarget === 'free'){
    const mapDesc = { meadow:'Деревья и поляна, мягкая сцена', city:'Кварталы домов, интересные силуэты', canyon:'Скальные пики и расщелины' };
    stCardEl.innerHTML = `
      <p class="st-title">Свободный полёт</p>
      <p class="st-sub">Шаг 2 из 2 — выберите карту</p>
      <div class="st-levels">
        ${cfgMaps.map(o=>
          `<button type="button" class="st-mode" data-map="${o.id}">${o.name}
            <small>${mapDesc[o.id]||''}</small></button>`).join('')}
      </div>
      <div class="st-foot">
        <button type="button" class="st-back" id="stBack">← Назад</button>
      </div>`;
    stCardEl.querySelectorAll('button[data-map]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        cfg.map = btn.dataset.map;
        saveCfg();
        const fi = LEVELS.findIndex(l => l.free);
        hideStart();
        loadLevel(fi >= 0 ? fi : LEVELS.length-1);
      });
    });
    document.getElementById('stBack').addEventListener('click', ()=> showStart(1));
  } else if(stTarget === 'races'){
    stCardEl.innerHTML = `
      <p class="st-title">Гонки на время</p>
      <p class="st-sub">Шаг 2 из 2 — выберите трассу</p>
      <div class="st-levels">
        ${LEVELS.map((lv,i)=>({lv,i})).filter(o=>o.lv.race).map(({lv,i})=>
          `<button type="button" data-idx="${i}">🏁 ${lv.name}<small>${lv.brief}</small></button>`).join('')}
      </div>
      <div class="st-foot">
        <button type="button" class="st-back" id="stBack">← Назад</button>
      </div>`;
    stCardEl.querySelectorAll('button[data-idx]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        hideStart();
        loadLevel(parseInt(btn.dataset.idx,10));
      });
    });
    document.getElementById('stBack').addEventListener('click', ()=> showStart(1));
  } else {
    stCardEl.innerHTML = `
      <p class="st-title">Обучающие упражнения</p>
      <p class="st-sub">Шаг 2 из 2 — выберите уровень</p>
      <div class="st-levels">
        ${LEVELS.map((lv,i)=>({lv,i})).filter(o=>!o.lv.race).map(({lv,i},n)=>
          `<button type="button" data-idx="${i}" class="${i===currentLevelIndex?'active':''}">
            ${n+1}. ${lv.name}<small>${lv.brief}</small></button>`).join('')}
      </div>
      <div class="st-foot">
        <button type="button" class="st-back" id="stBack">← Назад</button>
      </div>`;
    stCardEl.querySelectorAll('button[data-idx]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        hideStart();
        loadLevel(parseInt(btn.dataset.idx,10));
      });
    });
    document.getElementById('stBack').addEventListener('click', ()=> showStart(1));
  }
  makeCollapsible(startScreenEl);
}
/* Открытие пульта из стартового экрана: скрываем его, gpBtnOfStart вернёт */
function openGpFromStart(){
  startScreenEl.classList.remove('show');
  gpOpenModal();
  const gpClose = document.getElementById('gpClose');
  if(gpClose._stHooked) gpClose.removeEventListener('click', gpClose._stHooked);
  gpClose._stHooked = ()=>{
    if(stStep !== 0) showStart(stStep, stTarget);
  };
  gpClose.addEventListener('click', gpClose._stHooked, { once:true });
}
/* Esc-навигация стартового экрана: шаг 2 → шаг 1 */
addEventListener('keydown', e=>{
  if(e.code === 'Escape' && stStep === 2) showStart(1);
});

/* Кнопка «УРОВНИ ▾» открывает стартовый экран на шаге выбора уровня.
   Клон узла снимает старый обработчик (toggle levelmenu). Локально — menuBtnEl
   объявляется ниже по файлу, нельзя на неё ссылаться при инициализации. */
const mbEl = document.getElementById('menuBtn');
mbEl.replaceWith(mbEl.cloneNode(true));
/* на тач-устройствах кнопка меню — маленький круглый «☰» */
if(isMobile) document.getElementById('menuBtn').textContent = '☰';
document.getElementById('menuBtn').addEventListener('click', e=>{
  e.stopPropagation();
  if(gpCalOpen || cfgOpen) { closeLevelMenu(); return; }
  /* на тач-устройствах всё меню — в старт-экране */
  showStart(isMobile ? 1 : 2, 'lessons');
});

/* ============================================================
   Сетевая игра: несколько комнат (до 4 участников) с выбором игры.
   Хост (первый участник) выбирает карту и режим, жмёт «Начать игру»;
   остальные подключаются к нужной комнате и получают карту/режим хоста.
   Сигналинг — HTTP-поллинг бэкенда fly-web (/api/signal/*), затем P2P.
   ============================================================ */
const netModalEl  = document.getElementById('netModal');
const netBtnEl    = document.getElementById('netBtn');
const netStatusEl = document.getElementById('netStatus');
const netStepsEl  = document.getElementById('netSteps');

const NET_API     = '/api/signal';
const NET_MAX     = 4;
const NET_POLL_MS = 2000;
const NET_MAP_NAMES = { meadow:'Луг', city:'Город', canyon:'Каньон', forest:'Лесная дорога' };
/* Точки спавна по слоту игрока (0..7): сетка 2×4, чтобы не появляться в одной точке. */
const NET_SPAWNS = [
  { x:-5.25, z:-2.5 }, { x:-1.75, z:-2.5 }, { x:1.75, z:-2.5 }, { x:5.25, z:-2.5 },
  { x:-5.25, z: 2.5 }, { x:-1.75, z: 2.5 }, { x:1.75, z: 2.5 }, { x:5.25, z: 2.5 },
];
/* Спавн по слоту: для лесной трассы — на дороге у стартовой арки, по рельефу;
   для плоских карт — прежняя сетка у нуля. Возвращает {x,y,z}. */
function netSpawn(slot){
  slot = Math.max(0, Number(slot) || 0);
  if(netRoom.info && netRoom.info.map === 'forest'){
    const t0 = -1/80, p = forestPath(t0), tg = forestTangent(t0);
    const nx = tg.z, nz = -tg.x;          /* нормаль к дороге */
    const col = slot % 4, row = (slot / 4) | 0;
    const lat = -3.0 + col * 2.0;         /* поперёк дороги: -3,-1,1,3 */
    const lon = -row * 3.6;               /* второй ряд — позади старта */
    const x = p.x + nx*lat + tg.x*lon;
    const z = p.z + nz*lat + tg.z*lon;
    return { x, z, y: GROUND_REST + forestTerrain(x, z) };
  }
  const s = NET_SPAWNS[slot] || { x:0, z:0 };
  return { x:s.x, z:s.z, y:GROUND_REST };
}

/* LAN-релей: включается на http (локальная сеть), либо по ?lan / ?relay=host:port.
   В этом режиме транспорт — один WebSocket к релею (звезда), без auth-web/TURN. */
const NET_QS = new URLSearchParams(location.search);
const NET_RELAY = NET_QS.has('lan') || NET_QS.has('relay') || location.protocol === 'http:';
const NET_ADMIN_KEY = NET_QS.get('admin') || '';
const LAN_NAME_KEY = 'fly-lan-name';
const LAN_RELAY_KEY = 'fly-lan-relay';

/* Адрес релея «host[:port]» → URL WebSocket. Пустая строка = текущий хост. */
function relayWsUrlFromAddr(addr){
  addr = String(addr == null ? '' : addr).trim();
  if(addr === '') addr = location.host;
  if(/^wss?:\/\//.test(addr)) return addr;
  if(/^https?:\/\//.test(addr)) return addr.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws';
  const scheme = location.protocol === 'https:' ? 'wss://' : 'ws://';
  let path = '/ws';
  let host = addr;
  const slash = addr.indexOf('/');
  if(slash >= 0){ host = addr.slice(0, slash); path = addr.slice(slash) || '/ws'; }
  if(host.indexOf(':') < 0) host += ':8080';   // порт релея по умолчанию
  if(path.charAt(0) !== '/') path = '/' + path;
  return scheme + host + path;
}
function relayDefaultAddr(){
  const q = NET_QS.get('relay');
  if(q) return q;
  try{ const saved = localStorage.getItem(LAN_RELAY_KEY); if(saved) return saved; }catch(_){}
  return NET_RELAY ? location.host : '';
}
/* Адрес релея «host[:port]» → http-URL его страницы (?lan). Пусто, если адрес не задан. */
function relayHttpUrlFromAddr(addr){
  addr = String(addr == null ? '' : addr).trim();
  if(addr === '') return '';
  if(/^https?:\/\//.test(addr)) return addr.replace(/\/+$/, '') + '/?lan';
  if(/^wss?:\/\//.test(addr)) return addr.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/ws\/?$/, '') + '/?lan';
  let host = addr;
  const slash = addr.indexOf('/');
  if(slash >= 0) host = addr.slice(0, slash);
  if(host.indexOf(':') < 0) host += ':8080';
  return 'http://' + host + '/?lan';
}
/* С сайта (https) ws:// к LAN-IP запрещён (mixed content) — открываем страницу релея в новой вкладке. */
function openLocalRelay(addr){
  addr = String(addr == null ? '' : addr).trim();
  if(addr === ''){ netSetStatus('⚠ Укажите адрес релея (IP:порт)', false); return; }
  try{ localStorage.setItem(LAN_RELAY_KEY, addr); }catch(_){}
  const url = relayHttpUrlFromAddr(addr);
  try{ window.open(url, '_blank', 'noopener'); }catch(_){ location.href = url; }
  netSetStatus('↗ Открываю локальный релей: ' + url, true);
}
let relayTarget = relayDefaultAddr();
let relayUrl = relayWsUrlFromAddr(relayTarget);
function lanName(){
  let n = '';
  try{ n = localStorage.getItem(LAN_NAME_KEY) || ''; }catch(_){}
  if(!n){ n = 'Пилот-' + Math.floor(Math.random()*900 + 100); try{ localStorage.setItem(LAN_NAME_KEY, n); }catch(_){} }
  return n;
}
function netReady(){ return NET_RELAY || !!authUser; }

/* ---------- LAN-релей: транспорт по WebSocket ---------- */
let relayWs = null;
let relayReady = false;

function relaySend(obj){
  try{ if(relayWs && relayWs.readyState === 1) relayWs.send(JSON.stringify(obj)); }catch(_){}
}
function relayHello(name){ relaySend({ t:'hello', name: name, admin: NET_ADMIN_KEY }); }
function relayConnect(addr){
  const target = (addr === undefined || addr === null || String(addr).trim() === '')
    ? relayTarget : String(addr).trim();
  const url = relayWsUrlFromAddr(target);
  if(relayWs && url === relayUrl && (relayWs.readyState === 0 || relayWs.readyState === 1)) return;

  // Переключение на другой релей: уходим из комнаты, закрываем старое соединение.
  if(netRoom.active){
    try{ relaySend({ t:'leave' }); }catch(_){}
    for(const id of Array.from(netRoom.peers.keys())) removePeer(id);
    netRoom.active = false;
    netRoom.info = null;
  }
  if(relayWs){ try{ relayWs.close(); }catch(_){} }
  relayWs = null;
  relayReady = false;
  relayTarget = target;
  relayUrl = url;
  try{ localStorage.setItem(LAN_RELAY_KEY, target); }catch(_){}
  netRoom.lobbyRooms = [];
  netSetStatus('○ Подключение к релею…', false);

  let ws;
  try{ ws = new WebSocket(relayUrl); }
  catch(_){ netSetStatus('⚠ Некорректный адрес релея', false); renderNetBody(); return; }
  relayWs = ws;

  ws.addEventListener('open', ()=>{
    if(ws !== relayWs) return;
    relayReady = true;
    netRoom.selfName = lanName();
    relayHello(netRoom.selfName);
    relaySend({ t:'lobby' });
    renderNetBody();
  });
  ws.addEventListener('close', ()=>{
    if(ws !== relayWs) return;   // закрылось старое соединение — игнорируем
    relayReady = false;
    relayWs = null;
    if(netRoom.active){
      for(const id of Array.from(netRoom.peers.keys())) removePeer(id);
      netRoom.active = false;
      netRoom.info = null;
      netRaceStop();
    }
    netSetStatus('○ Релей отключён', false);
    renderNetBody();
  });
  ws.addEventListener('error', ()=>{});
  ws.addEventListener('message', ev => { if(ws === relayWs) relayOnMessage(ev.data); });
  renderNetBody();
}
function relayOnMessage(data){
  let m;
  try{ m = JSON.parse(data); }catch(_){ return; }
  if(!m || !m.t) return;
  if(m.t === 'hello'){ if(m.self && m.self.name) netRoom.selfName = m.self.name; return; }
  if(m.t === 'lobby'){
    if(m.self && m.self.name) netRoom.selfName = m.self.name;
    netRoom.lobbyRooms = m.rooms || [];
    syncNetMeta(m);
    if(!netRoom.active) renderNetBody();
    return;
  }
  if(m.t === 'welcome'){ relayEnter(m); return; }
  if(m.t === 'room'){ relayRoomUpdate(m); return; }
  if(m.t === 'st'){
    const p = netRoom.peers.get(Number(m.id));
    if(p && Array.isArray(m.p) && Array.isArray(m.q)){
      p.targetPos.set(m.p[0], m.p[1], m.p[2]);
      p.targetQuat.set(m.q[0], m.q[1], m.q[2], m.q[3]);
    }
    return;
  }
  if(m.t === 'ready' || m.t === 'go' || m.t === 'reset' || m.t === 'race'){ netRaceHandle(m.id, m); return; }
  if(m.t === 'error'){ netSetStatus('⚠ ' + m.message, false); return; }
}
function syncNetMeta(m){
  if(Array.isArray(m.maps) && m.maps.length) netRoom.maps = m.maps;
  if(Array.isArray(m.maxOptions) && m.maxOptions.length) netRoom.maxOptions = m.maxOptions;
  if(m.maxHard) netRoom.maxHard = Number(m.maxHard) || netRoom.maxHard;
}
function relayEnter(m){
  netRoom.active = true;
  netRoom.id = m.room ? Number(m.room.id) : 0;
  netRoom.selfId = Number(m.self.id);
  netRoom.selfSlot = Number(m.self.slot) || 0;
  netRoom.selfName = m.self.name;
  netRoom.info = m.room || null;
  netRoom.max = (m.room && m.room.max) || netRoom.max;
  syncNetMeta(m);
  netRoom.control = {};
  netRoom.appliedMap = '';
  netRoom.appliedMode = '';
  netRoom.startedSeen = false;
  applyParticipants(m.participants || []);
  applyNetGame(true);
  updateNetStatusText();
  renderNetBody();
}
function relayRoomUpdate(m){
  if(!netRoom.active) return;
  if(m.room){ netRoom.info = m.room; netRoom.max = m.room.max || netRoom.max; }
  applyParticipants(m.participants || []);
  applyNetGame(false);
  updateNetStatusText();
  renderNetBody();
}

const netRoom = {
  active: false,
  id: 0,
  selfId: 0,
  selfSlot: 0,
  selfName: 'Пилот',
  max: NET_MAX,
  pollTimer: null,
  lobbyTimer: null,
  polling: false,
  pending: [],                 // исходящие SDP: { to, type, sdp }
  control: {},                 // неотправленное управление хоста: { map?, mode?, started? }
  peers: new Map(),            // userId -> peer
  info: null,                  // данные комнаты с сервера
  lobbyRooms: [],
  maps: ['meadow', 'city', 'canyon', 'forest'],
  maxOptions: [2, 4, 6, 8],
  maxHard: 8,
  appliedMap: '',
  appliedMode: '',
  startedSeen: false,
  iceServers: [
    { urls:['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls:'stun:stun.cloudflare.com:3478' },
  ],
};

let netKickTimer = null;

function netMapName(id){ return NET_MAP_NAMES[id] || 'Луг'; }
function netSelfName(){
  if(NET_RELAY) return netRoom.selfName || lanName();
  return (authUser && (authUser.display_name || authUser.login)) || 'Пилот';
}
function netSetStatus(txt, ok){
  netStatusEl.textContent = txt;
  netStatusEl.className = ok ? 'ok' : '';
}
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

/* ---------- окно ---------- */
netBtnEl.addEventListener('click', e=>{ e.stopPropagation(); closeLevelMenu(); openNetModal(); });
document.getElementById('netClose').addEventListener('click', closeNetModal);
netModalEl.addEventListener('click', e=>{ if(e.target === netModalEl) closeNetModal(); });
addEventListener('keydown', e=>{ if(e.code === 'Escape' && netModalEl.classList.contains('show')) closeNetModal(); });
addEventListener('pagehide', ()=>{
  if(!NET_RELAY && netRoom.active){
    try{
      navigator.sendBeacon(NET_API + '/leave.php',
        new Blob([JSON.stringify({ room_id: netRoom.id })], { type:'application/json' }));
    }catch(_){}
  }
});

function openNetModal(){
  netModalEl.classList.add('show');
  netModalEl.setAttribute('aria-hidden','false');
  makeCollapsible(netModalEl);
  expandWindow(netModalEl);
  updateNetStatusText();
  renderNetBody();
  if(NET_RELAY) relayConnect();
  else if(authUser && !netRoom.active) startLobbyPolling();
}
function closeNetModal(){
  netModalEl.classList.remove('show');
  netModalEl.setAttribute('aria-hidden','true');
  stopLobbyPolling();
  if(stStep !== 0) showStart(stStep, stTarget);
}

function updateNetStatusText(){
  if(!netRoom.active){ netSetStatus('○ Не подключено', false); return; }
  const total = netRoom.peers.size + 1;
  const anyOpen = Array.from(netRoom.peers.values()).some(p=>p.open);
  const info = netRoom.info || {};
  const phase = info.started ? 'игра идёт' : 'ожидание';
  netSetStatus('● ' + (info.title || 'Игра') + ' ' + total + '/' + netRoom.max + ' · ' + phase + (anyOpen ? ' · соединено' : ''), true);
}

/* ---------- отрисовка ---------- */
/* Строка «Релей»: в LAN-режиме — подключение в этом окне, на сайте (https) —
   открытие страницы релея (ws:// к LAN-IP из https браузер блокирует). */
function netRelayHtml(){
  return '<p class="net-step">Релей: ' +
    '<input id="netRelay" class="net-addr" value="' + escapeHtml(relayTarget) + '" placeholder="192.168.1.50:8080"> ' +
    '<button type="button" id="netRelayGo" class="net-mini">' + (NET_RELAY ? 'Подключиться' : 'Открыть релей') + '</button>' +
    (NET_RELAY ? (relayReady ? ' <span class="net-ok">● онлайн</span>' : ' <span class="net-wait">● подключение…</span>') : '') +
  '</p>';
}
function netBindRelayLine(){
  const rg = document.getElementById('netRelayGo');
  if(rg) rg.addEventListener('click', ()=>{
    const el = document.getElementById('netRelay');
    const val = el ? el.value : '';
    if(NET_RELAY) relayConnect(val); else openLocalRelay(val);
  });
  const rl = document.getElementById('netRelay');
  if(rl) rl.addEventListener('keydown', e=>{
    if(e.key !== 'Enter') return;
    if(NET_RELAY) relayConnect(rl.value); else openLocalRelay(rl.value);
  });
}

function renderNetBody(){
  if(!netReady()){
    netStepsEl.innerHTML = '<p class="net-step">Для сетевой игры нужен вход через портал — соперники подбираются среди вошедших. Нажмите «🔑 Войти через портал» в панели или на стартовом экране.</p>' + netRelayHtml();
    netBindRelayLine();
    return;
  }
  if(!netRoom.active){ renderLobby(); return; }
  renderRoom();
}

function renderLobby(){
  const canStart = NET_RELAY ? relayReady : true;
  const rows = netRoom.lobbyRooms.map(r=>{
    const full = r.count >= r.max;
    const status = r.started ? 'идёт' : 'ожидание';
    return '<div class="net-room">' +
      '<div class="net-room-main"><b>' + escapeHtml(r.title || 'Игра') + '</b>' +
        '<small>' + escapeHtml(r.host_name || '—') + ' · ' + netMapName(r.map) + ' · ' + status + '</small></div>' +
      '<div class="net-room-side"><span>' + r.count + '/' + r.max + '</span>' +
        '<button type="button" data-join="' + r.id + '"' + ((full || !canStart) ? ' disabled' : '') + '>Войти</button></div>' +
    '</div>';
  }).join('');

  let head = netRelayHtml();
  if(NET_RELAY){
    head +=
      '<p class="net-step">Ваше имя: ' +
        '<input id="netName" class="net-name" maxlength="24" value="' + escapeHtml(lanName()) + '"></p>';
  }

  netStepsEl.innerHTML = head +
    '<p class="net-step">Название новой игры: ' +
      '<input id="netTitle" class="net-name" maxlength="40" placeholder="по умолчанию"></p>' +
    '<div class="gp-btns net-row">' +
      '<button type="button" id="netCreate"' + (canStart ? '' : ' disabled') + '>➕ Создать игру</button>' +
      '<button type="button" id="netQuick"' + (canStart ? '' : ' disabled') + '>⚡ Быстрая игра</button>' +
      '<button type="button" id="netRefresh" title="Обновить список">🔄</button>' +
    '</div>' +
    '<p class="net-step">Открытые игры — выберите нужную и нажмите «Войти»:</p>' +
    (netRoom.lobbyRooms.length
      ? '<div class="net-rooms">' + rows + '</div>'
      : '<p class="net-step">Пока нет открытых игр. Создайте первую.</p>');

  const c = document.getElementById('netCreate');  if(c) c.addEventListener('click', netCreate);
  const q = document.getElementById('netQuick');   if(q) q.addEventListener('click', netQuick);
  const rf = document.getElementById('netRefresh'); if(rf) rf.addEventListener('click', refreshLobby);
  const nm = document.getElementById('netName');
  if(nm) nm.addEventListener('change', ()=>{
    const v = nm.value.trim().slice(0, 24);
    if(!v) return;
    try{ localStorage.setItem(LAN_NAME_KEY, v); }catch(_){}
    netRoom.selfName = v;
    relayHello(v);
  });
  netBindRelayLine();
  netStepsEl.querySelectorAll('button[data-join]').forEach(b=>
    b.addEventListener('click', ()=> netJoin(Number(b.dataset.join))));
}

function renderRoom(){
  const info = netRoom.info || {};
  const isHost = info.host_user_id === netRoom.selfId;
  const mode = (info.params && info.params.mode) || 'angle';

  const rows = ['<div class="net-player"><span>' + escapeHtml(netRoom.selfName) + '</span><em>' + (isHost ? 'вы · хост' : 'вы') + '</em></div>'];
  for(const p of netRoom.peers.values()){
    let stateTxt;
    if(p.open) stateTxt = 'соединён';
    else if(p.iceState === 'failed' || p.connState === 'failed') stateTxt = 'ошибка соединения';
    else stateTxt = 'подключение…';
    const tag = (p.userId === info.host_user_id ? ' · хост' : '') + ' · ' + stateTxt;
    rows.push('<div class="net-player"><span>' + escapeHtml(p.name) + '</span><em>' + tag.trim() + '</em></div>');
  }

  let controls;
  if(isHost){
    const mapBtns = netRoom.maps.map(m =>
      '<button type="button" data-map="' + m + '" class="' + (m === info.map ? 'sel' : '') + '">' + netMapName(m) + '</button>').join('');
    const modeBtns =
      '<button type="button" data-mode="angle" class="' + (mode === 'angle' ? 'sel' : '') + '">🎯 Angle</button>' +
      '<button type="button" data-mode="acro" class="' + (mode === 'acro' ? 'sel' : '') + '">🌀 Acro</button>';
    const curCount = 1 + netRoom.peers.size;
    const sizeBtns = netRoom.maxOptions.map(n =>
      '<button type="button" data-max="' + n + '" class="' + (n === info.max ? 'sel' : '') + '"' +
      (n < curCount ? ' disabled' : '') + '>' + n + '</button>').join('');
    controls =
      '<p class="net-h3">Локация</p><div class="net-maps">' + mapBtns + '</div>' +
      '<p class="net-h3">Режим полёта</p><div class="net-maps">' + modeBtns + '</div>' +
      '<p class="net-h3">Участников (макс.)</p><div class="net-maps">' + sizeBtns + '</div>' +
      '<div class="gp-btns net-row">' +
        (info.started ? '<button type="button" id="netStart">🔁 Перезапустить гонку</button>'
                      : '<button type="button" id="netStart">🚀 Начать игру</button>') +
        '<button type="button" id="netLeave" class="net-ghost">Выйти</button>' +
      '</div>';
  } else {
    controls =
      '<p class="net-step">Локация хоста: <b>' + netMapName(info.map) + '</b>, режим <b>' + (mode === 'angle' ? 'Angle' : 'Acro') + '</b>.</p>' +
      (info.started ? '<p class="net-step">Игра идёт — летайте вместе.</p>'
                    : '<p class="net-step">Ожидание старта хоста…</p>') +
      '<div class="gp-btns net-row"><button type="button" id="netLeave" class="net-ghost">Выйти из игры</button></div>';
  }

  netStepsEl.innerHTML =
    '<div class="net-player"><span>' + escapeHtml(info.title || 'Игра') + '</span><em>' +
      (info.started ? 'идёт' : 'ожидание') + ' · ' + netMapName(info.map) + '</em></div>' +
    '<p class="net-step">Участники (' + rows.length + '/' + netRoom.max + '):</p>' +
    '<div class="net-players">' + rows.join('') + '</div>' + controls;

  const st = document.getElementById('netStart');  if(st) st.addEventListener('click', hostStart);
  const lv = document.getElementById('netLeave');  if(lv) lv.addEventListener('click', netLeave);
  netStepsEl.querySelectorAll('button[data-map]').forEach(b=> b.addEventListener('click', ()=> hostSetMap(b.dataset.map)));
  netStepsEl.querySelectorAll('button[data-mode]').forEach(b=> b.addEventListener('click', ()=> hostSetMode(b.dataset.mode)));
  netStepsEl.querySelectorAll('button[data-max]').forEach(b=> b.addEventListener('click', ()=> hostSetMax(Number(b.dataset.max))));
}

/* ---------- HTTP API ---------- */
async function netApi(path, body){
  const res = await fetch(NET_API + '/' + path, {
    method:'POST',
    credentials:'include',
    headers:{ 'Content-Type':'application/json', 'Accept':'application/json' },
    body: JSON.stringify(body || {}),
  });
  let data = null;
  try{ data = await res.json(); }catch(_){}
  if(!res.ok){
    const err = new Error((data && data.error) || ('HTTP ' + res.status));
    err.status = res.status;
    throw err;
  }
  return data || {};
}

async function netCreate(){
  if(!netReady() || netRoom.active) return;
  const titleEl = document.getElementById('netTitle');
  const title = titleEl ? titleEl.value.trim().slice(0, 40) : '';
  if(NET_RELAY){ relaySend({ t:'create', title }); netSetStatus('⟳ Создание игры…', true); return; }
  netSetStatus('⟳ Создание игры…', true);
  try{ await enterRoom(await netApi('create.php', { title })); }
  catch(err){ netSetStatus('⚠ ' + err.message, false); }
}
async function netQuick(){
  if(!netReady() || netRoom.active) return;
  if(NET_RELAY){ relaySend({ t:'quick' }); netSetStatus('⟳ Поиск игры…', true); return; }
  netSetStatus('⟳ Поиск игры…', true);
  try{ await enterRoom(await netApi('find.php', {})); }
  catch(err){ netSetStatus('⚠ ' + err.message, false); }
}
async function netJoin(roomId){
  if(!netReady() || netRoom.active) return;
  if(NET_RELAY){ relaySend({ t:'join', roomId }); netSetStatus('⟳ Подключение…', true); return; }
  netSetStatus('⟳ Подключение…', true);
  try{ await enterRoom(await netApi('join.php', { room_id: roomId })); }
  catch(err){ netSetStatus('⚠ ' + err.message, false); }
}

async function enterRoom(data){
  stopLobbyPolling();
  netRoom.active = true;
  netRoom.id = Number(data.room && data.room.id) || 0;
  netRoom.selfId = data.self ? Number(data.self.id) : (Number(authUser.id) || 0);
  netRoom.selfSlot = data.self && data.self.slot != null ? Number(data.self.slot) : 0;
  netRoom.selfName = (data.self && data.self.name) || netSelfName();
  netRoom.max = Number(data.max) || NET_MAX;
  if(Array.isArray(data.maxOptions) && data.maxOptions.length) netRoom.maxOptions = data.maxOptions;
  if(data.maxHard) netRoom.maxHard = Number(data.maxHard) || netRoom.maxHard;
  if(Array.isArray(data.maps) && data.maps.length) netRoom.maps = data.maps;
  netRoom.info = data.room || null;
  netRoom.control = {};
  netRoom.appliedMap = '';
  netRoom.appliedMode = '';
  netRoom.startedSeen = false;
  await netLoadIce();            // STUN/TURN до создания соединений
  if(!netRoom.active) return;    // пока ждали — могли выйти
  applyParticipants(data.participants || []);
  applyNetGame(true);
  startNetPolling();
  updateNetStatusText();
  renderNetBody();
}

/* ICE-серверы (STUN + TURN с временными креденшелами) с бэкенда. */
async function netLoadIce(){
  try{
    const data = await netApi('ice.php', {});
    if(Array.isArray(data.iceServers) && data.iceServers.length){
      netRoom.iceServers = data.iceServers;
    }
  }catch(_){ /* остаются STUN по умолчанию */ }
}

async function netLeave(){
  stopLobbyPolling();
  stopNet();
  updateNetStatusText();
  renderNetBody();
  if(!NET_RELAY && authUser && netModalEl.classList.contains('show')) startLobbyPolling();
}

function stopNet(){
  if(netKickTimer){ clearTimeout(netKickTimer); netKickTimer = null; }
  if(netRoom.pollTimer){ clearInterval(netRoom.pollTimer); netRoom.pollTimer = null; }
  const roomId = netRoom.id;
  for(const id of Array.from(netRoom.peers.keys())) removePeer(id);
  netRoom.pending = [];
  netRoom.control = {};
  netRoom.active = false;
  netRaceStop();
  netRoom.polling = false;
  netRoom.info = null;
  if(NET_RELAY){
    relaySend({ t:'leave' });
    return;
  }
  if(roomId){
    // best-effort: уведомить сервер (sendBeacon тоже сработает при уходе со страницы)
    fetch(NET_API + '/leave.php', {
      method:'POST', credentials:'include',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ room_id: roomId }), keepalive:true,
    }).catch(()=>{});
  }
}

/* ---------- поллинг лобби и комнаты ---------- */
function startLobbyPolling(){
  if(netRoom.lobbyTimer) clearInterval(netRoom.lobbyTimer);
  refreshLobby();
  netRoom.lobbyTimer = setInterval(refreshLobby, NET_POLL_MS);
}
function stopLobbyPolling(){
  if(netRoom.lobbyTimer){ clearInterval(netRoom.lobbyTimer); netRoom.lobbyTimer = null; }
}
async function refreshLobby(){
  if(NET_RELAY){ relaySend({ t:'lobby' }); return; }
  if(netRoom.active || !authUser) return;
  try{
    const data = await netApi('rooms.php', {});
    netRoom.lobbyRooms = data.rooms || [];
    if(Array.isArray(data.maps) && data.maps.length) netRoom.maps = data.maps;
    if(!netRoom.active) renderLobby();
  }catch(_){}
}

function startNetPolling(){
  if(netRoom.pollTimer) clearInterval(netRoom.pollTimer);
  netPollOnce();
  netRoom.pollTimer = setInterval(netPollOnce, NET_POLL_MS);
}
function netKick(){
  if(!netRoom.active || netKickTimer) return;
  netKickTimer = setTimeout(()=>{ netKickTimer = null; netPollOnce(); }, 150);
}

async function netPollOnce(){
  if(!netRoom.active || netRoom.polling) return;
  netRoom.polling = true;
  try{
    const send = netRoom.pending.slice();
    const control = (netRoom.control && Object.keys(netRoom.control).length) ? netRoom.control : null;
    const body = { room_id: netRoom.id, send };
    if(control) body.control = control;
    const data = await netApi('exchange.php', body);
    if(send.length) netRoom.pending = netRoom.pending.filter(x => send.indexOf(x) === -1);
    if(control) netRoom.control = {};
    if(data.room) netRoom.info = data.room;
    if(data.max) netRoom.max = Number(data.max);
    if(Array.isArray(data.maxOptions) && data.maxOptions.length) netRoom.maxOptions = data.maxOptions;
    applyParticipants(data.participants || []);
    applyNetGame(false);
    for(const sig of (data.signals || [])) await handleSignal(sig);
    updateNetStatusText();
    renderNetBody();
  }catch(err){
    if(err.status === 401)      stopNet(), netSetStatus('⚠ Требуется вход через портал', false);
    else if(err.status === 404) stopNet(), netSetStatus('○ Игра закрыта', false);
    else if(err.status === 403) stopNet(), netSetStatus('○ Сессия закрыта', false);
  }finally{
    netRoom.polling = false;
  }
}

/* ---------- управление игрой (хост) ---------- */
/* Единый хост-контроль: mesh — через exchange (control), релей — через WS. */
function hostControl(patch){
  const info = netRoom.info;
  if(!info || info.host_user_id !== netRoom.selfId) return;
  if('map' in patch) info.map = patch.map;
  if('mode' in patch){ info.params = info.params || {}; info.params.mode = patch.mode; }
  if('max' in patch){ info.max = patch.max; netRoom.max = patch.max; }
  if('started' in patch) info.started = !!patch.started;
  if(NET_RELAY){
    relaySend(Object.assign({ t:'control' }, patch));
  } else {
    netRoom.control = Object.assign(netRoom.control || {}, patch);
    netKick();
  }
  applyNetGame(true);
  renderNetBody();
}
function hostSetMap(map){ hostControl({ map }); }
function hostSetMode(mode){ hostControl({ mode }); }
function hostSetMax(max){
  if(max < (1 + netRoom.peers.size)) return; // нельзя меньше числа текущих участников
  hostControl({ max });
}
function hostStart(){
  /* повторное «Начать игру» в идущей гонке — общий перезапуск */
  if(netRoom.info && netRoom.info.started){
    netRaceReset();
    netBroadcast({ t:'reset' });
    return;
  }
  hostControl({ started:true });
}

/* Применить карту/режим хоста: у хоста — сразу, у гостей — при старте. */
function applyNetGame(force){
  const info = netRoom.info;
  if(!info) return;
  const isHost = info.host_user_id === netRoom.selfId;
  const started = !!info.started;
  if(!(started || (force && isHost))) return;

  let loadedNow = false;
  if(netRoom.appliedMap !== info.map){
    netRoom.appliedMap = info.map;
    if(info.map !== 'forest'){ cfg.map = info.map; saveCfg(); }   /* 'forest' — только сетевая трасса */
    hideStart();
    const li = (info.map === 'forest')
      ? LEVELS.findIndex(l => l.terrain === 'forest')
      : LEVELS.findIndex(l => l.free);
    loadLevel(li >= 0 ? li : LEVELS.length - 1);
    netPlaceLocalAtSpawn();
    loadedNow = true;
  }
  const mode = (info.params && info.params.mode) || 'angle';
  if(netRoom.appliedMode !== mode){
    netRoom.appliedMode = mode;
    setFlightMode(mode);
  }

  /* Как только игра началась — переходим в неё, окно закрываем сами.
     Для трасс на время у хоста перезагружаем уровень, чтобы таймер стартовал
     ровно с началом игры, а не с выбора карты (у гостей уровень только что загружен). */
  if(started && !netRoom.startedSeen){
    netRoom.startedSeen = true;
    if(!loadedNow){ loadLevel(currentLevelIndex); netPlaceLocalAtSpawn(); }   /* чистый старт */
    if(netModalEl.classList.contains('show')) closeNetModal();
    netRaceBegin();
  }
}

/* Поставить местный дрон в персональную точку спавна (не в общий ноль). */
function netPlaceLocalAtSpawn(){
  const s = netSpawn(netRoom.selfSlot);
  const lv = LEVELS[currentLevelIndex] || {};
  state.pos.set(s.x, s.y, s.z);
  state.vel.set(0, 0, 0);
  state.yaw = (lv.start && lv.start.yaw) || 0;
  state.pitch = 0; state.roll = 0;
  state.quat.setFromEuler(_e.set(0, state.yaw, 0, 'YXZ'));
  camera.position.set(s.x, s.y + 3.4, s.z - 9);
}

/* ============================================================
   СЕТЕВАЯ ГОНКА: общий старт (ready → go → отсчёт), общий прогресс
   и итоговое табло. Сообщения идут тем же каналом, что и состояние
   (DataChannel в mesh, WebSocket в LAN-релее).
   ============================================================ */
const netRace = {
  active: false,
  phase: 'idle',       // idle | waiting | countdown | running | done
  countdown: 0,
  waitUntil: 0,
  ready: new Set(),    // id участников, подтвердивших готовность (для хоста)
  results: new Map(),  // id -> { name, prog, time, done, failed, fin }
  lastSent: 0,
  selfFailed: false,
};
const countdownEl = document.getElementById('countdown');
const raceBoardEl = document.getElementById('raceBoard');

function netBroadcast(obj){
  if(NET_RELAY){ relaySend(obj); return; }
  const payload = JSON.stringify(obj);
  for(const p of netRoom.peers.values()){
    if(p.open && p.dc && p.dc.readyState === 'open'){ try{ p.dc.send(payload); }catch(_){} }
  }
}
function netRaceIsHost(){ return !!(netRoom.info && netRoom.selfId === netRoom.info.host_user_id); }
function netRaceTotal(){ const lv = LEVELS[currentLevelIndex]; return (lv && lv.gates) ? lv.gates.length : 0; }
function netRaceStop(){
  netRace.active = false; netRace.phase = 'idle';
  netRace.ready.clear(); netRace.results.clear();
  if(raceBoardEl) raceBoardEl.classList.remove('show');
  if(countdownEl) countdownEl.classList.remove('show');
}
/* Уровень загружен, все на старте — начинаем общий отсчёт. */
function netRaceBegin(){
  if(!netRoom.active || !netRoom.info || !netRoom.info.started) return;
  netRace.active = true;
  netRace.results.clear(); netRace.ready.clear();
  netRace.selfFailed = false;
  netRace.phase = 'waiting';
  netRace.waitUntil = performance.now() + (netRaceIsHost() ? 6000 : 9000);   /* не ждём «готов» вечно */
  netRaceSendState(true);
  netBroadcast({ t:'ready', name: netRoom.selfName });
  netRaceMaybeGo();
}
function netRaceMaybeGo(){
  if(!netRaceIsHost() || netRace.phase !== 'waiting') return;
  if(netRace.ready.size >= netRoom.peers.size) netRaceGo();
}
function netRaceGo(){
  if(netRace.phase === 'countdown' || netRace.phase === 'running') return;
  netRace.phase = 'countdown';
  netRace.countdown = 3.2;
  if(netRaceIsHost()) netBroadcast({ t:'go', sec: netRace.countdown });
  renderCountdown();
}
/* Полный перезапуск гонки (по кнопке хоста). */
function netRaceReset(){
  netRace.results.clear(); netRace.ready.clear();
  netRace.selfFailed = false;
  loadLevel(currentLevelIndex);
  netPlaceLocalAtSpawn();
  netRaceBegin();
}
function netRaceHandle(fromId, m){
  if(m.t === 'ready'){
    if(netRaceIsHost()){ netRace.ready.add(Number(fromId)); netRaceMaybeGo(); }
    return;
  }
  if(m.t === 'go'){
    if(netRace.phase === 'waiting' || netRace.phase === 'idle'){
      netRace.active = true;
      netRace.phase = 'countdown';
      netRace.countdown = Number(m.sec) || 3.2;
      renderCountdown();
    }
    return;
  }
  if(m.t === 'reset'){ netRaceReset(); return; }
  if(m.t === 'race'){
    netRace.results.set(Number(fromId), {
      name: String(m.name || 'Пилот').slice(0, 24),
      prog: Number(m.prog) || 0,
      time: Number(m.time) || 0,
      done: !!m.done,
      failed: !!m.failed,
      fin: m.fin != null ? Number(m.fin) : null,
    });
    updateRaceBoard();
    if(netRace.phase === 'done') renderRaceResult();
    return;
  }
}
function netRaceSendState(force){
  if(!netRace.active) return;
  const now = performance.now();
  if(!force && now - netRace.lastSent < 300) return;
  netRace.lastSent = now;
  const ended = !!(levelState && levelState.done);
  const done = ended && !netRace.selfFailed;
  const time = levelState ? levelState.elapsed : 0;
  const rec = { name: netRoom.selfName, prog: levelState ? levelState.progress : 0, time,
                done, failed: ended && netRace.selfFailed, fin: done ? time : null };
  netRace.results.set(netRoom.selfId, rec);
  netBroadcast(Object.assign({ t:'race' }, rec));
  updateRaceBoard();
}
/* Общая сортировка: финишировавшие по времени, затем «в гонке»/DNF по прогрессу. */
function netRaceSortRows(){
  const rows = [...netRace.results.entries()].map(([id, r]) => Object.assign({ id }, r));
  rows.sort((a, b) => {
    if(a.done !== b.done) return a.done ? -1 : 1;
    if(a.done) return (a.fin || 0) - (b.fin || 0);
    if(a.failed !== b.failed) return a.failed ? 1 : -1;
    return b.prog - a.prog;
  });
  return rows;
}
function netRaceRowHtml(r, i, total, result){
  const status = r.done ? (r.fin || 0).toFixed(result ? 2 : 1) + ' с'
               : r.failed ? 'сход'
               : r.prog + '/' + total + (result ? ' — в гонке' : '');
  const meCls = (r.id === netRoom.selfId ? ' me' : '') + (r.done ? ' done' : '');
  if(result){
    return '<div class="res-row' + meCls + '"><b>' + (i + 1) + '</b> ' +
      '<span>' + escapeHtml(r.name) + '</span> <em>' + status + '</em></div>';
  }
  return '<div class="rr' + meCls + '">' +
    '<span class="nm">' + (i + 1) + '. ' + escapeHtml(r.name) + '</span>' +
    '<span class="tm">' + status + '</span></div>';
}
function updateRaceBoard(){
  if(!raceBoardEl) return;
  if(!netRace.active || netRace.results.size === 0){ raceBoardEl.classList.remove('show'); return; }
  const total = netRaceTotal();
  const rows = netRaceSortRows();
  const fin = rows.filter(r => r.done).length;
  raceBoardEl.innerHTML = '<div class="ttl">ГОНКА · финиш ' + fin + '/' + rows.length + '</div>' +
    rows.map((r, i) => netRaceRowHtml(r, i, total, false)).join('');
  raceBoardEl.classList.add('show');
}
function renderCountdown(){
  if(!countdownEl) return;
  if(netRace.phase === 'waiting'){
    countdownEl.textContent = 'Ожидание игроков…';
    countdownEl.classList.add('show', 'wait'); return;
  }
  if(netRace.phase === 'countdown'){
    countdownEl.classList.remove('wait');
    const n = Math.ceil(netRace.countdown);
    countdownEl.textContent = n > 0 ? String(n) : 'СТАРТ!';
    countdownEl.classList.add('show'); return;
  }
  countdownEl.classList.remove('show');
}
/* Итоговое табло гонки (оверлей поверх всего). */
function showRaceResult(){
  netRace.phase = 'done';
  renderRaceResult();
  overlayEl.classList.add('show');
  makeCollapsible(overlayEl);
  paused = true;
}
function renderRaceResult(){
  const total = netRaceTotal();
  const rows = netRaceSortRows();
  overlayEl.innerHTML = '<div class="card"><h2>Результаты гонки</h2>' +
    '<div class="results">' + rows.map((r, i) => netRaceRowHtml(r, i, total, true)).join('') + '</div>' +
    '<div class="btns"><button data-action="close">Продолжить</button>' +
    '<button class="primary" data-action="menu">К уровням</button></div></div>';
}

/* ---------- участники и пары ---------- */
function applyParticipants(list){
  const seen = new Set();
  for(const part of list){
    const id = Number(part.user_id);
    if(!id || id === netRoom.selfId) continue;
    seen.add(id);
    ensurePeer(id, part.name, part.slot);
  }
  for(const id of Array.from(netRoom.peers.keys())){
    if(!seen.has(id)) removePeer(id);
  }
}

function ensurePeer(userId, name, slot){
  userId = Number(userId);
  let p = netRoom.peers.get(userId);
  if(!p){
    const s = netSpawn(slot != null ? Number(slot) : 0);
    p = {
      userId,
      name: name || 'Пилот',
      slot: slot != null ? Number(slot) : 0,
      pc: null, dc: null,
      targetPos: new THREE.Vector3(s.x, s.y, s.z),
      targetQuat: new THREE.Quaternion(),
      obj: null, props: [], label: null,
      open: false,
    };
    netRoom.peers.set(userId, p);
  }
  if(name) p.name = name;
  if(slot != null) p.slot = Number(slot);
  if(NET_RELAY){
    /* Релей: соединение одно (WebSocket), борт показываем сразу. */
    if(!p.open){ p.open = true; showPeerDrone(p, true); }
  } else if(!p.pc){
    createPeerConnection(p);
  }
  return p;
}

function createPeerConnection(p){
  p.pc = new RTCPeerConnection({ iceServers: netRoom.iceServers });
  p.createdAt = Date.now();
  p.iceState = '';
  p.connState = '';
  p.pc.oniceconnectionstatechange = ()=>{
    p.iceState = p.pc ? p.pc.iceConnectionState : '';
    if(!p.open) renderNetBody();
  };
  p.pc.onconnectionstatechange = ()=>{
    p.connState = p.pc ? p.pc.connectionState : '';
    if(!p.open) renderNetBody();
  };
  p.pc.ondatachannel = e => wirePeerChannel(p, e.channel);

  /* Инициатор пары — участник с меньшим user_id: в паре ровно один offer. */
  if(netRoom.selfId && netRoom.selfId < p.userId){
    const dc = p.pc.createDataChannel('fly', { ordered:false, maxRetransmits:1 });
    wirePeerChannel(p, dc);
    (async ()=>{
      try{
        const offer = await p.pc.createOffer();
        await p.pc.setLocalDescription(offer);
        await netIceDone(p.pc);
        netQueueSdp(p.userId, 'offer', p.pc.localDescription.sdp);
      }catch(_){}
    })();
  }
}

function wirePeerChannel(p, dc){
  p.dc = dc;
  dc.addEventListener('open', ()=>{
    p.open = true;
    try{ dc.send(JSON.stringify({ t:'hello', name: netRoom.selfName })); }catch(_){}
    showPeerDrone(p, true);
    updateNetStatusText();
    renderNetBody();
  });
  dc.addEventListener('close', ()=>{ p.open = false; });
  dc.addEventListener('error', ()=>{ p.open = false; });
  dc.addEventListener('message', ev=>{
    try{
      const m = JSON.parse(ev.data);
      if(m.t === 'hello'){
        if(m.name){ p.name = String(m.name).slice(0, 60); updatePeerLabel(p); renderNetBody(); }
      }else if(m.t === 'st'){
        p.targetPos.set(m.p[0], m.p[1], m.p[2]);
        p.targetQuat.set(m.q[0], m.q[1], m.q[2], m.q[3]);
      }else if(m.t === 'ready' || m.t === 'go' || m.t === 'reset' || m.t === 'race'){
        netRaceHandle(p.userId, m);
      }
    }catch(_){}
  });
}

function netQueueSdp(to, type, sdp){
  netRoom.pending = netRoom.pending.filter(x => !(x.to === to && x.type === type));
  netRoom.pending.push({ to, type, sdp });
  netKick();
}

async function handleSignal(sig){
  const from = Number(sig.from_user_id);
  if(!from || from === netRoom.selfId) return;
  const p = ensurePeer(from);
  if(!p.pc) return;
  let sdp = sig.sdp, type = sig.type;
  // Совместимость со старым форматом (слал JSON описания целиком как sdp).
  if(typeof sdp === 'string' && sdp.charAt(0) === '{'){
    try{ const d = JSON.parse(sdp); if(d && d.sdp){ sdp = d.sdp; if(d.type) type = d.type; } }catch(_){}
  }
  const desc = { type, sdp };
  try{
    if(sig.type === 'offer'){
      await p.pc.setRemoteDescription(desc);
      const answer = await p.pc.createAnswer();
      await p.pc.setLocalDescription(answer);
      await netIceDone(p.pc);
      netQueueSdp(from, 'answer', p.pc.localDescription.sdp);
    }else if(sig.type === 'answer'){
      if(p.pc.signalingState === 'have-local-offer'){
        await p.pc.setRemoteDescription(desc);
      }
    }
  }catch(_){}
}

function netIceDone(p){
  if(!p || !p.iceGatheringState) return Promise.resolve(p);
  if(p.iceGatheringState === 'complete') return Promise.resolve(p);
  return new Promise(res=>{
    const onChange = ()=>{
      if(p.iceGatheringState === 'complete'){
        p.removeEventListener('icegatheringstatechange', onChange);
        res(p);
      }
    };
    p.addEventListener('icegatheringstatechange', onChange);
    setTimeout(()=>{ p.removeEventListener('icegatheringstatechange', onChange); res(p); }, 6000);
  });
}

/* ---------- удалённые борта и подписи имён ---------- */
function showPeerDrone(p, on){
  if(on && !p.obj){
    const built = makeDroneMesh(DRONE_MODELS[0]);
    p.obj = built.group;
    p.props = built.props;
    const s = netSpawn(p.slot);
    p.obj.position.set(s.x, s.y, s.z);
    p.targetPos.set(s.x, s.y, s.z);
    p.targetQuat.set(0, 0, 0, 1);
    scene.add(p.obj);
    updatePeerLabel(p);
  }else if(!on && p.obj){
    if(p.label){ p.obj.remove(p.label); disposeTree(p.label); p.label = null; }
    scene.remove(p.obj);
    disposeTree(p.obj);
    p.obj = null;
    p.props = [];
  }
}

function updatePeerLabel(p){
  if(!p.obj) return;
  if(p.label){ p.obj.remove(p.label); disposeTree(p.label); p.label = null; }
  p.label = makeNameLabel(p.name);
  p.label.position.set(0, 1.7, 0);
  p.obj.add(p.label);
}

function makeNameLabel(name){
  const text = (name || 'Пилот').slice(0, 24);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const font = '600 30px system-ui, "Segoe UI", sans-serif';
  ctx.font = font;
  const pad = 18;
  const w = Math.max(64, Math.ceil(ctx.measureText(text).width) + pad * 2);
  const h = 46;
  canvas.width = w; canvas.height = h;
  ctx.font = font;
  ctx.fillStyle = 'rgba(6,12,20,0.74)';
  roundRectPath(ctx, 1, 1, w - 2, h - 2, 11);
  ctx.fill();
  ctx.strokeStyle = 'rgba(159,208,255,0.5)';
  ctx.lineWidth = 2;
  roundRectPath(ctx, 1, 1, w - 2, h - 2, 11);
  ctx.stroke();
  ctx.fillStyle = '#cfe6ff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2 + 1);

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthTest: false, depthWrite: false,
  }));
  const k = 0.011;
  sprite.scale.set(w * k, h * k, 1);
  sprite.renderOrder = 999;
  return sprite;
}
function roundRectPath(ctx, x, y, w, h, r){
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function removePeer(userId){
  userId = Number(userId);
  const p = netRoom.peers.get(userId);
  if(!p) return;
  showPeerDrone(p, false);
  try{ if(p.dc) p.dc.close(); }catch(_){}
  try{ if(p.pc) p.pc.close(); }catch(_){}
  netRoom.peers.delete(userId);
  updateNetStatusText();
}

/* ---------- тики: интерполяция удалённых бортов и отправка состояния (20 Гц) ---------- */
setInterval(()=>{
  const spin = 10;
  for(const p of netRoom.peers.values()){
    if(!p.obj) continue;
    p.obj.position.lerp(p.targetPos, 0.5);
    p.obj.quaternion.slerp(p.targetQuat, 0.5);
    for(const prop of p.props) prop.rotation.y += prop.userData.dir * spin * 0.05;
  }
}, 50);

setInterval(()=>{
  netRaceSendState();
  if(NET_RELAY){
    if(!netRoom.active || !relayReady) return;
    const qr = state.quat;
    relaySend({ t:'st', p:[state.pos.x, state.pos.y, state.pos.z], q:[qr.x, qr.y, qr.z, qr.w] });
    return;
  }
  if(netRoom.peers.size === 0) return;
  const q = state.quat;
  const payload = JSON.stringify({
    t:'st', p:[state.pos.x, state.pos.y, state.pos.z],
    q:[q.x, q.y, q.z, q.w]
  });
  for(const p of netRoom.peers.values()){
    if(p.open && p.dc && p.dc.readyState === 'open'){
      try{ p.dc.send(payload); }catch(_){}
    }
  }
}, 50);

/* Страховка: если у инициатора за ~7 с канал не открылся — пересоздаём связь. */
setInterval(netPeerWatchdog, 3000);
function netPeerWatchdog(){
  if(NET_RELAY || !netRoom.active) return;
  const now = Date.now();
  for(const p of netRoom.peers.values()){
    if(p.open || !p.pc) continue;
    if(!(netRoom.selfId && netRoom.selfId < p.userId)) continue; // пересоздаёт инициатор пары
    if(p.createdAt && (now - p.createdAt) > 7000 && (p.retries || 0) < 2){
      p.retries = (p.retries || 0) + 1;
      try{ if(p.dc) p.dc.close(); }catch(_){}
      try{ p.pc.close(); }catch(_){}
      p.pc = null;
      p.dc = null;
      createPeerConnection(p);
    }
  }
}

/* ============================================================
   Камеры
   ============================================================ */
const CAM_MODES = ['Погоня', 'Сверху', 'Фиксированная', 'FPV'];
let camMode = 0;
function cycleCamera(){ camMode = (camMode+1) % CAM_MODES.length; updateCamBtn(); }
updateCamBtn();

const camTarget = new THREE.Vector3();
const camDesired = new THREE.Vector3();
const tmpV = new THREE.Vector3();

function updateCamera(dt){
  /* в FPV аппарат скрыт целиком: пропеллеры, нос и корпус не загораживают вид */
  drone.visible = camMode !== 3;
  if(camMode === 3){
    /* FPV: камера в носу дрона, ориентация = канонический кватернион дрона.
       Ранний выход: общий lerp/lookAt ниже затёр бы позицию и кватернион. */
    camera.position.copy(state.pos);
    camera.position.add(tmpV.set(0, 0.22, 0.55).applyQuaternion(state.quat));
    camera.quaternion.copy(state.quat);
    /* камера по умолчанию смотрит вдоль локальной −Z, а нос дрона — +Z,
       поэтому разворачиваем FPV-камеру на 180° вокруг вертикали */
    camera.rotateY(Math.PI);
    camera.rotateX(0.08);             // взгляд чуть вверх, как у реальных FPV-камер
    return;
  } else if(camMode === 0){
    /* позади дрона, вращается вместе с рысканием */
    const off = new THREE.Vector3(0, 3.0, -7.0).applyAxisAngle(new THREE.Vector3(0,1,0), state.yaw);
    camDesired.copy(state.pos).add(off);
    camera.up.set(0,1,0);
    camTarget.copy(state.pos).add(tmpV.set(Math.sin(state.yaw),0,Math.cos(state.yaw)).multiplyScalar(2));
    camTarget.y = state.pos.y + 0.4;
  }else if(camMode === 1){
    /* строго сверху, север вверху */
    camera.up.set(0,0,-1);
    camDesired.copy(state.pos).add(tmpV.set(0,42,0.001));
    camTarget.copy(state.pos);
  }else{
    /* фиксированный мировой ракурс — видно, как дрон поворачивается */
    camera.up.set(0,1,0);
    camDesired.copy(state.pos).add(tmpV.set(12,6,-12));
    camTarget.copy(state.pos);
  }
  const k = 1 - Math.pow(0.001, dt);
  camera.position.lerp(camDesired, camMode===2 ? 0.25 : k);
  camera.lookAt(camTarget);
}

/* Плавный FOV: FPV — 105°, остальные — 62°. */
let camFovCurrent = 62;
function updateCameraFov(){
  const target = (camMode === 3) ? 105 : 62;
  camFovCurrent += (target - camFovCurrent) * 0.18;
  if(Math.abs(camFovCurrent - target) > 0.01){
    camera.fov = camFovCurrent;
    camera.updateProjectionMatrix();
  }
}

/* ============================================================
   Сброс — перезапуск текущего уровня
   ============================================================ */
function resetDrone(){ restartLevel(); }

/* Модификаторы управления, задаваемые уровнем (например, отказ мотора).
   Значения 1 = норма; <1 ослабляет соответствующий канал. */
const ctrl = { pitch:1, roll:1, yaw:1, climb:1, biasYaw:0, emergency:false };

/* продвинутые константы acro */
const ACRO_MAX_YAW = 3.4;       // рад/с
const ACRO_MAX_RATE = 6.5;      // рад/с тангаж/крен
const ACRO_THRUST = 16.0;       // м/с² по оси корпуса
const ACRO_DRAG = 0.09;         // лобовое сопротивление (повышено — меньше выбега/инерции)
const ACRO_ALIGN = 0.8;         // мягкое автовыравнивание при нулевых ставках
/* временные объекты для расчёта ориентации */
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _q2 = new THREE.Quaternion();
const _dq = new THREE.Quaternion();
const _yawQ = new THREE.Quaternion();
const Y_AXIS = new THREE.Vector3(0,1,0);
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();

/* --- рельеф ---
   По умолчанию земля плоская (y=0). Уровень с `terrain:'forest'` задаёт функцию
   высоты `forestTerrain`, которую используют и физика приземления, и постановка
   объектов леса. `aglAlt()` — высота над рельефом (AGL) для HUD и целей. */
let terrainFn = null;
function groundHeightAt(x, z){ return terrainFn ? terrainFn(x, z) : 0; }
function aglAlt(){
  return state.pos.y - GROUND_REST - groundHeightAt(state.pos.x, state.pos.z);
}
/* лес: список деревьев и пространственная сетка для быстрых столкновений */
let forestTrees = [];
let forestGrid = null;

function updatePhysics(dt){
  /* --- итоговые входы: стики + клавиатура --- */
  const lx = clamp(stickL.x + (keys.KeyD?1:0) - (keys.KeyA?1:0), -1, 1);
  const ly = clamp(stickL.y + (keys.KeyW?1:0) - (keys.KeyS?1:0), -1, 1);
  const rx = clamp(stickR.x + (keys.ArrowRight?1:0) - (keys.ArrowLeft?1:0), -1, 1);
  const ry = clamp(stickR.y + (keys.ArrowUp?1:0) - (keys.ArrowDown?1:0), -1, 1);
  syncStickVisuals(lx, ly, rx, ry);

  const throttle = (ly + 1) / 2;   // 0..1

  /* --- батарея: расход пропорционален газу, при разряде тяга падает --- */
  const usage = 0.28 + 0.72*throttle*throttle;
  batteryCharge = Math.max(0, batteryCharge - dt * usage / (BASE_ENDURANCE * perf.cap + 1));
  const bf = batteryCharge > 0.15 ? 1 : 0.25 + 0.75*(batteryCharge/0.15);

  if(flightMode === 'acro'){
    updateAcroPhysics(dt, lx, ly, rx, ry, throttle, bf);
  } else {
    updateAnglePhysics(dt, lx, ly, rx, ry, throttle, bf);
  }

  /* --- винты --- */
  const spin = 8 + throttle*55;
  for(const p of propellers) p.rotation.y += p.userData.dir * spin * dt;

  /* --- позиция солнца/тени следует за дроном --- */
  sun.position.set(state.pos.x+60, 90, state.pos.z+40);
  sun.target.position.copy(state.pos);
  sun.target.updateMatrixWorld();

  /* --- пятно-тень --- */
  shadowBlob.position.set(state.pos.x, groundHeightAt(state.pos.x, state.pos.z) + 0.03, state.pos.z);
  const h = clamp(1 - (state.pos.y-GROUND_REST - groundHeightAt(state.pos.x, state.pos.z))/26, 0.15, 1);
  shadowBlob.scale.setScalar(0.7 + (state.pos.y-GROUND_REST - groundHeightAt(state.pos.x, state.pos.z))*0.05);
  shadowBlob.material.opacity = 0.30 * h;

  updateCamera(dt);
  updateCameraFov();
  updateHUD(throttle, lx, ly, rx, ry);
}

/* ---------- Angle: автостабилизация (исходная аркадная модель) ---------- */
function updateAnglePhysics(dt, lx, ly, rx, ry, throttle, bf){
  /* --- рыскание (с учётом возможного сноса при отказе) --- */
  state.yaw += (-lx * MAX_YAW_RATE * ctrl.yaw + ctrl.biasYaw) * dt;

  /* --- тангаж/крен: цель и авто-выравнивание --- */
  const pitchTarget = ry * MAX_PITCH * ctrl.pitch;   // стик вверх → нос вниз → вперёд
  const rollTarget  = rx * MAX_ROLL * ctrl.roll;     // стик вправо → крен вправо
  const lk = Math.min(1, LEVEL_RATE*dt);
  state.pitch += (pitchTarget - state.pitch) * lk;
  state.roll  += (rollTarget  - state.roll ) * lk;

  /* --- газ и вертикальная скорость --- */
  const vYTarget = (throttle - HOVER_THROTTLE) * 2 * MAX_CLIMB * ctrl.climb * bf;
  state.vel.y += (vYTarget - state.vel.y) * Math.min(1, CLIMB_RATE*dt);

  /* --- горизонтальная скорость из наклона --- */
  const forward = tmpV.set(Math.sin(state.yaw), 0, Math.cos(state.yaw));
  const right = new THREE.Vector3(-Math.cos(state.yaw), 0, Math.sin(state.yaw));
  const pitchNorm = state.pitch / MAX_PITCH;
  const rollNorm  = state.roll  / MAX_ROLL;
  const vmax = MAX_SPEED * perf.maxSpeed * bf;
  const hx = forward.x * pitchNorm * vmax + right.x * rollNorm * vmax;
  const hz = forward.z * pitchNorm * vmax + right.z * rollNorm * vmax;
  const hk = Math.min(1, ACCEL_RATE*dt);
  state.vel.x += (hx - state.vel.x) * hk;
  state.vel.z += (hz - state.vel.z) * hk;

  state.quat.setFromEuler(_e.set(state.pitch, state.yaw, state.roll, 'YXZ'));
  integrateDrone(dt);
}

/* ---------- Acro: угловые скорости, тяга по оси корпуса, гравитация ---------- */
function updateAcroPhysics(dt, lx, ly, rx, ry, throttle, bf){
  /* ставки угловых скоростей (рад/с). Никакого автовыравнивания —
     чистый acro: дрон держит ориентацию, какую ему задал пилот */
  const yawRate    = -lx * ACRO_MAX_YAW  * ctrl.yaw + ctrl.biasYaw;
  const pitchRate  =  ry * ACRO_MAX_RATE * perf.rate * ctrl.pitch;   // стик вверх → нос вниз
  const rollRate   =  rx * ACRO_MAX_RATE * perf.rate * ctrl.roll;

  /* вращение вокруг ЛОКАЛЬНЫХ осей корпуса (кватернионная интеграция):
     pitch — вокруг поперечной (X), roll — вокруг продольной (Z) */
  _dq.setFromEuler(_e.set(pitchRate*dt, 0, rollRate*dt, 'XYZ'));
  state.quat.multiply(_dq);
  /* рыскание — вокруг ЛОКАЛЬНОЙ вертикали корпуса (Y=up), поэтому наклон
     учитывается: при крене/тангаже рыскание уводит нос по конусу (снос
     `biasYaw` при отказе мотора — тоже в локальной оси) */
  if(yawRate !== 0){
    _yawQ.setFromAxisAngle(Y_AXIS, yawRate*dt);
    state.quat.multiply(_yawQ);
  }
  state.quat.normalize();

  /* согласование угловых величин с ориентацией (HUD/физика/гейты) */
  _e.setFromQuaternion(state.quat, 'YXZ');
  state.pitch = _e.x; state.yaw = _e.y; state.roll = _e.z;

  /* тяга вдоль ЛОКАЛЬНОЙ оси корпуса (up) */
  const bodyUp = tmpV.set(0,1,0).applyQuaternion(state.quat);

  /* тяга + гравитация + сопротивление */
  const thrust = throttle * ACRO_THRUST * perf.thrust * ctrl.climb * bf;
  state.vel.y -= 9.81 * dt;
  state.vel.addScaledVector(bodyUp, thrust * dt);
  const d = 1 - ACRO_DRAG * perf.drag * dt;
  state.vel.x *= d; state.vel.y *= d; state.vel.z *= d;

  integrateDrone(dt);
}

/* ============================================================
   Столкновения: ОТСКОК от препятствий и рамок ворот.
   Дрон — сфера радиуса DRONE_R; при проникновении выталкиваем его
   на поверхность и отражаем скорость (с потерей на упругость/трение).
   Провал уровня за удар не наступает — только гасится/меняется вектор.
   ============================================================ */
const DRONE_R       = 0.5;    /* радиус корпуса для столкновений */
const BOUNCE_REST   = 0.45;   /* упругость отскока (0..1) */
const BOUNCE_FRIC   = 0.35;   /* потеря касательной скорости */
const _colN = new THREE.Vector3();
const _colT = new THREE.Vector3();
let stadiumSolids = [];   /* AABB-коллайдеры стадиона (собирает buildStadium) */

/* отражение скорости относительно единичной нормали n (наружу поверхности) */
function bounceOff(n){
  const vn = state.vel.dot(n);
  if(vn >= 0) return;                       /* уже расходятся — не отражаем */
  state.vel.addScaledVector(n, -(1 + BOUNCE_REST) * vn);
  const vn2 = state.vel.dot(n);
  _colT.copy(state.vel).addScaledVector(n, -vn2).multiplyScalar(1 - BOUNCE_FRIC);
  state.vel.copy(_colT).addScaledVector(n, vn2);
}

/* отскок от прямоугольного препятствия (AABB, ось наименьшего проникновения) */
function resolveObstacle(o){
  const [w,h,d] = o.size;
  const hx = w/2 + DRONE_R, hy = h/2 + DRONE_R, hz = d/2 + DRONE_R;
  const dx = state.pos.x - o.pos[0], dy = state.pos.y - o.pos[1], dz = state.pos.z - o.pos[2];
  if(Math.abs(dx) >= hx || Math.abs(dy) >= hy || Math.abs(dz) >= hz) return;
  const px = hx - Math.abs(dx), py = hy - Math.abs(dy), pz = hz - Math.abs(dz);
  let nx = 0, ny = 0, nz = 0, pen;
  if(px <= py && px <= pz){ pen = px; nx = dx < 0 ? -1 : 1; }
  else if(py <= pz)      { pen = py; ny = dy < 0 ? -1 : 1; }
  else                   { pen = pz; nz = dz < 0 ? -1 : 1; }
  state.pos.x += nx*pen; state.pos.y += ny*pen; state.pos.z += nz*pen;
  _colN.set(nx, ny, nz);
  bounceOff(_colN);
}

/* отскок от рамы ворот: квадрат (гонки) или кольцо (упражнения) */
function resolveGate(g){
  if(g.type !== 'ring' || !g.pos) return;
  const r = g.r;
  const yaw = g.faceYaw || 0, cy = Math.cos(yaw), sy = Math.sin(yaw);
  const dx = state.pos.x - g.pos[0], dy = state.pos.y - g.pos[1], dz = state.pos.z - g.pos[2];
  /* локальные оси ворот (поворот на -yaw вокруг Y) */
  const lx = dx*cy - dz*sy, lz = dx*sy + dz*cy, ly = dy;
  let nx, ny, barR;
  if(g.raceGate){
    barR = 0.14;                            /* половина толщины бруса */
    if(Math.abs(lx) <= r && Math.abs(ly) <= r){    /* внутри — тянемся к ближайшей стороне */
      const dR = r - lx, dL = lx + r, dT = r - ly, dB = ly + r;
      const m = Math.min(dR, dL, dT, dB);
      nx = lx; ny = ly;
      if(m === dR) nx = r; else if(m === dL) nx = -r; else if(m === dT) ny = r; else ny = -r;
    } else { nx = clamp(lx, -r, r); ny = clamp(ly, -r, r); }
  } else {
    barR = 0.22;                            /* радиус трубы кольца */
    const phi = Math.atan2(ly, lx);
    nx = r*Math.cos(phi); ny = r*Math.sin(phi);
  }
  let ox = lx - nx, oy = ly - ny, oz = lz;
  let dist = Math.hypot(ox, oy, oz);
  const reach = barR + DRONE_R;
  if(dist >= reach) return;
  if(dist < 1e-4){ ox = lx; oy = ly; oz = lz; dist = Math.hypot(ox, oy, oz) || 1; }
  const nlx = ox/dist, nly = oy/dist, nlz = oz/dist;
  /* выталкиваем центр дрона на поверхность бруса и возвращаем в мировые оси */
  const tx = nx + nlx*reach, ty = ny + nly*reach, tz = nlz*reach;
  state.pos.set(g.pos[0] + tx*cy + tz*sy, g.pos[1] + ty, g.pos[2] - tx*sy + tz*cy);
  _colN.set(nlx*cy + nlz*sy, nly, -nlx*sy + nlz*cy);
  bounceOff(_colN);
}

/* отскок от стволов деревьев: цилиндры, выборка по пространственной сетке */
const FOREST_CELL = 18;
function resolveForestTrees(){
  if(!forestGrid) return;
  const cx = Math.floor(state.pos.x / FOREST_CELL), cz = Math.floor(state.pos.z / FOREST_CELL);
  for(let ix = cx-1; ix <= cx+1; ix++) for(let iz = cz-1; iz <= cz+1; iz++){
    const arr = forestGrid.get(ix + ',' + iz);
    if(!arr) continue;
    for(const i of arr){
      const t = forestTrees[i];
      const dx = state.pos.x - t.x, dz = state.pos.z - t.z;
      const reach = t.r + DRONE_R;
      const d2 = dx*dx + dz*dz;
      if(d2 >= reach*reach) continue;
      if(state.pos.y < t.y0 - 0.3 || state.pos.y > t.y1) continue;
      const d = Math.sqrt(d2) || 1;
      const nx = dx/d, nz = dz/d;
      state.pos.x = t.x + nx*reach; state.pos.z = t.z + nz*reach;
      _colN.set(nx, 0, nz);
      bounceOff(_colN);
    }
  }
}

function resolveCollisions(){
  if(!levelState) return;
  const lv = LEVELS[currentLevelIndex];
  if(!lv) return;
  if(lv.obstacles) for(const o of lv.obstacles) resolveObstacle(o);
  for(const o of stadiumSolids) resolveObstacle(o);   /* борта/трибуны/мачты арены */
  resolveForestTrees();                                /* стволы деревьев лесной трассы */
  if(!lv.free){
    for(const g of lv.gates){
      if(g.done || g.type !== 'ring') continue;
      resolveGate(g);
    }
  }
}

/* общее завершение шага: интегрирование, земля, границы, модель */
function integrateDrone(dt){
  state.pos.addScaledVector(state.vel, dt);

  const gY = GROUND_REST + groundHeightAt(state.pos.x, state.pos.z);
  if(state.pos.y < gY){
    state.pos.y = gY;
    if(state.vel.y < 0) state.vel.y = 0;
    /* на земле ориентация доворачивается к «ровно на курсе» (и в acro тоже) */
    const gk = Math.min(1, 8*dt);
    _q2.setFromEuler(_e.set(0, state.yaw, 0, 'YXZ'));
    state.quat.slerp(_q2, gk);
    _e.setFromQuaternion(state.quat, 'YXZ');
    state.pitch = _e.x; state.roll = _e.z;
    state.vel.x *= 1 - Math.min(1, 4*dt);
    state.vel.z *= 1 - Math.min(1, 4*dt);
  }
  state.pos.x = clamp(state.pos.x, -WORLD_LIMIT, WORLD_LIMIT);
  state.pos.z = clamp(state.pos.z, -WORLD_LIMIT, WORLD_LIMIT);

  resolveCollisions();   /* отскок от препятствий и рамок ворот */

  /* в acro ограничения уровня по крену не действуют (см. updateLevel) */
  drone.position.copy(state.pos);
  drone.quaternion.copy(state.quat);
}

/* нормализация угла к диапазону [-PI, PI] */
function wrapPi(a){
  a = (a + Math.PI) % (2*Math.PI);
  if(a < 0) a += 2*Math.PI;
  return a - Math.PI;
}

/* ============================================================
   HUD
   ============================================================ */
const vAlt = document.getElementById('vAlt');
const vSpd = document.getElementById('vSpd');
const vThr = document.getElementById('vThr');
const vPitch = document.getElementById('vPitch');
const vRoll = document.getElementById('vRoll');
const vHdg = document.getElementById('vHdg');
const vMode = document.getElementById('vMode');
const vBat = document.getElementById('vBat');
const compassArrow = document.getElementById('compassArrow');

function updateHUD(throttle){
  const deg = r => r*180/Math.PI;
  vAlt.textContent = aglAlt().toFixed(1) + ' м';
  vSpd.textContent = Math.hypot(state.vel.x, state.vel.z).toFixed(1) + ' м/с';
  vThr.textContent = Math.round(throttle*100) + '%';
  vPitch.textContent = deg(state.pitch).toFixed(0) + '°';
  vRoll.textContent = deg(state.roll).toFixed(0) + '°';
  if(vMode) vMode.textContent = FLIGHT_MODES[flightMode];
  if(vBat){
    const pct = Math.round(batteryCharge*100);
    vBat.textContent = pct + '%';
    vBat.classList.toggle('bat-low', pct < 20);
  }
  let hd = (deg(state.yaw) % 360 + 360) % 360;
  vHdg.textContent = hd.toFixed(0) + '°';
  /* стрелка компаса: 0° = нос вверх (вперёд) */
  compassArrow.style.transform = `rotate(${-hd}deg)`;
  compassArrow.style.borderBottomColor = (levelState && levelState.aligned) ? '#39d353' : '#9fd0ff';
}

/* ============================================================
   FPV HUD (canvas): авиагоризонт, pitch-лестница, компас-лента,
   вариометр, шкала скорости и высоты. Рисуется поверх 3D каждый кадр.
   ============================================================ */
const fpvCanvas = document.getElementById('fpvHud');
const fpvCtx = fpvCanvas ? fpvCanvas.getContext('2d') : null;
const FPV_GREEN = '#7dff8a';
const FPV_OVERLAY_WARN = '#ff5c4d';

function fpvResize(){
  if(!fpvCanvas) return;
  if(fpvCanvas.width !== innerWidth || fpvCanvas.height !== innerHeight){
    fpvCanvas.width = innerWidth;
    fpvCanvas.height = innerHeight;
  }
}
addEventListener('resize', fpvResize);
fpvResize();

function drawFpvHud(){
  if(!fpvCtx) return;
  fpvCtx.clearRect(0, 0, fpvCanvas.width, fpvCanvas.height);
  const W = fpvCanvas.width, H = fpvCanvas.height;
  const cx = W/2, cy = H/2;
  const G = FPV_GREEN, WARN = FPV_OVERLAY_WARN;

  fpvCtx.save();
  fpvCtx.translate(cx, cy);
  fpvCtx.lineCap = 'round';

  /* ---------- Мировая линия горизонта (проекция камеры) ----------
     Берём две точки далеко впереди на уровне глаз, разнесённые по мировой
     горизонтали, и проецируем их экранными координатами. Так линия горизонта
     отражает горизонт мира: наклоняется при крене, смещается при тангаже. */
  const degToPx = H * 0.0055;            // пикселей на градус (для лестницы)
  const eye  = _v1.copy(camera.position);
  const fwdH = _v2.set(Math.sin(state.yaw), 0, Math.cos(state.yaw));
  const rgtH = _v3.set(fwdH.z, 0, -fwdH.x);
  const DIST = 60000, SPAN = 26000;

  const p1 = _v4.copy(eye).addScaledVector(fwdH, DIST).addScaledVector(rgtH,  SPAN).project(camera);
  const s1x = (p1.x*0.5 + 0.5) * W - cx, s1y = (-p1.y*0.5 + 0.5) * H - cy;
  const p2 = _v4.copy(eye).addScaledVector(fwdH, DIST).addScaledVector(rgtH, -SPAN).project(camera);
  const s2x = (p2.x*0.5 + 0.5) * W - cx, s2y = (-p2.y*0.5 + 0.5) * H - cy;

  /* направление линии горизонта на экране и нормаль к ней (вниз экрана) */
  let dirX = s2x - s1x, dirY = s2y - s1y;
  const dirLen = Math.hypot(dirX, dirY) || 1;
  dirX /= dirLen; dirY /= dirLen;
  let nrmX = -dirY, nrmY = dirX;
  if(nrmY < 0){ nrmX = -nrmX; nrmY = -nrmY; }   // нормаль вниз экрана

  /* линия горизонта */
  fpvCtx.strokeStyle = G; fpvCtx.lineWidth = 2;
  fpvCtx.beginPath();
  fpvCtx.moveTo(s1x, s1y); fpvCtx.lineTo(s2x, s2y);
  fpvCtx.stroke();

  /* штриховка «вниз к земле» вдоль линии горизонта */
  fpvCtx.lineWidth = 1.2;
  for(let t=-0.9; t<0.95; t+=0.11){
    const bx = s1x + (s2x - s1x)*(t*0.5 + 0.5);
    const by = s1y + (s2y - s1y)*(t*0.5 + 0.5);
    fpvCtx.beginPath();
    fpvCtx.moveTo(bx, by);
    fpvCtx.lineTo(bx + nrmX*15 - dirX*16, by + nrmY*15 - dirY*16);
    fpvCtx.stroke();
  }

  /* лестница тангажа: шаги вдоль нормали к горизонту (мировая вертикаль) */
  const mx = (s1x + s2x)/2, my = (s1y + s2y)/2;
  fpvCtx.lineWidth = 1.4;
  fpvCtx.font = '10px system-ui,Segoe UI,Arial';
  fpvCtx.textAlign = 'center';
  for(const d of [10,20,30,45,60,-10,-20,-30,-45,-60]){
    const off = d * degToPx;                      // d>0 → вверх по экрану
    const bx = mx - nrmX*off, by = my - nrmY*off;
    const w = (d % 30 === 0) ? 96 : 60;
    fpvCtx.globalAlpha = 0.7;
    fpvCtx.strokeStyle = (d > 0) ? G : 'rgba(255,255,255,.75)';
    fpvCtx.beginPath();
    fpvCtx.moveTo(bx - dirX*w, by - dirY*w);
    fpvCtx.lineTo(bx - dirX*24, by - dirY*24);
    fpvCtx.moveTo(bx + dirX*24, by + dirY*24);
    fpvCtx.lineTo(bx + dirX*w, by + dirY*w);
    fpvCtx.stroke();
    fpvCtx.globalAlpha = 1;
    if(d % 30 === 0){
      fpvCtx.fillStyle = (d > 0) ? G : 'rgba(255,255,255,.8)';
      fpvCtx.fillText(String(Math.abs(d)), bx - dirX*(w+16), by - dirY*(w+16) + 3);
      fpvCtx.fillText(String(Math.abs(d)), bx + dirX*(w+16), by + dirY*(w+16) + 3);
    }
  }

  /* ---------- Шкала крена (дуга сверху, маркер по крену дрона) ---------- */
  {
    const R = Math.min(W,H)*0.30;
    const a0 = -Math.PI/2 - 1.31;         // −75° от вертикали
    const a1 = -Math.PI/2 + 1.31;         // +75°
    fpvCtx.strokeStyle = G; fpvCtx.lineWidth = 1.6;
    fpvCtx.beginPath();
    fpvCtx.arc(0, 0, R, a0, a1);
    fpvCtx.stroke();
    /* деления ±15/±30/±45/±60 и центр */
    fpvCtx.lineWidth = 1.4;
    for(const d of [-60,-45,-30,-15,0,15,30,45,60]){
      const a = -Math.PI/2 + d*Math.PI/180;
      const len = (d === 0) ? 14 : (d % 30 === 0 ? 10 : 6);
      const cA = Math.cos(a), sA = Math.sin(a);
      fpvCtx.beginPath();
      fpvCtx.moveTo(R*cA, R*sA);
      fpvCtx.lineTo((R+len)*cA, (R+len)*sA);
      fpvCtx.stroke();
      if(d % 30 === 0 && d !== 0){
        fpvCtx.font = '10px system-ui,Segoe UI,Arial';
        fpvCtx.fillStyle = G;
        fpvCtx.textAlign = 'center';
        fpvCtx.fillText(String(Math.abs(d)), (R+24)*cA, (R+24)*sA+3);
      }
    }
    /* маркер крена: треугольник, ходящий по дуге ровно на угол крена */
    const rollRad = state.roll;
    const mA = -Math.PI/2 + clamp(rollRad, -1.4, 1.4);
    const mA1 = mA - 0.05, mA2 = mA + 0.05;
    fpvCtx.fillStyle = '#ffd23f';
    fpvCtx.beginPath();
    fpvCtx.moveTo((R-14)*Math.cos(mA),  (R-14)*Math.sin(mA));
    fpvCtx.lineTo((R+6)*Math.cos(mA1), (R+6)*Math.sin(mA1));
    fpvCtx.lineTo((R+6)*Math.cos(mA2), (R+6)*Math.sin(mA2));
    fpvCtx.closePath();
    fpvCtx.fill();
    /* цифровое значение крена */
    fpvCtx.font = '11px system-ui,Segoe UI,Arial';
    fpvCtx.fillStyle = '#ffd23f';
    fpvCtx.textAlign = 'center';
    fpvCtx.fillText('крен ' + (rollRad*180/Math.PI).toFixed(0) + '°', 0, -(R+34));
  }

  /* ---------- Центр-маркер ---------- */
  fpvCtx.strokeStyle = '#ffd23f'; fpvCtx.lineWidth = 3;
  fpvCtx.beginPath();
  fpvCtx.moveTo(-36, 0); fpvCtx.lineTo(-10, 0); fpvCtx.lineTo(-18, 9);
  fpvCtx.moveTo( 36, 0); fpvCtx.lineTo( 10, 0); fpvCtx.lineTo( 18, 9);
  fpvCtx.stroke();

  /* ---------- Компас-лента (курс вверху) ---------- */
  const hd = (state.yaw*180/Math.PI % 360 + 360) % 360;
  fpvCtx.save();
  fpvCtx.translate(cx, 44);
  fpvCtx.font = '11px system-ui,Segoe UI,Arial';
  fpvCtx.textAlign = 'center';
  const tapeHalf = Math.min(W*0.22, 210);
  const pxPerDeg = tapeHalf / 60;
  fpvCtx.strokeStyle = G; fpvCtx.lineWidth = 1.4;
  for(let a=-60; a<=60; a+=5){
    const deg = ((hd + a) % 360 + 360) % 360;
    const x = a * pxPerDeg;
    const major = (deg % 30 === 0);
    fpvCtx.globalAlpha = major ? 0.95 : 0.4;
    fpvCtx.beginPath();
    fpvCtx.moveTo(x, 0); fpvCtx.lineTo(x, major ? 9 : 5);
    fpvCtx.stroke();
    if(major){
      if(deg % 90 === 0){
        fpvCtx.fillStyle = '#ffd23f';
        fpvCtx.fillText(deg===0?'С':deg===90?'В':deg===180?'Ю':'З', x, 24);
      } else {
        fpvCtx.fillStyle = G;
        fpvCtx.fillText(String(deg/10), x, 24);
      }
    }
  }
  fpvCtx.globalAlpha = 1;
  fpvCtx.fillStyle = '#ffd23f';
  fpvCtx.beginPath();
  fpvCtx.moveTo(0, 27); fpvCtx.lineTo(-5, 35); fpvCtx.lineTo(5, 35);
  fpvCtx.closePath(); fpvCtx.fill();
  fpvCtx.fillText(hd.toFixed(0) + '°', 0, 49);
  fpvCtx.restore();

  /* ---------- Скорость (слева), высота и вариометр (справа) ---------- */
  const speed = Math.hypot(state.vel.x, state.vel.z);
  const vsi = state.vel.y;
  const alt = aglAlt();
  fpvCtx.textAlign = 'left';
  fpvCtx.fillStyle = G;
  fpvCtx.font = '11px system-ui,Segoe UI,Arial';
  fpvCtx.fillText('SPD', cx-186, cy-34);
  fpvCtx.font = 'bold 20px system-ui,Segoe UI,Arial';
  fpvCtx.fillText(speed.toFixed(1), cx-186, cy-10);
  fpvCtx.font = '11px system-ui,Segoe UI,Arial';
  fpvCtx.fillStyle = (vsi >= 0) ? G : WARN;
  fpvCtx.fillText((vsi>=0?'▲ ':'▼ ') + Math.abs(vsi).toFixed(1) + ' м/с', cx-186, cy+8);

  fpvCtx.textAlign = 'right';
  fpvCtx.fillStyle = G;
  fpvCtx.fillText('ALT', cx+186, cy-34);
  fpvCtx.font = 'bold 20px system-ui,Segoe UI,Arial';
  fpvCtx.fillText(alt.toFixed(1), cx+186, cy-10);
  fpvCtx.font = '11px system-ui,Segoe UI,Arial';
  fpvCtx.fillText('м', cx+186, cy+10);

  /* предупреждение о низкой высоте при быстром снижении */
  if(alt < 3 && state.vel.y < -1){
    fpvCtx.fillStyle = WARN;
    fpvCtx.font = 'bold 13px system-ui,Segoe UI,Arial';
    fpvCtx.textAlign = 'center';
    fpvCtx.fillText('НИЗКАЯ ВЫСОТА', 0, cy+88);
  }

  fpvCtx.restore();
}

/* ============================================================
   СИСТЕМА ОБУЧАЮЩИХ УРОВНЕЙ
   ============================================================ */
const overlayEl   = document.getElementById('overlay');
const levelmenuEl = document.getElementById('levelmenu');
const menuBtnEl   = document.getElementById('menuBtn');
const lvNameEl    = document.getElementById('lvName');
const lvObjEl     = document.getElementById('lvObj');
const lvProgEl    = document.getElementById('lvProg');
const lvTimeEl    = document.getElementById('lvTime');
const lvDistEl    = document.getElementById('lvDist');
const lvWarnEl    = document.getElementById('lvWarn');

let currentLevelIndex = 0;
let levelState = null;
let paused = false;

/* --- построение сцены уровня --- */
function disposeTree(node){
  node.traverse(o=>{
    if(o.geometry) o.geometry.dispose();
    if(o.material){
      (Array.isArray(o.material)?o.material:[o.material]).forEach(m=>{
        if(m.map) m.map.dispose();
        m.dispose();
      });
    }
  });
}
function clearLevelRoot(){
  for(let i=levelRoot.children.length-1;i>=0;i--){
    const c = levelRoot.children[i];
    disposeTree(c);
    levelRoot.remove(c);
  }
  raceAssets = null;   /* общие материалы/геометрии трасс пересоздаются на новый уровень */
  stadiumSolids = [];  /* объёмные коллайдеры стадиона пересобираются на новый уровень */
  forestTrees = [];    /* деревья лесной трассы */
  forestGrid = null;
}

function buildGateVisual(g, race, idx){
  g.done = false; g.timer = 0;
  g.raceGate = false;                 /* квадратная рама (гонки) или круглое кольцо */
  if(g.type === 'ring' && race){ buildRaceGate(g, idx); return; }
  const grp = new THREE.Group();
  if(g.type === 'ring'){
    const color = 0x3b9dff;
    g.baseColor = color;
    g.mat = new THREE.MeshStandardMaterial({ color, emissive:color, emissiveIntensity:.4, roughness:.4, transparent:true, opacity:.92 });
    grp.add(new THREE.Mesh(new THREE.TorusGeometry(g.r, 0.22, 14, 48), g.mat));
    grp.position.set(g.pos[0], g.pos[1], g.pos[2]);
    grp.rotation.y = g.faceYaw || 0;
  } else if(g.type === 'hover'){
    const color = 0xffd23f;
    g.baseColor = color;
    g.alt = g.pos[1];
    const altTol = g.altTol || 2;
    const zoneMat = new THREE.MeshBasicMaterial({ color, transparent:true, opacity:.13, side:THREE.DoubleSide, depthWrite:false });
    const cyl = new THREE.Mesh(new THREE.CylinderGeometry(g.r,g.r,altTol*2,28,1,true), zoneMat);
    cyl.position.y = g.alt; grp.add(cyl);
    g.zoneMat = zoneMat;
    g.mat = new THREE.MeshStandardMaterial({ color, emissive:color, emissiveIntensity:.5, roughness:.4 });
    const base = new THREE.Mesh(new THREE.TorusGeometry(g.r,0.14,10,48), g.mat);
    base.rotation.x = Math.PI/2; base.position.y = 0.08; grp.add(base);
    const halo = new THREE.Mesh(new THREE.TorusGeometry(g.r,0.12,10,48), g.mat);
    halo.rotation.x = Math.PI/2; halo.position.y = g.alt; grp.add(halo);
    grp.position.set(g.pos[0], 0, g.pos[2]);
  } else if(g.type === 'land'){
    const color = 0x39d353;
    g.baseColor = color;
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(g.r,g.r,0.12,40), new THREE.MeshStandardMaterial({color:0x22303a, roughness:.9}));
    disc.position.y = 0.06; disc.receiveShadow = true; grp.add(disc);
    g.mat = new THREE.MeshStandardMaterial({ color, emissive:color, emissiveIntensity:.6, roughness:.4 });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(Math.max(0.6,g.r-0.5),0.15,10,48), g.mat);
    ring.rotation.x = Math.PI/2; ring.position.y = 0.16; grp.add(ring);
    grp.position.set(g.pos[0],0,g.pos[2]);
  } else if(g.type === 'altitude'){
    const color = 0xffd23f;
    g.baseColor = color;
    g.mat = new THREE.MeshStandardMaterial({ color, emissive:color, emissiveIntensity:.6, roughness:.4 });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(Math.max(2.2, g.r||3),0.14,10,48), g.mat);
    ring.rotation.x = Math.PI/2;
    ring.position.set(g.pos[0], g.pos[1], g.pos[2]);
    grp.add(ring);
  } else {
    g.mat = null;  /* heading — только подсказка в HUD */
  }
  levelRoot.add(grp);
  g.visual = grp;
}

function buildObstacle(o){
  const [w,h,d] = o.size;
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(w,h,d),
    new THREE.MeshStandardMaterial({ color:0xff8a3b, emissive:0x662200, emissiveIntensity:.25, roughness:.6, transparent:true, opacity:.9 })
  );
  box.position.set(o.pos[0],o.pos[1],o.pos[2]);
  box.castShadow = true; box.receiveShadow = true;
  levelRoot.add(box);
}

/* --- детализированные объекты гоночных трасс (MultiGP-стиль) ---
   Общий кэш материалов/геометрий живёт в пределах одной сборки уровня:
   clearLevelRoot() сбрасывает его, а disposeTree() освобождает ресурсы. */
let raceAssets = null;
function makeTextTexture(text, w, h, bg, fg, font){
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  if(bg){ g.fillStyle = bg; g.fillRect(0, 0, w, h); }
  g.font = font; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = Math.max(3, h*0.07); g.strokeStyle = 'rgba(10,14,20,.85)';
  g.strokeText(text, w/2, h/2+2);
  g.fillStyle = fg; g.fillText(text, w/2, h/2+2);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function getRaceAssets(){
  if(raceAssets) return raceAssets;
  const s = 128, n = 8, c = document.createElement('canvas'); c.width = c.height = s;
  const g = c.getContext('2d');
  g.fillStyle = '#f4f7fb'; g.fillRect(0, 0, s, s);
  g.fillStyle = '#12161c';
  const q = s/n;
  for(let y=0;y<n;y++) for(let x=0;x<n;x++) if((x+y)&1) g.fillRect(x*q, y*q, q, q);
  const checker = new THREE.CanvasTexture(c); checker.colorSpace = THREE.SRGBColorSpace;
  raceAssets = {
    checker,
    pole:      new THREE.MeshStandardMaterial({ color:0xe8eef7, roughness:.6, metalness:.1 }),
    cone:      new THREE.MeshStandardMaterial({ color:0xff6a2b, roughness:.75 }),
    coneBand:  new THREE.MeshStandardMaterial({ color:0xf4f7fb, roughness:.75 }),
    flagRed:   new THREE.MeshStandardMaterial({ color:0xff5a3c, roughness:.8, side:THREE.DoubleSide }),
    flagWhite: new THREE.MeshStandardMaterial({ color:0xf4f7fb, roughness:.8, side:THREE.DoubleSide }),
    pillar:    new THREE.MeshStandardMaterial({ color:0x2b313c, roughness:.6, metalness:.25 }),
    poleGeo:   new THREE.CylinderGeometry(0.05, 0.05, 3.2, 6),
    flagGeo:   new THREE.PlaneGeometry(1.05, 0.65),
    coneGeo:   new THREE.ConeGeometry(0.42, 0.95, 10),
    bandGeo:   new THREE.TorusGeometry(0.24, 0.06, 6, 14),
  };
  return raceAssets;
}
/* Квадратные ворота как на реальных трассах: рама, косынки, сетка,
   шахматный флаг сверху и номер ворот. */
function buildRaceGate(g, idx){
  const r = g.r, t = 0.28, A = getRaceAssets();
  g.raceGate = true;
  g.baseColor = 0xffb03a;
  g.mat = new THREE.MeshStandardMaterial({ color:g.baseColor, emissive:0xff7a00, emissiveIntensity:.35, roughness:.45, metalness:.15 });
  g.netMat = new THREE.MeshBasicMaterial({ color:0x3b9dff, transparent:true, opacity:.13, side:THREE.DoubleSide, depthWrite:false });
  const grp = new THREE.Group();
  const postGeo = new THREE.BoxGeometry(t, r*2 + t*2, t);
  const barGeo  = new THREE.BoxGeometry(r*2 + t*2, t, t);
  const parts = [[postGeo,-(r+t/2),0],[postGeo,(r+t/2),0],[barGeo,0,(r+t/2)],[barGeo,0,-(r+t/2)]];
  for(const [geo,x,y] of parts){
    const m = new THREE.Mesh(geo, g.mat);
    m.position.set(x, y, 0); m.castShadow = true; grp.add(m);
  }
  const gGeo = new THREE.BoxGeometry(t*1.25, t*1.25, t*1.25);
  for(const sx of [-1,1]) for(const sy of [-1,1]){
    const gu = new THREE.Mesh(gGeo, g.mat);
    gu.position.set(sx*(r-t*0.1), sy*(r-t*0.1), 0); grp.add(gu);
  }
  const net = new THREE.Mesh(new THREE.PlaneGeometry(r*2, r*2), g.netMat);
  net.renderOrder = 2; grp.add(net);
  const banner = new THREE.Mesh(
    new THREE.PlaneGeometry(r*2 + t*2, 0.7),
    new THREE.MeshBasicMaterial({ map:A.checker, side:THREE.DoubleSide })
  );
  banner.position.set(0, r + t + 0.45, 0.03); grp.add(banner);
  const label = makeTextTexture(String(idx+1), 128, 128, null, '#ffe066', 'bold 80px sans-serif');
  const plate = new THREE.Mesh(
    new THREE.PlaneGeometry(0.95, 0.95),
    new THREE.MeshBasicMaterial({ map:label, transparent:true, depthWrite:false, side:THREE.DoubleSide })
  );
  /* номер развёрнут навстречу пилоту (локальный −Z — откуда он летит) */
  plate.position.set(0, r + t + 1.2, -0.05);
  plate.rotation.y = Math.PI;
  grp.add(plate);
  grp.position.set(g.pos[0], g.pos[1], g.pos[2]);
  grp.rotation.y = g.faceYaw || 0;
  levelRoot.add(grp);
  g.visual = grp;
}
function makeFlag(x, z, flagMat){
  const A = getRaceAssets();
  const grp = new THREE.Group();
  const pole = new THREE.Mesh(A.poleGeo, A.pole); pole.position.y = 1.6; pole.castShadow = true; grp.add(pole);
  const flag = new THREE.Mesh(A.flagGeo, flagMat); flag.position.set(0.58, 2.75, 0); grp.add(flag);
  grp.position.set(x, 0, z);
  levelRoot.add(grp);
}
function makeCone(x, z){
  const A = getRaceAssets();
  const cone = new THREE.Mesh(A.coneGeo, A.cone); cone.position.set(x, 0.48, z); cone.castShadow = true; levelRoot.add(cone);
  const band = new THREE.Mesh(A.bandGeo, A.coneBand); band.rotation.x = Math.PI/2; band.position.set(x, 0.46, z); levelRoot.add(band);
}
/* Стартово-финишная арка над центральной площадкой. */
function buildStartGantry(){
  const A = getRaceAssets();
  const H = 6.4, W = 10.4, ps = 0.42;
  const pillarGeo = new THREE.BoxGeometry(ps, H, ps);
  for(const sx of [-1,1]){
    const p = new THREE.Mesh(pillarGeo, A.pillar);
    p.position.set(sx*W/2, H/2, 0); p.castShadow = true; levelRoot.add(p);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(W+ps, 0.5, 0.5), A.pillar);
  beam.position.set(0, H, 0); beam.castShadow = true; levelRoot.add(beam);
  const tex = makeTextTexture('СТАРТ · ФИНИШ', 512, 96, '#0d1117', '#ffe066', 'bold 54px sans-serif');
  const banner = new THREE.Mesh(
    new THREE.PlaneGeometry(W, 1.5),
    new THREE.MeshBasicMaterial({ map:tex, transparent:true, side:THREE.DoubleSide })
  );
  banner.position.set(0, H-1.1, 0.3); levelRoot.add(banner);
}
/* Флажки у ворот и конусы вдоль гоночной линии. */
function buildRaceProps(lv){
  buildStartGantry();
  const gates = lv.gates || [];
  const A = getRaceAssets();
  const flagMats = [A.flagRed, A.flagWhite];
  let fi = 0;
  for(const g of gates){
    if(g.type !== 'ring') continue;
    const off = (g.r||3) + 1.4, th = g.faceYaw || 0;
    const ox = Math.cos(th)*off, oz = -Math.sin(th)*off;
    makeFlag(g.pos[0]-ox, g.pos[2]-oz, flagMats[fi%2]);
    makeFlag(g.pos[0]+ox, g.pos[2]+oz, flagMats[(fi+1)%2]);
    fi++;
  }
  for(let i=1;i<gates.length;i++){
    const a = gates[i-1].pos, b = gates[i].pos;
    const dx = b[0]-a[0], dz = b[2]-a[2];
    const len = Math.hypot(dx, dz);
    if(len < 2) continue;
    const steps = Math.max(1, Math.floor(len/9));
    for(let s=1;s<steps;s++){
      const u = s/steps;
      const x = a[0]+dx*u, z = a[2]+dz*u;
      if(Math.hypot(x, z) < 6) continue;
      makeCone(x, z);
    }
  }
}

/* ============================================================
   ЛЕСНАЯ ТРАССА — длинная дорога среди деревьев с рельефом.
   Дорога — замкнутое волнистое кольцо; высота задаётся forestTerrain(x,z),
   общей для физики приземления (groundHeightAt) и постановки объектов.
   ============================================================ */
const FOREST_R    = 235;      /* радиус, до которого строится рельеф */
const FOREST_FLAT = 196;      /* отсюда рельеф сходит к плоской земле */

function forestSmooth(a, b, x){ const t = clamp((x-a)/(b-a), 0, 1); return t*t*(3-2*t); }

function forestPath(t){
  const a = t*Math.PI*2;
  const r = 120 + 40*Math.sin(3*a) + 24*Math.cos(5*a + 0.6);
  return { x: Math.cos(a)*r, z: Math.sin(a)*r };
}
function forestTangent(t){
  const e = 0.002;
  const a = forestPath(t-e), b = forestPath(t+e);
  const dx = b.x-a.x, dz = b.z-a.z, L = Math.hypot(dx, dz) || 1;
  return { x: dx/L, z: dz/L };
}
function forestTerrain(x, z){
  const r = Math.hypot(x, z);
  const f = 1 - forestSmooth(FOREST_FLAT, FOREST_R, r);   /* к краю — ровно */
  const h = 22
          + 8.0*Math.sin(x*0.020)
          + 7.0*Math.cos(z*0.023)
          + 4.0*Math.sin((x + z)*0.028);
  return Math.max(0.25, f*h);
}
/* 40 ворот вдоль дороги; высота — над местным рельефом (выше на холмах) */
function buildForestTrack(n){
  const gates = [];
  for(let i = 0; i < n; i++){
    const p = forestPath(i/n), tg = forestTangent(i/n);
    const clr = Math.max(4, 4 + 1.6*Math.sin(i*0.9) + 0.8*Math.sin(i*2.3));
    gates.push({ type:'ring', pos:[p.x, forestTerrain(p.x, p.z) + clr, p.z], r:3.0,
                 faceYaw: Math.atan2(tg.x, tg.z) });
  }
  return gates;
}
/* расстояние от точки до дороги (по ломаной из сэмплов) */
function distToRoad(pts, x, z){
  let best = Infinity;
  for(let i = 1; i < pts.length; i++){
    const d = segDist2(pts[i-1][0], pts[i-1][1], pts[i][0], pts[i][1], x, z);
    if(d < best) best = d;
  }
  return Math.sqrt(best);
}

function buildForestTrees(pts, count){
  const trunkGeo = new THREE.CylinderGeometry(0.16, 0.24, 1.7, 6);
  const leafGeo  = new THREE.ConeGeometry(1.5, 2.3, 7);
  const trunkMat = new THREE.MeshStandardMaterial({ color:0x5a4327, roughness:1 });
  const leafA = new THREE.MeshStandardMaterial({ color:0x2f6d33, roughness:1 });
  const leafB = new THREE.MeshStandardMaterial({ color:0x255227, roughness:1 });
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, count);
  const leaf1  = new THREE.InstancedMesh(leafGeo, leafA, count);
  const leaf2  = new THREE.InstancedMesh(leafGeo, leafB, count);
  trunks.castShadow = leaf1.castShadow = leaf2.castShadow = true;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), tr = new THREE.Vector3();
  let n = 0, guard = 0;
  while(n < count && guard < count*10){
    guard++;
    const ang = rnd()*Math.PI*2, rad = 22 + rnd()*(FOREST_FLAT - 32);
    const x = Math.cos(ang)*rad, z = Math.sin(ang)*rad;
    if(distToRoad(pts, x, z) < 9.5) continue;      /* не ставим на дорогу */
    const y = forestTerrain(x, z);
    const s = 0.8 + rnd()*0.9, ry = rnd()*Math.PI*2;
    q.setFromAxisAngle(Y_AXIS, ry); sc.set(s, s, s);
    tr.set(x, y + 0.85*s, z); m.compose(tr, q, sc); trunks.setMatrixAt(n, m);
    tr.set(x, y + 1.9*s,  z); m.compose(tr, q, sc); leaf1.setMatrixAt(n, m);
    tr.set(x, y + 3.0*s,  z); m.compose(tr, q, sc); leaf2.setMatrixAt(n, m);
    /* коллайдер-цилиндр ствола/кроны */
    forestTrees.push({ x, z, y0:y, y1:y + 4.2*s, r:1.05*s });
    const key = Math.floor(x/FOREST_CELL) + ',' + Math.floor(z/FOREST_CELL);
    const cell = forestGrid.get(key); if(cell) cell.push(n); else forestGrid.set(key, [n]);
    n++;
  }
  trunks.count = leaf1.count = leaf2.count = n;
  trunks.instanceMatrix.needsUpdate = leaf1.instanceMatrix.needsUpdate = leaf2.instanceMatrix.needsUpdate = true;
  levelRoot.add(trunks); levelRoot.add(leaf1); levelRoot.add(leaf2);
}

function buildForest(){
  seed = 24601;
  forestTrees = []; forestGrid = new Map();

  /* --- рельеф --- */
  const seg = 84;
  const geo = new THREE.PlaneGeometry(FOREST_R*2, FOREST_R*2, seg, seg);
  geo.rotateX(-Math.PI/2);
  const pos = geo.attributes.position;
  for(let i = 0; i < pos.count; i++) pos.setY(i, forestTerrain(pos.getX(i), pos.getZ(i)));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  const terrain = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color:0x35502f, roughness:1 }));
  terrain.receiveShadow = true; levelRoot.add(terrain);

  /* --- дорога: лента вдоль кольца --- */
  const N = 300, halfW = 3.6;
  const verts = [], uvs = [], idx = [];
  for(let i = 0; i <= N; i++){
    const t = i/N, p = forestPath(t), tg = forestTangent(t);
    const nx = tg.z, nz = -tg.x;
    const y = forestTerrain(p.x, p.z) + 0.2;
    verts.push(p.x + nx*halfW, y, p.z + nz*halfW);
    verts.push(p.x - nx*halfW, y, p.z - nz*halfW);
    uvs.push(0, i*0.5, 1, i*0.5);
    if(i < N){ const a = i*2; idx.push(a, a+1, a+2, a+1, a+3, a+2); }
  }
  const rgeo = new THREE.BufferGeometry();
  rgeo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  rgeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  rgeo.setIndex(idx); rgeo.computeVertexNormals();
  const road = new THREE.Mesh(rgeo, new THREE.MeshStandardMaterial({ color:0x5b5246, roughness:1 }));
  road.receiveShadow = true; levelRoot.add(road);

  /* --- деревья --- */
  const pts = [];
  for(let i = 0; i <= 200; i++){ const p = forestPath(i/200); pts.push([p.x, p.z]); }
  buildForestTrees(pts, 900);

  /* --- стартовая арка «СТАРТ · ФИНИШ» на дороге, по рельефу --- */
  const t0 = -1/80, sp = forestPath(t0), stg = forestTangent(t0);
  const arch = new THREE.Group();
  const AH = 5.5, AW = 7.6;
  const archMat = new THREE.MeshStandardMaterial({ color:0x2b313c, roughness:.6, metalness:.3 });
  const postGeo = new THREE.BoxGeometry(0.35, AH, 0.35);
  for(const sx of [-1, 1]){
    const post = new THREE.Mesh(postGeo, archMat);
    post.position.set(sx*AW/2, AH/2, 0); post.castShadow = true; arch.add(post);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(AW + 0.35, 0.4, 0.4), archMat);
  beam.position.y = AH; beam.castShadow = true; arch.add(beam);
  const banner = new THREE.Mesh(
    new THREE.PlaneGeometry(AW, 1.1),
    new THREE.MeshBasicMaterial({ map: makeTextTexture('СТАРТ · ФИНИШ', 512, 96, '#0d1117', '#ffe066', 'bold 54px sans-serif'), transparent:true, side:THREE.DoubleSide })
  );
  banner.position.set(0, AH - 0.8, -0.22); banner.rotation.y = Math.PI; arch.add(banner);
  arch.position.set(sp.x, forestTerrain(sp.x, sp.z), sp.z);
  arch.rotation.y = Math.atan2(stg.x, stg.z);
  levelRoot.add(arch);
}

/* --- описания уровней (возрастающая сложность) --- */
const LEVELS = [
  {
    name:'Взлёт и посадка',
    brief:'Поднимитесь выше 4 м и мягко приземлитесь в центр площадки.',
    start:{x:0,y:GROUND_REST,z:0,yaw:0},
    gates:[
      { type:'altitude', pos:[0,4,0], r:3.5 },
      { type:'land', pos:[0,GROUND_REST,0], r:3.5, maxSpeed:1.5 },
    ],
  },
  {
    name:'Рыскание',
    brief:'На высоте 2–8 м разверните нос на 180° (курс «юг») и удержите 1.2 с.',
    start:{x:0,y:GROUND_REST,z:0,yaw:0},
    gates:[
      { type:'heading', target:180, tol:20, hold:1.2, minAlt:2, maxAlt:8 },
    ],
  },
  {
    name:'Висение в зоне',
    brief:'Перелетите в жёлтую зону и удерживайте дрон внутри 4 секунды.',
    start:{x:0,y:GROUND_REST,z:0,yaw:0},
    gates:[
      { type:'hover', pos:[0,4,14], r:2.6, altTol:2.0, hold:4 },
    ],
  },
  {
    name:'Полёт по прямой',
    brief:'Пролетите последовательно через 4 кольца. Двигайтесь вперёд тангажом.',
    start:{x:0,y:GROUND_REST,z:0,yaw:0},
    gates:[
      { type:'ring', pos:[0,4,10], r:3.2 },
      { type:'ring', pos:[0,4,20], r:3.2 },
      { type:'ring', pos:[0,5,30], r:3.2 },
      { type:'ring', pos:[0,5,40], r:3.2 },
    ],
  },
  {
    name:'Слалом',
    brief:'Пройдите змейкой через кольца, работая креном.',
    start:{x:0,y:GROUND_REST,z:0,yaw:0},
    gates:[
      { type:'ring', pos:[4,4,10], r:3.0 },
      { type:'ring', pos:[-4,4,20], r:3.0 },
      { type:'ring', pos:[4,4,30], r:3.0 },
      { type:'ring', pos:[-4,4,40], r:3.0 },
      { type:'ring', pos:[0,4,50], r:3.0 },
    ],
  },
  {
    name:'Маршрут с разворотом',
    brief:'Пройдите ворота, развернитесь на курс 90° и финишируйте висением.',
    start:{x:0,y:GROUND_REST,z:0,yaw:0},
    gates:[
      { type:'ring', pos:[0,5,12], r:3.2 },
      { type:'heading', target:90, tol:20, hold:1.0, minAlt:3, maxAlt:12 },
      { type:'ring', pos:[20,6,12], r:3.2, faceYaw:Math.PI/2 },
      { type:'hover', pos:[30,6,12], r:2.5, altTol:2.5, hold:3 },
    ],
  },
  {
    name:'Точная посадка',
    brief:'Перелетите к удалённой площадке и сядьте в центр на скорости ниже 1.2 м/с.',
    start:{x:0,y:GROUND_REST,z:0,yaw:0},
    gates:[
      { type:'hover', pos:[0,6,15], r:3.0, altTol:3.0, hold:2 },
      { type:'ring', pos:[0,6,30], r:3.2 },
      { type:'land', pos:[0,GROUND_REST,45], r:3.0, maxSpeed:1.2 },
    ],
  },
  {
    name:'Полоса препятствий',
    brief:'Пройдите ворота, не поднимаясь выше 10 м и не быстрее 9 м/с. Избегайте препятствий.',
    start:{x:0,y:GROUND_REST,z:0,yaw:0},
    constraints:{ maxAlt:10, maxSpeed:9, grace:1.5 },
    obstacles:[
      { pos:[0,3,16], size:[7,6,1.2] },
      { pos:[0,3,28], size:[7,6,1.2] },
    ],
    gates:[
      { type:'ring', pos:[0,7,16], r:2.4 },
      { type:'ring', pos:[0,3,22], r:2.0 },
      { type:'ring', pos:[0,7,34], r:2.4 },
      { type:'land', pos:[0,GROUND_REST,48], r:3.0, maxSpeed:1.2 },
    ],
  },
  {
    name:'Восьмёрка',
    brief:'Опишите «восьмёрку» через 6 колец, удерживая плавный крен. Резкие развороты не помогут.',
    start:{x:0,y:GROUND_REST,z:0,yaw:0},
    constraints:{ maxRoll:55, grace:2.0 },
    gates:[
      { type:'ring', pos:[ 10,9,14], r:3.0, faceYaw:-0.6 },
      { type:'ring', pos:[ 16,10,6], r:3.0, faceYaw:-1.2 },
      { type:'ring', pos:[ 10,9,0], r:3.0, faceYaw:-2.0 },
      { type:'ring', pos:[-10,9,0], r:3.0, faceYaw: 2.0 },
      { type:'ring', pos:[-16,10,6], r:3.0, faceYaw: 1.2 },
      { type:'ring', pos:[-10,9,14], r:3.0, faceYaw: 0.6 },
    ],
  },
  {
    name:'Коридор',
    brief:'Пройдите коридор на высоте не выше 2.5 м, не задевая стены. Точность важнее скорости.',
    start:{x:0,y:GROUND_REST,z:0,yaw:0},
    constraints:{ maxAlt:2.5, maxSpeed:5, grace:1.5 },
    obstacles:[
      { pos:[ 3,1.5,14], size:[2,3,26] },
      { pos:[-3,1.5,14], size:[2,3,26] },
      { pos:[ 3,1.5,44], size:[2,3,26] },
      { pos:[-3,1.5,44], size:[2,3,26] },
    ],
    gates:[
      { type:'ring', pos:[0,2,12], r:1.8 },
      { type:'ring', pos:[0,2,24], r:1.8 },
      { type:'ring', pos:[0,2,38], r:1.8 },
      { type:'ring', pos:[0,2,52], r:1.8 },
      { type:'land', pos:[0,GROUND_REST,62], r:2.6, maxSpeed:1.2 },
    ],
  },
  {
    name:'Гонка на время',
    brief:'Пролетите 8 ворот на время. Норматив — 40 с; уложитесь в 28 с для трёх звёзд.',
    start:{x:0,y:GROUND_REST,z:0,yaw:0},
    timeLimit:70,
    gates:[
      { type:'ring', pos:[ 6,6,10], r:2.8, faceYaw:-0.4 },
      { type:'ring', pos:[ 14,8,20], r:2.8, faceYaw:-0.9 },
      { type:'ring', pos:[ 10,10,34], r:2.8, faceYaw:-0.2 },
      { type:'ring', pos:[ -6,9,40], r:2.8, faceYaw: 1.4 },
      { type:'ring', pos:[-16,8,28], r:2.8, faceYaw: 2.2 },
      { type:'ring', pos:[-14,7,12], r:2.8, faceYaw: 2.8 },
      { type:'ring', pos:[ -4,6,4],  r:2.8, faceYaw: 3.5 },
      { type:'land', pos:[0,GROUND_REST,0], r:3.2, maxSpeed:2.0 },
    ],
  },
  {
    name:'Диагонали',
    brief:'Маршрут по диагоналям: ворота развёрнуты под углом. Отработайте пространственное мышление.',
    start:{x:0,y:GROUND_REST,z:0,yaw:0},
    gates:[
      { type:'ring', pos:[ 12,7,12], r:2.8, faceYaw:-Math.PI/4 },
      { type:'ring', pos:[ -2,10,26], r:2.8, faceYaw:Math.PI/2 },
      { type:'ring', pos:[-14,8,38], r:2.8, faceYaw:-Math.PI/4 },
      { type:'ring', pos:[ -4,11,52], r:2.8, faceYaw:Math.PI },
      { type:'heading', target:270, tol:18, hold:1.5, minAlt:3, maxAlt:14 },
      { type:'ring', pos:[ 12,8,56], r:2.8, faceYaw:Math.PI/2 },
      { type:'hover', pos:[18,7,44], r:2.6, altTol:2.5, hold:2.5 },
    ],
  },
  {
    name:'Узкие ворота',
    brief:'Ювелирный проход через 5 малых колец. Крен ограничен 25° — крените плавно.',
    start:{x:0,y:GROUND_REST,z:0,yaw:0},
    constraints:{ maxRoll:25, maxSpeed:6, grace:2.0 },
    gates:[
      { type:'ring', pos:[0,5,10], r:1.5 },
      { type:'ring', pos:[ 3.5,6,18], r:1.4 },
      { type:'ring', pos:[-3.5,7,26], r:1.4 },
      { type:'ring', pos:[ 3.5,8,34], r:1.4 },
      { type:'ring', pos:[0,7,42], r:1.5 },
      { type:'hover', pos:[0,6,50], r:2.4, altTol:2.2, hold:2.5 },
    ],
  },
  {
    name:'Отказ мотора',
    brief:'Через 3 с откажет один мотор: управление ослабнет, дрон начнёт вращаться. Снизьтесь и сядьте в зелёную зону.',
    start:{x:0,y:GROUND_REST,z:0,yaw:0},
    emergency:{ delay:3.0, yawBias:0.9, climbScale:0.5, pitchScale:0.55, rollScale:0.6 },
    gates:[
      { type:'hover', pos:[0,12,18], r:3.2, altTol:3.0, hold:1.5 },
      { type:'land', pos:[0,GROUND_REST,34], r:3.4, maxSpeed:1.6 },
    ],
  },
  /* --- трассы-гонки на время (по мотивам MultiGP Universal Time Trial):
     компактные круги, старт и финиш — посадочная площадка в центре --- */
  {
    name:'Серпантин (UTT-1)',
    brief:'Змейка по мотивам MultiGP UTT-1: три длинных прохода и быстрый возврат. Норматив — 55 с, три звезды — до 36 с.',
    start:{x:0,y:GROUND_REST,z:0,yaw:0},
    race:true, map:'stadium',
    timeLimit:85,
    gates:[
      { type:'ring', pos:[  0,5,16], r:2.9, faceYaw: 0 },
      { type:'ring', pos:[ 22,5,16], r:2.9, faceYaw: Math.PI/2 },
      { type:'ring', pos:[ 22,5,32], r:2.9, faceYaw: 0 },
      { type:'ring', pos:[  0,5,32], r:2.9, faceYaw:-Math.PI/2 },
      { type:'ring', pos:[  0,6,48], r:2.9, faceYaw: 0 },
      { type:'ring', pos:[ 22,6,48], r:2.9, faceYaw: Math.PI/2 },
      { type:'ring', pos:[ 22,6,62], r:2.9, faceYaw: 0 },
      { type:'ring', pos:[-16,6,62], r:2.9, faceYaw:-Math.PI/2 },
      { type:'ring', pos:[-16,5,24], r:2.9, faceYaw: Math.PI },
      { type:'land', pos:[0,GROUND_REST,0], r:3.2, maxSpeed:2.2 },
    ],
  },
  {
    name:'Цунами (UTT-2)',
    brief:'Петля с длинной прямой и пикированием сквозь вертикальные ворота (MultiGP UTT-2). Три звезды — до 29 с.',
    start:{x:0,y:GROUND_REST,z:0,yaw:0},
    race:true, map:'stadium',
    timeLimit:70,
    gates:[
      { type:'ring', pos:[  0,4,16], r:2.9, faceYaw: 0 },
      { type:'ring', pos:[-14,4,30], r:2.9, faceYaw:-0.79 },
      { type:'ring', pos:[  0,4,42], r:2.9, faceYaw: 0.86 },
      { type:'ring', pos:[  0,10,54], r:2.7, faceYaw: 0 },
      { type:'ring', pos:[  0,16,54], r:2.7, faceYaw: 0 },
      { type:'ring', pos:[ 16,6,44], r:2.8, faceYaw: 2.13 },
      { type:'ring', pos:[ 14,4,22], r:2.9, faceYaw:-3.05 },
      { type:'land', pos:[0,GROUND_REST,0], r:3.2, maxSpeed:2.2 },
    ],
  },
  {
    name:'Спираль (UTT-5)',
    brief:'Раковина Nautilus: ворота закручиваются внутрь с постоянным снижением (MultiGP UTT-5). Три звезды — до 34 с.',
    start:{x:0,y:GROUND_REST,z:0,yaw:0},
    race:true, map:'stadium',
    timeLimit:80,
    gates:[
      { type:'ring', pos:[ 22,8,  6], r:3.0, faceYaw: 1.30 },
      { type:'ring', pos:[ 18,8, 22], r:2.9, faceYaw:-0.25 },
      { type:'ring', pos:[  2,8, 32], r:2.8, faceYaw:-1.01 },
      { type:'ring', pos:[-14,8, 26], r:2.7, faceYaw:-1.93 },
      { type:'ring', pos:[-22,8,  8], r:2.6, faceYaw:-2.72 },
      { type:'ring', pos:[-16,8, -8], r:2.5, faceYaw: 2.78 },
      { type:'ring', pos:[ -2,7,-16], r:2.4, faceYaw: 2.09 },
      { type:'ring', pos:[ 10,6, -8], r:2.4, faceYaw: 0.98 },
      { type:'land', pos:[0,GROUND_REST,0], r:3.2, maxSpeed:2.2 },
    ],
  },
  {
    name:'Высокое напряжение (UTT-4)',
    brief:'Городской слалом со сменой направления между домами и разворотом домой (MultiGP UTT-4). Три звезды — до 34 с.',
    start:{x:0,y:GROUND_REST,z:0,yaw:0},
    race:true, map:'stadium',
    timeLimit:80,
    gates:[
      { type:'ring', pos:[  0,5,14], r:2.9, faceYaw: 0 },
      { type:'ring', pos:[-12,6,26], r:2.8, faceYaw:-0.79 },
      { type:'ring', pos:[ 12,7,30], r:2.8, faceYaw: 1.41 },
      { type:'ring', pos:[-10,8,44], r:2.7, faceYaw:-1.00 },
      { type:'ring', pos:[ 14,6,50], r:2.7, faceYaw: 1.33 },
      { type:'ring', pos:[  0,5,64], r:2.9, faceYaw:-0.79 },
      { type:'ring', pos:[-16,6,50], r:2.8, faceYaw:-2.29 },
      { type:'ring', pos:[-14,5,22], r:2.9, faceYaw: 3.07 },
      { type:'land', pos:[0,GROUND_REST,0], r:3.2, maxSpeed:2.2 },
    ],
  },
  {
    name:'Лесная дорога (40 ворот)',
    brief:'Длинная лесная гонка на время: 40 ворот вдоль дороги, рельеф то поднимается, то опускается. Держитесь дороги.',
    start:(()=>{
      const t0 = -1/80, p = forestPath(t0), tg = forestTangent(t0);
      return { x:p.x, y:GROUND_REST + forestTerrain(p.x, p.z), z:p.z, yaw:Math.atan2(tg.x, tg.z) };
    })(),
    terrain:'forest',
    race:true,
    timeLimit:260,
    gates: buildForestTrack(40),
  },
  {
    name:'Свободный полёт',
    brief:'Соберите 5 колец в любом порядке. Никаких ограничений — летайте свободно.',
    start:{x:0,y:GROUND_REST,z:0,yaw:0},
    unordered:true, free:true,
    gates:[
      { type:'ring', pos:[12,5,12], r:3.2 },
      { type:'ring', pos:[-14,7,8], r:3.2 },
      { type:'ring', pos:[8,10,-12], r:3.2 },
      { type:'ring', pos:[-10,4,-16], r:3.2 },
      { type:'ring', pos:[16,6,-4], r:3.2 },
    ],
  },
];
const RACE_TOTAL   = LEVELS.filter(l => l.race).length;
const LESSON_TOTAL = LEVELS.length - RACE_TOTAL;

/* --- гидирующая стрелка --- */
const guideArrow = new THREE.Group();
{
  const m = new THREE.MeshBasicMaterial({ color:0x9fd0ff, transparent:true, opacity:.92, depthTest:false });
  const shaft = new THREE.Mesh(new THREE.BoxGeometry(0.12,0.12,0.5), m);
  shaft.position.z = 0.15; guideArrow.add(shaft);
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.24,0.44,12), m);
  head.rotation.x = Math.PI/2; head.position.z = 0.58; guideArrow.add(head);
}
guideArrow.visible = false; guideArrow.renderOrder = 999; scene.add(guideArrow);

/* --- подсветка активной цели (всё кольцо целиком) --- */
const HL_ACTIVE = new THREE.Color(0xffe066);
const HL_ACTIVE_EM = new THREE.Color(0xffcf33);
const HL_DONE = new THREE.Color(0x39d353);
function updateGateHighlight(t){
  if(!levelState) return;
  const lv = LEVELS[currentLevelIndex];
  const active = activeGate();
  const pulse = 0.5 + 0.5*Math.sin(t*6);
  for(const g of lv.gates){
    if(!g.mat) continue;                 /* heading — без меша */
    if(g.done){
      g.mat.color.copy(HL_DONE);
      g.mat.emissive.copy(HL_DONE);
      g.mat.emissiveIntensity = 0.45;
      if(g.mat.transparent) g.mat.opacity = 0.4;
      if(g.zoneMat) g.zoneMat.opacity = 0.06;
    } else if(g === active){
      g.mat.color.copy(HL_ACTIVE);
      g.mat.emissive.copy(HL_ACTIVE_EM);
      g.mat.emissiveIntensity = 0.9 + 1.1*pulse;
      if(g.mat.transparent) g.mat.opacity = 1.0;
      if(g.zoneMat) g.zoneMat.opacity = 0.16 + 0.14*pulse;
    } else {
      g.mat.color.setHex(g.baseColor ?? 0x3b9dff);
      g.mat.emissive.setHex(g.baseColor ?? 0x3b9dff);
      g.mat.emissiveIntensity = 0.22;
      if(g.mat.transparent) g.mat.opacity = 0.7;
      if(g.zoneMat) g.zoneMat.opacity = 0.09;
    }
    if(g.netMat){
      g.netMat.color.copy(g.mat.color);
      if(g.done) g.netMat.opacity = 0.05;
      else if(g === active) g.netMat.opacity = 0.24 + 0.14*pulse;
      else g.netMat.opacity = 0.12;
    }
  }
}

/* --- декор карт свободного полёта --- */
function makeBuilding(x, z, w, h, d){
  const grp = new THREE.Group();
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(w,h,d),
    new THREE.MeshStandardMaterial({ color:0x55617a, roughness:.85 })
  );
  box.position.set(x, h/2, z);
  box.castShadow = true; box.receiveShadow = true;
  grp.add(box);
  /* тёмная надстройка на крыше для силуэта */
  const roof = new THREE.Mesh(
    new THREE.BoxGeometry(w*0.55, 1.4, d*0.55),
    new THREE.MeshStandardMaterial({ color:0x2c3340, roughness:.9 })
  );
  roof.position.set(x, h+0.7, z);
  roof.castShadow = true;
  grp.add(roof);
  levelRoot.add(grp);
}
function makeBuildingRow(x, z, w, h, d, color){
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(w,h,d),
    new THREE.MeshStandardMaterial({ color, roughness:.8 })
  );
  box.position.set(x, h/2, z);
  box.castShadow = true; box.receiveShadow = true;
  levelRoot.add(box);
}
function makeRock(x, z, s=1){
  const h = (7 + rnd()*14) * s;
  const r = (2 + rnd()*3.4) * s;
  const rock = new THREE.Mesh(
    new THREE.ConeGeometry(r, h, 7+rnd()*5|0),
    new THREE.MeshStandardMaterial({ color:0x8a7a5f, roughness:1 })
  );
  rock.position.set(x, h/2, z);
  rock.rotation.y = rnd()*Math.PI*2;
  rock.castShadow = true; rock.receiveShadow = true;
  levelRoot.add(rock);
}

/* Квадрат расстояния от точки (ax,az) до отрезка (px,pz)-(qx,qz). */
function segDist2(px, pz, qx, qz, ax, az){
  const dx = qx-px, dz = qz-pz;
  const l2 = dx*dx + dz*dz;
  let t = l2 > 0 ? ((ax-px)*dx + (az-pz)*dz) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = px + dx*t, cz = pz + dz*t;
  return (ax-cx)*(ax-cx) + (az-cz)*(az-cz);
}
/* Коридор вдоль трассы: точка свободна, если она дальше `clear` от любой
   цели и от отрезков между последовательными целями. Без списка целей —
   свободно везде (обычный декор карты). */
function makeDecorClear(gates, clear){
  if(!gates || !gates.length) return ()=>true;
  const pts = gates.map(g=>[g.pos[0], g.pos[2]]);
  const c2 = clear*clear;
  return (x, z)=>{
    for(let i=0;i<pts.length;i++){
      const dx = x-pts[i][0], dz = z-pts[i][1];
      if(dx*dx + dz*dz < c2) return false;
      if(i > 0 && segDist2(pts[i-1][0], pts[i-1][1], pts[i][0], pts[i][1], x, z) < c2) return false;
    }
    return true;
  };
}

function buildMapDecor(kind, gates){
  seed = (kind === 'city') ? 4242 : (kind === 'canyon') ? 90210 : 1337;
  const clear = makeDecorClear(gates, kind === 'city' ? 15 : kind === 'canyon' ? 15 : 9);
  if(kind === 'city'){
    /* кварталы — сохраняем центр свободным для площадки */
    for(let i=0;i<30;i++){
      const a = rnd()*Math.PI*2, r = 26 + rnd()*190;
      const x = Math.cos(a)*r, z = Math.sin(a)*r;
      const w = 8+rnd()*7, h = 9+rnd()*22, d = 8+rnd()*7;
      const col = [0x55617a,0x4d5d6e,0x5d6a83,0x465066][rnd()*4|0];
      if(!clear(x, z)) continue;
      makeBuildingRow(x, z, w, h, d, col);
    }
    for(let i=0;i<10;i++){
      const a = rnd()*Math.PI*2, r = 22 + rnd()*120;
      const x = Math.cos(a)*r, z = Math.sin(a)*r;
      if(!clear(x, z)) continue;
      levelRoot.add(makeTree(x, z, 0.8+rnd()*0.8));
    }
  } else if(kind === 'canyon'){
    for(let i=0;i<42;i++){
      const a = rnd()*Math.PI*2, r = 18 + rnd()*200;
      const x = Math.cos(a)*r, z = Math.sin(a)*r;
      if(!clear(x, z)) continue;
      makeRock(x, z, 0.9+rnd()*1.5);
    }
    /* редкие деревья в расщелинах */
    for(let i=0;i<12;i++){
      const a = rnd()*Math.PI*2, r = 25 + rnd()*160;
      const x = Math.cos(a)*r, z = Math.sin(a)*r;
      if(!clear(x, z)) continue;
      levelRoot.add(makeTree(x, z, 0.7+rnd()*0.9));
    }
  } else {
    /* луг — исходная сцена */
    for(let i=0;i<46;i++){
      const a = rnd()*Math.PI*2, r = 20 + rnd()*170;
      const x = Math.cos(a)*r, z = Math.sin(a)*r;
      if(!clear(x, z)) continue;
      levelRoot.add(makeTree(x, z, 0.8+rnd()*1.4));
    }
  }
}

/* ============================================================
   СТАДИОН — арена для всех гоночных трасс на время.
   Тёмное поле с разметкой и логотипом, борта, LED-борта,
   ступенчатые трибуны с козырьком, мачты прожекторов и табло
   с названием трассы. Габариты подобраны так, чтобы все четыре
   трассы UTT целиком лежали внутри поля.
   ============================================================ */
const ST_CX = 0, ST_CZ = 24;      /* центр поля */
const ST_HW = 32, ST_HD = 50;     /* внутренние полуразмеры поля (X и Z) */

function makeFieldTexture(){
  const W = 1024, H = 1600;       /* пропорции под поле 64×100 м */
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#2a3038'; g.fillRect(0, 0, W, H);
  /* метровая сетка */
  g.strokeStyle = 'rgba(120,150,190,.10)'; g.lineWidth = 2;
  for(let x = 0; x <= W; x += W/16){ g.beginPath(); g.moveTo(x,0); g.lineTo(x,H); g.stroke(); }
  for(let y = 0; y <= H; y += H/25){ g.beginPath(); g.moveTo(0,y); g.lineTo(W,y); g.stroke(); }
  /* центральный круг и логотип */
  g.strokeStyle = 'rgba(120,180,255,.30)'; g.lineWidth = 10;
  g.beginPath(); g.arc(W/2, H/2, 250, 0, Math.PI*2); g.stroke();
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = 'rgba(150,200,255,.16)';
  g.font = 'bold 150px sans-serif'; g.fillText('FLY', W/2, H/2 - 70);
  g.font = 'bold 96px sans-serif';  g.fillText('ARENA', W/2, H/2 + 70);
  /* стартовая прямая */
  g.fillStyle = 'rgba(255,210,63,.22)'; g.fillRect(0, H/2 - 8, W, 16);
  /* шахматная окантовка по периметру */
  const q = 32;
  for(let i = 0; i < W/q; i++){
    g.fillStyle = (i & 1) ? '#e8eef7' : '#12161c';
    g.fillRect(i*q, 0, q, q); g.fillRect(i*q, H-q, q, q);
  }
  for(let j = 0; j < H/q; j++){
    g.fillStyle = (j & 1) ? '#e8eef7' : '#12161c';
    g.fillRect(0, j*q, q, q); g.fillRect(W-q, j*q, q, q);
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function makeAdTexture(){
  const W = 1024, H = 128;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  const seg = W/4, cols = ['#1f6fd0','#ffb03a','#39d353','#e8483c'];
  const words = ['FLY ARENA','DRONE RACING','UTT','FLY ARENA'];
  g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = 'bold 58px sans-serif';
  for(let i = 0; i < 4; i++){
    g.fillStyle = cols[i]; g.fillRect(i*seg, 0, seg - 6, H);
    g.fillStyle = '#08111c'; g.fillText(words[i], i*seg + seg/2, H/2 + 2);
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  return t;
}
function makeScreenTexture(title, sub){
  const W = 1024, H = 576;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 0, H);
  grd.addColorStop(0, '#0e1622'); grd.addColorStop(1, '#060a11');
  g.fillStyle = grd; g.fillRect(0, 0, W, H);
  g.strokeStyle = 'rgba(120,180,255,.35)'; g.lineWidth = 8; g.strokeRect(6, 6, W-12, H-12);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  let size = 150; g.font = 'bold ' + size + 'px sans-serif';
  while(g.measureText(title).width > W - 120 && size > 28){ size -= 4; g.font = 'bold ' + size + 'px sans-serif'; }
  g.fillStyle = '#ffe066'; g.fillText(title, W/2, H*0.42);
  g.font = 'bold 62px sans-serif'; g.fillStyle = '#9fd0ff'; g.fillText(sub, W/2, H*0.74);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* AABB-коллайдер арены (обрабатывается resolveCollisions) */
function stadiumSolid(x, y, z, w, h, d){
  stadiumSolids.push({ pos:[x, y, z], size:[w, h, d] });
}

function buildStadium(lv){
  const A = getRaceAssets();
  const cx = ST_CX, cz = ST_CZ, HW = ST_HW, HD = ST_HD;
  const wallMat = new THREE.MeshStandardMaterial({ color:0x171d27, roughness:.7, metalness:.2 });
  const concMat = new THREE.MeshStandardMaterial({ color:0x8b929c, roughness:.9 });
  const darkMat = new THREE.MeshStandardMaterial({ color:0x2b313c, roughness:.55, metalness:.4 });

  /* --- поле --- */
  const field = new THREE.Mesh(
    new THREE.PlaneGeometry(HW*2, HD*2),
    new THREE.MeshStandardMaterial({ map:makeFieldTexture(), roughness:.92, metalness:.05 })
  );
  field.rotation.x = -Math.PI/2; field.position.set(cx, 0.04, cz);
  field.receiveShadow = true; levelRoot.add(field);

  /* --- борта по периметру --- */
  const wallT = 0.5, wallH = 1.15;
  const rails = [
    [cx+HW+wallT/2, cz, wallT, HD*2+wallT*2],
    [cx-HW-wallT/2, cz, wallT, HD*2+wallT*2],
    [cx, cz+HD+wallT/2, HW*2+wallT*2, wallT],
    [cx, cz-HD-wallT/2, HW*2+wallT*2, wallT],
  ];
  for(const [x, z, w, d] of rails){
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, wallH, d), wallMat);
    m.position.set(x, wallH/2, z);
    m.castShadow = true; m.receiveShadow = true; levelRoot.add(m);
    stadiumSolid(x, wallH/2, z, w, wallH, d);
  }

  /* --- LED-борта (реклама) вдоль поля, между отбойником и трибунами --- */
  const adSides = [
    [cx+HW+1.6, cz, HD*2, -Math.PI/2],
    [cx-HW-1.6, cz, HD*2,  Math.PI/2],
    [cx, cz+HD+1.6, HW*2,  Math.PI],
    [cx, cz-HD-1.6, HW*2,  0],
  ];
  for(const [x, z, len, rot] of adSides){
    const tex = makeAdTexture();
    tex.wrapS = THREE.RepeatWrapping; tex.repeat.set(Math.max(1, Math.round(len/12)), 1);
    const board = new THREE.Mesh(
      new THREE.PlaneGeometry(len, 1.1),
      new THREE.MeshBasicMaterial({ map:tex })
    );
    board.position.set(x, 1.0, z); board.rotation.y = rot;
    levelRoot.add(board);
  }

  /* --- трибуны (ступени + сиденья + задняя стена) --- */
  const T = 5, dep = 2.4, rise = 1.1, baseY = 0.6;
  const stepGeo = new THREE.BoxGeometry(1, rise, dep);
  const seatGeo = new THREE.BoxGeometry(1, 0.12, dep*0.8);
  const backGeo = new THREE.BoxGeometry(1, 1, 0.5);
  const seatA = new THREE.MeshStandardMaterial({ color:0x2f6fb5, roughness:.85 });
  const seatB = new THREE.MeshStandardMaterial({ color:0x24517f, roughness:.85 });
  function addStand(len, px, pz, rotY){
    const grp = new THREE.Group();
    for(let i = 0; i < T; i++){
      const step = new THREE.Mesh(stepGeo, concMat);
      step.scale.x = len;
      step.position.set(0, baseY + i*rise + rise/2, i*dep + dep/2);
      step.castShadow = true; step.receiveShadow = true; grp.add(step);
      const seat = new THREE.Mesh(seatGeo, i % 2 ? seatA : seatB);
      seat.scale.x = len;
      seat.position.set(0, baseY + (i+1)*rise + 0.06, i*dep + dep/2);
      grp.add(seat);
    }
    const backH = T*rise + 1.4;
    const back = new THREE.Mesh(backGeo, wallMat);
    back.scale.set(len, backH, 1);
    back.position.set(0, baseY + backH/2, T*dep + 0.25);
    back.castShadow = true; grp.add(back);
    grp.position.set(px, 0, pz); grp.rotation.y = rotY;
    levelRoot.add(grp);
    const totalD = T*dep + 0.5, totalH = baseY + T*rise + 0.3;
    const c = Math.abs(Math.cos(rotY)), s = Math.abs(Math.sin(rotY));
    stadiumSolid(px + Math.sin(rotY)*totalD/2, totalH/2, pz + Math.cos(rotY)*totalD/2,
                 c*len + s*totalD, totalH, s*len + c*totalD);
  }
  addStand(HD*2, cx+HW+2.6, cz, Math.PI/2);
  addStand(HD*2, cx-HW-2.6, cz, -Math.PI/2);
  addStand(HW*2, cx, cz+HD+2.6, 0);
  addStand(HW*2, cx, cz-HD-2.6, Math.PI);

  /* --- козырёк над трибунами с опорами --- */
  const roofY = baseY + T*rise + 3.4;
  const roofD = T*dep + 2.6;
  const pillarGeo = new THREE.CylinderGeometry(0.28, 0.28, roofY, 8);
  const roofGeo = new THREE.BoxGeometry(1, 0.5, 1);
  function addRoof(len, px, pz, rotY){
    const roof = new THREE.Mesh(roofGeo, darkMat);
    roof.scale.set(len + roofD, 1, roofD);
    roof.position.set(px + Math.sin(rotY)*roofD/2, roofY, pz + Math.cos(rotY)*roofD/2);
    roof.rotation.y = rotY; roof.castShadow = true; levelRoot.add(roof);
    const n = Math.max(2, Math.round(len/16));
    for(let i = 1; i < n; i++){
      const lx = -len/2 + len*i/n, lz = roofD*0.85;
      const wx = px + Math.cos(rotY)*lx + Math.sin(rotY)*lz;
      const wz = pz - Math.sin(rotY)*lx + Math.cos(rotY)*lz;
      const pil = new THREE.Mesh(pillarGeo, A.pillar);
      pil.position.set(wx, roofY/2, wz); pil.castShadow = true; levelRoot.add(pil);
    }
  }
  addRoof(HD*2, cx+HW+2.6, cz, Math.PI/2);
  addRoof(HD*2, cx-HW-2.6, cz, -Math.PI/2);
  addRoof(HW*2, cx, cz+HD+2.6, 0);
  addRoof(HW*2, cx, cz-HD-2.6, Math.PI);

  /* --- мачты прожекторов по углам --- */
  const towerH = 17;
  const towerGeo = new THREE.CylinderGeometry(0.35, 0.6, towerH, 10);
  const headGeo = new THREE.BoxGeometry(4.4, 2.2, 0.7);
  const lampGeo = new THREE.PlaneGeometry(0.8, 1.4);
  const lampMat = new THREE.MeshBasicMaterial({ color:0xfff6d8 });
  for(const sx of [-1, 1]) for(const sz of [-1, 1]){
    const x = cx + sx*(HW + 7), z = cz + sz*(HD + 7);
    const pole = new THREE.Mesh(towerGeo, A.pillar);
    pole.position.set(x, towerH/2, z); pole.castShadow = true; levelRoot.add(pole);
    const head = new THREE.Mesh(headGeo, darkMat);
    head.position.set(x, towerH + 0.6, z); head.castShadow = true; levelRoot.add(head);
    for(let i = 0; i < 4; i++){
      const lamp = new THREE.Mesh(lampGeo, lampMat);
      lamp.position.set(x - 1.65 + i*1.1, towerH + 0.6, z + 0.38);
      lamp.lookAt(cx, towerH + 0.6, cz);
      levelRoot.add(lamp);
    }
    stadiumSolid(x, towerH/2, z, 1.2, towerH, 1.2);
  }

  /* --- табло с названием трассы на дальнем торце --- */
  const SW = 17, SH = 9.5, jz = cz + HD + T*dep + 9, jy = roofY + 4.5;
  const jgrp = new THREE.Group();
  const panel = new THREE.Mesh(new THREE.BoxGeometry(SW + 1.2, SH + 1.2, 0.8), darkMat);
  panel.castShadow = true; jgrp.add(panel);
  const face = new THREE.Mesh(
    new THREE.PlaneGeometry(SW, SH),
    new THREE.MeshBasicMaterial({ map: makeScreenTexture(lv.name, 'FLY ARENA · UTT') })
  );
  face.position.z = 0.42; jgrp.add(face);
  jgrp.position.set(cx, jy, jz);
  jgrp.rotation.y = Math.PI;          /* экран развёрнут в поле (−Z) */
  levelRoot.add(jgrp);
  for(const sx of [-1, 1]){
    const leg = new THREE.Mesh(pillarGeo, A.pillar);
    leg.position.set(cx + sx*(SW/2 - 1), jy/2, jz);
    leg.castShadow = true; levelRoot.add(leg);
  }
}

/* --- сборка сцены уровня --- */
function buildLevelScene(lv){
  clearLevelRoot();
  terrainFn = (lv.terrain === 'forest') ? forestTerrain : null;
  (lv.obstacles||[]).forEach(buildObstacle);
  (lv.gates||[]).forEach((g,i)=>buildGateVisual(g, !!lv.race, i));
  if(lv.terrain === 'forest') buildForest();
  else if(lv.race) buildStadium(lv);
  else if(lv.free) buildMapDecor(cfg.map);
  else if(lv.map) buildMapDecor(lv.map, lv.gates);
  if(lv.race && lv.terrain !== 'forest') buildRaceProps(lv);
}

/* --- загрузка / перезапуск / завершение --- */
function loadLevel(index){
  currentLevelIndex = ((index % LEVELS.length) + LEVELS.length) % LEVELS.length;
  const lv = LEVELS[currentLevelIndex];
  buildLevelScene(lv);
  state.pos.set(lv.start.x, lv.start.y, lv.start.z);
  state.vel.set(0,0,0);
  state.yaw = lv.start.yaw || 0; state.pitch = 0; state.roll = 0;
  state.quat.setFromEuler(_e.set(0, state.yaw, 0, 'YXZ'));
  stickL.x=stickR.x=stickL.y=stickR.y=0;
  for(const k in keys) keys[k]=false;
  batteryCharge = 1;                 // полный заряд на новом уровне
  /* сброс модификаторов управления (отказ мотора и т.п.) */
  ctrl.pitch=1; ctrl.roll=1; ctrl.yaw=1; ctrl.climb=1; ctrl.biasYaw=0; ctrl.emergency=false;
  levelState = { progress:0, hoverTime:0, headingTime:0, violationTime:0, done:false, elapsed:0, warn:false, aligned:false, emergencyAt:null };
  camera.position.set(lv.start.x, lv.start.y+3.4, lv.start.z-9);
  hideOverlay();
  updateLevelMenu();
  updateGateHighlight(0);
  updateGuide();
  updateLevelBar();
}

function restartLevel(){ loadLevel(currentLevelIndex); }
function nextLevel(){ loadLevel(currentLevelIndex+1); }

/* --- выбор активной цели --- */
function gateAnchor(g){
  if(g.type === 'heading'){
    const a = g.target*Math.PI/180;
    return new THREE.Vector3(state.pos.x+Math.sin(a)*10, state.pos.y, state.pos.z+Math.cos(a)*10);
  }
  return new THREE.Vector3(g.pos[0], g.pos[1], g.pos[2]);
}
function activeGate(){
  if(!levelState) return null;
  const lv = LEVELS[currentLevelIndex];
  if(lv.unordered){
    let best = null, bd = Infinity;
    for(const g of lv.gates){
      if(g.done) continue;
      const p = gateAnchor(g);
      const d = p.distanceToSquared(state.pos);
      if(d < bd){ bd = d; best = g; }
    }
    return best;
  }
  return lv.gates[levelState.progress] || null;
}

function completeGate(g){
  g.done = true;
  if(g.mat){
    g.mat.color.set(0x39d353);
    g.mat.emissive.set(0x39d353);
    g.mat.emissiveIntensity = .7;
    if('opacity' in g.mat) g.mat.opacity = .5;
  }
  if(g.netMat) g.netMat.opacity = .05;
  levelState.progress++;
  levelState.hoverTime = 0; levelState.headingTime = 0;
  if(levelState.progress >= LEVELS[currentLevelIndex].gates.length) completeLevel();
}

/* --- проверка ворот --- */
const _gateV = new THREE.Vector3();
function checkGate(g, dt){
  const alt = aglAlt();
  const spd = Math.hypot(state.vel.x, state.vel.z);
  if(g.type === 'ring'){
    if(state.pos.distanceTo(_gateV.set(g.pos[0],g.pos[1],g.pos[2])) < g.r) completeGate(g);
  } else if(g.type === 'altitude'){
    if(alt >= g.pos[1]) completeGate(g);
  } else if(g.type === 'hover'){
    const horiz = Math.hypot(state.pos.x-g.pos[0], state.pos.z-g.pos[2]);
    const within = horiz < g.r && Math.abs(alt - g.pos[1]) < (g.altTol||2);
    if(within){
      levelState.hoverTime += dt;
      if(levelState.hoverTime >= g.hold) completeGate(g);
    } else levelState.hoverTime = Math.max(0, levelState.hoverTime - dt*1.5);
  } else if(g.type === 'heading'){
    const hd = (state.yaw*180/Math.PI % 360 + 360) % 360;
    const diff = Math.abs(((hd - g.target + 540) % 360) - 180);
    const inBand = alt >= (g.minAlt||0) && alt <= (g.maxAlt||99);
    if(inBand && diff <= g.tol){
      levelState.headingTime += dt;
      levelState.aligned = true;
      /* мягкий ассист: доворачиваем нос к целевому курсу, чтобы удержать */
      let d = g.target*Math.PI/180 - state.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      /* доворот вокруг мировой вертикали: в acro — кватернионом, в angle — прямым yaw */
      const yd = d * Math.min(1, 2.5*dt);
      if(flightMode === 'acro'){
        _yawQ.setFromAxisAngle(Y_AXIS, yd);
        state.quat.premultiply(_yawQ);
      } else {
        state.yaw += yd;
      }
      if(levelState.headingTime >= g.hold) completeGate(g);
      if(levelState.headingTime >= g.hold) completeGate(g);
    } else {
      /* медленный спад вместо мгновенного сброса */
      levelState.headingTime = Math.max(0, levelState.headingTime - dt*0.6);
      levelState.aligned = false;
    }
  } else if(g.type === 'land'){
    const horiz = Math.hypot(state.pos.x-g.pos[0], state.pos.z-g.pos[2]);
    if(horiz < g.r && alt < 0.6 && spd < (g.maxSpeed||1.5)) completeGate(g);
  }
}

/* --- обновление уровня каждый кадр --- */
function updateLevel(dt){
  if(!levelState || levelState.done) return;
  const lv = LEVELS[currentLevelIndex];
  levelState.elapsed += dt;
  levelState.warn = false;
  levelState.aligned = false;

  /* ограничения (maxRoll в acro не проверяется — крен не лимитируется) */
  const alt = aglAlt();
  const spd = Math.hypot(state.vel.x, state.vel.z);
  const rollDeg = Math.abs(state.roll * 180/Math.PI);
  if(lv.constraints){
    const c = lv.constraints;
    const violated = (c.maxAlt!=null && alt > c.maxAlt) ||
                     (c.maxSpeed!=null && spd > c.maxSpeed) ||
                     (c.maxRoll!=null && flightMode !== 'acro' && rollDeg > c.maxRoll);
    if(violated){
      levelState.violationTime += dt;
      levelState.warn = true;
      if(levelState.violationTime > (c.grace||1.5)){ failLevel('Нарушено ограничение уровня'); return; }
    } else {
      levelState.violationTime = Math.max(0, levelState.violationTime - dt*2);
    }
  }

  /* отказ мотора: через emergency.delay секунд ослабляем управление */
  if(lv.emergency && levelState.emergencyAt == null && levelState.elapsed >= lv.emergency.delay){
    levelState.emergencyAt = levelState.elapsed;
    const e = lv.emergency;
    ctrl.emergency = true;
    ctrl.yaw   = 0.35;
    ctrl.biasYaw = e.yawBias || 0.9;
    ctrl.climb = e.climbScale != null ? e.climbScale : 0.5;
    ctrl.pitch = e.pitchScale != null ? e.pitchScale : 0.55;
    ctrl.roll  = e.rollScale  != null ? e.rollScale  : 0.6;
  }

  /* гонка на время: выйти за лимит = провал */
  if(lv.timeLimit && levelState.elapsed > lv.timeLimit){
    failLevel('Время вышло'); return;
  }

  /* проверка целей */
  if(lv.unordered){
    for(const g of lv.gates){
      if(g.done) continue;
      if(state.pos.distanceTo(_gateV.set(g.pos[0],g.pos[1],g.pos[2])) < g.r) completeGate(g);
    }
  } else {
    const g = lv.gates[levelState.progress];
    if(g) checkGate(g, dt);
  }

  updateGateHighlight(levelState.elapsed);
  updateGuide();
  updateLevelBar();
}

/* --- стрелка-указатель --- */
function updateGuide(){
  const g = activeGate();
  if(!g){ guideArrow.visible = false; return; }
  const p = gateAnchor(g);
  const gy = state.pos.y + 1.6;
  const dx = p.x - state.pos.x, dz = p.z - state.pos.z;
  if(dx*dx + dz*dz > 0.04){
    guideArrow.visible = true;
    guideArrow.position.set(state.pos.x, gy, state.pos.z);
    guideArrow.lookAt(p.x, gy, p.z);
  } else guideArrow.visible = false;
}

/* --- оверлей завершения/провала --- */
function showOverlay(html){ overlayEl.innerHTML = html; overlayEl.classList.add('show'); makeCollapsible(overlayEl); paused = true; }
function hideOverlay(){ overlayEl.classList.remove('show'); overlayEl.innerHTML = ''; paused = false; }

function completeLevel(){
  levelState.done = true;
  guideArrow.visible = false;
  if(netRace.active){ netRaceSendState(true); showRaceResult(); return; }
  const lv = LEVELS[currentLevelIndex];
  const t = levelState.elapsed;
  const s3 = lv.timeLimit ? lv.timeLimit*0.42 : 22;
  const s2 = lv.timeLimit ? lv.timeLimit*0.65 : 50;
  const stars = t < s3 ? 3 : t < s2 ? 2 : 1;
  const isLast = currentLevelIndex === LEVELS.length-1;
  showOverlay(`
    <div class="card">
      <h2>Уровень пройден!</h2>
      <div class="stars">${'★'.repeat(stars)}${'☆'.repeat(3-stars)}</div>
      <p><b>${lv.name}</b><br>Время: ${t.toFixed(1)} с</p>
      <div class="btns">
        <button data-action="retry">Заново</button>
        <button class="primary" data-action="next">${isLast?'К первому':'Далее →'}</button>
      </div>
    </div>`);
}
function failLevel(reason){
  levelState.done = true;
  guideArrow.visible = false;
  if(netRace.active){ netRace.selfFailed = true; netRaceSendState(true); showRaceResult(); return; }
  showOverlay(`
    <div class="card">
      <h2>Не получилось</h2>
      <p>${reason}</p>
      <div class="btns">
        <button class="primary" data-action="retry">Повторить</button>
        <button data-action="menu">Уровни</button>
      </div>
    </div>`);
}
overlayEl.addEventListener('click', e=>{
  const b = e.target.closest('button[data-action]');
  if(!b) return;
  const a = b.dataset.action;
  if(a === 'next') nextLevel();
  else if(a === 'retry') restartLevel();
  else if(a === 'close') hideOverlay();
  else if(a === 'menu'){ hideOverlay(); openLevelMenu(); }
});

/* --- строка уровня (HUD) --- */
function objectiveText(lv){
  const g = activeGate();
  if(!g) return lv.brief;
  const alt = aglAlt();
  switch(g.type){
    case 'ring':     return 'Пролетите через подсвеченное кольцо';
    case 'hover':    return `Висение в зоне: ${levelState.hoverTime.toFixed(1)} / ${g.hold} с`;
    case 'heading':  return `Разверните нос на курс ${g.target}° и удержите: ${levelState.headingTime.toFixed(1)} / ${g.hold} с${levelState.aligned ? ' — ЕСТЬ!' : ''}`;
    case 'altitude': return `Наберите высоту ${g.pos[1].toFixed(0)} м (сейчас ${alt.toFixed(1)} м)`;
    case 'land':     return `Приземлитесь в центр: скорость < ${g.maxSpeed} м/с`;
    default:         return lv.brief;
  }
}
function updateLevelBar(){
  if(!levelState) return;
  const lv = LEVELS[currentLevelIndex];
  const catIdx = LEVELS.slice(0, currentLevelIndex+1).filter(l => !!l.race === !!lv.race).length;
  lvNameEl.textContent = `${lv.race ? 'Трасса' : 'Уровень'} ${catIdx}/${lv.race ? RACE_TOTAL : LESSON_TOTAL} — ${lv.name}`;
  let obj = objectiveText(lv);
  if(lv.emergency){
    obj = levelState.emergencyAt == null
      ? `Мотор цел. Отказ через ${(lv.emergency.delay - levelState.elapsed).toFixed(1)} с. ` + obj
      : `⚠ ОТКАЗ МОТОРА — дрон вращается! ` + obj;
  }
  if(lv.timeLimit){
    const left = Math.max(0, lv.timeLimit - levelState.elapsed);
    obj = `⏱ Лимит: ${left.toFixed(1)} с. ` + obj;
  }
  lvObjEl.textContent  = obj;
  lvObjEl.classList.toggle('ok', !!levelState.aligned);
  lvProgEl.textContent = `Цели: ${levelState.progress} / ${lv.gates.length}`;
  lvTimeEl.textContent = levelState.elapsed.toFixed(1) + ' с';
  const g = activeGate();
  if(g && g.type !== 'heading' && g.pos){
    lvDistEl.textContent = 'До цели: ' + Math.hypot(state.pos.x-g.pos[0], state.pos.z-g.pos[2]).toFixed(0) + ' м';
  } else lvDistEl.textContent = '';
  const rollDeg = Math.abs(state.roll * 180/Math.PI);
  lvWarnEl.textContent = levelState.warn
    ? (lv.constraints && lv.constraints.maxRoll != null && rollDeg > lv.constraints.maxRoll
        ? `КРЕН > ${lv.constraints.maxRoll}°!`
        : 'ОГРАНИЧЕНИЕ!')
    : (ctrl.emergency ? 'ОТКАЗ МОТОРА' : '');
  lvWarnEl.className = (levelState.warn || ctrl.emergency) ? 'warn' : '';
}

/* --- меню уровней --- */
function updateLevelMenu(){
  let li = 0, ri = 0;
  levelmenuEl.innerHTML = LEVELS.map((lv,i)=>{
    const label = lv.race ? `Трасса ${++ri}/${RACE_TOTAL}` : `Уровень ${++li}/${LESSON_TOTAL}`;
    return `<button data-idx="${i}" class="${i===currentLevelIndex?'active':''}">${lv.name}<small>${label} · ${lv.brief}</small></button>`;
  }).join('');
}
function openLevelMenu(){ levelmenuEl.classList.add('open'); }
function closeLevelMenu(){ levelmenuEl.classList.remove('open'); }
menuBtnEl.addEventListener('click', e=>{ e.stopPropagation(); levelmenuEl.classList.toggle('open'); });
levelmenuEl.addEventListener('click', e=>{
  const b = e.target.closest('button[data-idx]');
  if(!b) return;
  loadLevel(parseInt(b.dataset.idx,10));
  closeLevelMenu();
});
document.addEventListener('click', e=>{
  if(!levelmenuEl.contains(e.target) && !menuBtnEl.contains(e.target)) closeLevelMenu();
});

/* ============================================================
   Цикл
   ============================================================ */
const clock = new THREE.Clock();
function animate(){
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, clock.getDelta());
  qTime += dt; qFrames++;
  gpUpdate();
  /* Сетевой старт: до «GO» физика и таймер стоят, идёт отсчёт. */
  const frozen = netRace.active && (netRace.phase === 'waiting' || netRace.phase === 'countdown');
  if(frozen){
    if(netRace.phase === 'countdown'){
      netRace.countdown -= dt;
      renderCountdown();
      if(netRace.countdown <= 0){ netRace.phase = 'running'; renderCountdown(); netRaceSendState(true); }
    } else if(performance.now() > netRace.waitUntil){
      netRaceGo();   /* хост — по готовности/таймауту; гость — аварийный таймаут */
    }
  }
  if(!paused && !frozen){ updatePhysics(dt); updateLevel(dt); }
  renderer.render(scene, camera);
  if(camMode === 3) drawFpvHud();
}
loadLevel(0);
animate();

/* Стартовый экран при загрузке. */
showStart(1);

/* ============================================================
   Resize
   ============================================================ */
addEventListener('resize', ()=>{
  camera.aspect = innerWidth/innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

/* Подсказка в консоли */
console.log('%cСимулятор БПЛА: обучающие уровни. N — далее, R — заново, 1…9/0 — выбор уровня, C — камера. Подключите USB-пульт (BetaFPV) и настройте оси в кнопке «Настройка пульта».', 'color:#39d353');

/* ============================================================
   Сворачиваемые окна (пульт / модель / сеть / старт-экран / оверлей).
   Каждое окно получает заголовок с кнопкой свернуть/развернуть; тело
   складывается, остаётся только заголовок.
   ============================================================ */
function makeCollapsible(modalEl){
  const card = modalEl.querySelector('.gp-card, .st-card, .card');
  if(!card || !card.firstElementChild || card.querySelector('.win-head')) return;
  const title = card.firstElementChild;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'win-toggle';
  btn.title = 'Свернуть окно';
  btn.setAttribute('aria-label', 'Свернуть окно');
  btn.textContent = 'Свернуть ▾';
  const head = document.createElement('div');
  head.className = 'win-head';
  head.appendChild(title);
  head.appendChild(btn);
  const body = document.createElement('div');
  body.className = 'win-body';
  while(card.firstChild) body.appendChild(card.firstChild);
  card.appendChild(head);
  card.appendChild(body);
  btn.addEventListener('click', e=>{
    e.stopPropagation();
    const min = card.classList.toggle('min');
    btn.textContent = min ? 'Развернуть ▸' : 'Свернуть ▾';
    btn.title = min ? 'Развернуть окно' : 'Свернуть окно';
    btn.setAttribute('aria-label', btn.title);
    card.dataset.min = min ? '1' : '';
  });
  if(card.dataset.min === '1'){
    card.classList.add('min');
    btn.textContent = 'Развернуть ▸';
    btn.title = 'Развернуть окно';
  }
}
function expandWindow(modalEl){
  const card = modalEl.querySelector('.gp-card, .st-card, .card');
  if(!card) return;
  card.classList.remove('min');
  if(card.dataset) card.dataset.min = '';
  const btn = card.querySelector('.win-toggle');
  if(btn){ btn.textContent = 'Свернуть ▾'; btn.title = 'Свернуть окно'; }
}

/* --- сворачивание панелей поверх полёта (телеметрия / строка уровня / легенда) ---
   Заголовок панели оборачивается в шапку с кнопкой; содержимое после заголовка
   складывается в .panel-body и при .collapsed скрывается. */
function makePanelCollapsible(panelEl, headerEl){
  if(!panelEl || !headerEl || panelEl.querySelector('.panel-toggle')) return;
  const body = document.createElement('div');
  body.className = 'panel-body';
  let n = headerEl.nextSibling;
  while(n){ const next = n.nextSibling; body.appendChild(n); n = next; }
  panelEl.appendChild(body);
  const head = document.createElement('div');
  head.className = 'panel-head';
  panelEl.insertBefore(head, headerEl);
  head.appendChild(headerEl);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'panel-toggle';
  btn.title = 'Свернуть панель';
  btn.setAttribute('aria-label', 'Свернуть панель');
  btn.textContent = '▾';
  head.appendChild(btn);
  btn.addEventListener('click', e=>{
    e.stopPropagation();
    const col = panelEl.classList.toggle('collapsed');
    btn.textContent = col ? '▸' : '▾';
    btn.title = col ? 'Развернуть панель' : 'Свернуть панель';
    btn.setAttribute('aria-label', btn.title);
  });
}
makePanelCollapsible(document.getElementById('hud'),      document.querySelector('#hud .ttl'));
makePanelCollapsible(document.getElementById('levelbar'), document.getElementById('lvName'));

/* --- панели без своего заголовка: добавляем шапку с названием и кнопкой ---
   (правый блок с кнопкой «УРОВНИ» и нижняя панель подсказок).
   startCollapsed — свернуть панель сразу (по умолчанию). */
function makeHeaderPanel(panelEl, titleText, startCollapsed){
  if(!panelEl || panelEl.querySelector(':scope > .panel-head')) return;
  const body = document.createElement('div');
  body.className = 'panel-body';
  while(panelEl.firstChild) body.appendChild(panelEl.firstChild);
  const head = document.createElement('div');
  head.className = 'panel-head';
  const t = document.createElement('span');
  t.className = 'panel-title';
  t.textContent = titleText;
  head.appendChild(t);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'panel-toggle';
  btn.title = 'Свернуть панель';
  btn.setAttribute('aria-label', 'Свернуть панель');
  btn.textContent = '▾';
  head.appendChild(btn);
  panelEl.appendChild(head);
  panelEl.appendChild(body);
  btn.addEventListener('click', e=>{
    e.stopPropagation();
    const col = panelEl.classList.toggle('collapsed');
    btn.textContent = col ? '▸' : '▾';
    btn.title = col ? 'Развернуть панель' : 'Свернуть панель';
    btn.setAttribute('aria-label', btn.title);
  });
  if(startCollapsed){
    panelEl.classList.add('collapsed');
    btn.textContent = '▸';
    btn.title = 'Развернуть панель';
    btn.setAttribute('aria-label', btn.title);
  }
}
makeHeaderPanel(document.getElementById('legend'), 'УПРАВЛЕНИЕ', !isMobile);
makeHeaderPanel(document.getElementById('help'),   'ПОДСКАЗКИ', true);

/* ============================================================
   Полный экран (кнопка ⛶) и адаптивное качество на слабых устройствах
   ============================================================ */
/* Максимально полноэкранный режим: Fullscreen API с флагом navigationUI:'hide'
   (в вебкит-префиксе параметров нет), на мобильных — ещё и wakeLock (экран
   не гаснет) + блокировка ориентации. iOS Safari (iPhone) не даёт переводить
   элементы в fullscreen — там остаётся standalone PWA-режим. */
function isFsActive(){
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}
function fullscreenEl(){
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}
async function enterMaxFullscreen(){
  const el = document.documentElement;
  if(el.requestFullscreen) await el.requestFullscreen({ navigationUI:'hide' });
  else if(el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
}
function exitMaxFullscreen(){
  const fs = fullscreenEl();
  if(!fs) return;
  if(document.exitFullscreen) document.exitFullscreen();
  else if(document.webkitExitFullscreen) document.webkitExitFullscreen();
}
function toggleFullscreen(){
  if(isFsActive()) exitMaxFullscreen();
  else enterMaxFullscreen().catch(()=>{});
}

const fsBtn = document.getElementById('fsBtn');
if(fsBtn) fsBtn.addEventListener('click', e=>{
  e.stopPropagation();
  toggleFullscreen();
  updateFsBtn();
});
function updateFsBtn(){
  if(!fsBtn) return;
  fsBtn.textContent = isFsActive() ? '⛶ СВЕРНУТЬ ФС' : '⛶ ПОЛНЫЙ ЭКРАН';
}
document.addEventListener('fullscreenchange', updateFsBtn);
document.addEventListener('webkitfullscreenchange', updateFsBtn);

/* на мобильных: включаем максимально полноэкранный режим ОДИН раз по первому
   жесту пользователя (требование браузеров) — без повторных запросов, чтобы
   не спровоцировать цикл fullscreen/orientation. Экран держим включённым. */
if(isMobile){
  let fsAutoTried = false;
  async function tryAutoMaxFs(){
    if(fsAutoTried) return;
    fsAutoTried = true;
    try{
      if(navigator.wakeLock) await navigator.wakeLock.request('screen');
    }catch(_){}
    if(isFsActive()) return;
    try{
      const el = document.documentElement;
      if(el.requestFullscreen) await el.requestFullscreen({ navigationUI:'hide' });
      else if(el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
      /* блокировка ориентации (где поддерживается) — один раз */
      if(screen.orientation && screen.orientation.lock){
        try{ await screen.orientation.lock('landscape'); }catch(_){}
      }
    }catch(_){}
  }
  addEventListener('pointerdown', tryAutoMaxFs, { passive:true, once:true });
  addEventListener('touchend',    tryAutoMaxFs, { passive:true, once:true });
}

/* Адаптивное разрешение: если средний кадр тяжелее 34 мс — снижаем scale */
setInterval(()=>{
  if(qFrames < 20) return;
  const avg = qTime / qFrames;
  if(avg > 0.034 && renderScale > 0.8){
    renderScale = Math.max(0.75, renderScale - 0.25);
    renderer.setPixelRatio(Math.min(devicePixelRatio, renderScale));
    renderer.setSize(innerWidth, innerHeight);
  }
  qFrames = 0; qTime = 0;
}, 3000);
