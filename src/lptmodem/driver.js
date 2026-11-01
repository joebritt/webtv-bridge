// Box-side LPT modem driver: MIPS source assembled into a WebTV OS build by patch.js, on top of
// PARMOD's link layer (parmod.js, assembled alongside: modem and console on one link).
//
// It replaces the bottom of the hardware-modem stack (InitModem, putchar_modem, putbuf_modem,
// getbuf_modem, ModemFIFOCount, ModemGetCD, Read/WriteModemReg, the DTR calls) and keeps
// everything above it: the 4 KB receive/transmit rings, TellyScript, PPP and TCP/IP. Bytes
// move between the rings and the bridge's modem channel:
//   - task-level calls (put/get/count) pump the link synchronously with the port interrupt
//     masked, the way the originals masked the modem interrupt;
//   - the bridge pulses nAck when it has news (data, room, carrier), which raises ACKDONE
//     and runs lm_isr -> pm_pump;
//   - as in the original ISR, receiving a PPP flag byte (0x7e) wakes the PPP task.
// Read/WriteModemReg become a small virtual 16550 for TellyScript's direct register access:
// RBR/THR use the rings, MCR.DTR is a DTR command to the bridge, MSR.DCD is the carrier bit of
// the bridge's status byte.
//
// State lives in modemRcvBufDelta / modemXmtBufDelta, two words every build has and nothing
// else uses (the rings themselves are only allocated after InitModem runs):
//   modemRcvBufDelta  bytes: IER, LCR, MCR, SCR (the virtual 16550's stored registers)
//   modemXmtBufDelta  bytes: (unused), interrupt count; halfword: (unused)
// All-zero state is valid: TellyScript's modem-firmware download runs before InitModem.
// Calls between driver functions use j/jal, never branches: placement may put them far apart.

import { CTRL, STAT, INT, PP } from './link.js';
import { ST, PMCMD, V as PMV } from './parmod.js';

export const DRIVER_VERSION = 6;   // 2: DIR polarity fixed (bit 4 set = the box drives); 3: PARMOD idles with 0xFF on the bus;
                                   // 4: the driver state (PM_VARS) outside the OS's J2 write fence; 5: a timed-out transaction looks
                                   // at Busy once more (an interrupt could take the whole wait); 6: no fast reboot from RAM
                                   // (patch.js: power-off reboots through SafeReset again)
// the patched-build marker, "LPT2", then the driver version
export const SIGNATURE = 0x4c505432;

const hex = (v) => '0x' + (v >>> 0).toString(16);
const V_STATUS = PMV.STATUS;

export function driverSource({ lptInt }) {
  const PUMP = 'pm_pump';
  // all the modem globals share one 64 KB window (patch.js checks), so one lui reaches them
  const GBASE = (r) => `
  lui  ${r}, %hi(RCVHEAD)`;
  const G = (sym, r) => `%lo(${sym})(${r})`;
  const LOCK = `
  jal  lm_lock
  nop`;
  const UNLOCK = `
  jal  lm_unlock
  nop`;
  const ENTER = (n, regs) => `
  addiu sp, sp, -${n}
  sw   ra, ${n - 4}(sp)` + regs.map((r, i) => `\n  sw   ${r}, ${n - 8 - i * 4}(sp)`).join('');
  const LEAVE = (n, regs, before = '') => regs.map((r, i) => `\n  lw   ${r}, ${n - 8 - i * 4}(sp)`).join('') + `
  lw   ra, ${n - 4}(sp)${before ? '\n  ' + before : ''}
  jr   ra
  addiu sp, sp, ${n}`;

  return `
.equ LPT_INT, ${hex(lptInt)}
.equ PPB, 0xa400                   # lui: SOLO registers (KSEG1)
.equ P_IEN, ${hex(0x4200 + PP.IEN)}
.equ P_CLRINT, ${hex(0x4200 + PP.CLRINT)}
.equ I_ACKDONE, ${hex(INT.ACKDONE)}
.equ RING_MASK, 0xfff
.equ RCVDATA, modemRcvData
.equ XMTDATA, modemXmtData
.equ RCVHEAD, modemRcvHead
.equ RCVTAIL, modemRcvTail
.equ XMTHEAD, modemXmtHead
.equ XMTTAIL, modemXmtTail
.equ V_REGS, modemRcvBufDelta      # bytes: IER, LCR, MCR, SCR
.equ V_LCR, V_REGS + 1
.equ V_MCR, V_REGS + 2
.equ V_CTL, modemXmtBufDelta       # cleared at InitModem (kept so the state stays where it was)
.equ V_INTS, modemXmtBufDelta + 1  # parallel port interrupts (wraps)
.equ REG_SLOTS, 0x3ff21f0f         # register -> V_REGS byte (a nibble per register, f = none)


# lm_isr(): parallel port interrupt (ACKDONE = the bridge pulsed nAck)
.func lm_isr
${ENTER(24, [])}
# The bridge pulsed nAck: it has something for us (modem data, console input, room again, a
# carrier change). Clear the interrupt, count it, and pump; the pump does the work.
  lui  t9, PPB
  li   t0, I_ACKDONE
  sw   t0, P_CLRINT(t9)${GBASE('t1')}
  lbu  t0, ${G('V_INTS', 't1')}
  addiu t0, t0, 1
  jal  ${PUMP}
  sb   t0, ${G('V_INTS', 't1')}    # (delay slot) the count${LEAVE(24, [], 'li   v0, 1')}
.endfunc

# lm_lock / lm_unlock: mask / unmask the parallel port interrupt (tail calls). They also
# replace DisableModemInterrupts / EnableModemInterrupts.
.func lm_lock
  j    DisableInterrupt
  li   a0, LPT_INT                 # (delay slot) the parallel port's interrupt
.endfunc

.func lm_unlock
  j    EnableInterrupt
  li   a0, LPT_INT                 # (delay slot) the parallel port's interrupt
.endfunc

# ---------------------------------------------------------------- modem API replacements

# InitModem() -> 0
.func lm_init
${ENTER(24, [])}${GBASE('t8')}
# Empty both modem rings and reset the virtual 16550's registers.
  sw   zero, ${G('RCVHEAD', 't8')}
  sw   zero, ${G('RCVTAIL', 't8')}
  sw   zero, ${G('XMTHEAD', 't8')}
  sw   zero, ${G('XMTTAIL', 't8')}
  li   t0, 0x00030000              # IER 0, LCR 3 (8N1), MCR 0, SCR 0
  sw   t0, ${G('V_REGS', 't8')}
  sw   zero, ${G('V_CTL', 't8')}     # idle control (DTR off), no interrupts, no errors
# The port interrupt off while things are set up; the port to software mode, lines idle.
  lui  t9, PPB
  sw   zero, P_IEN(t9)
  jal  pm_portinit                 # software mode, idle
  nop
# Install lm_isr on the parallel port's interrupt (a stale ACKDONE cleared first), then enable
# ACKDONE: from now on an nAck pulse from the bridge interrupts the OS.
  lui  t9, PPB
  li   t0, I_ACKDONE
  sw   t0, P_CLRINT(t9)
  li   a0, LPT_INT
  la   a1, lm_isr
  move a2, zero
  jal  RegisterIntHandler
  move a3, zero
  lui  t9, PPB
  li   t0, I_ACKDONE
  sw   t0, P_IEN(t9)
# The original InitModem reset the modem chip; this asks the bridge to do the same with its
# modem (MODEM_RESET). It waits in the queue until a session is up.
  jal  pm_cmd                      # the bridge hangs up and resets its modem
  li   a0, ${hex(PMCMD.MODEM_RESET)}${LEAVE(24, [], 'move v0, zero')}
.endfunc

# putchar_modem(a0 = byte) -> 0 queued, 1 ring full
.func lm_putchar
# One byte is putbuf with a length of 1; the byte goes through a stack slot.
  addiu sp, sp, -24
  sw   ra, 20(sp)
  sb   a0, 16(sp)
  addiu a0, sp, 16
  jal  lm_putbuf
  li   a1, 1                       # (delay slot) one byte
  lw   ra, 20(sp)
  jr   ra
  addiu sp, sp, 24
.endfunc

# putbuf_modem(a0 = buf, a1 = len) -> 0 queued, 1 not enough room (nothing queued)
.func lm_putbuf
${ENTER(32, ['s0', 's1', 's2'])}
  move s0, a0
  move s1, a1${LOCK}
# With the port interrupt masked (the ISR's pump can't run in the middle), check the transmit
# ring has room for all of it: the OS expects all or nothing.
  li   s2, 1${GBASE('t8')}
  lw   t0, ${G('XMTHEAD', 't8')}
  lw   t2, ${G('XMTTAIL', 't8')}
  subu t3, t2, t0
  addiu t3, t3, -1
  andi t3, t3, RING_MASK           # free space
  sltu t3, t3, s1
  bnez t3, lm_putbuf_pump
  nop
  lw   t2, ${G('XMTDATA', 't8')}
lm_putbuf_loop:
# Copy it in: store at head + 1, move on.
  beqz s1, lm_putbuf_done
  nop
  addiu t0, t0, 1
  andi t0, t0, RING_MASK
  lbu  t3, 0(s0)
  addu t4, t2, t0
  sb   t3, 0(t4)
  addiu s0, s0, 1
  b    lm_putbuf_loop
  addiu s1, s1, -1
lm_putbuf_done:
  sw   t0, ${G('XMTHEAD', 't8')}
  move s2, zero                    # 0: all of it queued
lm_putbuf_pump:
# Send what can go now (and pass on what was waiting), then unmask the interrupt.
  jal  ${PUMP}
  nop${UNLOCK}
  move v0, s2${LEAVE(32, ['s0', 's1', 's2'])}
.endfunc

# getbuf_modem(a0 = buf, a1 = max) -> bytes copied
.func lm_getbuf
${ENTER(32, ['s0', 's1', 's2'])}
  move s0, a0
  move s1, a1
  move s2, zero${LOCK}
# A pump first, so bytes waiting in the bridge reach the ring; then copy out up to max bytes,
# oldest first, with the interrupt masked so the ring holds still.
  jal  ${PUMP}
  nop${GBASE('t8')}
  lw   t0, ${G('RCVTAIL', 't8')}
  lw   t2, ${G('RCVHEAD', 't8')}
  lw   t3, ${G('RCVDATA', 't8')}
lm_getbuf_loop:
  beq  s2, s1, lm_getbuf_end
  nop
  beq  t0, t2, lm_getbuf_end
  nop
  addiu t0, t0, 1
  andi t0, t0, RING_MASK
  addu t4, t3, t0
  lbu  t4, 0(t4)
  addu t5, s0, s2
  sb   t4, 0(t5)
  b    lm_getbuf_loop
  addiu s2, s2, 1
lm_getbuf_end:
  sw   t0, ${G('RCVTAIL', 't8')}
  beqz s2, lm_getbuf_unlock
  nop
  jal  ${PUMP}                     # refill the room we just made
  nop
lm_getbuf_unlock:${UNLOCK}
  move v0, s2${LEAVE(32, ['s0', 's1', 's2'])}
.endfunc

# ModemFIFOCount() -> bytes waiting in the receive ring
.func lm_fifocount
${ENTER(24, ['s0'])}${LOCK}
# A pump first, so the count includes what the bridge was holding; then head - tail.
  jal  ${PUMP}
  nop${GBASE('t8')}
  lw   t0, ${G('RCVHEAD', 't8')}
  lw   t1, ${G('RCVTAIL', 't8')}
  subu s0, t0, t1
  andi s0, s0, RING_MASK${UNLOCK}
  move v0, s0${LEAVE(24, ['s0'])}
.endfunc

# ModemGetCD() -> 1 if the bridge reports carrier (the status byte, fresh from a pump)
.func lm_getcd
  addiu sp, sp, -24
  sw   ra, 20(sp)
  jal  pm_pump
  nop
# The pump leaves the bridge's last status byte in PM_VARS; bit 3 is carrier.
  la   t0, PM_VARS
  lw   t0, ${V_STATUS}(t0)
  andi t0, t0, ${hex(ST.CARRIER)}
  lw   ra, 20(sp)
  sltu v0, zero, t0
  jr   ra
  addiu sp, sp, 24
.endfunc

# ModemSetDTR(a0 = on): MCR.DTR, and DTR_ON / DTR_OFF to the bridge
.func lm_setdtr${GBASE('t1')}
# Keep DTR in the virtual MCR (bit 0), where ModemGetDTR and MCR reads find it, then send it
# to the bridge: DTR_ON or DTR_OFF. The bridge's modem hangs up when DTR drops.
  lbu  t0, ${G('V_MCR', 't1')}
  ori  t0, t0, 1
  bnez a0, lm_sd_on
  nop
  xori t0, t0, 1
lm_sd_on:
  sb   t0, ${G('V_MCR', 't1')}
  andi t0, t0, 1
  li   a0, ${hex(PMCMD.DTR_OFF)}
  j    pm_cmd                      # DTR_ON (2) or DTR_OFF (3)
  subu a0, a0, t0                  # (delay slot) 3 - DTR
.endfunc

# ModemGetDTR() -> MCR.DTR
.func lm_getdtr${GBASE('v0')}
  lbu  v0, ${G('V_MCR', 'v0')}
  jr   ra
  andi v0, v0, 1
.endfunc

# ReadModemReg(a0 = register address) -> value. A virtual 16550 for TellyScript's direct
# register access: RBR reads the receive ring, LSR/MSR reflect the link, IIR says nothing is
# pending, IER/LCR/MCR/SCR read back what was written.
.func lm_readreg
# The register number is address bits 2-4 (the 16550's registers sit a word apart): t0 = 0 RBR,
# 1 IER, 2 IIR, 3 LCR, 4 MCR, 5 LSR, 6 MSR, 7 SCR.
  srl  t0, a0, 2
  andi t0, t0, 7
  addiu t1, t0, -5
  sltiu t1, t1, 2
  beqz t1, lm_rr_go                # LSR, MSR: a pump first, for a fresh status (TellyScript's
  nop                              # firmware download polls LSR before InitModem has run)
  addiu sp, sp, -24
  sw   ra, 20(sp)
  jal  pm_pump
  sw   t0, 16(sp)
  lw   t0, 16(sp)
  lw   ra, 20(sp)
  addiu sp, sp, 24
lm_rr_go:${GBASE('t6')}
# Register 0 is RBR unless LCR's DLAB bit is set (then it's the divisor latch, which reads 0).
  bnez t0, lm_rr_lsr
  lbu  t1, ${G('V_LCR', 't6')}
  andi t1, t1, 0x80
  bnez t1, lm_rr_ret               # DLAB: divisor latch reads as 0
  move v0, zero
# RBR: one byte from the receive ring, through getbuf.
  addiu sp, sp, -24
  sw   ra, 20(sp)
  sb   zero, 16(sp)
  addiu a0, sp, 16
  jal  lm_getbuf                   # RBR: next byte from the ring (0 if none)
  li   a1, 1
  lbu  v0, 16(sp)
  lw   ra, 20(sp)
  jr   ra
  addiu sp, sp, 24
lm_rr_lsr:
# LSR (5) and MSR (6) are made from the bridge's last status byte, fresh from the pump above.
  la   t9, PM_VARS
  lw   t3, ${V_STATUS}(t9)         # t3: the last status byte
  li   t4, 5
  bne  t0, t4, lm_rr_msr
  andi t5, t3, ${hex(ST.MODEM)}    # LSR: THR empty; data ready = bridge has data or ring not empty
  lw   t7, ${G('RCVHEAD', 't6')}
  lw   t6, ${G('RCVTAIL', 't6')}
  xor  t7, t7, t6
  sltu t7, zero, t7
  or   t5, t5, t7
  jr   ra
  ori  v0, t5, 0x60
lm_rr_msr:
  li   t4, 6
  bne  t0, t4, lm_rr_stored
  andi t5, t3, ${hex(ST.CARRIER)}
  sltu t5, zero, t5                # MSR: CTS, DSR, DCD = carrier
  sll  t5, t5, 7
  jr   ra
  ori  v0, t5, 0x30
lm_rr_stored:
# The rest read back what was written: REG_SLOTS maps each register to a byte of V_REGS (IER,
# LCR, MCR, SCR), f for none. IIR has none and reads 0xC1: FIFOs on, no interrupt pending.
  li   t4, REG_SLOTS
  sll  t5, t0, 2
  srlv t4, t4, t5
  andi t4, t4, 0xf
  li   t5, 0xf
  beq  t4, t5, lm_rr_ret           # IIR: FIFOs on, nothing pending
  li   v0, 0xc1
  addu t6, t6, t4
  lbu  v0, ${G('V_REGS', 't6')}
lm_rr_ret:
  jr   ra
  nop
.endfunc

# WriteModemReg(a0 = register address, a1 = value) on the virtual 16550: THR goes into the
# transmit ring, MCR.DTR becomes a DTR command to the bridge, enabling IER interrupts services the link.
.func lm_writereg
# t0 = the register number, as in ReadModemReg. THR (0, DLAB clear) is a byte to send, MCR is
# DTR, IER, LCR and SCR are stored, and the rest are ignored.
  srl  t0, a0, 2
  andi t0, t0, 7
  andi a1, a1, 0xff${GBASE('t6')}
  sltiu t3, t0, 2
  beqz t3, lm_wr_store
  lbu  t2, ${G('V_LCR', 't6')}
  andi t2, t2, 0x80
  bnez t2, lm_wr_ret               # DLAB: divisor latch writes are ignored
  nop
  bnez t0, lm_wr_store
  nop
  j    lm_putchar                  # THR
  move a0, a1
lm_wr_store:
  li   t4, 4
  bne  t0, t4, lm_wr_reg
  nop
  j    lm_setdtr                   # MCR (only DTR matters)
  andi a0, a1, 1
lm_wr_reg:
  li   t4, REG_SLOTS
  sll  t5, t0, 2
  srlv t4, t4, t5
  andi t4, t4, 0xf
  li   t5, 0xf
  beq  t4, t5, lm_wr_ret           # FCR, LSR, MSR: ignored
  addu t5, t6, t4
  sb   a1, ${G('V_REGS', 't5')}
# IER with the receive or transmit interrupt on: TellyScript is about to wait for the modem,
# so run the link now.
  li   t4, 1
  bne  t0, t4, lm_wr_ret
  andi a1, a1, 3
  beqz a1, lm_wr_ret
  nop
  j    lm_fifocount                # enabling RX/TX interrupts: service the link now
  nop
lm_wr_ret:
  jr   ra
  nop
.endfunc

# signature, so tools can recognise a patched build
.func lm_signature
  .word ${hex(SIGNATURE)}                       # "LPT2"
  .word ${hex(DRIVER_VERSION)}                  # the driver version
.endfunc
`;
}

// SafeReset wrapper: tell the bridge first that this reset is the OS rebooting (a
// power-off, an update, a switch of OS slot), not a power-up or a crash, so it starts the OS
// again without its countdown (WEBTV_LPT_BRIDGE.md §10.7). SafeReset runs last, interrupts off,
// so whatever held the port is never coming back: the claim is cleared before the command
// goes out. `displaced`: SafeReset's first two instructions.
export function rebootSource(displaced) {
  return `
# SafeReset(a0): send REBOOT first, then carry on into SafeReset
.func lm_reboot
  addiu sp, sp, -24
  sw   ra, 20(sp)
  sw   a0, 16(sp)
# The OS is about to reset itself. Tell the bridge (REBOOT), so it starts the OS again at once,
# with no countdown. a0, SafeReset's argument, is kept for the real SafeReset.
  la   t0, PM_VARS
  sw   zero, ${PMV.BUSY}(t0)        # interrupts are off and nothing holds the port any more: clear the claim
  jal  pm_cmd                      # queue REBOOT and pump it out
  li   a0, ${hex(PMCMD.REBOOT)}
# Then SafeReset as it was: its two displaced instructions, and on into the rest of it.
  lw   a0, 16(sp)
  lw   ra, 20(sp)
  addiu sp, sp, 24
  .word ${hex(displaced[0])}              # SafeReset's first two instructions, displaced by the hook
  .word ${hex(displaced[1])}
  j    SafeReset + 8
  nop
.endfunc
`;
}

// The console channel in the OS (patch.js picks one):
//   debug builds, which have the 1997 parallel console (SetCharIO flag 0x10): InitECPCharIO,
//     ECPCharIOOut and ECPCharIOIn are hooked to pm_portinit, lm_ecpout and pm_conin, so the
//     flag now means the bridge's console channel. The 1997 transfers' request bytes become
//     LEGACY_ECP <rq> (the bridge then steps aside for the ECP transfer that follows).
//   builds without it: putchar also copies to the console channel while gCharIOSelect has
//     0x10, and SetCharIO always sets it. `displaced` are the first two instructions of each.
export function consoleSource({ ecp, putchar, setCharIo }) {
  // SetCharIO(a0 = flags): the console channel is always on
  const keepOn = setCharIo ? `
# SetCharIO(a0 = flags): the console channel is always on
.func lm_setchario_con
  ori  a0, a0, 0x10
  .word ${hex(setCharIo[0])}            # SetCharIO's first two instructions, displaced by the hook
  .word ${hex(setCharIo[1])}
  j    SetCharIO + 8
  nop
.endfunc
` : '';
  if (ecp) return keepOn + `
# ECPCharIOOut(a0 = char): console output; the 1997 transfers' request bytes become LEGACY_ECP
.func lm_ecpout
# On a debug build the parallel console is the bridge's console channel. The 1997 transfer
# commands open with a request byte on that console: those become LEGACY_ECP, so the bridge
# knows an ECP transfer follows. Everything else is console text.
  andi a0, a0, 0xff
  li   t0, 0x81                    # dde, pardl
  beq  a0, t0, lm_ecpout_rq
  li   t0, 0x83                    # dde id
  beq  a0, t0, lm_ecpout_rq
  li   t0, 0x85                    # dde t3
  beq  a0, t0, lm_ecpout_rq
  li   t0, 0x88                    # ud, udr (upload)
  beq  a0, t0, lm_ecpout_rq
  nop
# Ordinary text: into the console-out ring, and a pump.
  j    pm_conout
  nop
lm_ecpout_rq:
# LEGACY_ECP, then the request byte as its argument; the pump sends both.
  addiu sp, sp, -24
  sw   ra, 20(sp)
  sw   a0, 16(sp)
  jal  pm_queue
  li   a0, ${hex(PMCMD.LEGACY_ECP)}
  jal  pm_cmd
  lw   a0, 16(sp)
  lw   ra, 20(sp)
  move v0, zero
  jr   ra
  addiu sp, sp, 24
.endfunc
`;
  return keepOn + `
.equ CHARIOSEL, gCharIOSelect

# putchar(a0): also to the bridge's console channel while gCharIOSelect has 0x10 (LF -> LF CR,
# as the OS does for its serial ports)
.func lm_putchar_con
  lui  t0, %hi(CHARIOSEL)
  lbu  t0, %lo(CHARIOSEL)(t0)
  andi t0, t0, 0x10
  beqz t0, lm_pc_go
  nop
# Copy the character to the console channel; a LF gets a CR after it, as on the serial ports.
  addiu sp, sp, -24
  sw   ra, 20(sp)
  sw   a0, 16(sp)
  jal  pm_conout
  andi a0, a0, 0xff
  lw   a0, 16(sp)
  li   t0, 10
  bne  a0, t0, lm_pc_back
  nop
  jal  pm_conout
  li   a0, 13
lm_pc_back:
  lw   a0, 16(sp)
  lw   ra, 20(sp)
  addiu sp, sp, 24
lm_pc_go:
# Then putchar as it was: its two displaced instructions, and on into the rest of it.
  .word ${hex(putchar[0])}              # putchar's first two instructions, displaced by the hook
  .word ${hex(putchar[1])}
  j    putchar + 8
  nop
.endfunc
`;
}
