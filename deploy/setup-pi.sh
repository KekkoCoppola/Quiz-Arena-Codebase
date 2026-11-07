#!/usr/bin/env bash
# deploy/setup-pi.sh
#
# Rende il Raspberry Pi un apparecchio plug-and-play: lo si attacca alla
# corrente e, senza toccare nulla,
#   1. crea la rete Wi-Fi della sala (access point, il Pi è 192.168.4.1);
#   2. avvia il server di gioco (e lo riavvia se cade);
#   3. apre la vista sala a tutto schermo sull'HDMI, con l'audio sull'HDMI.
#
# Prerequisiti, da fare prima a mano:
#   - Raspberry Pi OS Lite 64-bit (Trixie o successiva)
#   - Node.js v24+ (NodeSource), progetto clonato in ~/quizzata, `npm ci` fatto
#   - .env compilato (JWT_SECRET) e account host creato con tools/create-host.js
#
# Uso (dal Pi, via SSH):
#   sudo bash setup-pi.sh                      rete aperta "QuizZata"
#   sudo bash setup-pi.sh --pass parolalunga   rete con password (min 8 caratteri)
#   sudo bash setup-pi.sh --ssid AltroNome     altro nome di rete
#
# Rilanciabile: ogni passo riscrive la propria configurazione.
# L'access point NON parte subito: farlo staccherebbe il Pi dal Wi-Fi di casa,
# e con lui questa sessione SSH. Parte al riavvio.

set -euo pipefail

AP_SSID="QuizZata"
AP_PASS=""
AP_IP="192.168.4.1"
AP_CON="quizzata-ap"
SALA_HOST="quizzata.gioca"   # il nome della sala, risolto dal DNS dell'access point
HDMI_MODE="1920x1080@60"   # a 4K la GPU del Pi 4 non regge le scene three.js
APP_USER="${SUDO_USER:-quizzata}"
APP_DIR="/home/${APP_USER}/quizzata"

die() { echo "ERRORE: $*" >&2; exit 1; }
step() { echo; echo "==> $*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --ssid) AP_SSID="${2:?manca il nome dopo --ssid}"; shift 2 ;;
    --pass) AP_PASS="${2:?manca la password dopo --pass}"; shift 2 ;;
    --dir)  APP_DIR="${2:?manca la cartella dopo --dir}"; shift 2 ;;
    *) die "opzione sconosciuta: $1 (vedi l'intestazione dello script)" ;;
  esac
done

# ─── Controlli ──────────────────────────────────────────────────────────────────

[ "$(id -u)" -eq 0 ] || die "lancialo con sudo: sudo bash $0"
[ "$APP_USER" != "root" ] || die "lancialo con sudo da un utente normale, non da root"
[ -f "$APP_DIR/server/index.js" ] || die "progetto non trovato in $APP_DIR (usa --dir)"
[ -f "$APP_DIR/.env" ] || die ".env mancante in $APP_DIR (copia .env.example e compila JWT_SECRET)"
[ -d "$APP_DIR/node_modules" ] || die "dipendenze mancanti: in $APP_DIR lancia npm ci --omit=dev"

NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || die "Node.js non installato"
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 24 ] || die "serve Node v24+, trovato $("$NODE_BIN" -v)"

if [ -n "$AP_PASS" ] && [ "${#AP_PASS}" -lt 8 ]; then
  die "la password del Wi-Fi deve avere almeno 8 caratteri"
fi
# Finiscono nel .env fra apici singoli (vedi set_env più sotto).
case "${AP_SSID}${AP_PASS}" in
  *"'"*) die "nome e password del Wi-Fi non possono contenere apostrofi" ;;
esac

# La porta la decide .env, come per il server. Il \r tollera un .env salvato da Windows.
PORT="$(sed -n 's/^PORT=//p' "$APP_DIR/.env" | tail -n1 | tr -d '\r[:space:]')"
PORT="${PORT:-3000}"

# ─── Pacchetti ──────────────────────────────────────────────────────────────────

step "Installo cage, Chromium e gli strumenti audio"
export DEBIAN_FRONTEND=noninteractive
# Solo ciò che manca: rilanciato con l'access point acceso il Pi non ha
# internet, e un apt-get update fallito fermerebbe tutto lo script.
NEED=""
for p in cage alsa-utils curl fonts-noto-color-emoji python3 \
         pipewire pipewire-pulse pipewire-alsa wireplumber; do
  dpkg -s "$p" >/dev/null 2>&1 || NEED="$NEED $p"
done
if ! command -v chromium >/dev/null && ! command -v chromium-browser >/dev/null; then
  NEED="$NEED chromium"
fi
if [ -n "$NEED" ]; then
  apt-get update || die "serve internet per installare:$NEED
  Con l'access point acceso il Pi non ce l'ha: sudo quizzata-rete casa, poi rilancia."
  # shellcheck disable=SC2086
  apt-get install -y $NEED
else
  echo "già tutto installato"
fi
CHROMIUM="$(command -v chromium || command -v chromium-browser)"
CAGE="$(command -v cage)"

# Schermo, GPU, audio e input per la sessione del kiosk.
for g in video render audio input; do
  if getent group "$g" >/dev/null; then usermod -aG "$g" "$APP_USER"; fi
done

# ─── Server di gioco ────────────────────────────────────────────────────────────

step "Servizio del server (quizzata.service)"
cat > /etc/systemd/system/quizzata.service <<EOF
[Unit]
Description=Quiz-Zata! server di gioco
After=network.target

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}
ExecStart=${NODE_BIN} server/index.js
Restart=always
RestartSec=2
# Permette la porta 80 (URL senza ":porta") senza girare da root.
AmbientCapabilities=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
EOF

# ─── Vista sala in kiosk ────────────────────────────────────────────────────────

step "Kiosk della vista sala (quizzata-kiosk.service)"

# Aspetta il server prima di aprire la pagina: senza, al boot Chromium
# mostrerebbe "impossibile raggiungere il sito" sul proiettore.
# Profilo in /tmp (tmpfs): pulito a ogni avvio, quindi niente "ripristinare
# le pagine?" dopo una corrente staccata, e nessuna scrittura sulla SD.
cat > /usr/local/bin/quizzata-kiosk <<EOF
#!/bin/sh
# Tema di puntatori trasparenti (vedi sotto): il cursore lo disegna cage
# finché Chromium non riceve il mouse, e il cursor:none della sala arriva tardi.
export XCURSOR_THEME=quizzata-nascosto
export XCURSOR_SIZE=24
i=0
while [ \$i -lt 90 ]; do
  curl -sf "http://localhost:${PORT}/api/health" >/dev/null 2>&1 && break
  i=\$((i + 1))
  sleep 1
done
exec ${CAGE} -d -- ${CHROMIUM} \\
  --kiosk --incognito --no-first-run --noerrdialogs --disable-infobars \\
  --disable-session-crashed-bubble --disable-features=Translate,TranslateUI \\
  --lang=it --accept-lang=it-IT,it \\
  --password-store=basic --autoplay-policy=no-user-gesture-required \\
  --check-for-update-interval=31536000 --overscroll-history-navigation=0 \\
  --disable-pinch --ozone-platform=wayland \\
  --enable-logging=stderr --log-level=0 \\
  --user-data-dir=/tmp/quizzata-kiosk \\
  "http://localhost:${PORT}/sala"
EOF
chmod 755 /usr/local/bin/quizzata-kiosk

# Puntatore invisibile. cage non ha un'opzione per nasconderlo, quindi gli si
# dà un tema in cui ogni puntatore è un pixel trasparente: un file Xcursor da
# 68 byte (intestazione, un indice, un'immagine 1x1 con alfa 0).
CUR_THEME=/usr/share/icons/quizzata-nascosto
mkdir -p "$CUR_THEME/cursors"
printf 'Xcur\x10\x00\x00\x00\x00\x00\x01\x00\x01\x00\x00\x00\x02\x00\xfd\xff\x18\x00\x00\x00\x1c\x00\x00\x00\x24\x00\x00\x00\x02\x00\xfd\xff\x18\x00\x00\x00\x01\x00\x00\x00\x01\x00\x00\x00\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00' \
  > "$CUR_THEME/cursors/left_ptr"
for n in default arrow top_left_arrow left_arrow pointer hand2 text xterm wait watch; do
  ln -sf left_ptr "$CUR_THEME/cursors/$n"
done
printf '[Icon Theme]\nName=quizzata-nascosto\n' > "$CUR_THEME/index.theme"
# Anche come tema "default" dell'utente del kiosk, per chi non legge XCURSOR_THEME.
install -d -o "$APP_USER" -g "$APP_USER" "/home/$APP_USER/.icons/default"
printf '[Icon Theme]\nInherits=quizzata-nascosto\n' > "/home/$APP_USER/.icons/default/index.theme"
chown "$APP_USER:$APP_USER" "/home/$APP_USER/.icons/default/index.theme"

# Criteri di Chromium: i flag cambiano nome fra versioni, i criteri no.
for d in /etc/chromium/policies/managed /etc/chromium-browser/policies/managed; do
  mkdir -p "$d"
  cat > "$d/quizzata.json" <<'EOF'
{
  "TranslateEnabled": false,
  "PasswordManagerEnabled": false
}
EOF
done

# Sessione logind vera sul tty1, senza login: è quella che dà a cage
# l'accesso a schermo e input.
cat > /etc/pam.d/quizzata-kiosk <<'EOF'
auth     required pam_unix.so nullok
account  required pam_unix.so
session  required pam_unix.so
session  required pam_systemd.so
EOF

cat > /etc/systemd/system/quizzata-kiosk.service <<EOF
[Unit]
Description=Quiz-Zata! vista sala sull'HDMI
After=systemd-user-sessions.service dbus.socket systemd-logind.service quizzata.service
Wants=dbus.socket systemd-logind.service quizzata.service quizzata-nudge.service
Conflicts=getty@tty1.service
After=getty@tty1.service

[Service]
Type=simple
User=${APP_USER}
PAMName=quizzata-kiosk
TTYPath=/dev/tty1
TTYReset=yes
TTYVHangup=yes
TTYVTDisallocate=yes
StandardInput=tty-fail
StandardOutput=journal
StandardError=journal
UtmpIdentifier=tty1
UtmpMode=user
ExecStart=/usr/local/bin/quizzata-kiosk
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

# ─── Puntatore: un mouse virtuale lo fa sparire ─────────────────────────────────

# Il puntatore al centro lo disegna cage finché Chromium non riceve un
# movimento: solo da lì vale il cursor:none della sala. Senza mouse il
# movimento non arriva mai, quindi lo si finge per i primi due minuti.
cat > /usr/local/bin/quizzata-nudge <<'PYEOF'
#!/usr/bin/python3
"""Mouse virtuale (uinput) che sposta il puntatore di un pixel avanti e indietro."""
import fcntl
import os
import struct
import time

UI_SET_EVBIT, UI_SET_KEYBIT, UI_SET_RELBIT = 0x40045564, 0x40045565, 0x40045566
UI_DEV_CREATE, UI_DEV_DESTROY = 0x5501, 0x5502
EV_SYN, EV_KEY, EV_REL = 0, 1, 2
REL_X, REL_Y, BTN_LEFT = 0, 1, 0x110

fd = os.open('/dev/uinput', os.O_WRONLY | os.O_NONBLOCK)
fcntl.ioctl(fd, UI_SET_EVBIT, EV_KEY)
fcntl.ioctl(fd, UI_SET_KEYBIT, BTN_LEFT)   # senza un tasto libinput non lo crede un mouse
fcntl.ioctl(fd, UI_SET_EVBIT, EV_REL)
fcntl.ioctl(fd, UI_SET_RELBIT, REL_X)
fcntl.ioctl(fd, UI_SET_RELBIT, REL_Y)
# struct uinput_user_dev: nome, input_id, ff_effects_max, 4 x 64 assi assoluti
os.write(fd, struct.pack('80sHHHHI', b'quizzata-nudge', 0x06, 1, 1, 1, 0) + bytes(4 * 64 * 4))
fcntl.ioctl(fd, UI_DEV_CREATE)


def emit(ev_type, code, value):
    os.write(fd, struct.pack('llHHi', 0, 0, ev_type, code, value))


try:
    time.sleep(2)   # il compositor deve accorgersi del dispositivo nuovo
    for _ in range(60):
        for step in (1, -1):
            emit(EV_REL, REL_X, step)
            emit(EV_SYN, 0, 0)
            time.sleep(1)
finally:
    fcntl.ioctl(fd, UI_DEV_DESTROY)
    os.close(fd)
PYEOF
chmod 755 /usr/local/bin/quizzata-nudge

cat > /etc/systemd/system/quizzata-nudge.service <<'EOF'
[Unit]
Description=Quiz-Zata! nasconde il puntatore in sala
After=quizzata-kiosk.service
PartOf=quizzata-kiosk.service

[Service]
Type=simple
ExecStartPre=-/sbin/modprobe uinput
ExecStart=/usr/local/bin/quizzata-nudge
EOF

# ─── Audio: PipeWire ────────────────────────────────────────────────────────────

step "Audio con PipeWire, solo sull'HDMI 0"
# Senza un server audio Chromium apre l'HDMI una volta per sorgente (effetti
# in Web Audio, musica in <audio>, sintetizzatore del sipario), e l'HDMI del
# Pi 4 ne accetta una: la prima suona, le altre restano mute. PipeWire le
# mescola, come sul Raspberry Pi OS con desktop. Parte da solo nella sessione
# del kiosk (servizi utente attivati dal socket).
# Il vecchio /etc/asound.conf di questo script scavalcava PipeWire: via.
if [ -f /etc/asound.conf ] && grep -q 'quizzata' /etc/asound.conf; then
  rm -f /etc/asound.conf
fi
if [ -f /etc/asound.conf.prima-di-quizzata ]; then
  mv /etc/asound.conf.prima-di-quizzata /etc/asound.conf
fi
mkdir -p /etc/wireplumber/wireplumber.conf.d
cat > /etc/wireplumber/wireplumber.conf.d/51-quizzata.conf <<'EOF'
# quizzata: l'audio della sala esce solo dall'HDMI 0, la presa accanto
# all'alimentazione. Jack e HDMI 1 spenti, così nessuno dei due diventa
# l'uscita predefinita.
monitor.alsa.rules = [
  {
    matches = [
      { api.alsa.card.name = "bcm2835 Headphones" }
      { api.alsa.card.name = "vc4-hdmi-1" }
    ]
    actions = {
      update-props = { device.disabled = true }
    }
  }
]
# Il volume di partenza di un'uscita nuova è basso: in sala serve pieno,
# il volume lo regola il proiettore o l'impianto.
wireplumber.settings = {
  device.routes.default-sink-volume = 1.0
}
EOF

# ─── Avvio pulito e uscita video ────────────────────────────────────────────────

step "Boot silenzioso e uscita HDMI a ${HDMI_MODE}"
BOOT=/boot/firmware
[ -f "$BOOT/cmdline.txt" ] || BOOT=/boot
CMDLINE="$BOOT/cmdline.txt"
CONFIG="$BOOT/config.txt"
[ -f "$CMDLINE" ] || die "cmdline.txt non trovato"
[ -f "$CMDLINE.prima-di-quizzata" ] || cp "$CMDLINE" "$CMDLINE.prima-di-quizzata"

# cmdline.txt è una riga sola. La "D" finale accende l'uscita anche se il
# proiettore è spento al boot: senza, il Pi non lo vedrebbe e resterebbe nero.
line="$(head -n1 "$CMDLINE" | sed -E 's/(^| )video=HDMI-A-1:[^ ]*//g')"
for tok in quiet loglevel=3 logo.nologo vt.global_cursor_default=0 consoleblank=0; do
  case " $line " in *" $tok "*) ;; *) line="$line $tok" ;; esac
done
line="$line video=HDMI-A-1:${HDMI_MODE}D"
echo "$line" | tr -s ' ' | sed 's/^ //' > "$CMDLINE"

if ! grep -q '^disable_splash=1' "$CONFIG"; then
  printf '\n[all]\n# quizzata: niente arcobaleno al boot\ndisable_splash=1\n' >> "$CONFIG"
fi

# ─── Rete della sala ────────────────────────────────────────────────────────────

step "Access point \"${AP_SSID}\" su ${AP_IP}"
command -v raspi-config >/dev/null && raspi-config nonint do_wifi_country IT || true
rfkill unblock wifi 2>/dev/null || true

# Il file di connessione si scrive invece di passare da `nmcli con add`:
# così rilanciare lo script non tocca una connessione attiva (cadrebbe SSH),
# e le modifiche valgono dalla prossima attivazione.
NM_DIR=/etc/NetworkManager/system-connections
NM_FILE="$NM_DIR/${AP_CON}.nmconnection"
UUID="$(sed -n 's/^uuid=//p' "$NM_FILE" 2>/dev/null || true)"
UUID="${UUID:-$(cat /proc/sys/kernel/random/uuid)}"
{
  echo "[connection]"
  echo "id=${AP_CON}"
  echo "uuid=${UUID}"
  echo "type=wifi"
  echo "interface-name=wlan0"
  echo "autoconnect=true"
  # Vince sul Wi-Fi di casa (priorità 0): al boot il Pi fa sempre la sala.
  echo "autoconnect-priority=100"
  echo
  echo "[wifi]"
  echo "mode=ap"
  echo "ssid=${AP_SSID}"
  echo "band=bg"
  echo "channel=6"
  echo "powersave=2"
  echo
  if [ -n "$AP_PASS" ]; then
    echo "[wifi-security]"
    echo "key-mgmt=wpa-psk"
    echo "psk=${AP_PASS}"
    echo "proto=rsn"
    echo "pairwise=ccmp"
    echo "group=ccmp"
    echo
  fi
  echo "[ipv4]"
  echo "method=shared"
  echo "address1=${AP_IP}/24"
  echo
  echo "[ipv6]"
  echo "method=disabled"
} > "$NM_FILE"
chmod 600 "$NM_FILE"

# La guida proiettata in sala (passo 1, "Connettiti al Wi-Fi") scrive nome e
# password della rete leggendoli dal .env: si allineano qui a quelli appena
# dati all'access point, così le due cose non possono divergere. Il file si
# riscrive sul posto (cat >) e non si sostituisce: resta dell'utente.
set_env() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  grep -v "^${key}=" "$APP_DIR/.env" > "$tmp" || true
  [ -z "$(tail -c1 "$tmp")" ] || echo >> "$tmp"
  printf "%s='%s'\n" "$key" "$value" >> "$tmp"
  cat "$tmp" > "$APP_DIR/.env"
  rm -f "$tmp"
}
set_env WIFI_SSID "$AP_SSID"
set_env WIFI_PASSWORD "$AP_PASS"
# Sotto il QR la sala scrive questo nome invece dell'IP.
set_env JOIN_HOST "$SALA_HOST"

# Il DHCP della modalità "shared" è un dnsmasq di NetworkManager:
# qui gli si insegna il nome della sala.
mkdir -p /etc/NetworkManager/dnsmasq-shared.d
cat > /etc/NetworkManager/dnsmasq-shared.d/quizzata.conf <<EOF
address=/${SALA_HOST}/${AP_IP}
EOF
nmcli connection reload

# Per aggiornare il Pi serve internet: questo passa dalla sala al Wi-Fi di casa.
cat > /usr/local/bin/quizzata-rete <<EOF
#!/bin/sh
# sudo quizzata-rete casa  -> lascia la rete della sala, si collega al Wi-Fi di casa
# sudo quizzata-rete sala  -> torna access point (lo fa anche un riavvio)
case "\$1" in
  casa)
    HOME_CON="\$(nmcli -t -f NAME,TYPE connection show | awk -F: '\$2=="802-11-wireless" && \$1!="${AP_CON}" {print \$1; exit}')"
    [ -n "\$HOME_CON" ] || { echo "Nessun Wi-Fi di casa configurato"; exit 1; }
    echo "Passo a \"\$HOME_CON\": la rete della sala si spegne. Rientra con ssh ${APP_USER}@quizzata.local"
    nmcli connection up "\$HOME_CON"
    ;;
  sala)
    nmcli connection up ${AP_CON}
    ;;
  *)
    echo "uso: sudo quizzata-rete casa|sala"
    exit 1
    ;;
esac
EOF
chmod 755 /usr/local/bin/quizzata-rete

# ─── Attivazione ────────────────────────────────────────────────────────────────

step "Attivo i servizi"
systemctl daemon-reload
# Il tty1 è della sala: il login testuale resta su Ctrl+Alt+F2.
systemctl disable getty@tty1.service >/dev/null 2>&1 || true
systemctl enable quizzata.service quizzata-kiosk.service
systemctl restart quizzata.service
# Rilanciato su un Pi già in funzione, la sala riparte subito con le modifiche.
systemctl try-restart quizzata-kiosk.service

if [ "$PORT" = "80" ]; then URL="http://${AP_IP}"; else URL="http://${AP_IP}:${PORT}"; fi
if [ -n "$AP_PASS" ]; then RETE="con password"; else RETE="aperta"; fi

cat <<EOF

Fatto. Dal prossimo avvio, appena il Pi riceve corrente:
  - rete Wi-Fi "${AP_SSID}" (${RETE}), il Pi è ${AP_IP}
  - giocatori su ${URL} (oppure http://${SALA_HOST})
  - vista sala sull'HDMI 0, la presa accanto all'alimentazione

ATTENZIONE: dopo il riavvio il Pi lascia il Wi-Fi di casa.
  Per rientrare via SSH: collega il PC alla rete "${AP_SSID}", poi
      ssh ${APP_USER}@${AP_IP}
  Per aggiornare (serve internet): sudo quizzata-rete casa
  Per tornare in sala:             sudo quizzata-rete sala  (o un riavvio)

Log utili:
  journalctl -u quizzata -f           server
  journalctl -u quizzata-kiosk -b     vista sala

Riavvia ora con:  sudo reboot
EOF
