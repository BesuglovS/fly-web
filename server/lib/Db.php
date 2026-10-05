<?php
declare(strict_types=1);

/**
 * Хранилище сигналинга сетевой игры (SQLite).
 *
 * Файл БД лежит ВНЕ webroot — в каталоге `data/` рядом с `public/`
 * (на проде `/var/www/fly.nayanovaacademy.ru/data/signaling.db`), поэтому
 * деплой, который пересоздаёт `public/`, его не трогает. Путь можно
 * переопределить переменной окружения FLY_DATA_DIR (локальный запуск/тесты).
 *
 * Схема развивается миграциями по маркеру PRAGMA user_version — как в auth-web.
 */
class FlyDb
{
    private static ?PDO $pdo = null;

    public static function dataDir(): string
    {
        $env = getenv('FLY_DATA_DIR');
        if (is_string($env) && $env !== '') {
            return rtrim($env, "/\\");
        }
        // server/lib -> server -> <корень проекта> -> data
        return dirname(__DIR__, 2) . DIRECTORY_SEPARATOR . 'data';
    }

    public static function getInstance(): PDO
    {
        if (self::$pdo === null) {
            $dir = self::dataDir();
            if (!is_dir($dir)) {
                if (!@mkdir($dir, 0755, true) && !is_dir($dir)) {
                    throw new RuntimeException('Не удалось создать каталог данных: ' . $dir);
                }
            }
            if (!is_writable($dir)) {
                throw new RuntimeException('Каталог данных недоступен для записи: ' . $dir);
            }

            $pdo = new PDO('sqlite:' . $dir . DIRECTORY_SEPARATOR . 'signaling.db', null, null, [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES => false,
            ]);
            $pdo->exec('PRAGMA journal_mode=WAL');
            $pdo->exec('PRAGMA busy_timeout=5000');
            $pdo->exec('PRAGMA foreign_keys=ON');

            self::$pdo = $pdo;
            self::migrate($pdo);
        }
        return self::$pdo;
    }

    private static function migrate(PDO $db): void
    {
        // Схема сигналинга: комнаты до 4 игроков, присутствие игроков,
        // очередь SDP-сообщений (offer/answer) между парами участников.
        $version = (int) $db->query('PRAGMA user_version')->fetchColumn();
        if ($version < 1) {
            $db->exec("
                CREATE TABLE IF NOT EXISTS rooms (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    created_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS players (
                    user_id INTEGER PRIMARY KEY,
                    name TEXT NOT NULL DEFAULT '',
                    room_id INTEGER NOT NULL,
                    joined_at INTEGER NOT NULL,
                    seen_at INTEGER NOT NULL,
                    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS idx_players_room ON players(room_id);
                CREATE INDEX IF NOT EXISTS idx_players_seen ON players(seen_at);

                CREATE TABLE IF NOT EXISTS signals (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    room_id INTEGER NOT NULL,
                    from_user_id INTEGER NOT NULL,
                    to_user_id INTEGER NOT NULL,
                    sdp_type TEXT NOT NULL,
                    sdp TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS idx_signals_to ON signals(room_id, to_user_id);

                CREATE TABLE IF NOT EXISTS rate_limits (
                    name TEXT PRIMARY KEY,
                    window_started_at INTEGER NOT NULL,
                    hits INTEGER NOT NULL DEFAULT 0
                );
            ");
            $db->exec('PRAGMA user_version = 1');
        }
        if ($version < 2) {
            self::migrateV2($db);
            $db->exec('PRAGMA user_version = 2');
        }
        if ($version < 3) {
            self::migrateV3($db);
            $db->exec('PRAGMA user_version = 3');
        }
        if ($version < 4) {
            self::migrateV4($db);
            $db->exec('PRAGMA user_version = 4');
        }
    }

    /**
     * Миграция v2: комната как самостоятельная игра — название, карта,
     * параметры (JSON), хост и признак старта. Позволяет вести несколько
     * сетевых игр одновременно и подключаться к конкретной.
     */
    private static function migrateV2(PDO $db): void
    {
        $cols = [];
        foreach ($db->query('PRAGMA table_info(rooms)') as $row) {
            $cols[(string) $row['name']] = true;
        }
        $add = [
            'title'        => "ALTER TABLE rooms ADD COLUMN title TEXT NOT NULL DEFAULT ''",
            'map'          => "ALTER TABLE rooms ADD COLUMN map TEXT NOT NULL DEFAULT 'meadow'",
            'params'       => "ALTER TABLE rooms ADD COLUMN params TEXT NOT NULL DEFAULT '{}'",
            'host_user_id' => "ALTER TABLE rooms ADD COLUMN host_user_id INTEGER NOT NULL DEFAULT 0",
            'started'      => "ALTER TABLE rooms ADD COLUMN started INTEGER NOT NULL DEFAULT 0",
        ];
        foreach ($add as $col => $sql) {
            if (!isset($cols[$col])) {
                $db->exec($sql);
            }
        }
    }

    /**
     * Миграция v3: слот игрока в комнате (0..3) — стабильная точка спавна,
     * чтобы при старте участники не появлялись в одной точке. Существующим
     * игрокам слоты назначаются по порядку входа.
     */
    private static function migrateV3(PDO $db): void
    {
        $cols = [];
        foreach ($db->query('PRAGMA table_info(players)') as $row) {
            $cols[(string) $row['name']] = true;
        }
        if (!isset($cols['slot'])) {
            $db->exec('ALTER TABLE players ADD COLUMN slot INTEGER NOT NULL DEFAULT -1');
        }

        $roomIds = $db->query('SELECT id FROM rooms')->fetchAll(PDO::FETCH_COLUMN);
        $selectPlayers = $db->prepare(
            'SELECT user_id FROM players WHERE room_id = ? ORDER BY joined_at ASC, user_id ASC'
        );
        $setSlot = $db->prepare('UPDATE players SET slot = ? WHERE user_id = ?');
        foreach ($roomIds as $roomId) {
            $selectPlayers->execute([(int) $roomId]);
            $taken = [];
            foreach ($selectPlayers->fetchAll(PDO::FETCH_COLUMN) as $uid) {
                $slot = -1;
                for ($s = 0; $s < 4; $s++) { // слотов ровно столько, сколько мест в комнате
                    if (!isset($taken[$s])) {
                        $slot = $s;
                        break;
                    }
                }
                if ($slot >= 0) {
                    $taken[$slot] = true;
                }
                $setSlot->execute([$slot, (int) $uid]);
            }
        }
    }

    /**
     * Миграция v4: размер комнаты (`rooms.max`) — хост выбирает число
     * участников (например 2/4/6/8) для игры в локальной сети.
     */
    private static function migrateV4(PDO $db): void
    {
        $cols = [];
        foreach ($db->query('PRAGMA table_info(rooms)') as $row) {
            $cols[(string) $row['name']] = true;
        }
        if (!isset($cols['max'])) {
            $db->exec('ALTER TABLE rooms ADD COLUMN max INTEGER NOT NULL DEFAULT 4');
        }
    }

    /**
     * BEGIN IMMEDIATE с корректным режимом транзакции (нюанс pdo_sqlite:
     * exec('BEGIN') не регистрирует транзакцию в драйвере на части версий PHP).
     * Логика общая с auth-web (Auth::immediateTxn / track.php).
     */
    public static function immediateTxn(PDO $db, callable $fn)
    {
        $db->exec('BEGIN IMMEDIATE');
        $driverTxn = $db->inTransaction();
        try {
            $result = $fn($db);
            if ($driverTxn) {
                $db->commit();
            } else {
                $db->exec('COMMIT');
            }
            return $result;
        } catch (Throwable $e) {
            try {
                if ($driverTxn) {
                    if ($db->inTransaction()) {
                        $db->rollBack();
                    }
                } else {
                    $db->exec('ROLLBACK');
                }
            } catch (Throwable $ignored) {
            }
            throw $e;
        }
    }

    /**
     * Удалить протухших игроков, осиротевшие комнаты и старые сигналы.
     * Кэш SDP-сообщений короткоживущий: дольше пары минут они не нужны.
     */
    public static function cleanup(PDO $db, ?int $now = null, int $playerTtl = 20, int $signalTtl = 120): void
    {
        $now = $now ?? time();
        $db->prepare('DELETE FROM players WHERE seen_at < ?')->execute([$now - $playerTtl]);
        $db->prepare('DELETE FROM signals WHERE created_at < ?')->execute([$now - $signalTtl]);
        $db->exec('DELETE FROM rooms WHERE id NOT IN (SELECT DISTINCT room_id FROM players)');
    }
}
