// Compiles the Swift Wi-Fi helper (helpers/wifi-signal.swift) into build/wifi-signal.
// Runs as `npm run build`, and automatically before `npm start` (prestart).
//
// Skipped when not on macOS or when the binary is newer than its source. A missing
// swiftc only warns, since the app runs fine without the Wi-Fi panel; a compile error
// fails the build.

import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { HELPER_BINARY, HELPER_SOURCE } from '../src/wifi.ts';

const name = relative(process.cwd(), HELPER_BINARY);
const mtime = (path: string) => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
};

if (process.platform !== 'darwin') {
  console.log(`${name}: skipped, the Wi-Fi helper only works on macOS`);
  process.exit(0);
}

const built = mtime(HELPER_BINARY);
if (built !== undefined && built >= mtime(HELPER_SOURCE)!) process.exit(0);

try {
  execFileSync('swiftc', ['--version'], { stdio: 'ignore' });
} catch {
  console.warn(
    `${name}: not built, swiftc was not found. Install the Xcode Command Line Tools ` +
      '(xcode-select --install) to enable the Wi-Fi signal panel.',
  );
  process.exit(0);
}

console.log(`${name}: compiling ${relative(process.cwd(), HELPER_SOURCE)}…`);
mkdirSync(dirname(HELPER_BINARY), { recursive: true });
execFileSync('swiftc', ['-O', HELPER_SOURCE, '-o', HELPER_BINARY], { stdio: 'inherit' });
