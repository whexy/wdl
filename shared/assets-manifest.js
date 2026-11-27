// Per-version ASSETS manifest: Control writes it beside __meta__ in the bundle
// hash at deploy; runtime reads it to route requests to assets before the
// Worker runs and to answer env.ASSETS.fetch(). Matching follows Cloudflare's
// defaults (html_handling "auto-trailing-slash", not_found_handling "none"),
// the only ones the CLI can deliver.

import { bytesToHex } from "./hex.js";
import { assetsPrefixFor } from "./assets-token.js";

export const ASSETS_MANIFEST_FIELD = "__assets__";

// Cloudflare's per-version file limit.
export const MAX_ASSET_FILES = 20_000;
// UTF-8 bytes of one asset path; S3 keys cap at 1024 bytes including the prefix.
export const MAX_ASSET_PATH_BYTES = 512;
// UTF-8 bytes of one serialized manifest. Every runtime process caches
// manifests in one shared budget (runtime/assets.js), so a single version must
// stay a small fraction of it.
export const MAX_ASSETS_MANIFEST_BYTES = 4 * 1024 * 1024;

const utf8 = new TextEncoder();

/** @param {string} value */
export function utf8ByteLength(value) {
  return utf8.encode(value).byteLength;
}

const ETAG_RE = /^[0-9a-f]{32}$/;
const MAX_CONTENT_TYPE_LENGTH = 256;
// Header-safe visible ASCII plus space and tab.
const CONTENT_TYPE_RE = /^[\x20-\x7e\t]+$/;

/**
 * @typedef {{ contentType: string, etag: string, size: number }} AssetEntry
 * @typedef {Map<string, AssetEntry>} AssetFiles  Keyed by decoded absolute path ("/a/b.css").
 * @typedef {{ prefix: string, files: AssetFiles }} ParsedAssetsManifest
 * @typedef {{ type: "asset", path: string, entry: AssetEntry } | { type: "redirect", destination: string }} AssetIntent
 */

/**
 * Strong validator for an asset body: the first 128 bits of its SHA-256.
 * @param {Uint8Array} bytes
 * @returns {Promise<string>}
 */
export async function assetEtag(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", /** @type {Uint8Array<ArrayBuffer>} */ (bytes));
  return bytesToHex(new Uint8Array(digest)).slice(0, 32);
}

/** @param {string} path */
function isValidAssetPath(path) {
  return path !== "" && !path.startsWith("/") &&
    path.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/**
 * @param {string} prefix  The version's object prefix, `assets/<ns>/<worker>/<token>/`.
 * @param {Array<{ path: string, contentType: string, etag: string, size: number }>} entries
 * @returns {string}
 */
export function buildAssetsManifest(prefix, entries) {
  /** @type {Record<string, AssetEntry>} */
  const files = Object.create(null);
  for (const { path, contentType, etag, size } of [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    files[path] = { contentType, etag, size };
  }
  return JSON.stringify({ prefix, files });
}

/**
 * Persisted-state reader: anything but the exact grammar fails closed,
 * including a prefix outside the bundle's own namespace and worker.
 * @param {string} text
 * @param {{ ns: string, worker: string }} owner  Identity of the bundle hash it was read from.
 * @returns {ParsedAssetsManifest}
 */
export function parseAssetsManifest(text, { ns, worker }) {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("assets manifest must be a JSON object");
  }
  const { prefix } = parsed;
  const token = typeof prefix === "string" ? prefix.slice(`assets/${ns}/${worker}/`.length, -1) : "";
  let expectedPrefix;
  try {
    expectedPrefix = assetsPrefixFor(ns, worker, token);
  } catch {
    expectedPrefix = null;
  }
  if (prefix !== expectedPrefix) {
    throw new TypeError("assets manifest prefix does not belong to its bundle");
  }
  const files = parsed.files;
  if (!files || typeof files !== "object" || Array.isArray(files)) {
    throw new TypeError("assets manifest files must be an object");
  }
  const keys = Object.keys(files);
  if (keys.length > MAX_ASSET_FILES) {
    throw new TypeError(`assets manifest lists more than ${MAX_ASSET_FILES} files`);
  }
  /** @type {AssetFiles} */
  const out = new Map();
  for (const path of keys) {
    if (!isValidAssetPath(path) || utf8ByteLength(path) > MAX_ASSET_PATH_BYTES) {
      throw new TypeError(`assets manifest path ${JSON.stringify(path)} is invalid`);
    }
    const entry = files[path];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError(`assets manifest entry ${JSON.stringify(path)} must be an object`);
    }
    const { contentType, etag, size } = entry;
    if (
      typeof contentType !== "string" ||
      contentType.length > MAX_CONTENT_TYPE_LENGTH ||
      !CONTENT_TYPE_RE.test(contentType)
    ) {
      throw new TypeError(`assets manifest entry ${JSON.stringify(path)} has an invalid contentType`);
    }
    if (typeof etag !== "string" || !ETAG_RE.test(etag)) {
      throw new TypeError(`assets manifest entry ${JSON.stringify(path)} has an invalid etag`);
    }
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new TypeError(`assets manifest entry ${JSON.stringify(path)} has an invalid size`);
    }
    out.set(`/${path}`, { contentType, etag, size });
  }
  return { prefix, files: out };
}

/**
 * @param {string} pathname  URL-encoded absolute pathname.
 * @returns {string | null}
 */
function decodePathname(pathname) {
  const segments = pathname.split("/");
  const decoded = [];
  for (const segment of segments) {
    let value;
    try {
      value = decodeURIComponent(segment);
    } catch {
      return null;
    }
    // An encoded "/" would alias a different path.
    if (value.includes("/")) return null;
    decoded.push(value);
  }
  return decoded.join("/");
}

/**
 * Cloudflare "auto-trailing-slash": serve /foo from /foo.html and /foo/ from
 * /foo/index.html, and 307 the other spellings to those canonical ones.
 * @param {AssetFiles} files
 * @param {string} pathname  Decoded absolute pathname.
 * @returns {AssetIntent | null}
 */
function autoTrailingSlash(files, pathname) {
  /** @param {string} path @returns {AssetIntent | null} */
  const serve = (path) => {
    const entry = files.get(path);
    return entry ? { type: "asset", path, entry } : null;
  };
  // Never redirect away from a path that is itself an asset.
  /** @param {string} file @param {string} destination @returns {AssetIntent | null} */
  const redirect = (file, destination) =>
    !files.has(destination) && files.has(file) ? { type: "redirect", destination } : null;

  if (pathname.endsWith("/index")) {
    const base = pathname.slice(0, -"/index".length);
    const hit = serve(pathname) ||
      redirect(`${pathname}.html`, `${base}/`) ||
      redirect(`${base}.html`, base);
    if (hit) return hit;
  } else if (pathname.endsWith("/index.html")) {
    const base = pathname.slice(0, -"/index.html".length);
    const hit = redirect(pathname, `${base}/`) || redirect(`${base}.html`, base);
    if (hit) return hit;
  } else if (pathname.endsWith("/")) {
    const base = pathname.slice(0, -1);
    const hit = serve(`${pathname}index.html`) || redirect(`${base}.html`, base);
    if (hit) return hit;
  } else if (pathname.endsWith(".html")) {
    const base = pathname.slice(0, -".html".length);
    const hit = redirect(pathname, base) || redirect(`${base}/index.html`, `${base}/`);
    if (hit) return hit;
  }
  return serve(pathname) ||
    serve(`${pathname}.html`) ||
    redirect(`${pathname}/index.html`, `${pathname}/`);
}

/**
 * Relative reference from `requestPathname` to the Worker-root path
 * `destination`. Relative, so a redirect stays under whatever mount prefix
 * the gateway stripped (`/<worker>` on the namespace host).
 * @param {string} requestPathname  URL-encoded pathname the Worker sees.
 * @param {string} destination  Decoded absolute pathname.
 */
function relativeLocation(requestPathname, destination) {
  const depth = requestPathname.split("/").length - 2;
  const encoded = destination
    .slice(1)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${depth > 0 ? "../".repeat(depth) : "./"}${encoded}`;
}

/**
 * @param {AssetFiles} files
 * @param {string} pathname  URL-encoded pathname the Worker sees.
 * @param {string} search  Query string including "?", or "".
 * @returns {{ type: "asset", path: string, entry: AssetEntry } | { type: "redirect", location: string } | null}
 */
export function resolveAsset(files, pathname, search) {
  if (files.size === 0 || !pathname.startsWith("/")) return null;
  const decoded = decodePathname(pathname);
  if (decoded === null) return null;
  const intent = autoTrailingSlash(files, decoded);
  if (!intent) return null;
  if (intent.type === "asset") return intent;
  return { type: "redirect", location: relativeLocation(pathname, intent.destination) + search };
}

/**
 * @param {string | null} header  If-None-Match value.
 * @param {string} etag  Unquoted asset etag.
 */
export function ifNoneMatchSatisfied(header, etag) {
  if (header === null) return false;
  if (header.trim() === "*") return true;
  const quoted = `"${etag}"`;
  return header.split(",").some((part) => {
    const tag = part.trim();
    return (tag.startsWith("W/") ? tag.slice(2) : tag) === quoted;
  });
}
