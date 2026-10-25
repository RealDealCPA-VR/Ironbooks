// A self-signed TLS certificate for multi-user access on the office network.
//
// When someone lets a teammate into a company file (electron/companyLock.js), this computer
// hosts it over HTTPS on the office network. No certificate authority is involved: the host
// makes its own key and certificate once, and the teammate's Ironbooks learns the certificate's
// SHA-256 fingerprint through the company file's lock folder on the shared drive — so it
// connects only to this exact certificate (pinning), and nobody else on the network can sit in
// the middle. Plain Node crypto: an ECDSA P-256 key, and the certificate encoded by hand (DER).
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// --- minimal DER ---
function len(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, content) => Buffer.concat([Buffer.from([tag]), len(content.length), content]);
const seq = (...items) => tlv(0x30, Buffer.concat(items));
const set = (...items) => tlv(0x31, Buffer.concat(items));
function int(buf) {
  let b = Buffer.from(buf);
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}
function oid(str) {
  const parts = str.split('.').map(Number);
  const out = [40 * parts[0] + parts[1]];
  for (const p of parts.slice(2)) {
    const stack = [p & 0x7f];
    let v = p >>> 7;
    while (v > 0) {
      stack.unshift((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    out.push(...stack);
  }
  return tlv(0x06, Buffer.from(out));
}
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const bitString = (buf, unused = 0) => tlv(0x03, Buffer.concat([Buffer.from([unused]), buf]));
const octets = (buf) => tlv(0x04, buf);
function time(d) {
  const pad = (n) => String(n).padStart(2, '0');
  const body = `${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  const y = d.getUTCFullYear();
  return y < 2050 ? tlv(0x17, Buffer.from(`${String(y).slice(2)}${body}`)) : tlv(0x18, Buffer.from(`${y}${body}`));
}

const OID = {
  ecdsaSha256: '1.2.840.10045.4.3.2',
  commonName: '2.5.4.3',
  subjectAltName: '2.5.29.17',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  serverAuth: '1.3.6.1.5.5.7.3.1',
};

function ipv4Bytes(ip) {
  const p = String(ip).split('.').map(Number);
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? Buffer.from(p) : null;
}

/**
 * Make a key and self-signed certificate: { cert, key } as PEM strings, valid ~2 years for
 * `names` (DNS names) and `ips` (IPv4 addresses).
 */
function generateCertificate({ commonName, names = [], ips = [], days = 825, now = new Date() } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const cn = commonName || `Ironbooks host ${os.hostname()}`;
  const name = seq(set(seq(oid(OID.commonName), utf8(cn))));
  const alg = seq(oid(OID.ecdsaSha256));
  const notBefore = new Date(now.getTime() - 24 * 3600 * 1000);
  const notAfter = new Date(now.getTime() + days * 24 * 3600 * 1000);
  const san = [
    ...names.filter(Boolean).map((n) => tlv(0x82, Buffer.from(String(n), 'ascii'))),
    ...ips.map(ipv4Bytes).filter(Boolean).map((b) => tlv(0x87, b)),
  ];
  const extensions = [
    seq(oid(OID.basicConstraints), tlv(0x01, Buffer.from([0xff])), octets(seq())),
    seq(oid(OID.keyUsage), tlv(0x01, Buffer.from([0xff])), octets(bitString(Buffer.from([0x80]), 7))),
    seq(oid(OID.extKeyUsage), octets(seq(oid(OID.serverAuth)))),
    ...(san.length ? [seq(oid(OID.subjectAltName), octets(seq(...san)))] : []),
  ];
  const tbs = seq(
    tlv(0xa0, int(Buffer.from([2]))), // v3
    int(crypto.randomBytes(16)),
    alg,
    name,
    seq(time(notBefore), time(notAfter)),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    tlv(0xa3, seq(...extensions)),
  );
  const signature = crypto.sign('sha256', tbs, privateKey); // DER ECDSA signature
  const der = seq(tbs, alg, bitString(signature));
  const pem = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')}\n-----END CERTIFICATE-----\n`;
  return { cert: pem, key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

/** SHA-256 of a certificate's DER bytes, lowercase hex — the pin teammates check. */
function fingerprintOf(pem) {
  const b64 = String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  return crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex');
}

/**
 * This computer's office-network certificate (made once, kept in `dir`). Renewed when it is
 * within 30 days of expiring or unreadable. Returns { cert, key, fingerprint }.
 */
function loadOrCreate(dir, opts = {}) {
  const certFile = path.join(dir, 'lan-host.crt');
  const keyFile = path.join(dir, 'lan-host.key');
  try {
    const cert = fs.readFileSync(certFile, 'utf8');
    const key = fs.readFileSync(keyFile, 'utf8');
    const x = new crypto.X509Certificate(cert);
    if (Date.parse(x.validTo) - Date.now() > 30 * 24 * 3600 * 1000) return { cert, key, fingerprint: fingerprintOf(cert) };
  } catch {
    /* missing or unreadable: make a new one */
  }
  const made = generateCertificate(opts);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(keyFile, made.key, { mode: 0o600 });
  fs.writeFileSync(certFile, made.cert);
  return { ...made, fingerprint: fingerprintOf(made.cert) };
}

module.exports = { generateCertificate, fingerprintOf, loadOrCreate };
