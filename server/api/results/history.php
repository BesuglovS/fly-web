<?php
declare(strict_types=1);

/**
 * GET /api/results/history.php
 * Последние заезды и турниры. Доступно после входа через auth-web.
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
flyRequireUser();
$db = FlyDb::getInstance();
$limit = (int) ($_GET['limit'] ?? 30);

flyJson([
    'ok' => true,
    'updatedAt' => time(),
    'events' => flyResultsHistory($db, $limit),
]);

