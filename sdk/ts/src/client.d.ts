export type { RayTraceOptions } from './index.js';
export {
  RayTraceClient, RayTraceError, archiveFromDirectory, archiveFromRepo,
  buildTarGz, connectScript, githubRepo, workBranch,
} from './index.js';

export const DEFAULT_BASE_URL: string;
export function isSecretFile(name: string): boolean;
/** The clone URL for an https/ssh URL, host/owner/name, or GitHub owner/name. */
export function repoUrl(repo: string): string;
/** The last repository path segment without .git, used as the sandbox name. */
export function repoName(repo: string): string;
