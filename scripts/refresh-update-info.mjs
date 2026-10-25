/**
 * After the Windows installer is code-signed OUTSIDE electron-builder (SignPath signs the built
 * files and hands them back — .github/workflows/release.yml), its bytes changed: the update feed
 * (latest.yml: sha512 + size) and the differential-update block map no longer match it, and every
 * installed copy would refuse the update. This rebuilds both from the signed file, the way
 * electron-builder does (its own buildBlockMap).
 *
 *   node scripts/refresh-update-info.mjs [releaseDir]     (default: release)
 *
 * Prints what changed. Running it on an unsigned build changes nothing (the hashes already match).
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap');
const yaml = require('js-yaml');

const dir = path.resolve(process.argv[2] || 'release');
const feedFile = path.join(dir, 'latest.yml');
const feed = yaml.load(fs.readFileSync(feedFile, 'utf8'));
if (!feed || !Array.isArray(feed.files) || !feed.files.length) throw new Error(`${feedFile} lists no files`);

/** The local file for a feed URL ("Ironbooks-Setup-1.6.0.exe"; older builds used spaces locally). */
function localFile(url) {
  for (const name of [url, url.replace(/-/g, ' ')]) {
    const f = path.join(dir, name);
    if (fs.existsSync(f)) return f;
  }
  throw new Error(`The installer named in latest.yml is not in ${dir}: ${url}`);
}

let changed = 0;
for (const entry of feed.files) {
  const file = localFile(entry.url);
  // Rebuilds <file>.blockmap and returns the file's own size and sha512 (base64).
  const info = await buildBlockMap(file, 'gzip', `${file}.blockmap`);
  if (entry.sha512 !== info.sha512 || entry.size !== info.size) {
    console.log(`${entry.url}: sha512/size updated for the signed file (${entry.size} -> ${info.size} bytes)`);
    entry.sha512 = info.sha512;
    entry.size = info.size;
    changed++;
  } else {
    console.log(`${entry.url}: already up to date`);
  }
  if (feed.path === entry.url) feed.sha512 = info.sha512;
}
fs.writeFileSync(feedFile, yaml.dump(feed, { lineWidth: 8000 }));
console.log(changed ? `latest.yml refreshed (${changed} file${changed === 1 ? '' : 's'}).` : 'latest.yml unchanged.');
