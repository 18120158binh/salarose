# Use cases

These are the business use cases that the platform must support, grouped by customer lifecycle stage, from a shopper's first visit to loyalty or churn. The last group, [daily work in studio](#daily-work-in-studio), covers the staff who run the journeys. They are requirements, not a description of the code. [Support today](#support-today) maps each use case to what the code supports.

## Acquisition and activation

### UC-01. Welcome on first login

| | |
|---|---|
| Trigger | The user logs in successfully for the first time. |
| Action | Send a welcome message and a guide to using the site. |
| Frequency | Once per user. |
| Example | "Chào mừng bạn đến Auroracy! Khám phá ngay các ưu đãi dành riêng cho thành viên mới." (Welcome to Auroracy! Explore the offers for new members now.) |

### UC-02. Remind to complete profile

| | |
|---|---|
| Trigger | 24 hours after sign-up, the user's profile is still incomplete. For example, the gender or the city is missing. |
| Action | Remind the user to complete the profile to get personalized offers. |
| Frequency | At most twice, 3 days apart. |

## Engagement and browsing

### UC-03. Browse abandonment

| | |
|---|---|
| Trigger | In one session, the user views the details of 3 or more products in the same category but adds none of them to the cart. |
| Delay | 2 hours after the last browsing session. |
| Action | Send a discount voucher for that product category. |
| Frequency | At most once per day and 3 times per week. |
| Example | "Bạn đang tìm điện thoại? Nhận ngay voucher giảm 10% cho nhóm Smartphone!" (Are you looking for a phone? Get a 10% off voucher for the Smartphone category now!) |

### UC-04. Search with no results

| | |
|---|---|
| Trigger | The user searches for a keyword, and the search returns 0 products. |
| Action | Suggest similar products, or notify the user when new products match the keyword. |
| Frequency | Once per keyword per user. |

### UC-05. Search for a target brand

| | |
|---|---|
| Trigger | The user searches for a specific brand, for example "Xiaomi". The user is in the target customer segment, for example male and in Ho Chi Minh City, and the search happens during the prime time window. |
| Action | Send an exclusive voucher for that brand. |
| Frequency | Once per brand per user per week. |
| Notes | This is use case EO03 in the earlier demo. |

## Conversion

### UC-06. Cart abandonment

| | |
|---|---|
| Trigger | The user adds a product to the cart but does not pay within 1 hour. |
| Delay | 1 hour after the last add-to-cart action. |
| Action | Send a cart reminder and a free shipping code that applies if the user pays within 2 hours. |
| Frequency | At most twice per cart. Skip the message if the user has already bought. |
| Branching | If the cart value is over 2 million VND, give a 5% voucher. Otherwise, send only the reminder. |

### UC-07. Payment failure recovery

| | |
|---|---|
| Trigger | The user clicks pay, but the transaction fails. For example, the payment times out or the bank declines the card. |
| Delay | 5 minutes. |
| Action | Send a support message and a link to retry the payment. |
| Frequency | Once per failed order. |

### UC-08. Price drop on a liked product

| | |
|---|---|
| Trigger | The price drops on a product that the user viewed 2 or more times in the last 7 days. |
| Action | Send the new price and a quick-buy link. |
| Frequency | Once per product per price drop. |
| Notes | The use case needs two event streams together. One is user behavior, which is the product views. The other is a system event, which is the price update. |

## Post-purchase

### UC-09. Order confirmation and tracking

| | |
|---|---|
| Trigger | The user completes a payment successfully. |
| Action | Send an order confirmation and a link to track the delivery. |
| Frequency | Once per order. |

### UC-10. Review request after delivery

| | |
|---|---|
| Trigger | An order is delivered successfully. |
| Delay | 3 days after delivery. |
| Action | Send a message that asks the user to review the product. |
| Frequency | Once per order. |
| Branching | If the user gives 4 stars or more, send a thank-you voucher. If the user gives 2 stars or fewer, pass a ticket to customer service. |

### UC-11. Cross-sell after purchase

| | |
|---|---|
| Trigger | The user buys a product in category X. |
| Delay | 7 days after the purchase. |
| Action | Suggest accessories or complementary products for X. |
| Frequency | Once per category per month. |
| Example | A user who buys a phone gets suggestions for a phone case, a screen protector, and a fast charger. |

## Retention and re-engagement

### UC-12. Dormant user win-back

| | |
|---|---|
| Trigger | The user does not log in or take any action for 14 days. |
| Action | Send a voucher with a large discount to bring the user back. |
| Frequency | Once every 14 days. |
| Branching | If the user comes back within 3 days, the journey ends. If not, send a second, stronger message with a larger discount. If the user still does not come back, mark the user as "churned". |

### UC-13. Loyalty milestone

| | |
|---|---|
| Trigger | The user completes a fifth order, or the user's total spend passes 10 million VND. |
| Action | Raise the user's membership tier and give a VIP voucher. |
| Frequency | Once per milestone. |

### UC-14. Back in stock

| | |
|---|---|
| Trigger | A product that the user viewed while it was out of stock is back in stock. |
| Action | Tell the user that the product is in stock, with a quick-buy link. |
| Frequency | Once per product per user. |
| Notes | Like UC-08, the use case needs two event streams together. One is user behavior. The other is a system event, which is the stock update. |

## Time-based campaigns

### UC-15. Flash sale at a set time

| | |
|---|---|
| Trigger | The user is online during the time window of a flash sale, for example 12:00 to 13:00. |
| Action | Push a flash sale notice to a real-time banner. |
| Frequency | Once per flash sale. |

### UC-16. Birthday

| | |
|---|---|
| Trigger | It is the user's birthday, as recorded in the profile. |
| Action | Send a birthday voucher. |
| Frequency | Once per year. |

## Daily work in studio

These use cases belong to the staff who run the journeys, not to a shopper. Studio v2 phase 1 delivers them from data the platform already writes.

### UC-17. Morning overview

| | |
|---|---|
| Who | Marketer |
| Need | See how all journeys did today, this week, or this month against the period before, and whether the pipeline is behind or dropping input. |
| Delivered by | [Home overview](../features/home-overview.md) |

### UC-18. Journey performance by step

| | |
|---|---|
| Who | Marketer |
| Need | See, for one journey and a time range, how many people reached each step, how many moved on, how many are still waiting, and which branch they took. |
| Delivered by | [Journey builder: node analytics](../features/journey-builder.md#node-analytics) |

### UC-19. Look up a customer

| | |
|---|---|
| Who | Marketer, support |
| Need | Given a user id or device id from a complaint, see the person's devices, every journey they entered with the step they are at, and their metric values. |
| Delivered by | [Customer lookup](../features/customer-lookup.md) |

### UC-20. Check data health

| | |
|---|---|
| Who | Marketer reads the catalog. Admin also reads dropped input. |
| Need | See which events the platform expects and whether their schema gate is on. An admin also sees the source keys and the records ingestion dropped, with the reason. |
| Delivered by | [Data health](../features/data-health.md) |

### UC-21. See where a segment is used

| | |
|---|---|
| Who | Marketer |
| Need | Before changing a segment, see which journeys use it and how. |
| Delivered by | [Segments: the segment list](../features/segments.md#the-segment-list) |

### UC-22. Build a journey from a template

| | |
|---|---|
| Who | Marketer |
| Need | Start a common journey, such as abandoned cart or win-back, from a built-in template with Vietnamese copy on SMS and push, map its events to the shop's catalog, edit it, and publish it without leaving the v2 studio or losing work to a closed browser. |
| Delivered by | [Journey builder](../features/journey-builder.md), [campaign management](../features/campaign-management.md) |

### UC-23. Start a journey when a person enters a segment

| | |
|---|---|
| Who | Marketer |
| Need | Start a journey when a person comes to match a saved segment, such as "Spent over 5,000,000 in the last 90 days", and test segment membership in a check, without copying the segment's conditions into every journey. |
| Delivered by | [Segments](../features/segments.md), [journey builder](../features/journey-builder.md), [customer decision](../architecture/components/customer-decision.md) |

### UC-24. Know how many people a segment reaches

| | |
|---|---|
| Who | Marketer |
| Need | See a segment's size before using it, counting tracked people and customers known only from imports, with the basis of the count stated. |
| Delivered by | [Segments](../features/segments.md), [profile writer](../architecture/components/profile-writer.md), [segment membership pass](../architecture/components/segment-membership-pass.md) |

## The shop's own data

These use cases bring in data the tracker never sees: the shop's orders and customer records. [Data import](../features/data-import.md) delivers them.

### UC-30. Target on purchase history

| | |
|---|---|
| Who | Marketer |
| Need | Target people by what they bought from the shop, online or in store, such as "spent over 5,000,000 in the last 90 days", "bought from the Shoes category twice", or "no order for 60 days", in journeys and segments. |
| Delivered by | [Data import: imported metrics](../features/data-import.md#imported-metrics), [customer decision](../architecture/components/customer-decision.md#condition-language), [segments](../features/segments.md) |

### UC-31. Bring in the shop's customer records

| | |
|---|---|
| Who | Admin, and the shop's developers |
| Need | Push customer records and orders once a day, by API or spreadsheet, and see whether each delivery applied, what it rejected, and whether its customer ids match the tracked ones. Attach email addresses and phone numbers to the shop's customer ids. |
| Delivered by | [Data import](../features/data-import.md), [import applier](../architecture/components/import-applier.md) |

### UC-32. Delete a person's imported data

| | |
|---|---|
| Who | Admin |
| Need | On a customer's request, delete everything the shop imported about them, and keep later deliveries from bringing it back. |
| Delivered by | [Data import: privacy](../features/data-import.md#privacy) |

## Support today

This table maps each use case to what the code supports today.

| Id | Use case | Support | What is missing |
|---|---|---|---|
| UC-01 | Welcome on first login | Yes | |
| UC-02 | Remind to complete profile | Partial | A person enters a journey once, so "at most twice, 3 days apart" cannot be built. |
| UC-03 | Browse abandonment | Yes | |
| UC-04 | Search with no results | Yes, if the search event carries a result count | |
| UC-05 | Search for a target brand | Yes | |
| UC-06 | Cart abandonment | Yes | |
| UC-07 | Payment failure recovery | Yes | |
| UC-08 | Price drop on a liked product | Partial | `price_drop` is a trigger in the builder, but nothing in this repo produces the event. [Business event fan-out](../architecture/components/business-event-fan-out.md), a draft, specifies the interest audience and one entry per price drop. |
| UC-09 | Order confirmation and tracking | Yes | |
| UC-10 | Review request after delivery | Yes, with a delay | |
| UC-11 | Cross-sell after purchase | Partial | No recommendation source. Message content is not sent yet. |
| UC-12 | Dormant user win-back | No | `INACTION` never matches, and no timer fires when a person goes quiet. |
| UC-13 | Loyalty milestone | Yes, with a `COUNT` metric condition on the same event that reaches the check | A metric about a different event is never visible to the check. |
| UC-14 | Back in stock | Partial | Same as UC-08, for `back_in_stock`. |
| UC-15 | Flash sale at a set time | No | No scheduled trigger. |
| UC-16 | Birthday | No | No scheduled trigger. |
| UC-17 | Morning overview | No | Planned for studio v2 phase 1. |
| UC-18 | Journey performance by step | No | Planned for studio v2 phase 1. |
| UC-19 | Look up a customer | No | Planned for studio v2 phase 1. |
| UC-20 | Check data health | No | Planned for studio v2 phase 1. |
| UC-21 | See where a segment is used | No | Planned for studio v2 phase 1. |
| UC-22 | Build a journey from a template | No | Planned for studio v3. Drafts live in the browser and the builder has no templates. |
| UC-23 | Start a journey when a person enters a segment | No | Customer decision reads no segments ([DEC-KI-41](../known-issues/components/customer-decision.md)). Planned for studio v3. |
| UC-24 | Know how many people a segment reaches | No | No membership is stored. Planned for studio v3. Imported-only customers also need data import. |
| UC-30 | Target on purchase history | No | Data import is planned. Imported-only customers also need the segment runtime's nightly pass. |
| UC-31 | Bring in the shop's customer records | No | Data import is planned. Its pipeline waits until #320 part 1 is merged and live (CDC window shortened, cap 8 GB). |
| UC-32 | Delete a person's imported data | No | Data import is planned. Deleting tracked data waits for the consent and deletion contract. |

"Yes" means the journey can be built and the design supports it. No known issue stops every journey today. See [what stops a journey today](../known-issues/README.md#what-stops-a-journey-today).

UC-12 needs a decision when no event arrives. How to make one is an open question in [customer decision](../architecture/components/customer-decision.md#open-questions). UC-02 needs a journey instance that runs more than once. Whether to allow that is an open question in [journey execution](../architecture/components/journey-execution.md#open-questions).
