#!/usr/bin/env python3
"""
Drupal module registry ingester.
Uses drupal.org REST API to list modules; downloads tarballs from ftp.drupal.org.

Usage:
    python -m drupal.ingest --max-modules 200 --core-compat 10.x --output-dir output/
    python -m drupal.ingest --core-compat 9.x --output-dir output/
"""
import argparse
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from common.state import DownloadState
from common.http import RateLimitedSession

ECOSYSTEM = "drupal"
DRUPAL_API = "https://www.drupal.org/api-d7/node.json"
PAGE_SIZE = 100

logger = logging.getLogger(__name__)


def list_modules(session: RateLimitedSession, page: int):
    """Fetch one page of full Drupal modules. Returns (modules_list, next_url_or_None)."""
    params = {
        "type": "project_module",
        "field_project_type": "full",
        "limit": PAGE_SIZE,
        "page": page,
        "sort": "changed",
        "direction": "DESC",
    }
    resp = session.get(DRUPAL_API, params=params)
    data = resp.json()
    return data.get("list", []), data.get("next")


def get_latest_release_url(session: RateLimitedSession, nid: int, core_compat: str,
                           slug: str = None):
    """Return (version, download_url) for the latest stable release matching core_compat.

    Note on Drupal versioning: D8/D9/D10 compatible modules all use the "8.x-" version
    prefix (legacy convention). D7 modules use "7.x-". Newer modules use semantic
    versioning (e.g. 1.5.0). The real API returns field_collection_item references for
    file entries, not embedded URLs, so we construct the URL from slug+version using the
    well-known ftp.drupal.org pattern.
    """
    # D7 modules: require "7.x-" prefix. D8/9/10: accept "8.x-" or semantic versioning.
    is_d7 = core_compat.startswith("7")
    params = {
        "type": "project_release",
        "field_release_project": nid,
        "limit": 10,
        "sort": "changed",
        "direction": "DESC",
    }
    resp = session.get(DRUPAL_API, params=params)
    for release in resp.json().get("list", []):
        version = release.get("field_release_version", "")
        if not version or "-dev" in version:
            continue
        if is_d7:
            if not version.startswith("7.x-"):
                continue
        else:
            # Accept 8.x- prefix (D8/D9/D10) or semantic versioning; reject D7-only
            if version.startswith("7.x-"):
                continue

        # Try embedded URL first (used in unit tests with mocked data)
        for f in release.get("field_release_files", []):
            url = f.get("file", {}).get("url", "")
            if url.endswith(".tar.gz") or url.endswith(".zip"):
                return version, url

        # Real API: field_release_files are field_collection_item refs with no embedded URL.
        # Construct the URL directly from the known ftp.drupal.org pattern.
        if slug:
            return version, f"https://ftp.drupal.org/files/projects/{slug}-{version}.tar.gz"

    return None, None


def download_module(session: RateLimitedSession, state: DownloadState,
                    module: dict, core_compat: str, output_dir: str) -> bool:
    slug = module.get("field_project_machine_name")
    nid = module.get("nid")
    if not slug or not nid:
        return False

    version, url = get_latest_release_url(session, nid, core_compat, slug=slug)
    if not url:
        logger.debug("No %s release for %s", core_compat, slug)
        return False

    if state.is_downloaded(ECOSYSTEM, slug, version):
        logger.debug("Skip %s %s", slug, version)
        return False

    ext = ".tar.gz" if url.endswith(".tar.gz") else ".zip"
    dest = str(Path(output_dir) / ECOSYSTEM / f"{slug}.{version}{ext}")
    try:
        file_hash = session.download(url, dest)
        state.record(ECOSYSTEM, slug, version, dest, file_hash)
        logger.info("Downloaded %s %s -> %s", slug, version, dest)
        return True
    except Exception as exc:
        logger.warning("Failed %s: %s", slug, exc)
        return False


def main():
    parser = argparse.ArgumentParser(description="Ingest Drupal modules")
    parser.add_argument("--max-modules", type=int, default=0,
                        help="Stop after N downloads (0 = unlimited)")
    parser.add_argument("--output-dir", default="output")
    parser.add_argument("--db", default="data/downloads.db")
    parser.add_argument("--core-compat", default="10.x",
                        choices=["7.x", "8.x", "9.x", "10.x"])
    parser.add_argument("--requests-per-second", type=float, default=1.0)
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    session = RateLimitedSession(args.requests_per_second)
    state = DownloadState(args.db)

    downloaded = 0
    page = 0
    has_more = True

    while has_more:
        try:
            modules, next_url = list_modules(session, page)
        except Exception as exc:
            logger.error("Page %d failed: %s", page, exc)
            break

        if not modules:
            break

        for module in modules:
            if args.max_modules and downloaded >= args.max_modules:
                logger.info("Reached --max-modules=%d, stopping.", args.max_modules)
                has_more = False
                break
            if download_module(session, state, module, args.core_compat, args.output_dir):
                downloaded += 1

        if has_more:
            has_more = bool(next_url)
            page += 1

    logger.info("Done. %d downloaded this run. DB totals: %s", downloaded, state.stats())


if __name__ == "__main__":
    main()
