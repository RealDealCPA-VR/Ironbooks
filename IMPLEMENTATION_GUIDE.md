> **⚠️ HISTORICAL DOCUMENT — December 2025 planning, NOT the current implementation.**
> The phases below target a cloud PostgreSQL/Neon + NextAuth architecture that was never built.
> The app shipped instead as an offline **Electron + PGlite** desktop application.
> See [README.md](README.md) for the current architecture, [INSTALL.md](INSTALL.md) for setup, and [TODO.md](TODO.md) for the roadmap.

# Ironbooks - Implementation Guide

## 🎯 Overview

This guide explains how to complete the Ironbooks implementation, a white-label QuickBooks alternative with .QBO file support and LLM-powered error correction, built using the autonomous coding pattern from Anthropic's Claude quickstart.

## 📋 What's Been Created

### ✅ Completed Foundation

1. **Project Structure**
   - Next.js 15 with App Router and TypeScript
   - Tailwind CSS configuration
   - Drizzle ORM setup with PostgreSQL/Neon
   - Complete database schema for accounting

2. **Database Schema** (`lib/db/schema.ts`)
   - Users and authentication
   - Companies with multi-user support
   - Chart of accounts with hierarchical structure
   - Journal entries with double-entry bookkeeping
   - Bank accounts and reconciliation
   - File import tracking
   - Error detection and correction system
   - Complete audit trail

3. **Documentation**
   - `PROJECT_SPEC.md` - Detailed technical specification
   - `README.md` - User-facing documentation
   - This implementation guide

### 🔨 Next Steps to Complete

## Phase 1: Database Setup (1-2 hours)

### 1.1 Install Drizzle Kit
```bash
cd bookkeeper-ai
npm install -D drizzle-kit
```

### 1.2 Set up Neon Database
1. Go to [neon.tech](https://neon.tech) and create a free account
2. Create a new project
3. Copy the connection string
4. Create `.env.local`:
```env
DATABASE_URL="postgresql://user:password@host/database?sslmode=require"
NEXTAUTH_URL="http://localhost:3000"
NEXTAUTH_SECRET="run: openssl rand -base64 32"
```

AI providers are not configured with environment variables. Each company configures its own
models under **AI & Automation** (Settings): by default a local model server on this computer,
your LAN or your Tailscale tailnet (Ollama, LM Studio, vLLM, llama.cpp). Cloud providers
(Anthropic, OpenAI-compatible APIs) are optional, need an API key entered there (stored
encrypted in the company file), and are used only when the company opts in to cloud AI on both
AI & Automation and **Privacy & Network** (data sent to a cloud model is redacted first).

### 1.3 Push Schema to Database
```bash
npm run db:push
```

## Phase 2: Core Application Structure (2-3 hours)

### 2.1 Create Database Client (`lib/db/index.ts`)
```typescript
import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import * as schema from './schema';

const sql = neon(process.env.DATABASE_URL!);
export const db = drizzle(sql, { schema });
```

### 2.2 Create Utility Functions (`lib/utils.ts`)
```typescript
import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(amount);
}

export function formatDate(date: Date): string {
  return new Intl.DateTimeFormat('en-US').format(date);
}
```

### 2.3 Create Root Layout (`app/layout.tsx`)
```typescript
import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Ironbooks - Smart Accounting Software',
  description: 'White-label accounting software with AI-powered error correction',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={inter.className}>{children}</body>
    </html>
  );
}
```

### 2.4 Create Global Styles (`app/globals.css`)
```css
@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  :root {
    --background: 0 0% 100%;
    --foreground: 222.2 84% 4.9%;
    --card: 0 0% 100%;
    --card-foreground: 222.2 84% 4.9%;
    --popover: 0 0% 100%;
    --popover-foreground: 222.2 84% 4.9%;
    --primary: 222.2 47.4% 11.2%;
    --primary-foreground: 210 40% 98%;
    --secondary: 210 40% 96.1%;
    --secondary-foreground: 222.2 47.4% 11.2%;
    --muted: 210 40% 96.1%;
    --muted-foreground: 215.4 16.3% 46.9%;
    --accent: 210 40% 96.1%;
    --accent-foreground: 222.2 47.4% 11.2%;
    --destructive: 0 84.2% 60.2%;
    --destructive-foreground: 210 40% 98%;
    --border: 214.3 31.8% 91.4%;
    --input: 214.3 31.8% 91.4%;
    --ring: 222.2 84% 4.9%;
    --radius: 0.5rem;
  }
}

@layer base {
  * {
    @apply border-border;
  }
  body {
    @apply bg-background text-foreground;
  }
}
```

## Phase 3: QBO File Parser (3-4 hours)

### 3.1 Create QBO Parser (`lib/qbo/parser.ts`)
```typescript
import { XMLParser } from 'fast-xml-parser';
import { parseString } from 'xml2js';

export interface QBOTransaction {
  date: Date;
  description: string;
  amount: number;
  account: string;
  reference?: string;
  memo?: string;
}

export class QBOParser {
  private parser: XMLParser;

  constructor() {
    this.parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
    });
  }

  async parseQBO(fileContent: string): Promise<QBOTransaction[]> {
    // QBO files are typically OFX format
    const result = this.parser.parse(fileContent);
    
    // Extract transactions from OFX structure
    const transactions: QBOTransaction[] = [];
    
    // Navigate OFX structure: OFX -> BANKMSGSRSV1 -> STMTTRNRS -> STMTRS -> BANKTRANLIST -> STMTTRN
    const bankTransactions = result?.OFX?.BANKMSGSRSV1?.STMTTRNRS?.STMTRS?.BANKTRANLIST?.STMTTRN || [];
    
    for (const txn of Array.isArray(bankTransactions) ? bankTransactions : [bankTransactions]) {
      transactions.push({
        date: this.parseOFXDate(txn.DTPOSTED),
        description: txn.NAME || txn.MEMO || 'Unknown',
        amount: parseFloat(txn.TRNAMT),
        account: txn.FITID, // Transaction ID
        reference: txn.CHECKNUM,
        memo: txn.MEMO,
      });
    }
    
    return transactions;
  }

  private parseOFXDate(ofxDate: string): Date {
    // OFX dates are in format: YYYYMMDDHHMMSS
    const year = parseInt(ofxDate.substring(0, 4));
    const month = parseInt(ofxDate.substring(4, 6)) - 1;
    const day = parseInt(ofxDate.substring(6, 8));
    return new Date(year, month, day);
  }

  async parseIIF(fileContent: string): Promise<QBOTransaction[]> {
    // IIF is tab-delimited format
    const lines = fileContent.split('\n');
    const transactions: QBOTransaction[] = [];
    
    // Parse IIF format (simplified)
    for (const line of lines) {
      if (line.startsWith('TRNS')) {
        const fields = line.split('\t');
        // Parse transaction fields
        // This is a simplified example - real IIF parsing is more complex
      }
    }
    
    return transactions;
  }
}
```

### 3.2 Create Import Service (`lib/qbo/importer.ts`)
```typescript
import { db } from '@/lib/db';
import { fileImports, journalEntries, journalEntryLines, accounts } from '@/lib/db/schema';
import { QBOParser, type QBOTransaction } from './parser';
import { eq } from 'drizzle-orm';

export class ImportService {
  private parser: QBOParser;

  constructor() {
    this.parser = new QBOParser();
  }

  async importFile(
    companyId: string,
    userId: string,
    filename: string,
    fileContent: string,
    fileType: 'qbo' | 'qbx' | 'iif' | 'ofx'
  ) {
    // Create import record
    const [importRecord] = await db.insert(fileImports).values({
      companyId,
      filename,
      fileType,
      status: 'processing',
      uploadedBy: userId,
    }).returning();

    try {
      // Parse file based on type
      let transactions: QBOTransaction[];
      
      if (fileType === 'qbo' || fileType === 'ofx') {
        transactions = await this.parser.parseQBO(fileContent);
      } else if (fileType === 'iif') {
        transactions = await this.parser.parseIIF(fileContent);
      } else {
        throw new Error(`Unsupported file type: ${fileType}`);
      }

      // Import transactions
      let imported = 0;
      let failed = 0;
      const errors: Array<{ line: number; error: string }> = [];

      for (let i = 0; i < transactions.length; i++) {
        try {
          await this.importTransaction(companyId, userId, transactions[i]);
          imported++;
        } catch (error) {
          failed++;
          errors.push({
            line: i + 1,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }

      // Update import record
      await db.update(fileImports)
        .set({
          status: 'completed',
          totalTransactions: transactions.length,
          importedTransactions: imported,
          failedTransactions: failed,
          errorLog: errors,
          completedAt: new Date(),
        })
        .where(eq(fileImports.id, importRecord.id));

      return {
        success: true,
        imported,
        failed,
        errors,
      };
    } catch (error) {
      // Update import record with error
      await db.update(fileImports)
        .set({
          status: 'failed',
          errorLog: [{
            line: 0,
            error: error instanceof Error ? error.message : 'Unknown error',
          }],
          completedAt: new Date(),
        })
        .where(eq(fileImports.id, importRecord.id));

      throw error;
    }
  }

  private async importTransaction(
    companyId: string,
    userId: string,
    transaction: QBOTransaction
  ) {
    // Find or create accounts
    // This is simplified - real implementation would have account mapping
    const [cashAccount] = await db.select()
      .from(accounts)
      .where(eq(accounts.companyId, companyId))
      .limit(1);

    if (!cashAccount) {
      throw new Error('No accounts found for company');
    }

    // Get next entry number
    const lastEntry = await db.select()
      .from(journalEntries)
      .where(eq(journalEntries.companyId, companyId))
      .orderBy(journalEntries.entryNumber)
      .limit(1);

    const entryNumber = (lastEntry[0]?.entryNumber || 0) + 1;

    // Create journal entry
    const [entry] = await db.insert(journalEntries).values({
      companyId,
      entryNumber,
      date: transaction.date,
      description: transaction.description,
      reference: transaction.reference,
      status: 'posted',
      createdBy: userId,
    }).returning();

    // Create journal entry lines (simplified double-entry)
    const isDebit = transaction.amount > 0;
    
    await db.insert(journalEntryLines).values([
      {
        journalEntryId: entry.id,
        accountId: cashAccount.id,
        debit: isDebit ? Math.abs(transaction.amount).toString() : null,
        credit: !isDebit ? Math.abs(transaction.amount).toString() : null,
        memo: transaction.memo,
      },
      // Second line would go to appropriate expense/revenue account
      // This is simplified - real implementation would have proper account mapping
    ]);
  }
}
```

## Phase 4: LLM Error Correction (3-4 hours)

### 4.1 Create Error Detector (`lib/llm/error-detector.ts`)
```typescript
import { db } from '@/lib/db';
import { journalEntries, journalEntryLines, errorDetections, accounts } from '@/lib/db/schema';
import { eq, and, sql } from 'drizzle-orm';

export class ErrorDetector {
  async detectErrors(companyId: string) {
    const errors: Array<{
      type: string;
      severity: string;
      description: string;
      journalEntryId?: string;
    }> = [];

    // Check for unbalanced entries
    const unbalancedEntries = await this.findUnbalancedEntries(companyId);
    errors.push(...unbalancedEntries);

    // Check for duplicates
    const duplicates = await this.findDuplicateTransactions(companyId);
    errors.push(...duplicates);

    // Check for unusual patterns
    const unusual = await this.findUnusualPatterns(companyId);
    errors.push(...unusual);

    // Save errors to database
    for (const error of errors) {
      await db.insert(errorDetections).values({
        companyId,
        journalEntryId: error.journalEntryId,
        errorType: error.type as any,
        severity: error.severity as any,
        description: error.description,
      });
    }

    return errors;
  }

  private async findUnbalancedEntries(companyId: string) {
    const entries = await db
      .select({
        id: journalEntries.id,
        entryNumber: journalEntries.entryNumber,
        description: journalEntries.description,
        totalDebit: sql<number>`SUM(COALESCE(${journalEntryLines.debit}, 0))`,
        totalCredit: sql<number>`SUM(COALESCE(${journalEntryLines.credit}, 0))`,
      })
      .from(journalEntries)
      .leftJoin(journalEntryLines, eq(journalEntries.id, journalEntryLines.journalEntryId))
      .where(eq(journalEntries.companyId, companyId))
      .groupBy(journalEntries.id);

    return entries
      .filter(entry => Math.abs(entry.totalDebit - entry.totalCredit) > 0.01)
      .map(entry => ({
        type: 'unbalanced',
        severity: 'critical',
        description: `Entry #${entry.entryNumber} is unbalanced: Debits=${entry.totalDebit}, Credits=${entry.totalCredit}`,
        journalEntryId: entry.id,
      }));
  }

  private async findDuplicateTransactions(companyId: string) {
    // Find entries with same date, description, and amount
    const duplicates = await db
      .select({
        date: journalEntries.date,
        description: journalEntries.description,
        count: sql<number>`COUNT(*)`,
        ids: sql<string[]>`ARRAY_AGG(${journalEntries.id})`,
      })
      .from(journalEntries)
      .where(eq(journalEntries.companyId, companyId))
      .groupBy(journalEntries.date, journalEntries.description)
      .having(sql`COUNT(*) > 1`);

    return duplicates.map(dup => ({
      type: 'duplicate',
      severity: 'high',
      description: `Possible duplicate transactions on ${dup.date}: "${dup.description}" (${dup.count} occurrences)`,
    }));
  }

  private async findUnusualPatterns(companyId: string) {
    // This would use more sophisticated analysis
    // For now, just a placeholder
    return [];
  }
}
```

### 4.2 Create LLM Corrector (`lib/llm/corrector.ts`)

> **Historical sketch.** The shipped corrector (`lib/services/llmCorrector.ts`) does not read an
> API key from the environment: it calls the per-company AI router (`lib/ai/router.ts`), whose
> providers are configured in AI & Automation (local tailnet models by default) and whose every
> HTTP call is checked against the network policy (`lib/net/guard.ts`).
```typescript
import Anthropic from '@anthropic-ai/sdk';
import { db } from '@/lib/db';
import { errorDetections, errorCorrections } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

export class LLMCorrector {
  private anthropic: Anthropic;

  constructor() {
    this.anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
  }

  async analyzeError(errorId: string) {
    // Get error details
    const [error] = await db
      .select()
      .from(errorDetections)
      .where(eq(errorDetections.id, errorId));

    if (!error) {
      throw new Error('Error not found');
    }

    // Create prompt for Claude
    const prompt = `You are an expert accountant analyzing a bookkeeping error.

Error Type: ${error.errorType}
Severity: ${error.severity}
Description: ${error.description}

Please analyze this error and suggest a correction. Provide:
1. Root cause analysis
2. Recommended correction action
3. Step-by-step fix instructions
4. Potential impact if not fixed

Format your response as JSON with keys: analysis, action, steps, impact`;

    // Call Claude API
    const message = await this.anthropic.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: prompt,
      }],
    });

    const response = message.content[0].type === 'text' 
      ? message.content[0].text 
      : '';

    // Parse response
    let suggestion;
    try {
      suggestion = JSON.parse(response);
    } catch {
      suggestion = { analysis: response };
    }

    // Save correction suggestion
    await db.insert(errorCorrections).values({
      errorDetectionId: errorId,
      suggestedBy: 'llm',
      correctionType: 'auto',
      correctionData: suggestion,
      llmReasoning: response,
      status: 'pending',
    });

    return suggestion;
  }

  async applyCorrection(correctionId: string, userId: string) {
    // Get correction details
    const [correction] = await db
      .select()
      .from(errorCorrections)
      .where(eq(errorCorrections.id, correctionId));

    if (!correction) {
      throw new Error('Correction not found');
    }

    // Apply the correction based on correction type
    // This would contain the actual logic to modify journal entries
    // For now, just mark as applied

    await db.update(errorCorrections)
      .set({
        status: 'applied',
        reviewedBy: userId,
        appliedAt: new Date(),
      })
      .where(eq(errorCorrections.id, correctionId));

    // Mark error as resolved
    await db.update(errorDetections)
      .set({
        resolvedAt: new Date(),
      })
      .where(eq(errorDetections.id, correction.errorDetectionId));

    return { success: true };
  }
}
```

## Phase 5: API Routes (4-5 hours)

Create API routes in `app/api/`:
- `auth/[...nextauth]/route.ts` - NextAuth configuration
- `companies/route.ts` - Company CRUD
- `companies/[id]/accounts/route.ts` - Account management
- `companies/[id]/journal-entries/route.ts` - Journal entries
- `companies/[id]/import/route.ts` - File import
- `companies/[id]/detect-errors/route.ts` - Error detection
- `errors/[id]/analyze/route.ts` - LLM analysis
- `errors/[id]/apply-correction/route.ts` - Apply correction

## Phase 6: Frontend UI (6-8 hours)

Create pages in `app/(dashboard)/`:
- `dashboard/page.tsx` - Main dashboard
- `dashboard/[companyId]/accounts/page.tsx` - Chart of accounts
- `dashboard/[companyId]/transactions/page.tsx` - Transaction list
- `dashboard/[companyId]/import/page.tsx` - File import wizard
- `dashboard/[companyId]/errors/page.tsx` - Error management

## Phase 7: Autonomous Agent System (4-5 hours)

Copy and adapt files from `claude-quickstarts/autonomous-coding/`:
- `agent/autonomous_import.py` - Main import agent
- `agent/error_detector.py` - Error detection
- `agent/llm_corrector.py` - LLM integration
- `agent/security.py` - Security hooks
- `agent/progress.py` - Progress tracking

## 🚀 Quick Start After Setup

```bash
# Install dependencies
npm install

# Set up database
npm run db:push

# Run development server
npm run dev
```

## 📚 Key Resources

- **Drizzle ORM Docs**: https://orm.drizzle.team/
- **Next.js Docs**: https://nextjs.org/docs
- **Anthropic Claude API**: https://docs.anthropic.com/
- **QBO/OFX Format**: https://www.ofx.net/

## 🎯 Testing Strategy

1. **Unit Tests**: Test individual functions (parser, validator, etc.)
2. **Integration Tests**: Test API routes and database operations
3. **E2E Tests**: Test complete workflows (import, error correction)
4. **Sample Data**: Create sample .QBO files for testing

## 🔐 Security Checklist

- [ ] Encrypt sensitive data (bank account numbers)
- [ ] Implement proper authentication
- [ ] Add rate limiting to API routes
- [ ] Validate all file uploads
- [ ] Sanitize LLM outputs before application
- [ ] Implement audit logging
- [ ] Add CSRF protection
- [ ] Use environment variables for secrets

## 📈 Performance Optimization

- [ ] Add database indexes
- [ ] Implement caching (Redis)
- [ ] Optimize queries with Drizzle
- [ ] Use React Server Components
- [ ] Implement pagination
- [ ] Add loading states
- [ ] Optimize bundle size

## 🎨 Customization

To white-label this application:
1. Update branding in `app/layout.tsx`
2. Customize colors in `tailwind.config.ts`
3. Modify chart of accounts defaults
4. Adjust LLM prompts for your use case
5. Add custom reports

## 🐛 Common Issues

**Database connection fails**
- Check DATABASE_URL in .env.local
- Ensure Neon project is active
- Verify SSL mode is set

**File import fails**
- Check file format (must be valid QBO/OFX)
- Verify file size limits
- Check error logs in database

**LLM corrections not working**
- In AI & Automation, run Test Connection on the provider (local tailnet models are the default)
- For a cloud provider, check its API key there and that cloud AI is allowed on Privacy & Network
- Review error logs

## 📞 Support

For implementation help:
1. Review PROJECT_SPEC.md for detailed specs
2. Check code comments
3. Review Claude autonomous coding pattern
4. Test with sample data first

---

**Next Action**: Start with Phase 1 (Database Setup) and work through each phase sequentially. The foundation is solid - now it's time to build!
