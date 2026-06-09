import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/*
 * Rebuild the native modules (better-sqlite3, node-pty) for a target runtime.
 *
 *   node ./scripts/rebuild-native.js [--target=electron|node]
 *
 * Electron and system Node use DIFFERENT native ABIs (Electron 42 = 146,
 * Node 22 = 127), and Electron's ABI is ahead of every released Node line, so
 * a single build can't serve both. The app (electron-vite) loads the modules
 * under Electron; vitest loads them under system Node. We therefore rebuild
 * on demand for whichever context is about to run:
 *
 *   predev / prestart / prebuild / postinstall → --target=electron
 *   pretest                                     → --target=node
 *
 * A marker file records the last-built target so repeat runs in the same
 * context are fast no-ops; switching contexts forces a from-source rebuild.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const target = (process.argv.find((a) => a.startsWith('--target=')) || '--target=electron').split('=')[1];
if (target !== 'electron' && target !== 'node') {
  console.error(`[rebuild-native] unknown target '${target}' (expected electron|node)`);
  process.exit(1);
}

const NATIVE_BINARY = path.join(rootDir, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node');
const MARKER = path.join(rootDir, 'node_modules/.native-abi-target');

// node-gyp/make embeds the active Xcode developer dir into the generated
// Makefile *unquoted*. If that path contains a space (e.g.
// "/Applications/Xcode 26.0.1.app/Contents/Developer"), make truncates the
// compiler invocation at the space and the build fails with exit 127. Point
// the build at a space-free toolchain for the duration of the rebuild.
function ensureSpaceFreeDeveloperDir(env) {
  if (process.platform !== 'darwin') return env;
  let activePath = '';
  try {
    activePath = execFileSync('xcode-select', ['-p'], { encoding: 'utf8' }).trim();
  } catch {
    return env;
  }
  if (activePath && !activePath.includes(' ')) return env;
  const replacement = ['/Library/Developer/CommandLineTools', '/Applications/Xcode.app/Contents/Developer'].find(
    (p) => !p.includes(' ') && fs.existsSync(p)
  );
  if (!replacement) {
    console.warn(
      `[rebuild-native] Active Xcode path contains a space (${activePath}) and no space-free ` +
        'toolchain was found. Install the Command Line Tools (xcode-select --install).'
    );
    return env;
  }
  console.log(`[rebuild-native] Xcode path has a space; using DEVELOPER_DIR=${replacement} for the build.`);
  return { ...env, DEVELOPER_DIR: replacement };
}

// Fast path: already built for this target.
if (fs.existsSync(NATIVE_BINARY) && fs.existsSync(MARKER) && fs.readFileSync(MARKER, 'utf8').trim() === target) {
  console.log(`[rebuild-native] native modules already built for '${target}' — skipping.`);
  process.exit(0);
}

const env = ensureSpaceFreeDeveloperDir(process.env);
console.log(`[rebuild-native] rebuilding native modules for '${target}'…`);

let result;
if (target === 'electron') {
  // Force a from-source rebuild against Electron's ABI. From-source is required
  // because patch-better-sqlite3.js patches the source for Electron's V8 13.
  result = spawnSync(
    'electron-rebuild',
    ['-f', '--build-from-source', '-w', 'better-sqlite3', '-w', 'node-pty'],
    { stdio: 'inherit', env, shell: true }
  );
} else {
  // Recompile against the current system Node (what vitest runs under).
  result = spawnSync('npm', ['rebuild', 'better-sqlite3', 'node-pty'], {
    stdio: 'inherit',
    env,
    shell: true
  });
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

fs.writeFileSync(MARKER, target + '\n');
console.log(`[rebuild-native] done — native modules built for '${target}'.`);
