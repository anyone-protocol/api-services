import { afterAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { affectedServices, loadWorkspace, requestedServices, type Workspace } from './affected-services';

const workspace: Workspace = {
  services: ['alpha', 'beta'],
  packagesByService: { alpha: ['shared'], beta: ['shared', 'beta-only'] },
};

describe('affectedServices', () => {
  it('selects only the service whose sources changed', () => {
    expect(affectedServices(['apps/alpha/src/main.ts', 'apps/alpha/Dockerfile'], workspace)).toEqual({
      alpha: ['apps/alpha'],
    });
  });

  it('selects every service that depends on a changed package', () => {
    expect(affectedServices(['packages/shared/src/index.ts'], workspace)).toEqual({
      alpha: ['packages/shared'],
      beta: ['packages/shared'],
    });
    expect(affectedServices(['packages/beta-only/src/index.ts'], workspace)).toEqual({
      beta: ['packages/beta-only'],
    });
  });

  it('selects every service when a file that enters every image changed', () => {
    expect(Object.keys(affectedServices(['bun.lock'], workspace))).toEqual(['alpha', 'beta']);
    expect(Object.keys(affectedServices(['tsconfig.json'], workspace))).toEqual(['alpha', 'beta']);
  });

  it('selects nothing for files that enter no image', () => {
    const files = ['README.md', '.github/workflows/ci.yaml', 'operations/alpha-stage.hcl', 'docs/notes.md'];

    expect(affectedServices(files, workspace)).toEqual({});
  });

  it('ignores a removed service and a package nothing depends on', () => {
    expect(affectedServices(['apps/removed/src/main.ts', 'packages/unused/src/index.ts'], workspace)).toEqual({});
  });

  it('lists each reason once', () => {
    const files = ['apps/beta/src/a.ts', 'apps/beta/src/b.ts', 'packages/shared/src/index.ts', 'bun.lock'];

    expect(affectedServices(files, workspace).beta).toEqual(['apps/beta', 'bun.lock', 'packages/shared']);
  });
});

describe('requestedServices', () => {
  it('expands all to every service', () => {
    expect(Object.keys(requestedServices('all', workspace))).toEqual(['alpha', 'beta']);
  });

  it('accepts a space or comma separated list', () => {
    expect(Object.keys(requestedServices('beta alpha', workspace))).toEqual(['alpha', 'beta']);
    expect(Object.keys(requestedServices('beta,alpha', workspace))).toEqual(['alpha', 'beta']);
  });

  it('rejects a name that is not a service', () => {
    expect(() => requestedServices('alpha gamma', workspace)).toThrow('Unknown service: gamma');
  });
});

describe('loadWorkspace', () => {
  const roots: string[] = [];

  afterAll(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  async function repository(manifests: Record<string, object>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'affected-services-'));
    roots.push(root);
    await mkdir(join(root, 'packages'));
    for (const [directory, manifest] of Object.entries(manifests)) {
      await Bun.write(join(root, directory, 'package.json'), JSON.stringify(manifest));
    }
    return root;
  }

  it('follows workspace dependencies through other packages', async () => {
    const root = await repository({
      'apps/alpha': { name: 'alpha', dependencies: { '@scope/client': 'workspace:*', express: '^4.0.0' } },
      'apps/beta': { name: 'beta' },
      'packages/client': { name: '@scope/client', dependencies: { '@scope/kit': 'workspace:*' } },
      'packages/kit': { name: '@scope/kit' },
      'packages/unused': { name: '@scope/unused' },
    });

    expect(await loadWorkspace(root)).toEqual({
      services: ['alpha', 'beta'],
      packagesByService: { alpha: ['client', 'kit'], beta: [] },
    });
  });
});
