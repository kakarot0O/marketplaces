# Marketplaces Ingestion Scripts Progress

## Implemented
- Project scaffolding: requirements.txt, __init__.py files, .gitignore, directories
- `common/state.py`: DownloadState SQLite tracker (is_downloaded, record, stats) with 6 passing tests
- `common/http.py`: RateLimitedSession with rate limiting, retries (429/5xx), streaming download + SHA256 hashing, with 4 passing tests
- `wordpress/ingest.py`: WordPress Plugin API ingester, pagination, min_installs filter, CLI; smoke tested (5 real plugins downloaded)
- `drupal/ingest.py`: Drupal.org API ingester, per-module release lookup, core_compat filter, CLI; sort fix applied (changed DESC to get modern modules)
- `joomla/ingest.py`: JED API + GitHub Releases ingester, regex GitHub URL extraction, manual_review.tsv for non-GitHub extensions, CLI
- Full test suite: 27/27 tests passing

## Completed (Task 7)
- Drupal smoke test: 5 modules downloaded (semantic versioned D10 modules)
- Joomla smoke test: 20 extensions downloaded (GitHub-hosted), 100+ logged to manual_review.tsv
- DB totals verified: drupal=5, joomla=20, wordpress=5

## Remaining / Backlog
- Scanner submission endpoint integration (hook is ready: download functions return local file path)
- Additional ecosystems: Magento, PrestaShop, TYPO3, Craft CMS
- Incremental update detection (newer versions of already-seen slugs)
- Parallel downloads with concurrent.futures
- Metadata indexing beyond SQLite

## Key Decisions
- Implemented fresh from scratch (not reusing github-issue-scanner code directly)
- Scanner integration explicitly NOT in scope for this session
- Joomla: best-effort approach -- GitHub-hosted extensions downloaded automatically, others logged to TSV
- Drupal sort: changed DESC to get modern modules with 10.x support (oldest-first default showed zero 10.x releases)
- TDD: tests written before implementation for all modules

## Additional Fixes Applied
- Drupal `get_latest_release_url`: fixed version filter (D10 modules use `8.x-` prefix, not `10.x-`); fixed URL construction (real API returns `field_collection_item` refs, not embedded URLs -- now builds URL from `ftp.drupal.org/files/projects/{slug}-{version}.tar.gz` pattern)
- Joomla `list_extensions`: handles bare-list API response (new format as of 2026)
- Joomla `extract_github_repo`: unwraps `{value, text}` dict fields (new JED field format)
- Joomla `main`: uses `core_alias` for slug in new JED format

## Last updated
2026-04-14
