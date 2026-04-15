# CMS Marketplace Ingesters

Bulk-downloads plugin and module artifacts from WordPress, Drupal, and Joomla for security research. Each ecosystem has its own ingester script that:

1. Pages through the registry API to discover all available packages
2. Downloads the artifact (ZIP or tarball) to a local directory
3. Records metadata and download state in a SQLite database
4. Detects packages that have been removed from the registry since the last run

The **TypeScript version** (`ts/`) is the canonical implementation used by the scanner pipeline. The **Python version** (root) is kept as a reference and is fully working.

---

## Table of Contents

- [Quick Start (TypeScript)](#quick-start-typescript)
- [Quick Start (Python)](#quick-start-python)
- [Repository Structure](#repository-structure)
- [Architecture Overview](#architecture-overview)
- [Common Layer Deep Dive](#common-layer-deep-dive)
  - [types.ts](#typests)
  - [state.ts / state.py](#statets--statepy)
  - [http.ts / http.py](#httpts--httppy)
- [Ecosystem Ingesters](#ecosystem-ingesters)
  - [WordPress](#wordpress)
  - [Drupal](#drupal)
  - [Joomla](#joomla)
- [Database Schema](#database-schema)
- [CLI Options Reference](#cli-options-reference)
- [Running as a Cron Job](#running-as-a-cron-job)
- [Scanner Integration Hook](#scanner-integration-hook)
- [Adding a New Ecosystem](#adding-a-new-ecosystem)
- [Test Suite](#test-suite)
- [Known Quirks and Design Decisions](#known-quirks-and-design-decisions)

---

## Quick Start (TypeScript)

**Requirements:** Node.js 18+ (tested on Node 24)

```bash
cd ts
npm install

# Download the 10 most-installed WordPress plugins
npm run wordpress -- --max-plugins 10 --min-installs 1000000

# Download 10 Drupal modules compatible with Drupal 10
npm run drupal -- --max-modules 10 --core-compat 10.x

# Download 20 Joomla extensions (GitHub-hosted ones)
npm run joomla -- --max-extensions 20

# Run the test suite (45 tests, ~0.5s)
npm test
```

Artifacts land in `ts/output/{ecosystem}/`. State is tracked in `ts/data/downloads.db`.

---

## Quick Start (Python)

**Requirements:** Python 3.10+

```bash
# Install dependencies
pip install -r requirements.txt

# Run from the repo root (not inside a subdirectory)
python -m wordpress.ingest --max-plugins 10 --min-installs 1000000
python -m drupal.ingest    --max-modules 10 --core-compat 10.x
python -m joomla.ingest    --max-extensions 20

# Run the test suite (27 tests)
pytest tests/ -v
```

Artifacts land in `output/{ecosystem}/`. State is tracked in `data/downloads.db`.

---

## Repository Structure

```
marketplaces/
│
├── ts/                          # TypeScript version (canonical for pipeline)
│   ├── src/
│   │   ├── common/
│   │   │   ├── types.ts         # PackageMetadata interface + shared types
│   │   │   ├── state.ts         # SQLite download tracker + metadata store
│   │   │   └── http.ts          # Rate-limited HTTP client with retry
│   │   ├── wordpress/
│   │   │   └── ingest.ts        # WordPress Plugin Directory ingester
│   │   ├── drupal/
│   │   │   └── ingest.ts        # Drupal.org module ingester
│   │   └── joomla/
│   │       └── ingest.ts        # JED + GitHub Releases ingester
│   ├── tests/
│   │   ├── state.test.ts        # 10 tests for DownloadState
│   │   ├── http.test.ts         # 6 tests for RateLimitedClient
│   │   ├── wordpress.test.ts    # 6 tests for WP ingester
│   │   ├── drupal.test.ts       # 9 tests for Drupal ingester
│   │   └── joomla.test.ts       # 14 tests for Joomla ingester
│   ├── package.json
│   ├── tsconfig.json
│   └── vitest.config.ts
│
├── common/                      # Python shared modules
│   ├── state.py                 # SQLite download tracker
│   └── http.py                  # Rate-limited requests.Session
├── wordpress/
│   └── ingest.py
├── drupal/
│   └── ingest.py
├── joomla/
│   └── ingest.py
├── tests/                       # Python test suite
├── requirements.txt
│
├── output/                      # Downloaded artifacts (gitignored)
│   ├── wordpress/
│   ├── drupal/
│   └── joomla/
└── data/                        # SQLite databases (gitignored)
    └── downloads.db
```

---

## Architecture Overview

Every ingester follows the same loop:

```
while pages remain:
    page = fetch_registry_page(page_number)
    for each package in page:
        upsertMetadata(package)       # always save what we discovered
        if already_downloaded(slug, version):
            continue                  # skip, SQLite PRIMARY KEY dedup
        artifact = download(url)      # stream to output/ecosystem/
        record(slug, version, hash)   # mark done in SQLite
markRemovedIfAbsent(seenSlugs)        # flag anything that disappeared
```

The **state database** is the central coordination point. It has two tables:

- `downloads` -- every artifact that was actually downloaded (slug + version + file path + SHA256 hash)
- `packages` -- every package we have ever seen in a registry listing, with its full metadata and a removal flag

Because the PRIMARY KEY on `downloads` is `(ecosystem, slug, version)`, running the same ingester twice in a row is always safe: the second run finds all packages already recorded and skips the download, finishing in seconds.

---

## Common Layer Deep Dive

### types.ts

`ts/src/common/types.ts` defines three TypeScript types used across all ingesters:

**`PackageMetadata`** is the canonical shape for every discovered package, regardless of whether we downloaded its artifact. Fields:

| Field | Source |
|---|---|
| `ecosystem` | `"wordpress"`, `"drupal"`, or `"joomla"` |
| `slug` | Unique identifier within the ecosystem (e.g. `akismet`) |
| `name` | Human-readable display name |
| `currentVersion` | Latest version string |
| `description` | Short description (capped at 500 chars for Joomla) |
| `homepageUrl` | Plugin homepage |
| `downloadUrl` | Direct download link (where available) |
| `author` | Author name (HTML stripped for WordPress) |
| `authorProfileUrl` | Author's profile on the registry |
| `registryAddedDate` | ISO date when first published |
| `lastUpdatedDate` | ISO date of last update |
| `downloadCount` | All-time download count (WordPress: exact; Joomla: page-hit proxy) |
| `activeInstalls` | Active WordPress installations (WordPress only) |
| `rating` | Numeric rating (WordPress: 0-100; Joomla: score) |
| `numRatings` | Number of reviews |
| `rawMetadata` | JSON string of ecosystem-specific fields that don't fit above |

**`DownloadRecord`** is the shape of a row from the `downloads` table.

**`EcosystemStats`** is `Record<string, number>` -- a map of ecosystem name to count.

---

### state.ts / state.py

The TypeScript version (`ts/src/common/state.ts`) uses `better-sqlite3` (a synchronous SQLite binding for Node.js). The Python version (`common/state.py`) uses the stdlib `sqlite3` module.

Both expose the same conceptual API:

```
new DownloadState(dbPath)
  isDownloaded(ecosystem, slug, version) → boolean
  record(ecosystem, slug, version, filePath, fileHash)
  upsertMetadata(meta: PackageMetadata)           [TypeScript only]
  markRemovedIfAbsent(ecosystem, seenSlugs) → number  [TypeScript only]
  stats() → { wordpress: N, drupal: N, ... }
  metadataStats() → { wordpress: N, ... }         [TypeScript only]
  close()
```

**Why synchronous SQLite?**

The ingesters are I/O-bound on network, not on the database. Using a synchronous SQLite binding keeps the code simple: no `await` noise around every DB call, no transaction management needed. Each `record()` call is a single `INSERT OR REPLACE` that takes microseconds.

**`upsertMetadata` detail**

The SQL is an `INSERT ... ON CONFLICT DO UPDATE SET`. This means:
- First time we see a slug: inserts a new row with `is_removed = 0` and `first_seen_at = now`
- Subsequent runs: updates all metadata fields but leaves `first_seen_at` untouched
- If a package was previously marked removed and reappears: sets `is_removed = 0` and clears `removed_at`

**`markRemovedIfAbsent` detail**

Called once at the end of each full run, after we've paged through the entire registry. It:
1. Queries all packages for this ecosystem where `is_removed = 0`
2. For each one NOT in `seenSlugs`, runs `UPDATE ... SET is_removed=1, removed_at=datetime('now')`
3. Returns the count of newly-removed packages

This is how the system detects that a plugin was taken down from the registry between runs.

---

### http.ts / http.py

**TypeScript (`ts/src/common/http.ts`)** exposes `RateLimitedClient` with:

```typescript
new RateLimitedClient(requestsPerSecond: number = 1.0)
  get(url, options?) → Promise<Response>
  getJson<T>(url, options?) → Promise<T>
  download(url, destPath) → Promise<string>   // returns sha256 hex
```

**Rate limiting:** Before every request, a private `wait()` method computes `elapsed = now - lastRequest`. If `elapsed < minInterval` (where `minInterval = 1000ms / rps`), it sleeps for the difference. This is a simple token-bucket that allows exactly one request per interval, smoothing out bursts.

**Retry logic:** `withRetry(fn, maxRetries=3)` wraps every request. It retries only on HTTP status codes `429, 500, 502, 503, 504` with exponential backoff: 1s, 2s, 4s. Errors without a status code (network errors) are re-thrown immediately without retrying, because they usually mean the server is down.

**Streaming download:** `download()` uses the native `fetch` API with `response.body` (a `ReadableStream`). It converts this to a Node.js `Readable` stream with `Readable.fromWeb()`, then pipes it through an async generator that computes the SHA256 hash chunk-by-chunk while writing to disk. This means arbitrarily large files are handled without loading the whole thing into memory.

**Python (`common/http.py`)** is functionally equivalent: `requests.Session` for HTTP, `urllib3.util.retry.Retry` for retries, and streaming download with `iter_content(chunk_size=65536)`.

---

## Ecosystem Ingesters

### WordPress

**File:** `ts/src/wordpress/ingest.ts` / `wordpress/ingest.py`

**API:** `https://api.wordpress.org/plugins/info/1.2/`

**What the API returns:** A paginated list of plugin objects. Each page returns up to 250 plugins (controlled by `request[per_page]`). The response looks like:

```json
{
  "info": { "page": 1, "pages": 42, "results": 10432 },
  "plugins": [{ "slug": "akismet", "version": "5.3", ... }, ...]
}
```

**How pagination works:** The ingester starts at `page=1` and increments until `page >= totalPages`.

**`listPlugins(client, page, minInstalls)`**

Fetches one page. The URL has many `request[fields][...]` parameters -- each one tells the API to include that field in the response. Without them, the API returns a minimal set. We request: `active_installs`, `downloaded`, `download_link`, `last_updated`, `added`, `author`, `rating`, `num_ratings`, `requires`, `tested`, `requires_php`, `short_description`, `homepage`, `donate_link`, `tags`, `contributors`, `support_threads`, `license`.

If `minInstalls > 0`, plugins below that threshold are filtered out client-side after the page is returned. There is no server-side filter for install count.

**`toMetadata(plugin)`**

Maps the WordPress API object to `PackageMetadata`. Key transforms:
- `author` may contain HTML like `<a href="...">Automattic</a>` -- stripped with a regex (`/<[^>]+>/g`)
- `tags` is a `Record<string, string>` like `{ "spam": "Spam", "anti-spam": "Anti-Spam" }` -- we take `Object.values()`
- `rawMetadata` captures WordPress-specific fields: `requires` (minimum WP version), `tested` (tested-up-to WP version), `requires_php`, `support_threads`, `donate_link`, contributor usernames

**`downloadPlugin(client, state, plugin, outputDir)`**

Download URL is taken from `plugin.download_link` if present; otherwise constructed as `https://downloads.wordpress.org/plugin/{slug}.{version}.zip`. Output path is `{outputDir}/wordpress/{slug}.{version}.zip`.

---

### Drupal

**File:** `ts/src/drupal/ingest.ts` / `drupal/ingest.py`

**API:** `https://www.drupal.org/api-d7/node.json`

This is a generic Drupal 7 REST API. Drupal.org uses it to expose its own content as JSON, so modules are nodes of type `project_module` and releases are nodes of type `project_release`.

**How pagination works:** The API returns a `next` URL in the response when there are more pages. The TypeScript ingester tracks `hasMore = Boolean(data.next)` and increments `page` until `hasMore` is false. Page size is 100.

**`listModules(client, page)`**

Fetches modules with:
- `type=project_module` -- only module projects, not themes or distributions
- `field_project_type=full` -- only "Full" projects (not sandboxes/experimental)
- `sort=changed&direction=DESC` -- newest-updated first

Returns `{ modules, hasMore }`.

**`getLatestRelease(client, nid, coreCompat, slug)`**

This is the trickiest part of the Drupal ingester. To find the download URL for a module, we need a separate API call to list its releases:

```
GET /api-d7/node.json?type=project_release&field_release_project={nid}&limit=10&sort=changed&direction=DESC
```

Each release has a `field_release_version` like `8.x-1.3`, `7.x-2.0`, or `2.0.0` (semantic versioning for newer modules).

**Version filtering rules:**
- For `core-compat=10.x` (or `9.x` or `8.x`): accept `8.x-*` prefix and pure semantic versions. Reject `7.x-*` (those are Drupal 7-only).
- For `core-compat=7.x`: only accept `7.x-*` prefix.
- Always skip versions containing `-dev` (development snapshots).

**Why 8.x- for Drupal 10?** This is a Drupal ecosystem oddity. When Drupal 8 came out, releases started using the `8.x-` prefix. That prefix was carried forward through Drupal 9 and 10 -- it doesn't mean the module only works on Drupal 8. A module listing `8.x-1.3` is perfectly valid for Drupal 10.

**Download URL construction:** The real Drupal API does not embed download URLs in the releases list in a useful way (the `field_release_files` field contains collection item references, not actual URLs). Instead, the download URL is constructed directly from the known pattern:

```
https://ftp.drupal.org/files/projects/{slug}-{version}.tar.gz
```

This URL pattern is public and stable -- it's the same URL format shown on every Drupal project page.

**`toMetadata(mod)`**

Unix timestamps (`created`, `changed`) are stored as seconds-since-epoch strings in the Drupal API. They're multiplied by 1000 and converted to ISO strings via `new Date(ts).toISOString()`.

---

### Joomla

**File:** `ts/src/joomla/ingest.ts` / `joomla/ingest.py`

**API:** `https://extensions.joomla.org/index.php?option=com_jed&view=extension&format=json`

The Joomla Extension Directory (JED) provides metadata only. Unlike WordPress and Drupal, JED does NOT host download files centrally. Each extension developer hosts their own files.

**Two-phase strategy:**
1. For extensions that link to a GitHub repository: download the latest GitHub release as a ZIP
2. For all others: log them to `output/joomla/manual_review.tsv` for manual handling

In practice, roughly 15-20% of the most popular Joomla extensions are GitHub-hosted. The rest are commercial or self-hosted.

**The `JedField` type**

The JED API has changed its response format over time. Fields can be either:
- A plain string: `"GPL-2.0+"`
- A `{value, text}` dict: `{"value": "GPL-2.0+", "text": "GPL-2.0+"}`

The `jedStr(field)` helper handles both cases. Every field access in the Joomla ingester goes through `jedStr()` to normalize the value.

**`listExtensions(client, start)`**

Uses offset-based pagination (`start=0`, `start=20`, ...) with `PAGE_SIZE=20`. The API response can be either a bare array or a wrapped dict (`{"data": [...]}` or `{"list": [...]}`). The function handles all three formats.

**`extractGithubRepo(ext)`**

Searches all URL-like fields (`url`, `download_url`, `homepage_link`, `download_link`, `download_integration_url`) for a GitHub repository path using the regex:

```
/github\.com[:/]([^/\s]+\/[^/\s.#?]+)/
```

Returns `"owner/repo"` or `null`. Strips trailing slashes and `.git` suffixes.

**`downloadFromGithub(client, state, githubToken, repo, slug, outputDir)`**

Calls `https://api.github.com/repos/{owner}/{repo}/releases/latest` to get the latest release's `tag_name` and `zipball_url`. The `zipball_url` is a GitHub-generated archive of the repo at that tag. If a GitHub token is provided, it's sent as `Authorization: token ...` to get the higher authenticated rate limit (5000 req/hr vs 60 req/hr).

**`toMetadata(ext)`**

Maps JED fields. The slug priority is: `core_alias` field > `alias` > `element` > `id`. The `rawMetadata` JSON captures Joomla-specific fields: extension type, approval time, community choice status, and the five review sub-scores (functionality, ease of use, support, documentation, value for money).

---

## Database Schema

Both `downloads.db` files (Python: `data/downloads.db`, TypeScript: `ts/data/downloads.db`) have the same schema.

### `downloads` table

Tracks every artifact that was successfully downloaded.

```sql
CREATE TABLE downloads (
    ecosystem     TEXT NOT NULL,
    slug          TEXT NOT NULL,
    version       TEXT NOT NULL,
    file_path     TEXT,           -- absolute path on disk
    file_hash     TEXT,           -- SHA256 hex digest
    downloaded_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (ecosystem, slug, version)
);
```

The `PRIMARY KEY (ecosystem, slug, version)` is what makes re-running the ingester safe. `INSERT OR REPLACE` on an already-seen (ecosystem, slug, version) tuple is a no-op from a deduplication standpoint -- it just updates the timestamp.

### `packages` table

Tracks every package ever seen in a registry listing, whether or not we downloaded its artifact. This is TypeScript-only (the Python version only has `downloads`).

```sql
CREATE TABLE packages (
    ecosystem           TEXT NOT NULL,
    slug                TEXT NOT NULL,

    -- Registry metadata (updated on every run)
    name                TEXT,
    current_version     TEXT,
    description         TEXT,
    homepage_url        TEXT,
    download_url        TEXT,
    author              TEXT,
    author_profile_url  TEXT,
    license             TEXT,
    tags                TEXT,           -- JSON array stored as string
    registry_added_date TEXT,
    last_updated_date   TEXT,
    download_count      INTEGER,
    active_installs     INTEGER,
    rating              REAL,
    num_ratings         INTEGER,

    -- Removal detection (set by markRemovedIfAbsent)
    is_removed          INTEGER NOT NULL DEFAULT 0,
    removed_at          TEXT,

    -- Housekeeping
    first_seen_at       TEXT NOT NULL DEFAULT (datetime('now')),
    last_checked_at     TEXT NOT NULL DEFAULT (datetime('now')),
    raw_metadata        TEXT,           -- JSON string with ecosystem-specific fields

    PRIMARY KEY (ecosystem, slug)
);
```

**Inspecting the database**

```bash
sqlite3 data/downloads.db

# How many artifacts downloaded per ecosystem?
SELECT ecosystem, COUNT(*) FROM downloads GROUP BY ecosystem;

# How many packages tracked (metadata) per ecosystem?
SELECT ecosystem, COUNT(*) FROM packages WHERE is_removed=0 GROUP BY ecosystem;

# Which Joomla extensions were removed from JED?
SELECT slug, removed_at FROM packages WHERE ecosystem='joomla' AND is_removed=1;

# Top 20 most-downloaded WordPress plugins we've seen
SELECT slug, name, download_count FROM packages
WHERE ecosystem='wordpress'
ORDER BY download_count DESC LIMIT 20;
```

---

## CLI Options Reference

All four ingesters (TypeScript and Python) accept the same options:

### WordPress

| Option | Default | Description |
|---|---|---|
| `--max-plugins N` | 0 (unlimited) | Stop after downloading N plugins |
| `--min-installs N` | 1000 | Skip plugins with fewer active installs |
| `--output-dir DIR` | `output` | Root directory for downloaded ZIPs |
| `--db PATH` | `data/downloads.db` | SQLite database path |
| `--requests-per-second N` | 2 | Rate limit (WP API is generous) |
| `-v / --verbose` | off | Verbose logging |

### Drupal

| Option | Default | Description |
|---|---|---|
| `--max-modules N` | 0 (unlimited) | Stop after downloading N modules |
| `--core-compat VER` | `10.x` | Drupal core version (`7.x`, `8.x`, `9.x`, `10.x`) |
| `--output-dir DIR` | `output` | Root directory for downloaded tarballs |
| `--db PATH` | `data/downloads.db` | SQLite database path |
| `--requests-per-second N` | 1 | Rate limit (Drupal API asks for 1 rps) |
| `-v / --verbose` | off | Verbose logging |

### Joomla

| Option | Default | Description |
|---|---|---|
| `--max-extensions N` | 0 (unlimited) | Stop after downloading N extensions |
| `--output-dir DIR` | `output` | Root directory for downloaded ZIPs |
| `--db PATH` | `data/downloads.db` | SQLite database path |
| `--github-token TOKEN` | none | GitHub PAT for 5000 req/hr (vs 60 req/hr unauthenticated) |
| `--requests-per-second N` | 1 | Rate limit |
| `-v / --verbose` | off | Verbose logging |

**TypeScript invocation:**
```bash
cd ts
npm run wordpress -- [options]
npm run drupal   -- [options]
npm run joomla   -- [options]
```

**Python invocation (from repo root):**
```bash
python -m wordpress.ingest [options]
python -m drupal.ingest    [options]
python -m joomla.ingest    [options]
```

---

## Running as a Cron Job

The ingesters are safe to run on a schedule. The SQLite deduplication means running the same ingester twice never downloads the same artifact twice.

**What happens on a cron run:**

1. New packages that appeared in the registry since the last run: their metadata is upserted and their artifacts are downloaded.
2. Existing packages at the same version: metadata is updated (in case download count or rating changed), artifact download is skipped.
3. Existing packages at a new version: the new version is downloaded (slug+version is a new PRIMARY KEY).
4. Packages removed from the registry: `markRemovedIfAbsent` marks them `is_removed=1`.

**Example crontab (runs nightly at 2am):**

```
0 2 * * * cd /path/to/marketplaces/ts && npm run wordpress -- --min-installs 1000 >> /var/log/marketplaces.log 2>&1
0 3 * * * cd /path/to/marketplaces/ts && npm run drupal   -- --core-compat 10.x  >> /var/log/marketplaces.log 2>&1
0 4 * * * cd /path/to/marketplaces/ts && npm run joomla   -- --github-token $GITHUB_TOKEN >> /var/log/marketplaces.log 2>&1
```

**Rate limit notes:**
- WordPress API: 2 requests/second is fine. No authentication needed.
- Drupal API: 1 request/second. The server will start returning errors if you go faster.
- Joomla JED: 1 request/second. GitHub API: 60 req/hr unauthenticated, 5000 req/hr with `--github-token`.

---

## Scanner Integration Hook

The scanner pipeline expects to receive a local file path for each downloaded artifact. Every `downloadPlugin` / `downloadModule` / `downloadFromGithub` function already returns `true/false` (did we download?), and the `state.record()` call stores the absolute file path.

To wire in a scanner, add a call after a successful download in each ingester. In `ts/src/wordpress/ingest.ts`:

```typescript
// In downloadPlugin(), after state.record():
if (process.env.SCANNER_ENDPOINT) {
  await submitToScanner(destPath, { ecosystem: ECOSYSTEM, slug, version });
}
```

Or query the database after each run to get all paths for newly downloaded artifacts:

```sql
SELECT file_path FROM downloads
WHERE ecosystem='wordpress'
  AND downloaded_at > datetime('now', '-1 day');
```

---

## Adding a New Ecosystem

To add a new registry (e.g. PrestaShop), follow this pattern:

1. **Create `ts/src/prestashop/ingest.ts`** with:
   - `export const ECOSYSTEM = "prestashop"`
   - `listModules(client, page)` -- returns paged items + pagination signal
   - `toMetadata(item)` -- maps API response to `PackageMetadata`
   - `downloadModule(client, state, item, outputDir)` -- download + record
   - `main()` -- CLI entry point using `commander`

2. **Create `ts/tests/prestashop.test.ts`** with unit tests for each exported function.

3. **Add to `ts/package.json`:**
   ```json
   "prestashop": "tsx src/prestashop/ingest.ts"
   ```

4. The `DownloadState` class in `state.ts` is ecosystem-agnostic -- no changes needed there. Just pass `"prestashop"` as the `ecosystem` argument to all state methods.

---

## Test Suite

### TypeScript (45 tests)

```bash
cd ts && npm test
```

Each module's test file uses `vi.fn()` mocks to avoid real network calls. The pattern:

```typescript
function mockClient(responses: unknown[]): RateLimitedClient {
  const getJson = vi.fn();
  responses.forEach((r) => getJson.mockResolvedValueOnce(r));
  return { getJson, get: vi.fn(), download: vi.fn().mockResolvedValue("deadbeef") };
}
```

This lets tests inject exactly the API responses they need. The `download` mock returns a fixed hash `"deadbeef"` so tests can verify that `state.record()` was called without touching the network or filesystem.

`DownloadState` tests use real SQLite in a `tmp` directory (created by `mkdtempSync`), which is faster and more reliable than mocking the database.

### Python (27 tests)

```bash
pytest tests/ -v
```

Same pattern: `unittest.mock.MagicMock` for the HTTP session, real SQLite for state tests.

---

## Known Quirks and Design Decisions

**Drupal version scheme:** Drupal 8/9/10 modules all use the `8.x-` version prefix. This is not a typo. It's a legacy convention from when Drupal 8 was released that was never changed. When you run with `--core-compat 10.x`, the ingester accepts `8.x-1.3` as a valid D10 release.

**Joomla `{value, text}` fields:** The JED API returns field values as either plain strings or `{"value": "...", "text": "..."}` dicts depending on the API version. The `jedStr()` helper normalizes both. If you add new JED field access anywhere, always wrap it in `jedStr()`.

**Joomla ~15% download rate:** The Joomla ecosystem is majority-commercial and self-hosted. Only extensions that publish on GitHub can be automatically downloaded. The rest go to `manual_review.tsv`. This is a property of the ecosystem, not a bug.

**`better-sqlite3` version:** Must be v11+ for Node 22+ and v12+ for Node 24+. Earlier versions fail to compile because Node 24's V8 headers require C++20 which the older `better-sqlite3` build scripts did not specify. The `package.json` pins `^12.9.0`.

**Python `common/state.py` is simpler than `state.ts`:** The Python version only has the `downloads` table (no `packages` table, no `upsertMetadata`, no removal detection). The TypeScript version was enhanced for use in the live pipeline. If you need the full feature set in Python, port the schema additions from `state.ts`.

**All timestamps in SQLite are stored as ISO strings** (`datetime('now')` returns UTC). When reading them back, treat them as UTC.

**SHA256 hashes:** Stored in the `file_hash` column. These are useful for deduplication across ecosystems (if the same plugin exists on multiple registries) and for verifying download integrity on subsequent reads.
