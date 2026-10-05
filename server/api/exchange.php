<?php
declare(strict_types=1);

/**
 * POST /api/signal/exchange.php
 *
 * Один запрос = heartbeat присутствия + состав комнаты + обмен SDP.
 * Тело: { room_id, send?:[{to,type:'offer'|'answer',sdp}], control?:{...} }.
 * `control` применяется, только если вызывающий — хост комнаты:
 *   { map?, mode?, started?, title? }.
 * Ответ: { room, self, participants, signals, max, maps }.
 */

require_once __DIR__ . '/../lib/http.php';

flyMethod();
$user = flyRequireUser();
$body = flyBody();
$db = FlyDb::getInstance();
$now = time();

$userId = (int) $user['id'];
$name = flyName($user);
$isAdmin = flyIsAdmin($user);
$roomId = isset($body['room_id']) ? (int) $body['room_id'] : 0;
if ($roomId <= 0) {
    flyFail('room_id required', 400);
}

$stmt = $db->prepare('SELECT room_id FROM players WHERE user_id = ?');
$stmt->execute([$userId]);
if ((int) $stmt->fetchColumn() !== $roomId) {
    flyFail('Not in room', 403);
}

FlyDb::cleanup($db, $now);
flyRateLimit($db, $userId);

$send = isset($body['send']) && is_array($body['send']) ? $body['send'] : [];
if (count($send) > FLY_MAX_PLAYERS) {
    $send = array_slice($send, 0, FLY_MAX_PLAYERS);
}
$control = isset($body['control']) && is_array($body['control']) ? $body['control'] : null;

$signals = FlyDb::immediateTxn($db, function (PDO $db) use ($send, $roomId, $userId, $now, $control, $isAdmin): array {
    // ─── управление игрой хостом ───
    if ($control !== null) {
        flyApplyControl($db, $roomId, $userId, $control, $now, $isAdmin);
    }

    // ─── исходящие SDP ───
    foreach ($send as $item) {
        if (!is_array($item)) {
            continue;
        }
        $to = isset($item['to']) ? (int) $item['to'] : 0;
        $type = isset($item['type']) ? (string) $item['type'] : '';
        $sdp = isset($item['sdp']) ? (string) $item['sdp'] : '';

        if ($to <= 0 || $to === $userId) {
            continue;
        }
        if ($type !== 'offer' && $type !== 'answer') {
            continue;
        }
        if ($sdp === '' || strlen($sdp) > FLY_SDP_MAX_BYTES) {
            continue;
        }

        $chk = $db->prepare('SELECT 1 FROM players WHERE user_id = ? AND room_id = ?');
        $chk->execute([$to, $roomId]);
        if (!$chk->fetchColumn()) {
            continue;
        }

        $db->prepare('DELETE FROM signals WHERE room_id = ? AND from_user_id = ? AND to_user_id = ?')
            ->execute([$roomId, $userId, $to]);
        $db->prepare(
            'INSERT INTO signals (room_id, from_user_id, to_user_id, sdp_type, sdp, created_at)
             VALUES (?, ?, ?, ?, ?, ?)'
        )->execute([$roomId, $userId, $to, $type, $sdp, $now]);
    }

    $db->prepare('UPDATE players SET seen_at = ? WHERE user_id = ?')->execute([$now, $userId]);
    flyEnsureHost($db, $roomId);

    $stmt = $db->prepare(
        'SELECT id, from_user_id, sdp_type, sdp
           FROM signals
          WHERE room_id = ? AND to_user_id = ?
          ORDER BY id ASC'
    );
    $stmt->execute([$roomId, $userId]);
    $rows = $stmt->fetchAll();

    if ($rows) {
        $ids = array_map(static fn(array $r): int => (int) $r['id'], $rows);
        $placeholders = implode(',', array_fill(0, count($ids), '?'));
        $db->prepare("DELETE FROM signals WHERE id IN ($placeholders)")->execute($ids);
    }

    return array_map(static fn(array $r): array => [
        'from_user_id' => (int) $r['from_user_id'],
        'type' => (string) $r['sdp_type'],
        'sdp' => (string) $r['sdp'],
    ], $rows);
});

$snapshot = flySnapshot($db, $roomId, $userId, $name, $isAdmin);
$snapshot['signals'] = $signals;
flyJson($snapshot);
