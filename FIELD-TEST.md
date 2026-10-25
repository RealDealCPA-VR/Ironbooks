# Ironbooks Two-PC Field Test

Run this once on two office computers and a shared folder to confirm Ironbooks 1.6.0 handles a
company file on a file server the way QuickBooks Desktop does. It takes about 45 minutes. Tick
each box when the result matches; write down anything that doesn't.

## 1. Before you start

You need two Windows computers on the same office network (called **PC A** and **PC B** below)
and a shared folder both can open, such as `\\SERVER\Books` or a mapped `S:` drive. Use a new
test company, not your real books.

- [ ] Ironbooks 1.6.0 is installed on both PCs (Help > About shows 1.6.0).
- [ ] Both PCs can open the shared folder in File Explorer and create a file in it.
- [ ] On PC A: File > New Company, save it in the shared folder as **Field Test.ironbooks**.
- [ ] Set up the Admin user name, password and challenge question when asked. Write the password down.
- [ ] On PC A: Company > Users & Roles, add a second user (for example **Bob**) with a password, for PC B to use.
- [ ] In File Explorer, `Field Test.ironbooks` is one file in the shared folder.

## 2. The lock

PC A stays in Field Test the whole time.

- [ ] On PC B, open Field Test (double-click it in File Explorer, or File > Open or Restore
  Company). Ironbooks says the file is open, naming PC A's user and computer, with **Ask to Come
  In** and **Cancel**. It does not open the file.
- [ ] On PC B, choose **Ask to Come In**. PC B shows an "Asking…" window with Cancel.
- [ ] Within about 10 seconds PC A shows "*user* wants to open Field Test", with **Let Them In**,
  **Hand It Over** and **Not Now**.
- [ ] On PC A, choose **Not Now**. PC B is told the answer and is not let in.
- [ ] On PC B, ask again, then press **Cancel** on the "Asking…" window before PC A answers.
  Within a few seconds the question on PC A closes by itself, and PC A keeps the file.

## 3. Working together (multi-user mode)

- [ ] On PC B, ask to come in again. On PC A, choose **Let Them In** (leave the checkbox clear).
- [ ] If Windows on PC A asks whether Ironbooks may use the network, choose **Allow** for private
  networks. Note whether it asked.
- [ ] PC B restarts Ironbooks connected to PC A and shows the sign-in box for Field Test. Bob
  signs in with his own password.
- [ ] On PC A, enter an invoice for $100. On PC B, open the invoice list: the $100 invoice is there.
- [ ] On PC B, enter an invoice for $200. On PC A, the $200 invoice is there.
- [ ] On PC A, File > Multi-user status shows Bob as signed in from another computer.
- [ ] On PC A, File > Switch to Single-user Mode. Ironbooks warns that someone is working in the
  file and will be disconnected. Choose **Cancel**: Bob keeps working.
- [ ] On PC B, close Ironbooks. Wait 5 minutes, then on PC A choose File > Switch to Single-user
  Mode: it switches without the warning.

## 4. Handing the file over

Start with PC A in Field Test in single-user mode and Ironbooks closed on PC B.

- [ ] On PC B, open Field Test and ask to come in. On PC A, choose **Hand It Over**.
- [ ] PC A saves, closes the company file and shows No Company Open.
- [ ] Without anyone touching PC B, it opens Field Test, shows the sign-in box, and Bob signs in.
- [ ] Both invoices from section 3 are there on PC B.
- [ ] On PC A, open Field Test: now PC A is the one told that Bob has it open.

## 5. Saving, crashes and network drops

Nothing typed should be lost, and the file on the server should never be damaged.

- [ ] Enter a transaction. Within a few seconds the title bar says **Saved**.
- [ ] Enter another transaction and, within 2 seconds, end Ironbooks in Task Manager. Open Field
  Test again on the same PC: Ironbooks says it recovered your unsaved work, and the transaction is there.
- [ ] With Field Test open on PC A, unplug PC A's network cable (or turn Wi-Fi off) for 30 seconds
  while entering a transaction, then reconnect. The title bar returns to **Saved**; the
  transaction is there after closing and reopening.
- [ ] With Field Test open on PC A, turn PC A off without closing Ironbooks (hold the power
  button). On PC B, open Field Test straight away: it says PC A has it open.
- [ ] About 2 minutes later, open it on PC B again: it says PC A stopped responding and offers
  **Open It Here**. Choose it; the file opens on PC B.
- [ ] Close Field Test on PC B, turn PC A back on and open Field Test there. If PC A had unsaved
  changes, Ironbooks offers to keep them as a separate company file named "… unsaved changes …"
  next to Field Test, then opens the file as PC B saved it. Nothing PC B entered is overwritten.

## 6. Passwords travel with the file

- [ ] Close Field Test everywhere. Copy `Field Test.ironbooks` to a USB drive or another folder,
  and open the copy on PC B.
- [ ] It asks for a user name and password before showing anything, and names the company and
  the file's location.
- [ ] A wrong password is refused. The Admin password from section 1 works.
- [ ] Choose **I forgot my password**: it asks the Admin's challenge question, and the right
  answer lets you set a new password.
- [ ] Open the original on the server again: the password you just changed in the copy did not
  change there (each file keeps its own users).

## 7. Keyboard

Do this section without touching the mouse.

- [ ] **Ctrl+I** opens Create Invoices. **Tab** moves through the fields in order.
- [ ] In the date field, **+** and **-** move a day, **T** is today.
- [ ] **Alt+S** saves the invoice and starts a new one. Enter and save a second invoice.
- [ ] **Alt+P** shows the previous invoice, **Alt+N** the next one.
- [ ] Change an amount, then **Alt+R** puts the saved invoice back.
- [ ] **Ctrl+Y** shows the invoice's journal entry.
- [ ] **Esc** closes the form. **Ctrl+W** opens Write Checks, **Ctrl+J** the Customer Center,
  **Ctrl+A** the Chart of Accounts.
- [ ] In a list, the arrow keys move the highlight, typing a name jumps to it, and **Enter** opens it.
- [ ] **?** shows every shortcut. Note any QuickBooks key you reached for that did something different.

## 8. Download and install

Use a PC that has never had Ironbooks, if you have one.

- [ ] In Edge, download **Ironbooks-Setup-1.6.0.exe** from
  [the latest release](https://github.com/RealDealCPA-VR/Ironbooks/releases/latest). Note exactly
  what the browser and Windows say. Until signing is set up, Windows shows "Windows protected your
  PC": choose **More info**, then **Run anyway**.
- [ ] The installer finishes without errors, and Ironbooks opens to the welcome screen.
- [ ] Double-clicking a `.ironbooks` file in File Explorer opens it in Ironbooks.
- [ ] Once the winget listing is approved, `winget install RealDealCPA-VR.Ironbooks` in a terminal
  installs it with no Windows warning.
- [ ] Help > Check for Updates says Ironbooks is up to date.

## 9. When something doesn't match

Write one row per problem, take a screenshot (**Windows+Shift+S**), and post them as an issue on
[GitHub](https://github.com/RealDealCPA-VR/Ironbooks/issues/new).

| Step | PC | Time | What you did | What you expected | What happened |
| --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |
|  |  |  |  |  |  |
|  |  |  |  |  |  |

Don't delete or move the hidden `Field Test.ironbooks.lock` folder next to the file while
testing: it is how the two PCs know who is in the file.
