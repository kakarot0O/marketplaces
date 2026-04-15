import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  listModules,
  getLatestRelease,
  downloadModule,
  toMetadata,
  ECOSYSTEM,
} from "../src/drupal/ingest.js";
import { DownloadState } from "../src/common/state.js";
import type { RateLimitedClient } from "../src/common/http.js";

function mockClient(responses: unknown[]): RateLimitedClient {
  const getJson = vi.fn();
  responses.forEach((r) => getJson.mockResolvedValueOnce(r));
  return { getJson, get: vi.fn(), download: vi.fn().mockResolvedValue("deadbeef") } as unknown as RateLimitedClient;
}

describe("listModules", () => {
  it("returns modules and hasMore=true when next present", async () => {
    const client = mockClient([{
      list: [
        { nid: "1", title: "Token", field_project_machine_name: "token" },
        { nid: "2", title: "Views", field_project_machine_name: "views" },
      ],
      next: "https://www.drupal.org/api-d7/node.json?page=1",
    }]);
    const { modules, hasMore } = await listModules(client, 0);
    expect(modules).toHaveLength(2);
    expect(hasMore).toBe(true);
  });

  it("returns hasMore=false on last page", async () => {
    const client = mockClient([{ list: [{ nid: "3", title: "Pathauto", field_project_machine_name: "pathauto" }] }]);
    const { modules, hasMore } = await listModules(client, 99);
    expect(modules).toHaveLength(1);
    expect(hasMore).toBe(false);
  });
});

describe("getLatestRelease", () => {
  it("returns version and ftp URL for 8.x module", async () => {
    const client = mockClient([{
      list: [{ field_release_version: "8.x-1.3", changed: "1700000000" }],
    }]);
    const result = await getLatestRelease(client, "1001", "8.x", "token");
    expect(result).not.toBeNull();
    expect(result!.version).toBe("8.x-1.3");
    expect(result!.url).toBe("https://ftp.drupal.org/files/projects/token-8.x-1.3.tar.gz");
  });

  it("returns version and ftp URL for semantic versioning (D10)", async () => {
    const client = mockClient([{
      list: [{ field_release_version: "2.0.0", changed: "1700000000" }],
    }]);
    const result = await getLatestRelease(client, "1001", "10.x", "webform");
    expect(result).not.toBeNull();
    expect(result!.url).toContain("webform-2.0.0.tar.gz");
  });

  it("skips 7.x releases when compat is 10.x", async () => {
    const client = mockClient([{
      list: [{ field_release_version: "7.x-1.3" }],
    }]);
    const result = await getLatestRelease(client, "1001", "10.x", "token");
    expect(result).toBeNull();
  });

  it("skips -dev versions", async () => {
    const client = mockClient([{
      list: [
        { field_release_version: "8.x-1.x-dev" },
        { field_release_version: "8.x-1.3" },
      ],
    }]);
    const result = await getLatestRelease(client, "1001", "8.x", "token");
    expect(result!.version).toBe("8.x-1.3");
  });

  it("accepts 7.x release when compat is 7.x", async () => {
    const client = mockClient([{
      list: [{ field_release_version: "7.x-1.3" }],
    }]);
    const result = await getLatestRelease(client, "1001", "7.x", "token");
    expect(result!.version).toBe("7.x-1.3");
  });
});

describe("toMetadata", () => {
  it("converts Unix timestamps to ISO dates", () => {
    const mod = {
      nid: "106016",
      title: "Token",
      field_project_machine_name: "token",
      created: "1148000000",
      changed: "1700000000",
      field_project_license: { title: "GPL-2.0+" },
    };
    const meta = toMetadata(mod);
    expect(meta.slug).toBe("token");
    expect(meta.registryAddedDate).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(meta.license).toBe("GPL-2.0+");
  });
});

describe("downloadModule", () => {
  let tmpDir: string;
  let state: DownloadState;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "drupal-test-"));
    state = new DownloadState(join(tmpDir, "test.db"));
  });

  it("skips if already downloaded", async () => {
    state.record(ECOSYSTEM, "token", "8.x-1.3", "/some/path.tar.gz", "abc");
    const client = mockClient([{
      list: [{ field_release_version: "8.x-1.3" }],
    }]);
    const result = await downloadModule(
      client, state,
      { nid: "1", title: "Token", field_project_machine_name: "token" },
      "8.x", tmpDir
    );
    expect(result).toBe(false);
    expect(client.download).not.toHaveBeenCalled();
  });
});
