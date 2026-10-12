import { describe, expect, it } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const rootManifest = await Bun.file(join(root, 'package.json')).json();
const bunImage = `docker.io/oven/bun:${rootManifest.packageManager.replace('bun@', '')}`;
const services = readdirSync(join(root, 'apps'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

describe.each(services)('apps/%s', (service) => {
  const directory = join(root, 'apps', service);

  it('is named after its directory', async () => {
    const manifest = await Bun.file(join(directory, 'package.json')).json();

    expect(manifest.name).toBe(service);
  });

  it('has a Dockerfile on the pinned Bun release that installs and starts this service', async () => {
    const dockerfile = await Bun.file(join(directory, 'Dockerfile')).text();
    const baseImages = dockerfile
      .split('\n')
      .filter((line) => line.startsWith('FROM '))
      .map((line) => line.split(' ')[1]);

    expect(baseImages.length).toBeGreaterThan(0);
    expect(new Set(baseImages)).toEqual(new Set([bunImage]));
    expect(dockerfile).toContain(`--filter ${service}\n`);
    expect(dockerfile).toContain(`COPY apps/${service} ./apps/${service}\n`);
    expect(dockerfile).toContain(`CMD ["bun", "apps/${service}/src/main.ts"]`);
  });
});
