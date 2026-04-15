/**
 * Drupal module registry ingester.
 * Downloads tarballs from ftp.drupal.org and captures module metadata.
 *
 * Usage:
 *   npx tsx src/drupal/ingest.ts --max-modules 200 --core-compat 10.x
 */
import { join } from "path";
import { program } from "commander";
import { RateLimitedClient } from "../common/http.js";
import { DownloadState } from "../common/state.js";
import type { PackageMetadata } from "../common/types.js";

export const ECOSYSTEM = "drupal";
const DRUPAL_API = "https://www.drupal.org/api-d7/node.json";
const PAGE_SIZE = 100;

interface DrupalModule {
  nid: string | number;
  title: string;
  field_project_machine_name: string;
  body?: { value?: string; summary?: string };
  created?: string | number;
  changed?: string | number;
  field_project_type?: string;
  field_project_has_releases?: boolean;
  field_project_homepage?: { url?: string };
  field_project_license?: { title?: string };
}

interface DrupalRelease {
  field_release_version: string;
  changed?: string | number;
}

interface DrupalListResponse<T> {
  list?: T[];
  next?: string;
}

export async function listModules(
  client: RateLimitedClient,
  page: number
): Promise<{ modules: DrupalModule[]; hasMore: boolean }> {
  const params = new URLSearchParams({
    type: "project_module",
    field_project_type: "full",
    limit: String(PAGE_SIZE),
    page: String(page),
    sort: "changed",
    direction: "DESC",
  });
  const data = await client.getJson<DrupalListResponse<DrupalModule>>(
    `${DRUPAL_API}?${params}`
  );
  return {
    modules: data.list ?? [],
    hasMore: Boolean(data.next),
  };
}

/**
 * Return the latest stable release for a module.
 * D8/D9/D10 compatible modules use the "8.x-" version prefix.
 * D7 modules use "7.x-". Newer modules use semantic versioning.
 * URL is constructed directly from the known ftp.drupal.org pattern.
 */
export async function getLatestRelease(
  client: RateLimitedClient,
  nid: string | number,
  coreCompat: string,
  slug: string
): Promise<{ version: string; url: string } | null> {
  const isD7 = coreCompat.startsWith("7");
  const params = new URLSearchParams({
    type: "project_release",
    field_release_project: String(nid),
    limit: "10",
    sort: "changed",
    direction: "DESC",
  });
  const data = await client.getJson<DrupalListResponse<DrupalRelease>>(
    `${DRUPAL_API}?${params}`
  );

  for (const release of data.list ?? []) {
    const version = release.field_release_version ?? "";
    if (!version || version.includes("-dev")) continue;
    if (isD7) {
      if (!version.startsWith("7.x-")) continue;
    } else {
      // D8/D9/D10: accept 8.x- prefix or semantic versioning; skip D7-only
      if (version.startsWith("7.x-")) continue;
    }
    return {
      version,
      url: `https://ftp.drupal.org/files/projects/${slug}-${version}.tar.gz`,
    };
  }
  return null;
}

export function toMetadata(mod: DrupalModule): PackageMetadata {
  const slug = mod.field_project_machine_name;
  const createdTs = mod.created ? Number(mod.created) * 1000 : undefined;
  const changedTs = mod.changed ? Number(mod.changed) * 1000 : undefined;

  return {
    ecosystem: ECOSYSTEM,
    slug,
    name: mod.title,
    description: mod.body?.summary ?? mod.body?.value?.slice(0, 500),
    homepageUrl: mod.field_project_homepage?.url,
    license: mod.field_project_license?.title,
    registryAddedDate: createdTs ? new Date(createdTs).toISOString() : undefined,
    lastUpdatedDate: changedTs ? new Date(changedTs).toISOString() : undefined,
    rawMetadata: JSON.stringify({
      nid: mod.nid,
      project_type: mod.field_project_type,
      has_releases: mod.field_project_has_releases,
    }),
  };
}

export async function downloadModule(
  client: RateLimitedClient,
  state: DownloadState,
  mod: DrupalModule,
  coreCompat: string,
  outputDir: string
): Promise<boolean> {
  const slug = mod.field_project_machine_name;
  const nid = mod.nid;
  if (!slug || !nid) return false;

  const release = await getLatestRelease(client, nid, coreCompat, slug);
  if (!release) return false;

  const { version, url } = release;
  if (state.isDownloaded(ECOSYSTEM, slug, version)) return false;

  const destPath = join(outputDir, ECOSYSTEM, `${slug}.${version}.tar.gz`);
  try {
    const fileHash = await client.download(url, destPath);
    state.record(ECOSYSTEM, slug, version, destPath, fileHash);
    return true;
  } catch (err) {
    console.warn(`[drupal] Failed ${slug}: ${(err as Error).message}`);
    return false;
  }
}

async function main() {
  program
    .option("--max-modules <n>", "stop after N downloads (0 = unlimited)", "0")
    .option("--core-compat <v>", "Drupal core version", "10.x")
    .option("--output-dir <dir>", "output directory", "output")
    .option("--db <path>", "sqlite db path", "data/downloads.db")
    .option("--requests-per-second <n>", "rate limit", "1")
    .option("-v, --verbose", "verbose logging")
    .parse();

  const opts = program.opts();
  const maxModules = parseInt(opts.maxModules);

  const client = new RateLimitedClient(parseFloat(opts.requestsPerSecond));
  const state = new DownloadState(opts.db);
  const seenSlugs = new Set<string>();

  let downloaded = 0;
  let page = 0;
  let hasMore = true;

  while (hasMore) {
    let modules: DrupalModule[];
    let nextHasMore: boolean;
    try {
      ({ modules, hasMore: nextHasMore } = await listModules(client, page));
    } catch (err) {
      console.error(`[drupal] Page ${page} failed: ${(err as Error).message}`);
      break;
    }

    if (modules.length === 0) break;

    for (const mod of modules) {
      const slug = mod.field_project_machine_name;
      if (slug) {
        seenSlugs.add(slug);
        state.upsertMetadata(toMetadata(mod));
      }

      if (maxModules > 0 && downloaded >= maxModules) {
        console.log(`[drupal] Reached --max-modules=${maxModules}, stopping.`);
        hasMore = false;
        break;
      }
      if (await downloadModule(client, state, mod, opts.coreCompat, opts.outputDir)) {
        downloaded++;
        console.log(`[drupal] Downloaded ${slug}`);
      }
    }

    if (hasMore) {
      hasMore = nextHasMore;
      page++;
    }
  }

  const removed = state.markRemovedIfAbsent(ECOSYSTEM, seenSlugs);
  if (removed > 0) console.log(`[drupal] Marked ${removed} modules as removed.`);
  console.log(`[drupal] Done. ${downloaded} downloaded. DB totals:`, state.stats());
  console.log(`[drupal] Metadata tracked:`, state.metadataStats());
  state.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
