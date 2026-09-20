# AI Accountant + Credit Builder for Informal MSMEs

> **A kirana shop owner should not need to become an accountant to build a financial history.**

AI Accountant + Credit Builder is a mobile-first financial record-keeping application designed for informal micro and small businesses such as kirana shops and local retailers.

The application allows a business owner to record transactions using natural inputs such as:

-  Photographing a paper bill or invoice
-  Speaking a sentence such as _"I bought 2 kg tomato from Ramu for Rs 200"_
-  Manually entering a transaction

The system converts these inputs into structured financial records, stores them securely, generates business summaries, and evaluates the **readiness of the financial records for formal credit documentation**.

> **Important:** The Record Readiness metric is a measure of financial-record completeness and history. It is **not a credit score, credit-risk assessment, underwriting decision, or guarantee of loan approval.**

---

##  Problem

Many informal businesses maintain their financial information using:

- Paper bills and notebooks
- Mental calculations
- Unstructured records
- Informal verbal transactions

This creates several problems:

- Difficult to track sales and expenses
- Difficult to understand monthly cash flow
- Records can be incomplete or inconsistent
- Difficult to prepare formal financial documentation
- Limited financial history can make it harder to demonstrate business activity to formal institutions

The business owner should not have to understand accounting software, spreadsheets, or complex financial terminology just to maintain usable records.

---

##  Solution

The application simplifies bookkeeping by allowing the user to interact with the system using everyday inputs.

### Example

A shop owner says:

> "I bought 2 kg tomato from Ramu for Rs 200."

The system converts the statement into a structured transaction:

```json
{
  "transactionId": "uuid",
  "userId": "demo-user",
  "date": "2026-09-19T21:27:40Z",
  "type": "purchase",
  "item": "tomato",
  "quantity": 2,
  "unit": "kg",
  "pricePerUnit": 100,
  "totalAmount": 200,
  "currency": "INR",
  "counterparty": "Ramu",
  "source": "voice",
  "rawInput": "I bought 2 kg tomato from Ramu for Rs 200",
  "confidence": 0.95
}
