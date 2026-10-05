<?php
declare(strict_types=1);

/**
 * POST /api/signal/create.php
 *
 * Создать новую сетевую игру. Создатель становится хостом (он выбирает
 * карту, размер, параметры и запускает игру). Тело: { title?, max? }.
 * Ответ — снимок комнаты (как у exchange, без signals).
 */

require_once __DIR__ . '/../lib/http.php';

flyMethod();
$user = flyRequireUser();
$body = flyBody();
$db = FlyDb::getInstance();
$now = time();

FlyDb::cleanup($db, $now);
flyRateLimit($db, (int) $user['id']);

$userId = (int) $user['id'];
$name = flyName($user);
$isAdmin = flyIsAdmin($user);
$title = flySanitizeTitle(isset($body['title']) ? (string) $body['title'] : '');
// Больше FLY_PUBLIC_MAX (4) участников — только администратор.
$max = flyClampMaxForUser(flySanitizeMax($body['max'] ?? FLY_DEFAULT_MAX), $isAdmin);

$roomId = FlyDb::immediateTxn($db, function (PDO $db) use ($userId, $name, $title, $max, $now): int {
    $cur = $db->prepare('SELECT room_id FROM players WHERE user_id = ?');
    $cur->execute([$userId]);
    $curRoom = $cur->fetchColumn();
    if ($curRoom !== false) {
        flyRemovePlayer($db, $userId, (int) $curRoom, $now);
    }
    return flyCreateRoom($db, $userId, $name, $title, $now, $max);
});

flyJson(flySnapshot($db, $roomId, $userId, $name, $isAdmin));
