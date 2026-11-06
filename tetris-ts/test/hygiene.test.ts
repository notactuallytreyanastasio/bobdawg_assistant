/**
 * Repository hygiene tests. These scan the repository itself rather than the
 * game, so the two promises that shape the codebase - the forbidden broad type
 * and no platform access inside the runtime tree - fail a build when broken.
 *
 * The forbidden spellings are assembled from pieces so this file cannot match
 * its own patterns.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = join(HERE, '..');

const ANY = 'a' + 'ny';

type Forbidden = {
  readonly label: string;
  readonly pattern: RegExp;
};

const FORBIDDEN: readonly Forbidden[] = [
  { label: 'type annotation', pattern: new RegExp(':\\s*' + ANY + '\\b') },
  { label: 'type assertion', pattern: new RegExp('\\bas\\s+' + ANY + '\\b') },
  { label: 'generic argument', pattern: new RegExp('<\\s*' + ANY + '\\s*[>,]') },
  { label: 'union member', pattern: new RegExp('\\b' + ANY + '\\s*\\|') },
  { label: 'array element', pattern: new RegExp('\\b' + ANY + '\\s*\\[\\s*\\]') },
  { label: 'suppressed type error', pattern: /@ts-(ignore|expect-error|nocheck)/ },
];

// The entry point and the terminal owner are the layers allowed to reach the
// platform; every other module under src must stay a pure data module.
const NON_PURE: readonly string[] = ['src/main.ts', 'src/render/term.ts'];

// This suite checks the repository instead of a runtime module, so it has no
// mirror in the runtime tree.
const NON_MIRRORED: readonly string[] = ['test/hygiene.test.ts'];

function filesUnder(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(PACKAGE, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      for (const nested of filesUnder(path)) {
        found.push(nested);
      }
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      found.push(path);
    }
  }
  return found.sort();
}

function readOrMiss(path: string): string | null {
  try {
    return readFileSync(join(PACKAGE, path), 'utf8');
  } catch {
    return null;
  }
}

function isPureModule(path: string): boolean {
  return !NON_PURE.some((excluded: string): boolean => {
    return path === excluded || path.startsWith(`${excluded}/`);
  });
}

function testPathFor(modulePath: string): string {
  return modulePath.replace(/^src\//, 'test/').replace(/\.ts$/, '.test.ts');
}

function modulePathFor(testPath: string): string {
  return testPath.replace(/^test\//, 'src/').replace(/\.test\.ts$/, '.ts');
}

test('no file in the repository mentions the broad type or a suppression', () => {
  const paths: readonly string[] = [...filesUnder('src'), ...filesUnder('test')];
  assert.equal(paths.length > 0, true, 'the scan must see the repository');
  const violations: string[] = [];
  for (const path of paths) {
    const text = readOrMiss(path) ?? '';
    const lines = text.split('\n');
    for (const forbidden of FORBIDDEN) {
      for (let index = 0; index < lines.length; index = index + 1) {
        if (forbidden.pattern.test(lines[index] ?? '')) {
          violations.push(`${path}:${index + 1} ${forbidden.label}`);
        }
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('the runtime tree reads nothing from the platform', () => {
  const paths = filesUnder('src').filter(isPureModule);
  assert.equal(paths.length > 0, true, 'the runtime tree must exist');
  const violations: string[] = [];
  for (const path of paths) {
    const text = readOrMiss(path) ?? '';
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index = index + 1) {
      const line = lines[index] ?? '';
      if (/from\s*['"]node:/.test(line) || /require\s*\(/.test(line)) {
        violations.push(`${path}:${index + 1} platform access`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('every runtime module has a test module at the mirrored path', () => {
  const modules = filesUnder('src').filter(isPureModule);
  const missing: string[] = [];
  for (const module of modules) {
    const expected = testPathFor(module);
    if (readOrMiss(expected) === null) {
      missing.push(`${module} has no ${expected}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('every test suite mirrors a runtime module', () => {
  const suites = filesUnder('test')
    .filter((path: string): boolean => path.endsWith('.test.ts'))
    .filter((path: string): boolean => !NON_MIRRORED.includes(path));
  const orphans: string[] = [];
  for (const suite of suites) {
    const candidate = modulePathFor(suite);
    if (readOrMiss(candidate) === null) {
      orphans.push(`${suite} has no ${candidate}`);
    }
  }
  assert.deepEqual(orphans, []);
});
