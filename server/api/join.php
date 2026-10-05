<?php
declare(strict_types=1);

/**
 * POST /api/signal/join.php
 *
 * Подключиться к конкретной сетевой игре. Тело: { room_id }.
 * Если игрок уже в другой комнате — выходит из неё. Ответ — снимок комнаты.
 */

require_once __DIR__ . '/../lib/http.php';

flyMethod();
$user = flyRequireUser();
$body = flyBody();
$db = FlyDb::getInstance();
$now = time();

$userId = (int) $user['id'];
$name = flyName($user);
$isAdmin = flyIsAdmin($user);
$roomId = isset($body['room_id']) ? (int) $body['room_id'] : 0;
if ($roomId <= 0) {
    flyFail('room_id required', 400);
}

FlyDb::cleanup($db, $now);
flyRateLimit($db, $userId);

$res = FlyDb::immediateTxn($db, function (PDO $db) use ($userId, $name, $roomId, $now): array {
    return flyJoinRoom($db, $userId, $name, $roomId, $now);
});

if (!$res['ok']) {
    flyFail($res['error'] ?? 'Не удалось войти', $res['code'] ?? 400);
}

flyJson(flySnapshot($db, (int) $res['room_id'], $userId, $name, $isAdmin));
