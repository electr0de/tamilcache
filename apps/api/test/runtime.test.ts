import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';

const repo = join(import.meta.dirname, '../../..');
const read = (file: string): string => readFileSync(join(repo, file), 'utf8');

/**
 * The floor is Node 22.12, and the way you find out is 149 tests failing with a message about
 * `light-my-request` and `cookie`. It deserves a test that says what actually broke.
 */
describe('runtime floor', () => {
  it('can inject, which lazily requires the ESM-only cookie package', async () => {
    const app = Fastify({ logger: false });
    app.get('/', async () => ({ ok: true }));
    try {
      const response = await app.inject('/');
      expect(response.statusCode).toBe(200);
    } catch (error) {
      throw new Error(
        `fastify.inject() failed on ${process.version}. It lazily requires light-my-request, which ` +
          `require()s the ESM-only cookie@2 — that needs Node >= 22.12. This is the same code path ` +
          `every API test uses, so a runtime below the floor turns into ~149 unrelated failures.`,
        { cause: error },
      );
    } finally {
      await app.close();
    }
  }, 15_000);

  it('pins one Node patch for both the image and CI', () => {
    const docker = /^FROM node:([\d.]+)-slim/m.exec(read('Dockerfile'))?.[1];
    const ci = /node-version:\s*([\d.]+)/.exec(read('.github/workflows/ci.yml'))?.[1];

    expect(docker, 'Dockerfile FROM node:<patch>-slim').toBeDefined();
    expect(ci, 'ci.yml node-version').toBeDefined();
    // Drift here is how a red CI gets explained away as "works on my machine".
    expect(ci).toBe(docker);
  });

  it('declares an engine floor at or below the pinned patch', () => {
    const engines = JSON.parse(read('package.json')).engines.node as string;
    const floor = /(\d+)\.(\d+)/.exec(engines);
    expect(floor, engines).not.toBeNull();

    const docker = /^FROM node:([\d.]+)-slim/m.exec(read('Dockerfile'))?.[1] ?? '0.0.0';
    const [major, minor] = docker.split('.').map(Number) as [number, number, number];
    const [floorMajor, floorMinor] = [Number(floor?.[1]), Number(floor?.[2])];

    expect(major * 1000 + minor).toBeGreaterThanOrEqual(floorMajor * 1000 + floorMinor);
  });
});
