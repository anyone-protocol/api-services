import type { Logger } from '@anyone-protocol/service-kit';
import { mkdir, rename } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { databasePath, EDITIONS, type Edition, type GeoDatabases, openDatabase } from './databases';
import type { MaxMindDownloads } from './maxmind-downloads';
import { Counter, metricFamily } from './metrics';
import { findTarEntry } from './tar';

export const UPDATE_RECORDS_FILE = 'update-state.json';

export type UpdateOutcome = 'downloaded' | 'unchanged' | 'failed';

export interface UpdateRecord {
  lastAttemptAt: string | null;
  lastOutcome: UpdateOutcome | null;
  lastError: string | null;
  archiveSha256: string | null;
}

export interface UpdateStatus extends UpdateRecord {
  enabled: boolean;
  nextCheckAfter: string | null;
}

export type UpdateRecords = Partial<Record<Edition, UpdateRecord>>;

export interface DatabaseUpdaterOptions {
  directory: string;
  databases: GeoDatabases;
  downloads: MaxMindDownloads | undefined;
  maxAgeMs: number;
  minRequestIntervalMs: number;
  logger: Logger;
  now?: () => number;
}

const NO_ATTEMPT: UpdateRecord = { lastAttemptAt: null, lastOutcome: null, lastError: null, archiveSha256: null };

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}

export class DatabaseUpdater {
  readonly requests = new Counter('geoip_update_requests_total', 'Update attempts against MaxMind, by edition and outcome');
  readonly #options: DatabaseUpdaterOptions;
  readonly #now: () => number;
  #records: UpdateRecords = {};
  #running: Promise<void> | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: DatabaseUpdaterOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.#options.downloads !== undefined;
  }

  start(intervalMs: number): void {
    const check = () => this.checkAll().catch((error) => this.#options.logger.error('Database update check failed', { error }));
    void check();
    this.#timer = setInterval(check, intervalMs);
  }

  stop(): void {
    clearInterval(this.#timer);
  }

  checkAll(): Promise<void> {
    this.#running ??= this.#checkAll().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  async update(edition: Edition, { force = false } = {}): Promise<UpdateRecord> {
    const { downloads, databases, logger } = this.#options;
    if (!downloads) {
      throw new Error('Database updates are disabled without MaxMind credentials');
    }

    const previous = (await this.#readRecords())[edition] ?? NO_ATTEMPT;
    const lastAttemptAt = new Date(this.#now()).toISOString();
    let record: UpdateRecord;
    try {
      const checksum = await downloads.checksum(edition);
      if (!force && databases.state(edition).loaded && checksum === previous.archiveSha256) {
        record = { lastAttemptAt, lastOutcome: 'unchanged', lastError: null, archiveSha256: checksum };
      } else {
        await this.#install(edition, await downloads.archive(edition), checksum);
        record = { lastAttemptAt, lastOutcome: 'downloaded', lastError: null, archiveSha256: checksum };
      }
    } catch (error) {
      const lastError = error instanceof Error ? error.message : String(error);
      record = { lastAttemptAt, lastOutcome: 'failed', lastError, archiveSha256: previous.archiveSha256 };
    }

    await this.#writeRecords({ ...(await this.#readRecords()), [edition]: record });
    this.requests.inc({ edition, outcome: record.lastOutcome ?? 'failed' });
    if (record.lastOutcome === 'failed') {
      logger.warn('Database update failed', { edition, error: record.lastError });
    } else {
      logger.info(record.lastOutcome === 'downloaded' ? 'Database downloaded' : 'Database unchanged', { edition, buildDate: databases.state(edition).buildDate });
    }
    return record;
  }

  status(edition: Edition): UpdateStatus {
    const record = this.#records[edition] ?? NO_ATTEMPT;
    const nextCheckAfter = this.#nextCheckAfter(edition, record);
    return {
      enabled: this.enabled,
      ...record,
      nextCheckAfter: this.enabled ? new Date(Number.isFinite(nextCheckAfter) ? nextCheckAfter : this.#now()).toISOString() : null,
    };
  }

  renderMetrics(): string {
    const attempts = EDITIONS.flatMap((edition) => {
      const lastAttemptAt = this.#records[edition]?.lastAttemptAt;
      return lastAttemptAt ? [{ labels: { edition }, value: Date.parse(lastAttemptAt) / 1000 }] : [];
    });
    return [
      metricFamily('geoip_updates_enabled', 'gauge', 'Whether the service downloads database updates from MaxMind', [{ value: Number(this.enabled) }]),
      metricFamily('geoip_update_last_attempt_timestamp_seconds', 'gauge', 'Time of the last update attempt against MaxMind', attempts),
      this.requests.render(),
    ].join('\n');
  }

  async #checkAll(): Promise<void> {
    const records = await this.#readRecords();
    if (!this.enabled) return;
    for (const edition of EDITIONS) {
      if (this.#now() >= this.#nextCheckAfter(edition, records[edition] ?? NO_ATTEMPT)) {
        await this.update(edition);
      }
    }
  }

  #nextCheckAfter(edition: Edition, record: UpdateRecord): number {
    const buildDate = this.#options.databases.buildDate(edition);
    const staleAt = buildDate ? buildDate.getTime() + this.#options.maxAgeMs : -Infinity;
    const allowedAt = record.lastAttemptAt ? Date.parse(record.lastAttemptAt) + this.#options.minRequestIntervalMs : -Infinity;
    return Math.max(staleAt, allowedAt);
  }

  async #install(edition: Edition, archive: Uint8Array<ArrayBuffer>, checksum: string): Promise<void> {
    const actual = sha256(archive);
    if (actual !== checksum) {
      throw new Error(`archive checksum ${actual} does not match the published ${checksum}`);
    }
    const file = findTarEntry(Bun.gunzipSync(archive), (path) => basename(path) === `${edition}.mmdb`);
    if (!file) {
      throw new Error(`archive holds no ${edition}.mmdb`);
    }

    const bytes = Buffer.from(file);
    const reader = openDatabase(edition, bytes);
    const loadedBuild = this.#options.databases.buildDate(edition);
    if (loadedBuild && reader.metadata.buildEpoch < loadedBuild) {
      throw new Error(`downloaded build ${reader.metadata.buildEpoch.toISOString()} is older than the loaded ${loadedBuild.toISOString()}`);
    }

    const path = databasePath(this.#options.directory, edition);
    await mkdir(this.#options.directory, { recursive: true });
    await Bun.write(`${path}.download`, bytes);
    await rename(`${path}.download`, path);
    this.#options.databases.replace(edition, reader);
  }

  async #readRecords(): Promise<UpdateRecords> {
    const file = Bun.file(join(this.#options.directory, UPDATE_RECORDS_FILE));
    try {
      this.#records = (await file.exists()) ? ((await file.json()) as UpdateRecords) : {};
    } catch (error) {
      this.#options.logger.warn('Update records unreadable, starting from none', { error });
      this.#records = {};
    }
    return this.#records;
  }

  async #writeRecords(records: UpdateRecords): Promise<void> {
    this.#records = records;
    const path = join(this.#options.directory, UPDATE_RECORDS_FILE);
    try {
      await mkdir(this.#options.directory, { recursive: true });
      await Bun.write(`${path}.tmp`, `${JSON.stringify(records, null, 2)}\n`);
      await rename(`${path}.tmp`, path);
    } catch (error) {
      this.#options.logger.error('Update records could not be written', { error });
    }
  }
}
