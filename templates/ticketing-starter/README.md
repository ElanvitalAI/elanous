# Concert ticketing starter

This is a synthetic local demo. It uses a demo identity header, a synthetic checkout and no real payment, member authentication or public deployment.
Omitted event details remain unknown. The page marks every generated placeholder, including seat count, as sample/virtual data until real details are supplied.

Run from the generated project directory:

1. bun test test
2. PORT=31542 bun run backend/server.ts
3. Open http://127.0.0.1:31542/ and check http://127.0.0.1:31542/api/health.

The server binds to 127.0.0.1. It serves the static frontend and API from the same origin. The SQLite file is data/ticketing.sqlite. Stop the server process to remove the local preview; keep or back up the data file intentionally. A public URL requires a separate approved member or relay deployment and its own URL/undo receipt.

API: GET /api/health, /api/concerts, /api/concerts/demo-concert, /api/concerts/demo-concert/seats, POST /api/concerts/demo-concert/hold, POST /api/concerts/demo-concert/checkout, GET /api/my-tickets. Demo requests use X-User-Id. Checkout requires Idempotency-Key and returns syntheticPayment true.
