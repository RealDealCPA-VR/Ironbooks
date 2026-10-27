-- Review round 5 (multi-currency): a received payment's exchange rate keeps the 8 decimals every
-- other rate has (currency list, invoices, bills, deposits, journal lines). It was numeric(15, 6):
-- a payment taken at the currency list's rate (e.g. 1.08234567) was stored and posted at 1.082346,
-- so paying an invoice booked at the very same rate showed a made-up realized exchange gain or loss
-- (USD 0.03 on EUR 100,000; more on currencies such as JPY, IDR or VND).
--
-- Widening a numeric column keeps every stored value exactly.
ALTER TABLE "payments_received" ALTER COLUMN "exchange_rate" TYPE numeric(18, 8);
