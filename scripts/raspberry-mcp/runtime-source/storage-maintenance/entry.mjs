// Proposed frontend entrypoint, activated only with the exact deployment approval.
import fs from 'node:fs';
import {makeRepairRoute} from './repair-server.mjs';
import {makeFullRoute} from './task-server.mjs';
import {brokerCall, route as dispatch} from './expanded-server.mjs';
import {makeStorageRoute} from './storage-route.mjs';
const audit = row => fs.writeSync(2, JSON.stringify(row)+'\n');
const route = makeStorageRoute(makeRepairRoute(makeFullRoute(brokerCall, audit), brokerCall, dispatch, audit),
  brokerCall, dispatch, audit);
let pending = Buffer.alloc(0), count = 0, start = Date.now();
for await (const chunk of process.stdin) for (const byte of chunk) {
  if (pending.length >= 16384) process.exit(1);
  pending = Buffer.concat([pending, Buffer.from([byte])]);
  if (byte !== 10) continue;
  if (Date.now()-start >= 60000) {start = Date.now(); count = 0;}
  if (++count > 60) process.exit(1);
  let q; try {q = JSON.parse(pending.toString());} catch {q = null;}
  pending = Buffer.alloc(0);
  const r = await route(q);
  if (r && !process.stdout.write(JSON.stringify(r)+'\n'))
    await new Promise(resolve => process.stdout.once('drain', resolve));
}
