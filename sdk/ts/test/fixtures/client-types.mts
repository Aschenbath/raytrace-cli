import RayTrace from '@raytrace-cli/sdk';
import {
  DEFAULT_BASE_URL, RayTraceClient, RayTraceError, archiveFromDirectory,
  archiveFromRepo, buildTarGz, connectScript, githubRepo, isSecretFile,
  repoName, repoUrl, workBranch,
} from '@raytrace-cli/sdk/client';
import type { RayTraceOptions } from '@raytrace-cli/sdk/client';

// @ts-expect-error The low-level runtime has no default export.
import MissingDefault from '@raytrace-cli/sdk/client';
// @ts-expect-error High-level classes are available only from the package root.
import { RayTrace as MissingRayTrace, Sandbox } from '@raytrace-cli/sdk/client';

const options: RayTraceOptions = { apiKey: 'test', baseUrl: DEFAULT_BASE_URL };
new RayTrace(options);
new RayTraceClient(options).request('GET', '/v1/sandboxes');
new RayTraceError('failed');
const archive: Buffer = buildTarGz({ 'README.md': 'hello' });
const directory: Buffer = archiveFromDirectory('.');
const repository: Promise<Buffer> = archiveFromRepo('owner/repo');
const secret: boolean = isSecretFile('.env');
const url: string = repoUrl('owner/repo');
const name: string = repoName(url);
const github: string | null = githubRepo(url);
const branch: string = workBranch('rtp-test');
const script: string = connectScript({ repo: 'owner/repo', sandboxId: 'rtp-test' });
