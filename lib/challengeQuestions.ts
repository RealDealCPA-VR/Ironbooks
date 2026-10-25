/**
 * Challenge questions for resetting a forgotten password (QuickBooks Desktop asks the Admin to
 * pick one when the password is set). The answer is stored hashed in the company file; it is
 * compared case- and spacing-insensitively (normalizeChallengeAnswer).
 */
export const CHALLENGE_QUESTIONS = [
  'Name of your first manager',
  "Your mother's maiden name",
  'City where you went to high school',
  'Name of your first pet',
  'Make and model of your first car',
  "Your favorite teacher's last name",
  'Street you grew up on',
  "Your best friend's first name in school",
] as const;

/** Shortest answer accepted (a one-letter answer is a guess away). */
export const MIN_CHALLENGE_ANSWER = 3;

/** "  New   York " and "new york" are the same answer. */
export function normalizeChallengeAnswer(answer: string): string {
  return answer.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function isKnownChallengeQuestion(q: unknown): q is string {
  return typeof q === 'string' && (CHALLENGE_QUESTIONS as readonly string[]).includes(q);
}
