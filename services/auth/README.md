# Auth service

Owns the login: registration, email verification, password hashing, sessions,
and the audit trail of who tried to sign in and from where. It does **not** own
the profile — that lives in `services/user`, and this service calls it once an
account is verified.

Port `4005`, owns the `auth` Postgres schema, error-first (`[error, data]`)
throughout — same conventions as `services/user` and `services/email`.

## Why it is built this way

Three decisions shape almost everything else.

**Two token types, on purpose.** The access token is a signed JWT: verifying it
is pure computation, so any service can check it on every request without a
database. The price is that it cannot be revoked, so it lives 15 minutes and
carries no authority beyond that. The refresh token is the opposite — an opaque
random string with no claims and no signature, useful only as a lookup key into
`refresh_tokens`. That is exactly what makes it revocable, and revocation is why
the *long-lived* credential is the one with a database row behind it.

**Nothing that matters is stored in a form that can be replayed.** Passwords are
argon2id. Refresh tokens and verification codes are SHA-256. A dump of every
table in this schema yields nothing an attacker can present at the door.

**The service never says whether an address has an account.** Login, resend and
forgot-password answer identically whether or not the account exists — including
in *timing*, which is why a login for an unknown address still runs an argon2
hash before answering. An endpoint that distinguishes them is a free membership
oracle: point it at a leaked address list and it sorts your users out of it. The
one deliberate exception is registration, which returns a 409 for a duplicate
email, because the alternative makes the sign-up form unusable for the majority
of people who simply forgot they had an account.

## Registration flow

The interesting part is the hand-off to the user service, which cannot be
transactional — a database transaction cannot span an HTTP call to a different
service.

```
POST /auth/register
  ├─ BEGIN                                    (no network call inside)
  │    INSERT auth_users        verified=false, pending_profile={name,address,phone}
  │    INSERT verifications     code_hash=sha256(code), 15 min
  │  COMMIT
  └─ POST email-service /emails               after the commit, non-fatal
     └─ 201 { user, emailQueued }

POST /auth/verify-email  { email, code }
  ├─ BEGIN
  │    UPDATE verifications  status=VERIFIED
  │    UPDATE auth_users     verified=true
  │  COMMIT                                   ← the account is now verified
  ├─ POST user-service /users {authUserId, name, email, address, phone}
  │    └─ UPDATE auth_users  user_id=…, pending_profile=NULL
  └─ 200 { user, tokens, profileCreated }
```

`profileCreated: false` is a real answer, not an error. If the user service is
down, the account is still verified and the user is still signed in — they just
have no profile yet. **Every login retries the hand-off**, so the gap closes by
itself. That is compensation, not a distributed transaction, and it is the same
philosophy as `inventory_items.product_id` in the product service: consistency
across a service boundary is eventual and enforced by retry.

A 409 from the user service is treated as *success*: it means an earlier
hand-off committed there but its response was lost, so the profile is looked up
and attached rather than re-created.

### Why `pending_profile` is a `Json` column

The user service requires `name`, `address` and `phone`, and none of them are
this service's business. Holding them as three typed columns would mean a
migration here every time that service adds a field. As Json, this service
carries them without understanding them, and drops them the moment they are
delivered. They are validated at the edge — against that service's constraints —
so a bad phone number is a 422 while the user is still looking at the form,
rather than a failed hand-off fifteen minutes later.

## Tables

### `auth_users` — the login

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `uuid` | What other services know this account by |
| `email` | `varchar(320)` unique | Lower-cased; RFC 5321 maximum |
| `username` | `varchar(50)` unique | Lower-cased. A display handle — you log in with `email` |
| `passwordHash` | `varchar(255)` | Argon2id. Named for what it holds so no line of code ever *looks* like it compares a plaintext password |
| `role` | `USER \| ADMIN` | Stamped into the access token |
| `status` | `ACTIVE \| SUSPENDED \| DELETED` | |
| `verified` / `verifiedAt` | | |
| `userId` | `text` unique, nullable | Soft reference to `user.users.id`. Null until the hand-off succeeds |
| `pendingProfile` | `jsonb` nullable | Profile in transit; cleared on hand-off |
| `failedLoginAttempts` / `lockedUntil` | | Incremented **by Postgres**, never read-modify-write — see below |
| `lastLoginAt`, `passwordChangedAt`, `createdAt`, `updatedAt` | | |

`verified` and `status` are separate on purpose. One answers "did they prove
they own the mailbox", the other "is this account allowed to exist". Collapsing
them makes "suspended" and "never confirmed" indistinguishable, and those need
very different messages.

### `verifications` — one-time codes

| Column | Type | Notes |
| --- | --- | --- |
| `authUserId` | `uuid` | Cascades |
| `codeHash` | `varchar(64)` | SHA-256, not argon2 — see below |
| `type` | `EMAIL_VERIFICATION \| PASSWORD_RESET \| EMAIL_CHANGE` | |
| `status` | `PENDING \| VERIFIED \| EXPIRED \| REVOKED` | One-way out of `PENDING` |
| `newEmail` | `varchar(320)` nullable | `EMAIL_CHANGE` only |
| `attempts` / `maxAttempts` | `int` | Ceiling copied at issue time |
| `issuedAt` / `expiresAt` / `verifiedAt` | | |
| `emailMessageId` | `text` nullable | The email service's receipt. **Null is the row an operator wants**: the code was issued but never handed to the mail service |

Six digits is a million possibilities — brute-forceable in isolation. It is
never in isolation: a 15-minute expiry, an attempt ceiling that burns the code
after 5 wrong guesses, and a resend cooldown. Remove any one and the other two
stop being enough.

SHA-256 rather than argon2 is deliberate. A slow hash defends a *low-entropy*
secret; a six-digit code that lives 15 minutes is defended by the counter and
the clock instead. SHA-256 keeps a leaked row from being directly replayable,
which is the whole job, at a cost that lets `verify` stay fast.

### `login_history` — append-only audit

| Column | Type | Notes |
| --- | --- | --- |
| `authUserId` | `uuid` **nullable** | Null when the attempt named an address with no account — those rows are the credential-stuffing signal, and dropping them hides the attack |
| `email` | `varchar(320)` | As submitted. Kept even when the account is known, because an account can change its email and this must still say what was typed that day |
| `success` / `outcome` | | `SUCCESS \| INVALID_CREDENTIALS \| UNKNOWN_EMAIL \| NOT_VERIFIED \| ACCOUNT_LOCKED \| ACCOUNT_INACTIVE` |
| `attempt` | `int` | Which consecutive attempt this was |
| `ip` | `varchar(45)` | Full IPv6 width. Trustworthy only because `trust proxy` is on and this sits behind the gateway |
| `userAgent` | `varchar(512)` | Truncated at the edge |
| `loginAt` | | |

**The response is vague; this table is not.** The client is told "invalid email
or password" for every credential failure, but the real cause is recorded here —
otherwise an operator investigating a lockout has nothing to work with. Never
updated after insert: an audit trail that gets edited is not one.

Email verification writes a `SUCCESS` row too, because it hands out a session.
A session with no row here is one the user cannot account for.

### `refresh_tokens` — one row per live session

| Column | Type | Notes |
| --- | --- | --- |
| `tokenHash` | `varchar(64)` unique | SHA-256. The token itself is returned once and never stored |
| `familyId` | `uuid` | A login and everything rotated from it — see below |
| `expiresAt` / `revokedAt` / `revokedReason` | | `ROTATED \| LOGOUT \| LOGOUT_ALL \| PASSWORD_CHANGED \| REUSE_DETECTED` |
| `replacedById` | `uuid` nullable | Makes the rotation chain walkable |
| `ip` / `userAgent` | | So "sign out my other devices" can show something recognisable |

## Rotation and reuse detection

Every refresh mints a new token and kills the one presented. So if a **dead**
token is ever presented again, two copies were in circulation — the legitimate
client's and someone else's. There is no way to tell which one just called, so
the entire family is revoked and both are forced to sign in again. Losing a
session is a cheap price for cutting off a stolen one.

```
login ──► T1 (family F)
          T1 ──refresh──► T2   T1 revoked ROTATED
          T2 ──refresh──► T3   T2 revoked ROTATED
          T1 ──refresh──► ✗    two copies existed
                               └─► every token in family F revoked REUSE_DETECTED
```

Each login opens its own family, so revoking a compromised session leaves the
user's other devices alone.

The `revokedAt: null` guard in the rotation transaction is what makes this
reliable: two concurrent refreshes of the same token both look live in the
service layer, but only one matches in the database. The other updates zero
rows and mints nothing — so "a used token was presented again" is genuine theft
evidence, not a race between two browser tabs.

## Lockout

Five consecutive failures locks the account for 15 minutes. Two details matter:

- **The counter is incremented by Postgres** (`{ increment: 1 }`), not by
  read-modify-write. Counting in application code loses increments under
  concurrency, which is the exact condition a lockout exists to detect — an
  attacker running parallel guesses would hold the counter permanently below the
  threshold.
- **The lock expires.** A lock only an operator can clear hands anyone who knows
  an email address a way to lock its owner out on demand.

The lock check runs *after* the password is verified, so it is only ever
reported to someone who already proved they know the password. A wrong password
gets the same generic 401 either way.

## Endpoints

Base path `/api/v1/auth`.

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `POST` | `/register` | — | `201`. Body carries the profile the user service will need |
| `POST` | `/verify-email` | — | `200` + tokens. Creates the profile |
| `POST` | `/resend-verification` | — | `202` **always** |
| `POST` | `/login` | — | `200` + tokens |
| `POST` | `/refresh` | refresh token | Rotates. Deliberately not behind `authenticate` — it must work *after* the access token expires |
| `POST` | `/logout` | refresh token | `204`, idempotent |
| `POST` | `/forgot-password` | — | `202` **always** |
| `POST` | `/reset-password` | code | Revokes every session |
| `GET` | `/me` | access token | |
| `POST` | `/change-password` | access token | Requires the current password too |
| `GET` | `/sessions` | access token | Live sessions, current one flagged |
| `POST` | `/logout-all` | access token | |
| `GET` | `/login-history` | access token | Paginated, filterable by `outcome` |

`authenticate` is mounted with `router.use` rather than per route, so anything
added below that line is protected whether or not its author remembered to
protect it. One visible consequence: an unknown path under `/auth` answers 401
rather than 404 to an anonymous caller. That is the fail-closed direction.

### Using the access token from another service

Verification needs no database — copy `lib/tokens.ts` and
`middlewares/authenticate.ts`, share `JWT_SECRET`, `JWT_ISSUER`, `JWT_AUDIENCE`.
The claims are `sub` (auth user id), `email`, `username`, `role`, `sid` (session
family).

Be clear-eyed about what that check cannot see: **a revocation.** An account
suspended thirty seconds ago still passes until its token expires. That window
is `ACCESS_TOKEN_TTL_MINUTES`, which is why it is 15 and why `status` and
`verified` are re-checked on every refresh, where a database is already in hand.

## Configuration

Everything is in `.env.example` with the reasoning inline. The one that has no
default and never will:

```bash
# Required in every environment, including development. A fallback here would
# mean a deploy that forgot to set it comes up healthy and signs real tokens
# with a key published on GitHub.
JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")
```

`argon2` is a native module. It is listed in the root `pnpm-workspace.yaml`
under `onlyBuiltDependencies` so its install script can fetch a prebuilt binary
for the platform.

## Running it

```bash
cp services/auth/.env.example services/auth/.env   # then set JWT_SECRET
pnpm --filter @services/auth db:generate
pnpm --filter @services/auth db:migrate
pnpm --filter @services/auth dev
```

The email and user services are optional for development: registration reports
`emailQueued: false` when the mail service is unreachable, and verification
reports `profileCreated: false` when the user service is. Both are recoverable —
resend, and the next login, respectively.

## Tests

```bash
pnpm --filter @services/auth test
```

93 tests, no database and no other service required. The service layer depends
on the `AuthRepository`, `EmailClient` and `UserClient` *interfaces*, so the
tests substitute in-memory implementations and drive the whole HTTP stack
through supertest.

That matters more here than elsewhere: the behaviour worth testing in this
service is policy — does a lockout actually lock, does a reused refresh token
really cut the family, do two different failures really produce byte-identical
responses — and none of it needs a real Postgres to be wrong. The in-memory
doubles reproduce the real repository's concurrency guards (`status: PENDING`,
`revokedAt: null`) precisely so those paths are exercised rather than assumed.
