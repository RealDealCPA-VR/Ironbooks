'use client';
/**
 * "If you forget your password" — set or change your challenge question (QuickBooks parity).
 * Shown on the Security page; after sign-in, someone without one is sent here once with
 * `prompt` set (a short why, and Not now). Saving needs the current password.
 */
import * as React from 'react';
import { CheckCircle2, KeyRound } from 'lucide-react';
import { Button, Card, Input, Label, Select, toast } from '@/components/ui';
import { api } from '@/lib/client';
import { CHALLENGE_QUESTIONS } from '@/lib/challengeQuestions';

export function ChallengeQuestionCard({ prompt = false, onDone }: { prompt?: boolean; onDone?: () => void }) {
  const [current, setCurrent] = React.useState<string | null | undefined>(undefined);
  const [question, setQuestion] = React.useState<string>(CHALLENGE_QUESTIONS[0]);
  const [answer, setAnswer] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [editing, setEditing] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    api
      .get<{ question: string | null }>('/api/auth/challenge')
      .then((r) => {
        setCurrent(r.question);
        if (r.question) setQuestion(r.question);
        if (!r.question) setEditing(true);
      })
      .catch(() => setCurrent(null));
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post('/api/auth/challenge', { currentPassword: password, question, answer });
      setCurrent(question);
      setEditing(false);
      setAnswer('');
      setPassword('');
      toast('Challenge question saved.', 'success');
      onDone?.();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save the challenge question.', 'danger');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className={`p-6 max-w-xl ${prompt ? 'ring-2 ring-electric/40' : ''}`}>
      <div className="flex items-start gap-3 mb-3">
        <KeyRound className="h-5 w-5 text-electric mt-0.5 flex-none" aria-hidden />
        <div>
          <h2 className="text-lg font-bold text-navy">If you forget your password</h2>
          <p className="text-sm text-navy/60">
            {prompt
              ? 'Your user name and password are stored in this company file, and go wherever the file goes. Choose a challenge question now: it is the only way to reset your password yourself if you forget it.'
              : 'Ironbooks asks this question before it lets anyone reset your password on the sign-in screen.'}
          </p>
        </div>
      </div>
      {current === undefined ? null : !editing && current ? (
        <div className="flex items-center justify-between gap-3">
          <p className="flex items-center gap-2 text-sm text-navy">
            <CheckCircle2 className="h-4 w-4 text-emerald" aria-hidden /> {current}
          </p>
          <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
            Change
          </Button>
        </div>
      ) : (
        <form onSubmit={save} className="space-y-3">
          <div>
            <Label htmlFor="cq-question">Challenge question</Label>
            <Select id="cq-question" value={question} onChange={(e) => setQuestion(e.target.value)}>
              {CHALLENGE_QUESTIONS.map((q) => (
                <option key={q} value={q}>
                  {q}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="cq-answer">Answer</Label>
            <Input id="cq-answer" value={answer} onChange={(e) => setAnswer(e.target.value)} autoComplete="off" autoFocus={prompt} />
            <p className="mt-1 text-xs text-navy/50">Not case-sensitive. Write it down somewhere safe.</p>
          </div>
          <div>
            <Label htmlFor="cq-password">Your current password</Label>
            <Input id="cq-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </div>
          <div className="flex gap-2">
            <Button type="submit" loading={busy} disabled={!answer.trim() || !password}>
              Save
            </Button>
            {prompt && onDone && (
              <Button type="button" variant="secondary" onClick={onDone}>
                Not now
              </Button>
            )}
            {!prompt && current && (
              <Button type="button" variant="secondary" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      )}
    </Card>
  );
}

export default ChallengeQuestionCard;
