# Start here

From nothing to working books in about ten minutes. Each step names the screen to open; inside
Ironbooks you can also press **Ctrl+K** and type what you want to do.

## 1. Install

1. Download **`Ironbooks-Setup-x.y.z.exe`** from the
   [latest release](https://github.com/RealDealCPA-VR/Ironbooks/releases/latest). The portable
   `Ironbooks-x.y.z.exe` runs without installing.
2. Double-click it. It installs for your Windows user only (no admin password) and puts an
   **Ironbooks** icon on your Desktop.
3. If Windows says "Windows protected your PC", check that the publisher reads
   **RealDealCPA.Ai LLC**, then choose **More info** and **Run anyway**.

macOS and Linux: build from source for now. See [INSTALL.md](../INSTALL.md).

## 2. Make or open your company

The start screen offers three choices:

| You have… | Choose | Then |
|---|---|---|
| Nothing yet | **Create a new company…** | Pick a name and folder for the company file, then answer the Setup Interview. Only the company name is required. |
| An Ironbooks file or backup | **Open or restore a company file…** | Pick the `.ironbooks` file (or a backup) and sign in. |
| Books in QuickBooks Desktop | **Convert from QuickBooks…** | Follow the three steps: lists, history, open invoices and bills. [Guide](./guide/coming-from-quickbooks.md#migrate-from-quickbooks) |

Your whole company is **one file**, for example `Acme Plumbing.ironbooks`. Keep it on this
computer, a USB drive or the office file server. Nothing leaves your computer unless you turn
that on. [More about the company file](./guide/getting-started.md#company-file)

## 3. Connect your AI (optional, two minutes)

Ironbooks works without AI. With a model connected, **Ask AI** answers in full sentences,
categorizes bank lines it has not seen before, and drafts entries for you to approve.

Open **Company > AI & Automation** (`/ai-settings`) and pick one:

- **Set up free AI on this computer.** One click on Windows: Ironbooks installs Ollama, downloads
  a starter model and connects it. Nothing leaves your PC.
- **Continue with ChatGPT.** Sign in with your ChatGPT Plus or Pro plan in your browser. No API
  key and no extra bill. Then turn on **Allow cloud AI for this company**.

You can use both: the local model answers first. [Full guide](./guide/ai-and-automation.md#connect-ai)

## 4. Your first week

| Task | Open | Guide |
|---|---|---|
| Bring in bank transactions (statement file, no bank login) | Banking › Bank Feeds | [How](./guide/banking.md#import-bank-statement) |
| Categorize them | Banking › Review bank transactions | [How](./guide/banking.md#review-bank-transactions) |
| Invoice a customer | Sales › Invoices | [How](./guide/customers-and-sales.md#create-invoice) |
| Record a customer payment | Sales › Receive Payments | [How](./guide/customers-and-sales.md#got-paid) |
| Enter and pay a bill | Purchases › Enter Bills, Pay Bills | [How](./guide/vendors-and-purchases.md#paying-bills) |
| Reconcile against the statement | Banking › Reconcile | [How](./guide/banking.md#reconcile-monthly) |
| See how you did | Reports › Profit & Loss | [How](./guide/reports.md#profit-and-loss) |
| Turn on backups | Setup › Back Up & Restore | [How](./guide/company-file-backup-users.md#back-up) |

Not sure what to do next? **Home** and **Needs attention** list what is waiting on you, most
urgent first.

## 5. Getting help without leaving the app

- **Ask AI** (top bar). Ask in your own words: "How do I reconcile my bank account?", "Where do
  I enter a bill?", "Who owes us money?". How-to answers come from the built-in guide and end
  with a button that opens the right screen. Questions about your numbers are answered from
  your own reports, and each figure names its report. Ask AI cannot change your books: anything
  it drafts waits for your approval.
- **Ctrl+K**. Type a task ("I got paid", "pay a bill") or a screen name, including the
  QuickBooks name.
- **Help & Glossary** (`/help`). Every guide in this folder, searchable, plus the glossary.
- **?** on any page lists the keyboard shortcuts. The **?** bubble beside a page title says what
  that page is for.
- **Try it on a copy** (`/sandbox`). Practice on a throwaway copy of your books.

Without a connected model, Ask AI still answers how-to questions from the built-in guide and
basic questions about your numbers.

## Where to read more

- [The user guide](./guide/README.md): every how-to, by area.
- [Every screen](./guide/screens.md) and [QuickBooks names](./guide/quickbooks-names.md).
- [Glossary](./guide/glossary.md).
- [PRIVACY.md](../PRIVACY.md): exactly what can leave your computer, and the switch for each.
- Building or changing Ironbooks, or pointing a coding agent at it: [docs/agents](./agents/README.md).
