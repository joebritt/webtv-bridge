// Parallel-port loopback "dongle": the plug the LC2 boot ROM looks for at cold boot (the
// check at 0x9fc01358 in boot ROM 3475). The ROM drives one of D0-D3 at a time and expects
// exactly one pattern on the status lines for each:
//
//   D0 -> nAck (0x02)   D1 -> Busy (0x01)   D2 -> PError (0x10)   D3 -> nFault + Select (0x0c)
//
// Every other status line reads low. Install with bridge.setConsole(new LptDongle()); the
// bridge then hands it the port on every change.

export class LptDongle {
  reset() { this.port = null; }

  get status() {
    const p = this.port;
    if (!p || !p.driving) return 0;
    const d = p.data;
    return (d & 1 ? 0x02 : 0) | (d & 2 ? 0x01 : 0) | (d & 4 ? 0x10 : 0) | (d & 8 ? 0x0c : 0);
  }

  get data() { return null; }

  hostChanged(port) { this.port = port; }
}
