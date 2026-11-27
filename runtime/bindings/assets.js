// ASSETS binding shim — sibling to runtime/bindings/kv.js. Props pin the
// loaded version, so rollback flips both url() and fetch() automatically.

import { WorkerEntrypoint } from "cloudflare:workers";
import { buildAssetUrl } from "runtime-lib";
import { fetchAsset } from "runtime-assets";

/**
 * @typedef {{ cdnBase: string, prefix: string, ns: string, worker: string, version: string }} AssetsBindingProps
 */

export class Assets extends WorkerEntrypoint {
  /**
   * @param {unknown} path
   * @returns {string}
   */
  url(path) {
    const { cdnBase, prefix } = /** @type {AssetsBindingProps} */ (this.ctx.props);
    return buildAssetUrl(cdnBase, prefix, path);
  }

  /**
   * @param {Request} request
   * @returns {Promise<Response>}
   */
  async fetch(request) {
    const { ns, worker, version } = /** @type {AssetsBindingProps} */ (this.ctx.props);
    return await fetchAsset({
      env: /** @type {import("runtime-assets").AssetsEnv} */ (this.env),
      ctx: this.ctx,
      request,
      identity: { ns, worker, version },
    });
  }
}
