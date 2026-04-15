/**
 * Joomla Extension Directory ingester.
 * JED does not host downloads centrally. GitHub-hosted extensions are downloaded
 * via GitHub Releases. Others are logged to manual_review.tsv.
 *
 * Usage:
 *   npx tsx src/joomla/ingest.ts --max-extensions 100
 *   npx tsx src/joomla/ingest.ts --max-extensions 100 --github-token ghp_xxx
 */
import { join } from "path";
import { mkdirSync, createWriteStream } from "fs";
import { program } from "commander";
import { RateLimitedClient } from "../common/http.js";
import { DownloadState } from "../common/state.js";
import type { PackageMetadata } from "../common/types.js";

export const ECOSYSTEM = "joomla";
const JED_API = "https://extensions.joomla.org/index.php";
const GITHUB_API = "https://api.github.com";
const PAGE_SIZE = 20;

// JED field values come as either plain strings or {value, text} objects
type JedField = string | { value?: string; text?: string } | null | undefined;

function jedStr(field: JedField): string {
  if (!field) return "";
  if (typeof field === "string") return field;
  return field.value ?? field.text ?? "";
}

function jedNum(field: JedField): number | undefined {
  const s = jedStr(field);
  const n = parseFloat(s);
  return isNaN(n) ? undefined : n;
}

interface JedExtension {
  id?: string | number;
  core_title?: JedField;
  core_alias?: JedField;
  core_body?: JedField;
  core_created_time?: JedField;
  core_modified_time?: JedField;
  core_hits?: JedField;
  version?: JedField;
  type?: JedField;
  license?: JedField;
  score?: JedField;
  num_reviews?: JedField;
  functionality?: JedField;
  ease_of_use?: JedField;
  support?: JedField;
  documentation?: JedField;
  value_for_money?: JedField;
  download_link?: JedField;
  homepage_link?: JedField;
  download_integration_url?: JedField;
  approved?: JedField;
  approved_time?: JedField;
  community_choice?: JedField;
  popular?: JedField;
  tags?: unknown;
  // old format
  url?: string;
  download_url?: string;
  alias?: string;
  element?: string;
}

export function listExtensions(
  client: RateLimitedClient,
  start: number
): Promise<JedExtension[]> {
  const params = new URLSearchParams({
    option: "com_jed",
    view: "extension",
    format: "json",
    limit: String(PAGE_SIZE),
    start: String(start),
    orderby: "popular",
  });
  return client
    .getJson<JedExtension[] | { data?: JedExtension[]; extensions?: JedExtension[]; list?: JedExtension[] }>(
      `${JED_API}?${params}`
    )
    .then((data) => {
      if (Array.isArray(data)) return data;
      return (
        (data as { data?: JedExtension[] }).data ??
        (data as { extensions?: JedExtension[] }).extensions ??
        (data as { list?: JedExtension[] }).list ??
        []
      );
    })
    .catch(() => []);
}

export function extractGithubRepo(ext: JedExtension): string | null {
  const text = [
    ext.url ?? "",
    ext.download_url ?? "",
    jedStr(ext.homepage_link),
    jedStr(ext.download_link),
    jedStr(ext.download_integration_url),
  ].join(" ");

  const match = text.match(/github\.com[:/]([^/\s]+\/[^/\s.#?]+)/);
  if (!match) return null;
  return match[1].replace(/\/$/, "").replace(/\.git$/, "");
}

export function toMetadata(ext: JedExtension): PackageMetadata {
  const slug =
    jedStr(ext.core_alias) ||
    (ext.alias as string) ||
    (ext.element as string) ||
    String(ext.id ?? "unknown");

  const tags: string[] = [];
  if (ext.tags && typeof ext.tags === "object") {
    for (const tag of Object.values(ext.tags as Record<string, unknown>)) {
      if (typeof tag === "string") tags.push(tag);
      else if (tag && typeof tag === "object" && "name" in tag) {
        tags.push(String((tag as { name: string }).name));
      }
    }
  }

  return {
    ecosystem: ECOSYSTEM,
    slug,
    name: jedStr(ext.core_title) || slug,
    currentVersion: jedStr(ext.version) || undefined,
    description: jedStr(ext.core_body)?.slice(0, 500) || undefined,
    homepageUrl: jedStr(ext.homepage_link) || undefined,
    downloadUrl: jedStr(ext.download_link) || jedStr(ext.download_integration_url) || undefined,
    license: jedStr(ext.license) || undefined,
    tags: tags.length > 0 ? tags : undefined,
    registryAddedDate: jedStr(ext.core_created_time) || undefined,
    lastUpdatedDate: jedStr(ext.core_modified_time) || undefined,
    downloadCount: jedNum(ext.core_hits),  // page hits, best available proxy
    rating: jedNum(ext.score),
    numRatings: jedNum(ext.num_reviews),
    rawMetadata: JSON.stringify({
      type: jedStr(ext.type),
      approved_time: jedStr(ext.approved_time),
      community_choice: jedStr(ext.community_choice),
      popular: jedStr(ext.popular),
      review_scores: {
        functionality: jedNum(ext.functionality),
        ease_of_use: jedNum(ext.ease_of_use),
        support: jedNum(ext.support),
        documentation: jedNum(ext.documentation),
        value_for_money: jedNum(ext.value_for_money),
      },
    }),
  };
}

interface GitHubRelease {
  tag_name?: string;
  zipball_url?: string;
}

export async function downloadFromGithub(
  client: RateLimitedClient,
  state: DownloadState,
  githubToken: string | undefined,
  repo: string,
  slug: string,
  outputDir: string
): Promise<boolean> {
  const headers: Record<string, string> = {};
  if (githubToken) headers["Authorization"] = `token ${githubToken}`;

  try {
    const release = await client.getJson<GitHubRelease>(
      `${GITHUB_API}/repos/${repo}/releases/latest`,
      { headers }
    );
    const version = release.tag_name ?? "unknown";
    const zipballUrl = release.zipball_url;
    if (!zipballUrl) return false;

    if (state.isDownloaded(ECOSYSTEM, slug, version)) return false;

    const destPath = join(outputDir, ECOSYSTEM, `${slug}.${version}.zip`);
    const fileHash = await client.download(zipballUrl, destPath);
    state.record(ECOSYSTEM, slug, version, destPath, fileHash);
    return true;
  } catch (err) {
    console.warn(`[joomla] GitHub download failed for ${repo}: ${(err as Error).message}`);
    return false;
  }
}

async function main() {
  program
    .option("--max-extensions <n>", "stop after N downloads (0 = unlimited)", "0")
    .option("--output-dir <dir>", "output directory", "output")
    .option("--db <path>", "sqlite db path", "data/downloads.db")
    .option("--github-token <token>", "GitHub PAT for higher rate limits")
    .option("--requests-per-second <n>", "rate limit", "1")
    .option("-v, --verbose", "verbose logging")
    .parse();

  const opts = program.opts();
  const maxExtensions = parseInt(opts.maxExtensions);

  const client = new RateLimitedClient(parseFloat(opts.requestsPerSecond));
  const state = new DownloadState(opts.db);
  const seenSlugs = new Set<string>();
  const manualReview: string[] = [];

  let downloaded = 0;
  let start = 0;
  let stop = false;

  while (!stop) {
    const extensions = await listExtensions(client, start);
    if (extensions.length === 0) {
      console.log(`[joomla] No extensions at start=${start}, stopping.`);
      break;
    }

    for (const ext of extensions) {
      const meta = toMetadata(ext);
      seenSlugs.add(meta.slug);
      state.upsertMetadata(meta);

      if (maxExtensions > 0 && downloaded >= maxExtensions) {
        console.log(`[joomla] Reached --max-extensions=${maxExtensions}, stopping.`);
        stop = true;
        break;
      }

      const repo = extractGithubRepo(ext);
      if (repo) {
        if (
          await downloadFromGithub(
            client,
            state,
            opts.githubToken,
            repo,
            meta.slug,
            opts.outputDir
          )
        ) {
          downloaded++;
          console.log(`[joomla] Downloaded ${meta.slug} (GitHub:${repo})`);
        }
      } else {
        const fallbackUrl = meta.downloadUrl ?? "";
        manualReview.push(`${meta.slug}\t${fallbackUrl}`);
      }
    }

    if (!stop) start += PAGE_SIZE;
  }

  if (manualReview.length > 0) {
    const reviewDir = join(opts.outputDir, ECOSYSTEM);
    mkdirSync(reviewDir, { recursive: true });
    const reviewPath = join(reviewDir, "manual_review.tsv");
    const stream = createWriteStream(reviewPath);
    stream.write("slug\turl\n");
    stream.write(manualReview.join("\n"));
    stream.end();
    console.log(`[joomla] Logged ${manualReview.length} extensions for manual review -> ${reviewPath}`);
  }

  const removed = state.markRemovedIfAbsent(ECOSYSTEM, seenSlugs);
  if (removed > 0) console.log(`[joomla] Marked ${removed} extensions as removed.`);
  console.log(`[joomla] Done. ${downloaded} downloaded. DB totals:`, state.stats());
  console.log(`[joomla] Metadata tracked:`, state.metadataStats());
  state.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
