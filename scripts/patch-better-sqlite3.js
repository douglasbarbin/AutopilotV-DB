import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rootDir = path.resolve(__dirname, '..');

function patchFile(relativeFilePath, target, replacement) {
  const filePath = path.join(rootDir, relativeFilePath);
  if (!fs.existsSync(filePath)) {
    console.log(`[patch-better-sqlite3] File not found: ${relativeFilePath}`);
    return;
  }

  let content = fs.readFileSync(filePath, 'utf8');
  if (content.includes(replacement)) {
    console.log(`[patch-better-sqlite3] Already patched: ${relativeFilePath}`);
    return;
  }

  if (!content.includes(target)) {
    console.warn(`[patch-better-sqlite3] Target pattern not found in: ${relativeFilePath}`);
    return;
  }

  content = content.replace(target, replacement);
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`[patch-better-sqlite3] Successfully patched: ${relativeFilePath}`);
}

// 1. Patch macros.cpp
patchFile(
  'node_modules/better-sqlite3/src/util/macros.cpp',
  '#define OnlyAddon static_cast<Addon*>(info.Data().As<v8::External>()->Value())',
  `#if defined(V8_MAJOR_VERSION) && V8_MAJOR_VERSION >= 13
#define OnlyAddon static_cast<Addon*>(info.Data().As<v8::External>()->Value(v8::kExternalPointerTypeTagDefault))
#else
#define OnlyAddon static_cast<Addon*>(info.Data().As<v8::External>()->Value())
#endif`
);

// 2. Patch better_sqlite3.cpp
patchFile(
  'node_modules/better-sqlite3/src/better_sqlite3.cpp',
  '\tv8::Local<v8::External> data = v8::External::New(isolate, addon);',
  `#if defined(V8_MAJOR_VERSION) && V8_MAJOR_VERSION >= 13
	v8::Local<v8::External> data = v8::External::New(isolate, addon, v8::kExternalPointerTypeTagDefault);
#else
	v8::Local<v8::External> data = v8::External::New(isolate, addon);
#endif`
);

// 3. Patch helpers.cpp
patchFile(
  'node_modules/better-sqlite3/src/util/helpers.cpp',
  `\trecv->InstanceTemplate()->SetNativeDataProperty(
\t\tInternalizedFromLatin1(isolate, name),
\t\tfunc,
\t\t0,
\t\tdata
\t);`,
  `\trecv->InstanceTemplate()->SetNativeDataProperty(
\t\tInternalizedFromLatin1(isolate, name),
\t\tfunc,
\t\tnullptr,
\t\tdata
\t);`
);
