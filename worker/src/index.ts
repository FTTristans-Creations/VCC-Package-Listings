// VCC package listing Worker.
//
// Serves the static landing page from ./Website (wrangler assets binding)
// and generates index.json on demand from GitHub, driven by source.json
// (copied into Website/ at deploy time, so it is served as a static asset).
//
// Mirrors vrchat-community/package-list-action (PackageBuilder/Build.cs):
// for every repo in source.json's githubRepos it scans release assets for
// zips that look like VPM packages, downloads each candidate zip, and reads
// package.json from the ZIP ROOT — zips without one are skipped, exactly
// like upstream. All listing metadata therefore comes from the packaged
// manifest, not the repo's package.json on the default branch.
//
// Repo manifests are still discovered via the GitHub tree API, but only as
// a candidate-name filter: upstream downloads EVERY .zip asset (including
// huge payload archives), which is not viable per-request. A zip is a
// candidate when its filename starts with "{pkgname}-" (dots or dashes)
// followed by a digit — matching the "{name}-{version}.zip" convention.
//
// Caching (one KV namespace):
//   index                  -> finished listing JSON, expires after 60s
//   index:stale            -> last good listing, never expires
//   repometa:{repo}        -> repo default branch, 1h
//   manifests:{repo}:{br}  -> discovered package.json manifests, 1h
//   asset:{url}            -> { sha256, manifest } for a release zip, ~30d
//
// Worst case GitHub traffic is ~1 releases call per repo per minute plus
// tree/raw fetches only when the hourly manifest cache expires.

import { unzipSync, strFromU8 } from "fflate";

const LISTING_TTL = 60;            // seconds; ~1 GitHub refresh per minute max
const META_TTL = 60 * 60;          // repo meta + manifests
const ASSET_TTL = 60 * 60 * 24 * 30; // 30 days; release assets are immutable

interface Env {
  LISTING_CACHE: KVNamespace;
  ASSETS: Fetcher;
  GITHUB_TOKEN?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/index.json") {
      return handleIndex(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};

async function handleIndex(request: Request, env: Env): Promise<Response> {
  const cached = await env.LISTING_CACHE.get("index", "text");
  if (cached) {
    return json(cached, { "X-Listing-Cache": "hit" });
  }

  try {
    const body = await buildIndex(request, env);
    // Stale copy first: if a later build fails, errors still serve something.
    await env.LISTING_CACHE.put("index:stale", body);
    await env.LISTING_CACHE.put("index", body, { expirationTtl: LISTING_TTL });
    return json(body, { "X-Listing-Cache": "miss" });
  } catch (err) {
    const stale = await env.LISTING_CACHE.get("index:stale", "text");
    if (stale) {
      return json(stale, { "X-Listing-Cache": "stale", "X-Listing-Error": String(err) });
    }
    return json(JSON.stringify({ error: String(err) }), { status: 502 });
  }
}

async function buildIndex(request: Request, env: Env): Promise<string> {
  const cfg = await getSourceConfig(request, env);
  const repos: string[] = cfg.githubRepos ?? [];

  const packages: Record<string, { versions: Record<string, unknown> }> = {};
  for (const repo of repos) {
    const branch = await getDefaultBranch(env, repo);
    const manifests = await getManifests(env, repo, branch);
    const releases = await getReleases(env, repo);

    for (const rel of releases) {
      if (rel.draft) continue;
      const tagVersion = String(rel.tag_name ?? rel.name ?? "").replace(/^v/, "");
      if (!tagVersion) continue;

      // Candidate zips across every known package name, deduped by URL.
      const candidates = new Map<string, string>();
      for (const m of manifests) {
        for (const asset of rel.assets ?? []) {
          if (typeof asset?.browser_download_url !== "string") continue;
          if (!isCandidateZip(asset.name, m.name)) continue;
          candidates.set(asset.browser_download_url, asset.name);
        }
      }

      for (const url of candidates.keys()) {
        const info = await getAssetInfo(env, url);
        const pkg = info?.manifest;
        // Upstream skips zips with no package.json at the root.
        if (!pkg || typeof pkg.name !== "string" || !pkg.name) continue;

        // Upstream uses the manifest's own version field; fall back to the
        // release tag when the packaged manifest omits it.
        const version = String(pkg.version || tagVersion);
        const entry: Record<string, unknown> = {
          name: pkg.name,
          displayName: pkg.displayName,
          version,
          unity: pkg.unity,
          description: pkg.description,
          dependencies: pkg.dependencies ?? {},
          vpmDependencies: pkg.vpmDependencies ?? {},
          changelogUrl: pkg.changelogUrl,
          author: pkg.author,
          documentationUrl: pkg.documentationUrl,
          keywords: pkg.keywords ?? [],
          unityRelease: pkg.unityRelease,
          zipSHA256: info.sha256,
          url,
        };
        // Drop undefined fields so the JSON matches the upstream shape.
        for (const k of Object.keys(entry)) {
          if (entry[k] === undefined) delete entry[k];
        }

        const group = packages[pkg.name] ?? (packages[pkg.name] = { versions: {} });
        group.versions[version] = entry;
      }
    }
  }

  const origin = new URL(request.url).origin;
  return JSON.stringify({
    name: cfg.name,
    author: typeof cfg.author === "string" ? cfg.author : cfg.author?.name,
    url: `${origin}/index.json`,
    id: cfg.id,
    packages,
  });
}

// The listing's own config, served as a static asset (deploy copies
// source.json into Website/). Not cached in KV: asset fetches are cheap
// and this way config changes take effect on the next deploy.
async function getSourceConfig(request: Request, env: Env): Promise<any> {
  const assetUrl = new URL("/source.json", request.url).toString();
  const res = await env.ASSETS.fetch(new Request(assetUrl));
  if (!res.ok) throw new Error(`source.json asset: HTTP ${res.status}`);
  return res.json();
}

async function github(env: Env, path: string): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "fttristan-vcc-listing",
  };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  return fetch(`https://api.github.com${path}`, { headers });
}

async function getDefaultBranch(env: Env, repo: string): Promise<string> {
  const key = `repometa:${repo}`;
  const hit = await env.LISTING_CACHE.get(key, "text");
  if (hit) return JSON.parse(hit).default_branch ?? "main";

  const res = await github(env, `/repos/${repo}`);
  if (!res.ok) throw new Error(`repo ${repo}: HTTP ${res.status}`);
  const info = await res.json();
  await env.LISTING_CACHE.put(key, JSON.stringify(info), { expirationTtl: META_TTL });
  return info.default_branch ?? "main";
}

interface Manifest { name: string; pkg: any }

// Every package.json in the repo that looks like a VPM package (name starts
// com.). Used only to generate candidate zip names — the authoritative
// manifest comes from inside each zip, like upstream. Cached for an hour.
async function getManifests(env: Env, repo: string, branch: string): Promise<Manifest[]> {
  const key = `manifests:${repo}:${branch}`;
  const hit = await env.LISTING_CACHE.get(key, "text");
  if (hit) return JSON.parse(hit);

  const treeRes = await github(env, `/repos/${repo}/git/trees/${branch}?recursive=1`);
  if (!treeRes.ok) throw new Error(`tree ${repo}@${branch}: HTTP ${treeRes.status}`);
  const tree = await treeRes.json();

  const manifests: Manifest[] = [];
  for (const entry of tree.tree ?? []) {
    if (entry.type !== "blob") continue;
    const p = entry.path as string;
    if (!(p === "package.json" || p.endsWith("/package.json"))) continue;
    if (p.includes("node_modules") || p.startsWith("Library/")) continue;

    try {
      const raw = await fetch(`https://raw.githubusercontent.com/${repo}/${branch}/${p}`);
      if (!raw.ok) continue;
      const pkg = await raw.json();
      if (typeof pkg?.name === "string" && pkg.name.startsWith("com.")) {
        manifests.push({ name: pkg.name, pkg });
      }
    } catch {
      // A malformed manifest shouldn't sink the whole listing.
    }
  }

  await env.LISTING_CACHE.put(key, JSON.stringify(manifests), { expirationTtl: META_TTL });
  return manifests;
}

async function getReleases(env: Env, repo: string): Promise<any[]> {
  const res = await github(env, `/repos/${repo}/releases?per_page=100`);
  if (!res.ok) throw new Error(`releases ${repo}: HTTP ${res.status}`);
  return res.json();
}

// A zip is a package candidate when its normalized name starts with the
// normalized package name followed by a digit. Normalization strips dots
// and dashes because release pipelines name zips inconsistently — e.g.
// com.fttristan.cck-advanced.installer ships as
// "com.fttristan.cck-advanced-installer-0.2.4.zip". The digit requirement
// keeps sibling artifacts like "com.fttristan.cck-advanced-payload-..."
// from matching the shorter "com.fttristan.cck-advanced" package name.
// False positives are harmless: the zip's own package.json decides what
// actually gets listed.
function isCandidateZip(assetName: string, pkgName: string): boolean {
  if (typeof assetName !== "string" || !assetName.endsWith(".zip")) return false;
  const norm = (s: string) => s.toLowerCase().replace(/[.-]/g, "");
  const a = norm(assetName);
  const p = norm(pkgName);
  if (!p || !a.startsWith(p)) return false;
  const next = a.charAt(p.length);
  return next >= "0" && next <= "9";
}

interface AssetInfo { sha256: string; manifest: any }

// Downloads a release zip once, computes its SHA-256 (what VCC verifies)
// and extracts package.json from the zip root — the same two things
// HashZipAndReturnManifest does in Build.cs. Cached ~30d: release assets
// are immutable, so each zip is fetched at most once ever.
async function getAssetInfo(env: Env, url: string): Promise<AssetInfo | null> {
  const key = `asset:${url}`;
  const hit = await env.LISTING_CACHE.get(key, "text");
  if (hit) return JSON.parse(hit);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`asset ${url}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());

  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");

  let manifest: any = null;
  try {
    // unzipSync is tolerant of the zip64 / data-descriptor variants GitHub
    // release zips use; a missing or corrupt package.json just yields null.
    const files = unzipSync(bytes);
    const raw = files["package.json"];
    if (raw) manifest = JSON.parse(strFromU8(raw));
  } catch {
    manifest = null;
  }

  const info: AssetInfo = { sha256, manifest };
  // Cache misses (no manifest) too — otherwise every rebuild would
  // re-download payload zips that will never become packages.
  await env.LISTING_CACHE.put(key, JSON.stringify(info), { expirationTtl: ASSET_TTL });
  return info;
}

function json(body: string, extraHeaders: Record<string, string> = {}): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=30",
      ...extraHeaders,
    },
  });
}
