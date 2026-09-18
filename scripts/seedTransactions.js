const { PutCommand } = require("@aws-sdk/lib-dynamodb");
const { randomUUID } = require("crypto");

const { dynamoClient, TABLE_NAME } = require("../shared/dynamoClient");
const { USER_ID } = require("../shared/constants");

const transactions = [
  {
    date: "2026-07-01T09:15:00Z",
    type: "sale",
    item: "rice",
    quantity: 10,
    unit: "kg",
    pricePerUnit: 60,
    totalAmount: 600,
    counterparty: "Local Customer",
    source: "manual",
    rawInput: "Sold 10kg rice",
    confidence: 1
  },
  {
    date: "2026-07-02T11:30:00Z",
    type: "sale",
    item: "onions",
    quantity: 5,
    unit: "kg",
    pricePerUnit: 40,
    totalAmount: 200,
    counterparty: "Ramu",
    source: "manual",
    rawInput: "Sold 5kg onions to Ramu",
    confidence: 1
  },
  {
    date: "2026-07-03T10:00:00Z",
    type: "purchase",
    item: "rice",
    quantity: 50,
    unit: "kg",
    pricePerUnit: 48,
    totalAmount: 2400,
    counterparty: "Wholesale Supplier",
    source: "manual",
    rawInput: "Bought 50kg rice from supplier",
    confidence: 1
  },
  {
    date: "2026-07-04T15:20:00Z",
    type: "expense",
    item: "electricity",
    quantity: 1,
    unit: "bill",
    pricePerUnit: 1200,
    totalAmount: 1200,
    counterparty: "Electricity Board",
    source: "manual",
    rawInput: "Paid electricity bill 1200",
    confidence: 1
  },
  {
    date: "2026-07-05T12:10:00Z",
    type: "sale",
    item: "sugar",
    quantity: 8,
    unit: "kg",
    pricePerUnit: 45,
    totalAmount: 360,
    counterparty: "Local Customer",
    source: "manual",
    rawInput: "Sold 8kg sugar",
    confidence: 1
  },
  {
    date: "2026-07-06T09:45:00Z",
    type: "sale",
    item: "milk",
    quantity: 20,
    unit: "packet",
    pricePerUnit: 30,
    totalAmount: 600,
    counterparty: "Local Customer",
    source: "manual",
    rawInput: "Sold 20 milk packets",
    confidence: 1
  },
  {
    date: "2026-07-07T14:00:00Z",
    type: "purchase",
    item: "onions",
    quantity: 30,
    unit: "kg",
    pricePerUnit: 28,
    totalAmount: 840,
    counterparty: "Vegetable Supplier",
    source: "manual",
    rawInput: "Bought 30kg onions",
    confidence: 1
  },
  {
    date: "2026-07-08T10:30:00Z",
    type: "sale",
    item: "wheat flour",
    quantity: 6,
    unit: "kg",
    pricePerUnit: 50,
    totalAmount: 300,
    counterparty: "Local Customer",
    source: "manual",
    rawInput: "Sold 6kg wheat flour",
    confidence: 1
  },
  {
    date: "2026-07-09T16:00:00Z",
    type: "expense",
    item: "transport",
    quantity: 1,
    unit: "trip",
    pricePerUnit: 500,
    totalAmount: 500,
    counterparty: "Auto Driver",
    source: "manual",
    rawInput: "Paid 500 for transport",
    confidence: 1
  },
  {
    date: "2026-07-10T11:15:00Z",
    type: "sale",
    item: "biscuits",
    quantity: 25,
    unit: "packet",
    pricePerUnit: 10,
    totalAmount: 250,
    counterparty: "Local Customer",
    source: "manual",
    rawInput: "Sold 25 biscuit packets",
    confidence: 1
  },

  {
    date: "2026-08-01T09:20:00Z",
    type: "sale",
    item: "rice",
    quantity: 12,
    unit: "kg",
    pricePerUnit: 60,
    totalAmount: 720,
    counterparty: "Local Customer",
    source: "manual",
    rawInput: "Sold 12kg rice",
    confidence: 1
  },
  {
    date: "2026-08-02T11:00:00Z",
    type: "sale",
    item: "onions",
    quantity: 7,
    unit: "kg",
    pricePerUnit: 40,
    totalAmount: 280,
    counterparty: "Ramu",
    source: "manual",
    rawInput: "Sold 7kg onions to Ramu",
    confidence: 1
  },
  {
    date: "2026-08-03T10:15:00Z",
    type: "purchase",
    item: "sugar",
    quantity: 40,
    unit: "kg",
    pricePerUnit: 38,
    totalAmount: 1520,
    counterparty: "Wholesale Supplier",
    source: "manual",
    rawInput: "Bought 40kg sugar",
    confidence: 1
  },
  {
    date: "2026-08-04T15:30:00Z",
    type: "sale",
    item: "milk",
    quantity: 25,
    unit: "packet",
    pricePerUnit: 30,
    totalAmount: 750,
    counterparty: "Local Customer",
    source: "manual",
    rawInput: "Sold 25 milk packets",
    confidence: 1
  },
  {
    date: "2026-08-05T13:00:00Z",
    type: "expense",
    item: "electricity",
    quantity: 1,
    unit: "bill",
    pricePerUnit: 1350,
    totalAmount: 1350,
    counterparty: "Electricity Board",
    source: "manual",
    rawInput: "Paid electricity bill 1350",
    confidence: 1
  },
  {
    date: "2026-08-06T10:40:00Z",
    type: "sale",
    item: "cooking oil",
    quantity: 5,
    unit: "litre",
    pricePerUnit: 140,
    totalAmount: 700,
    counterparty: "Local Customer",
    source: "manual",
    rawInput: "Sold 5 litres cooking oil",
    confidence: 1
  },
  {
    date: "2026-08-07T14:20:00Z",
    type: "purchase",
    item: "biscuits",
    quantity: 100,
    unit: "packet",
    pricePerUnit: 7,
    totalAmount: 700,
    counterparty: "Wholesale Supplier",
    source: "manual",
    rawInput: "Bought 100 biscuit packets",
    confidence: 1
  },
  {
    date: "2026-08-08T12:00:00Z",
    type: "sale",
    item: "wheat flour",
    quantity: 10,
    unit: "kg",
    pricePerUnit: 50,
    totalAmount: 500,
    counterparty: "Local Customer",
    source: "manual",
    rawInput: "Sold 10kg wheat flour",
    confidence: 1
  },
  {
    date: "2026-08-09T16:15:00Z",
    type: "expense",
    item: "transport",
    quantity: 1,
    unit: "trip",
    pricePerUnit: 600,
    totalAmount: 600,
    counterparty: "Auto Driver",
    source: "manual",
    rawInput: "Paid 600 transport",
    confidence: 1
  },
  {
    date: "2026-08-10T11:30:00Z",
    type: "sale",
    item: "dal",
    quantity: 5,
    unit: "kg",
    pricePerUnit: 110,
    totalAmount: 550,
    counterparty: "Local Customer",
    source: "manual",
    rawInput: "Sold 5kg dal",
    confidence: 1
  },

  {
    date: "2026-09-01T09:30:00Z",
    type: "sale",
    item: "rice",
    quantity: 15,
    unit: "kg",
    pricePerUnit: 60,
    totalAmount: 900,
    counterparty: "Local Customer",
    source: "manual",
    rawInput: "Sold 15kg rice",
    confidence: 1
  },
  {
    date: "2026-09-02T10:45:00Z",
    type: "sale",
    item: "onions",
    quantity: 10,
    unit: "kg",
    pricePerUnit: 42,
    totalAmount: 420,
    counterparty: "Ramu",
    source: "manual",
    rawInput: "Sold 10kg onions to Ramu",
    confidence: 1
  },
  {
    date: "2026-09-03T13:15:00Z",
    type: "purchase",
    item: "rice",
    quantity: 60,
    unit: "kg",
    pricePerUnit: 49,
    totalAmount: 2940,
    counterparty: "Wholesale Supplier",
    source: "manual",
    rawInput: "Bought 60kg rice",
    confidence: 1
  },
  {
    date: "2026-09-04T11:00:00Z",
    type: "sale",
    item: "sugar",
    quantity: 12,
    unit: "kg",
    pricePerUnit: 45,
    totalAmount: 540,
    counterparty: "Local Customer",
    source: "manual",
    rawInput: "Sold 12kg sugar",
    confidence: 1
  },
  {
    date: "2026-09-05T15:00:00Z",
    type: "expense",
    item: "electricity",
    quantity: 1,
    unit: "bill",
    pricePerUnit: 1400,
    totalAmount: 1400,
    counterparty: "Electricity Board",
    source: "manual",
    rawInput: "Paid electricity bill 1400",
    confidence: 1
  },
  {
    date: "2026-09-06T10:15:00Z",
    type: "sale",
    item: "milk",
    quantity: 30,
    unit: "packet",
    pricePerUnit: 30,
    totalAmount: 900,
    counterparty: "Local Customer",
    source: "manual",
    rawInput: "Sold 30 milk packets",
    confidence: 1
  },
  {
    date: "2026-09-07T12:30:00Z",
    type: "purchase",
    item: "onions",
    quantity: 40,
    unit: "kg",
    pricePerUnit: 30,
    totalAmount: 1200,
    counterparty: "Vegetable Supplier",
    source: "manual",
    rawInput: "Bought 40kg onions",
    confidence: 1
  },
  {
    date: "2026-09-08T14:10:00Z",
    type: "sale",
    item: "cooking oil",
    quantity: 8,
    unit: "litre",
    pricePerUnit: 145,
    totalAmount: 1160,
    counterparty: "Local Customer",
    source: "manual",
    rawInput: "Sold 8 litres cooking oil",
    confidence: 1
  },
  {
    date: "2026-09-09T16:30:00Z",
    type: "expense",
    item: "transport",
    quantity: 1,
    unit: "trip",
    pricePerUnit: 550,
    totalAmount: 550,
    counterparty: "Auto Driver",
    source: "manual",
    rawInput: "Paid 550 transport",
    confidence: 1
  },
  {
    date: "2026-09-10T11:45:00Z",
    type: "sale",
    item: "biscuits",
    quantity: 30,
    unit: "packet",
    pricePerUnit: 10,
    totalAmount: 300,
    counterparty: "Local Customer",
    source: "manual",
    rawInput: "Sold 30 biscuit packets",
    confidence: 1
  },

  {
    date: "2026-09-11T09:45:00Z",
    type: "sale",
    item: "dal",
    quantity: 7,
    unit: "kg",
    pricePerUnit: 110,
    totalAmount: 770,
    counterparty: "Local Customer",
    source: "manual",
    rawInput: "Sold 7kg dal",
    confidence: 1
  },
  {
    date: "2026-09-12T10:30:00Z",
    type: "sale",
    item: "rice",
    quantity: 10,
    unit: "kg",
    pricePerUnit: 60,
    totalAmount: 600,
    counterparty: "Local Customer",
    source: "manual",
    rawInput: "Sold 10kg rice",
    confidence: 1
  },
  {
    date: "2026-09-13T13:00:00Z",
    type: "purchase",
    item: "sugar",
    quantity: 50,
    unit: "kg",
    pricePerUnit: 39,
    totalAmount: 1950,
    counterparty: "Wholesale Supplier",
    source: "manual",
    rawInput: "Bought 50kg sugar",
    confidence: 1
  },
  {
    date: "2026-09-14T11:20:00Z",
    type: "sale",
    item: "wheat flour",
    quantity: 12,
    unit: "kg",
    pricePerUnit: 52,
    totalAmount: 624,
    counterparty: "Local Customer",
    source: "manual",
    rawInput: "Sold 12kg wheat flour",
    confidence: 1
  },
  {
    date: "2026-09-15T15:40:00Z",
    type: "expense",
    item: "shop rent",
    quantity: 1,
    unit: "month",
    pricePerUnit: 8000,
    totalAmount: 8000,
    counterparty: "Landlord",
    source: "manual",
    rawInput: "Paid monthly shop rent 8000",
    confidence: 1
  },
  {
    date: "2026-09-16T10:00:00Z",
    type: "sale",
    item: "onions",
    quantity: 8,
    unit: "kg",
    pricePerUnit: 42,
    totalAmount: 336,
    counterparty: "Local Customer",
    source: "manual",
    rawInput: "Sold 8kg onions",
    confidence: 1
  },
  {
    date: "2026-09-17T12:15:00Z",
    type: "sale",
    item: "milk",
    quantity: 35,
    unit: "packet",
    pricePerUnit: 30,
    totalAmount: 1050,
    counterparty: "Local Customer",
    source: "manual",
    rawInput: "Sold 35 milk packets",
    confidence: 1
  },
  {
    date: "2026-09-18T10:30:00Z",
    type: "sale",
    item: "rice",
    quantity: 18,
    unit: "kg",
    pricePerUnit: 60,
    totalAmount: 1080,
    counterparty: "Ramu",
    source: "manual",
    rawInput: "Sold 18kg rice to Ramu",
    confidence: 1
  },
  {
    date: "2026-09-18T12:00:00Z",
    type: "expense",
    item: "packaging",
    quantity: 1,
    unit: "bundle",
    pricePerUnit: 300,
    totalAmount: 300,
    counterparty: "Packaging Supplier",
    source: "manual",
    rawInput: "Bought packaging materials for 300",
    confidence: 1
  }
];

async function seedTransactions() {
  console.log(`Seeding ${transactions.length} transactions...`);

  for (const transaction of transactions) {
    const item = {
      transactionId: randomUUID(),
      userId: USER_ID,
      currency: "INR",
      ...transaction
    };

    await dynamoClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: item
      })
    );

    console.log(
      `Inserted ${item.transactionId} - ${item.type} - ${item.item} - ₹${item.totalAmount}`
    );
  }

  console.log("Seed complete.");
}

seedTransactions().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});