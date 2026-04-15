import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DownloadState } from "../src/common/state.js";

let tmpDir: string;
let state: DownloadState;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "state-test-"));
  state = new DownloadState(join(tmpDir, "test.db"));
});

describe("DownloadState", () => {
  it("returns false for unseen packages", () => {
    expect(state.isDownloaded("wordpress", "akismet", "5.3")).toBe(false);
  });

  it("returns true after recording", () => {
    state.record("wordpress", "akismet", "5.3", "/tmp/akismet.zip", "abc");
    expect(state.isDownloaded("wordpress", "akismet", "5.3")).toBe(true);
  });

  it("does not cross ecosystems", () => {
    state.record("wordpress", "akismet", "5.3", "/tmp/akismet.zip", "abc");
    expect(state.isDownloaded("drupal", "akismet", "5.3")).toBe(false);
  });

  it("does not cross versions", () => {
    state.record("wordpress", "akismet", "5.3", "/tmp/v1.zip", "abc");
    expect(state.isDownloaded("wordpress", "akismet", "5.4")).toBe(false);
  });

  it("counts by ecosystem in stats()", () => {
    state.record("wordpress", "plugin-a", "1.0", "/tmp/a.zip", null!);
    state.record("wordpress", "plugin-b", "2.0", "/tmp/b.zip", null!);
    state.record("drupal", "module-c", "3.0", "/tmp/c.tar.gz", null!);
    const s = state.stats();
    expect(s["wordpress"]).toBe(2);
    expect(s["drupal"]).toBe(1);
  });

  it("is idempotent on duplicate record()", () => {
    state.record("wordpress", "akismet", "5.3", "/tmp/v1.zip", "h1");
    state.record("wordpress", "akismet", "5.3", "/tmp/v2.zip", "h2");
    expect(state.isDownloaded("wordpress", "akismet", "5.3")).toBe(true);
  });
});

describe("DownloadState.upsertMetadata", () => {
  it("stores and counts metadata", () => {
    state.upsertMetadata({
      ecosystem: "wordpress",
      slug: "akismet",
      name: "Akismet",
      currentVersion: "5.3",
      downloadCount: 1_000_000,
      activeInstalls: 5_000_000,
      rating: 88,
    });
    const s = state.metadataStats();
    expect(s["wordpress"]).toBe(1);
  });

  it("upserts without error on second call", () => {
    const base = { ecosystem: "wordpress", slug: "akismet", name: "Akismet" };
    state.upsertMetadata(base);
    state.upsertMetadata({ ...base, currentVersion: "5.4" });
    expect(state.metadataStats()["wordpress"]).toBe(1);
  });
});

describe("DownloadState.markRemovedIfAbsent", () => {
  it("marks packages not in seenSlugs as removed", () => {
    state.upsertMetadata({ ecosystem: "wordpress", slug: "old-plugin", name: "Old" });
    state.upsertMetadata({ ecosystem: "wordpress", slug: "current-plugin", name: "Current" });

    const count = state.markRemovedIfAbsent("wordpress", new Set(["current-plugin"]));
    expect(count).toBe(1);
  });

  it("does not touch other ecosystems", () => {
    state.upsertMetadata({ ecosystem: "drupal", slug: "views", name: "Views" });
    state.markRemovedIfAbsent("wordpress", new Set());
    expect(state.metadataStats()["drupal"]).toBe(1);
  });
});
