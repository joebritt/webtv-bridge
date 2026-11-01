#!/usr/bin/env python3
"""Saleae Logic 2 captures of the WebTV parallel port, and decoders for them: PARMOD (what the
bridge speaks, with the boot ROM's dongle probe and its 19200 diagnostics console) and the
bridge's walk pattern.

  lptscope.py devices                         list analyzers (Logic 2 must be running with
                                              automation on, or pass --launch)
  lptscope.py capture [options]               capture, export digital.csv + capture.sal, analyze
  lptscope.py analyze DIR|digital.csv [--walk]
                                              decode a capture that is already exported (or a
                                              trace from the emulator: run.mjs --pico --pico-trace)
  lptscope.py console "status"                send one command to the bridge's USB console
  lptscope.py selftest                        check the decoders on made-up traces

Capture options:
  --profile parmod|hs8|walk16  which signal is on which Saleae channel (see PROFILES)
  --map "0=nStrobe,1=Busy,.."  your own wiring instead
  --rate 50e6                  digital sample rate (must be one Logic 2 offers for the device)
  --seconds 5                  timed capture length; with --trigger, seconds after the trigger
  --trigger nInit:falling      start on an edge of a named signal (rising|falling)
  --send walk                  after the capture starts, send this to the bridge console
  --port /dev/cu.usbmodemXXXX  the bridge's USB console (default: the only usbmodem)
  --threshold 3.3              Logic Pro only: 1.2, 1.8 or 3.3 V (3.3 for the 5 V cable)
  --sim                        use Logic 2's simulated device (to test this script)
  --launch                     start Logic 2 ourselves instead of connecting to it
  --out DIR                    where to put the capture (default captures/<time>)

Probe the cable side at J2 on Tom Verbeure's parallel2usb board (both revisions):
  J2 pin  3 Select   4 PError  5 Busy    6 nAck    7 D7     8 D6     9 D5    10 D4
         11 D3      12 nSelIn 13 D2     14 nInit  15 D1    16 nFault 17 D0  18 nAutoFd
         19 nStrobe 20 GND     (pin 1 is +5 V and pin 2 is +3.3 V: no ground clips there)
The bridge's debug strobes are on the Pico's GP26 (dbg0) and GP27 (dbg1), 3.3 V.

Requires: pip install logic2-automation  (see tools/saleae/README.md)
"""
import argparse
import bisect
import csv
import glob
import os
import statistics
import sys
import time
from datetime import datetime

SIGNALS = ["nStrobe", "nAutoFd", "nInit", "nSelectIn", "nAck", "Busy", "PError", "Select", "nFault",
           "D0", "D1", "D2", "D3", "D4", "D5", "D6", "D7", "dbg0", "dbg1", "DIR"]

PROFILES = {
    # PARMOD: the data, the four code/strobe lines, and the answers (Busy, Select) plus nAck and
    # nFault; not PError (only says "in a session" in PARMOD; in the dongle it mirrors D2)
    "parmod": ["D0", "D1", "D2", "D3", "D4", "D5", "D6", "D7",
              "nStrobe", "nAutoFd", "nInit", "nSelectIn", "Busy", "Select", "nAck", "nFault"],
    # handshakes only (Logic 8): timing, no data bytes
    "hs8": ["nStrobe", "nAutoFd", "nInit", "nSelectIn", "nAck", "Busy", "PError", "nFault"],
    # the bridge's outputs, for the walk test (link.h), plus dbg0 and nStrobe
    "walk16": ["nAck", "Busy", "PError", "Select", "nFault", "D0", "D1", "D2", "D3", "D4", "D5", "D6", "D7",
               "dbg0", "dbg1", "nStrobe"],
}

# the walk (src/link.h): line k gets k+1 pulses, in this order
WALK_ORDER = ["nAck", "Busy", "PError", "Select", "nFault", "D0", "D1", "D2", "D3", "D4", "D5", "D6", "D7"]
WALK_IDLE = {"nAck": 1, "Busy": 0, "PError": 0, "Select": 1, "nFault": 1}   # data lines: 0 while DIR = 1
WALK_MAX_PULSE = 20e-6      # pulses are 2 us; anything shorter than this counts
WALK_GAP = 50e-6            # lines are 100 us apart

# the bridge's timing settings (pico/src/bridge_config.h), to compare against
ACK_PULSE = 2e-6            # LINK_ACK_PULSE_CYCLES


# ------------------------------------------------------------------ channel maps

def parse_map(text):
    m = {}
    for part in text.split(","):
        ch, name = part.split("=")
        name = name.strip()
        if name not in SIGNALS:
            sys.exit(f"unknown signal {name!r}; known: {', '.join(SIGNALS)}")
        m[int(ch)] = name
    return m


def profile_map(args):
    if args.map:
        return parse_map(args.map)
    return dict(enumerate(PROFILES[args.profile]))


# ------------------------------------------------------------------ reading digital.csv

class Trace:
    """Transitions per named signal: times[] and the level from each time on."""

    def __init__(self, path, chmap=None):
        self.edges = {}       # name -> list of (time, level)
        self.order = []       # (time, name, level, first) in file order
        with open(path, newline="") as f:
            rd = csv.reader(f)
            header = next(rd)
            cols = []
            for i, h in enumerate(header[1:]):
                h = h.strip()
                name = h if h in SIGNALS else None
                if name is None and h.startswith("Channel ") and chmap is not None:
                    name = chmap.get(int(h.split()[1]))
                if name is None and chmap is not None and h.isdigit():
                    name = chmap.get(int(h))
                cols.append(name)
            last = [None] * len(cols)
            for row in rd:
                if not row:
                    continue
                t = float(row[0])
                for i, name in enumerate(cols):
                    if name is None:
                        continue
                    v = int(row[i + 1])
                    if v != last[i]:
                        self.edges.setdefault(name, []).append((t, v))
                        self.order.append((t, name, v, last[i] is None))
                        last[i] = v
        self.names = [n for n in cols if n]
        self.start = min((e[0][0] for e in self.edges.values()), default=0.0)
        self.end = max((e[-1][0] for e in self.edges.values()), default=0.0)

    def has(self, *names):
        return all(n in self.edges for n in names)

    def events(self):
        """All changes in file order (which is time order, and keeps changes that share a
        sample in the order they were written): (time, name, level, first sample)."""
        return self.order


# ------------------------------------------------------------------ the walk test

def analyze_walk(tr):
    ok = True
    print("walk test (src/link.h): each line should show its own number of short pulses")
    print(f"  {'line':10} {'idle':>4} {'pulses':>6}  {'looks like':12} result")
    expected = {name: k + 1 for k, name in enumerate(WALK_ORDER)}
    by_count = {v: k for k, v in expected.items()}
    found = {}
    for name in tr.names:
        e = tr.edges[name]
        pulses, pol = count_pulses(e)
        idle = e[0][1]
        found[name] = (idle, pulses, pol)
    for name in tr.names:
        idle, pulses, pol = found[name]
        if name not in expected:
            print(f"  {name:10} {idle:>4} {pulses:>6}  {'':12} (not a walked line)")
            continue
        want = expected[name]
        looks = by_count.get(pulses, "?")
        want_idle = WALK_IDLE.get(name)
        notes = []
        if pulses != want:
            notes.append(f"expected {want} pulses: this channel carries {looks}" if looks != "?" else f"expected {want}")
        if name in WALK_IDLE and pol is not None and pol == want_idle:
            notes.append("pulses go the wrong way: inverted?")
        if name in WALK_IDLE and idle != want_idle:
            notes.append(f"idles at {idle}, expected {want_idle}")
        if name.startswith("D") and pulses == 0:
            notes.append("no data pulses: is DIR reaching the 161284?")
        res = "OK" if not notes else "; ".join(notes)
        ok = ok and not notes
        print(f"  {name:10} {idle:>4} {pulses:>6}  {looks:12} {res}")
    missing = [n for n in WALK_ORDER if n not in found]
    if missing:
        print(f"  not captured: {', '.join(missing)}")
    print("PASS" if ok else "FAIL")
    return ok


def count_pulses(e):
    """Short excursions (< WALK_MAX_PULSE) in the direction of the first one; the short gaps
    between them go the other way and don't count. Returns (count, level during a pulse)."""
    n, pol = 0, None
    for (t0, v), (t1, _) in zip(e[1:], e[2:]):
        if t1 - t0 < WALK_MAX_PULSE:
            if pol is None:
                pol = v
            if v == pol:
                n += 1
    return n, pol


# ------------------------------------------------------------------ timing statistics

def stats_line(label, xs, unit=1e-9, uname="ns"):
    if not xs:
        return f"  {label:34} -"
    xs = sorted(xs)
    p = lambda q: xs[min(len(xs) - 1, int(q * len(xs)))]
    return (f"  {label:34} n={len(xs):<7} min {xs[0] / unit:9.0f}  median {statistics.median(xs) / unit:9.0f}  "
            f"p99 {p(0.99) / unit:9.0f}  max {xs[-1] / unit:9.0f} {uname}")


class DataLines:
    """D0-D7 as one timeline of (time, byte), for lookups by time."""

    def __init__(self, tr):
        self.ok = tr.has(*[f"D{i}" for i in range(8)])
        self.t, self.v = [], []
        if not self.ok:
            return
        ev = sorted((t, i, v) for i in range(8) for t, v in tr.edges[f"D{i}"])
        b = 0
        for t, i, v in ev:
            b = (b & ~(1 << i)) | (v << i)
            if self.t and self.t[-1] == t:
                self.v[-1] = b
            else:
                self.t.append(t)
                self.v.append(b)
        self.first = self.t[0] if self.t else 0.0

    def at(self, t):
        k = bisect.bisect_right(self.t, t) - 1
        return self.v[max(k, 0)] if self.v else None

    def last_change(self, t):
        """Latest change at or before t (not counting the capture's first sample)."""
        k = bisect.bisect_right(self.t, t) - 1
        return self.t[k] if k >= 1 else None

    def first_change(self, t0, t1):
        k = bisect.bisect_right(self.t, t0)
        return self.t[k] if k < len(self.t) and self.t[k] < t1 and k >= 1 else None


# ------------------------------------------------------------------ PARMOD decode (WEBTV_LPT_BRIDGE.md §4.1)

PM_CODES = {7: "IDLE", 5: "CTRL_OUT", 4: "CTRL_IN", 3: "MODEM_OUT", 2: "MODEM_IN", 1: "CON_OUT", 6: "CON_IN", 0: "000"}
PM_OUT = {"CTRL_OUT", "MODEM_OUT", "CON_OUT"}
PM_SIG = b"LPT2"
PM_CMDS = {1: "MODEM_RESET", 2: "DTR_ON", 3: "DTR_OFF", 4: "LEGACY_ECP", 5: "EXIT", 6: "REBOOT"}
PM_ST = [(1, "modem"), (2, "con-in"), (4, "reply"), (8, "carrier"), (16, "mfull"), (32, "client")]
PROBE = (0xF1, 0xF2, 0xF4, 0xF8)
BAUD = 19200


class Lines:
    """The trace as rows: each distinct time once, with every line's level after it."""

    def __init__(self, tr):
        self.rows = []
        level = {}
        last_t = None
        for t, name, v, first in tr.events():
            if t != last_t:
                if last_t is not None:
                    self.rows.append((last_t, dict(level)))
                last_t = t
            level[name] = v
        if last_t is not None:
            self.rows.append((last_t, dict(level)))


def data_byte(lv):
    if not all(f"D{i}" in lv for i in range(8)):
        return None
    return sum(lv[f"D{i}"] << i for i in range(8))


def uart_decode(edges, t0, t1, idle=1):
    """19200 8N1 on a line given as (time, level) changes: the bytes that start in [t0, t1)."""
    bit = 1.0 / BAUD
    out = []
    times = [t for t, _ in edges]

    def level_at(t):
        k = bisect.bisect_right(times, t) - 1
        return edges[k][1] if k >= 0 else idle

    k = bisect.bisect_left(times, t0)
    while k < len(edges) and edges[k][0] < t1:
        t, v = edges[k]
        if v != idle and level_at(t - bit / 4) == idle:        # a start bit's edge
            if level_at(t + bit / 2) == idle:                  # back already: a glitch
                k += 1
                continue
            b = sum(level_at(t + (n + 1.5) * bit) << n for n in range(8))
            stop_ok = level_at(t + 9.5 * bit) == idle
            out.append((t, b, stop_ok))
            k = bisect.bisect_left(times, t + 9.6 * bit)
            continue
        k += 1
    return out


def analyze_parmod(tr, out_dir=None):
    need = ["nStrobe", "nAutoFd", "nInit", "nSelectIn", "Busy", "Select"]
    missing = [n for n in need if n not in tr.edges]
    if missing:
        print(f"can't decode PARMOD without {', '.join(missing)}")
        return None
    rows = Lines(tr).rows
    have_data = all(f"D{i}" in tr.edges for i in range(8))
    dl = DataLines(tr) if have_data else None
    st = dict(strobe_busy=[], rise_busy_fall=[], setup_box=[], strobe_low=[], ack_width=[], mirror=[])
    problems = []
    counts = {}
    streams = {"MODEM_OUT": [], "MODEM_IN": [], "CON_OUT": [], "CON_IN": [], "CTRL_OUT": [], "CTRL_IN": []}
    refused = 0
    status_bits = {}
    sessions, cmds, gave_up, sig, arg_for, in_session = 0, [], 0, 0, None, False
    slog = []                # per session: when it began, modem bytes each way
    pend = None              # the transaction under way: dict(t, code, out)
    rise_t = None
    # The boot ROM's probe after a reset is F1, then F2, F4, F8 while the status lines answer
    # (the dongle); with no answer it stops at F1. After a full run the ROM leaves F8 on the bus
    # through the diagnostics. A run that doesn't start with F1 is a byte floating beside the
    # idle code: the hazard the 0xFF rule prevents.
    probes, stray = [], []   # runs of probe bytes: starting with F1 (a reset), and otherwise
    run, run_last = [], 0.0  # the run being collected: (t, byte) when the byte changes
    pat, pat_t, answered = None, 0.0, False   # the pattern on the lines now, since when, mirrored yet
    attentions = 0
    prev = rows[0][1] if rows else {}
    ctrl4 = ("nStrobe", "nAutoFd", "nInit", "nSelectIn")
    last_strobe = -1.0

    run_strobe = [-1.0]     # the last strobe before the run began

    def keep(r):
        # a run with F1 is a reset (it may start from the F8 the boot ROM leaves on the bus through
        # its diagnostics); anything else matters only right after PARMOD traffic
        bs = [b for _, b in r]
        if 0xF1 in bs:
            probes.append(r[bs.index(0xF1):])
        elif r[0][0] - run_strobe[0] < 10e-3:
            stray.append(r)

    for t, lv in rows[1:]:
        fell = {n for n in lv if prev.get(n) == 1 and lv[n] == 0}
        rose = {n for n in lv if prev.get(n) == 0 and lv[n] == 1}
        d = data_byte(lv)
        # the boot ROM's dongle probe: four lines high, F1/F2/F4/F8 on the bus
        if d is not None and all(lv.get(n) == 1 for n in ctrl4) and d in PROBE:
            if run and t - run_last > 5e-3:
                keep(run)
                run = []
            run_last = t
            if not run:
                run_strobe[0] = last_strobe
            if d == 0xF1 and in_session:      # a box reset: whatever session there was is over
                in_session, sig, arg_for = False, 0, None
            if not run or run[-1][1] != d:
                run.append((t, d))
                pat, pat_t, answered = d, t, False
            exp = {"nAck": d & 1, "Busy": d >> 1 & 1, "PError": d >> 2 & 1, "nFault": d >> 3 & 1, "Select": d >> 3 & 1}
            if not answered and all(lv.get(n, e) == e for n, e in exp.items()):
                st["mirror"].append(t - pat_t)
                answered = True
        else:
            pat = None
        if "nStrobe" in fell:
            last_strobe = t
            code = (lv["nSelectIn"] << 2) | (lv["nInit"] << 1) | lv["nAutoFd"]
            name = PM_CODES[code]
            if prev.get("Busy"):
                problems.append((t, f"{name}: nStrobe fell while Busy was high"))
            out = d if name in PM_OUT else None
            if name in PM_OUT and dl is not None:
                lc = dl.last_change(t)
                if lc is not None:
                    st["setup_box"].append(t - lc)
            pend = dict(t=t, code=name, out=out, answered=False)
            if name in ("IDLE", "000"):
                problems.append((t, f"a strobe with code {name}"))
        if "Busy" in rose and pend and not pend["answered"]:
            pend["answered"] = True
            st["strobe_busy"].append(t - pend["t"])
            sel = lv["Select"]
            name = pend["code"]
            counts[name] = counts.get(name, 0) + 1
            if name in PM_OUT:
                b = pend["out"]
                if dl is not None and dl.first_change(pend["t"], t) is not None:
                    problems.append((t, f"{name}: data changed between nStrobe low and Busy high"))
                if name == "CTRL_OUT" and b is not None:
                    if in_session and arg_for is not None:
                        cmds.append((t, f"{PM_CMDS[arg_for]} 0x{b:02x}")); arg_for = None
                    elif b == PM_SIG[sig]:
                        sig += 1
                        if sig == 4:
                            sig = 0
                            if not in_session:
                                sessions += 1
                                slog.append(dict(t=t, out=0, inn=0))
                            in_session = True
                    else:
                        sig = 1 if b == PM_SIG[0] else 0
                        if in_session and sig == 0:
                            if b == 4:
                                arg_for = 4
                            else:
                                cmds.append((t, PM_CMDS.get(b, f"0x{b:02x}")))
                                if b == 5:
                                    in_session = False
                if name == "MODEM_OUT" and not sel:
                    refused += 1
                elif b is not None and (sel or name != "MODEM_OUT"):
                    streams[name].append(b)
                    if name == "MODEM_OUT" and slog:
                        slog[-1]["out"] += 1
            else:
                pend["in"] = d
                pend["sel"] = sel
                if sel and d is not None:
                    streams[name].append(d)
                    if name == "MODEM_IN" and slog:
                        slog[-1]["inn"] += 1
                elif not sel and d is not None:
                    for bit, label in PM_ST:
                        if d & bit:
                            status_bits[label] = status_bits.get(label, 0) + 1
        if "nStrobe" in rose:
            if pend:
                if t >= pend["t"]:
                    st["strobe_low"].append(t - pend["t"])
                if not pend["answered"]:
                    gave_up += 1
                elif pend["code"] not in PM_OUT and dl is not None and pend.get("in") is not None:
                    ch = dl.first_change(pend["t"], t)
                    if ch is not None and ch > pend["t"] and dl.at(t - 1e-9) != pend["in"]:
                        problems.append((ch, f"{pend['code']}: the bridge's byte changed before nStrobe rose"))
            rise_t = t if pend and pend["answered"] else None
            pend = None
        if "Busy" in fell and rise_t is not None:
            st["rise_busy_fall"].append(t - rise_t)
            rise_t = None
        if "nAck" in rose and "nAck" in prev:
            attentions += 1
            k = bisect.bisect_right([e[0] for e in tr.edges["nAck"]], t) - 2
            if k >= 0:
                st["ack_width"].append(t - tr.edges["nAck"][k][0])
        prev = lv
    if run:
        keep(run)
    # the diagnostics console, between each probe and the first strobe after it
    serial = []
    strobes = [e[0] for e in tr.edges["nStrobe"] if e[1] == 0]
    starts = [r[0][0] for r in probes]
    for j, prun in enumerate(probes):
        if [b for _, b in prun][:4] != list(PROBE):
            continue                                     # not answered: no diagnostics
        a = prun[3][0]
        k = bisect.bisect_right(strobes, a)
        b = min(strobes[k] if k < len(strobes) else tr.end + 1, starts[j + 1] if j + 1 < len(starts) else tr.end + 1)
        box = uart_decode(tr.edges["nSelectIn"], a, b)
        br = uart_decode(tr.edges["D7"], a, b) if "D7" in tr.edges else []
        serial.append((a, b, box, br))

    dur = tr.end - tr.start
    print(f"PARMOD decode: {dur:.3f} s of capture, channels: {', '.join(tr.names)}")
    full = sum(1 for r in probes if [b for _, b in r][:4] == list(PROBE))
    print(f"  box resets (the boot ROM's dongle probe): {len(probes)}, {full} answered by the mirror "
          f"(F1 F2 F4 F8), {len(probes) - full} let pass (F1 only); probe-like bytes otherwise: {len(stray)}")
    for r in probes:
        print(f"    {(r[0][0] - tr.start):10.6f} s  " + " ".join(f"{b:02X}" for _, b in r[:4]))
    for prun in stray[:5]:
        problems.append((prun[0][0], "probe-like byte beside the idle code: " + " ".join(f"{b:02X}" for _, b in prun[:8])
                         + " (the bridge would take it for a reset)"))
    print(f"  sessions entered {sessions}, transactions {sum(counts.values())} "
          f"({', '.join(f'{k} {v}' for k, v in sorted(counts.items()))}), box gave up {gave_up}")
    print(f"  modem: box->bridge {len(streams['MODEM_OUT'])} bytes ({refused} refused), bridge->box "
          f"{len(streams['MODEM_IN'])}; console: out {len(streams['CON_OUT'])}, in {len(streams['CON_IN'])}; "
          f"attentions (nAck pulses) {attentions}")
    for x in slog:
        print(f"    session from {(x['t'] - tr.start):10.6f} s: modem box->bridge {x['out']} bytes, bridge->box {x['inn']}")
    if status_bits:
        print("  status bytes (an _IN with nothing to give): " + ", ".join(f"{k} {v}" for k, v in status_bits.items()))
    if cmds:
        print("  commands: " + ", ".join(c for _, c in cmds[:30]) + (" ..." if len(cmds) > 30 else ""))
    for a, b, box, br in serial:
        def text(bs):
            return "".join(chr(c) if 32 <= c < 127 else {10: "\\n", 13: "\\r"}.get(c, ".") for _, c, _ in bs)
        bad = sum(1 for x in box + br if not x[2])
        print(f"  diagnostics console from {(a - tr.start):.3f} s: box -> bridge {len(box)} chars, bridge -> box {len(br)}"
              + (f", {bad} framing errors" if bad else ""))
        if box:
            t_ = text(box)
            print(f"    box:    {t_[:300]}{' ...' if len(t_) > 300 else ''}")
        if br:
            t_ = text(br)
            print(f"    bridge: {t_[:300]}{' ...' if len(t_) > 300 else ''}")
    print("timing:")
    print(stats_line("dongle probe -> mirror on the lines", st["mirror"]))
    print(stats_line("nStrobe low -> Busy high (answer)", st["strobe_busy"]))
    print(stats_line("nStrobe high -> Busy low (release)", st["rise_busy_fall"]))
    print(stats_line("data setup before nStrobe (box)", st["setup_box"]))
    print(stats_line("nStrobe low time (box)", st["strobe_low"]))
    print(stats_line("nAck pulse width", st["ack_width"]))
    if problems:
        print(f"problems: {len(problems)}")
        for t, msg in problems[:20]:
            print(f"  {(t - tr.start) * 1e6:14.3f} us  {msg}")
    else:
        print("problems: none")
    for name in ("MODEM_OUT", "MODEM_IN", "CON_OUT"):
        if streams[name]:
            head = bytes(streams[name][:48])
            txt = "".join(chr(c) if 32 <= c < 127 else "." for c in head)
            print(f"  {name} first bytes: {head.hex(' ')}\n  {'':19}{txt}")
    if out_dir:
        for name, fn in (("MODEM_OUT", "modem_box_to_bridge.bin"), ("MODEM_IN", "modem_bridge_to_box.bin"),
                         ("CON_OUT", "console_out.bin"), ("CON_IN", "console_in.bin")):
            with open(os.path.join(out_dir, fn), "wb") as f:
                f.write(bytes(streams[name]))
        print(f"  channel streams written to {out_dir}/modem_*.bin and console_*.bin")
    return dict(streams=streams, problems=problems, stats=st, sessions=sessions, cmds=cmds, probes=probes,
                stray=stray, serial=serial)


# ------------------------------------------------------------------ the bridge console

def find_console(port):
    if port:
        return port
    ports = sorted(glob.glob("/dev/cu.usbmodem*")) + sorted(glob.glob("/dev/ttyACM*"))
    if len(ports) != 1:
        sys.exit(f"pass --port: found {ports or 'no usbmodem ports'}")
    return ports[0]


def console_command(port, cmd, wait=1.0):
    import termios
    import tty
    fd = os.open(port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    try:
        tty.setraw(fd)
        attrs = termios.tcgetattr(fd)
        attrs[2] |= termios.CLOCAL
        termios.tcsetattr(fd, termios.TCSANOW, attrs)
        termios.tcflush(fd, termios.TCIFLUSH)
        os.write(fd, (cmd + "\r").encode())
        out, end = b"", time.time() + wait
        while time.time() < end:
            try:
                chunk = os.read(fd, 4096)
                if chunk:
                    out += chunk
                    continue
            except BlockingIOError:
                pass
            time.sleep(0.02)
        return out.decode(errors="replace")
    finally:
        os.close(fd)


# ------------------------------------------------------------------ Logic 2

def manager(args):
    try:
        from saleae import automation
    except ImportError:
        sys.exit("needs the Saleae automation library: see tools/saleae/README.md")
    if args.launch:
        return automation, automation.Manager.launch()
    try:
        return automation, automation.Manager.connect(port=args.grpc_port, connect_timeout_seconds=5)
    except Exception as e:
        sys.exit(f"can't reach Logic 2 on port {args.grpc_port} ({type(e).__name__}).\n"
                 "Open Logic 2 and turn on Preferences > Automation > Enable automation server, or pass --launch.")


def pick_device(automation, mgr, sim):
    devs = mgr.get_devices(include_simulation_devices=sim)
    devs = [d for d in devs if d.is_simulation == sim]
    if not devs:
        sys.exit("no Saleae device found" + ("" if sim else " (plug it in, or --sim for the simulated one)"))
    return devs[0]


def cmd_devices(args):
    automation, mgr = manager(args)
    with mgr:
        info = mgr.get_app_info()
        v = info.api_version
        print(f"Logic {info.app_version}, automation API {v.major}.{v.minor}.{v.patch}")
        for d in mgr.get_devices(include_simulation_devices=True):
            print(f"  {d.device_id}  {d.device_type.name}{'  (simulated)' if d.is_simulation else ''}")


def cmd_capture(args):
    chmap = profile_map(args)
    automation, mgr = manager(args)
    out = os.path.abspath(args.out or os.path.join("captures", datetime.now().strftime("%Y%m%d-%H%M%S")))
    os.makedirs(out, exist_ok=True)
    with mgr:
        dev = pick_device(automation, mgr, args.sim)
        pro = dev.device_type.name.startswith("LOGIC_PRO")
        channels = sorted(chmap)
        cfg = automation.LogicDeviceConfiguration(
            enabled_digital_channels=channels,
            digital_sample_rate=int(float(args.rate)),
            digital_threshold_volts=args.threshold if pro else None,
        )
        if args.trigger:
            sig, _, edge = args.trigger.partition(":")
            inv = {v: k for k, v in chmap.items()}
            if sig not in inv:
                sys.exit(f"trigger signal {sig} isn't in the channel map")
            mode = automation.DigitalTriggerCaptureMode(
                trigger_type=automation.DigitalTriggerType.RISING if edge == "rising" else automation.DigitalTriggerType.FALLING,
                trigger_channel_index=inv[sig], after_trigger_seconds=args.seconds)
        else:
            mode = automation.TimedCaptureMode(duration_seconds=args.seconds)
        cc = automation.CaptureConfiguration(capture_mode=mode, buffer_size_megabytes=args.buffer_mb)
        print(f"capturing on {dev.device_type.name} {dev.device_id}: {', '.join(f'{c}={chmap[c]}' for c in channels)}, "
              f"{float(args.rate) / 1e6:g} MS/s")
        with mgr.start_capture(device_id=dev.device_id, device_configuration=cfg, capture_configuration=cc) as cap:
            if args.send:
                time.sleep(0.3)
                port = find_console(args.port)
                print(f"> {args.send}  ({port})")
                print(console_command(port, args.send).rstrip())
            if args.trigger:
                print("waiting for the trigger ...")
            cap.wait()
            cap.export_raw_data_csv(directory=out, digital_channels=channels)
            cap.save_capture(filepath=os.path.join(out, "capture.sal"))
    with open(os.path.join(out, "channels.txt"), "w") as f:
        f.write(",".join(f"{c}={chmap[c]}" for c in channels) + "\n")
    print(f"saved {out}/digital.csv and capture.sal (opens in Logic 2)")
    run_analysis(os.path.join(out, "digital.csv"), chmap, walk=args.walk or args.send == "walk", out_dir=out)


def run_analysis(path, chmap, walk, out_dir):
    tr = Trace(path, chmap)
    if not tr.names:
        sys.exit("no known signals in the capture: pass --map or --profile")
    if walk:
        return analyze_walk(tr)
    r = analyze_parmod(tr, out_dir=out_dir)
    return r is not None and not r["problems"]


def cmd_analyze(args):
    path = args.path
    if os.path.isdir(path):
        path = os.path.join(path, "digital.csv")
    chmap = None
    saved = os.path.join(os.path.dirname(path), "channels.txt")
    if args.map or args.profile_given:
        chmap = profile_map(args)
    elif os.path.exists(saved):
        chmap = parse_map(open(saved).read().strip())
    else:
        chmap = dict(enumerate(PROFILES[args.profile]))
    ok = run_analysis(path, chmap, args.walk, os.path.dirname(path) or ".")
    sys.exit(0 if ok else 1)


def cmd_console(args):
    print(console_command(find_console(args.port), args.command, args.wait).rstrip())


# ------------------------------------------------------------------ self-test

def cmd_selftest(args):
    import tempfile
    d = tempfile.mkdtemp()
    # 1. the walk, as link_walk() produces it, with 10 ns samples' worth of jitter ignored
    names = WALK_ORDER + ["nStrobe"]
    state = {n: WALK_IDLE.get(n, 1) for n in names}   # data lines idle high (pull-ups)
    rows, t = [], 0.0
    def emit():
        rows.append([f"{t:.9f}"] + [str(state[n]) for n in names])
    emit()
    t += 200e-6
    for k, n in enumerate(WALK_ORDER):
        if n == "D0":
            for i in range(8):
                state[f"D{i}"] = 0
            emit(); t += 100e-6
        idle = state[n]
        for _ in range(k + 1):
            state[n] = 1 - idle; emit(); t += 2e-6
            state[n] = idle; emit(); t += 2e-6
        t += 100e-6
    for i in range(8):
        state[f"D{i}"] = 1
    emit()
    p = os.path.join(d, "walk.csv")
    with open(p, "w") as f:
        f.write("Time [s]," + ",".join(names) + "\n")
        for r in rows:
            f.write(",".join(r) + "\n")
    print("--- walk, wired right")
    ok1 = analyze_walk(Trace(p))
    # 2. swap two lines: the decoder has to notice
    with open(p) as f:
        lines = f.read().splitlines()
    hdr = lines[0].split(",")
    i, j = hdr.index("Busy"), hdr.index("D3")
    hdr[i], hdr[j] = hdr[j], hdr[i]
    p2 = os.path.join(d, "walk_swapped.csv")
    with open(p2, "w") as f:
        f.write(",".join(hdr) + "\n" + "\n".join(lines[1:]) + "\n")
    print("--- walk, Busy and D3 swapped (should FAIL)")
    ok2 = not analyze_walk(Trace(p2))
    print(f"selftest: walk {'ok' if ok1 else 'BROKEN'}, swap detection {'ok' if ok2 else 'BROKEN'}")
    print("for the PARMOD decoder: node tools/run.mjs ... --pico --pico-trace t.csv (pico/README.md) && "
          "lptscope.py analyze t.csv")
    sys.exit(0 if ok1 and ok2 else 1)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--grpc-port", type=int, default=10430)
    ap.add_argument("--launch", action="store_true")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("devices")
    c = sub.add_parser("capture")
    a = sub.add_parser("analyze")
    a.add_argument("path")
    for p in (c, a):
        p.add_argument("--profile", choices=sorted(PROFILES), default=None)
        p.add_argument("--map")
        p.add_argument("--walk", action="store_true", help="check the walk pattern instead of decoding the link")
    c.add_argument("--rate", default="50e6")
    c.add_argument("--seconds", type=float, default=5.0)
    c.add_argument("--trigger")
    c.add_argument("--send")
    c.add_argument("--port")
    c.add_argument("--threshold", type=float, default=3.3)
    c.add_argument("--sim", action="store_true")
    c.add_argument("--buffer-mb", type=int, default=None)
    c.add_argument("--out")
    k = sub.add_parser("console")
    k.add_argument("command")
    k.add_argument("--port")
    k.add_argument("--wait", type=float, default=1.0)
    sub.add_parser("selftest")
    args = ap.parse_args()
    if args.cmd in ("capture", "analyze"):
        args.profile_given = args.profile is not None
        if args.profile is None:
            args.profile = "walk16" if args.walk or getattr(args, "send", None) == "walk" else "parmod"
    {"devices": cmd_devices, "capture": cmd_capture, "analyze": cmd_analyze, "console": cmd_console,
     "selftest": cmd_selftest}[args.cmd](args)


if __name__ == "__main__":
    main()
