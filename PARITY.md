# QB Desktop Enterprise 24 parity matrix for bookkeeper-ai (second wave)

**Repo:** `C:/Users/VR/Projects/Open Source QB/bookkeeper-ai`. Paths below are relative to this root. I skipped `.wt/`, `node_modules`, `.next` and `.bookkeeper-data`. I made no changes to any file.

**Method:** I read `TODO.md`, `lib/nav.ts`, `lib/db/schema.ts`, `lib/services/*`, the `app/` pages and API routes, and `electron/*`. Before listing a gap I checked that it exists, with a grep over `lib app components electron` (`*.ts`, `*.tsx`, `*.js`, tests excluded) or by reading the code. Exclusions follow the brief.

## 0. Checking the TODO.md "100% complete" claim

I sampled the claims in the code. Most hold up, but these do not:

| TODO claim (marked [x]) | What the code shows |
|---|---|
| Invoices, estimates and sales orders can be edited after creation | Only invoices, bills and journal entries have an edit route (PATCH). `app/api/estimates/[id]/route.ts:48` changes **status only**. Sales orders, sales receipts, credit memos, checks, deposits, POs, payments, bill payments and vendor credits have no update at all. |
| Sub-account hierarchy has report roll-up | There is no `parentId` in `lib/services/reports.ts`, `reportsComparative.ts` or `classReports.ts`. P&L, Balance Sheet and Trial Balance are flat. |
| Company preferences depth | The keys are saved but never read. `accountNumbersEnabled`, `reportBasis`, `defaultCustomerTerms`, `defaultInvoiceMemo`, `defaultVendorTerms`, `negativeStockWarning`, `payroll*` and `timezone` appear only in `lib/services/company.ts`, `lib/validation/company.ts` and `app/settings/page.tsx`. |
| QB-style price levels | Only per-customer, per-item overrides exist (`customerPricing.ts`). They are applied only in `app/invoices/page.tsx:421`. A grep for `priceLevel` finds nothing. |
| Units of measure | `items.unitOfMeasure` is a text label only. There are no U/M sets or conversions. |
| Paycheck void/delete/edit | Only `voidPaycheck` exists (`payroll.ts:386`). There is no edit. |
| Pay Sales Tax per-agency liability | It counts **invoices only** (`combinedTax.ts:181-199`). Sales receipts and credit memos are left out. See D7. |

## 1. Summary counts

| | Total | Missing | Partial | Buggy | P0 | P1 | P2 |
|---|---|---|---|---|---|---|---|
| **All areas** | **105** | 57 | 40 | 8 | **10** | 47 | 48 |
| A Company/Setup & Prefs | 4 | 1 | 2 | 1 | 1 | 2 | 1 |
| B Lists | 18 | 11 | 6 | 1 | 1 | 7 | 10 |
| C Customers/AR | 9 | 4 | 4 | 1 | 0 | 5 | 4 |
| D Vendors/AP & Sales Tax | 8 | 3 | 4 | 1 | 1 | 5 | 2 |
| E Employees/Payroll (after-the-fact) | 8 | 5 | 2 | 1 | 2 | 4 | 2 |
| F Banking | 2 | 2 | 0 | 0 | 0 | 0 | 2 |
| G Inventory (non-Advanced) | 5 | 3 | 2 | 0 | 0 | 1 | 4 |
| H Reports | 17 | 6 | 11 | 0 | 0 | 10 | 7 |
| I Accountant tools | 13 | 11 | 1 | 1 | 1 | 6 | 6 |
| J Utilities | 15 | 8 | 7 | 0 | 0 | 5 | 10 |
| K Multi-user/security | 0 | – | – | – | – | – | – |
| L Data portability/migration | 6 | 2 | 2 | 2 | 4 | 2 | 0 |

**The 10 P0s:** A3 (document numbers), B1 (account types), D7 (sales tax liability), E1 (Social Security wage base), E3 (payroll YTD setup), I11 (journal entry names and A/R/A/P guard), L1 (IIF account hierarchy), L2 (IIF item types), L3 (IIF customer/vendor fields), L6 (open A/R/A/P and opening balances).

## 2. Parity tables

### A. Company/Setup & Preferences
| ID | Feature | Status | Evidence | Size | Pri |
|---|---|---|---|---|---|
| A1 | Saved preferences actually take effect | buggy | The pref keys appear only in `lib/services/company.ts:136-177`, `lib/validation/company.ts` and `app/settings/page.tsx` (grep per key). No service or form reads them. | M | P1 |
| A2 | Missing preference categories: Accounting (require accounts, class tracking on/off, auto JE number, past/future date warnings), Checking (default account per form), General, Jobs & Estimates, Items & Inventory, Payments (auto-apply, Undeposited Funds default), Reminders, Reports (aging from due vs. transaction date), Sales & Customers (ship/FOB defaults, price levels on), Sales Tax (owe on accrual vs. cash, frequency), Send Forms, Spelling, Time & Expenses (markup), Multiple Currencies toggle | missing | The `CompanySettings` interface (`company.ts:120-180`) has only those keys | L | P1 |
| A3 | Document numbers: user override, alphanumeric numbers (e.g. "INV-1001"), set a starting number | partial | Number columns are `integer` (`schema.ts:414,446,515,831,887,973`). `nextInvoiceNumber` is MAX+1 (`invoices.ts:216`). No `startingNumber` exists. You cannot carry on from QB's numbering or keep imported reference numbers. | M | P0 |
| A4 | Warnings for duplicate check, bill or invoice numbers | missing | No `duplicate` in `bills.ts` or `expenses.ts` | S | P2 |

### B. Lists
| ID | Feature | Status | Evidence | Size | Pri |
|---|---|---|---|---|---|
| B1 | QB account types: Other Current Asset, Other Asset, Other Current Liability, Other Expense, Non-posting | buggy | The subtype enum (`schema.ts:6-12`) has none of these. Default asset→`checking` and liability→`accounts_payable` (`accounts.ts:27-33`). IIF `OCASSET`→checking, `OCLIABILITY`→AP, `OTHERASSET`→fixed assets (`qbImport.ts:60-73`). Undeposited Funds is seeded as `checking` (`company.ts:20`). Result: prepaids show up as **Cash** (`dashboard.ts:192`, `reportsExtra.ts:475`) and as bank registers (`journal.ts:542`), and the A/P figure includes payroll and sales-tax liabilities (`dashboard.ts:213`). | M | P0 |
| B2 | Tax-line mapping on accounts | missing | A grep for `taxLineId\|tax_line` finds nothing | M | P1 |
| B3 | Other Names list (payees who are not customers, vendors or employees) | missing | grep `otherName` finds nothing. Payee is free text `expenses.payeeName` (`schema.ts:618`). | M | P1 |
| B4 | Customer Type, Vendor Type and Job Type lists | missing | grep `customerType\|vendorType\|jobType` finds nothing | M | P2 |
| B5 | Terms list (Standard and Date-Driven, discount %/days) that sets due dates and discounts | partial | Four hardcoded strings (`validation/company.ts:13`). `invoices.ts` takes `dueDate` from input only. grep `dueDays\|netDays` finds nothing. | M | P1 |
| B6 | Ship Via list plus invoice ship date, FOB, tracking number, ship-to snapshot and customer PO number | missing | grep `shipVia` finds nothing. The invoices table (`schema.ts:442-472`) has none of these fields. | M | P1 |
| B7 | Payment Method list (custom entries such as Visa, AmEx, e-Check) | partial | Fixed enum `paymentMethodEnum` (`schema.ts:296`) | S | P2 |
| B8 | Customer Message list | missing | grep `customerMessage` finds nothing | S | P2 |
| B9 | Sales Tax Code list (Tax/Non and custom codes), customer resale number and exemption reason | missing | grep `taxCode\|taxExempt` finds nothing (outside payroll). There is only a boolean `taxable`. | M | P1 |
| B10 | To Do list and timestamped Notes (customers, vendors, employees) | missing | grep `todo` finds only `electron/main.js`. `customers.notes` is a single text field. | M | P2 |
| B11 | Form templates and Layout Designer (logo, show/hide fields, column labels, several templates per form) | missing | grep `layoutDesigner\|formTemplate\|logo` (in `lib/pdf`) finds nothing. The `lib/pdf/*.ts` layouts are hardcoded. | L | P1 |
| B12 | Price Levels (fixed % and per-item, assigned to a customer, used on every sales form) | partial | Only `customerPricing.ts` overrides, used only in `app/invoices/page.tsx:421`. Not used on sales receipts, estimates or sales orders. (Check the boundary with the Advanced Pricing team.) | M | P1 |
| B13 | Billing Rate Levels | missing | grep `billingRate` finds nothing | S | P2 |
| B14 | Vehicle list (for mileage) | missing | `mileageLogs` (`schema.ts:1083`) has no vehicle field | S | P2 |
| B15 | Add/Edit Multiple List Entries (grid editing, paste from Excel) | missing | grep `bulkEdit\|addEditMultiple` finds nothing | M | P2 |
| B16 | Merge for items, classes, employees and other lists | partial | `merge.ts` only has `mergeCustomers`, `mergeVendors` and `mergeAccounts` | S | P2 |
| B17 | Memorized transaction list depth: groups, remind/never, number remaining, days in advance, memorize from a form (Ctrl+M), more document types, edit | partial | `recurring.ts:4` handles invoice, bill, JE and expense only. There is no PATCH in `app/api/recurring`. grep `memorize` in the form pages finds nothing. | M | P2 |
| B18 | Edit a sales tax rate or item | partial | `app/api/tax-rates/[id]/` has only `components/`. There is no PATCH. | S | P2 |

### C. Customers/AR
| ID | Feature | Status | Evidence | Size | Pri |
|---|---|---|---|---|---|
| C1 | Edit estimates, sales orders, sales receipts, credit memos and received payments after saving | partial | The estimate PATCH is status-only (`app/api/estimates/[id]/route.ts:48-63`). There is no `update*` export in `estimates.ts`, `salesOrders.ts`, `salesReceipts.ts`, `creditMemos.ts` or `payments.ts`. | L | P1 |
| C2 | Credit limit warns and allows override (as in QB) | buggy | It hard-blocks: `throw new ServiceError('VALIDATION','Credit limit exceeded')` (`invoices.ts:602`) | S | P1 |
| C3 | Early-payment discounts in Receive Payments | missing | No `discount` in `payments.ts` | M | P1 |
| C4 | Apply credit memos from inside Receive Payments | partial | `creditMemo` appears 0 times in `payments.ts`. Credits can only be applied from the memo side (`creditMemos.ts:559`). | S | P2 |
| C5 | Statement charges | missing | grep `statementCharge` finds nothing | M | P2 |
| C6 | Batch Invoicing | missing | grep `batchInvoic` finds nothing | M | P2 |
| C7 | Email estimates, statements, sales receipts, sales orders and credit memos; "to be printed/emailed" batch queues | partial | `email.ts` exports only `emailInvoice` (`:94`). grep `toBeEmailed\|batchPrint` finds nothing. | M | P1 |
| C8 | Printable PDFs for sales receipts, credit memos/refunds and sales orders | partial | `lib/pdf/` has invoice, estimate, statement, packingSlip, purchaseOrder and check only | S | P1 |
| C9 | Income Tracker and Collections Center | missing | grep `incomeTracker\|collectionsCenter` finds nothing | M | P2 |

### D. Vendors/AP & Sales Tax
| ID | Feature | Status | Evidence | Size | Pri |
|---|---|---|---|---|---|
| D1 | Edit POs, item receipts, checks/charges, bill payments, vendor credits, deposits and transfers | partial | PATCH routes exist only for bills, invoices and journal entries (grep of `app/api` for PATCH/PUT) | L | P1 |
| D2 | Items tab on Write Checks and credit card charges (buying inventory with a check or card) | missing | `expenseLines` has no `itemId` (`schema.ts:632-645`) | M | P1 |
| D3 | Print queue for bill-payment checks, refund checks and paychecks | partial | The print queue reads only `/api/expenses?toPrint=true` (`app/print-checks/page.tsx:105`). `billPayments` has no `toPrint` column. | M | P1 |
| D4 | Check printer alignment offsets and wallet style | partial | `lib/pdf/check.ts` has a voucher style only, with no offsets | S | P2 |
| D5 | Due dates and discount suggestions from terms in Bills and Pay Bills | partial | Discounts are entered by hand (`billPayments.ts:44-62`). No due date is computed from terms (depends on B5). | S | P1 |
| D6 | Vendor prefill accounts (QB allows 3), account number printed on the check memo, "Print on check as" | missing | grep `printAs\|printOnCheck` finds nothing. There is a single `defaultExpenseAccountId`. | S | P2 |
| D7 | Pay Sales Tax liability counts sales receipts and credit memos, and handles a per-line tax rate | buggy | `salesTaxByAgency` reads only `invoices` and uses the header `taxRateId` (`combinedTax.ts:181-199`). This feeds `salesTaxLiabilityByAgency` (`liabilityPayments.ts:380`), so tax owed is **understated** or wrong. `salesTaxLiabilityNet` (`salesTax.ts:101`) is not used anywhere. | M | P0 |
| D8 | Sales Tax Adjustment (discount, rounding, penalty) | missing | grep `salesTaxAdjust\|adjustSalesTax` finds nothing | S | P1 |

### E. Employees/Payroll (after-the-fact scope)
| ID | Feature | Status | Evidence | Size | Pri |
|---|---|---|---|---|---|
| E1 | Social Security wage base by year for W-2 Box 3 and W-3 | buggy | `SS_WAGE_BASE = 168600` (the 2024 figure) is hardcoded for every year (`payrollReports.ts:30,202,600`; `payrollTax.ts:71`). 2025 and 2026 W-2s are wrong for high earners. | S | P0 |
| E2 | Current withholding tables and filing statuses (Head of Household, post-2020 W-4) | partial | 2024 tables only (`payrollTax.ts:2-60`). `FilingStatus = 'single' \| 'married'` (`payrollTax.ts:95`). | M | P1 |
| E3 | Mid-year YTD payroll setup (historical paychecks or YTD adjustments) | missing | grep `ytdAdjust\|historical\|priorPayroll` in the payroll services finds nothing | M | P0 |
| E4 | Edit a paycheck | missing | Only `voidPaycheck` (`payroll.ts:386`) | M | P1 |
| E5 | Adjust Payroll Liabilities | missing | grep `adjustLiab\|liabilityAdjust` finds nothing | S | P1 |
| E6 | Employer SUI/SDI and a state quarterly wage worksheet | missing | `statePayrollTax.ts` has withholding only. grep `SUI\|SUTA\|SDI` finds only FUTA. | M | P1 |
| E7 | Workers Compensation | missing | grep `workersComp` finds nothing | M | P2 |
| E8 | Employee Earnings Summary, Payroll Item Detail, Payroll Transactions by Payee | partial | Only `payrollSummary`, `payrollDetail` and `payrollLiabilityBalances` exist (`payrollReports.ts`). grep `employeeEarnings` finds nothing. | S | P2 |

### F. Banking
| ID | Feature | Status | Evidence | Size | Pri |
|---|---|---|---|---|---|
| F1 | Loan Manager (amortization, payment splits) | missing | grep `loanManager\|amortization` finds nothing | M | P2 |
| F2 | Record Bounced Check (NSF) | missing | grep `bounced` finds nothing. The `nsf` hits are false positives on "tra-nsf-er". | S | P2 |

### G. Inventory (Advanced Inventory excluded)
| ID | Feature | Status | Evidence | Size | Pri |
|---|---|---|---|---|---|
| G1 | Opening quantity on hand and value when an item is created or imported | partial | `CreateItemInput` (`items.ts:30-60`) has no quantity on hand or as-of date. The IIF INVITEM import ignores `QNTY`. | S | P1 |
| G2 | Unit of Measure sets with conversions | partial | Label only (`items.unitOfMeasure`). grep `uomSet\|conversion` finds no UoM code. | M | P2 |
| G3 | Preferred vendor, create a PO from the reorder list, Stock Status by Vendor | missing | grep `preferredVendor` finds nothing | S | P2 |
| G4 | Change Item Prices utility | missing | grep `changeItemPrices\|bulkPrice` finds nothing | S | P2 |
| G5 | Inventory Center | missing | grep `inventoryCenter` finds nothing | S | P2 |

### H. Reports
| ID | Feature | Status | Evidence | Size | Pri |
|---|---|---|---|---|---|
| H1 | P&L sections: COGS, Gross Profit, Other Income, Other Expense | partial | `profitAndLoss` splits only revenue and expense (`reports.ts:117-180`) | M | P1 |
| H2 | Sub-account roll-up on P&L, Balance Sheet and Trial Balance | partial | No `parentId` in `reports.ts`, `reportsComparative.ts` or `classReports.ts` | M | P1 |
| H3 | Balance Sheet shows prior-years Retained Earnings and current-year Net Income separately | partial | All-time net income is lumped into one `retainedEarnings` figure (`reports.ts:186-190`, `:227-238`) | S | P1 |
| H4 | Memorize any standard report, Memorized Report Groups, Process Multiple Reports, rename or update | partial | `memorized` is used only in `app/reports/builder/page.tsx`. `memorizedReports.ts` has only list, save and delete, and no group column. | M | P1 |
| H5 | Scheduled reports | missing | grep `scheduleReport\|cron` finds nothing | M | P2 |
| H6 | Report filters (account, name, transaction type, amount, cleared status, and more), sort-by, subtotal-by, collapse | partial | `ReportToolbar.tsx` offers header, column picker and basis only. `transaction-detail` has a name/memo text filter only. | L | P1 |
| H7 | Drill-down (QuickZoom) on every report | partial | Present only in balance sheet, GL, P&L, trial balance, transaction detail, inventory valuation and reconciliation. Missing in aging, sales-by-*, purchases-by-*, cash flow, P&L comparative/monthly/by class, payroll and `SimpleReport.tsx`. | M | P1 |
| H8 | Missing standard reports: P&L Detail, P&L YTD Comparison, Balance Sheet Detail/Summary, Customer and Vendor Balance Summary/Detail (`customerBalanceSummary` exists at `customers.ts:315` but has no page), Unpaid Bills Detail, Sales by Customer/Item Detail, Open Sales Orders, Open POs, Expenses by Vendor Detail, Bills & Applied Payments, Journal | missing | grep `profitLossDetail\|vendorBalance\|unpaidBills\|openSalesOrders\|journalReport` finds nothing. No matching folders in `app/reports/`. | L | P1 |
| H9 | Job, time and mileage reports: Job Profitability Summary/Detail as reports, Job/Item Estimates vs. Actuals, Unbilled Costs by Job, Time by Job/Name/Item, Mileage by Vehicle/Job | missing | grep `estimateVsActual\|timeByJob\|mileageReport` finds nothing. `jobProfitability` is used only in `app/jobs`. | M | P1 |
| H10 | Income Tax Preparation, Income Tax Summary/Detail | missing | Nothing found (depends on B2) | M | P1 |
| H11 | List reports: contact and phone lists, Item Price List, Item Listing, Account Listing | missing | grep `contactList\|priceList\|itemListing` finds nothing | S | P2 |
| H12 | Sales Tax Liability as a report and Sales Tax Revenue Summary | partial | `sales-tax-by-agency` is used only in `app/sales-tax-components/page.tsx`. grep `salesTaxRevenue` finds nothing. | S | P1 |
| H13 | QB graphs (Income & Expense, Net Worth, Sales, A/R, A/P, Budget) | partial | Dashboard trend only | M | P2 |
| H14 | Advanced Reporting (ad-hoc and pivot) | partial | `reportBuilder.ts:14` groups GL lines by account, type or month only | L | P2 |
| H15 | Combine Reports from multiple companies (beyond P&L and Balance Sheet) | partial | `consolidation.ts:56,106` covers only P&L and Balance Sheet | M | P2 |
| H16 | Fonts and number formats (show in thousands, negatives in parentheses, without cents) | missing | Not in `ReportToolbar.tsx` | S | P2 |
| H17 | Budgets by Customer:Job and balance-sheet budgets, Forecasts, Budget Overview | partial | `budgetLines` has `classId` only (`schema.ts:780-787`). grep `forecast` finds nothing. | M | P2 |

### I. Accountant tools
| ID | Feature | Status | Evidence | Size | Pri |
|---|---|---|---|---|---|
| I1 | Accountant's Copy and dividing date | missing | grep `accountantCopy\|dividingDate` finds nothing. (Coordinate with the portable-file team.) | L | P2 |
| I2 | Fix Incorrectly Recorded Sales Tax | missing | grep `fixSalesTax\|fixIncorrectlyRecorded` finds nothing | M | P1 |
| I3 | Reclassify Transactions | missing | grep `reclassify` finds only an error string (`accounts.ts:262`) | M | P1 |
| I4 | Write Off Invoices | missing | grep `writeOff` finds nothing | S | P1 |
| I5 | Batch Enter Transactions | missing | grep `batchEnter` finds nothing | L | P1 |
| I6 | Batch Delete/Void | missing | grep `batchDelete\|batchVoid` finds nothing | M | P2 |
| I7 | Period Copy | missing | grep `periodCopy` finds nothing | L | P2 |
| I8 | Working Trial Balance | missing | grep `workingTrialBalance` finds nothing | M | P2 |
| I9 | Adjusting Entry flag and Adjusting Journal Entries report | missing | `journalEntries` (`schema.ts:79-94`) has no flag. grep `isAdjusting` finds nothing relevant. | S | P1 |
| I10 | Review List Changes | missing | grep `listChanges` finds nothing (audit logs could provide the data) | S | P2 |
| I11 | Name column on journal entry lines, and a guard that A/R and A/P lines carry a customer or vendor | buggy | `journalEntryLines` (`schema.ts:96-105`) has no entity column. `ManualEntryInput` (`journal.ts:1-123`) has no customer or vendor. Nothing in `journal.ts` or `posting.ts` guards A/R/A/P accounts. A manual JE to A/R therefore changes the GL but not aging or customer balances. | M | P0 |
| I12 | Accountant Center | missing | grep `accountantCenter` finds nothing | M | P2 |
| I13 | Client Data Review tasks (fix unapplied payments/credits, clear up Undeposited Funds, review item setup, compare with the last review) | partial | Only AI review (`errorDetection.ts`) and `integrity.ts` exist | L | P1 |

### J. Utilities
| ID | Feature | Status | Evidence | Size | Pri |
|---|---|---|---|---|---|
| J1 | Clean Up Company Data: remove unused list entries | partial | `condense.ts` exists. grep `removeInactive\|purge` finds nothing for lists. | S | P2 |
| J2 | IIF export of lists and transactions | missing | `app/api/export/[list]` is CSV only (`listExport.ts:22`). grep `iifExport\|toIif` finds nothing. | M | P1 |
| J3 | Excel (.xlsx) import for lists | missing | `lib/export/xlsx.ts` writes only. grep `parseXlsx\|importXlsx` finds nothing. | S | P2 |
| J4 | Export of all lists (classes, tax items, terms, jobs, payroll items) | partial | `ExportableList` covers 5 lists (`listExport.ts:22`) | S | P2 |
| J5 | Advanced Find (type, name, amount range, number, account, filters) | partial | Global search (`app/api/search`) plus a text filter in transaction detail | M | P2 |
| J6 | Calendar | missing | No `app/calendar`. The `calendar` hits are date pickers. | M | P2 |
| J7 | Reminders list with preferences (checks/forms to print, money to deposit, reorder, to-dos) | partial | Dashboard insights only (`dashboard.ts:95-107`) | M | P2 |
| J8 | Lead Center | missing | grep `leadCenter\|leads` finds nothing | M | P2 |
| J9 | Doc Center: attach from forms and lists, plus an unfiled inbox | partial | No `attachments` usage in `app/invoices`, `bills`, `expenses`, `journal`, `customers`, `vendors` or `components`. `entityId` is required (NOT NULL, `schema.ts:807`). | M | P1 |
| J10 | Multi-currency across documents and names (currency on customers, vendors, bank/credit card accounts, bills, expenses, sales receipts, credit memos, estimates) | partial | `currency` exists only on invoices and payments (`schema.ts:455,502`) | L | P1 |
| J11 | Closing Date Exception report, and an audit record when the closing-date password is used | missing | `closingDateOverride` appears only in `_base.ts`, `context.ts` and `fiscalPeriods.ts`, and is never written to the audit log | S | P1 |
| J12 | Voided/Deleted Transactions Summary and Detail | missing | grep `voidedDeleted\|deletedTransactions` finds nothing (`audit_logs` already has void and delete actions) | S | P1 |
| J13 | Spell check on forms | missing | grep `spell` finds nothing | S | P2 |
| J14 | Fuller Electron menu (Company, Customers, Vendors, Employees, Banking, Lists) | partial | Only File, Edit, View, Reports and Help (`electron/main.js:415-448`) | S | P2 |
| J15 | Letters (collection letters), mailing labels, envelopes | missing | grep `collectionLetter\|envelope\|avery` finds nothing | M | P2 |

### K. Multi-user/security
Nothing in scope is left. Users, roles, permissions, per-file login and hosting over tailnet are excluded. The closing-date audit gap is J11.

### L. Data portability/migration (GL import from xlsx/csv/pdf excluded)
| ID | Feature | Status | Evidence | Size | Pri |
|---|---|---|---|---|---|
| L1 | IIF account hierarchy ("Parent:Sub") | buggy | `importIIF` passes no `parentId`, so accounts are created flat under the literal "Parent:Sub" name (`qbImport.ts:557-565`). Lookup by leaf name only (`qbImport.ts:839-848`) can post transaction lines to the wrong account when two leaves share a name (e.g. "Utilities:Gas" and "Auto:Gas"). | M | P0 |
| L2 | IIF item type mapping | buggy | `mapIifItemType` maps `OTHC`, `DISC`, `PMT`, `STAX`/`COMPTAX`, `GRP`, `SUBT` and `ASSEMBLY` all to `non_inventory`, even though the matching enum values exist (`qbImport.ts:1066-1076`, `schema.ts:288`) | S | P0 |
| L3 | IIF CUST/VEND field coverage | partial | Only name, company, email, phone and bill address are parsed (`qbImport.ts:261-288`). Dropped: ship-to, terms, tax settings, credit limit, CTYPE/VTYPE, REP, HIDDEN, vendor 1099 flag and TAXID. "Customer:Job" is imported as one flat customer. | M | P0 |
| L4 | Other IIF list types: OTHERNAME, CTYPE, VTYPE, JOBTYPE, TERMS, SHIPMETH, PAYMETH, CUSTMSG, SALESTAXCODE, BUD, TODO, VEH | missing | The parser handles only ACCNT, CUST, VEND, CLASS, INVITEM, EMP, TRNS and SPL (`qbImport.ts:241-318`) | M | P1 |
| L5 | IIF EMP fields (address, SSN, hire date, pay rates, W-4) | partial | Only name and email (`qbImport.ts:306`) | S | P1 |
| L6 | Open A/R and A/P conversion: customer/vendor opening balances and import of open invoices and bills as real documents | missing | No `openingBalance` in `customers.ts`, `vendors.ts` or `items.ts`. IIF transactions are imported as journal entries only (sourceRef `iif:`, `qbImport.ts:~1014`). After cutover, Receive Payments, Pay Bills and aging have nothing to apply to. (Coordinate with the GL-import team.) | M | P0 |

## 3. Proposed second-wave work packages (8, file-disjoint)

**Rule:** WP1 runs first, on its own, and it is the only package that edits `lib/db/schema.ts`, `drizzle/*` and `lib/nav.ts`. It adds every column, table and nav entry the other packages need, from one agreed spec. WP2–WP8 then run in parallel. Each owns the files listed against it and only *calls* other packages' exported functions.

| WP | Theme | Gaps | Files it owns |
|---|---|---|---|
| **WP1** | Schema and GL foundation (runs first) | B1, B2, I9, I11, schema for A3 (text reference numbers), plus all wave columns and tables (lists, shipping fields, `toPrint` on billPayments, `itemId` on expense lines, FX columns, nullable attachment `entityId`, memorized-report groups, JE entity column, adjusting flag) | `lib/db/schema.ts`, `drizzle/0017+`, `lib/nav.ts`, `lib/services/{accounts,journal,posting,dashboard}.ts`, the company.ts seed block, `app/accounts`, `app/journal` |
| **WP2** | Lists, master data and inventory | B3–B10, B12–B16, B18, G1–G5, J1 (A4 is split between WP3 and WP4) | new `lib/services/lists/*` (`terms.ts` exports `computeDueDate`), `customers.ts`, `vendors.ts`, `items.ts`, `customerPricing.ts`, `merge.ts`, `salesTax.ts`, `inventory.ts`, `inventoryOps.ts`, `app/lists/*`, `app/{customers,vendors,items,customer-pricing,merge,inventory-ops}` |
| **WP3** | Sales/AR transactions | C1–C6, C9, F2, A3 and A4 for sales, B6 and B12 on the forms, J10 for sales documents, J9 panel dropped into sales forms | `lib/services/{invoices,estimates,salesOrders,salesReceipts,creditMemos,payments,statements,financeCharges}.ts`, `app/{invoices,estimates,sales-orders,sales-receipts,credit-memos,payments,finance-charges}` |
| **WP4** | Purchases and banking transactions | D1, D2, D5, D6, F1, A3 and A4 for purchases, J10 for purchase documents and bank accounts, J9 panel dropped into purchase forms | `lib/services/{bills,billPayments,purchaseOrders,itemReceipts,expenses,vendorCredits,deposits,transfers,checkNumbers,currencies}.ts`, new `loans.ts`, `app/{bills,pay-bills,expenses,purchase-orders,item-receipts,vendor-credits,deposits,transfers,banking}` |
| **WP5** | Sales tax and accountant tools | D7, D8, H12, I2–I6, I8, I10, I12, I13, J11, J12 (I1 and I7 deferred, overlap with the portable-file team) | `lib/services/{combinedTax,liabilityPayments,auditTrail,errorDetection,fiscalPeriods}.ts`, new `lib/services/accountant/*`, `app/{pay-liabilities,sales-tax-components,audit-trail,errors}`, new `app/accountant/*` |
| **WP6** | Reports engine | H1–H11, H13–H17, J5 | `lib/services/{reports,reportsExtra,reportsComparative,classReports,reportBuilder,memorizedReports,consolidation,budgets,jobs,cashBasisReports,balanceSheetClassified}.ts`, new `lib/services/reportsJobsTime.ts`, `app/reports/**`, `app/{budgets,transactions}` |
| **WP7** | Preferences, forms output and shell | A1, A2 (exports `getPreferences()` for WP3/WP4 to use), B11, C7, C8, D3, D4, B17, J6–J9 (Doc Center service and component), J13–J15, the timer side of H5 | `lib/services/{company,email,recurring,attachments}.ts`, `lib/pdf/*`, `app/{settings,print-checks,recurring,attachments,dashboard}`, new `app/{calendar,reminders,leads}`, `components/AttachmentPanel.tsx`, `electron/*` |
| **WP8** | Payroll (after-the-fact) and migration | E1–E8, L1–L6, J2–J4 | `lib/services/{payroll,payrollTax,payrollReports,statePayrollTax,payrollItems,qbImport,import,listExport}.ts`, new `payrollAdjustments.ts` and `iifExport.ts`, `app/{employees,pay-runs,pay-stubs,payroll-forms,payroll-tax,qb-import}` |

**Dependencies and coordination**
- **WP2 before WP3, WP4 and WP8:**
  - Terms (`computeDueDate`) is needed by C3, D5 and B5's due-date use.
  - Sales tax codes and price levels are needed by WP3.
  - The list services are needed by L3 and L4. Schedule L3 and L4 last within WP8.
- **WP7 to WP3/WP4:** WP7 exports `getPreferences()` and `AttachmentPanel`, and WP3/WP4 call them. WP7 builds each before the packages that call it.
- **WP6 to WP7:** WP6 adds the scheduled-report endpoint; WP7 adds the Electron timer that calls it.
- **Other teams:**
  - B12 overlaps the Advanced Pricing team.
  - L6 overlaps the GL-import team.
  - I1 and I7 overlap the portable-file and transaction-log team.
  - J7 overlaps the home-page/onboarding team.

**Suggested order inside each package:** P0s first. That is B1 and I11 in WP1, D7 in WP5, E1, E3, L1, L2, L3 and L6 in WP8, and A3 in WP3 and WP4.