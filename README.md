# JSS PDA Hostel

Hostel administration and accounting for independent communities, based on the application-level plan dated 10 November 2026. React/TypeScript frontend, Express API, Supabase PostgreSQL/Auth/private Storage, and Vercel hosting.

**Live:** https://hostel360-nine.vercel.app

The core operational workflows are deployed. Treat this as a pilot until hostel staff approve the billing policies, reconcile their migrated data and complete acceptance testing. It is not a claim that every configurable master-data screen in the planning document has been delivered.

## Community access (new version; production rollout pending)

1. Choose **Create a community**, enter its name and your own name/email/password. Verify your email if prompted, then submit the same form again. The creator becomes its Admin. There is no private setup key in community mode.
2. Open **Operations → Accounts** and share the community code or link. The code selects the community; it does not grant access.
3. Managers and Students choose **Join a community**, enter that code and their own details, and request a role. Their account stays Pending; no community records, documents, exports or backups are accessible.
4. Only that community’s Admin can approve/reject requests in **Operations → Accounts → Manage**. Rejecting requires a reason. Approved members can later be disabled or re-enabled. Public requests cannot select Admin.
5. For Students, link the correct existing student record or leave it unlinked. An approved, unlinked Student can submit an admission application; membership approval and admission approval are separate decisions.
6. Sign in with a community code, email and password. Use **Change community** to sign out and choose another. The same personal identity can join several communities with different roles, but each Admin must approve its membership separately.

Passwords belong to people, not communities. Community Admins cannot create/reset other people’s passwords or grant themselves access to someone else’s community. A password change through **My account** invalidates sessions in every community. Pending/rejected/disabled members may sign in only to see their own access status (and change their own password through the API), not business records.

Production (https://hostel360-nine.vercel.app) serves a single hostel, JSS Polytechnic for Differently Abled Students (community code `jss-pda`), with online payments in Razorpay Test Mode. Set `HOSTEL_COMMUNITY=jss-pda` on the server: creating communities, the community search and every other community code are then refused. Students and Managers register from the sign-in page and the Admin approves them. The UI's fixed hostel is `HOSTEL` in `src/lib.ts`.

## Implemented workflows

- Server-enforced roles, student privacy, inactive-account denial, rate-limited sign-in, eight-hour hashed sessions, secure HTTP-only cookies, forced temporary-password replacement and session revocation.
- Student/application submission, review remarks, approval/rejection, one-time conversion, personal/academic/guardian details, room history, exits and private PDF/JPEG/PNG documents (2 MB maximum).
- Daily bulk attendance with missing-entry tracking, corrections and audit; Admin-only monthly preview/finalization, stale-preview rejection, incomplete-period checks, stored calculation inputs and period locking, including zero-charge months.
- Academic-year fee components for Fund, Management and Establishment; freshers-only caution deposits and B.E.-only Management application fees; preview/finalize without issuing a component twice for the same academic year.
- Explicit full/partial/multi-month allocations, Cash/UPI/Bank, payment dates and references, atomic idempotent confirmation, per-category sequential receipts, immutable receipt snapshots and print / browser Save as PDF.
- Admin-only payment reversals and demand adjustments with required reasons. Original financial amounts and receipts remain traceable; reversals reopen balances.
- Reviewed Excel student/opening-balance import with all-or-nothing commit and duplicate revalidation, XLSX exports, fee statements, collection/reversal reports, operational registers, print layouts and audit history.
- Consistent JSON data archives and private Storage snapshots. Vercel daily cron is scheduled at 02:00 IST; Hobby-plan execution can start within that hour. Manual backups are also available.

## Provisional operating policies

Confirm these with hostel staff before using real money:

1. Mess charges are Present days × the configured daily rate. Absent/Leave days are free. Joining and exit dates are inclusive. A month must be over and attendance complete before finalization. Holiday/exemption policy is not separately configured.
2. Staff select allocations explicitly. One payment covers one category, potentially several months/components, and produces one consolidated receipt.
3. Each category has its own continuous receipt sequence, without annual resets. The production smoke test used disposable records; test users, financial entries and uploaded files were removed.
4. Managers start admission reviews; Admin makes final admission decisions. Manager and Student community memberships also require Admin approval.
5. Admission components are issued once per student, component and academic year. Semester-based recurring charges and caution-deposit refund processing need a confirmed policy and additional implementation.

## Local development

Requires Node.js 24.13+ and npm. Multi-community mode requires PostgreSQL. The SQLite demo remains a single-hostel demonstration and does not simulate PostgreSQL row-level security or community onboarding.

```sh
npm ci
npm run dev
npm test
npm run build
```

The API and Vite UI share port 3000 (`PORT` overrides it). Development SQLite is `data/hostel360.sqlite` (`DATABASE_PATH` overrides it), with fictional demo records. Demo accounts: `admin@hostel360.demo`, `manager@hostel360.demo`, `student@hostel360.demo`; password `JSS PDA HostelDemo!`. Never enable demo mode against production data.

`DEMO_MODE=true npm start` serves the compiled local demonstration. `DEMO_MODE=false` disables seeding. `DATABASE_URL` selects PostgreSQL. `npm run dev` does not watch backend files: restart it after server changes; Vite reloads frontend edits.

For a community preview, apply both SQL migrations to a disposable PostgreSQL database, grant a restricted application role the permissions below, and set `DATABASE_URL` to that role. Without Supabase environment variables, local development uses password hashes in the private identity table; Vercel always requires Supabase Auth. Do not reuse preview accounts/data in production.

## Deployment configuration

The production project is `hostel360` on Vercel, using the dedicated JSS PDA Hostel Supabase project `mtxznwjxiruaxopepudr`, not StreetWatch's database.

Server-only encrypted Vercel environment variables: `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_CA`, `CRON_SECRET`, and `COOKIE_SECURE=true`. `BOOTSTRAP_TOKEN` is obsolete after community rollout. Never use a `VITE_` prefix for credentials. Use the transaction pooler, TLS certificate validation, and a dedicated limited database login; never use an owner, superuser or BYPASSRLS connection for the running application.

`supabase/migrations/20261111000000_hostel360.sql` creates the private schema; `20261111010000_communities.sql` adds communities, shared identities, membership decisions and forced row-level security on all 17 business tables. Composite foreign keys prevent cross-community references. Requests select a community by code and each database query uses transaction-local context, which is safe with the Supabase transaction pooler. No context means no business rows.

The application login needs schema USAGE, SELECT/INSERT/UPDATE on application tables (including the new `communities`, `identities`, `onboarding_attempts`) and USAGE/SELECT on identity sequences (including `communities_id_seq`). DELETE is needed only on `sessions`, `login_attempts`, `onboarding_attempts`. Do not grant browser roles schema access, or the application DDL, role administration, financial/audit DELETE, or RLS bypass. Create private Storage buckets `student-documents` and `finance-backups`; only the server service key accesses them. Migrations and grants must be applied by an authorized database administrator, not on function startup.

Rollout requires explicit approval: back up the database/Auth/Storage, arrange a maintenance window, apply the community migration and restricted-role grants, then deploy the new server/UI together. The previous server is not compatible with the migrated schema. Read community 1’s assigned code from `hostel360.communities` and provide it to its existing Admin. Configure Supabase Auth’s Site URL to the production site, enable public email signup, and configure a production SMTP provider/appropriate email limits before inviting real users; verification email delivery is not covered by local tests. Verify creating two communities and approval/isolation on the deployed app before inviting users. Do not roll back only the server; database recovery requires the pre-migration backup.

`api/index.ts` is the Vercel entry point; `vercel.json` supplies API/SPA routing and the authenticated daily backup cron. Deploy from the repository with the Vercel CLI or connect the Git repository. An independent source-control commit/push is still needed for the current working tree; a CLI deployment does not save code to Git.

## Backups and restore

Download an independent copy of backups regularly. Archives include ledger/profile data and document metadata, **not document bytes, sessions or Auth passwords**. Back up Storage files separately and retain control of Supabase Auth. Snapshots are retained until an approved retention policy is implemented; there is no automatic pruning. Provider downtime, quotas or paused free projects can prevent scheduled backups; check the Backups screen regularly.

Community archives use version 2, include only that community’s records and membership decisions, and store new files under `communities/<id>/…`. Community 1 retains access to its legacy `daily/` backups. The cron enumerates communities and saves a separate archive for each.

`scripts/restore.ts` restores one archive into an already-migrated, empty PostgreSQL database using `DATABASE_URL` and, for Supabase TLS, `SUPABASE_DB_CA`. It refuses to overwrite existing records and restores identity sequences. Community restores require a database administrator with BYPASSRLS; a restricted connection fails rather than treating invisible rows as an empty database. It preserves community IDs and rebuilds identity references without passwords. It is a single-archive disaster-recovery tool, not a merge/import into an existing multi-community deployment. Use provider database backups for whole-service recovery. Restoring to a new Supabase project also requires reprovisioning Auth identities and restoring document files; Auth IDs from another project cannot authenticate automatically.

## Verification and remaining launch work

- `npm test`: 11 passing HTTP contract tests on SQLite. The same suite passes against disposable PostgreSQL using `TEST_DATABASE_URL='postgresql:///hostel360_test?host=/var/run/postgresql' npm test`. The test database name must end in `_test`; its application schema is replaced.
- `COMMUNITY_TEST_DATABASE_URL='postgresql:///hostel360_communities_test?host=/var/run/postgresql' npm test` additionally exercises migration preservation, pending/approved/rejected/disabled memberships, Admin-only approval, shared identities/password revocation, simultaneous community ledgers, receipts, exports, default-deny RLS and cross-community foreign keys. Create a NOLOGIN/NOSUPERUSER/NOBYPASSRLS role `hostel360_community_test` (or `COMMUNITY_TEST_ROLE`) and grant membership to the test database owner first. The test role must not own the schema. This replaces only the disposable database’s `hostel360` schema; keep it separate from the legacy workflow test database.
- `npm run build`: TypeScript and Vite succeed. ExcelJS is lazy-loaded; its chunk generates Vite's size warning.
- Live Vercel/Supabase checks exercised activation guards, Auth, secure cookies, permissions, imports, partial payments/idempotency/reversal, private document download, password changes, disabled-user revocation, backups and logout. Disposable records were removed.
- A live-created backup restored correctly into isolated PostgreSQL, retaining a 137,500-paise demand, 37,500-paise reversed payment and its allocation. A second restore was correctly refused.
- Local PostgreSQL benchmark: 1,200 students imported in 196 ms; 37,200 attendance entries saved through 31 daily HTTP requests in 1,074 ms; monthly preview/finalization in 84 ms; 682 KiB workspace response in 19 ms. These are one local run, not production network/concurrency guarantees or a multi-year load test.
- Browser checks cover main role screens, admissions, account forms and narrow layouts. Further staff pilot testing is still required.

Remaining plan gaps: configurable room/department/class/academic-year master lists and capacity controls; full organization branding/address/bank settings; applicant corrections/resubmission; import filename/history UI; dedicated monthly attendance summaries; server-side ledger pagination for multi-year growth. Current workspace loading fetches all permitted ledger rows together, so large histories may hit Vercel response limits. Role permissions and payment modes are fixed rather than an editable permission/mode matrix. PDF output uses the browser Print / Save as PDF flow rather than server-generated PDF downloads. No online payment gateway, SMS or biometric attendance is included. Community ownership transfer, additional Admin invitations and self-service forgotten-password recovery are not included in this rollout.

## Registration and Admins

Students, Managers and Admins register from the sign-in page. Every registration stays Pending, with no access to records, until an existing Admin approves it under Operations → Accounts. An approved Admin cannot be disabled by another Admin.

**Required, not yet live: email verification for every registration.** The code exists (`EMAIL_VERIFICATION=on` sends a Supabase one-time code that must be entered before an account is created), but production has no SMTP provider. To finish: connect an SMTP provider (for example Brevo) in Supabase Auth, put `{{ .Token }}` in the Magic Link email template, raise the email rate limit, then set `EMAIL_VERIFICATION=on` on Vercel. The local branch `admin-registration` also has an emailed-code flow for Admin approval that can reuse the same setup.

## Online payments (Razorpay)

Students pay one fee category at a time by UPI or card. The server always charges the full outstanding balance of that category; verified payments create a receipt, allocate it to the demands and mark fully settled fees Paid.

- Apply `supabase/migrations/20261115010000_gateway.sql` and `20261115020000_payment_recovery.sql` as the schema owner.
- Grant the runtime role: `GRANT SELECT,INSERT,UPDATE ON hostel360.gateway_orders, hostel360.gateway_refunds TO hostel360_app; GRANT UPDATE (refunded_amount) ON hostel360.allocations TO hostel360_app;` Without the column grant every settlement fails with `permission denied` (42501).
- Set the encrypted Vercel variable `RAZORPAY_COMMUNITIES`, a JSON object keyed by community id, or `"*"` for a merchant shared by every community without its own entry: `{"*":{"key_id":"rzp_test_...","key_secret":"...","webhook_secret":"...","enabled":true}}`. Switching to `rzp_live_` keys is the only change needed for real money.
- Optional webhook: `https://<site>/api/gateway/webhook/<community-code>?key_id=<key_id>` with events `payment.authorized`, `payment.captured`, `order.paid`, `refund.created`, `refund.processed`, `refund.failed`.
- UPI appears in checkout only when it is enabled on the Razorpay account.
- Mess money to the Mess bank account: enable Razorpay Route, add the Mess account as a Linked Account, and add its id to the merchant entry as `"mess_account":"acc_..."`. Mess fee payments and meal tokens are then transferred to it in full; Management, Fund and Establishment settle to the merchant's own (Admission) account. Refund a Mess payment from the Razorpay Dashboard with its transfer reversed.
