# Bixcart Transaction Lifecycle & Paystack Split System

Bixcart uses **Paystack Split Payments** for marketplace checkout. Seller bank accounts are connected as Paystack subaccounts, and every checkout is split automatically between Bixcart and the participating sellers. There is no separate Bixcart-held balance and no post-delivery transfer.

## 1. Seller payment setup

1. An approved seller enters their bank details in Bixcart.
2. Bixcart verifies the account with Paystack.
3. Bixcart creates a Paystack subaccount for that seller and stores the subaccount code server-side.
4. The subaccount code is never exposed to the browser.

## 2. Buyer checkout

1. Buyer adds one or more listings to the cart.
2. Bixcart groups cart items by seller.
3. The backend applies the platform-wide 7% commission rate to the seller group.
4. Bixcart creates a **dynamic flat Paystack Split**:
   - each seller receives their calculated seller share;
   - Bixcart receives the remaining commission share;
   - `bearer_type: "all"` makes Paystack share processing fees across the main account and participating subaccounts.
5. Buyer completes the Paystack checkout.
6. Paystack verifies and processes the transaction.
7. Bixcart creates the corresponding order records and marks the purchased listings as pending.

## 3. Seller response window

Every paid order has a six-hour response deadline.

### Seller accepts

- Order becomes `confirmed`.
- Seller's delivery window starts from the acceptance time.
- Buyer is notified.

### Seller declines

- Order becomes `cancelled`.
- Listing becomes available again.
- Bixcart initiates a Paystack refund for the buyer.
- Buyer receives Bixcart push/email notifications about the refund.

### Seller does not respond

When the six-hour response deadline expires:

- Bixcart automatically cancels the order.
- The listing becomes available again.
- Bixcart initiates the Paystack refund.
- Buyer and seller are notified.

## 4. Delivery

The seller's listing determines the delivery window: **5 minutes (test), 6 hours, 12 hours, 1 day, 3 days, or 7 days**.

Before handoff, the seller uses **Get Delivery Info**:

- Same hostel → Bixcart confirms the shared hostel and shows the relevant delivery information.
- Different hostels → Bixcart opens the order's delivery chat so buyer and seller can coordinate.

After the seller has handed over the item, the seller marks the order as fulfilled. Bixcart gives the buyer the opportunity to enter the delivery verification code.

## 5. Buyer confirms delivery

The buyer enters the code supplied by the seller.

Bixcart validates:

- the order is still active;
- the delivery deadline has not expired;
- the code matches.

If valid:

1. Order becomes `completed`.
2. Listing becomes `sold`.
3. Seller's successful-sales count is incremented.
5. The seller share has already been allocated through Paystack Split at checkout; **no second transfer is created**.
6. Buyer can rate the seller.

## 6. Refund lifecycle

Refunds are handled through Paystack's Refund API using the original transaction reference.

Bixcart tracks the refund status:

`pending → processing → processed`

or

`pending → failed / needs-attention`

Bixcart sends its own customer notifications so buyers are not dependent on processor emails.

## 7. Important implementation rules

- Never trust a browser-reported payment success; verify the Paystack transaction server-side.
- Never accept a client-supplied commission or seller share.
- Never expose Paystack secret keys or seller subaccount codes to the frontend.
- Never initiate a Paystack Transfer after delivery confirmation.
- Delivery confirmation completes the **order**, not a payment release.
- Refunds always reference the original Paystack transaction.
- The 5-minute delivery option is intended for testing the deadline/refund automation.
