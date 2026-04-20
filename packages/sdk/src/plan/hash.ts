import { createHash } from 'node:crypto';
import { serializeSummaryPlan } from './serialize.js';
import type { SummaryPlan } from './types.js';

export function hashSummaryPlan(plan: SummaryPlan): string {
  return createHash('sha256').update(serializeSummaryPlan(plan)).digest('hex');
}
