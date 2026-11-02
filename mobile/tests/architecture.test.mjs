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

const FORBIDDEN = /from\s+['"][^'"]*(infrastructure|lib\/supabase|\/supabase['"]|@supabase\/)/;

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

test('only the container picks the implementations', () => {
  const imports = sourceFiles('src')
    .filter((file) => !file.includes('src/infrastructure'))
    .filter((file) => /from\s+['"][^'"]*infrastructure\/supabase\/\w+Repository/.test(readFileSync(file, 'utf8')));
  assert.deepEqual(imports, ['src/lib/container.ts']);
});
