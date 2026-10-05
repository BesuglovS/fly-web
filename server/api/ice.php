<?php
declare(strict_types=1);

/**
 * POST /api/signal/ice.php
 *
 * ICE-серверы для WebRTC: STUN + TURN с временными креденшелами
 * (coturn REST-авторизация, use-auth-secret). Секрет лежит вне webroot
 * (`data/turn_secret`), клиенту не отдаётся.
 *
 * Ответ: { iceServers:[{urls, username?, credential?}] }
 */

require_once __DIR__ . '/../lib/http.php';

flyMethod();
$user = flyRequireUser();
$db = FlyDb::getInstance();
$now = time();

flyRateLimit($db, (int) $user['id']);

$ice = [
    ['urls' => ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302']],
    ['urls' => 'stun:stun.cloudflare.com:3478'],
];

$secretFile = FlyDb::dataDir() . DIRECTORY_SEPARATOR . 'turn_secret';
$secret = is_file($secretFile) ? trim((string) file_get_contents($secretFile)) : '';
if ($secret !== '') {
    $ttl = 3600;
    $username = ($now + $ttl) . ':' . (int) $user['id'];
    $credential = base64_encode(hash_hmac('sha1', $username, $secret, true));
    foreach ([
        'turn:fly.nayanovaacademy.ru:3478?transport=udp',
        'turn:fly.nayanovaacademy.ru:3478?transport=tcp',
    ] as $url) {
        $ice[] = ['urls' => $url, 'username' => $username, 'credential' => $credential];
    }
}

flyJson(['iceServers' => $ice]);
