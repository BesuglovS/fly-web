<?php
declare(strict_types=1);

$appDir = require __DIR__ . '/_bootstrap.php';
if ($appDir === null) {
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['error' => 'Server not configured']);
    exit;
}

require $appDir . '/api/create.php';
