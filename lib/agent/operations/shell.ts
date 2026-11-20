/**
 * Agent full access: the operations that are not API routes (plan §5.5 and §5.7): what the desktop
 * shell carries out (new, open, switch company, Save Copy As, restore, sandbox, hosting, updates,
 * printing), and what the server does itself (saving a staged file to a folder).
 * The registry merges these in as operations of kind 'shell'.
 */
import type { ShellOperationDef } from '../contract';

export const SHELL_OPERATIONS: readonly ShellOperationDef[] = [];
