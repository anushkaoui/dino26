# Credit research, checked 10 October 2026

The user clarified that "$300" and "₹23,000" describe one balance, then supplied the actual Credits Info breakdown:

| Account-reported detail | Value |
| --- | --- |
| Total available | ₹23,855.33 |
| Promotional / Referral / Earned | ₹0 each |
| Others | ₹23,855.33 |
| Credit history description | Special credits offered |
| Transaction date / original value | 4 October 2026 / $250 |
| Earliest expiry shown | 6 April 2027 |

This identifies a **$250 special grant**, rather than a $300 grant or a balance categorized as promotional credit. Its amount matches Catalyst's standard advertised grant. The account details are supplied by the user; no authenticated account inspection, redemption or spending was performed. If this is the Credits Info view for the Catalyst billing account, Catalyst-specific wallet terms support using valid credits against future Catalyst invoices. The special grant's accepted terms and invoice deduction remain authoritative.

## Distinguishing the two terms pages

The supplied FAQ concerns general **Zoho Store promotional wallet credits**, while the subscription details show **Catalyst Pay As You Go**, with current usage/net total ₹0. That subscription line proves neither that the balance is allocated to Catalyst nor that future metered invoices are fully covered.

[Current general Zoho wallet terms](https://www.zoho.com/wallet/terms-and-conditions.html) distinguish promotional, referral, startup and special credits. Promotional annual-subscription deductions are capped at 50% of the invoice or USD200 equivalent, whichever is lower. Monthly promotional use has separate restrictions: initial purchase and one renewal, with a payment-method condition. Therefore the annual cap is not proof that all wallet credits work only annually. The pasted FAQ's wording differs from current pages on some details; the actual grant and accepted terms matter. No explicit official statement found establishes that this general promotional grant pays Catalyst's metered Pay As You Go invoices.

[**Catalyst-specific wallet terms**](https://catalyst.zoho.com/wallet-terms-and-conditions.html) say its wallet credits can redeem against future invoices on the same Catalyst account and are usable only for Catalyst. If the ₹23,000 grant is explicitly a Catalyst wallet grant, these terms support invoice offsetting. Catalyst's [pricing FAQ](https://catalyst.zoho.com/pricing.html) separately describes standard trial credit deductions. The standard currently advertised grant is $250 for six months; that does not identify this user's reported $300 offer.

The supplied breakdown lists the grant under **Others**, not Promotional Credits. Do not automatically impose the general promotional annual-purchase cap on it. Confirm it belongs to the correct Catalyst India billing account and keep its 6 April 2027 expiry in mind. A ₹0 current usage total does not independently show a credit deduction. If the special grant terms are unclear, obtain account-specific confirmation. [Manage Billing documentation](https://docs.catalyst.zoho.com/en/deployment-and-billing/billing/manage-billing/).

Suggested question for Zoho support, to be sent by the user:

> Does my promotional credit balance apply to metered AppSail and Data Store invoices on Catalyst Pay As You Go? Please confirm the eligible credit type, expiry, redemption cap and billing-account/data-centre restrictions.

The official wallet contact is wallet@zohocorp.com; Catalyst support is support@zohocatalyst.com. No message has been sent.

## Community search

Searched Reddit, Zoho's Catalyst forum, GitHub and Stack Overflow using explicitly requested research subagents. No reliable firsthand report confirmed redemption of this ₹23,000 grant or a 500-player Catalyst event.

- [Reddit beginner discussion](https://www.reddit.com/r/Zoho/comments/1tpywdd/zoho_catalyst/) provides no redemption/capacity evidence.
- [Reddit student-cloud discussion](https://www.reddit.com/r/u_Thirumalaivasan_GJ/comments/1wztrpm/zoho_built_its_own_cloud_instead_of_awsgcp_now/) discusses possible student benefits without published eligibility/limits. Search text was available, but directly opening the post failed. It cannot establish this user's grant.
- [Older Catalyst free-trial announcement](https://forums.catalyst.zoho.com/portal/en/community/topic/catalyst-free-trial) mentions first-year use and invocation allowances that differ from current pricing. Do not apply its historical terms to this grant.
- [Official AppSail React example](https://github.com/catalystbyzoho/appsail-vitejs-react-ts) demonstrates a hosting pattern, not credit eligibility or measured 500-player reliability.

Credits pay eligible bills; they do not increase concurrency or guarantee uptime. The deployed load test and production database checks remain necessary. [Budget checks](https://docs.catalyst.zoho.com/en/deployment-and-billing/billing/billing-settings/) run every 30 minutes, so disabling production at a budget threshold is not an instantaneous spend cap and can interrupt an event.
