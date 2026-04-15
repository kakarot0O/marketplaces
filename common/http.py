import hashlib
import time
from pathlib import Path

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry


class RateLimitedSession:
    """HTTP session with per-request rate limiting and automatic retries."""

    def __init__(self, requests_per_second: float = 1.0):
        self._min_interval = 1.0 / requests_per_second
        self._last_request = 0.0
        self._session = requests.Session()
        retry = Retry(
            total=3,
            backoff_factor=2,
            status_forcelist=[429, 500, 502, 503, 504],
        )
        adapter = HTTPAdapter(max_retries=retry)
        self._session.mount("https://", adapter)
        self._session.mount("http://", adapter)
        self._session.headers["User-Agent"] = (
            "security-research-bot/1.0 (plugin artifact scanner)"
        )

    def _wait(self):
        elapsed = time.time() - self._last_request
        if elapsed < self._min_interval:
            time.sleep(self._min_interval - elapsed)
        self._last_request = time.time()

    def get(self, url: str, **kwargs) -> requests.Response:
        self._wait()
        resp = self._session.get(url, timeout=30, **kwargs)
        resp.raise_for_status()
        return resp

    def download(self, url: str, dest_path: str) -> str:
        """Stream-download url to dest_path. Returns sha256 hex digest."""
        self._wait()
        resp = self._session.get(url, timeout=120, stream=True)
        resp.raise_for_status()
        Path(dest_path).parent.mkdir(parents=True, exist_ok=True)
        hasher = hashlib.sha256()
        with open(dest_path, "wb") as f:
            for chunk in resp.iter_content(chunk_size=65536):
                f.write(chunk)
                hasher.update(chunk)
        return hasher.hexdigest()
