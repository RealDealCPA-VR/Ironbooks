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

/**
 * In a company file protected with passwords, an answer also OPENS the encrypted file (its own key
 * slot) — and a copy of the file can be attacked offline, without any sign-in limit. So that slot
 * is only made for an answer of at least this many characters (after the case and spacing are
 * evened out) with some variety in it: a short phrase rather than one word ("pip the grey cat").
 * A shorter answer still resets the password while the file is open; it just never opens the file.
 */
export const MIN_CHALLENGE_SLOT_ANSWER = 10;

/** True when the answer is strong enough to open a protected company file by itself. */
export function challengeAnswerOpensFile(answer: string): boolean {
  const a = normalizeChallengeAnswer(String(answer ?? ''));
  return a.length >= MIN_CHALLENGE_SLOT_ANSWER && new Set(a.replace(/ /g, '')).size >= 5;
}

/** What the challenge-question screens say about this in a protected company file. */
export const CHALLENGE_SLOT_RULE_TEXT = `In a company file protected with passwords, an answer of at least ${MIN_CHALLENGE_SLOT_ANSWER} characters (a short phrase works well, like "pip the grey cat") also opens the file when you forget your password. A shorter answer still resets your password while the file is open on this or another computer, but it can't open the file by itself.`;

export function isKnownChallengeQuestion(q: unknown): q is string {
  return typeof q === 'string' && (CHALLENGE_QUESTIONS as readonly string[]).includes(q);
}
