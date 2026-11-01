// Stock-box loader: MIPS code the bridge types into a stock LC2's RAM through the boot ROM's
// debug monitor (WEBTV_LPT_BRIDGE.md §10.6: dongle -> diagnostics -> test 18 -> `sl` ... ->
// `epc` -> `g`). It runs uncached from kseg1, owns the box from then on, and does two things:
//
//   - puts up a simple TV screen: it starts SOLO video on its own framebuffer, as the boot
//     ROM's ColorPage test does, and draws filled rectangles and 5x7 text (src/stockbox/font.js);
//   - takes commands from the bridge over the parallel port: PARMOD transactions on the modem
//     channel (the link section below), polled, with the box as master and the data bus
//     released whenever no byte is being sent. Commands and replies are in protocol.js;
//   - gives the bridge the box's memory: READ / WRITE with loads and stores of a given width,
//     within RAM, the boot ROM and the SOLO registers, and CALL (protocol.js);
//   - passes the IR receiver's raw runs to the bridge, which decodes the remote and the IR
//     keyboard. The receiver is set up as the OS's InitSoloIR does; its FIFO holds only 16
//     runs (a few ms of a keypress), so the loader also empties it into a 256-entry ring
//     while it fills rectangles and draws text.
//
// The boot ROM has already programmed the video encoder (SAA7187) at cold boot; like the
// ColorPage test, the loader only turns the RF modulator on (GPIO 0 enable off) and sets the
// encoder's register 0x61 to 0x15 over I2C.
//
// Register use: internal calls pass arguments in a0-a3 (fill_rect also takes its colour in
// v1) and may clobber every t register; the main loop keeps its state in s registers.
// ir_poll only touches at, v0, k0, k1, t8 and t9 (interrupts are off, so k0/k1 are free).

import { parse, prepare, unitSize, unitLabels, assemble, evaluate } from '../lptmodem/asm.js';
import { CTRL, STAT, PP } from '../lptmodem/link.js';
import { FONT, FIRST, LAST } from './font.js';
import { CMD, MSG, LDR_VERSION, SCREEN, RANGES, yuyv } from './protocol.js';

// Memory: everything the loader uses sits below 0x803c0000, the lowest base the boot ROM
// accepts for an OS, so an OS read from the disk (up to the end of RAM) never covers it. That
// is inside the boot ROM's own RAM copy (0x80200000-), which nothing needs once the loader
// runs: the next reset copies the ROM there again.
export const LOADER_BASE = 0xa0300000;  // kseg1: runs uncached, so no cache flush is needed
const STACK = 0xa0318000;
const FB = 0xa0320000;                  // framebuffer (to 0xa0392d80), written uncached so video DMA sees it
// the back buffer (to 0xa02f2d80), the framebuffer's size and layout: TARGET draws there and COPY
// moves rectangles between the two, so a redrawn line never shows half done (no erase first)
const BACK = 0xa0280000;
export const SCRATCH = 0xa03a0000;      // a sector buffer for the bridge (disk_read of headers, the select block)
const STRIDE = SCREEN.W * 2;            // YCbCr 4:2:2: 2 bytes a pixel, a word per pixel pair

const hex = (v) => '0x' + (v >>> 0).toString(16);
const words = (bytes) => {
  const out = [];
  for (let i = 0; i < bytes.length; i += 4) {
    out.push(((bytes[i] << 24) | ((bytes[i + 1] ?? 0) << 16) | ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0)) >>> 0);
  }
  return out.map((w) => `  .word ${hex(w)}`).join('\n');
};
const text = (s) => [...s].map((c) => c.charCodeAt(0));

// the equates and the link routines, shared with stage 0
const EQU = `.equ SOLO, 0xa400                  # lui: SOLO registers (kseg1)
.equ SOLO_HI, 0xa401               # lui: SOLO + 0x10000, for the potUnit's registers
.equ VID_NSTART, 0x300c
.equ VID_NSIZE, 0x3010
.equ VID_DMACNTL, 0x3014
.equ POT_VSTART, 0x9080 - 0x10000
.equ POT_VSIZE, 0x9084 - 0x10000
.equ POT_BLANK, 0x9088 - 0x10000
.equ POT_HSTART, 0x908c - 0x10000
.equ POT_HSIZE, 0x9090 - 0x10000
.equ POT_CNTL, 0x9094 - 0x10000
.equ DEV_IIC, 0x400c
.equ DEV_IRSAMPLE, 0x4020          # IR receiver: sample interval (bus clocks)
.equ DEV_IRREJECT, 0x4024          #   glitch reject interval
.equ DEV_IRDATA, 0x4028            #   FIFO: count:4 level:1 ticks:11
.equ DEV_IRCNTL, 0x402c            #   status / control
.equ DEV_GPIOEN_CLR, 0x4118
.equ P_DATA, ${hex(0x4200 + PP.DATA)}
.equ P_CTRL, ${hex(0x4200 + PP.CTRL)}
.equ P_STAT, ${hex(0x4200 + PP.STAT)}
.equ P_CNFG, ${hex(0x4200 + PP.CNFG)}
.equ P_IEN, ${hex(0x4200 + PP.IEN)}
.equ P_ENABLE, ${hex(0x4200 + PP.ENABLE)}
.equ C_STBN, ${hex(CTRL.STB_N)}
.equ C_AUTOFDN, ${hex(CTRL.AUTOFD_N)}
.equ C_DIROUT, ${hex(CTRL.DIR_OUT)}
.equ C_IDLE, ${hex(CTRL.STB_N | CTRL.INIT_N | CTRL.AUTOFD_N | CTRL.SELIN_N | CTRL.DIR_OUT)}
.equ C_FREE, C_IDLE - C_DIROUT     # idle with the data bus released
.equ S_BUSY, ${hex(STAT.BUSY)}
.equ S_ACKN, ${hex(STAT.ACK_N)}
.equ S_FAULTN, ${hex(STAT.FAULT_N)}
.equ S_PE, ${hex(STAT.PE)}
.equ S_SEL, ${hex(STAT.SEL)}
.equ FB, ${hex(FB)}
.equ BACK, ${hex(BACK)}
.equ FB_DMA, ${hex(FB & 0x1fffffff | 0x80000000)}
.equ FB_SIZE, ${hex(STRIDE * SCREEN.H)}
.equ STRIDE, ${STRIDE}
.equ SCR_W, ${SCREEN.W}
.equ SCR_H, ${SCREEN.H}
.equ STACK, ${hex(STACK)}
.equ GLYPHS, ${LAST - FIRST + 1}

`;
// The link (PARMOD, WEBTV_LPT_BRIDGE.md §4.1, polled, box side): the same transactions as the
// OS's parmod.js. A transaction puts a code on (nSelectIn, nInit, nAutoFd), and for _OUT the
// byte on the bus, then strobes; the bridge answers with Busy high, Select (taken / a byte) and
// for _IN the byte, and lets go when nStrobe rises. The loader's protocol rides the modem channel:
// MODEM_OUT to the bridge (Select low: refused, its ring is full: again), MODEM_IN from it
// (Select low: the status byte, nothing yet).
const K_IDLE = 0x0f, K_CTRL_OUT = 0x1d, K_CTRL_IN = 0x09, K_MODEM_OUT = 0x17, K_MODEM_IN = 0x03;
const SIG = 0x4c505432;                // 'L' 'P' 'T' '2'
let xn = 0;
// one transaction: t2 = the code, a1 = the byte (_OUT); afterwards t0 = STAT, v0 = DATA. Uses t0,
// t1, t2, t9 (and t5, t6, t7 with a timeout: Count ticks to `fail`)
const XFER = (code, data, timeout = 0, fail = '') => {
  const n = xn++;
  const wait = (label, test) => timeout ? `
  li   t7, ${timeout}                     # give up after this many Count ticks
  mfc0 t5, 9                       # the start time
${label}:
  lw   t0, P_STAT(t9)
  andi t1, t0, S_BUSY
  ${test} t1, ${label}_ok
  nop
  mfc0 t6, 9
  subu t6, t6, t5
  sltu t6, t6, t7
  bnez t6, ${label}
  nop
  b    ${fail}
  nop
${label}_ok:` : `
${label}:
  lw   t0, P_STAT(t9)
  andi t1, t0, S_BUSY
  ${test === 'beqz' ? 'bnez' : 'beqz'} t1, ${label}
  nop`;
  return `
# a PARMOD transaction: wait until the last one is over (Busy low), put the code (and an _OUT
# byte) on the cable, strobe, wait for the bridge's answer (Busy high), read it, release nStrobe
  lui  t9, SOLO${wait(`xi${n}`, 'beqz')}
  li   t2, ${hex(code)}
  sw   t2, P_CTRL(t9)              # the code on nSelectIn, nInit, nAutoFd; nStrobe still high${data ? `
  sw   ${data}, P_DATA(t9)          # the byte for the bridge (DIR out in this code)` : ''}
  li   t1, 8
xs${n}:
  bnez t1, xs${n}                  # the code settles on the cable
  addiu t1, t1, -1
  xori t1, t2, C_STBN
  sw   t1, P_CTRL(t9)              # nStrobe low${wait(`xa${n}`, 'bnez')}
  lw   v0, P_DATA(t9)
  sw   t2, P_CTRL(t9)              # nStrobe high: the bridge lets go, then drops Busy
  andi v0, v0, 0xff`;
};

const LINK = () => `# ---------------------------------------------------------------- link (PARMOD, polled)

# link_init(): software mode, no interrupts, the bus released, then a session: the signature on
# CTRL_OUT, the version on CTRL_IN. Each step gives up after 1 ms (the bridge may still be the
# dongle, whose Busy is only D1) and the whole entry starts again.
.func link_init
# the port on, in software mode (CNFG 0: we drive every line ourselves), its interrupts off
  lui  t9, SOLO
  li   t0, 1
  sw   t0, P_ENABLE(t9)
  sw   zero, P_CNFG(t9)
  sw   zero, P_IEN(t9)
li_again:
# idle lines, then send the four signature bytes one CTRL_OUT transaction each; t3 holds what
# is left of the signature, top byte next, t4 counts the bytes
  li   t0, C_FREE
  sw   t0, P_CTRL(t9)
  li   t3, ${hex(SIG)}
  li   t4, 4
li_byte:
  srl  a1, t3, 24${XFER(K_CTRL_OUT, 'a1', 83000, 'li_fail')}
  andi t0, t0, S_SEL
  li   t1, 0xff
  sw   t1, P_DATA(t9)              # all ones before the next code (link_tx says why)
  beqz t0, li_fail                 # not taken
  sll  t3, t3, 8
  addiu t4, t4, -1
  bnez t4, li_byte
  nop
# all four taken: read the reply on CTRL_IN. A reply (Select high, the protocol version) means
# the bridge has opened a session for us${XFER(K_CTRL_IN, null, 83000, 'li_fail')}
  andi t0, t0, S_SEL
  beqz t0, li_fail                 # no reply: no session
  li   t0, C_FREE
  jr   ra
  sw   t0, P_CTRL(t9)
li_fail:
# no answer, or the bridge didn't take a byte: it may still be the diagnostics dongle (it switches
# to PARMOD at the end of the g line, or when test 19 boots the tier-3 area). Let the lines go,
# wait 1 ms and start over.
  lui  t9, SOLO
  li   t0, 0xff
  sw   t0, P_DATA(t9)
  li   t0, C_FREE
  sw   t0, P_CTRL(t9)
  li   t7, 83000
  mfc0 t5, 9
li_pause:                          # 1 ms, then from the start
  mfc0 t6, 9
  subu t6, t6, t5
  sltu t6, t6, t7
  bnez t6, li_pause
  nop
  b    li_again
  nop
.endfunc

# link_rx() -> v0 = byte: MODEM_IN until the bridge has one (Select high). Blocks: the loader has
# nothing else to do while a command is half read.
.func link_rx
lr_again:${XFER(K_MODEM_IN)}
  andi t0, t0, S_SEL
  beqz t0, lr_again                # the status byte: nothing yet
  li   t0, C_FREE
  jr   ra
  sw   t0, P_CTRL(t9)
.endfunc

# link_tx(a0 = byte): MODEM_OUT until the bridge takes it (Select high). Keeps v0, v1. Then the
# bus to all ones before it's released (parmod.js's pm_idle says why).
.func link_tx
  move t3, v0                      # v0 survives (callers keep a result in it)
lt_again:${XFER(K_MODEM_OUT, 'a0')}
  andi t0, t0, S_SEL
  beqz t0, lt_again                # refused: its ring is full
  move v0, t3
# taken: drive all ones, then release the bus and go idle
  li   t0, 0xff
  sw   t0, P_DATA(t9)
  li   t0, C_FREE
  jr   ra
  sw   t0, P_CTRL(t9)
.endfunc

`;

export function loaderSource() {
  let n = 0;
  // CP0 Count runs at half the 167 MHz CPU clock: 83 ticks a microsecond
  const DELAY = (us) => { n++; return `
  mfc0 t4, 9
  li   t5, ${us * 83}
dly${n}:
  mfc0 t6, 9
  nop
  subu t6, t6, t4
  sltu t6, t6, t5
  bnez t6, dly${n}
  nop`; };
  // I2C, as the boot ROM does it: read-modify-write of DEV_IICCNTL, open drain (a line is
  // released by clearing its output enable), half a bit every 5 us
  const IIC = (set, clr) => `
  li   a0, ${hex(set)}
  jal  iic_set
  li   a1, ${hex(clr)}`;
  const SCL1 = IIC(0x08, 0x10), SCL0 = IIC(0x10, 0x08), SDA1 = IIC(0x02, 0x04), SDA0 = IIC(0x04, 0x02);
  const ENTER = (regs) => `
  addiu sp, sp, -${regs.length * 4 + 8}
  sw   ra, ${regs.length * 4 + 4}(sp)` + regs.map((r, i) => `\n  sw   ${r}, ${i * 4}(sp)`).join('');
  const LEAVE = (regs) => regs.map((r, i) => `\n  lw   ${r}, ${i * 4}(sp)`).join('') + `
  lw   ra, ${regs.length * 4 + 4}(sp)
  jr   ra
  addiu sp, sp, ${regs.length * 4 + 8}`;
  const RX = (dst) => `
  jal  link_rx
  nop
  move ${dst}, v0`;
  const RXN = (k, dst) => `
  jal  rx_n
  li   a0, ${k}
  move ${dst}, v0`;
  const TX = (v) => `
  jal  link_tx
  li   a0, ${hex(v)}`;
  const navy = yuyv(16, 32, 96);

  return `
${EQU}
# ---------------------------------------------------------------- entry (must come first)

.func ldr_start
LOADER_START:
# We arrive from stage 0 or the tier-3 stub, uncached at LOADER_BASE. Take the CPU: interrupts
# off (Status.IE clear), our own stack, the link to the bridge, the screen and the IR receiver.
  mfc0 t0, 12
  li   t1, -2
  and  t0, t0, t1
  mtc0 t0, 12                      # interrupts off: the ROM's handlers stay out of our way
  nop
  nop
  la   sp, STACK
  la   t0, V_FBT                   # drawing goes to the screen (the variables aren't sent: set them)
  la   t1, FB
  sw   t1, 0(t0)
  jal  link_init
  nop
  jal  vid_init
  nop
  jal  ir_init
  nop
# The first screen, drawn before the bridge says anything: the whole screen navy, no text. The
# bridge reads the boot ROM's fonts first thing and draws its own screens in them; text here
# would be the 5x7 font, up until then.
  li   v1, ${hex(navy)}            # fill colour: the navy background
  move a0, zero
  move a1, zero
  li   a2, SCR_W
  jal  fill_rect
  li   a3, SCR_H

# The command loop. Keep the IR receiver drained and send what it caught to the bridge, then look
# at nFault: the bridge pulls it low when it has bytes for us. Each command is one byte, its
# arguments follow (protocol.js has the layouts); s0 holds the command byte.
main:
  jal  ir_poll
  nop
  jal  ir_flush
  nop
  lui  t9, SOLO
  lw   t0, P_STAT(t9)
  andi t0, t0, S_FAULTN
  bnez t0, main                    # nFault high: nothing from the bridge yet
  nop${RX('s0')}
  li   t0, ${CMD.HELLO}
  beq  s0, t0, cmd_hello
  li   t0, ${CMD.FILL}
  beq  s0, t0, cmd_fill
  li   t0, ${CMD.TEXT}
  beq  s0, t0, cmd_text
  li   t0, ${CMD.SYNC}
  beq  s0, t0, cmd_sync
  li   t0, ${CMD.RESET}
  beq  s0, t0, cmd_reset
  li   t0, ${CMD.READ}
  beq  s0, t0, cmd_read
  li   t0, ${CMD.WRITE}
  beq  s0, t0, cmd_write
  li   t0, ${CMD.CALL}
  beq  s0, t0, cmd_call
  li   t0, ${CMD.TEXT2}
  beq  s0, t0, cmd_text2
  li   t0, ${CMD.VFILT}
  beq  s0, t0, cmd_vfilt
  li   t0, ${CMD.TARGET}
  beq  s0, t0, cmd_target
  li   t0, ${CMD.COPY}
  beq  s0, t0, cmd_copy
  nop
# not a command we know: answer ERR (0xee) and the byte, so the bridge can tell we lost step${TX(MSG.ERR)}
  jal  link_tx
  move a0, s0
  b    main
  nop

# HELLO: answer 0x81 'L' 'D' 'R' and our protocol version; the bridge checks it before it relies
# on READ, WRITE and CALL
cmd_hello:${TX(MSG.HELLO)}${TX(0x4c)}${TX(0x44)}${TX(0x52)}${TX(LDR_VERSION)}
  b    main
  nop

# FILL x:2 y:2 w:2 h:2 colour:4 (s1-s5): a filled rectangle; no reply
cmd_fill:${RXN(2, 's1')}${RXN(2, 's2')}${RXN(2, 's3')}${RXN(2, 's4')}${RXN(4, 's5')}
  move a0, s1
  move a1, s2
  move a2, s3
  move a3, s4
  jal  fill_rect
  move v1, s5
  b    main
  nop

# TEXT x:2 y:2 scale:1 fg:4 bg:4 count:1, then the characters: s1 x, s2 y, s3 scale, s4 fg,
# s5 bg, s6 count. The characters go to TEXTBUF first (s0 counts them), then draw_text; no reply.
cmd_text:${RXN(2, 's1')}${RXN(2, 's2')}${RX('s3')}${RXN(4, 's4')}${RXN(4, 's5')}${RX('s6')}
  la   s7, TEXTBUF
  move s0, zero
cmd_text_char:
  beq  s0, s6, cmd_text_draw
  nop${RX('t0')}
  addu t1, s7, s0
  sb   t0, 0(t1)
  b    cmd_text_char
  addiu s0, s0, 1
cmd_text_draw:
# clamp the scale to 1..4 (0 becomes 1, anything over 4 becomes 4), then set V_SCALE for draw_text
  bnez s3, cmd_text_s1
  sltiu t0, s3, 5
  li   s3, 1
cmd_text_s1:
  bnez t0, cmd_text_s2
  nop
  li   s3, 4
cmd_text_s2:
  la   t0, V_SCALE
  sw   s3, 0(t0)
  sw   s4, 4(t0)
  sw   s5, 8(t0)
  move a0, s1
  move a1, s2
  move a2, s7
  jal  draw_text
  move a3, s6
  b    main
  nop

# TEXT2 strike:4 x:2 y:2 fg:4 count:1, then the characters: text in one of the boot ROM's own
# font strikes (strike.js has the format; the bridge finds them in the ROM filesystem), drawn
# at the screen's own resolution with each glyph's 4-bit coverage blended from what is already
# there towards fg. x is the pen, y the baseline. No reply. s1 strike, s2 x, s3 y, s4 fg, s6 count.
cmd_text2:${RXN(4, 's1')}${RXN(2, 's2')}${RXN(2, 's3')}${RXN(4, 's4')}${RX('s6')}
  la   s7, TEXTBUF
  move s0, zero
cmd_text2_char:
  beq  s0, s6, cmd_text2_draw
  nop${RX('t0')}
  addu t1, s7, s0
  sb   t0, 0(t1)
  b    cmd_text2_char
  addiu s0, s0, 1
cmd_text2_draw:
  la   t0, V_T2
  sw   s7, 0(t0)                   # the characters
  sw   s6, 4(t0)                   # how many
  lui  t0, 0x2000
  or   a0, s1, t0                  # the strike, read uncached (kseg1)
  move a1, s2
  move a2, s3
  jal  draw_strike
  move a3, s4
  b    main
  nop

# VFILT x:2 y:2 w:2 h:2: the OS's vertical flicker filter over a rectangle, in place; no reply
cmd_vfilt:${RXN(2, 's1')}${RXN(2, 's2')}${RXN(2, 's3')}${RXN(2, 's4')}
  move a0, s1
  move a1, s2
  move a2, s3
  jal  vfilt
  move a3, s4
  b    main
  nop

# TARGET which:1: FILL, TEXT, TEXT2 and VFILT draw on the screen (0) or the back buffer (1); no reply
cmd_target:${RX('s1')}
  la   t0, FB
  beqz s1, cmd_target_set
  nop
  la   t0, BACK
cmd_target_set:
  la   t1, V_FBT
  sw   t0, 0(t1)
  b    main
  nop

# COPY dir:1 x:2 y:2 w:2 h:2: a rectangle from the back buffer to the screen (dir 0) or from the
# screen to the back buffer (1), the same place in each; x and w widened to pixel pairs, clipped
# to the screen; no reply
cmd_copy:${RX('s5')}${RXN(2, 's1')}${RXN(2, 's2')}${RXN(2, 's3')}${RXN(2, 's4')}
  sltiu t0, s1, SCR_W
  beqz t0, main
  sltiu t0, s2, SCR_H
  beqz t0, main
  andi t0, s1, 1                   # (delay slot) widen to pixel pairs
  subu s1, s1, t0
  addu s3, s3, t0
  addiu s3, s3, 1
  srl  s3, s3, 1                   # words a row
  sll  t0, s3, 1
  addu t0, s1, t0                  # clip the right
  sltiu t1, t0, SCR_W + 1
  bnez t1, cmd_copy_w
  nop
  li   s3, SCR_W
  subu s3, s3, s1
  srl  s3, s3, 1
cmd_copy_w:
  addu t0, s2, s4                  # clip the bottom
  sltiu t1, t0, SCR_H + 1
  bnez t1, cmd_copy_h
  nop
  li   s4, SCR_H
  subu s4, s4, s2
cmd_copy_h:
  sll  t0, s2, 10                  # offset = y * 1120 + x * 2
  sll  t1, s2, 6
  addu t0, t0, t1
  sll  t1, s2, 5
  addu t0, t0, t1
  sll  t1, s1, 1
  addu t0, t0, t1
  la   s6, BACK
  addu s6, s6, t0                  # from
  la   s7, FB
  addu s7, s7, t0                  # to
  beqz s5, cmd_copy_row
  nop
  move t0, s6                      # dir 1: the other way
  move s6, s7
  move s7, t0
cmd_copy_row:
  beqz s4, main
  nop
  jal  ir_poll
  nop
  move t2, s6
  move t3, s7
  move t4, s3
cmd_copy_word:
  beqz t4, cmd_copy_next
  nop
  lw   t5, 0(t2)
  addiu t2, t2, 4
  sw   t5, 0(t3)
  addiu t3, t3, 4
  b    cmd_copy_word
  addiu t4, t4, -1
cmd_copy_next:
  addiu s6, s6, STRIDE
  addiu s7, s7, STRIDE
  b    cmd_copy_row
  addiu s4, s4, -1

# READ / WRITE addr:4 width:1 count:2: s1 address, s2 width (1, 2 or 4 bytes), s3 count; checked
# first against MEM_RANGES. READ answers DATA (0x92) count:2, then each item, most significant
# byte first; a bad request gets FAULT (0x9f) and the reason instead.
cmd_read:${RXN(4, 's1')}${RX('s2')}${RXN(2, 's3')}
  move a0, s1
  move a1, s2
  jal  mem_check
  move a2, s3
  bnez v0, cmd_fault
  move s4, v0                      # (delay slot) the reason, for cmd_fault${TX(MSG.DATA)}
  jal  link_tx
  srl  a0, s3, 8
  jal  link_tx
  andi a0, s3, 0xff
cmd_read_item:
  beqz s3, main
  andi t0, s3, 63                  # keep the IR receiver drained on long reads
  bnez t0, cmd_read_load
  nop
  jal  ir_poll
  nop
cmd_read_load:
# one item of the given width -> s5, its size in bytes -> s6
  li   t0, 4
  beq  s2, t0, cmd_read_w
  li   t0, 2
  beq  s2, t0, cmd_read_h
  nop
  lbu  s5, 0(s1)
  b    cmd_read_send
  li   s6, 1
cmd_read_h:
  lhu  s5, 0(s1)
  b    cmd_read_send
  li   s6, 2
cmd_read_w:
  lw   s5, 0(s1)
  li   s6, 4
cmd_read_send:                     # s6 bytes of s5, most significant first
  addu s1, s1, s6
cmd_read_byte:
  addiu s6, s6, -1
  sll  t0, s6, 3
  srlv a0, s5, t0
  jal  link_tx
  andi a0, a0, 0xff
  bnez s6, cmd_read_byte
  nop
  b    cmd_read_item
  addiu s3, s3, -1

# WRITE: the same header, then count items of width bytes each. Answers DONE (0x93), or FAULT
# and the reason once all the data has been read.
cmd_write:${RXN(4, 's1')}${RX('s2')}${RXN(2, 's3')}
  move a0, s1
  move a1, s2
  jal  mem_check
  move a2, s3
  move s4, v0                      # bad: still read the data (to stay in step), store nothing
cmd_write_item:
  beqz s3, cmd_write_end
  nop
  jal  rx_n
  move a0, s2                      # (delay slot) read one item of the width
  bnez s4, cmd_write_next          # a bad request: drop it
  li   t0, 4
  beq  s2, t0, cmd_write_w
  li   t0, 2
  beq  s2, t0, cmd_write_h
  nop
  b    cmd_write_next
  sb   v0, 0(s1)
cmd_write_h:
  b    cmd_write_next
  sh   v0, 0(s1)
cmd_write_w:
  sw   v0, 0(s1)
cmd_write_next:
  addu s1, s1, s2
  b    cmd_write_item
  addiu s3, s3, -1
cmd_write_end:
  bnez s4, cmd_fault
  nop${TX(MSG.DONE)}
  b    main
  nop

cmd_fault:                         # FAULT (0x9f), then s4: why (1 out of range, 2 unaligned, 3 bad width)${TX(MSG.FAULT)}
  jal  link_tx
  move a0, s4
  b    main
  nop

# CALL addr:4 a0..a3: call it and answer with v0 (interrupts stay off; on our stack). s1 the
# address, s2-s5 the arguments. This is how the bridge runs disk_read, disk_write, sum_words
# and boot_ram, and the tier-3 updater. The answer is RET (0x94) and v0, most significant first.
cmd_call:${RXN(4, 's1')}${RXN(4, 's2')}${RXN(4, 's3')}${RXN(4, 's4')}${RXN(4, 's5')}
  move a0, s2
  move a1, s3
  move a2, s4
  jalr s1
  move a3, s5
  move s1, v0${TX(MSG.RET)}
  li   s2, 4
cmd_call_byte:
  addiu s2, s2, -1
  sll  t0, s2, 3
  srlv a0, s1, t0
  jal  link_tx
  andi a0, a0, 0xff
  bnez s2, cmd_call_byte
  nop
  b    main
  nop

# RESET: a cold boot. Clear RAM (all but this code; a precaution, see buildZap) through kseg1,
# below the loader and then above it to the 8 MB top, then the boot ROM's own reset: 7 to
# BUS_RESETCAUSE. No reply: the box is gone a moment later.
cmd_reset:
  lui  t0, 0xa000                  # RAM's start, uncached
  la   t1, LOADER_START
cmd_reset_low:
  sw   zero, 0(t0)
  addiu t0, t0, 4
  bne  t0, t1, cmd_reset_low
  nop
  la   t0, LOADER_END
  lui  t1, 0xa080                  # the end of 8 MB of RAM
cmd_reset_high:
  sw   zero, 0(t0)
  addiu t0, t0, 4
  bne  t0, t1, cmd_reset_high
  nop
  lui  t9, SOLO
  li   t0, 7
  sw   t0, 0xa8(t9)
cmd_reset_wait:
  b    cmd_reset_wait
  nop

# SYNC n: answer SYNC (0x84) n. The bridge uses it to know that everything it sent before has
# been done.
cmd_sync:${RX('s1')}${TX(MSG.SYNC)}
  jal  link_tx
  move a0, s1
  b    main
  nop
.endfunc

${LINK()}# rx_n(a0 = count) -> v0 = that many bytes, big-endian
.func rx_n${ENTER(['s0', 's1'])}
  move s0, a0
  move s1, zero
rx_n_loop:                         # s0 bytes left, s1 the value so far
  jal  link_rx
  nop
  sll  s1, s1, 8
  or   s1, s1, v0
  addiu s0, s0, -1
  bnez s0, rx_n_loop
  nop
  move v0, s1${LEAVE(['s0', 's1'])}
.endfunc

# ---------------------------------------------------------------- video

# vid_init(): the boot ROM ColorPage test's sequence, on our framebuffer. The vidUnit fetches
# FB by DMA (a kseg0 address) and the potUnit puts a 560 x 420 window of it on screen; the rest
# of the picture is the blank colour. The boot ROM programmed the SAA7187 encoder at cold boot;
# we only power the RF modulator and set its register 0x61.
.func vid_init${ENTER([])}
  lui  t9, SOLO
  lui  t8, SOLO_HI
  la   t0, FB_DMA                  # where the framebuffer DMA starts
  sw   t0, VID_NSTART(t9)
  li   t0, FB_SIZE
  sw   t0, VID_NSIZE(t9)
  li   t0, 0x230                   # 560 pixels
  sw   t0, POT_HSIZE(t8)
  li   t0, 0x1a4                   # 420 lines
  sw   t0, POT_VSIZE(t8)
  li   t0, 0x9f                    # where the window starts: these centre it on the TV
  sw   t0, POT_HSTART(t8)
  li   t0, 0x45
  sw   t0, POT_VSTART(t8)
  li   t0, 0x1f                    # framebuffer DMA on
  sw   t0, VID_DMACNTL(t9)
  li   t0, 0x108080                # black border: Y 0x10, Cb Cr 0x80 (this also ends the
  sw   t0, POT_BLANK(t8)           # diagnostics' magenta, if the bridge hasn't already)
  li   t0, 0x941                   # on, framebuffer (not gfxUnit) source
  sw   t0, POT_CNTL(t8)
  li   t0, 1
  sw   t0, DEV_GPIOEN_CLR(t9)      # RF modulator power on
  li   a0, 0x8c                    # SAA7187: register 0x61 = 0x15
  li   a1, 0x61
  jal  iic_write
  li   a2, 0x15${LEAVE([])}
.endfunc

# fill_rect(a0 = x, a1 = y, a2 = w, a3 = h, v1 = colour as a Y Cb Y Cr word); x and w are
# rounded to whole pixel pairs, and the rectangle is clipped to the screen. Polls the IR
# receiver every row (keeping its return address in t7).
.func fill_rect
  move t7, ra
# off screen altogether: nothing to do. Then clip w and h to the screen's right and bottom edges.
  sltiu t0, a0, SCR_W
  beqz t0, fill_rect_done
  sltiu t0, a1, SCR_H
  beqz t0, fill_rect_done
  li   t1, SCR_W
  subu t1, t1, a0
  sltu t0, t1, a2
  beqz t0, fill_rect_cw
  nop
  move a2, t1
fill_rect_cw:
  li   t1, SCR_H
  subu t1, t1, a1
  sltu t0, t1, a3
  beqz t0, fill_rect_ch
  nop
  move a3, t1
fill_rect_ch:
# a 4:2:2 word is two pixels, so start on an even x and count pixel pairs, rounding up
  andi t0, a0, 1
  subu a0, a0, t0
  addu a2, a2, t0
  addiu a2, a2, 1
  srl  a2, a2, 1                   # pixel pairs
  beqz a2, fill_rect_done
  nop
  beqz a3, fill_rect_done
  sll  t0, a1, 10                  # t0 = FB + y * 1120 + x * 2: 1120 = 1024 + 64 + 32 bytes a line
  sll  t1, a1, 6
  addu t0, t0, t1
  sll  t1, a1, 5
  addu t0, t0, t1
  sll  t1, a0, 1
  addu t0, t0, t1
  la   t1, V_FBT
  lw   t1, 0(t1)              # the target: FB, or BACK after TARGET 1
  addu t0, t0, t1
fill_rect_row:                     # a row: t2 walks it, t3 counts pixel pairs
  jal  ir_poll
  move t2, t0
  move t3, a2
fill_rect_col:
  sw   v1, 0(t2)
  addiu t3, t3, -1
  bnez t3, fill_rect_col
  addiu t2, t2, 4
  addiu a3, a3, -1
  bnez a3, fill_rect_row
  addiu t0, t0, STRIDE
fill_rect_done:
  jr   t7
  nop
.endfunc

# draw_text(a0 = x, a1 = y, a2 = chars, a3 = count) in V_SCALE / V_FG / V_BG. A glyph pixel is
# 2 * scale pixels square (one 4:2:2 word wide, and 2 lines so the interlaced TV doesn't
# flicker), so a character cell is 12 x 16 at scale 1. Stops at the screen edge.
.func draw_text${ENTER(['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7'])}
# s0 x, s1 y, s2 the next character, s3 characters left, s4 scale, s5 fg, s6 bg, s7 glyph rows
  la   t0, V_SCALE
  lw   s4, 0(t0)
  lw   s5, 4(t0)                   # fg
  lw   s6, 8(t0)                   # bg
  li   t0, -2
  and  s0, a0, t0                  # even x
  move s1, a1
  move s2, a2
  move s3, a3
draw_text_char:
# stop when the characters run out, or when the next cell would not fit on the screen
  jal  ir_poll
  nop
  beqz s3, draw_text_done
  sll  t0, s4, 3                   # cell width 12 * scale
  sll  t1, s4, 2
  addu t0, t0, t1
  addu t1, s0, t0
  sltiu t2, t1, SCR_W + 1
  beqz t2, draw_text_done
  sll  t1, s4, 4                   # cell height 16 * scale
  addu t1, s1, t1
  sltiu t2, t1, SCR_H + 1
  beqz t2, draw_text_done
  nop
# the glyph: 8 bytes a character from the space up; anything outside the font draws as '?'
  lbu  t0, 0(s2)
  addiu t1, t0, -${FIRST}
  sltiu t2, t1, GLYPHS
  bnez t2, draw_text_known
  nop
  li   t1, ${'?'.charCodeAt(0) - FIRST}
draw_text_known:
  sll  t1, t1, 3
  la   t2, FONT
  addu s7, t2, t1                  # glyph rows
  sll  t3, s1, 10                  # dest = FB + y * 1120 + x * 2
  sll  t4, s1, 6
  addu t3, t3, t4
  sll  t4, s1, 5
  addu t3, t3, t4
  sll  t4, s0, 1
  addu t3, t3, t4
  la   t4, V_FBT
  lw   t4, 0(t4)              # the target: FB, or BACK after TARGET 1
  addu t3, t3, t4
  li   t4, 8
# 8 glyph rows (t4). Each row byte has the 5 pixels in its top bits; it is drawn 2 * scale lines
# tall (t6), and each glyph pixel is scale words wide (a0), fg for a 1 and bg for a 0.
draw_text_row:
  lbu  t5, 0(s7)
  sll  t6, s4, 1                   # 2 * scale lines a glyph row
draw_text_line:
  move t7, t3
  move t8, t5
  li   t9, 6                       # 5 glyph columns and a blank one
draw_text_col:
  andi v0, t8, 0x80
  beqz v0, draw_text_put
  move v1, s6                      # (delay slot) bg; overwritten with fg when the bit is set
  move v1, s5
draw_text_put:
  move a0, s4
draw_text_word:
  sw   v1, 0(t7)
  addiu a0, a0, -1
  bnez a0, draw_text_word
  addiu t7, t7, 4
  addiu t9, t9, -1
  bnez t9, draw_text_col
  sll  t8, t8, 1
  addiu t6, t6, -1
  bnez t6, draw_text_line
  addiu t3, t3, STRIDE
  addiu t4, t4, -1
  bnez t4, draw_text_row
  addiu s7, s7, 1
# the next cell: x += 12 * scale
  sll  t0, s4, 3
  sll  t1, s4, 2
  addu t0, t0, t1
  addu s0, s0, t0
  addiu s2, s2, 1
  b    draw_text_char
  addiu s3, s3, -1
draw_text_done:${LEAVE(['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7'])}
.endfunc

# draw_strike(a0 = strike (kseg1), a1 = pen x, a2 = baseline y, a3 = fg; V_T2 the characters
# and their count): each character's glyph from the strike (strike.js: the character entry, its
# metrics and its glyph), drawn by glyph_blit at (pen - left, baseline - top); the pen moves by
# the advance, kept in 1/16 px. Characters the strike lacks are skipped.
.func draw_strike${ENTER(['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7'])}
# s0 strike, s1 pen (1/16 px), s2 baseline, s3 fg, s4 the next character, s5 characters left,
# s6 metrics table, s7 glyph table; V_T2+8 the bitmaps
  move s0, a0
  sll  s1, a1, 4
  move s2, a2
  move s3, a3
  la   t0, V_T2
  lw   s4, 0(t0)
  lw   s5, 4(t0)
  lbu  t1, ${0x3c + 0x7e0}(s0)      # metrics count, big-endian halfword
  lbu  t2, ${0x3c + 0x7e1}(s0)
  sll  t1, t1, 8
  or   t1, t1, t2
  lbu  t3, ${0x3c + 0x7e4}(s0)      # glyph count
  addiu s6, s0, ${0x3c + 0x7e8}
  sll  t1, t1, 2
  addu s7, s6, t1
  sll  t3, t3, 2
  addu t3, s7, t3
  sw   t3, 8(t0)
draw_strike_char:
  jal  ir_poll
  nop
  beqz s5, draw_strike_done
  addiu s5, s5, -1
  lbu  t0, 0(s4)
  addiu s4, s4, 1
  addiu t0, t0, -32                # the table starts at the space
  sltiu t1, t0, 224
  beqz t1, draw_strike_char
  sll  t0, t0, 2
  addu t0, t0, s0
  lbu  t1, ${0x3c + 0xe0}(t0)       # metrics index
  lbu  t2, ${0x3c + 0xe1}(t0)       # glyph index (255: none)
  li   t3, 0xff
  beq  t2, t3, draw_strike_char
  sll  t1, t1, 2
  addu t1, s6, t1
  lb   t4, 0(t1)                   # advance, signed big-endian halfword
  lbu  t5, 1(t1)
  sll  t4, t4, 8
  or   t4, t4, t5
  lb   t6, 2(t1)                   # left
  lb   t7, 3(t1)                   # top
  sll  t2, t2, 2
  addu t2, s7, t2
  lbu  t8, 0(t2)                   # bitmap offset, big-endian halfword
  lbu  t9, 1(t2)
  sll  t8, t8, 8
  or   t8, t8, t9
  lbu  a1, 2(t2)
  andi a1, a1, 0x7f                # width
  lbu  a2, 3(t2)                   # height
  la   t0, V_T2
  lw   t1, 8(t0)
  addu a0, t1, t8                  # the bitmap
  subu t1, s2, t7
  sw   t1, 12(t0)                  # y = baseline - top
  addiu t0, s1, 8
  sra  t0, t0, 4
  subu a3, t0, t6                  # x = pen (rounded) - left
  jal  glyph_blit
  addu s1, s1, t4                  # (delay slot) the pen moves on
  b    draw_strike_char
  nop
draw_strike_done:${LEAVE(['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7'])}
.endfunc

# glyph_blit(a0 = bitmap, a1 = width, a2 = height, a3 = x; V_T2+12 = y; s3 = fg): the glyph's
# nibbles decoded as the OS's DecompressGlyph does (strike.js: a nibble with bit 3 set is a run
# of (n & 3) + 2 pixels, all 15 if bit 2 else all 0; otherwise one pixel of 3-bit coverage,
# widened to (n << 1) | (n >> 2)), and each pixel's coverage a (0-15) blended into the screen:
# Y, and the pair's Cb and Cr, move from what is there towards fg by a * 17 / 256. Clipped to
# the screen. A leaf: t0-t9, v0, v1 only.
.func glyph_blit
  la   t0, V_T2
  lw   v1, 12(t0)                  # y
  move t8, zero                    # 1: the low nibble of the byte at a0 is next
  move t9, zero                    # pixels left in a run
  move t7, zero                    # the run's coverage
glyph_blit_row:
  beqz a2, glyph_blit_done
  move t6, a1                      # (delay slot) columns left
  move t5, a3                      # x
glyph_blit_col:
  beqz t6, glyph_blit_next_row
  nop
  beqz t9, glyph_blit_nibble
  nop
  addiu t9, t9, -1
  b    glyph_blit_have
  move v0, t7
glyph_blit_nibble:
  lbu  t0, 0(a0)
  bnez t8, glyph_blit_low
  nop
  srl  t0, t0, 4
  b    glyph_blit_n
  li   t8, 1
glyph_blit_low:
  andi t0, t0, 15
  addiu a0, a0, 1
  move t8, zero
glyph_blit_n:
  andi t1, t0, 8
  beqz t1, glyph_blit_px
  andi t1, t0, 3
  addiu t9, t1, 1                  # a run: this pixel and (n & 3) + 1 more
  andi t1, t0, 4
  beqz t1, glyph_blit_run
  move t7, zero
  li   t7, 15
glyph_blit_run:
  b    glyph_blit_have
  move v0, t7
glyph_blit_px:
  sll  t1, t0, 1
  srl  t2, t0, 2
  or   v0, t1, t2
glyph_blit_have:
  beqz v0, glyph_blit_skip
  sltiu t0, t5, SCR_W              # (delay slot) on the screen? (unsigned: negative is off)
  beqz t0, glyph_blit_skip
  sltiu t0, v1, SCR_H
  beqz t0, glyph_blit_skip
  sll  t0, v1, 10                  # (delay slot) the pair = FB + y * 1120 + (x & ~1) * 2
  sll  t1, v1, 6
  addu t0, t0, t1
  sll  t1, v1, 5
  addu t0, t0, t1
  li   t1, -2
  and  t1, t5, t1
  sll  t1, t1, 1
  addu t0, t0, t1
  la   t1, V_FBT
  lw   t1, 0(t1)              # the target: FB, or BACK after TARGET 1
  addu t0, t0, t1                  # Y0 Cb Y1 Cr
  sll  t2, v0, 4
  addu v0, t2, v0                  # a * 17: 0-255
  andi t1, t5, 1
  sll  t1, t1, 1
  addu t1, t0, t1                  # this pixel's Y
  lbu  t2, 0(t1)
  srl  t3, s3, 24
  subu t3, t3, t2
  mult t3, v0
  mflo t3
  sra  t3, t3, 8
  addu t2, t2, t3
  sb   t2, 0(t1)
  lbu  t2, 1(t0)                   # Cb
  srl  t3, s3, 16
  andi t3, t3, 0xff
  subu t3, t3, t2
  mult t3, v0
  mflo t3
  sra  t3, t3, 8
  addu t2, t2, t3
  sb   t2, 1(t0)
  lbu  t2, 3(t0)                   # Cr
  andi t3, s3, 0xff
  subu t3, t3, t2
  mult t3, v0
  mflo t3
  sra  t3, t3, 8
  addu t2, t2, t3
  sb   t2, 3(t0)
glyph_blit_skip:
  addiu t5, t5, 1
  b    glyph_blit_col
  addiu t6, t6, -1
glyph_blit_next_row:
  addiu v1, v1, 1
  b    glyph_blit_row
  addiu a2, a2, -1
glyph_blit_done:
  jr   ra
  nop
.endfunc

# vfilt(a0 = x, a1 = y, a2 = w, a3 = h): the OS's vertical flicker filter (16406
# FilterBlitYUYVtoYUYV) over a rectangle, in place: every byte (Y, Cb, Y, Cr) becomes
# avg(avg(above, below), itself), avg(a, b) = ((a & 0xfe) >> 1) + ((b & 0xfe) >> 1) + (a & b & 1),
# done a word (two pixels) at a time with the OS's masks. Down each word column, keeping the
# row above as it was before filtering, so the result is the OS's, which filters from a copy.
# Rows above and below the rectangle are read as they are; off the screen, the row itself.
# x and w are widened to whole pixel pairs; clipped to the screen. A leaf: t0-t9, v0, v1, a0-a3.
.func vfilt
  sltiu t0, a0, SCR_W
  beqz t0, vfilt_done
  sltiu t0, a1, SCR_H
  beqz t0, vfilt_done
  andi t0, a0, 1                   # (delay slot) widen to pixel pairs
  subu a0, a0, t0
  addu a2, a2, t0
  addiu a2, a2, 1
  srl  a2, a2, 1                   # words a row
  addu t0, a1, a3                  # clip the bottom
  sltiu t1, t0, SCR_H + 1
  bnez t1, vfilt_h_ok
  nop
  li   a3, SCR_H
  subu a3, a3, a1
vfilt_h_ok:
  sll  t0, a2, 1
  addu t0, a0, t0                  # clip the right
  sltiu t1, t0, SCR_W + 1
  bnez t1, vfilt_w_ok
  nop
  li   a2, SCR_W
  subu a2, a2, a0
  srl  a2, a2, 1
vfilt_w_ok:
  lui  t8, 0xfefe
  ori  t8, t8, 0xfefe
  lui  t9, 0x0101
  ori  t9, t9, 0x0101
  sll  t2, a1, 10                  # the first word: FB + y * 1120 + x * 2
  sll  t3, a1, 6
  addu t2, t2, t3
  sll  t3, a1, 5
  addu t2, t2, t3
  sll  t3, a0, 1
  addu t2, t2, t3
  la   t3, V_FBT
  lw   t3, 0(t3)              # the target: FB, or BACK after TARGET 1
  addu t2, t2, t3
vfilt_col:
  beqz a2, vfilt_done
  move t3, t2                      # (delay slot) down this column
  lw   t5, 0(t3)                   # the row itself
  move t4, t5                      # the row above, as it was (the row itself at the top)
  beqz a1, vfilt_rows
  nop
  lw   t4, -STRIDE(t3)
vfilt_rows:
  move v1, a3                      # rows left
  move t7, a1                      # this row's y
vfilt_row:
  beqz v1, vfilt_next_col
  addiu t0, t7, 1                  # (delay slot) the row below, or the row itself off the bottom
  sltiu t0, t0, SCR_H
  beqz t0, vfilt_have_below
  move t6, t5
  lw   t6, STRIDE(t3)
vfilt_have_below:
  and  t0, t4, t8
  srl  t0, t0, 1
  and  t1, t6, t8
  srl  t1, t1, 1
  addu t0, t0, t1
  and  t1, t4, t6
  and  t1, t1, t9
  addu v0, t0, t1
  and  t0, v0, t8
  srl  t0, t0, 1
  and  t1, t5, t8
  srl  t1, t1, 1
  addu t0, t0, t1
  and  t1, v0, t5
  and  t1, t1, t9
  addu v0, t0, t1
  sw   v0, 0(t3)
  move t4, t5                      # the next row's above: this row as it was
  move t5, t6
  addiu t3, t3, STRIDE
  addiu t7, t7, 1
  b    vfilt_row
  addiu v1, v1, -1
vfilt_next_col:
  addiu t2, t2, 4
  b    vfilt_col
  addiu a2, a2, -1
vfilt_done:
  jr   ra
  nop
.endfunc

# ---------------------------------------------------------------- disk (ATA PIO), for the bridge's CALLs

# The registers are 32-bit accesses, low byte (the data register: low 16 bits), as the boot ROM
# does them; drive 0, LBA addressing. A sector's 256 data words are stored as big-endian
# halfwords, which undoes the drive's byte order: what lands in RAM is the image as the boot
# ROM loads it. Each wait gives up after 2 s.
.equ ATA, 0xbe40                   # lui: command block (kseg1)
.equ ATA_DATA, 0x00
.equ ATA_FEAT, 0x04
.equ ATA_COUNT, 0x08
.equ ATA_LBA0, 0x0c
.equ ATA_LBA1, 0x10
.equ ATA_LBA2, 0x14
.equ ATA_DEV, 0x18
.equ ATA_CMD, 0x1c                 # status on read
.equ ATA_CTL, 0xbe80               # lui: control block; device control / alt status at +0x18
.equ T_ATA, 166000000              # Count ticks: 2 s

# ata_wait(a0 = 1 to also want DRQ) -> v0 = 0 ready; 0x100 | error register on ERR; -1 timed
# out (leaf; t0-t5)
.func ata_wait
# poll the status register: busy -> keep waiting (up to 2 s); error -> the error register;
# DRQ (the drive wants or has data) or, when not asked for DRQ, simply not busy -> ready
  mfc0 t4, 9
  li   t5, T_ATA
ata_wait_poll:
  lui  t9, ATA
  lw   t0, ATA_CMD(t9)
  andi t0, t0, 0xff
  andi t1, t0, 0x80
  bnez t1, ata_wait_time           # BSY
  andi t1, t0, 0x01
  bnez t1, ata_wait_err            # ERR
  andi t1, t0, 0x08
  bnez t1, ata_wait_ok             # DRQ
  nop
  beqz a0, ata_wait_ok             # not waiting for DRQ: ready
  nop
ata_wait_time:
  mfc0 t1, 9
  nop
  subu t1, t1, t4
  sltu t1, t1, t5
  bnez t1, ata_wait_poll
  nop
  jr   ra
  li   v0, -1
ata_wait_err:
  lw   v0, ATA_FEAT(t9)
  andi v0, v0, 0xff
  jr   ra
  ori  v0, v0, 0x100
ata_wait_ok:
  jr   ra
  move v0, zero
.endfunc

# ata_cmd(a0 = LBA, a1 = sectors 1..256, a2 = command) -> v0 = 0 issued, else as ata_wait
.func ata_cmd${ENTER(['s0', 's1', 's2'])}
# wait for the drive to be idle, then load the task file (LBA 28 split over four registers, the
# sector count) and write the command last, which starts it. s0 LBA, s1 count, s2 command.
  move s0, a0
  move s1, a1
  move s2, a2
  jal  ata_wait
  move a0, zero
  bnez v0, ata_cmd_out
  lui  t9, ATA_CTL
  sw   zero, 0x18(t9)              # device control: interrupts on, no reset (as the ROM)
  lui  t9, ATA
  sw   zero, ATA_FEAT(t9)
  srl  t0, s0, 24
  andi t0, t0, 0x0f
  ori  t0, t0, 0xe0                # LBA, drive 0
  sw   t0, ATA_DEV(t9)
  andi t0, s1, 0xff                # 256 -> 0
  sw   t0, ATA_COUNT(t9)
  andi t0, s0, 0xff
  sw   t0, ATA_LBA0(t9)
  srl  t0, s0, 8
  andi t0, t0, 0xff
  sw   t0, ATA_LBA1(t9)
  srl  t0, s0, 16
  andi t0, t0, 0xff
  sw   t0, ATA_LBA2(t9)
  sw   s2, ATA_CMD(t9)
  move v0, zero
ata_cmd_out:${LEAVE(['s0', 's1', 's2'])}
.endfunc

# disk_read(a0 = LBA, a1 = sectors 1..256, a2 = RAM address) -> v0 = 0, or the error
# (ata_wait). Keeps the IR receiver drained between sectors.
.func disk_read${ENTER(['s0', 's1', 's2'])}
  move s1, a1
  move s2, a2
  jal  ata_cmd
  li   a2, 0x20                    # READ SECTORS
  bnez v0, disk_read_out
  move s0, s1
disk_read_sector:                  # s0 sectors left, s2 where the next one goes
  jal  ata_wait
  li   a0, 1                       # a sector is ready when DRQ is set
  bnez v0, disk_read_out
  li   t1, 256
  lui  t9, ATA
disk_read_word:                    # 256 16-bit words a sector
  lw   t0, ATA_DATA(t9)
  addiu t1, t1, -1
  sh   t0, 0(s2)
  bnez t1, disk_read_word
  addiu s2, s2, 2
  jal  ir_poll
  nop
  addiu s0, s0, -1
  bnez s0, disk_read_sector
  nop
  move v0, zero
disk_read_out:${LEAVE(['s0', 's1', 's2'])}
.endfunc

# disk_write(a0 = LBA, a1 = sectors 1..256, a2 = RAM address) -> v0 = 0, or the error
.func disk_write${ENTER(['s0', 's1', 's2'])}
  move s1, a1
  move s2, a2
  jal  ata_cmd
  li   a2, 0x30                    # WRITE SECTORS
  bnez v0, disk_write_out
  move s0, s1
disk_write_sector:                 # s0 sectors left, s2 the next one's data
  jal  ata_wait
  li   a0, 1                       # the drive is ready for a sector when DRQ is set
  bnez v0, disk_write_out
  li   t1, 256
  lui  t9, ATA
disk_write_word:
  lhu  t0, 0(s2)
  addiu t1, t1, -1
  sw   t0, ATA_DATA(t9)
  bnez t1, disk_write_word
  addiu s2, s2, 2
  jal  ir_poll
  nop
  addiu s0, s0, -1
  bnez s0, disk_write_sector
  nop
  jal  ata_wait                    # the last sector written
  move a0, zero
disk_write_out:${LEAVE(['s0', 's1', 's2'])}
.endfunc

# sum_words(a0 = address, a1 = words, a2 = index to leave out, or -1) -> v0 = their 32-bit sum:
# the code checksum (index 2 left out) and the ROM filesystem's (none), as the boot ROM checks
# them before it boots an OS from RAM
.func sum_words
  move v0, zero
  move t1, zero
sum_words_next:
  beq  t1, a1, sum_words_done
  nop
  beq  t1, a2, sum_words_skip
  lw   t0, 0(a0)
  addu v0, v0, t0
sum_words_skip:
  addiu a0, a0, 4
  andi t2, t1, 0xffff
  bnez t2, sum_words_next          # every 64K words: drain the IR receiver
  addiu t1, t1, 1
  move t3, v0                      # ir_poll may change v0 and ra: keep them
  move t4, ra
  jal  ir_poll
  nop
  move ra, t4
  b    sum_words_next
  move v0, t3
sum_words_done:
  jr   ra
  nop
.endfunc

# boot_ram(a0 = OS base, a1 = size in bytes, a2 = where the boot ROM keeps them): store them
# where the boot ROM looks for an OS already in RAM, then its own reset (7 to BUS_RESETCAUSE).
# The ROM checks the image and starts it from RAM (WEBTV_LPT_BRIDGE.md §10.7). No return.
.func boot_ram
  sw   a0, 0(a2)                   # the base, then the size, as the ROM keeps them (0xa0000400 + 0x19c)
  sw   a1, 4(a2)
  lui  t9, SOLO
  li   t0, 7
  sw   t0, 0xa8(t9)
boot_ram_wait:
  b    boot_ram_wait
  nop
.endfunc

# ---------------------------------------------------------------- memory access

# mem_check(a0 = address, a1 = width, a2 = count) -> v0 = 0 if [a0, a0 + width * count) lies
# inside one of MEM_RANGES and a0 is aligned to the width; else 1 out of range, 2 unaligned,
# 3 bad width (leaf)
.func mem_check
# the width must be 1, 2 or 4 (t1 = its log2), the address aligned to it, the range must not
# wrap past the top of the address space, and it must fit wholly inside one MEM_RANGES entry
  li   v0, 3
  li   t0, 1
  beq  a1, t0, mem_check_w
  move t1, zero                    # t1 = log2(width)
  li   t0, 2
  beq  a1, t0, mem_check_w
  li   t1, 1
  li   t0, 4
  bne  a1, t0, mem_check_done
  li   t1, 2
mem_check_w:
  li   v0, 2
  addiu t0, a1, -1
  and  t0, a0, t0
  bnez t0, mem_check_done
  sllv t2, a2, t1
  addu t2, a0, t2                  # end
  li   v0, 1
  sltu t0, t2, a0
  bnez t0, mem_check_done          # wrapped around
  la   t3, MEM_RANGES
mem_check_range:
  lw   t4, 0(t3)                   # start
  lw   t5, 4(t3)                   # end
  beqz t5, mem_check_done          # end of the table
  addiu t3, t3, 8
  sltu t0, a0, t4
  bnez t0, mem_check_range
  sltu t0, t5, t2
  bnez t0, mem_check_range
  nop
  move v0, zero
mem_check_done:
  jr   ra
  nop
.endfunc

# ---------------------------------------------------------------- IR receiver

# ir_init(): as the OS's InitSoloIR: a 15 us sample interval from the bus clock the boot ROM
# measured (at 0x80000288, in Hz), reject interval 0xa, control 0x3083; empty ring
.func ir_init
  lui  t0, 0x8000
  lw   t0, 0x288(t0)               # the bus clock in Hz, as the boot ROM measured it
  li   t1, 15
  multu t0, t1
  mflo t0
  li   t1, 0x431bde83              # / 1,000,000 (as the OS: multiply, take the high word >> 18)
  nop
  multu t0, t1
  mfhi t0
  srl  t0, t0, 18                  # t0 = bus clock * 15 / 1,000,000: bus clocks in 15 us
  lui  t9, SOLO
  sw   t0, DEV_IRSAMPLE(t9)
  li   t0, 0xa
  sw   t0, DEV_IRREJECT(t9)
  li   t0, 0x3083
  sw   t0, DEV_IRCNTL(t9)
  la   t0, IR_HEAD
  sw   zero, 0(t0)
  jr   ra
  sw   zero, 4(t0)
.endfunc

# ir_poll(): move every run in the receiver's FIFO to the ring (dropped if the ring is full).
# Uses only at, v0, k0, k1, t8, t9.
.func ir_poll
  lui  t9, SOLO
  la   t8, IR_HEAD
# Each FIFO read gives one run: how long the IR line stayed at one level. The ring keeps them for
# ir_flush; k0/k1 are free because interrupts are off for good.
ir_poll_next:
  lw   k0, DEV_IRDATA(t9)
  andi k1, k0, 0xf000
  beqz k1, ir_poll_done            # count 0: nothing there
  lw   k1, 0(t8)                   # head
  addiu at, k1, 1
  andi at, at, 255
  lw   v0, 4(t8)                   # tail
  beq  at, v0, ir_poll_next        # full: drop this run
  sll  k1, k1, 1                   # the entry's offset (halfwords, after head and tail)
  addu k1, k1, t8
  sh   k0, 8(k1)
  b    ir_poll_next
  sw   at, 0(t8)
ir_poll_done:
  jr   ra
  nop
.endfunc

# ir_flush(): send what the ring holds as one IR message (up to 64 runs)
.func ir_flush${ENTER(['s0', 's1', 's2'])}
# s0 the ring, s1 runs to send (head - tail, at most 64), s2 the run being sent. The message is
# IR (0x90), the count, then each run as two bytes; the bridge decodes remote and keyboard codes.
  la   s0, IR_HEAD
  lw   t0, 0(s0)
  lw   t1, 4(s0)
  subu s1, t0, t1
  andi s1, s1, 255
  beqz s1, ir_flush_done
  sltiu t0, s1, 65
  bnez t0, ir_flush_send
  nop
  li   s1, 64
ir_flush_send:${TX(MSG.IR)}
  jal  link_tx
  move a0, s1
ir_flush_entry:
  lw   t1, 4(s0)
  sll  t2, t1, 1
  addu t2, t2, s0
  lhu  s2, 8(t2)
  addiu t1, t1, 1
  andi t1, t1, 255
  sw   t1, 4(s0)
  jal  link_tx
  srl  a0, s2, 8
  jal  link_tx
  andi a0, s2, 0xff
  addiu s1, s1, -1
  bnez s1, ir_flush_entry
  nop
ir_flush_done:${LEAVE(['s0', 's1', 's2'])}
.endfunc

# ---------------------------------------------------------------- I2C (as the boot ROM does it)

# iic_set(a0 = DEV_IICCNTL bits to set, a1 = bits to clear), then half a bit time. Raising
# SCL waits (a while) for a slave that stretches the clock.
.func iic_set
# the I2C lines are bits of DEV_IICCNTL: 0x02/0x04 SDA released/driven low, 0x08/0x10 SCL
# released/driven low, 0x20 SCL as it reads on the bus
  lui  t9, SOLO
  lw   t0, DEV_IIC(t9)
  or   t0, t0, a0
  nor  t1, a1, zero
  and  t0, t0, t1
  sw   t0, DEV_IIC(t9)
  andi t0, a0, 0x08                # releasing SCL? then wait (up to 100 reads) until it is high
  beqz t0, iic_set_wait
  li   t1, 100
iic_set_scl:
  lw   t0, DEV_IIC(t9)
  andi t0, t0, 0x20
  bnez t0, iic_set_wait
  addiu t1, t1, -1
  bnez t1, iic_set_scl
  nop
iic_set_wait:${DELAY(5)}
  jr   ra
  nop
.endfunc

# iic_byte(a0 = byte): 8 bits MSB first, then a clock for the slave's ack (not checked)
.func iic_byte${ENTER(['s0', 's1'])}
# each bit: SDA set while SCL is low, then a clock pulse; s0 the byte, shifted up, s1 bits left
  move s0, a0
  li   s1, 8
iic_byte_bit:
  andi t0, s0, 0x80
  beqz t0, iic_byte_0
  nop${SDA1}
  b    iic_byte_clk
  nop
iic_byte_0:${SDA0}
iic_byte_clk:${SCL1}${SCL0}
  sll  s0, s0, 1
  addiu s1, s1, -1
  bnez s1, iic_byte_bit
  nop
# the ninth clock, SDA released: the slave's ack, which we don't read${SDA1}${SCL1}${SCL0}${LEAVE(['s0', 's1'])}
.endfunc

# iic_write(a0 = device address, a1 = register, a2 = value)
.func iic_write${ENTER(['s0', 's1', 's2'])}
  move s0, a0
  move s1, a1
  move s2, a2
# START: SDA falls while SCL is high. Then the device address, the register, the value.${SDA1}${SCL1}${SDA0}${SCL0}
  jal  iic_byte
  move a0, s0
  jal  iic_byte
  move a0, s1
  jal  iic_byte
  move a0, s2
# STOP: SDA rises while SCL is high${SDA0}${SCL1}${SDA1}${LEAVE(['s0', 's1', 's2'])}
.endfunc

# ---------------------------------------------------------------- data

.func MEM_RANGES                   # [start, end) pairs; end 0 ends the table
${RANGES.map(([a, b]) => `  .word ${hex(a)}\n  .word ${hex(b)}`).join('\n')}
  .word 0
  .word 0
.endfunc

# 5 x 7 glyphs from ' ' to '~', 8 bytes each: a row a byte, the pixels in its top 5 bits (font.js)
.func FONT
${words(FONT)}
.endfunc

.func V_SCALE                      # text scale, fg, bg; then a 256-byte text buffer
  .word 1
  .word 0
  .word 0
TEXTBUF:
${Array(64).fill('  .word 0').join('\n')}
V_T2:                              # TEXT2: the characters, their count, the strike's bitmaps, y
  .word 0
  .word 0
  .word 0
  .word 0
V_FBT:                             # where drawing goes: FB, or BACK (TARGET); set at start
  .word 0
IR_HEAD:                           # IR ring: head, tail, then 256 halfword runs
  .word 0
  .word 0
${Array(128).fill('  .word 0').join('\n')}
LOADER_END:
.endfunc
`;
}

// -> { bytes (Uint8Array, big-endian), base, entry, size, labels }
export function buildLoader({ base = LOADER_BASE, source = loaderSource() } = {}) { return assembleSource(source, base, 'loader'); }

function assembleSource(source, base, name) {
  const prog = parse(source, name);
  const labels = new Map();
  const lookup = (name) => {
    if (labels.has(name)) return labels.get(name);
    if (prog.equ.has(name)) return evaluate(prog.equ.get(name), lookup, `equ ${name}`) ?? undefined;
    return undefined;
  };
  for (const u of prog.units) prepare(u, lookup);
  let at = base;
  const placed = prog.units.map((u) => {
    const p = { u, at };
    for (const [k, v] of unitLabels(u, at)) labels.set(k, v);
    at += unitSize(u);
    return p;
  });
  const bytes = new Uint8Array(at - base);
  for (const p of placed) { p.bytes = assemble(p.u, p.at, lookup); bytes.set(p.bytes, p.at - base); }
  return { bytes, base, entry: base, size: bytes.length, labels, sources: [{ file: name, text: source }], placed };
}

// Stage 0: the little program the bridge types in with `sl` (it takes seconds a word at 19200
// baud); everything else comes over the parallel link in milliseconds. It turns interrupts
// off, takes the port, then reads length:4, the words (stored from LOADER_BASE) and their
// sum:4. A good image: it answers MSG.LOADED and jumps to it. A bad sum: MSG.BADSUM, and it
// reads an image again. It draws nothing: video takes far more code than this, and the
// loader's first screen (navy) follows within milliseconds anyway.
export const STAGE0_BASE = 0xa0480000;

export function stage0Source() {
  return `
${EQU}
.equ LOADER, ${hex(LOADER_BASE)}

# Stage 0: typed in with sl through the debug monitor, so it is as small as it can be. It takes
# the port, opens a PARMOD session (retrying while the bridge is still the dongle), reads the
# loader on the modem channel as length:4, the words, their sum:4, and stores it at LOADER. A
# good sum: answer LOADED (0x8a) and jump to the loader. A bad one: BADSUM (0x8b), and the bridge
# sends it again. Registers kept across the subroutines: s0 where the next word goes, s1 bytes
# left, s2 the running sum, t7 the timeout.
.func s0_start
  mfc0 t0, 12
  li   t1, -2
  and  t0, t0, t1
  mtc0 t0, 12                      # interrupts off
  nop
  nop
  li   t7, 83000                   # s0_x's timeout: 1 ms of Count
  lui  t9, SOLO
  li   t0, 1
  sw   t0, P_ENABLE(t9)            # the port on, software mode, its interrupts off
  sw   zero, P_CNFG(t9)
  sw   zero, P_IEN(t9)
s0_enter:                          # the signature on CTRL_OUT, the version on CTRL_IN
  li   t3, ${hex(SIG)}
  li   t4, 4
s0_sig:
  li   t2, ${hex(K_CTRL_OUT)}
  jal  s0_x
  srl  a1, t3, 24
  blez v1, s0_enter                # not taken, or no answer (still the dongle): again
  sll  t3, t3, 8
  addiu t4, t4, -1
  bnez t4, s0_sig
  li   t2, ${hex(K_CTRL_IN)}                # (delay slot) set up the reply read for when the loop ends
  jal  s0_x
  nop
  blez v1, s0_enter
  nop
# the loader: its length, then the words into LOADER, summing as they come
s0_image:
  jal  s0_rx4
  nop
  move s1, v0                      # length in bytes
  la   s0, LOADER
  move s2, zero                    # sum
s0_word:
  beqz s1, s0_check
  nop
  jal  s0_rx4
  nop
  sw   v0, 0(s0)
  addu s2, s2, v0
  addiu s0, s0, 4
  b    s0_word
  addiu s1, s1, -4
s0_check:                          # the sender's sum against ours
  jal  s0_rx4
  nop
  bne  v0, s2, s0_bad
  nop
  jal  s0_tx
  li   a1, ${hex(MSG.LOADED)}
  la   t0, LOADER
  jr   t0
  nop
s0_bad:
  jal  s0_tx
  li   a1, ${hex(MSG.BADSUM)}
  b    s0_image
  nop

# s0_rx4() -> v0 = 4 bytes from MODEM_IN, big-endian (keeps s0-s3)
s0_rx4:
  move s4, ra                      # no stack: the return address waits in s4 (s0_x doesn't touch it)
  li   s5, 4
  move s6, zero
s0_rx_byte:
  li   t2, ${hex(K_MODEM_IN)}
  jal  s0_x
  nop
  blez v1, s0_rx_byte              # the status byte: nothing yet
  nop
  sll  s6, s6, 8
  or   s6, s6, v0
  addiu s5, s5, -1
  bnez s5, s0_rx_byte
  nop
  move v0, s6
  jr   s4
  nop

# s0_tx(a1 = byte): MODEM_OUT until taken, then the bus to all ones and released (parmod.js's
# pm_idle says why)
s0_tx:
  move s4, ra
s0_tx_again:
  li   t2, ${hex(K_MODEM_OUT)}
  jal  s0_x
  nop
  blez v1, s0_tx_again
  li   t0, 0xff
  sw   t0, P_DATA(t9)
  li   t0, C_FREE
  jr   s4
  sw   t0, P_CTRL(t9)

# s0_x(t2 = code, a1 = byte for _OUT): one PARMOD transaction, giving up after t7 ticks for
# either half. -> v1 = Select (1 / 0), or -1 if the bridge didn't answer; v0 = DATA.
# Uses t0, t1, t5, t6, t9.
s0_x:
  lui  t9, SOLO
  mfc0 t5, 9
s0_x_idle:                         # the last transaction is over once Busy is low
  lw   t0, P_STAT(t9)
  andi t0, t0, S_BUSY
  beqz t0, s0_x_go
  mfc0 t6, 9
  subu t6, t6, t5
  sltu t6, t6, t7
  bnez t6, s0_x_idle
  nop
  b    s0_x_fail
  nop
s0_x_go:
  sw   t2, P_CTRL(t9)
  sw   a1, P_DATA(t9)              # harmless for an _IN code: DIR is in, so nothing is driven
  li   t1, 4
s0_x_settle:
  bnez t1, s0_x_settle             # the code settles on the cable
  addiu t1, t1, -1
  xori t0, t2, C_STBN
  sw   t0, P_CTRL(t9)              # nStrobe low
  mfc0 t5, 9                       # wait for the answer: Busy high
s0_x_ack:
  lw   t0, P_STAT(t9)
  andi t1, t0, S_BUSY
  bnez t1, s0_x_got
  mfc0 t6, 9
  subu t6, t6, t5
  sltu t6, t6, t7
  bnez t6, s0_x_ack
  nop
s0_x_fail:                         # no answer: let go of everything, v1 = -1
  li   t0, 0xff
  sw   t0, P_DATA(t9)
  li   t0, C_FREE
  sw   t0, P_CTRL(t9)              # nStrobe high, the bus released
  jr   ra
  li   v1, -1
s0_x_got:
  lw   v0, P_DATA(t9)
  sw   t2, P_CTRL(t9)              # nStrobe high: the bridge lets go, then drops Busy
  andi v0, v0, 0xff
  andi v1, t0, S_SEL
  jr   ra
  sltu v1, zero, v1
.endfunc
`;
}

export function buildStage0({ base = STAGE0_BASE } = {}) { return assembleSource(stage0Source(), base, 'stage0'); }

// Hand-back routine for a box the bridge doesn't set up: clear RAM, then reset, typed in
// through the monitor (16 words, ~0.5 s) and run with `epc` and `g`. Writing 7 to
// BUS_RESETCAUSE is how the OS's own Reboot and the boot ROM ask for a cold boot. Clearing
// RAM first is a precaution, not a proven need: in the emulator 16423 also boots cleanly from
// a plain `sr a8 7` over what the diagnostics' RAM tests leave (address-as-data patterns),
// but a box coming out of a real power cycle has no such patterns in memory either.
export const ZAP_BASE = 0xa07fff00;

export function buildZap({ base = ZAP_BASE } = {}) {
  return assembleSource(`
.func zap
  mfc0 t0, 12
  li   t1, -2
  and  t0, t0, t1
  mtc0 t0, 12                      # interrupts off
  lui  t0, 0xa000
  la   t1, ${hex(base)}
zap_clear:
  sw   zero, 0(t0)
  addiu t0, t0, 4
  bne  t0, t1, zap_clear
  nop
  lui  t9, 0xa400
  li   t0, 7
  sw   t0, 0xa8(t9)
zap_wait:
  b    zap_wait
  nop
.endfunc
`, base, 'zap');
}
