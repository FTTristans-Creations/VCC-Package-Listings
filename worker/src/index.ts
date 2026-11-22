// VCC package listing Worker.
//
// Serves the static landing page from ./Website (wrangler assets binding)
// and generates index.json on demand from GitHub, driven by source.json
// (copied into Website/ at deploy time, so it is served as a static asset).
//
// For every repo in source.json's githubRepos the Worker discovers all
// package.json manifests via the GitHub tree API, then lists a package
// version for each release that ships a matching "{name}-{version}.zip"
// asset (dots in the package name may appear as dashes — both are tried).
//
// Caching (one KV namespace):
//   index                  -> finished listing JSON, expires after 60s
//   index:stale            -> last good listing, never expires
//   repometa:{repo}        -> repo default branch, 1h
//   manifests:{repo}:{br}  -> discovered package.json manifests, 1h
//   sha256:{url}           -> release asset hash, ~30d (immutable)
//
// Worst case GitHub traffic is ~1 releases call per repo per minute plus
// tree/raw fetches only when the hourly manifest cache expires.

const LISTING_TTL = 60;            // seconds; ~1 GitHub refresh per minute max
const META_TTL = 60 * 60;          // repo meta + manifests
const SHA_TTL = 60 * 60 * 24 * 30; // 30 days

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
      const version = String(rel.tag_name ?? rel.name ?? "").replace(/^v/, "");
      if (!version) continue;

      for (const m of manifests) {
        const asset = findAsset(rel.assets ?? [], m.name, version);
        if (!asset?.browser_download_url) continue;

        const sha = await getSha256(env, asset.browser_download_url);
        const pkg = packages[m.name] ?? (packages[m.name] = { versions: {} });
        pkg.versions[version] = {
          name: m.name,
          displayName: m.pkg.displayName,
          version,
          unity: m.pkg.unity,
          description: m.pkg.description,
          dependencies: m.pkg.dependencies ?? {},
          vpmDependencies: m.pkg.vpmDependencies ?? {},
          changelogUrl: m.pkg.changelogUrl,
          author: m.pkg.author,
          documentationUrl: m.pkg.documentationUrl,
          keywords: m.pkg.keywords ?? [],
          unityRelease: m.pkg.unityRelease,
          zipSHA256: sha,
          url: asset.browser_download_url,
        };
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
// com.). Cached for an hour: manifests change far less often than releases.
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

// Release zips are named after the package with dots turned into dashes
// (com.fttristan.cck-advanced.installer -> com.fttristan.cck-advanced-installer-1.2.3.zip),
// but plain "{name}-{version}.zip" is a common convention too — try both.
function findAsset(assets: any[], name: string, version: string): any {
  const dashed = `${name.replace(/\./g, "-")}-${version}.zip`;
  const dotted = `${name}-${version}.zip`;
  return assets.find((a) => a.name === dashed) ?? assets.find((a) => a.name === dotted);
}

async function getSha256(env: Env, downloadUrl: string): Promise<string> {
  const key = `sha256:${downloadUrl}`;
  const hit = await env.LISTING_CACHE.get(key);
  if (hit) return hit;

  const res = await fetch(downloadUrl);
  if (!res.ok) throw new Error(`asset ${downloadUrl}: HTTP ${res.status}`);
  const digest = await crypto.subtle.digest("SHA-256", await res.arrayBuffer());
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  await env.LISTING_CACHE.put(key, hex, { expirationTtl: SHA_TTL });
  return hex;
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
