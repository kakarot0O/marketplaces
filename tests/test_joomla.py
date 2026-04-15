import pytest
from unittest.mock import MagicMock
from joomla.ingest import list_extensions, extract_github_repo, download_from_github, ECOSYSTEM
from common.state import DownloadState


def test_extract_github_repo_from_url():
    ext = {"url": "https://github.com/joomla-extensions/foo-bar", "download_url": ""}
    assert extract_github_repo(ext) == "joomla-extensions/foo-bar"


def test_extract_github_repo_from_download_url():
    ext = {"url": "", "download_url": "https://github.com/acme/my-plugin/releases"}
    assert extract_github_repo(ext) == "acme/my-plugin"


def test_extract_github_repo_returns_none_when_absent():
    ext = {"url": "https://example.com/plugin", "download_url": ""}
    assert extract_github_repo(ext) is None


def test_extract_github_repo_strips_git_suffix():
    ext = {"url": "https://github.com/acme/plugin.git", "download_url": ""}
    result = extract_github_repo(ext)
    assert result is not None
    assert ".git" not in result


def test_download_from_github_skips_if_already_downloaded(tmp_path):
    state = DownloadState(str(tmp_path / "test.db"))
    state.record(ECOSYSTEM, "foo-bar", "v2.1.0", "/some/path.zip", "abc")

    session = MagicMock()
    resp = MagicMock()
    resp.json.return_value = {"tag_name": "v2.1.0", "zipball_url": "https://api.github.com/..."}
    session.get.return_value = resp

    result = download_from_github(session, state, None, "acme/foo-bar", "foo-bar", str(tmp_path))
    session.download.assert_not_called()
    assert result is False


def test_download_from_github_records_on_success(tmp_path):
    state = DownloadState(str(tmp_path / "test.db"))
    session = MagicMock()
    session.get.return_value.json.return_value = {
        "tag_name": "v3.0.0",
        "zipball_url": "https://api.github.com/repos/acme/plugin/zipball/v3.0.0",
    }
    session.download.return_value = "deadbeef"

    result = download_from_github(session, state, None, "acme/plugin", "plugin", str(tmp_path))
    assert result is True
    assert state.is_downloaded(ECOSYSTEM, "plugin", "v3.0.0")


def test_list_extensions_handles_api_failure():
    session = MagicMock()
    session.get.side_effect = Exception("Connection refused")
    result = list_extensions(session, start=0)
    assert result == []
