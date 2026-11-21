<?php
declare(strict_types=1);

/**
 * Пересчёт рейтинга Elo по архиву race_events/race_rows.
 *
 * Старт 1200, K=24 (первые 5 рейтинговых гонок — 32). Изменение K
 * распределяется по соперникам, поэтому заезд на 6 человек не даёт
 * в 5 раз большего изменения, чем 1×1. Сход — поражение финишировавшим,
 * два схода — ничья. Тренировочные события рейтинг не меняют.
 */

const FLY_RATING_START = 1200.0;
const FLY_RATING_K = 24.0;
const FLY_RATING_PROV_K = 32.0;
const FLY_RATING_PROV_RACES = 5;
const FLY_RATING_MIN_PLAYERS = 2;

function flyRatingScore(array $a, array $b): float
{
    $af = !empty($a['failed']);
    $bf = !empty($b['failed']);
    if ($af && $bf) {
        return 0.5;
    }
    if ($af) {
        return 0.0;
    }
    if ($bf) {
        return 1.0;
    }
    $ap = (int) ($a['place'] ?? 0);
    $bp = (int) ($b['place'] ?? 0);
    if ($ap > 0 && $bp > 0) {
        return $ap < $bp ? 1.0 : ($ap > $bp ? 0.0 : 0.5);
    }
    return 0.5;
}

/** Полный пересчёт рейтинга. Вызывать внутри транзакции. */
function flyRatingRebuild(PDO $db): void
{
    $db->exec('DELETE FROM ratings');
    $db->exec('UPDATE race_rows SET rating_before = 0, rating_after = 0, rating_delta = 0');

    $events = $db->query(
        'SELECT id, finished_at FROM race_events WHERE rated = 1 ORDER BY finished_at ASC, id ASC'
    )->fetchAll();

    $state = [];
    $rowStmt = $db->prepare(
        'SELECT id, user_id, name, class_name, place, fin, time, prog, done, failed
         FROM race_rows WHERE event_id = ? AND user_id > 0 ORDER BY place ASC, id ASC'
    );
    $updRow = $db->prepare(
        'UPDATE race_rows SET rating_before = ?, rating_after = ?, rating_delta = ? WHERE id = ?'
    );

    foreach ($events as $event) {
        $rowStmt->execute([(int) $event['id']]);
        $rows = $rowStmt->fetchAll();
        if (count($rows) < FLY_RATING_MIN_PLAYERS) {
            continue;
        }

        $entries = [];
        foreach ($rows as $row) {
            $uid = (int) $row['user_id'];
            if ($uid <= 0) {
                continue;
            }
            if (!isset($state[$uid])) {
                $state[$uid] = [
                    'user_id' => $uid,
                    'name' => (string) $row['name'],
                    'class_name' => (string) $row['class_name'],
                    'rating' => FLY_RATING_START,
                    'races' => 0,
                    'wins' => 0,
                    'podiums' => 0,
                    'place_sum' => 0,
                    'last_event_at' => 0,
                ];
            }
            if ((string) $row['name'] !== '') {
                $state[$uid]['name'] = (string) $row['name'];
            }
            if ((string) $row['class_name'] !== '') {
                $state[$uid]['class_name'] = (string) $row['class_name'];
            }
            $entries[] = ['row' => $row, 'uid' => $uid, 'delta' => 0.0, 'before' => $state[$uid]['rating']];
        }
        $n = count($entries);
        if ($n < FLY_RATING_MIN_PLAYERS) {
            continue;
        }

        for ($i = 0; $i < $n; $i++) {
            for ($j = $i + 1; $j < $n; $j++) {
                $a = $entries[$i];
                $b = $entries[$j];
                $ra = $state[$a['uid']]['rating'];
                $rb = $state[$b['uid']]['rating'];
                $expectedA = 1.0 / (1.0 + pow(10.0, ($rb - $ra) / 400.0));
                $scoreA = flyRatingScore($a['row'], $b['row']);
                $kA = $state[$a['uid']]['races'] < FLY_RATING_PROV_RACES ? FLY_RATING_PROV_K : FLY_RATING_K;
                $kB = $state[$b['uid']]['races'] < FLY_RATING_PROV_RACES ? FLY_RATING_PROV_K : FLY_RATING_K;
                $entries[$i]['delta'] += ($kA / ($n - 1)) * ($scoreA - $expectedA);
                $entries[$j]['delta'] += ($kB / ($n - 1)) * ((1.0 - $scoreA) - (1.0 - $expectedA));
            }
        }

        foreach ($entries as $entry) {
            $uid = $entry['uid'];
            $state[$uid]['rating'] = round($state[$uid]['rating'] + $entry['delta'], 1);
            $state[$uid]['races'] += 1;
            $place = (int) $entry['row']['place'];
            if (empty($entry['row']['failed']) && $place > 0) {
                $state[$uid]['place_sum'] += $place;
                if ($place === 1) {
                    $state[$uid]['wins'] += 1;
                }
                if ($place <= 3) {
                    $state[$uid]['podiums'] += 1;
                }
            }
            $state[$uid]['last_event_at'] = max(
                (int) $state[$uid]['last_event_at'],
                (int) $event['finished_at']
            );
            $updRow->execute([
                round($entry['before'], 2),
                round($state[$uid]['rating'], 2),
                round($entry['delta'], 2),
                (int) $entry['row']['id'],
            ]);
        }
    }

    $now = time();
    $ins = $db->prepare(
        'INSERT INTO ratings (user_id, name, class_name, rating, races, wins, podiums,
            place_sum, last_event_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
            name = excluded.name,
            class_name = excluded.class_name,
            rating = excluded.rating,
            races = excluded.races,
            wins = excluded.wins,
            podiums = excluded.podiums,
            place_sum = excluded.place_sum,
            last_event_at = excluded.last_event_at,
            updated_at = excluded.updated_at'
    );
    foreach ($state as $rec) {
        $ins->execute([
            (int) $rec['user_id'],
            (string) $rec['name'],
            (string) $rec['class_name'],
            round((float) $rec['rating'], 1),
            (int) $rec['races'],
            (int) $rec['wins'],
            (int) $rec['podiums'],
            (int) $rec['place_sum'],
            (int) $rec['last_event_at'],
            $now,
        ]);
    }
}

function flyRatingLeaderboard(PDO $db, int $limit = 50): array
{
    $limit = max(1, min(200, $limit));
    $stmt = $db->prepare(
        'SELECT user_id, name, class_name, rating, races, wins, podiums,
                place_sum, last_event_at
         FROM ratings ORDER BY rating DESC, races DESC, wins DESC, name ASC LIMIT ?'
    );
    $stmt->bindValue(1, $limit, PDO::PARAM_INT);
    $stmt->execute();
    $out = [];
    $rank = 0;
    foreach ($stmt->fetchAll() as $row) {
        $rank++;
        $races = (int) $row['races'];
        $out[] = [
            'rank' => $rank,
            'user_id' => (int) $row['user_id'],
            'name' => (string) $row['name'],
            'class_name' => (string) $row['class_name'],
            'rating' => (int) round((float) $row['rating']),
            'races' => $races,
            'wins' => (int) $row['wins'],
            'podiums' => (int) $row['podiums'],
            'avg_place' => $races ? round(((int) $row['place_sum']) / $races, 1) : 0,
            'provisional' => $races < FLY_RATING_PROV_RACES,
            'last_event_at' => (int) $row['last_event_at'],
        ];
    }
    return $out;
}

function flyRatingForUser(PDO $db, int $userId): ?array
{
    $stmt = $db->prepare(
        'SELECT user_id, name, class_name, rating, races, wins, podiums, place_sum, last_event_at
         FROM ratings WHERE user_id = ?'
    );
    $stmt->execute([$userId]);
    $row = $stmt->fetch();
    if (!$row) {
        return null;
    }
    $races = (int) $row['races'];
    return [
        'user_id' => (int) $row['user_id'],
        'name' => (string) $row['name'],
        'class_name' => (string) $row['class_name'],
        'rating' => (int) round((float) $row['rating']),
        'races' => $races,
        'wins' => (int) $row['wins'],
        'podiums' => (int) $row['podiums'],
        'avg_place' => $races ? round(((int) $row['place_sum']) / $races, 1) : 0,
        'provisional' => $races < FLY_RATING_PROV_RACES,
        'last_event_at' => (int) $row['last_event_at'],
    ];
}
