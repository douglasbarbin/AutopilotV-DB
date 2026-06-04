import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';

// node-gyp/make embeds the active Xcode developer dir into the generated
// Makefile *unquoted*. If that path contains a space (e.g.
// "/Applications/Xcode 26.0.1.app/Contents/Developer"), make truncates the
// compiler invocation at the space and the native build fails with
// "/bin/sh: /Applications/Xcode: No such file or directory" (exit 127).
//
// CI works because the runners use a space-free path (/Applications/Xcode.app).
// To make local installs robust regardless of how Xcode is named, detect a
// spaced developer dir on macOS and point the build at a space-free one for
// the duration of this rebuild via DEVELOPER_DIR.
function ensureSpaceFreeDeveloperDir(env) {
  if (process.platform !== 'darwin') return env;

  let activePath = '';
  try {
    activePath = execFileSync('xcode-select', ['-p'], { encoding: 'utf8' }).trim();
  } catch {
    return env; // no xcode-select; let the build surface its own error
  }

  if (activePath && !activePath.includes(' ')) return env; // already fine

  // Prefer the standalone Command Line Tools (installed at a space-free path).
  const candidates = [
    '/Library/Developer/CommandLineTools',
    '/Applications/Xcode.app/Contents/Developer',
  ];
  const replacement = candidates.find(
    (p) => !p.includes(' ') && fs.existsSync(p)
  );

  if (!replacement) {
    console.warn(
      `[rebuild-native] Active Xcode path contains a space (${activePath}) ` +
        'and no space-free toolchain was found. The native build may fail. ' +
        'Install the Command Line Tools (xcode-select --install) or rename ' +
        'Xcode.app to remove the space.'
    );
    return env;
  }

  console.log(
    `[rebuild-native] Active Xcode path has a space (${activePath}); ` +
      `using DEVELOPER_DIR=${replacement} for the native build.`
  );
  return { ...env, DEVELOPER_DIR: replacement };
}

const env = ensureSpaceFreeDeveloperDir(process.env);

const result = spawnSync(
  'electron-builder',
  ['install-app-deps'],
  { stdio: 'inherit', env, shell: true }
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
