import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
test('Git publication metadata: isolated producer and MCP projection contracts',()=>{
 const result=spawnSync('python3',['-m','unittest','scripts/test_git_publication_evidence.py','scripts/raspberry-mcp/runtime-source/repair-control/test_git_publication_evidence.py'],{encoding:'utf8'});
 assert.equal(result.status,0,result.stdout+result.stderr);
});
