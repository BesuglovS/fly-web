# ==========================================
# fly.nayanovaacademy.ru — конфиг nginx
#
# Симулятор полёта БПЛА — самодостаточная статическая страница
# (index.html / style.css / app.js / three.module.min.js).
#
# ВАЖНО про наследование add_header:
# nginx наследует директивы add_header с уровня сервера ТОЛЬКО если
# в location нет ни одной собственной директивы add_header. Поэтому
# набор security-заголовков продублирован в каждом location, где
# задаётся свой Cache-Control.
#
# Кэш: файлы страницы грузятся по именам БЕЗ content-hash (?v=),
# поэтому любое долгое caching недопустимо — после деплоя браузер
# навсегда отдал бы старые app.js/style.css при новом HTML
# (ломаются кнопки/UI без ошибок в консоли). Всё — no-cache.
#
# Сайт полностью статический (без PHP).
# ==========================================

server {
    listen 80;
    server_name fly.nayanovaacademy.ru;

    return 301 https://$host$request_uri;
}

# ==========================================
# 2. Основной HTTPS-сервер
# ==========================================
server {
    listen 443 ssl http2;
    server_name fly.nayanovaacademy.ru;

    # --- SSL-сертификаты (wildcard *.nayanovaacademy.ru) ---
    ssl_certificate     /etc/ssl/certs/nayanovaacademy.ru/cert.pem;
    ssl_certificate_key /etc/ssl/private/nayanovaacademy.ru/key.pem;

    # --- Настройки безопасности SSL ---
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;

    # HSTS
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;

    # Security Headers — канонический набор (дублируется в location ниже).
    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
    add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'" always;

    # --- Сжатие gzip ---
    gzip on;
    gzip_types text/css application/javascript text/javascript application/json text/xml image/svg+xml;
    gzip_min_length 1000;
    gzip_comp_level 6;
    gzip_vary on;

    # --- Основные параметры сайта ---
    root /var/www/fly.nayanovaacademy.ru/public;
    index index.html;
    autoindex off;

    # Логирование
    access_log /var/log/nginx/fly.nayanovaacademy.ru.access.log;
    error_log  /var/log/nginx/fly.nayanovaacademy.ru.error.log;

    # 1. Основная маршрутизация
    location / {
        try_files $uri $uri/ =404;
    }

    # 2. Все ресурсы без content-hash — не кэшируем.
    # Свой add_header => дублируем security-набор (см. шапку файла).
    location ~* \.(css|js)$ {
        add_header Cache-Control "no-cache, must-revalidate" always;
        add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
        add_header X-Frame-Options "DENY" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Referrer-Policy "strict-origin-when-cross-origin" always;
        add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
        add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'" always;
        access_log off;
    }

    # 2a. HTML — не кэшируем (контент меняется при деплое).
    # Свой add_header => дублируем security-набор (см. шапку файла).
    location ~* \.html$ {
        add_header Cache-Control "no-cache, must-revalidate" always;
        add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
        add_header X-Frame-Options "DENY" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Referrer-Policy "strict-origin-when-cross-origin" always;
        add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
        add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'" always;
    }

    # 3. Блокировка скрытых файлов
    location ~ /\. {
        deny all;
        access_log off;
        log_not_found off;
    }
}
