import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

// from '...'、import '...'、import('...')、require('...') のどの書き方でも検出する
const IMPORTS_OF = (target) => new RegExp(`(?:from\\s+|import\\s*\\(?\\s*|require\\s*\\(\\s*)['"\`][^'"\`]*(?:${target})`);
const FORBIDDEN = IMPORTS_OF(`infrastructure|lib/supabase|/supabase['"\`]|@supabase/`);

test('screens and components reach data only through the container', () => {
  for (const file of [...sourceFiles('src/app'), ...sourceFiles('src/components')]) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), FORBIDDEN, file);
  }
});

test('the domain and repository layers do not depend on the implementations', () => {
  for (const file of [...sourceFiles('src/domain'), ...sourceFiles('src/repositories')]) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, FORBIDDEN, file);
    assert.doesNotMatch(source, /from\s+['"]react/, file);
  }
});

test('the import check catches every way of loading a module', () => {
  for (const source of [
    "import { x } from '../infrastructure/supabase/client';",
    "import '../infrastructure/supabase/client';",
    "const x = await import('../infrastructure/supabase/client');",
    "const x = require('../infrastructure/supabase/client');",
  ]) {
    assert.match(source, FORBIDDEN, source);
  }
});

test('only the container and the auth files read the implementations', () => {
  const imports = sourceFiles('src')
    .filter((file) => !file.includes('src/infrastructure'))
    .filter((file) => IMPORTS_OF('infrastructure').test(readFileSync(file, 'utf8')))
    .sort();
  assert.deepEqual(imports, ['src/lib/auth.tsx', 'src/lib/authActions.ts', 'src/lib/container.ts']);
});

test('the auth files read only the client', () => {
  for (const file of ['src/lib/auth.tsx', 'src/lib/authActions.ts']) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), IMPORTS_OF('infrastructure/supabase/(?!client)'), file);
  }
});
