/**
 * WordPress Plugin Directory ingester.
 * Downloads plugin ZIP artifacts from wordpress.org and captures rich metadata.
 *
 * Usage:
 *   npx tsx src/wordpress/ingest.ts --max-plugins 100 --min-installs 10000
 *   npx tsx src/wordpress/ingest.ts --max-plugins 0   # no limit
 */
import { join } from "path";
import { program } from "commander";
import { RateLimitedClient } from "../common/http.js";
import { DownloadState } from "../common/state.js";
import type { PackageMetadata } from "../common/types.js";

export const ECOSYSTEM = "wordpress";
const WP_API = "https://api.wordpress.org/plugins/info/1.2/";
const PAGE_SIZE = 250;

interface WpPlugin {
  slug: string;
  name: string;
  version: string;
  author?: string;
  author_profile?: string;
  requires?: string;
  tested?: string;
  requires_php?: string;
  rating?: number;
  num_ratings?: number;
  support_threads?: number;
  support_threads_resolved?: number;
  active_installs?: number;
  downloaded?: number;
  last_updated?: string;
  added?: string;
  homepage?: string;
  download_link?: string;
  short_description?: string;
  description?: string;
  tags?: Record<string, string>;
  donate_link?: string;
  license?: string;
  license_uri?: string;
  contributors?: Record<string, unknown>;
}

interface WpApiResponse {
  info?: { pages?: number };
  plugins?: WpPlugin[];
}

export async function listPlugins(
  client: RateLimitedClient,
  page: number,
  minInstalls = 0
): Promise<{ plugins: WpPlugin[]; totalPages: number }> {
  const params = new URLSearchParams({
    action: "query_plugins",
    "request[per_page]": String(PAGE_SIZE),
    "request[page]": String(page),
    "request[fields][active_installs]": "1",
    "request[fields][downloaded]": "1",
    "request[fields][download_link]": "1",
    "request[fields][last_updated]": "1",
    "request[fields][added]": "1",
    "request[fields][author]": "1",
    "request[fields][rating]": "1",
    "request[fields][num_ratings]": "1",
    "request[fields][requires]": "1",
    "request[fields][tested]": "1",
    "request[fields][requires_php]": "1",
    "request[fields][short_description]": "1",
    "request[fields][homepage]": "1",
    "request[fields][donate_link]": "1",
    "request[fields][tags]": "1",
    "request[fields][contributors]": "1",
    "request[fields][support_threads]": "1",
    "request[fields][license]": "1",
  });
  const data = await client.getJson<WpApiResponse>(`${WP_API}?${params}`);
  let plugins = data.plugins ?? [];
  if (minInstalls > 0) {
    plugins = plugins.filter((p) => (p.active_installs ?? 0) >= minInstalls);
  }
  return { plugins, totalPages: data.info?.pages ?? 1 };
}

export function toMetadata(plugin: WpPlugin): PackageMetadata {
  return {
    ecosystem: ECOSYSTEM,
    slug: plugin.slug,
    name: plugin.name,
    currentVersion: plugin.version,
    description: plugin.short_description ?? plugin.description,
    homepageUrl: plugin.homepage,
    downloadUrl: plugin.download_link,
    author: plugin.author
      ? plugin.author.replace(/<[^>]+>/g, "").trim()
      : undefined,
    authorProfileUrl: plugin.author_profile,
    license: plugin.license,
    tags: plugin.tags ? Object.values(plugin.tags) : undefined,
    registryAddedDate: plugin.added,
    lastUpdatedDate: plugin.last_updated,
    downloadCount: plugin.downloaded,
    activeInstalls: plugin.active_installs,
    rating: plugin.rating,
    numRatings: plugin.num_ratings,
    rawMetadata: JSON.stringify({
      requires: plugin.requires,
      tested: plugin.tested,
      requires_php: plugin.requires_php,
      support_threads: plugin.support_threads,
      support_threads_resolved: plugin.support_threads_resolved,
      donate_link: plugin.donate_link,
      contributors: plugin.contributors
        ? Object.keys(plugin.contributors)
        : undefined,
    }),
  };
}

export async function downloadPlugin(
  client: RateLimitedClient,
  state: DownloadState,
  plugin: WpPlugin,
  outputDir: string
): Promise<boolean> {
  const { slug, version } = plugin;
  const url =
    plugin.download_link ??
    `https://downloads.wordpress.org/plugin/${slug}.${version}.zip`;

  if (state.isDownloaded(ECOSYSTEM, slug, version)) {
    return false;
  }

  const destPath = join(outputDir, ECOSYSTEM, `${slug}.${version}.zip`);
  try {
    const fileHash = await client.download(url, destPath);
    state.record(ECOSYSTEM, slug, version, destPath, fileHash);
    return true;
  } catch (err) {
    console.warn(`[wordpress] Failed ${slug}: ${(err as Error).message}`);
    return false;
  }
}

async function main() {
  program
    .option("--max-plugins <n>", "stop after N downloads (0 = unlimited)", "0")
    .option("--min-installs <n>", "skip plugins below this install count", "1000")
    .option("--output-dir <dir>", "output directory", "output")
    .option("--db <path>", "sqlite db path", "data/downloads.db")
    .option("--requests-per-second <n>", "rate limit", "2")
    .option("-v, --verbose", "verbose logging")
    .parse();

  const opts = program.opts();
  const maxPlugins = parseInt(opts.maxPlugins);
  const minInstalls = parseInt(opts.minInstalls);
  const rps = parseFloat(opts.requestsPerSecond);
  if (opts.verbose) process.env.VERBOSE = "1";

  const client = new RateLimitedClient(rps);
  const state = new DownloadState(opts.db);
  const seenSlugs = new Set<string>();

  let downloaded = 0;
  let page = 1;
  let stop = false;

  while (!stop) {
    let plugins: WpPlugin[];
    let totalPages: number;
    try {
      ({ plugins, totalPages } = await listPlugins(client, page, minInstalls));
    } catch (err) {
      console.error(`[wordpress] Page ${page} failed: ${(err as Error).message}`);
      break;
    }

    if (plugins.length === 0) break;

    for (const plugin of plugins) {
      seenSlugs.add(plugin.slug);
      state.upsertMetadata(toMetadata(plugin));

      if (maxPlugins > 0 && downloaded >= maxPlugins) {
        console.log(`[wordpress] Reached --max-plugins=${maxPlugins}, stopping.`);
        stop = true;
        break;
      }
      if (await downloadPlugin(client, state, plugin, opts.outputDir)) {
        downloaded++;
        console.log(`[wordpress] Downloaded ${plugin.slug} ${plugin.version}`);
      }
    }

    if (!stop) {
      if (page >= totalPages) break;
      page++;
    }
  }

  const removed = state.markRemovedIfAbsent(ECOSYSTEM, seenSlugs);
  if (removed > 0) console.log(`[wordpress] Marked ${removed} plugins as removed from registry.`);
  console.log(`[wordpress] Done. ${downloaded} downloaded. DB totals:`, state.stats());
  console.log(`[wordpress] Metadata tracked:`, state.metadataStats());
  state.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
