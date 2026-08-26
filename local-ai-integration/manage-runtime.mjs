#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const LOCK_PATH = path.join(ROOT, 'local-ai-rtx.lock.json');
const COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const VERSION = /^\d+\.\d+\.\d+$/;

export function loadLock(filename = LOCK_PATH) {
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}
export function validateLock(lock) {
  const errors = [];
  if (lock?.schema_version !== 1) errors.push('unsupported_schema_version');
  if (lock?.repository !== 'https://github.com/gabrafur/local-ai-rtx') errors.push('unexpected_repository');
  if (!VERSION.test(String(lock?.version || ''))) errors.push('invalid_version');
  if (lock?.tag !== `v${lock?.version}`) errors.push('tag_version_mismatch');
  if (!COMMIT.test(String(lock?.commit || ''))) errors.push('invalid_commit');
  if (!SHA256.test(String(lock?.asset_sha256 || ''))) errors.push('invalid_asset_sha256');
  const expected = `${lock?.repository}/releases/download/${lock?.tag}/local-ai-rtx-${lock?.version}.tar.gz`;
  if (lock?.asset_url !== expected) errors.push('unexpected_asset_url');
  return errors;
}

function sha256(filename) {
  const digest = createHash('sha256');
  digest.update(fs.readFileSync(filename));
  return digest.digest('hex');
}

function download(url, destination, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error('too_many_redirects'));
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') return Promise.reject(new Error('https_required'));
  return new Promise((resolve, reject) => {
    const request = https.get(parsed, { headers: { 'User-Agent': 'my-smart-home-local-ai-installer' } }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        const redirected = new URL(response.headers.location, parsed).toString();
        download(redirected, destination, redirects + 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`download_http_${response.statusCode}`));
        return;
      }
      const stream = fs.createWriteStream(destination, { mode: 0o600 });
      response.pipe(stream);
      stream.on('finish', () => stream.close(resolve));
      stream.on('error', reject);
    });
    request.setTimeout(30_000, () => request.destroy(new Error('download_timeout')));
    request.on('error', reject);
  });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `${command} failed`).trim());
  }
  return result.stdout.trim();
}

export function verifyInstalled(runtimeDir, lock = loadLock()) {
  const errors = validateLock(lock);
  const manifestPath = path.join(runtimeDir, 'contracts', 'runtime-manifest.json');
  const versionPath = path.join(runtimeDir, 'VERSION');
  const required = ['mcp_server.py', 'local-ai.py', 'post_tool_routing.py', 'model-registry.json'];
  if (!fs.existsSync(manifestPath) || !fs.existsSync(versionPath)) errors.push('runtime_contract_missing');
  for (const filename of required) {
    if (!fs.existsSync(path.join(runtimeDir, filename))) errors.push(`runtime_file_missing:${filename}`);
  }
  if (!errors.includes('runtime_contract_missing')) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const version = fs.readFileSync(versionPath, 'utf8').trim();
    if (manifest.name !== 'local-ai-rtx') errors.push('runtime_name_mismatch');
    if (manifest.runtime_version !== lock.version || version !== lock.version) errors.push('runtime_version_mismatch');
    if (manifest.mcp?.server_name !== 'local-ai-rtx') errors.push('mcp_server_name_mismatch');
  }
  return errors;
}

async function install(lock, prefix, preflight, group) {
  const errors = validateLock(lock);
  if (errors.length) throw new Error(`invalid_lock:${errors.join(',')}`);
  if (!path.isAbsolute(prefix) || path.basename(prefix) !== 'local-ai-rtx') throw new Error('invalid_prefix');
  if (preflight && (!path.isAbsolute(preflight) || !fs.statSync(preflight).isFile())) throw new Error('invalid_preflight');
  if (group && !/^[a-z_][a-z0-9_-]*$/.test(group)) throw new Error('invalid_group');

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'local-ai-rtx-release-'));
  try {
    const archive = path.join(temporary, 'release.tar.gz');
    await download(lock.asset_url, archive);
    const actual = sha256(archive);
    if (actual !== lock.asset_sha256) throw new Error(`asset_checksum_mismatch:${actual}`);
    run('tar', ['-xzf', archive, '-C', temporary, '--no-same-owner', '--no-same-permissions']);
    const source = path.join(temporary, `local-ai-rtx-${lock.version}`);
    const installer = path.join(source, 'install-runtime.sh');
    if (!fs.existsSync(installer)) throw new Error('release_installer_missing');
    const args = ['--prefix', prefix];
    if (preflight) args.push('--preflight', preflight);
    if (group) args.push('--group', group);
    const output = run(installer, args);
    const runtimeDir = path.join(prefix, 'current');
    const installedErrors = verifyInstalled(runtimeDir, lock);
    if (installedErrors.length) throw new Error(`installed_runtime_invalid:${installedErrors.join(',')}`);
    return JSON.parse(output);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function usage() {
  console.error('usage: manage-runtime.mjs validate-lock | verify --runtime-dir PATH | install --prefix PATH [--preflight PATH] [--group GROUP]');
  process.exit(2);
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const lock = loadLock();
  if (command === 'validate-lock' && args.length === 0) {
    const errors = validateLock(lock);
    if (errors.length) throw new Error(errors.join(','));
    console.log(JSON.stringify({ valid: true, version: lock.version, commit: lock.commit, sha256: lock.asset_sha256 }));
    return;
  }
  if (command === 'verify') {
    const runtimeDir = option(args, '--runtime-dir');
    if (!runtimeDir) usage();
    const errors = verifyInstalled(path.resolve(runtimeDir), lock);
    if (errors.length) throw new Error(errors.join(','));
    console.log(JSON.stringify({ valid: true, runtime_dir: path.resolve(runtimeDir), version: lock.version }));
    return;
  }
  if (command === 'install') {
    const prefix = option(args, '--prefix');
    if (!prefix) usage();
    console.log(JSON.stringify(await install(
      lock, path.resolve(prefix), option(args, '--preflight'), option(args, '--group'),
    )));
    return;
  }
  usage();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`manage-runtime: ${error.message}`);
    process.exitCode = 1;
  });
}
