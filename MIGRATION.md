# Migrating from QuickBooks Desktop to Ironbooks

A practical, step-by-step guide for moving a company file from QuickBooks
Desktop (Pro/Premier/Enterprise) into Ironbooks.

> **TL;DR:** Open **Migrate from QuickBooks** (File → Migrate from QuickBooks…).
> Step 1 brings your lists (IIF / CSV / Excel), step 2 your full history from the
> QuickBooks **General Ledger** report (proven account by account before anything is
> saved), step 3 your **open invoices and unpaid bills** as real documents. Then run
> the verification checklist at the bottom before retiring the old file. (The older
> route — lists plus one opening entry from a Trial Balance — is in section 3.)
>
> Imports change the whole company file, so they need an **owner or admin** and
> **single-user mode** while anyone else is signed in (Setup → Multi-user), as in
> QuickBooks.

---

## 1. What you need to know first

### Known limitations

- **No direct `.QBB` / `.QBW` read.** Ironbooks cannot open QuickBooks
  company files (`.QBW`) or QuickBooks backups (`.QBB`) directly — these are
  proprietary, encrypted formats. Migration goes through QuickBooks' own
  **IIF exports** (lists) and **reports** (balances).
- **History vs. opening balances.** The practical, recommended approach is to
  bring over your **lists + opening balances as of a cutover date** and keep
  the old QuickBooks file for historical reference. Re-keying or importing
  years of transaction history is possible (IIF transactions, bank-file
  re-imports) but rarely worth the effort.
- **Payroll history** does not transfer line-by-line. Set up payroll items and
  employees fresh, and enter year-to-date totals as opening balances if you
  migrate mid-year.
- **Memorized reports, custom templates, and attachments** do not transfer.
  Re-create the reports you actually use; re-attach critical documents.

### What maps where

| QuickBooks Desktop            | Ironbooks                                  |
| ----------------------------- | ---------------------------------------------- |
| Chart of Accounts             | Chart of Accounts (`Accounts` page)            |
| Customers & Jobs              | Customers (jobs become Jobs / sub-customers)   |
| Vendors                       | Vendors                                        |
| Items (all types)             | Items — service, inventory, non-inventory, other charge, discount, subtotal, payment, sales tax |
| Classes                       | Classes                                        |
| Employees                     | Employees (+ Payroll Items)                    |
| Sales Tax Items/Groups        | Tax Rates (+ combined/group rates)             |
| Memorized Transactions        | Recurring Templates                            |
| Set Closing Date + password   | Settings → Closing Date (+ password)           |
| Condense Data                 | Backup & Restore → Condense / Archive          |
| Backup (`.QBB`)               | Backup (`.bka`) — full or per-company          |
| Bank Feeds / Web Connect      | Banking → Import (OFX, QFX, QBO, CSV, Excel, statement PDF / scan) |

---

## 2. Export from QuickBooks Desktop

All exports below are from the QuickBooks Desktop menus.

1. **Lists as IIF**
   `File → Utilities → Export → Lists to IIF Files…`
   Tick at minimum: **Chart of Accounts, Customer List, Vendor List, Item
   List, Class List, Employee List**. Save the `.IIF` file(s).
2. **Trial Balance (opening balances)**
   `Reports → Accountant & Taxes → Trial Balance`. Set the date to your
   cutover date (typically the last day of the prior fiscal period — e.g.
   Dec 31). `Excel → Create New Worksheet` or export to CSV.
3. **Open invoices / unpaid bills** (so receivables and payables stay
   document-level, not just a lump sum):
   - `Reports → Customers & Receivables → Open Invoices` → Excel, CSV or PDF.
   - `Reports → Vendors & Payables → Unpaid Bills Detail` → Excel, CSV or PDF.
4. **Inventory valuation** (if you track inventory):
   `Reports → Inventory → Inventory Valuation Summary` as of the cutover date.
5. **Optional — bank history:** download the last 30–90 days from your bank as
   **QFX/OFX/QBO/CSV** for re-import into Ironbooks' Banking module.

Close the books in QuickBooks as of the cutover date so nothing changes under
you while migrating.

## 3. Import into Ironbooks — in this order

Order matters: each step references records created by the previous one.

1. **Create the company** (File → New Company / first-run setup). Set the
   fiscal-year start to match QuickBooks.
2. **Chart of Accounts** — *Migrate from QuickBooks → Step 1 (Lists)*: the
   QuickBooks IIF file (`!ACCNT` sections), or a CSV / Excel list. Verify account
   types/subtypes after import; A/R and A/P accounts must keep their special
   subtypes. Pick the IIF file with **Choose file…** as QuickBooks saved it: it is
   read in QuickBooks' own Windows character set, so accented names (Société,
   Müller) come over exactly.
3. **Customers and Vendors** — IIF (`!CUST`, `!VEND`) or CSV list import.
   Jobs/sub-customers come in under their parent customers.
4. **Items** — IIF (`!INVITEM`) or CSV. Check that each item's income/expense
   (and inventory asset/COGS) account mapping survived. Ironbooks supports
   the full QB item-type set including other charge, discount, subtotal,
   payment, and sales-tax items.
5. **Classes** — IIF (`!CLASS`) or create manually (usually a short list).
6. **Sales tax** — create Tax Agencies and Tax Rates (and combined rates) to
   match your QB sales-tax items/groups.
7. **Employees & payroll items** — IIF (`!EMP`) or manual entry; then set up
   payroll items (wage, tax, deduction) to mirror your QB payroll item list.
8. **Opening balances / transactions**
   - Post one **opening journal entry** dated the cutover date from the QB
     Trial Balance (every account, debits = credits; the offset, if any, goes
     to Opening Balance Equity).
   - **Important:** exclude A/R, A/P, and Inventory from that entry if you
     load them at document level in the next steps (otherwise they double).
   - Bring in the **open invoices** and **unpaid bills** with *Migrate from
     QuickBooks → Step 3* (upload the Open Invoices / Unpaid Bills Detail export,
     or type each balance in), with "My General Ledger history already has these
     balances" **unticked**: each becomes a real invoice / bill (credit memo /
     vendor credit for credits) dated as in QuickBooks, posted against Opening
     Balance Equity, so their postings recreate the A/R and A/P balances. (With an
     IIF file, tick "Bring in unpaid invoices and bills as real documents" in
     step 1 instead.) Re-importing the same report adds nothing.
   - Enter **inventory quantities on hand** (item opening quantities/values
     per the Valuation Summary) to rebuild the Inventory Asset balance.
9. **Banking** — add bank accounts, then import recent OFX/QFX/QBO/CSV files.
   Use the CSV mapper's preview before committing. Matched transactions up to
   the cutover should be excluded (they're already in the opening balances).
10. **Set the closing date** to the cutover date (Settings) so nobody back-posts
    into the migrated period, and take a **backup** (Backup & Restore page).

## 3a. Bring over your full history from the General Ledger (recommended)

Instead of (or after) opening balances, you can migrate **every transaction** from
QuickBooks' General Ledger report. Open **Migrate from QuickBooks** (sidebar → Setup, or
File → Migrate from QuickBooks…):

1. **Lists (optional)** — import your IIF lists first so contact details and items come over.
2. **Upload** the General Ledger: `Reports → Accountant & Taxes → General Ledger`, date range
   *All* (or the years you want), no filters, then `Excel → Create New Worksheet` (.xlsx),
   `Excel → Create .CSV file`, or `File → Save as PDF`. Optionally add the **Account Listing**
   (`Reports → List → Account Listing`, or your IIF chart of accounts) so every account type is
   exact, and a **Trial Balance** as of the last day for a second check.
3. **Preview** — accounts, transaction count, date range, totals, and anything that needs review.
4. **Account types** — a GL doesn't say what kind each account is; Ironbooks works it out from
   QB's section order, account numbers, names, running-balance direction and how each account is
   used. Confirm or change them, and map accounts onto ones that already exist (no duplicates).
5. **Dry run** — the whole import runs and is proven, then rolled back.
6. **Import** — one database transaction: accounts (numbers and `Parent:Child` hierarchy),
   classes, customers/vendors/employees, one opening entry dated the day before the period for
   the beginning balances, and every rebuilt transaction (each verified to balance, posted
   through the normal posting engine). Every line keeps its QuickBooks **Name**: a name on an
   Accounts Receivable line is always a customer and on an Accounts Payable line always a vendor
   (created if your lists don't have it yet); other names are sorted by how they are used
   (invoices and payments → customers, bills and checks → vendors, paychecks → employees).
7. **Proof** — every account's balance as of the period end must equal the report's ending
   balance (and the Trial Balance, if supplied), and debits must equal credits. If anything
   differs, **nothing is saved** — unless you explicitly choose to post the difference to a
   `QB Import Suspense` account to sort out later. The proof is stored with the import.
   - `QB Import Suspense` (code `QB-SUSPENSE`) is created as an equity account so it shows
     on the balance sheet as a clearing balance; reclassify its balance and bring it to zero.
     The variance entry is dated the period end, so closing-date rules apply to it.
   - A difference against the **Trial Balance** cannot be moved to suspense: if the General
     Ledger reconciles but the Trial Balance doesn't, the two exports describe different books
     (date, accrual/cash basis, filters) and the import is always rolled back.
   - Lines that offset each other but whose `Split` column points to other accounts are not
     forced into one entry; they go to the review list.
   - The proof compares the entries this import posted. If the company file already has other
     entries in a mapped account, the import warns that the account's full balance differs.

8. **Open invoices and bills (Step 3)** — the General Ledger brings your A/R and A/P *balances*,
   not the documents behind them, so until this step the A/R and A/P aging reports (and Receive
   Payments / Pay Bills) don't show what each customer and vendor owes. Upload QuickBooks' Open
   Invoices and Unpaid Bills Detail reports with "My General Ledger history already has these
   balances" **ticked**: each open item becomes a real document netted against `QB Conversion
   Clearing`, so the A/R and A/P totals don't change. The step refuses items that add up to more
   than the A/R or A/P the books hold without documents, and shows the proof that A/R equals the
   A/R aging and A/P the A/P aging.

Notes:

- Re-importing the same report (or an overlapping one) never duplicates: each transaction has a
  stable fingerprint (`qbgl:` source reference). Import consecutive periods oldest first.
- Excel files must be saved by Excel (or QuickBooks): a workbook whose formulas were never
  calculated is refused (the cell is named), and so is one that expands to more than 200 MB —
  export a shorter date range, or use CSV.
- Lines that can't be matched into a balanced transaction (usually a filtered report or a
  missing page) are listed for review and never posted.
- If you use this path, **skip** the opening-balance entry in step 8 above — the GL import
  creates it. Item quantities on hand imported afterwards (an IIF or CSV item list with
  quantities) set up the stock without posting it again: the GL import already holds the
  Inventory Asset balance.
- After the import you may have two accounts for the same thing (QuickBooks' "11000 Accounts
  Receivable - Trade" next to Ironbooks' "1200 Accounts Receivable"). Merge the **QuickBooks**
  one into the Ironbooks one (sidebar → Admin → Merge Records): invoices, bills, payments, inventory, sales tax and
  payroll post to Ironbooks' own accounts by number, so those are always the ones to keep
  (rename them afterwards if you like). The merge refuses the other direction.
- Running an import twice at once (a double click, two windows) is safe: imports into one
  company run one after the other, and the second one finds everything already there.

## 4. Verify-your-data checklist

Run these checks in Ironbooks against the same reports from QuickBooks
**as of the cutover date** before you stop using the old file:

- [ ] **Trial Balance** matches QuickBooks line for line (run Reports → Trial
      Balance). Total debits = total credits. (Invoices and bills always post to
      Ironbooks' own A/R and A/P accounts: if QuickBooks used several A/R or A/P
      accounts, the open documents from step 3 move their balances onto those — the
      totals still match.)
- [ ] **Balance Sheet** total assets/liabilities/equity match.
- [ ] **A/R Aging Summary** matches, and the **count and total of open
      invoices** equals QB's Open Invoices report.
- [ ] **A/P Aging Summary** matches, and unpaid bill count/total equals QB's
      Unpaid Bills Detail.
- [ ] **Inventory Valuation** (quantity and value per item) matches.
- [ ] **Bank account balances** match the bank statement and the QB register.
- [ ] Spot-check 5–10 **customers and vendors** for contact info and terms.
- [ ] Each **item** points at the correct income/expense/COGS accounts (create
      one test invoice in a draft and confirm the posting preview).
- [ ] **Sales tax rates** compute correctly on a test sale.
- [ ] **Closing date** is set and a **.bka backup** is saved off-machine.
- [ ] Run the built-in **Data Integrity** check (Integrity page) — zero issues.

Keep the QuickBooks file (read-only) for at least your statutory retention
period; historical detail you didn't migrate lives there.

---

## 5. Ongoing parity notes

- **Backups:** `.bka` files are portable zip archives. A *full backup* covers
  every company in the data directory; a *company backup* is a single tenant
  you can restore as a new company anywhere. Ironbooks also writes automatic
  **pre-operation backups** (last 5 kept) before restores and condense runs.
- **Condense/Archive** (QB "Condense Data" equivalent) lives on the Backup &
  Restore page: it summarizes closed-period detail to one entry per month and
  always writes a permanent archive `.bka` first. It is irreversible except by
  restoring that archive.
- **Bank imports:** OFX, QFX, QBO, CSV and Excel are supported; CSV / Excel
  have a full column mapper (separate debit/credit columns, date format, skip
  rows, sign flip) with a preview before anything is committed. Amounts such as
  `(12.50)`, `12.50-` and `$1,250.00` are understood, a `-` in an empty Debit or
  Credit cell counts as blank, and a file with an amount or date that is not
  real (`NaN`, Feb 30) is refused with the row number instead of being imported.
  Importing the same file again (or twice at once) adds nothing. A statement
  **PDF, scan or photo** is read on this computer (text layer or offline OCR —
  your AI is asked only under its usual routing rules), and its rows are shown
  for review and **tied out** to the statement's opening and closing balances;
  a statement that doesn't tie out is only imported if you say so.
- **IIF details:** names an IIF transaction uses on an A/R or A/P line that are
  not on your lists are added (as QuickBooks does), so those lines keep their
  name. Budgets (`!BUD`) land in the fiscal year each month belongs to.
