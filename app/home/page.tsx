/**
 * /home — QuickBooks calls the start screen the Home page; ours lives at /dashboard: the
 * "Needs attention" inbox tab (where Simple mode lands) and the Overview tab (workflow diagram,
 * reminders, and the company snapshot for people who may see it).
 */
import { redirect } from 'next/navigation';

export default function HomePage() {
  redirect('/dashboard');
}
