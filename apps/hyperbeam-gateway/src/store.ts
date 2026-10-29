import { Database } from 'bun:sqlite';

export interface AcceptedMessage {
  id: string;
  processId: string;
  action: string;
  signer: string;
  slot: string | null;
  status: number;
  body: string;
  contentType: string | null;
  acceptedAt: number;
}

interface Row {
  id: string;
  process_id: string;
  action: string;
  signer: string;
  slot: string | null;
  status: number;
  body: string;
  content_type: string | null;
  accepted_at: number;
}

export class MessageStore {
  private readonly database: Database;

  constructor(path: string) {
    this.database = new Database(path, { create: true, strict: true });
    this.database.run('PRAGMA journal_mode = WAL');
    this.database.run(`
      CREATE TABLE IF NOT EXISTS accepted (
        id TEXT PRIMARY KEY,
        process_id TEXT NOT NULL,
        action TEXT NOT NULL,
        signer TEXT NOT NULL,
        slot TEXT,
        status INTEGER NOT NULL,
        body TEXT NOT NULL,
        content_type TEXT,
        accepted_at INTEGER NOT NULL
      )
    `);
    this.database.run('CREATE INDEX IF NOT EXISTS accepted_slot ON accepted (process_id, slot)');
  }

  find(id: string): AcceptedMessage | undefined {
    const row = this.database.query<Row, { id: string }>('SELECT * FROM accepted WHERE id = $id').get({ id });
    return row
      ? {
          id: row.id,
          processId: row.process_id,
          action: row.action,
          signer: row.signer,
          slot: row.slot,
          status: row.status,
          body: row.body,
          contentType: row.content_type,
          acceptedAt: row.accepted_at,
        }
      : undefined;
  }

  record(message: AcceptedMessage): void {
    this.database
      .query(
        `INSERT OR IGNORE INTO accepted (id, process_id, action, signer, slot, status, body, content_type, accepted_at)
         VALUES ($id, $processId, $action, $signer, $slot, $status, $body, $contentType, $acceptedAt)`,
      )
      .run({ ...message });
  }

  hasSlot(processId: string, slot: string): boolean {
    return this.database.query('SELECT 1 FROM accepted WHERE process_id = $processId AND slot = $slot').get({ processId, slot }) !== null;
  }

  close(): void {
    this.database.close();
  }
}
