/**
 * Users & Roles request schemas (team users). Routes: app/api/users/**, app/api/roles/**.
 */
import { z } from 'zod';
import { ACTIONS, AREA_KEYS, FLAGS } from '@/lib/permissions/model';

const login = z
  .string()
  .trim()
  .min(1, 'is required')
  .max(255)
  .regex(/^\S+$/, 'cannot contain spaces');

export const passwordSchema = z
  .string()
  .min(8, 'must be at least 8 characters')
  .max(200);

const roleKeys = z.array(z.string().min(1).max(64)).min(1, 'assign at least one role').max(30);

export const createUserSchema = z.object({
  name: z.string().trim().min(1, 'is required').max(255),
  login,
  password: passwordSchema.optional(),
  roleKeys,
});

export const updateUserSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    login: login.optional(),
    roleKeys: roleKeys.optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export const resetPasswordSchema = z.object({ password: passwordSchema });

/** POST /api/auth/login body. `email` is the login (an email address or a plain user name). */
export const loginSchema = z.object({
  email: z.string().trim().min(1, 'is required').max(255),
  password: z.string().min(1, 'is required').max(200),
  totp: z.union([z.string(), z.number()]).optional().nullable(),
});

const grantAction = z.enum([...ACTIONS, 'full'] as [string, ...string[]]);
export const permissionGrantSchema = z
  .record(z.string(), z.array(grantAction))
  .superRefine((v, ctx) => {
    for (const k of Object.keys(v)) {
      if (!(AREA_KEYS as string[]).includes(k)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `unknown permission area '${k}'` });
      }
    }
  });

export const roleFlagsSchema = z
  .object(
    Object.fromEntries(FLAGS.map((f) => [f.key, z.boolean().optional()])) as Record<
      string,
      z.ZodOptional<z.ZodBoolean>
    >,
  )
  .strict();

export const createRoleSchema = z.union([
  z.object({
    cloneFrom: z.string().min(1).max(64),
    name: z.string().trim().min(1).max(100),
    description: z.string().max(500).optional(),
  }),
  z.object({
    name: z.string().trim().min(1, 'is required').max(100),
    description: z.string().max(500).optional(),
    permissions: permissionGrantSchema,
    flags: roleFlagsSchema.default({}),
  }),
]);

export const updateRoleSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().max(500).optional(),
    permissions: permissionGrantSchema.optional(),
    flags: roleFlagsSchema.optional(),
  })
  .strict();
