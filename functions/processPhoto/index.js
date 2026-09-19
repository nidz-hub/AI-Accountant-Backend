const {
  TextractClient,
  AnalyzeExpenseCommand
} = require("@aws-sdk/client-textract");

const {
  S3Client
} = require("@aws-sdk/client-s3");

const {
  PutCommand
} = require("@aws-sdk/lib-dynamodb");

const crypto = require("crypto");

const {
  dynamoClient,
  TABLE_NAME
} = require("../../shared/dynamoClient");

const {
  validateTransaction,
  normalizeTransaction
} = require("../../shared/transactionSchema");

const {
  success,
  error
} = require("../../shared/response");

const textract = new TextractClient({});
const s3 = new S3Client({});

const BUCKET_NAME = process.env.UPLOAD_BUCKET;

exports.handler = async (event) => {
  try {
    // ---------------------------------------------------------
    // 1. Validate configuration
    // ---------------------------------------------------------

    if (!BUCKET_NAME) {
      console.error("UPLOAD_BUCKET is not configured");
      return error("Upload storage is not configured", 500);
    }

    if (!TABLE_NAME) {
      console.error("TABLE_NAME is not configured");
      return error("Database is not configured", 500);
    }

    // ---------------------------------------------------------
    // 2. Parse request body safely
    // ---------------------------------------------------------

    let body;

    try {
      let rawBody = event.body || "{}";

      if (event.isBase64Encoded) {
        rawBody = Buffer.from(rawBody, "base64").toString("utf-8");
      }

      body =
        typeof rawBody === "string"
          ? JSON.parse(rawBody)
          : rawBody;
    } catch (parseError) {
      console.error("Invalid request JSON:", parseError);
      return error("Request body must be valid JSON", 400);
    }

    const userId = body.userId;
    const s3Key = body.s3Key;

    // ---------------------------------------------------------
    // 3. Validate request
    // ---------------------------------------------------------

    if (userId !== "demo-user") {
      return error("Invalid userId", 400);
    }

    if (!s3Key) {
      return error("s3Key is required", 400);
    }

    const expectedPrefix = `uploads/${userId}/`;

    if (!s3Key.startsWith(expectedPrefix)) {
      return error("Invalid s3Key", 400);
    }

    // ---------------------------------------------------------
    // 4. Analyze invoice/receipt using Textract
    // ---------------------------------------------------------

    console.log("Starting Textract expense analysis:", {
      bucket: BUCKET_NAME,
      s3Key
    });

    const textractResponse = await textract.send(
      new AnalyzeExpenseCommand({
        Document: {
          S3Object: {
            Bucket: BUCKET_NAME,
            Name: s3Key
          }
        }
      })
    );

    console.log(
      "Raw Textract response:",
      JSON.stringify(textractResponse)
    );

    const expenseDocuments =
      textractResponse.ExpenseDocuments || [];

    if (expenseDocuments.length === 0) {
      return error(
        "No receipt or invoice data was detected",
        422
      );
    }

    // ---------------------------------------------------------
    // 5. Convert Textract line items directly to transactions
    // ---------------------------------------------------------

    const transactions = [];

    for (const document of expenseDocuments) {
      const summary =
        extractSummaryFields(document);

      const lineItems =
        extractLineItems(document);

      console.log(
        "Textract summary fields:",
        summary
      );

      console.log(
        "Textract line items:",
        JSON.stringify(lineItems)
      );

      // -------------------------------------------------------
      // Normal invoice/receipt with line items
      // -------------------------------------------------------

      if (lineItems.length > 0) {
        for (const lineItem of lineItems) {
          const transaction =
            buildTransactionFromLineItem({
              userId,
              summary,
              lineItem
            });

          const normalized =
            normalizeTransaction(transaction);

          const validation =
            validateTransaction(normalized);

          if (!validation.valid) {
            console.warn(
              "Skipping invalid Textract line item:",
              validation.errors,
              normalized
            );

            continue;
          }

          await saveTransaction(normalized);

          transactions.push(normalized);
        }
      }

      // -------------------------------------------------------
      // Receipt without line items
      // -------------------------------------------------------

      else {
        const transaction =
          buildTransactionFromSummary({
            userId,
            summary
          });

        const normalized =
          normalizeTransaction(transaction);

        const validation =
          validateTransaction(normalized);

        if (!validation.valid) {
          console.error(
            "Textract summary transaction failed validation:",
            validation.errors,
            normalized
          );

          return error(
            "Could not extract a valid transaction from the receipt",
            422
          );
        }

        await saveTransaction(normalized);

        transactions.push(normalized);
      }
    }

    // ---------------------------------------------------------
    // 6. Ensure something was extracted
    // ---------------------------------------------------------

    if (transactions.length === 0) {
      return error(
        "Could not extract any transaction items from the receipt",
        422
      );
    }

    // ---------------------------------------------------------
    // 7. Return transactions
    // ---------------------------------------------------------

    return success({
      transactions
    });

  } catch (err) {
    console.error(
      "processPhoto error:",
      err
    );

    // Explicitly handle AWS service access problems.
    if (
      err?.name === "SubscriptionRequiredException" ||
      err?.name === "AccessDeniedException"
    ) {
      return error(
        "Receipt processing is temporarily unavailable because Amazon Textract access is not enabled for this AWS account yet.",
        503
      );
    }

    return error(
      "Unable to process the uploaded photo",
      500
    );
  }
};


// =============================================================
// Save transaction
// =============================================================

async function saveTransaction(transaction) {
  await dynamoClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: transaction
    })
  );
}


// =============================================================
// Extract summary fields
// =============================================================

function extractSummaryFields(document) {
  const fields = {};

  for (const field of document.SummaryFields || []) {
    const type =
      String(field.Type?.Text || "")
        .trim()
        .toUpperCase();

    const value =
      String(
        field.ValueDetection?.Text ||
        field.LabelDetection?.Text ||
        ""
      ).trim();

    if (!type || !value) {
      continue;
    }

    fields[type] = value;
  }

  return fields;
}


// =============================================================
// Extract invoice line items
// =============================================================

function extractLineItems(document) {
  const items = [];

  for (
    const group
    of document.LineItemGroups || []
  ) {
    for (
      const lineItem
      of group.LineItems || []
    ) {
      const fields = {};

      for (
        const field
        of lineItem.LineItemExpenseFields || []
      ) {
        const type =
          String(field.Type?.Text || "")
            .trim()
            .toUpperCase();

        const value =
          String(
            field.ValueDetection?.Text ||
            field.LabelDetection?.Text ||
            ""
          ).trim();

        const confidence =
          Number(
            field.ValueDetection?.Confidence || 0
          );

        if (!type || !value) {
          continue;
        }

        fields[type] = {
          value,
          confidence
        };
      }

      if (Object.keys(fields).length > 0) {
        items.push(fields);
      }
    }
  }

  return items;
}


// =============================================================
// Build transaction from line item
// =============================================================

function buildTransactionFromLineItem({
  userId,
  summary,
  lineItem
}) {
  const item =
    getFieldValue(lineItem, [
      "ITEM",
      "EXPENSE_ROW_ITEM",
      "DESCRIPTION"
    ]) || "Unknown item";

  const rawQuantity =
    getFieldValue(lineItem, [
      "QUANTITY",
      "QTY"
    ]);

  const parsedQuantity =
    parseQuantity(rawQuantity);

  const quantity =
    parsedQuantity.quantity || 1;

  const unit =
    parsedQuantity.unit || "item";

  const unitPrice =
    parseMoney(
      getFieldValue(lineItem, [
        "UNIT_PRICE",
        "RATE"
      ])
    );

  const linePrice =
    parseMoney(
      getFieldValue(lineItem, [
        "PRICE",
        "AMOUNT",
        "TOTAL"
      ])
    );

  const totalAmount =
    linePrice !== null
      ? linePrice
      : unitPrice !== null
        ? roundMoney(
            unitPrice * quantity
          )
        : 0;

  const pricePerUnit =
    unitPrice !== null
      ? unitPrice
      : quantity > 0 &&
        totalAmount !== 0
        ? roundMoney(
            totalAmount / quantity
          )
        : 0;

  const confidenceValues =
    Object.values(lineItem)
      .map(
        (field) =>
          Number(field.confidence)
      )
      .filter(
        (value) =>
          Number.isFinite(value) &&
          value > 0
      );

  const confidence =
    confidenceValues.length > 0
      ? roundConfidence(
          average(confidenceValues) / 100
        )
      : 0.7;

  return {
    transactionId:
      crypto.randomUUID(),

    userId,

    date:
      parseDate(
        summary.INVOICE_RECEIPT_DATE
      ),

    type:
      detectTransactionType(
        summary
      ),

    item:
      cleanItem(item),

    quantity,

    unit,

    pricePerUnit,

    totalAmount,

    currency:
      "INR",

    counterparty:
      getCounterparty(summary),

    source:
      "photo",

    rawInput:
      buildRawInput(
        summary,
        lineItem
      ),

    confidence
  };
}


// =============================================================
// Build transaction when no line items are available
// =============================================================

function buildTransactionFromSummary({
  userId,
  summary
}) {
  const total =
    parseMoney(
      summary.TOTAL ||
      summary.AMOUNT_DUE ||
      summary.AMOUNT_DUE_TO_VENDOR ||
      summary.SUBTOTAL
    );

  const item =
    summary.DESCRIPTION ||
    summary.ITEM ||
    "Receipt total";

  return {
    transactionId:
      crypto.randomUUID(),

    userId,

    date:
      parseDate(
        summary.INVOICE_RECEIPT_DATE
      ),

    type:
      detectTransactionType(
        summary
      ),

    item:
      cleanItem(item),

    quantity:
      1,

    unit:
      "invoice",

    pricePerUnit:
      total !== null
        ? total
        : 0,

    totalAmount:
      total !== null
        ? total
        : 0,

    currency:
      "INR",

    counterparty:
      getCounterparty(summary),

    source:
      "photo",

    rawInput:
      Object.entries(summary)
        .map(
          ([key, value]) =>
            `${key}: ${value}`
        )
        .join("\n"),

    confidence:
      total !== null
        ? 0.8
        : 0.5
  };
}


// =============================================================
// Get a field from line item
// =============================================================

function getFieldValue(
  lineItem,
  names
) {
  for (const name of names) {
    if (lineItem[name]?.value) {
      return lineItem[name].value;
    }
  }

  return null;
}


// =============================================================
// Parse quantity
// =============================================================

function parseQuantity(value) {
  if (!value) {
    return {
      quantity: 1,
      unit: "item"
    };
  }

  const text =
    String(value).trim();

  const match =
    text.match(
      /([0-9]+(?:[.,][0-9]+)?)\s*([A-Za-z]+)?/
    );

  if (!match) {
    return {
      quantity: 1,
      unit: "item"
    };
  }

  const quantity =
    Number(
      match[1].replace(/,/g, "")
    );

  const unit =
    normalizeUnit(match[2]);

  return {
    quantity:
      Number.isFinite(quantity) &&
      quantity > 0
        ? quantity
        : 1,

    unit
  };
}


// =============================================================
// Normalize units
// =============================================================

function normalizeUnit(value) {
  const unit =
    String(value || "")
      .trim()
      .toLowerCase();

  const map = {
    nos: "nos",
    no: "nos",

    pcs: "piece",
    pc: "piece",
    pieces: "piece",
    piece: "piece",

    kg: "kg",
    kgs: "kg",
    kilogram: "kg",
    kilograms: "kg",

    g: "g",
    gm: "g",
    gram: "g",
    grams: "g",

    l: "litre",
    litre: "litre",
    litres: "litre",
    liter: "litre",
    liters: "litre",

    ml: "ml",

    bag: "bag",
    bags: "bag",

    box: "box",
    boxes: "box",

    packet: "packet",
    packets: "packet"
  };

  return (
    map[unit] ||
    unit ||
    "item"
  );
}


// =============================================================
// Parse monetary value
// =============================================================

function parseMoney(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  const text =
    String(value)
      .replace(/[₹$€£]/g, "")
      .replace(/INR/gi, "")
      .replace(/Rs\.?/gi, "")
      .replace(/,/g, "")
      .trim();

  const match =
    text.match(
      /-?\d+(?:\.\d+)?/
    );

  if (!match) {
    return null;
  }

  const number =
    Number(match[0]);

  return Number.isFinite(number)
    ? roundMoney(number)
    : null;
}


// =============================================================
// Parse invoice date
// =============================================================

function parseDate(value) {
  if (!value) {
    return new Date().toISOString();
  }

  const parsed =
    new Date(value);

  if (
    Number.isNaN(
      parsed.getTime()
    )
  ) {
    return new Date().toISOString();
  }

  return parsed.toISOString();
}


// =============================================================
// Detect transaction type
// =============================================================

function detectTransactionType(summary) {
  const hasVendor =
    Boolean(
      summary.VENDOR_NAME ||
      summary.VENDOR_ADDRESS ||
      summary.VENDOR_GST_NUMBER
    );

  const hasCustomer =
    Boolean(
      summary.CUSTOMER_NAME ||
      summary.RECEIVER_NAME ||
      summary.BILL_TO_NAME
    );

  if (
    hasVendor &&
    !hasCustomer
  ) {
    return "purchase";
  }

  if (
    hasCustomer &&
    !hasVendor
  ) {
    return "sale";
  }

  return "purchase";
}


// =============================================================
// Counterparty
// =============================================================

function getCounterparty(summary) {
  return (
    summary.VENDOR_NAME ||
    summary.CUSTOMER_NAME ||
    summary.RECEIVER_NAME ||
    summary.BILL_TO_NAME ||
    null
  );
}


// =============================================================
// Clean item name
// =============================================================

function cleanItem(value) {
  return String(
    value || "Unknown item"
  )
    .replace(/\s+/g, " ")
    .trim();
}


// =============================================================
// Raw input for audit/debugging
// =============================================================

function buildRawInput(
  summary,
  lineItem
) {
  const summaryText =
    Object.entries(summary)
      .map(
        ([key, value]) =>
          `${key}: ${value}`
      )
      .join(" | ");

  const lineText =
    Object.entries(lineItem)
      .map(
        ([key, field]) =>
          `${key}: ${field.value}`
      )
      .join(" | ");

  return [
    summaryText,
    lineText
  ]
    .filter(Boolean)
    .join("\n");
}


// =============================================================
// Helpers
// =============================================================

function roundMoney(value) {
  return (
    Math.round(
      value * 100
    ) / 100
  );
}

function roundConfidence(value) {
  return (
    Math.round(
      value * 100
    ) / 100
  );
}

function average(values) {
  if (
    values.length === 0
  ) {
    return 0;
  }

  return (
    values.reduce(
      (sum, value) =>
        sum + value,
      0
    ) / values.length
  );
}