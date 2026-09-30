---
'lens': patch
---

Fix `slippagePct` on `/price/:a/:b/route`, which was always exactly 0 because
the execution price was compared with itself. It is now the shortfall of the
execution price against the AMM reserve-ratio spot price, so it grows with
order size against a fixed pool. Route selection and `estimatedOutput` are
unchanged. With no AMM pool there is no size-independent spot reference, so
the value stays 0.
