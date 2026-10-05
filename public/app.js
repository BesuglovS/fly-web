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
  { id:'mini2',  name:'Пионер Мини 2', desc:'Образовательный: спокойный и послушный.',
    scale:1.0,  bodyColor:0x2c3138, thrustMul:1.0,  speedMul:1.0,  climbMul:1.0,  dragMul:1.0,  baseCap:3500 },
  { id:'base',   name:'Пионер Базовый', desc:'Платформа-конструктор: устойчивый, тяговитый.',
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
  el.textContent = `● ${name}` + (gamepad.count > 1 ? ` (#${gamepad.axisIndex})` : '');
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
      <button type="button" class="st-mode" data-target="free">🛩️ Свободный полёт
        <small>Просто летайте: Луг, Город или Каньон</small></button>
    </div>
    <p class="st-h3">Ещё</p>
    <div class="st-modes">
      <button type="button" class="st-mode st-small" id="stNetBtn">🌐 Сетевая игра</button>
      <button type="button" class="st-mode st-small" id="stFsBtn">⛶ Полный экран</button>
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
  } else {
    stCardEl.innerHTML = `
      <p class="st-title">Обучающие упражнения</p>
      <p class="st-sub">Шаг 2 из 2 — выберите уровень</p>
      <div class="st-levels">
        ${LEVELS.map((lv,i)=>
          `<button type="button" data-idx="${i}" class="${i===currentLevelIndex?'active':''}">
            ${i+1}. ${lv.name}<small>${lv.brief}</small></button>`).join('')}
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
   Сетевая игра: WebRTC DataChannel с ручным обменом кодами.
   Хост создаёт код-приглашение, гость отвечает кодом, хост завершает.
   ============================================================ */
const netModalEl = document.getElementById('netModal');
const netBtnEl   = document.getElementById('netBtn');
const netStatusEl   = document.getElementById('netStatus');
const netStepsEl    = document.getElementById('netSteps');
const netHostNameEl = document.getElementById('netHost');
const netJoinNameEl = document.getElementById('netJoin');

const net = {
  pc: null, dc: null,
  role: '',          // 'host' | 'guest'
  connected: false,
  userName: 'Пилот',
  peerName: 'Соперник',
};

function netTextStatus(txt, ok){
  netStatusEl.textContent = txt;
  netStatusEl.className = ok ? 'ok' : '';
}
function netSetStatus(txt){
  netStepsEl.innerHTML = txt;
}

netBtnEl.addEventListener('click', e=>{ e.stopPropagation(); closeLevelMenu(); openNetModal(); });
document.getElementById('netClose').addEventListener('click', closeNetModal);
netModalEl.addEventListener('click', e=>{ if(e.target === netModalEl) closeNetModal(); });
addEventListener('keydown', e=>{ if(e.code === 'Escape' && netModalEl.classList.contains('show')) closeNetModal(); });

function openNetModal(){
  netModalEl.classList.add('show');
  netModalEl.setAttribute('aria-hidden','false');
  makeCollapsible(netModalEl);
  expandWindow(netModalEl);
  netTextStatus(net.connected ? '● ' + net.peerName : '○ Не подключено', net.connected);
  netStepsEl.innerHTML = net.connected
    ? `<p class="net-step">Соединение установлено. Летайте вместе — на сцене виден аппарат соперника. Рекомендуется свободный полёт.</p>`
    : `<p class="net-step">Хост: нажмите «Создать приглашение», скопируйте код-приглашение и отправьте другу.</p>
       <p class="net-step">Гость: нажмите «Присоединиться», вставьте полученный код, скопи́руйте ответный код и отправьте хосту.</p>
       <p class="net-step">Хост: вставьте ответный код в поле «Ответ гостя» (шаг 3). Соединение установится автоматически.</p>`;
}

function closeNetModal(){
  netModalEl.classList.remove('show');
  netModalEl.setAttribute('aria-hidden','true');
  /* если открыли из стартового экрана — возвращаемся на него */
  if(stStep !== 0) showStart(stStep, stTarget);
}

/* -- помощники обмена кодами -- */
function codeOut(label, value){
  const ta = document.createElement('textarea');
  ta.className = 'net-code';
  ta.readOnly = true;
  ta.value = value;
  ta.addEventListener('click', ()=>ta.select());
  const div = document.createElement('div');
  div.innerHTML = label;
  div.appendChild(ta);
  netStepsEl.appendChild(div);
}
function codeIn(label, onok){
  const ta = document.createElement('textarea');
  ta.className = 'net-code';
  ta.placeholder = 'вставьте код сюда…';
  ta.addEventListener('click', ()=>ta.select());
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'ОК';
  btn.addEventListener('click', ()=>onok(ta.value.trim()));
  const div = document.createElement('div');
  div.innerHTML = label;
  div.appendChild(ta);
  div.appendChild(btn);
  netStepsEl.appendChild(div);
}
function desc2code(desc){
  return btoa(unescape(encodeURIComponent(JSON.stringify(desc)))).slice(0, 1200);
}
function code2desc(str){
  str = str.replace(/^invite:/,'').trim();
  return JSON.parse(decodeURIComponent(escape(atob(str))));
}
function netIceDone(p){
  if(!p || !p.iceGatheringState) return Promise.resolve(p);
  if(p.iceGatheringState === 'complete') return Promise.resolve(p);
  return new Promise(res=>{
    p.addEventListener('icegatheringstatechange', ()=>{
      if(p.iceGatheringState === 'complete') res(p);
    });
  });
}

/* -- хост: приглашение -- */
netHostElSetup();
function netHostElSetup(){
  netHostNameEl.addEventListener('click', netCreateInvite);
}

async function netCreateInvite(){
  try{
    net.pc = new RTCPeerConnection({ iceServers:[{ urls:'stun:stun.l.google.com:19302' }] });
    net.dc = net.pc.createDataChannel('fly', { ordered:false, maxRetransmits:1 });
    wireDataChannel(net.dc);
    net.pc.ondatachannel = e=>wireDataChannel(e.channel);
    const offer = await net.pc.createOffer();
    await net.pc.setLocalDescription(offer);
    await netIceDone(net.pc);
    netTextStatus('⟳ Код готов — отправьте другу', true);
    netStepsEl.innerHTML = '';
    codeOut('<b>Ваш код-приглашение</b> (скопируйте):', desc2code(net.pc.localDescription));
    netHostNameEl.replaceWith(netHostNameEl.cloneNode(true));
    codeIn('<b>Ответ гостя</b> (шаг 3):', async val=>{
      try{
        await net.pc.setRemoteDescription(code2desc(val));
        netTextStatus('⟳ Подключение…', true);
      }catch(err){ netTextStatus('⚠ Ошибка ответа: ' + err.message, false); }
    });
  }catch(err){ netTextStatus('⚠ ' + err.message, false); }
}

/* -- гость: ответ -- */
netJoinNameSetup();
function netJoinNameSetup(){
  netJoinNameEl.addEventListener('click', netCreateAnswer);
}
async function netCreateAnswer(){
  try{
    netStepsEl.innerHTML = '';
    codeIn('<b>Код-приглашение хоста</b> (вставьте):', async val=>{
      try{
        net.pc = new RTCPeerConnection({ iceServers:[{ urls:'stun:stun.l.google.com:19302' }] });
        net.pc.ondatachannel = e=>wireDataChannel(e.channel);
        await net.pc.setRemoteDescription(code2desc(val));
        const answer = await net.pc.createAnswer();
        await net.pc.setLocalDescription(answer);
        await netIceDone(net.pc);
        netTextStatus('⟳ Ответ готов — отправьте хосту', true);
        codeOut('<b>Ваш ответный код</b> (скопируйте):', desc2code(net.pc.localDescription));
      }catch(err){ netTextStatus('⚠ ' + err.message, false); }
    });
  }catch(err){ netTextStatus('⚠ ' + err.message, false); }
}

/* -- данные -- */
function wireDataChannel(dc){
  net.dc = dc;
  dc.addEventListener('open', ()=>{
    net.connected = true;
    net.pc.onconnectionstatechange = updateNetState;
    dc.send(JSON.stringify({ t:'hello', name: net.userName }));
    showRemoteDrone(true);
    netTextStatus('● Соединено', true);
  });
  dc.addEventListener('close', ()=>updateNetState());
  dc.addEventListener('error', ()=>updateNetState());
  dc.addEventListener('message', ev=>{
    try{
      const m = JSON.parse(ev.data);
      if(m.t === 'hello'){ net.peerName = m.name || 'Пилот'; netTextStatus('● ' + net.peerName, true); }
      else if(m.t === 'st' && net.connected){
        remoteTargetPos.set(m.p[0], m.p[1], m.p[2]);
        remoteTargetQuat.set(m.q[0], m.q[1], m.q[2], m.q[3]);
      }
    }catch(_){}
  });
}
function updateNetState(){
  const isUp = net.dc && net.dc.readyState === 'open';
  net.connected = isUp;
  if(!isUp){
    showRemoteDrone(false);
    netTextStatus('○ Не подключено', false);
  }
}

/* -- удалённый дрон соперника: клон меша + плавная интерполяция -- */
const remoteTargetPos  = new THREE.Vector3(0, GROUND_REST, 0);
const remoteTargetQuat = new THREE.Quaternion();
let remoteDroneObj = null;
let remoteProps = [];
function showRemoteDrone(on){
  if(on && !remoteDroneObj){
    const built = makeDroneMesh(DRONE_MODELS[0]);
    remoteDroneObj = built.group;
    remoteProps = built.props;
    scene.add(remoteDroneObj);
  } else if(!on && remoteDroneObj){
    scene.remove(remoteDroneObj);
    disposeTree(remoteDroneObj);
    remoteDroneObj = null;
    remoteProps = [];
  }
}

/* -- сетевые тики: приём (интерполяция) и отправка (20 Гц) -- */
setInterval(()=>{
  if(!net.connected || !remoteDroneObj) return;
  remoteDroneObj.position.lerp(remoteTargetPos, 0.5);
  remoteDroneObj.quaternion.slerp(remoteTargetQuat, 0.5);
  const spin = 10;
  for(const p of remoteProps) p.rotation.y += p.userData.dir * spin * 0.05;
}, 50);
setInterval(()=>{
  if(!net.connected || !net.dc || net.dc.readyState !== 'open') return;
  const q = state.quat;
  net.dc.send(JSON.stringify({
    t:'st', p:[state.pos.x, state.pos.y, state.pos.z],
    q:[q.x, q.y, q.z, q.w]
  }));
}, 50);

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
  shadowBlob.position.set(state.pos.x, 0.02, state.pos.z);
  const h = clamp(1 - (state.pos.y-GROUND_REST)/26, 0.15, 1);
  shadowBlob.scale.setScalar(0.7 + (state.pos.y-GROUND_REST)*0.05);
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
  /* рыскание — вокруг МИРОВОЙ вертикали (снос при отказе мотора тоже здесь) */
  if(yawRate !== 0){
    _yawQ.setFromAxisAngle(Y_AXIS, yawRate*dt);
    state.quat.premultiply(_yawQ);
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

/* общее завершение шага: интегрирование, земля, границы, модель */
function integrateDrone(dt){
  state.pos.addScaledVector(state.vel, dt);

  if(state.pos.y < GROUND_REST){
    state.pos.y = GROUND_REST;
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
  vAlt.textContent = (state.pos.y - GROUND_REST).toFixed(1) + ' м';
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
  const alt = state.pos.y - GROUND_REST;
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
}

function buildGateVisual(g){
  g.done = false; g.timer = 0;
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

function buildMapDecor(kind){
  seed = (kind === 'city') ? 4242 : (kind === 'canyon') ? 90210 : 1337;
  if(kind === 'city'){
    /* кварталы — сохраняем центр свободным для площадки */
    for(let i=0;i<30;i++){
      const a = rnd()*Math.PI*2, r = 26 + rnd()*190;
      const x = Math.cos(a)*r, z = Math.sin(a)*r;
      makeBuildingRow(x, z, 8+rnd()*7, 9+rnd()*22, 8+rnd()*7,
        [0x55617a,0x4d5d6e,0x5d6a83,0x465066][rnd()*4|0]);
    }
    for(let i=0;i<10;i++){
      const a = rnd()*Math.PI*2, r = 22 + rnd()*120;
      levelRoot.add(makeTree(Math.cos(a)*r, Math.sin(a)*r, 0.8+rnd()*0.8));
    }
  } else if(kind === 'canyon'){
    for(let i=0;i<42;i++){
      const a = rnd()*Math.PI*2, r = 18 + rnd()*200;
      makeRock(Math.cos(a)*r, Math.sin(a)*r, 0.9+rnd()*1.5);
    }
    /* редкие деревья в расщелинах */
    for(let i=0;i<12;i++){
      const a = rnd()*Math.PI*2, r = 25 + rnd()*160;
      levelRoot.add(makeTree(Math.cos(a)*r, Math.sin(a)*r, 0.7+rnd()*0.9));
    }
  } else {
    /* луг — исходная сцена */
    for(let i=0;i<46;i++){
      const a = rnd()*Math.PI*2, r = 20 + rnd()*170;
      levelRoot.add(makeTree(Math.cos(a)*r, Math.sin(a)*r, 0.8+rnd()*1.4));
    }
  }
}

/* --- сборка сцены уровня --- */
function buildLevelScene(lv){
  clearLevelRoot();
  (lv.obstacles||[]).forEach(buildObstacle);
  (lv.gates||[]).forEach(buildGateVisual);
  if(lv.free) buildMapDecor(cfg.map);
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
  levelState.progress++;
  levelState.hoverTime = 0; levelState.headingTime = 0;
  if(levelState.progress >= LEVELS[currentLevelIndex].gates.length) completeLevel();
}

/* --- проверка ворот --- */
const _gateV = new THREE.Vector3();
function checkGate(g, dt){
  const alt = state.pos.y - GROUND_REST;
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
  const alt = state.pos.y - GROUND_REST;
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

  /* столкновения с препятствиями */
  if(lv.obstacles){
    for(const o of lv.obstacles){
      const [w,h,d] = o.size, m = 0.6;
      if(Math.abs(state.pos.x-o.pos[0]) < w/2+m &&
         Math.abs(state.pos.y-o.pos[1]) < h/2+m &&
         Math.abs(state.pos.z-o.pos[2]) < d/2+m){
        failLevel('Столкновение с препятствием'); return;
      }
    }
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
  else if(a === 'menu'){ hideOverlay(); openLevelMenu(); }
});

/* --- строка уровня (HUD) --- */
function objectiveText(lv){
  const g = activeGate();
  if(!g) return lv.brief;
  const alt = state.pos.y - GROUND_REST;
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
  lvNameEl.textContent = `Уровень ${currentLevelIndex+1}/${LEVELS.length} — ${lv.name}`;
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
  levelmenuEl.innerHTML = LEVELS.map((lv,i)=>
    `<button data-idx="${i}" class="${i===currentLevelIndex?'active':''}">${lv.name}<small>Уровень ${i+1} · ${lv.brief}</small></button>`
  ).join('');
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
  if(!paused){ updatePhysics(dt); updateLevel(dt); }
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
