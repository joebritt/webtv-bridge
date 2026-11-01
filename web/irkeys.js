// The WebTV remote's and the IR keyboard's codes, shared by the emulator (src/machine/ir.js) and
// the Bridge's web page (its Remote tab; tools/webgen.mjs inlines this file).

// WebTV remote button -> 6-bit code (the OS's Table.2502, EchoStar_ParseAndPost)
export const REMOTE = {
  up: 0x1a, down: 0x1e, left: 0x1c, right: 0x18, select: 0x1b, enter: 0x1b, back: 0x00, home: 0x14,
  options: 0x16, recent: 0x12, scroll_up: 0x19, scroll_down: 0x1d, power: 0x02, view: 0x0b, info: 0x32,
  '1': 0x04, '2': 0x05, '3': 0x06, '4': 0x08, '5': 0x09, '6': 0x0a, '7': 0x0c, '8': 0x0d, '9': 0x0e, '0': 0x11,
};

// Browser KeyboardEvent.code -> Sejin scancode (from MAME's wtvir_kbd input port table).
export const KEY_MAP = {
  Backquote: 0x04, F12: 0x05, CapsLock: 0x09, KeyX: 0x0a, Digit2: 0x0d, KeyS: 0x0e, KeyW: 0x0f,
  KeyC: 0x12, Digit3: 0x15, KeyD: 0x16, KeyE: 0x17, AltRight: 0x18, Tab: 0x19, KeyZ: 0x1a,
  F1: 0x1b, ControlLeft: 0x1c, Digit1: 0x1d, KeyA: 0x1e, KeyQ: 0x1f,
  KeyB: 0x20, KeyT: 0x21, KeyV: 0x22, KeyG: 0x23, Digit5: 0x24, Digit4: 0x25, KeyF: 0x26, KeyR: 0x27,
  AltLeft: 0x28, Escape: 0x29, ControlRight: 0x2b, F7: 0x2d, F8: 0x2f,
  ShiftLeft: 0x31, ShiftRight: 0x32, PrintScreen: 0x36, Pause: 0x37, Space: 0x38, Backspace: 0x39,
  Enter: 0x3a, NumpadEnter: 0x3a, Home: 0x3c, Numpad7: 0x3c, F3: 0x3d, Backslash: 0x3e,
  ArrowLeft: 0x48, Numpad4: 0x48, F9: 0x4a, ArrowUp: 0x4b, Numpad8: 0x4b, Insert: 0x4c, Numpad0: 0x4c,
  End: 0x4e, Numpad1: 0x4e,
  ArrowDown: 0x50, Numpad2: 0x50, F6: 0x52, F11: 0x54, F4: 0x55, PageUp: 0x56, Numpad9: 0x56,
  ArrowRight: 0x58, Numpad6: 0x58, PageDown: 0x5b, Numpad3: 0x5b, F10: 0x5c, F5: 0x5d,
  Period: 0x62, F2: 0x64, Digit9: 0x65, KeyL: 0x66, KeyO: 0x67, Slash: 0x68, BracketLeft: 0x69,
  Quote: 0x6b, Minus: 0x6c, Digit0: 0x6d, Semicolon: 0x6e, KeyP: 0x6f,
  BracketRight: 0x71, Comma: 0x72, Equal: 0x74, Digit8: 0x75, KeyK: 0x76, KeyI: 0x77, KeyN: 0x78,
  KeyY: 0x79, KeyM: 0x7a, KeyH: 0x7b, Digit6: 0x7c, Digit7: 0x7d, KeyJ: 0x7e, KeyU: 0x7f,
};

// character -> [KeyboardEvent.code, shifted] on a US keyboard
export const CHAR_KEYS = { ' ': ['Space', false] };
for (let i = 0; i < 26; i++) {
  const c = String.fromCharCode(97 + i);
  CHAR_KEYS[c] = ['Key' + c.toUpperCase(), false];
  CHAR_KEYS[c.toUpperCase()] = ['Key' + c.toUpperCase(), true];
}
')!@#$%^&*('.split('').forEach((c, i) => { CHAR_KEYS[String(i)] = ['Digit' + i, false]; CHAR_KEYS[c] = ['Digit' + i, true]; });
for (const [code, plain, shifted] of [['Backquote', '`', '~'], ['Minus', '-', '_'], ['Equal', '=', '+'], ['BracketLeft', '[', '{'],
  ['BracketRight', ']', '}'], ['Backslash', '\\', '|'], ['Semicolon', ';', ':'], ['Quote', "'", '"'], ['Comma', ',', '<'],
  ['Period', '.', '>'], ['Slash', '/', '?']]) { CHAR_KEYS[plain] = [code, false]; CHAR_KEYS[shifted] = [code, true]; }
