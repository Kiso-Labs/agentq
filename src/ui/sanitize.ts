const ESC = 0x1b;
const BEL = 0x07;
const CSI = 0x9b;
const DCS = 0x90;
const OSC = 0x9d;
const SOS = 0x98;
const PM = 0x9e;
const APC = 0x9f;
const ST = 0x9c;

const isCsiFinal = (code: number): boolean => code >= 0x40 && code <= 0x7e;

const consumeCsi = (value: string, start: number): number => {
  for (let index = start; index < value.length; index += 1) {
    if (isCsiFinal(value.charCodeAt(index))) return index + 1;
  }
  return value.length;
};

const consumeStringControl = (value: string, start: number, allowBel: boolean): number => {
  for (let index = start; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((allowBel && code === BEL) || code === ST) return index + 1;
    if (code === ESC && value.charCodeAt(index + 1) === 0x5c) return index + 2;
  }
  return value.length;
};

/**
 * Remove terminal control sequences from text that will be rendered by Ink.
 *
 * Provider output, task titles, repository paths, and database errors are all
 * untrusted display data. Stripping both 7-bit and 8-bit terminal controls
 * prevents them from changing the terminal title, creating links, moving the
 * cursor, or smuggling additional escape sequences into the TUI.
 */
export const sanitizeTerminalText = (value: string): string => {
  let output = "";
  let index = 0;

  while (index < value.length) {
    const code = value.charCodeAt(index);

    if (code === ESC) {
      const next = value.charCodeAt(index + 1);
      if (next === 0x5b) {
        index = consumeCsi(value, index + 2);
        continue;
      }
      if (next === 0x5d) {
        index = consumeStringControl(value, index + 2, true);
        continue;
      }
      if (next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
        index = consumeStringControl(value, index + 2, false);
        continue;
      }

      // Fe escape sequences are two bytes. Sequences with intermediates use
      // bytes 0x20-0x2f followed by a final byte; consume the whole sequence.
      index += 1;
      while (index < value.length) {
        const sequenceCode = value.charCodeAt(index);
        index += 1;
        if (sequenceCode < 0x20 || sequenceCode > 0x2f) break;
      }
      continue;
    }

    if (code === CSI) {
      index = consumeCsi(value, index + 1);
      continue;
    }
    if (code === OSC) {
      index = consumeStringControl(value, index + 1, true);
      continue;
    }
    if (code === DCS || code === SOS || code === PM || code === APC) {
      index = consumeStringControl(value, index + 1, false);
      continue;
    }

    // Keep layout stable when pasted text contains line-oriented whitespace.
    if (code === 0x09 || code === 0x0a || code === 0x0d) {
      output += " ";
      index += 1;
      continue;
    }

    // Drop the remaining C0/C1 controls and DEL. Printable Unicode survives.
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      index += 1;
      continue;
    }

    output += value[index];
    index += 1;
  }

  return output;
};
