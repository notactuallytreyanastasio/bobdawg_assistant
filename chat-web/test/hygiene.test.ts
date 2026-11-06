// Repository hygiene tests. These scan the package itself rather than the chat page, so
// the two promises that shape it - no broad type, and no platform access inside src -
// fail a build when broken. The mirror rule keeps every module facing its own test.
//
// The forbidden spellings are assembled from pieces so this file cannot match its own
// patterns.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

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

// No module under src owns platform access: the page reaches the network through fetch,
// which is a browser global, and the entry point only mounts React. A node: import inside
// src would mean a module the browser cannot run.
const NON_PURE: readonly string[] = [];

// The entry point has no test behind it: it reads index.html's #root and mounts the app,
// and the app behind it is tested through its own props. The ambient declaration for the
// build tool's import.meta.env holds no code to test either.
const NON_MIRRORED_SRC: readonly string[] = ['src/main.tsx', 'src/vite-env.d.ts'];

// This suite checks the package instead of a runtime module, so it has no mirror.
const NON_MIRRORED_TEST: readonly string[] = ['test/hygiene.test.ts'];

const EXTENSIONS = ['.ts', '.tsx'];

function filesUnder(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(PACKAGE, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      for (const nested of filesUnder(path)) {
        found.push(nested);
      }
    } else if (entry.isFile() && EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
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

function excluded(path: string, owners: readonly string[]): boolean {
  return owners.some((owner) => path === owner || path.startsWith(`${owner}/`));
}

// src/chat/sse.ts and test/chat/sse.test.tsx share the base test/chat/sse, so the mirror
// is found whether either side is written as .ts or .tsx.
function baseOf(path: string, from: string, to: string): string {
  return path.replace(new RegExp(`^${from}/`), `${to}/`).replace(/\.(test\.)?tsx?$/, '');
}

function suitesFor(modulePath: string): string[] {
  const base = baseOf(modulePath, 'src', 'test');
  return [`${base}.test.ts`, `${base}.test.tsx`];
}

function modulesFor(testPath: string): string[] {
  const base = baseOf(testPath, 'test', 'src');
  return [`${base}.ts`, `${base}.tsx`];
}

function violationsOf(
  paths: readonly string[],
  describe: (line: string) => string | null,
): string[] {
  const violations: string[] = [];
  for (const path of paths) {
    const lines = (readOrMiss(path) ?? '').split('\n');
    for (const [index, line] of lines.entries()) {
      const violation = describe(line);
      if (violation !== null) violations.push(`${path}:${index + 1} ${violation}`);
    }
  }
  return violations;
}

it('no file in the package mentions the broad type or a suppression', () => {
  const paths = [...filesUnder('src'), ...filesUnder('test')];
  expect(paths.length > 0).toBe(true);
  const violations = violationsOf(paths, (line) => {
    for (const forbidden of FORBIDDEN) {
      if (forbidden.pattern.test(line)) return forbidden.label;
    }
    return null;
  });
  expect(violations).toEqual([]);
});

it('the browser code reads nothing from the platform', () => {
  const paths = filesUnder('src').filter((path) => !excluded(path, NON_PURE));
  expect(paths.length > 0).toBe(true);
  const violations = violationsOf(paths, (line) =>
    /from\s*['"]node:/.test(line) || /require\s*\(/.test(line) ? 'platform access' : null,
  );
  expect(violations).toEqual([]);
});

it('every module faces its own test', () => {
  const modules = filesUnder('src').filter((path) => !excluded(path, NON_MIRRORED_SRC));
  const missing: string[] = [];
  for (const module of modules) {
    const suites = suitesFor(module);
    if (suites.every((suite) => readOrMiss(suite) === null)) missing.push(`${module} has no ${suites[0]}`);
  }
  expect(missing).toEqual([]);
});

it('every test suite faces its own module', () => {
  const suites = filesUnder('test')
    .filter((path) => path.includes('.test.'))
    .filter((path) => !excluded(path, NON_MIRRORED_TEST));
  const orphans: string[] = [];
  for (const suite of suites) {
    const modules = modulesFor(suite);
    if (modules.every((module) => readOrMiss(module) === null)) orphans.push(`${suite} has no ${modules[0]}`);
  }
  expect(orphans).toEqual([]);
});
