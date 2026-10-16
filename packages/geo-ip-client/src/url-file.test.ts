import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { urlFromFile } from './url-file';

let directory: string;
let file: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'geo-ip-client-'));
  file = join(directory, 'geo-ip-service-url');
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('urlFromFile', () => {
  it('reads the trimmed contents of the file on every call', async () => {
    const url = urlFromFile(file);

    await writeFile(file, 'http://10.1.0.5:24312\n');
    expect(url()).toBe('http://10.1.0.5:24312');

    await writeFile(file, '\n  http://10.1.0.6:25001  \n');
    expect(url()).toBe('http://10.1.0.6:25001');
  });

  it('has no address while the file is missing or blank', async () => {
    const url = urlFromFile(file);
    expect(url()).toBeUndefined();

    await writeFile(file, '\n');
    expect(url()).toBeUndefined();
  });

  it('throws when the path cannot be read as a file', () => {
    expect(() => urlFromFile(directory)()).toThrow();
  });
});
