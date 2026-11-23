// Shared low-level /v1 HTTP client for @raytrace-cli/sdk.
// Zero runtime dependencies (Node 20+ native fetch + zlib + crypto).
import { gzipSync } from 'node:zlib';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';

export const DEFAULT_BASE_URL = 'https://api.raytracer.si';

const DEFAULT_EXCLUDED = new Set([
  '.git', '.raytace', '.raytrace', '.ssh', '.aws', '.azure', '.config',
  '.claude', '.codex', '.docker', '.kube', '.gnupg', 'node_modules',
  '.venv', '__pycache__', '.next', 'dist', 'coverage', '.DS_Store',
]);
// Files that usually hold credentials, never uploaded (the same rules as the
// CLI's `raytrace sandbox create`). Compared in lower case.
const SECRET_NAMES = new Set([
  '.npmrc', '.netrc', '.pypirc', '.htpasswd', '.dockercfg', 'credentials', 'credentials.json', 'credentials.ini',
  'auth.json', 'service-account.json', 'service_account.json', 'serviceaccountkey.json',
  'client_secret.json', 'client_secrets.json', 'token.json', 'id_rsa', 'id_dsa', 'id_ecdsa',
  'id_ed25519', 'id_ecdsa_sk', 'id_ed25519_sk', 'known_hosts',
]);
const SECRET_EXTENSIONS = /\.(pem|key|p12|pfx)$/i;

export function isSecretFile(name) {
  const lower = String(name).toLowerCase();
  return lower.startsWith('.env') || lower.startsWith('.secret') || SECRET_EXTENSIONS.test(lower) || SECRET_NAMES.has(lower);
}

export class RayTraceError extends Error {
  constructor(message, { status = 0, code = null, topupUrl = null, body = null } = {}) {
    super(message);
    this.name = 'RayTraceError';
    this.status = status;
    this.code = code;
    this.topupUrl = topupUrl;
    this.body = body;
  }
}

function writeOctal(buf, offset, length, value) {
  const str = Math.max(0, value).toString(8).padStart(length - 1, '0');
  buf.write(str.slice(-(length - 1)), offset, length - 1, 'ascii');
  buf[offset + length - 1] = 0;
}

/**
 * Pure-JS POSIX ustar + gzip builder (no external tar binary or npm packages).
 * Accepts a map of relative POSIX paths -> string | Uint8Array | Buffer.
 */
export function buildTarGz(files) {
  const chunks = [];
  const entries = Object.entries(files || {});
  if (!entries.length) {
    throw new Error('Archive must contain at least one file');
  }
  for (const [rawPath, content] of entries) {
    const rel = String(rawPath).replace(/^\/+/, '');
    if (!rel || rel.includes('..') || rel.length > 99) {
      throw new Error(`Invalid archive file path: ${rawPath}`);
    }
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const header = Buffer.alloc(512, 0);
    header.write(rel, 0, Math.min(rel.length, 100), 'utf8');
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 1000);
    writeOctal(header, 116, 8, 1000);
    writeOctal(header, 124, 12, data.length);
    writeOctal(header, 136, 12, Math.floor(Date.now() / 1000));
    header.fill(0x20, 148, 156); // checksum placeholder spaces
    header[156] = 0x30; // '0' regular file
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += header[i];
    const chk = sum.toString(8).padStart(6, '0');
    header.write(chk, 148, 6, 'ascii');
    header[154] = 0;
    header[155] = 0x20;
    chunks.push(header);
    if (data.length > 0) {
      chunks.push(data);
      const pad = (512 - (data.length % 512)) % 512;
      if (pad) chunks.push(Buffer.alloc(pad, 0));
    }
  }
  chunks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(chunks));
}

export function archiveFromDirectory(dirPath) {
  const files = {};
  function walk(absDir, relPrefix) {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      if (DEFAULT_EXCLUDED.has(entry.name)) continue;
      const abs = join(absDir, entry.name);
      const rel = relPrefix ? posix.join(relPrefix, entry.name) : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile() && !isSecretFile(entry.name)) {
        const st = statSync(abs);
        if (st.size <= 25 * 1024 * 1024) {
          files[rel] = readFileSync(abs);
        }
      }
    }
  }
  walk(dirPath, '');
  return buildTarGz(files);
}

export class RayTraceClient {
  constructor({ apiKey = process.env.RAYTRACE_API_KEY, baseUrl = process.env.RAYTRACE_API_URL || DEFAULT_BASE_URL, fetchImpl = globalThis.fetch } = {}) {
    if (!apiKey) {
      throw new Error('RayTrace API key is required (pass { apiKey } or set RAYTRACE_API_KEY)');
    }
    if (typeof fetchImpl !== 'function') {
      throw new Error('A Fetch API implementation is required');
    }
    this.apiKey = apiKey;
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.fetch = fetchImpl;
  }

  async request(method, path, { headers = {}, body = undefined } = {}) {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const reqHeaders = {
      Authorization: `Bearer ${this.apiKey}`,
      ...headers,
    };
    let reqBody = body;
    if (body !== undefined && !(body instanceof Uint8Array) && typeof body !== 'string') {
      reqHeaders['Content-Type'] = 'application/json';
      reqBody = JSON.stringify(body);
    }
    const response = await this.fetch(url, { method, headers: reqHeaders, body: reqBody });
    const text = await response.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { error: text };
      }
    }
    if (!response.ok) {
      throw new RayTraceError(
        (parsed && parsed.error) || `RayTrace API error (HTTP ${response.status})`,
        {
          status: response.status,
          code: (parsed && parsed.code) || null,
          topupUrl: (parsed && parsed.topup_url) || null,
          body: parsed,
        },
      );
    }
    return { status: response.status, data: parsed };
  }
}
