-- fix/payroll: QuickBooks-style "tax tracking type" on payroll items and paycheck lines.
-- 401(k)/403(b)/457(b) deferrals reduce income-tax wages only; Section 125 items reduce
-- income-tax AND Social Security/Medicare/FUTA wages; after-tax deductions reduce nothing.
-- W-2 / 941 / 940 / state worksheets aggregate by this code instead of free-text line names.
ALTER TABLE "payroll_items" ADD COLUMN IF NOT EXISTS "tax_tracking" varchar(40);--> statement-breakpoint
ALTER TABLE "paycheck_lines" ADD COLUMN IF NOT EXISTS "tax_tracking" varchar(40);--> statement-breakpoint
-- Deduction items: retirement deferrals by name, other pre-tax items as Section 125, else after-tax.
UPDATE "payroll_items" SET "tax_tracking" = CASE
    WHEN "name" ~* '401\s*\(?k' THEN '401k'
    WHEN "name" ~* '403\s*\(?b' THEN '403b'
    WHEN "name" ~* '457' THEN '457b'
    WHEN "name" ~* 'simple\s*ira' THEN 'simple_ira'
    WHEN NOT "pretax" THEN 'none'
    WHEN "name" ~* '(^|[^a-z])hsa([^a-z]|$)|health savings' THEN 'hsa'
    WHEN "name" ~* 'dependent\s*care' THEN 'dependent_care'
    WHEN "name" ~* 'retire|pension|deferred comp' THEN '401k'
    ELSE 'section125'
  END
  WHERE "kind" = 'deduction' AND "tax_tracking" IS NULL;--> statement-breakpoint
UPDATE "payroll_items" SET "tax_tracking" = 'none' WHERE "kind" = 'garnishment' AND "tax_tracking" IS NULL;--> statement-breakpoint
UPDATE "payroll_items" SET "pretax" = ("tax_tracking" IN ('401k','403b','457b','simple_ira','section125','hsa','dependent_care'))
  WHERE "kind" = 'deduction';--> statement-breakpoint
-- Employee tax items by name (unrecognized names stay NULL until the user picks a type).
UPDATE "payroll_items" SET "tax_tracking" = CASE
    WHEN "name" ~* 'federal\s+(income\s+tax|withholding|tax)' THEN 'federal_withholding'
    WHEN "name" ~* 'medicare' THEN 'medicare'
    WHEN "name" ~* 'social\s+security|oasdi' THEN 'social_security'
    WHEN "name" ~* 'disab|(^|[^a-z])sdi([^a-z]|$)' THEN 'sdi'
    WHEN "name" ~* 'unemploy|workers' THEN NULL
    WHEN "name" ~* 'state' THEN 'state_withholding'
    WHEN "name" ~* 'local|city|county' THEN 'local_tax'
    ELSE NULL
  END
  WHERE "kind" = 'tax' AND "tax_tracking" IS NULL;--> statement-breakpoint
-- Employer items by name.
UPDATE "payroll_items" SET "tax_tracking" = CASE
    WHEN "name" ~* 'futa|federal unemployment' THEN 'futa'
    WHEN "name" ~* 'state unemployment|(^|[^a-z])sui([^a-z]|$)|(^|[^a-z])suta([^a-z]|$)' THEN 'sui'
    WHEN "name" ~* 'workers' THEN 'workers_comp'
    WHEN "name" ~* 'social security|oasdi' THEN 'employer_social_security'
    WHEN "name" ~* 'medicare' THEN 'employer_medicare'
    WHEN "name" ~* '(^|[^a-z])hsa([^a-z]|$)|health savings' THEN 'employer_hsa'
    WHEN "name" ~* 'health|medical|dental|vision' THEN 'employer_health'
    WHEN "name" ~* '401|403|457|match|retire|pension' THEN 'employer_retirement'
    ELSE 'other'
  END
  WHERE "kind" = 'employer_contribution' AND "tax_tracking" IS NULL;--> statement-breakpoint
-- Paycheck lines linked to an item inherit the item's tracking type.
UPDATE "paycheck_lines" AS pl SET "tax_tracking" = pi."tax_tracking"
  FROM "payroll_items" AS pi
  WHERE pl."payroll_item_id" = pi."id" AND pl."tax_tracking" IS NULL AND pi."tax_tracking" IS NOT NULL
    AND pl."kind" <> 'earning';--> statement-breakpoint
-- Unlinked lines: the standard names written by the paycheck engine.
UPDATE "paycheck_lines" SET "tax_tracking" = CASE
    WHEN "name" ~* 'federal\s+(income\s+tax|withholding|tax)' THEN 'federal_withholding'
    WHEN "name" ~* 'medicare' THEN 'medicare'
    WHEN "name" ~* 'social\s+security|oasdi' THEN 'social_security'
    WHEN "name" ~* 'disab|(^|[^a-z])sdi([^a-z]|$)' THEN 'sdi'
    WHEN "name" ~* 'unemploy|workers' THEN NULL
    WHEN "name" ~* 'state' THEN 'state_withholding'
    WHEN "name" ~* 'local|city|county' THEN 'local_tax'
    ELSE NULL
  END
  WHERE "kind" = 'tax' AND "tax_tracking" IS NULL;--> statement-breakpoint
UPDATE "paycheck_lines" SET "tax_tracking" = CASE
    WHEN "name" ~* 'futa|federal unemployment' THEN 'futa'
    WHEN "name" ~* 'state unemployment|(^|[^a-z])sui([^a-z]|$)|(^|[^a-z])suta([^a-z]|$)' THEN 'sui'
    WHEN "name" ~* 'workers' THEN 'workers_comp'
    WHEN "name" ~* 'social security|oasdi' THEN 'employer_social_security'
    WHEN "name" ~* 'medicare' THEN 'employer_medicare'
    ELSE 'other'
  END
  WHERE "kind" = 'employer_contribution' AND "tax_tracking" IS NULL;--> statement-breakpoint
UPDATE "paycheck_lines" SET "tax_tracking" = 'none' WHERE "kind" = 'deduction' AND "tax_tracking" IS NULL;
