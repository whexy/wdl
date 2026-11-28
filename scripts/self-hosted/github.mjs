#!/usr/bin/env node
// GitHub access for the upstream sync (.woodpecker/self-hosted-sync.yaml), as
// the whexy-bot App from GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID and
// GITHUB_APP_PRIVATE_KEY. CI_REPO names this repository as owner/name.
//
//   token                     prints an installation token for this repository
//   release                   prints upstream's latest release tag
//   pull-request TITLE BODY   opens or updates the sync pull request, BODY a file
//   close-pull-request NOTE   closes the open sync pull request with a comment
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const UPSTREAM = "wdl-dev/wdl";
const SYNC_BRANCH = "self-hosted-sync";
const BASE_BRANCH = "main";
const RELEASE_TAG = /^wdl\.\d{8}\.\d+$/u;

/** @param {string} name */
function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}

/**
 * @param {string} token
 * @param {string} path
 * @param {{ method?: string, body?: unknown }} [init]
 * @returns {Promise<any>}
 */
async function github(token, path, { method = "GET", body } = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`GitHub ${method} ${path} answered ${response.status}: ${await response.text()}`);
  }
  return response.status === 204 ? null : response.json();
}

async function installationToken() {
  /** @param {unknown} value */
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  // GitHub rejects an `iat` ahead of its clock, so back-date it for skew.
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iat: now - 60,
    exp: now + 540,
    iss: env("GITHUB_APP_ID"),
  })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(env("GITHUB_APP_PRIVATE_KEY"));
  const jwt = `${unsigned}.${signature.toString("base64url")}`;
  // The App is installed account-wide, so scope the token to this repository.
  const { token } = await github(
    jwt,
    `/app/installations/${env("GITHUB_APP_INSTALLATION_ID")}/access_tokens`,
    { method: "POST", body: { repositories: [env("CI_REPO").split("/")[1]] } },
  );
  return /** @type {string} */ (token);
}

/** @param {string} token */
async function latestRelease(token) {
  // The latest endpoint already excludes drafts and prereleases.
  const { tag_name: tag } = await github(token, `/repos/${UPSTREAM}/releases/latest`);
  if (typeof tag !== "string" || !RELEASE_TAG.test(tag)) {
    throw new Error(`Upstream's latest release has an unexpected tag: ${tag}`);
  }
  return tag;
}

/** @param {string} token */
async function openSyncPullRequest(token) {
  const repo = env("CI_REPO");
  const owner = repo.split("/")[0];
  const pulls = await github(
    token,
    `/repos/${repo}/pulls?state=open&base=${BASE_BRANCH}&head=${owner}:${SYNC_BRANCH}`,
  );
  return /** @type {{ number: number, html_url: string } | undefined} */ (pulls[0]);
}

/** @param {string[]} argv */
async function main([command, ...args]) {
  const repo = env("CI_REPO");
  const token = await installationToken();
  switch (command) {
    case "token":
      return token;
    case "release":
      return latestRelease(token);
    case "pull-request": {
      const [title, bodyFile] = args;
      if (!title || !bodyFile) throw new Error("Usage: github.mjs pull-request TITLE BODY_FILE");
      const body = readFileSync(bodyFile, "utf8");
      const open = await openSyncPullRequest(token);
      const pull = open
        ? await github(token, `/repos/${repo}/pulls/${open.number}`, {
            method: "PATCH",
            body: { title, body },
          })
        : await github(token, `/repos/${repo}/pulls`, {
            method: "POST",
            body: { title, body, head: SYNC_BRANCH, base: BASE_BRANCH, maintainer_can_modify: true },
          });
      return /** @type {string} */ (pull.html_url);
    }
    case "close-pull-request": {
      const [note] = args;
      if (!note) throw new Error("Usage: github.mjs close-pull-request NOTE");
      const open = await openSyncPullRequest(token);
      if (!open) return "";
      await github(token, `/repos/${repo}/issues/${open.number}/comments`, {
        method: "POST",
        body: { body: note },
      });
      await github(token, `/repos/${repo}/pulls/${open.number}`, {
        method: "PATCH",
        body: { state: "closed" },
      });
      return open.html_url;
    }
    default:
      throw new Error("Usage: github.mjs <token|release|pull-request|close-pull-request>");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(await main(process.argv.slice(2)));
}
