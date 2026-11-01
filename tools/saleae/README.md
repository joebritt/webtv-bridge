# Saleae captures of the parallel port

`lptscope.py` drives a Saleae analyzer through Logic 2's automation API. It captures the
WebTV ↔ bridge cable, saves the capture (it opens in Logic 2) and decodes it: PARMOD (what
the bridge speaks), the boot ROM's dongle probe and diagnostics console. It also talks to the
bridge's USB console, so one command can start a capture and then make the bridge do
something.

## Setup

1. Install [Logic 2](https://www.saleae.com/downloads/). In **Preferences**, turn on
   **Enable automation server** (port 10430). Or pass `--launch`, and the script starts
   Logic 2 itself.
2. Install the library: `python3 -m venv tools/saleae/.venv && tools/saleae/.venv/bin/pip install logic2-automation`
3. Check the setup with `tools/saleae/.venv/bin/python tools/saleae/lptscope.py devices`.
   With no hardware plugged in, `capture --sim` uses Logic 2's simulated device.

## Probing

Clip onto **J2** on the parallel2usb board. Its pinout is the same on both revisions:

| J2 | signal | J2 | signal | J2 | signal | J2 | signal |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 3 | Select | 8 | D6 | 13 | D2 | 18 | nAutoFd |
| 4 | PError | 9 | D5 | 14 | nInit | 19 | nStrobe |
| 5 | Busy | 10 | D4 | 15 | D1 | 20 | **GND** |
| 6 | nAck | 11 | D3 | 16 | nFault | 1 | +5 V (don't clip ground here) |
| 7 | D7 | 12 | nSelectIn | 17 | D0 | 2 | +3.3 V |

The signals on J2 are 5 V. On a Logic Pro, the default threshold of 3.3 V is right. The
bridge's debug strobes are 3.3 V signals on the Pico's own pins:

- **dbg0 (GP26):** toggles each time the link engine acts on an edge from the box.
- **dbg1 (GP27):** high while the bridge holds Busy because its buffer is full.

Profiles (`--profile`) map Saleae channels to signals:

| profile | channels 0–15 | for |
| --- | --- | --- |
| `parmod` (default) | D0–D7, nStrobe, nAutoFd, nInit, nSelectIn, Busy, Select, nAck, nFault | PARMOD: codes, bytes, answers, timing; the dongle probe and its mirror; the diagnostics serial |
| `hs8` | nStrobe, nAutoFd, nInit, nSelectIn, nAck, Busy, PError, nFault | Logic 8: timing only |
| `walk16` | nAck, Busy, PError, Select, nFault, D0–D7, dbg0, dbg1, nStrobe | the walk test |

For other wiring, use `--map "0=nStrobe,1=Busy,…"`. The script saves the map next to the
capture as `channels.txt`, and `analyze` uses that file again.

## Bring-up, in order

```sh
S="tools/saleae/.venv/bin/python tools/saleae/lptscope.py"

# 1. Bridge on USB, no WebTV box. Check the board revision and the input levels
#    (the 161284's pull-ups hold every line high).
$S console pins

# 1b. Without the analyzer: jumper J2 and run `loop 1` .. `loop 5` on the console
#     (pico/README.md, WEBTV_LPT_BRIDGE.md §2.5). Remove the jumpers before step 2.

# 2. Mapping, polarity and DIR: the bridge pulses each output line in turn (src/link.h).
#    Each line needs its own count of pulses, in the right direction.
$S capture --profile walk16 --seconds 1 --send walk

# 3. With the box: start the capture, then switch the box on. The loader is running ~6 s
#    later and the OS ~10 s after the countdown; 40 s covers the start-up and a dial.
$S capture --seconds 40 --rate 25e6

# 4. Decode an existing capture again, or a trace from the emulator (below).
$S analyze captures/20261013-101500
```

The PARMOD decode reports:
- **box resets**: each boot ROM dongle probe, whether the bridge's mirror answered it (F1 F2 F4 F8,
  the dongle) or let it pass (F1 only, e.g. the reset that starts the patched OS), and the time
  from the probe byte to the mirror on the lines. That last number is the first thing to check
  on hardware: the ROM reads STAT ~150 instructions after driving its pattern;
- **probe-like bytes** within 10 ms of PARMOD traffic: a byte floating beside the idle code, which
  the bridge would take for a reset. There should be none: both sides drive 0xFF before
  releasing the bus;
- the **diagnostics console**, as text both ways (19200 8N1: the box on nSelectIn, the bridge on D7);
- **PARMOD**: sessions (each with its modem bytes each way), transactions by code, refusals, status
  bytes, commands (DTR, MODEM_RESET, REBOOT, ...), nAck attentions; the modem and console
  channels are saved as `.bin` files;
- **timing**: nStrobe low → Busy high (the bridge's answer), nStrobe high → Busy low (its release),
  the box's data setup before nStrobe, nAck pulse widths;
- **protocol violations**: a strobe while Busy is high, the box's byte changing before the
  answer, the bridge's byte changing before nStrobe rises, a strobe with the idle code.

Compare the timings with the knobs in `pico/src/bridge_config.h`.

## Without hardware

`lptscope.py selftest` checks the walk decoder: once on a correct trace, and once on a trace
with two lines swapped. For the PARMOD decoder, take the cable from the emulator: with the
bridge firmware on the emulated port (`run.mjs --pico`, see `pico/README.md`), `--pico-trace`
writes the cable in Logic 2's CSV export format, timed by the emulated clock:

```sh
node tools/run.mjs --install-os …/build-16423/_approm.o --pico --pico-settings bridge.settings \
  --pico-service 127.0.0.1 --net builtin --wtv-listen --press 4000000000:power \
  --cycles 6000000000 --pico-trace /tmp/t.csv
python3 tools/saleae/lptscope.py analyze /tmp/t.csv
```

That run (a bridge with WiFi already set) decodes as five box resets (three answered by the
mirror: power-on, the boot ROM's second check and the diagnostics' own; two let pass: the
starts of the patched OS), the diagnostics console both ways (the ROM's banner and menu; the
bridge's `18`, `dr a8`, stage 0's `sl` lines, `epc`, `g`), the loader's session (its 5 KB image
and the start-up's commands) and the OS's (its modem firmware download), with no problems.
The emulated bridge answers in zero time, so the timings say nothing about the Pico; the
decode, the byte streams and the checks are what this tests.
