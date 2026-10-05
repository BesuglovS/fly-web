<?php
declare(strict_types=1);

/**
 * POST /api/signal/leave.php
 *
 * Выход из игры. Тело: { room_id } (необязательно — тогда из всех комнат).
 * Хост переназначается, пустая комната удаляется. Ответ: { ok:true }
 */

require_once __DIR__ . '/../lib/http.php';

flyMethod();
$user = flyRequireUser();
$body = flyBody();
$db = FlyDb::getInstance();
$now = time();

$userId = (int) $user['id'];
$roomId = isset($body['room_id']) ? (int) $body['room_id'] : 0;

FlyDb::immediateTxn($db, function (PDO $db) use ($userId, $roomId, $now): void {
    if ($roomId > 0) {
        flyRemovePlayer($db, $userId, $roomId, $now);
        return;
    }
    $stmt = $db->prepare('SELECT room_id FROM players WHERE user_id = ?');
    $stmt->execute([$userId]);
    foreach ($stmt->fetchAll() as $row) {
        flyRemovePlayer($db, $userId, (int) $row['room_id'], $now);
    }
});

FlyDb::cleanup($db, $now);
flyJson(['ok' => true]);
