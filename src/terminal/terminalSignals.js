/**
 * Reads the signals a terminal program sends to its terminal out of a
 * session's raw output (track T slice T2a-2): the bell, Program Status
 * Protocol reports and queries (OSC 7501), a new shell prompt (OSC 133;A) and
 * a full reset (RIS).
 *
 * The domain's tap runs this on every chunk as it arrives, once, whether or
 * not a view shows the session. xterm.js parses the same bytes for the screen,
 * but a view replays recent output whenever it mounts, so signals read there
 * would fire again.
 *
 * Escape sequences are tracked the way xterm.js's parser tracks them, across
 * chunk boundaries, so only a bell xterm would ring counts: a BEL that ends an
 * OSC (a window title, or a program status report) is a terminator, not a
 * bell. Any ESC ends an OSC, as in xterm; CAN and SUB abort a sequence; the
 * 8-bit C1 introducers are honoured.
 */

const BEL = 0x07;
const CAN = 0x18;
const SUB = 0x1a;
const ESC = 0x1b;
const C1_DCS = 0x90;
const C1_SOS = 0x98;
const C1_CSI = 0x9b;
const C1_ST = 0x9c;
const C1_OSC = 0x9d;
const C1_PM = 0x9e;
const C1_APC = 0x9f;

const GROUND = 0;
const ESCAPE = 1;
const ESCAPE_INTERMEDIATE = 2;
const CSI = 3;
const OSC = 4;
/** DCS, SOS, PM and APC: their content is skipped up to ST. */
const STRING = 5;

/** The OSC payloads worth keeping; any other OSC is only tracked to its end. */
const KEPT_OSC = ['7501;', '133;'];
/** A memory bound on a kept OSC payload, in UTF-16 code units. The Program
 * Status Protocol caps a whole sequence at 4096 bytes and a code unit is at
 * least a byte, so this never drops a valid report; the parser checks bytes. */
export const MAX_OSC_PAYLOAD = 4096;

/** Characters that can change the scanner's state when it is in the ground state. */
const GROUND_SPECIAL = /[\x07\x18\x1a\x1b\x80-\x9f]/g;

const isC0 = (code) => code < 0x20;

/**
 * @param {object} handlers
 * @param {() => void} [handlers.onBell]
 * @param {(body: string) => void} [handlers.onStatus] an OSC 7501 report's body
 * @param {() => void} [handlers.onQuery] `OSC 7501 ; ?`
 * @param {() => void} [handlers.onPrompt] OSC 133;A, a new prompt
 * @param {() => void} [handlers.onReset] RIS (ESC c)
 */
export function createTerminalSignalScanner({
  onBell = () => {},
  onStatus = () => {},
  onQuery = () => {},
  onPrompt = () => {},
  onReset = () => {}
} = {}) {
  let state = GROUND;
  let osc = '';
  let oscKept = false;
  let oscOverflow = false;

  const startOsc = () => {
    state = OSC;
    osc = '';
    oscKept = true;
    oscOverflow = false;
  };

  const putOsc = (ch) => {
    if (!oscKept) return;
    osc += ch;
    if (osc.length > MAX_OSC_PAYLOAD) {
      oscKept = false;
      oscOverflow = true;
      osc = '';
      return;
    }
    if (osc.length <= 5 && !KEPT_OSC.some((p) => p.startsWith(osc) || osc.startsWith(p))) {
      oscKept = false;
      osc = '';
    }
  };

  const dispatchOsc = () => {
    const payload = osc;
    const kept = oscKept && !oscOverflow;
    osc = '';
    oscKept = false;
    if (!kept) return;
    if (payload.startsWith('7501;')) {
      const body = payload.slice(5);
      if (body.trim() === '?') onQuery();
      else onStatus(body);
    } else if (payload === '133;A' || payload.startsWith('133;A;')) {
      onPrompt();
    }
  };

  /** Bytes that act the same in every state. Returns true when handled. */
  const anywhere = (code) => {
    if (code === CAN || code === SUB) {
      state = GROUND;
      osc = '';
      oscKept = false;
      return true;
    }
    if (code === ESC) {
      if (state === OSC) dispatchOsc();
      state = ESCAPE;
      return true;
    }
    if (code === C1_ST) {
      if (state === OSC) dispatchOsc();
      state = GROUND;
      return true;
    }
    return false;
  };

  /** A C1 introducer, valid from the ground, escape and control states. */
  const c1 = (code) => {
    if (code === C1_CSI) state = CSI;
    else if (code === C1_OSC) startOsc();
    else if (code === C1_DCS || code === C1_SOS || code === C1_PM || code === C1_APC) state = STRING;
    else return false;
    return true;
  };

  const push = (chunk) => {
    if (typeof chunk !== 'string' || chunk.length === 0) return;
    let i = 0;
    while (i < chunk.length) {
      if (state === GROUND) {
        GROUND_SPECIAL.lastIndex = i;
        const match = GROUND_SPECIAL.exec(chunk);
        if (!match) return;
        i = match.index;
      }
      const code = chunk.charCodeAt(i);
      const ch = chunk[i];
      i += 1;

      if (state === OSC) {
        if (code === BEL) {
          dispatchOsc();
          state = GROUND;
        } else if (!anywhere(code) && !isC0(code)) {
          putOsc(ch);
        }
        continue;
      }
      if (state === STRING) {
        // Content is skipped; a BEL here is neither a bell nor a terminator.
        anywhere(code);
        continue;
      }
      if (anywhere(code)) continue;
      if (code === BEL) {
        // A C0 control executes in the ground, escape and CSI states alike.
        onBell();
        continue;
      }
      if (isC0(code)) continue;
      if (code >= 0x80 && code <= 0x9f) {
        if (!c1(code)) state = GROUND;
        continue;
      }

      switch (state) {
        case GROUND:
          break;
        case ESCAPE:
          if (code >= 0x20 && code <= 0x2f) state = ESCAPE_INTERMEDIATE;
          else if (ch === '[') state = CSI;
          else if (ch === ']') startOsc();
          else if (ch === 'P' || ch === 'X' || ch === '^' || ch === '_') state = STRING;
          else {
            state = GROUND;
            if (ch === 'c') onReset();
          }
          break;
        case ESCAPE_INTERMEDIATE:
          if (code >= 0x30 && code <= 0x7e) state = GROUND;
          break;
        case CSI:
          if (code >= 0x40 && code <= 0x7e) state = GROUND;
          break;
        default:
          state = GROUND;
      }
    }
  };

  return { push };
}
