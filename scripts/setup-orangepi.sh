#!/bin/bash
# ============================================================
#  setup-orangepi.sh
#  Configures an Orange Pi PC (Armbian) as a Piso WiFi router
#
#  Tested on:
#    - Armbian Bookworm / Jammy (arm32 / arm64)
#    - Orange Pi PC (H3 SoC)
#
#  Hardware required:
#    - Orange Pi PC
#    - USB WiFi adapter (the on-board H3 WiFi is NOT supported
#      on many Armbian builds; a USB adapter on wlan0 or wlan1
#      is strongly recommended)
#    - Ethernet cable on eth0 (or end0) connected to your ISP router
#
#  Usage:
#    sudo bash scripts/setup-orangepi.sh
# ============================================================

set -e

# ── User-configurable values ──────────────────────────────────────────────────

SSID="TechPiso WiFi"          # WiFi name customers see
WPA_PASS="pisowifi2024"       # WiFi password (change this!)
GATEWAY_IP="192.168.10.1"     # Orange Pi IP on the hotspot network
DHCP_RANGE_START="192.168.10.10"
DHCP_RANGE_END="192.168.10.200"
APP_PORT="3000"

# ── Detect app directory ──────────────────────────────────────────────────────
# Resolves to the folder containing this script's parent
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"

# ── Detect running user (for systemd service) ────────────────────────────────
APP_USER="${SUDO_USER:-root}"
if [ "$APP_USER" = "root" ]; then APP_USER="root"; fi

# ── Detect WiFi interface ─────────────────────────────────────────────────────
# Prefer wlan1 (USB adapter) → wlan0 → fail
detect_wifi() {
  for iface in wlan1 wlan0; do
    if ip link show "$iface" &>/dev/null; then
      echo "$iface"
      return
    fi
  done
  echo ""
}

# ── Detect WAN (ethernet) interface ──────────────────────────────────────────
detect_eth() {
  for iface in end0 eth0 enp1s0; do
    if ip link show "$iface" &>/dev/null; then
      echo "$iface"
      return
    fi
  done
  echo "eth0"  # best guess fallback
}

WIFI_IFACE=$(detect_wifi)
ETH_IFACE=$(detect_eth)

echo "============================================"
echo "  TechPiso WiFi — Orange Pi PC Setup"
echo "============================================"
echo "  App dir:      $APP_DIR"
echo "  App user:     $APP_USER"
echo "  WiFi iface:   ${WIFI_IFACE:-'NOT FOUND — plug in USB WiFi adapter!'}"
echo "  Ethernet:     $ETH_IFACE"
echo "  SSID:         $SSID"
echo "  Gateway IP:   $GATEWAY_IP"
echo "  App port:     $APP_PORT"
echo "============================================"
echo ""

if [ -z "$WIFI_IFACE" ]; then
  echo "❌  No WiFi interface found (wlan0 / wlan1)."
  echo "    Plug in your USB WiFi adapter and re-run this script."
  exit 1
fi

# ── 1. Update & install system packages ──────────────────────────────────────

echo "[1/10] Installing system packages..."
apt-get update -qq
apt-get install -y --no-install-recommends \
  curl wget git \
  hostapd dnsmasq \
  iptables iptables-persistent \
  iw wireless-tools rfkill \
  net-tools \
  python3 python3-pip python3-dev

# Python deps for the coin slot GPIO reader
pip3 install --quiet OPi.GPIO requests

# Unblock WiFi in case it is rfkill-blocked (common on Armbian)
rfkill unblock all || true

# ── 2. Install Node.js 20 LTS ─────────────────────────────────────────────────

echo "[2/10] Checking Node.js..."
NODE_MAJOR=0
if command -v node &>/dev/null; then
  NODE_MAJOR=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
fi

if [ "$NODE_MAJOR" -lt 18 ] 2>/dev/null; then
  echo "  Installing Node.js 20 LTS via NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "  Node.js: $(node -v)   npm: $(npm -v)"

# ── 3. Stop services while we configure ──────────────────────────────────────

echo "[3/10] Stopping hostapd & dnsmasq..."
systemctl stop hostapd dnsmasq 2>/dev/null || true
systemctl unmask hostapd 2>/dev/null || true

# ── 4. Assign static IP to WiFi interface ────────────────────────────────────

echo "[4/10] Setting static IP on $WIFI_IFACE..."

# Remove any dhcpcd or NetworkManager management of this iface
if systemctl is-active --quiet NetworkManager; then
  # Armbian Bookworm uses NetworkManager by default
  nmcli dev set "$WIFI_IFACE" managed no 2>/dev/null || true
fi

# Set static IP via ip command and persist via /etc/network/interfaces.d/
mkdir -p /etc/network/interfaces.d
cat > /etc/network/interfaces.d/pisowifi.conf << EOF
auto $WIFI_IFACE
iface $WIFI_IFACE inet static
    address ${GATEWAY_IP}/24
EOF

# Apply immediately
ip addr flush dev "$WIFI_IFACE" 2>/dev/null || true
ip addr add "${GATEWAY_IP}/24" dev "$WIFI_IFACE" 2>/dev/null || true
ip link set "$WIFI_IFACE" up

# ── 5. Configure dnsmasq ──────────────────────────────────────────────────────

echo "[5/10] Configuring dnsmasq..."
[ -f /etc/dnsmasq.conf ] && mv /etc/dnsmasq.conf /etc/dnsmasq.conf.bak.$(date +%s) 2>/dev/null || true

cat > /etc/dnsmasq.conf << EOF
# TechPiso WiFi — dnsmasq config
interface=${WIFI_IFACE}
bind-interfaces
dhcp-range=${DHCP_RANGE_START},${DHCP_RANGE_END},255.255.255.0,24h
domain-needed
bogus-priv
no-resolv
server=8.8.8.8
server=1.1.1.1
# Captive portal: redirect ALL DNS queries to our gateway
address=/#/${GATEWAY_IP}
# Log queries (comment out to reduce I/O on SD card)
# log-queries
EOF

# ── 6. Configure hostapd ──────────────────────────────────────────────────────

echo "[6/10] Configuring hostapd..."
cat > /etc/hostapd/hostapd.conf << EOF
interface=${WIFI_IFACE}
driver=nl80211
ssid=${SSID}
hw_mode=g
channel=6
ieee80211n=1
wmm_enabled=1
macaddr_acl=0
auth_algs=1
ignore_broadcast_ssid=0
wpa=2
wpa_passphrase=${WPA_PASS}
wpa_key_mgmt=WPA-PSK
wpa_pairwise=CCMP
rsn_pairwise=CCMP
EOF

# Point to config file
sed -i 's|^#\?DAEMON_CONF=.*|DAEMON_CONF="/etc/hostapd/hostapd.conf"|' /etc/default/hostapd

# ── 7. Enable IP forwarding ───────────────────────────────────────────────────

echo "[7/10] Enabling IP forwarding..."
# Apply now
sysctl -w net.ipv4.ip_forward=1 > /dev/null
# Persist across reboots
grep -qx 'net.ipv4.ip_forward=1' /etc/sysctl.d/99-pisowifi.conf 2>/dev/null || \
  echo 'net.ipv4.ip_forward=1' >> /etc/sysctl.d/99-pisowifi.conf

# ── 8. iptables — NAT + captive portal ───────────────────────────────────────

echo "[8/10] Configuring iptables..."

# Flush first
iptables -F
iptables -t nat -F
iptables -t mangle -F
iptables -X 2>/dev/null || true
iptables -t nat -X 2>/dev/null || true

# Accept established connections
iptables -A INPUT   -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A FORWARD -m state --state ESTABLISHED,RELATED -j ACCEPT

# NAT: share eth0 internet to WiFi clients
iptables -t nat -A POSTROUTING -o "$ETH_IFACE" -j MASQUERADE

# Allow DNS and DHCP on the WiFi interface
iptables -A INPUT  -i "$WIFI_IFACE" -p udp --dport 53  -j ACCEPT
iptables -A INPUT  -i "$WIFI_IFACE" -p tcp --dport 53  -j ACCEPT
iptables -A INPUT  -i "$WIFI_IFACE" -p udp --dport 67  -j ACCEPT
iptables -A INPUT  -i "$WIFI_IFACE" -p tcp --dport "$APP_PORT" -j ACCEPT

# Captive portal — redirect HTTP and HTTPS to our Node app
iptables -t nat -A PREROUTING -i "$WIFI_IFACE" -p tcp --dport 80 \
  -j DNAT --to-destination "${GATEWAY_IP}:${APP_PORT}"
iptables -t nat -A PREROUTING -i "$WIFI_IFACE" -p tcp --dport 443 \
  -j DNAT --to-destination "${GATEWAY_IP}:${APP_PORT}"

# Block all WiFi → internet forwarding by default
# (paid sessions get individual ACCEPT rules inserted by session-manager.js)
iptables -I FORWARD 1 -i "$WIFI_IFACE" -o "$ETH_IFACE" -j DROP

# Save rules so they survive reboots
netfilter-persistent save

# ── 9. Install Node.js dependencies & setup DB ───────────────────────────────

echo "[9/10] Installing Node.js dependencies..."
cd "$APP_DIR"
npm install --production

echo "  Setting up database..."
node scripts/setup-db.js

# ── 10. Create systemd service ────────────────────────────────────────────────

echo "[10/10] Creating systemd service..."
NODE_BIN=$(which node)

cat > /etc/systemd/system/pisowifi.service << EOF
[Unit]
Description=TechPiso WiFi Captive Portal
After=network.target hostapd.service dnsmasq.service
Wants=hostapd.service dnsmasq.service

[Service]
WorkingDirectory=${APP_DIR}
ExecStart=${NODE_BIN} ${APP_DIR}/server.js
Restart=always
RestartSec=5
User=${APP_USER}
Environment=PORT=${APP_PORT}
Environment=GATEWAY_IP=${GATEWAY_IP}
Environment=NODE_ENV=production
Environment=API_KEY=piso-api-key-2024
Environment=SESSION_SECRET=change-me-$(openssl rand -hex 12)
StandardOutput=journal
StandardError=journal
SyslogIdentifier=pisowifi

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable pisowifi
systemctl enable hostapd
systemctl enable dnsmasq

# ── Coin slot systemd service ─────────────────────────────────────────────────

PYTHON_BIN=$(which python3)

cat > /etc/systemd/system/pisowifi-coin.service << EOF
[Unit]
Description=TechPiso WiFi — Coin Slot GPIO Reader
After=pisowifi.service
Requires=pisowifi.service

[Service]
WorkingDirectory=${APP_DIR}
ExecStart=${PYTHON_BIN} ${APP_DIR}/scripts/coin-slot.py
Restart=always
RestartSec=3
User=root
StandardOutput=journal
StandardError=journal
SyslogIdentifier=pisowifi-coin

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable pisowifi-coin

# ── Start everything ──────────────────────────────────────────────────────────

echo ""
echo "  Starting services..."
systemctl restart dnsmasq
systemctl restart hostapd
systemctl restart pisowifi
systemctl restart pisowifi-coin

sleep 2  # give services a moment to stabilise

echo ""
echo "============================================"
echo "  ✅  Setup Complete!"
echo "============================================"
echo ""
echo "  WiFi SSID:     $SSID"
echo "  WiFi Password: $WPA_PASS"
echo "  Portal URL:    http://${GATEWAY_IP}:${APP_PORT}/portal"
echo "  Admin URL:     http://${GATEWAY_IP}:${APP_PORT}/admin"
echo "  Admin login:   admin / admin1234"
echo ""
echo "  ⚠️  IMPORTANT:"
echo "  1. Change admin password at /admin/settings"
echo "  2. Change WPA_PASS in this script and re-run hostapd"
echo "  3. Change API_KEY in the systemd service unit above"
echo ""
echo "  View app logs:   journalctl -u pisowifi      -f"
echo "  View coin logs:  journalctl -u pisowifi-coin -f"
echo "  View AP logs:    journalctl -u hostapd        -f"
echo "  Restart app:     systemctl restart pisowifi"
echo ""
