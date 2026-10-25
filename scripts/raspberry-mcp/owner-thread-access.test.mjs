import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
for (const [name, command, args] of [
  ['reference metadata and scope report', 'python3', ['-B', '-m', 'unittest', 'discover', '-s', fileURLToPath(new URL('./runtime-source/task-control/', import.meta.url)), '-p', 'test_*.py']],
  ['legacy RPC and descriptor scope', process.execPath, [fileURLToPath(new URL('./owner-thread-access-check.cjs', import.meta.url))]],
]) {
  test(name, () => {
    const result=spawnSync(command,args,{encoding:'utf8',timeout:30000,maxBuffer:65536,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
    assert.equal(result.status,0,result.stderr || result.stdout);
    assert.equal(result.error,undefined);
  });
}
