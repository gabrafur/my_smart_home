import path from 'node:path';

export function assertCustomIntegrationCompatibility(desiredImages, {repoRoot, run, dryRun=false}) {
  const target=desiredImages.find(row=>row.service==='homeassistant');
  if (!target) return {state:'not_required'};
  if (!/^ghcr\.io\/home-assistant\/home-assistant@sha256:[a-f0-9]{64}$/.test(target.image))
    throw new Error('Home Assistant compatibility image identity unconfirmed');
  if (dryRun) return {state:'not_checked',reason:'dry_run_no_container_started'};
  const args=['run','--rm','--pull=never','--network','none','--read-only',
    '--cap-drop','ALL','--security-opt','no-new-privileges','--user','1001:1001',
    '--cpus','0.15','--memory','512m','--memory-swap','512m','--pids-limit','16',
    '--ulimit','nofile=128:128','--tmpfs','/tmp:rw,noexec,nosuid,size=32m,mode=1777',
    '-e','PYTHONDONTWRITEBYTECODE=1','-e','HOME=/tmp',
    '--mount','type=bind,src='+path.join(repoRoot,'homeassistant/custom_components/icloud/device_owner.py')+',dst=/review/device_owner.py,readonly',
    '--mount','type=bind,src='+path.join(repoRoot,'scripts/icloud-image-preflight.py')+',dst=/review/preflight.py,readonly',
    '--entrypoint','python3',target.image,'-I','-B','/review/preflight.py'];
  let result;
  try {result=JSON.parse(run('docker',args,{capture:true,timeout:110000}));}
  catch {throw new Error('Home Assistant custom integration compatibility unconfirmed; production update blocked');}
  if (result?.state!=='compatible' || result.network_enabled!==false ||
      result.production_configuration_mounted!==false || result.apple_authentication_called!==false)
    throw new Error('Home Assistant custom integration compatibility refused; production update blocked');
  return result;
}
