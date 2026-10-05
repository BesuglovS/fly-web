<?php
/**
 * AuthClient — единый клиент единой системы авторизации (auth-web).
 *
 * Единственный источник реализации SSO для всех PHP-проектов экосистемы
 * Nayanova Academy (contest-web, python-web, ai-web, j-web и т.д.).
 * Каноническая копия: shared/php/auth-client/AuthClient.php
 *
 * Проверяет авторизацию по общей куке auth_session на .nayanovaacademy.ru
 * через auth.nayanovaacademy.ru/api/*. Результат кэшируется в PHP-сессии.
 *
 * checkStatus() различает три состояния:
 *   - authenticated — пользователь авторизован;
 *   - anonymous     — auth-web ответил «не авторизован»;
 *   - unavailable   — auth-web недоступен (сеть/5xx/таймаут).
 * Это позволяет потребителям не выкидывать пользователя на логин при сбое сервиса.
 */

if (!function_exists('nayanova_auth_url')) {
    function nayanova_auth_url(): string
    {
        if (defined('AUTH_URL')) {
            return AUTH_URL;
        }
        return 'https://auth.nayanovaacademy.ru';
    }
}

if (!class_exists('AuthClient')) {
    class AuthClient
    {
        private static int $cacheTtl = 300;   // 5 минут кэш положительного результата
        private static int $negativeTtl = 30; // короткий кэш «не авторизован/недоступен»

        /**
         * Проверить авторизацию через auth-web API с различением состояний.
         * @return array{status:string, user:array{id:int,login:string,display_name:string,is_admin:bool}|null}
         *         status: 'authenticated' | 'anonymous' | 'unavailable'
         */
        public static function checkStatus(): array
        {
            $cached = self::getCachedUser();
            if ($cached !== null) {
                return ['status' => 'authenticated', 'user' => $cached];
            }

            // Отрицательный результат тоже привязан к куке: сменилась кука — перепроверяем.
            $negative = self::getNegativeCache();
            if ($negative !== null) {
                return ['status' => $negative, 'user' => null];
            }

            $response = self::apiGet('/api/check.php');

            if ($response === null) {
                // Транспортная ошибка или не-200: сервис недоступен, это НЕ «гость».
                self::setNegativeCache('unavailable');
                return ['status' => 'unavailable', 'user' => null];
            }

            $user = $response['user'] ?? null;
            if (empty($response['authenticated']) || !is_array($user)) {
                self::clearUserCache();
                self::setNegativeCache('anonymous');
                return ['status' => 'anonymous', 'user' => null];
            }

            self::setCachedUser($user);
            return ['status' => 'authenticated', 'user' => $user];
        }

        /**
         * Проверить авторизацию через auth-web API.
         * @return array{id:int,login:string,display_name:string,is_admin:bool}|null
         */
        public static function check(): ?array
        {
            return self::checkStatus()['user'];
        }

        /** Проверка авторизации как boolean */
        public static function isLoggedIn(): bool
        {
            return self::check() !== null;
        }

        /** Проверка прав администратора */
        public static function isAdmin(): bool
        {
            $user = self::check();
            return $user !== null && !empty($user['is_admin']);
        }

        /** id пользователя из auth-web (глобальный) или null */
        public static function getUserId(): ?int
        {
            $user = self::check();
            return isset($user['id']) ? (int)$user['id'] : null;
        }

        /** Имя пользователя для отображения или null */
        public static function getUserName(): ?string
        {
            $user = self::check();
            return isset($user['display_name']) ? (string)$user['display_name'] : null;
        }

        /**
         * Получить список всех пользователей из auth-web (без паролей).
         * Кэшируется в сессии на cacheTtl.
         */
        public static function getUsers(bool $force = false): ?array
        {
            $cached = self::getCached('users');
            if ($cached !== null && !$force) {
                return $cached;
            }

            $response = self::apiGet('/api/public_users.php');
            if ($response === null || !isset($response['users'])) {
                return null;
            }

            self::setCached('users', $response['users']);
            return $response['users'];
        }

        /**
         * Получить список всех групп (классов) из auth-web.
         * Кэшируется в сессии на cacheTtl.
         */
        public static function getGroups(bool $force = false): ?array
        {
            $cached = self::getCached('groups');
            if ($cached !== null && !$force) {
                return $cached;
            }

            $response = self::apiGet('/api/groups.php');
            if ($response === null || !isset($response['groups'])) {
                return null;
            }

            self::setCached('groups', $response['groups']);
            return $response['groups'];
        }

        /**
         * Получить принадлежность пользователей к группам из auth-web.
         * Возвращает список пар ['user_id' => N, 'group_id' => N].
         * Кэшируется в сессии на cacheTtl.
         */
        public static function getMemberships(bool $force = false): ?array
        {
            $cached = self::getCached('memberships');
            if ($cached !== null && !$force) {
                return $cached;
            }

            $response = self::apiGet('/api/user_groups.php');
            if ($response === null || !isset($response['memberships'])) {
                return null;
            }

            self::setCached('memberships', $response['memberships']);
            return $response['memberships'];
        }

        /**
         * Получить URL для входа с редиректом обратно
         */
        public static function getLoginUrl(string $returnUrl): string
        {
            return nayanova_auth_url() . '/index.php?page=login&redirect=' . urlencode($returnUrl);
        }

        /**
         * Получить URL для выхода
         */
        public static function getLogoutUrl(string $returnUrl): string
        {
            return nayanova_auth_url() . '/api/logout.php?redirect=' . urlencode($returnUrl);
        }

        /** Очистить весь кэш сессии (включая негативный) */
        public static function clearCache(): void
        {
            foreach (['data_users', 'data_groups', 'data_memberships', 'neg'] as $key) {
                unset($_SESSION['nayanova_auth_' . $key]);
            }
            self::clearUserCache();
            // Легаси-ключи старых версий — подчистим, если остались.
            foreach (['users', 'users_at', 'groups', 'groups_at', 'memberships', 'memberships_at'] as $legacy) {
                unset($_SESSION['nayanova_auth_' . $legacy]);
            }
        }

        private static function apiGet(string $path): ?array
        {
            $url = nayanova_auth_url() . $path;

            $cookieHeader = '';
            if (!empty($_COOKIE['auth_session'])) {
                // Значение куки идёт в HTTP-заголовок — оставляем только допустимые символы.
                $safeValue = preg_replace('/[^A-Za-z0-9,_\-]/', '', (string)$_COOKIE['auth_session']);
                if ($safeValue !== '') {
                    $cookieHeader = 'auth_session=' . $safeValue;
                }
            }

            try {
                $ch = curl_init($url);
                $opts = [
                    CURLOPT_RETURNTRANSFER => true,
                    CURLOPT_TIMEOUT => 5,
                    CURLOPT_CONNECTTIMEOUT => 2,
                    CURLOPT_SSL_VERIFYPEER => true,
                    CURLOPT_FOLLOWLOCATION => false,
                ];
                if ($cookieHeader !== '') {
                    $opts[CURLOPT_COOKIE] = $cookieHeader;
                }
                curl_setopt_array($ch, $opts);

                $response = curl_exec($ch);
                $httpCode = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
                curl_close($ch);

                if ($response === false || $httpCode !== 200) {
                    return null;
                }
            } catch (Throwable $e) {
                return null;
            }

            $data = json_decode($response, true);
            return is_array($data) ? $data : null;
        }

        private static function getCachedUser(): ?array
        {
            $envelope = $_SESSION['nayanova_auth_user'] ?? null;
            if (!is_array($envelope) || !isset($envelope['data'])) {
                // Легаси-формат (до введения конвертов).
                if (!empty($_SESSION['nayanova_auth_user']) && is_array($_SESSION['nayanova_auth_user'])
                    && isset($_SESSION['nayanova_auth_user_at'])) {
                    if (time() - (int)$_SESSION['nayanova_auth_user_at'] <= self::$cacheTtl
                        && ($_SESSION['nayanova_auth_cookie_hash'] ?? '') === self::getCookieHash()) {
                        return $_SESSION['nayanova_auth_user'];
                    }
                }
                return null;
            }
            if (time() - (int)($envelope['at'] ?? 0) > self::$cacheTtl) {
                return null;
            }
            if (($envelope['hash'] ?? '') !== self::getCookieHash()) {
                return null;
            }
            return is_array($envelope['data']) ? $envelope['data'] : null;
        }

        private static function setCachedUser(array $user): void
        {
            $_SESSION['nayanova_auth_user'] = [
                'data' => $user,
                'at' => time(),
                'hash' => self::getCookieHash(),
            ];
            unset($_SESSION['nayanova_auth_neg']);
        }

        private static function clearUserCache(): void
        {
            unset($_SESSION['nayanova_auth_user'], $_SESSION['nayanova_auth_user_at'], $_SESSION['nayanova_auth_cookie_hash']);
        }

        /**
         * Негативный кэш ('anonymous'|'unavailable'), привязанный к значению куки:
         * после входа/выхода он мгновенно перестаёт действовать.
         */
        private static function getNegativeCache(): ?string
        {
            $envelope = $_SESSION['nayanova_auth_neg'] ?? null;
            if (!is_array($envelope)) {
                return null;
            }
            if (($envelope['hash'] ?? '') !== self::getCookieHash()) {
                return null;
            }
            if (time() - (int)($envelope['at'] ?? 0) > self::$negativeTtl) {
                return null;
            }
            $status = $envelope['status'] ?? '';
            return in_array($status, ['anonymous', 'unavailable'], true) ? $status : null;
        }

        private static function setNegativeCache(string $status): void
        {
            $_SESSION['nayanova_auth_neg'] = [
                'status' => $status,
                'at' => time(),
                'hash' => self::getCookieHash(),
            ];
        }

        private static function getCached(string $kind): ?array
        {
            $envelope = $_SESSION['nayanova_auth_data_' . $kind] ?? null;
            if (!is_array($envelope) || !isset($envelope['data'])) {
                return null;
            }
            if (time() - (int)($envelope['at'] ?? 0) > self::$cacheTtl) {
                return null;
            }
            // Справочники тоже привязаны к куке: другой пользователь в той же
            // PHP-сессии не должен читать чужой кэш.
            if (($envelope['hash'] ?? '') !== self::getCookieHash()) {
                return null;
            }
            return is_array($envelope['data']) ? $envelope['data'] : null;
        }

        private static function setCached(string $kind, array $value): void
        {
            $_SESSION['nayanova_auth_data_' . $kind] = [
                'data' => $value,
                'at' => time(),
                'hash' => self::getCookieHash(),
            ];
        }

        private static function getCookieHash(): string
        {
            return hash('sha256', $_COOKIE['auth_session'] ?? '');
        }
    }
}
