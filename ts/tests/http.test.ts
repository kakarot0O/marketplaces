import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { RateLimitedClient } from "../src/common/http.js";

describe("RateLimitedClient rate limiting", () => {
  it("waits between requests when hammered", async () => {
    const client = new RateLimitedClient(5); // 5 rps = 200ms gap
    // Force last-request to now so next call must wait
    (client as unknown as { lastRequest: number }).lastRequest = Date.now();

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const start = Date.now();
    await client.getJson("https://example.com/api");
    const elapsed = Date.now() - start;

    // Should have waited at least 150ms (200ms gap minus some tolerance)
    expect(elapsed).toBeGreaterThanOrEqual(150);
    fetchSpy.mockRestore();
  });

  it("does not wait when last request was long ago", async () => {
    const client = new RateLimitedClient(2); // 2 rps = 500ms gap
    // Set last request to 2 seconds ago
    (client as unknown as { lastRequest: number }).lastRequest = Date.now() - 2000;

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const start = Date.now();
    await client.getJson("https://example.com/api");
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(100);
    fetchSpy.mockRestore();
  });
});

describe("RateLimitedClient.getJson", () => {
  it("returns parsed JSON on success", async () => {
    const client = new RateLimitedClient(100);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ name: "test", count: 42 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const result = await client.getJson<{ name: string; count: number }>("https://example.com/test");
    expect(result.name).toBe("test");
    expect(result.count).toBe(42);
    fetchSpy.mockRestore();
  });

  it("throws on 404 response (non-retryable)", async () => {
    const client = new RateLimitedClient(100);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Not Found", { status: 404 })
    );

    await expect(client.getJson("https://example.com/missing")).rejects.toThrow("404");
    fetchSpy.mockRestore();
  });
});

describe("RateLimitedClient.download", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "http-test-"));
  });

  it("writes file and returns sha256 hash", async () => {
    const content = "fake zip content for testing";
    const client = new RateLimitedClient(100);

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(content, {
        status: 200,
        headers: { "Content-Type": "application/zip" },
      })
    );

    const destPath = join(tmpDir, "test.zip");
    const hash = await client.download("https://example.com/file.zip", destPath);

    expect(typeof hash).toBe("string");
    expect(hash).toHaveLength(64); // SHA256 hex = 64 chars
    const written = readFileSync(destPath, "utf8");
    expect(written).toBe(content);
    fetchSpy.mockRestore();
  });

  it("throws on 404 download (non-retryable)", async () => {
    const client = new RateLimitedClient(100);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Not Found", { status: 404 })
    );

    const destPath = join(tmpDir, "fail.zip");
    await expect(client.download("https://example.com/fail.zip", destPath)).rejects.toThrow("404");
    fetchSpy.mockRestore();
  });
});
