"""Runs inside existing HA image, using its existing SDK and AppFolder credential."""
import asyncio, hashlib, json, os, sys, time
os.nice(19)
from aiohttp import ClientSession, ClientTimeout
from onedrive_personal_sdk import OneDriveClient
from onedrive_personal_sdk.clients.large_file_upload import LargeFileUploadClient
from onedrive_personal_sdk.const import ConflictBehavior
from onedrive_personal_sdk.exceptions import NotFoundError
from onedrive_personal_sdk.models.upload import FileInfo

async def main(row):

    def config():
        entries = json.load(open('/config/.storage/core.config_entries'))['data']['entries']
        entries = [e for e in entries if e['domain'] == 'onedrive' and e.get('disabled_by') is None]
        assert len(entries) == 1
        e = entries[0]
        assert e.get('options', {}).get('delete_permanently', False) is False
        assert set(e['data']['token']['scope'].split()) == {'openid', 'Files.ReadWrite.AppFolder'}
        return e['data']
    folder = config()['folder_id']

    async def token():
        d = config()
        assert d['folder_id'] == folder
        assert d['token']['expires_at'] > time.time() + 10
        return d['token']['access_token']
    name = row['image_id'] + '.docker.tar.gz'
    local = hashlib.sha256()
    count = 0

    async def stream():
        nonlocal count
        while count < row['bytes']:
            chunk = await asyncio.to_thread(sys.stdin.buffer.read, min(65536, row['bytes'] - count))
            assert chunk
            count += len(chunk)
            local.update(chunk)
            yield chunk
        assert local.hexdigest() == row['sha256']
    async with ClientSession(timeout=ClientTimeout(total=2400, connect=15, sock_read=60)) as session:
        client = OneDriveClient(token, session=session)
        drive = await client.get_drive()
        assert drive.quota and drive.quota.remaining > row['bytes']
        try:
            await client.get_drive_item(folder + ':/' + name + ':')
        except NotFoundError:
            pass
        else:
            raise RuntimeError('existing_cloud_file_inspect_without_upload')
        uploaded = await LargeFileUploadClient.upload(token, FileInfo(name, row['bytes'], folder, stream()), session=session, upload_chunk_size=16 * 320 * 1024, smart_chunk_size=False, validate_hash=True, conflict_behavior=ConflictBehavior.FAIL)
        assert uploaded.size == row['bytes'] and count == row['bytes']
        source = await client.download_drive_item(uploaded.id, timeout=ClientTimeout(total=1800, connect=15, sock_read=60))
        remote = hashlib.sha256()
        downloaded = 0
        async for chunk in source.iter_chunked(65536):
            downloaded += len(chunk)
            assert downloaded <= row['bytes']
            remote.update(chunk)
        assert downloaded == row['bytes'] and remote.hexdigest() == row['sha256']
        final = await client.get_drive_item(uploaded.id)
        assert final.id == uploaded.id and final.size == row['bytes']
        print(json.dumps({'state': 'cloud_roundtrip_sha256_verified', 'image_id': row['image_id'], 'bytes': downloaded, 'sha256': remote.hexdigest(), 'cloud_item_id': uploaded.id, 'verified_at': time.time()}), flush=True)
if __name__ == '__main__':
    try:
        asyncio.run(main(json.loads(sys.argv[1])))
    except Exception as e:
        print(json.dumps({'state': 'cloud_operation_unconfirmed', 'error_kind': type(e).__name__, 'automatic_retry': False}), flush=True)
        sys.exit(1)
