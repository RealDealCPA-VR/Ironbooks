/**
 * Test fixture (not a test file): damage a closed PGlite data folder the way two Postgres instances
 * on one folder (or a power cut) leave it — its control file names a checkpoint whose write-ahead
 * log segment is gone, so Postgres stops at start with "could not locate a valid checkpoint
 * record" and PGlite reports "Aborted()". This is exactly the damage of the working copy that
 * could not be reopened after `next dev` was stopped (see lib/db/index.ts, electron/pgDataCheck.js).
 */
import fs from 'node:fs';
import path from 'node:path';

/** Remove the log segment holding the folder's last checkpoint. Returns the removed segment's name. */
export function damageCheckpoint(dir: string): string {
  const control = fs.readFileSync(path.join(dir, 'global', 'pg_control'));
  const checkpoint = control.readBigUInt64LE(32);
  const timeline = control.readUInt32LE(48);
  const walDir = path.join(dir, 'pg_wal');
  const any = fs.readdirSync(walDir).find((n) => /^[0-9A-F]{24}$/.test(n));
  if (!any) throw new Error(`no write-ahead log in ${dir}`);
  const seg = BigInt(fs.statSync(path.join(walDir, any)).size);
  const segNo = checkpoint / seg;
  const perId = BigInt(0x100000000) / seg;
  const hex8 = (n: bigint) => n.toString(16).toUpperCase().padStart(8, '0');
  const name = `${hex8(BigInt(timeline))}${hex8(segNo / perId)}${hex8(segNo % perId)}`;
  fs.rmSync(path.join(walDir, name));
  return name;
}
