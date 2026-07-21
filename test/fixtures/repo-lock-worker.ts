import { writeFile } from "node:fs/promises";
import { withRepoLock } from "../../src/git/repo-lock.ts";

const [locksDir, repoPath, enteredPath, releasePath, staleMsValue] = process.argv.slice(2);

if (!locksDir || !repoPath || !enteredPath || !releasePath || !staleMsValue) {
  throw new Error("Expected locksDir, repoPath, enteredPath, releasePath, and staleMs");
}

const staleMs = Number(staleMsValue);
if (!Number.isSafeInteger(staleMs) || staleMs < 1) throw new Error("Invalid staleMs");

await withRepoLock(
  locksDir,
  repoPath,
  async () => {
    await writeFile(enteredPath, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
    while (!(await Bun.file(releasePath).exists())) await Bun.sleep(10);
  },
  { staleMs, timeoutMs: 5_000 },
);
