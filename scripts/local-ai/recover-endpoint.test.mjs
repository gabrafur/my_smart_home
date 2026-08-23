import assert from 'node:assert/strict';
import test from 'node:test';

import {
  magicPacket,
  recoverEndpoint,
  recoverySettings,
  repairPowerShell,
  sshCommand,
} from './recover-endpoint.mjs';

function config() {
  return {
    endpoint: 'http://192.168.1.50:11435',
    recovery: {
      enabled: true,
      boot_wait_seconds: 1,
      endpoint_wait_seconds: 2,
      wake_on_lan: { mac: '00:11:22:33:44:55', broadcast: '192.168.1.255', port: 9 },
    },
    gpu_probe: {
      container: 'homeassistant',
      ssh_user: 'gpu-user',
      ssh_host: '192.168.1.50',
      ssh_key_path: '/config/.ssh/gpu_ed25519',
      ssh_port: 22,
    },
  };
}

test('builds a valid magic packet without retaining alternate data', () => {
  const packet = magicPacket('00-11-22-33-44-55');
  assert.equal(packet.length, 102);
  assert.deepEqual([...packet.subarray(0, 6)], [255, 255, 255, 255, 255, 255]);
  assert.equal(packet.subarray(6).toString('hex'), '001122334455'.repeat(16));
  assert.throws(() => magicPacket('invalid'), /invalid_wol_mac/);
});

test('requires an explicitly enabled private endpoint that matches the SSH host', () => {
  assert.ok(recoverySettings(config()));
  const publicEndpoint = config();
  publicEndpoint.endpoint = 'http://203.0.113.10:11435';
  publicEndpoint.gpu_probe.ssh_host = '203.0.113.10';
  assert.equal(recoverySettings(publicEndpoint), null);
  const mismatched = config();
  mismatched.gpu_probe.ssh_host = '192.168.1.51';
  assert.equal(recoverySettings(mismatched), null);
  const publicBroadcast = config();
  publicBroadcast.recovery.wake_on_lan.broadcast = '203.0.113.255';
  assert.equal(recoverySettings(publicBroadcast), null);
});

test('uses strict SSH and a bounded, exact-address portproxy repair', () => {
  const settings = recoverySettings(config());
  const [command, args] = sshCommand(settings);
  assert.equal(command, 'docker');
  assert.ok(args.includes('StrictHostKeyChecking=yes'));
  const encoded = args.at(-1).split(' ').at(-1);
  const script = Buffer.from(encoded, 'base64').toString('utf16le');
  assert.match(script, /wsl\.exe -u root -e systemctl start ollama/);
  assert.match(script, /listenaddress=\$target/);
  assert.match(script, /LocalAddress -eq \$target/);
  assert.match(script, /connectaddress=127\.0\.0\.1/);
  assert.match(script, /Restart-Service iphlpsvc/);
  assert.doesNotMatch(script, /listenaddress=0\.0\.0\.0/);
  assert.equal(repairPowerShell(settings), encoded);
});

test('tries recovery twice and accepts endpoint health over a dropped SSH session', async () => {
  let wakes = 0;
  let sshRuns = 0;
  const result = await recoverEndpoint(config(), {
    sendWakePacket: async () => { wakes += 1; return true; },
    wait: async () => {},
    runSsh: () => { sshRuns += 1; return { status: 255 }; },
    cleanupSsh: () => ({ status: 0 }),
    waitForEndpoint: async () => sshRuns >= 2,
  });
  assert.equal(result.recovery_succeeded, true);
  assert.equal(result.recovery_attempts, 2);
  assert.equal(wakes, 2);
  assert.equal(sshRuns, 2);
});
