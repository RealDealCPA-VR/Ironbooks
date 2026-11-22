/**
 * Zod schema for PATCH /api/account-roles — Company > System Accounts: which account Ironbooks
 * posts to on its own for a role (lib/services/accountRoles.ts setAccountRole).
 *
 * SERVER ONLY: it imports the account roles service for its list of roles.
 */
import { z } from 'zod';
import { ACCOUNT_ROLE_KEYS, type AccountRole } from '@/lib/services/accountRoles';

export const setAccountRoleSchema = z.object({
  role: z
    .enum(ACCOUNT_ROLE_KEYS as [AccountRole, ...AccountRole[]])
    .describe('The role whose account is set, such as accounts_payable or inventory_asset (GET /api/account-roles lists them).'),
  accountId: z
    .string()
    .uuid()
    .nullable()
    .describe(
      "Id of an active account of the right kind (chart of accounts), or null to go back to the automatic choice. Refused while the role's current account still carries a balance.",
    ),
});
