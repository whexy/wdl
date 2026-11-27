// ASSETS serving through gateway → runtime → s3mock: assets answer before the
// Worker runs, and env.ASSETS.fetch() returns them, pinned to the version.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  adminFetch,
  adminPost,
  deployAndPromote,
  gatewayFetch,
  responseJson,
  uniqueNs,
  setupIntegrationSuite,
  waitUntil,
  withServiceStopped,
} from "./helpers/index.js";

setupIntegrationSuite();

const SITE_WORKER = `
export class Room {
  constructor(state, env) { this.env = env; }
  async fetch(request) {
    const asset = await this.env.ASSETS.fetch(request);
    return new Response(asset.status + ":" + await asset.text());
  }
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/via-binding") {
      const target = new URL(url.searchParams.get("path"), request.url);
      return env.ASSETS.fetch(new Request(target, {
        headers: request.headers,
        redirect: url.searchParams.get("redirect") || "follow",
      }));
    }
    if (url.pathname === "/via-do") {
      const target = new URL(url.searchParams.get("path"), request.url);
      return env.ROOM.get(env.ROOM.idFromName("a")).fetch(target);
    }
    return new Response("worker " + request.method + " " + url.pathname);
  }
};`;

const FILES = {
  "index.html": "<h1>home</h1>",
  "about.html": "<h1>about</h1>",
  "docs/index.html": "<h1>docs</h1>",
  "_next/static/app.js": "console.log('app');",
  "img/a b.svg": "<svg/>",
};

/** @param {Record<string, string>} files */
function encodeAssets(files) {
  return Object.fromEntries(
    Object.entries(files).map(([path, body]) => [path, Buffer.from(body).toString("base64")])
  );
}

/** @param {string} body */
function etagOf(body) {
  return `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`;
}

/** @param {string} ns @param {Record<string, string>} [files] */
async function deploySite(ns, files = FILES) {
  return await deployAndPromote(ns, "site", {
    mainModule: "worker.js",
    modules: { "worker.js": SITE_WORKER },
    bindings: { ROOM: { type: "do", className: "Room" } },
    assets: encodeAssets(files),
  });
}

test("assets are served before the Worker with Cloudflare headers", async () => {
  const ns = uniqueNs("assets-serve");
  await deploySite(ns);

  const js = await gatewayFetch(ns, "/site/_next/static/app.js");
  assert.equal(js.status, 200);
  assert.equal(await js.text(), FILES["_next/static/app.js"]);
  assert.equal(js.headers["content-type"], "application/javascript; charset=utf-8");
  assert.equal(js.headers.etag, etagOf(FILES["_next/static/app.js"]));
  assert.equal(js.headers["cache-control"], "public, max-age=0, must-revalidate");
  assert.equal(js.headers["content-length"], String(Buffer.byteLength(FILES["_next/static/app.js"])));
  assert.equal(js.headers["x-amz-request-id"], undefined);

  const svg = await gatewayFetch(ns, "/site/img/a%20b.svg");
  assert.equal(svg.status, 200);
  assert.equal(svg.headers["content-type"], "image/svg+xml");

  const home = await gatewayFetch(ns, "/site/");
  assert.equal(await home.text(), FILES["index.html"]);
  const about = await gatewayFetch(ns, "/site/about");
  assert.equal(await about.text(), FILES["about.html"]);
  const docs = await gatewayFetch(ns, "/site/docs/");
  assert.equal(await docs.text(), FILES["docs/index.html"]);
});

test("asset redirects stay under the worker mount", async () => {
  const ns = uniqueNs("assets-redirect");
  await deploySite(ns);
  for (const [path, expected] of [
    ["/site/about.html?x=1", "/site/about?x=1"],
    ["/site/docs", "/site/docs/"],
    ["/site/docs/index.html", "/site/docs/"],
    ["/site/index.html", "/site/"],
  ]) {
    const res = await gatewayFetch(ns, path);
    assert.equal(res.status, 307, path);
    const resolved = new URL(String(res.headers.location), `http://${ns}.workers.local${path}`);
    assert.equal(resolved.pathname + resolved.search, expected, path);
  }
});

test("conditional GET and HEAD are answered without a body", async () => {
  const ns = uniqueNs("assets-cond");
  await deploySite(ns);
  const etag = etagOf(FILES["about.html"]);

  const notModified = await gatewayFetch(ns, "/site/about", { headers: { "if-none-match": `W/${etag}` } });
  assert.equal(notModified.status, 304);
  assert.equal(notModified.headers.etag, etag);
  assert.equal(await notModified.text(), "");

  const changed = await gatewayFetch(ns, "/site/about", { headers: { "if-none-match": '"stale"' } });
  assert.equal(changed.status, 200);

  const head = await gatewayFetch(ns, "/site/about", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.etag, etag);
  assert.equal(head.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(head.headers["content-length"], String(Buffer.byteLength(FILES["about.html"])));
  assert.equal(await head.text(), "");
});

test("non-asset paths and non-GET methods reach the Worker unchanged", async () => {
  const ns = uniqueNs("assets-miss");
  await deploySite(ns);

  const api = await gatewayFetch(ns, "/site/api/users");
  assert.equal(api.status, 200);
  assert.equal(await api.text(), "worker GET /api/users");

  const post = await gatewayFetch(ns, "/site/about", { method: "POST", body: "x" });
  assert.equal(await post.text(), "worker POST /about");
});

test("env.ASSETS.fetch returns the asset, its redirects, 304s and 404s", async () => {
  const ns = uniqueNs("assets-binding-fetch");
  await deploySite(ns);

  const hit = await gatewayFetch(ns, "/site/via-binding?path=/_next/static/app.js");
  assert.equal(hit.status, 200);
  assert.equal(await hit.text(), FILES["_next/static/app.js"]);
  assert.equal(hit.headers.etag, etagOf(FILES["_next/static/app.js"]));

  const pretty = await gatewayFetch(ns, "/site/via-binding?path=/about");
  assert.equal(await pretty.text(), FILES["about.html"]);

  const redirect = await gatewayFetch(ns, "/site/via-binding?path=/docs&redirect=manual");
  assert.equal(redirect.status, 307);
  assert.equal(redirect.headers.location, "./docs/");
  // Like any Fetcher, the binding follows redirects unless told not to.
  const followed = await gatewayFetch(ns, "/site/via-binding?path=/docs");
  assert.equal(await followed.text(), FILES["docs/index.html"]);

  const cached = await gatewayFetch(ns, "/site/via-binding?path=/about", {
    headers: { "if-none-match": etagOf(FILES["about.html"]) },
  });
  assert.equal(cached.status, 304);

  const miss = await gatewayFetch(ns, "/site/via-binding?path=/nope.js");
  assert.equal(miss.status, 404);
});

test("env.ASSETS.fetch works inside a Durable Object", async () => {
  const ns = uniqueNs("assets-do-fetch");
  await deploySite(ns);
  const res = await gatewayFetch(ns, "/site/via-do?path=/about");
  assert.equal(res.status, 200);
  assert.equal(await res.text(), `200:${FILES["about.html"]}`);
});

test("promoting a new version switches both serving paths", async () => {
  const ns = uniqueNs("assets-pivot");
  await deploySite(ns, { "msg.txt": "v1" });
  assert.equal(await (await gatewayFetch(ns, "/site/msg.txt")).text(), "v1");

  await deploySite(ns, { "msg.txt": "v2", "new.txt": "added" });
  assert.equal(await (await gatewayFetch(ns, "/site/msg.txt")).text(), "v2");
  assert.equal(await (await gatewayFetch(ns, "/site/via-binding?path=/msg.txt")).text(), "v2");
  assert.equal(await (await gatewayFetch(ns, "/site/new.txt")).text(), "added");
});

test("a secret bump keeps serving the bumped version's assets", async () => {
  const ns = uniqueNs("assets-bump");
  await deploySite(ns, { "msg.txt": "kept" });
  const put = await adminFetch(`/ns/${ns}/worker/site/secrets/TOKEN`, {
    method: "PUT",
    body: JSON.stringify({ value: "v" }),
  });
  assert.equal(put.status, 200);
  assert.equal(await (await gatewayFetch(ns, "/site/msg.txt")).text(), "kept");
});

test("Workers deployed without assets see every path", async () => {
  const ns = uniqueNs("assets-none");
  await deployAndPromote(ns, "plain", {
    mainModule: "worker.js",
    modules: {
      "worker.js": "export default { fetch: (r) => Response.json({ path: new URL(r.url).pathname }) };",
    },
  });
  const res = await gatewayFetch(ns, "/plain/index.html");
  assert.deepEqual(await responseJson(res), { path: "/index.html" });
});

test("service-binding fetch into a Worker with assets is answered by its assets", async () => {
  const ns = uniqueNs("assets-svc");
  await deploySite(ns);
  await deployAndPromote(ns, "caller", {
    code: `export default {
      async fetch(request, env) {
        const asset = await env.SITE.fetch("http://site.internal/about");
        const api = await env.SITE.fetch("http://site.internal/api");
        return new Response(asset.status + ":" + await asset.text() + "|" + await api.text());
      }
    };`,
    bindings: { SITE: { type: "service", service: "site" } },
  });
  const res = await gatewayFetch(ns, "/caller/");
  assert.equal(await res.text(), `200:${FILES["about.html"]}|worker GET /api`);
});

test("concurrent cold requests to a new version all get the asset", async () => {
  const ns = uniqueNs("assets-cold-race");
  await deploySite(ns);
  const responses = await Promise.all(Array.from({ length: 20 }, () => gatewayFetch(ns, "/site/about")));
  assert.deepEqual(responses.map((r) => r.status), Array(20).fill(200));
  for (const r of responses) assert.equal(await r.text(), FILES["about.html"]);
});

test("two namespaces with the same Worker name serve their own assets", async () => {
  const a = uniqueNs("assets-iso-a");
  const b = uniqueNs("assets-iso-b");
  await deploySite(a, { "who.txt": "namespace a", "only-a.txt": "a" });
  await deploySite(b, { "who.txt": "namespace b" });
  assert.equal(await (await gatewayFetch(a, "/site/who.txt")).text(), "namespace a");
  assert.equal(await (await gatewayFetch(b, "/site/who.txt")).text(), "namespace b");
  assert.equal(await (await gatewayFetch(b, "/site/only-a.txt")).text(), "worker GET /only-a.txt");
  assert.equal(await (await gatewayFetch(b, "/site/via-binding?path=/only-a.txt")).text(), "");
});

test("encoded separators and dot segments never reach another asset", async () => {
  const ns = uniqueNs("assets-encoded");
  await deploySite(ns, { "a/b.txt": "inside a", "c.txt": "top" });
  // An encoded "/" or "\\" stays inside one segment, so it names no asset.
  for (const path of ["/site/a%2Fb.txt", "/site/a%2fb.txt", "/site/a%5Cb.txt", "/site/a%5cb.txt"]) {
    const res = await gatewayFetch(ns, path);
    assert.equal(res.status, 200, path);
    assert.match(await res.text(), /^worker GET \//, path);
  }
  // Dot segments resolve before routing, as for any URL, and stay in the mount.
  assert.equal(await (await gatewayFetch(ns, "/site/a/%2e%2e/c.txt")).text(), "top");
  const escaped = await gatewayFetch(ns, "/site/%2e%2e/c.txt");
  assert.equal(escaped.status, 404);
  assert.notEqual(await escaped.text(), "top");
});

test("a warm Worker without assets keeps serving while redis-proxy is down", async () => {
  const ns = uniqueNs("assets-proxy-down");
  await deployAndPromote(ns, "plain", {
    mainModule: "worker.js",
    modules: { "worker.js": "export default { fetch: () => new Response('plain ok') };" },
  });
  assert.equal(await (await gatewayFetch(ns, "/plain/")).text(), "plain ok");
  await withServiceStopped("redis-proxy-user", async () => {
    const res = await gatewayFetch(ns, "/plain/x");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "plain ok");
  });
  await waitUntil("user-runtime reaches redis-proxy again", async () => {
    const probe = uniqueNs("assets-proxy-back");
    await deployAndPromote(probe, "plain", {
      mainModule: "worker.js",
      modules: { "worker.js": "export default { fetch: () => new Response('back') };" },
    });
    return (await (await gatewayFetch(probe, "/plain/")).text()) === "back";
  });
});

test("deploy rejects asset sets over the path and manifest limits", async () => {
  const ns = uniqueNs("assets-limits");
  const longPath = await adminPost(`/ns/${ns}/worker/site/deploy`, {
    mainModule: "worker.js",
    modules: { "worker.js": SITE_WORKER },
    assets: { [`d/${"a".repeat(511)}`]: "" },
  });
  assert.equal(longPath.status, 413);
  assert.equal(longPath.json.error, "asset_path_too_long");

  const files = Object.fromEntries(Array.from({ length: 20_000 }, (_, i) => [`${String(i).padStart(6, "0")}${"a".repeat(200)}`, ""]));
  const bigManifest = await adminPost(`/ns/${ns}/worker/site/deploy`, {
    mainModule: "worker.js",
    modules: { "worker.js": SITE_WORKER },
    assets: files,
  });
  assert.equal(bigManifest.status, 413);
  assert.equal(bigManifest.json.error, "assets_manifest_too_large");
});
