#!/usr/bin/env python3
"""
WordPress Plugin Directory ingester.
Downloads plugin ZIP artifacts from wordpress.org.

Usage:
    python -m wordpress.ingest --max-plugins 100 --min-installs 10000 --output-dir output/
    python -m wordpress.ingest --max-plugins 0  # 0 = no limit, download everything
"""
import argparse
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from common.state import DownloadState
from common.http import RateLimitedSession

ECOSYSTEM = "wordpress"
WP_API = "https://api.wordpress.org/plugins/info/1.2/"
PAGE_SIZE = 250

logger = logging.getLogger(__name__)


def list_plugins(session: RateLimitedSession, page: int, min_installs: int = 0):
    """Fetch one page of plugins. Returns (plugins_list, total_pages)."""
    params = {
        "action": "query_plugins",
        "request[per_page]": PAGE_SIZE,
        "request[page]": page,
        "request[fields][active_installs]": 1,
        "request[fields][download_link]": 1,
    }
    resp = session.get(WP_API, params=params)
    data = resp.json()
    plugins = data.get("plugins", [])
    total_pages = data.get("info", {}).get("pages", 1)
    if min_installs > 0:
        plugins = [p for p in plugins if p.get("active_installs", 0) >= min_installs]
    return plugins, total_pages


def download_plugin(session: RateLimitedSession, state: DownloadState,
                    plugin: dict, output_dir: str) -> bool:
    """Download a single plugin ZIP. Returns True if downloaded, False if skipped/failed."""
    slug = plugin["slug"]
    version = plugin.get("version", "latest")
    url = plugin.get(
        "download_link",
        f"https://downloads.wordpress.org/plugin/{slug}.{version}.zip",
    )

    if state.is_downloaded(ECOSYSTEM, slug, version):
        logger.debug("Skip %s %s (already downloaded)", slug, version)
        return False

    dest = str(Path(output_dir) / ECOSYSTEM / f"{slug}.{version}.zip")
    try:
        file_hash = session.download(url, dest)
        state.record(ECOSYSTEM, slug, version, dest, file_hash)
        logger.info("Downloaded %s %s -> %s", slug, version, dest)
        return True
    except Exception as exc:
        logger.warning("Failed to download %s: %s", slug, exc)
        return False


def main():
    parser = argparse.ArgumentParser(description="Ingest WordPress plugins")
    parser.add_argument("--max-plugins", type=int, default=0,
                        help="Stop after N downloads (0 = unlimited)")
    parser.add_argument("--min-installs", type=int, default=1000,
                        help="Skip plugins with fewer active installs than this")
    parser.add_argument("--output-dir", default="output")
    parser.add_argument("--db", default="data/downloads.db")
    parser.add_argument("--requests-per-second", type=float, default=2.0)
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    session = RateLimitedSession(args.requests_per_second)
    state = DownloadState(args.db)

    downloaded = 0
    page = 1

    while True:
        try:
            plugins, total_pages = list_plugins(session, page, args.min_installs)
        except Exception as exc:
            logger.error("Failed to fetch page %d: %s", page, exc)
            break

        if not plugins:
            break

        for plugin in plugins:
            if args.max_plugins and downloaded >= args.max_plugins:
                logger.info("Reached --max-plugins=%d, stopping.", args.max_plugins)
                break
            if download_plugin(session, state, plugin, args.output_dir):
                downloaded += 1
        else:
            page += 1
            if page > total_pages:
                break
            continue
        break  # inner for-loop hit break (max reached)

    logger.info("Done. %d downloaded this run. DB totals: %s", downloaded, state.stats())


if __name__ == "__main__":
    main()
