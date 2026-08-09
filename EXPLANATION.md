# auth-service — code walkthrough

How this service is put together, file by file and function by function.

This is the **internals** document. For the request/response contract an API
consumer needs — payload shapes, example bodies, status codes — see
[API-DOCS.md](./API-DOCS.md). This one explains *why the code looks the way it
does*, which is the part that is hard to recover from reading it cold.

---

## 1. What this service owns

auth-service is the only service in the platform that can **issue** an identity.
Everything else only **verifies** one.

| Responsibility | Detail |
| --- | --- |
| User identity | register, login, logout, "who am I" |
| Token lifecycle | issue, rotate, revoke |
| Key distribution | publishes the public half of its RSA key as a JWKS document |
| Tenants | CRUD for restaurants (a tenant *is* a restaurant) |
| User administration | admin-only CRUD over users |

The important consequence: catelog-service, order-service and ws-service never
talk to this service at request time. They fetch its **public key** once, cache
it, and validate access tokens locally. auth-service being down does not stop
an already-authenticated user from browsing a menu — it stops them logging in.

---

## 2. The shape of a request

Every request flows through the same layers. Nothing skips a layer.

```
HTTP request
    │
    ├─ app.ts            cors → static → cookieParser → express.json
    │
    ├─ routes/*.ts       matches the path, assembles the middleware chain,
    │                    and holds the dependency wiring
    │
    ├─ middlewares/*     authenticate → canAccess → validator
    │                    (each may end the request early)
    │
    ├─ controllers/*     reads req, calls services, shapes the response.
    │                    No SQL, no bcrypt, no jwt.
    │
    ├─ services/*        business rules. Owns bcrypt, jsonwebtoken, and all
    │                    query construction.
    │
    ├─ repository        TypeORM Repository<Entity>. The only thing that
    │                    touches Postgres.
    │
    └─ globalErrorHandler   catches anything passed to next(err)
```

The rule that keeps this honest: **a controller never imports `bcrypt`,
`jsonwebtoken`, or a repository.** If you find yourself wanting to, the logic
belongs in a service.

---

## 3. Bootstrapping

### `src/server.ts`

The entry point, and deliberately tiny.

```ts
await AppDataSource.initialize();   // connect first
app.listen(PORT, ...)               // only then accept traffic
```

If the database connection fails it logs, waits **1 second**, then
`process.exit(1)`. The delay is not arbitrary — winston's file transports flush
asynchronously, and exiting immediately would discard the very log line
explaining why the process died.

Note `app` and `server` are separate modules. That separation is what lets the
test suite `import app` and drive it with supertest without ever binding a port.

### `src/app.ts`

Builds the Express app. Middleware order matters:

| Order | Middleware | Why here |
| --- | --- | --- |
| 1 | `cors` | must run before anything that can respond |
| 2 | `express.static("public", { dotfiles: "allow" })` | serves the JWKS document |
| 3 | `cookieParser()` | `req.cookies` must exist before `authenticate` reads it |
| 4 | `express.json()` | populates `req.body` for the validators |
| 5 | routers | `/auth`, `/tenants`, `/users` |
| 6 | `globalErrorHandler` | last, so it catches everything above it |

> **`dotfiles: "allow"` is load-bearing.** serve-static 2 (Express 5) defaults to
> `"ignore"`, which 404s any path containing a dot-segment — and the JWKS
> document lives at `/.well-known/jwks.json`. Without this option that endpoint
> returns 404, every other service's `jwks-rsa` client fails to fetch the
> signing key, and no access token can be validated anywhere in the platform.
> serve-static 1 (Express 4) served it, so this only became necessary on the
> Express 5 upgrade. Covered by [`tests/app.spec.ts`](./tests/app.spec.ts).

`ALLOWED_DOMAINS` is `[CLIENT_UI_DOMAIN, ADMIN_UI_DOMAIN]` with
`credentials: true`. Credentials are required because the auth cookies are
`httpOnly` — the browser only attaches them cross-origin when both the server
allows credentials and the client sends them.

### `src/config/index.ts`

Loads `.env.${NODE_ENV}` (defaulting to `dev`) and re-exports the variables as
a frozen-in-practice `Config` object. Everything reads `Config.X` rather than
`process.env.X`, so there is exactly one place that knows the variable names.

### `src/config/data-source.ts`

The TypeORM `DataSource`. Three details worth knowing:

- `synchronize: false`. Schema changes go through migrations, never through
  auto-sync. **Except in tests**, which call `connection.synchronize()`
  explicitly — see §11 for a place where the two schemas disagree.
- `ssl` is enabled whenever `DB_HOST !== "localhost"`, with
  `rejectUnauthorized: false`, which is what managed Postgres (Neon) needs.
- `entities` and `migrations` are **glob strings**, not imports. That is why
  the compiled build must preserve the `src/` directory layout, and why
  `start` is `node dist/src/server.js` rather than `node dist/server.js`.

### `src/config/logger.ts`

winston, JSON format, tagged `serviceName: "auth-service"`. All three
transports are `silent` when `NODE_ENV === "test"` — without that, every test
run would spray log lines through the Jest reporter.

---

## 4. The repository layer

There is no custom repository class. The repository *is* TypeORM's generic
`Repository<Entity>`, obtained at module load in each router:

```ts
const userRepository = AppDataSource.getRepository(User);
const userService = new UserService(userRepository);
const userController = new UserController(userService, logger);
```

Two things follow from this.

**Wiring lives in the routes.** Each router file is the composition root for
its own slice. Nothing else constructs a service.

**Services take a repository, not a DataSource.** `UserService` is handed a
`Repository<User>` and nothing else. That is what makes the unit tests in
[`tests/services/token.spec.ts`](./tests/services/token.spec.ts) possible —
a stub with `save` and `delete` jest mocks satisfies the constructor, and no
database is involved.

The one cost of doing this at module scope: `AppDataSource.getRepository()` runs
at *import* time, before `initialize()`. TypeORM tolerates this because the
repository resolves its connection lazily on first query.

### Entities

**`User`** (`users`)

| Column | Notes |
| --- | --- |
| `id` | generated |
| `firstName`, `lastName` | |
| `email` | `unique: true` — the database is the real duplicate guard |
| `password` | **`select: false`** |
| `role` | plain string, values from `constants.Roles` |
| `tenant` | `@ManyToOne(() => Tenant)`, nullable |

`select: false` on `password` is the single most consequential line in the
entity layer. Every ordinary `find` silently omits the column, which is why
`GET /users`, `GET /users/:id` and `GET /auth/self` cannot leak a hash even by
accident. It is also why login needs a special query — see
`findByEmailWithPassword` below.

**`Tenant`** (`tenants`) — `id`, `name` (varchar 100), `address` (varchar 255),
plus create/update timestamps. Nothing surprising.

**`RefreshToken`** (`refreshTokens`) — `id`, `expiresAt`, and
`@ManyToOne(() => User)`. One row per live session. This table is the entire
revocation mechanism: §9 explains how.

---

## 5. Services

### `UserService`

Constructor: `(private userRepository: Repository<User>)`.

#### `create({ firstName, lastName, email, password, role, tenantId })`

1. Looks up the email. If a user exists, throws `createHttpError(400, "Email is already exists!")`.
2. Hashes the password with bcrypt, **10 salt rounds**.
3. Saves, attaching `tenant: tenantId ? { id: tenantId } : undefined`.

The partial-object trick — `{ id: tenantId }` in place of a full `Tenant` — is
TypeORM's way of setting a foreign key without loading the related row.

The explicit duplicate check ahead of the insert exists to turn a Postgres
unique-violation (which would surface as a 500) into a clean 400. It is a
check-then-act race in theory; the unique index is still the real guarantee.

The `try/catch` around `save` collapses **every** failure into
`500 "Failed to store the data in the database"`, which is convenient for the
client and lossy for the operator — the original error is discarded rather than
re-thrown. The stack still reaches the logs via `globalErrorHandler`, but the
driver's message does not.

#### `findByEmailWithPassword(email)`

The login query, and the reason it is separate:

```ts
select: { id: true, firstName: true, lastName: true,
          email: true, role: true, password: true },
relations: { tenant: true },
```

`password` **must** stay in that list. The column is `select: false`, so
omitting it returns a user whose `password` is `undefined`, `bcrypt.compare`
then rejects every credential, and login fails for everyone with no error to
show for it.

> TypeORM 1.x dropped the older string-array form (`select: ["id", "email"]`).
> This object form is the current API.

#### `findById(id)`

Plain lookup with the `tenant` relation joined. No `password` — `select: false`
handles that. Backs both `GET /auth/self` and `GET /users/:id`.

#### `update(userId, { firstName, lastName, role, email, tenantId })`

`repository.update(...)`, which issues an `UPDATE` and never loads the row.
Consequences worth internalising:

- **Entity hooks and cascades do not run.** Fine here; there are none.
- **A missing id is not an error.** Updating id 9999 affects zero rows and
  resolves normally. The controller does not check `affected`, so the API
  answers `200 { id: 9999 }` for a user that does not exist.
- `tenant: tenantId ? { id: tenantId } : null` — an empty tenant id **clears**
  the relation rather than leaving it alone. That is what lets an admin be
  promoted out of a tenant.
- `password` is not in the signature at all, so this endpoint cannot change a
  password even if one is posted.

#### `getAll(validatedQuery)`

Query-builder based, because it needs `ILIKE` and a count in one round trip.

```ts
CONCAT(user.firstName, ' ', user.lastName) ILIKE :q   OR   user.email ILIKE :q
```

Both are wrapped in `new Brackets(...)`. Without the brackets the later
`.andWhere("user.role = :role")` would bind to only the last `orWhere`, and a
role filter combined with a search would return the wrong rows. This is the
classic SQL precedence bug and the brackets are the fix.

Then `leftJoinAndSelect("user.tenant")`, `skip`, `take`, `orderBy id DESC`, and
`getManyAndCount()` — returning `[rows, total]`, which is exactly the pair the
controller needs for its pagination envelope.

`ILIKE` is Postgres-specific. This service is not portable to another engine
without touching this method.

#### `deleteById(userId)`

`repository.delete(userId)`. Same "no affected check" caveat as `update`.

---

### `TenantService`

The same shape, simpler. `create`, `update`, `getById`, `deleteById` are thin
wrappers over the repository. `getAll` mirrors `UserService.getAll` but searches
`CONCAT(tenant.name, ' ', tenant.address)` and needs no `Brackets`, because
there is only one condition.

---

### `TokenService`

Constructor: `(private refreshTokenRepository: Repository<RefreshToken>)`.

#### `generateAccessToken(payload)`

Reads `certs/private.pem` **synchronously on every call** and signs:

| Option | Value |
| --- | --- |
| algorithm | `RS256` |
| expiresIn | `1d` |
| issuer | `auth-service` |

`RS256` — asymmetric — is the whole design. Only this service holds the private
key; everyone else needs only the public half, so no shared secret is ever
distributed. A leaked key in one downstream service could not mint tokens.

The path is `path.join(__dirname, "../../certs/private.pem")`. From
`dist/src/services/` that resolves to `dist/certs/`, **not** the repo root —
which is why [`scripts/write-certs.mjs`](./scripts/write-certs.mjs) writes the
key to both locations.

A read failure is converted to `500 "Error while reading private key"`. That is
the exact symptom of a deploy that forgot `PRIVATE_KEY_BASE64`: every login and
register 500s while everything else looks healthy.

Re-reading the file per call is a small inefficiency (the OS page cache absorbs
it) with a real benefit — rotating the key does not require a restart.

#### `generateRefreshToken(payload)`

`HS256` against `REFRESH_TOKEN_SECRET`, `expiresIn: "1y"`, and critically:

```ts
jwtid: String(payload.id)
```

Symmetric is correct here because **only auth-service ever verifies a refresh
token**. No other service needs to, so there is nothing to distribute.

The `jti` carries the primary key of the `refreshTokens` row. That is the handle
that makes the token revocable — §9.

#### `persistRefreshToken(user)`

Inserts a row with `expiresAt = now + 365 days` and returns it. The caller needs
the generated `id` to put in the token's `jti`, so the order is always: persist
first, sign second.

> Minor inconsistency: `jsonwebtoken` resolves `"1y"` through `ms`, which counts
> a year as **365.25** days, while this method uses a flat **365**. The row
> therefore lapses about six hours before the token it backs. Harmless as
> written — the row is what gates revocation and it expires first — but the two
> are worth keeping in view.

#### `deleteRefreshToken(tokenId)`

`delete({ id: tokenId })`. One row, one session. Called by logout and by the
rotation step of refresh.

---

### `CredentialService`

One method, `comparePassword(userPassword, passwordHash)`, wrapping
`bcrypt.compare`. It exists so the controller has something injectable to call
instead of importing bcrypt directly, and so password comparison has a single
home if the hashing scheme ever changes.

`bcrypt.compare` is constant-time with respect to the hash, which is the point —
a naive `===` would leak information through timing.

---

## 6. Middlewares

### `authenticate` — is this a valid access token?

`express-jwt` configured with `jwks-rsa`:

```ts
secret: jwksClient.expressJwtSecret({ jwksUri: Config.JWKS_URI, cache: true, rateLimit: true }),
algorithms: ["RS256"],
```

Pinning `algorithms` is a security control, not a formality. Without it a
token could arrive claiming `alg: none`, or `alg: HS256` signed with the
*public* key as its secret — both classic JWT confusion attacks.

`getToken` prefers the `Authorization: Bearer` header, then falls back to the
`accessToken` cookie. The header branch guards against the literal string
`"undefined"`, which is what a client sends when it interpolates a missing
variable — a small but real robustness fix.

On success `req.auth` holds the decoded payload. On failure express-jwt throws
a 401 that `globalErrorHandler` formats.

### `canAccess(roles)` — is this token allowed here?

Reads `req.auth.role`, and if it is not in the allow-list calls
`next(createHttpError(403, "You don't have enough permissions"))`.

Always runs **after** `authenticate` and assumes `req.auth` exists. Matching is
exact and case-sensitive, which is deliberate — a case-insensitive compare
against a value taken straight off a JWT would widen the attack surface for
nothing. Covered by
[`tests/middlewares/can-access.spec.ts`](./tests/middlewares/can-access.spec.ts).

### `validateRefreshToken` — is this refresh token valid *and* still live?

`express-jwt` with `HS256` and `REFRESH_TOKEN_SECRET`, reading the
`refreshToken` cookie — plus an `isRevoked` callback that does the real work:

```ts
const refreshToken = await refreshTokenRepo.findOne({
    where: { id: Number(payload.id), user: { id: Number(payload.sub) } },
});
return refreshToken === null;   // no row  ->  revoked
```

The lookup is keyed on **both** the token id and the user id, so a correctly
signed token that claims someone else's row finds nothing and is rejected.

```ts
const payload = token?.payload as IRefreshTokenPayload & JwtPayload;
```

That cast is not cosmetic. express-jwt types `payload` as `JwtPayload | string`;
reading `.sub` off the un-narrowed union silently resolved to
`String.prototype.sub` — a real function — so `Number(...)` produced `NaN` and
the lookup could never match. The cast is what makes the query work at all.

If the lookup **throws**, the catch logs and returns `true`, i.e. treats the
token as revoked. Failing closed is the right default: a database blip
logs users out rather than letting unverifiable tokens through.

### `parseRefreshToken` — decode without checking revocation

Same secret and same cookie as above, but **no `isRevoked`**. Used only by
logout, where the token is about to be deleted; refusing to decode an
already-revoked token would leave the user unable to complete a logout.

### `globalErrorHandler`

The 4-arity terminal handler. For every error it:

1. mints a `uuid` **reference id**,
2. logs the full message, stack, path and method against that id,
3. responds with the standard envelope.

```ts
let message = "Internal server error";
if (statusCode === 400) message = err.message;
```

Only 400s echo their real message. A 500 carrying
`duplicate key value violates unique constraint "users_email_key"` reveals
schema details, so it is replaced — and the `ref` is how support ties the
sanitised client-facing error back to the full log line. `stack` is `null` in
production and present everywhere else. Covered by
[`tests/middlewares/global-error-handler.spec.ts`](./tests/middlewares/global-error-handler.spec.ts).

---

## 7. Validators

All six use `express-validator`'s `checkSchema`. They **sanitise in place** —
`trim: true` mutates `req.body`, so a controller reading `req.body.name` gets
the trimmed value without asking.

| Validator | Guards | Rules |
| --- | --- | --- |
| `register-validator` | `POST /auth/register` | email required + valid, first/last name required, password ≥ 8 |
| `login-validator` | `POST /auth/login` | email required + valid, password non-empty |
| `create-user-validator` | `POST /users` | as register, plus `role` required |
| `update-user-validator` | `PATCH /users/:id` | first/last name, role, email, and a conditional `tenantId` |
| `tenant-validator` | `POST/PATCH /tenants` | `name` and `address` non-empty |
| `list-users-validator` / `list-tenants-validator` | the list routes | sanitise-only |

The list validators reject nothing. They **coerce**: `currentPage` and `perPage`
go through `Number(...)`, falling back to `1` and `6` when the result is `NaN`,
and `q`/`role` default to `""`. So `?currentPage=banana` yields page 1 rather
than an error. Controllers then read the cleaned values via
`matchedData(req, { onlyValidData: true })` — never `req.query` directly.

Two copy-paste artefacts survive in the messages: several `password` fields
carry `errorMessage: "Last name is required!"`. Cosmetic, but user-visible.

> **`update-user-validator.tenantId` does not work.** See §11.

---

## 8. Routes, one by one

### `/auth`

Wiring: `UserService`, `TokenService`, `CredentialService` and the logger are
constructed once at module load and injected into `AuthController`.

---

#### `POST /auth/register` → `AuthController.register`

Chain: `registerValidator` → controller.

1. `validationResult(req)`; if non-empty, respond `400 { errors: [...] }` directly.
2. `userService.create({ ..., role: Roles.CUSTOMER })`. **The role is hard-coded.**
   A caller cannot self-register as an admin by posting `role: "admin"` — the
   field is not read.
3. Build the JWT payload: `sub`, `role`, `tenant`, `firstName`, `lastName`, `email`.
4. `generateAccessToken` → `persistRefreshToken` → `generateRefreshToken`, in
   that order (the refresh token needs the row id).
5. Set both cookies `httpOnly`, `sameSite: "strict"`, on `Config.MAIN_DOMAIN`.
6. `201 { id }`.

Note the debug log masks the password as `"******"` before it ever reaches a
transport.

`httpOnly` is what keeps the tokens out of reach of XSS — JavaScript in the page
cannot read them. `sameSite: "strict"` is the CSRF control.

---

#### `POST /auth/login` → `AuthController.login`

Chain: `loginValidator` → controller.

1. Validation, as above.
2. `findByEmailWithPassword(email)` — the query that deliberately includes the hash.
3. `credentialService.comparePassword(...)`.
4. Either failure — unknown email **or** wrong password — produces the identical
   `400 "Email or password does not match."`. That symmetry is intentional: a
   distinct "no such user" would turn the endpoint into an account enumerator.
5. Same token-issuing sequence as register. `200 { id }`.

---

#### `GET /auth/self` → `AuthController.self`

Chain: `authenticate` → controller.

```ts
const user = await this.userService.findById(Number(req.auth.sub));
res.json({ ...user, password: undefined });
```

The identity comes from the **token**, never from a query parameter, so there is
no object-level authorisation question — a caller can only ever fetch
themselves.

The `password: undefined` spread is belt-and-braces; `select: false` already
excluded it. Note this method takes no `next` and has no `try/catch`, so a
database failure rejects the promise unhandled rather than reaching
`globalErrorHandler`. Express 5 catches rejected promises from handlers, so it
degrades to a 500 — but it is the odd one out among the controller methods.

---

#### `POST /auth/refresh` → `AuthController.refresh`

Chain: `validateRefreshToken` → controller.

1. Rebuild the payload from `req.auth` — the claims come from the **old token**,
   so a role change does not take effect until the user logs in again.
2. Issue a new access token.
3. `findById(req.auth.sub)`; if the user is gone, `400 "User with the token could not find"`.
4. **Persist a new refresh-token row, then delete the old one** (`req.auth.id`).
5. Set both cookies. `200 { id }`.

This is **rotation**: one refresh token, one use. Replaying an old one finds no
row and is rejected as revoked. Steps 4 and 5 are not transactional — a crash
between them leaves an orphan row, which is harmless (an unused live session
that expires on its own).

---

#### `POST /auth/logout` → `AuthController.logout`

Chain: `authenticate` → `parseRefreshToken` → controller.

Both middlewares assign `req.auth`, and **the second wins** — so `req.auth.id`
is the refresh token's `jti`, which is exactly what needs deleting. Requiring a
valid access token *as well* means a stolen refresh token alone cannot be used
to log someone out.

Deletes the row, clears both cookies, `200 {}`.

---

### `/tenants`

| Route | Chain | Controller |
| --- | --- | --- |
| `POST /tenants` | `authenticate` → `canAccess([ADMIN])` → `tenantValidator` | `create` |
| `PATCH /tenants/:id` | `authenticate` → `canAccess([ADMIN])` → `tenantValidator` | `update` |
| `GET /tenants` | `listUsersValidator` **only** | `getAll` |
| `GET /tenants/:id` | `authenticate` → `canAccess([ADMIN])` | `getOne` |
| `DELETE /tenants/:id` | `authenticate` → `canAccess([ADMIN])` | `destroy` |

`GET /tenants` is the odd one out — **no `authenticate`**. See §11.

Every `:id` handler runs the same guard before touching the service:

```ts
if (isNaN(Number(tenantId))) { next(createHttpError(400, "Invalid url param.")); return; }
```

Without it, `Number("abc")` → `NaN` would reach Postgres and surface as a 500.

`getOne` additionally translates a missing row into `400 "Tenant does not exist."`
— note **400, not 404**, which is a house convention here rather than a mistake.

`destroy` does not check the affected row count, so deleting a non-existent id
returns `200 { id }`.

---

### `/users`

All five routes are `authenticate` → `canAccess([ADMIN])`, plus a validator
where there is a body.

| Route | Controller | Notes |
| --- | --- | --- |
| `POST /users` | `create` | takes `role` **and** `tenantId` from the body — this is how managers are made |
| `PATCH /users/:id` | `update` | cannot change a password |
| `GET /users` | `getAll` | paginated envelope |
| `GET /users/:id` | `getOne` | 400 when absent |
| `DELETE /users/:id` | `destroy` | 200 even when absent |

`POST /users` is the privileged counterpart to `/auth/register`: register
hard-codes `customer`, this one accepts any role. That is precisely why it sits
behind `canAccess([ADMIN])`.

`UserController.create` reports validation failures differently from every other
controller — `next(createHttpError(400, result.array()[0].msg))`, i.e. the
**first** message only, routed through the error handler. The others respond
`400 { errors: [...] }` directly with the full array. Both reach the client as a
400; the body shape differs.

The list envelope:

```json
{ "currentPage": 1, "perPage": 6, "total": 42, "data": [ ... ] }
```

`currentPage` and `perPage` are echoed from the sanitised query, `total` is the
unpaginated count from `getManyAndCount()`.

---

## 9. Token design

```
     login / register
            │
            ├── accessToken   RS256, 1 day,  httpOnly cookie
            │     └── verified locally by every other service via JWKS
            │
            └── refreshToken  HS256, 1 year, httpOnly cookie
                  └── jti ──▶ refreshTokens row ──▶ revocable
```

**Why two algorithms.** The access token is verified by four services, so it
must be asymmetric — distribute the public key, keep the private one here. The
refresh token is verified by exactly one service, so a shared secret is simpler
and there is nothing to distribute.

**Why the refresh token has a database row.** A JWT is, by construction, valid
until it expires — you cannot un-issue one. A one-year token with no way back
would be a serious problem. The `jti` → row indirection restores control:
delete the row and the token is dead on its next use, checked by
`validateRefreshToken.isRevoked`.

**How the other services verify.** `JWKS_URI` points at
`/.well-known/jwks.json`, served statically from `public/`. `jwks-rsa` fetches
it once, caches, and rate-limits. `public/` and `certs/` are both gitignored;
[`scripts/write-certs.mjs`](./scripts/write-certs.mjs) materialises them at boot
from `PRIVATE_KEY_BASE64`.

---

## 10. Configuration

| Variable | Used by | Notes |
| --- | --- | --- |
| `PORT` | server.ts | |
| `NODE_ENV` | config, logger, error handler | selects `.env.<NODE_ENV>`; `test` silences logs; `production` strips stacks |
| `DB_HOST` / `DB_PORT` / `DB_USERNAME` / `DB_PASSWORD` / `DB_NAME` | data-source | SSL turns on automatically unless the host is `localhost` |
| `REFRESH_TOKEN_SECRET` | TokenService, both refresh middlewares | HS256 secret |
| `JWKS_URI` | `authenticate` | this service's own JWKS URL |
| `PRIVATE_KEY_BASE64` | `scripts/write-certs.mjs` | the RSA private key, base64'd |
| `CLIENT_UI_DOMAIN` / `ADMIN_UI_DOMAIN` | app.ts | CORS allow-list |
| `MAIN_DOMAIN` | AuthController | cookie `domain` |

---

## 11. Known issues

Recorded here because each one is captured by a test that documents current
behaviour rather than asserting it is correct.

**`tenantId` is never actually required.** `update-user-validator` declares it
mandatory for any non-admin role, with `errorMessage: "Tenant id is required!"`.
It never fires. The `custom.options` callback is `async`, and express-validator
only fails a custom validator that **throws or returns a rejected promise** — an
async function returning `false` still *resolves*, which counts as a pass. A
manager can therefore be saved with no tenant, which the rest of the platform
assumes cannot happen. Dropping `async` (or throwing instead of returning
`false`) makes the rule real.

**`GET /tenants` is public.** Unlike every other `/tenants` route it has no
`authenticate` middleware, so the full tenant list — names and addresses — is
readable by anyone. The admin UI depends on it during the create-user flow,
which is presumably how it happened.

**`TenantController.getAll` responds twice.**

```ts
res.json({ currentPage, perPage, total, data: tenants });
res.json(tenants);          // ← dead, and throws
```

The client gets the first (correct) response. The second throws
`ERR_HTTP_HEADERS_SENT`, which the surrounding `try/catch` forwards to
`next(err)` after the response has already been sent. Harmless in practice,
noisy in the logs, and the line is simply left over.

**The entity and the migrations disagree on the refresh-token FK.**
`RefreshToken.user` is a plain `@ManyToOne(() => User)` with no `onDelete`, so
a schema built by `synchronize()` — which is what the **test suite** uses — gets
`ON DELETE NO ACTION`, and deleting a logged-in user fails. Production is
migrated, and `1699475145577-add_refreshtoken_cascade` re-creates the same FK
with `ON DELETE CASCADE`, where it succeeds. Tests and production genuinely
behave differently here. Adding `{ onDelete: "CASCADE" }` to the relation would
close the gap.

**Delete and update never check `affected`.** `PATCH`/`DELETE` on an id that
does not exist return `200` with that id. A no-op reads as success.

**`src/utils.ts` is dead code.** `calculateDiscount` has no caller in this
service — it belongs to order pricing.

---

## 12. Where the tests live

```
tests/
├── app.spec.ts                      root route, 404s, malformed JSON, CORS, JWKS
├── middlewares/
│   ├── can-access.spec.ts           role gating          (unit)
│   └── global-error-handler.spec.ts error envelope       (unit)
├── services/
│   ├── credential.spec.ts           bcrypt comparison    (unit)
│   └── token.spec.ts                signing, lifetimes   (unit)
├── tenants/                         create, update, list, get-one, delete
├── users/                           register, login, self, refresh, logout,
│                                    create, update, list, get-one, delete
└── utils/index.ts                   createUser, createTenant, createRefreshToken,
                                     extractAuthCookies, isJwt
```

The unit specs use stubs and finish in about five seconds. The integration
specs drive the real app through supertest against a real Postgres, dropping and
re-synchronising the schema in `beforeEach` — correct, and slow. `testTimeout`
is raised to 30s in `jest.config.js` for exactly that reason.

Access tokens in tests come from `mock-jwks`, which stands up a fake JWKS
endpoint on `http://localhost:5501` so `authenticate` can verify tokens the test
minted itself. Refresh tokens are built by `createRefreshToken`, which persists
the row **and** signs the matching token — both halves are needed, because a
token without a row is what "revoked" means.

```bash
npm test
```
