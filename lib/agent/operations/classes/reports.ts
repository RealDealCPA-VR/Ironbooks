/**
 * Agent full access: classification of the "reports" routes (classes/buckets.ts lists the segments).
 * One entry per route + method, keyed "METHOD /api/pattern". Checked by classes/reports.test.ts.
 *
 * How this bucket was decided (plan sections 4.2, 4.6, 5.1, 5.6, 5.8, 5.9 and the rows "Reports"
 * and "1099" of section 8):
 *  - Reports, the audit trail, the transaction log, find and search only read: 'read'. A report
 *    run is remembered for a minute in memory (reportRegistry.ts, for the amount tooltips); that is
 *    not a database write. A POST that only computes (report builder, Process Multiple Reports,
 *    a report file made from the rows the caller sends) is 'read' too.
 *  - PDFs, XLSX, CSV and IIF files made for viewing or saving are 'read' with output 'pdf' or
 *    'file', even where the route map calls the action 'print': nothing is marked printed and no
 *    printer is driven. Saving such a file to a folder is the agent's own save_file (class 'file').
 *  - Masked by default (lib/permissions/mask.ts, taxIdFor, maskForContext): the route stays 'read'
 *    and names what a reveal shows. The contract allows one reveal kind per route; routes that mask
 *    both SSNs / tax IDs and account numbers name 'ssn', so account numbers stay masked even on an
 *    approved reveal (fails toward masking).
 *  - Report groups and commented reports are 'prepare': they never reach the ledger and a person
 *    can delete them. Deleting one is 'remove' (a group's delete also deletes its schedules).
 *  - Memorizing a report or changing a memorized one is 'outside', not 'prepare': it can put a
 *    report into a group (or change one) that an existing schedule saves and emails, so 'prepare'
 *    (which can be Allow) would let it change what an approved standing send carries. Such a change
 *    by an agent now holds every schedule that runs the report until a person saves its recipients
 *    again (below), but the class stays the worst case until that hold has proved itself: one route
 *    has one class.
 *  - Report schedules save files to disk unattended and can email them: creating or changing one is
 *    'outside' (the schedule is the standing permission the approver sees), and running the due
 *    ones is 'outside' with effects file and email. Their emails and files are not yet behind the
 *    effects outbox (plan 5.4), so a run has no dry run. A schedule an agent made or changed (or
 *    whose report or group an agent changed) is held: the desktop timer does not run it until a
 *    person saves its recipients on the Scheduled Reports page (lib/services/memorizedReports.ts
 *    schedulesWaitingForAPerson). That person then becomes its creator when it had none, and the
 *    runs use the creator's current access. The schedule entries say so to the approver.
 *  - Listing the schedules is 'file' (plan 4.2): it is a File Utilities read that names the
 *    report-export folder on this computer, next to the company file.
 *  - Where the request switches the answer to a download (format "xlsx", ?format=csv), the output
 *    is the download's kind ('file'), so a caller never parses a workbook as JSON.
 *  - The one-line report summary can ask the company's AI to phrase it (?ai=1): 'outside'.
 *  - The 1099 e-file needs full tax IDs and is refused without "view sensitive payroll data":
 *    'read_sensitive'. The 1099 account mapping is a company setting: 'settings'.
 *  - The quit-time automatic backup and the raw transaction log are copies of the company file:
 *    'file'. The desktop shell's own path of those routes (x-bka-internal) is never sent by the
 *    bridge, so only the signed-in path is classified.
 */
import type { ClassificationMap } from '../types';

/** Keys maskSensitive masks (lib/permissions/mask.ts SSN_KEYS and ACCOUNT_KEYS). */
const MASKED_KEYS = ['ssn', 'employeeSsn', 'taxId', 'accountNumber', 'routingNumber', 'bankAccountNumber'] as const;

/** The masked keys under each dotted prefix ("oldValues" → "oldValues.ssn", …). */
function maskedUnder(...prefixes: string[]): string[] {
  return prefixes.flatMap((p) => MASKED_KEYS.map((k) => `${p}.${k}`));
}

/** Cells of a standard report that a reveal can unmask (SS No. and the voided "Original values"). */
const STD_REPORT_MASKED_CELLS = ['rows.*.cells.ssn', 'rows.*.cells.original'];

/** Which standard report keys unmask data, said once for every route that runs them. */
const STD_REVEAL_WHY =
  'Two standard report keys mask data unless revealed: employee-contact-list (the SS No. column, last four digits) and voided-deleted-detail (the Original values column, with SSNs, tax IDs and account numbers masked). A reveal shows SSNs and tax IDs only; account numbers stay masked. The payroll reports (payroll-summary, payroll-detail, employee-earnings-summary, payroll-item-detail, payroll-liability-balances) need the role\'s payroll report right but mask nothing, so they need no reveal. Every other key masks nothing.';

export const REPORTS_CLASSES: ClassificationMap = {
  // ---- Standard reports: one route for the ~104 catalog keys, plus what is built on it ----
  'GET /api/reports/std/[report]': {
    class: 'read',
    describe: 'Run the {report} report',
    why: STD_REVEAL_WHY,
    reveal: 'ssn',
    sensitiveFields: STD_REPORT_MASKED_CELLS,
  },
  'GET /api/reports/drilldown/[report]': {
    class: 'read',
    describe: 'Show the transactions behind one amount of a report ({report})',
  },
  'GET /api/reports/summary/[report]': {
    class: 'outside',
    describe: "Summarize what changed in a report ({report}), phrased by the company's AI when ai=1",
    why: "With ai=1 the summary sentence is sent to the company's AI (a cloud model when the company allows one) and a cloud call is counted in the company's daily AI usage. Without ai=1 it is a plain read, but one route has one class, so it is classed by the call out. The AI call is not yet behind the effects outbox, so no dry run.",
    effects: ['network'],
    dryRun: 'none',
  },
  'GET /api/reports/graphs': { class: 'read', describe: 'Show a report graph' },
  'GET /api/reports/pivot': { class: 'read', describe: 'Show a pivot of ledger amounts by {rows}' },
  'GET /api/reports/filter-options': {
    class: 'read',
    describe: 'List the names the report filters can choose from',
  },

  // ---- Named financial reports ----
  'GET /api/reports/profit-loss': { class: 'read', describe: 'Show profit and loss' },
  'GET /api/reports/profit-loss-cash': { class: 'read', describe: 'Show cash-basis profit and loss' },
  'GET /api/reports/pl-by-class': { class: 'read', describe: 'Show profit and loss by class' },
  'GET /api/reports/pl-comparative': {
    class: 'read',
    describe: 'Show profit and loss for {from} to {to} (compared with {priorFrom} to {priorTo})',
  },
  'GET /api/reports/pl-monthly': { class: 'read', describe: 'Show profit and loss by month for {year}' },
  'GET /api/reports/pl-percent': { class: 'read', describe: 'Show profit and loss as a percent of income' },
  'GET /api/reports/balance-sheet': { class: 'read', describe: 'Show the balance sheet' },
  'GET /api/reports/balance-sheet-cash': { class: 'read', describe: 'Show the cash-basis balance sheet' },
  'GET /api/reports/balance-sheet-classified': { class: 'read', describe: 'Show the classified balance sheet' },
  'GET /api/reports/cash-flow': { class: 'read', describe: 'Show the statement of cash flows' },
  'GET /api/reports/trial-balance': { class: 'read', describe: 'Show the trial balance' },
  'GET /api/reports/general-ledger': { class: 'read', describe: 'Show the general ledger' },
  'GET /api/reports/transaction-detail': { class: 'read', describe: 'Show transaction detail' },
  'GET /api/reports/consolidated': {
    class: 'read',
    describe: 'Show the combined report of every company you may report on',
  },
  'GET /api/reports/budget-vs-actual': {
    class: 'read',
    describe: 'Show budget {budgetId} against actual amounts',
  },
  'GET /api/reports/budget-vs-actual-class': {
    class: 'read',
    describe: 'Show budget {budgetId} against actual amounts by class',
  },

  // ---- Banking reports ----
  'GET /api/reports/check-detail': { class: 'read', describe: 'Show the check detail report' },
  'GET /api/reports/deposit-detail': { class: 'read', describe: 'Show the deposit detail report' },
  'GET /api/reports/missing-checks': { class: 'read', describe: 'Show missing check numbers' },

  // ---- Customers and sales reports ----
  'GET /api/reports/ar-aging': { class: 'read', describe: 'Show the A/R aging summary' },
  'GET /api/reports/ar-aging-detail': { class: 'read', describe: 'Show the A/R aging detail' },
  'GET /api/reports/open-invoices': { class: 'read', describe: 'Show open invoices' },
  'GET /api/reports/collections': { class: 'read', describe: 'Show the collections report of overdue customers' },
  'GET /api/reports/commissions': { class: 'read', describe: 'Show sales rep commissions' },
  'GET /api/reports/sales-by-customer': { class: 'read', describe: 'Show sales by customer' },
  'GET /api/reports/sales-by-item': { class: 'read', describe: 'Show sales by item' },
  'GET /api/reports/sales-tax-by-agency': { class: 'read', describe: 'Show sales tax by agency' },
  'GET /api/reports/customer-statement': {
    class: 'read',
    describe: 'Show the statement of customer {customerId}',
  },
  'GET /api/reports/customer-statement/pdf': {
    class: 'read',
    describe: 'Make a PDF of the statement of customer {customerId}',
    output: 'pdf',
  },

  // ---- Vendors and purchases reports ----
  'GET /api/reports/ap-aging': { class: 'read', describe: 'Show the A/P aging summary' },
  'GET /api/reports/ap-aging-detail': { class: 'read', describe: 'Show the A/P aging detail' },
  'GET /api/reports/purchases-by-item': { class: 'read', describe: 'Show purchases by item' },
  'GET /api/reports/purchases-by-vendor': { class: 'read', describe: 'Show purchases by vendor' },

  // ---- Inventory reports ----
  'GET /api/reports/inventory-valuation': { class: 'read', describe: 'Show the inventory valuation summary' },
  'GET /api/reports/inventory-valuation/detail': { class: 'read', describe: 'Show the inventory valuation detail' },

  // ---- 1099: report, mapping, PDF and e-file ----
  'GET /api/reports/1099': {
    class: 'read',
    describe: 'Show the 1099 report for {year}',
    why: "Vendor tax IDs (a sole proprietor's is their SSN) are masked to the last four digits unless revealed.",
    reveal: 'ssn',
    sensitiveFields: ['*.taxId', 'rows.*.taxId'],
  },
  'GET /api/reports/1099/mapping': {
    class: 'read',
    describe: 'Show which accounts count toward each 1099 box',
  },
  'PATCH /api/reports/1099/mapping': {
    class: 'settings',
    describe: 'Change which accounts count toward each 1099 box',
    why: "Saves the company's 1099 account-to-box mapping in the company settings; it decides what every 1099 form and the e-file report.",
  },
  'GET /api/reports/1099-pdf': {
    class: 'read',
    describe: 'Make the {year} 1099-NEC PDF of a vendor (vendor: {vendorId})',
    why: "The vendor's tax ID on the form is masked to the last four digits unless revealed.",
    output: 'pdf',
    reveal: 'ssn',
  },
  'GET /api/reports/1099-xml': {
    class: 'read_sensitive',
    describe: 'Make the 1099-NEC e-file for {year} with full tax IDs',
    why: 'The IRS e-file carries every recipient\'s full tax ID and has no masked form: the service refuses anyone without "view sensitive payroll data". reveal names that need (SSNs) so the approver must hold that right and the approved call runs unmasked. Nothing is sent to the IRS; saving the file is the agent\'s own save_file.',
    reveal: 'ssn',
    output: 'file',
    dryRun: 'none',
  },

  // ---- Scheduled reports, path the desktop timer polls (same as /api/report-schedules/run-due) ----
  'POST /api/reports/schedules/run-due': {
    class: 'outside',
    describe: 'Run the scheduled reports that are due now: save their files and send their emails',
    why: "Runs every due schedule: writes report files into the report-export folder, emails them to each schedule's recipients, and moves each schedule's next run. A schedule an agent made or changed is skipped and stays due until a person saves its recipients. Files and email are written directly, not through the effects outbox, so no dry run.",
    effects: ['file', 'email'],
    body: 'none',
    dryRun: 'none',
  },

  // ---- Report builder ----
  'POST /api/report-builder': {
    class: 'read',
    describe: 'Run a custom report (grouped by {groupBy})',
    why: 'A POST only because the report settings are a body; it computes the report and writes nothing.',
  },

  // ---- Report schedules ----
  'GET /api/report-schedules': {
    class: 'file',
    describe: 'List scheduled reports and the folder they save to',
    why: "Decided 'file', not 'read' (plan 4.2): a File Utilities read whose answer names the report-export folder on this computer (exportFolder, the full path next to the company file) and each schedule's sub-folder, besides the recipients every schedule emails. An Admin approves it. Described only, never dry run: a dry run would hand the agent the answer before anyone approved it.",
    dryRun: 'none',
  },
  'POST /api/report-schedules': {
    class: 'outside',
    // The card line is at most 200 characters, and describe.ts shortens every value before it cuts
    // the line, so the line names what runs (the report or group id), the format, the recipients
    // and the folder, and leaves out the name: free text the agent chose, up to 60 characters, that
    // would shorten the id. The card shows the name with the rest of the request. A "(label: )"
    // left empty is removed.
    describe:
      'Schedule {frequency} {format} files, held until a person saves its recipients (report: {memorizedReportId}) (group: {groupId}) (email to: {emailTo}) (folder: {folder})',
    why: "A schedule saves report files to disk and, with recipients, emails them, later and with nobody at the keyboard. The approval lets the agent set it up, so it is classed by those sends; creating it only writes the schedule row. It does not run yet: a schedule an agent made waits until a person checks it under Scheduled Reports and saves its recipients (lib/services/memorizedReports.ts AGENT_SCHEDULE_HELD_MESSAGE); until then the desktop timer skips it. Who the runs act as: the schedule records the person of the request that made it (createdBy is the context's userId), and one made under a standing permission records none, so the person who saves its recipients becomes its creator. The runs use the creator's current access. The name is free text: what runs is the memorized report or report group the card names by id, so check that, not the name.",
    effects: ['file', 'email'],
  },
  'PATCH /api/report-schedules/[id]': {
    class: 'outside',
    // The new recipients and the on/off value first; a new name (free text) is left to the request
    // the card shows, for the same reason as the create line above.
    describe:
      'Change report schedule {id}, held until a person saves its recipients (email to: {emailTo}) (turned on: {isActive}) (how often: {frequency}) (file type: {format})',
    why: "Can add or change who the scheduled reports are emailed to (emailTo), or turn a schedule back on (isActive: true): the same standing sends as creating one. The line shows the new recipients and the on or off value the request sends. Any change an agent makes holds the schedule again: the desktop timer skips it until a person saves its recipients under Scheduled Reports (pausing or resuming it does not release it). A change keeps the schedule's creator, whose current access the runs use.",
    effects: ['file', 'email'],
  },
  'DELETE /api/report-schedules/[id]': { class: 'remove', describe: 'Delete report schedule {id}' },
  'POST /api/report-schedules/run-due': {
    class: 'outside',
    describe: 'Run the scheduled reports that are due now: save their files and send their emails',
    why: "Runs every due schedule: writes report files into the report-export folder, emails them to each schedule's recipients, and moves each schedule's next run. A schedule an agent made or changed is skipped and stays due until a person saves its recipients. Files and email are written directly, not through the effects outbox, so no dry run.",
    effects: ['file', 'email'],
    body: 'none',
    dryRun: 'none',
  },

  // ---- Memorized reports and groups ----
  'GET /api/memorized-reports': { class: 'read', describe: 'List memorized reports' },
  'POST /api/memorized-reports': {
    class: 'outside',
    describe: 'Memorize report {name} ({reportType}) (group: {groupId}, whose schedules then save and email it)',
    why: "Classed by its worst case, not as 'prepare': a saved report definition never reaches the ledger, but with a groupId it joins that group, and every schedule of the group then saves it into the report-export folder and emails it to the schedule's recipients. That run uses the schedule creator's access (full SSNs when that person may see them), so memorizing employee-contact-list into such a group would send full SSNs. An agent's change now holds those schedules until a person saves their recipients again (lib/services/memorizedReports.ts schedulesWaitingForAPerson), but 'prepare' can be Allow, and the class stays the worst case until that hold has proved itself. Without a groupId it is harmless, but one route has one class. It can go back to 'prepare' once the bridge escalates only when the group has an active schedule.",
    effects: ['file', 'email'],
  },
  'GET /api/memorized-reports/[id]': {
    class: 'read',
    describe: 'Run memorized report {id} with its saved settings',
    why: `Runs a standard report with saved settings. ${STD_REVEAL_WHY}`,
    reveal: 'ssn',
    sensitiveFields: STD_REPORT_MASKED_CELLS,
  },
  'PATCH /api/memorized-reports/[id]': {
    class: 'outside',
    describe:
      'Change memorized report {id}: its name, saved settings or group (new group: {groupId}); every schedule that runs it saves and emails the new version',
    why: "Classed by its worst case, not as 'prepare': a saved report definition never reaches the ledger, but a schedule that runs this report (or its new group, with a groupId) saves it into the report-export folder and emails it with the new settings, under the schedule creator's access. An agent's change now holds those schedules until a person saves their recipients again (lib/services/memorizedReports.ts schedulesWaitingForAPerson), but 'prepare' can be Allow, and the class stays the worst case until that hold has proved itself. A rename alone is harmless, but one route has one class. It can go back to 'prepare' once the bridge escalates only when the report or its new group has an active schedule.",
    effects: ['file', 'email'],
  },
  'DELETE /api/memorized-reports/[id]': {
    class: 'remove',
    describe: 'Delete memorized report {id} and its schedules',
  },
  'GET /api/memorized-reports/groups': { class: 'read', describe: 'List memorized report groups' },
  'POST /api/memorized-reports/groups': {
    class: 'prepare',
    describe: 'Make memorized report group {name}',
    why: 'A folder for saved report definitions: never reaches the ledger and a person can delete it.',
  },
  'PATCH /api/memorized-reports/groups/[id]': {
    class: 'prepare',
    describe: 'Rename memorized report group {id} to {name}',
    why: 'Renames a folder of saved report definitions; never reaches the ledger.',
  },
  'DELETE /api/memorized-reports/groups/[id]': {
    class: 'remove',
    describe: 'Delete memorized report group {id} and its schedules',
    why: "The group's reports are kept (ungrouped); its schedules are deleted for good.",
  },
  'POST /api/memorized-reports/process': {
    class: 'read',
    describe: 'Run several memorized reports at once (Process Multiple Reports)',
    why: `A POST only because the group or list of reports is a body; it runs them and writes nothing. format "xlsx" answers one workbook file (an attachment) instead of JSON, so the output is marked "file": a caller must go by the answer's content type, never parse it as JSON unseen. ${STD_REVEAL_WHY}`,
    reveal: 'ssn',
    sensitiveFields: ['results.*.report.rows.*.cells.ssn', 'results.*.report.rows.*.cells.original'],
    output: 'file',
  },

  // ---- Commented reports (a masked snapshot of a report with notes) ----
  'GET /api/commented-reports': { class: 'read', describe: 'List commented reports' },
  'POST /api/commented-reports': {
    class: 'prepare',
    describe: 'Save commented report {name} on a report ({reportType})',
    why: 'Notes on a picture of a report, taken with sensitive data masked: never reaches the ledger and a person can delete it.',
  },
  'GET /api/commented-reports/[id]': { class: 'read', describe: 'Show commented report {id} with its comments' },
  'PATCH /api/commented-reports/[id]': {
    class: 'prepare',
    describe: 'Rename commented report {id} or change its comments',
    why: 'Notes on a picture of a report: never reaches the ledger.',
  },
  'DELETE /api/commented-reports/[id]': { class: 'remove', describe: 'Delete commented report {id}' },

  // ---- Dashboard ----
  'GET /api/dashboard': {
    class: 'read',
    describe: 'Show the company dashboard: key numbers and what needs attention',
  },
  'POST /api/dashboard/auto-backup': {
    class: 'file',
    describe: 'Make an automatic backup of the whole company file, deleting automatic backups older than the kept number, or start the backup timer',
    why: "The desktop shell's quit-time backup. For a signed-in caller it needs an Admin of every company in the file. ?save=1 writes a full copy of the file into the backup folder, records it in the backup history and then deletes the older automatic backup versions beyond the number the backup settings keep. Without ?save it answers the whole file as a download and records it in the history. ?start=1 makes no backup: it starts the app's own scheduled-backup timer, which then backs up by itself. The service reads and writes the files on disk, so no dry run.",
    fileAdmin: true,
    body: 'none',
    output: 'file',
    effects: ['file'],
    dryRun: 'none',
  },

  // ---- Audit trail (reading only; editing its history is on the hard floor and has no route) ----
  'GET /api/audit-trail': {
    class: 'read',
    describe: 'List audit trail entries: who changed what, and when',
  },
  'GET /api/audit-trail/[id]': {
    class: 'read',
    describe: 'Show audit trail entry {id} with its before and after values',
    why: 'The before and after values mask SSNs, tax IDs and account numbers unless revealed. A reveal shows SSNs and tax IDs only; account numbers stay masked.',
    reveal: 'ssn',
    sensitiveFields: maskedUnder('oldValues', 'newValues'),
  },

  // ---- Transaction log ----
  'GET /api/transaction-log': {
    class: 'read',
    describe: 'Show the transaction log',
    why: "Each record's before and after data masks SSNs, tax IDs and account numbers unless revealed. A reveal shows SSNs and tax IDs only; account numbers stay masked.",
    reveal: 'ssn',
    sensitiveFields: maskedUnder('rows.*.data.old', 'rows.*.data.new'),
  },
  'GET /api/transaction-log/verify': {
    class: 'read',
    describe: 'Check the transaction log is complete and unchanged',
  },
  'GET /api/transaction-log/export': {
    class: 'read',
    describe: 'Export the transaction log as CSV',
    why: 'One plain-language line per record, without the before and after data, so nothing to mask.',
    output: 'file',
  },
  'GET /api/transaction-log/download': {
    class: 'file',
    describe: 'Download the raw transaction log file',
    why: 'A byte-for-byte copy of part of the company file: every record with its full before and after data, nothing masked, for every company in the file. Records written by older builds can also carry the closing-date and file password hashes; the JSON log strips those, this file cannot without breaking its fingerprints. The route gives it only to someone who manages every company it records, and to an Admin of every company in the file (requireFileAdmin) when a company has been deleted since; fileAdmin is set for that stricter case. ?part=verification answers only the verification report. Read from disk, so no dry run.',
    fileAdmin: true,
    output: 'file',
    dryRun: 'none',
  },

  // ---- Why did this number change ----
  'GET /api/why-changed': { class: 'read', describe: 'Show why the numbers changed (since {since})' },

  // ---- Find and search ----
  'GET /api/find': { class: 'read', describe: 'Find transactions matching the given filters' },
  'GET /api/search': { class: 'read', describe: 'Search names, transactions and accounts for {q}' },

  // ---- Exports (files made for the caller; nothing is written on disk) ----
  'GET /api/export/[list]': {
    class: 'file',
    describe: 'Export the {list} list as a file',
    why: "A File Utilities read that produces a file (the route map asks for File Utilities' Print right), so class file (plan 4.2): an Admin approves it. CSV and XLSX leave tax IDs and SSNs out. The IIF format of vendors, employees and \"all\" leaves tax IDs and SSNs blank unless revealed (it never writes a masked value). Described only, never dry run: a dry run would hand the agent the file before anyone approved it.",
    output: 'file',
    reveal: 'ssn',
    dryRun: 'none',
  },
  'POST /api/export/reports': {
    class: 'read',
    describe: 'Make a {format} file of the report {title}',
    why: 'A POST only because the report rows are a body: it turns the rows the caller sends into an XLSX or PDF file and writes nothing.',
    output: 'file',
  },
  'GET /api/export/statements/batch': {
    class: 'read',
    describe: 'Make statements for every customer with a balance or activity',
    output: 'file',
  },
  'GET /api/export/statements/open-item': {
    class: 'read',
    describe: 'Show the open-item statement of customer {customerId}',
  },
  'GET /api/export/statements/open-item/pdf': {
    class: 'read',
    describe: 'Make a PDF of the open-item statement of customer {customerId}',
    output: 'pdf',
  },
};
