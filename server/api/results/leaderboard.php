<?php
declare(strict_types=1);

/**
 * GET /api/results/leaderboard.php
 * Рейтинг Elo. Доступен только после входа через auth-web.
 */

require_once __DIR__ . '/../../lib/http.php';
require_once __DIR__ . '/../../lib/Db.php';
require_once __DIR__ . '/../../lib/rating.php';
require_once __DIR__ . '/../../lib/results.php';

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    http_response_code(204);
    exit;
}
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') {
    flyFail('Method not allowed', 405);
}
$user = flyRequireUser();
$db = FlyDb::getInstance();
$limit = (int) ($_GET['limit'] ?? 50);

flyJson([
    'ok' => true,
    'updatedAt' => time(),
    'leaderboard' => flyRatingLeaderboard($db, $limit),
    'me' => flyRatingForUser($db, (int) $user['id']),
    'isAdmin' => flyIsAdmin($user),
    'provisionalRaces' => FLY_RATING_PROV_RACES,
]);

