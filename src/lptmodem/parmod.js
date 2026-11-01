// PARMOD (PARallel MODem) link, box side (WEBTV_LPT_BRIDGE.md §4.1): MIPS source for the transaction, session
// entry and the pump that moves the modem and console channels. The OS patch places it with
// driver.js; the stress harness (tools/parmodstress.mjs) runs the same source on the
// emulated CPU against the emulated bridge (src/machine/parmodhost.js).
//
// A transaction is one byte on one channel, the box as master, interrupts off:
//   CTRL = code + nStrobe high (+ DIR out and DATA for _OUT codes); 2 us settle if the code
//   changed; nStrobe low; wait for Busy high; read STAT (Select = result) and, for _IN, DATA;
//   nStrobe high. The bridge then releases the bus and drops Busy, and the next transaction
//   waits for that.
//
// Channels and rings:
//   modem   the OS's own rings (modemRcvData/Head/Tail, modemXmtData/Head/Tail; 4 KB each),
//           named by the caller through `syms`
//   console the driver's own: PM_CONOUT (256 bytes, to the bridge), PM_CONIN (64, from it)
//   control command replies land in PM_REPLY (16); a peek's address arrives there too
//   peek    the bridge asks for box memory (status bit 6): pm_ch_peek sends it on CTRL_OUT
//   key     the bridge gives a key (status bit 7): pm_ch_key puts it in the OS's IR input ring
//           (irDataBuf, as its IR decoders do), named by the caller through `syms.ir`
//   commands queue in PM_CMD (16) and go out at the start of the next pump
// Every ring keeps head (producer) and tail (consumer) indexes; the producer stores at
// (head + 1) & mask and then advances head, so head == tail is empty.
//
// In the OS the pump runs from task level (the modem calls, port interrupt masked), from the
// port's interrupt, and from console output, which can come from anywhere: another interrupt,
// another thread, the debug monitor. So the port is claimed first (a test-and-set with
// interrupts off); a pump that finds it taken only leaves word (PEND) for the owner, which
// goes round again before letting go. Nothing touches the port while CNFG != 0 (a 1997 ECP
// transfer has it). With no bridge, entry is tried at most once a second and console output
// just overwrites the oldest bytes in its ring.
//
// Calls between functions use jal, so placement may put them anywhere in the segment.

import { PP } from './link.js';

export const PARMOD_VERSION = 2;

// codes on (nSelectIn, nInit, nAutoFd), as CTRL values with nStrobe high (DIR out for _OUT)
export const K = {
  IDLE: 0x0f, CTRL_OUT: 0x1d, CTRL_IN: 0x09, MODEM_OUT: 0x17, MODEM_IN: 0x03, CON_OUT: 0x15, CON_IN: 0x0b,
};
export const CODE = { IDLE: 7, CTRL_OUT: 5, CTRL_IN: 4, MODEM_OUT: 3, MODEM_IN: 2, CON_OUT: 1, CON_IN: 6 };
export const ST = { MODEM: 1, CONIN: 2, REPLY: 4, CARRIER: 8, MFULL: 16, CLIENT: 32, PEEK: 64, KEY: 128 };
// KEY: the last four reply bytes are an IR input entry's first word (the OS's irDataBuf: for the
// IR keyboard 0x94 make / 0xd4 break, the scancode, 0, 0; for a remote 0, 0, its maker, its
// code); pm_ch_key adds the time and queues it as the OS's decoders would. Nothing goes back.
// REBOOT: the OS is about to reset itself (SafeReset): the bridge starts it again without its
// countdown (WEBTV_LPT_BRIDGE.md §10.7)
// PEEK: box memory the bridge asked for (status bit 6, the address in the replies before it):
// the count of words, then the words, big-endian (pm_ch_peek; the web page's screenshot)
export const PMCMD = { MODEM_RESET: 0x01, DTR_ON: 0x02, DTR_OFF: 0x03, LEGACY_ECP: 0x04, EXIT: 0x05, REBOOT: 0x06, PEEK: 0x07 };
export const ENTER_SIG = [0x4c, 0x50, 0x54, 0x32]; // 'L' 'P' 'T' '2'

// state block layout (PM_VARS + offset)
export const V = {
  SESSION: 0, LASTCTRL: 4, STATUS: 8, ERRS: 12, ENTERS: 16, VERSION: 20, PPP: 24,
  RPH: 28, RPT: 32, RPD: 36,          // reply ring, 16
  COH: 52, COT: 56, COD: 60,          // console out ring, 256
  CIH: 316, CIT: 320, CID: 324,       // console in ring, 64
  BUSY: 388, PEND: 392,               // the port is in use; someone asked for a pump meanwhile
  FAILED: 396, TRIED: 400,            // the last entry failed, at this Count
  CMH: 404, CMT: 408, CMD: 412,       // command ring, 16
  SIZE: 428,
};
export const MASK = { REPLY: 15, CONOUT: 255, CONIN: 63, CMD: 15, MODEM: 0xfff };

const hex = (v) => '0x' + (v >>> 0).toString(16);

// syms: { rcvData, rcvHead, rcvTail, xmtData, xmtHead, xmtTail, ppp, ir? } (ppp: the function to
// call when a PPP flag byte, 0x7e, comes in from the modem channel, as the modem ISR did; ir:
// { buf, head, tail, ticks, last }, the OS's IR input ring and clock, for keys from the bridge)
export function parmodSource(syms) {
  // O32 frames: 16 bytes at the bottom for a callee to store its arguments, then the saved
  // registers, ra at the top; 8-byte aligned (OS code may be called from here)
  const FRAME = (regs) => (16 + regs.length * 4 + 4 + 7) & ~7;
  const ENTER = (regs) => `
  addiu sp, sp, -${FRAME(regs)}
  sw   ra, ${FRAME(regs) - 4}(sp)` + regs.map((r, i) => `\n  sw   ${r}, ${16 + i * 4}(sp)`).join('');
  const LEAVE = (regs, v0) => regs.map((r, i) => `\n  lw   ${r}, ${16 + i * 4}(sp)`).join('') + `
  lw   ra, ${FRAME(regs) - 4}(sp)${v0 ? '\n  ' + v0 : ''}
  jr   ra
  addiu sp, sp, ${FRAME(regs)}`;
  const KNAME = Object.fromEntries(Object.entries(K).map(([n, v]) => [v, n]));
  const XFER = (k, byte) => `${byte ? `\n  ${byte}` : ''}
  jal  pm_xfer
  li   a0, ${hex(k)}                   # (delay slot) ${KNAME[k]}`;
  const SAVE = ['s0', 's1', 's2', 's3', 's4', 's5'];
  // the pump's subroutines: ra on an 8-byte frame (they call only leaf functions)
  const CH_ENTER = `
  addiu sp, sp, -8
  sw   ra, 4(sp)`;
  const CH_LEAVE = `
  lw   ra, 4(sp)
  jr   ra
  addiu sp, sp, 8`;
  return `
.equ PPB, 0xa400
.equ P_DATA, ${hex(0x4200 + PP.DATA)}
.equ P_CTRL, ${hex(0x4200 + PP.CTRL)}
.equ P_STAT, ${hex(0x4200 + PP.STAT)}
.equ P_CNFG, ${hex(0x4200 + PP.CNFG)}
.equ P_ENABLE, ${hex(0x4200 + PP.ENABLE)}
.equ C_STBN, 0x01
.equ C_DIROUT, 0x10
.equ S_BUSY, 0x01
.equ S_SEL, 0x08
.equ S_PE, 0x10
.equ T_WAIT, 200 * 83             # Count ticks (83.5 MHz): 200 us for the bridge to answer
.equ T_SETTLE, 2 * 83              # Count ticks: 2 us for the lines to settle after a code change
.equ T_RETRY, 83000000             # Count ticks: 1 s between entry attempts while nobody answers
.equ RCVDATA, ${syms.rcvData}
.equ RCVHEAD, ${syms.rcvHead}
.equ RCVTAIL, ${syms.rcvTail}
.equ XMTDATA, ${syms.xmtData}
.equ XMTHEAD, ${syms.xmtHead}
.equ XMTTAIL, ${syms.xmtTail}

# pm_xfer(a0 = CTRL value: code, nStrobe high, DIR; a1 = byte for _OUT) -> v0 = DATA (_IN),
# v1 = Select (1 accepted / data, 0 full / status); v0 = -1, v1 = 0 if the bridge didn't answer
.func pm_xfer
  lui  t9, PPB
  mfc0 t1, 9                       # waits are timed with CP0 Count, so they hold at any bus speed
# Wait for the previous transaction to end: the bridge drops Busy once it has let go of the
# bus. Nothing for 200 us means no bridge (or it is still the diagnostics dongle): give up.
pm_xfer_idle:                      # the last transaction is over once Busy is low
  lw   t0, P_STAT(t9)
  andi t0, t0, S_BUSY
  beqz t0, pm_xfer_go
  nop
  mfc0 t0, 9
  nop
  subu t0, t0, t1
  sltiu t0, t0, T_WAIT
  bnez t0, pm_xfer_idle
  nop
# Out of time, but an interrupt may have taken it all since the read above: look once more
  lw   t0, P_STAT(t9)
  andi t0, t0, S_BUSY
  bnez t0, pm_xfer_fail
  nop
pm_xfer_go:
# Put the code on the control lines, nStrobe still high, and remember it. An _OUT code has
# DIR out too, and its byte goes on the bus now, before the strobe.
  la   t2, PM_VARS
  lw   t3, ${V.LASTCTRL}(t2)                   # the last CTRL value
  sw   a0, P_CTRL(t9)
  sw   a0, ${V.LASTCTRL}(t2)
  andi t0, a0, C_DIROUT
  beqz t0, pm_xfer_settle
  nop
  sw   a1, P_DATA(t9)
pm_xfer_settle:
# A released line takes ~0.35 us to rise through the pull-ups, so after a code change wait
# 2 us before strobing. The same code as last time has long settled.
  beq  t3, a0, pm_xfer_strobe      # same code as last time: the lines have settled
  nop
  mfc0 t1, 9
pm_xfer_wait:
  mfc0 t0, 9
  nop
  subu t0, t0, t1
  sltiu t0, t0, T_SETTLE
  bnez t0, pm_xfer_wait
  nop
pm_xfer_strobe:
# Strobe, then wait for the answer: Busy high, with Select = taken / a byte (1) or full /
# the status byte (0). No answer in 200 us: let go of nStrobe and fail.
  xori t0, a0, C_STBN
  sw   t0, P_CTRL(t9)              # nStrobe low
  mfc0 t1, 9
pm_xfer_ack:
  lw   t0, P_STAT(t9)
  andi t3, t0, S_BUSY
  bnez t3, pm_xfer_got             # Busy high: answered
  nop
  mfc0 t3, 9
  nop
  subu t3, t3, t1
  sltiu t3, t3, T_WAIT
  bnez t3, pm_xfer_ack
  nop
# Out of time. An interrupt between the read of STAT above and the clock may have taken all of
# it while the bridge answered in a few us: look at Busy once more, or a byte it took would be
# sent again (MODEM_OUT) or one it gave would be lost (MODEM_IN)
  lw   t0, P_STAT(t9)
  andi t3, t0, S_BUSY
  bnez t3, pm_xfer_got
  nop
  sw   a0, P_CTRL(t9)              # nStrobe high again
pm_xfer_fail:
# Count it; v0 = -1 tells the caller the session is gone.
  la   t2, PM_VARS
  lw   t0, ${V.ERRS}(t2)                  # unanswered transactions
  addiu t0, t0, 1
  sw   t0, ${V.ERRS}(t2)
  move v1, zero
  jr   ra
  li   v0, -1
pm_xfer_got:
# Answered. Select is the result; for an _IN code DATA holds the bridge's byte.
  andi v1, t0, S_SEL
  sltu v1, zero, v1
  lw   v0, P_DATA(t9)
  andi v0, v0, 0xff
  jr   ra
  sw   a0, P_CTRL(t9)              # nStrobe high: the bridge releases the bus, then drops Busy
.endfunc

# pm_idle(): end of a burst: code 111, DIR in. The bus goes to all ones first, while we may still
# drive it: released, it only floats up from there, so the four lines high never show beside one
# of the boot ROM's dongle probe bytes (0xF1-0xF8), which the bridge watches for (a reset).
.func pm_idle
  lui  t9, PPB
  li   t0, 0xff
  sw   t0, P_DATA(t9)
  li   t0, ${hex(K.IDLE)}          # code 111, DIR in, nStrobe high
  la   t2, PM_VARS
  sw   t0, ${V.LASTCTRL}(t2)                   # the last CTRL value
  jr   ra
  sw   t0, P_CTRL(t9)
.endfunc

# pm_enter() -> v0 = 1 in a session: 'L' 'P' 'T' '2' on CTRL_OUT, then the version reply
.func pm_enter${ENTER(['s0'])}
  la   s0, PM_VARS
# The four signature bytes on CTRL_OUT. A bridge outside a session takes nothing else, and
# takes these only in order; a refusal or no answer means nobody is there to talk to.
${ENTER_SIG.map((c) => `${XFER(K.CTRL_OUT, `li   a1, ${hex(c)}`)}
  beqz v1, pm_enter_no
  nop`).join('')}${XFER(K.CTRL_IN)}
  beqz v1, pm_enter_no             # Select low: no reply, so no session
  nop
# In a session: keep the bridge's version, count the entry, and end the burst.
  sw   v0, ${V.VERSION}(s0)                  # the bridge's version
  lw   t0, ${V.ENTERS}(s0)                  # sessions entered
  addiu t0, t0, 1
  sw   t0, ${V.ENTERS}(s0)
  li   t0, 1
  sw   t0, ${V.SESSION}(s0)                   # in a session
  jal  pm_idle
  nop${LEAVE(['s0'], 'li   v0, 1')}
pm_enter_no:
  jal  pm_idle
  nop${LEAVE(['s0'], 'move v0, zero')}
.endfunc

# pm_queue(a0 = command byte) -> v0 = 1 queued, 0 the queue is full. It goes out first thing
# in the next pump, once there is a session (the bridge takes nothing but the entry signature
# outside one). Task level only: one producer.
.func pm_queue
# The next head slot; meeting the tail means full. The byte is stored before the head moves,
# so a pump never sends a slot that isn't written yet.
  la   t2, PM_VARS
  lw   t0, ${V.CMH}(t2)                 # command ring head
  addiu t0, t0, 1
  andi t0, t0, ${MASK.CMD}
  lw   t1, ${V.CMT}(t2)                 # command ring tail
  beq  t0, t1, pm_queue_full
  addu t1, t2, t0                  # (delay slot) the slot's address
  sb   a0, ${V.CMD}(t1)                 # command ring data
  sw   t0, ${V.CMH}(t2)                 # command ring head
  jr   ra
  li   v0, 1
pm_queue_full:
  jr   ra
  move v0, zero
.endfunc

# pm_cmd(a0 = command byte) -> v0 = 1 queued: pm_queue, then a pump
.func pm_cmd${ENTER(['s0'])}
  jal  pm_queue
  nop
  beqz v0, pm_cmd_out
  move s0, v0                      # (delay slot) the result to return
  jal  pm_pump
  nop
pm_cmd_out:${LEAVE(['s0'], 'move v0, s0')}
.endfunc

# pm_claim() -> v0 = 1: the port is ours (BUSY). 0: someone else has it, and PEND now tells
# them to go round once more.
.func pm_claim
# Interrupts off (Status IE clear) so nothing can claim the port between our read of BUSY and
# our write; the old Status goes back on the way out.
  mfc0 t0, 12
  li   t1, -2
  and  t1, t0, t1
  mtc0 t1, 12                      # interrupts off for the test-and-set
  nop
  nop
# Free: it's ours (BUSY = 1). Taken: set PEND, so the owner goes round once more before it
# lets go, and moves whatever we came to move.
  la   t2, PM_VARS
  lw   v0, ${V.BUSY}(t2)                 # BUSY
  li   t1, 1
  bnez v0, pm_claim_taken
  nop
  sw   t1, ${V.BUSY}(t2)
  b    pm_claim_out
  li   v0, 1
pm_claim_taken:
  sw   t1, ${V.PEND}(t2)                 # PEND
  move v0, zero
pm_claim_out:
  mtc0 t0, 12                      # interrupts back as they were
  nop
  jr   ra
  nop
.endfunc

# pm_release(a0 = may go again) -> v0 = 1: someone asked meanwhile, the port stays ours and
# the caller goes round again. 0: released.
.func pm_release
# Interrupts off, so a pump starting in an interrupt can't fall between reading PEND and
# clearing BUSY (it would find the port taken and nobody going round for it).
  mfc0 t0, 12
  li   t1, -2
  and  t1, t0, t1
  mtc0 t1, 12
  nop
  nop
  la   t2, PM_VARS
# Asked for meanwhile, and the caller may go again: keep the port and say so. Otherwise let
# it go.
  lw   v0, ${V.PEND}(t2)
  sw   zero, ${V.PEND}(t2)
  and  v0, v0, a0
  bnez v0, pm_release_out
  nop
  sw   zero, ${V.BUSY}(t2)               # BUSY
pm_release_out:
  mtc0 t0, 12                      # interrupts back as they were
  nop
  jr   ra
  nop
.endfunc

# pm_portinit(): software mode, idle. For console output before InitModem (debug builds set up
# their parallel console early).
.func pm_portinit
  lui  t9, PPB
  li   t0, 1
  sw   t0, P_ENABLE(t9)            # the port on
  sw   zero, P_CNFG(t9)            # software mode: the box works the lines itself
  j    pm_idle                     # idle lines: the bus to 0xFF, then released
  nop
.endfunc

# pm_conout(a0 = byte): into the console ring (a full ring loses its oldest byte), then a pump.
# Any context.
.func pm_conout${ENTER([])}
  mfc0 t3, 12
  li   t1, -2
  and  t1, t3, t1
  mtc0 t1, 12                      # interrupts off: output can come from anywhere
  nop
  nop
# Into the console-out ring. Full: drop the oldest byte (move the tail on) rather than wait;
# a printf must never stall, with or without a bridge on the port.
  la   t2, PM_VARS
  lw   t0, ${V.COH}(t2)                  # console-out head
  addiu t0, t0, 1
  andi t0, t0, ${MASK.CONOUT}
  lw   t1, ${V.COT}(t2)                  # console-out tail
  bne  t0, t1, pm_conout_put
  addu t4, t2, t0
  addiu t1, t1, 1
  andi t1, t1, ${MASK.CONOUT}
  sw   t1, ${V.COT}(t2)
pm_conout_put:
  sb   a0, ${V.COD}(t4)                  # console-out data
  sw   t0, ${V.COH}(t2)                  # console-out head
# Interrupts back, then try to send it now. If the port is busy, the owner sends it for us.
  mtc0 t3, 12
  nop
  jal  pm_pump
  nop${LEAVE([])}
.endfunc

# pm_conin() -> v0 = next console input byte, 0 if none (as ECPCharIOIn). Pumps when the ring
# is empty.
.func pm_conin${ENTER(['s0'])}
  la   s0, PM_VARS
# Anything in the console-in ring? If not, one pump fetches what the bridge holds.
  lw   t0, ${V.CIT}(s0)                 # console-in tail
  lw   t1, ${V.CIH}(s0)                 # console-in head
  bne  t0, t1, pm_conin_take
  nop
  jal  pm_pump
  nop
  lw   t0, ${V.CIT}(s0)                 # console-in tail
  lw   t1, ${V.CIH}(s0)                 # console-in head
  beq  t0, t1, pm_conin_out
  move v0, zero                    # (delay slot) still nothing: 0, as ECPCharIOIn returns
pm_conin_take:
# Take the oldest byte (tail + 1), then move the tail.
  addiu t0, t0, 1
  andi t0, t0, ${MASK.CONIN}
  addu t1, s0, t0
  lbu  v0, ${V.CID}(t1)                 # console-in data
  sw   t0, ${V.CIT}(s0)                 # console-in tail
pm_conin_out:${LEAVE(['s0'])}
.endfunc

# pm_pump(): send the queued commands, then move everything that can move on all four
# channels, and end the burst. Enters the session first if there isn't one. Any context.
# The work is in the pm_ch_* subroutines below (so that every piece fits the room the OS
# patch finds); they share the pump's registers: s0 status byte, s1 count, s2 saw a PPP
# flag, s4 PM_VARS, s5 moved anything this round. Each returns v0 = 0, or -1 if the bridge
# stopped answering.
# The pump itself also keeps s3, the rounds left in this pass, and s6, the passes left before
# it lets the port go even if others keep asking.
.func pm_pump${ENTER([...SAVE, 's6'])}
  jal  pm_claim
  nop
  beqz v0, pm_pump_ret             # someone else is pumping; they go round again for us
  li   s6, 4                       # passes at most, however often others ask
  la   s4, PM_VARS
pm_pump_pass:
# A pass: be in a session, send the queued commands, then rounds over the channels until a
# round moves nothing.
  jal  pm_session
  move s2, zero                    # (delay slot) no PPP flag seen yet
  beqz v0, pm_pump_free            # no session (no bridge, or a 1997 ECP transfer)
  nop
  jal  pm_ch_cmd
  nop
  bltz v0, pm_pump_lost
  li   s3, 16                      # rounds a pass, so a busy link can't hold the CPU forever
pm_pump_round:
# A round: the status byte (and any replies) says what the bridge holds for us and whether its
# modem input has room; then each channel in turn moves what it can.
  jal  pm_ch_status
  move s5, zero                    # (delay slot) nothing moved yet
  bltz v0, pm_pump_lost
  nop
  jal  pm_ch_peek
  nop
  bltz v0, pm_pump_lost
  nop
  jal  pm_ch_key
  nop
  jal  pm_ch_mi
  nop
  bltz v0, pm_pump_lost
  nop
  jal  pm_ch_ci
  nop
  bltz v0, pm_pump_lost
  nop
  jal  pm_ch_mo
  nop
  bltz v0, pm_pump_lost
  nop
  jal  pm_ch_co
  nop
  bltz v0, pm_pump_lost
  nop
  beqz s5, pm_pump_done            # nothing moved: done
  addiu s3, s3, -1
  bnez s3, pm_pump_round
  nop
pm_pump_done:
# Keep the status for ModemGetCD and the LSR/MSR reads, end the burst (bus to 0xFF, code 111),
# wake PPP if a frame ended, and let the port go unless a pump was asked for meanwhile.
  andi t0, s0, 0xff
  sw   t0, ${V.STATUS}(s4)                   # the last status byte
  jal  pm_idle
  nop
  jal  pm_pump_ppp
  nop
  addiu s6, s6, -1
  jal  pm_release
  move a0, s6                      # (delay slot) may go again while passes are left
  bnez v0, pm_pump_pass            # asked for meanwhile: once more
  nop
  b    pm_pump_ret
  nop
pm_pump_lost:                      # no answer: the session is gone; enter again next time
  sw   zero, ${V.SESSION}(s4)                 # in a session
  jal  pm_idle
  nop
  jal  pm_pump_ppp
  nop
pm_pump_free:
  jal  pm_release
  move a0, zero
pm_pump_ret:${LEAVE([...SAVE, 's6'])}
pm_pump_ppp:                       # wake PPP if a flag byte came in (s2)
  beqz s2, pm_pump_ppp_no
  nop
  j    ${syms.ppp}                 # tail call: the OS's PPP wake-up, as its modem ISR did
  nop
pm_pump_ppp_no:
  jr   ra
  nop
.endfunc

# pm_session() -> v0 = 1 in a session (entering one if need be). 0 while CNFG != 0 (a 1997
# ECP transfer has the port), or if nobody answers (then again at most once a second).
.func pm_session${CH_ENTER}
# A 1997 ECP transfer owns the port while CNFG != 0: stay off it.
  lui  t9, PPB
  lw   t0, P_CNFG(t9)
  bnez t0, pm_session_out
  move v0, zero                    # (delay slot) not in a session
# We think we're in a session: PError low says the bridge agrees. High: it reset, was
# unplugged or stepped aside for ECP, so enter again.
  lw   t0, ${V.SESSION}(s4)
  beqz t0, pm_session_enter
  nop
  lw   t0, P_STAT(t9)
  andi t0, t0, S_PE
  beqz t0, pm_session_out          # PError low: the session is up
  li   v0, 1
  sw   zero, ${V.SESSION}(s4)      # PError high: the bridge has none (reset, ECP, unplugged)
pm_session_enter:
# After a failed entry, try again only once a second, so a box without a bridge doesn't
# spend its time waiting for answers.
  lw   t0, ${V.FAILED}(s4)                 # the last entry failed
  beqz t0, pm_session_try
  nop
  mfc0 t0, 9
  lw   t1, ${V.TRIED}(s4)                 # when it was tried
  subu t0, t0, t1
  li   t1, T_RETRY
  sltu t0, t0, t1
  bnez t0, pm_session_out          # nobody answered less than a second ago
  move v0, zero
pm_session_try:
# Enter; remember a failure and when it happened.
  jal  pm_enter
  nop
  sw   zero, ${V.FAILED}(s4)               # the last entry failed
  bnez v0, pm_session_out
  li   t0, 1
  sw   t0, ${V.FAILED}(s4)
  mfc0 t0, 9
  sw   t0, ${V.TRIED}(s4)                 # when it was tried
pm_session_out:${CH_LEAVE}
.endfunc

# queued commands, in order
.func pm_ch_cmd${CH_ENTER}
pm_ch_cmd_next:
# Each queued command byte on CTRL_OUT, oldest first. A byte leaves the queue only once the
# bridge has taken it, so a dropped session loses nothing.
  lw   t0, ${V.CMT}(s4)                 # command ring tail
  lw   t1, ${V.CMH}(s4)                 # command ring head
  beq  t0, t1, pm_ch_cmd_out
  move v0, zero
  addiu t0, t0, 1
  andi t0, t0, ${MASK.CMD}
  addu t1, s4, t0
  lbu  a1, ${V.CMD}(t1)                 # the command byte${XFER(K.CTRL_OUT)}
  bltz v0, pm_ch_cmd_out
  nop
  beqz v1, pm_ch_cmd_out           # not taken: the bridge has no session after all
  li   v0, -1
  lw   t0, ${V.CMT}(s4)                 # command ring tail
  addiu t0, t0, 1
  andi t0, t0, ${MASK.CMD}
  b    pm_ch_cmd_next
  sw   t0, ${V.CMT}(s4)
pm_ch_cmd_out:${CH_LEAVE}
.endfunc

# CTRL_IN: command replies first (Select high), then the status byte -> s0
.func pm_ch_status${CH_ENTER}
pm_ch_status_next:
# CTRL_IN gives a pending reply byte (Select high) or, when none is left, the status byte
# (Select low): bit 0 modem bytes waiting, 1 console input, 2 a reply, 3 carrier, 4 the
# bridge's modem input is full.
  ${XFER(K.CTRL_IN).trim()}
  bltz v0, pm_ch_status_out
  nop
  beqz v1, pm_ch_status_out
  move s0, v0                      # Select low: s0 = status byte
  lw   t0, ${V.RPH}(s4)            # a reply byte: keep it (the oldest goes when full)
  addiu t0, t0, 1
  andi t0, t0, ${MASK.REPLY}
  lw   t1, ${V.RPT}(s4)                  # reply ring tail
  bne  t0, t1, pm_ch_status_reply
  addu t2, s4, t0
  addiu t1, t1, 1
  andi t1, t1, ${MASK.REPLY}
  sw   t1, ${V.RPT}(s4)
pm_ch_status_reply:
  sb   v0, ${V.RPD}(t2)                  # reply ring data
  b    pm_ch_status_next
  sw   t0, ${V.RPH}(s4)                  # reply ring head
pm_ch_status_out:
  sra  v0, v0, 31                  # -1 stays -1, a status byte becomes 0${CH_LEAVE}
.endfunc

# a peek: the bridge wants box memory (the web page's screenshot of what the OS is showing).
# Status bit 6 says the last four reply bytes are an address, big-endian; its low bit set asks
# for one word, else sixteen. Only RAM (as kseg0) or the SOLO's registers (0xa400xxxx) are
# read, so no address the bridge sends can fault. Back on CTRL_OUT: PEEK, the count, then
# the words big-endian. t4-t7 hold across pm_xfer (it uses t0-t3, t9).
.func pm_ch_peek${CH_ENTER}
  andi t0, s0, ${ST.PEEK}
  beqz t0, pm_ch_peek_out
  move v0, zero
# The address: reply ring slots head-3 .. head, oldest first; then the ring is used up.
  lw   t0, ${V.RPH}(s4)                  # reply ring head
  move t4, zero
  li   t5, 4
pm_ch_peek_addr:
  subu t1, t0, t5
  addiu t1, t1, 1
  andi t1, t1, ${MASK.REPLY}
  addu t1, s4, t1
  lbu  t1, ${V.RPD}(t1)                  # reply ring data
  sll  t4, t4, 8
  or   t4, t4, t1
  addiu t5, t5, -1
  bnez t5, pm_ch_peek_addr
  nop
  sw   t0, ${V.RPT}(s4)                  # reply ring tail = head: consumed
# How many words: low bit set, one (a register); else sixteen.
  andi t5, t4, 1
  beqz t5, pm_ch_peek_n
  li   t5, 16                      # (delay slot) sixteen
  li   t5, 1
pm_ch_peek_n:
# Where: the SOLO's registers as they are, anything else as RAM through kseg0.
  srl  t0, t4, 16
  li   t1, 0xa400
  bne  t0, t1, pm_ch_peek_ram
  andi t0, t4, 0xfffc              # (delay slot) a register's offset
  lui  t4, 0xa400
  b    pm_ch_peek_send
  or   t4, t4, t0
pm_ch_peek_ram:
  lui  t0, 0x7f
  ori  t0, t0, 0xfffc
  and  t0, t4, t0                  # within 8 MB, word-aligned
  lui  t4, 0x8000
  or   t4, t4, t0
pm_ch_peek_send:${XFER(K.CTRL_OUT, `li   a1, ${PMCMD.PEEK}`)}
  bltz v0, pm_ch_peek_out
  nop
  beqz v1, pm_ch_peek_out          # not taken: the bridge has no session after all
  li   v0, -1${XFER(K.CTRL_OUT, 'move a1, t5')}
  bltz v0, pm_ch_peek_out
  nop
  beqz v1, pm_ch_peek_out
  li   v0, -1
pm_ch_peek_word:
  lw   t6, 0(t4)
  li   t7, 4
pm_ch_peek_byte:${XFER(K.CTRL_OUT, 'srl  a1, t6, 24')}
  bltz v0, pm_ch_peek_out
  nop
  beqz v1, pm_ch_peek_out
  li   v0, -1
  sll  t6, t6, 8
  addiu t7, t7, -1
  bnez t7, pm_ch_peek_byte
  nop
  addiu t5, t5, -1
  bnez t5, pm_ch_peek_word
  addiu t4, t4, 4                  # (delay slot) the next word
  li   s5, 1                       # something moved
  move v0, zero
pm_ch_peek_out:${CH_LEAVE}
.endfunc

# a key from the bridge (status bit 7): the last four reply bytes are the first word of an entry
# in the OS's IR input ring. Queued as the OS's decoders queue one (ValidateSonyData in 16406):
# at (irHead + 1) & 63 unless that is irTail (full: dropped, as the OS drops one), the word, then
# gSystemTicks, gLastIRTime = it, irHead = the slot, with interrupts off so no decoder is
# midway. IRIdle takes it from there, as a key from the IR receiver. A build without the ring
# (syms.ir) only uses the bytes up.
.func pm_ch_key${CH_ENTER}
  andi t0, s0, ${ST.KEY}
  beqz t0, pm_ch_key_out
  move v0, zero
  lw   t0, ${V.RPH}(s4)                  # reply ring head
  move t4, zero
  li   t5, 4
pm_ch_key_byte:
  subu t1, t0, t5
  addiu t1, t1, 1
  andi t1, t1, ${MASK.REPLY}
  addu t1, s4, t1
  lbu  t1, ${V.RPD}(t1)                  # reply ring data
  sll  t4, t4, 8
  or   t4, t4, t1
  addiu t5, t5, -1
  bnez t5, pm_ch_key_byte
  nop
  sw   t0, ${V.RPT}(s4)                  # reply ring tail = head: consumed
  li   s5, 1                       # something moved${syms.ir ? `
  mfc0 t6, 12
  li   t1, -2
  and  t1, t6, t1
  mtc0 t1, 12                      # interrupts off: the decoders queue from the IR task
  nop
  nop
  la   t2, ${syms.ir.head}
  lw   t0, 0(t2)
  addiu t0, t0, 1
  andi t0, t0, 63
  la   t3, ${syms.ir.tail}
  lw   t1, 0(t3)
  beq  t0, t1, pm_ch_key_full      # full: dropped
  sll  t1, t0, 3                   # (delay slot) 8 bytes an entry
  la   t3, ${syms.ir.buf}
  addu t3, t3, t1
  sw   t4, 0(t3)
  la   t1, ${syms.ir.ticks}
  lw   t1, 0(t1)
  sw   t1, 4(t3)                   # when: Now()
  la   t5, ${syms.ir.last}
  sw   t1, 0(t5)                   # gLastIRTime
  sw   t0, 0(t2)                   # irHead: IRIdle sees it
pm_ch_key_full:
  mtc0 t6, 12                      # interrupts back as they were
  nop
  nop` : ''}
  move v0, zero
pm_ch_key_out:${CH_LEAVE}
.endfunc

# modem in, while the bridge has bytes and the ring has room
.func pm_ch_mi${CH_ENTER}
# Status bit 0: the bridge has modem bytes. Up to 32 a round, straight into the OS's receive
# ring; when the ring is full the rest waits in the bridge.
  andi t0, s0, ${ST.MODEM}
  beqz t0, pm_ch_mi_out
  move v0, zero
  li   s1, 32
pm_ch_mi_byte:
  la   t2, RCVHEAD
  lw   t0, 0(t2)
  addiu t0, t0, 1
  andi t0, t0, ${MASK.MODEM}
  la   t3, RCVTAIL
  lw   t1, 0(t3)
  beq  t0, t1, pm_ch_mi_out        # ring full: leave it in the bridge
  move v0, zero${XFER(K.MODEM_IN)}
  bltz v0, pm_ch_mi_out
  nop
  bnez v1, pm_ch_mi_got
  nop
  move s0, v0                      # Select low: v0 is the status, nothing more waiting
  b    pm_ch_mi_out
  move v0, zero
pm_ch_mi_got:
  la   t2, RCVHEAD
  lw   t0, 0(t2)
  addiu t0, t0, 1
  andi t0, t0, ${MASK.MODEM}
  la   t3, RCVDATA
  lw   t3, 0(t3)
  addu t3, t3, t0
  sb   v0, 0(t3)
  sw   t0, 0(t2)
# A PPP flag byte (0x7e) ends a frame: note it, to wake PPP when the pump is done.
  xori t0, v0, 0x7e
  bnez t0, pm_ch_mi_next
  li   s5, 1                       # (delay slot) something moved
  li   s2, 1                       # a flag byte came in
pm_ch_mi_next:
  addiu s1, s1, -1
  bnez s1, pm_ch_mi_byte
  nop
  move v0, zero
pm_ch_mi_out:${CH_LEAVE}
.endfunc

# console in
.func pm_ch_ci${CH_ENTER}
# Status bit 1: console input waiting. Up to 32 a round into the console-in ring (64 bytes);
# the rest waits in the bridge.
  andi t0, s0, ${ST.CONIN}
  beqz t0, pm_ch_ci_out
  move v0, zero
  li   s1, 32
pm_ch_ci_byte:
  lw   t0, ${V.CIH}(s4)                 # console-in head
  addiu t0, t0, 1
  andi t0, t0, ${MASK.CONIN}
  lw   t1, ${V.CIT}(s4)                 # console-in tail
  beq  t0, t1, pm_ch_ci_out        # ring full
  move v0, zero${XFER(K.CON_IN)}
  bltz v0, pm_ch_ci_out
  nop
  bnez v1, pm_ch_ci_got
  nop
  move s0, v0                      # Select low: the status
  b    pm_ch_ci_out
  move v0, zero
pm_ch_ci_got:
  lw   t0, ${V.CIH}(s4)                 # console-in head
  addiu t0, t0, 1
  andi t0, t0, ${MASK.CONIN}
  addu t1, s4, t0
  sb   v0, ${V.CID}(t1)                 # console-in data
  sw   t0, ${V.CIH}(s4)                 # console-in head
  addiu s1, s1, -1
  bnez s1, pm_ch_ci_byte
  li   s5, 1
  move v0, zero
pm_ch_ci_out:${CH_LEAVE}
.endfunc

# modem out, unless the bridge said its modem input is full
.func pm_ch_mo${CH_ENTER}
# Status bit 4: the bridge's modem input is full, so send nothing. Otherwise up to 32 bytes a
# round from the OS's transmit ring. A refused byte stays in the ring; the bridge pulses nAck
# when it has room, and that interrupt runs the pump again.
  andi t0, s0, ${ST.MFULL}
  bnez t0, pm_ch_mo_out
  move v0, zero
  li   s1, 32
pm_ch_mo_byte:
  la   t2, XMTTAIL
  lw   t0, 0(t2)
  la   t3, XMTHEAD
  lw   t1, 0(t3)
  beq  t0, t1, pm_ch_mo_out        # empty
  move v0, zero
  addiu t0, t0, 1
  andi t0, t0, ${MASK.MODEM}
  la   t3, XMTDATA
  lw   t3, 0(t3)
  addu t3, t3, t0
  lbu  a1, 0(t3)${XFER(K.MODEM_OUT)}
  bltz v0, pm_ch_mo_out
  nop
  beqz v1, pm_ch_mo_out            # refused: the bridge pulses nAck when it has room
  move v0, zero
  la   t2, XMTTAIL
  lw   t0, 0(t2)
  addiu t0, t0, 1
  andi t0, t0, ${MASK.MODEM}
  sw   t0, 0(t2)
  addiu s1, s1, -1
  bnez s1, pm_ch_mo_byte
  li   s5, 1
pm_ch_mo_out:${CH_LEAVE}
.endfunc

# console out (always accepted)
.func pm_ch_co${CH_ENTER}
# Up to 32 console bytes a round. The bridge always takes them; only a lost bridge stops this.
  li   s1, 32
pm_ch_co_byte:
  lw   t0, ${V.COT}(s4)                  # console-out tail
  lw   t1, ${V.COH}(s4)                  # console-out head
  beq  t0, t1, pm_ch_co_out
  move v0, zero
  addiu t0, t0, 1
  andi t0, t0, ${MASK.CONOUT}
  addu t1, s4, t0
  lbu  a1, ${V.COD}(t1)                  # the console byte${XFER(K.CON_OUT)}
  bltz v0, pm_ch_co_out
  nop
  lw   t0, ${V.COT}(s4)                  # console-out tail
  addiu t0, t0, 1
  andi t0, t0, ${MASK.CONOUT}
  sw   t0, ${V.COT}(s4)
  addiu s1, s1, -1
  bnez s1, pm_ch_co_byte
  li   s5, 1
  move v0, zero
pm_ch_co_out:${CH_LEAVE}
.endfunc

# the driver's state (V offsets), written by the driver only once placed in RAM: 0 in a session,
# 4 the last CTRL value, 8 the last status byte, 12 unanswered transactions, 16 sessions entered,
# 20 the bridge's version, 28 reply ring (head, tail, 16 bytes), 52 console-out ring (head, tail,
# 256), 316 console-in ring (head, tail, 64), 388 BUSY, 392 PEND, 396 the last entry failed,
# 400 when (Count), 404 command ring (head, tail, 16). All zero is a valid start.
.func PM_VARS
${Array(V.SIZE / 4).fill('  .word 0').join('\n')}
.endfunc
`;
}
