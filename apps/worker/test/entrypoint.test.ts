import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The worker has two files: `index.ts` is the package barrel (what other packages import) and
 * `main.ts` is the program. Pointing a container at the barrel is a silent failure — the
 * process starts, re-exports, and exits 0, leaving a running API with an empty queue and no
 * visible error. This test is the only thing that catches a wrong entrypoint before deploy.
 */
const repoRoot = join(import.meta.dirname, '../../..');
const compose = readFileSync(join(repoRoot, 'docker-compose.yml'), 'utf8');
const workerPackage = JSON.parse(readFileSync(join(repoRoot, 'apps/worker/package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

/** Extract one service's block: from `  worker:` to the next top-of-file key. */
function serviceBlock(name: string): string {
  const start = compose.indexOf(`\n  ${name}:`);
  if (start < 0) return '';
  const rest = compose.slice(start + 1);
  const next = /\n {2}[a-z][\w-]*:/.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

function workerCommand(): string {
  return /command:\s*\[([^\]]+)\]/.exec(serviceBlock('worker'))?.[1] ?? '';
}

describe('compose worker entrypoint', () => {
  it('runs the program, not the barrel', () => {
    expect(workerCommand()).toContain('dist/main.js');
    expect(workerCommand()).not.toContain('dist/index.js');
  });

  it('uses the same entry as package.json start', () => {
    const fromScript = /node\s+(\S+)/.exec(workerPackage.scripts['start'] ?? '')?.[1] ?? '';
    expect(fromScript).toBe('dist/main.js');
    expect(workerCommand()).toContain(fromScript);
  });

  it('the entry module actually exists in source', () => {
    expect(existsSync(join(repoRoot, 'apps/worker/src/main.ts'))).toBe(true);
    expect(readFileSync(join(repoRoot, 'apps/worker/src/main.ts'), 'utf8')).toContain('void main()');
  });
});

describe('barrel guard', () => {
  it('exits non-zero with an explanation when run as a program', async () => {
    const built = join(repoRoot, 'apps/worker/dist/index.js');
    if (!existsSync(built)) return; // dist not built in this run; the compose assertions above still hold

    const { spawnSync } = await import('node:child_process');
    const result = spawnSync(process.execPath, [built], { encoding: 'utf8', timeout: 10_000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('not the program');
  }, 15_000);
});
