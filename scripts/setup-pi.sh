#!/bin/bash
# setup-pi.sh — Run this ONCE on Raspberry Pi to configure it as a Piso WiFi router
# Tested on Raspberry Pi OS (Bullseye/Bookworm) with two network interfaces:
#   eth0 (WAN — internet from your ISP router)
#   wlan0 (AP — hotspot for customers)
#
# Usage: sudo bash setup-pi.sh

set -e

SSID="TechPiso WiFi"
WPA_PASS="pisowifi2024"
GATEWAY_IP="192.168.10.1"
DHCP_RANGE="192.168.10.10,192.168.10.200"
APP_PORT="3000"
APP_DIR="/home/pi/piso-wifi"

echo "===== Piso WiFi Raspberry Pi Setup ====="
echo "SSID:       $SSID"
echo "Gateway IP: $GATEWAY_IP"
echo ""

# ── 1. Install system packages ─────────────────────────────────────────────────

apt-get update
apt-get install -y curl wget git hostapd dnsmasq iptables-persistent

# Install Node.js 20 LTS via NodeSource (official, works on Pi ARM)
if ! command -v node &>/dev/null || [[ $(node -v | cut -d. -f1 | tr -d 'v') -lt 18 ]]; then
  echo "Installing Node.js 20 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "Node.js version: $(node -v)"
echo "npm version:     $(npm -v)"

# ── 2. Stop & disable services while configuring ─────────────────────────────

systemctl stop hostapd dnsmasq || true
systemctl unmask hostapd

# ── 3. Assign static IP to wlan0 ─────────────────────────────────────────────
# Works on Pi OS Bullseye (dhcpcd) and Bookworm (NetworkManager)

if systemctl is-active --quiet NetworkManager; then
  echo "Using NetworkManager for static IP..."
  nmcli con add type wifi ifname wlan0 con-name pisowifi-ap autoconnect yes \
    ssid "$SSID" 802-11-wireless.mode ap 802-11-wireless.band bg \
    ipv4.method shared ipv4.addresses "${GATEWAY_IP}/24" || true
else
  # dhcpcd method (Bullseye and older)
  if ! grep -q "interface wlan0" /etc/dhcpcd.conf; then
    cat >> /etc/dhcpcd.conf << EOF

interface wlan0
    static ip_address=${GATEWAY_IP}/24
    nohook wpa_supplicant
EOF
  fi
fi

# ── 4. Configure dnsmasq (DHCP + DNS for customers) ──────────────────────────

mv /etc/dnsmasq.conf /etc/dnsmasq.conf.bak 2>/dev/null || true

cat > /etc/dnsmasq.conf << EOF
interface=wlan0
dhcp-range=${DHCP_RANGE},255.255.255.0,24h
domain-needed
bogus-priv
# Captive portal: redirect all DNS to our gateway
address=/#/${GATEWAY_IP}
EOF

# ── 5. Configure hostapd (Access Point) ──────────────────────────────────────

cat > /etc/hostapd/hostapd.conf << EOF
interface=wlan0
driver=nl80211
ssid=${SSID}
hw_mode=g
channel=7
wmm_enabled=0
macaddr_acl=0
auth_algs=1
ignore_broadcast_ssid=0
wpa=2
wpa_passphrase=${WPA_PASS}
wpa_key_mgmt=WPA-PSK
wpa_pairwise=TKIP
rsn_pairwise=CCMP
EOF

echo 'DAEMON_CONF="/etc/hostapd/hostapd.conf"' > /etc/default/hostapd

# ── 6. Enable IP forwarding ───────────────────────────────────────────────────

sed -i 's/#net.ipv4.ip_forward=1/net.ipv4.ip_forward=1/' /etc/sysctl.conf
sysctl -w net.ipv4.ip_forward=1

# ── 7. iptables — NAT and captive portal rules ────────────────────────────────

# Flush old rules
iptables -F
iptables -t nat -F
iptables -t mangle -F

# NAT: share internet from eth0 to wlan0
iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE
iptables -A FORWARD -i eth0 -o wlan0 -m state --state RELATED,ESTABLISHED -j ACCEPT
iptables -A FORWARD -i wlan0 -o eth0 -j ACCEPT

# Captive portal: redirect ALL HTTP traffic to our portal
iptables -t nat -A PREROUTING -i wlan0 -p tcp --dport 80 \
  -j DNAT --to-destination ${GATEWAY_IP}:${APP_PORT}

# HTTPS redirect notice (optional)
iptables -t nat -A PREROUTING -i wlan0 -p tcp --dport 443 \
  -j DNAT --to-destination ${GATEWAY_IP}:${APP_PORT}

# Block everything else by default (paid sessions get ACCEPT rules inserted dynamically)
iptables -I FORWARD 1 -i wlan0 -o eth0 -j DROP

# Save rules
netfilter-persistent save

# ── 8. Install Node.js app dependencies ──────────────────────────────────────

cd "$APP_DIR"
npm install
node scripts/setup-db.js

# ── 9. Create systemd service ─────────────────────────────────────────────────

NODE_BIN=$(which node)

cat > /etc/systemd/system/pisowifi.service << EOF
[Unit]
Description=Piso WiFi Captive Portal
After=network.target hostapd.service dnsmasq.service
Wants=hostapd.service dnsmasq.service

[Service]
WorkingDirectory=${APP_DIR}
ExecStart=${NODE_BIN} ${APP_DIR}/server.js
Restart=always
RestartSec=5
Environment=PORT=${APP_PORT}
Environment=GATEWAY_IP=${GATEWAY_IP}
Environment=NODE_ENV=production
StandardOutput=journal
StandardError=journal
SyslogIdentifier=pisowifi
User=root

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable pisowifi

# ── 10. Start everything ──────────────────────────────────────────────────────

# Restart network stack safely
if systemctl is-active --quiet NetworkManager; then
  systemctl restart NetworkManager
else
  systemctl restart dhcpcd || true
fi

systemctl start hostapd
systemctl start dnsmasq
systemctl start pisowifi

echo ""
echo "===== Setup Complete! ====="
echo "WiFi SSID:     $SSID"
echo "WiFi Password: $WPA_PASS"
echo "Portal:        http://${GATEWAY_IP}:${APP_PORT}/portal"
echo "Admin:         http://${GATEWAY_IP}:${APP_PORT}/admin"
echo "Admin login:   admin / admin1234"
echo ""
echo "⚠️  IMPORTANT: Change the admin password and WiFi password!"
