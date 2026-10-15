'use client';
/**
 * <AccessKeyText>: renders a button / label text with its access-key letter underlined, the
 * Windows convention for "press Alt + this letter". Put the matching `accessKey` attribute on the
 * button or field itself (the browser / Electron then presses or focuses it on Alt+letter).
 */
import * as React from 'react';
import { accessKeyParts } from '@/lib/shortcuts';

export function AccessKeyText({ text, accessKey }: { text: string; accessKey: string }) {
  const parts = accessKeyParts(text, accessKey);
  if (!parts) return <>{text}</>;
  return (
    <>
      {parts.before}
      <u className="underline decoration-1 underline-offset-2">{parts.letter}</u>
      {parts.after}
    </>
  );
}

export default AccessKeyText;
