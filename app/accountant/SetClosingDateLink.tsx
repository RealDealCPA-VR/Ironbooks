'use client';
/** Accountant Center: "Set Closing Date" opens the same dialog as the desktop menus. */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { SetClosingDateDialog } from '@/components/SetClosingDateDialog';

export function SetClosingDateLink() {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  return (
    <>
      <button type="button" className="text-sm text-electric hover:underline" onClick={() => setOpen(true)}>
        Set Closing Date…
      </button>
      {open && (
        <SetClosingDateDialog
          onClose={() => {
            setOpen(false);
            router.refresh();
          }}
        />
      )}
    </>
  );
}
