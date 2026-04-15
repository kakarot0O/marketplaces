/** Metadata stored for every package we discover, regardless of download status. */
export interface PackageMetadata {
  ecosystem: string;
  slug: string;
  name: string;
  currentVersion?: string;
  description?: string;
  homepageUrl?: string;
  downloadUrl?: string;
  license?: string;
  tags?: string[];

  // Author / publisher
  author?: string;
  authorProfileUrl?: string;

  // Dates (ISO strings)
  registryAddedDate?: string;   // when first published to registry
  lastUpdatedDate?: string;     // when last updated in registry

  // Popularity
  downloadCount?: number;       // all-time downloads (WordPress: "downloaded", Joomla: "core_hits" proxy)
  activeInstalls?: number;      // WordPress only
  rating?: number;              // WordPress: 0-100, Joomla: numeric score
  numRatings?: number;

  // Status (removal detection: we record this ourselves)
  isRemoved?: boolean;
  removedAt?: string;

  // Raw API response for any fields not mapped above
  rawMetadata?: string;         // JSON string
}

/** Record of a downloaded artifact. */
export interface DownloadRecord {
  ecosystem: string;
  slug: string;
  version: string;
  filePath: string;
  fileHash: string;
}

/** Aggregate stats returned by DownloadState.stats() */
export type EcosystemStats = Record<string, number>;
