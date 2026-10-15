> **⚠️ HISTORICAL DOCUMENT — December 2025 planning, NOT the current architecture.**
> This spec describes a cloud SaaS design (Vercel/Neon, NextAuth, multi-tenant) that was never built.
> The app shipped instead as an offline **Electron + PGlite** desktop application.
> See [README.md](README.md) for the current architecture, [INSTALL.md](INSTALL.md) for setup, and [TODO.md](TODO.md) for the roadmap.

# Ironbooks - White Label Accounting SaaS

## Project Overview

Ironbooks is a white-label QuickBooks alternative built with Next.js, featuring native .QBO file support and autonomous LLM-powered error correction. This application enables businesses to manage their accounting with intelligent automation that detects and fixes common bookkeeping errors.

## Core Technology Stack

- **Frontend**: Next.js 14+ (App Router), TypeScript, Tailwind CSS, shadcn/ui
- **Backend**: Next.js API Routes, Server Actions
- **Database**: PostgreSQL (Neon), Drizzle ORM
- **Authentication**: NextAuth.js
- **File Processing**: xml2js, fast-xml-parser
- **LLM Integration**: Anthropic Claude API
- **Deployment**: Vercel (frontend), Neon (database)

## Key Features

### 1. Core Accounting Functionality
- **Chart of Accounts**: Full CRUD for account management (Assets, Liabilities, Equity, Revenue, Expenses)
- **Double-Entry Bookkeeping**: Automatic validation ensuring debits = credits
- **Journal Entries**: Manual and automated journal entry creation
- **Transaction Management**: Full transaction lifecycle (create, edit, void, delete)
- **Bank Reconciliation**: Match imported transactions with bank statements
- **Financial Reports**: 
  - Profit & Loss Statement
  - Balance Sheet
  - Cash Flow Statement
  - Trial Balance
  - General Ledger

### 2. QBO File Support
- **Import Formats**:
  - .QBO (QuickBooks Online Backup)
  - .QBX (QuickBooks Backup)
  - .IIF (Intuit Interchange Format)
  - .OFX (Open Financial Exchange)
- **Export Formats**:
  - .QBO for QuickBooks compatibility
  - .CSV for spreadsheet analysis
  - .PDF for reports
- **Features**:
  - Batch import with progress tracking
  - Account mapping (map imported accounts to chart of accounts)
  - Duplicate detection
  - Transaction validation before import

### 3. LLM-Powered Error Correction
- **Error Detection**:
  - Duplicate transactions
  - Mismatched account types
  - Unbalanced journal entries
  - Missing required fields
  - Unusual transaction patterns
  - Incorrect categorization
  - Date inconsistencies
- **Autonomous Correction**:
  - LLM analyzes errors with accounting context
  - Suggests corrections with explanations
  - Applies fixes with human-in-the-loop approval
  - Maintains complete audit trail
- **Learning System**:
  - Learns from user corrections
  - Improves categorization over time
  - Adapts to business-specific patterns

### 4. Autonomous Agent System
Adapted from Claude's autonomous coding pattern:
- **Session Management**: Long-running import/correction sessions
- **Progress Tracking**: feature_list.json style tracking for batch operations
- **Security**: Sandboxed file operations, allowlist-based command execution
- **Resumability**: Can pause and resume large imports

## Database Schema

### Users & Companies
```typescript
users
  - id (uuid, pk)
  - email (unique)
  - name
  - created_at
  - updated_at

companies
  - id (uuid, pk)
  - name
  - owner_id (fk -> users)
  - settings (jsonb)
  - created_at
  - updated_at

user_companies (many-to-many)
  - user_id (fk -> users)
  - company_id (fk -> companies)
  - role (owner, admin, accountant, viewer)
```

### Chart of Accounts
```typescript
accounts
  - id (uuid, pk)
  - company_id (fk -> companies)
  - code (string, unique per company)
  - name
  - type (asset, liability, equity, revenue, expense)
  - subtype (checking, accounts_receivable, etc.)
  - parent_id (fk -> accounts, nullable for hierarchy)
  - balance (decimal)
  - is_active (boolean)
  - created_at
  - updated_at
```

### Transactions & Journal Entries
```typescript
journal_entries
  - id (uuid, pk)
  - company_id (fk -> companies)
  - entry_number (auto-increment per company)
  - date
  - description
  - reference (invoice #, check #, etc.)
  - status (draft, posted, void)
  - created_by (fk -> users)
  - created_at
  - updated_at

journal_entry_lines
  - id (uuid, pk)
  - journal_entry_id (fk -> journal_entries)
  - account_id (fk -> accounts)
  - debit (decimal, nullable)
  - credit (decimal, nullable)
  - memo
  - created_at
```

### Reconciliation
```typescript
bank_accounts
  - id (uuid, pk)
  - company_id (fk -> companies)
  - account_id (fk -> accounts)
  - bank_name
  - account_number (encrypted)
  - last_reconciled_date
  - last_reconciled_balance

reconciliations
  - id (uuid, pk)
  - bank_account_id (fk -> bank_accounts)
  - statement_date
  - statement_balance
  - reconciled_balance
  - status (in_progress, completed)
  - created_by (fk -> users)
  - created_at
  - completed_at

reconciliation_items
  - id (uuid, pk)
  - reconciliation_id (fk -> reconciliations)
  - journal_entry_line_id (fk -> journal_entry_lines)
  - is_cleared (boolean)
  - cleared_date
```

### File Imports & Audit
```typescript
file_imports
  - id (uuid, pk)
  - company_id (fk -> companies)
  - filename
  - file_type (qbo, qbx, iif, ofx)
  - status (pending, processing, completed, failed)
  - total_transactions
  - imported_transactions
  - failed_transactions
  - error_log (jsonb)
  - uploaded_by (fk -> users)
  - created_at
  - completed_at

audit_logs
  - id (uuid, pk)
  - company_id (fk -> companies)
  - user_id (fk -> users, nullable for system actions)
  - action (create, update, delete, void, llm_correction)
  - entity_type (account, journal_entry, etc.)
  - entity_id (uuid)
  - old_values (jsonb)
  - new_values (jsonb)
  - llm_reasoning (text, nullable)
  - created_at
```

### LLM Error Correction
```typescript
error_detections
  - id (uuid, pk)
  - company_id (fk -> companies)
  - journal_entry_id (fk -> journal_entries, nullable)
  - error_type (duplicate, unbalanced, miscategorized, etc.)
  - severity (low, medium, high, critical)
  - description
  - detected_at
  - resolved_at (nullable)

error_corrections
  - id (uuid, pk)
  - error_detection_id (fk -> error_detections)
  - suggested_by (system, llm, user)
  - correction_type (merge, delete, recategorize, adjust)
  - correction_data (jsonb)
  - llm_reasoning (text, nullable)
  - status (pending, approved, rejected, applied)
  - reviewed_by (fk -> users, nullable)
  - created_at
  - applied_at (nullable)
```

## API Routes

### Authentication
- `POST /api/auth/signup` - Register new user
- `POST /api/auth/signin` - Login
- `POST /api/auth/signout` - Logout

### Companies
- `GET /api/companies` - List user's companies
- `POST /api/companies` - Create company
- `GET /api/companies/[id]` - Get company details
- `PATCH /api/companies/[id]` - Update company
- `DELETE /api/companies/[id]` - Delete company

### Accounts
- `GET /api/companies/[id]/accounts` - List chart of accounts
- `POST /api/companies/[id]/accounts` - Create account
- `PATCH /api/accounts/[id]` - Update account
- `DELETE /api/accounts/[id]` - Delete account

### Journal Entries
- `GET /api/companies/[id]/journal-entries` - List entries (with filters)
- `POST /api/companies/[id]/journal-entries` - Create entry
- `GET /api/journal-entries/[id]` - Get entry details
- `PATCH /api/journal-entries/[id]` - Update entry
- `POST /api/journal-entries/[id]/void` - Void entry
- `DELETE /api/journal-entries/[id]` - Delete entry

### File Import
- `POST /api/companies/[id]/import` - Upload QBO/QBX/IIF/OFX file
- `GET /api/imports/[id]` - Get import status
- `GET /api/imports/[id]/preview` - Preview transactions before import
- `POST /api/imports/[id]/confirm` - Confirm and execute import
- `POST /api/imports/[id]/map-accounts` - Map imported accounts

### Reports
- `GET /api/companies/[id]/reports/profit-loss` - P&L statement
- `GET /api/companies/[id]/reports/balance-sheet` - Balance sheet
- `GET /api/companies/[id]/reports/cash-flow` - Cash flow statement
- `GET /api/companies/[id]/reports/trial-balance` - Trial balance
- `GET /api/companies/[id]/reports/general-ledger` - General ledger

### LLM Error Correction
- `POST /api/companies/[id]/detect-errors` - Run error detection
- `GET /api/companies/[id]/errors` - List detected errors
- `POST /api/errors/[id]/analyze` - Get LLM analysis and suggestions
- `POST /api/errors/[id]/apply-correction` - Apply suggested correction
- `POST /api/errors/[id]/reject` - Reject suggestion

## UI Pages

### Public
- `/` - Landing page
- `/login` - Login page
- `/signup` - Registration page

### Dashboard
- `/dashboard` - Company selector / overview
- `/dashboard/[companyId]` - Financial dashboard (charts, recent activity)

### Accounting
- `/dashboard/[companyId]/accounts` - Chart of accounts
- `/dashboard/[companyId]/transactions` - Transaction list
- `/dashboard/[companyId]/journal-entries/new` - Create journal entry
- `/dashboard/[companyId]/journal-entries/[id]` - View/edit entry

### Reports
- `/dashboard/[companyId]/reports/profit-loss` - P&L report
- `/dashboard/[companyId]/reports/balance-sheet` - Balance sheet
- `/dashboard/[companyId]/reports/cash-flow` - Cash flow
- `/dashboard/[companyId]/reports/general-ledger` - General ledger

### Import & Reconciliation
- `/dashboard/[companyId]/import` - File upload and import wizard
- `/dashboard/[companyId]/reconcile` - Bank reconciliation

### Error Management
- `/dashboard/[companyId]/errors` - Error dashboard
- `/dashboard/[companyId]/errors/[id]` - Error details and correction

### Settings
- `/dashboard/[companyId]/settings` - Company settings
- `/settings/profile` - User profile

## Autonomous Agent Integration

### Agent Workflow
1. **File Upload**: User uploads .QBO file
2. **Parsing**: Agent parses XML/OFX format
3. **Error Detection**: Scan for common issues
4. **LLM Analysis**: Claude analyzes errors with accounting context
5. **Correction Suggestions**: Present fixes with reasoning
6. **Human Approval**: User reviews and approves
7. **Application**: Apply corrections with audit trail
8. **Import**: Complete transaction import

### Agent Architecture (adapted from Claude quickstart)
```
bookkeeper-ai/
├── agent/
│   ├── autonomous_import.py      # Main import agent
│   ├── error_detector.py         # Error detection logic
│   ├── llm_corrector.py          # LLM integration
│   ├── security.py               # File operation security
│   ├── progress.py               # Progress tracking
│   └── prompts/
│       ├── error_analysis.md     # LLM prompt for error analysis
│       └── correction_prompt.md  # LLM prompt for corrections
```

## Security Considerations

1. **File Upload**: Validate file types, scan for malicious content
2. **Data Isolation**: Strict company-level data separation
3. **Audit Trail**: Log all changes with user attribution
4. **Encryption**: Encrypt sensitive data (bank account numbers)
5. **Role-Based Access**: Owner, Admin, Accountant, Viewer roles
6. **LLM Safety**: Validate LLM suggestions before application
7. **Sandboxed Operations**: File operations in isolated environment

## Development Phases

### Phase 1: Foundation (Current)
- Next.js project setup
- Database schema and migrations
- Authentication system
- Basic UI components

### Phase 2: Core Accounting
- Chart of accounts CRUD
- Journal entry creation
- Double-entry validation
- Basic reports

### Phase 3: File Import
- QBO/QBX parser
- Transaction import
- Account mapping
- Duplicate detection

### Phase 4: LLM Integration
- Error detection service
- Claude API integration
- Correction workflow
- Audit trail

### Phase 5: Advanced Features
- Bank reconciliation
- Advanced reports
- Multi-company support
- Export functionality

### Phase 6: Polish & Deploy
- Testing
- Performance optimization
- Documentation
- Production deployment

## Success Metrics

- Import 1000+ transactions from .QBO file in < 30 seconds
- Detect 95%+ of common accounting errors
- LLM correction accuracy > 90% with human approval
- Support 10,000+ transactions per company
- Sub-second page load times
- 99.9% uptime

## Business Value

This white-label accounting SaaS provides:
1. **Cost Savings**: Eliminate QuickBooks subscription fees
2. **Automation**: Reduce manual bookkeeping by 70%+
3. **Accuracy**: AI-powered error detection and correction
4. **Flexibility**: Customizable for specific business needs
5. **Data Ownership**: Full control over financial data
6. **Integration**: Easy import/export with existing tools

## Next Steps

1. Initialize Next.js project
2. Set up Drizzle ORM and database
3. Create authentication system
4. Build core accounting models
5. Implement QBO parser
6. Integrate Claude API for error correction
7. Build UI with shadcn/ui
8. Test with real-world data
9. Deploy to production
