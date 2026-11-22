/**
 * Zod schemas for Billing Groups, the named lists of customers Batch Invoicing bills at once
 * (POST /api/billing-groups, PATCH /api/billing-groups/:id; lib/services/billingGroups.ts).
 *
 * The routes pass the fields to the service, which checks each with its own words ("Give the
 * billing group a name."), so every field here is zLenient: the check refuses nothing and says
 * what each field is, for agents (describe_operation, plan §6.3).
 */
import { z } from 'zod';
import { zLenient, zUuid } from './helpers';

const customerIdList = () => z.array(zUuid).nullable();

/** POST /api/billing-groups — add a group. */
export const createBillingGroupSchema = z.object({
  name: zLenient(z.string()).describe('Required. Name of the group, unique among billing groups (at most 100 characters), such as "Monthly retainers".'),
  customerIds: zLenient(customerIdList()).describe('Ids of the customers in the group (customer list), at most 2,000; leave out to start it empty.'),
});

/** PATCH /api/billing-groups/:id — rename a group, replace its customers, or add to them. */
export const updateBillingGroupSchema = z.object({
  name: zLenient(z.string()).describe('New name of the group (unique, at most 100 characters); leave out to keep the name.'),
  customerIds: zLenient(customerIdList()).describe(
    'Ids of all the customers of the group (customer list), replacing the ones it has; leave out to keep them. Not used when addCustomerIds is sent.',
  ),
  addCustomerIds: zLenient(customerIdList()).describe(
    'Ids of customers to add to the group (customer list); the ones it has stay. When sent, customerIds is not used.',
  ),
});
