import type { Config } from '../config.js';
import type { HttpClient } from '../net/http.js';
import type { RobotsCache } from '../net/robots.js';
import type { Logger } from '../log.js';

export type Policy = 'MIRROR_ALLOWED' | 'PERMISSION_REQUIRED' | 'EXTERNAL_ONLY' | 'BLOCKED';

export interface SourceRow {
  id: string;
  name: string;
  kind: string;
  homepage: string | null;
  config: Record<string, any>;
  policy: Policy;
  license: string | null;
  permission_evidence: string | null;
  enabled: boolean;
  paused: boolean;
  discovery_interval_minutes: number;
}

/** One save as published by a discovery source. Only fields the source actually states are filled. */
export interface DiscoveredItem {
  sourceItemKey: string;
  sourcePageUrl?: string | null;
  downloadUrl?: string | null;
  fileHost?: string | null;
  platform?: 'PS4' | 'PS5' | null;
  gameTitle?: string | null;
  titleId?: string | null;
  region?: string | null;
  regionSource?: string | null;
  category?: string | null;
  categorySource?: string | null;
  description?: string | null;
  originalAuthor?: string | null;
  uploadedBy?: string | null;
  uploadedBySource?: string | null;
  originalFilename?: string | null;
  fileFormat?: string | null;
  expectedSize?: number | null;
  expectedHash?: string | null;
  /** Item-level permission (e.g. a licence that only covers part of a source). Defaults from the source policy. */
  redistribution?: 'granted' | 'pending' | 'denied';
  permissionBasis?: string | null;
  /** Known access restriction (login wall, paid, private) — recorded as RESTRICTED, never fetched. */
  restrictedReason?: string | null;
  raw?: Record<string, unknown>;
}

export interface SourceContext {
  cfg: Config;
  http: HttpClient;
  robots: RobotsCache;
  log: Logger;
  source: SourceRow;
}

export interface SourceConnector {
  kind: string;
  description: string;
  /** true when the connector has been exercised against the live source */
  liveTested: boolean;
  discover(ctx: SourceContext): AsyncIterable<DiscoveredItem>;
}
