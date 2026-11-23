/**
 * This computer user's home folder (os.homedir), for the server's agent code.
 *
 * Read through a computed name on purpose: the production build's file tracer (Next.js, @vercel/nft)
 * evaluates `os.homedir()` at build time, and a path built from it (`path.join(home, 'Documents')`,
 * `…\AppData\Local`) makes the tracer list that folder on the build computer. On a CI runner some
 * folders there refuse to be listed ("Application Data", "My Music"), and the build fails. Nothing
 * of the home folder belongs in the app anyway: these paths are only ever compared with others at
 * run time.
 */
import os from 'node:os';

const HOME_DIR = ['home', 'dir'].join('') as 'homedir';

export function homeDir(): string {
  return (os[HOME_DIR] as () => string).call(os);
}
