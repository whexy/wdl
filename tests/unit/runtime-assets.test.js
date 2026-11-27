import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_ASSETS_MANIFEST_BYTES, buildAssetsManifest } from "../../shared/assets-manifest.js";
import {
  importRepositoryModuleFresh,
  importSpecifierReplacements,
  readRepositoryJson,
  repositoryFileUrl,
  runtimeLibModuleDataUrl,
} from "../helpers/load-shared-module.js";
import { withMockedFetch } from "../helpers/mock-fetch.js";
import { delay } from "../helpers/timing.js";
import { runtimeProxyBindingStubUrl } from "../helpers/runtime-proxy-stub.js";

const IDENTITY = { ns: "demo", worker: "site", version: "v3" };
const PREFIX = "assets/demo/site/0123456789abcdef0123456789ab/";
const ETAG = "0123456789abcdef0123456789abcdef";
const ENV = {
  REDIS_PROXY_URL: "http://redis-proxy:7070",
  WDL_INTERNAL_AUTH_TOKEN: "internal-token",
  ASSETS_ORIGIN_BASE: "http://s3.mesh/wdl-assets",
  ASSETS_CDN_BASE: "https://cdn.example/wdl-assets",
};
const MANIFEST = buildAssetsManifest(PREFIX, [
  { path: "index.html", contentType: "text/html; charset=utf-8", etag: ETAG, size: 7 },
  { path: "docs/index.html", contentType: "text/html; charset=utf-8", etag: ETAG, size: 7 },
  { path: "app 1.js", contentType: "application/javascript; charset=utf-8", etag: ETAG, size: 7 },
]);

// workerd global; enough of it to check the declared length.
/** @type {any} */ (globalThis).FixedLengthStream ??= class FixedLengthStream extends TransformStream {
  /** @param {number} expected */
  constructor(expected) {
    let seen = 0;
    super({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > expected) throw new TypeError("body longer than declared length");
        controller.enqueue(chunk);
      },
      flush() {
        if (seen !== expected) throw new TypeError("body shorter than declared length");
      },
    });
  }
};
const CTX = { waitUntil(/** @type {Promise<unknown>} */ promise) { promise.catch(() => {}); } };

async function loadAssets() {
  return await importRepositoryModuleFresh("runtime/assets.js", importSpecifierReplacements({
    "shared-assets-manifest": repositoryFileUrl("shared/assets-manifest.js"),
    "runtime-lib": runtimeLibModuleDataUrl(),
    "runtime-bindings-proxy": runtimeProxyBindingStubUrl(),
    "shared-errors": repositoryFileUrl("shared/errors.js"),
    "shared-respond": repositoryFileUrl("shared/respond.js"),
    "shared-s3-request": repositoryFileUrl("shared/s3-request.js"),
  }));
}

/**
 * @param {{ manifest?: string | null, origin?: (url: string) => Response }} [options]
 */
function stack({ manifest = MANIFEST, origin = () => new Response("bytes!!", { headers: { "x-amz-request-id": "r", server: "rgw" } }) } = {}) {
  /** @type {Array<{ url: string, headers: Headers }>} */
  const calls = [];
  /** @type {typeof globalThis.fetch} */
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, headers: new Headers(init.headers) });
    if (url.startsWith(ENV.REDIS_PROXY_URL)) {
      return manifest === null
        ? new Response(null, { status: 204 })
        : new Response(manifest, { headers: { "content-type": "application/json" } });
    }
    return origin(url);
  };
  return { calls, fetchImpl };
}

/** @param {string} path @param {RequestInit} [init] */
function request(path, init) {
  return new Request(`http://demo.workers.local${path}`, init);
}

test("pre-Worker GET serves the asset from the origin with Cloudflare headers", async () => {
  const { serveAssetBeforeWorker } = await loadAssets();
  const { calls, fetchImpl } = stack();
  await withMockedFetch(fetchImpl, async () => {
    const response = await serveAssetBeforeWorker({ env: ENV, ctx: CTX, request: request("/app%201.js"), identity: IDENTITY });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "bytes!!");
    assert.equal(response.headers.get("content-type"), "application/javascript; charset=utf-8");
    assert.equal(response.headers.get("etag"), `"${ETAG}"`);
    assert.equal(response.headers.get("cache-control"), "public, max-age=0, must-revalidate");
    assert.equal(response.headers.get("x-amz-request-id"), null);
    assert.equal(response.headers.get("server"), null);
  });
  const manifestUrl = new URL(calls[0].url);
  assert.equal(manifestUrl.pathname, readRepositoryJson("tests/fixtures/assets-manifest-contract.json").route);
  assert.deepEqual(Object.fromEntries(manifestUrl.searchParams), { ns: "demo", worker: "site", version: "v3" });
  assert.equal(calls[0].headers.get("x-wdl-internal-auth"), "internal-token");
  assert.equal(calls[1].url, `http://s3.mesh/wdl-assets/${PREFIX}app%201.js`);
  assert.equal(calls[1].headers.get("x-wdl-internal-auth"), null);
});

test("origin falls back to ASSETS_CDN_BASE", async () => {
  const { serveAssetBeforeWorker } = await loadAssets();
  const { calls, fetchImpl } = stack();
  const env = { ...ENV, ASSETS_ORIGIN_BASE: undefined };
  await withMockedFetch(fetchImpl, async () => {
    const response = await serveAssetBeforeWorker({ env, ctx: CTX, request: request("/"), identity: IDENTITY });
    assert.equal(await response.text(), "bytes!!");
  });
  assert.equal(calls[1].url, `https://cdn.example/wdl-assets/${PREFIX}index.html`);
});

test("HEAD and If-None-Match are answered from the manifest without an origin fetch", async () => {
  const { serveAssetBeforeWorker } = await loadAssets();
  const { calls, fetchImpl } = stack();
  await withMockedFetch(fetchImpl, async () => {
    const head = await serveAssetBeforeWorker({ env: ENV, ctx: CTX, request: request("/", { method: "HEAD" }), identity: IDENTITY });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), "7");
    assert.equal(head.headers.get("etag"), `"${ETAG}"`);
    assert.equal(head.body, null);

    const conditional = await serveAssetBeforeWorker({
      env: ENV,
      ctx: CTX,
      request: request("/docs/", { headers: { "if-none-match": `W/"${ETAG}"` } }),
      identity: IDENTITY,
    });
    assert.equal(conditional.status, 304);
    assert.equal(conditional.headers.get("etag"), `"${ETAG}"`);
  });
  // One manifest read, cached across requests for the immutable version.
  assert.equal(calls.length, 1);
});

test("pre-Worker serving redirects to canonical paths and leaves misses to the Worker", async () => {
  const { serveAssetBeforeWorker } = await loadAssets();
  const { calls, fetchImpl } = stack();
  await withMockedFetch(fetchImpl, async () => {
    const redirect = await serveAssetBeforeWorker({ env: ENV, ctx: CTX, request: request("/docs?x=1"), identity: IDENTITY });
    assert.equal(redirect.status, 307);
    assert.equal(redirect.headers.get("location"), "./docs/?x=1");

    for (const req of [
      request("/api/users"),
      request("/", { method: "POST", body: "x" }),
      request("/", { headers: { upgrade: "websocket" } }),
    ]) {
      assert.equal(await serveAssetBeforeWorker({ env: ENV, ctx: CTX, request: req, identity: IDENTITY }), null);
    }
  });
  assert.equal(calls.filter((call) => !call.url.startsWith(ENV.REDIS_PROXY_URL)).length, 0);
});

test("versions without a manifest dispatch to the Worker and cache the absence", async () => {
  const { serveAssetBeforeWorker } = await loadAssets();
  const { calls, fetchImpl } = stack({ manifest: null });
  await withMockedFetch(fetchImpl, async () => {
    assert.equal(await serveAssetBeforeWorker({ env: ENV, ctx: CTX, request: request("/"), identity: IDENTITY }), null);
    assert.equal(await serveAssetBeforeWorker({ env: ENV, ctx: CTX, request: request("/x"), identity: IDENTITY }), null);
  });
  assert.equal(calls.length, 1);
});

test("a manifest outside its bundle's namespace fails closed", async () => {
  const { serveAssetBeforeWorker } = await loadAssets();
  const foreign = buildAssetsManifest("assets/other/site/0123456789abcdef0123456789ab/", []);
  const { fetchImpl } = stack({ manifest: foreign });
  await withMockedFetch(fetchImpl, async () => {
    await assert.rejects(
      serveAssetBeforeWorker({ env: ENV, ctx: CTX, request: request("/"), identity: IDENTITY }),
      /Invalid assets manifest for demo:site:v3/
    );
  });
});

test("an origin miss for a manifest path is an asset error, not a Worker dispatch", async () => {
  const { serveAssetBeforeWorker, AssetUnavailableError } = await loadAssets();
  const { fetchImpl } = stack({ origin: () => new Response("NoSuchKey", { status: 404 }) });
  await withMockedFetch(fetchImpl, async () => {
    await assert.rejects(
      serveAssetBeforeWorker({ env: ENV, ctx: CTX, request: request("/"), identity: IDENTITY }),
      (err) => err instanceof AssetUnavailableError && /returned 404/.test(String(err))
    );
  });
});

test("ASSETS.fetch returns 404 for misses and 405 for other methods", async () => {
  const { fetchAsset } = await loadAssets();
  const { fetchImpl } = stack();
  await withMockedFetch(fetchImpl, async () => {
    const hit = await fetchAsset({ env: ENV, ctx: CTX, request: request("/index.html"), identity: IDENTITY });
    assert.equal(hit.status, 307);
    assert.equal(hit.headers.get("location"), "./");

    const served = await fetchAsset({ env: ENV, ctx: CTX, request: request("/"), identity: IDENTITY });
    assert.equal(await served.text(), "bytes!!");

    const miss = await fetchAsset({ env: ENV, ctx: CTX, request: request("/api"), identity: IDENTITY });
    assert.equal(miss.status, 404);

    const post = await fetchAsset({ env: ENV, ctx: CTX, request: request("/", { method: "POST", body: "x" }), identity: IDENTITY });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get("allow"), "GET, HEAD");
  });
});

test("ASSETS.fetch on a version without a manifest returns 404", async () => {
  const { fetchAsset } = await loadAssets();
  const { fetchImpl } = stack({ manifest: null });
  await withMockedFetch(fetchImpl, async () => {
    const response = await fetchAsset({ env: ENV, ctx: CTX, request: request("/"), identity: IDENTITY });
    assert.equal(response.status, 404);
  });
});

/** @param {string} worker @param {number} files @param {number} [pathBytes] */
function manifestFor(worker, files, pathBytes = 8) {
  return buildAssetsManifest(`assets/demo/${worker}/0123456789abcdef0123456789ab/`, Array.from({ length: files }, (_, i) => ({
    path: `${i}`.padStart(pathBytes, "f"), contentType: "text/plain", etag: ETAG, size: 1,
  })));
}

/** @param {Record<string, string>} manifests  worker name → manifest; others get 204 */
function proxyOnly(manifests) {
  let reads = 0;
  /** @type {typeof globalThis.fetch} */
  const fetchImpl = async (input) => {
    reads++;
    await delay(2);
    const worker = String(new URL(String(input)).searchParams.get("worker"));
    return Object.hasOwn(manifests, worker) ? new Response(manifests[worker]) : new Response(null, { status: 204 });
  };
  return { fetchImpl, reads: () => reads };
}

test("concurrent cold loads of one version share one read", async () => {
  const { loadAssetManifest } = await loadAssets();
  const proxy = proxyOnly({ site: manifestFor("site", 1000) });
  await withMockedFetch(proxy.fetchImpl, async () => {
    const results = await Promise.all(Array.from({ length: 40 }, () =>
      loadAssetManifest(ENV, { ns: "demo", worker: "site", version: "v1" })));
    assert.equal(new Set(results).size, 1);
    assert.equal(proxy.reads(), 1);
    for (let i = 0; i < 5; i++) await loadAssetManifest(ENV, { ns: "demo", worker: "site", version: "v1" });
    assert.equal(proxy.reads(), 1);
  });
});

/** A valid manifest of exactly `bytes` UTF-8 bytes, padding paths up to their cap. */
function manifestOfSize(/** @type {string} */ worker, /** @type {number} */ bytes) {
  const prefix = `assets/demo/${worker}/0123456789abcdef0123456789ab/`;
  /** @param {string[]} paths */
  const build = (paths) => buildAssetsManifest(prefix, paths.map((path) => ({ path, contentType: "text/plain", etag: ETAG, size: 1 })));
  const paths = Array.from({ length: 20_000 }, (_, i) => `${i}`.padStart(6, "0"));
  let short = bytes - Buffer.byteLength(build(paths));
  for (let i = 0; short > 0; i++) {
    const grow = Math.min(short, 512 - paths[i].length);
    paths[i] += "q".repeat(grow);
    short -= grow;
  }
  const text = build(paths);
  assert.equal(Buffer.byteLength(text), bytes);
  return text;
}

test("the byte budget holds exactly eight maximum-size manifests, even after racing loads", async () => {
  const { loadAssetManifest } = await loadAssets();
  const proxy = proxyOnly({ big: manifestOfSize("big", MAX_ASSETS_MANIFEST_BYTES) });
  /** @param {number} v */
  const load = (v) => loadAssetManifest(ENV, { ns: "demo", worker: "big", version: `v${v}` });
  await withMockedFetch(proxy.fetchImpl, async () => {
    // Racing cold loads must count each version's bytes once, or fewer fit.
    for (let v = 1; v <= 8; v++) await Promise.all(Array.from({ length: 10 }, () => load(v)));
    assert.equal(proxy.reads(), 8);
    for (let v = 1; v <= 8; v++) await load(v);
    assert.equal(proxy.reads(), 8, "all eight still cached");

    await load(9);
    assert.equal(proxy.reads(), 9);
    await load(9);
    await load(8);
    assert.equal(proxy.reads(), 9, "newest versions stay cached");
    await load(1);
    assert.equal(proxy.reads(), 10, "least recently used version was evicted");
  });
});

test("a manifest over the size cap fails closed without being cached", async () => {
  const { loadAssetManifest } = await loadAssets();
  const oversized = `{"prefix":"x","files":{},"pad":"${"x".repeat(MAX_ASSETS_MANIFEST_BYTES)}"}`;
  const proxy = proxyOnly({ site: oversized });
  await withMockedFetch(proxy.fetchImpl, async () => {
    await assert.rejects(
      loadAssetManifest(ENV, { ns: "demo", worker: "site", version: "v1" }),
      /Invalid assets manifest for demo:site:v1: \d+ bytes exceeds 4194304/
    );
    await assert.rejects(loadAssetManifest(ENV, { ns: "demo", worker: "site", version: "v1" }));
  });
  assert.equal(proxy.reads(), 2);
});

test("waiters share a loader's failure and the next request retries", async () => {
  const { loadAssetManifest } = await loadAssets();
  let reads = 0;
  await withMockedFetch(async () => {
    reads++;
    await delay(2);
    return reads === 1 ? new Response("down", { status: 503 }) : new Response(null, { status: 204 });
  }, async () => {
    const outcomes = await Promise.allSettled(Array.from({ length: 5 }, () =>
      loadAssetManifest(ENV, { ns: "demo", worker: "site", version: "v1" })));
    assert.deepEqual(outcomes.map((o) => o.status), Array(5).fill("rejected"));
    assert.equal(reads, 1);
    await loadAssetManifest(ENV, { ns: "demo", worker: "site", version: "v1" });
    assert.equal(reads, 2);
  });
});

test("a waiter takes over when the loading request never settles", async (t) => {
  const { loadAssetManifest } = await loadAssets();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let reads = 0;
  await withMockedFetch(async () => {
    reads++;
    // The first loader's request was cancelled: its read never completes.
    return reads === 1 ? new Promise(() => {}) : new Response(MANIFEST);
  }, async () => {
    void loadAssetManifest(ENV, IDENTITY);
    await Promise.resolve();
    const waiter = loadAssetManifest(ENV, IDENTITY);
    await Promise.resolve();
    assert.equal(reads, 1);
    t.mock.timers.tick(6_001);
    const manifest = await waiter;
    assert.equal(reads, 2);
    assert.equal(manifest.prefix, PREFIX);
  });
});

test("a client that leaves before origin headers aborts the origin read", async () => {
  const { serveAssetBeforeWorker } = await loadAssets();
  const controller = new AbortController();
  /** @type {AbortSignal | undefined} */
  let originSignal;
  await withMockedFetch(async (input, init = {}) => {
    if (String(input).startsWith(ENV.REDIS_PROXY_URL)) return new Response(MANIFEST);
    originSignal = init.signal ?? undefined;
    return await new Promise((_, reject) => {
      originSignal?.addEventListener("abort", () => reject(originSignal?.reason), { once: true });
      controller.abort(new Error("client gone"));
    });
  }, async () => {
    await assert.rejects(
      serveAssetBeforeWorker({ env: ENV, ctx: CTX, request: request("/", { signal: controller.signal }), identity: IDENTITY }),
      /Asset origin fetch for .*index.html failed/
    );
  });
  assert.equal(originSignal?.aborted, true);
});

test("an origin body that disagrees with the manifest size errors the response body", async () => {
  const { serveAssetBeforeWorker } = await loadAssets();
  const { fetchImpl } = stack({ origin: () => new Response("too long for five bytes") });
  await withMockedFetch(fetchImpl, async () => {
    const response = await serveAssetBeforeWorker({ env: ENV, ctx: CTX, request: request("/"), identity: IDENTITY });
    await assert.rejects(response.text(), /longer than declared length/);
  });
});
