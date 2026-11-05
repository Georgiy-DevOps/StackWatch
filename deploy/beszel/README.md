# Мониторинг на Beszel: hardened-развёртывание

TL;DR: hub за Caddy с автоматическим TLS, порт 8090 только на loopback, админка PocketBase закрыта allowlist'ом, агенты подключаются исходящим WebSocket (без входящих портов), Docker виден агенту через read-only прокси, образы закреплены по digest, бэкапы шифруются age.

## Риски текущей установки (исправить в первую очередь)

| Риск | Почему опасно | Что делает этот шаблон |
|---|---|---|
| Панель на `http://IP:8090` без TLS | Пароль и токен сессии идут открытым текстом; любой на маршруте их видит | Caddy + Let's Encrypt, HSTS, 8090 только на `127.0.0.1` |
| `ports: "8090:8090"` + ufw | Docker обходит ufw: «закрыли в ufw» ≠ закрыто | Публикация на loopback, `firewall.sh` проверяет слушающие порты |
| Админка `/_/` открыта всем | Суперпользователь PocketBase = полный доступ к БД и приватному ключу hub | `ADMIN_ALLOW_CIDRS` в Caddy |
| Агент слушает 45876 наружу | Лишняя поверхность атаки на каждом хосте | WebSocket-режим (`HUB_URL` + `TOKEN`), `LISTEN=127.0.0.1` |
| `docker.sock` в агенте | Компрометация агента = root на хосте (`:ro` не ограничивает API) | `socket-proxy` только с GET `/containers`, `POST=0` |
| Плавающие теги `latest` | Неконтролируемое обновление, supply-chain | Тег + `@sha256` digest |

**После переезда на HTTPS обязательно смените пароль** (он уже передавался по HTTP) и включите OTP/MFA в настройках пользователя.

## Развёртывание

```sh
sudo mkdir -p /opt/beszel && sudo cp -r deploy/beszel/. /opt/beszel/ && cd /opt/beszel
cp .env.example .env && chmod 600 .env && nano .env
docker compose config -q          # проверка синтаксиса и переменных
docker compose up -d
sudo ./firewall.sh                # с открытой второй SSH-сессией
```

DNS: A-запись `BESZEL_DOMAIN` → IP сервера (до запуска, иначе ACME не выпустит сертификат).

## Переезд с текущей установки (данные сохраняются)

```sh
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}'           # найти старые hub/agent
docker inspect <hub> --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'
docker stop <hub> <agent>
sudo mkdir -p /opt/beszel/data/hub
sudo cp -a <Source для /beszel_data>/. /opt/beszel/data/hub/   # data.db, auxiliary.db, id_ed25519
cd /opt/beszel && docker compose up -d
docker rm <hub> <agent>                                         # только после проверки
```

Ключ hub (`id_ed25519`) сохраняется, поэтому `AGENT_KEY` остаётся прежним. Если агент был в SSH-режиме, в карточке системы смените адрес на WebSocket: «Добавить систему» → взять токен → прописать `AGENT_TOKEN`.

Настройки PocketBase после старта (`https://<домен>/_/` с IP из `ADMIN_ALLOW_CIDRS`):

- **Settings → Application → Trusted proxy**: заголовок `X-Forwarded-For`, иначе rate limit видит всех как IP Caddy (та же ошибка, что была в StackWatch).
- **Settings → Rate limits**: включить.
- **Settings → Mail settings**: SMTP для писем-алертов.

## Удалённые хосты

```sh
scp deploy/beszel/agent.compose.yaml host:/opt/beszel-agent/
# на хосте: agent.env с BESZEL_DOMAIN, AGENT_KEY, AGENT_TOKEN; chmod 600 agent.env
docker compose -f agent.compose.yaml --env-file agent.env up -d
```

Входящие порты на хосте не нужны. Без Docker — бинарь агента как systemd-сервис с теми же переменными (`HUB_URL`, `TOKEN`, `KEY`, `LISTEN=127.0.0.1:45876`).

## Алерты (рекомендуемые пороги)

Настраиваются в UI: колокольчик в карточке системы, или «Настройки → Уведомления» для всех систем сразу.

| Алерт | Порог | Длительность | Зачем |
|---|---|---|---|
| Status | down | — | Хост/агент недоступен |
| CPU | 85% | 10 мин | Отсекает короткие пики (как на графике в 00:25) |
| Memory | 90% | 10 мин | Кэш/буферы не считаются, только used |
| Disk | 85% | 5 мин | Время до заполнения корня |
| Load Avg 5m | ≥ число vCPU | 10 мин | Очередь на CPU/IO |
| Bandwidth | по тарифу, напр. 50 MB/s | 10 мин | Аномальный трафик: DDoS, эксфильтрация, майнер |
| Temperature | 80 °C | 5 мин | Только на железе; на VPS датчиков обычно нет |

Каналы (Shoutrrr-URL в «Настройки → Уведомления»):

- Telegram: `telegram://<BOT_TOKEN>@telegram?chats=<CHAT_ID>` — токен бота это секрет, в репозиторий не коммитить.
- Email: адрес получателя (нужен SMTP в PocketBase).
- Webhook/ntfy/Gotify/Discord — любой URL, поддерживаемый Shoutrrr.

Проверьте кнопкой «Test» и вручную: `docker compose stop beszel-agent` → через ~1 мин должен прийти алерт Status.

## Кто сторожит сторожа

Если упадёт сам hub, алертов не будет. Добавьте в StackWatch HTTP-проверку `https://<домен>/api/health` (ожидается 200) — два мониторинга страхуют друг друга.

## Бэкапы

```sh
sudo apt install -y sqlite3 age
age-keygen -o beszel-backup.key     # НА ЛОКАЛЬНОЙ МАШИНЕ, не на сервере; ключ хранить офлайн
# на сервере: cron, AGE_RECIPIENT = публичный ключ (age1...)
30 3 * * * AGE_RECIPIENT=age1... /opt/beszel/backup.sh >>/var/log/beszel-backup.log 2>&1
```

Бэкап содержит приватный ключ hub, поэтому без шифрования скрипт не запускается. Копию `backups/` выносите за пределы сервера (rsync/rclone в S3). Восстановление описано в конце `backup.sh`; проверяйте его раз в квартал на копии.

## Обновление

1. Прочитать release notes Beszel.
2. Сделать бэкап (`backup.sh`).
3. Заменить тег и digest в `compose.yaml` и `agent.compose.yaml` (`docker buildx imagetools inspect henrygd/beszel:<версия>`).
4. `docker compose pull && docker compose up -d`; версии hub и агентов держать одинаковыми.
