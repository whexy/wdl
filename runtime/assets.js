// Host-side ASSETS serving, shared by the pre-Worker path (gateway traffic and
// service-binding fetch into a default entrypoint) and env.ASSETS.fetch().
// Asset bytes come from an anonymous GET of the public-read asset origin, so
// no runtime holds ASSETS bucket credentials.

import {
  MAX_ASSETS_MANIFEST_BYTES,
  ifNoneMatchSatisfied,
  parseAssetsManifest,
  resolveAsset,
} from "shared-assets-manifest";
import { buildAssetUrl } from "runtime-lib";
import {
  proxyEndpoint,
  proxyFetch,
  requireRedisProxyBaseUrl,
} from "runtime-bindings-proxy";
import { errorMessage } from "shared-errors";
import { discardResponseBody } from "shared-respond";
import { streamS3Response, withS3Request } from "shared-s3-request";

/**
 * @typedef {import("shared-assets-manifest").AssetFiles} AssetFiles
 * @typedef {import("shared-assets-manifest").AssetEntry} AssetEntry
 * @typedef {{ files: AssetFiles, prefix: string | null }} AssetManifest
 * @typedef {{ ns: string, worker: string, version: string }} AssetIdentity
 * @typedef {{ waitUntil(promise: Promise<unknown>): void }} AssetsCtx
 * @typedef {{
 *   REDIS_PROXY_URL?: unknown,
 *   WDL_INTERNAL_AUTH_TOKEN?: unknown,
 *   ASSETS_ORIGIN_BASE?: unknown,
 *   ASSETS_CDN_BASE?: unknown,
 * }} AssetsEnv
 * @typedef {{ resolve(manifest: AssetManifest | null): void, reject(error: Error): void }} ManifestWaiter
 * @typedef {{ deadline: number, waiters: Set<ManifestWaiter> }} PendingManifestLoad
 */

const MANIFEST_LOAD_TIMEOUT_MS = 5_000;
// A live loader settles within its fetch deadline plus parsing; past this a
// pending load belongs to a cancelled request and another request takes over.
const MANIFEST_LOAD_TAKEOVER_MS = MANIFEST_LOAD_TIMEOUT_MS + 1_000;
// Covers origin connect and response headers; the body then streams under
// streamS3Response's read and idle deadlines.
const ORIGIN_HEADERS_TIMEOUT_MS = 30_000;
const MANIFEST_CACHE_MAX_ENTRIES = 512;
// Entries count their UTF-8 wire bytes plus a fixed overhead; the budget holds
// exactly eight maximum-size manifests.
const MANIFEST_ENTRY_OVERHEAD_BYTES = 64;
const MANIFEST_CACHE_MAX_BYTES = 8 * (MAX_ASSETS_MANIFEST_BYTES + MANIFEST_ENTRY_OVERHEAD_BYTES);
const ASSET_CACHE_CONTROL = "public, max-age=0, must-revalidate";

/** @type {AssetManifest} */
const ABSENT_MANIFEST = Object.freeze({ files: new Map(), prefix: null });
const utf8Decoder = new TextDecoder();

// Version ids are immutable, so entries never go stale; the bounds only cap
// memory across many cold versions.
/** @type {Map<string, { manifest: AssetManifest, bytes: number }>} */
const manifestCache = new Map();
let manifestCacheBytes = 0;

// Concurrent cold requests for one version share a single redis-proxy read.
// Each waiting request creates and awaits its own Promise; the loading request
// settles it with the parsed manifest, an I/O-free value, and workerd's
// cross-request settlement resumes the waiter in its own IoContext. No
// request ever awaits another request's fetch.
/** @type {Map<string, PendingManifestLoad>} */
const pendingLoads = new Map();

export class AssetUnavailableError extends Error {
  /** @param {string} message @param {{ cause?: unknown }} [options] */
  constructor(message, options) {
    super(message, options);
    this.name = "AssetUnavailableError";
  }
}

/** @param {string} key @param {AssetManifest} manifest @param {number} bytes */
function cacheManifest(key, manifest, bytes) {
  const replaced = manifestCache.get(key);
  if (replaced) {
    manifestCache.delete(key);
    manifestCacheBytes -= replaced.bytes;
  }
  if (bytes > MANIFEST_CACHE_MAX_BYTES) return;
  manifestCache.set(key, { manifest, bytes });
  manifestCacheBytes += bytes;
  for (const [oldest, entry] of manifestCache) {
    if (manifestCache.size <= MANIFEST_CACHE_MAX_ENTRIES && manifestCacheBytes <= MANIFEST_CACHE_MAX_BYTES) break;
    manifestCache.delete(oldest);
    manifestCacheBytes -= entry.bytes;
  }
}

/**
 * @param {AssetsEnv} env
 * @param {AssetIdentity} identity
 * @returns {Promise<{ manifest: AssetManifest, bytes: number }>}
 */
async function readManifest(env, { ns, worker, version }) {
  const url = proxyEndpoint(
    requireRedisProxyBaseUrl(env, "ASSETS"),
    "/runtime/assets",
    { ns, worker, version }
  );
  const res = await proxyFetch(url, { signal: AbortSignal.timeout(MANIFEST_LOAD_TIMEOUT_MS) }, {
    env,
    failurePrefix: "Redis proxy assets manifest load",
  });
  if (res.status === 204) {
    await discardResponseBody(res);
    return { manifest: ABSENT_MANIFEST, bytes: MANIFEST_ENTRY_OVERHEAD_BYTES };
  }
  const raw = new Uint8Array(await res.arrayBuffer());
  const key = `${ns}:${worker}:${version}`;
  if (raw.byteLength > MAX_ASSETS_MANIFEST_BYTES) {
    throw new Error(`Invalid assets manifest for ${key}: ${raw.byteLength} bytes exceeds ${MAX_ASSETS_MANIFEST_BYTES}`);
  }
  try {
    const manifest = parseAssetsManifest(utf8Decoder.decode(raw), { ns, worker });
    return { manifest, bytes: raw.byteLength + MANIFEST_ENTRY_OVERHEAD_BYTES };
  } catch (err) {
    throw new Error(`Invalid assets manifest for ${key}`, { cause: err });
  }
}

/**
 * @param {string} key
 * @param {PendingManifestLoad} pending
 * @returns {Promise<AssetManifest | null>}  Null when the loader did not settle in time.
 */
async function waitForPendingLoad(key, pending) {
  const { promise, resolve, reject } = Promise.withResolvers();
  /** @type {ManifestWaiter} */
  const waiter = { resolve, reject };
  pending.waiters.add(waiter);
  const timer = setTimeout(() => {
    pending.waiters.delete(waiter);
    if (pendingLoads.get(key) === pending) pendingLoads.delete(key);
    resolve(null);
  }, Math.max(0, pending.deadline - Date.now()));
  try {
    return /** @type {AssetManifest | null} */ (await promise);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {AssetsEnv} env
 * @param {AssetIdentity} identity
 * @returns {Promise<AssetManifest>}
 */
export async function loadAssetManifest(env, identity) {
  const key = `${identity.ns}:${identity.worker}:${identity.version}`;
  for (;;) {
    const cached = manifestCache.get(key);
    if (cached) {
      manifestCache.delete(key);
      manifestCache.set(key, cached);
      return cached.manifest;
    }
    const pending = pendingLoads.get(key);
    if (!pending || pending.deadline <= Date.now()) break;
    const shared = await waitForPendingLoad(key, pending);
    if (shared) return shared;
  }

  /** @type {PendingManifestLoad} */
  const pending = { deadline: Date.now() + MANIFEST_LOAD_TAKEOVER_MS, waiters: new Set() };
  pendingLoads.set(key, pending);
  try {
    const { manifest, bytes } = await readManifest(env, identity);
    cacheManifest(key, manifest, bytes);
    for (const waiter of pending.waiters) waiter.resolve(manifest);
    return manifest;
  } catch (err) {
    const shared = errorMessage(err);
    for (const waiter of pending.waiters) waiter.reject(new Error(shared));
    throw err;
  } finally {
    pending.waiters.clear();
    if (pendingLoads.get(key) === pending) pendingLoads.delete(key);
  }
}

/** @param {AssetsEnv} env */
function assetOriginBase(env) {
  for (const value of [env.ASSETS_ORIGIN_BASE, env.ASSETS_CDN_BASE]) {
    if (typeof value === "string" && value) return value;
  }
  throw new AssetUnavailableError("ASSETS requires ASSETS_ORIGIN_BASE or ASSETS_CDN_BASE");
}

/**
 * @param {{ env: AssetsEnv, ctx: AssetsCtx, request: Request, prefix: string, path: string, entry: AssetEntry }} args
 *   `path` is the decoded absolute asset path.
 * @returns {Promise<Response>}
 */
async function assetResponse({ env, ctx, request, prefix, path, entry }) {
  const headers = new Headers({
    etag: `"${entry.etag}"`,
    "cache-control": ASSET_CACHE_CONTROL,
  });
  if (ifNoneMatchSatisfied(request.headers.get("if-none-match"), entry.etag)) {
    return new Response(null, { status: 304, headers });
  }
  headers.set("content-type", entry.contentType);
  if (request.method === "HEAD") {
    headers.set("content-length", String(entry.size));
    return new Response(null, { status: 200, headers });
  }
  const url = buildAssetUrl(assetOriginBase(env), prefix, path);
  const objectKey = `${prefix}${path.slice(1)}`;
  /** @type {{ origin: Response, aborter: AbortController }} */
  let fetched;
  try {
    fetched = await withS3Request(async (aborter) => {
      // A client that leaves before headers stops the origin read too.
      const clientSignal = request.signal;
      if (clientSignal) {
        clientSignal.throwIfAborted();
        clientSignal.addEventListener("abort", () => aborter.abort(clientSignal.reason), { once: true });
      }
      return { origin: await fetch(url, { signal: aborter.signal }), aborter };
    }, ORIGIN_HEADERS_TIMEOUT_MS);
  } catch (err) {
    throw new AssetUnavailableError(`Asset origin fetch for ${objectKey} failed`, { cause: err });
  }
  const { origin, aborter } = fetched;
  if (origin.status !== 200) {
    await discardResponseBody(origin);
    throw new AssetUnavailableError(`Asset origin returned ${origin.status} for ${objectKey}`);
  }
  // FixedLengthStream restores Content-Length lost by the JS wrapper and
  // errors the body if the origin sends a different size than the manifest.
  const body = new FixedLengthStream(entry.size);
  streamS3Response(origin, aborter, ctx).pipeTo(body.writable).catch(() => {});
  return new Response(body.readable, { status: 200, headers });
}

/** @param {string} location */
function redirectResponse(location) {
  return new Response(null, { status: 307, headers: { location } });
}

/** @param {Request} request */
function isAssetMethod(request) {
  return request.method === "GET" || request.method === "HEAD";
}

/**
 * Cloudflare's default `run_worker_first = false`: answer GET/HEAD for an
 * asset path before the Worker runs. Null means "dispatch to the Worker".
 * @param {{ env: AssetsEnv, ctx: AssetsCtx, request: Request, identity: AssetIdentity }} args
 * @returns {Promise<Response | null>}
 */
export async function serveAssetBeforeWorker({ env, ctx, request, identity }) {
  if (!isAssetMethod(request) || request.headers.has("upgrade")) return null;
  const manifest = await loadAssetManifest(env, identity);
  if (manifest.prefix === null || manifest.files.size === 0) return null;
  const url = new URL(request.url);
  const intent = resolveAsset(manifest.files, url.pathname, url.search);
  if (!intent) return null;
  if (intent.type === "redirect") return redirectResponse(intent.location);
  return await assetResponse({ env, ctx, request, prefix: manifest.prefix, path: intent.path, entry: intent.entry });
}

/**
 * env.ASSETS.fetch(): the same matching, with not_found_handling "none".
 * @param {{ env: AssetsEnv, ctx: AssetsCtx, request: Request, identity: AssetIdentity }} args
 * @returns {Promise<Response>}
 */
export async function fetchAsset({ env, ctx, request, identity }) {
  if (!isAssetMethod(request)) {
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  }
  const manifest = await loadAssetManifest(env, identity);
  const url = new URL(request.url);
  const intent = manifest.prefix === null ? null : resolveAsset(manifest.files, url.pathname, url.search);
  if (!intent) return new Response(null, { status: 404 });
  if (intent.type === "redirect") return redirectResponse(intent.location);
  return await assetResponse({
    env, ctx, request, prefix: /** @type {string} */ (manifest.prefix), path: intent.path, entry: intent.entry,
  });
}
