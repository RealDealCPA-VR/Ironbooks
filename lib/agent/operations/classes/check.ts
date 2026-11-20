/**
 * Agent full access: checks one bucket of the classification against the route map.
 * Used by each bucket's own test (classes/<bucket>.test.ts) and by test/agentRegistry.test.ts.
 */
import { API_ROUTE_PERMISSIONS, HTTP_METHODS } from '@/lib/permissions/routes';
import { CLASS_BUCKETS, routeSegment, type ClassBucket } from './buckets';
import { NEVER_ALLOW_CLASSES, isRiskClass, operationKey, type ClassificationMap } from '../types';

/** Every route + method of the route map that belongs to this bucket, as classification keys. */
export function bucketKeys(bucket: ClassBucket): string[] {
  const segments = CLASS_BUCKETS[bucket] as readonly string[];
  const keys: string[] = [];
  for (const [pattern, rules] of Object.entries(API_ROUTE_PERMISSIONS)) {
    if (!segments.includes(routeSegment(pattern))) continue;
    for (const m of HTTP_METHODS) if (rules[m]) keys.push(operationKey(m, pattern));
  }
  return keys.sort();
}

/** What is wrong with a bucket's map; an empty list means it is complete and well formed. */
export function bucketProblems(bucket: ClassBucket, map: ClassificationMap): string[] {
  const problems: string[] = [];
  const expected = new Set(bucketKeys(bucket));
  for (const key of expected) if (!map[key]) problems.push(`missing: ${key}`);
  for (const [key, c] of Object.entries(map)) {
    if (!expected.has(key)) problems.push(`not a route of this bucket (or not in the route map): ${key}`);
    if (!isRiskClass(c.class)) problems.push(`unknown class "${String(c.class)}": ${key}`);
    if (!c.describe || c.describe.trim().length < 8) problems.push(`describe is missing or too short: ${key}`);
    if (/\.\s*$/.test(c.describe ?? '')) problems.push(`describe ends with a period: ${key}`);
    if (c.availability && c.availability !== 'agent' && !c.why) problems.push(`not available to agents but no "why": ${key}`);
    const method = key.split(' ')[0];
    if (method === 'GET' && c.class !== 'read' && !c.why) problems.push(`a GET that is not class "read" needs a "why": ${key}`);
    if (method !== 'GET' && c.class === 'read' && !c.why) problems.push(`a ${method} classed "read" needs a "why": ${key}`);
    if (c.class === 'read' && c.dryRun && c.dryRun !== 'none') problems.push(`a read has no dry run: ${key}`);
    if (c.producesSecret?.length && c.class !== 'secret') problems.push(`produces a secret but is not class "secret": ${key}`);
    if (c.alwaysAsk && (NEVER_ALLOW_CLASSES as readonly string[]).includes(c.class)) {
      problems.push(`alwaysAsk is redundant (class ${c.class} can never be Allow): ${key}`);
    }
    if (c.class === 'bulk' && !c.countField && !c.why) {
      problems.push(`bulk without countField needs a "why" saying how many records it changes: ${key}`);
    }
  }
  return problems.sort();
}
