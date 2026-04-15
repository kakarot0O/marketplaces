#!/usr/bin/env python3
"""
Joomla Extension Directory ingester.

NOTE: JED does not centrally host downloads. Each extension links to the developer's
own server. This script:
  1. Queries the JED API for extension listings
  2. Extracts GitHub repo URLs from the metadata (most popular extensions are on GitHub)
  3. Downloads the latest GitHub release ZIP for those
  4. Logs the rest to output/joomla/manual_review.tsv for manual follow-up

Usage:
    python -m joomla.ingest --max-extensions 100 --output-dir output/
    python -m joomla.ingest --max-extensions 100 --github-token ghp_xxx --output-dir output/
"""
import argparse
import logging
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from common.state import DownloadState
from common.http import RateLimitedSession

ECOSYSTEM = "joomla"
JED_API = "https://extensions.joomla.org/index.php"
GITHUB_API = "https://api.github.com"
PAGE_SIZE = 20

logger = logging.getLogger(__name__)


def list_extensions(session: RateLimitedSession, start: int) -> list:
    """Fetch one page of extensions from JED. Returns empty list on any failure."""
    params = {
        "option": "com_jed",
        "view": "extension",
        "format": "json",
        "limit": PAGE_SIZE,
        "start": start,
        "orderby": "popular",
    }
    try:
        resp = session.get(JED_API, params=params)
        data = resp.json()
        # JED API response format has changed over time:
        #   - bare list (current as of 2026)
        #   - {"data": [...]}
        #   - {"extensions": [...]}
        #   - {"list": [...]}
        if isinstance(data, list):
            return data
        return data.get("data", data.get("extensions", data.get("list", [])))
    except Exception as exc:
        logger.warning("JED page start=%d failed: %s", start, exc)
        return []


def _jed_str(field) -> str:
    """Unwrap a JED field that may be a plain string or a {value, text} dict."""
    if isinstance(field, dict):
        return field.get("value", "") or field.get("text", "")
    return str(field) if field else ""


def extract_github_repo(extension: dict) -> str | None:
    """Extract 'owner/repo' from any URL-like field in the extension record."""
    text = " ".join(_jed_str(extension.get(k, "")) for k in [
        "url", "download_url", "repository_url", "homepage",
        "homepage_link", "download_link", "download_integration_url",
    ])
    m = re.search(r"github\.com[:/]([^/\s]+/[^/\s.#?]+)", text)
    if m:
        repo = m.group(1).rstrip("/")
        if repo.endswith(".git"):
            repo = repo[:-4]
        return repo
    return None


def download_from_github(session: RateLimitedSession, state: DownloadState,
                          github_token: str | None, repo: str,
                          slug: str, output_dir: str) -> bool:
    """Download latest release ZIP from a GitHub repo. Returns True if downloaded."""
    headers = {}
    if github_token:
        headers["Authorization"] = f"token {github_token}"
    try:
        resp = session.get(f"{GITHUB_API}/repos/{repo}/releases/latest", headers=headers)
        release = resp.json()
        version = release.get("tag_name", "unknown")
        zipball_url = release.get("zipball_url")
        if not zipball_url:
            logger.debug("No zipball_url for %s", repo)
            return False
        if state.is_downloaded(ECOSYSTEM, slug, version):
            logger.debug("Skip %s %s", slug, version)
            return False
        dest = str(Path(output_dir) / ECOSYSTEM / f"{slug}.{version}.zip")
        file_hash = session.download(zipball_url, dest)
        state.record(ECOSYSTEM, slug, version, dest, file_hash)
        logger.info("Downloaded %s %s (GitHub:%s) -> %s", slug, version, repo, dest)
        return True
    except Exception as exc:
        logger.warning("GitHub download failed for %s (%s): %s", slug, repo, exc)
        return False


def main():
    parser = argparse.ArgumentParser(description="Ingest Joomla extensions")
    parser.add_argument("--max-extensions", type=int, default=0,
                        help="Stop after N downloads (0 = unlimited)")
    parser.add_argument("--output-dir", default="output")
    parser.add_argument("--db", default="data/downloads.db")
    parser.add_argument("--github-token", default=None,
                        help="GitHub PAT for higher API rate limits (60 -> 5000 req/hr)")
    parser.add_argument("--requests-per-second", type=float, default=1.0)
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    session = RateLimitedSession(args.requests_per_second)
    state = DownloadState(args.db)
    manual_review = []
    downloaded = 0
    start = 0

    while True:
        extensions = list_extensions(session, start)
        if not extensions:
            logger.info("No extensions returned at start=%d, stopping.", start)
            break

        for ext in extensions:
            if args.max_extensions and downloaded >= args.max_extensions:
                logger.info("Reached --max-extensions=%d, stopping.", args.max_extensions)
                break

            # core_alias is the canonical slug in the new JED format
            slug = str(
                _jed_str(ext.get("core_alias"))
                or ext.get("alias") or ext.get("element") or ext.get("id")
                or "unknown"
            )
            github_repo = extract_github_repo(ext)

            if github_repo:
                if download_from_github(
                    session, state, args.github_token, github_repo, slug, args.output_dir
                ):
                    downloaded += 1
            else:
                fallback_url = (
                    _jed_str(ext.get("download_link"))
                    or _jed_str(ext.get("homepage_link"))
                    or ext.get("url") or ext.get("download_url", "")
                )
                manual_review.append(f"{slug}\t{fallback_url}")
                logger.debug("No GitHub URL for %s; logged for manual review", slug)
        else:
            start += PAGE_SIZE
            continue
        break  # inner for-loop hit break (max reached)

    if manual_review:
        review_path = Path(args.output_dir) / ECOSYSTEM / "manual_review.tsv"
        review_path.parent.mkdir(parents=True, exist_ok=True)
        with open(review_path, "w") as f:
            f.write("slug\turl\n")
            f.write("\n".join(manual_review))
        logger.info(
            "Logged %d extensions for manual review -> %s",
            len(manual_review), review_path,
        )

    logger.info("Done. %d downloaded this run. DB totals: %s", downloaded, state.stats())


if __name__ == "__main__":
    main()
