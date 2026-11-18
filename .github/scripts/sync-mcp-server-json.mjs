import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const SERVER_NAME = 'io.github.Godcreatebugs/raytrace';

const STABLE = /^\d+\.\d+\.\d+$/;

/** The README line the registry accepts as PyPI ownership proof. */
export function mcpNameMarker() {
  return `<!-- mcp-name: ${SERVER_NAME} -->`;
}

/** True when `readme` carries the ownership token on its own line, closed as a comment. */
export function readmeHasMcpName(readme) {
  return readme.split('\n').some((line) => line.trim() === mcpNameMarker());
}

function positionalMcp(entry) {
  return (entry.packageArguments ?? []).filter((arg) => arg.type === 'positional' && arg.value === 'mcp');
}

/**
 * Point `server` at `pkg.version` and check it still describes this CLI.
 * The release tag keeps whatever version was on main; publishing overwrites it
 * in the runner, because a registry version has to be the version just released.
 */
export function syncServerJson(server, pkg) {
  if (pkg?.name !== '@raytrace-cli/cli') throw new Error('Expected the RayTrace CLI package.');
  if (pkg.mcpName !== SERVER_NAME) {
    throw new Error(`package.json mcpName must be ${SERVER_NAME}. The registry reads it from the published npm package.`);
  }
  if (server?.name !== SERVER_NAME) throw new Error(`server.json name must be ${SERVER_NAME}.`);
  if (server.title !== 'RayTrace') throw new Error('server.json title must be RayTrace.');
  if (typeof server.description !== 'string' || server.description.length < 1 || server.description.length > 100) {
    throw new Error('server.json description must be 1-100 characters.');
  }
  if (server.repository?.url !== 'https://github.com/Godcreatebugs/raytrace-cli' || server.repository?.source !== 'github') {
    throw new Error('server.json repository must point at https://github.com/Godcreatebugs/raytrace-cli.');
  }
  if (!STABLE.test(pkg.version)) throw new Error(`Expected a stable version, got ${pkg.version}.`);
  const packages = server.packages ?? [];
  const npm = packages.find((entry) => entry.registryType === 'npm');
  const pypi = packages.find((entry) => entry.registryType === 'pypi');
  if (packages.length !== 2 || !npm || !pypi) throw new Error('server.json must list the npm package and the PyPI package.');
  if (npm.identifier !== '@raytrace-cli/cli' || npm.runtimeHint !== 'npx' || npm.transport?.type !== 'stdio' || positionalMcp(npm).length !== 1) {
    throw new Error('The npm package must run @raytrace-cli/cli over stdio with a positional mcp argument.');
  }
  if (pypi.identifier !== 'raytrace-cli' || pypi.runtimeHint !== 'uvx' || pypi.transport?.type !== 'stdio' || positionalMcp(pypi).length !== 1) {
    throw new Error('The PyPI package must run raytrace-cli over stdio with a positional mcp argument.');
  }
  const next = structuredClone(server);
  next.version = pkg.version;
  for (const entry of next.packages) entry.version = pkg.version;
  return next;
}

export function npmMetadataUrl(version) {
  return `https://registry.npmjs.org/${encodeURIComponent('@raytrace-cli/cli')}/${encodeURIComponent(version)}`;
}

export function pypiMetadataUrl(version) {
  return `https://pypi.org/pypi/raytrace-cli/${encodeURIComponent(version)}/json`;
}

function note(message) {
  console.error(message);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
}

async function fetchJson(url, attempts) {
  let last = 0;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'raytrace-cli-mcp-registry' } });
    last = response.status;
    if (response.status === 200) return response.json();
    if (response.status !== 404 && response.status < 500 && response.status !== 429) {
      throw new Error(`${url} returned HTTP ${response.status}`);
    }
    if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  const error = new Error(`not published (HTTP ${last})`);
  error.status = last;
  throw error;
}

/** Fail until npm carries mcpName and PyPI carries the ownership line, for this exact version. */
export async function assertPackagesPublished(version) {
  let npm;
  try {
    npm = await fetchJson(npmMetadataUrl(version), 8);
  } catch (error) {
    throw new Error(`@raytrace-cli/cli@${version} is not on npm yet (${error.message}). Publish the package before the MCP Registry.`, { cause: error });
  }
  if (npm.mcpName !== SERVER_NAME) {
    throw new Error(`@raytrace-cli/cli@${version} on npm has mcpName ${JSON.stringify(npm.mcpName ?? null)}, not ${SERVER_NAME}. Releases cut before that field was added cannot be listed.`);
  }
  let pypi;
  try {
    pypi = await fetchJson(pypiMetadataUrl(version), 8);
  } catch (error) {
    throw new Error([
      `raytrace-cli ${version} is not on PyPI yet (${error.message}), so ${SERVER_NAME} ${version} was not published.`,
      'The PyPI job uploads that version before this step.',
      'Re-run Publish npm package with this tag once the PyPI trusted publisher is saved.',
      'No PyPI token and no registry secret are required.',
    ].join(' '), { cause: error });
  }
  const description = pypi?.info?.description ?? '';
  if (!description.includes(mcpNameMarker()) && !readmeHasMcpName(description)) {
    throw new Error(`raytrace-cli ${version} is on PyPI but its description has no "${mcpNameMarker()}" line. Rebuild the wheels from this release and upload them again before publishing the registry entry.`);
  }
}

async function main() {
  const serverPath = 'server.json';
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  let server;
  try {
    server = JSON.parse(readFileSync(serverPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('This release tag has no server.json. Listing starts with the first release cut after that file is on main.');
    }
    throw error;
  }
  const synced = syncServerJson(server, pkg);
  writeFileSync(serverPath, `${JSON.stringify(synced, null, 2)}\n`);
  if (process.argv.includes('--check-published')) {
    try {
      await assertPackagesPublished(synced.version);
    } catch (error) {
      note(error.message);
      process.exitCode = 1;
      return;
    }
    const message = `${SERVER_NAME} ${synced.version}: npm and PyPI both carry the registry name.`;
    console.log(message);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    note(error.message);
    process.exitCode = 1;
  });
}
