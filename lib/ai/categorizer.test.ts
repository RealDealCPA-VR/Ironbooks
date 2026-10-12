import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  amountBucket,
  emptyState,
  featurize,
  learn,
  loadState,
  payeeKey,
  predict,
  summary,
  tokenize,
  type TrainingExample,
} from './categorizer';
import { decryptSecret, encryptSecret } from './keyVault';

const ex = (payee: string, account: string, amount = '50.00', extra: Partial<TrainingExample> = {}): TrainingExample => ({
  payee,
  amount,
  direction: 'out',
  labels: { account },
  ...extra,
});

describe('featurization', () => {
  it('drops bank noise, numbers and store ids', () => {
    expect(tokenize('POS PURCHASE STARBUCKS #1234 SEATTLE WA')).toEqual(['starbucks', 'seattle', 'wa']);
    expect(tokenize('AMZN Mktp US*2K4L')).toEqual(['amzn', 'mktp', '2k4l']);
    expect(payeeKey('CHECKCARD 0412 SHELL OIL 57444')).toBe('shell oil');
    expect(payeeKey('12345')).toBeNull();
  });

  it('buckets amounts on a log scale and includes direction', () => {
    expect(amountBucket('0.50')).toBe(0);
    expect(amountBucket('1.00')).toBe(1);
    expect(amountBucket('100')).toBe(7);
    expect(amountBucket('-100')).toBe(7);
    const f = featurize({ payee: 'Shell', amount: '-42.10', direction: 'out' });
    expect(f).toContain('p1:shell');
    expect(f).toContain('d:out');
    expect(f).toContain('x:42.10');
  });
});

describe('naive Bayes categorizer', () => {
  function trained() {
    const s = emptyState();
    for (let i = 0; i < 8; i++) learn(s, ex('Shell Oil', 'fuel', `${40 + i}.00`));
    for (let i = 0; i < 6; i++) learn(s, ex('Starbucks', 'meals', `${5 + i}.25`));
    for (let i = 0; i < 4; i++) learn(s, ex('Landlord LLC', 'rent', '2500.00'));
    learn(s, ex('Office Depot', 'supplies', '80.00'));
    return s;
  }

  it('predicts the account a payee was historically categorized to', () => {
    const s = trained();
    const p = predict(s, { payee: 'SHELL OIL 57444 HOUSTON', amount: '45.00', direction: 'out' });
    expect(p.account?.label).toBe('fuel');
    expect(p.account!.confidence).toBeGreaterThan(0.8);
    expect(predict(s, { payee: 'STARBUCKS #77', amount: '6.00', direction: 'out' }).account?.label).toBe('meals');
  });

  it('confidence is calibrated by evidence: one observation never looks certain', () => {
    const s = trained();
    const once = predict(s, { payee: 'Office Depot', amount: '80.00', direction: 'out' }).account!;
    expect(once.label).toBe('supplies');
    expect(once.confidence).toBeLessThanOrEqual(0.5);
    const many = predict(s, { payee: 'Shell Oil', amount: '44.00', direction: 'out' }).account!;
    expect(many.confidence).toBeGreaterThan(once.confidence);
  });

  it('unknown payees get low confidence', () => {
    const s = trained();
    const p = predict(s, { payee: 'Zyxwv Unknown Vendor', amount: '13.00', direction: 'out' }).account!;
    expect(p.confidence).toBeLessThan(0.3);
  });

  it('respects the allowed label set (inactive accounts are never suggested)', () => {
    const s = trained();
    const p = predict(s, { payee: 'Shell Oil', amount: '45.00', direction: 'out' }, { allowed: { account: new Set(['meals', 'rent']) } });
    expect(p.account?.label).not.toBe('fuel');
  });

  it('learns incrementally — a correction shifts future predictions', () => {
    const s = emptyState();
    learn(s, ex('Costco', 'supplies'));
    learn(s, ex('Costco', 'supplies'));
    expect(predict(s, { payee: 'Costco', amount: '50', direction: 'out' }).account?.label).toBe('supplies');
    for (let i = 0; i < 5; i++) learn(s, ex('Costco', 'inventory'), { track: true });
    expect(predict(s, { payee: 'Costco', amount: '50', direction: 'out' }).account?.label).toBe('inventory');
    expect(s.stats.predictions).toBe(5);
  });

  it('online calibration pulls an over-confident bin toward observed accuracy', () => {
    const s = trained();
    const before = predict(s, { payee: 'Shell Oil', amount: '44.00', direction: 'out' }).account!.confidence;
    // The user keeps re-categorizing Shell to "vehicle" — the model was wrong every time.
    for (let i = 0; i < 3; i++) learn(s, ex('Shell Oil', 'vehicle', '44.00'), { track: true });
    const binIdx = s.calibration.findIndex((b) => b.n > 0);
    expect(binIdx).toBeGreaterThanOrEqual(0);
    expect(s.calibration[binIdx].correct).toBeLessThan(s.calibration[binIdx].n);
    expect(predict(s, { payee: 'Shell Oil', amount: '44.00', direction: 'out' }).account!.confidence).toBeLessThan(before);
  });

  it('class and customer:job heads learn "blank" as well as values', () => {
    const s = emptyState();
    for (let i = 0; i < 5; i++) learn(s, { ...ex('Home Depot', 'materials'), labels: { account: 'materials', class: 'construction', customerJob: 'cust1|job1' } });
    for (let i = 0; i < 5; i++) learn(s, { ...ex('Verizon', 'phone'), labels: { account: 'phone', class: '', customerJob: '' } });
    const hd = predict(s, { payee: 'Home Depot', amount: '50', direction: 'out' });
    expect(hd.class?.label).toBe('construction');
    expect(hd.customerJob?.label).toBe('cust1|job1');
    expect(predict(s, { payee: 'Verizon', amount: '50', direction: 'out' }).class?.label).toBe('');
  });

  it('round-trips through JSON (persistence) and rejects unknown versions', () => {
    const s = trained();
    const restored = loadState(JSON.parse(JSON.stringify(s)));
    expect(predict(restored, { payee: 'Starbucks', amount: '6', direction: 'out' }).account?.label).toBe('meals');
    expect(loadState({ version: 99 }).docs).toBe(0);
    expect(loadState(null).docs).toBe(0);
    expect(summary(s).accounts).toBe(4);
  });

  it('empty model predicts nothing', () => {
    expect(predict(emptyState(), { payee: 'x', amount: '1', direction: 'out' }).account).toBeNull();
  });
});

describe('keyVault (AES-GCM)', () => {
  const secret = crypto.randomBytes(32).toString('hex');
  const company = '11111111-1111-1111-1111-111111111111';

  it('round-trips and never stores plaintext', () => {
    const blob = encryptSecret('sk-ant-SECRET', company, secret);
    expect(blob.startsWith('v1:')).toBe(true);
    expect(blob).not.toContain('SECRET');
    expect(decryptSecret(blob, company, secret)).toBe('sk-ant-SECRET');
    // Random IV — same plaintext, different ciphertext.
    expect(encryptSecret('sk-ant-SECRET', company, secret)).not.toBe(blob);
  });

  it('is bound to the company and the data-dir secret; tampering fails closed', () => {
    const blob = encryptSecret('k', company, secret);
    expect(decryptSecret(blob, '22222222-2222-2222-2222-222222222222', secret)).toBeNull();
    expect(decryptSecret(blob, company, 'other-secret')).toBeNull();
    const raw = Buffer.from(blob.slice(3), 'base64');
    raw[raw.length - 1] ^= 1;
    expect(decryptSecret('v1:' + raw.toString('base64'), company, secret)).toBeNull();
    expect(decryptSecret('garbage', company, secret)).toBeNull();
    expect(decryptSecret(null, company, secret)).toBeNull();
  });
});
