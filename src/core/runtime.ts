import { setTimeout as wait } from "node:timers/promises";

const syncWaitBuffer = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

export async function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await wait(milliseconds, undefined, signal ? { signal } : undefined);
}

export function sleepSync(milliseconds: number): void {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return;
  Atomics.wait(syncWaitBuffer, 0, 0, Math.ceil(milliseconds));
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
