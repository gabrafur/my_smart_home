import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = path.join(root, 'restore/process-boundary.c');
const probe = path.join(root, 'restore/fixtures/process-boundary-probe.py');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('recovery boundary enforces native memory and process creation limits', () => {
  assert.equal(process.platform, 'linux', 'native Linux kernel evidence is required');
  assert.notEqual(process.getuid(), 0, 'run native tests without root capabilities');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-boundary-test-'));
  try {
    let binary = path.join(temporary, 'boundary');
    const provided = process.env.RECOVERY_BOUNDARY_TEST_BINARY;
    if (provided) {
      assert.equal(process.env.RECOVERY_BOUNDARY_TEST_SOURCE_SHA256, hash(source));
      assert.equal(process.env.RECOVERY_BOUNDARY_TEST_BINARY_SHA256, hash(provided));
      assert.ok(fs.statSync(provided).isFile());
      binary = provided;
    } else {
      const compiled = spawnSync('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-static',
        source, '-o', binary], {encoding: 'utf8', timeout: 15000});
      assert.equal(compiled.status, 0,
        'a C compiler or an explicitly source-bound native test binary is required: ' + (compiled.stderr ?? compiled.error?.code ?? ''));
    }
    const python = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], {encoding: 'utf8', timeout: 5000});
    assert.equal(python.status, 0);
    const executable = python.stdout.trim();
    assert.ok(path.isAbsolute(executable));
    const env = {...process.env, MALLOC_ARENA_MAX: '1', PYTHONMALLOC: 'pymalloc'};
    const native = spawnSync(binary, ['probe-64m', executable, '-I', '-S', '-B', probe],
      {encoding: 'utf8', timeout: 15000, env});
    assert.equal(native.status, 0, native.stderr);
    const proof = JSON.parse(native.stdout);
    for (const key of ['shared_thread_mapping_enforced', 'valid_threads_started', 'fork_denied',
      'nonthread_clone_denied', 'clone3_denied_with_fallback', 'child_creation_denied_in_thread',
      'hard_ceiling_cannot_be_raised', 'oversized_mapping_refused', 'io_uring_denied']) {
      assert.equal(proof[key], true, key);
    }
    assert.equal(proof.hard_AS_bytes, 67108864);
    assert.equal(proof.restored_services_started, 0);
    assert.equal(proof.backup_key_reads, 0);
    for (const args of [[], ['invalid', executable, '-c', 'print("should_not_execute")'],
      ['probe-64m', 'python3', '-c', 'print("should_not_execute")'],
      ...['vm-1024m', 'vm-1280m', 'vm-1536m'].map(mode =>
        [mode, executable, '-c', 'print("should_not_execute")'])]) {
      const refused = spawnSync(binary, args, {encoding: 'utf8', timeout: 5000, env});
      assert.equal(refused.status, 125, 'invalid scope or non-PID1 VM must fail closed');
      assert.equal(refused.stdout, '');
    }
    if (process.arch === 'x64') {
      const x32 = spawnSync(binary, ['probe-64m', executable, '-I', '-S', '-B', '-c',
        'import ctypes; ctypes.CDLL(None).syscall(0x40000000)'], {encoding: 'utf8', timeout: 5000, env});
      assert.equal(x32.signal, 'SIGSYS', 'x32 syscall numbers cannot bypass the ABI filter');
    }
  } finally {
    fs.rmSync(temporary, {recursive: true, force: true});
  }
});
