#!/usr/bin/env bash
# Базовый firewall для хоста с hub: наружу только SSH, 80, 443.
# Запускать вручную под root, с открытой второй SSH-сессией (страховка от самоблокировки).
#
# ВАЖНО: опубликованные Docker-порты (ports: "8090:8090") идут через цепочку DOCKER
# и ОБХОДЯТ правила ufw INPUT. Поэтому закрытие 8090 делается в compose.yaml
# (публикация только на 127.0.0.1), а этот скрипт — второй слой и проверка.
set -euo pipefail

SSH_PORT="${SSH_PORT:-22}"
[[ $EUID -eq 0 ]] || { echo "Нужен root" >&2; exit 1; }
command -v ufw >/dev/null || apt-get install -y ufw

ufw default deny incoming
ufw default allow outgoing
ufw limit "${SSH_PORT}/tcp" comment 'ssh (rate-limited)'
ufw allow 80/tcp  comment 'caddy http (ACME + redirect)'
ufw allow 443/tcp comment 'caddy https'
ufw allow 443/udp comment 'caddy http/3'
ufw --force enable
ufw status verbose

echo
echo "== Порты, слушающие НЕ на loopback (проверьте, что тут нет 8090/45876/2375) =="
ss -Htlnp | awk '$4 !~ /^(127\.|\[::1\])/' || true

echo
echo "== Проверка снаружи (с другой машины) =="
echo "  nc -vz <IP> 8090    # должно быть: connection refused / timeout"
echo "  nc -vz <IP> 45876   # должно быть: connection refused / timeout"
