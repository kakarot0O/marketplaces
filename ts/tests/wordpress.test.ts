import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { listPlugins, downloadPlugin, toMetadata, ECOSYSTEM } from "../src/wordpress/ingest.js";
import { DownloadState } from "../src/common/state.js";
import type { RateLimitedClient } from "../src/common/http.js";

function mockClient(jsonResponse: unknown, downloadHash = "deadbeef"): RateLimitedClient {
  return {
    getJson: vi.fn().mockResolvedValue(jsonResponse),
    get: vi.fn(),
    download: vi.fn().mockResolvedValue(downloadHash),
  } as unknown as RateLimitedClient;
}

describe("listPlugins", () => {
  it("returns plugins and page count", async () => {
    const client = mockClient({
      info: { pages: 10 },
      plugins: [
        { slug: "akismet", name: "Akismet", version: "5.3", active_installs: 5_000_000 },
        { slug: "hello-dolly", name: "Hello Dolly", version: "1.7", active_installs: 0 },
      ],
    });
    const { plugins, totalPages } = await listPlugins(client, 1);
    expect(plugins).toHaveLength(2);
    expect(totalPages).toBe(10);
  });

  it("filters by minInstalls", async () => {
    const client = mockClient({
      info: { pages: 1 },
      plugins: [
        { slug: "popular", version: "1.0", active_installs: 50_000 },
        { slug: "obscure", version: "1.0", active_installs: 10 },
      ],
    });
    const { plugins } = await listPlugins(client, 1, 1000);
    expect(plugins).toHaveLength(1);
    expect(plugins[0].slug).toBe("popular");
  });
});

describe("toMetadata", () => {
  it("maps WordPress API fields to PackageMetadata", () => {
    const plugin = {
      slug: "akismet",
      name: "Akismet Anti-Spam",
      version: "5.3",
      author: '<a href="https://automattic.com">Automattic</a>',
      author_profile: "https://profiles.wordpress.org/automattic/",
      downloaded: 500_000_000,
      active_installs: 5_000_000,
      rating: 88,
      num_ratings: 1200,
      added: "2005-11-18",
      last_updated: "2024-01-15",
      homepage: "https://akismet.com",
      license: "GPL v2 or later",
      tags: { spam: "Spam", anti: "Anti-Spam" },
    };
    const meta = toMetadata(plugin);
    expect(meta.slug).toBe("akismet");
    expect(meta.author).toBe("Automattic");  // HTML stripped
    expect(meta.downloadCount).toBe(500_000_000);
    expect(meta.activeInstalls).toBe(5_000_000);
    expect(meta.rating).toBe(88);
    expect(meta.registryAddedDate).toBe("2005-11-18");
    expect(meta.tags).toContain("Spam");
  });
});

describe("downloadPlugin", () => {
  let tmpDir: string;
  let state: DownloadState;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wp-test-"));
    state = new DownloadState(join(tmpDir, "test.db"));
  });

  it("skips if already downloaded", async () => {
    state.record(ECOSYSTEM, "akismet", "5.3", "/some/path.zip", "abc");
    const client = mockClient({});
    const result = await downloadPlugin(
      client,
      state,
      { slug: "akismet", name: "Akismet", version: "5.3", download_link: "https://example.com/akismet.zip" },
      tmpDir
    );
    expect(result).toBe(false);
    expect(client.download).not.toHaveBeenCalled();
  });

  it("records on success", async () => {
    const client = mockClient({});
    const plugin = {
      slug: "contact-form-7",
      name: "CF7",
      version: "5.8.4",
      download_link: "https://downloads.wordpress.org/plugin/contact-form-7.5.8.4.zip",
    };
    const result = await downloadPlugin(client, state, plugin, tmpDir);
    expect(result).toBe(true);
    expect(state.isDownloaded(ECOSYSTEM, "contact-form-7", "5.8.4")).toBe(true);
  });

  it("returns false on network error", async () => {
    const client = {
      getJson: vi.fn(),
      get: vi.fn(),
      download: vi.fn().mockRejectedValue(new Error("Connection refused")),
    } as unknown as RateLimitedClient;
    const result = await downloadPlugin(
      client,
      state,
      { slug: "broken", name: "Broken", version: "1.0", download_link: "https://broken.example.com/" },
      tmpDir
    );
    expect(result).toBe(false);
    expect(state.isDownloaded(ECOSYSTEM, "broken", "1.0")).toBe(false);
  });
});
