import pytest
from unittest.mock import MagicMock
from wordpress.ingest import list_plugins, download_plugin, ECOSYSTEM
from common.state import DownloadState


def make_session(json_data=None, raises=None):
    session = MagicMock()
    if raises:
        session.get.side_effect = raises
    else:
        resp = MagicMock()
        resp.json.return_value = json_data or {}
        session.get.return_value = resp
    return session


def test_list_plugins_returns_plugins_and_page_count():
    session = make_session({
        "info": {"page": 1, "pages": 10, "results": 2500},
        "plugins": [
            {"slug": "akismet", "version": "5.3",
             "download_link": "https://downloads.wordpress.org/plugin/akismet.5.3.zip",
             "active_installs": 5000000},
            {"slug": "hello-dolly", "version": "1.7.2",
             "download_link": "https://downloads.wordpress.org/plugin/hello-dolly.1.7.2.zip",
             "active_installs": 0},
        ]
    })
    plugins, total_pages = list_plugins(session, page=1, min_installs=0)
    assert len(plugins) == 2
    assert total_pages == 10


def test_list_plugins_filters_by_min_installs():
    session = make_session({
        "info": {"pages": 1},
        "plugins": [
            {"slug": "popular", "active_installs": 10000, "version": "1.0", "download_link": "..."},
            {"slug": "obscure", "active_installs": 50, "version": "1.0", "download_link": "..."},
        ]
    })
    plugins, _ = list_plugins(session, page=1, min_installs=1000)
    assert len(plugins) == 1
    assert plugins[0]["slug"] == "popular"


def test_download_plugin_skips_if_already_downloaded(tmp_path):
    state = DownloadState(str(tmp_path / "test.db"))
    state.record(ECOSYSTEM, "akismet", "5.3", "/some/path.zip", "abc")
    session = MagicMock()
    plugin = {"slug": "akismet", "version": "5.3",
              "download_link": "https://example.com/akismet.zip"}
    result = download_plugin(session, state, plugin, str(tmp_path))
    session.download.assert_not_called()
    assert result is False


def test_download_plugin_records_on_success(tmp_path):
    state = DownloadState(str(tmp_path / "test.db"))
    session = MagicMock()
    session.download.return_value = "deadbeef"
    plugin = {"slug": "contact-form-7", "version": "5.8.4",
              "download_link": "https://example.com/cf7.zip"}
    result = download_plugin(session, state, plugin, str(tmp_path))
    assert result is True
    assert state.is_downloaded(ECOSYSTEM, "contact-form-7", "5.8.4")


def test_download_plugin_returns_false_on_error(tmp_path):
    state = DownloadState(str(tmp_path / "test.db"))
    session = MagicMock()
    session.download.side_effect = Exception("Connection refused")
    plugin = {"slug": "broken-plugin", "version": "1.0",
              "download_link": "https://broken.example.com/"}
    result = download_plugin(session, state, plugin, str(tmp_path))
    assert result is False
    assert not state.is_downloaded(ECOSYSTEM, "broken-plugin", "1.0")
