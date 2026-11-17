# Contributing

Three different loops, three different documents. Pick the one you are in:

| you want to | read |
|---|---|
| **run** TamilCache on a server | [`README.md`](README.md) → [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) |
| **change** TamilCache locally | [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) — setup, dev loop, databases, commands |
| **contribute** a change back | this file |

Maintainers additionally: [`docs/RELEASING.md`](docs/RELEASING.md).

## The contributor loop

```bash
# 1. fork on GitHub, then
git clone git@github.com:<you>/tamilcache.git && cd tamilcache
pnpm install --prefer-offline && pnpm -r build      # see docs/DEVELOPMENT.md for why the build is first

# 2. one branch per change, off main
git checkout -b fix/parser-hq-hdrp

# 3. make the smallest change that fixes the thing, with a test that failed first
#    (docs/DEVELOPMENT.md has the loop, the commands and the databases)

# 4. the gate CI will run, in the same order
pnpm check:leaks
pnpm -r build
npx vitest run
pnpm -r typecheck

# 5. push and open a PR
git push -u origin fix/parser-hq-hdrp
```

Run those four commands bare, never piped through `grep`: the pipe's exit status hides the
command's, and that is how a failing typecheck gets merged.

## What gets a PR accepted

- **It does something the project wants.** Open an issue first for anything larger than a bug fix —
  a parser rewrite or a new provider is a design discussion, not a diff review.
- **A behavioural change has a test that failed before the change.** "I added a regression test"
  means nothing without the red run.
- **The gate is green** and `pnpm check:leaks` is clean.
- **Fixtures are honest.** If a captured page disagrees with the parser, the parser is wrong — never
  edit a fixture to make a test pass. After capturing a new one
  (`pnpm fixture:capture packages/shared/test/fixtures <url>...`) run `pnpm sanitize:fixtures` and
  commit the fixture *and* `synthetic-hashes.json` together.
- **No new dependency unless nothing in the tree does the job.** This project runs on eight
  production dependencies across four packages; that is a feature.
- **Docs move with behaviour.** A new env var, route or compose key without its line in the README
  table is an incomplete change.

## What will be pushed back on

- Silent error swallowing (`catch {}` around a fetch, a parse, a write) — say what happened or let it
  throw.
- Tests that assert a function was called instead of asserting an observable result.
- Speculative abstraction: a `Provider` interface with one implementation, config for something that
  never varies.
- UI changes verified only in jsdom. The empty/loading/error states are where the SPA breaks; check
  them in a browser.
- Bulk reformatting or dependency bumps mixed into a behavioural change.

## Code layout and its rules

| package | rule |
|---|---|
| `packages/shared` | pure functions only — no I/O, no database, no clock. Parser, token mapping, classifier, Torznab serialiser |
| `packages/db` | schema + the single `migrate()` authority. A schema change bumps `SCHEMA_VERSION` and adds an upgrade step |
| `apps/worker` | the only place that talks to the network or reads the clock |
| `apps/api` | HTTP only; reads the database, never crawls |
| `apps/web` | React; no business logic |

## Commit messages

One change per commit, conventional prefix (`feat:`, `fix:`, `test:`, `docs:`, `chore:`, `ci:`), and
a body that says **why** when the diff does not. Squash fixup commits before opening the PR; keep
refactors separate from behaviour changes.

## Review

Every PR gets a read of the surrounding code, not just the diff — data-integrity paths (migrations,
dedupe, coverage), failure paths (what happens when the site 403s, the provider 502s, the disk is
full) and any test that could pass for the wrong reason. Expect questions in that shape.
