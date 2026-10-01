# Example: feature task

Synthetic. The repository and its paths are invented; only the shape matters.

**Request.** "Customers should be able to export their invoices."

**Grounding found.** Invoices are listed by `src/billing/invoices/list-handler` and
rendered by `web/billing/invoice-list`. Reports already export to a spreadsheet file
through `src/reports/export/`, which streams rows and enforces a row limit from the
project's configuration. The rules forbid the web layer from reading billing storage
directly. The product context does not say which invoice fields customers may see.

**Result.**

```markdown
**Type:** Feature

## Description
Customers can see their invoices but cannot take them out of the product, so they copy
them by hand into their accounting tools. They need to export the invoices they are
allowed to see to a spreadsheet file.

## Expected result
From the invoice list, a customer downloads a spreadsheet with the invoices matching
the current filters, one row per invoice.

## Acceptance criteria
- [ ] The invoice list offers an export action to customers with access to billing.
- [ ] The file contains exactly the invoices matching the active filters (integration test).
- [ ] Each row has invoice number, issue date, due date, status and total (integration test).
- [ ] With no invoice matching the filters, the export produces a file with headers only.
- [ ] A customer never receives another customer's invoices (integration test).
- [ ] Above the configured row limit, the user is told to narrow the filters instead of
      receiving a truncated file.
- [ ] The existing invoice list and its filters behave as before (existing tests pass).

## Technical context
- Follow the report export in `src/reports/export/`: streamed rows, configured row limit.
- Query through `src/billing/invoices/`; the web layer must not read billing storage
  directly (architecture rules).
- New: an export entry point next to `src/billing/invoices/list-handler`.
- Open question: which invoice fields customers may see is not defined in the product
  context; the columns above are a proposal to confirm.
```
