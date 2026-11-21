<?php
declare(strict_types=1);

/**
 * Общие помощники архива результатов: токен синхронизации, валидация
 * событий, вставка с защитой от дублей. Elo пересчитывается в rating.php.
 */

function flyResultsToken(): string
{
    $token = getenv('FLY_RESULTS_TOKEN');
    if (is_string($token) && trim($token) !== '') {
        return trim($token);
    }
    $file = FlyDb::dataDir() . DIRECTORY_SEPARATOR . 'results_token';
    if (is_file($file)) {
        $text = @file_get_contents($file);
        if (is_string($text) && trim($text) !== '') {
            return trim($text);
        }
    }
    return '';
}

function flyResultsRequireToken(): void
{
    $expected = flyResultsToken();
    if ($expected === '') {
        flyFail('Результаты не настроены на сервере', 503);
    }
    $header = (string) ($_SERVER['HTTP_AUTHORIZATION'] ?? '');
    $given = '';
    if (stripos($header, 'Bearer ') === 0) {
        $given = trim(substr($header, 7));
    } elseif (isset($_SERVER['HTTP_X_FLY_SYNC_TOKEN'])) {
        $given = trim((string) $_SERVER['HTTP_X_FLY_SYNC_TOKEN']);
    }
    if ($given === '' || !hash_equals($expected, $given)) {
        flyFail('Forbidden', 403);
    }
}

function flyResultsBool($v): bool
{
    return !empty($v);
}

function flyResultsInt($v, int $min, int $max, int $default = 0): int
{
    $n = (int) $v;
    if ($n < $min || $n > $max) {
        return $default;
    }
    return $n;
}

function flyResultsFloat($v, ?float $default = null): ?float
{
    if ($v === null || $v === '') {
        return $default;
    }
    $n = (float) $v;
    if (!is_finite($n)) {
        return $default;
    }
    return $n;
}

function flyResultsSanitizeKey(string $key): string
{
    $key = preg_replace('/[^A-Za-z0-9:_\-.]/u', '', $key) ?? '';
    return mb_substr($key, 0, 160);
}

/**
 * Нормализация события из синхронизации релея.
 * @return array{event:?array,error:string}
 */
function flyResultsNormalizeEvent(array $raw): array
{
    $key = flyResultsSanitizeKey((string) ($raw['key'] ?? ''));
    if ($key === '') {
        return ['event' => null, 'error' => 'empty key'];
    }
    $source = (string) ($raw['source'] ?? 'comp');
    if ($source !== 'comp') {
        return ['event' => null, 'error' => 'unsupported source'];
    }
    if (!is_array($raw['rows'] ?? null) || count($raw['rows']) < 1 || count($raw['rows']) > 64) {
        return ['event' => null, 'error' => 'bad rows'];
    }
    $track = (string) ($raw['track'] ?? '');
    if (!in_array($track, FLY_RACES, true)) {
        return ['event' => null, 'error' => 'bad track'];
    }
    $mode = (string) ($raw['mode'] ?? 'angle') === 'acro' ? 'acro' : 'angle';
    $format = in_array((string) ($raw['format'] ?? 'heats'), ['heats', 'olympic', 'points'], true)
        ? (string) $raw['format'] : 'heats';
    $rows = [];
    $seen = [];
    foreach ($raw['rows'] as $r) {
        if (!is_array($r)) {
            continue;
        }
        $uid = (int) ($r['user_id'] ?? $r['sid'] ?? 0);
        if ($uid <= 0 || isset($seen[$uid])) {
            continue;
        }
        $seen[$uid] = true;
        $rows[] = [
            'user_id' => $uid,
            'name' => mb_substr(trim((string) ($r['name'] ?? '')), 0, FLY_NAME_MAX),
            'class_name' => mb_substr(trim((string) ($r['class_name'] ?? $r['className'] ?? '')), 0, 60),
            'place' => flyResultsInt($r['place'] ?? 0, 1, 64, 0),
            'fin' => flyResultsFloat($r['fin'] ?? null, null),
            'time' => max(0.0, (float) ($r['time'] ?? 0)),
            'prog' => flyResultsInt($r['prog'] ?? 0, 0, 1000, 0),
            'done' => flyResultsBool($r['done'] ?? false) ? 1 : 0,
            'failed' => flyResultsBool($r['failed'] ?? false) ? 1 : 0,
            'points' => flyResultsInt($r['points'] ?? 0, 0, 100, 0),
        ];
    }
    if (!$rows) {
        return ['event' => null, 'error' => 'no valid rows'];
    }
    $finishedAt = (int) ($raw['finishedAt'] ?? time());
    if ($finishedAt > 4000000000) {
        $finishedAt = (int) floor($finishedAt / 1000);
    }
    return ['event' => [
        'key' => $key,
        'source' => 'comp',
        'comp_id' => mb_substr((string) ($raw['compId'] ?? ''), 0, 80),
        'room_id' => 0,
        'title' => mb_substr(trim((string) ($raw['title'] ?? '')), 0, 80),
        'class_id' => mb_substr(trim((string) ($raw['classId'] ?? '')), 0, 40),
        'class_name' => mb_substr(trim((string) ($raw['className'] ?? '')), 0, 60),
        'track' => $track,
        'mode' => $mode,
        'format' => $format,
        'rated' => flyResultsBool($raw['rated'] ?? false) ? 1 : 0,
        'heat_id' => flyResultsInt($raw['heatId'] ?? 0, 0, 1000000000, 0),
        'round' => flyResultsInt($raw['round'] ?? 0, 0, 1000, 0),
        'label' => mb_substr(trim((string) ($raw['label'] ?? '')), 0, 40),
        'finished_at' => flyResultsInt($finishedAt, 0, 4000000000, time()),
        'reason' => mb_substr(trim((string) ($raw['reason'] ?? '')), 0, 40),
        'rows' => $rows,
    ], 'error' => ''];
}

/** @return array{status:string,event_id:int} */
function flyResultsInsertEvent(PDO $db, array $event): array
{
    $chk = $db->prepare('SELECT id FROM race_events WHERE record_key = ?');
    $chk->execute([$event['key']]);
    $existing = $chk->fetchColumn();
    if ($existing !== false) {
        return ['status' => 'duplicate', 'event_id' => (int) $existing];
    }
    $db->prepare(
        'INSERT INTO race_events (record_key, source, room_id, comp_id, title, class_id,
            class_name, track, mode, format, rated, finished_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )->execute([
        $event['key'],
        $event['source'],
        (int) ($event['room_id'] ?? 0),
        $event['comp_id'],
        $event['title'],
        $event['class_id'],
        $event['class_name'],
        $event['track'],
        $event['mode'],
        $event['format'],
        (int) $event['rated'],
        (int) $event['finished_at'],
        time(),
    ]);
    $eventId = (int) $db->lastInsertId();
    $ins = $db->prepare(
        'INSERT OR IGNORE INTO race_rows (event_id, user_id, name, class_name, place,
            fin, time, prog, done, failed, points)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    foreach ($event['rows'] as $row) {
        $ins->execute([
            $eventId,
            (int) $row['user_id'],
            (string) $row['name'],
            (string) $row['class_name'],
            (int) $row['place'],
            $row['fin'] === null ? null : (float) $row['fin'],
            (float) $row['time'],
            (int) $row['prog'],
            (int) $row['done'],
            (int) $row['failed'],
            (int) $row['points'],
        ]);
    }
    return ['status' => 'accepted', 'event_id' => $eventId];
}

function flyResultsEventRows(PDO $db, int $eventId): array
{
    $rowStmt = $db->prepare(
        'SELECT user_id, name, class_name, place, fin, time, prog, done, failed,
                points, rating_before, rating_after, rating_delta
         FROM race_rows WHERE event_id = ? ORDER BY place ASC, id ASC'
    );
    $rowStmt->execute([$eventId]);
    $rows = [];
    foreach ($rowStmt->fetchAll() as $r) {
        $rows[] = [
            'user_id' => (int) $r['user_id'],
            'name' => (string) $r['name'],
            'class_name' => (string) $r['class_name'],
            'place' => (int) $r['place'],
            'fin' => $r['fin'] === null ? null : (float) $r['fin'],
            'time' => (float) $r['time'],
            'prog' => (int) $r['prog'],
            'done' => (bool) $r['done'],
            'failed' => (bool) $r['failed'],
            'points' => (int) $r['points'],
            'rating_before' => (float) $r['rating_before'],
            'rating_after' => (float) $r['rating_after'],
            'rating_delta' => (float) $r['rating_delta'],
        ];
    }
    return $rows;
}

/** Полная история с фильтрами и пагинацией (только администратор). */
function flyResultsAdminQuery(PDO $db, array $filters): array
{
    $where = [];
    $params = [];

    $class = trim((string) ($filters['class'] ?? ''));
    if ($class !== '') {
        $where[] = 'e.class_name = :class';
        $params[':class'] = $class;
    }
    $track = trim((string) ($filters['track'] ?? ''));
    if ($track !== '' && in_array($track, FLY_RACES, true)) {
        $where[] = 'e.track = :track';
        $params[':track'] = $track;
    }
    $rated = (string) ($filters['rated'] ?? '');
    if ($rated === '0' || $rated === '1') {
        $where[] = 'e.rated = :rated';
        $params[':rated'] = (int) $rated;
    }
    $source = trim((string) ($filters['source'] ?? ''));
    if (in_array($source, ['comp', 'net'], true)) {
        $where[] = 'e.source = :source';
        $params[':source'] = $source;
    }
    $from = trim((string) ($filters['from'] ?? ''));
    if ($from !== '') {
        $ts = strtotime($from . ' 00:00:00');
        if ($ts !== false) {
            $where[] = 'e.finished_at >= :from';
            $params[':from'] = (int) $ts;
        }
    }
    $to = trim((string) ($filters['to'] ?? ''));
    if ($to !== '') {
        $ts = strtotime($to . ' 23:59:59');
        if ($ts !== false) {
            $where[] = 'e.finished_at <= :to';
            $params[':to'] = (int) $ts;
        }
    }
    $q = trim((string) ($filters['q'] ?? ''));
    if ($q !== '') {
        $like = '%' . str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $q) . '%';
        $where[] = 'EXISTS (SELECT 1 FROM race_rows rq WHERE rq.event_id = e.id AND rq.name LIKE :q ESCAPE \'\\\')';
        $params[':q'] = $like;
    }

    $whereSql = $where ? ('WHERE ' . implode(' AND ', $where)) : '';
    $countStmt = $db->prepare('SELECT COUNT(*) FROM race_events e ' . $whereSql);
    foreach ($params as $key => $value) {
        $countStmt->bindValue($key, $value, is_int($value) ? PDO::PARAM_INT : PDO::PARAM_STR);
    }
    $countStmt->execute();
    $total = (int) $countStmt->fetchColumn();

    $per = (int) ($filters['per'] ?? 25);
    if (!in_array($per, [25, 50, 100], true)) {
        $per = 25;
    }
    $pages = max(1, (int) ceil($total / $per));
    $page = max(1, min($pages, (int) ($filters['page'] ?? 1)));
    $offset = ($page - 1) * $per;

    $stmt = $db->prepare(
        'SELECT e.* FROM race_events e ' . $whereSql .
        ' ORDER BY e.finished_at DESC, e.id DESC LIMIT :limit OFFSET :offset'
    );
    foreach ($params as $key => $value) {
        $stmt->bindValue($key, $value, is_int($value) ? PDO::PARAM_INT : PDO::PARAM_STR);
    }
    $stmt->bindValue(':limit', $per, PDO::PARAM_INT);
    $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
    $stmt->execute();

    $events = [];
    foreach ($stmt->fetchAll() as $e) {
        $events[] = [
            'key' => (string) $e['record_key'],
            'source' => (string) $e['source'],
            'room_id' => (int) $e['room_id'],
            'comp_id' => (string) $e['comp_id'],
            'title' => (string) $e['title'],
            'class_id' => (string) $e['class_id'],
            'class_name' => (string) $e['class_name'],
            'track' => (string) $e['track'],
            'mode' => (string) $e['mode'],
            'format' => (string) $e['format'],
            'rated' => (bool) $e['rated'],
            'finished_at' => (int) $e['finished_at'],
            'rows' => flyResultsEventRows($db, (int) $e['id']),
        ];
    }

    $classes = [];
    foreach ($db->query("SELECT DISTINCT class_name FROM race_events WHERE class_name <> '' ORDER BY class_name")->fetchAll(PDO::FETCH_COLUMN) as $c) {
        $classes[] = (string) $c;
    }
    $tracks = [];
    foreach ($db->query("SELECT DISTINCT track FROM race_events WHERE track <> '' ORDER BY track")->fetchAll(PDO::FETCH_COLUMN) as $t) {
        $tracks[] = (string) $t;
    }
    $sources = [];
    foreach ($db->query("SELECT DISTINCT source FROM race_events ORDER BY source")->fetchAll(PDO::FETCH_COLUMN) as $s) {
        $sources[] = (string) $s;
    }

    return [
        'total' => $total,
        'page' => $page,
        'per' => $per,
        'pages' => $pages,
        'events' => $events,
        'facets' => [
            'classes' => $classes,
            'tracks' => $tracks,
            'sources' => $sources,
        ],
    ];
}

function flyResultsHistory(PDO $db, int $limit = 30): array
{
    $limit = max(1, min(100, $limit));
    $stmt = $db->prepare(
        'SELECT id, record_key, source, room_id, comp_id, title, class_id, class_name,
                track, mode, format, rated, finished_at
         FROM race_events ORDER BY finished_at DESC, id DESC LIMIT ?'
    );
    $stmt->bindValue(1, $limit, PDO::PARAM_INT);
    $stmt->execute();
    $events = $stmt->fetchAll();
    $rowStmt = $db->prepare(
        'SELECT user_id, name, class_name, place, fin, time, prog, done, failed,
                points, rating_before, rating_after, rating_delta
         FROM race_rows WHERE event_id = ? ORDER BY place ASC, id ASC'
    );
    $out = [];
    foreach ($events as $e) {
        $rowStmt->execute([(int) $e['id']]);
        $rows = [];
        foreach ($rowStmt->fetchAll() as $r) {
            $rows[] = [
                'user_id' => (int) $r['user_id'],
                'name' => (string) $r['name'],
                'class_name' => (string) $r['class_name'],
                'place' => (int) $r['place'],
                'fin' => $r['fin'] === null ? null : (float) $r['fin'],
                'time' => (float) $r['time'],
                'prog' => (int) $r['prog'],
                'done' => (bool) $r['done'],
                'failed' => (bool) $r['failed'],
                'points' => (int) $r['points'],
                'rating_before' => (float) $r['rating_before'],
                'rating_after' => (float) $r['rating_after'],
                'rating_delta' => (float) $r['rating_delta'],
            ];
        }
        $out[] = [
            'key' => (string) $e['record_key'],
            'source' => (string) $e['source'],
            'room_id' => (int) $e['room_id'],
            'comp_id' => (string) $e['comp_id'],
            'title' => (string) $e['title'],
            'class_id' => (string) $e['class_id'],
            'class_name' => (string) $e['class_name'],
            'track' => (string) $e['track'],
            'mode' => (string) $e['mode'],
            'format' => (string) $e['format'],
            'rated' => (bool) $e['rated'],
            'finished_at' => (int) $e['finished_at'],
            'rows' => $rows,
        ];
    }
    return $out;
}
