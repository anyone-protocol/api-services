import { appendFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { $ } from 'bun';

const FILES_IN_EVERY_IMAGE = new Set(['package.json', 'bun.lock', 'tsconfig.json', '.dockerignore']);
const NO_COMMIT = /^0*$/;

export interface Workspace {
  services: string[];
  packagesByService: Record<string, string[]>;
}

export type AffectedServices = Record<string, string[]>;

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
}

function directoriesIn(path: string): string[] {
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function workspaceDependencies(manifest: Manifest): string[] {
  return Object.entries(manifest.dependencies ?? {})
    .filter(([, version]) => version.startsWith('workspace:'))
    .map(([name]) => name);
}

export async function loadWorkspace(root: string): Promise<Workspace> {
  const readManifest = (...path: string[]): Promise<Manifest> => Bun.file(join(root, ...path, 'package.json')).json();

  const packages = new Map<string, { directory: string; manifest: Manifest }>();
  for (const directory of directoriesIn(join(root, 'packages'))) {
    const manifest = await readManifest('packages', directory);
    packages.set(manifest.name, { directory, manifest });
  }

  const services = directoriesIn(join(root, 'apps'));
  const packagesByService: Record<string, string[]> = {};
  for (const service of services) {
    const directories = new Set<string>();
    const pending = workspaceDependencies(await readManifest('apps', service));
    for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
      const dependency = packages.get(name);
      if (!dependency || directories.has(dependency.directory)) continue;
      directories.add(dependency.directory);
      pending.push(...workspaceDependencies(dependency.manifest));
    }
    packagesByService[service] = [...directories].sort();
  }

  return { services, packagesByService };
}

export function affectedServices(changedFiles: string[], workspace: Workspace): AffectedServices {
  const reasons = new Map<string, Set<string>>();
  const affect = (service: string, reason: string) => {
    reasons.set(service, (reasons.get(service) ?? new Set()).add(reason));
  };

  for (const file of changedFiles) {
    const [top, directory] = file.split('/');
    if (FILES_IN_EVERY_IMAGE.has(file)) {
      workspace.services.forEach((service) => affect(service, file));
    } else if (top === 'apps' && directory && workspace.services.includes(directory)) {
      affect(directory, `apps/${directory}`);
    } else if (top === 'packages' && directory) {
      workspace.services
        .filter((service) => workspace.packagesByService[service]?.includes(directory))
        .forEach((service) => affect(service, `packages/${directory}`));
    }
  }

  return Object.fromEntries(
    workspace.services
      .filter((service) => reasons.has(service))
      .map((service) => [service, [...(reasons.get(service) ?? [])].sort()]),
  );
}

export function requestedServices(request: string, workspace: Workspace): AffectedServices {
  const names = request.trim() === 'all' ? workspace.services : request.trim().split(/[\s,]+/);
  const unknown = names.filter((name) => !workspace.services.includes(name));
  if (unknown.length > 0) {
    throw new Error(`Unknown service: ${unknown.join(', ')}. Services: ${workspace.services.join(', ')}`);
  }
  return Object.fromEntries(workspace.services.filter((name) => names.includes(name)).map((name) => [name, ['requested']]));
}

async function commitExists(sha: string): Promise<boolean> {
  const { exitCode } = await $`git cat-file -e ${`${sha}^{commit}`}`.nothrow().quiet();
  return exitCode === 0;
}

async function selectServices(options: { base: string; head: string; services: string }, workspace: Workspace): Promise<AffectedServices> {
  if (options.services.trim() !== '') {
    return requestedServices(options.services, workspace);
  }
  if (NO_COMMIT.test(options.base) || !(await commitExists(options.base))) {
    return Object.fromEntries(workspace.services.map((service) => [service, ['no earlier commit to compare with']]));
  }
  const diff = await $`git diff --name-only ${options.base} ${options.head}`.text();
  return affectedServices(diff.split('\n').filter(Boolean), workspace);
}

function report(affected: AffectedServices, workspace: Workspace): string {
  const rows = workspace.services.map((service) => {
    const reasons = affected[service];
    return `| ${service} | ${reasons ? 'yes' : 'no'} | ${reasons?.join(', ') ?? ''} |`;
  });
  return ['| Service | Publish | Because of |', '| --- | --- | --- |', ...rows].join('\n');
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      base: { type: 'string', default: '' },
      head: { type: 'string', default: 'HEAD' },
      services: { type: 'string', default: '' },
    },
  });

  const workspace = await loadWorkspace(join(import.meta.dir, '..'));
  const affected = await selectServices(values, workspace);
  const summary = report(affected, workspace);

  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  }
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `services=${JSON.stringify(Object.keys(affected))}\n`);
  }
}
