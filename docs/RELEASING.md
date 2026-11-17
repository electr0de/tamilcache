# Releasing

Maintainer notes. Running it: [`DEPLOYMENT.md`](DEPLOYMENT.md). Changing it:
[`DEVELOPMENT.md`](DEVELOPMENT.md). Contributing: [`CONTRIBUTING.md`](../CONTRIBUTING.md).

The published repository is **one squashed commit**, produced from this one. Two things flow from
that:

- `master` is the development history and stays private. It also holds a few working-note paths
  that are excluded from commits via `.git/info/exclude`; they are never published.
- `public` is the snapshot branch: a single commit whose tree is identical to `master`'s tree
  minus the excluded files. That branch is what gets pushed to GitHub as `main`.

## First-time setup (once)

```bash
# 1. Create the repo on GitHub, EMPTY and PRIVATE. No README, no licence, no .gitignore.
#    Private first is deliberate: you get to see CI pass and inspect the tree before it is public.

# 2. Push the snapshot as the default branch.
git remote add origin git@github.com:electr0de/tamilcache.git
git push origin public:main                      # only works while the repo is EMPTY

# 3. Watch CI (Actions → ci). The leak gate runs first, so a leak fails before anything is built.
#    The publish workflow runs on the same push and creates the image in GHCR.

# 4. Flip the repository public: Settings → General → Danger Zone → Change visibility.

# 5. Flip the CONTAINER PACKAGE public: your profile → Packages → tamilcache →
#    Package settings → Change visibility → Public.
#    This is separate from the repo and is the step everyone forgets: without it
#    `docker compose up` fails with `denied` / `manifest unknown` for every reader,
#    because packages are private by default.

# 6. Cut the first release (publishes semver image tags, not just latest/sha-):
git tag v0.1.0 public
git push origin v0.1.0
```

Verify as a stranger would — no credentials, no local image:

```bash
docker logout ghcr.io
docker pull ghcr.io/electr0de/tamilcache:0.1.0
cd /tmp && mkdir smoke && cd smoke
curl -fsSL https://raw.githubusercontent.com/electr0de/tamilcache/main/docker-compose.yml -o docker-compose.yml
docker compose up -d && sleep 25 && curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8484/
```

## Routine release

```bash
git checkout master && git merge --no-ff <feature-branch>
pnpm -r build && npx vitest run && pnpm -r typecheck && pnpm check:leaks    # must all be green
```

Then regenerate the snapshot and push it. **Regenerating is the fiddly part:**

```bash
git branch -D public                   # the old snapshot; its commit stays reachable by SHA
git checkout --orphan public
git rm -r -q --cached .               # MANDATORY — see below
git add -A
# nothing you have locally excluded may be staged; this must print nothing:
git diff --cached --name-only -z | xargs -0 -r git check-ignore --no-index --
GIT_AUTHOR_NAME=electr0de GIT_AUTHOR_EMAIL=electr0de@users.noreply.github.com \
GIT_COMMITTER_NAME=electr0de GIT_COMMITTER_EMAIL=electr0de@users.noreply.github.com \
  git commit -m "<message>"
git checkout master
# sanity checks before pushing:
git diff --stat public master        # must be empty
git ls-tree -r --name-only public | wc -l    # 241 at the time of writing
git push origin public:main
```

`git rm -r --cached .` is not optional: **`--orphan` keeps the index**, so `git add -A` alone
re-commits every previously-tracked file, `.git/info/exclude` notwithstanding. Verified on a
scratch repo — without it, the first attempt published the locally-excluded working notes.

The handle identity is set on the `git commit` above, so the personal address never enters the
published history. If a commit did land with the wrong identity, `--amend --reset-author` is
required — a plain `--amend` keeps the **original** author:

```bash
GIT_AUTHOR_NAME=electr0de GIT_AUTHOR_EMAIL=electr0de@users.noreply.github.com \
GIT_COMMITTER_NAME=electr0de GIT_COMMITTER_EMAIL=electr0de@users.noreply.github.com \
git commit --amend --no-edit --reset-author
```

### Version tags

| command | image tags produced |
|---|---|
| push to `main` | `latest`, `main`, `sha-<short>` |
| `git tag v1.2.3 && git push origin v1.2.3` | `1.2.3`, `1.2`, `1`, plus the above |

The CI/publish workflows trigger on `main` **and** `master`, because this repo's default branch is
`master` while the public repo's is `main`. A `main`-only trigger silently never runs here — the
gate would be green by absence and the image would never be pushed.

## What the workflows do

| file | trigger | steps |
|---|---|---|
| `.github/workflows/ci.yml` | push to main/master, PRs | `check:leaks` → `-r build` → `vitest run` → `-r typecheck` |
| `.github/workflows/publish.yml` | push to main/master, `v*` tags, manual | buildx, `linux/amd64`, push to GHCR with `type=gha` cache, SBOM + provenance |

No secrets are stored: `GITHUB_TOKEN` plus `permissions: packages: write` is the whole
authentication. Pushing by hand needs a classic PAT with `write:packages`:

```bash
echo "$PAT" | docker login ghcr.io -u electr0de --password-stdin
```

Images are `linux/amd64` only — Unraid and the realistic self-hosting targets are x86_64, and an
arm64 build would need QEMU for users this project does not have. Adding it means a `platforms:`
line and a slower pipeline, nothing else.

## Pre-publish checklist

- [ ] `pnpm -r build && npx vitest run && pnpm -r typecheck` green on `master` after the merge
- [ ] `pnpm check:leaks` clean **on the `public` branch**, not only on `master`
- [ ] nothing excluded is present: `git ls-tree -r --name-only public -z | xargs -0 -r git check-ignore --no-index` prints nothing
- [ ] `git log --format='%ae' public` shows only `electr0de@users.noreply.github.com`
- [ ] the diff `public..master` is empty
- [ ] the GHCR package is public, and `docker logout ghcr.io && docker pull …:latest` succeeds
