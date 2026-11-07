#!/usr/bin/env bash
# deploy/update-pi.sh
#
# Allinea il Raspberry a GitHub: scarica l'ultima versione e applica solo
# quello che serve (dipendenze, configurazione di sistema, riavvio dei servizi).
#
# Uso (dal Pi, via SSH, con internet: cavo o `sudo quizzata-rete casa`):
#   sudo bash ~/quizzata/deploy/update-pi.sh            aggiorna e riavvia i servizi
#   sudo bash ~/quizzata/deploy/update-pi.sh --reboot   aggiorna e riavvia il Pi
#                                                       (torna in modalità sala)
#
# Le modifiche fatte a mano sul Pi ai file del progetto vengono BUTTATE: la
# fonte di verità è GitHub. .env, database e node_modules non sono nel repo
# e restano dove sono.

set -euo pipefail

APP_USER="${SUDO_USER:-quizzata}"
APP_DIR="/home/${APP_USER}/quizzata"
REBOOT=0
[ "${1:-}" = "--reboot" ] && REBOOT=1

die() { echo "ERRORE: $*" >&2; exit 1; }
step() { echo; echo "==> $*"; }
as_user() { sudo -u "$APP_USER" -H "$@"; }

[ "$(id -u)" -eq 0 ] || die "lancialo con sudo: sudo bash $0"
[ -d "$APP_DIR/.git" ] || die "progetto non trovato in $APP_DIR"
cd "$APP_DIR"

step "Controllo internet"
curl -fsS --max-time 8 https://github.com >/dev/null 2>&1 \
  || die "niente internet. Collega il cavo o lancia: sudo quizzata-rete casa"

step "Scarico da GitHub"
BEFORE="$(as_user git rev-parse HEAD)"
as_user git fetch --quiet origin
BRANCH="$(as_user git rev-parse --abbrev-ref HEAD)"
if [ -n "$(as_user git status --porcelain --untracked-files=no)" ]; then
  echo "Modifiche locali ai file del progetto: le scarto."
fi
as_user git reset --hard --quiet "origin/$BRANCH"
AFTER="$(as_user git rev-parse HEAD)"

if [ "$BEFORE" = "$AFTER" ]; then
  echo "Già aggiornato ($(as_user git log -1 --format='%h %s'))."
  CHANGED=""
else
  echo "Da $(echo "$BEFORE" | cut -c1-7) a $(as_user git log -1 --format='%h %s')"
  CHANGED="$(as_user git diff --name-only "$BEFORE" "$AFTER")"
fi

if echo "$CHANGED" | grep -qE '^package(-lock)?\.json$'; then
  step "Dipendenze cambiate: npm ci"
  as_user npm ci --omit=dev
fi

if echo "$CHANGED" | grep -q '^deploy/setup-pi\.sh$'; then
  step "Configurazione di sistema cambiata: rilancio setup-pi.sh"
  # Stessa rete di prima: nome e password li ha scritti setup-pi.sh nel .env.
  SSID="$(sed -n 's/^WIFI_SSID=//p' .env | tail -n1 | tr -d '\r')"
  PASS="$(sed -n 's/^WIFI_PASSWORD=//p' .env | tail -n1 | tr -d '\r')"
  ARGS=()
  [ -n "$SSID" ] && ARGS+=(--ssid "$SSID")
  [ -n "$PASS" ] && ARGS+=(--pass "$PASS")
  bash deploy/setup-pi.sh "${ARGS[@]}"
fi

if [ "$REBOOT" = 1 ]; then
  step "Riavvio: al ritorno il Pi è di nuovo in modalità sala"
  reboot
else
  step "Riavvio server e sala"
  systemctl restart quizzata.service
  systemctl try-restart quizzata-kiosk.service
  echo
  echo "Fatto. Per tornare in modalità sala: sudo reboot"
fi
