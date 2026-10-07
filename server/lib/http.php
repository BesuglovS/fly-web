<?php
declare(strict_types=1);

/**
 * Общие помощники API сигналинга сетевой игры fly-web.
 *
 * Авторизация — только сервер-к-серверу через канонический AuthClient
 * (auth.nayanovaacademy.ru/api/check.php): доверяем исключительно серверу,
 * клиентские данные (user_id/имя) не принимаем. Соперники подбираются среди
 * всех вошедших учеников.
 *
 * Запросы принимаем только POST с Content-Type: application/json — это также
 * отсекает кросс-сайтовые form-POST (простые запросы не умеют JSON).
 */

require_once __DIR__ . '/../auth-client/AuthClient.php';
require_once __DIR__ . '/Db.php';

const FLY_DEFAULT_MAX   = 4;                   // размер комнаты по умолчанию
const FLY_MAX_PLAYERS   = 8;                   // жёсткий потолок участников (mesh)
const FLY_MAX_OPTIONS   = [2, 4, 6, 8];        // разрешённые размеры комнаты
const FLY_PUBLIC_MAX    = 4;                   // больше — только администратор
const FLY_SDP_MAX_BYTES = 32768;
const FLY_NAME_MAX      = 60;
const FLY_POLL_WINDOW   = 60;   // окно rate-limit, сек
const FLY_POLL_LIMIT    = 120;  // запросов на окно на игрока (~2/сек)

function flyJson($data, int $code = 200): void
{
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

function flyFail(string $message, int $code = 400): void
{
    flyJson(['error' => $message], $code);
}

/** Разрешить только POST с JSON (и короткий ответ на preflight OPTIONS). */
function flyMethod(): void
{
    $method = $_SERVER['REQUEST_METHOD'] ?? '';
    if ($method === 'OPTIONS') {
        http_response_code(204);
        exit;
    }
    if ($method !== 'POST') {
        flyFail('Method not allowed', 405);
    }
    // JSON обязателен для ВСЕХ эндпоинтов (даже без тела) — это, вместе с
    // SameSite=Lax, отсекает кросс-сайтовые form-POST (простые запросы не умеют JSON).
    $ctype = strtolower((string) ($_SERVER['CONTENT_TYPE'] ?? ''));
    if (strpos($ctype, 'application/json') === false) {
        flyFail('Expected application/json', 415);
    }
}

function flyBody(): array
{
    $raw = file_get_contents('php://input');
    if ($raw === false || $raw === '') {
        return [];
    }
    $data = json_decode($raw, true);
    if (!is_array($data)) {
        flyFail('Invalid JSON', 400);
    }
    return $data;
}

/** Текущий авторизованный пользователь либо 401. */
function flyRequireUser(): array
{
    if (session_status() === PHP_SESSION_NONE) {
        ini_set('session.use_only_cookies', 1);
        @session_start();
    }
    $user = AuthClient::check();
    if (!is_array($user) || !isset($user['id'])) {
        flyFail('Требуется авторизация', 401);
    }
    return $user;
}

/** Имя для отображения из профиля auth-web. */
function flyName(array $user): string
{
    $name = (string) ($user['display_name'] ?? '');
    if ($name === '') {
        $name = (string) ($user['login'] ?? 'Пилот');
    }
    $name = preg_replace('/[\x00-\x1F\x7F]/u', '', $name) ?? '';
    $name = trim($name);
    if ($name === '') {
        return 'Пилот';
    }
    return mb_substr($name, 0, FLY_NAME_MAX);
}

/** Фиксированное окно rate-limit на игрока. */
function flyRateLimit(PDO $db, int $userId): void
{
    $name = 'signal:' . $userId;
    $now = time();
    $allowed = FlyDb::immediateTxn($db, function (PDO $db) use ($name, $now): bool {
        $stmt = $db->prepare('SELECT window_started_at, hits FROM rate_limits WHERE name = ?');
        $stmt->execute([$name]);
        $row = $stmt->fetch();

        if (!$row || ($now - (int) $row['window_started_at']) >= FLY_POLL_WINDOW) {
            $db->prepare(
                'INSERT INTO rate_limits (name, window_started_at, hits) VALUES (?, ?, 1)
                 ON CONFLICT(name) DO UPDATE SET window_started_at = excluded.window_started_at, hits = 1'
            )->execute([$name, $now]);
            return true;
        }
        if ((int) $row['hits'] >= FLY_POLL_LIMIT) {
            return false;
        }
        $db->prepare('UPDATE rate_limits SET hits = hits + 1 WHERE name = ?')->execute([$name]);
        return true;
    });

    if (!$allowed) {
        flyFail('Too many requests', 429);
    }
}

/** @return array<int,array{user_id:int,name:string,slot:int}> */
function flyParticipants(PDO $db, int $roomId): array
{
    $stmt = $db->prepare(
        'SELECT user_id, name, slot FROM players WHERE room_id = ? ORDER BY joined_at ASC, user_id ASC'
    );
    $stmt->execute([$roomId]);
    $out = [];
    foreach ($stmt->fetchAll() as $row) {
        $out[] = [
            'user_id' => (int) $row['user_id'],
            'name' => (string) $row['name'],
            'slot' => (int) $row['slot'],
        ];
    }
    return $out;
}

/* ─── комнаты как самостоятельные игры (несколько одновременно) ─── */

const FLY_MAPS  = ['meadow', 'city', 'canyon', 'forest'];
const FLY_MODES = ['angle', 'acro'];

function flySanitizeMap(?string $map): string
{
    return in_array((string) $map, FLY_MAPS, true) ? (string) $map : 'meadow';
}

function flySanitizeMode(?string $mode): string
{
    return in_array((string) $mode, FLY_MODES, true) ? (string) $mode : 'angle';
}

function flySanitizeTitle(?string $title): string
{
    $title = preg_replace('/[\x00-\x1F\x7F]/u', '', (string) $title) ?? '';
    return mb_substr(trim($title), 0, 60);
}

/** Размер комнаты: только из FLY_MAX_OPTIONS, иначе значение по умолчанию. */
function flySanitizeMax($value): int
{
    $max = (int) $value;
    return in_array($max, FLY_MAX_OPTIONS, true) ? $max : FLY_DEFAULT_MAX;
}

function flyIsAdmin(array $user): bool
{
    return !empty($user['is_admin']);
}

/** Доступные размеры комнаты для создания: > FLY_PUBLIC_MAX — только админ. */
function flyAllowedMaxOptions(bool $isAdmin): array
{
    if ($isAdmin) {
        return FLY_MAX_OPTIONS;
    }
    return array_values(array_filter(FLY_MAX_OPTIONS, static fn(int $n): bool => $n <= FLY_PUBLIC_MAX));
}

/** Ограничить размер по правам: не-админу — не больше FLY_PUBLIC_MAX. */
function flyClampMaxForUser(int $max, bool $isAdmin): int
{
    if (!$isAdmin && $max > FLY_PUBLIC_MAX) {
        return FLY_PUBLIC_MAX;
    }
    return $max;
}

function flyRoomRow(PDO $db, int $roomId): ?array
{
    $stmt = $db->prepare(
        'SELECT id, title, map, params, host_user_id, started, max, created_at FROM rooms WHERE id = ?'
    );
    $stmt->execute([$roomId]);
    $row = $stmt->fetch();
    return $row ?: null;
}

/** Если хост покинул комнату — назначить хостом самого «старого» участника. */
function flyEnsureHost(PDO $db, int $roomId): void
{
    $room = flyRoomRow($db, $roomId);
    if (!$room) {
        return;
    }
    $hostId = (int) $room['host_user_id'];
    $chk = $db->prepare('SELECT 1 FROM players WHERE user_id = ? AND room_id = ?');
    $chk->execute([$hostId, $roomId]);
    if ($chk->fetchColumn()) {
        return;
    }
    $stmt = $db->prepare(
        'SELECT user_id FROM players WHERE room_id = ? ORDER BY joined_at ASC, user_id ASC LIMIT 1'
    );
    $stmt->execute([$roomId]);
    $newHost = $stmt->fetchColumn();
    if ($newHost !== false) {
        $db->prepare('UPDATE rooms SET host_user_id = ? WHERE id = ?')->execute([(int) $newHost, $roomId]);
    }
}

function flyRoomInfo(PDO $db, int $roomId): ?array
{
    $room = flyRoomRow($db, $roomId);
    if (!$room) {
        return null;
    }
    $hostId = (int) $room['host_user_id'];
    $hn = $db->prepare('SELECT name FROM players WHERE user_id = ?');
    $hn->execute([$hostId]);
    $params = json_decode((string) $room['params'], true);
    return [
        'id' => (int) $room['id'],
        'title' => (string) $room['title'],
        'map' => (string) $room['map'],
        'params' => is_array($params) ? $params : ['mode' => 'angle'],
        'host_user_id' => $hostId,
        'host_name' => (string) ($hn->fetchColumn() ?: ''),
        'started' => (int) $room['started'] === 1,
        'max' => (int) $room['max'],
    ];
}

/** Снимок комнаты для клиента (без сигналов). */
function flySnapshot(PDO $db, int $roomId, int $viewerId, string $viewerName, bool $isAdmin = false): array
{
    $slotStmt = $db->prepare('SELECT slot FROM players WHERE user_id = ?');
    $slotStmt->execute([$viewerId]);
    $room = flyRoomInfo($db, $roomId);
    return [
        'room' => $room,
        'self' => ['id' => $viewerId, 'name' => $viewerName, 'slot' => (int) $slotStmt->fetchColumn()],
        'participants' => flyParticipants($db, $roomId),
        'max' => $room['max'] ?? FLY_DEFAULT_MAX,
        'maxOptions' => flyAllowedMaxOptions($isAdmin),
        'maxHard' => $isAdmin ? FLY_MAX_PLAYERS : FLY_PUBLIC_MAX,
        'isAdmin' => $isAdmin,
        'maps' => FLY_MAPS,
    ];
}

/** Наименьший свободный слот (0..3) в комнате; -1, если свободных нет. */
function flyPickSlot(PDO $db, int $roomId, int $excludeUserId): int
{
    $stmt = $db->prepare(
        'SELECT slot FROM players WHERE room_id = ? AND user_id <> ? AND slot >= 0'
    );
    $stmt->execute([$roomId, $excludeUserId]);
    $used = $stmt->fetchAll(PDO::FETCH_COLUMN);
    $used = array_map('intval', $used);
    for ($s = 0; $s < FLY_MAX_PLAYERS; $s++) {
        if (!in_array($s, $used, true)) {
            return $s;
        }
    }
    return -1;
}

/** Применить управление игрой от хоста (иначе — no-op). */
function flyApplyControl(PDO $db, int $roomId, int $userId, array $control, int $now, bool $isAdmin = false): void
{
    $room = flyRoomRow($db, $roomId);
    if (!$room || (int) $room['host_user_id'] !== $userId) {
        return;
    }

    $map = array_key_exists('map', $control)
        ? flySanitizeMap((string) $control['map'])
        : (string) $room['map'];

    $params = json_decode((string) $room['params'], true);
    if (!is_array($params)) {
        $params = [];
    }
    if (array_key_exists('mode', $control)) {
        $params['mode'] = flySanitizeMode((string) $control['mode']);
    }

    $started = array_key_exists('started', $control)
        ? (int) (!empty($control['started']) ? 1 : 0)
        : (int) $room['started'];

    $title = (string) $room['title'];
    if (array_key_exists('title', $control)) {
        $t = flySanitizeTitle((string) $control['title']);
        if ($t !== '') {
            $title = $t;
        }
    }

    // Размер комнаты: нельзя опустить ниже числа текущих участников.
    $max = (int) $room['max'];
    if (array_key_exists('max', $control)) {
        $cand = flyClampMaxForUser(flySanitizeMax($control['max']), $isAdmin);
        $cnt = $db->prepare('SELECT COUNT(*) FROM players WHERE room_id = ?');
        $cnt->execute([$roomId]);
        if ($cand >= (int) $cnt->fetchColumn()) {
            $max = $cand;
        }
    }

    $db->prepare('UPDATE rooms SET map = ?, params = ?, started = ?, title = ?, max = ? WHERE id = ?')
        ->execute([$map, json_encode($params), $started, $title, $max, $roomId]);
}

function flyUpsertPlayer(PDO $db, int $userId, string $name, int $roomId, int $now): void
{
    // Слот (точка спавна) сохраняем при обновлении в той же комнате;
    // при входе/переходе — занимаем наименьший свободный.
    $cur = $db->prepare('SELECT room_id, slot FROM players WHERE user_id = ?');
    $cur->execute([$userId]);
    $row = $cur->fetch();
    if ($row && (int) $row['room_id'] === $roomId && (int) $row['slot'] >= 0) {
        $slot = (int) $row['slot'];
    } else {
        $slot = flyPickSlot($db, $roomId, $userId);
        if ($slot < 0) {
            $slot = 0;
        }
    }

    $db->prepare(
        'INSERT INTO players (user_id, name, room_id, joined_at, seen_at, slot)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           name = excluded.name, room_id = excluded.room_id,
           joined_at = excluded.joined_at, seen_at = excluded.seen_at, slot = excluded.slot'
    )->execute([$userId, $name, $roomId, $now, $now, $slot]);
}

function flyCreateRoom(PDO $db, int $userId, string $name, string $title, int $now, int $max = FLY_DEFAULT_MAX): int
{
    if ($title === '') {
        $title = mb_substr('Игра: ' . $name, 0, 60);
    }
    $max = flySanitizeMax($max);
    $db->prepare(
        'INSERT INTO rooms (title, map, params, host_user_id, started, max, created_at)
         VALUES (?, ?, ?, ?, 0, ?, ?)'
    )->execute([$title, 'meadow', json_encode(['mode' => 'angle']), $userId, $max, $now]);
    $roomId = (int) $db->lastInsertId();
    flyUpsertPlayer($db, $userId, $name, $roomId, $now);
    return $roomId;
}

/** @return array{ok:bool,room_id?:int,error?:string,code?:int} */
function flyJoinRoom(PDO $db, int $userId, string $name, int $roomId, int $now): array
{
    $room = flyRoomRow($db, $roomId);
    if (!$room) {
        return ['ok' => false, 'error' => 'Комната не найдена', 'code' => 404];
    }

    $cur = $db->prepare('SELECT room_id FROM players WHERE user_id = ?');
    $cur->execute([$userId]);
    $curRoom = $cur->fetchColumn();
    if ($curRoom !== false && (int) $curRoom === $roomId) {
        $db->prepare('UPDATE players SET name = ?, seen_at = ? WHERE user_id = ?')->execute([$name, $now, $userId]);
        return ['ok' => true, 'room_id' => $roomId];
    }

    $cnt = $db->prepare('SELECT COUNT(*) FROM players WHERE room_id = ?');
    $cnt->execute([$roomId]);
    if ((int) $cnt->fetchColumn() >= (int) $room['max']) {
        return ['ok' => false, 'error' => 'Комната заполнена', 'code' => 409];
    }

    if ($curRoom !== false) {
        flyRemovePlayer($db, $userId, (int) $curRoom, $now);
    }
    flyUpsertPlayer($db, $userId, $name, $roomId, $now);
    flyEnsureHost($db, $roomId);
    return ['ok' => true, 'room_id' => $roomId];
}

/** Убрать игрока из комнаты; переназначить хоста; удалить пустую комнату. */
function flyRemovePlayer(PDO $db, int $userId, int $roomId, int $now): void
{
    $db->prepare('DELETE FROM players WHERE user_id = ? AND room_id = ?')->execute([$userId, $roomId]);
    flyEnsureHost($db, $roomId);
    $cnt = $db->prepare('SELECT COUNT(*) FROM players WHERE room_id = ?');
    $cnt->execute([$roomId]);
    if ((int) $cnt->fetchColumn() === 0) {
        $db->prepare('DELETE FROM rooms WHERE id = ?')->execute([$roomId]);
    }
}
