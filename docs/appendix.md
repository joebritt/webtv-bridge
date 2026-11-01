# Appendix: the patch and the loader code

*Generated from the current source with `tools/asmlist.mjs` (November 2026). See [bridge.md](bridge.md) for how it all fits together.*

The MIPS code the bridge puts into a box: the OS patch (A), and the code that gets the bridge in (B). Each listing is the source as the assembler (`src/lptmodem/asm.js`) takes it, comments and all, with the address and the machine word in front of every line that emits code. A line that emits two words (`la`, a 32-bit `li`) shows the second on the line below.

- **The patch is listed for production build 16423** (`approm/production-nondebug/build-16423`). Every build gets the same source; what changes is where each unit lands (the free space differs from build to build, so each unit header says where it went and whose body it reuses) and a few OS addresses. A debug build such as 16406 gets the parallel-console hooks (`ECPCharIOOut`, `ECPCharIOIn`, `InitECPCharIO`) in place of the `putchar` and `SetCharIO` ones in A.4.
- **Stage 0, the loader and the tier-3 stub** are the same for every box.
- Made with `node tools/asmlist.mjs patch <_approm.o> | loader | stage0 | tier3`. Runs of the same word (a zeroed data block) are shown once with a count.

## A.1 What the patch changes in the OS's own code

Outside the code it places (A.2 to A.4), the patch changes only these words of 16423. Each hooked function's first two words become a jump to its replacement; the replacement code goes into the bodies of the functions it replaces and of the printer driver, which the patch turns off. The header's code checksum is recomputed last.

```
80616ce8  3c10807b           ProtectMemory: lui: the J2 write fence ends at 807b0000, below the driver's state
807b0000  00000000           filler: PM_VARS, 428 bytes (zeroed)
8060f628  08183e69 00000000  EnableModemInterrupts: j lm_unlock; nop
8060f644  08185c34 00000000  DisableModemInterrupts: j lm_lock; nop
8060f3c0  08185d0d 00000000  InitModem: j lm_init; nop
8060f6ec  08185cb3 00000000  putchar_modem: j lm_putchar; nop
8060f79c  08185c39 00000000  putbuf_modem: j lm_putbuf; nop
8060f884  08183dbd 00000000  getbuf_modem: j lm_getbuf; nop
8060f6a4  08185e16 00000000  ModemFIFOCount: j lm_fifocount; nop
8060f4d0  08185c66 00000000  ModemGetCD: j lm_getcd; nop
8060f3b0  08185fe7 00000000  ReadModemReg: j lm_readreg; nop
8060f3b8  08185d31 00000000  WriteModemReg: j lm_writereg; nop
8060f5ac  08185e29 00000000  ModemSetDTR: j lm_setdtr; nop
8060f61c  08185f62 00000000  ModemGetDTR: j lm_getdtr; nop
8060f4e0  03e00008 24020001  ModemGetCTS: stub: jr ra, with the result in the delay slot
8060f550  03e00008 00000000  ModemSetRTS: stub: jr ra, with the result in the delay slot
80612940  08183dab 00000000  SafeReset: j lm_reboot; nop
80734adc  08185c78 00000000  putchar: j lm_putchar_con; nop
80734a80  08183d8c 00000000  SetCharIO: j lm_setchario_con; nop
8060f66c  2404001d           ModemReset: li a0, 0x1d: the parallel port's interrupt, not the modem's
8060f670  2404001d           ModemReset: li a0, 0x1d: the parallel port's interrupt, not the modem's
80616f40  03e00008 2402ffff  ParallelDriver method: jr ra; li v0, -1 (the printer driver off)
80616f64  03e00008 2402ffff  ParallelDriver method: jr ra; li v0, -1 (the printer driver off)
806170dc  03e00008 2402ffff  ParallelDriver method: jr ra; li v0, -1 (the printer driver off)
80617190  03e00008 2402ffff  ParallelDriver method: jr ra; li v0, -1 (the printer driver off)
806171c8  03e00008 2402ffff  ParallelDriver method: jr ra; li v0, -1 (the printer driver off)
806171d0  03e00008 2402ffff  ParallelDriver method: jr ra; li v0, -1 (the printer driver off)
806171d8  03e00008 2402ffff  ParallelDriver method: jr ra; li v0, -1 (the printer driver off)
8061723c  03e00008 2402ffff  ParallelDriver method: jr ra; li v0, -1 (the printer driver off)
80617248  03e00008 2402ffff  ParallelDriver method: jr ra; li v0, -1 (the printer driver off)
80617274  03e00008 2402ffff  ParallelDriver method: jr ra; li v0, -1 (the printer driver off)
8061729c  03e00008 2402ffff  ParallelDriver method: jr ra; li v0, -1 (the printer driver off)
806172c4  03e00008 2402ffff  ParallelDriver method: jr ra; li v0, -1 (the printer driver off)
806172f0  03e00008 2402ffff  ParallelDriver method: jr ra; li v0, -1 (the printer driver off)
80617318  03e00008 2402ffff  ParallelDriver method: jr ra; li v0, -1 (the printer driver off)
80617344  03e00008 2402ffff  ParallelDriver method: jr ra; li v0, -1 (the printer driver off)
8061736c  03e00008 2402ffff  ParallelDriver method: jr ra; li v0, -1 (the printer driver off)
80617394  03e00008 2402ffff  ParallelDriver method: jr ra; li v0, -1 (the printer driver off)
8061742c  03e00008 2402ffff  ParallelDriver method: jr ra; li v0, -1 (the printer driver off)
806174bc  03e00008 2402ffff  ParallelDriver method: jr ra; li v0, -1 (the printer driver off)
8061755c  03e00008 2402ffff  ParallelDriver method: jr ra; li v0, -1 (the printer driver off)
80617634  03e00008 2402ffff  ParallelDriver method: jr ra; li v0, -1 (the printer driver off)
80617810  03e00008 2402ffff  ParallelDriver method: jr ra; li v0, -1 (the printer driver off)
80617850  03e00008 2402ffff  ParallelDriver method: jr ra; li v0, -1 (the printer driver off)
80617944  03e00008 2402ffff  ParallelDriver method: jr ra; li v0, -1 (the printer driver off)
80617a94  03e00008 2402ffff  ParallelDriver method: jr ra; li v0, -1 (the printer driver off)
80617b3c  03e00008 2402ffff  ParallelDriver method: jr ra; li v0, -1 (the printer driver off)
80617c34  03e00008 2402ffff  ParallelDriver method: jr ra; li v0, -1 (the printer driver off)
80617d10  03e00008 2402ffff  ParallelDriver method: jr ra; li v0, -1 (the printer driver off)
80617d98  03e00008 2402ffff  ParallelDriver method: jr ra; li v0, -1 (the printer driver off)
80617e38  03e00008 2402ffff  ParallelDriver method: jr ra; li v0, -1 (the printer driver off)
80617ee4  03e00008 2402ffff  ParallelDriver method: jr ra; li v0, -1 (the printer driver off)
80617f94  03e00008 2402ffff  ParallelDriver method: jr ra; li v0, -1 (the printer driver off)
80616258  03e00008 00001021  InitParallelPort: jr ra; move v0, zero (no printer)
8060be78  00000000           Reboot: nop (was jal BootRAMImage): no restart from RAM; the warm reboot instead
80540008  07fc15ed           header: the code checksum
```

## A.2 The PARMOD link, box side (parmod.js)

The link layer: one transaction (`pm_xfer`), session entry, the port claim that lets any context pump, the command queue, the console rings, the pump that moves all four channels, peeks (box memory for the web page's screenshot) and keys (into the OS's IR input, for the Remote tab). Every piece is its own unit so it fits a piece of free space; `PM_VARS` is the 428-byte state block.

```
                   .equ PPB, 0xa400
                   .equ P_DATA, 0x4200
                   .equ P_CTRL, 0x4204
                   .equ P_STAT, 0x4208
                   .equ P_CNFG, 0x420c
                   .equ P_ENABLE, 0x422c
                   .equ C_STBN, 0x01
                   .equ C_DIROUT, 0x10
                   .equ S_BUSY, 0x01
                   .equ S_SEL, 0x08
                   .equ S_PE, 0x10
                   .equ T_WAIT, 200 * 83             # Count ticks (83.5 MHz): 200 us for the bridge to answer
                   .equ T_SETTLE, 2 * 83              # Count ticks: 2 us for the lines to settle after a code change
                   .equ T_RETRY, 83000000             # Count ticks: 1 s between entry attempts while nobody answers
                   .equ RCVDATA, modemRcvData
                   .equ RCVHEAD, modemRcvHead
                   .equ RCVTAIL, modemRcvTail
                   .equ XMTDATA, modemXmtData
                   .equ XMTHEAD, modemXmtHead
                   .equ XMTTAIL, modemXmtTail

                   # pm_xfer(a0 = CTRL value: code, nStrobe high, DIR; a1 = byte for _OUT) -> v0 = DATA (_IN),
                   # v1 = Select (1 accepted / data, 0 full / status); v0 = -1, v1 = 0 if the bridge didn't answer
                   # ---- pm_xfer: 264 bytes at 0x8060f3c8 (in InitModem)
                   .func pm_xfer
8060f3c8  3c19a400   lui  t9, PPB
8060f3cc  40094800   mfc0 t1, 9                       # waits are timed with CP0 Count, so they hold at any bus speed
                   # Wait for the previous transaction to end: the bridge drops Busy once it has let go of the
                   # bus. Nothing for 200 us means no bridge (or it is still the diagnostics dongle): give up.
                   pm_xfer_idle:                      # the last transaction is over once Busy is low
8060f3d0  8f284208   lw   t0, P_STAT(t9)
8060f3d4  31080001   andi t0, t0, S_BUSY
8060f3d8  1100000b   beqz t0, pm_xfer_go
8060f3dc  00000000   nop
8060f3e0  40084800   mfc0 t0, 9
8060f3e4  00000000   nop
8060f3e8  01094023   subu t0, t0, t1
8060f3ec  2d0840d8   sltiu t0, t0, T_WAIT
8060f3f0  1500fff7   bnez t0, pm_xfer_idle
8060f3f4  00000000   nop
                   # Out of time, but an interrupt may have taken it all since the read above: look once more
8060f3f8  8f284208   lw   t0, P_STAT(t9)
8060f3fc  31080001   andi t0, t0, S_BUSY
8060f400  15000025   bnez t0, pm_xfer_fail
8060f404  00000000   nop
                   pm_xfer_go:
                   # Put the code on the control lines, nStrobe still high, and remember it. An _OUT code has
                   # DIR out too, and its byte goes on the bus now, before the strobe.
8060f408  3c0a807b   la   t2, PM_VARS
8060f40c  254a0000
8060f410  8d4b0004   lw   t3, 4(t2)                   # the last CTRL value
8060f414  af244204   sw   a0, P_CTRL(t9)
8060f418  ad440004   sw   a0, 4(t2)
8060f41c  30880010   andi t0, a0, C_DIROUT
8060f420  11000002   beqz t0, pm_xfer_settle
8060f424  00000000   nop
8060f428  af254200   sw   a1, P_DATA(t9)
                   pm_xfer_settle:
                   # A released line takes ~0.35 us to rise through the pull-ups, so after a code change wait
                   # 2 us before strobing. The same code as last time has long settled.
8060f42c  11640008   beq  t3, a0, pm_xfer_strobe      # same code as last time: the lines have settled
8060f430  00000000   nop
8060f434  40094800   mfc0 t1, 9
                   pm_xfer_wait:
8060f438  40084800   mfc0 t0, 9
8060f43c  00000000   nop
8060f440  01094023   subu t0, t0, t1
8060f444  2d0800a6   sltiu t0, t0, T_SETTLE
8060f448  1500fffb   bnez t0, pm_xfer_wait
8060f44c  00000000   nop
                   pm_xfer_strobe:
                   # Strobe, then wait for the answer: Busy high, with Select = taken / a byte (1) or full /
                   # the status byte (0). No answer in 200 us: let go of nStrobe and fail.
8060f450  38880001   xori t0, a0, C_STBN
8060f454  af284204   sw   t0, P_CTRL(t9)              # nStrobe low
8060f458  40094800   mfc0 t1, 9
                   pm_xfer_ack:
8060f45c  8f284208   lw   t0, P_STAT(t9)
8060f460  310b0001   andi t3, t0, S_BUSY
8060f464  15600014   bnez t3, pm_xfer_got             # Busy high: answered
8060f468  00000000   nop
8060f46c  400b4800   mfc0 t3, 9
8060f470  00000000   nop
8060f474  01695823   subu t3, t3, t1
8060f478  2d6b40d8   sltiu t3, t3, T_WAIT
8060f47c  1560fff7   bnez t3, pm_xfer_ack
8060f480  00000000   nop
                   # Out of time. An interrupt between the read of STAT above and the clock may have taken all of
                   # it while the bridge answered in a few us: look at Busy once more, or a byte it took would be
                   # sent again (MODEM_OUT) or one it gave would be lost (MODEM_IN)
8060f484  8f284208   lw   t0, P_STAT(t9)
8060f488  310b0001   andi t3, t0, S_BUSY
8060f48c  1560000a   bnez t3, pm_xfer_got
8060f490  00000000   nop
8060f494  af244204   sw   a0, P_CTRL(t9)              # nStrobe high again
                   pm_xfer_fail:
                   # Count it; v0 = -1 tells the caller the session is gone.
8060f498  3c0a807b   la   t2, PM_VARS
8060f49c  254a0000
8060f4a0  8d48000c   lw   t0, 12(t2)                  # unanswered transactions
8060f4a4  25080001   addiu t0, t0, 1
8060f4a8  ad48000c   sw   t0, 12(t2)
8060f4ac  00001821   move v1, zero
8060f4b0  03e00008   jr   ra
8060f4b4  2402ffff   li   v0, -1
                   pm_xfer_got:
                   # Answered. Select is the result; for an _IN code DATA holds the bridge's byte.
8060f4b8  31030008   andi v1, t0, S_SEL
8060f4bc  0003182b   sltu v1, zero, v1
8060f4c0  8f224200   lw   v0, P_DATA(t9)
8060f4c4  304200ff   andi v0, v0, 0xff
8060f4c8  03e00008   jr   ra
8060f4cc  af244204   sw   a0, P_CTRL(t9)              # nStrobe high: the bridge releases the bus, then drops Busy
                   .endfunc

                   # pm_idle(): end of a burst: code 111, DIR in. The bus goes to all ones first, while we may still
                   # drive it: released, it only floats up from there, so the four lines high never show beside one
                   # of the boot ROM's dongle probe bytes (0xF1-0xF8), which the bridge watches for (a reset).
                   # ---- pm_idle: 36 bytes at 0x80617250 (in FGetTimeSinceLastInit)
                   .func pm_idle
80617250  3c19a400   lui  t9, PPB
80617254  240800ff   li   t0, 0xff
80617258  af284200   sw   t0, P_DATA(t9)
8061725c  2408000f   li   t0, 0xf          # code 111, DIR in, nStrobe high
80617260  3c0a807b   la   t2, PM_VARS
80617264  254a0000
80617268  ad480004   sw   t0, 4(t2)                   # the last CTRL value
8061726c  03e00008   jr   ra
80617270  af284204   sw   t0, P_CTRL(t9)
                   .endfunc

                   # pm_enter() -> v0 = 1 in a session: 'L' 'P' 'T' '2' on CTRL_OUT, then the version reply
                   # ---- pm_enter: 196 bytes at 0x80617564 (in FWaitForPrinter)
                   .func pm_enter
80617564  27bdffe8   addiu sp, sp, -24
80617568  afbf0014   sw   ra, 20(sp)
8061756c  afb00010   sw   s0, 16(sp)
80617570  3c10807b   la   s0, PM_VARS
80617574  26100000
                   # The four signature bytes on CTRL_OUT. A bridge outside a session takes nothing else, and
                   # takes these only in order; a refusal or no answer means nobody is there to talk to.

80617578  2405004c   li   a1, 0x4c
8061757c  0c183cf2   jal  pm_xfer
80617580  2404001d   li   a0, 0x1d                   # (delay slot) CTRL_OUT
80617584  10600021   beqz v1, pm_enter_no
80617588  00000000   nop
8061758c  24050050   li   a1, 0x50
80617590  0c183cf2   jal  pm_xfer
80617594  2404001d   li   a0, 0x1d                   # (delay slot) CTRL_OUT
80617598  1060001c   beqz v1, pm_enter_no
8061759c  00000000   nop
806175a0  24050054   li   a1, 0x54
806175a4  0c183cf2   jal  pm_xfer
806175a8  2404001d   li   a0, 0x1d                   # (delay slot) CTRL_OUT
806175ac  10600017   beqz v1, pm_enter_no
806175b0  00000000   nop
806175b4  24050032   li   a1, 0x32
806175b8  0c183cf2   jal  pm_xfer
806175bc  2404001d   li   a0, 0x1d                   # (delay slot) CTRL_OUT
806175c0  10600012   beqz v1, pm_enter_no
806175c4  00000000   nop
806175c8  0c183cf2   jal  pm_xfer
806175cc  24040009   li   a0, 0x9                   # (delay slot) CTRL_IN
806175d0  1060000e   beqz v1, pm_enter_no             # Select low: no reply, so no session
806175d4  00000000   nop
                   # In a session: keep the bridge's version, count the entry, and end the burst.
806175d8  ae020014   sw   v0, 20(s0)                  # the bridge's version
806175dc  8e080010   lw   t0, 16(s0)                  # sessions entered
806175e0  25080001   addiu t0, t0, 1
806175e4  ae080010   sw   t0, 16(s0)
806175e8  24080001   li   t0, 1
806175ec  ae080000   sw   t0, 0(s0)                   # in a session
806175f0  0c185c94   jal  pm_idle
806175f4  00000000   nop
806175f8  8fb00010   lw   s0, 16(sp)
806175fc  8fbf0014   lw   ra, 20(sp)
80617600  24020001   li   v0, 1
80617604  03e00008   jr   ra
80617608  27bd0018   addiu sp, sp, 24
                   pm_enter_no:
8061760c  0c185c94   jal  pm_idle
80617610  00000000   nop
80617614  8fb00010   lw   s0, 16(sp)
80617618  8fbf0014   lw   ra, 20(sp)
8061761c  00001021   move v0, zero
80617620  03e00008   jr   ra
80617624  27bd0018   addiu sp, sp, 24
                   .endfunc

                   # pm_queue(a0 = command byte) -> v0 = 1 queued, 0 the queue is full. It goes out first thing
                   # in the next pump, once there is a session (the bridge takes nothing but the entry signature
                   # outside one). Task level only: one producer.
                   # ---- pm_queue: 56 bytes at 0x80617e00 (in FRev_to_Fwd_Trans)
                   .func pm_queue
                   # The next head slot; meeting the tail means full. The byte is stored before the head moves,
                   # so a pump never sends a slot that isn't written yet.
80617e00  3c0a807b   la   t2, PM_VARS
80617e04  254a0000
80617e08  8d480194   lw   t0, 404(t2)                 # command ring head
80617e0c  25080001   addiu t0, t0, 1
80617e10  3108000f   andi t0, t0, 15
80617e14  8d490198   lw   t1, 408(t2)                 # command ring tail
80617e18  11090005   beq  t0, t1, pm_queue_full
80617e1c  01484821   addu t1, t2, t0                  # (delay slot) the slot's address
80617e20  a124019c   sb   a0, 412(t1)                 # command ring data
80617e24  ad480194   sw   t0, 404(t2)                 # command ring head
80617e28  03e00008   jr   ra
80617e2c  24020001   li   v0, 1
                   pm_queue_full:
80617e30  03e00008   jr   ra
80617e34  00001021   move v0, zero
                   .endfunc

                   # pm_cmd(a0 = command byte) -> v0 = 1 queued: pm_queue, then a pump
                   # ---- pm_cmd: 56 bytes at 0x80617818 (in FGetStatusAsNibbleData)
                   .func pm_cmd
80617818  27bdffe8   addiu sp, sp, -24
8061781c  afbf0014   sw   ra, 20(sp)
80617820  afb00010   sw   s0, 16(sp)
80617824  0c185f80   jal  pm_queue
80617828  00000000   nop
8061782c  10400003   beqz v0, pm_cmd_out
80617830  00408021   move s0, v0                      # (delay slot) the result to return
80617834  0c185bdb   jal  pm_pump
80617838  00000000   nop
                   pm_cmd_out:
8061783c  8fb00010   lw   s0, 16(sp)
80617840  8fbf0014   lw   ra, 20(sp)
80617844  02001021   move v0, s0
80617848  03e00008   jr   ra
8061784c  27bd0018   addiu sp, sp, 24
                   .endfunc

                   # pm_claim() -> v0 = 1: the port is ours (BUSY). 0: someone else has it, and PEND now tells
                   # them to go round once more.
                   # ---- pm_claim: 84 bytes at 0x8060f558 (in ModemSetRTS)
                   .func pm_claim
                   # Interrupts off (Status IE clear) so nothing can claim the port between our read of BUSY and
                   # our write; the old Status goes back on the way out.
8060f558  40086000   mfc0 t0, 12
8060f55c  2409fffe   li   t1, -2
8060f560  01094824   and  t1, t0, t1
8060f564  40896000   mtc0 t1, 12                      # interrupts off for the test-and-set
8060f568  00000000   nop
8060f56c  00000000   nop
                   # Free: it's ours (BUSY = 1). Taken: set PEND, so the owner goes round once more before it
                   # lets go, and moves whatever we came to move.
8060f570  3c0a807b   la   t2, PM_VARS
8060f574  254a0000
8060f578  8d420184   lw   v0, 388(t2)                 # BUSY
8060f57c  24090001   li   t1, 1
8060f580  14400004   bnez v0, pm_claim_taken
8060f584  00000000   nop
8060f588  ad490184   sw   t1, 388(t2)
8060f58c  10000003   b    pm_claim_out
8060f590  24020001   li   v0, 1
                   pm_claim_taken:
8060f594  ad490188   sw   t1, 392(t2)                 # PEND
8060f598  00001021   move v0, zero
                   pm_claim_out:
8060f59c  40886000   mtc0 t0, 12                      # interrupts back as they were
8060f5a0  00000000   nop
8060f5a4  03e00008   jr   ra
8060f5a8  00000000   nop
                   .endfunc

                   # pm_release(a0 = may go again) -> v0 = 1: someone asked meanwhile, the port stays ours and
                   # the caller goes round again. 0: released.
                   # ---- pm_release: 72 bytes at 0x80617f4c (in FExit_ECP_Mode)
                   .func pm_release
                   # Interrupts off, so a pump starting in an interrupt can't fall between reading PEND and
                   # clearing BUSY (it would find the port taken and nobody going round for it).
80617f4c  40086000   mfc0 t0, 12
80617f50  2409fffe   li   t1, -2
80617f54  01094824   and  t1, t0, t1
80617f58  40896000   mtc0 t1, 12
80617f5c  00000000   nop
80617f60  00000000   nop
80617f64  3c0a807b   la   t2, PM_VARS
80617f68  254a0000
                   # Asked for meanwhile, and the caller may go again: keep the port and say so. Otherwise let
                   # it go.
80617f6c  8d420188   lw   v0, 392(t2)
80617f70  ad400188   sw   zero, 392(t2)
80617f74  00441024   and  v0, v0, a0
80617f78  14400002   bnez v0, pm_release_out
80617f7c  00000000   nop
80617f80  ad400184   sw   zero, 388(t2)               # BUSY
                   pm_release_out:
80617f84  40886000   mtc0 t0, 12                      # interrupts back as they were
80617f88  00000000   nop
80617f8c  03e00008   jr   ra
80617f90  00000000   nop
                   .endfunc

                   # pm_portinit(): software mode, idle. For console output before InitModem (debug builds set up
                   # their parallel console early).
                   # ---- pm_portinit: 24 bytes at 0x80617cf8 (in FChange_ECP_Channel)
                   .func pm_portinit
80617cf8  3c19a400   lui  t9, PPB
80617cfc  24080001   li   t0, 1
80617d00  af28422c   sw   t0, P_ENABLE(t9)            # the port on
80617d04  af20420c   sw   zero, P_CNFG(t9)            # software mode: the box works the lines itself
80617d08  08185c94   j    pm_idle                     # idle lines: the bus to 0xFF, then released
80617d0c  00000000   nop
                   .endfunc

                   # pm_conout(a0 = byte): into the console ring (a full ring loses its oldest byte), then a pump.
                   # Any context.
                   # ---- pm_conout: 112 bytes at 0x80617d18 (in FFwd_to_Rev_Trans)
                   .func pm_conout
80617d18  27bdffe8   addiu sp, sp, -24
80617d1c  afbf0014   sw   ra, 20(sp)
80617d20  400b6000   mfc0 t3, 12
80617d24  2409fffe   li   t1, -2
80617d28  01694824   and  t1, t3, t1
80617d2c  40896000   mtc0 t1, 12                      # interrupts off: output can come from anywhere
80617d30  00000000   nop
80617d34  00000000   nop
                   # Into the console-out ring. Full: drop the oldest byte (move the tail on) rather than wait;
                   # a printf must never stall, with or without a bridge on the port.
80617d38  3c0a807b   la   t2, PM_VARS
80617d3c  254a0000
80617d40  8d480034   lw   t0, 52(t2)                  # console-out head
80617d44  25080001   addiu t0, t0, 1
80617d48  310800ff   andi t0, t0, 255
80617d4c  8d490038   lw   t1, 56(t2)                  # console-out tail
80617d50  15090004   bne  t0, t1, pm_conout_put
80617d54  01486021   addu t4, t2, t0
80617d58  25290001   addiu t1, t1, 1
80617d5c  312900ff   andi t1, t1, 255
80617d60  ad490038   sw   t1, 56(t2)
                   pm_conout_put:
80617d64  a184003c   sb   a0, 60(t4)                  # console-out data
80617d68  ad480034   sw   t0, 52(t2)                  # console-out head
                   # Interrupts back, then try to send it now. If the port is busy, the owner sends it for us.
80617d6c  408b6000   mtc0 t3, 12
80617d70  00000000   nop
80617d74  0c185bdb   jal  pm_pump
80617d78  00000000   nop
80617d7c  8fbf0014   lw   ra, 20(sp)
80617d80  03e00008   jr   ra
80617d84  27bd0018   addiu sp, sp, 24
                   .endfunc

                   # pm_conin() -> v0 = next console input byte, 0 if none (as ECPCharIOIn). Pumps when the ring
                   # is empty.
                   # ---- pm_conin: 96 bytes at 0x80617da0 (in FRev_to_Fwd_Trans)
                   .func pm_conin
80617da0  27bdffe8   addiu sp, sp, -24
80617da4  afbf0014   sw   ra, 20(sp)
80617da8  afb00010   sw   s0, 16(sp)
80617dac  3c10807b   la   s0, PM_VARS
80617db0  26100000
                   # Anything in the console-in ring? If not, one pump fetches what the bridge holds.
80617db4  8e080140   lw   t0, 320(s0)                 # console-in tail
80617db8  8e09013c   lw   t1, 316(s0)                 # console-in head
80617dbc  15090007   bne  t0, t1, pm_conin_take
80617dc0  00000000   nop
80617dc4  0c185bdb   jal  pm_pump
80617dc8  00000000   nop
80617dcc  8e080140   lw   t0, 320(s0)                 # console-in tail
80617dd0  8e09013c   lw   t1, 316(s0)                 # console-in head
80617dd4  11090006   beq  t0, t1, pm_conin_out
80617dd8  00001021   move v0, zero                    # (delay slot) still nothing: 0, as ECPCharIOIn returns
                   pm_conin_take:
                   # Take the oldest byte (tail + 1), then move the tail.
80617ddc  25080001   addiu t0, t0, 1
80617de0  3108003f   andi t0, t0, 63
80617de4  02084821   addu t1, s0, t0
80617de8  91220144   lbu  v0, 324(t1)                 # console-in data
80617dec  ae080140   sw   t0, 320(s0)                 # console-in tail
                   pm_conin_out:
80617df0  8fb00010   lw   s0, 16(sp)
80617df4  8fbf0014   lw   ra, 20(sp)
80617df8  03e00008   jr   ra
80617dfc  27bd0018   addiu sp, sp, 24
                   .endfunc

                   # pm_pump(): send the queued commands, then move everything that can move on all four
                   # channels, and end the burst. Enters the session first if there isn't one. Any context.
                   # The work is in the pm_ch_* subroutines below (so that every piece fits the room the OS
                   # patch finds); they share the pump's registers: s0 status byte, s1 count, s2 saw a PPP
                   # flag, s4 PM_VARS, s5 moved anything this round. Each returns v0 = 0, or -1 if the bridge
                   # stopped answering.
                   # The pump itself also keeps s3, the rounds left in this pass, and s6, the passes left before
                   # it lets the port go even if others keep asking.
                   # ---- pm_pump: 356 bytes at 0x80616f6c (in FInitDevice)
                   .func pm_pump
80616f6c  27bdffd0   addiu sp, sp, -48
80616f70  afbf002c   sw   ra, 44(sp)
80616f74  afb00010   sw   s0, 16(sp)
80616f78  afb10014   sw   s1, 20(sp)
80616f7c  afb20018   sw   s2, 24(sp)
80616f80  afb3001c   sw   s3, 28(sp)
80616f84  afb40020   sw   s4, 32(sp)
80616f88  afb50024   sw   s5, 36(sp)
80616f8c  afb60028   sw   s6, 40(sp)
80616f90  0c183d56   jal  pm_claim
80616f94  00000000   nop
80616f98  1040003d   beqz v0, pm_pump_ret             # someone else is pumping; they go round again for us
80616f9c  24160004   li   s6, 4                       # passes at most, however often others ask
80616fa0  3c14807b   la   s4, PM_VARS
80616fa4  26940000
                   pm_pump_pass:
                   # A pass: be in a session, send the queued commands, then rounds over the channels until a
                   # round moves nothing.
80616fa8  0c185ce7   jal  pm_session
80616fac  00009021   move s2, zero                    # (delay slot) no PPP flag seen yet
80616fb0  10400035   beqz v0, pm_pump_free            # no session (no bridge, or a 1997 ECP transfer)
80616fb4  00000000   nop
80616fb8  0c185f90   jal  pm_ch_cmd
80616fbc  00000000   nop
80616fc0  0440002c   bltz v0, pm_pump_lost
80616fc4  24130010   li   s3, 16                      # rounds a pass, so a busy link can't hold the CPU forever
                   pm_pump_round:
                   # A round: the status byte (and any replies) says what the bridge holds for us and whether its
                   # modem input has room; then each channel in turn moves what it can.
80616fc8  0c185fbb   jal  pm_ch_status
80616fcc  0000a821   move s5, zero                    # (delay slot) nothing moved yet
80616fd0  04400028   bltz v0, pm_pump_lost
80616fd4  00000000   nop
80616fd8  0c183e23   jal  pm_ch_peek
80616fdc  00000000   nop
80616fe0  04400024   bltz v0, pm_pump_lost
80616fe4  00000000   nop
80616fe8  0c183de9   jal  pm_ch_key
80616fec  00000000   nop
80616ff0  0c185f0f   jal  pm_ch_mi
80616ff4  00000000   nop
80616ff8  0440001e   bltz v0, pm_pump_lost
80616ffc  00000000   nop
80617000  0c185898   jal  pm_ch_ci
80617004  00000000   nop
80617008  0440001a   bltz v0, pm_pump_lost
8061700c  00000000   nop
80617010  0c185ea7   jal  pm_ch_mo
80617014  00000000   nop
80617018  04400016   bltz v0, pm_pump_lost
8061701c  00000000   nop
80617020  0c183d6d   jal  pm_ch_co
80617024  00000000   nop
80617028  04400012   bltz v0, pm_pump_lost
8061702c  00000000   nop
80617030  12a00003   beqz s5, pm_pump_done            # nothing moved: done
80617034  2673ffff   addiu s3, s3, -1
80617038  1660ffe3   bnez s3, pm_pump_round
8061703c  00000000   nop
                   pm_pump_done:
                   # Keep the status for ModemGetCD and the LSR/MSR reads, end the burst (bus to 0xFF, code 111),
                   # wake PPP if a frame ended, and let the port go unless a pump was asked for meanwhile.
80617040  320800ff   andi t0, s0, 0xff
80617044  ae880008   sw   t0, 8(s4)                   # the last status byte
80617048  0c185c94   jal  pm_idle
8061704c  00000000   nop
80617050  0c185c2e   jal  pm_pump_ppp
80617054  00000000   nop
80617058  26d6ffff   addiu s6, s6, -1
8061705c  0c185fd3   jal  pm_release
80617060  02c02021   move a0, s6                      # (delay slot) may go again while passes are left
80617064  1440ffd0   bnez v0, pm_pump_pass            # asked for meanwhile: once more
80617068  00000000   nop
8061706c  10000008   b    pm_pump_ret
80617070  00000000   nop
                   pm_pump_lost:                      # no answer: the session is gone; enter again next time
80617074  ae800000   sw   zero, 0(s4)                 # in a session
80617078  0c185c94   jal  pm_idle
8061707c  00000000   nop
80617080  0c185c2e   jal  pm_pump_ppp
80617084  00000000   nop
                   pm_pump_free:
80617088  0c185fd3   jal  pm_release
8061708c  00002021   move a0, zero
                   pm_pump_ret:
80617090  8fb00010   lw   s0, 16(sp)
80617094  8fb10014   lw   s1, 20(sp)
80617098  8fb20018   lw   s2, 24(sp)
8061709c  8fb3001c   lw   s3, 28(sp)
806170a0  8fb40020   lw   s4, 32(sp)
806170a4  8fb50024   lw   s5, 36(sp)
806170a8  8fb60028   lw   s6, 40(sp)
806170ac  8fbf002c   lw   ra, 44(sp)
806170b0  03e00008   jr   ra
806170b4  27bd0030   addiu sp, sp, 48
                   pm_pump_ppp:                       # wake PPP if a flag byte came in (s2)
806170b8  12400003   beqz s2, pm_pump_ppp_no
806170bc  00000000   nop
806170c0  081c31e0   j    pppInterruptHandler                 # tail call: the OS's PPP wake-up, as its modem ISR did
806170c4  00000000   nop
                   pm_pump_ppp_no:
806170c8  03e00008   jr   ra
806170cc  00000000   nop
                   .endfunc

                   # pm_session() -> v0 = 1 in a session (entering one if need be). 0 while CNFG != 0 (a 1997
                   # ECP transfer has the port), or if nobody answers (then again at most once a second).
                   # ---- pm_session: 144 bytes at 0x8061739c (in FGetDeviceInfoSize)
                   .func pm_session
8061739c  27bdfff8   addiu sp, sp, -8
806173a0  afbf0004   sw   ra, 4(sp)
                   # A 1997 ECP transfer owns the port while CNFG != 0: stay off it.
806173a4  3c19a400   lui  t9, PPB
806173a8  8f28420c   lw   t0, P_CNFG(t9)
806173ac  1500001c   bnez t0, pm_session_out
806173b0  00001021   move v0, zero                    # (delay slot) not in a session
                   # We think we're in a session: PError low says the bridge agrees. High: it reset, was
                   # unplugged or stepped aside for ECP, so enter again.
806173b4  8e880000   lw   t0, 0(s4)
806173b8  11000006   beqz t0, pm_session_enter
806173bc  00000000   nop
806173c0  8f284208   lw   t0, P_STAT(t9)
806173c4  31080010   andi t0, t0, S_PE
806173c8  11000015   beqz t0, pm_session_out          # PError low: the session is up
806173cc  24020001   li   v0, 1
806173d0  ae800000   sw   zero, 0(s4)      # PError high: the bridge has none (reset, ECP, unplugged)
                   pm_session_enter:
                   # After a failed entry, try again only once a second, so a box without a bridge doesn't
                   # spend its time waiting for answers.
806173d4  8e88018c   lw   t0, 396(s4)                 # the last entry failed
806173d8  11000009   beqz t0, pm_session_try
806173dc  00000000   nop
806173e0  40084800   mfc0 t0, 9
806173e4  8e890190   lw   t1, 400(s4)                 # when it was tried
806173e8  01094023   subu t0, t0, t1
806173ec  3c0904f2   li   t1, T_RETRY
806173f0  35297ac0
806173f4  0109402b   sltu t0, t0, t1
806173f8  15000009   bnez t0, pm_session_out          # nobody answered less than a second ago
806173fc  00001021   move v0, zero
                   pm_session_try:
                   # Enter; remember a failure and when it happened.
80617400  0c185d59   jal  pm_enter
80617404  00000000   nop
80617408  ae80018c   sw   zero, 396(s4)               # the last entry failed
8061740c  14400004   bnez v0, pm_session_out
80617410  24080001   li   t0, 1
80617414  ae88018c   sw   t0, 396(s4)
80617418  40084800   mfc0 t0, 9
8061741c  ae880190   sw   t0, 400(s4)                 # when it was tried
                   pm_session_out:
80617420  8fbf0004   lw   ra, 4(sp)
80617424  03e00008   jr   ra
80617428  27bd0008   addiu sp, sp, 8
                   .endfunc

                   # queued commands, in order
                   # ---- pm_ch_cmd: 96 bytes at 0x80617e40 (in FECP_GetChar)
                   .func pm_ch_cmd
80617e40  27bdfff8   addiu sp, sp, -8
80617e44  afbf0004   sw   ra, 4(sp)
                   pm_ch_cmd_next:
                   # Each queued command byte on CTRL_OUT, oldest first. A byte leaves the queue only once the
                   # bridge has taken it, so a dropped session loses nothing.
80617e48  8e880198   lw   t0, 408(s4)                 # command ring tail
80617e4c  8e890194   lw   t1, 404(s4)                 # command ring head
80617e50  11090010   beq  t0, t1, pm_ch_cmd_out
80617e54  00001021   move v0, zero
80617e58  25080001   addiu t0, t0, 1
80617e5c  3108000f   andi t0, t0, 15
80617e60  02884821   addu t1, s4, t0
80617e64  9125019c   lbu  a1, 412(t1)                 # the command byte
80617e68  0c183cf2   jal  pm_xfer
80617e6c  2404001d   li   a0, 0x1d                   # (delay slot) CTRL_OUT
80617e70  04400008   bltz v0, pm_ch_cmd_out
80617e74  00000000   nop
80617e78  10600006   beqz v1, pm_ch_cmd_out           # not taken: the bridge has no session after all
80617e7c  2402ffff   li   v0, -1
80617e80  8e880198   lw   t0, 408(s4)                 # command ring tail
80617e84  25080001   addiu t0, t0, 1
80617e88  3108000f   andi t0, t0, 15
80617e8c  1000ffee   b    pm_ch_cmd_next
80617e90  ae880198   sw   t0, 408(s4)
                   pm_ch_cmd_out:
80617e94  8fbf0004   lw   ra, 4(sp)
80617e98  03e00008   jr   ra
80617e9c  27bd0008   addiu sp, sp, 8
                   .endfunc

                   # CTRL_IN: command replies first (Select high), then the status byte -> s0
                   # ---- pm_ch_status: 96 bytes at 0x80617eec (in FExit_ECP_Mode)
                   .func pm_ch_status
80617eec  27bdfff8   addiu sp, sp, -8
80617ef0  afbf0004   sw   ra, 4(sp)
                   pm_ch_status_next:
                   # CTRL_IN gives a pending reply byte (Select high) or, when none is left, the status byte
                   # (Select low): bit 0 modem bytes waiting, 1 console input, 2 a reply, 3 carrier, 4 the
                   # bridge's modem input is full.
80617ef4  0c183cf2   jal  pm_xfer
80617ef8  24040009   li   a0, 0x9                   # (delay slot) CTRL_IN
80617efc  0440000f   bltz v0, pm_ch_status_out
80617f00  00000000   nop
80617f04  1060000d   beqz v1, pm_ch_status_out
80617f08  00408021   move s0, v0                      # Select low: s0 = status byte
80617f0c  8e88001c   lw   t0, 28(s4)            # a reply byte: keep it (the oldest goes when full)
80617f10  25080001   addiu t0, t0, 1
80617f14  3108000f   andi t0, t0, 15
80617f18  8e890020   lw   t1, 32(s4)                  # reply ring tail
80617f1c  15090004   bne  t0, t1, pm_ch_status_reply
80617f20  02885021   addu t2, s4, t0
80617f24  25290001   addiu t1, t1, 1
80617f28  3129000f   andi t1, t1, 15
80617f2c  ae890020   sw   t1, 32(s4)
                   pm_ch_status_reply:
80617f30  a1420024   sb   v0, 36(t2)                  # reply ring data
80617f34  1000ffef   b    pm_ch_status_next
80617f38  ae88001c   sw   t0, 28(s4)                  # reply ring head
                   pm_ch_status_out:
80617f3c  000217c3   sra  v0, v0, 31                  # -1 stays -1, a status byte becomes 0
80617f40  8fbf0004   lw   ra, 4(sp)
80617f44  03e00008   jr   ra
80617f48  27bd0008   addiu sp, sp, 8
                   .endfunc

                   # a peek: the bridge wants box memory (the web page's screenshot of what the OS is showing).
                   # Status bit 6 says the last four reply bytes are an address, big-endian; its low bit set asks
                   # for one word, else sixteen. Only RAM (as kseg0) or the SOLO's registers (0xa400xxxx) are
                   # read, so no address the bridge sends can fault. Back on CTRL_OUT: PEEK, the count, then
                   # the words big-endian. t4-t7 hold across pm_xfer (it uses t0-t3, t9).
                   # ---- pm_ch_peek: 280 bytes at 0x8060f88c (in getbuf_modem)
                   .func pm_ch_peek
8060f88c  27bdfff8   addiu sp, sp, -8
8060f890  afbf0004   sw   ra, 4(sp)
8060f894  32080040   andi t0, s0, 64
8060f898  1100003f   beqz t0, pm_ch_peek_out
8060f89c  00001021   move v0, zero
                   # The address: reply ring slots head-3 .. head, oldest first; then the ring is used up.
8060f8a0  8e88001c   lw   t0, 28(s4)                  # reply ring head
8060f8a4  00006021   move t4, zero
8060f8a8  240d0004   li   t5, 4
                   pm_ch_peek_addr:
8060f8ac  010d4823   subu t1, t0, t5
8060f8b0  25290001   addiu t1, t1, 1
8060f8b4  3129000f   andi t1, t1, 15
8060f8b8  02894821   addu t1, s4, t1
8060f8bc  91290024   lbu  t1, 36(t1)                  # reply ring data
8060f8c0  000c6200   sll  t4, t4, 8
8060f8c4  01896025   or   t4, t4, t1
8060f8c8  25adffff   addiu t5, t5, -1
8060f8cc  15a0fff7   bnez t5, pm_ch_peek_addr
8060f8d0  00000000   nop
8060f8d4  ae880020   sw   t0, 32(s4)                  # reply ring tail = head: consumed
                   # How many words: low bit set, one (a register); else sixteen.
8060f8d8  318d0001   andi t5, t4, 1
8060f8dc  11a00002   beqz t5, pm_ch_peek_n
8060f8e0  240d0010   li   t5, 16                      # (delay slot) sixteen
8060f8e4  240d0001   li   t5, 1
                   pm_ch_peek_n:
                   # Where: the SOLO's registers as they are, anything else as RAM through kseg0.
8060f8e8  000c4402   srl  t0, t4, 16
8060f8ec  3409a400   li   t1, 0xa400
8060f8f0  15090004   bne  t0, t1, pm_ch_peek_ram
8060f8f4  3188fffc   andi t0, t4, 0xfffc              # (delay slot) a register's offset
8060f8f8  3c0ca400   lui  t4, 0xa400
8060f8fc  10000006   b    pm_ch_peek_send
8060f900  01886025   or   t4, t4, t0
                   pm_ch_peek_ram:
8060f904  3c08007f   lui  t0, 0x7f
8060f908  3508fffc   ori  t0, t0, 0xfffc
8060f90c  01884024   and  t0, t4, t0                  # within 8 MB, word-aligned
8060f910  3c0c8000   lui  t4, 0x8000
8060f914  01886025   or   t4, t4, t0
                   pm_ch_peek_send:
8060f918  24050007   li   a1, 7
8060f91c  0c183cf2   jal  pm_xfer
8060f920  2404001d   li   a0, 0x1d                   # (delay slot) CTRL_OUT
8060f924  0440001c   bltz v0, pm_ch_peek_out
8060f928  00000000   nop
8060f92c  1060001a   beqz v1, pm_ch_peek_out          # not taken: the bridge has no session after all
8060f930  2402ffff   li   v0, -1
8060f934  01a02821   move a1, t5
8060f938  0c183cf2   jal  pm_xfer
8060f93c  2404001d   li   a0, 0x1d                   # (delay slot) CTRL_OUT
8060f940  04400015   bltz v0, pm_ch_peek_out
8060f944  00000000   nop
8060f948  10600013   beqz v1, pm_ch_peek_out
8060f94c  2402ffff   li   v0, -1
                   pm_ch_peek_word:
8060f950  8d8e0000   lw   t6, 0(t4)
8060f954  240f0004   li   t7, 4
                   pm_ch_peek_byte:
8060f958  000e2e02   srl  a1, t6, 24
8060f95c  0c183cf2   jal  pm_xfer
8060f960  2404001d   li   a0, 0x1d                   # (delay slot) CTRL_OUT
8060f964  0440000c   bltz v0, pm_ch_peek_out
8060f968  00000000   nop
8060f96c  1060000a   beqz v1, pm_ch_peek_out
8060f970  2402ffff   li   v0, -1
8060f974  000e7200   sll  t6, t6, 8
8060f978  25efffff   addiu t7, t7, -1
8060f97c  15e0fff6   bnez t7, pm_ch_peek_byte
8060f980  00000000   nop
8060f984  25adffff   addiu t5, t5, -1
8060f988  15a0fff1   bnez t5, pm_ch_peek_word
8060f98c  258c0004   addiu t4, t4, 4                  # (delay slot) the next word
8060f990  24150001   li   s5, 1                       # something moved
8060f994  00001021   move v0, zero
                   pm_ch_peek_out:
8060f998  8fbf0004   lw   ra, 4(sp)
8060f99c  03e00008   jr   ra
8060f9a0  27bd0008   addiu sp, sp, 8
                   .endfunc

                   # a key from the bridge (status bit 7): the last four reply bytes are the first word of an entry
                   # in the OS's IR input ring. Queued as the OS's decoders queue one (ValidateSonyData in 16406):
                   # at (irHead + 1) & 63 unless that is irTail (full: dropped, as the OS drops one), the word, then
                   # gSystemTicks, gLastIRTime = it, irHead = the slot, with interrupts off so no decoder is
                   # midway. IRIdle takes it from there, as a key from the IR receiver. A build without the ring
                   # (syms.ir) only uses the bytes up.
                   # ---- pm_ch_key: 220 bytes at 0x8060f7a4 (in putbuf_modem)
                   .func pm_ch_key
8060f7a4  27bdfff8   addiu sp, sp, -8
8060f7a8  afbf0004   sw   ra, 4(sp)
8060f7ac  32080080   andi t0, s0, 128
8060f7b0  11000030   beqz t0, pm_ch_key_out
8060f7b4  00001021   move v0, zero
8060f7b8  8e88001c   lw   t0, 28(s4)                  # reply ring head
8060f7bc  00006021   move t4, zero
8060f7c0  240d0004   li   t5, 4
                   pm_ch_key_byte:
8060f7c4  010d4823   subu t1, t0, t5
8060f7c8  25290001   addiu t1, t1, 1
8060f7cc  3129000f   andi t1, t1, 15
8060f7d0  02894821   addu t1, s4, t1
8060f7d4  91290024   lbu  t1, 36(t1)                  # reply ring data
8060f7d8  000c6200   sll  t4, t4, 8
8060f7dc  01896025   or   t4, t4, t1
8060f7e0  25adffff   addiu t5, t5, -1
8060f7e4  15a0fff7   bnez t5, pm_ch_key_byte
8060f7e8  00000000   nop
8060f7ec  ae880020   sw   t0, 32(s4)                  # reply ring tail = head: consumed
8060f7f0  24150001   li   s5, 1                       # something moved
8060f7f4  400e6000   mfc0 t6, 12
8060f7f8  2409fffe   li   t1, -2
8060f7fc  01c94824   and  t1, t6, t1
8060f800  40896000   mtc0 t1, 12                      # interrupts off: the decoders queue from the IR task
8060f804  00000000   nop
8060f808  00000000   nop
8060f80c  3c0a8000   la   t2, irHead
8060f810  254a2ec8
8060f814  8d480000   lw   t0, 0(t2)
8060f818  25080001   addiu t0, t0, 1
8060f81c  3108003f   andi t0, t0, 63
8060f820  3c0b8000   la   t3, irTail
8060f824  256b2ecc
8060f828  8d690000   lw   t1, 0(t3)
8060f82c  1109000d   beq  t0, t1, pm_ch_key_full      # full: dropped
8060f830  000848c0   sll  t1, t0, 3                   # (delay slot) 8 bytes an entry
8060f834  3c0b8000   la   t3, irDataBuf
8060f838  256b2cc8
8060f83c  01695821   addu t3, t3, t1
8060f840  ad6c0000   sw   t4, 0(t3)
8060f844  3c098000   la   t1, gSystemTicks
8060f848  25291f44
8060f84c  8d290000   lw   t1, 0(t1)
8060f850  ad690004   sw   t1, 4(t3)                   # when: Now()
8060f854  3c0d8000   la   t5, gLastIRTime
8060f858  25ad2ed4
8060f85c  ada90000   sw   t1, 0(t5)                   # gLastIRTime
8060f860  ad480000   sw   t0, 0(t2)                   # irHead: IRIdle sees it
                   pm_ch_key_full:
8060f864  408e6000   mtc0 t6, 12                      # interrupts back as they were
8060f868  00000000   nop
8060f86c  00000000   nop
8060f870  00001021   move v0, zero
                   pm_ch_key_out:
8060f874  8fbf0004   lw   ra, 4(sp)
8060f878  03e00008   jr   ra
8060f87c  27bd0008   addiu sp, sp, 8
                   .endfunc

                   # modem in, while the bridge has bytes and the ring has room
                   # ---- pm_ch_mi: 188 bytes at 0x80617c3c (in FChange_ECP_Channel)
                   .func pm_ch_mi
80617c3c  27bdfff8   addiu sp, sp, -8
80617c40  afbf0004   sw   ra, 4(sp)
                   # Status bit 0: the bridge has modem bytes. Up to 32 a round, straight into the OS's receive
                   # ring; when the ring is full the rest waits in the bridge.
80617c44  32080001   andi t0, s0, 1
80617c48  11000028   beqz t0, pm_ch_mi_out
80617c4c  00001021   move v0, zero
80617c50  24110020   li   s1, 32
                   pm_ch_mi_byte:
80617c54  3c0a8000   la   t2, RCVHEAD
80617c58  254a263c
80617c5c  8d480000   lw   t0, 0(t2)
80617c60  25080001   addiu t0, t0, 1
80617c64  31080fff   andi t0, t0, 4095
80617c68  3c0b8000   la   t3, RCVTAIL
80617c6c  256b2640
80617c70  8d690000   lw   t1, 0(t3)
80617c74  1109001d   beq  t0, t1, pm_ch_mi_out        # ring full: leave it in the bridge
80617c78  00001021   move v0, zero
80617c7c  0c183cf2   jal  pm_xfer
80617c80  24040003   li   a0, 0x3                   # (delay slot) MODEM_IN
80617c84  04400019   bltz v0, pm_ch_mi_out
80617c88  00000000   nop
80617c8c  14600004   bnez v1, pm_ch_mi_got
80617c90  00000000   nop
80617c94  00408021   move s0, v0                      # Select low: v0 is the status, nothing more waiting
80617c98  10000014   b    pm_ch_mi_out
80617c9c  00001021   move v0, zero
                   pm_ch_mi_got:
80617ca0  3c0a8000   la   t2, RCVHEAD
80617ca4  254a263c
80617ca8  8d480000   lw   t0, 0(t2)
80617cac  25080001   addiu t0, t0, 1
80617cb0  31080fff   andi t0, t0, 4095
80617cb4  3c0b8000   la   t3, RCVDATA
80617cb8  256b2630
80617cbc  8d6b0000   lw   t3, 0(t3)
80617cc0  01685821   addu t3, t3, t0
80617cc4  a1620000   sb   v0, 0(t3)
80617cc8  ad480000   sw   t0, 0(t2)
                   # A PPP flag byte (0x7e) ends a frame: note it, to wake PPP when the pump is done.
80617ccc  3848007e   xori t0, v0, 0x7e
80617cd0  15000002   bnez t0, pm_ch_mi_next
80617cd4  24150001   li   s5, 1                       # (delay slot) something moved
80617cd8  24120001   li   s2, 1                       # a flag byte came in
                   pm_ch_mi_next:
80617cdc  2631ffff   addiu s1, s1, -1
80617ce0  1620ffdc   bnez s1, pm_ch_mi_byte
80617ce4  00000000   nop
80617ce8  00001021   move v0, zero
                   pm_ch_mi_out:
80617cec  8fbf0004   lw   ra, 4(sp)
80617cf0  03e00008   jr   ra
80617cf4  27bd0008   addiu sp, sp, 8
                   .endfunc

                   # console in
                   # ---- pm_ch_ci: 136 bytes at 0x80616260 (in InitParallelPort)
                   .func pm_ch_ci
80616260  27bdfff8   addiu sp, sp, -8
80616264  afbf0004   sw   ra, 4(sp)
                   # Status bit 1: console input waiting. Up to 32 a round into the console-in ring (64 bytes);
                   # the rest waits in the bridge.
80616268  32080002   andi t0, s0, 2
8061626c  1100001b   beqz t0, pm_ch_ci_out
80616270  00001021   move v0, zero
80616274  24110020   li   s1, 32
                   pm_ch_ci_byte:
80616278  8e88013c   lw   t0, 316(s4)                 # console-in head
8061627c  25080001   addiu t0, t0, 1
80616280  3108003f   andi t0, t0, 63
80616284  8e890140   lw   t1, 320(s4)                 # console-in tail
80616288  11090014   beq  t0, t1, pm_ch_ci_out        # ring full
8061628c  00001021   move v0, zero
80616290  0c183cf2   jal  pm_xfer
80616294  2404000b   li   a0, 0xb                   # (delay slot) CON_IN
80616298  04400010   bltz v0, pm_ch_ci_out
8061629c  00000000   nop
806162a0  14600004   bnez v1, pm_ch_ci_got
806162a4  00000000   nop
806162a8  00408021   move s0, v0                      # Select low: the status
806162ac  1000000b   b    pm_ch_ci_out
806162b0  00001021   move v0, zero
                   pm_ch_ci_got:
806162b4  8e88013c   lw   t0, 316(s4)                 # console-in head
806162b8  25080001   addiu t0, t0, 1
806162bc  3108003f   andi t0, t0, 63
806162c0  02884821   addu t1, s4, t0
806162c4  a1220144   sb   v0, 324(t1)                 # console-in data
806162c8  ae88013c   sw   t0, 316(s4)                 # console-in head
806162cc  2631ffff   addiu s1, s1, -1
806162d0  1620ffe9   bnez s1, pm_ch_ci_byte
806162d4  24150001   li   s5, 1
806162d8  00001021   move v0, zero
                   pm_ch_ci_out:
806162dc  8fbf0004   lw   ra, 4(sp)
806162e0  03e00008   jr   ra
806162e4  27bd0008   addiu sp, sp, 8
                   .endfunc

                   # modem out, unless the bridge said its modem input is full
                   # ---- pm_ch_mo: 156 bytes at 0x80617a9c (in FExitNibbleMode)
                   .func pm_ch_mo
80617a9c  27bdfff8   addiu sp, sp, -8
80617aa0  afbf0004   sw   ra, 4(sp)
                   # Status bit 4: the bridge's modem input is full, so send nothing. Otherwise up to 32 bytes a
                   # round from the OS's transmit ring. A refused byte stays in the ring; the bridge pulses nAck
                   # when it has room, and that interrupt runs the pump again.
80617aa4  32080010   andi t0, s0, 16
80617aa8  15000020   bnez t0, pm_ch_mo_out
80617aac  00001021   move v0, zero
80617ab0  24110020   li   s1, 32
                   pm_ch_mo_byte:
80617ab4  3c0a8000   la   t2, XMTTAIL
80617ab8  254a2648
80617abc  8d480000   lw   t0, 0(t2)
80617ac0  3c0b8000   la   t3, XMTHEAD
80617ac4  256b2644
80617ac8  8d690000   lw   t1, 0(t3)
80617acc  11090017   beq  t0, t1, pm_ch_mo_out        # empty
80617ad0  00001021   move v0, zero
80617ad4  25080001   addiu t0, t0, 1
80617ad8  31080fff   andi t0, t0, 4095
80617adc  3c0b8000   la   t3, XMTDATA
80617ae0  256b2634
80617ae4  8d6b0000   lw   t3, 0(t3)
80617ae8  01685821   addu t3, t3, t0
80617aec  91650000   lbu  a1, 0(t3)
80617af0  0c183cf2   jal  pm_xfer
80617af4  24040017   li   a0, 0x17                   # (delay slot) MODEM_OUT
80617af8  0440000c   bltz v0, pm_ch_mo_out
80617afc  00000000   nop
80617b00  1060000a   beqz v1, pm_ch_mo_out            # refused: the bridge pulses nAck when it has room
80617b04  00001021   move v0, zero
80617b08  3c0a8000   la   t2, XMTTAIL
80617b0c  254a2648
80617b10  8d480000   lw   t0, 0(t2)
80617b14  25080001   addiu t0, t0, 1
80617b18  31080fff   andi t0, t0, 4095
80617b1c  ad480000   sw   t0, 0(t2)
80617b20  2631ffff   addiu s1, s1, -1
80617b24  1620ffe3   bnez s1, pm_ch_mo_byte
80617b28  24150001   li   s5, 1
                   pm_ch_mo_out:
80617b2c  8fbf0004   lw   ra, 4(sp)
80617b30  03e00008   jr   ra
80617b34  27bd0008   addiu sp, sp, 8
                   .endfunc

                   # console out (always accepted)
                   # ---- pm_ch_co: 104 bytes at 0x8060f5b4 (in ModemSetDTR)
                   .func pm_ch_co
8060f5b4  27bdfff8   addiu sp, sp, -8
8060f5b8  afbf0004   sw   ra, 4(sp)
                   # Up to 32 console bytes a round. The bridge always takes them; only a lost bridge stops this.
8060f5bc  24110020   li   s1, 32
                   pm_ch_co_byte:
8060f5c0  8e880038   lw   t0, 56(s4)                  # console-out tail
8060f5c4  8e890034   lw   t1, 52(s4)                  # console-out head
8060f5c8  11090011   beq  t0, t1, pm_ch_co_out
8060f5cc  00001021   move v0, zero
8060f5d0  25080001   addiu t0, t0, 1
8060f5d4  310800ff   andi t0, t0, 255
8060f5d8  02884821   addu t1, s4, t0
8060f5dc  9125003c   lbu  a1, 60(t1)                  # the console byte
8060f5e0  0c183cf2   jal  pm_xfer
8060f5e4  24040015   li   a0, 0x15                   # (delay slot) CON_OUT
8060f5e8  04400009   bltz v0, pm_ch_co_out
8060f5ec  00000000   nop
8060f5f0  8e880038   lw   t0, 56(s4)                  # console-out tail
8060f5f4  25080001   addiu t0, t0, 1
8060f5f8  310800ff   andi t0, t0, 255
8060f5fc  ae880038   sw   t0, 56(s4)
8060f600  2631ffff   addiu s1, s1, -1
8060f604  1620ffee   bnez s1, pm_ch_co_byte
8060f608  24150001   li   s5, 1
8060f60c  00001021   move v0, zero
                   pm_ch_co_out:
8060f610  8fbf0004   lw   ra, 4(sp)
8060f614  03e00008   jr   ra
8060f618  27bd0008   addiu sp, sp, 8
                   .endfunc

                   # the driver's state (V offsets), written by the driver only once placed in RAM: 0 in a session,
                   # 4 the last CTRL value, 8 the last status byte, 12 unanswered transactions, 16 sessions entered,
                   # 20 the bridge's version, 28 reply ring (head, tail, 16 bytes), 52 console-out ring (head, tail,
                   # 256), 316 console-in ring (head, tail, 64), 388 BUSY, 392 PEND, 396 the last entry failed,
                   # 400 when (Count), 404 command ring (head, tail, 16). All zero is a valid start.
                   .func PM_VARS
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                     .word 0
                   .endfunc
```

## A.3 The modem driver (driver.js)

The bottom of the OS's modem stack, rewritten onto PARMOD's modem channel: the interrupt handler, and a replacement for each hooked modem function. The OS's own 4 KB rings stay; `ReadModemReg` / `WriteModemReg` become a small virtual 16550 for TellyScript. `lm_signature` is the `LPT2` marker and driver version that tools look for in a patched build.

```
                   .equ LPT_INT, 0x1d
                   .equ PPB, 0xa400                   # lui: SOLO registers (KSEG1)
                   .equ P_IEN, 0x4220
                   .equ P_CLRINT, 0x4228
                   .equ I_ACKDONE, 0x8
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
                   # ---- lm_isr: 56 bytes at 0x80617ea0 (in FECP_GetChar)
                   .func lm_isr

80617ea0  27bdffe8   addiu sp, sp, -24
80617ea4  afbf0014   sw   ra, 20(sp)
                   # The bridge pulsed nAck: it has something for us (modem data, console input, room again, a
                   # carrier change). Clear the interrupt, count it, and pump; the pump does the work.
80617ea8  3c19a400   lui  t9, PPB
80617eac  24080008   li   t0, I_ACKDONE
80617eb0  af284228   sw   t0, P_CLRINT(t9)
80617eb4  3c098000   lui  t1, %hi(RCVHEAD)
80617eb8  91282651   lbu  t0, %lo(V_INTS)(t1)
80617ebc  25080001   addiu t0, t0, 1
80617ec0  0c185bdb   jal  pm_pump
80617ec4  a1282651   sb   t0, %lo(V_INTS)(t1)    # (delay slot) the count
80617ec8  8fbf0014   lw   ra, 20(sp)
80617ecc  24020001   li   v0, 1
80617ed0  03e00008   jr   ra
80617ed4  27bd0018   addiu sp, sp, 24
                   .endfunc

                   # lm_lock / lm_unlock: mask / unmask the parallel port interrupt (tail calls). They also
                   # replace DisableModemInterrupts / EnableModemInterrupts.
                   # ---- lm_lock: 8 bytes at 0x806170d0 (in FInitDevice)
                   .func lm_lock
806170d0  08184b36   j    DisableInterrupt
806170d4  2404001d   li   a0, LPT_INT                 # (delay slot) the parallel port's interrupt
                   .endfunc

                   # ---- lm_unlock: 8 bytes at 0x8060f9a4 (in getbuf_modem)
                   .func lm_unlock
8060f9a4  08184b2c   j    EnableInterrupt
8060f9a8  2404001d   li   a0, LPT_INT                 # (delay slot) the parallel port's interrupt
                   .endfunc

                   # ---------------------------------------------------------------- modem API replacements

                   # InitModem() -> 0
                   # ---- lm_init: 132 bytes at 0x80617434 (in FGetDeviceInfo)
                   .func lm_init

80617434  27bdffe8   addiu sp, sp, -24
80617438  afbf0014   sw   ra, 20(sp)
8061743c  3c188000   lui  t8, %hi(RCVHEAD)
                   # Empty both modem rings and reset the virtual 16550's registers.
80617440  af00263c   sw   zero, %lo(RCVHEAD)(t8)
80617444  af002640   sw   zero, %lo(RCVTAIL)(t8)
80617448  af002644   sw   zero, %lo(XMTHEAD)(t8)
8061744c  af002648   sw   zero, %lo(XMTTAIL)(t8)
80617450  3c080003   li   t0, 0x00030000              # IER 0, LCR 3 (8N1), MCR 0, SCR 0
80617454  35080000
80617458  af08264c   sw   t0, %lo(V_REGS)(t8)
8061745c  af002650   sw   zero, %lo(V_CTL)(t8)     # idle control (DTR off), no interrupts, no errors
                   # The port interrupt off while things are set up; the port to software mode, lines idle.
80617460  3c19a400   lui  t9, PPB
80617464  af204220   sw   zero, P_IEN(t9)
80617468  0c185f3e   jal  pm_portinit                 # software mode, idle
8061746c  00000000   nop
                   # Install lm_isr on the parallel port's interrupt (a stale ACKDONE cleared first), then enable
                   # ACKDONE: from now on an nAck pulse from the bridge interrupts the OS.
80617470  3c19a400   lui  t9, PPB
80617474  24080008   li   t0, I_ACKDONE
80617478  af284228   sw   t0, P_CLRINT(t9)
8061747c  2404001d   li   a0, LPT_INT
80617480  3c058061   la   a1, lm_isr
80617484  24a57ea0
80617488  00003021   move a2, zero
8061748c  0c1cd4c4   jal  RegisterIntHandler
80617490  00003821   move a3, zero
80617494  3c19a400   lui  t9, PPB
80617498  24080008   li   t0, I_ACKDONE
8061749c  af284220   sw   t0, P_IEN(t9)
                   # The original InitModem reset the modem chip; this asks the bridge to do the same with its
                   # modem (MODEM_RESET). It waits in the queue until a session is up.
806174a0  0c185e06   jal  pm_cmd                      # the bridge hangs up and resets its modem
806174a4  24040001   li   a0, 0x1
806174a8  8fbf0014   lw   ra, 20(sp)
806174ac  00001021   move v0, zero
806174b0  03e00008   jr   ra
806174b4  27bd0018   addiu sp, sp, 24
                   .endfunc

                   # putchar_modem(a0 = byte) -> 0 queued, 1 ring full
                   # ---- lm_putchar: 36 bytes at 0x806172cc (in FGetDataBits)
                   .func lm_putchar
                   # One byte is putbuf with a length of 1; the byte goes through a stack slot.
806172cc  27bdffe8   addiu sp, sp, -24
806172d0  afbf0014   sw   ra, 20(sp)
806172d4  a3a40010   sb   a0, 16(sp)
806172d8  27a40010   addiu a0, sp, 16
806172dc  0c185c39   jal  lm_putbuf
806172e0  24050001   li   a1, 1                       # (delay slot) one byte
806172e4  8fbf0014   lw   ra, 20(sp)
806172e8  03e00008   jr   ra
806172ec  27bd0018   addiu sp, sp, 24
                   .endfunc

                   # putbuf_modem(a0 = buf, a1 = len) -> 0 queued, 1 not enough room (nothing queued)
                   # ---- lm_putbuf: 172 bytes at 0x806170e4 (in FOpenDriver)
                   .func lm_putbuf

806170e4  27bdffe0   addiu sp, sp, -32
806170e8  afbf001c   sw   ra, 28(sp)
806170ec  afb00018   sw   s0, 24(sp)
806170f0  afb10014   sw   s1, 20(sp)
806170f4  afb20010   sw   s2, 16(sp)
806170f8  00808021   move s0, a0
806170fc  00a08821   move s1, a1
80617100  0c185c34   jal  lm_lock
80617104  00000000   nop
                   # With the port interrupt masked (the ISR's pump can't run in the middle), check the transmit
                   # ring has room for all of it: the OS expects all or nothing.
80617108  24120001   li   s2, 1
8061710c  3c188000   lui  t8, %hi(RCVHEAD)
80617110  8f082644   lw   t0, %lo(XMTHEAD)(t8)
80617114  8f0a2648   lw   t2, %lo(XMTTAIL)(t8)
80617118  01485823   subu t3, t2, t0
8061711c  256bffff   addiu t3, t3, -1
80617120  316b0fff   andi t3, t3, RING_MASK           # free space
80617124  0171582b   sltu t3, t3, s1
80617128  1560000e   bnez t3, lm_putbuf_pump
8061712c  00000000   nop
80617130  8f0a2634   lw   t2, %lo(XMTDATA)(t8)
                   lm_putbuf_loop:
                   # Copy it in: store at head + 1, move on.
80617134  12200009   beqz s1, lm_putbuf_done
80617138  00000000   nop
8061713c  25080001   addiu t0, t0, 1
80617140  31080fff   andi t0, t0, RING_MASK
80617144  920b0000   lbu  t3, 0(s0)
80617148  01486021   addu t4, t2, t0
8061714c  a18b0000   sb   t3, 0(t4)
80617150  26100001   addiu s0, s0, 1
80617154  1000fff7   b    lm_putbuf_loop
80617158  2631ffff   addiu s1, s1, -1
                   lm_putbuf_done:
8061715c  af082644   sw   t0, %lo(XMTHEAD)(t8)
80617160  00009021   move s2, zero                    # 0: all of it queued
                   lm_putbuf_pump:
                   # Send what can go now (and pass on what was waiting), then unmask the interrupt.
80617164  0c185bdb   jal  pm_pump
80617168  00000000   nop
8061716c  0c183e69   jal  lm_unlock
80617170  00000000   nop
80617174  02401021   move v0, s2
80617178  8fb00018   lw   s0, 24(sp)
8061717c  8fb10014   lw   s1, 20(sp)
80617180  8fb20010   lw   s2, 16(sp)
80617184  8fbf001c   lw   ra, 28(sp)
80617188  03e00008   jr   ra
8061718c  27bd0020   addiu sp, sp, 32
                   .endfunc

                   # getbuf_modem(a0 = buf, a1 = max) -> bytes copied
                   # ---- lm_getbuf: 168 bytes at 0x8060f6f4 (in putchar_modem)
                   .func lm_getbuf

8060f6f4  27bdffe0   addiu sp, sp, -32
8060f6f8  afbf001c   sw   ra, 28(sp)
8060f6fc  afb00018   sw   s0, 24(sp)
8060f700  afb10014   sw   s1, 20(sp)
8060f704  afb20010   sw   s2, 16(sp)
8060f708  00808021   move s0, a0
8060f70c  00a08821   move s1, a1
8060f710  00009021   move s2, zero
8060f714  0c185c34   jal  lm_lock
8060f718  00000000   nop
                   # A pump first, so bytes waiting in the bridge reach the ring; then copy out up to max bytes,
                   # oldest first, with the interrupt masked so the ring holds still.
8060f71c  0c185bdb   jal  pm_pump
8060f720  00000000   nop
8060f724  3c188000   lui  t8, %hi(RCVHEAD)
8060f728  8f082640   lw   t0, %lo(RCVTAIL)(t8)
8060f72c  8f0a263c   lw   t2, %lo(RCVHEAD)(t8)
8060f730  8f0b2630   lw   t3, %lo(RCVDATA)(t8)
                   lm_getbuf_loop:
8060f734  1251000b   beq  s2, s1, lm_getbuf_end
8060f738  00000000   nop
8060f73c  110a0009   beq  t0, t2, lm_getbuf_end
8060f740  00000000   nop
8060f744  25080001   addiu t0, t0, 1
8060f748  31080fff   andi t0, t0, RING_MASK
8060f74c  01686021   addu t4, t3, t0
8060f750  918c0000   lbu  t4, 0(t4)
8060f754  02126821   addu t5, s0, s2
8060f758  a1ac0000   sb   t4, 0(t5)
8060f75c  1000fff5   b    lm_getbuf_loop
8060f760  26520001   addiu s2, s2, 1
                   lm_getbuf_end:
8060f764  af082640   sw   t0, %lo(RCVTAIL)(t8)
8060f768  12400003   beqz s2, lm_getbuf_unlock
8060f76c  00000000   nop
8060f770  0c185bdb   jal  pm_pump                     # refill the room we just made
8060f774  00000000   nop
                   lm_getbuf_unlock:
8060f778  0c183e69   jal  lm_unlock
8060f77c  00000000   nop
8060f780  02401021   move v0, s2
8060f784  8fb00018   lw   s0, 24(sp)
8060f788  8fb10014   lw   s1, 20(sp)
8060f78c  8fb20010   lw   s2, 16(sp)
8060f790  8fbf001c   lw   ra, 28(sp)
8060f794  03e00008   jr   ra
8060f798  27bd0020   addiu sp, sp, 32
                   .endfunc

                   # ModemFIFOCount() -> bytes waiting in the receive ring
                   # ---- lm_fifocount: 76 bytes at 0x80617858 (in FNibbleModeGetChar)
                   .func lm_fifocount

80617858  27bdffe8   addiu sp, sp, -24
8061785c  afbf0014   sw   ra, 20(sp)
80617860  afb00010   sw   s0, 16(sp)
80617864  0c185c34   jal  lm_lock
80617868  00000000   nop
                   # A pump first, so the count includes what the bridge was holding; then head - tail.
8061786c  0c185bdb   jal  pm_pump
80617870  00000000   nop
80617874  3c188000   lui  t8, %hi(RCVHEAD)
80617878  8f08263c   lw   t0, %lo(RCVHEAD)(t8)
8061787c  8f092640   lw   t1, %lo(RCVTAIL)(t8)
80617880  01098023   subu s0, t0, t1
80617884  32100fff   andi s0, s0, RING_MASK
80617888  0c183e69   jal  lm_unlock
8061788c  00000000   nop
80617890  02001021   move v0, s0
80617894  8fb00010   lw   s0, 16(sp)
80617898  8fbf0014   lw   ra, 20(sp)
8061789c  03e00008   jr   ra
806178a0  27bd0018   addiu sp, sp, 24
                   .endfunc

                   # ModemGetCD() -> 1 if the bridge reports carrier (the status byte, fresh from a pump)
                   # ---- lm_getcd: 48 bytes at 0x80617198 (in FCloseDriver)
                   .func lm_getcd
80617198  27bdffe8   addiu sp, sp, -24
8061719c  afbf0014   sw   ra, 20(sp)
806171a0  0c185bdb   jal  pm_pump
806171a4  00000000   nop
                   # The pump leaves the bridge's last status byte in PM_VARS; bit 3 is carrier.
806171a8  3c08807b   la   t0, PM_VARS
806171ac  25080000
806171b0  8d080008   lw   t0, 8(t0)
806171b4  31080008   andi t0, t0, 0x8
806171b8  8fbf0014   lw   ra, 20(sp)
806171bc  0008102b   sltu v0, zero, t0
806171c0  03e00008   jr   ra
806171c4  27bd0018   addiu sp, sp, 24
                   .endfunc

                   # ModemSetDTR(a0 = on): MCR.DTR, and DTR_ON / DTR_OFF to the bridge
                   # ---- lm_setdtr: 44 bytes at 0x806178a4 (in FNibbleModeGetChar)
                   .func lm_setdtr
806178a4  3c098000   lui  t1, %hi(RCVHEAD)
                   # Keep DTR in the virtual MCR (bit 0), where ModemGetDTR and MCR reads find it, then send it
                   # to the bridge: DTR_ON or DTR_OFF. The bridge's modem hangs up when DTR drops.
806178a8  9128264e   lbu  t0, %lo(V_MCR)(t1)
806178ac  35080001   ori  t0, t0, 1
806178b0  14800002   bnez a0, lm_sd_on
806178b4  00000000   nop
806178b8  39080001   xori t0, t0, 1
                   lm_sd_on:
806178bc  a128264e   sb   t0, %lo(V_MCR)(t1)
806178c0  31080001   andi t0, t0, 1
806178c4  24040003   li   a0, 0x3
806178c8  08185e06   j    pm_cmd                      # DTR_ON (2) or DTR_OFF (3)
806178cc  00882023   subu a0, a0, t0                  # (delay slot) 3 - DTR
                   .endfunc

                   # ModemGetDTR() -> MCR.DTR
                   # ---- lm_getdtr: 16 bytes at 0x80617d88 (in FFwd_to_Rev_Trans)
                   .func lm_getdtr
80617d88  3c028000   lui  v0, %hi(RCVHEAD)
80617d8c  9042264e   lbu  v0, %lo(V_MCR)(v0)
80617d90  03e00008   jr   ra
80617d94  30420001   andi v0, v0, 1
                   .endfunc

                   # ReadModemReg(a0 = register address) -> value. A virtual 16550 for TellyScript's direct
                   # register access: RBR reads the receive ring, LSR/MSR reflect the link, IIR says nothing is
                   # pending, IER/LCR/MCR/SCR read back what was written.
                   # ---- lm_readreg: 244 bytes at 0x80617f9c (in FGetECPModeStatus)
                   .func lm_readreg
                   # The register number is address bits 2-4 (the 16550's registers sit a word apart): t0 = 0 RBR,
                   # 1 IER, 2 IIR, 3 LCR, 4 MCR, 5 LSR, 6 MSR, 7 SCR.
80617f9c  00044082   srl  t0, a0, 2
80617fa0  31080007   andi t0, t0, 7
80617fa4  2509fffb   addiu t1, t0, -5
80617fa8  2d290002   sltiu t1, t1, 2
80617fac  11200008   beqz t1, lm_rr_go                # LSR, MSR: a pump first, for a fresh status (TellyScript's
80617fb0  00000000   nop                              # firmware download polls LSR before InitModem has run)
80617fb4  27bdffe8   addiu sp, sp, -24
80617fb8  afbf0014   sw   ra, 20(sp)
80617fbc  0c185bdb   jal  pm_pump
80617fc0  afa80010   sw   t0, 16(sp)
80617fc4  8fa80010   lw   t0, 16(sp)
80617fc8  8fbf0014   lw   ra, 20(sp)
80617fcc  27bd0018   addiu sp, sp, 24
                   lm_rr_go:
80617fd0  3c0e8000   lui  t6, %hi(RCVHEAD)
                   # Register 0 is RBR unless LCR's DLAB bit is set (then it's the divisor latch, which reads 0).
80617fd4  1500000e   bnez t0, lm_rr_lsr
80617fd8  91c9264d   lbu  t1, %lo(V_LCR)(t6)
80617fdc  31290080   andi t1, t1, 0x80
80617fe0  15200029   bnez t1, lm_rr_ret               # DLAB: divisor latch reads as 0
80617fe4  00001021   move v0, zero
                   # RBR: one byte from the receive ring, through getbuf.
80617fe8  27bdffe8   addiu sp, sp, -24
80617fec  afbf0014   sw   ra, 20(sp)
80617ff0  a3a00010   sb   zero, 16(sp)
80617ff4  27a40010   addiu a0, sp, 16
80617ff8  0c183dbd   jal  lm_getbuf                   # RBR: next byte from the ring (0 if none)
80617ffc  24050001   li   a1, 1
80618000  93a20010   lbu  v0, 16(sp)
80618004  8fbf0014   lw   ra, 20(sp)
80618008  03e00008   jr   ra
8061800c  27bd0018   addiu sp, sp, 24
                   lm_rr_lsr:
                   # LSR (5) and MSR (6) are made from the bridge's last status byte, fresh from the pump above.
80618010  3c19807b   la   t9, PM_VARS
80618014  27390000
80618018  8f2b0008   lw   t3, 8(t9)         # t3: the last status byte
8061801c  240c0005   li   t4, 5
80618020  150c0008   bne  t0, t4, lm_rr_msr
80618024  316d0001   andi t5, t3, 0x1    # LSR: THR empty; data ready = bridge has data or ring not empty
80618028  8dcf263c   lw   t7, %lo(RCVHEAD)(t6)
8061802c  8dce2640   lw   t6, %lo(RCVTAIL)(t6)
80618030  01ee7826   xor  t7, t7, t6
80618034  000f782b   sltu t7, zero, t7
80618038  01af6825   or   t5, t5, t7
8061803c  03e00008   jr   ra
80618040  35a20060   ori  v0, t5, 0x60
                   lm_rr_msr:
80618044  240c0006   li   t4, 6
80618048  150c0005   bne  t0, t4, lm_rr_stored
8061804c  316d0008   andi t5, t3, 0x8
80618050  000d682b   sltu t5, zero, t5                # MSR: CTS, DSR, DCD = carrier
80618054  000d69c0   sll  t5, t5, 7
80618058  03e00008   jr   ra
8061805c  35a20030   ori  v0, t5, 0x30
                   lm_rr_stored:
                   # The rest read back what was written: REG_SLOTS maps each register to a byte of V_REGS (IER,
                   # LCR, MCR, SCR), f for none. IIR has none and reads 0xC1: FIFOs on, no interrupt pending.
80618060  3c0c3ff2   li   t4, REG_SLOTS
80618064  358c1f0f
80618068  00086880   sll  t5, t0, 2
8061806c  01ac6006   srlv t4, t4, t5
80618070  318c000f   andi t4, t4, 0xf
80618074  240d000f   li   t5, 0xf
80618078  118d0003   beq  t4, t5, lm_rr_ret           # IIR: FIFOs on, nothing pending
8061807c  240200c1   li   v0, 0xc1
80618080  01cc7021   addu t6, t6, t4
80618084  91c2264c   lbu  v0, %lo(V_REGS)(t6)
                   lm_rr_ret:
80618088  03e00008   jr   ra
8061808c  00000000   nop
                   .endfunc

                   # WriteModemReg(a0 = register address, a1 = value) on the virtual 16550: THR goes into the
                   # transmit ring, MCR.DTR becomes a DTR command to the bridge, enabling IER interrupts services the link.
                   # ---- lm_writereg: 148 bytes at 0x806174c4 (in FGetPrinterStatus)
                   .func lm_writereg
                   # t0 = the register number, as in ReadModemReg. THR (0, DLAB clear) is a byte to send, MCR is
                   # DTR, IER, LCR and SCR are stored, and the rest are ignored.
806174c4  00044082   srl  t0, a0, 2
806174c8  31080007   andi t0, t0, 7
806174cc  30a500ff   andi a1, a1, 0xff
806174d0  3c0e8000   lui  t6, %hi(RCVHEAD)
806174d4  2d0b0002   sltiu t3, t0, 2
806174d8  11600008   beqz t3, lm_wr_store
806174dc  91ca264d   lbu  t2, %lo(V_LCR)(t6)
806174e0  314a0080   andi t2, t2, 0x80
806174e4  1540001a   bnez t2, lm_wr_ret               # DLAB: divisor latch writes are ignored
806174e8  00000000   nop
806174ec  15000003   bnez t0, lm_wr_store
806174f0  00000000   nop
806174f4  08185cb3   j    lm_putchar                  # THR
806174f8  00a02021   move a0, a1
                   lm_wr_store:
806174fc  240c0004   li   t4, 4
80617500  150c0003   bne  t0, t4, lm_wr_reg
80617504  00000000   nop
80617508  08185e29   j    lm_setdtr                   # MCR (only DTR matters)
8061750c  30a40001   andi a0, a1, 1
                   lm_wr_reg:
80617510  3c0c3ff2   li   t4, REG_SLOTS
80617514  358c1f0f
80617518  00086880   sll  t5, t0, 2
8061751c  01ac6006   srlv t4, t4, t5
80617520  318c000f   andi t4, t4, 0xf
80617524  240d000f   li   t5, 0xf
80617528  118d0009   beq  t4, t5, lm_wr_ret           # FCR, LSR, MSR: ignored
8061752c  01cc6821   addu t5, t6, t4
80617530  a1a5264c   sb   a1, %lo(V_REGS)(t5)
                   # IER with the receive or transmit interrupt on: TellyScript is about to wait for the modem,
                   # so run the link now.
80617534  240c0001   li   t4, 1
80617538  150c0005   bne  t0, t4, lm_wr_ret
8061753c  30a50003   andi a1, a1, 3
80617540  10a00003   beqz a1, lm_wr_ret
80617544  00000000   nop
80617548  08185e16   j    lm_fifocount                # enabling RX/TX interrupts: service the link now
8061754c  00000000   nop
                   lm_wr_ret:
80617550  03e00008   jr   ra
80617554  00000000   nop
                   .endfunc

                   # signature, so tools can recognise a patched build
                   # ---- lm_signature: 8 bytes at 0x80617628 (in FWaitForPrinter)
                   .func lm_signature
80617628  4c505432   .word 0x4c505432                       # "LPT2"
8061762c  00000006   .word 0x6                  # the driver version
                   .endfunc

                   .equ CHARIOSEL, gCharIOSelect

                   # putchar(a0): also to the bridge's console channel while gCharIOSelect has 0x10 (LF -> LF CR,
                   # as the OS does for its serial ports)
```

## A.4 The reboot notice and the console hooks

Three wrappers that run their own few instructions, then the two the hook displaced, then jump back into the original function. `lm_reboot` tells the bridge the OS is restarting itself (no countdown next time). On a production build, `putchar` also copies to the console channel, and `SetCharIO` keeps that channel on.

```
                   # SafeReset(a0): send REBOOT first, then carry on into SafeReset
                   # ---- lm_reboot: 60 bytes at 0x8060f6ac (in ModemFIFOCount)
                   .func lm_reboot
8060f6ac  27bdffe8   addiu sp, sp, -24
8060f6b0  afbf0014   sw   ra, 20(sp)
8060f6b4  afa40010   sw   a0, 16(sp)
                   # The OS is about to reset itself. Tell the bridge (REBOOT), so it starts the OS again at once,
                   # with no countdown. a0, SafeReset's argument, is kept for the real SafeReset.
8060f6b8  3c08807b   la   t0, PM_VARS
8060f6bc  25080000
8060f6c0  ad000184   sw   zero, 388(t0)        # interrupts are off and nothing holds the port any more: clear the claim
8060f6c4  0c185e06   jal  pm_cmd                      # queue REBOOT and pump it out
8060f6c8  24040006   li   a0, 0x6
                   # Then SafeReset as it was: its two displaced instructions, and on into the rest of it.
8060f6cc  8fa40010   lw   a0, 16(sp)
8060f6d0  8fbf0014   lw   ra, 20(sp)
8060f6d4  27bd0018   addiu sp, sp, 24
8060f6d8  27bdffe8   .word 0x27bdffe8              # SafeReset's first two instructions, displaced by the hook
8060f6dc  afb00010   .word 0xafb00010
8060f6e0  08184a52   j    SafeReset + 8
8060f6e4  00000000   nop
                   .endfunc
                   # ---- lm_putchar_con: 92 bytes at 0x806171e0 (in FCheckBlink)
                   .func lm_putchar_con
806171e0  3c088000   lui  t0, %hi(CHARIOSEL)
806171e4  910859f1   lbu  t0, %lo(CHARIOSEL)(t0)
806171e8  31080010   andi t0, t0, 0x10
806171ec  1100000f   beqz t0, lm_pc_go
806171f0  00000000   nop
                   # Copy the character to the console channel; a LF gets a CR after it, as on the serial ports.
806171f4  27bdffe8   addiu sp, sp, -24
806171f8  afbf0014   sw   ra, 20(sp)
806171fc  afa40010   sw   a0, 16(sp)
80617200  0c185f46   jal  pm_conout
80617204  308400ff   andi a0, a0, 0xff
80617208  8fa40010   lw   a0, 16(sp)
8061720c  2408000a   li   t0, 10
80617210  14880003   bne  a0, t0, lm_pc_back
80617214  00000000   nop
80617218  0c185f46   jal  pm_conout
8061721c  2404000d   li   a0, 13
                   lm_pc_back:
80617220  8fa40010   lw   a0, 16(sp)
80617224  8fbf0014   lw   ra, 20(sp)
80617228  27bd0018   addiu sp, sp, 24
                   lm_pc_go:
                   # Then putchar as it was: its two displaced instructions, and on into the rest of it.
8061722c  3c028000   .word 0x3c028000              # putchar's first two instructions, displaced by the hook
80617230  904259f0   .word 0x904259f0
80617234  081cd2b9   j    putchar + 8
80617238  00000000   nop
                   .endfunc

                   # SetCharIO(a0 = flags): the console channel is always on
                   # ---- lm_setchario_con: 20 bytes at 0x8060f630 (in EnableModemInterrupts)
                   .func lm_setchario_con
8060f630  34840010   ori  a0, a0, 0x10
8060f634  27bdffe8   .word 0x27bdffe8            # SetCharIO's first two instructions, displaced by the hook
8060f638  308400ff   .word 0x308400ff
8060f63c  081cd2a2   j    SetCharIO + 8
8060f640  00000000   nop
                   .endfunc
```

## B.1 Stage 0

What the bridge types into a debug box with `sl` (123 words at 0xa0480000), then starts with `epc` and `g`. It turns interrupts off, enters a PARMOD session, reads the loader on the modem channel (a length, the words, their sum), answers 0x8a (LOADED) or 0x8b (bad sum), and jumps to it. Every wait gives up after 1 ms, because the bridge may still be the diagnostics dongle when it starts. The equates at the top are shared with the loader.

```
                   .equ SOLO, 0xa400                  # lui: SOLO registers (kseg1)
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
                   .equ P_DATA, 0x4200
                   .equ P_CTRL, 0x4204
                   .equ P_STAT, 0x4208
                   .equ P_CNFG, 0x420c
                   .equ P_IEN, 0x4220
                   .equ P_ENABLE, 0x422c
                   .equ C_STBN, 0x1
                   .equ C_AUTOFDN, 0x4
                   .equ C_DIROUT, 0x10
                   .equ C_IDLE, 0x1f
                   .equ C_FREE, C_IDLE - C_DIROUT     # idle with the data bus released
                   .equ S_BUSY, 0x1
                   .equ S_ACKN, 0x2
                   .equ S_FAULTN, 0x4
                   .equ S_PE, 0x10
                   .equ S_SEL, 0x8
                   .equ FB, 0xa0320000
                   .equ BACK, 0xa0280000
                   .equ FB_DMA, 0x80320000
                   .equ FB_SIZE, 0x72d80
                   .equ STRIDE, 1120
                   .equ SCR_W, 560
                   .equ SCR_H, 420
                   .equ STACK, 0xa0318000
                   .equ GLYPHS, 95


                   .equ LOADER, 0xa0300000

                   # Stage 0: typed in with sl through the debug monitor, so it is as small as it can be. It takes
                   # the port, opens a PARMOD session (retrying while the bridge is still the dongle), reads the
                   # loader on the modem channel as length:4, the words, their sum:4, and stores it at LOADER. A
                   # good sum: answer LOADED (0x8a) and jump to the loader. A bad one: BADSUM (0x8b), and the bridge
                   # sends it again. Registers kept across the subroutines: s0 where the next word goes, s1 bytes
                   # left, s2 the running sum, t7 the timeout.
                   # ---- s0_start: 492 bytes at 0xa0480000
                   .func s0_start
a0480000  40086000   mfc0 t0, 12
a0480004  2409fffe   li   t1, -2
a0480008  01094024   and  t0, t0, t1
a048000c  40886000   mtc0 t0, 12                      # interrupts off
a0480010  00000000   nop
a0480014  00000000   nop
a0480018  3c0f0001   li   t7, 83000                   # s0_x's timeout: 1 ms of Count
a048001c  35ef4438
a0480020  3c19a400   lui  t9, SOLO
a0480024  24080001   li   t0, 1
a0480028  af28422c   sw   t0, P_ENABLE(t9)            # the port on, software mode, its interrupts off
a048002c  af20420c   sw   zero, P_CNFG(t9)
a0480030  af204220   sw   zero, P_IEN(t9)
                   s0_enter:                          # the signature on CTRL_OUT, the version on CTRL_IN
a0480034  3c0b4c50   li   t3, 0x4c505432
a0480038  356b5432
a048003c  240c0004   li   t4, 4
                   s0_sig:
a0480040  240a001d   li   t2, 0x1d
a0480044  0c120053   jal  s0_x
a0480048  000b2e02   srl  a1, t3, 24
a048004c  1860fff9   blez v1, s0_enter                # not taken, or no answer (still the dongle): again
a0480050  000b5a00   sll  t3, t3, 8
a0480054  258cffff   addiu t4, t4, -1
a0480058  1580fff9   bnez t4, s0_sig
a048005c  240a0009   li   t2, 0x9                # (delay slot) set up the reply read for when the loop ends
a0480060  0c120053   jal  s0_x
a0480064  00000000   nop
a0480068  1860fff2   blez v1, s0_enter
a048006c  00000000   nop
                   # the loader: its length, then the words into LOADER, summing as they come
                   s0_image:
a0480070  0c120039   jal  s0_rx4
a0480074  00000000   nop
a0480078  00408821   move s1, v0                      # length in bytes
a048007c  3c10a030   la   s0, LOADER
a0480080  26100000
a0480084  00009021   move s2, zero                    # sum
                   s0_word:
a0480088  12200008   beqz s1, s0_check
a048008c  00000000   nop
a0480090  0c120039   jal  s0_rx4
a0480094  00000000   nop
a0480098  ae020000   sw   v0, 0(s0)
a048009c  02429021   addu s2, s2, v0
a04800a0  26100004   addiu s0, s0, 4
a04800a4  1000fff8   b    s0_word
a04800a8  2631fffc   addiu s1, s1, -4
                   s0_check:                          # the sender's sum against ours
a04800ac  0c120039   jal  s0_rx4
a04800b0  00000000   nop
a04800b4  14520007   bne  v0, s2, s0_bad
a04800b8  00000000   nop
a04800bc  0c120049   jal  s0_tx
a04800c0  2405008a   li   a1, 0x8a
a04800c4  3c08a030   la   t0, LOADER
a04800c8  25080000
a04800cc  01000008   jr   t0
a04800d0  00000000   nop
                   s0_bad:
a04800d4  0c120049   jal  s0_tx
a04800d8  2405008b   li   a1, 0x8b
a04800dc  1000ffe4   b    s0_image
a04800e0  00000000   nop

                   # s0_rx4() -> v0 = 4 bytes from MODEM_IN, big-endian (keeps s0-s3)
                   s0_rx4:
a04800e4  03e0a021   move s4, ra                      # no stack: the return address waits in s4 (s0_x doesn't touch it)
a04800e8  24150004   li   s5, 4
a04800ec  0000b021   move s6, zero
                   s0_rx_byte:
a04800f0  240a0003   li   t2, 0x3
a04800f4  0c120053   jal  s0_x
a04800f8  00000000   nop
a04800fc  1860fffc   blez v1, s0_rx_byte              # the status byte: nothing yet
a0480100  00000000   nop
a0480104  0016b200   sll  s6, s6, 8
a0480108  02c2b025   or   s6, s6, v0
a048010c  26b5ffff   addiu s5, s5, -1
a0480110  16a0fff7   bnez s5, s0_rx_byte
a0480114  00000000   nop
a0480118  02c01021   move v0, s6
a048011c  02800008   jr   s4
a0480120  00000000   nop

                   # s0_tx(a1 = byte): MODEM_OUT until taken, then the bus to all ones and released (parmod.js's
                   # pm_idle says why)
                   s0_tx:
a0480124  03e0a021   move s4, ra
                   s0_tx_again:
a0480128  240a0017   li   t2, 0x17
a048012c  0c120053   jal  s0_x
a0480130  00000000   nop
a0480134  1860fffc   blez v1, s0_tx_again
a0480138  240800ff   li   t0, 0xff
a048013c  af284200   sw   t0, P_DATA(t9)
a0480140  2408000f   li   t0, C_FREE
a0480144  02800008   jr   s4
a0480148  af284204   sw   t0, P_CTRL(t9)

                   # s0_x(t2 = code, a1 = byte for _OUT): one PARMOD transaction, giving up after t7 ticks for
                   # either half. -> v1 = Select (1 / 0), or -1 if the bridge didn't answer; v0 = DATA.
                   # Uses t0, t1, t5, t6, t9.
                   s0_x:
a048014c  3c19a400   lui  t9, SOLO
a0480150  400d4800   mfc0 t5, 9
                   s0_x_idle:                         # the last transaction is over once Busy is low
a0480154  8f284208   lw   t0, P_STAT(t9)
a0480158  31080001   andi t0, t0, S_BUSY
a048015c  11000007   beqz t0, s0_x_go
a0480160  400e4800   mfc0 t6, 9
a0480164  01cd7023   subu t6, t6, t5
a0480168  01cf702b   sltu t6, t6, t7
a048016c  15c0fff9   bnez t6, s0_x_idle
a0480170  00000000   nop
a0480174  10000011   b    s0_x_fail
a0480178  00000000   nop
                   s0_x_go:
a048017c  af2a4204   sw   t2, P_CTRL(t9)
a0480180  af254200   sw   a1, P_DATA(t9)              # harmless for an _IN code: DIR is in, so nothing is driven
a0480184  24090004   li   t1, 4
                   s0_x_settle:
a0480188  1520ffff   bnez t1, s0_x_settle             # the code settles on the cable
a048018c  2529ffff   addiu t1, t1, -1
a0480190  39480001   xori t0, t2, C_STBN
a0480194  af284204   sw   t0, P_CTRL(t9)              # nStrobe low
a0480198  400d4800   mfc0 t5, 9                       # wait for the answer: Busy high
                   s0_x_ack:
a048019c  8f284208   lw   t0, P_STAT(t9)
a04801a0  31090001   andi t1, t0, S_BUSY
a04801a4  1520000b   bnez t1, s0_x_got
a04801a8  400e4800   mfc0 t6, 9
a04801ac  01cd7023   subu t6, t6, t5
a04801b0  01cf702b   sltu t6, t6, t7
a04801b4  15c0fff9   bnez t6, s0_x_ack
a04801b8  00000000   nop
                   s0_x_fail:                         # no answer: let go of everything, v1 = -1
a04801bc  240800ff   li   t0, 0xff
a04801c0  af284200   sw   t0, P_DATA(t9)
a04801c4  2408000f   li   t0, C_FREE
a04801c8  af284204   sw   t0, P_CTRL(t9)              # nStrobe high, the bus released
a04801cc  03e00008   jr   ra
a04801d0  2403ffff   li   v1, -1
                   s0_x_got:
a04801d4  8f224200   lw   v0, P_DATA(t9)
a04801d8  af2a4204   sw   t2, P_CTRL(t9)              # nStrobe high: the bridge lets go, then drops Busy
a04801dc  304200ff   andi v0, v0, 0xff
a04801e0  31030008   andi v1, t0, S_SEL
a04801e4  03e00008   jr   ra
a04801e8  0003182b   sltu v1, zero, v1
                   .endfunc
```

## B.2 The loader

The bridge's own program in the box (`src/stockbox/loader.js`, 7,448 bytes at 0xa0300000, uncached). It owns the box from stage 0 (or the tier-3 stub) until `boot_ram`: it draws what the bridge tells it to, passes the IR receiver's runs on, and does memory and disk work for the bridge. Its protocol runs on PARMOD's modem channel: HELLO, FILL, TEXT, SYNC, RESET, READ, WRITE, CALL, TEXT2 (the boot ROM's fonts), VFILT (the OS's flicker filter), TARGET and COPY (a back buffer, so nothing shows half-drawn) in; replies, IR runs and faults out.

**Part 1: the command loop and the link.**

```
                   .equ SOLO, 0xa400                  # lui: SOLO registers (kseg1)
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
                   .equ P_DATA, 0x4200
                   .equ P_CTRL, 0x4204
                   .equ P_STAT, 0x4208
                   .equ P_CNFG, 0x420c
                   .equ P_IEN, 0x4220
                   .equ P_ENABLE, 0x422c
                   .equ C_STBN, 0x1
                   .equ C_AUTOFDN, 0x4
                   .equ C_DIROUT, 0x10
                   .equ C_IDLE, 0x1f
                   .equ C_FREE, C_IDLE - C_DIROUT     # idle with the data bus released
                   .equ S_BUSY, 0x1
                   .equ S_ACKN, 0x2
                   .equ S_FAULTN, 0x4
                   .equ S_PE, 0x10
                   .equ S_SEL, 0x8
                   .equ FB, 0xa0320000
                   .equ BACK, 0xa0280000
                   .equ FB_DMA, 0x80320000
                   .equ FB_SIZE, 0x72d80
                   .equ STRIDE, 1120
                   .equ SCR_W, 560
                   .equ SCR_H, 420
                   .equ STACK, 0xa0318000
                   .equ GLYPHS, 95


                   # ---------------------------------------------------------------- entry (must come first)

                   # ---- ldr_start: 1816 bytes at 0xa0300000
                   .func ldr_start
                   LOADER_START:
                   # We arrive from stage 0 or the tier-3 stub, uncached at LOADER_BASE. Take the CPU: interrupts
                   # off (Status.IE clear), our own stack, the link to the bridge, the screen and the IR receiver.
a0300000  40086000   mfc0 t0, 12
a0300004  2409fffe   li   t1, -2
a0300008  01094024   and  t0, t0, t1
a030000c  40886000   mtc0 t0, 12                      # interrupts off: the ROM's handlers stay out of our way
a0300010  00000000   nop
a0300014  00000000   nop
a0300018  3c1da032   la   sp, STACK
a030001c  27bd8000
a0300020  3c08a030   la   t0, V_FBT                   # drawing goes to the screen (the variables aren't sent: set them)
a0300024  25081b20
a0300028  3c09a032   la   t1, FB
a030002c  25290000
a0300030  ad090000   sw   t1, 0(t0)
a0300034  0c0c01c6   jal  link_init
a0300038  00000000   nop
a030003c  0c0c0284   jal  vid_init
a0300040  00000000   nop
a0300044  0c0c04fc   jal  ir_init
a0300048  00000000   nop
                   # The first screen, drawn before the bridge says anything: the whole screen navy, no text. The
                   # bridge reads the boot ROM's fonts first thing and draws its own screens in them; text here
                   # would be the 5x7 font, up until then.
a030004c  3c032e9e   li   v1, 0x2e9e2e74            # fill colour: the navy background
a0300050  34632e74
a0300054  00002021   move a0, zero
a0300058  00002821   move a1, zero
a030005c  24060230   li   a2, SCR_W
a0300060  0c0c02a6   jal  fill_rect
a0300064  240701a4   li   a3, SCR_H

                   # The command loop. Keep the IR receiver drained and send what it caught to the bridge, then look
                   # at nFault: the bridge pulls it low when it has bytes for us. Each command is one byte, its
                   # arguments follow (protocol.js has the layouts); s0 holds the command byte.
                   main:
a0300068  0c0c0512   jal  ir_poll
a030006c  00000000   nop
a0300070  0c0c0524   jal  ir_flush
a0300074  00000000   nop
a0300078  3c19a400   lui  t9, SOLO
a030007c  8f284208   lw   t0, P_STAT(t9)
a0300080  31080004   andi t0, t0, S_FAULTN
a0300084  1500fff8   bnez t0, main                    # nFault high: nothing from the bridge yet
a0300088  00000000   nop
a030008c  0c0c023c   jal  link_rx
a0300090  00000000   nop
a0300094  00408021   move s0, v0
a0300098  24080001   li   t0, 1
a030009c  1208001d   beq  s0, t0, cmd_hello
a03000a0  24080002   li   t0, 2
a03000a4  12080027   beq  s0, t0, cmd_fill
a03000a8  24080003   li   t0, 3
a03000ac  1208003c   beq  s0, t0, cmd_text
a03000b0  24080004   li   t0, 4
a03000b4  1208018f   beq  s0, t0, cmd_sync
a03000b8  24080005   li   t0, 5
a03000bc  1208017a   beq  s0, t0, cmd_reset
a03000c0  24080006   li   t0, 6
a03000c4  120800f9   beq  s0, t0, cmd_read
a03000c8  24080007   li   t0, 7
a03000cc  12080129   beq  s0, t0, cmd_write
a03000d0  24080008   li   t0, 8
a03000d4  12080153   beq  s0, t0, cmd_call
a03000d8  24080009   li   t0, 9
a03000dc  12080060   beq  s0, t0, cmd_text2
a03000e0  2408000a   li   t0, 10
a03000e4  12080085   beq  s0, t0, cmd_vfilt
a03000e8  2408000b   li   t0, 11
a03000ec  12080096   beq  s0, t0, cmd_target
a03000f0  2408000c   li   t0, 12
a03000f4  120800a2   beq  s0, t0, cmd_copy
a03000f8  00000000   nop
                   # not a command we know: answer ERR (0xee) and the byte, so the bridge can tell we lost step
a03000fc  0c0c0254   jal  link_tx
a0300100  240400ee   li   a0, 0xee
a0300104  0c0c0254   jal  link_tx
a0300108  02002021   move a0, s0
a030010c  1000ffd6   b    main
a0300110  00000000   nop

                   # HELLO: answer 0x81 'L' 'D' 'R' and our protocol version; the bridge checks it before it relies
                   # on READ, WRITE and CALL
                   cmd_hello:
a0300114  0c0c0254   jal  link_tx
a0300118  24040081   li   a0, 0x81
a030011c  0c0c0254   jal  link_tx
a0300120  2404004c   li   a0, 0x4c
a0300124  0c0c0254   jal  link_tx
a0300128  24040044   li   a0, 0x44
a030012c  0c0c0254   jal  link_tx
a0300130  24040052   li   a0, 0x52
a0300134  0c0c0254   jal  link_tx
a0300138  24040005   li   a0, 0x5
a030013c  1000ffca   b    main
a0300140  00000000   nop

                   # FILL x:2 y:2 w:2 h:2 colour:4 (s1-s5): a filled rectangle; no reply
                   cmd_fill:
a0300144  0c0c0271   jal  rx_n
a0300148  24040002   li   a0, 2
a030014c  00408821   move s1, v0
a0300150  0c0c0271   jal  rx_n
a0300154  24040002   li   a0, 2
a0300158  00409021   move s2, v0
a030015c  0c0c0271   jal  rx_n
a0300160  24040002   li   a0, 2
a0300164  00409821   move s3, v0
a0300168  0c0c0271   jal  rx_n
a030016c  24040002   li   a0, 2
a0300170  0040a021   move s4, v0
a0300174  0c0c0271   jal  rx_n
a0300178  24040004   li   a0, 4
a030017c  0040a821   move s5, v0
a0300180  02202021   move a0, s1
a0300184  02402821   move a1, s2
a0300188  02603021   move a2, s3
a030018c  02803821   move a3, s4
a0300190  0c0c02a6   jal  fill_rect
a0300194  02a01821   move v1, s5
a0300198  1000ffb3   b    main
a030019c  00000000   nop

                   # TEXT x:2 y:2 scale:1 fg:4 bg:4 count:1, then the characters: s1 x, s2 y, s3 scale, s4 fg,
                   # s5 bg, s6 count. The characters go to TEXTBUF first (s0 counts them), then draw_text; no reply.
                   cmd_text:
a03001a0  0c0c0271   jal  rx_n
a03001a4  24040002   li   a0, 2
a03001a8  00408821   move s1, v0
a03001ac  0c0c0271   jal  rx_n
a03001b0  24040002   li   a0, 2
a03001b4  00409021   move s2, v0
a03001b8  0c0c023c   jal  link_rx
a03001bc  00000000   nop
a03001c0  00409821   move s3, v0
a03001c4  0c0c0271   jal  rx_n
a03001c8  24040004   li   a0, 4
a03001cc  0040a021   move s4, v0
a03001d0  0c0c0271   jal  rx_n
a03001d4  24040004   li   a0, 4
a03001d8  0040a821   move s5, v0
a03001dc  0c0c023c   jal  link_rx
a03001e0  00000000   nop
a03001e4  0040b021   move s6, v0
a03001e8  3c17a030   la   s7, TEXTBUF
a03001ec  26f71a10
a03001f0  00008021   move s0, zero
                   cmd_text_char:
a03001f4  12160008   beq  s0, s6, cmd_text_draw
a03001f8  00000000   nop
a03001fc  0c0c023c   jal  link_rx
a0300200  00000000   nop
a0300204  00404021   move t0, v0
a0300208  02f04821   addu t1, s7, s0
a030020c  a1280000   sb   t0, 0(t1)
a0300210  1000fff8   b    cmd_text_char
a0300214  26100001   addiu s0, s0, 1
                   cmd_text_draw:
                   # clamp the scale to 1..4 (0 becomes 1, anything over 4 becomes 4), then set V_SCALE for draw_text
a0300218  16600002   bnez s3, cmd_text_s1
a030021c  2e680005   sltiu t0, s3, 5
a0300220  24130001   li   s3, 1
                   cmd_text_s1:
a0300224  15000002   bnez t0, cmd_text_s2
a0300228  00000000   nop
a030022c  24130004   li   s3, 4
                   cmd_text_s2:
a0300230  3c08a030   la   t0, V_SCALE
a0300234  25081a04
a0300238  ad130000   sw   s3, 0(t0)
a030023c  ad140004   sw   s4, 4(t0)
a0300240  ad150008   sw   s5, 8(t0)
a0300244  02202021   move a0, s1
a0300248  02402821   move a1, s2
a030024c  02e03021   move a2, s7
a0300250  0c0c02d6   jal  draw_text
a0300254  02c03821   move a3, s6
a0300258  1000ff83   b    main
a030025c  00000000   nop

                   # TEXT2 strike:4 x:2 y:2 fg:4 count:1, then the characters: text in one of the boot ROM's own
                   # font strikes (strike.js has the format; the bridge finds them in the ROM filesystem), drawn
                   # at the screen's own resolution with each glyph's 4-bit coverage blended from what is already
                   # there towards fg. x is the pen, y the baseline. No reply. s1 strike, s2 x, s3 y, s4 fg, s6 count.
                   cmd_text2:
a0300260  0c0c0271   jal  rx_n
a0300264  24040004   li   a0, 4
a0300268  00408821   move s1, v0
a030026c  0c0c0271   jal  rx_n
a0300270  24040002   li   a0, 2
a0300274  00409021   move s2, v0
a0300278  0c0c0271   jal  rx_n
a030027c  24040002   li   a0, 2
a0300280  00409821   move s3, v0
a0300284  0c0c0271   jal  rx_n
a0300288  24040004   li   a0, 4
a030028c  0040a021   move s4, v0
a0300290  0c0c023c   jal  link_rx
a0300294  00000000   nop
a0300298  0040b021   move s6, v0
a030029c  3c17a030   la   s7, TEXTBUF
a03002a0  26f71a10
a03002a4  00008021   move s0, zero
                   cmd_text2_char:
a03002a8  12160008   beq  s0, s6, cmd_text2_draw
a03002ac  00000000   nop
a03002b0  0c0c023c   jal  link_rx
a03002b4  00000000   nop
a03002b8  00404021   move t0, v0
a03002bc  02f04821   addu t1, s7, s0
a03002c0  a1280000   sb   t0, 0(t1)
a03002c4  1000fff8   b    cmd_text2_char
a03002c8  26100001   addiu s0, s0, 1
                   cmd_text2_draw:
a03002cc  3c08a030   la   t0, V_T2
a03002d0  25081b10
a03002d4  ad170000   sw   s7, 0(t0)                   # the characters
a03002d8  ad160004   sw   s6, 4(t0)                   # how many
a03002dc  3c082000   lui  t0, 0x2000
a03002e0  02282025   or   a0, s1, t0                  # the strike, read uncached (kseg1)
a03002e4  02402821   move a1, s2
a03002e8  02603021   move a2, s3
a03002ec  0c0c0337   jal  draw_strike
a03002f0  02803821   move a3, s4
a03002f4  1000ff5c   b    main
a03002f8  00000000   nop

                   # VFILT x:2 y:2 w:2 h:2: the OS's vertical flicker filter over a rectangle, in place; no reply
                   cmd_vfilt:
a03002fc  0c0c0271   jal  rx_n
a0300300  24040002   li   a0, 2
a0300304  00408821   move s1, v0
a0300308  0c0c0271   jal  rx_n
a030030c  24040002   li   a0, 2
a0300310  00409021   move s2, v0
a0300314  0c0c0271   jal  rx_n
a0300318  24040002   li   a0, 2
a030031c  00409821   move s3, v0
a0300320  0c0c0271   jal  rx_n
a0300324  24040002   li   a0, 2
a0300328  0040a021   move s4, v0
a030032c  02202021   move a0, s1
a0300330  02402821   move a1, s2
a0300334  02603021   move a2, s3
a0300338  0c0c03ea   jal  vfilt
a030033c  02803821   move a3, s4
a0300340  1000ff49   b    main
a0300344  00000000   nop

                   # TARGET which:1: FILL, TEXT, TEXT2 and VFILT draw on the screen (0) or the back buffer (1); no reply
                   cmd_target:
a0300348  0c0c023c   jal  link_rx
a030034c  00000000   nop
a0300350  00408821   move s1, v0
a0300354  3c08a032   la   t0, FB
a0300358  25080000
a030035c  12200003   beqz s1, cmd_target_set
a0300360  00000000   nop
a0300364  3c08a028   la   t0, BACK
a0300368  25080000
                   cmd_target_set:
a030036c  3c09a030   la   t1, V_FBT
a0300370  25291b20
a0300374  ad280000   sw   t0, 0(t1)
a0300378  1000ff3b   b    main
a030037c  00000000   nop

                   # COPY dir:1 x:2 y:2 w:2 h:2: a rectangle from the back buffer to the screen (dir 0) or from the
                   # screen to the back buffer (1), the same place in each; x and w widened to pixel pairs, clipped
                   # to the screen; no reply
                   cmd_copy:
a0300380  0c0c023c   jal  link_rx
a0300384  00000000   nop
a0300388  0040a821   move s5, v0
a030038c  0c0c0271   jal  rx_n
a0300390  24040002   li   a0, 2
a0300394  00408821   move s1, v0
a0300398  0c0c0271   jal  rx_n
a030039c  24040002   li   a0, 2
a03003a0  00409021   move s2, v0
a03003a4  0c0c0271   jal  rx_n
a03003a8  24040002   li   a0, 2
a03003ac  00409821   move s3, v0
a03003b0  0c0c0271   jal  rx_n
a03003b4  24040002   li   a0, 2
a03003b8  0040a021   move s4, v0
a03003bc  2e280230   sltiu t0, s1, SCR_W
a03003c0  1100ff29   beqz t0, main
a03003c4  2e4801a4   sltiu t0, s2, SCR_H
a03003c8  1100ff27   beqz t0, main
a03003cc  32280001   andi t0, s1, 1                   # (delay slot) widen to pixel pairs
a03003d0  02288823   subu s1, s1, t0
a03003d4  02689821   addu s3, s3, t0
a03003d8  26730001   addiu s3, s3, 1
a03003dc  00139842   srl  s3, s3, 1                   # words a row
a03003e0  00134040   sll  t0, s3, 1
a03003e4  02284021   addu t0, s1, t0                  # clip the right
a03003e8  2d090231   sltiu t1, t0, SCR_W + 1
a03003ec  15200004   bnez t1, cmd_copy_w
a03003f0  00000000   nop
a03003f4  24130230   li   s3, SCR_W
a03003f8  02719823   subu s3, s3, s1
a03003fc  00139842   srl  s3, s3, 1
                   cmd_copy_w:
a0300400  02544021   addu t0, s2, s4                  # clip the bottom
a0300404  2d0901a5   sltiu t1, t0, SCR_H + 1
a0300408  15200003   bnez t1, cmd_copy_h
a030040c  00000000   nop
a0300410  241401a4   li   s4, SCR_H
a0300414  0292a023   subu s4, s4, s2
                   cmd_copy_h:
a0300418  00124280   sll  t0, s2, 10                  # offset = y * 1120 + x * 2
a030041c  00124980   sll  t1, s2, 6
a0300420  01094021   addu t0, t0, t1
a0300424  00124940   sll  t1, s2, 5
a0300428  01094021   addu t0, t0, t1
a030042c  00114840   sll  t1, s1, 1
a0300430  01094021   addu t0, t0, t1
a0300434  3c16a028   la   s6, BACK
a0300438  26d60000
a030043c  02c8b021   addu s6, s6, t0                  # from
a0300440  3c17a032   la   s7, FB
a0300444  26f70000
a0300448  02e8b821   addu s7, s7, t0                  # to
a030044c  12a00004   beqz s5, cmd_copy_row
a0300450  00000000   nop
a0300454  02c04021   move t0, s6                      # dir 1: the other way
a0300458  02e0b021   move s6, s7
a030045c  0100b821   move s7, t0
                   cmd_copy_row:
a0300460  1280ff01   beqz s4, main
a0300464  00000000   nop
a0300468  0c0c0512   jal  ir_poll
a030046c  00000000   nop
a0300470  02c05021   move t2, s6
a0300474  02e05821   move t3, s7
a0300478  02606021   move t4, s3
                   cmd_copy_word:
a030047c  11800007   beqz t4, cmd_copy_next
a0300480  00000000   nop
a0300484  8d4d0000   lw   t5, 0(t2)
a0300488  254a0004   addiu t2, t2, 4
a030048c  ad6d0000   sw   t5, 0(t3)
a0300490  256b0004   addiu t3, t3, 4
a0300494  1000fff9   b    cmd_copy_word
a0300498  258cffff   addiu t4, t4, -1
                   cmd_copy_next:
a030049c  26d60460   addiu s6, s6, STRIDE
a03004a0  26f70460   addiu s7, s7, STRIDE
a03004a4  1000ffee   b    cmd_copy_row
a03004a8  2694ffff   addiu s4, s4, -1

                   # READ / WRITE addr:4 width:1 count:2: s1 address, s2 width (1, 2 or 4 bytes), s3 count; checked
                   # first against MEM_RANGES. READ answers DATA (0x92) count:2, then each item, most significant
                   # byte first; a bad request gets FAULT (0x9f) and the reason instead.
                   cmd_read:
a03004ac  0c0c0271   jal  rx_n
a03004b0  24040004   li   a0, 4
a03004b4  00408821   move s1, v0
a03004b8  0c0c023c   jal  link_rx
a03004bc  00000000   nop
a03004c0  00409021   move s2, v0
a03004c4  0c0c0271   jal  rx_n
a03004c8  24040002   li   a0, 2
a03004cc  00409821   move s3, v0
a03004d0  02202021   move a0, s1
a03004d4  02402821   move a1, s2
a03004d8  0c0c04db   jal  mem_check
a03004dc  02603021   move a2, s3
a03004e0  1440004a   bnez v0, cmd_fault
a03004e4  0040a021   move s4, v0                      # (delay slot) the reason, for cmd_fault
a03004e8  0c0c0254   jal  link_tx
a03004ec  24040092   li   a0, 0x92
a03004f0  0c0c0254   jal  link_tx
a03004f4  00132202   srl  a0, s3, 8
a03004f8  0c0c0254   jal  link_tx
a03004fc  326400ff   andi a0, s3, 0xff
                   cmd_read_item:
a0300500  1260fed9   beqz s3, main
a0300504  3268003f   andi t0, s3, 63                  # keep the IR receiver drained on long reads
a0300508  15000003   bnez t0, cmd_read_load
a030050c  00000000   nop
a0300510  0c0c0512   jal  ir_poll
a0300514  00000000   nop
                   cmd_read_load:
                   # one item of the given width -> s5, its size in bytes -> s6
a0300518  24080004   li   t0, 4
a030051c  12480009   beq  s2, t0, cmd_read_w
a0300520  24080002   li   t0, 2
a0300524  12480004   beq  s2, t0, cmd_read_h
a0300528  00000000   nop
a030052c  92350000   lbu  s5, 0(s1)
a0300530  10000006   b    cmd_read_send
a0300534  24160001   li   s6, 1
                   cmd_read_h:
a0300538  96350000   lhu  s5, 0(s1)
a030053c  10000003   b    cmd_read_send
a0300540  24160002   li   s6, 2
                   cmd_read_w:
a0300544  8e350000   lw   s5, 0(s1)
a0300548  24160004   li   s6, 4
                   cmd_read_send:                     # s6 bytes of s5, most significant first
a030054c  02368821   addu s1, s1, s6
                   cmd_read_byte:
a0300550  26d6ffff   addiu s6, s6, -1
a0300554  001640c0   sll  t0, s6, 3
a0300558  01152006   srlv a0, s5, t0
a030055c  0c0c0254   jal  link_tx
a0300560  308400ff   andi a0, a0, 0xff
a0300564  16c0fffa   bnez s6, cmd_read_byte
a0300568  00000000   nop
a030056c  1000ffe4   b    cmd_read_item
a0300570  2673ffff   addiu s3, s3, -1

                   # WRITE: the same header, then count items of width bytes each. Answers DONE (0x93), or FAULT
                   # and the reason once all the data has been read.
                   cmd_write:
a0300574  0c0c0271   jal  rx_n
a0300578  24040004   li   a0, 4
a030057c  00408821   move s1, v0
a0300580  0c0c023c   jal  link_rx
a0300584  00000000   nop
a0300588  00409021   move s2, v0
a030058c  0c0c0271   jal  rx_n
a0300590  24040002   li   a0, 2
a0300594  00409821   move s3, v0
a0300598  02202021   move a0, s1
a030059c  02402821   move a1, s2
a03005a0  0c0c04db   jal  mem_check
a03005a4  02603021   move a2, s3
a03005a8  0040a021   move s4, v0                      # bad: still read the data (to stay in step), store nothing
                   cmd_write_item:
a03005ac  12600011   beqz s3, cmd_write_end
a03005b0  00000000   nop
a03005b4  0c0c0271   jal  rx_n
a03005b8  02402021   move a0, s2                      # (delay slot) read one item of the width
a03005bc  1680000a   bnez s4, cmd_write_next          # a bad request: drop it
a03005c0  24080004   li   t0, 4
a03005c4  12480007   beq  s2, t0, cmd_write_w
a03005c8  24080002   li   t0, 2
a03005cc  12480003   beq  s2, t0, cmd_write_h
a03005d0  00000000   nop
a03005d4  10000004   b    cmd_write_next
a03005d8  a2220000   sb   v0, 0(s1)
                   cmd_write_h:
a03005dc  10000002   b    cmd_write_next
a03005e0  a6220000   sh   v0, 0(s1)
                   cmd_write_w:
a03005e4  ae220000   sw   v0, 0(s1)
                   cmd_write_next:
a03005e8  02328821   addu s1, s1, s2
a03005ec  1000ffef   b    cmd_write_item
a03005f0  2673ffff   addiu s3, s3, -1
                   cmd_write_end:
a03005f4  16800005   bnez s4, cmd_fault
a03005f8  00000000   nop
a03005fc  0c0c0254   jal  link_tx
a0300600  24040093   li   a0, 0x93
a0300604  1000fe98   b    main
a0300608  00000000   nop

                   cmd_fault:                         # FAULT (0x9f), then s4: why (1 out of range, 2 unaligned, 3 bad width)
a030060c  0c0c0254   jal  link_tx
a0300610  2404009f   li   a0, 0x9f
a0300614  0c0c0254   jal  link_tx
a0300618  02802021   move a0, s4
a030061c  1000fe92   b    main
a0300620  00000000   nop

                   # CALL addr:4 a0..a3: call it and answer with v0 (interrupts stay off; on our stack). s1 the
                   # address, s2-s5 the arguments. This is how the bridge runs disk_read, disk_write, sum_words
                   # and boot_ram, and the tier-3 updater. The answer is RET (0x94) and v0, most significant first.
                   cmd_call:
a0300624  0c0c0271   jal  rx_n
a0300628  24040004   li   a0, 4
a030062c  00408821   move s1, v0
a0300630  0c0c0271   jal  rx_n
a0300634  24040004   li   a0, 4
a0300638  00409021   move s2, v0
a030063c  0c0c0271   jal  rx_n
a0300640  24040004   li   a0, 4
a0300644  00409821   move s3, v0
a0300648  0c0c0271   jal  rx_n
a030064c  24040004   li   a0, 4
a0300650  0040a021   move s4, v0
a0300654  0c0c0271   jal  rx_n
a0300658  24040004   li   a0, 4
a030065c  0040a821   move s5, v0
a0300660  02402021   move a0, s2
a0300664  02602821   move a1, s3
a0300668  02803021   move a2, s4
a030066c  0220f809   jalr s1
a0300670  02a03821   move a3, s5
a0300674  00408821   move s1, v0
a0300678  0c0c0254   jal  link_tx
a030067c  24040094   li   a0, 0x94
a0300680  24120004   li   s2, 4
                   cmd_call_byte:
a0300684  2652ffff   addiu s2, s2, -1
a0300688  001240c0   sll  t0, s2, 3
a030068c  01112006   srlv a0, s1, t0
a0300690  0c0c0254   jal  link_tx
a0300694  308400ff   andi a0, a0, 0xff
a0300698  1640fffa   bnez s2, cmd_call_byte
a030069c  00000000   nop
a03006a0  1000fe71   b    main
a03006a4  00000000   nop

                   # RESET: a cold boot. Clear RAM (all but this code; a precaution, see buildZap) through kseg1,
                   # below the loader and then above it to the 8 MB top, then the boot ROM's own reset: 7 to
                   # BUS_RESETCAUSE. No reply: the box is gone a moment later.
                   cmd_reset:
a03006a8  3c08a000   lui  t0, 0xa000                  # RAM's start, uncached
a03006ac  3c09a030   la   t1, LOADER_START
a03006b0  25290000
                   cmd_reset_low:
a03006b4  ad000000   sw   zero, 0(t0)
a03006b8  25080004   addiu t0, t0, 4
a03006bc  1509fffd   bne  t0, t1, cmd_reset_low
a03006c0  00000000   nop
a03006c4  3c08a030   la   t0, LOADER_END
a03006c8  25081d2c
a03006cc  3c09a080   lui  t1, 0xa080                  # the end of 8 MB of RAM
                   cmd_reset_high:
a03006d0  ad000000   sw   zero, 0(t0)
a03006d4  25080004   addiu t0, t0, 4
a03006d8  1509fffd   bne  t0, t1, cmd_reset_high
a03006dc  00000000   nop
a03006e0  3c19a400   lui  t9, SOLO
a03006e4  24080007   li   t0, 7
a03006e8  af2800a8   sw   t0, 0xa8(t9)
                   cmd_reset_wait:
a03006ec  1000ffff   b    cmd_reset_wait
a03006f0  00000000   nop

                   # SYNC n: answer SYNC (0x84) n. The bridge uses it to know that everything it sent before has
                   # been done.
                   cmd_sync:
a03006f4  0c0c023c   jal  link_rx
a03006f8  00000000   nop
a03006fc  00408821   move s1, v0
a0300700  0c0c0254   jal  link_tx
a0300704  24040084   li   a0, 0x84
a0300708  0c0c0254   jal  link_tx
a030070c  02202021   move a0, s1
a0300710  1000fe55   b    main
a0300714  00000000   nop
                   .endfunc

                   # ---------------------------------------------------------------- link (PARMOD, polled)

                   # link_init(): software mode, no interrupts, the bus released, then a session: the signature on
                   # CTRL_OUT, the version on CTRL_IN. Each step gives up after 1 ms (the bridge may still be the
                   # dongle, whose Busy is only D1) and the whole entry starts again.
                   # ---- link_init: 472 bytes at 0xa0300718
                   .func link_init
                   # the port on, in software mode (CNFG 0: we drive every line ourselves), its interrupts off
a0300718  3c19a400   lui  t9, SOLO
a030071c  24080001   li   t0, 1
a0300720  af28422c   sw   t0, P_ENABLE(t9)
a0300724  af20420c   sw   zero, P_CNFG(t9)
a0300728  af204220   sw   zero, P_IEN(t9)
                   li_again:
                   # idle lines, then send the four signature bytes one CTRL_OUT transaction each; t3 holds what
                   # is left of the signature, top byte next, t4 counts the bytes
a030072c  2408000f   li   t0, C_FREE
a0300730  af284204   sw   t0, P_CTRL(t9)
a0300734  3c0b4c50   li   t3, 0x4c505432
a0300738  356b5432
a030073c  240c0004   li   t4, 4
                   li_byte:
a0300740  000b2e02   srl  a1, t3, 24
                   # a PARMOD transaction: wait until the last one is over (Busy low), put the code (and an _OUT
                   # byte) on the cable, strobe, wait for the bridge's answer (Busy high), read it, release nStrobe
a0300744  3c19a400   lui  t9, SOLO
a0300748  3c0f0001   li   t7, 83000                     # give up after this many Count ticks
a030074c  35ef4438
a0300750  400d4800   mfc0 t5, 9                       # the start time
                   xi0:
a0300754  8f284208   lw   t0, P_STAT(t9)
a0300758  31090001   andi t1, t0, S_BUSY
a030075c  11200008   beqz t1, xi0_ok
a0300760  00000000   nop
a0300764  400e4800   mfc0 t6, 9
a0300768  01cd7023   subu t6, t6, t5
a030076c  01cf702b   sltu t6, t6, t7
a0300770  15c0fff8   bnez t6, xi0
a0300774  00000000   nop
a0300778  1000004e   b    li_fail
a030077c  00000000   nop
                   xi0_ok:
a0300780  240a001d   li   t2, 0x1d
a0300784  af2a4204   sw   t2, P_CTRL(t9)              # the code on nSelectIn, nInit, nAutoFd; nStrobe still high
a0300788  af254200   sw   a1, P_DATA(t9)          # the byte for the bridge (DIR out in this code)
a030078c  24090008   li   t1, 8
                   xs0:
a0300790  1520ffff   bnez t1, xs0                  # the code settles on the cable
a0300794  2529ffff   addiu t1, t1, -1
a0300798  39490001   xori t1, t2, C_STBN
a030079c  af294204   sw   t1, P_CTRL(t9)              # nStrobe low
a03007a0  3c0f0001   li   t7, 83000                     # give up after this many Count ticks
a03007a4  35ef4438
a03007a8  400d4800   mfc0 t5, 9                       # the start time
                   xa0:
a03007ac  8f284208   lw   t0, P_STAT(t9)
a03007b0  31090001   andi t1, t0, S_BUSY
a03007b4  15200008   bnez t1, xa0_ok
a03007b8  00000000   nop
a03007bc  400e4800   mfc0 t6, 9
a03007c0  01cd7023   subu t6, t6, t5
a03007c4  01cf702b   sltu t6, t6, t7
a03007c8  15c0fff8   bnez t6, xa0
a03007cc  00000000   nop
a03007d0  10000038   b    li_fail
a03007d4  00000000   nop
                   xa0_ok:
a03007d8  8f224200   lw   v0, P_DATA(t9)
a03007dc  af2a4204   sw   t2, P_CTRL(t9)              # nStrobe high: the bridge lets go, then drops Busy
a03007e0  304200ff   andi v0, v0, 0xff
a03007e4  31080008   andi t0, t0, S_SEL
a03007e8  240900ff   li   t1, 0xff
a03007ec  af294200   sw   t1, P_DATA(t9)              # all ones before the next code (link_tx says why)
a03007f0  11000030   beqz t0, li_fail                 # not taken
a03007f4  000b5a00   sll  t3, t3, 8
a03007f8  258cffff   addiu t4, t4, -1
a03007fc  1580ffd0   bnez t4, li_byte
a0300800  00000000   nop
                   # all four taken: read the reply on CTRL_IN. A reply (Select high, the protocol version) means
                   # the bridge has opened a session for us
                   # a PARMOD transaction: wait until the last one is over (Busy low), put the code (and an _OUT
                   # byte) on the cable, strobe, wait for the bridge's answer (Busy high), read it, release nStrobe
a0300804  3c19a400   lui  t9, SOLO
a0300808  3c0f0001   li   t7, 83000                     # give up after this many Count ticks
a030080c  35ef4438
a0300810  400d4800   mfc0 t5, 9                       # the start time
                   xi1:
a0300814  8f284208   lw   t0, P_STAT(t9)
a0300818  31090001   andi t1, t0, S_BUSY
a030081c  11200008   beqz t1, xi1_ok
a0300820  00000000   nop
a0300824  400e4800   mfc0 t6, 9
a0300828  01cd7023   subu t6, t6, t5
a030082c  01cf702b   sltu t6, t6, t7
a0300830  15c0fff8   bnez t6, xi1
a0300834  00000000   nop
a0300838  1000001e   b    li_fail
a030083c  00000000   nop
                   xi1_ok:
a0300840  240a0009   li   t2, 0x9
a0300844  af2a4204   sw   t2, P_CTRL(t9)              # the code on nSelectIn, nInit, nAutoFd; nStrobe still high
a0300848  24090008   li   t1, 8
                   xs1:
a030084c  1520ffff   bnez t1, xs1                  # the code settles on the cable
a0300850  2529ffff   addiu t1, t1, -1
a0300854  39490001   xori t1, t2, C_STBN
a0300858  af294204   sw   t1, P_CTRL(t9)              # nStrobe low
a030085c  3c0f0001   li   t7, 83000                     # give up after this many Count ticks
a0300860  35ef4438
a0300864  400d4800   mfc0 t5, 9                       # the start time
                   xa1:
a0300868  8f284208   lw   t0, P_STAT(t9)
a030086c  31090001   andi t1, t0, S_BUSY
a0300870  15200008   bnez t1, xa1_ok
a0300874  00000000   nop
a0300878  400e4800   mfc0 t6, 9
a030087c  01cd7023   subu t6, t6, t5
a0300880  01cf702b   sltu t6, t6, t7
a0300884  15c0fff8   bnez t6, xa1
a0300888  00000000   nop
a030088c  10000009   b    li_fail
a0300890  00000000   nop
                   xa1_ok:
a0300894  8f224200   lw   v0, P_DATA(t9)
a0300898  af2a4204   sw   t2, P_CTRL(t9)              # nStrobe high: the bridge lets go, then drops Busy
a030089c  304200ff   andi v0, v0, 0xff
a03008a0  31080008   andi t0, t0, S_SEL
a03008a4  11000003   beqz t0, li_fail                 # no reply: no session
a03008a8  2408000f   li   t0, C_FREE
a03008ac  03e00008   jr   ra
a03008b0  af284204   sw   t0, P_CTRL(t9)
                   li_fail:
                   # no answer, or the bridge didn't take a byte: it may still be the diagnostics dongle (it switches
                   # to PARMOD at the end of the g line, or when test 19 boots the tier-3 area). Let the lines go,
                   # wait 1 ms and start over.
a03008b4  3c19a400   lui  t9, SOLO
a03008b8  240800ff   li   t0, 0xff
a03008bc  af284200   sw   t0, P_DATA(t9)
a03008c0  2408000f   li   t0, C_FREE
a03008c4  af284204   sw   t0, P_CTRL(t9)
a03008c8  3c0f0001   li   t7, 83000
a03008cc  35ef4438
a03008d0  400d4800   mfc0 t5, 9
                   li_pause:                          # 1 ms, then from the start
a03008d4  400e4800   mfc0 t6, 9
a03008d8  01cd7023   subu t6, t6, t5
a03008dc  01cf702b   sltu t6, t6, t7
a03008e0  15c0fffc   bnez t6, li_pause
a03008e4  00000000   nop
a03008e8  1000ff90   b    li_again
a03008ec  00000000   nop
                   .endfunc

                   # link_rx() -> v0 = byte: MODEM_IN until the bridge has one (Select high). Blocks: the loader has
                   # nothing else to do while a command is half read.
                   # ---- link_rx: 96 bytes at 0xa03008f0
                   .func link_rx
                   lr_again:
                   # a PARMOD transaction: wait until the last one is over (Busy low), put the code (and an _OUT
                   # byte) on the cable, strobe, wait for the bridge's answer (Busy high), read it, release nStrobe
a03008f0  3c19a400   lui  t9, SOLO
                   xi2:
a03008f4  8f284208   lw   t0, P_STAT(t9)
a03008f8  31090001   andi t1, t0, S_BUSY
a03008fc  1520fffd   bnez t1, xi2
a0300900  00000000   nop
a0300904  240a0003   li   t2, 0x3
a0300908  af2a4204   sw   t2, P_CTRL(t9)              # the code on nSelectIn, nInit, nAutoFd; nStrobe still high
a030090c  24090008   li   t1, 8
                   xs2:
a0300910  1520ffff   bnez t1, xs2                  # the code settles on the cable
a0300914  2529ffff   addiu t1, t1, -1
a0300918  39490001   xori t1, t2, C_STBN
a030091c  af294204   sw   t1, P_CTRL(t9)              # nStrobe low
                   xa2:
a0300920  8f284208   lw   t0, P_STAT(t9)
a0300924  31090001   andi t1, t0, S_BUSY
a0300928  1120fffd   beqz t1, xa2
a030092c  00000000   nop
a0300930  8f224200   lw   v0, P_DATA(t9)
a0300934  af2a4204   sw   t2, P_CTRL(t9)              # nStrobe high: the bridge lets go, then drops Busy
a0300938  304200ff   andi v0, v0, 0xff
a030093c  31080008   andi t0, t0, S_SEL
a0300940  1100ffeb   beqz t0, lr_again                # the status byte: nothing yet
a0300944  2408000f   li   t0, C_FREE
a0300948  03e00008   jr   ra
a030094c  af284204   sw   t0, P_CTRL(t9)
                   .endfunc

                   # link_tx(a0 = byte): MODEM_OUT until the bridge takes it (Select high). Keeps v0, v1. Then the
                   # bus to all ones before it's released (parmod.js's pm_idle says why).
                   # ---- link_tx: 116 bytes at 0xa0300950
                   .func link_tx
a0300950  00405821   move t3, v0                      # v0 survives (callers keep a result in it)
                   lt_again:
                   # a PARMOD transaction: wait until the last one is over (Busy low), put the code (and an _OUT
                   # byte) on the cable, strobe, wait for the bridge's answer (Busy high), read it, release nStrobe
a0300954  3c19a400   lui  t9, SOLO
                   xi3:
a0300958  8f284208   lw   t0, P_STAT(t9)
a030095c  31090001   andi t1, t0, S_BUSY
a0300960  1520fffd   bnez t1, xi3
a0300964  00000000   nop
a0300968  240a0017   li   t2, 0x17
a030096c  af2a4204   sw   t2, P_CTRL(t9)              # the code on nSelectIn, nInit, nAutoFd; nStrobe still high
a0300970  af244200   sw   a0, P_DATA(t9)          # the byte for the bridge (DIR out in this code)
a0300974  24090008   li   t1, 8
                   xs3:
a0300978  1520ffff   bnez t1, xs3                  # the code settles on the cable
a030097c  2529ffff   addiu t1, t1, -1
a0300980  39490001   xori t1, t2, C_STBN
a0300984  af294204   sw   t1, P_CTRL(t9)              # nStrobe low
                   xa3:
a0300988  8f284208   lw   t0, P_STAT(t9)
a030098c  31090001   andi t1, t0, S_BUSY
a0300990  1120fffd   beqz t1, xa3
a0300994  00000000   nop
a0300998  8f224200   lw   v0, P_DATA(t9)
a030099c  af2a4204   sw   t2, P_CTRL(t9)              # nStrobe high: the bridge lets go, then drops Busy
a03009a0  304200ff   andi v0, v0, 0xff
a03009a4  31080008   andi t0, t0, S_SEL
a03009a8  1100ffea   beqz t0, lt_again                # refused: its ring is full
a03009ac  01601021   move v0, t3
                   # taken: drive all ones, then release the bus and go idle
a03009b0  240800ff   li   t0, 0xff
a03009b4  af284200   sw   t0, P_DATA(t9)
a03009b8  2408000f   li   t0, C_FREE
a03009bc  03e00008   jr   ra
a03009c0  af284204   sw   t0, P_CTRL(t9)
                   .endfunc

                   # rx_n(a0 = count) -> v0 = that many bytes, big-endian
                   # ---- rx_n: 76 bytes at 0xa03009c4
                   .func rx_n
a03009c4  27bdfff0   addiu sp, sp, -16
a03009c8  afbf000c   sw   ra, 12(sp)
a03009cc  afb00000   sw   s0, 0(sp)
a03009d0  afb10004   sw   s1, 4(sp)
a03009d4  00808021   move s0, a0
a03009d8  00008821   move s1, zero
                   rx_n_loop:                         # s0 bytes left, s1 the value so far
a03009dc  0c0c023c   jal  link_rx
a03009e0  00000000   nop
a03009e4  00118a00   sll  s1, s1, 8
a03009e8  02228825   or   s1, s1, v0
a03009ec  2610ffff   addiu s0, s0, -1
a03009f0  1600fffa   bnez s0, rx_n_loop
a03009f4  00000000   nop
a03009f8  02201021   move v0, s1
a03009fc  8fb00000   lw   s0, 0(sp)
a0300a00  8fb10004   lw   s1, 4(sp)
a0300a04  8fbf000c   lw   ra, 12(sp)
a0300a08  03e00008   jr   ra
a0300a0c  27bd0010   addiu sp, sp, 16
                   .endfunc
```

**Part 2: video, the disk, memory checks, the IR receiver, I2C and the data.**

```
                   # ---------------------------------------------------------------- video

                   # vid_init(): the boot ROM ColorPage test's sequence, on our framebuffer. The vidUnit fetches
                   # FB by DMA (a kseg0 address) and the potUnit puts a 560 x 420 window of it on screen; the rest
                   # of the picture is the blank colour. The boot ROM programmed the SAA7187 encoder at cold boot;
                   # we only power the RF modulator and set its register 0x61.
                   # ---- vid_init: 136 bytes at 0xa0300a10
                   .func vid_init
a0300a10  27bdfff8   addiu sp, sp, -8
a0300a14  afbf0004   sw   ra, 4(sp)
a0300a18  3c19a400   lui  t9, SOLO
a0300a1c  3c18a401   lui  t8, SOLO_HI
a0300a20  3c088032   la   t0, FB_DMA                  # where the framebuffer DMA starts
a0300a24  25080000
a0300a28  af28300c   sw   t0, VID_NSTART(t9)
a0300a2c  3c080007   li   t0, FB_SIZE
a0300a30  35082d80
a0300a34  af283010   sw   t0, VID_NSIZE(t9)
a0300a38  24080230   li   t0, 0x230                   # 560 pixels
a0300a3c  af089090   sw   t0, POT_HSIZE(t8)
a0300a40  240801a4   li   t0, 0x1a4                   # 420 lines
a0300a44  af089084   sw   t0, POT_VSIZE(t8)
a0300a48  2408009f   li   t0, 0x9f                    # where the window starts: these centre it on the TV
a0300a4c  af08908c   sw   t0, POT_HSTART(t8)
a0300a50  24080045   li   t0, 0x45
a0300a54  af089080   sw   t0, POT_VSTART(t8)
a0300a58  2408001f   li   t0, 0x1f                    # framebuffer DMA on
a0300a5c  af283014   sw   t0, VID_DMACNTL(t9)
a0300a60  3c080010   li   t0, 0x108080                # black border: Y 0x10, Cb Cr 0x80 (this also ends the
a0300a64  35088080
a0300a68  af089088   sw   t0, POT_BLANK(t8)           # diagnostics' magenta, if the bridge hasn't already)
a0300a6c  24080941   li   t0, 0x941                   # on, framebuffer (not gfxUnit) source
a0300a70  af089094   sw   t0, POT_CNTL(t8)
a0300a74  24080001   li   t0, 1
a0300a78  af284118   sw   t0, DEV_GPIOEN_CLR(t9)      # RF modulator power on
a0300a7c  2404008c   li   a0, 0x8c                    # SAA7187: register 0x61 = 0x15
a0300a80  24050061   li   a1, 0x61
a0300a84  0c0c058e   jal  iic_write
a0300a88  24060015   li   a2, 0x15
a0300a8c  8fbf0004   lw   ra, 4(sp)
a0300a90  03e00008   jr   ra
a0300a94  27bd0008   addiu sp, sp, 8
                   .endfunc

                   # fill_rect(a0 = x, a1 = y, a2 = w, a3 = h, v1 = colour as a Y Cb Y Cr word); x and w are
                   # rounded to whole pixel pairs, and the rectangle is clipped to the screen. Polls the IR
                   # receiver every row (keeping its return address in t7).
                   # ---- fill_rect: 192 bytes at 0xa0300a98
                   .func fill_rect
a0300a98  03e07821   move t7, ra
                   # off screen altogether: nothing to do. Then clip w and h to the screen's right and bottom edges.
a0300a9c  2c880230   sltiu t0, a0, SCR_W
a0300aa0  1100002b   beqz t0, fill_rect_done
a0300aa4  2ca801a4   sltiu t0, a1, SCR_H
a0300aa8  11000029   beqz t0, fill_rect_done
a0300aac  24090230   li   t1, SCR_W
a0300ab0  01244823   subu t1, t1, a0
a0300ab4  0126402b   sltu t0, t1, a2
a0300ab8  11000002   beqz t0, fill_rect_cw
a0300abc  00000000   nop
a0300ac0  01203021   move a2, t1
                   fill_rect_cw:
a0300ac4  240901a4   li   t1, SCR_H
a0300ac8  01254823   subu t1, t1, a1
a0300acc  0127402b   sltu t0, t1, a3
a0300ad0  11000002   beqz t0, fill_rect_ch
a0300ad4  00000000   nop
a0300ad8  01203821   move a3, t1
                   fill_rect_ch:
                   # a 4:2:2 word is two pixels, so start on an even x and count pixel pairs, rounding up
a0300adc  30880001   andi t0, a0, 1
a0300ae0  00882023   subu a0, a0, t0
a0300ae4  00c83021   addu a2, a2, t0
a0300ae8  24c60001   addiu a2, a2, 1
a0300aec  00063042   srl  a2, a2, 1                   # pixel pairs
a0300af0  10c00017   beqz a2, fill_rect_done
a0300af4  00000000   nop
a0300af8  10e00015   beqz a3, fill_rect_done
a0300afc  00054280   sll  t0, a1, 10                  # t0 = FB + y * 1120 + x * 2: 1120 = 1024 + 64 + 32 bytes a line
a0300b00  00054980   sll  t1, a1, 6
a0300b04  01094021   addu t0, t0, t1
a0300b08  00054940   sll  t1, a1, 5
a0300b0c  01094021   addu t0, t0, t1
a0300b10  00044840   sll  t1, a0, 1
a0300b14  01094021   addu t0, t0, t1
a0300b18  3c09a030   la   t1, V_FBT
a0300b1c  25291b20
a0300b20  8d290000   lw   t1, 0(t1)              # the target: FB, or BACK after TARGET 1
a0300b24  01094021   addu t0, t0, t1
                   fill_rect_row:                     # a row: t2 walks it, t3 counts pixel pairs
a0300b28  0c0c0512   jal  ir_poll
a0300b2c  01005021   move t2, t0
a0300b30  00c05821   move t3, a2
                   fill_rect_col:
a0300b34  ad430000   sw   v1, 0(t2)
a0300b38  256bffff   addiu t3, t3, -1
a0300b3c  1560fffd   bnez t3, fill_rect_col
a0300b40  254a0004   addiu t2, t2, 4
a0300b44  24e7ffff   addiu a3, a3, -1
a0300b48  14e0fff7   bnez a3, fill_rect_row
a0300b4c  25080460   addiu t0, t0, STRIDE
                   fill_rect_done:
a0300b50  01e00008   jr   t7
a0300b54  00000000   nop
                   .endfunc

                   # draw_text(a0 = x, a1 = y, a2 = chars, a3 = count) in V_SCALE / V_FG / V_BG. A glyph pixel is
                   # 2 * scale pixels square (one 4:2:2 word wide, and 2 lines so the interlaced TV doesn't
                   # flicker), so a character cell is 12 x 16 at scale 1. Stops at the screen edge.
                   # ---- draw_text: 388 bytes at 0xa0300b58
                   .func draw_text
a0300b58  27bdffd8   addiu sp, sp, -40
a0300b5c  afbf0024   sw   ra, 36(sp)
a0300b60  afb00000   sw   s0, 0(sp)
a0300b64  afb10004   sw   s1, 4(sp)
a0300b68  afb20008   sw   s2, 8(sp)
a0300b6c  afb3000c   sw   s3, 12(sp)
a0300b70  afb40010   sw   s4, 16(sp)
a0300b74  afb50014   sw   s5, 20(sp)
a0300b78  afb60018   sw   s6, 24(sp)
a0300b7c  afb7001c   sw   s7, 28(sp)
                   # s0 x, s1 y, s2 the next character, s3 characters left, s4 scale, s5 fg, s6 bg, s7 glyph rows
a0300b80  3c08a030   la   t0, V_SCALE
a0300b84  25081a04
a0300b88  8d140000   lw   s4, 0(t0)
a0300b8c  8d150004   lw   s5, 4(t0)                   # fg
a0300b90  8d160008   lw   s6, 8(t0)                   # bg
a0300b94  2408fffe   li   t0, -2
a0300b98  00888024   and  s0, a0, t0                  # even x
a0300b9c  00a08821   move s1, a1
a0300ba0  00c09021   move s2, a2
a0300ba4  00e09821   move s3, a3
                   draw_text_char:
                   # stop when the characters run out, or when the next cell would not fit on the screen
a0300ba8  0c0c0512   jal  ir_poll
a0300bac  00000000   nop
a0300bb0  1260003f   beqz s3, draw_text_done
a0300bb4  001440c0   sll  t0, s4, 3                   # cell width 12 * scale
a0300bb8  00144880   sll  t1, s4, 2
a0300bbc  01094021   addu t0, t0, t1
a0300bc0  02084821   addu t1, s0, t0
a0300bc4  2d2a0231   sltiu t2, t1, SCR_W + 1
a0300bc8  11400039   beqz t2, draw_text_done
a0300bcc  00144900   sll  t1, s4, 4                   # cell height 16 * scale
a0300bd0  02294821   addu t1, s1, t1
a0300bd4  2d2a01a5   sltiu t2, t1, SCR_H + 1
a0300bd8  11400035   beqz t2, draw_text_done
a0300bdc  00000000   nop
                   # the glyph: 8 bytes a character from the space up; anything outside the font draws as '?'
a0300be0  92480000   lbu  t0, 0(s2)
a0300be4  2509ffe0   addiu t1, t0, -32
a0300be8  2d2a005f   sltiu t2, t1, GLYPHS
a0300bec  15400002   bnez t2, draw_text_known
a0300bf0  00000000   nop
a0300bf4  2409001f   li   t1, 31
                   draw_text_known:
a0300bf8  000948c0   sll  t1, t1, 3
a0300bfc  3c0aa030   la   t2, FONT
a0300c00  254a170c
a0300c04  0149b821   addu s7, t2, t1                  # glyph rows
a0300c08  00115a80   sll  t3, s1, 10                  # dest = FB + y * 1120 + x * 2
a0300c0c  00116180   sll  t4, s1, 6
a0300c10  016c5821   addu t3, t3, t4
a0300c14  00116140   sll  t4, s1, 5
a0300c18  016c5821   addu t3, t3, t4
a0300c1c  00106040   sll  t4, s0, 1
a0300c20  016c5821   addu t3, t3, t4
a0300c24  3c0ca030   la   t4, V_FBT
a0300c28  258c1b20
a0300c2c  8d8c0000   lw   t4, 0(t4)              # the target: FB, or BACK after TARGET 1
a0300c30  016c5821   addu t3, t3, t4
a0300c34  240c0008   li   t4, 8
                   # 8 glyph rows (t4). Each row byte has the 5 pixels in its top bits; it is drawn 2 * scale lines
                   # tall (t6), and each glyph pixel is scale words wide (a0), fg for a 1 and bg for a 0.
                   draw_text_row:
a0300c38  92ed0000   lbu  t5, 0(s7)
a0300c3c  00147040   sll  t6, s4, 1                   # 2 * scale lines a glyph row
                   draw_text_line:
a0300c40  01607821   move t7, t3
a0300c44  01a0c021   move t8, t5
a0300c48  24190006   li   t9, 6                       # 5 glyph columns and a blank one
                   draw_text_col:
a0300c4c  33020080   andi v0, t8, 0x80
a0300c50  10400002   beqz v0, draw_text_put
a0300c54  02c01821   move v1, s6                      # (delay slot) bg; overwritten with fg when the bit is set
a0300c58  02a01821   move v1, s5
                   draw_text_put:
a0300c5c  02802021   move a0, s4
                   draw_text_word:
a0300c60  ade30000   sw   v1, 0(t7)
a0300c64  2484ffff   addiu a0, a0, -1
a0300c68  1480fffd   bnez a0, draw_text_word
a0300c6c  25ef0004   addiu t7, t7, 4
a0300c70  2739ffff   addiu t9, t9, -1
a0300c74  1720fff5   bnez t9, draw_text_col
a0300c78  0018c040   sll  t8, t8, 1
a0300c7c  25ceffff   addiu t6, t6, -1
a0300c80  15c0ffef   bnez t6, draw_text_line
a0300c84  256b0460   addiu t3, t3, STRIDE
a0300c88  258cffff   addiu t4, t4, -1
a0300c8c  1580ffea   bnez t4, draw_text_row
a0300c90  26f70001   addiu s7, s7, 1
                   # the next cell: x += 12 * scale
a0300c94  001440c0   sll  t0, s4, 3
a0300c98  00144880   sll  t1, s4, 2
a0300c9c  01094021   addu t0, t0, t1
a0300ca0  02088021   addu s0, s0, t0
a0300ca4  26520001   addiu s2, s2, 1
a0300ca8  1000ffbf   b    draw_text_char
a0300cac  2673ffff   addiu s3, s3, -1
                   draw_text_done:
a0300cb0  8fb00000   lw   s0, 0(sp)
a0300cb4  8fb10004   lw   s1, 4(sp)
a0300cb8  8fb20008   lw   s2, 8(sp)
a0300cbc  8fb3000c   lw   s3, 12(sp)
a0300cc0  8fb40010   lw   s4, 16(sp)
a0300cc4  8fb50014   lw   s5, 20(sp)
a0300cc8  8fb60018   lw   s6, 24(sp)
a0300ccc  8fb7001c   lw   s7, 28(sp)
a0300cd0  8fbf0024   lw   ra, 36(sp)
a0300cd4  03e00008   jr   ra
a0300cd8  27bd0028   addiu sp, sp, 40
                   .endfunc

                   # draw_strike(a0 = strike (kseg1), a1 = pen x, a2 = baseline y, a3 = fg; V_T2 the characters
                   # and their count): each character's glyph from the strike (strike.js: the character entry, its
                   # metrics and its glyph), drawn by glyph_blit at (pen - left, baseline - top); the pen moves by
                   # the advance, kept in 1/16 px. Characters the strike lacks are skipped.
                   # ---- draw_strike: 340 bytes at 0xa0300cdc
                   .func draw_strike
a0300cdc  27bdffd8   addiu sp, sp, -40
a0300ce0  afbf0024   sw   ra, 36(sp)
a0300ce4  afb00000   sw   s0, 0(sp)
a0300ce8  afb10004   sw   s1, 4(sp)
a0300cec  afb20008   sw   s2, 8(sp)
a0300cf0  afb3000c   sw   s3, 12(sp)
a0300cf4  afb40010   sw   s4, 16(sp)
a0300cf8  afb50014   sw   s5, 20(sp)
a0300cfc  afb60018   sw   s6, 24(sp)
a0300d00  afb7001c   sw   s7, 28(sp)
                   # s0 strike, s1 pen (1/16 px), s2 baseline, s3 fg, s4 the next character, s5 characters left,
                   # s6 metrics table, s7 glyph table; V_T2+8 the bitmaps
a0300d04  00808021   move s0, a0
a0300d08  00058900   sll  s1, a1, 4
a0300d0c  00c09021   move s2, a2
a0300d10  00e09821   move s3, a3
a0300d14  3c08a030   la   t0, V_T2
a0300d18  25081b10
a0300d1c  8d140000   lw   s4, 0(t0)
a0300d20  8d150004   lw   s5, 4(t0)
a0300d24  9209081c   lbu  t1, 2076(s0)      # metrics count, big-endian halfword
a0300d28  920a081d   lbu  t2, 2077(s0)
a0300d2c  00094a00   sll  t1, t1, 8
a0300d30  012a4825   or   t1, t1, t2
a0300d34  920b0820   lbu  t3, 2080(s0)      # glyph count
a0300d38  26160824   addiu s6, s0, 2084
a0300d3c  00094880   sll  t1, t1, 2
a0300d40  02c9b821   addu s7, s6, t1
a0300d44  000b5880   sll  t3, t3, 2
a0300d48  02eb5821   addu t3, s7, t3
a0300d4c  ad0b0008   sw   t3, 8(t0)
                   draw_strike_char:
a0300d50  0c0c0512   jal  ir_poll
a0300d54  00000000   nop
a0300d58  12a0002a   beqz s5, draw_strike_done
a0300d5c  26b5ffff   addiu s5, s5, -1
a0300d60  92880000   lbu  t0, 0(s4)
a0300d64  26940001   addiu s4, s4, 1
a0300d68  2508ffe0   addiu t0, t0, -32                # the table starts at the space
a0300d6c  2d0900e0   sltiu t1, t0, 224
a0300d70  1120fff7   beqz t1, draw_strike_char
a0300d74  00084080   sll  t0, t0, 2
a0300d78  01104021   addu t0, t0, s0
a0300d7c  9109011c   lbu  t1, 284(t0)       # metrics index
a0300d80  910a011d   lbu  t2, 285(t0)       # glyph index (255: none)
a0300d84  240b00ff   li   t3, 0xff
a0300d88  114bfff1   beq  t2, t3, draw_strike_char
a0300d8c  00094880   sll  t1, t1, 2
a0300d90  02c94821   addu t1, s6, t1
a0300d94  812c0000   lb   t4, 0(t1)                   # advance, signed big-endian halfword
a0300d98  912d0001   lbu  t5, 1(t1)
a0300d9c  000c6200   sll  t4, t4, 8
a0300da0  018d6025   or   t4, t4, t5
a0300da4  812e0002   lb   t6, 2(t1)                   # left
a0300da8  812f0003   lb   t7, 3(t1)                   # top
a0300dac  000a5080   sll  t2, t2, 2
a0300db0  02ea5021   addu t2, s7, t2
a0300db4  91580000   lbu  t8, 0(t2)                   # bitmap offset, big-endian halfword
a0300db8  91590001   lbu  t9, 1(t2)
a0300dbc  0018c200   sll  t8, t8, 8
a0300dc0  0319c025   or   t8, t8, t9
a0300dc4  91450002   lbu  a1, 2(t2)
a0300dc8  30a5007f   andi a1, a1, 0x7f                # width
a0300dcc  91460003   lbu  a2, 3(t2)                   # height
a0300dd0  3c08a030   la   t0, V_T2
a0300dd4  25081b10
a0300dd8  8d090008   lw   t1, 8(t0)
a0300ddc  01382021   addu a0, t1, t8                  # the bitmap
a0300de0  024f4823   subu t1, s2, t7
a0300de4  ad09000c   sw   t1, 12(t0)                  # y = baseline - top
a0300de8  26280008   addiu t0, s1, 8
a0300dec  00084103   sra  t0, t0, 4
a0300df0  010e3823   subu a3, t0, t6                  # x = pen (rounded) - left
a0300df4  0c0c038c   jal  glyph_blit
a0300df8  022c8821   addu s1, s1, t4                  # (delay slot) the pen moves on
a0300dfc  1000ffd4   b    draw_strike_char
a0300e00  00000000   nop
                   draw_strike_done:
a0300e04  8fb00000   lw   s0, 0(sp)
a0300e08  8fb10004   lw   s1, 4(sp)
a0300e0c  8fb20008   lw   s2, 8(sp)
a0300e10  8fb3000c   lw   s3, 12(sp)
a0300e14  8fb40010   lw   s4, 16(sp)
a0300e18  8fb50014   lw   s5, 20(sp)
a0300e1c  8fb60018   lw   s6, 24(sp)
a0300e20  8fb7001c   lw   s7, 28(sp)
a0300e24  8fbf0024   lw   ra, 36(sp)
a0300e28  03e00008   jr   ra
a0300e2c  27bd0028   addiu sp, sp, 40
                   .endfunc

                   # glyph_blit(a0 = bitmap, a1 = width, a2 = height, a3 = x; V_T2+12 = y; s3 = fg): the glyph's
                   # nibbles decoded as the OS's DecompressGlyph does (strike.js: a nibble with bit 3 set is a run
                   # of (n & 3) + 2 pixels, all 15 if bit 2 else all 0; otherwise one pixel of 3-bit coverage,
                   # widened to (n << 1) | (n >> 2)), and each pixel's coverage a (0-15) blended into the screen:
                   # Y, and the pair's Cb and Cr, move from what is there towards fg by a * 17 / 256. Clipped to
                   # the screen. A leaf: t0-t9, v0, v1 only.
                   # ---- glyph_blit: 376 bytes at 0xa0300e30
                   .func glyph_blit
a0300e30  3c08a030   la   t0, V_T2
a0300e34  25081b10
a0300e38  8d03000c   lw   v1, 12(t0)                  # y
a0300e3c  0000c021   move t8, zero                    # 1: the low nibble of the byte at a0 is next
a0300e40  0000c821   move t9, zero                    # pixels left in a run
a0300e44  00007821   move t7, zero                    # the run's coverage
                   glyph_blit_row:
a0300e48  10c00055   beqz a2, glyph_blit_done
a0300e4c  00a07021   move t6, a1                      # (delay slot) columns left
a0300e50  00e06821   move t5, a3                      # x
                   glyph_blit_col:
a0300e54  11c0004f   beqz t6, glyph_blit_next_row
a0300e58  00000000   nop
a0300e5c  13200004   beqz t9, glyph_blit_nibble
a0300e60  00000000   nop
a0300e64  2739ffff   addiu t9, t9, -1
a0300e68  10000017   b    glyph_blit_have
a0300e6c  01e01021   move v0, t7
                   glyph_blit_nibble:
a0300e70  90880000   lbu  t0, 0(a0)
a0300e74  17000004   bnez t8, glyph_blit_low
a0300e78  00000000   nop
a0300e7c  00084102   srl  t0, t0, 4
a0300e80  10000004   b    glyph_blit_n
a0300e84  24180001   li   t8, 1
                   glyph_blit_low:
a0300e88  3108000f   andi t0, t0, 15
a0300e8c  24840001   addiu a0, a0, 1
a0300e90  0000c021   move t8, zero
                   glyph_blit_n:
a0300e94  31090008   andi t1, t0, 8
a0300e98  11200008   beqz t1, glyph_blit_px
a0300e9c  31090003   andi t1, t0, 3
a0300ea0  25390001   addiu t9, t1, 1                  # a run: this pixel and (n & 3) + 1 more
a0300ea4  31090004   andi t1, t0, 4
a0300ea8  11200002   beqz t1, glyph_blit_run
a0300eac  00007821   move t7, zero
a0300eb0  240f000f   li   t7, 15
                   glyph_blit_run:
a0300eb4  10000004   b    glyph_blit_have
a0300eb8  01e01021   move v0, t7
                   glyph_blit_px:
a0300ebc  00084840   sll  t1, t0, 1
a0300ec0  00085082   srl  t2, t0, 2
a0300ec4  012a1025   or   v0, t1, t2
                   glyph_blit_have:
a0300ec8  1040002f   beqz v0, glyph_blit_skip
a0300ecc  2da80230   sltiu t0, t5, SCR_W              # (delay slot) on the screen? (unsigned: negative is off)
a0300ed0  1100002d   beqz t0, glyph_blit_skip
a0300ed4  2c6801a4   sltiu t0, v1, SCR_H
a0300ed8  1100002b   beqz t0, glyph_blit_skip
a0300edc  00034280   sll  t0, v1, 10                  # (delay slot) the pair = FB + y * 1120 + (x & ~1) * 2
a0300ee0  00034980   sll  t1, v1, 6
a0300ee4  01094021   addu t0, t0, t1
a0300ee8  00034940   sll  t1, v1, 5
a0300eec  01094021   addu t0, t0, t1
a0300ef0  2409fffe   li   t1, -2
a0300ef4  01a94824   and  t1, t5, t1
a0300ef8  00094840   sll  t1, t1, 1
a0300efc  01094021   addu t0, t0, t1
a0300f00  3c09a030   la   t1, V_FBT
a0300f04  25291b20
a0300f08  8d290000   lw   t1, 0(t1)              # the target: FB, or BACK after TARGET 1
a0300f0c  01094021   addu t0, t0, t1                  # Y0 Cb Y1 Cr
a0300f10  00025100   sll  t2, v0, 4
a0300f14  01421021   addu v0, t2, v0                  # a * 17: 0-255
a0300f18  31a90001   andi t1, t5, 1
a0300f1c  00094840   sll  t1, t1, 1
a0300f20  01094821   addu t1, t0, t1                  # this pixel's Y
a0300f24  912a0000   lbu  t2, 0(t1)
a0300f28  00135e02   srl  t3, s3, 24
a0300f2c  016a5823   subu t3, t3, t2
a0300f30  01620018   mult t3, v0
a0300f34  00005812   mflo t3
a0300f38  000b5a03   sra  t3, t3, 8
a0300f3c  014b5021   addu t2, t2, t3
a0300f40  a12a0000   sb   t2, 0(t1)
a0300f44  910a0001   lbu  t2, 1(t0)                   # Cb
a0300f48  00135c02   srl  t3, s3, 16
a0300f4c  316b00ff   andi t3, t3, 0xff
a0300f50  016a5823   subu t3, t3, t2
a0300f54  01620018   mult t3, v0
a0300f58  00005812   mflo t3
a0300f5c  000b5a03   sra  t3, t3, 8
a0300f60  014b5021   addu t2, t2, t3
a0300f64  a10a0001   sb   t2, 1(t0)
a0300f68  910a0003   lbu  t2, 3(t0)                   # Cr
a0300f6c  326b00ff   andi t3, s3, 0xff
a0300f70  016a5823   subu t3, t3, t2
a0300f74  01620018   mult t3, v0
a0300f78  00005812   mflo t3
a0300f7c  000b5a03   sra  t3, t3, 8
a0300f80  014b5021   addu t2, t2, t3
a0300f84  a10a0003   sb   t2, 3(t0)
                   glyph_blit_skip:
a0300f88  25ad0001   addiu t5, t5, 1
a0300f8c  1000ffb1   b    glyph_blit_col
a0300f90  25ceffff   addiu t6, t6, -1
                   glyph_blit_next_row:
a0300f94  24630001   addiu v1, v1, 1
a0300f98  1000ffab   b    glyph_blit_row
a0300f9c  24c6ffff   addiu a2, a2, -1
                   glyph_blit_done:
a0300fa0  03e00008   jr   ra
a0300fa4  00000000   nop
                   .endfunc

                   # vfilt(a0 = x, a1 = y, a2 = w, a3 = h): the OS's vertical flicker filter (16406
                   # FilterBlitYUYVtoYUYV) over a rectangle, in place: every byte (Y, Cb, Y, Cr) becomes
                   # avg(avg(above, below), itself), avg(a, b) = ((a & 0xfe) >> 1) + ((b & 0xfe) >> 1) + (a & b & 1),
                   # done a word (two pixels) at a time with the OS's masks. Down each word column, keeping the
                   # row above as it was before filtering, so the result is the OS's, which filters from a copy.
                   # Rows above and below the rectangle are read as they are; off the screen, the row itself.
                   # x and w are widened to whole pixel pairs; clipped to the screen. A leaf: t0-t9, v0, v1, a0-a3.
                   # ---- vfilt: 324 bytes at 0xa0300fa8
                   .func vfilt
a0300fa8  2c880230   sltiu t0, a0, SCR_W
a0300fac  1100004d   beqz t0, vfilt_done
a0300fb0  2ca801a4   sltiu t0, a1, SCR_H
a0300fb4  1100004b   beqz t0, vfilt_done
a0300fb8  30880001   andi t0, a0, 1                   # (delay slot) widen to pixel pairs
a0300fbc  00882023   subu a0, a0, t0
a0300fc0  00c83021   addu a2, a2, t0
a0300fc4  24c60001   addiu a2, a2, 1
a0300fc8  00063042   srl  a2, a2, 1                   # words a row
a0300fcc  00a74021   addu t0, a1, a3                  # clip the bottom
a0300fd0  2d0901a5   sltiu t1, t0, SCR_H + 1
a0300fd4  15200003   bnez t1, vfilt_h_ok
a0300fd8  00000000   nop
a0300fdc  240701a4   li   a3, SCR_H
a0300fe0  00e53823   subu a3, a3, a1
                   vfilt_h_ok:
a0300fe4  00064040   sll  t0, a2, 1
a0300fe8  00884021   addu t0, a0, t0                  # clip the right
a0300fec  2d090231   sltiu t1, t0, SCR_W + 1
a0300ff0  15200004   bnez t1, vfilt_w_ok
a0300ff4  00000000   nop
a0300ff8  24060230   li   a2, SCR_W
a0300ffc  00c43023   subu a2, a2, a0
a0301000  00063042   srl  a2, a2, 1
                   vfilt_w_ok:
a0301004  3c18fefe   lui  t8, 0xfefe
a0301008  3718fefe   ori  t8, t8, 0xfefe
a030100c  3c190101   lui  t9, 0x0101
a0301010  37390101   ori  t9, t9, 0x0101
a0301014  00055280   sll  t2, a1, 10                  # the first word: FB + y * 1120 + x * 2
a0301018  00055980   sll  t3, a1, 6
a030101c  014b5021   addu t2, t2, t3
a0301020  00055940   sll  t3, a1, 5
a0301024  014b5021   addu t2, t2, t3
a0301028  00045840   sll  t3, a0, 1
a030102c  014b5021   addu t2, t2, t3
a0301030  3c0ba030   la   t3, V_FBT
a0301034  256b1b20
a0301038  8d6b0000   lw   t3, 0(t3)              # the target: FB, or BACK after TARGET 1
a030103c  014b5021   addu t2, t2, t3
                   vfilt_col:
a0301040  10c00028   beqz a2, vfilt_done
a0301044  01405821   move t3, t2                      # (delay slot) down this column
a0301048  8d6d0000   lw   t5, 0(t3)                   # the row itself
a030104c  01a06021   move t4, t5                      # the row above, as it was (the row itself at the top)
a0301050  10a00002   beqz a1, vfilt_rows
a0301054  00000000   nop
a0301058  8d6cfba0   lw   t4, -STRIDE(t3)
                   vfilt_rows:
a030105c  00e01821   move v1, a3                      # rows left
a0301060  00a07821   move t7, a1                      # this row's y
                   vfilt_row:
a0301064  1060001c   beqz v1, vfilt_next_col
a0301068  25e80001   addiu t0, t7, 1                  # (delay slot) the row below, or the row itself off the bottom
a030106c  2d0801a4   sltiu t0, t0, SCR_H
a0301070  11000002   beqz t0, vfilt_have_below
a0301074  01a07021   move t6, t5
a0301078  8d6e0460   lw   t6, STRIDE(t3)
                   vfilt_have_below:
a030107c  01984024   and  t0, t4, t8
a0301080  00084042   srl  t0, t0, 1
a0301084  01d84824   and  t1, t6, t8
a0301088  00094842   srl  t1, t1, 1
a030108c  01094021   addu t0, t0, t1
a0301090  018e4824   and  t1, t4, t6
a0301094  01394824   and  t1, t1, t9
a0301098  01091021   addu v0, t0, t1
a030109c  00584024   and  t0, v0, t8
a03010a0  00084042   srl  t0, t0, 1
a03010a4  01b84824   and  t1, t5, t8
a03010a8  00094842   srl  t1, t1, 1
a03010ac  01094021   addu t0, t0, t1
a03010b0  004d4824   and  t1, v0, t5
a03010b4  01394824   and  t1, t1, t9
a03010b8  01091021   addu v0, t0, t1
a03010bc  ad620000   sw   v0, 0(t3)
a03010c0  01a06021   move t4, t5                      # the next row's above: this row as it was
a03010c4  01c06821   move t5, t6
a03010c8  256b0460   addiu t3, t3, STRIDE
a03010cc  25ef0001   addiu t7, t7, 1
a03010d0  1000ffe4   b    vfilt_row
a03010d4  2463ffff   addiu v1, v1, -1
                   vfilt_next_col:
a03010d8  254a0004   addiu t2, t2, 4
a03010dc  1000ffd8   b    vfilt_col
a03010e0  24c6ffff   addiu a2, a2, -1
                   vfilt_done:
a03010e4  03e00008   jr   ra
a03010e8  00000000   nop
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
                   # ---- ata_wait: 116 bytes at 0xa03010ec
                   .func ata_wait
                   # poll the status register: busy -> keep waiting (up to 2 s); error -> the error register;
                   # DRQ (the drive wants or has data) or, when not asked for DRQ, simply not busy -> ready
a03010ec  400c4800   mfc0 t4, 9
a03010f0  3c0d09e4   li   t5, T_ATA
a03010f4  35adf580
                   ata_wait_poll:
a03010f8  3c19be40   lui  t9, ATA
a03010fc  8f28001c   lw   t0, ATA_CMD(t9)
a0301100  310800ff   andi t0, t0, 0xff
a0301104  31090080   andi t1, t0, 0x80
a0301108  15200007   bnez t1, ata_wait_time           # BSY
a030110c  31090001   andi t1, t0, 0x01
a0301110  1520000d   bnez t1, ata_wait_err            # ERR
a0301114  31090008   andi t1, t0, 0x08
a0301118  1520000f   bnez t1, ata_wait_ok             # DRQ
a030111c  00000000   nop
a0301120  1080000d   beqz a0, ata_wait_ok             # not waiting for DRQ: ready
a0301124  00000000   nop
                   ata_wait_time:
a0301128  40094800   mfc0 t1, 9
a030112c  00000000   nop
a0301130  012c4823   subu t1, t1, t4
a0301134  012d482b   sltu t1, t1, t5
a0301138  1520ffef   bnez t1, ata_wait_poll
a030113c  00000000   nop
a0301140  03e00008   jr   ra
a0301144  2402ffff   li   v0, -1
                   ata_wait_err:
a0301148  8f220004   lw   v0, ATA_FEAT(t9)
a030114c  304200ff   andi v0, v0, 0xff
a0301150  03e00008   jr   ra
a0301154  34420100   ori  v0, v0, 0x100
                   ata_wait_ok:
a0301158  03e00008   jr   ra
a030115c  00001021   move v0, zero
                   .endfunc

                   # ata_cmd(a0 = LBA, a1 = sectors 1..256, a2 = command) -> v0 = 0 issued, else as ata_wait
                   # ---- ata_cmd: 148 bytes at 0xa0301160
                   .func ata_cmd
a0301160  27bdffec   addiu sp, sp, -20
a0301164  afbf0010   sw   ra, 16(sp)
a0301168  afb00000   sw   s0, 0(sp)
a030116c  afb10004   sw   s1, 4(sp)
a0301170  afb20008   sw   s2, 8(sp)
                   # wait for the drive to be idle, then load the task file (LBA 28 split over four registers, the
                   # sector count) and write the command last, which starts it. s0 LBA, s1 count, s2 command.
a0301174  00808021   move s0, a0
a0301178  00a08821   move s1, a1
a030117c  00c09021   move s2, a2
a0301180  0c0c043b   jal  ata_wait
a0301184  00002021   move a0, zero
a0301188  14400014   bnez v0, ata_cmd_out
a030118c  3c19be80   lui  t9, ATA_CTL
a0301190  af200018   sw   zero, 0x18(t9)              # device control: interrupts on, no reset (as the ROM)
a0301194  3c19be40   lui  t9, ATA
a0301198  af200004   sw   zero, ATA_FEAT(t9)
a030119c  00104602   srl  t0, s0, 24
a03011a0  3108000f   andi t0, t0, 0x0f
a03011a4  350800e0   ori  t0, t0, 0xe0                # LBA, drive 0
a03011a8  af280018   sw   t0, ATA_DEV(t9)
a03011ac  322800ff   andi t0, s1, 0xff                # 256 -> 0
a03011b0  af280008   sw   t0, ATA_COUNT(t9)
a03011b4  320800ff   andi t0, s0, 0xff
a03011b8  af28000c   sw   t0, ATA_LBA0(t9)
a03011bc  00104202   srl  t0, s0, 8
a03011c0  310800ff   andi t0, t0, 0xff
a03011c4  af280010   sw   t0, ATA_LBA1(t9)
a03011c8  00104402   srl  t0, s0, 16
a03011cc  310800ff   andi t0, t0, 0xff
a03011d0  af280014   sw   t0, ATA_LBA2(t9)
a03011d4  af32001c   sw   s2, ATA_CMD(t9)
a03011d8  00001021   move v0, zero
                   ata_cmd_out:
a03011dc  8fb00000   lw   s0, 0(sp)
a03011e0  8fb10004   lw   s1, 4(sp)
a03011e4  8fb20008   lw   s2, 8(sp)
a03011e8  8fbf0010   lw   ra, 16(sp)
a03011ec  03e00008   jr   ra
a03011f0  27bd0014   addiu sp, sp, 20
                   .endfunc

                   # disk_read(a0 = LBA, a1 = sectors 1..256, a2 = RAM address) -> v0 = 0, or the error
                   # (ata_wait). Keeps the IR receiver drained between sectors.
                   # ---- disk_read: 132 bytes at 0xa03011f4
                   .func disk_read
a03011f4  27bdffec   addiu sp, sp, -20
a03011f8  afbf0010   sw   ra, 16(sp)
a03011fc  afb00000   sw   s0, 0(sp)
a0301200  afb10004   sw   s1, 4(sp)
a0301204  afb20008   sw   s2, 8(sp)
a0301208  00a08821   move s1, a1
a030120c  00c09021   move s2, a2
a0301210  0c0c0458   jal  ata_cmd
a0301214  24060020   li   a2, 0x20                    # READ SECTORS
a0301218  14400011   bnez v0, disk_read_out
a030121c  02208021   move s0, s1
                   disk_read_sector:                  # s0 sectors left, s2 where the next one goes
a0301220  0c0c043b   jal  ata_wait
a0301224  24040001   li   a0, 1                       # a sector is ready when DRQ is set
a0301228  1440000d   bnez v0, disk_read_out
a030122c  24090100   li   t1, 256
a0301230  3c19be40   lui  t9, ATA
                   disk_read_word:                    # 256 16-bit words a sector
a0301234  8f280000   lw   t0, ATA_DATA(t9)
a0301238  2529ffff   addiu t1, t1, -1
a030123c  a6480000   sh   t0, 0(s2)
a0301240  1520fffc   bnez t1, disk_read_word
a0301244  26520002   addiu s2, s2, 2
a0301248  0c0c0512   jal  ir_poll
a030124c  00000000   nop
a0301250  2610ffff   addiu s0, s0, -1
a0301254  1600fff2   bnez s0, disk_read_sector
a0301258  00000000   nop
a030125c  00001021   move v0, zero
                   disk_read_out:
a0301260  8fb00000   lw   s0, 0(sp)
a0301264  8fb10004   lw   s1, 4(sp)
a0301268  8fb20008   lw   s2, 8(sp)
a030126c  8fbf0010   lw   ra, 16(sp)
a0301270  03e00008   jr   ra
a0301274  27bd0014   addiu sp, sp, 20
                   .endfunc

                   # disk_write(a0 = LBA, a1 = sectors 1..256, a2 = RAM address) -> v0 = 0, or the error
                   # ---- disk_write: 136 bytes at 0xa0301278
                   .func disk_write
a0301278  27bdffec   addiu sp, sp, -20
a030127c  afbf0010   sw   ra, 16(sp)
a0301280  afb00000   sw   s0, 0(sp)
a0301284  afb10004   sw   s1, 4(sp)
a0301288  afb20008   sw   s2, 8(sp)
a030128c  00a08821   move s1, a1
a0301290  00c09021   move s2, a2
a0301294  0c0c0458   jal  ata_cmd
a0301298  24060030   li   a2, 0x30                    # WRITE SECTORS
a030129c  14400012   bnez v0, disk_write_out
a03012a0  02208021   move s0, s1
                   disk_write_sector:                 # s0 sectors left, s2 the next one's data
a03012a4  0c0c043b   jal  ata_wait
a03012a8  24040001   li   a0, 1                       # the drive is ready for a sector when DRQ is set
a03012ac  1440000e   bnez v0, disk_write_out
a03012b0  24090100   li   t1, 256
a03012b4  3c19be40   lui  t9, ATA
                   disk_write_word:
a03012b8  96480000   lhu  t0, 0(s2)
a03012bc  2529ffff   addiu t1, t1, -1
a03012c0  af280000   sw   t0, ATA_DATA(t9)
a03012c4  1520fffc   bnez t1, disk_write_word
a03012c8  26520002   addiu s2, s2, 2
a03012cc  0c0c0512   jal  ir_poll
a03012d0  00000000   nop
a03012d4  2610ffff   addiu s0, s0, -1
a03012d8  1600fff2   bnez s0, disk_write_sector
a03012dc  00000000   nop
a03012e0  0c0c043b   jal  ata_wait                    # the last sector written
a03012e4  00002021   move a0, zero
                   disk_write_out:
a03012e8  8fb00000   lw   s0, 0(sp)
a03012ec  8fb10004   lw   s1, 4(sp)
a03012f0  8fb20008   lw   s2, 8(sp)
a03012f4  8fbf0010   lw   ra, 16(sp)
a03012f8  03e00008   jr   ra
a03012fc  27bd0014   addiu sp, sp, 20
                   .endfunc

                   # sum_words(a0 = address, a1 = words, a2 = index to leave out, or -1) -> v0 = their 32-bit sum:
                   # the code checksum (index 2 left out) and the ROM filesystem's (none), as the boot ROM checks
                   # them before it boots an OS from RAM
                   # ---- sum_words: 80 bytes at 0xa0301300
                   .func sum_words
a0301300  00001021   move v0, zero
a0301304  00004821   move t1, zero
                   sum_words_next:
a0301308  1125000f   beq  t1, a1, sum_words_done
a030130c  00000000   nop
a0301310  11260002   beq  t1, a2, sum_words_skip
a0301314  8c880000   lw   t0, 0(a0)
a0301318  00481021   addu v0, v0, t0
                   sum_words_skip:
a030131c  24840004   addiu a0, a0, 4
a0301320  312affff   andi t2, t1, 0xffff
a0301324  1540fff8   bnez t2, sum_words_next          # every 64K words: drain the IR receiver
a0301328  25290001   addiu t1, t1, 1
a030132c  00405821   move t3, v0                      # ir_poll may change v0 and ra: keep them
a0301330  03e06021   move t4, ra
a0301334  0c0c0512   jal  ir_poll
a0301338  00000000   nop
a030133c  0180f821   move ra, t4
a0301340  1000fff1   b    sum_words_next
a0301344  01601021   move v0, t3
                   sum_words_done:
a0301348  03e00008   jr   ra
a030134c  00000000   nop
                   .endfunc

                   # boot_ram(a0 = OS base, a1 = size in bytes, a2 = where the boot ROM keeps them): store them
                   # where the boot ROM looks for an OS already in RAM, then its own reset (7 to BUS_RESETCAUSE).
                   # The ROM checks the image and starts it from RAM (WEBTV_LPT_BRIDGE.md §10.7). No return.
                   # ---- boot_ram: 28 bytes at 0xa0301350
                   .func boot_ram
a0301350  acc40000   sw   a0, 0(a2)                   # the base, then the size, as the ROM keeps them (0xa0000400 + 0x19c)
a0301354  acc50004   sw   a1, 4(a2)
a0301358  3c19a400   lui  t9, SOLO
a030135c  24080007   li   t0, 7
a0301360  af2800a8   sw   t0, 0xa8(t9)
                   boot_ram_wait:
a0301364  1000ffff   b    boot_ram_wait
a0301368  00000000   nop
                   .endfunc

                   # ---------------------------------------------------------------- memory access

                   # mem_check(a0 = address, a1 = width, a2 = count) -> v0 = 0 if [a0, a0 + width * count) lies
                   # inside one of MEM_RANGES and a0 is aligned to the width; else 1 out of range, 2 unaligned,
                   # 3 bad width (leaf)
                   # ---- mem_check: 132 bytes at 0xa030136c
                   .func mem_check
                   # the width must be 1, 2 or 4 (t1 = its log2), the address aligned to it, the range must not
                   # wrap past the top of the address space, and it must fit wholly inside one MEM_RANGES entry
a030136c  24020003   li   v0, 3
a0301370  24080001   li   t0, 1
a0301374  10a80007   beq  a1, t0, mem_check_w
a0301378  00004821   move t1, zero                    # t1 = log2(width)
a030137c  24080002   li   t0, 2
a0301380  10a80004   beq  a1, t0, mem_check_w
a0301384  24090001   li   t1, 1
a0301388  24080004   li   t0, 4
a030138c  14a80016   bne  a1, t0, mem_check_done
a0301390  24090002   li   t1, 2
                   mem_check_w:
a0301394  24020002   li   v0, 2
a0301398  24a8ffff   addiu t0, a1, -1
a030139c  00884024   and  t0, a0, t0
a03013a0  15000011   bnez t0, mem_check_done
a03013a4  01265004   sllv t2, a2, t1
a03013a8  008a5021   addu t2, a0, t2                  # end
a03013ac  24020001   li   v0, 1
a03013b0  0144402b   sltu t0, t2, a0
a03013b4  1500000c   bnez t0, mem_check_done          # wrapped around
a03013b8  3c0ba030   la   t3, MEM_RANGES
a03013bc  256b16dc
                   mem_check_range:
a03013c0  8d6c0000   lw   t4, 0(t3)                   # start
a03013c4  8d6d0004   lw   t5, 4(t3)                   # end
a03013c8  11a00007   beqz t5, mem_check_done          # end of the table
a03013cc  256b0008   addiu t3, t3, 8
a03013d0  008c402b   sltu t0, a0, t4
a03013d4  1500fffa   bnez t0, mem_check_range
a03013d8  01aa402b   sltu t0, t5, t2
a03013dc  1500fff8   bnez t0, mem_check_range
a03013e0  00000000   nop
a03013e4  00001021   move v0, zero
                   mem_check_done:
a03013e8  03e00008   jr   ra
a03013ec  00000000   nop
                   .endfunc

                   # ---------------------------------------------------------------- IR receiver

                   # ir_init(): as the OS's InitSoloIR: a 15 us sample interval from the bus clock the boot ROM
                   # measured (at 0x80000288, in Hz), reject interval 0xa, control 0x3083; empty ring
                   # ---- ir_init: 88 bytes at 0xa03013f0
                   .func ir_init
a03013f0  3c088000   lui  t0, 0x8000
a03013f4  8d080288   lw   t0, 0x288(t0)               # the bus clock in Hz, as the boot ROM measured it
a03013f8  2409000f   li   t1, 15
a03013fc  01090019   multu t0, t1
a0301400  00004012   mflo t0
a0301404  3c09431b   li   t1, 0x431bde83              # / 1,000,000 (as the OS: multiply, take the high word >> 18)
a0301408  3529de83
a030140c  00000000   nop
a0301410  01090019   multu t0, t1
a0301414  00004010   mfhi t0
a0301418  00084482   srl  t0, t0, 18                  # t0 = bus clock * 15 / 1,000,000: bus clocks in 15 us
a030141c  3c19a400   lui  t9, SOLO
a0301420  af284020   sw   t0, DEV_IRSAMPLE(t9)
a0301424  2408000a   li   t0, 0xa
a0301428  af284024   sw   t0, DEV_IRREJECT(t9)
a030142c  24083083   li   t0, 0x3083
a0301430  af28402c   sw   t0, DEV_IRCNTL(t9)
a0301434  3c08a030   la   t0, IR_HEAD
a0301438  25081b24
a030143c  ad000000   sw   zero, 0(t0)
a0301440  03e00008   jr   ra
a0301444  ad000004   sw   zero, 4(t0)
                   .endfunc

                   # ir_poll(): move every run in the receiver's FIFO to the ring (dropped if the ring is full).
                   # Uses only at, v0, k0, k1, t8, t9.
                   # ---- ir_poll: 72 bytes at 0xa0301448
                   .func ir_poll
a0301448  3c19a400   lui  t9, SOLO
a030144c  3c18a030   la   t8, IR_HEAD
a0301450  27181b24
                   # Each FIFO read gives one run: how long the IR line stayed at one level. The ring keeps them for
                   # ir_flush; k0/k1 are free because interrupts are off for good.
                   ir_poll_next:
a0301454  8f3a4028   lw   k0, DEV_IRDATA(t9)
a0301458  335bf000   andi k1, k0, 0xf000
a030145c  1360000a   beqz k1, ir_poll_done            # count 0: nothing there
a0301460  8f1b0000   lw   k1, 0(t8)                   # head
a0301464  27610001   addiu at, k1, 1
a0301468  302100ff   andi at, at, 255
a030146c  8f020004   lw   v0, 4(t8)                   # tail
a0301470  1022fff8   beq  at, v0, ir_poll_next        # full: drop this run
a0301474  001bd840   sll  k1, k1, 1                   # the entry's offset (halfwords, after head and tail)
a0301478  0378d821   addu k1, k1, t8
a030147c  a77a0008   sh   k0, 8(k1)
a0301480  1000fff4   b    ir_poll_next
a0301484  af010000   sw   at, 0(t8)
                   ir_poll_done:
a0301488  03e00008   jr   ra
a030148c  00000000   nop
                   .endfunc

                   # ir_flush(): send what the ring holds as one IR message (up to 64 runs)
                   # ---- ir_flush: 160 bytes at 0xa0301490
                   .func ir_flush
a0301490  27bdffec   addiu sp, sp, -20
a0301494  afbf0010   sw   ra, 16(sp)
a0301498  afb00000   sw   s0, 0(sp)
a030149c  afb10004   sw   s1, 4(sp)
a03014a0  afb20008   sw   s2, 8(sp)
                   # s0 the ring, s1 runs to send (head - tail, at most 64), s2 the run being sent. The message is
                   # IR (0x90), the count, then each run as two bytes; the bridge decodes remote and keyboard codes.
a03014a4  3c10a030   la   s0, IR_HEAD
a03014a8  26101b24
a03014ac  8e080000   lw   t0, 0(s0)
a03014b0  8e090004   lw   t1, 4(s0)
a03014b4  01098823   subu s1, t0, t1
a03014b8  323100ff   andi s1, s1, 255
a03014bc  12200016   beqz s1, ir_flush_done
a03014c0  2e280041   sltiu t0, s1, 65
a03014c4  15000002   bnez t0, ir_flush_send
a03014c8  00000000   nop
a03014cc  24110040   li   s1, 64
                   ir_flush_send:
a03014d0  0c0c0254   jal  link_tx
a03014d4  24040090   li   a0, 0x90
a03014d8  0c0c0254   jal  link_tx
a03014dc  02202021   move a0, s1
                   ir_flush_entry:
a03014e0  8e090004   lw   t1, 4(s0)
a03014e4  00095040   sll  t2, t1, 1
a03014e8  01505021   addu t2, t2, s0
a03014ec  95520008   lhu  s2, 8(t2)
a03014f0  25290001   addiu t1, t1, 1
a03014f4  312900ff   andi t1, t1, 255
a03014f8  ae090004   sw   t1, 4(s0)
a03014fc  0c0c0254   jal  link_tx
a0301500  00122202   srl  a0, s2, 8
a0301504  0c0c0254   jal  link_tx
a0301508  324400ff   andi a0, s2, 0xff
a030150c  2631ffff   addiu s1, s1, -1
a0301510  1620fff3   bnez s1, ir_flush_entry
a0301514  00000000   nop
                   ir_flush_done:
a0301518  8fb00000   lw   s0, 0(sp)
a030151c  8fb10004   lw   s1, 4(sp)
a0301520  8fb20008   lw   s2, 8(sp)
a0301524  8fbf0010   lw   ra, 16(sp)
a0301528  03e00008   jr   ra
a030152c  27bd0014   addiu sp, sp, 20
                   .endfunc

                   # ---------------------------------------------------------------- I2C (as the boot ROM does it)

                   # iic_set(a0 = DEV_IICCNTL bits to set, a1 = bits to clear), then half a bit time. Raising
                   # SCL waits (a while) for a slave that stretches the clock.
                   # ---- iic_set: 100 bytes at 0xa0301530
                   .func iic_set
                   # the I2C lines are bits of DEV_IICCNTL: 0x02/0x04 SDA released/driven low, 0x08/0x10 SCL
                   # released/driven low, 0x20 SCL as it reads on the bus
a0301530  3c19a400   lui  t9, SOLO
a0301534  8f28400c   lw   t0, DEV_IIC(t9)
a0301538  01044025   or   t0, t0, a0
a030153c  00a04827   nor  t1, a1, zero
a0301540  01094024   and  t0, t0, t1
a0301544  af28400c   sw   t0, DEV_IIC(t9)
a0301548  30880008   andi t0, a0, 0x08                # releasing SCL? then wait (up to 100 reads) until it is high
a030154c  11000007   beqz t0, iic_set_wait
a0301550  24090064   li   t1, 100
                   iic_set_scl:
a0301554  8f28400c   lw   t0, DEV_IIC(t9)
a0301558  31080020   andi t0, t0, 0x20
a030155c  15000003   bnez t0, iic_set_wait
a0301560  2529ffff   addiu t1, t1, -1
a0301564  1520fffb   bnez t1, iic_set_scl
a0301568  00000000   nop
                   iic_set_wait:
a030156c  400c4800   mfc0 t4, 9
a0301570  240d019f   li   t5, 415
                   dly1:
a0301574  400e4800   mfc0 t6, 9
a0301578  00000000   nop
a030157c  01cc7023   subu t6, t6, t4
a0301580  01cd702b   sltu t6, t6, t5
a0301584  15c0fffb   bnez t6, dly1
a0301588  00000000   nop
a030158c  03e00008   jr   ra
a0301590  00000000   nop
                   .endfunc

                   # iic_byte(a0 = byte): 8 bits MSB first, then a clock for the slave's ack (not checked)
                   # ---- iic_byte: 164 bytes at 0xa0301594
                   .func iic_byte
a0301594  27bdfff0   addiu sp, sp, -16
a0301598  afbf000c   sw   ra, 12(sp)
a030159c  afb00000   sw   s0, 0(sp)
a03015a0  afb10004   sw   s1, 4(sp)
                   # each bit: SDA set while SCL is low, then a clock pulse; s0 the byte, shifted up, s1 bits left
a03015a4  00808021   move s0, a0
a03015a8  24110008   li   s1, 8
                   iic_byte_bit:
a03015ac  32080080   andi t0, s0, 0x80
a03015b0  11000006   beqz t0, iic_byte_0
a03015b4  00000000   nop
a03015b8  24040002   li   a0, 0x2
a03015bc  0c0c054c   jal  iic_set
a03015c0  24050004   li   a1, 0x4
a03015c4  10000004   b    iic_byte_clk
a03015c8  00000000   nop
                   iic_byte_0:
a03015cc  24040004   li   a0, 0x4
a03015d0  0c0c054c   jal  iic_set
a03015d4  24050002   li   a1, 0x2
                   iic_byte_clk:
a03015d8  24040008   li   a0, 0x8
a03015dc  0c0c054c   jal  iic_set
a03015e0  24050010   li   a1, 0x10
a03015e4  24040010   li   a0, 0x10
a03015e8  0c0c054c   jal  iic_set
a03015ec  24050008   li   a1, 0x8
a03015f0  00108040   sll  s0, s0, 1
a03015f4  2631ffff   addiu s1, s1, -1
a03015f8  1620ffec   bnez s1, iic_byte_bit
a03015fc  00000000   nop
                   # the ninth clock, SDA released: the slave's ack, which we don't read
a0301600  24040002   li   a0, 0x2
a0301604  0c0c054c   jal  iic_set
a0301608  24050004   li   a1, 0x4
a030160c  24040008   li   a0, 0x8
a0301610  0c0c054c   jal  iic_set
a0301614  24050010   li   a1, 0x10
a0301618  24040010   li   a0, 0x10
a030161c  0c0c054c   jal  iic_set
a0301620  24050008   li   a1, 0x8
a0301624  8fb00000   lw   s0, 0(sp)
a0301628  8fb10004   lw   s1, 4(sp)
a030162c  8fbf000c   lw   ra, 12(sp)
a0301630  03e00008   jr   ra
a0301634  27bd0010   addiu sp, sp, 16
                   .endfunc

                   # iic_write(a0 = device address, a1 = register, a2 = value)
                   # ---- iic_write: 164 bytes at 0xa0301638
                   .func iic_write
a0301638  27bdffec   addiu sp, sp, -20
a030163c  afbf0010   sw   ra, 16(sp)
a0301640  afb00000   sw   s0, 0(sp)
a0301644  afb10004   sw   s1, 4(sp)
a0301648  afb20008   sw   s2, 8(sp)
a030164c  00808021   move s0, a0
a0301650  00a08821   move s1, a1
a0301654  00c09021   move s2, a2
                   # START: SDA falls while SCL is high. Then the device address, the register, the value.
a0301658  24040002   li   a0, 0x2
a030165c  0c0c054c   jal  iic_set
a0301660  24050004   li   a1, 0x4
a0301664  24040008   li   a0, 0x8
a0301668  0c0c054c   jal  iic_set
a030166c  24050010   li   a1, 0x10
a0301670  24040004   li   a0, 0x4
a0301674  0c0c054c   jal  iic_set
a0301678  24050002   li   a1, 0x2
a030167c  24040010   li   a0, 0x10
a0301680  0c0c054c   jal  iic_set
a0301684  24050008   li   a1, 0x8
a0301688  0c0c0565   jal  iic_byte
a030168c  02002021   move a0, s0
a0301690  0c0c0565   jal  iic_byte
a0301694  02202021   move a0, s1
a0301698  0c0c0565   jal  iic_byte
a030169c  02402021   move a0, s2
                   # STOP: SDA rises while SCL is high
a03016a0  24040004   li   a0, 0x4
a03016a4  0c0c054c   jal  iic_set
a03016a8  24050002   li   a1, 0x2
a03016ac  24040008   li   a0, 0x8
a03016b0  0c0c054c   jal  iic_set
a03016b4  24050010   li   a1, 0x10
a03016b8  24040002   li   a0, 0x2
a03016bc  0c0c054c   jal  iic_set
a03016c0  24050004   li   a1, 0x4
a03016c4  8fb00000   lw   s0, 0(sp)
a03016c8  8fb10004   lw   s1, 4(sp)
a03016cc  8fb20008   lw   s2, 8(sp)
a03016d0  8fbf0010   lw   ra, 16(sp)
a03016d4  03e00008   jr   ra
a03016d8  27bd0014   addiu sp, sp, 20
                   .endfunc

                   # ---------------------------------------------------------------- data

                   # ---- MEM_RANGES: 48 bytes at 0xa03016dc
                   .func MEM_RANGES                   # [start, end) pairs; end 0 ends the table
a03016dc  80000000   .word 0x80000000
a03016e0  80800000   .word 0x80800000
a03016e4  a0000000   .word 0xa0000000
a03016e8  a0800000   .word 0xa0800000
a03016ec  9fc00000   .word 0x9fc00000
a03016f0  9fe00000   .word 0x9fe00000
a03016f4  bfc00000   .word 0xbfc00000
a03016f8  bfe00000   .word 0xbfe00000
a03016fc  a4000000   .word 0xa4000000
a0301700  a4010000   .word 0xa4010000
a0301704  00000000   .word 0
a0301708  00000000   .word 0
                   .endfunc

                   # 5 x 7 glyphs from ' ' to '~', 8 bytes each: a row a byte, the pixels in its top 5 bits (font.js)
                   # ---- FONT: 760 bytes at 0xa030170c
                   .func FONT
a030170c  00000000   .word 0x0
a0301710  00000000   .word 0x0
a0301714  20202020   .word 0x20202020
a0301718  20002000   .word 0x20002000
a030171c  50500000   .word 0x50500000
a0301720  00000000   .word 0x0
a0301724  5050f850   .word 0x5050f850
a0301728  f8505000   .word 0xf8505000
a030172c  2078a070   .word 0x2078a070
a0301730  28f02000   .word 0x28f02000
a0301734  c0c81020   .word 0xc0c81020
a0301738  40981800   .word 0x40981800
a030173c  6090a040   .word 0x6090a040
a0301740  a8906800   .word 0xa8906800
a0301744  20204000   .word 0x20204000
a0301748  00000000   .word 0x0
a030174c  10204040   .word 0x10204040
a0301750  40201000   .word 0x40201000
a0301754  40201010   .word 0x40201010
a0301758  10204000   .word 0x10204000
a030175c  0020a870   .word 0x20a870
a0301760  a8200000   .word 0xa8200000
a0301764  002020f8   .word 0x2020f8
a0301768  20200000   .word 0x20200000
a030176c  00000000   .word 0x0
a0301770  00602040   .word 0x602040
a0301774  000000f8   .word 0xf8
a0301778  00000000   .word 0x0
a030177c  00000000   .word 0x0
a0301780  00606000   .word 0x606000
a0301784  00081020   .word 0x81020
a0301788  40800000   .word 0x40800000
a030178c  708898a8   .word 0x708898a8
a0301790  c8887000   .word 0xc8887000
a0301794  20602020   .word 0x20602020
a0301798  20207000   .word 0x20207000
a030179c  70880810   .word 0x70880810
a03017a0  2040f800   .word 0x2040f800
a03017a4  f8102010   .word 0xf8102010
a03017a8  08887000   .word 0x8887000
a03017ac  10305090   .word 0x10305090
a03017b0  f8101000   .word 0xf8101000
a03017b4  f880f008   .word 0xf880f008
a03017b8  08887000   .word 0x8887000
a03017bc  304080f0   .word 0x304080f0
a03017c0  88887000   .word 0x88887000
a03017c4  f8081020   .word 0xf8081020
a03017c8  40404000   .word 0x40404000
a03017cc  70888870   .word 0x70888870
a03017d0  88887000   .word 0x88887000
a03017d4  70888878   .word 0x70888878
a03017d8  08106000   .word 0x8106000
a03017dc  00606000   .word 0x606000
a03017e0  60600000   .word 0x60600000
a03017e4  00606000   .word 0x606000
a03017e8  60204000   .word 0x60204000
a03017ec  10204080   .word 0x10204080
a03017f0  40201000   .word 0x40201000
a03017f4  0000f800   .word 0xf800
a03017f8  f8000000   .word 0xf8000000
a03017fc  40201008   .word 0x40201008
a0301800  10204000   .word 0x10204000
a0301804  70880810   .word 0x70880810
a0301808  20002000   .word 0x20002000
a030180c  70880868   .word 0x70880868
a0301810  a8a87000   .word 0xa8a87000
a0301814  708888f8   .word 0x708888f8
a0301818  88888800   .word 0x88888800
a030181c  f08888f0   .word 0xf08888f0
a0301820  8888f000   .word 0x8888f000
a0301824  70888080   .word 0x70888080
a0301828  80887000   .word 0x80887000
a030182c  e0908888   .word 0xe0908888
a0301830  8890e000   .word 0x8890e000
a0301834  f88080f0   .word 0xf88080f0
a0301838  8080f800   .word 0x8080f800
a030183c  f88080f0   .word 0xf88080f0
a0301840  80808000   .word 0x80808000
a0301844  708880b8   .word 0x708880b8
a0301848  88887800   .word 0x88887800
a030184c  888888f8   .word 0x888888f8
a0301850  88888800   .word 0x88888800
a0301854  70202020   .word 0x70202020
a0301858  20207000   .word 0x20207000
a030185c  38101010   .word 0x38101010
a0301860  10906000   .word 0x10906000
a0301864  8890a0c0   .word 0x8890a0c0
a0301868  a0908800   .word 0xa0908800
a030186c  80808080   .word 0x80808080
a0301870  8080f800   .word 0x8080f800
a0301874  88d8a8a8   .word 0x88d8a8a8
a0301878  88888800   .word 0x88888800
a030187c  8888c8a8   .word 0x8888c8a8
a0301880  98888800   .word 0x98888800
a0301884  70888888   .word 0x70888888
a0301888  88887000   .word 0x88887000
a030188c  f08888f0   .word 0xf08888f0
a0301890  80808000   .word 0x80808000
a0301894  70888888   .word 0x70888888
a0301898  a8906800   .word 0xa8906800
a030189c  f08888f0   .word 0xf08888f0
a03018a0  a0908800   .word 0xa0908800
a03018a4  78808070   .word 0x78808070
a03018a8  0808f000   .word 0x808f000
a03018ac  f8202020   .word 0xf8202020
a03018b0  20202000   .word 0x20202000
a03018b4  88888888   .word 0x88888888
a03018b8  88887000   .word 0x88887000
a03018bc  88888888   .word 0x88888888
a03018c0  88502000   .word 0x88502000
a03018c4  888888a8   .word 0x888888a8
a03018c8  a8a85000   .word 0xa8a85000
a03018cc  88885020   .word 0x88885020
a03018d0  50888800   .word 0x50888800
a03018d4  88888850   .word 0x88888850
a03018d8  20202000   .word 0x20202000
a03018dc  f8081020   .word 0xf8081020
a03018e0  4080f800   .word 0x4080f800
a03018e4  70404040   .word 0x70404040
a03018e8  40407000   .word 0x40407000
a03018ec  00804020   .word 0x804020
a03018f0  10080000   .word 0x10080000
a03018f4  70101010   .word 0x70101010
a03018f8  10107000   .word 0x10107000
a03018fc  20508800   .word 0x20508800
a0301900  00000000   .word 0x0
a0301904  00000000   .word 0x0
a0301908  000000f8   .word 0xf8
a030190c  40200000   .word 0x40200000
a0301910  00000000   .word 0x0
a0301914  00007008   .word 0x7008
a0301918  78887800   .word 0x78887800
a030191c  8080b0c8   .word 0x8080b0c8
a0301920  8888f000   .word 0x8888f000
a0301924  00007080   .word 0x7080
a0301928  80887000   .word 0x80887000
a030192c  08086898   .word 0x8086898
a0301930  88887800   .word 0x88887800
a0301934  00007088   .word 0x7088
a0301938  f8807000   .word 0xf8807000
a030193c  304840e0   .word 0x304840e0
a0301940  40404000   .word 0x40404000
a0301944  00007888   .word 0x7888
a0301948  88780870   .word 0x88780870
a030194c  8080b0c8   .word 0x8080b0c8
a0301950  88888800   .word 0x88888800
a0301954  20006020   .word 0x20006020
a0301958  20207000   .word 0x20207000
a030195c  10003010   .word 0x10003010
a0301960  10109060   .word 0x10109060
a0301964  808090a0   .word 0x808090a0
a0301968  c0a09000   .word 0xc0a09000
a030196c  60202020   .word 0x60202020
a0301970  20207000   .word 0x20207000
a0301974  0000d0a8   .word 0xd0a8
a0301978  a8888800   .word 0xa8888800
a030197c  0000b0c8   .word 0xb0c8
a0301980  88888800   .word 0x88888800
a0301984  00007088   .word 0x7088
a0301988  88887000   .word 0x88887000
a030198c  0000f088   .word 0xf088
a0301990  88f08080   .word 0x88f08080
a0301994  00007888   .word 0x7888
a0301998  88780808   .word 0x88780808
a030199c  0000b0c8   .word 0xb0c8
a03019a0  80808000   .word 0x80808000
a03019a4  00007080   .word 0x7080
a03019a8  7008f000   .word 0x7008f000
a03019ac  4040e040   .word 0x4040e040
a03019b0  40483000   .word 0x40483000
a03019b4  00008888   .word 0x8888
a03019b8  88986800   .word 0x88986800
a03019bc  00008888   .word 0x8888
a03019c0  88502000   .word 0x88502000
a03019c4  00008888   .word 0x8888
a03019c8  a8a85000   .word 0xa8a85000
a03019cc  00008850   .word 0x8850
a03019d0  20508800   .word 0x20508800
a03019d4  00008888   .word 0x8888
a03019d8  88780870   .word 0x88780870
a03019dc  0000f810   .word 0xf810
a03019e0  2040f800   .word 0x2040f800
a03019e4  10202040   .word 0x10202040
a03019e8  20201000   .word 0x20201000
a03019ec  20202020   .word 0x20202020
a03019f0  20202000   .word 0x20202000
a03019f4  40202010   .word 0x40202010
a03019f8  20204000   .word 0x20204000
a03019fc  000040a8   .word 0x40a8
a0301a00  10000000   .word 0x10000000
                   .endfunc

                   # ---- V_SCALE: 808 bytes at 0xa0301a04
                   .func V_SCALE                      # text scale, fg, bg; then a 256-byte text buffer
a0301a04  00000001   .word 1
a0301a08  00000000   .word 0
a0301a0c  00000000   .word 0
                   TEXTBUF:
a0301a10  00000000   .word 0
                   ... 63 more of the same, to a0301b0c
                   V_T2:                              # TEXT2: the characters, their count, the strike's bitmaps, y
a0301b10  00000000   .word 0
                   ... 3 more of the same, to a0301b1c
                   V_FBT:                             # where drawing goes: FB, or BACK (TARGET); set at start
a0301b20  00000000   .word 0
                   IR_HEAD:                           # IR ring: head, tail, then 256 halfword runs
a0301b24  00000000   .word 0
                   ... 129 more of the same, to a0301d28
                   LOADER_END:
                   .endfunc
```

The font's 190 words (0xa030110c to 0xa0301400) are left out above; they are the 5×7 glyphs of `src/stockbox/font.js`, one byte a row.

## B.3 The tier-3 stub

The first code in the tier-3 image (`src/stockbox/tier3.js`), after its OS-style header (a `b 0x40`, the size and checksum words, `NoFS`, the base 0x80400000 and the tier-3 flag). Test 19 jumps to it at 0x80400040.

```
                   # Test 19 has read the tier-3 area to its base and jumped here, past the OS-style header. The
                   # loader that follows is copied down to LOADER_BASE (uncached), out of the way of the OS the
                   # bridge reads to 0x80400000 and up, and started there.
                   # ---- t3_stub: 60 bytes at 0x80400040
                   .func t3_stub
80400040  3c088040   la   t0, T3_PAYLOAD              # from: the loader's words, right after this stub
80400044  2508007c
80400048  3c09a030   li   t1, 0xa0300000         # to: LOADER_BASE (kseg1)
8040004c  35290000
80400050  240a074b   li   t2, 1867                 # the loader's length in words
                   t3_copy:
80400054  8d0b0000   lw   t3, 0(t0)
80400058  ad2b0000   sw   t3, 0(t1)
8040005c  25080004   addiu t0, t0, 4
80400060  254affff   addiu t2, t2, -1
80400064  1540fffb   bnez t2, t3_copy
80400068  25290004   addiu t1, t1, 4                  # (delay slot)
8040006c  3c08a030   li   t0, 0xa0300000         # start it
80400070  35080000
80400074  01000008   jr   t0
80400078  00000000   nop
                   T3_PAYLOAD:                        # the loader image follows
                   .endfunc
```
