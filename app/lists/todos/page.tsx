/**
 * Old Lists > To Do address. Since the To Do lists were merged (migration 0039) there is one
 * To Do list at /todos; this path just sends people there.
 */
import { redirect } from 'next/navigation';

export default function OldTodosPage() {
  redirect('/todos');
}
