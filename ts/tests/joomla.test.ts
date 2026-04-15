import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  listExtensions,
  extractGithubRepo,
  toMetadata,
  downloadFromGithub,
  ECOSYSTEM,
} from "../src/joomla/ingest.js";
import { DownloadState } from "../src/common/state.js";
import type { RateLimitedClient } from "../src/common/http.js";

function mockClient(responses: unknown[]): RateLimitedClient {
  const getJson = vi.fn();
  responses.forEach((r) => getJson.mockResolvedValueOnce(r));
  return {
    getJson,
    get: vi.fn(),
    download: vi.fn().mockResolvedValue("deadbeef"),
  } as unknown as RateLimitedClient;
}

describe("listExtensions", () => {
  it("returns flat list when API returns array", async () => {
    const client = mockClient([
      [
        { id: "1", core_alias: "akeeba-backup" },
        { id: "2", core_alias: "virtuemart" },
      ],
    ]);
    const result = await listExtensions(client, 0);
    expect(result).toHaveLength(2);
  });

  it("returns list from wrapped data key", async () => {
    const client = mockClient([
      { data: [{ id: "1", core_alias: "akeebabackup" }] },
    ]);
    const result = await listExtensions(client, 0);
    expect(result).toHaveLength(1);
  });

  it("returns empty array on API failure", async () => {
    const client = {
      getJson: vi.fn().mockRejectedValue(new Error("Connection refused")),
      get: vi.fn(),
      download: vi.fn(),
    } as unknown as RateLimitedClient;
    const result = await listExtensions(client, 0);
    expect(result).toEqual([]);
  });
});

describe("extractGithubRepo", () => {
  it("extracts repo from plain string URL", () => {
    const ext = { url: "https://github.com/joomla-extensions/foo-bar" };
    expect(extractGithubRepo(ext)).toBe("joomla-extensions/foo-bar");
  });

  it("extracts repo from {value, text} field", () => {
    const ext = {
      homepage_link: { value: "https://github.com/acme/my-plugin", text: "Homepage" },
    };
    expect(extractGithubRepo(ext)).toBe("acme/my-plugin");
  });

  it("strips .git suffix", () => {
    const ext = { url: "https://github.com/acme/plugin.git" };
    const result = extractGithubRepo(ext);
    expect(result).not.toContain(".git");
    expect(result).toBe("acme/plugin");
  });

  it("returns null when no GitHub URL present", () => {
    const ext = { url: "https://extensions.joomla.org/extension/foo" };
    expect(extractGithubRepo(ext)).toBeNull();
  });

  it("extracts from download_integration_url field", () => {
    const ext = {
      download_integration_url: {
        value: "https://github.com/org/myext/releases",
        text: "Download",
      },
    };
    expect(extractGithubRepo(ext)).toBe("org/myext");
  });
});

describe("toMetadata", () => {
  it("maps JED fields to PackageMetadata", () => {
    const ext = {
      id: "12345",
      core_title: { value: "Akeeba Backup", text: "" },
      core_alias: { value: "akeeba-backup", text: "" },
      version: { value: "9.7.6", text: "" },
      license: { value: "GPL-2.0+", text: "" },
      score: { value: "4.8", text: "" },
      num_reviews: { value: "500", text: "" },
      core_hits: { value: "1200000", text: "" },
      core_body: { value: "Full site backup solution for Joomla.", text: "" },
      core_created_time: { value: "2010-01-01", text: "" },
      core_modified_time: { value: "2024-01-01", text: "" },
    };
    const meta = toMetadata(ext);
    expect(meta.slug).toBe("akeeba-backup");
    expect(meta.currentVersion).toBe("9.7.6");
    expect(meta.license).toBe("GPL-2.0+");
    expect(meta.rating).toBe(4.8);
    expect(meta.numRatings).toBe(500);
    expect(meta.downloadCount).toBe(1200000);
    expect(meta.ecosystem).toBe(ECOSYSTEM);
  });

  it("falls back to id when core_alias missing", () => {
    const ext = { id: "99999" };
    const meta = toMetadata(ext);
    expect(meta.slug).toBe("99999");
  });
});

describe("downloadFromGithub", () => {
  let tmpDir: string;
  let state: DownloadState;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "joomla-test-"));
    state = new DownloadState(join(tmpDir, "test.db"));
  });

  it("skips if already downloaded", async () => {
    state.record(ECOSYSTEM, "akeeba-backup", "v9.7.6", "/some/path.zip", "abc");
    const client = mockClient([{ tag_name: "v9.7.6", zipball_url: "https://api.github.com/repos/acme/akeeba/zipball/v9.7.6" }]);
    const result = await downloadFromGithub(client, state, undefined, "acme/akeeba", "akeeba-backup", tmpDir);
    expect(result).toBe(false);
    expect(client.download).not.toHaveBeenCalled();
  });

  it("downloads and records on success", async () => {
    const client = mockClient([
      { tag_name: "v9.7.6", zipball_url: "https://api.github.com/repos/acme/akeeba/zipball/v9.7.6" },
    ]);
    const result = await downloadFromGithub(client, state, undefined, "acme/akeeba", "akeeba-backup", tmpDir);
    expect(result).toBe(true);
    expect(state.isDownloaded(ECOSYSTEM, "akeeba-backup", "v9.7.6")).toBe(true);
  });

  it("returns false when release has no zipball_url", async () => {
    const client = mockClient([{ tag_name: "v1.0.0" }]);
    const result = await downloadFromGithub(client, state, undefined, "acme/plugin", "plugin", tmpDir);
    expect(result).toBe(false);
  });

  it("returns false on network error", async () => {
    const client = {
      getJson: vi.fn().mockRejectedValue(new Error("404 Not Found")),
      get: vi.fn(),
      download: vi.fn(),
    } as unknown as RateLimitedClient;
    const result = await downloadFromGithub(client, state, undefined, "acme/missing", "missing", tmpDir);
    expect(result).toBe(false);
  });
});
