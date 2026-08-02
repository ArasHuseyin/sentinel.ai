import * as fs from 'node:fs';

/** Owner read/write only. */
export const PRIVATE_FILE_MODE = 0o600;

/**
 * Writes a file that only its owner can read.
 *
 * `writeFileSync(..., { mode })` applies the mode **only when the file is
 * created** — an existing file keeps whatever permissions it already had. Since
 * these files are written repeatedly across runs, the very first write (before
 * this was tightened, or by an older version of the package) would otherwise
 * pin them at 0644 forever. The explicit chmod fixes that up.
 *
 * chmod is a no-op on Windows for anything but the read-only bit, and can fail
 * on filesystems that don't model POSIX permissions at all (mounted shares,
 * some containers). Failing to tighten permissions must not abort the caller's
 * run, so the chmod is best-effort while the write itself still throws.
 */
export function writeFilePrivateSync(filePath: string, data: string): void {
  fs.writeFileSync(filePath, data, { encoding: 'utf-8', mode: PRIVATE_FILE_MODE });
  try {
    fs.chmodSync(filePath, PRIVATE_FILE_MODE);
  } catch {
    // Best-effort — see above.
  }
}
