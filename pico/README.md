# LPT modem bridge firmware (Pico 2 W)

Firmware for the WebTV parallel-port WiFi adapter described in `../WEBTV_LPT_BRIDGE.md`. To a
WebTV box whose OS is patched for the bridge, the bridge looks like a Hayes modem on the parallel
port. When the box dials, the bridge answers with a PPP server and carries the box's TCP
connections and DNS over WiFi. The protocol on the cable is PARMOD (PARallel MODem, spec §4.1):
the modem, the box's console and the bridge's commands as channels of one link.

The box's disk needn't change (§10.7). At every start the bridge plays the boot ROM's
diagnostics dongle, gets its loader running in the box (through the debug monitor, or test 19
and the disk's tier-3 area on a production boot ROM), reads the OS from the disk, patches it in
RAM from a table of 150 builds, and starts it from there. WiFi is set up on the TV with the
remote or the IR keyboard. A web page, in tabs, has the box's console, what the Bridge knows of the box,
the WTVP and DNS servers, Save this OS and Install another, a screenshot of the TV, and the box's disk:
its partitions, fixed areas and files.

```
box ──pins── core 1: port.c (dongle + 19200 serial | PARMOD)
                 │ rings
             core 0: sb/ (start-up: loader, patch, boot, TV screens) ─┐
                     modem.c → ppp.c → gw.c ─────────────────────────┴─ net_lwip.c ── WiFi
                     web.c (the page, Save / Install, the box's console)
```

| File | What |
| --- | --- |
| `src/port.c`, `port.h` | The port engine on core 1, a RAM-resident polling loop in one of three modes: idle; the dongle (D0–D3 mirrored onto the status lines) with the diagnostics console at 19200 8N1 (box → bridge on nSelectIn, bridge → box on D7, driven only while a char goes out); PARMOD (modem, console and command channels, a port of `src/machine/parmodhost.js`), which the bridge's loader and the patched OS both speak. It watches for the boot ROM's dongle probe after a reset and switches to the dongle in the same pass. Core 0 talks to it through lock-free rings (`ring.h`). |
| `src/link.c`, `link_hw.h` | The board's pins (rev 1 / rev 2), core 1's start, and the pin bring-up tests. |
| `src/portglue.c` | Core 0's turn at the port: the modem on PARMOD's modem channel, its commands (DTR, modem reset, REBOOT) and console, and the start-up. |
| `src/sb/` | The start-up for a stock box, a port of `src/stockbox/`: the diagnostics session (`sb_session.c`), the loader protocol with pipelined memory requests (`sb_proto.c`), reading, patching, booting, saving and installing the OS (`sb_ramboot.c`, `sb_patch.c`), keeping the tier-3 area's loader current (`sb_tier3.c`), IR decoding (`sb_ir.c`), the TV screens with text entry and an on-screen keyboard (`sb_ui.c`), drawn in the boot ROM's own fonts (`sb_font.c`), and the state machine with the countdown menu (`sb_startup.c`). |
| `src/gen/` | Made by `node tools/picogen.mjs` from `src/stockbox/`: the loader, stage 0, the tier-3 image and the patch table (`sb_patches.bin`, 866 KB, pulled in with `.incbin`). |
| `src/web.c` | The bridge's web page on port 80 (from `web/`, see below) and its requests: `/info` (this firmware's build, what the Bridge has seen of the box: the boot ROM's version, date and builder from its diagnostics banner, how it started, the OS build and slot; and the settings); `/status` (the console's `status`, with `X-Ready` for Save/Install, `X-Box` for the disk, `X-Mem` for box memory and `X-Keys` for keys); the box's console (`GET /console?from=N` from a 16 KB ring, `POST /console`); `/service` and `/dns` (the WTVP and DNS servers, saved); `/os.o` and `/install` (Save this OS, Install another, streamed); `/mem` (box memory: through the loader on the WebTV Bridge screen, and read by the running OS for the Bridge with PARMOD peeks, `port_pm_peek`; the page's Screenshot builds the picture from it); `POST /key?e=…` (the Remote tab's keys: to the WebTV Bridge screen, or over PARMOD into the running OS's IR input, `port_pm_key`); and, while the WebTV Bridge screen is up, `GET`/`PUT /disk` (sectors through the loader), which hold the screen until they finish. And the box's console on TCP port 2323. |
| `web/` | The page: `page.html`, `page.css`, `page.js` (tabs: Box Console, Box & Bridge Info, Server Settings, Box OS, Screenshot, Box Filesystem, Remote). `node tools/webgen.mjs` inlines them with `../web/wtvdisk.js` (the partition table and FAT, read and written, in the browser), `../src/machine/solo_cels.js` (the emulator's SOLO compositor) `../web/boxscreen.js` (a screenshot from box memory: the framebuffer, or the compositor's cels composited) and `../web/irkeys.js` (the remote's and the IR keyboard's codes, shared with the emulator) into `src/gen/web_page.c`, gzipped; run it after changing any of them. |
| `src/modem.c` | Hayes/Rockwell command set as TellyScript uses it: AT** firmware download (discarded), ATDT…; then ATD, CONNECT, +++, and hang-up on DTR drop. Port of the emulator's `src/machine/modem.js`. |
| `src/ppp.c` | PPP server: HDLC framing, LCP, PAP, IPCP (box 10.0.0.2, gateway and DNS 10.0.0.1). Port of `src/net/ppp.js`. Any PAP login is accepted. |
| `src/gw.c` | IP gateway: ICMP echo, DNS answered over WiFi, and TCP endpoints for the box spliced onto outbound connections, with backpressure both ways. Connections to ports 1600–1699 go to the configured WebTV service. Port of `src/net/ip.js`. |
| `src/net_lwip.c` | CYW43 WiFi (station, scans) + lwIP raw TCP/DNS, outbound and listening, polled (`pico_cyw43_arch_lwip_poll`). |
| `src/console.c`, `settings.c` | The bridge's console on USB CDC and a UART (115200; pins depend on the board revision): its log, its state, WiFi set-up, typing to the box; settings in the last flash sector. |
| `src/main_pico.c` | Startup and the core 0 loop; the CYW43 LED blinks without WiFi, is on with WiFi, and flickers while connected. |
| `sim/` | Both cores built to WebAssembly for the emulator (`run.mjs --pico`, below): the platform underneath (pins, time, flash, a simulated radio, TCP) replaced, the firmware unchanged. |
| `host/` | `port_test`: the port engine at pin level against a simulated box (below). |

The board is Tom Verbeure's parallel2usb (`WEBTV_LPT_BRIDGE.md` §2.3), revision 1 or 2,
with a Pico 2 W. The firmware reads the GP28 strap at boot and uses that revision's pin map
(`src/bridge_config.h`, §2.4). The console UART is UART1 on GP20 (TX) / GP21 (RX) on rev 2,
and UART0 on GP0 (TX) / GP1 (RX) on rev 1. Debug strobes for a logic analyzer are on GP26 and
GP27. Power it over USB: the 161284's cable side runs from VBUS.

## Build

You need CMake, Ninja, the Arm GNU toolchain (`arm-none-eabi-gcc` 14.x) and pico-sdk 2.1 or
later (tested with 2.3.1, which supports the RP2350 A4 stepping).

```sh
node tools/picogen.mjs                                      # from the repo root: src/gen (only when src/stockbox changes)
cd pico
cmake -B build -G Ninja -DPICO_SDK_PATH=/path/to/pico-sdk   # or -DPICO_SDK_FETCH_FROM_GIT=1
ninja -C build                                              # -> build/lptbridge.uf2
```

The image is about 1.4 MB (most of it the patch table) of the Pico 2 W's 4 MB.

To flash, hold BOOTSEL while plugging in the Pico 2 W and copy `build/lptbridge.uf2` onto the
`RP2350` drive.

## Setup

With the start-up on (the default), plug the bridge into the box and switch the box on. The
first time, the TV shows the networks the bridge can see; pick one with the remote and type
its password with the IR keyboard or the on-screen keyboard. After that, every start shows the
WebTV Bridge screen with a 10 s countdown (any key stops it): Start now, Settings (WiFi; the WTVP server: an address or a name, or blank for the one the box's
OS asks for; Remotes: whether the OS also decodes Sony's WebTV remote and Philips RC-5 remotes,
on top of the WebTV remote and keyboard; Turn on by itself: whether the OS powers on at once,
the default, or waits in standby for the power key). The menu itself works with the WebTV remote, Sony's
WebTV remote, or the IR keyboard. The bridge's page at `http://<its address>/` shows its state (the port's mode,
PARMOD counts, WiFi, the modem, PPP, connections, the start-up), has a terminal on the box's
console (output scrolls in, a line typed goes to the box), and does Save and Install while the
WebTV Bridge screen is up (greyed out otherwise).

A box with a production boot ROM (no debug monitor, e.g. 2046) needs the loader in its disk's
tier-3 area once: `node tools/lptdisk.mjs DISK.bin --tier3 -o OUT.bin` on an image of its disk,
then 12 sectors written back with `dd` (step by step, for a drive pulled from a box: §10.7).

The bridge's console is there for everything else. Open the USB serial port (or the console
UART) at 115200: its log scrolls there (the box's console lines too, as `[pmcon]`), and it
takes commands:

```
scan                        # the networks in range
wifi "My Network" mypassword
service 192.168.1.20        # your minisrv (or another WebTV service); "none" = where the box asks
dns 1.1.1.1                 # DNS server; "auto" (the default) = the router's, or 8.8.8.8 if it gives none
remotes sony philips        # the remotes the OS decodes besides its own ("remotes none"); default both
autopower on                # the OS powers on by itself at start, the default ("off": waits for the power key)
entry tier3                 # a debug boot ROM starts as a production one does: test 19 and the disk's
                            # tier-3 area, not the debug monitor ("auto" = the monitor when there is one)
save
status                      # the port, WiFi, modem, PPP, open connections, the start-up
type "help"                 # a line to the box's console
```

`help` lists the rest; `log 2` shows more detail; `country XX` sets the WiFi country (save + reboot). `startup off`
(then `save`) skips the start-up for a box whose OS is already patched on its disk.

The web page's Server Settings tab has the WTVP and DNS servers too. Names ending in `.local` need mDNS, which the bridge
doesn't do.

For bring-up:
- `pins` prints the board revision and the level of every line.
- `walk` pulses each output line in a pattern that `tools/saleae/lptscope.py` checks: it
  shows the pin mapping, polarity and DIR are right before a box is attached.
- `loop 1`, `loop 2`, `loop 3` check every line and solder joint with jumpers on J2 and no
  box (`loop` alone lists the jumpers). Each driver goes to one receiver; the receivers in
  order are nStrobe, nAutoFd, nInit, nSelectIn, D0–D7:

  | J2 | nAck (6) | Busy (5) | PError (4) | Select (3) | nFault (16) |
  | --- | --- | --- | --- | --- | --- |
  | loop 1 | nStrobe (19) | nAutoFd (18) | nInit (14) | nSelectIn (12) | D0 (17) |
  | loop 2 | D1 (15) | D2 (13) | D3 (11) | D4 (10) | D5 (9) |
  | loop 3 | D6 (8) | D7 (7) | | | |

  With the data lines as inputs, open drain and then push-pull, each receiver must follow its
  driver and nothing else. The test names any receiver that doesn't, and notices when the jumpers
  are for a different mode.

  `loop 4` and `loop 5` turn the data bus around. Four data lines drive the control inputs
  while DIR = 1, and the status lines drive the other four while DIR = 0:

  | J2 | nStrobe (19) | nAutoFd (18) | nInit (14) | nSelectIn (12) | nAck (6) | Busy (5) | PError (4) | Select (3) |
  | --- | --- | --- | --- | --- | --- | --- | --- | --- |
  | loop 4 | D0 (17) | D1 (15) | D2 (13) | D3 (11) | D4 (10) | D5 (9) | D6 (8) | D7 (7) |
  | loop 5 | D4 (10) | D5 (9) | D6 (8) | D7 (7) | D0 (17) | D1 (15) | D2 (13) | D3 (11) |

  After the static checks it makes 1000 round trips (drive, release, receive) and prints the
  worst settling time of each step. Push-pull is only tried after open drain passes, so the
  wrong jumpers can't make the data outputs fight the status outputs.

  Take the jumpers off before `walk` or connecting a box.

For minisrv, set `service_ip` in its `user_config.json` to the address the box should use for
its services. The bridge sends every WTVP connection (ports 1600–1699) to `service`, whatever
address the box asks for, so the old WebTV addresses saved in the box's NVRAM work.

## Testing without hardware

The whole bridge runs in the emulator: the box is the MIPS emulator with its boot ROM, disk and
OS; the Pico is this firmware, both cores, built to WebAssembly (`sim/`) and attached to the
emulated parallel port pin by pin (`src/machine/picosim.js`). Every change the box makes to its
lines goes straight to core 1's `port_step()`, every line the firmware drives comes straight
back, and both run on the box's emulated clock (core 0 every 250 µs of it). Only the platform
is simulated: the pins, the clock, the flash sector (a file), the radio (a scan shows four
networks; a join takes 3 s and fails for a password starting with `bad`) and TCP (the emulator
process's sockets).

```sh
cd pico/sim && make                       # needs emscripten (emcc); -> out/lptbridge.mjs + .wasm
cd ../..
node tools/run.mjs --install-os …/approm/production-nondebug/build-16423/_approm.o \
  --pico --pico-settings bridge.settings --pico-service 127.0.0.1 --net builtin --wtv-listen \
  --remote 1600000000:down --remote 1700000000:down --remote 1800000000:select \
  --type "2100000000:Hello WebTV 1998" --key 2700000000:Enter --remote 3400000000:select \
  --press 6500000000:power --cycles 14000000000 --png out.png
```

goes from power-on to the service: the dongle, the diagnostics typed at 19200, stage 0 and the
loader over PARMOD, WiFi setup on the TV (a fresh `bridge.settings`), reading and patching,
the countdown, the OS from RAM, its own PARMOD session, dialing, PPP and the registration
page. Add `--rom …/bootrom/production-nondebug/build-2046/_bootstraprom.o` and `--disk` with
the tier-3 image for the production boot ROM. `--box-reset cycles` resets the box (a crash),
`--pico-console 'cycles:text'` types at the bridge's USB console, `--pico-trace FILE` writes
the cable as a logic analyzer would see it (for `tools/saleae/lptscope.py analyze`), and its web
page is on `http://127.0.0.1:8080/` while it runs. Screenshots of each phase: `out/picosim/`.

The scenarios, scripted (`tools/bridgesim.mjs`): first power-up with WiFi set up on the TV, a
power-off reboot, a crash, Settings and the WTVP server, the web page's screenshot (on the WebTV Bridge screen, and from the running OS over PARMOD), WTVP server
and Box Filesystem (a file written, read back and deleted through `/disk`), Save and Install through the web page,
the Remotes and Turn on by itself settings reaching the OS, a screenshot of the running OS over PARMOD, and keys from the web page (to the WebTV Bridge screen, and over PARMOD into the OS's IR input). Each checks what it should and
stops at the first failure; the summary gives emulated times. `--rom` and `--tier3` for a
production boot ROM, `--os` for another build (16406 by default). The built-in service
listens on 127.0.0.1's WTVP ports and the web page on 127.0.0.1:8080, so those must be free.
`PAGESHOT=1` also screenshots the page's tabs in headless Chrome, clicking Take a screenshot
and Read the disk (`out/stockbox/bridgesim-page-*.png`).

```sh
node tools/bridgesim.mjs                  # nine scenarios, ~6 minutes
cd pico/host && make test                 # port_test, both board revisions
```

`port_test` checks core 1 alone with threads: the probe watch and mirror, the diagnostics serial
both ways, and a PARMOD session as `parmod.js` drives it (modem and console data both ways,
refusals, commands, EXIT, and no false probe with the watch on).

Verified (2026-10-31: bridgesim's seven scenarios, 3475 and 16406. 2026-10-27, everything on PARMOD): boot ROMs 3475 and 2046 (tier 3), WiFi setup on
the TV, online to the registration page; Save from the web page (byte-identical to the image)
and Install (the installed build then goes online); a power-off (REBOOT: re-patched, no
countdown), a crash in the OS and a reset during the countdown, each caught and the OS started
again. In the emulator, press power within about 20 s of the OS starting: after that the OS
sets up its modem in standby, and a late press never dials, with or without the bridge (an
emulator problem still to find). Still untested: the real pins, the 161284, and WiFi/lwIP on
the Pico. `tools/saleae/lptscope.py` decodes PARMOD, the dongle probe and the diagnostics console.

## Notes

- **Core 1** runs only from RAM. That's why `PICO_FLASH_ASSUME_CORE1_SAFE`: saving settings
  doesn't stop the link.
- **Pin loop instead of PIO:** PARMOD is fully interlocked, with the box waiting up
  to milliseconds per edge, so a polling loop is fast enough and easy to follow. The dongle
  mirror answers within one pass of the loop (well under a microsecond); the boot ROM reads
  STAT a few instructions after driving its pattern, so this is the first thing to measure on
  hardware. PIO remains the plan for ECP (§4.2 of the spec).
- **The probe watch** takes 0xF1/F2/F4/F8 with all four control lines high as the boot ROM's
  dongle probe. It is on from the loader's start, except for 2 s after `boot_ram`'s own reset.
  PARMOD only raises all four lines at idle, and both sides put 0xFF on the bus before letting
  go of it (the box's `pm_idle`, the loader, stage 0; the bridge after an `_IN` answer), so a
  released bus only floats up from all ones and never shows a probe byte. The ROM waits ~150
  instructions between driving the pattern and reading STAT, too short to debounce through a
  floating bus, hence the rule rather than a timer.
- **The diagnostics console:** the box turns its data bus in while it sits in the console, and
  the bridge drives the bus only for the ~520 µs of each char it sends, after 1.5 ms of quiet
  on both lines (the box listens only between its own chars).
- **The box's console output** (PARMOD CON_OUT) can't be refused, so the bridge drops it when
  its 4 KB ring is full; the modem channel is refused instead (Select low) and recovers.
- **Timing knobs** in `bridge_config.h`: data setup before Busy rises on an `_IN` answer, the
  sample delay after nStrobe falls, and the nAck pulse width.
