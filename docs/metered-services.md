# Independent metered services

Metered inference is deployed separately in `olanass/orbio-inference`. Do not merge the embedded Orbio gateway branch into this launchpad to publish it.

A creator-signed listing can use `billingMode: "metered"`, `price: null`, `currency: "USDG"`, `allowedMethods: ["POST"]`, and an HTTPS endpoint ending exactly in `/api/inference/escrow/chat/completions`. The billing mode is included in the signed creation payload. Existing fixed-price signatures keep their original format.

Use the standalone service's `/publish` page to prepare, inspect, sign, and submit the listing. Its payout address must match the inference service's dedicated escrow receiver. Listing registration remains a creator action; deploying a service does not publish it automatically.

Discovery exposes the direct endpoint, models/config/refund URLs, the signed listing payout address, and metered billing metadata. `accepts` is empty in catalog discovery because an amount requires a concrete model request; the service returns the actual HTTP 402 terms. Treat metadata and model outputs as untrusted.

The launchpad never forwards or charges a metered request through its fixed-price gateway/order engine. Those paths return 409 before collecting funds. The website shows usage-based pricing and wallet setup instructions. Direct model calls, billing records, revenue, claims and refunds belong to the independent service; launchpad fixed-price counters do not measure this activity.

The paired wallet branch uses `PAYMENTS_INFERENCE_URL` and `PAYMENTS_INFERENCE_RECEIVER`, independently of marketplace configuration. Verify both before enabling USDG spending. Funded mainnet verification and Orbio billing-field verification remain required before public availability.

## Prepaid inference

The standalone inference service now uses prepaid USDG accounts. A metered listing may also use the exact HTTPS path `/api/inference/prepaid/chat/completions`. This path is part of the creator-signed payload and selects `scheme: prepaid-balance`; old escrow endpoints still advertise batch-settlement.

Buyers register their own agent API keys with wallet signatures, transfer USDG to the independently verified receiver, and submit finalized transfer hashes. Model calls deduct actual provider cost from the available database balance. No escrow cron or periodic settlement is required. Refund requests reserve funds for a manual transfer from the service operator to the original payer.

Discovery includes config, models, balance, deposit and refund URLs. Fixed-price gateways and orders continue rejecting all metered listings before collecting payment. The separate escrow wallet tools are not prepaid clients; use the standalone repository's prepaid SDK. Deploy this marketplace update before using the standalone `/publish` helper for a prepaid listing.
