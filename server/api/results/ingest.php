<?php
declare(strict_types=1);

/**
 * POST /api/results/ingest.php
 *
 * Пакетная синхронизация архива с LAN-релея. Авторизация — общий токен
 * (data/results_token или FLY_RESULTS_TOKEN), не пользовательская кука.
 * Идемпотентность по record_key; Elo пересчитывается после вставки.
 */

require_once __DIR__ . '/../../lib/http.php';
require_once __DIR__ . '/../../lib/Db.php';
require_once __DIR__ . '/../../lib/rating.php';
require_once __DIR__ . '/../../lib/results.php';

flyMethod();
flyResultsRequireToken();

$len = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
if ($len > 2 * 1024 * 1024) {
    flyFail('Payload too large', 413);
}
$body = flyBody();
$events = $body['events'] ?? null;
if (!is_array($events) || !$events) {
    flyFail('events required', 400);
}
if (count($events) > 100) {
    flyFail('Too many events', 413);
}

$db = FlyDb::getInstance();
$accepted = [];
$duplicates = [];
$errors = [];

FlyDb::immediateTxn($db, function (PDO $db) use ($events, &$accepted, &$duplicates, &$errors): void {
    foreach ($events as $raw) {
        if (!is_array($raw)) {
            continue;
        }
        $key = flyResultsSanitizeKey((string) ($raw['key'] ?? ''));
        $norm = flyResultsNormalizeEvent($raw);
        if ($norm['event'] === null) {
            $errors[] = ['key' => $key, 'error' => $norm['error']];
            continue;
        }
        $res = flyResultsInsertEvent($db, $norm['event']);
        if ($res['status'] === 'accepted') {
            $accepted[] = $norm['event']['key'];
        } else {
            $duplicates[] = $norm['event']['key'];
        }
    }
    if ($accepted) {
        flyRatingRebuild($db);
    }
});

flyJson([
    'ok' => true,
    'accepted' => $accepted,
    'duplicates' => $duplicates,
    'errors' => $errors,
    'updatedAt' => time(),
]);

