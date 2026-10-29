import { PROCESSES, type ProcessName } from './actions';

export const PROCESS_ID = /^[A-Za-z0-9_-]{43}$/;

export class ProcessIds {
  private readonly byName: ReadonlyMap<ProcessName, string>;
  private readonly byId: ReadonlyMap<string, ProcessName>;

  constructor(ids: Record<ProcessName, string>) {
    this.byName = new Map(PROCESSES.map((name) => [name, ids[name]]));
    this.byId = new Map(PROCESSES.map((name) => [ids[name], name]));
  }

  id(name: ProcessName): string {
    const id = this.byName.get(name);
    if (!id) throw new Error(`no process id for ${name}`);
    return id;
  }

  nameOf(id: string): ProcessName | undefined {
    return this.byId.get(id);
  }
}
