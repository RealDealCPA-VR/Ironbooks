/**
 * Client-side specs for the Lists page editors (components/lists/SimpleListEditor.tsx): which
 * endpoint, which fields, plain-language copy. The server validates everything again
 * (lib/validation/lists.ts + lib/services/lists/simpleLists.ts).
 */
import { describeTerms } from '@/lib/services/lists/termsMath';

export interface FieldSpec {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'email' | 'int' | 'decimal' | 'bool' | 'select';
  required?: boolean;
  max?: number;
  min?: number;
  maxValue?: number;
  placeholder?: string;
  hint?: string;
  default?: unknown;
  /** 'parent' = other entries of the same list. */
  options?: Array<{ value: string; label: string }> | 'parent';
  showIf?: (form: Record<string, unknown>) => boolean;
  sendEmptyAsNull?: boolean;
}

export interface ColumnSpec {
  key: string;
  label: string;
  render?: (row: Record<string, unknown>, all: Array<Record<string, unknown>>) => string;
}

export interface ListSpec {
  key: string;
  label: string;
  singular: string;
  description: string;
  emptyHint?: string;
  endpoint: string;
  responseKey: string;
  supportsInactiveQuery: boolean;
  updateMethod: 'patch' | 'put';
  nameField: string;
  fields: FieldSpec[];
  columns: ColumnSpec[];
  preview?: (form: Record<string, unknown>) => string;
}

const parentName = (row: Record<string, unknown>, all: Array<Record<string, unknown>>) =>
  row.parentId ? String(all.find((a) => a.id === row.parentId)?.name ?? '') : '';

const num = (v: unknown) => (v === '' || v == null ? null : Number(v));

export const LIST_SPECS: ListSpec[] = [
  {
    key: 'terms',
    label: 'Terms',
    singular: 'terms',
    description:
      'Payment terms decide when an invoice or bill is due and whether paying early earns a discount. Pick them on customers and vendors; their documents fill in the due date for you.',
    endpoint: '/api/lists/terms',
    responseKey: 'entries',
    supportsInactiveQuery: true,
    updateMethod: 'patch',
    nameField: 'name',
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true, max: 100, placeholder: 'e.g. Net 45' },
      {
        key: 'kind',
        label: 'How the due date is set',
        type: 'select',
        required: true,
        default: 'standard',
        options: [
          { value: 'standard', label: 'A number of days after the date (standard)' },
          { value: 'date_driven', label: 'A fixed day of the month (date driven)' },
        ],
      },
      { key: 'netDays', label: 'Due in how many days?', type: 'int', min: 0, maxValue: 999, hint: '0 means due on receipt.', showIf: (f) => f.kind !== 'date_driven' },
      { key: 'dueDayOfMonth', label: 'Due on which day of the month?', type: 'int', min: 1, maxValue: 31, showIf: (f) => f.kind === 'date_driven' },
      {
        key: 'dueNextMonthWithinDays',
        label: 'Due the next month if issued within this many days of the due day',
        type: 'int',
        min: 0,
        maxValue: 30,
        showIf: (f) => f.kind === 'date_driven',
      },
      { key: 'discountPercent', label: 'Early-payment discount (%)', type: 'decimal', min: 0, hint: 'Leave empty for no discount.' },
      { key: 'discountDays', label: 'Discount if paid within how many days?', type: 'int', min: 0, maxValue: 999, showIf: (f) => f.kind !== 'date_driven' && !!f.discountPercent },
      { key: 'discountDayOfMonth', label: 'Discount if paid by which day of the month?', type: 'int', min: 1, maxValue: 31, showIf: (f) => f.kind === 'date_driven' && !!f.discountPercent },
    ],
    columns: [
      { key: 'name', label: 'Name' },
      {
        key: 'kind',
        label: 'Meaning',
        render: (r) =>
          describeTerms({
            kind: String(r.kind),
            netDays: r.netDays as number | null,
            discountPercent: r.discountPercent as string | null,
            discountDays: r.discountDays as number | null,
            dueDayOfMonth: r.dueDayOfMonth as number | null,
            dueNextMonthWithinDays: r.dueNextMonthWithinDays as number | null,
            discountDayOfMonth: r.discountDayOfMonth as number | null,
          }),
      },
    ],
    preview: (f) =>
      'Means: ' +
      describeTerms({
        kind: String(f.kind || 'standard'),
        netDays: num(f.netDays),
        discountPercent: (f.discountPercent as string) || null,
        discountDays: num(f.discountDays),
        dueDayOfMonth: num(f.dueDayOfMonth),
        dueNextMonthWithinDays: num(f.dueNextMonthWithinDays),
        discountDayOfMonth: num(f.discountDayOfMonth),
      }),
  },
  {
    key: 'other-names',
    label: 'Other Names',
    singular: 'name',
    description:
      'People and businesses you pay or record that are not customers, vendors or employees — for example an owner taking a draw, or a one-time payee.',
    emptyHint: 'Add a name to use it as a payee on checks and expenses.',
    endpoint: '/api/lists/other-names',
    responseKey: 'entries',
    supportsInactiveQuery: true,
    updateMethod: 'patch',
    nameField: 'name',
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true, max: 255 },
      { key: 'companyName', label: 'Company', type: 'text', max: 255 },
      { key: 'email', label: 'Email', type: 'email', max: 255 },
      { key: 'phone', label: 'Phone', type: 'text', max: 50 },
      { key: 'accountNumber', label: 'Account number', type: 'text', max: 100, hint: 'Printed on checks to this payee (optional).' },
      { key: 'notes', label: 'Notes', type: 'textarea' },
    ],
    columns: [
      { key: 'name', label: 'Name' },
      { key: 'companyName', label: 'Company' },
      { key: 'phone', label: 'Phone' },
      { key: 'email', label: 'Email' },
    ],
  },
  {
    key: 'customer-types',
    label: 'Customer Types',
    singular: 'customer type',
    description: 'Group customers (for example Retail, Wholesale, Referral) to filter reports and price rules.',
    endpoint: '/api/type-lists/customer',
    responseKey: 'types',
    supportsInactiveQuery: false,
    updateMethod: 'put',
    nameField: 'name',
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true, max: 255 },
      { key: 'parentId', label: 'Subtype of', type: 'select', options: 'parent' },
    ],
    columns: [
      { key: 'name', label: 'Name' },
      { key: 'parentId', label: 'Subtype of', render: parentName },
    ],
  },
  {
    key: 'vendor-types',
    label: 'Vendor Types',
    singular: 'vendor type',
    description: 'Group vendors (for example Suppliers, Contractors, Utilities) to filter reports.',
    endpoint: '/api/type-lists/vendor',
    responseKey: 'types',
    supportsInactiveQuery: false,
    updateMethod: 'put',
    nameField: 'name',
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true, max: 255 },
      { key: 'parentId', label: 'Subtype of', type: 'select', options: 'parent' },
    ],
    columns: [
      { key: 'name', label: 'Name' },
      { key: 'parentId', label: 'Subtype of', render: parentName },
    ],
  },
  {
    key: 'job-types',
    label: 'Job Types',
    singular: 'job type',
    description: 'Group jobs (for example New Construction, Repair) to compare how each kind of work performs.',
    endpoint: '/api/lists/job-types',
    responseKey: 'entries',
    supportsInactiveQuery: true,
    updateMethod: 'patch',
    nameField: 'name',
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true, max: 255 },
      { key: 'parentId', label: 'Subtype of', type: 'select', options: 'parent' },
    ],
    columns: [
      { key: 'name', label: 'Name' },
      { key: 'parentId', label: 'Subtype of', render: parentName },
    ],
  },
  {
    key: 'sales-tax-codes',
    label: 'Sales Tax Codes',
    singular: 'sales tax code',
    description:
      'A short code on each customer and item that says whether sales tax applies. "Tax" and "Non" come built in; add your own (for example "Res" for resale) when you need to report why a sale was not taxed.',
    endpoint: '/api/lists/sales-tax-codes',
    responseKey: 'entries',
    supportsInactiveQuery: true,
    updateMethod: 'patch',
    nameField: 'code',
    fields: [
      { key: 'code', label: 'Code (up to 3 letters)', type: 'text', required: true, max: 3 },
      { key: 'description', label: 'Description', type: 'text', max: 255 },
      { key: 'taxable', label: 'Taxable — sales with this code are charged sales tax', type: 'bool', default: true },
    ],
    columns: [
      { key: 'code', label: 'Code' },
      { key: 'description', label: 'Description' },
      { key: 'taxable', label: 'Taxable?', render: (r) => (r.taxable ? 'Yes' : 'No') },
    ],
  },
  {
    key: 'payment-methods',
    label: 'Payment Methods',
    singular: 'payment method',
    description: 'How customers pay you (Visa, Check, Cash…). Each one belongs to a payment kind so deposits and reports group them correctly.',
    endpoint: '/api/lists/payment-methods',
    responseKey: 'entries',
    supportsInactiveQuery: true,
    updateMethod: 'patch',
    nameField: 'name',
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true, max: 100 },
      {
        key: 'type',
        label: 'Kind of payment',
        type: 'select',
        required: true,
        default: 'other',
        options: [
          { value: 'cash', label: 'Cash' },
          { value: 'check', label: 'Check' },
          { value: 'credit_card', label: 'Credit / debit card' },
          { value: 'ach', label: 'ACH / e-check' },
          { value: 'bank_transfer', label: 'Bank transfer' },
          { value: 'other', label: 'Other' },
        ],
      },
    ],
    columns: [
      { key: 'name', label: 'Name' },
      { key: 'type', label: 'Kind', render: (r) => String(r.type).replace('_', ' ') },
    ],
  },
  {
    key: 'ship-via',
    label: 'Ship Via',
    singular: 'shipping method',
    description: 'Carriers and delivery methods to pick on invoices and sales orders.',
    endpoint: '/api/lists/ship-via',
    responseKey: 'entries',
    supportsInactiveQuery: true,
    updateMethod: 'patch',
    nameField: 'name',
    fields: [{ key: 'name', label: 'Name', type: 'text', required: true, max: 100 }],
    columns: [{ key: 'name', label: 'Name' }],
  },
  {
    key: 'customer-messages',
    label: 'Customer Messages',
    singular: 'customer message',
    description: 'Short notes printed at the bottom of invoices and sales receipts, such as "Thank you for your business."',
    endpoint: '/api/lists/customer-messages',
    responseKey: 'entries',
    supportsInactiveQuery: true,
    updateMethod: 'patch',
    nameField: 'message',
    fields: [{ key: 'message', label: 'Message', type: 'textarea', required: true, max: 500 }],
    columns: [{ key: 'message', label: 'Message' }],
  },
  {
    key: 'vehicles',
    label: 'Vehicles',
    singular: 'vehicle',
    description: 'Vehicles you log business mileage for.',
    endpoint: '/api/lists/vehicles',
    responseKey: 'entries',
    supportsInactiveQuery: true,
    updateMethod: 'patch',
    nameField: 'name',
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true, max: 100, placeholder: 'e.g. 2022 Ford Transit' },
      { key: 'description', label: 'Description', type: 'text', max: 255 },
    ],
    columns: [
      { key: 'name', label: 'Name' },
      { key: 'description', label: 'Description' },
    ],
  },
];
