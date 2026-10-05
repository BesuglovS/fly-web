<?php
declare(strict_types=1);

/**
 * Поиск каталога приложения сигналинга.
 *
 * Код приложения (server/) деплоится РЯДОМ с webroot — в ../app
 * (на проде /var/www/fly.nayanovaacademy.ru/app), т.е. вне досягаемости nginx.
 * Локально из репозитория используется исходный server/. Возвращает путь
 * к каталогу приложения или null.
 */

$env = getenv('FLY_APP_DIR');

$candidates = [
    is_string($env) && $env !== '' ? rtrim($env, "/\\") : null,
    __DIR__ . '/../../../app',     // прод: ../app от public/
    __DIR__ . '/../../../server',  // локально: server/ в репозитории
];

foreach ($candidates as $dir) {
    if ($dir !== null && is_file($dir . '/api/find.php')) {
        return $dir;
    }
}

return null;
