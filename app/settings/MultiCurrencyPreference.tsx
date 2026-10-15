'use client';
/**
 * Preferences > Multiple Currencies (A2). One switch, "I use more than one currency":
 *  - off (the default for new companies): currency fields and the Currencies screen are hidden
 *    and foreign-currency saves are refused;
 *  - turning it on asks first (QB: once you have foreign-currency data you can never turn it off);
 *  - once it is on and foreign-currency data exists, the switch is locked on.
 * Saves through PATCH /api/company { settings: { multiCurrencyEnabled } }; the server enforces the
 * lock (lib/services/multiCurrency.ts). Status comes from GET /api/company/multi-currency.
 */
import * as React from 'react';
import { Lock } from 'lucide-react';
import { Card, ConfirmDialog, Label, toast } from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { refreshPreferences } from '@/lib/usePreferences';

interface Status {
  enabled: boolean;
  hasForeignData: boolean;
  locked: boolean;
}

export default function MultiCurrencyPreference({ canEdit }: { canEdit: boolean }) {
  const [status, setStatus] = React.useState<Status | null>(null);
  const [confirmOn, setConfirmOn] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      setStatus(await api.get<Status>('/api/company/multi-currency'));
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not load the Multiple Currencies setting.', 'danger');
    }
  }, []);
  React.useEffect(() => {
    void load();
  }, [load]);

  async function save(next: boolean) {
    setSaving(true);
    try {
      await api.patch('/api/company', { settings: { multiCurrencyEnabled: next } });
      await refreshPreferences();
      await load();
      toast(next ? 'Multiple currencies turned on.' : 'Multiple currencies turned off.', 'success');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to save the preference.', 'danger');
    } finally {
      setSaving(false);
      setConfirmOn(false);
    }
  }

  const disabled = !canEdit || !status || status.locked || saving;

  return (
    <Card className="p-8">
      <h2 className="mb-2 text-lg font-bold text-navy">Multiple Currencies</h2>
      <p className="mb-5 text-sm text-navy/50">
        This setting applies to everyone who uses this company file.
        {!canEdit && ' Only an administrator can change it.'}
      </p>
      <div className="flex items-start gap-3">
        <input
          id="pref-multiCurrencyEnabled"
          type="checkbox"
          checked={Boolean(status?.enabled)}
          disabled={disabled}
          aria-describedby="pref-multiCurrency-help"
          onChange={(e) => (e.target.checked ? setConfirmOn(true) : void save(false))}
          className="mt-1 h-4 w-4 rounded border-slate-300 text-electric focus:ring-electric"
        />
        <div>
          <Label htmlFor="pref-multiCurrencyEnabled" className="mb-0 cursor-pointer">
            I use more than one currency
          </Label>
          <p id="pref-multiCurrency-help" className="mt-0.5 text-xs text-navy/50">
            Turn this on if you bill customers, pay vendors or keep bank accounts in a foreign currency.
            It adds currency and exchange-rate fields to forms and the Currencies list. While it is off,
            those fields are hidden and everything is recorded in your home currency.
          </p>
          {status?.locked && (
            <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-navy/70" role="status">
              <Lock className="h-3.5 w-3.5" aria-hidden />
              This company already has foreign-currency accounts, names or transactions, so multiple
              currencies can no longer be turned off.
            </p>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={confirmOn}
        title="Turn on multiple currencies?"
        confirmLabel="Turn on"
        loading={saving}
        message={
          <div className="space-y-2 text-sm text-navy/80">
            <p>
              Your home currency is added to the Currencies list, and forms get currency and exchange-rate
              fields.
            </p>
            <p className="font-medium">
              Once you record a foreign-currency account, customer, vendor or transaction, you can't turn
              this off again. Make a backup first if you are not sure.
            </p>
          </div>
        }
        onConfirm={() => void save(true)}
        onClose={() => setConfirmOn(false)}
      />
    </Card>
  );
}
