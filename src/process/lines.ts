import { StringDecoder } from "node:string_decoder";

export interface LineOptions {
  /** Maximum decoded characters retained for one line. */
  maxLineLength?: number;
}

const DEFAULT_MAX_LINE_LENGTH = 16 * 1024 * 1024;
const TRUNCATION_MARKER = "…[truncated]";

/** Decode a byte stream into bounded UTF-8 lines without losing split characters. */
export async function* lines(
  stream: AsyncIterable<Uint8Array | string>,
  options: LineOptions = {},
): AsyncGenerator<string> {
  const maxLineLength = options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;
  if (!Number.isSafeInteger(maxLineLength) || maxLineLength < 1) {
    throw new RangeError("maxLineLength must be a positive integer");
  }

  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let truncated = false;

  function append(segment: string): void {
    if (truncated) return;
    const available = maxLineLength - buffer.length;
    if (segment.length <= available) {
      buffer += segment;
      return;
    }
    buffer += segment.slice(0, available);
    truncated = true;
  }

  function finishLine(): string {
    const text = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
    const result = truncated ? `${text}${TRUNCATION_MARKER}` : text;
    buffer = "";
    truncated = false;
    return result;
  }

  function* consume(decoded: string): Generator<string> {
    let offset = 0;
    while (offset < decoded.length) {
      const newline = decoded.indexOf("\n", offset);
      if (newline === -1) {
        append(decoded.slice(offset));
        return;
      }
      append(decoded.slice(offset, newline));
      yield finishLine();
      offset = newline + 1;
    }
  }

  for await (const chunk of stream) {
    const decoded = typeof chunk === "string" ? chunk : decoder.write(Buffer.from(chunk));
    yield* consume(decoded);
  }

  yield* consume(decoder.end());
  if (buffer.length > 0 || truncated) yield finishLine();
}
