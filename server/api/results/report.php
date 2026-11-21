<?php
declare(strict_types=1);

/**
 * POST /api/results/report.php
 *
 * Итоги сетевой гонки с сайта. Отправляет только хост комнаты; сервер
 * проверяет комнату, состав на старте и сам пересчитывает места.
 * Для рейтинговой комнаты (params.rated, включает только админ) обновляет Elo;
 * для тренировочной сохраняет только историю.
 */

require_once __DIR__ . '/../../lib/http.php';
require_once __DIR__ . '/../../lib/Db.php';
require_once __DIR__ . '/../../lib/rating.php';
require_once __DIR__ . '/../../lib/results.php';

flyMethod();
$user = flyRequireUser();
$body = flyBody();
$userId = (int) $user['id'];
$db = FlyDb::getInstance();
$now = time();

flyRateLimit($db, $userId);

$roomId = (int) ($body['room_id'] ?? 0);
if ($roomId <= 0) {
    flyFail('room_id required', 400);
}
$stmt = $db->prepare('SELECT * FROM rooms WHERE id = ?');
$stmt->execute([$roomId]);
$room = $stmt->fetch();
if (!$room) {
    flyFail('Комната не найдена', 404);
}
if ((int) $room['host_user_id'] !== $userId) {
    flyFail('Отчёт может отправить только хост комнаты', 403);
}
if (!(int) $room['started']) {
    flyFail('Гонка ещё не начиналась', 409);
}

$params = json_decode((string) $room['params'], true);
if (!is_array($params)) {
    $params = [];
}
$rated = !empty($params['rated']) ? 1 : 0;
$track = flySanitizeRace((string) ($body['track'] ?? ''));
if ($track === '') {
    $track = flySanitizeRace((string) ($params['race'] ?? ''));
}
if ($track === '') {
    flyFail('Трасса не определена', 400);
}
$raceKey = preg_replace('/[^A-Za-z0-9:_\-.]/', '', (string) ($body['race_key'] ?? '')) ?? '';
$raceKey = mb_substr($raceKey, 0, 80);
if ($raceKey === '') {
    flyFail('race_key required', 400);
}
$recordKey = 'net:' . $roomId . ':' . $raceKey;

$rowsRaw = $body['rows'] ?? null;
if (!is_array($rowsRaw) || count($rowsRaw) < 2 || count($rowsRaw) > FLY_MAX_PLAYERS) {
    flyFail('Нужно 2–' . FLY_MAX_PLAYERS . ' результата', 400);
}

$roster = [];
if (isset($params['roster']) && is_array($params['roster'])) {
    foreach ($params['roster'] as $p) {
        if (!is_array($p)) {
            continue;
        }
        $uid = (int) ($p['user_id'] ?? $p['id'] ?? 0);
        if ($uid > 0) {
            $roster[$uid] = [
                'name' => mb_substr(trim((string) ($p['name'] ?? '')), 0, FLY_NAME_MAX),
                'slot' => (int) ($p['slot'] ?? -1),
                'role' => (string) ($p['role'] ?? 'racer'),
            ];
        }
    }
}
if (!$roster) {
    $ps = $db->prepare('SELECT user_id, name, slot FROM players WHERE room_id = ?');
    $ps->execute([$roomId]);
    foreach ($ps->fetchAll() as $p) {
        $spectateRoom = !empty($params['pair']) || !empty($params['director']);
        $roster[(int) $p['user_id']] = [
            'name' => mb_substr(trim((string) $p['name']), 0, FLY_NAME_MAX),
            'slot' => (int) $p['slot'],
            'role' => ($spectateRoom && (int) $p['user_id'] === (int) $room['host_user_id'])
                ? 'spectator' : 'racer',
        ];
    }
}

$rows = [];
$seen = [];
foreach ($rowsRaw as $raw) {
    if (!is_array($raw)) {
        continue;
    }
    $uid = (int) ($raw['user_id'] ?? 0);
    if ($uid <= 0 || isset($seen[$uid]) || !isset($roster[$uid])) {
        continue;
    }
    if (($roster[$uid]['role'] ?? 'racer') === 'spectator') {
        continue;
    }
    $seen[$uid] = true;
    $done = !empty($raw['done']);
    $failed = !empty($raw['failed']) || !$done;
    $fin = flyResultsFloat($raw['fin'] ?? null, null);
    if ($done && $fin === null) {
        $fin = max(0.0, (float) ($raw['time'] ?? 0));
    }
    if (!$done) {
        $fin = null;
    }
    $rows[] = [
        'user_id' => $uid,
        'name' => $roster[$uid]['name'] ?: ('Участник ' . $uid),
        'class_name' => mb_substr(trim((string) ($raw['class_name'] ?? '')), 0, 60),
        'place' => 0,
        'fin' => $fin,
        'time' => max(0.0, (float) ($raw['time'] ?? 0)),
        'prog' => flyResultsInt($raw['prog'] ?? 0, 0, 1000, 0),
        'done' => $done ? 1 : 0,
        'failed' => $failed ? 1 : 0,
        'points' => 0,
    ];
}
if (count($rows) < 2) {
    flyFail('Нужно минимум два участника комнаты', 400);
}

usort($rows, function (array $a, array $b): int {
    if ($a['done'] !== $b['done']) {
        return $a['done'] ? -1 : 1;
    }
    if ($a['done']) {
        return ((float) $a['fin']) <=> ((float) $b['fin']);
    }
    if ($a['failed'] !== $b['failed']) {
        return $a['failed'] ? 1 : -1;
    }
    return $b['prog'] <=> $a['prog'];
});
$place = 1;
foreach ($rows as &$row) {
    $row['place'] = $place++;
}
unset($row);

$event = [
    'key' => $recordKey,
    'source' => 'net',
    'room_id' => $roomId,
    'comp_id' => '',
    'title' => mb_substr(trim((string) $room['title']), 0, 80) ?: 'Сетевая гонка',
    'class_id' => '',
    'class_name' => '',
    'track' => $track,
    'mode' => ((string) ($params['mode'] ?? 'angle')) === 'acro' ? 'acro' : 'angle',
    'format' => 'race',
    'rated' => $rated,
    'heat_id' => 0,
    'round' => 0,
    'label' => 'Сетевая гонка',
    'finished_at' => $now,
    'reason' => 'finish',
    'rows' => $rows,
];

$result = ['status' => 'duplicate', 'event_id' => 0];
FlyDb::immediateTxn($db, function (PDO $db) use ($event, &$result): void {
    $result = flyResultsInsertEvent($db, $event);
    if ($result['status'] === 'accepted') {
        flyRatingRebuild($db);
    }
});

flyJson([
    'ok' => true,
    'status' => $result['status'],
    'record_key' => $recordKey,
    'rated' => (bool) $rated,
    'track' => $track,
]);

