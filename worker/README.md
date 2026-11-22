# VCC Listing Worker

Replaces the GitHub Pages build (`build-listing.yml`) with a Cloudflare
Worker that generates `index.json` on demand from GitHub releases.

- `src/index.ts` — the Worker (TypeScript, no build step)
- `wrangler.toml` — Worker + KV + static assets config
- `../Website/` — the landing page, served as static assets

## How caching works

Everything is cached in one KV namespace (`LISTING_CACHE`):

| Key | TTL | Contents |
|---|---|---|
| `index` | 60s | The finished `index.json` — at most ~1 GitHub refresh/min |
| `index:stale` | never | Last good listing, served if GitHub is down |
| `pkgmeta` | 1h | Installer `package.json` from `main` |
| `sha256:<ver>` | 30d | Release asset hashes (immutable, hashed once ever) |

Per cache miss the Worker makes **one** GitHub API call (releases list)
plus asset downloads only for versions not yet hashed — release asset
downloads don't count against the API rate limit.

## CI deploy

`.github/workflows/deploy-worker.yml` deploys automatically on every push
to `worker/**` (and via manual dispatch). Repo secrets required:

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | API token with **Workers Scripts: Edit** on your account |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID (dashboard → Workers overview, right sidebar) |
| `LISTING_GITHUB_PAT` | Fine-grained PAT, read-only contents on `FTTristans-Creations/CCKAdvanced` — synced into the Worker as `GITHUB_TOKEN` on each deploy |

The KV namespace id still has to be created once by hand and pasted into
`wrangler.toml` — CI can't invent it:

```bash
wrangler kv namespace create LISTING_CACHE   # paste id into wrangler.toml, commit
```

## Manual deploy (alternative)

```bash
cd worker
npm i -g wrangler   # or use npx wrangler
wrangler login

# 1. Create the KV namespace and paste its id into wrangler.toml
wrangler kv namespace create LISTING_CACHE

# 2. GitHub token (optional locally; CI syncs it from LISTING_GITHUB_PAT)
wrangler secret put GITHUB_TOKEN

# 3. Deploy
wrangler deploy
```

The Worker is then live at `https://fttristan-vcc-listing.<account>.workers.dev`
(or attach a custom domain / route in the Cloudflare dashboard).

Point VCC at `https://<your-worker-url>/index.json` as the listing URL.

## Adding another package/repo later

Edit `REPO`, `PACKAGE_NAME`, and `PKG_JSON_URL` in `src/index.ts` — or
extend `buildIndex` to loop over a repo list. The per-version metadata
currently comes from the installer's `package.json` on `main`.

## Retiring the Pages build

Once the Worker URL is live and verified in VCC, the
`build-listing.yml` workflow and Pages deployment in this repo can be
disabled — the `schedule`/`push` triggers can simply be removed, or the
workflow file deleted.
