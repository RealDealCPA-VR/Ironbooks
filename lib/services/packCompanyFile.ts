/**
 * Write a restored company folder out as one single company file (.ironbooks): encrypted with its
 * own key and slots when the restored books are protected (the key travelled inside the
 * password-protected portable or transfer file). Used by the desktop shell's restore flows
 * (app/api/portable/restore, app/api/accountant-copy/open) through their internal-token path.
 */
import path from 'node:path';
import { closeDb, shippedSchemaStamp } from '@/lib/db';
import { protectionForDir } from '@/lib/services/fileProtection';
import { APP_VERSION } from '@/lib/appVersion';
import session from '@/electron/companySession';

export async function packRestoredAsCompanyFile(
  restored: { dataDir: string; companyName: string; protected?: boolean },
  target: string,
): Promise<void> {
  const protection = restored.protected ? await protectionForDir(restored.dataDir) : null;
  await closeDb(restored.dataDir).catch(() => undefined);
  await session.writeWorkingCopyAs(path.dirname(restored.dataDir), target, {
    companyName: restored.companyName,
    appVersion: APP_VERSION,
    dataDir: restored.dataDir,
    protection,
    // Restored by this app, so migrated to the layout it ships.
    dbSchema: shippedSchemaStamp(),
  });
}
