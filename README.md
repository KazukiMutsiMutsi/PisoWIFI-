# TechPiso WiFi

Full-featured Piso WiFi + Eload vending system for **Orange Pi PC** running Armbian.

---

## Features

- Captive portal — customers insert coins and get internet time
- Coin slot reads directly from Orange Pi GPIO (no Arduino needed)
- Eload vending — customers buy Globe, Smart, TNT, DITO load directly at the machine
- Admin dashboard — sessions, transactions, rates, eload stock & orders
- SQLite database (no MySQL needed) — survives reboots with file-based persistence
- iptables-based MAC filtering — only paid devices get internet access

---

## Hardware Setup

```
ISP Modem/Router
       │  (Ethernet cable)
       │
  [eth0 / end0]
  Orange Pi PC
  [wlan0 / wlan1]  ←── USB WiFi adapter (plug into Orange Pi USB port)
       │
  (Hotspot 192.168.10.x)
       │
  Customer devices
```

### What you need

| Part | Notes |
|------|-------|
| Orange Pi PC | Any Armbian image (Bookworm recommended) |
| USB WiFi adapter | RT8188 or MT7601 chipsets work great on Armbian |
| Ethernet cable | Connects Orange Pi to your ISP router |
| Coin slot sensor | CH-926 or similar, 5V pulse-per-coin type |
| Relay module | Controls power cut-off (driven by the buck converter board) |
| Buck converter | Steps down voltage for the relay / coin slot circuit |
| Power supply | 5V 3A for Orange Pi |

### Coin slot wiring (direct to Orange Pi 40-pin header)

No Arduino or NodeMCU needed — the coin slot signal wire connects straight to the Orange Pi GPIO header.

```
Orange Pi PC 40-pin header
──────────────────────────────────
Pin  2  (5V)   →  Coin Slot VCC
Pin  6  (GND)  →  Coin Slot GND
Pin 11  (PA0)  →  Coin Slot SIGNAL / OUT
──────────────────────────────────
```

Pin 11 = PA0 = sysfs GPIO 0. If you use a different pin, update `COIN_GPIO` in `scripts/coin-slot.py`.

The Python script `scripts/coin-slot.py` runs on the Orange Pi itself, counts the pulses, and calls the local Node.js server — no external board needed.

---

## Installation (Orange Pi / Armbian)

### Step 1 — Copy files to the Orange Pi

From your Windows PC:

```powershell
# SCP (Armbian default user is 'orangepi' or 'root')
scp -r "C:\Users\PEREZ\Downloads\TechPiso" orangepi@<PI_IP>:/home/orangepi/piso-wifi
```

Or via USB drive:
1. Copy the folder to a USB drive
2. Plug into Orange Pi
3. `cp -r /media/usb/TechPiso /home/orangepi/piso-wifi`

### Step 2 — Run the setup script

```bash
sudo bash /home/orangepi/piso-wifi/scripts/setup-orangepi.sh
```

This script:
- Installs Node.js 20 LTS, hostapd, dnsmasq, Python 3 + GPIO library
- Configures the USB WiFi adapter as a hotspot (`TechPiso WiFi`)
- Sets up NAT and iptables captive portal rules
- Creates the SQLite database with default rates and admin account
- Installs two systemd services that auto-start on boot:
  - `pisowifi` — the Node.js web server
  - `pisowifi-coin` — the Python GPIO coin slot reader

### Step 3 — Access the admin panel

From any device connected to `TechPiso WiFi`:

```
Admin:  http://192.168.10.1:3000/admin
Login:  admin / admin1234   ← CHANGE THIS after first login
```

---

## Default Rates

| Coins | Time |
|-------|------|
| ₱1 | 15 minutes |
| ₱5 | 90 minutes |
| ₱10 | 3 hours 20 minutes |
| ₱20 | 8 hours |

Change rates at **Admin → Rates**.

---

## Eload Vending

Customers go to `http://192.168.10.1:3000/eload`, pick a network + load amount, enter their phone, and the order appears in the admin panel. You manually send via GCash / Load Central, then mark it done.

**Restock your eload balance** at Admin → Eload Vending → Restock.  
The system warns you when balance drops below ₱100.

---

## Useful Commands (on Orange Pi)

```bash
# View live app logs
journalctl -u pisowifi -f

# View coin slot logs
journalctl -u pisowifi-coin -f

# Restart app
systemctl restart pisowifi

# Check hotspot status
systemctl status hostapd

# Check DHCP / DNS
systemctl status dnsmasq

# See connected clients
iw dev wlan0 station dump   # or wlan1

# Manual DB backup
cp /home/orangepi/piso-wifi/data/pisowifi.db ~/pisowifi.db.bak
```

---

## File Structure

```
TechPiso/
├── server.js                  Main Express app
├── package.json
├── lib/
│   ├── db.js                  SQLite wrapper (sql.js, pure WASM)
│   └── session-manager.js     WiFi session + iptables control
├── routes/
│   ├── portal.js              Customer captive portal
│   ├── api.js                 REST API (coin endpoint)
│   ├── admin.js               Admin dashboard
│   └── eload.js               Eload vending portal
├── views/                     EJS templates
│   ├── portal.ejs
│   ├── eload-portal.ejs
│   ├── eload-receipt.ejs
│   └── admin/
├── public/css/
│   ├── portal.css
│   └── admin.css
├── scripts/
│   ├── setup-orangepi.sh      ← Orange Pi / Armbian setup (run this)
│   ├── setup-pi.sh            (Raspberry Pi version, kept for reference)
│   ├── setup-db.js            DB initializer (called by setup script)
│   └── coin-slot.py           GPIO coin slot reader (runs on Orange Pi)
└── data/
    └── pisowifi.db            SQLite database (auto-created)
```

---

## Security Checklist

- [ ] Change admin password at `/admin/settings`
- [ ] Change `WPA_PASS` in `setup-orangepi.sh` and reconfigure hostapd
- [ ] Change `API_KEY` in the systemd service file (`/etc/systemd/system/pisowifi.service`) and in `scripts/coin-slot.py`
- [ ] Change `SESSION_SECRET` in the systemd service file
