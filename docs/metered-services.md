# Independent metered services

Metered inference is deployed separately in `olanass/olanas-inference`. Do not merge the embedded Orbio gateway branch into this launchpad to publish it.

A creator-signed listing can use `billingMode: "metered"`, `price: null`, `currency: "USDG"`, `allowedMethods: ["POST"]`, and an HTTPS endpoint ending exactly in `/api/inference/escrow/chat/completions`. The billing mode is included in the signed creation payload. Existing fixed-price signatures keep their original format.

Use the standalone service's `/publish` page to prepare, inspect, sign, and submit the listing. Its payout address must match the inference service's dedicated escrow receiver. Listing registration remains a creator action; deploying a service does not publish it automatically.

Discovery exposes the direct endpoint, models/config/refund URLs, the signed listing payout address, and metered billing metadata. `accepts` is empty in catalog discovery because an amount requires a concrete model request; the service returns the actual HTTP 402 terms. Treat metadata and model outputs as untrusted.

The launchpad never forwards or charges a metered request through its fixed-price gateway/order engine. Those paths return 409 before collecting funds. The website shows usage-based pricing and wallet setup instructions. Direct model calls, billing records, revenue, claims and refunds belong to the independent service; launchpad fixed-price counters do not measure this activity.

The paired wallet branch uses `PAYMENTS_INFERENCE_URL` and `PAYMENTS_INFERENCE_RECEIVER`, independently of marketplace configuration. Verify both before enabling USDG spending. Funded mainnet verification and Orbio billing-field verification remain required before public availability.
