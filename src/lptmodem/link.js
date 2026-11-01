// The SOLO parallel port as the LPT bridge's code uses it, in software mode (P_CNFG = 0): its
// registers and pin bits. Shared by the box-side code (src/lptmodem/driver.js, parmod.js,
// src/stockbox/loader.js) and the emulated peripherals (src/machine/lptbridge.js, parmodhost.js);
// the link itself, PARMOD, is WEBTV_LPT_BRIDGE.md §4.1.

// SOLO parallel port registers (dev unit + 0x200), KSEG1 address as the OS uses them
export const PP_BASE = 0xa4004200;
export const PP = {
  DATA: 0x00, CTRL: 0x04, STAT: 0x08, CNFG: 0x0c, FIFOCTRL: 0x10, FIFOSTAT: 0x14, TIMEOUT: 0x18,
  STAT2: 0x1c, IEN: 0x20, IST: 0x24, CLRINT: 0x28, ENABLE: 0x2c,
};

// P_CTRL bits: pin levels driven by the box. DIR_OUT set = the box drives D0-D7, as the printed
// spec says (and not the "Spec SWAPPED!" margin note): the OS's printer driver sets it to print,
// and the 1997 ECP debug link's Xfer2Bytes sets it before writing a byte for the PC and clears it
// before reading one (WEBTV_LPT_BRIDGE.md §3.7).
export const CTRL = { STB_N: 0x01, INIT_N: 0x02, AUTOFD_N: 0x04, SELIN_N: 0x08, DIR_OUT: 0x10, ECPCMND: 0x20 };

// P_STAT bits: pin levels driven by the peripheral. This is the layout the OS's own printer
// driver assumes (its SOLO -> PC status translation table), which differs from the printed
// spec's labels for bits 1, 2 and 4. VERIFY on hardware.
export const STAT = { BUSY: 0x01, ACK_N: 0x02, FAULT_N: 0x04, SEL: 0x08, PE: 0x10 };

// P_IEN / P_IST / P_CLRINT bits
export const INT = { THRESH: 0x01, ECPREVERSE: 0x04, ACKDONE: 0x08, CFIFOEXCP: 0x10 };
