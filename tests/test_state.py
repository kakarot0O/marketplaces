import pytest
from common.state import DownloadState


@pytest.fixture
def state(tmp_path):
    return DownloadState(str(tmp_path / "test.db"))


def test_not_downloaded_initially(state):
    assert state.is_downloaded("wordpress", "contact-form-7", "5.8.4") is False


def test_record_and_is_downloaded(state):
    state.record("wordpress", "contact-form-7", "5.8.4", "/tmp/cf7.zip", "abc123")
    assert state.is_downloaded("wordpress", "contact-form-7", "5.8.4") is True


def test_different_ecosystem_not_seen(state):
    state.record("wordpress", "akismet", "5.3", "/tmp/akismet.zip", None)
    assert state.is_downloaded("drupal", "akismet", "5.3") is False


def test_different_version_not_seen(state):
    state.record("wordpress", "akismet", "5.3", "/tmp/akismet.zip", None)
    assert state.is_downloaded("wordpress", "akismet", "5.4") is False


def test_stats_counts_by_ecosystem(state):
    state.record("wordpress", "plugin-a", "1.0", "/tmp/a.zip", None)
    state.record("wordpress", "plugin-b", "2.0", "/tmp/b.zip", None)
    state.record("drupal", "module-c", "3.0", "/tmp/c.tar.gz", None)
    stats = state.stats()
    assert stats["wordpress"] == 2
    assert stats["drupal"] == 1


def test_record_idempotent(state):
    state.record("wordpress", "akismet", "5.3", "/tmp/v1.zip", "hash1")
    state.record("wordpress", "akismet", "5.3", "/tmp/v2.zip", "hash2")
    assert state.is_downloaded("wordpress", "akismet", "5.3") is True
