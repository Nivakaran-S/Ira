# POS frontend

Angular 22 workspace for the POS platform. See the root README for how to run it.

| Project | What |
|---|---|
| `projects/admin` | Super-admin console (on `admin.*`) and tenant back office (on tenant hosts) |
| `projects/pos` | Till PWA, served under `/pos/`: device enrolment, PIN sign-in |
| `projects/ui` | Design tokens and shared components, consumed from source |

Unit tests: `npm run test:unit`. End to end: `npm run e2e` (needs the API, Postgres and Redis).
