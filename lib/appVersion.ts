/**
 * The running Ironbooks version (stamped into backups and shown in the restore preview).
 * Next inlines NEXT_PUBLIC_APP_VERSION from package.json at build time (next.config.js);
 * tests and scripts read package.json directly.
 */
import pkg from '@/package.json';

export const APP_VERSION: string = process.env.NEXT_PUBLIC_APP_VERSION || pkg.version;
