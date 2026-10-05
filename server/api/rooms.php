<?php
declare(strict_types=1);

/**
 * POST /api/signal/rooms.php
 *
 * Список открытых сетевых игр (комнат) для выбора конкретной.
 * Ответ: { rooms:[{id,title,map,params,started,host_name,count,max,created_at}],
 *          max, maps }
 */

require_once __DIR__ . '/../lib/http.php';

flyMethod();
$user = flyRequireUser();
$db = FlyDb::getInstance();
$now = time();
$isAdmin = flyIsAdmin($user);

FlyDb::cleanup($db, $now);
flyRateLimit($db, (int) $user['id']);

$rooms = FlyDb::immediateTxn($db, function (PDO $db): array {
    // Хост мог «протухнуть» — переназначим, чтобы список был корректным.
    // ids забираем заранее: правим rooms, пока итерируем ту же таблицу.
    $roomIds = $db->query('SELECT id FROM rooms')->fetchAll(PDO::FETCH_COLUMN);
    foreach ($roomIds as $rid) {
        flyEnsureHost($db, (int) $rid);
    }

    $stmt = $db->prepare(
        'SELECT r.id, r.title, r.map, r.params, r.host_user_id, r.started, r.max, r.created_at,
                (SELECT COUNT(*) FROM players p WHERE p.room_id = r.id) AS cnt
           FROM rooms r
          ORDER BY r.created_at DESC
          LIMIT 50'
    );
    $stmt->execute();

    $nameStmt = $db->prepare('SELECT name FROM players WHERE user_id = ?');
    $out = [];
    foreach ($stmt->fetchAll() as $row) {
        $cnt = (int) $row['cnt'];
        if ($cnt <= 0) {
            continue;
        }
        $nameStmt->execute([(int) $row['host_user_id']]);
        $params = json_decode((string) $row['params'], true);
        $out[] = [
            'id' => (int) $row['id'],
            'title' => (string) $row['title'],
            'map' => (string) $row['map'],
            'params' => is_array($params) ? $params : ['mode' => 'angle'],
            'started' => (int) $row['started'] === 1,
            'host_name' => (string) ($nameStmt->fetchColumn() ?: ''),
            'count' => $cnt,
            'max' => (int) $row['max'],
            'created_at' => (int) $row['created_at'],
        ];
    }
    return $out;
});

flyJson([
    'rooms' => $rooms,
    'max' => $isAdmin ? FLY_MAX_PLAYERS : FLY_PUBLIC_MAX,
    'maxOptions' => flyAllowedMaxOptions($isAdmin),
    'isAdmin' => $isAdmin,
    'maps' => FLY_MAPS,
]);
