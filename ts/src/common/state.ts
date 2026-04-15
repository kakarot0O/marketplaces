import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname } from "path";
import type { PackageMetadata, EcosystemStats } from "./types.js";

export class DownloadState {
  private db: Database.Database;

  constructor(dbPath = "data/downloads.db") {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.initTables();
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS downloads (
        ecosystem     TEXT NOT NULL,
        slug          TEXT NOT NULL,
        version       TEXT NOT NULL,
        file_path     TEXT,
        file_hash     TEXT,
        downloaded_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (ecosystem, slug, version)
      );

      CREATE TABLE IF NOT EXISTS packages (
        ecosystem           TEXT NOT NULL,
        slug                TEXT NOT NULL,
        name                TEXT,
        current_version     TEXT,
        description         TEXT,
        homepage_url        TEXT,
        download_url        TEXT,
        author              TEXT,
        author_profile_url  TEXT,
        license             TEXT,
        tags                TEXT,

        registry_added_date TEXT,
        last_updated_date   TEXT,

        download_count      INTEGER,
        active_installs     INTEGER,
        rating              REAL,
        num_ratings         INTEGER,

        is_removed          INTEGER NOT NULL DEFAULT 0,
        removed_at          TEXT,

        first_seen_at       TEXT NOT NULL DEFAULT (datetime('now')),
        last_checked_at     TEXT NOT NULL DEFAULT (datetime('now')),

        raw_metadata        TEXT,

        PRIMARY KEY (ecosystem, slug)
      );
    `);
  }

  isDownloaded(ecosystem: string, slug: string, version: string): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 FROM downloads WHERE ecosystem=? AND slug=? AND version=?"
      )
      .get(ecosystem, slug, version);
    return row !== undefined;
  }

  record(
    ecosystem: string,
    slug: string,
    version: string,
    filePath: string,
    fileHash: string | null
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO downloads (ecosystem, slug, version, file_path, file_hash)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(ecosystem, slug, version, filePath, fileHash ?? null);
  }

  upsertMetadata(meta: PackageMetadata): void {
    this.db
      .prepare(
        `INSERT INTO packages (
          ecosystem, slug, name, current_version, description, homepage_url,
          download_url, author, author_profile_url, license, tags,
          registry_added_date, last_updated_date,
          download_count, active_installs, rating, num_ratings,
          is_removed, removed_at, last_checked_at, raw_metadata
        ) VALUES (
          @ecosystem, @slug, @name, @currentVersion, @description, @homepageUrl,
          @downloadUrl, @author, @authorProfileUrl, @license, @tags,
          @registryAddedDate, @lastUpdatedDate,
          @downloadCount, @activeInstalls, @rating, @numRatings,
          0, NULL, datetime('now'), @rawMetadata
        )
        ON CONFLICT(ecosystem, slug) DO UPDATE SET
          name                = excluded.name,
          current_version     = excluded.current_version,
          description         = excluded.description,
          homepage_url        = excluded.homepage_url,
          download_url        = excluded.download_url,
          author              = excluded.author,
          author_profile_url  = excluded.author_profile_url,
          license             = excluded.license,
          tags                = excluded.tags,
          registry_added_date = excluded.registry_added_date,
          last_updated_date   = excluded.last_updated_date,
          download_count      = excluded.download_count,
          active_installs     = excluded.active_installs,
          rating              = excluded.rating,
          num_ratings         = excluded.num_ratings,
          is_removed          = 0,
          removed_at          = NULL,
          last_checked_at     = datetime('now'),
          raw_metadata        = excluded.raw_metadata`
      )
      .run({
        ecosystem: meta.ecosystem,
        slug: meta.slug,
        name: meta.name ?? null,
        currentVersion: meta.currentVersion ?? null,
        description: meta.description ?? null,
        homepageUrl: meta.homepageUrl ?? null,
        downloadUrl: meta.downloadUrl ?? null,
        author: meta.author ?? null,
        authorProfileUrl: meta.authorProfileUrl ?? null,
        license: meta.license ?? null,
        tags: meta.tags ? JSON.stringify(meta.tags) : null,
        registryAddedDate: meta.registryAddedDate ?? null,
        lastUpdatedDate: meta.lastUpdatedDate ?? null,
        downloadCount: meta.downloadCount ?? null,
        activeInstalls: meta.activeInstalls ?? null,
        rating: meta.rating ?? null,
        numRatings: meta.numRatings ?? null,
        rawMetadata: meta.rawMetadata ?? null,
      });
  }

  /**
   * Mark packages no longer returned by the registry listing as removed.
   * Call after a full run with the complete set of slugs seen.
   * Returns the number of packages newly marked as removed.
   */
  markRemovedIfAbsent(ecosystem: string, seenSlugs: Set<string>): number {
    const knownSlugs = this.db
      .prepare("SELECT slug FROM packages WHERE ecosystem=? AND is_removed=0")
      .all(ecosystem) as { slug: string }[];

    const markRemoved = this.db.prepare(
      `UPDATE packages SET is_removed=1, removed_at=datetime('now')
       WHERE ecosystem=? AND slug=?`
    );

    let count = 0;
    for (const { slug } of knownSlugs) {
      if (!seenSlugs.has(slug)) {
        markRemoved.run(ecosystem, slug);
        count++;
      }
    }
    return count;
  }

  stats(): EcosystemStats {
    const rows = this.db
      .prepare("SELECT ecosystem, COUNT(*) as cnt FROM downloads GROUP BY ecosystem")
      .all() as { ecosystem: string; cnt: number }[];
    return Object.fromEntries(rows.map((r) => [r.ecosystem, r.cnt]));
  }

  metadataStats(): EcosystemStats {
    const rows = this.db
      .prepare(
        "SELECT ecosystem, COUNT(*) as cnt FROM packages WHERE is_removed=0 GROUP BY ecosystem"
      )
      .all() as { ecosystem: string; cnt: number }[];
    return Object.fromEntries(rows.map((r) => [r.ecosystem, r.cnt]));
  }

  close(): void {
    this.db.close();
  }
}
