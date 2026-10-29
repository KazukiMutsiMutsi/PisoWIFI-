#!/usr/bin/env python3
"""
coin-slot.py — Reads coin slot pulses from Orange Pi PC GPIO
and POSTs the coin count to the local Piso WiFi server.

Runs ON the Orange Pi itself. No Arduino/NodeMCU needed.

WIRING (Orange Pi PC 40-pin header):
┌─────────────────────┬───────────────────────────────┐
│  Coin Slot Wire     │  Orange Pi PC Pin             │
├─────────────────────┼───────────────────────────────┤
│  VCC (5V)           │  Pin 2 or Pin 4  (5V)        │
│  GND                │  Pin 6  (GND)                 │
│  SIGNAL / OUT       │  Pin 11 (physical)            │
└─────────────────────┴───────────────────────────────┘

Install dependencies:
  pip3 install OPi.GPIO requests

Run manually:
  sudo python3 scripts/coin-slot.py

Auto-started on boot by the pisowifi-coin systemd service.
"""

import time
import subprocess
import threading
import signal
import sys
import collections

try:
    import OPi.GPIO as GPIO
except ImportError:
    print("ERROR: OPi.GPIO not installed. Run:  pip3 install OPi.GPIO")
    sys.exit(1)

try:
    import requests
except ImportError:
    print("ERROR: requests not installed. Run:  pip3 install requests")
    sys.exit(1)

# ── Configuration ─────────────────────────────────────────────────────────────

# Physical board pin number (BOARD mode).
# Pin 11 = PA0 on Orange Pi PC 40-pin header.
COIN_PIN     = 11           # physical board pin

SERVER_URL   = "http://127.0.0.1:3000/api/coin"
API_KEY      = "piso-api-key-2024"   # must match server API_KEY env var

DEBOUNCE_S   = 0.06         # 60 ms debounce between pulses
IDLE_SEND_S  = 3.0          # wait 3 s after last pulse before sending
RETRY_LIMIT  = 5            # max retry attempts for failed HTTP POST
RETRY_DELAY  = 4.0          # seconds between retries

# ── Get this machine's real MAC from the WiFi interface ───────────────────────
# This MAC is what iptables will ACCEPT, so it MUST be the interface
# the customer's traffic actually comes through on the hotspot.
# The AP is on wlan0 or wlan1 — we read it directly from the system.

def get_ap_mac():
    for iface in ('wlan1', 'wlan0'):
        try:
            out = subprocess.check_output(
                ['cat', f'/sys/class/net/{iface}/address'],
                stderr=subprocess.DEVNULL
            ).decode().strip().upper()
            if out and ':' in out:
                print(f"  Using MAC from {iface}: {out}")
                return out
        except Exception:
            pass
    # Fallback — should not happen
    print("  WARNING: Could not read MAC from wlan0/wlan1. Using fallback.")
    return "AA:BB:CC:00:00:01"

# ── State ─────────────────────────────────────────────────────────────────────

_lock       = threading.Lock()
_coin_count = 0
_last_pulse = 0.0
_retry_q    = collections.deque()   # (coins, attempts) tuples pending retry

# ── GPIO callback ─────────────────────────────────────────────────────────────

def on_coin_pulse(channel):
    global _coin_count, _last_pulse
    now = time.monotonic()
    with _lock:
        if now - _last_pulse > DEBOUNCE_S:
            _coin_count += 1
            _last_pulse  = now
            print(f"  Coin pulse — total pending: {_coin_count}")

# ── HTTP POST to server ───────────────────────────────────────────────────────

def send_coins(coins: int, mac: str) -> bool:
    payload = {"mac": mac, "coins": coins}
    headers = {"x-api-key": API_KEY, "Content-Type": "application/json"}
    try:
        resp = requests.post(SERVER_URL, json=payload, headers=headers, timeout=8)
        if resp.status_code == 200:
            data = resp.json()
            mins = data.get('minutes_added', '?')
            sid  = str(data.get('session_id', '?'))[:8]
            print(f"  ✅ Sent {coins} coin(s) — +{mins} min  session={sid}…")
            return True
        else:
            print(f"  ❌ Server HTTP {resp.status_code}: {resp.text[:100]}")
            return False
    except requests.exceptions.ConnectionError:
        print("  ❌ Connection refused — is the Node.js server running?")
        return False
    except requests.exceptions.Timeout:
        print("  ❌ Request timed out")
        return False
    except Exception as e:
        print(f"  ❌ Unexpected error: {e}")
        return False

# ── Graceful shutdown ─────────────────────────────────────────────────────────

def shutdown(sig, frame):
    print("\nShutting down coin slot reader...")
    try:
        GPIO.cleanup()
    except Exception:
        pass
    sys.exit(0)

signal.signal(signal.SIGINT,  shutdown)
signal.signal(signal.SIGTERM, shutdown)

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    global _coin_count, _last_pulse

    print("=== TechPiso Coin Slot Reader ===")
    mac = get_ap_mac()
    print(f"  GPIO pin : physical board pin {COIN_PIN}")
    print(f"  Server   : {SERVER_URL}")
    print(f"  MAC      : {mac}")
    print("")

    # Use BOARD mode (physical pin numbers) — reliable on all Orange Pi variants
    GPIO.setmode(GPIO.BOARD)
    GPIO.setup(COIN_PIN, GPIO.IN, pull_up_down=GPIO.PUD_UP)
    GPIO.add_event_detect(
        COIN_PIN,
        GPIO.FALLING,
        callback=on_coin_pulse,
        bouncetime=int(DEBOUNCE_S * 1000)
    )

    print(f"Listening for coins on pin {COIN_PIN}... (Ctrl+C to stop)\n")

    while True:
        time.sleep(0.1)

        # ── Drain retry queue first ────────────────────────────────────────
        if _retry_q:
            item = _retry_q[0]
            if time.monotonic() - item['last_try'] >= RETRY_DELAY:
                print(f"  Retrying {item['coins']} coin(s)  attempt {item['attempts']+1}/{RETRY_LIMIT}")
                ok = send_coins(item['coins'], mac)
                if ok:
                    _retry_q.popleft()
                else:
                    item['attempts'] += 1
                    item['last_try']  = time.monotonic()
                    if item['attempts'] >= RETRY_LIMIT:
                        print(f"  ⚠️  Giving up on {item['coins']} coin(s) after {RETRY_LIMIT} attempts")
                        _retry_q.popleft()
            continue   # process one retry per loop tick

        # ── Send accumulated coins after idle window ───────────────────────
        with _lock:
            count     = _coin_count
            last_time = _last_pulse

        if count > 0 and (time.monotonic() - last_time) >= IDLE_SEND_S:
            with _lock:
                coins_to_send = _coin_count
                _coin_count   = 0

            print(f"Sending {coins_to_send} coin(s) to server...")
            ok = send_coins(coins_to_send, mac)
            if not ok:
                print(f"  Queuing {coins_to_send} coin(s) for retry...")
                _retry_q.append({
                    'coins':    coins_to_send,
                    'attempts': 1,
                    'last_try': time.monotonic(),
                })

if __name__ == "__main__":
    main()
