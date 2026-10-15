/**
 * tesseract.js (receipt capture OCR) is only loaded by lib/receipts/ocr.ts, which declares the
 * small part of the API it uses itself. This shorthand keeps type-checking independent of
 * whether the package is installed yet (a checkout that hasn't run `npm install` since it was
 * added still compiles; at runtime getOcrEngine() then reports OCR as unavailable).
 */
declare module 'tesseract.js';
