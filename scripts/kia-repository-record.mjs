// Read only the fixed Kia record. Native Marketplace supersedes legacy HACS.
// Missing native storage permits legacy fallback; invalid native storage does not.
export const kiaRepositoryRecordCode = `
import json
paths = ['/config/.storage/marketplace.repositories', '/config/.storage/hacs.repositories']
record = None
for source in paths:
    try:
        with open(source) as handle:
            payload = json.load(handle)
    except FileNotFoundError:
        continue
    data = payload.get('data')
    if not isinstance(data, dict):
        raise ValueError('repository_metadata_invalid')
    matches = [v for v in data.values() if isinstance(v, dict) and v.get('full_name') == 'Hyundai-Kia-Connect/kia_uvo']
    if len(matches) > 1:
        raise ValueError('repository_identity_ambiguous')
    if matches:
        keys = ['full_name','installed','installed_commit','last_commit','last_fetched','last_updated','last_version','version_installed']
        record = {k: matches[0].get(k) for k in keys}
        record['repository_source'] = 'marketplace' if source == paths[0] else 'hacs'
    break
else:
    raise ValueError('repository_metadata_unavailable')
print(json.dumps(record))
`;

export function requireLegacyInstallationRecord(record) {
  // Legacy apply backs up/restores the whole HACS registry. It must never do
  // that to the native Marketplace registry shared by other integrations.
  if (record?.repository_source !== 'hacs') {
    throw new Error('marketplace_installation_requires_reviewed_adapter');
  }
}
