import { createHash } from "crypto";
import { createWriteStream, mkdirSync } from "fs";
import { dirname } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

const USER_AGENT =
  "security-research-bot/1.0 (plugin artifact scanner; contact security@example.com)";

const RETRY_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RateLimitedClient {
  private lastRequest = 0;
  private readonly minInterval: number;

  constructor(requestsPerSecond = 1.0) {
    this.minInterval = 1000 / requestsPerSecond;
  }

  private async wait(): Promise<void> {
    const elapsed = Date.now() - this.lastRequest;
    if (elapsed < this.minInterval) {
      await sleep(this.minInterval - elapsed);
    }
    this.lastRequest = Date.now();
  }

  async get(url: string, options: RequestInit = {}): Promise<Response> {
    return this.withRetry(async () => {
      await this.wait();
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(30_000),
        headers: {
          "User-Agent": USER_AGENT,
          ...(options.headers as Record<string, string> | undefined),
        },
      });
      if (!response.ok) {
        throw Object.assign(
          new Error(`HTTP ${response.status} for ${url}`),
          { status: response.status }
        );
      }
      return response;
    });
  }

  async getJson<T>(url: string, options: RequestInit = {}): Promise<T> {
    const response = await this.get(url, options);
    return response.json() as Promise<T>;
  }

  /**
   * Stream-download url to destPath. Returns sha256 hex digest.
   */
  async download(url: string, destPath: string): Promise<string> {
    return this.withRetry(async () => {
      await this.wait();
      const response = await fetch(url, {
        signal: AbortSignal.timeout(120_000),
        headers: { "User-Agent": USER_AGENT },
      });
      if (!response.ok) {
        throw Object.assign(
          new Error(`HTTP ${response.status} downloading ${url}`),
          { status: response.status }
        );
      }
      if (!response.body) {
        throw new Error(`No response body for ${url}`);
      }

      mkdirSync(dirname(destPath), { recursive: true });

      const hash = createHash("sha256");
      const dest = createWriteStream(destPath);

      // Convert web ReadableStream -> Node Readable, tee through hash
      const nodeStream = Readable.fromWeb(
        response.body as import("stream/web").ReadableStream
      );

      await pipeline(nodeStream, async function* (source) {
        for await (const chunk of source) {
          hash.update(chunk as Buffer);
          yield chunk;
        }
      }, dest);

      return hash.digest("hex");
    });
  }

  private async withRetry<T>(
    fn: () => Promise<T>,
    maxRetries = 3
  ): Promise<T> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err: unknown) {
        const status =
          err instanceof Error && "status" in err
            ? (err as { status: number }).status
            : undefined;
        const isRetryable =
          status !== undefined && RETRY_STATUS_CODES.has(status);
        if (attempt === maxRetries || !isRetryable) throw err;
        const backoff = Math.pow(2, attempt) * 1000;
        await sleep(backoff);
      }
    }
    throw new Error("unreachable");
  }
}
