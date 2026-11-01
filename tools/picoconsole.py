#!/usr/bin/env python3
"""The bridge's USB console, shared: holds the Pico's serial port (found by its USB serial number,
so another USB serial device can't be picked by mistake), reconnects across resets, writes every
line with a timestamp to a log, and serves the console on 127.0.0.1:PORT so several terminals
(nc 127.0.0.1 7001) can watch and type at once.

  python3 tools/picoconsole.py [--serial 8E1B06B170BE8676] [--port 7001] [--log logs/pico-console.log]
"""
import argparse, glob, os, select, socket, subprocess, sys, time
import serial

ap = argparse.ArgumentParser()
ap.add_argument('--serial', default=None, help='the Pico\'s USB serial number (default: the first Raspberry Pi device)')
ap.add_argument('--port', type=int, default=7001)
ap.add_argument('--log', default=os.path.join(os.path.dirname(__file__), '..', 'logs', 'pico-console.log'))
args = ap.parse_args()
os.makedirs(os.path.dirname(os.path.abspath(args.log)), exist_ok=True)
log = open(args.log, 'a', buffering=1)
bol = True

def logw(text):
    global bol
    for ch in text:
        if bol:
            log.write(time.strftime('[%H:%M:%S] ')); bol = False
        log.write(ch)
        if ch == '\n': bol = True

def find_port():
    # ioreg: the Raspberry Pi device (vendor 0x2e8a) with the serial number asked for -> its callout device
    # (the callout device sits in a child node, the CDC interface, listed after the device's own keys)
    out = subprocess.run(['ioreg', '-r', '-c', 'IOUSBHostDevice', '-l', '-w0'], capture_output=True, text=True).stdout
    lines = out.splitlines()
    want = ('"USB Serial Number" = "%s"' % args.serial) if args.serial else '"idVendor" = 11914'
    for i, line in enumerate(lines):
        if want not in line: continue
        for later in lines[i + 1:]:
            if '"IOCalloutDevice"' in later:
                return later.split('"')[3]
            if '"USB Serial Number"' in later and args.serial and args.serial not in later:
                break   # into another device without finding one
    return None

srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(('127.0.0.1', args.port)); srv.listen(4)
clients = []
ser = None

def broadcast(b):
    for c in clients[:]:
        try: c.sendall(b)
        except OSError: clients.remove(c)

while True:
    if ser is None:
        p = find_port()
        if p:
            try:
                ser = serial.Serial(p, 115200, timeout=0)
                ser.dtr = True
                msg = '\n--- console connected %s ---\n' % p
                logw(msg); broadcast(msg.encode())
            except (OSError, serial.SerialException):
                ser = None
    rl = [srv] + clients + ([ser] if ser else [])
    try:
        r, _, _ = select.select(rl, [], [], 0.2)
    except (OSError, ValueError):
        r = []
    for x in r:
        if x is srv:
            c, _ = srv.accept(); clients.append(c)
            c.sendall(b'--- bridge console (type commands; "help" lists them) ---\r\n')
        elif x is ser:
            try:
                d = ser.read(4096)
            except (OSError, serial.SerialException):
                d = None
            if d is None:
                msg = '\n--- console lost (the Pico reset or was unplugged) ---\n'
                logw(msg); broadcast(msg.encode())
                try: ser.close()
                except Exception: pass
                ser = None; time.sleep(0.5); continue
            if d:
                logw(d.decode('latin1').replace('\r', '')); broadcast(d)
        else:
            try: d = x.recv(1024)
            except OSError: d = b''
            if not d:
                clients.remove(x); continue
            if ser:
                try: ser.write(d.replace(b'\n', b'\r') if b'\r' not in d else d)
                except (OSError, serial.SerialException): pass
