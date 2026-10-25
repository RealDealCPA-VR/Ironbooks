/**
 * Multi-user mode on the office network (a teammate let into a company file on the shared drive):
 * the host's own certificate (electron/selfSignedCert.js) is valid X.509 that Node's TLS serves and
 * that a client can pin by fingerprint; the host lists its private LAN addresses and nothing public
 * (electron/hostingCore.js).
 */
import { afterAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cert = require('../electron/selfSignedCert.js');
const core = require('../electron/hostingCore.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-cert-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("the host's own certificate", () => {
  it('is a valid self-signed certificate for the names and addresses given', () => {
    const made = cert.generateCertificate({ names: ['FRONT-DESK'], ips: ['192.168.1.10'] });
    const x = new crypto.X509Certificate(made.cert);
    expect(x.verify(x.publicKey)).toBe(true);
    expect(x.subjectAltName).toContain('DNS:FRONT-DESK');
    expect(x.subjectAltName).toContain('IP Address:192.168.1.10');
    expect(Date.parse(x.validTo) - Date.now()).toBeGreaterThan(700 * 24 * 3600 * 1000);
    expect(cert.fingerprintOf(made.cert)).toBe(x.fingerprint256.replace(/:/g, '').toLowerCase());
  });

  it('is made once and kept', () => {
    const a = cert.loadOrCreate(dir, { names: ['x'] });
    const b = cert.loadOrCreate(dir, { names: ['x'] });
    expect(b.fingerprint).toBe(a.fingerprint);
  });

  it('serves HTTPS that a client recognises by its pinned fingerprint', async () => {
    const { cert: pem, key, fingerprint } = cert.loadOrCreate(dir);
    const server = https.createServer({ cert: pem, key }, (_q, r) => r.end('ok'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    const seen = await new Promise<string>((resolve, reject) => {
      https
        .get({ host: '127.0.0.1', port, rejectUnauthorized: false }, (res) => {
          const fp = res.socket && (res.socket as import('node:tls').TLSSocket).getPeerCertificate().fingerprint256;
          res.resume();
          resolve(String(fp).replace(/:/g, '').toLowerCase());
        })
        .on('error', reject);
    });
    server.close();
    expect(seen).toBe(fingerprint);
  });
});

describe('office-network addresses', () => {
  const ifaces = {
    Ethernet: [
      { family: 'IPv4', address: '192.168.1.10', internal: false },
      { family: 'IPv6', address: 'fe80::1', internal: false },
    ],
    Loopback: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    Public: [{ family: 'IPv4', address: '8.8.4.4', internal: false }],
    Tailscale: [{ family: 'IPv4', address: '100.101.102.103', internal: false }],
    Wifi: [{ family: 4, address: '10.0.0.7', internal: false }],
  };

  it('lists private LAN addresses only', () => {
    expect(core.lanIPv4s(ifaces)).toEqual(['192.168.1.10', '10.0.0.7']);
  });

  it('offers HTTPS on every LAN address, then the tailnet one', () => {
    expect(core.lanShareUrls({ lanIps: ['192.168.1.10'], tailnetIp: '100.101.102.103', port: 47800 })).toEqual([
      'https://192.168.1.10:47800',
      'https://100.101.102.103:47800',
    ]);
    // Each one is an address a teammate's Ironbooks will connect to.
    for (const u of core.lanShareUrls({ lanIps: ['192.168.1.10'], tailnetIp: null, port: 47800 })) {
      expect(core.normalizeHostAddress(u).ok).toBe(true);
    }
  });
});
