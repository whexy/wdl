#!/usr/bin/env node
// Reports a failed upstream sync to the T3 Code webhook in T3_REPAIR_WEBHOOK,
// whose scheduled task starts an agent run that repairs the branch. The task
// drops duplicates by kind, stage, commit and release tag, so a sync stuck on
// one release reports once however many daily runs fail on it. STATE_DIR is
// sync.sh's state directory.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** @param {string} name */
function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}

const kind = process.argv[2];
if (kind !== "sync") throw new Error("Usage: report-failure.mjs sync");

const stateDir = env("STATE_DIR");
/** @param {string} name */
const state = (name) => {
  const file = path.join(stateDir, name);
  return existsSync(file) ? readFileSync(file, "utf8").trim() : "";
};

const payload = {
  kind,
  stage: state("stage") || "setup",
  branch: "main",
  commit: state("start") || env("CI_COMMIT_SHA"),
  release_tag: state("tag"),
  result: state("result"),
  pipeline: env("CI_PIPELINE_NUMBER"),
  pipeline_url: process.env.CI_PIPELINE_URL ?? "",
};
console.log(
  `state=FAILED(${payload.stage}) tag=${payload.release_tag} start=${payload.commit} result=${payload.result}`,
);

const response = await fetch(env("T3_REPAIR_WEBHOOK"), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
  signal: AbortSignal.timeout(30_000),
});
if (!response.ok) {
  throw new Error(`The repair webhook answered ${response.status}: ${await response.text()}`);
}
console.log(`Reported the failure: ${response.headers.get("x-t3-hook-outcome")}`);
