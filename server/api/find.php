<?php
declare(strict_types=1);

/**
 * POST /api/signal/find.php
 *
 * Быстрая игра: подключиться к самой старой незаполненной комнате, иначе
 * создать новую (можно летать одному). Для выбора конкретной игры — rooms/join.
 */

require_once __DIR__ . '/../lib/http.php';

flyMethod();
$user = flyRequireUser();
$db = FlyDb::getInstance();
$now = time();

FlyDb::cleanup($db, $now);

$userId = (int) $user['id'];
$name = flyName($user);
$isAdmin = flyIsAdmin($user);
flyRateLimit($db, $userId);

$roomId = FlyDb::immediateTxn($db, function (PDO $db) use ($userId, $name, $now): int {
    $cur = $db->prepare('SELECT room_id FROM players WHERE user_id = ?');
    $cur->execute([$userId]);
    $curRoom = $cur->fetchColumn();
    if ($curRoom !== false) {
        return (int) $curRoom;
    }

    $stmt = $db->prepare(
        'SELECT r.id
           FROM rooms r
           LEFT JOIN players p ON p.room_id = r.id
          GROUP BY r.id
         HAVING COUNT(p.user_id) < r.max
          ORDER BY r.created_at ASC, r.id ASC
          LIMIT 1'
    );
    $stmt->execute();
    $row = $stmt->fetch();
    if ($row) {
        flyUpsertPlayer($db, $userId, $name, (int) $row['id'], $now);
        return (int) $row['id'];
    }
    return flyCreateRoom($db, $userId, $name, '', $now);
});

flyJson(flySnapshot($db, $roomId, $userId, $name, $isAdmin));
