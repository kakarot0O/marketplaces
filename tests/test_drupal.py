import pytest
from unittest.mock import MagicMock
from drupal.ingest import list_modules, get_latest_release_url, download_module, ECOSYSTEM
from common.state import DownloadState


def make_session(side_effects: list):
    session = MagicMock()
    responses = []
    for data in side_effects:
        resp = MagicMock()
        resp.json.return_value = data
        responses.append(resp)
    session.get.side_effect = responses
    return session


def test_list_modules_returns_modules_and_next():
    session = make_session([{
        "list": [
            {"nid": 1, "field_project_machine_name": "token"},
            {"nid": 2, "field_project_machine_name": "views"},
        ],
        "next": "https://www.drupal.org/api-d7/node.json?page=1"
    }])
    modules, next_url = list_modules(session, page=0)
    assert len(modules) == 2
    assert next_url is not None


def test_list_modules_no_next_on_last_page():
    session = make_session([{"list": [{"nid": 3, "field_project_machine_name": "pathauto"}]}])
    modules, next_url = list_modules(session, page=99)
    assert len(modules) == 1
    assert next_url is None


def test_get_latest_release_url_returns_tarball():
    session = make_session([{
        "list": [{
            "field_release_version": "8.x-1.3",
            "field_release_files": [{"file": {"url": "https://ftp.drupal.org/files/projects/token-8.x-1.3.tar.gz"}}]
        }]
    }])
    version, url = get_latest_release_url(session, nid=1001, core_compat="8.x")
    assert version == "8.x-1.3"
    assert url.endswith(".tar.gz")


def test_get_latest_release_url_skips_wrong_core():
    session = make_session([{
        "list": [{
            "field_release_version": "7.x-1.3",
            "field_release_files": [{"file": {"url": "https://ftp.drupal.org/files/projects/token-7.x-1.3.tar.gz"}}]
        }]
    }])
    version, url = get_latest_release_url(session, nid=1001, core_compat="8.x")
    assert version is None
    assert url is None


def test_download_module_skips_if_already_downloaded(tmp_path):
    state = DownloadState(str(tmp_path / "test.db"))
    state.record(ECOSYSTEM, "token", "8.x-1.3", "/some/path.tar.gz", "abc")
    # Session returns a release for that same version
    session = MagicMock()
    session.get.return_value.json.return_value = {
        "list": [{
            "field_release_version": "8.x-1.3",
            "field_release_files": [{"file": {"url": "https://ftp.drupal.org/files/projects/token-8.x-1.3.tar.gz"}}]
        }]
    }
    module = {"nid": 1, "field_project_machine_name": "token"}
    result = download_module(session, state, module, "8.x", str(tmp_path))
    session.download.assert_not_called()
    assert result is False
