import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ASSETS_MANIFEST_FIELD,
  MAX_ASSET_FILES,
  assetEtag,
  buildAssetsManifest,
  ifNoneMatchSatisfied,
  parseAssetsManifest,
  resolveAsset,
} from "../../shared/assets-manifest.js";
import { readRepositoryJson } from "../helpers/load-shared-module.js";

const OWNER = { ns: "demo", worker: "site" };
const PREFIX = "assets/demo/site/0123456789abcdef0123456789ab/";
const ETAG = "0123456789abcdef0123456789abcdef";

/** @param {string[]} paths */
function filesOf(paths) {
  const text = buildAssetsManifest(PREFIX, paths.map((path) => ({
    path, contentType: "text/plain", etag: ETAG, size: 1,
  })));
  return parseAssetsManifest(text, OWNER).files;
}

test("manifest field matches the cross-language fixture", () => {
  assert.equal(ASSETS_MANIFEST_FIELD, readRepositoryJson("tests/fixtures/assets-manifest-contract.json").bundleField);
});

test("assetEtag is the first 128 bits of SHA-256 in hex", async () => {
  // SHA-256("") = e3b0c44298fc1c149afbf4c8996fb924...
  assert.equal(await assetEtag(new Uint8Array()), "e3b0c44298fc1c149afbf4c8996fb924");
});

test("manifest round-trips paths, content types, etags and sizes", () => {
  const text = buildAssetsManifest(PREFIX, [
    { path: "b.css", contentType: "text/css; charset=utf-8", etag: ETAG, size: 3 },
    { path: "a/index.html", contentType: "text/html; charset=utf-8", etag: ETAG, size: 0 },
  ]);
  assert.deepEqual(Object.keys(JSON.parse(text).files), ["a/index.html", "b.css"]);
  const { prefix, files } = parseAssetsManifest(text, OWNER);
  assert.equal(prefix, PREFIX);
  assert.deepEqual(files.get("/b.css"), { contentType: "text/css; charset=utf-8", etag: ETAG, size: 3 });
  assert.deepEqual(files.get("/a/index.html"), { contentType: "text/html; charset=utf-8", etag: ETAG, size: 0 });
});

test("manifest reader fails closed on malformed persisted state", () => {
  const valid = { contentType: "text/plain", etag: ETAG, size: 1 };
  /** @param {unknown} value */
  const parse = (value) => parseAssetsManifest(JSON.stringify(value), OWNER);
  assert.throws(() => parseAssetsManifest("{", OWNER), SyntaxError);
  for (const bad of [
    [],
    { prefix: PREFIX },
    { prefix: PREFIX, files: [] },
    { prefix: "assets/other/site/0123456789abcdef0123456789ab/", files: {} },
    { prefix: "assets/demo/other/0123456789abcdef0123456789ab/", files: {} },
    { prefix: "assets/demo/site/not-a-token/", files: {} },
    { files: {} },
    { prefix: PREFIX, files: { "/abs": valid } },
    { prefix: PREFIX, files: { "a/../b": valid } },
    { prefix: PREFIX, files: { "a//b": valid } },
    { prefix: PREFIX, files: { x: null } },
    { prefix: PREFIX, files: { x: { ...valid, etag: "W/abc" } } },
    { prefix: PREFIX, files: { x: { ...valid, contentType: "text/plain\r\nx-injected: 1" } } },
    { prefix: PREFIX, files: { x: { ...valid, contentType: "" } } },
    { prefix: PREFIX, files: { x: { ...valid, size: -1 } } },
    { prefix: PREFIX, files: { x: { ...valid, size: 1.5 } } },
  ]) {
    assert.throws(() => parse(bad), TypeError, JSON.stringify(bad));
  }
  assert.throws(() => parse({ prefix: PREFIX, files: { ["a".repeat(513)]: valid } }), TypeError);
  const tooMany = Object.fromEntries(Array.from({ length: MAX_ASSET_FILES + 1 }, (_, i) => [`f${i}`, valid]));
  assert.throws(() => parse({ prefix: PREFIX, files: tooMany }), /more than 20000/);
});

test("resolveAsset follows Cloudflare auto-trailing-slash", () => {
  const files = filesOf([
    "index.html",
    "about.html",
    "blog/index.html",
    "docs/index.html",
    "docs.html",
    "raw/index",
    "app.js",
    "both.html",
    "both/index.html",
  ]);
  /** @param {string} path */
  const intent = (path) => {
    const result = resolveAsset(files, path, "");
    if (!result) return null;
    return result.type === "asset" ? `serve ${result.path}` : `307 ${result.location}`;
  };
  const cases = {
    "/": "serve /index.html",
    "/index.html": "307 ./",
    "/index": "307 ./",
    "/app.js": "serve /app.js",
    "/about": "serve /about.html",
    "/about.html": "307 ./about",
    "/about/": "307 ../about",
    "/blog": "307 ./blog/",
    "/blog/": "serve /blog/index.html",
    "/blog/index.html": "307 ../blog/",
    "/blog/index": "307 ../blog/",
    // A real asset is never redirected away from.
    "/docs.html": "307 ./docs",
    "/docs": "serve /docs.html",
    "/docs/": "serve /docs/index.html",
    "/raw/index": "serve /raw/index",
    "/both": "serve /both.html",
    "/both/": "serve /both/index.html",
    "/missing": null,
    "/missing/": null,
    "/app.js/": null,
  };
  for (const [path, expected] of Object.entries(cases)) {
    assert.equal(intent(path), expected, path);
  }
});

test("resolveAsset decodes request paths and re-encodes redirects", () => {
  const files = filesOf(["a b/c d.txt", "x y/index.html", "a:b.html"]);
  assert.deepEqual(resolveAsset(files, "/a%20b/c%20d.txt", "")?.type, "asset");
  assert.deepEqual(resolveAsset(files, "/x%20y", "?q=1"), { type: "redirect", location: "./x%20y/?q=1" });
  // "./" keeps a colon segment from parsing as a URL scheme.
  assert.deepEqual(resolveAsset(files, "/a:b.html", ""), { type: "redirect", location: "./a%3Ab" });
  assert.equal(resolveAsset(files, "/a%2Fb", ""), null);
  assert.equal(resolveAsset(files, "/%E0%A4%A", ""), null);
});

test("resolveAsset returns null for empty manifests", () => {
  assert.equal(resolveAsset(new Map(), "/", ""), null);
});

test("ifNoneMatchSatisfied accepts strong, weak, listed and wildcard tags", () => {
  assert.equal(ifNoneMatchSatisfied(null, ETAG), false);
  assert.equal(ifNoneMatchSatisfied(`"${ETAG}"`, ETAG), true);
  assert.equal(ifNoneMatchSatisfied(`W/"${ETAG}"`, ETAG), true);
  assert.equal(ifNoneMatchSatisfied(`"other", W/"${ETAG}"`, ETAG), true);
  assert.equal(ifNoneMatchSatisfied(" * ", ETAG), true);
  assert.equal(ifNoneMatchSatisfied(`"other"`, ETAG), false);
  assert.equal(ifNoneMatchSatisfied(ETAG, ETAG), false);
});
