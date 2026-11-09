<?php
declare(strict_types=1);

/**
 * POST /api/signal/create.php
 *
 * Создать новую сетевую игру. Создатель становится хостом (он выбирает
 * карту, размер, параметры и запускает игру). Тело: { title?, max?, pair?, director? }.
 * `pair:true` — парная гонка 1×1, только для администратора: 3 слота
 * (наблюдатель-админ + 2 гонщика). `director:true` — гонка с наблюдателем:
 * 7 слотов (админ + до 6 гонщиков). Трасса задаётся через `control.race`.
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
$pair = !empty($body['pair']);
$director = !empty($body['director']);
if ($pair && $director) {
    flyFail('Выберите один режим: пара или гонка с наблюдателем', 400);
}
if (($pair || $director) && !$isAdmin) {
    flyFail('Режим наблюдателя доступен только администратору', 403);
}
// Больше FLY_PUBLIC_MAX (4) участников — только администратор.
// Парная гонка: наблюдатель-админ + 2 гонщика.
// Гонка с наблюдателем: наблюдатель-админ + до 6 гонщиков.
$max = $pair
    ? FLY_PAIR_MAX
    : ($director
        ? FLY_DIRECTOR_MAX
        : flyClampMaxForUser(flySanitizeMax($body['max'] ?? FLY_DEFAULT_MAX), $isAdmin));

$roomId = FlyDb::immediateTxn($db, function (PDO $db) use ($userId, $name, $title, $max, $now, $pair, $director): int {
    $cur = $db->prepare('SELECT room_id FROM players WHERE user_id = ?');
    $cur->execute([$userId]);
    $curRoom = $cur->fetchColumn();
    if ($curRoom !== false) {
        flyRemovePlayer($db, $userId, (int) $curRoom, $now);
    }
    return flyCreateRoom($db, $userId, $name, $title, $now, $max, $pair, $director);
});

flyJson(flySnapshot($db, $roomId, $userId, $name, $isAdmin));
