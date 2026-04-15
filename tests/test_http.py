import hashlib
import time
import pytest
from unittest.mock import MagicMock
from common.http import RateLimitedSession


def test_rate_limiting_between_requests():
    session = RateLimitedSession(requests_per_second=2.0)
    session._last_request = time.time()
    start = time.time()
    session._wait()
    elapsed = time.time() - start
    assert elapsed >= 0.4, f"Expected wait >= 0.4s, got {elapsed:.3f}s"


def test_no_wait_after_gap():
    session = RateLimitedSession(requests_per_second=2.0)
    session._last_request = time.time() - 2.0
    start = time.time()
    session._wait()
    elapsed = time.time() - start
    assert elapsed < 0.1


def test_download_writes_file_and_returns_hash(tmp_path, mocker):
    session = RateLimitedSession(requests_per_second=100.0)
    content = b"fake zip content"
    expected_hash = hashlib.sha256(content).hexdigest()

    mock_resp = MagicMock()
    mock_resp.iter_content.return_value = [content]
    mock_resp.raise_for_status.return_value = None
    mocker.patch.object(session._session, "get", return_value=mock_resp)

    dest = str(tmp_path / "test.zip")
    result_hash = session.download("https://example.com/test.zip", dest)

    assert result_hash == expected_hash
    with open(dest, "rb") as f:
        assert f.read() == content


def test_get_raises_on_http_error(mocker):
    session = RateLimitedSession(requests_per_second=100.0)
    mock_resp = MagicMock()
    mock_resp.raise_for_status.side_effect = Exception("404 Not Found")
    mocker.patch.object(session._session, "get", return_value=mock_resp)

    with pytest.raises(Exception, match="404"):
        session.get("https://example.com/missing")
