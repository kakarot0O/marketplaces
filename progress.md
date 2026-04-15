# Marketplaces Ingestion Scripts Progress

## Implemented

### Python (ts/python/)
- Project scaffolding: requirements.txt, __init__.py files, .gitignore, directories
- `common/state.py`: DownloadState SQLite tracker (is_downloaded, record, stats) with 6 passing tests
- `common/http.py`: RateLimitedSession with rate limiting, retries (429/5xx), streaming download + SHA256 hashing, with 4 passing tests
- `wordpress/ingest.py`: WordPress Plugin API ingester, pagination, min_installs filter, CLI; smoke tested (5 real plugins downloaded)
- `drupal/ingest.py`: Drupal.org API ingester, per-module release lookup, core_compat filter, CLI; sort fix applied
- `joomla/ingest.py`: JED API + GitHub Releases ingester, regex GitHub URL extraction, manual_review.tsv for non-GitHub extensions, CLI
- Full Python test suite: 27/27 tests passing

### TypeScript (ts/)
- `ts/src/common/types.ts`: PackageMetadata interface shared across all three ecosystems (download count, active installs, rating, author profile, registry dates, raw metadata)
- `ts/src/common/state.ts`: DownloadState class using better-sqlite3 v12; two tables: downloads (PK: eco+slug+version) and packages (full metadata + is_removed/removed_at for removal tracking)
- `ts/src/common/http.ts`: RateLimitedClient with native fetch, token-bucket rate limiting, exponential backoff retry on 429/5xx, streaming download with SHA256 hash
- `ts/src/wordpress/ingest.ts`: Full WP API ingester with all metadata fields (downloaded count, active_installs, rating, added date, author HTML stripping)
- `ts/src/drupal/ingest.ts`: Drupal ingester with correct version handling (8.x- prefix for D8/D9/D10, semantic versioning, URL pattern construction, Unix timestamp conversion)
- `ts/src/joomla/ingest.ts`: JED ingester with JedField type (plain string or {value,text} dict), all 5 review sub-scores in rawMetadata, GitHub release downloader
- TypeScript test suite: 45/45 tests passing (state, http, wordpress, drupal, joomla)
- Pushed to GitHub: https://github.com/kakarot0O/marketplaces

## In Progress
- Nothing

## Remaining / Backlog
- Scanner submission endpoint integration (hook is ready: download functions return local file path)
- Additional ecosystems: Magento, PrestaShop, TYPO3, Craft CMS
- Incremental update detection (newer versions of already-seen slugs)
- Parallel downloads (TypeScript: Promise.all batches; Python: concurrent.futures)
- Metadata indexing beyond SQLite (JSON export, full-text search)

## Key Decisions
- Python version kept as reference; TypeScript is the canonical version for the pipeline
- TypeScript uses better-sqlite3 v12 (not node:sqlite built-in -- vitest/vite can't resolve node:sqlite as external)
- TypeScript adds a separate packages table tracking ALL discovered packages, not just downloaded ones
- markRemovedIfAbsent() called at end of each run to detect registry removals across cron runs
- Drupal: D8/D9/D10 modules use 8.x- prefix; URL constructed directly from ftp.drupal.org pattern (API doesn't embed URLs)
- Joomla: JedField type handles both plain string and {value, text} dict formats (new JED API format)
- Scanner integration explicitly NOT in scope

## Key Bugs Fixed
- Drupal: D10 modules use 8.x- version prefix, not 10.x-; URL must be constructed, not read from API response
- Joomla (Python): list_extensions handles bare-list API response; _jed_str() unwraps {value,text} dicts
- better-sqlite3 v9 doesn't compile on Node 24; upgraded to v12 which ships prebuilts for Node 24 arm64

## Last updated
2026-04-14
