// VCC package listing Worker.
//
// Serves the static landing page from ./Website (wrangler assets binding)
// and generates index.json on demand from GitHub releases, so the listing
// is never staler than LISTING_TTL seconds without a rebuild.
//
// Caching strategy (all in KV, one namespace):
//   index            -> the finished listing JSON, expires after 60s
//   index:stale      -> last good listing, never expires (error fallback)
//   pkgmeta          -> installer package.json from main, expires hourly
//   sha256:<version> -> asset hash, kept ~30 days (release assets are immutable)
//
// Worst case GitHub traffic is one releases API call per 60s plus asset
// downloads only for versions not yet hashed.

const REPO = "FTTristans-Creations/CCKAdvanced";
const PACKAGE_NAME = "com.fttristan.cck-advanced.installer";
const PKG_JSON_URL =
  `https://raw.githubusercontent.com/${REPO}/main/installer/com.fttristan.cck-advanced.installer/package.json`;
const LISTING_ID = "com.fttristan.vpm";
const LISTING_NAME = "FTTristan's VRChat Packages";

const LISTING_TTL = 60;            // seconds; ~1 GitHub refresh per minute max
const META_TTL = 60 * 60;          // package.json metadata
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
  const meta = await getJson(env, "pkgmeta", PKG_JSON_URL, META_TTL);
  const releases = await getReleases(env);

  const entries = await Promise.all(
    releases
      .filter((r) => !r.draft)
      .map(async (rel) => {
        const version = String(rel.tag_name ?? rel.name ?? "").replace(/^v/, "");
        if (!version) return null;
        const asset = (rel.assets ?? []).find(
          (a: { name?: string }) => a.name === `com.fttristan.cck-advanced-installer-${version}.zip`
        );
        if (!asset?.browser_download_url) return null;
        const sha = await getSha256(env, version, asset.browser_download_url);
        return [
          version,
          {
            name: PACKAGE_NAME,
            displayName: meta.displayName,
            version,
            unity: meta.unity,
            description: meta.description,
            dependencies: meta.dependencies ?? {},
            vpmDependencies: meta.vpmDependencies ?? {},
            changelogUrl: meta.changelogUrl,
            author: meta.author,
            documentationUrl: meta.documentationUrl,
            keywords: meta.keywords ?? [],
            unityRelease: meta.unityRelease,
            zipSHA256: sha,
            url: asset.browser_download_url,
          },
        ] as const;
      })
  );

  const versions: Record<string, unknown> = {};
  for (const entry of entries) {
    if (entry) versions[entry[0]] = entry[1];
  }

  const origin = new URL(request.url).origin;
  return JSON.stringify({
    name: LISTING_NAME,
    author: "FTTristan",
    url: `${origin}/index.json`,
    id: LISTING_ID,
    packages: {
      [PACKAGE_NAME]: { versions },
    },
  });
}

async function getReleases(env: Env): Promise<any[]> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "fttristan-vcc-listing",
  };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;

  const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100`, { headers });
  if (!res.ok) throw new Error(`GitHub releases: HTTP ${res.status}`);
  return res.json();
}

async function getJson(env: Env, key: string, url: string, ttl: number): Promise<any> {
  const hit = await env.LISTING_CACHE.get(key, "text");
  if (hit) return JSON.parse(hit);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const text = await res.text();
  await env.LISTING_CACHE.put(key, text, { expirationTtl: ttl });
  return JSON.parse(text);
}

async function getSha256(env: Env, version: string, downloadUrl: string): Promise<string> {
  const key = `sha256:${version}`;
  const hit = await env.LISTING_CACHE.get(key);
  if (hit) return hit;

  const res = await fetch(downloadUrl);
  if (!res.ok) throw new Error(`asset ${version}: HTTP ${res.status}`);
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
