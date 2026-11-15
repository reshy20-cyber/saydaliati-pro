# SAYDALIATI PRO V4.14 — offline draft and integration audit

## Scope
- Preserves original index.html and header image.
- POS draft stores only IDs and quantities locally. No invoice, payment, or stock write is created offline.
- Revalidates restored draft against the next available stock snapshot.
- Clears draft after confirmed online transaction, not after failed transaction.

## Safety limitations
- Offline transactions, inventory reconciliation, and cross-device conflict resolution are **NOT implemented**.
- Firestore Auth and security rules were **NOT live tested**.
- Do not use this build in a real pharmacy or deploy as production.
- Browser storage can be cleared by device settings; drafts are not durable financial records.
- The original project lacks a reliable automated end-to-end test harness; static tests are not substitutes.
