# WebTV Emulator

A browser-based emulator of the WebTV Plus (LC2 board, SOLO1 ASIC, e.g. Sony INT-W200),
written in plain JavaScript (ES modules, no build step).

## Running

```sh
npm start                     # = node tools/serve.mjs; Ctrl-C stops it (and minisrv/relay it started)
open http://localhost:8080/web/
```

**Start everything** (top right) starts minisrv and the relay, boots the box, waits for it to
reach standby and presses Power. Or pick the boot ROM and disk image (defaults are the files in
`data/`) and press **Start**.
The emulator runs in a Web Worker; the 1 GB disk image is streamed on demand with Range
requests (or read from a local file with `FileReaderSync`). The image itself is never
modified: sectors the box writes, and its NVRAM, are saved in the browser's IndexedDB
(`web/persist.js`, per disk image) and restored on every Start, so a box registered once stays
registered. **Box state → Erase box state** returns it to factory-fresh; untick **Save box
state** for a throwaway session.

The box boots into standby (power LED blinking). Press **Power** (or F1 with the screen
focused) to turn it on. With the screen focused, the PC keyboard acts as the WebTV IR
keyboard.

### Local WebTV service (minisrv)

With `tools/serve.mjs`, the page's **WebTV service** card starts and stops
[minisrv](https://github.com/zefie/zefie_wtvp_minisrv) (vendored in `services/minisrv`,
GPL-3.0, see `LICENSE.minisrv`) and the network relay. Press **Start** next to minisrv (the
relay starts with it, pointed at minisrv), then **Start** the box and press **Power**. The
first time, the box goes through minisrv's registration; after that it logs straight in to its
Home page. The card can also show each service's log. The control API (`/api/services`,
`tools/services.mjs`) only answers requests from this machine.

Services are tied to the window that started them: closing that window (or quitting the
browser) stops them 5 seconds later; reloading the page does not. During those seconds another
window shows "stops in Ns" with a **Keep** button that takes them over. Stopping the dev
server stops everything it started. A service started elsewhere (e.g. by hand) shows as
"already running" and is left alone.

minisrv keeps its accounts in `services/minisrv/SessionStore/accounts`. If you erase the
box state, delete the box's account there too (or use Unregister on the minisrv home page
first): minisrv may otherwise challenge the box with a login it no longer has.

### Browsing the real web

minisrv fetches `http://` and `https://` pages from the internet on the box's behalf (its
`http`/`https` services; the box itself only talks to minisrv). Type a URL into the field at
the top of the minisrv Home page, e.g. `http://frogfind.com` (a search engine that serves
simple pages for old browsers) or `http://68k.news`. Modern sites mostly render poorly: they
are large and depend on JavaScript and CSS the 1997 browser doesn't have. minisrv can send
requests through a simplifying proxy such as
[WebONE](https://github.com/atauenis/webone) (`use_external_proxy` in the `http`/`https`
sections of its config), and the `proto://` service browses archived 90s sites through
ProtoWeb.

## Audio

Emulated audio goes from the worker straight to an AudioWorklet (`web/audio-worklet.js`) with
a jitter buffer that refills before resuming after a gap and slightly resamples to follow the
emulator's speed. The graph under the screen shows emulation speed over the last 30 seconds
(dashed line = real time; amber below 97%, red below 85%) with red ticks where audio had a
gap; the status line beside it shows the buffer level and the number of gaps. Gaps line up
with dips below 100%, where the emulator can't keep up.

To find what's slow, `tools/run.mjs --profile FROM:TO:out.cpuprofile` writes a V8 CPU profile
of the given cycle range (open it in Chrome DevTools; `-` as the file just times it), and
`--hot-threshold N` / `--no-superblocks` change the JIT's tiering and block building for
comparisons.

The JIT (`src/cpu/jit.js`) interprets a block until it has been entered 1024 times and only
then compiles it; startup code mostly runs a few times, and compiling it (plus V8 warming up
each new function) cost more than interpreting it. Compiled blocks are superblocks: they
continue past conditional branches that aren't taken.

## Boot ROMs and OS builds

With a ROM collection unpacked under `data/rom-collection/` (any
`.../bootrom/<flavor>/build-N/_bootstraprom.o` and `.../approm/<flavor>/build-N/_approm.o`), the
dev server lists them (`/api/builds`): boot ROMs appear in the **Boot ROM** menu, and **Box state
→ Install an OS build** writes a build (or a local `_approm.o`) into both OS slots of the
selected disk's saved state (`src/machine/osinstall.js`; the image file is untouched, and Erase
box state undoes it). Pairs that boot through registration with the built-in service:

| Boot ROM | OS build | Notes |
| --- | --- | --- |
| `flipped_merged_boot.bin` (britt, 12/19/97) | the disk's own 1997 debug build | full debug console |
| `dbg-int-4m-solo-ram` 2205 (rob, 2/13/98) | `daily-debug` 16406 | MSN-era client with `client:boota` |
| `production-nondebug` 2046 | `production-nondebug` 16423 | latest production build |

The 1997 boot ROM only understands the old image header (it loads 4 MB at 0x80400000), so
newer builds need a 1998-or-later boot ROM. Newer builds print their debug output on the
parallel (ECP) port, which the emulator doesn't capture yet (a build patched for the LPT
modem bridge prints it on the debug serial port instead, which the console shows). `tools/run.mjs --install-os FILE`
does the same install headless.

## Disk layout

The **Disk browser** (header) shows the selected disk image as the box sees it, including
writes saved in box state: partitions, FAT folders and files (preview, download) and a raw
sector viewer. What we know of the layout, all in the CPU's byte order (the image file has
every 16-bit word byte-swapped, the ATA word order):

| LBA | What |
| --- | --- |
| 1-14 | NV storage (copy at 33796) |
| 1027, 17411 | OS slots "Browser 0" / "Browser 1", 16384 sectors each; the boot ROM picks one via the select block at 33795. Images (header: branch, 0, checksum, 0x00100000, length in words, ...; loaded at 0x80400000). The second, newer one has the You Don't Know Jack hooks (`GFXOpenJack`) |
| 42504 (0xa608) | Partition table, 2 KB: u32 checksum (byte sum of bytes 4-2047), u32 count, then 52-byte entries from offset 0xc: name[32], start, size, type, flags, timestamp (big-endian). The first entry's name overlaps the magic, `timn` + `boot`. The OS reads this fixed LBA; 34312 (0x8608) holds an older 3-entry table |
| partition start | `part<name>` header repeating the entry, same checksum scheme |
| partition start + 32 | FAT16 boot sector (OEM `WebTV   `) for type-2 partitions; VFAT long names |

This image's table: `boot` 0-61439 (type 3), `free` 61440 (10 MB), `jack` 81920 (20 MB,
FAT16, empty; for You Don't Know Jack), `browser` 122880 (20 MB, FAT16: `TV/IR/irdb.codes`,
`irdb.names`), `free` 163840 to the end (953 MB). The debug OS shell has `showparts`, `newpart
<name> <MB>`, `rmpart` and `scrubparts`, and the client has `client:showdir?theDir=...`.

## Single-file build

```sh
node tools/build-single.mjs        # -> dist/webtv.html (about 7.3 MB)
```

builds one self-contained HTML file with the code, styles, README, boot ROM (gzipped) and disk
image, which opens straight from disk (`file://`) or any static host. The disk is embedded in
a packed format made by `tools/pack-disk.mjs` (run automatically when the image changes): of
the image's 2.1 million sectors only about 18,000 hold real data, the rest a 4-byte counter
stamp and zeros, so sectors are stored trimmed, the stamps delta-coded, and groups of 2048
sectors compressed independently with raw deflate. The 1 GB image packs to 3.8 MB, decoded
on demand with the browser's own `DecompressionStream`. The page can also load
`data/debug_webtv_w200_7.wtvd` (or any `.wtvd` file) directly.

The single file needs no server: the box registers with and logs in to the built-in WebTV
service. Saved box state and accounts work as usual, per browser.

## Headless runner

```sh
node tools/run.mjs --cycles 1500000000 --answer 'Disk Boot?=y' --png out.png
```

Options: `--sample N` (print PC every N instructions), `--trace-tail N` (last N
instructions), `--break HEXPC`, `--mmio` (log SOLO register accesses), `--dis ADDR:COUNT`,
`--png FILE` (dump the last video frame), `--dump-on TEXT` (dump interrupt state when the debug
console prints TEXT). The box's debug serial port is printed as
`[dbg]` lines.

Networking options: `--net ws://localhost:8081` (connect the modem to a relay, see below;
`--net offline` answers the call but refuses TCP), `--host-map NAME=IP` (static DNS answers),
`--ppp-auth pap|chap` (ask the box to authenticate and log its credentials), `--modem-trace`
(hex dump of the modem byte stream). With `--net`, the runner yields to the event loop between
slices so relay sockets keep working.

## Network

The **Network** setting (Machine panel) picks what the box's modem reaches:

- **Built-in WebTV service** (default): a WebTV service that runs inside the page
  (`src/wtvsrv/`), so nothing else needs to run. It does what the box needs to boot, register
  and log in: the wtv-1800 / wtv-head-waiter handshake (challenge, ticket, RC4 "SECURE ON"
  encryption; `wtvsec.js` interoperates with minisrv's, including its tickets), registration,
  settings and a home page. Accounts are kept in the browser with the rest of the box state.
  Web pages (`http://`, `https://`) are fetched through the dev server's `/api/fetch`; in the
  single-file build only sites that allow cross-origin requests load. Every connection to a
  WTVP port (1600-1699) goes to it, including the old WebTV addresses saved in the box's NVRAM.
- **Relay**: the box's TCP connections go over a WebSocket to `tools/relay.mjs`, for minisrv or
  another real service (below).
- **Offline**: the call is answered but nothing is reachable.

`tools/run.mjs --net builtin` runs the built-in service headless.

### Relay

The modem's phone line is emulated by `src/net/`: when the TellyScript dials, the emulator
answers as the ISP's PPP peer (LCP, optional PAP/CHAP, IPCP: box 10.0.0.2, gateway and DNS
10.0.0.1), runs a small IPv4 gateway (ICMP echo, a DNS server on UDP/53, and TCP termination),
and carries every TCP connection the box opens over a WebSocket to a relay that makes the real
connection:

```sh
node tools/relay.mjs                       # ws://127.0.0.1:8081, connects where the box asks
node tools/relay.mjs --target 127.0.0.1    # send every connection to a local service emulator
node tools/relay.mjs --map 207.79.34.0/24=127.0.0.1 --map 10.0.0.1=127.0.0.1:1615
```

In the page, set **Relay URL** (default `ws://localhost:8081`, empty = no network) before
pressing Start. The relay logs every connection and the first bytes the box sends.

The box (from saved NVRAM state) first connects to `wtv-head-waiter` at 207.79.34.4:1601 /
207.79.34.3:1601 and `wtv-*` at port 1603; it does not use DNS for these. To talk to a
WebTV service emulator such as zefie's
[minisrv](https://github.com/zefie/zefie_wtvp_minisrv), run it on the same machine with a
`user_config.json` like

```json
{ "config": { "service_ip": "10.0.0.1", "bind_ip": "127.0.0.1", "enable_gzip_compression": false,
              "keys": { "user_data_key": "<random>" } } }
```

and start the relay with `--target 127.0.0.1`. minisrv then hands the box service addresses on
10.0.0.1, which the relay also maps to localhost. (`enable_gzip_compression` must be off: this
OS build fails with "a kind of information that WebTV can't use" on `Content-Encoding: deflate`;
minisrv's LZPF compression works.)

## LPT modem bridge

`WEBTV_LPT_BRIDGE.md` describes a Pico 2 W adapter that gets real boxes online through their
parallel port. It looks like a Hayes modem to the box, with PPP behind it over WiFi. The
emulator has both halves:

- **OS patch** (`src/lptmodem/`): `node tools/lptpatch.mjs <_approm.o> [symbols.sym] -o out.o`
  rewrites a build's modem driver to talk to the bridge over PARMOD (PARallel MODem: `driver.js`,
  `parmod.js`), with the debug console as a second channel, and turns off the printer driver.
  It works from the build's `symbols.sym` or, without one, finds the names by signature.
  In the page: **Box state → Install an OS build → Patch it for the LPT modem bridge**.
  Headless: `tools/run.mjs --install-os FILE --lpt`. A stock box needs no patched disk: the
  bridge patches its OS in RAM at start-up (`src/stockbox/`, spec §10).
- **Bridge firmware** (`pico/`, see `pico/README.md`): Pico 2 W firmware for the real adapter,
  which is Tom Verbeure's parallel2usb board (rev 1 or 2, detected at boot). `pico/sim` builds
  the same C to WebAssembly, and `tools/run.mjs … --pico` puts it on the emulated parallel port
  in place of the emulator's own bridge: start-up, WiFi setup, the web page (127.0.0.1:8080)
  and the gateway all run as on the Pico. On hardware, `tools/saleae/lptscope.py` captures the
  cable with a Saleae analyzer and decodes it.
- **Emulated bridge**: without `--pico`, the SOLO parallel port (`src/machine/solo_pport.js`)
  has the emulator's own bridge attached (`src/machine/lptbridge.js`), with the same network as
  the modem. A patched build enters its PARMOD session, dials and goes online through it; an
  unpatched one ignores it and uses its modem.

## Layout

| Path | What |
| --- | --- |
| `src/cpu/mips.js` | MIPS III interpreter, IDT R4640 flavour (big-endian, base/bound instead of TLB, MAD/MUL) |
| `src/cpu/disasm.js` | Disassembler |
| `src/machine/webtv.js` | Machine wiring and run loop |
| `src/machine/bus.js` | Physical address map |
| `src/machine/solo.js` | SOLO1 busUnit, romUnit, devUnit, memUnit, debug serial, interrupts |
| `src/machine/solo_video.js` | vidUnit / gfxUnit / potUnit (framebuffer + cel compositor, VSYNC) |
| `src/machine/solo_audio.js` | audUnit DMA |
| `src/machine/ir.js` | IR receiver + Sejin IR keyboard / remote |
| `src/machine/ide.js` | ATA disk |
| `src/machine/uart16550.js`, `modem.js` | Hardware modem UART and a Hayes/Rockwell modem model |
| `src/machine/solo_pport.js`, `lptbridge.js` | SOLO parallel port and the emulated LPT modem bridge |
| `src/lptmodem/` | Parallel-port definitions, box-side driver (MIPS source), assembler, OS patcher (`tools/lptpatch.mjs`) |
| `src/machine/romfs.js` | A build's ROM filesystem: read, expand (LZPF/LZSS) and replace files (`tools/romfs.mjs`) |
| `src/net/ppp.js` | PPP server: async-HDLC framing, LCP, PAP/CHAP, IPCP |
| `src/net/ip.js` | IPv4 gateway: ICMP echo, DNS server, TCP endpoints spliced onto relay streams |
| `src/net/line.js` | `createNetworkLine()` (the modem's line backend), the WebSocket relay transport and the built-in service transport |
| `src/wtvsrv/` | Built-in WebTV service: `crypto.js` (MD5, DES, RC4), `wtvsec.js` (WTVP security), `wtvp.js` (connections), `service.js` (handlers), `pages.js` |
| `src/machine/i2c.js` | IIC bus, 24C01 NVRAM, DS2401 serial ID |
| `web/` | Frontend (page, worker, audio worklet, `persist.js` saved box state, `packed-disk.js` WTVDSK1 reader, `wtvdisk.js` partition/FAT reader, `disk-browser.js`) |
| `tools/` | Dev server (`serve.mjs`, plus `services.mjs` minisrv/relay control), headless runner, disassembler, network relay (`relay.mjs`) |
| `tools/pack-disk.mjs`, `tools/build-single.mjs` | Disk packer and single-file build (`dist/`) |
| `pico/` | LPT modem bridge firmware for the Pico 2 W (C, pico-sdk), plus host builds for testing |
| `tools/saleae/` | Logic 2 automation: capture the parallel port, decode PARMOD and the dongle probe, drive the bridge console |
| `services/minisrv` | Vendored copy of zefie's minisrv with a local `user_config.json` |

## Sources

- SOLO1 ASIC Engineering Specification (`data/SOLO1_ASIC_Spec_reduce2.pdf`) and the LC2
  schematics.
- Behaviour cross-checked against, and parts ported from, the wtvemac MAME fork
  (`src/mame/webtv`, BSD-3-Clause, copyright-holders FairPlay137, wtvemac).

## Status

- Boot ROM runs, loads the WebTV OS from disk, kernel and tasks start.
- Dials, negotiates PPP and talks WTVP to a service emulator through the relay (tested with
  minisrv up to the registration pages).
- Registers and reaches a Home page with the built-in service (no server) or with minisrv;
  box state and accounts persist across reloads.
- Not yet done: accurate cycle timing.
