// Uninstalled overlay. Existing route composition is preserved byte-for-byte below.
import fs from 'node:fs';
import {makeRepairRoute} from './repair-server.mjs';
import {makeFullRoute} from './task-server.mjs';
import {brokerCall, route as dispatch} from './expanded-server.mjs';
import {makeStorageRoute} from './storage-route.mjs';
import {makeBindingRoute} from './binding-route.mjs';
import {makeAdminRoute} from './nodered-admin-route.mjs';
import {FrameParser,encodeRoutedResponse} from './nodered-admin-parser.mjs';
// Legacy audit remains on its original route. The admin route receives only this redacted sink.
const audit = row => fs.writeSync(2, JSON.stringify(row) + '\n');
const prior = makeStorageRoute(makeRepairRoute(makeFullRoute(brokerCall, audit), brokerCall, dispatch, audit),
  brokerCall, dispatch, audit);
const legacy = makeBindingRoute(prior, brokerCall, dispatch, audit);
const adminAudit = ({tool,id,success}) => fs.writeSync(2,JSON.stringify({tool,id,success})+'\n');
const route=makeAdminRoute(legacy,undefined,adminAudit), parser=new FrameParser();
try {
  for await(const chunk of process.stdin)for(const {request} of parser.push(chunk)) {
    const response=await route(request);
    if(response&&!process.stdout.write(encodeRoutedResponse(request,response)))
      await new Promise(resolve=>process.stdout.once('drain',resolve));
  }
  parser.end();
}catch{process.exitCode=1;}
