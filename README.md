# Nabta OMS — Backend

Backend service for the Nabta Order Management System.
Express + TypeScript + Prisma 6 + PostgreSQL.

## Requirements

- Node.js 20+
- PostgreSQL 14+ (developed against PostgreSQL 18)

## Getting started

```bash
npm install
cp .env.example .env        # then fill in real values
npx prisma migrate dev      # create the database schema
npx prisma db seed          # create the admin account from ADMIN_* env vars
npm run dev                 # http://localhost:4000
```

## Environment variables

All configuration lives in `.env` — see [.env.example](.env.example) for the full list:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Secret for signing auth tokens — use a long random string |
| `PORT` | API port (default 4000) |
| `NODE_ENV` | `development` or `production` |
| `CORS_ORIGIN` | Comma-separated allowed frontend origins, no trailing slash |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` | Admin account created by `prisma db seed` |
| `ENABLE_DEV_AUTH_FALLBACK` | `true` enables demo logins (dev only, ignored in production) |

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start dev server with watch mode |
| `npm run build` | Generate Prisma client + compile TypeScript to `dist/` |
| `npm start` | Run the compiled server |
| `npm run start:prod` | Apply pending migrations, then run the server |
| `npm run prisma:migrate` | Create/apply a migration in development |
| `npm run db:seed` | Seed/update the admin account |

## Deployment

1. Set all environment variables on the host (`NODE_ENV=production`).
2. `npm install && npm run build`
3. `npm run start:prod` — runs `prisma migrate deploy` then starts the API.
