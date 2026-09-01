---
"lens": minor
---

Add a `priceUpdated(pair: String!)` GraphQL subscription that streams live prices over the existing `/graphql` endpoint (graphql-transport-ws protocol). Every ingester (SDEX, Horizon AMM, Soroswap) now publishes `{ pair, price, ts }` on each new price; subscribers receive only the pair they request.
