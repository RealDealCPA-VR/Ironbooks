/**
 * QuickBooks Desktop's complete keyboard-shortcut list (2024 / Enterprise, Windows), with where
 * each key comes from and what it does in Ironbooks — or why it does not apply. The "?" / F1 /
 * Help > Keyboard Shortcuts list (components/ShortcutsHelp.tsx) is drawn from the rows marked
 * done, grouped under Intuit's own headings, so the list shows exactly what works.
 * lib/qbShortcuts.test.ts checks each done row against the key handlers.
 *
 * Sources (retrieved 2026-10-27; Intuit's article, QBK Accounting and TeachUcomp re-read 2026-10-30):
 *  - intuit: Intuit, "Keyboard shortcuts in QuickBooks Desktop"
 *    https://quickbooks.intuit.com/learn-support/en-us/help-articles/quickbooks-desktop-keyboard-shortcuts/00/261708
 *    (Canadian mirror: https://quickbooks.intuit.com/learn-support/en-ca/help-article/multi-user-mode/keyboard-shortcuts-quickbooks-desktop/L7xynnaf3_CA_en_CA)
 *  - qbhelp: QuickBooks Desktop's in-product Help "Keyboard shortcuts", as published by QBooks
 *    Consulting (https://qbooksconsulting.ca/wp-content/uploads/2020/01/QBD-PC-Keyboard-Shortcuts.pdf)
 *    and QBK Accounting (https://qbkaccounting.com/quickbooks-keyboard-shortcuts-versions-2008-2014/)
 *  - teachucomp: TeachUcomp, "Keyboard Shortcuts in QuickBooks Pro" (QuickBooks 2018–2023)
 *    https://www.teachucomp.com/keyboard-shortcuts-in-quickbooks-pro/
 *  - axpert: Axpert Advisors, "Keyboard Shortcuts for QuickBooks Desktop for Windows & Mac"
 *    https://www.axpertadvisors.com/keyboard-shortcuts-for-quickbook/ (menu letters, window keys,
 *    Chart of Accounts keys)
 *  - fmd: FMD Business Solutions, "Keyboard Shortcuts" https://www.fmdbusiness.com/keyboard-shortcuts
 *    (Ctrl+F6 next window, Home Home / End End, Windows MDI window keys)
 *  - dummies: QuickBooks 2024 All-in-One For Dummies cheat sheet
 *    https://dummies.com/article/technology/software/money-management-software/quickbooks/quickbooks-2023-all-in-one-for-dummies-cheat-sheet-295510
 *
 * Where the sources disagree:
 *  - ; and ' in a date field: QuickBooks' own Help, QBK Accounting and Axpert give ; = same day
 *    last month and ' = next month (left / right, like [ ] and - +); Intuit's current web article
 *    lists them the other way round. Ironbooks follows the in-product Help.
 *  - Alt+S: Intuit's article and the in-product Help say "save" (Intuit: "save and close"); the
 *    form buttons' underlined letters (TeachUcomp's sticker, Axpert's Invoices list) are
 *    Alt+S Save & New and Alt+A Save & Close. Ironbooks follows the buttons: Alt+S Save & New,
 *    Alt+A Save & Close, Alt+N saves (asking first) and goes to the next form.
 *  - Ctrl+F6: Intuit's article puts it under Lists as "Run a Quick Report for an item on a list";
 *    the in-product QuickReport key is Ctrl+Q, and Ctrl+F6 is the Windows / QuickBooks
 *    next-window key (FMD). Ironbooks does both: on a list with a highlighted name or account
 *    Ctrl+F6 runs its QuickReport, anywhere else it goes to the next window.
 *  - Ctrl+R: Intuit's article (and the Dummies cheat sheet): open an account register; the
 *    2008–2014 in-product Help (QBK Accounting): "Open split transaction window in register".
 *    Ironbooks follows Intuit's current list.
 *  - + / - in data fields: Intuit's article says "Increase or decrease the amount"; the
 *    in-product Help and TeachUcomp say "Increase check or other form number by one". In an
 *    amount field + and - are QuickMath (QuickBooks too), so they step form numbers.
 *  - Vendors / Employees menus: Alt+O and Alt+Y (Axpert: "Alt+O and Enter: Vendor Center",
 *    "Alt+Y and Enter: Employee Center").
 */

export type QbShortcutGroup =
  | 'navigate'
  | 'data-fields'
  | 'date-fields'
  | 'forms'
  | 'lists'
  | 'new-task'
  | 'open-close';

/** Intuit's section headings, in their order. */
export const QB_SHORTCUT_GROUPS: { id: QbShortcutGroup; title: string }[] = [
  { id: 'navigate', title: 'Navigate around QuickBooks' },
  { id: 'data-fields', title: 'Data fields on forms' },
  { id: 'date-fields', title: 'Date fields on forms' },
  { id: 'forms', title: 'Forms and transactions' },
  { id: 'lists', title: 'Lists, centers, registers and reports' },
  { id: 'new-task', title: 'Start a new task anywhere' },
  { id: 'open-close', title: 'Open, set up, and close' },
];

export type QbSource = 'intuit' | 'qbhelp' | 'teachucomp' | 'axpert' | 'fmd' | 'dummies' | 'ironbooks';

export interface QbShortcut {
  /** The keys as QuickBooks writes them ('Ctrl+G', 'Alt+Down'). */
  keys: string;
  /** What QuickBooks says the key does. */
  qb: string;
  group: QbShortcutGroup;
  /** Where the key is documented ('ironbooks' = an Ironbooks key with no QuickBooks equivalent). */
  sources: QbSource[];
  /** done: works in Ironbooks; na: does not apply (`ironbooks` says why). */
  status: 'done' | 'na';
  /** What the key does in Ironbooks, or why it does not apply. */
  ironbooks: string;
  /** Works only in the desktop app (its menus and window), not in a browser. */
  desktopOnly?: boolean;
}

export const QB_SHORTCUTS: QbShortcut[] = [
  // ---- Navigate around QuickBooks ----
  { keys: 'F1', qb: 'Open the Help window', group: 'navigate', sources: ['intuit', 'qbhelp', 'teachucomp'], status: 'done', ironbooks: 'Help for this page ("What is this page?"); it also opens this shortcuts list' },
  { keys: 'Esc', qb: 'Close current window', group: 'navigate', sources: ['intuit', 'qbhelp', 'dummies'], status: 'done', ironbooks: 'Closes the open form or dialog — a changed form first asks "Do you want to record your changes?" (Yes / No / Cancel); with nothing open or selected, closes the window' },
  { keys: 'Ctrl+F4', qb: 'Close active window', group: 'navigate', sources: ['qbhelp', 'axpert', 'fmd'], status: 'done', desktopOnly: true, ironbooks: 'Closes the open form (asking about changes); with none open, closes the window and shows the one before it' },
  { keys: 'Ctrl+Tab / Ctrl+F6', qb: 'Next open window', group: 'navigate', sources: ['axpert', 'fmd'], status: 'done', desktopOnly: true, ironbooks: 'Switches to the next open window (the pages opened this session; Window > Open Window List shows them). On a list with a highlighted name or account, Ctrl+F6 runs its QuickReport instead' },
  { keys: 'Ctrl+Shift+Tab / Ctrl+Shift+F6', qb: 'Previous open window', group: 'navigate', sources: ['axpert'], status: 'done', desktopOnly: true, ironbooks: 'Switches to the previous open window' },
  { keys: 'F2 / Ctrl+1', qb: 'Open the Product Information window (product, company file location, …)', group: 'navigate', sources: ['intuit', 'qbhelp'], status: 'done', ironbooks: 'Product Information: version, company file location and size, and how many accounts, names, items and transactions it holds' },
  { keys: 'F2, then F3', qb: 'Open Tech Help / Technical Info', group: 'navigate', sources: ['intuit'], status: 'done', ironbooks: 'F3 in Product Information shows the technical details (versions, database, data folder)' },
  { keys: 'F3 / Ctrl+2', qb: 'Open the Search window', group: 'navigate', sources: ['intuit'], status: 'done', ironbooks: 'Opens Search (the command bar): customers, vendors, items, accounts, transactions and pages' },
  { keys: 'Ctrl+F', qb: 'Open the Find Transaction window', group: 'navigate', sources: ['intuit', 'qbhelp'], status: 'done', ironbooks: 'Find' },
  { keys: 'Alt', qb: 'Highlight the menu bar (then a letter, or the arrow keys)', group: 'navigate', sources: ['axpert'], status: 'done', desktopOnly: true, ironbooks: 'Press and release Alt: the menu bar takes the keyboard; Left / Right move, Down or Enter opens, Esc goes back' },
  { keys: 'Alt+F / E / V / L / A', qb: 'File, Edit, View, Lists and Favorites menus', group: 'navigate', sources: ['axpert'], status: 'done', desktopOnly: true, ironbooks: 'Opens that menu (Favorites: Alt+A, outside a form — in a form Alt+A is Save & Close)' },
  { keys: 'Alt+C / U / O / Y', qb: 'Company, Customers, Vendors and Employees menus', group: 'navigate', sources: ['axpert'], status: 'done', desktopOnly: true, ironbooks: 'Opens that menu; Enter then opens its first item (Home, Customer Center, Vendor Center, Employee Center)' },
  { keys: 'Alt+B / R / W / H', qb: 'Banking, Reports, Window and Help menus', group: 'navigate', sources: ['axpert'], status: 'done', desktopOnly: true, ironbooks: 'Opens that menu' },
  { keys: 'Ctrl+F1', qb: 'Hide / show the cue cards', group: 'navigate', sources: ['fmd'], status: 'na', ironbooks: 'Ironbooks has no cue cards or icon bar to hide: every page has its "What is this page?" help instead' },

  // ---- Data fields on forms ----
  { keys: '+ / -', qb: 'Increase or decrease the check or form number by one', group: 'data-fields', sources: ['intuit', 'qbhelp', 'teachucomp'], status: 'done', ironbooks: 'Next / previous number in every check, invoice and document number field' },
  { keys: 'Tab / Shift+Tab', qb: 'Next / previous field', group: 'data-fields', sources: ['intuit', 'qbhelp'], status: 'done', ironbooks: "In QuickBooks' order: name, class, template, date, number, …, the lines, memo, then the Save buttons" },
  { keys: 'Enter', qb: 'Record or save a transaction', group: 'data-fields', sources: ['intuit', 'qbhelp', 'teachucomp'], status: 'done', ironbooks: 'Records the form (Save & Close); with "Pressing Enter moves between fields" on (My Preferences) it goes to the next field instead. In a line grid it goes to the next line; in an open list it takes the entry' },
  { keys: 'Ctrl+Z', qb: 'Undo changes made in the field', group: 'data-fields', sources: ['intuit', 'qbhelp', 'teachucomp'], status: 'done', ironbooks: 'Undoes typing in the field — including dates and amounts changed by the QuickBooks keys' },
  { keys: 'Ctrl+C / Ctrl+X / Ctrl+V', qb: 'Copy, cut, paste', group: 'data-fields', sources: ['intuit', 'qbhelp'], status: 'done', ironbooks: 'Copy, cut and paste text' },
  { keys: 'Home / End', qb: 'Beginning / end of the field', group: 'data-fields', sources: ['qbhelp', 'teachucomp'], status: 'done', ironbooks: 'Beginning / end of the field' },
  { keys: 'Del / Backspace', qb: 'Delete the character right / left of the cursor', group: 'data-fields', sources: ['qbhelp', 'teachucomp'], status: 'done', ironbooks: 'Delete the character right / left of the cursor' },
  { keys: 'Home Home / End End', qb: 'Beginning / end of the transaction', group: 'data-fields', sources: ['fmd'], status: 'done', ironbooks: 'Twice quickly: the first / last field of the form' },
  { keys: 'Ctrl+Left / Ctrl+Right', qb: 'Previous / next word in the field', group: 'data-fields', sources: ['qbhelp', 'teachucomp'], status: 'done', ironbooks: 'Previous / next word' },
  { keys: 'Space', qb: 'Mark or unmark a checkbox', group: 'data-fields', sources: ['fmd'], status: 'done', ironbooks: 'Marks or unmarks the checkbox (Pay Bills, Make Deposits, …)' },
  { keys: 'abc, then Tab', qb: 'QuickFill: type the first letters of a name and Tab', group: 'data-fields', sources: ['teachucomp'], status: 'done', ironbooks: 'Every name, item, account and class picker fills in the first match' },

  // ---- Date fields on forms ----
  { keys: 'Alt+Down', qb: 'Open the calendar', group: 'date-fields', sources: ['intuit', 'qbhelp'], status: 'done', ironbooks: 'Opens the date picker' },
  { keys: '+ / -', qb: 'Next day / previous day', group: 'date-fields', sources: ['intuit', 'qbhelp'], status: 'done', ironbooks: 'Next / previous day' },
  { keys: 'T', qb: 'Today', group: 'date-fields', sources: ['intuit', 'qbhelp'], status: 'done', ironbooks: "Today, on the company's calendar" },
  { keys: 'W / K', qb: 'First / last day of the week', group: 'date-fields', sources: ['intuit', 'qbhelp'], status: 'done', ironbooks: 'First / last day of the week' },
  { keys: 'M / H', qb: 'First / last day of the month', group: 'date-fields', sources: ['intuit', 'qbhelp'], status: 'done', ironbooks: 'First / last day of the month' },
  { keys: 'Y / R', qb: 'First / last day of the year', group: 'date-fields', sources: ['intuit', 'qbhelp'], status: 'done', ironbooks: 'First / last day of the year' },
  { keys: '[ / ]', qb: 'Same day last week / next week', group: 'date-fields', sources: ['intuit', 'qbhelp'], status: 'done', ironbooks: 'Same day last / next week' },
  { keys: "; / '", qb: 'Same day last month / next month', group: 'date-fields', sources: ['qbhelp', 'axpert', 'intuit'], status: 'done', ironbooks: 'Same day last / next month (QuickBooks Help: ; back, \' forward)' },

  // ---- Forms and transactions ----
  { keys: 'Ctrl+Ins / Ctrl+Del', qb: 'Insert / delete a transaction line', group: 'forms', sources: ['intuit', 'qbhelp', 'dummies'], status: 'done', ironbooks: 'Inserts a line above / deletes the line (Ctrl+D also deletes the line)' },
  { keys: 'Ctrl+Alt+Y', qb: 'Copy a transaction line (QuickBooks 2018 and later)', group: 'forms', sources: ['intuit', 'teachucomp'], status: 'done', ironbooks: 'Copies the line the cursor is on' },
  { keys: 'Ctrl+Alt+V', qb: 'Paste a transaction line into a blank line', group: 'forms', sources: ['intuit', 'teachucomp'], status: 'done', ironbooks: 'Pastes the copied line into a blank line (into a new one above when the line is not blank)' },
  { keys: 'Up / Down', qb: 'Previous / next transaction line', group: 'forms', sources: ['intuit', 'qbhelp'], status: 'done', ironbooks: 'Previous / next line; on the last line Down or Enter adds one' },
  { keys: 'Ctrl+L', qb: 'Open the full list for the drop-down', group: 'forms', sources: ['intuit', 'qbhelp'], status: 'done', ironbooks: 'Opens the list of the field you are in (Alt+Down too)' },
  { keys: 'Ctrl+U', qb: 'Add the selected list item to the open form (use list item)', group: 'forms', sources: ['intuit', 'qbhelp', 'teachucomp', 'axpert'], status: 'done', ironbooks: "In an open list: takes the highlighted entry. On a list row: uses it (an account's register, a memorized transaction entered, a new invoice for a customer, a new bill for a vendor)" },
  { keys: 'Page Up / Page Down', qb: 'Move between pages on forms and reports', group: 'forms', sources: ['intuit', 'qbhelp'], status: 'done', ironbooks: 'A page up / down' },
  { keys: 'Alt+S', qb: 'Save (the form button: Save & New)', group: 'forms', sources: ['intuit', 'qbhelp', 'teachucomp', 'axpert'], status: 'done', ironbooks: 'Save & New' },
  { keys: 'Alt+A', qb: 'Save & Close', group: 'forms', sources: ['teachucomp', 'axpert'], status: 'done', ironbooks: 'Save & Close' },
  { keys: 'Alt+N', qb: 'Save and go to the next form of the same type', group: 'forms', sources: ['intuit', 'qbhelp', 'axpert'], status: 'done', ironbooks: 'Next saved transaction of the same kind (a changed form asks whether to record it first)' },
  { keys: 'Alt+P', qb: 'Go to the previous form of the same type', group: 'forms', sources: ['intuit', 'axpert'], status: 'done', ironbooks: 'Previous saved transaction of the same kind (from a new form: the latest one)' },
  { keys: 'Alt+R', qb: 'Revert / Clear', group: 'forms', sources: ['ironbooks'], status: 'done', ironbooks: 'Puts a saved transaction back as it was saved, or clears a new one' },
  { keys: 'Ctrl+Enter', qb: 'Record (always)', group: 'forms', sources: ['qbhelp', 'teachucomp', 'dummies'], status: 'done', ironbooks: 'Records the form and opens a new one (Save & New); Ctrl+Alt+S too' },
  { keys: 'Ctrl+S', qb: 'Show list', group: 'forms', sources: ['qbhelp', 'teachucomp'], status: 'na', ironbooks: "Ironbooks keeps Ctrl+S for Save, the Windows key everyone knows; QuickBooks' Show list is the same as Ctrl+L, which works. Intuit's current list no longer has Ctrl+S" },
  { keys: 'Ctrl+P', qb: 'Print the form (or list)', group: 'forms', sources: ['intuit', 'qbhelp', 'dummies'], status: 'done', ironbooks: "Prints the open form, report or selected row (never the browser's own print of the screen)" },
  { keys: 'Ctrl+M', qb: 'Memorize the transaction', group: 'forms', sources: ['intuit', 'qbhelp'], status: 'done', ironbooks: 'Memorizes the open transaction' },
  { keys: 'Ctrl+T', qb: 'Open the Memorized Transaction List', group: 'forms', sources: ['intuit', 'qbhelp'], status: 'done', ironbooks: 'Memorized Transaction List' },
  { keys: 'Ctrl+H', qb: 'Transaction history', group: 'forms', sources: ['intuit', 'qbhelp'], status: 'done', ironbooks: 'History of the open or selected transaction' },
  { keys: 'Ctrl+Y', qb: 'Transaction journal', group: 'forms', sources: ['intuit', 'qbhelp'], status: 'done', ironbooks: 'Journal entry of the open or selected transaction' },
  { keys: 'Ctrl+N', qb: 'New transaction or list item', group: 'forms', sources: ['intuit', 'qbhelp'], status: 'done', ironbooks: 'New (on a list page: a new form)' },

  // ---- Lists, centers, registers and reports ----
  { keys: 'Ctrl+Page Up / Ctrl+Page Down', qb: 'First / last item on a list (previous / next month in a register)', group: 'lists', sources: ['intuit', 'qbhelp'], status: 'done', ironbooks: 'First / last row; in a register, the previous / next month' },
  { keys: 'Up / Down, Home / End', qb: 'Move through a list', group: 'lists', sources: ['qbhelp', 'axpert'], status: 'done', ironbooks: 'Move the highlight; Home / End first / last row' },
  { keys: 'A…Z', qb: 'Type a name to go to it', group: 'lists', sources: ['axpert'], status: 'done', ironbooks: 'Jumps to the first row starting with what you type' },
  { keys: 'Enter', qb: 'QuickZoom on a report / open the list item', group: 'lists', sources: ['qbhelp', 'teachucomp', 'axpert'], status: 'done', ironbooks: 'Opens the highlighted row; on a report, QuickZoom' },
  { keys: 'Left / Right', qb: 'Report column to the left / right', group: 'lists', sources: ['teachucomp', 'qbhelp'], status: 'done', ironbooks: 'Scrolls a wide report or list a column to the left / right' },
  { keys: 'Ctrl+E', qb: 'Edit the list item or the transaction selected in a register', group: 'lists', sources: ['intuit', 'qbhelp'], status: 'done', ironbooks: 'Edits the highlighted row' },
  { keys: 'Ctrl+D', qb: 'Delete the list item or transaction', group: 'lists', sources: ['intuit', 'qbhelp'], status: 'done', ironbooks: 'Deletes (or voids, or makes inactive) the highlighted row, asking first' },
  { keys: 'Ctrl+Q', qb: 'QuickReport on the transaction or list item', group: 'lists', sources: ['qbhelp', 'teachucomp', 'axpert'], status: 'done', ironbooks: 'QuickReport of the highlighted customer, vendor, employee or account' },
  { keys: 'Ctrl+F6 (on a list)', qb: 'Run a QuickReport for an item on a list', group: 'lists', sources: ['intuit'], status: 'done', desktopOnly: true, ironbooks: 'QuickReport of the highlighted name or account (with nothing highlighted: the next window)' },
  { keys: 'Ctrl+R (Chart of Accounts)', qb: "Open the highlighted account's register", group: 'lists', sources: ['axpert'], status: 'done', ironbooks: "The highlighted account's register" },
  { keys: 'Ctrl+O', qb: 'Copy the transaction in a register', group: 'lists', sources: ['qbhelp', 'teachucomp', 'axpert'], status: 'done', ironbooks: 'Copies the highlighted register transaction' },
  { keys: 'Ctrl+V', qb: 'Paste the copied transaction in a register', group: 'lists', sources: ['qbhelp', 'teachucomp'], status: 'done', ironbooks: "Pastes it on the register's blank line, ready to record with Enter" },
  { keys: 'F5', qb: 'Refresh the list (multi-user mode)', group: 'lists', sources: ['intuit', 'axpert'], status: 'done', ironbooks: "Refreshes the window's lists and totals (asks first when a form has typed work)" },

  // ---- Start a new task anywhere ----
  { keys: 'Ctrl+I', qb: 'Create a new invoice', group: 'new-task', sources: ['intuit', 'qbhelp'], status: 'done', ironbooks: 'Create Invoices' },
  { keys: 'Ctrl+W', qb: 'Write a new check', group: 'new-task', sources: ['intuit', 'qbhelp'], status: 'done', ironbooks: 'Write Checks (never closes the window)' },
  { keys: 'Ctrl+J', qb: 'Open the Customer Center', group: 'new-task', sources: ['intuit', 'qbhelp'], status: 'done', ironbooks: 'Customer Center' },
  { keys: 'Ctrl+A', qb: 'Open the Chart of Accounts', group: 'new-task', sources: ['intuit', 'qbhelp'], status: 'done', ironbooks: 'Chart of Accounts (in a text field it selects the text)' },
  { keys: 'Ctrl+R', qb: 'Open an account register', group: 'new-task', sources: ['intuit', 'dummies'], status: 'done', ironbooks: 'Use Register: choose an account — or, on the Chart of Accounts, the highlighted account\'s register (never reloads the window)' },
  { keys: 'Ctrl+G', qb: "From a register: open the transfer account's register", group: 'new-task', sources: ['intuit', 'qbhelp', 'teachucomp', 'dummies'], status: 'done', ironbooks: "Opens the other account's register at the same transaction" },
  { keys: 'Ctrl+K', qb: 'QuickBooks Service Keys (payroll only)', group: 'new-task', sources: ['intuit'], status: 'na', ironbooks: 'Ironbooks payroll is built in, so there are no Intuit service keys; Ctrl+K opens the command bar' },
  { keys: 'Ctrl+R (in a register, QuickBooks 2014 and earlier)', qb: 'Open the split transaction window', group: 'new-task', sources: ['qbhelp'], status: 'na', ironbooks: "Current QuickBooks (Intuit's list) uses Ctrl+R for Use Register, as Ironbooks does; in a register, Enter opens the highlighted transaction with every account it uses (its splits)" },

  // ---- Open, set up, and close ----
  { keys: 'Alt+F4', qb: 'Close QuickBooks', group: 'open-close', sources: ['intuit', 'qbhelp'], status: 'done', desktopOnly: true, ironbooks: 'Closes Ironbooks, saving the company file (asks first when a form has typed work)' },
  { keys: 'Ctrl+Alt+Y (Product Information)', qb: 'Set up YTD amounts for payroll', group: 'open-close', sources: ['intuit'], status: 'done', ironbooks: 'Opens Payroll Setup > year-to-date amounts' },
  { keys: 'Hold Alt while opening', qb: 'Open the company file with no windows open', group: 'open-close', sources: ['intuit', 'qbhelp'], status: 'na', ironbooks: 'Ironbooks never reopens the windows from last time — a company file always opens on the Home page' },
  { keys: 'Hold Ctrl while starting', qb: 'Start QuickBooks without opening a company file', group: 'open-close', sources: ['qbhelp', 'teachucomp'], status: 'na', ironbooks: 'A desktop app cannot read held keys before its window exists; File > Close Company shows the No Company Open window' },
  { keys: 'Alt+F4 (Help window)', qb: 'Close the Help window', group: 'open-close', sources: ['teachucomp'], status: 'na', ironbooks: 'The Help window is a dialog inside Ironbooks: Esc closes it (Alt+F4 closes Ironbooks itself)' },
  { keys: 'Cmd keys (QuickBooks Desktop for Mac)', qb: 'The Mac edition uses Cmd and its own keys (Cmd+Shift+V Vendor Center, …)', group: 'open-close', sources: ['intuit'], status: 'na', ironbooks: 'Ironbooks follows QuickBooks Desktop for Windows; on a Mac, Cmd works wherever these lists say Ctrl' },

  // ---- Ironbooks keys with no QuickBooks equivalent ----
  { keys: 'Ctrl+K', qb: '—', group: 'navigate', sources: ['ironbooks'], status: 'done', ironbooks: 'Command bar: search, or type what you want to do ("invoice Acme 250")' },
  { keys: '?', qb: '—', group: 'navigate', sources: ['ironbooks'], status: 'done', ironbooks: 'This list of keyboard shortcuts' },
  { keys: 'Ctrl+S', qb: '—', group: 'forms', sources: ['ironbooks'], status: 'done', ironbooks: 'Save the open form' },
  { keys: 'Alt+underlined letter', qb: '—', group: 'forms', sources: ['ironbooks'], status: 'done', ironbooks: 'Presses that button' },
  { keys: 'Alt+Left / Alt+Right', qb: '—', group: 'navigate', sources: ['ironbooks'], status: 'done', desktopOnly: true, ironbooks: 'Window > Back / Forward (asks first when a form has typed work)' },
];

/** The rows the shortcuts help shows: everything that works, in Intuit's groups. */
export function shortcutsHelpGroups(opts: { desktop: boolean }): { id: QbShortcutGroup; title: string; rows: QbShortcut[] }[] {
  return QB_SHORTCUT_GROUPS.map((g) => ({
    ...g,
    rows: QB_SHORTCUTS.filter((s) => s.group === g.id && s.status === 'done' && (opts.desktop || !s.desktopOnly)),
  })).filter((g) => g.rows.length > 0);
}
