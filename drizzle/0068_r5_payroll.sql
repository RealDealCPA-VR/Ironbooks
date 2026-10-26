-- Review round 5 (payroll): a paycheck remembers the pay frequency it was calculated with.
--
-- paychecks gains
--   periods_per_year  pay periods per year used to annualize the wages for withholding (52 weekly,
--                     26 biweekly, 24 semimonthly, 12 monthly). Edit Paycheck recalculates with the
--                     check's own frequency instead of assuming biweekly. Older rows stay NULL and
--                     fall back to the company's payroll pay period (Preferences > Payroll).
ALTER TABLE "paychecks" ADD COLUMN IF NOT EXISTS "periods_per_year" integer;
