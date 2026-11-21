<?php
declare(strict_types=1);

/**
 * Bootstrap для /api/results/*: находит server/ (вне webroot) и возвращает
 * каталог приложения. Локально в репозитории это ../../../server.
 */

$env = getenv('FLY_APP_DIR');

$candidates = [
    is_string($env) && $env !== '' ? rtrim($env, "/\\") : null,
    __DIR__ . '/../../../app',
    __DIR__ . '/../../../server',
];

foreach ($candidates as $dir) {
    if ($dir !== null && is_file($dir . '/api/results/ingest.php')) {
        return $dir;
    }
}

return null;
