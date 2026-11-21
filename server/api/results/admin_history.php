<?php
declare(strict_types=1);

/**
 * GET /api/results/admin_history.php
 * Полная история результатов с фильтрами и пагинацией.
 * Доступ только администратору auth-web.
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
if (!flyIsAdmin($user)) {
    flyFail('Полная история доступна только администратору', 403);
}
$db = FlyDb::getInstance();

$filters = [
    'class' => (string) ($_GET['class'] ?? ''),
    'track' => (string) ($_GET['track'] ?? ''),
    'rated' => (string) ($_GET['rated'] ?? ''),
    'source' => (string) ($_GET['source'] ?? ''),
    'from' => (string) ($_GET['from'] ?? ''),
    'to' => (string) ($_GET['to'] ?? ''),
    'q' => (string) ($_GET['q'] ?? ''),
    'page' => (int) ($_GET['page'] ?? 1),
    'per' => (int) ($_GET['per'] ?? 25),
];

flyJson(array_merge([
    'ok' => true,
    'updatedAt' => time(),
], flyResultsAdminQuery($db, $filters)));
