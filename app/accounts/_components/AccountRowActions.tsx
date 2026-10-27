'use client';
/**
 * The Actions cell of a Chart of Accounts row: Edit, and Make Inactive for an active account or
 * Make Active for an inactive one (QB "Make Account Inactive" / "Make Account Active"). Without
 * the second an account made inactive could never come back from this window.
 */
import { Pencil, RotateCcw, Trash2 } from 'lucide-react';

export interface AccountRowActionsProps {
  /** Account name, for the buttons' accessible names. */
  name: string;
  isActive: boolean;
  onEdit: () => void;
  onDeactivate: () => void;
  onReactivate: () => void;
  /** True while a change of this account is being saved. */
  busy?: boolean;
}

export default function AccountRowActions({ name, isActive, onEdit, onDeactivate, onReactivate, busy }: AccountRowActionsProps) {
  return (
    <>
      <button
        type="button"
        className="p-1.5 rounded-lg text-navy/40 hover:text-electric hover:bg-electric/10 transition-colors"
        title="Edit account"
        aria-label={`Edit ${name}`}
        onClick={onEdit}
      >
        <Pencil className="h-4 w-4" aria-hidden="true" />
      </button>
      {isActive ? (
        <button
          type="button"
          className="p-1.5 rounded-lg text-red-400 hover:text-red-600 hover:bg-red-50 transition-colors"
          title="Make account inactive"
          aria-label={`Make ${name} inactive`}
          onClick={onDeactivate}
          disabled={busy}
        >
          <Trash2 className="h-4 w-4" aria-hidden="true" />
        </button>
      ) : (
        <button
          type="button"
          className="p-1.5 rounded-lg text-navy/40 hover:text-emerald hover:bg-emerald/10 transition-colors"
          title="Make account active"
          aria-label={`Make ${name} active`}
          onClick={onReactivate}
          disabled={busy}
        >
          <RotateCcw className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
    </>
  );
}
