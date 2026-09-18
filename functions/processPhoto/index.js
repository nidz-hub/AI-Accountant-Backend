const {
  TextractClient,
  AnalyzeExpenseCommand
} = require("@aws-sdk/client-textract");

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
  invokeBedrock
} = require("../../shared/bedrockParse");

const {
  success,
  error
} = require("../../shared/response");

const textract = new TextractClient({});

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
      console.error("Invalid request JSON:", event.body);
      console.error("JSON parse error:", parseError);

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
    // 4. Send image to Amazon Textract
    // ---------------------------------------------------------

    console.log("Starting Textract analysis:", {
      bucket: BUCKET_NAME,
      s3Key
    });

    const textractCommand = new AnalyzeExpenseCommand({
      Document: {
        S3Object: {
          Bucket: BUCKET_NAME,
          Name: s3Key
        }
      }
    });

    const textractResponse =
      await textract.send(textractCommand);

    console.log(
      "Raw Textract response:",
      JSON.stringify(textractResponse)
    );

    // ---------------------------------------------------------
    // 5. Extract useful text
    // ---------------------------------------------------------

    const extractedText =
      extractTextractText(textractResponse);

    console.log(
      "Extracted Textract text:",
      extractedText
    );

    if (!extractedText) {
      return error(
        "Could not extract readable information from the image",
        422
      );
    }

    // ---------------------------------------------------------
    // 6. Parse receipt using Bedrock
    // ---------------------------------------------------------

    const prompt =
      buildParsingPrompt(extractedText);

    let parsedTransactions;

    try {
      const bedrockResponse =
        await invokeBedrock(prompt);

      console.log(
        "Raw Bedrock parser response:",
        JSON.stringify(bedrockResponse)
      );

      parsedTransactions =
        extractTransactionsFromBedrock(
          bedrockResponse
        );

    } catch (bedrockError) {
      console.error(
        "Bedrock parsing failed:",
        bedrockError
      );

      // AI failure must not crash the request.
      parsedTransactions = [
        createFallbackTransaction(
          userId,
          extractedText
        )
      ];
    }

    // ---------------------------------------------------------
    // 7. Validate, normalize and save
    // ---------------------------------------------------------

    const savedTransactions = [];

    for (const transaction of parsedTransactions) {
      const normalized = normalizeTransaction({
        ...transaction,

        transactionId:
          transaction.transactionId ||
          crypto.randomUUID(),

        userId,
        source: "photo",
        rawInput: extractedText
      });

      const validation =
        validateTransaction(normalized);

      if (!validation.valid) {
        console.warn(
          "Bedrock transaction failed validation:",
          {
            errors: validation.errors,
            transaction: normalized
          }
        );

        const fallback =
          createFallbackTransaction(
            userId,
            extractedText
          );

        await saveTransaction(fallback);

        savedTransactions.push(fallback);

        continue;
      }

      await saveTransaction(normalized);

      savedTransactions.push(normalized);
    }

    // ---------------------------------------------------------
    // 8. Return normalized transactions
    // ---------------------------------------------------------

    return success({
      transactions: savedTransactions
    });

  } catch (err) {
    console.error(
      "processPhoto error:",
      err
    );

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
// Extract text from Textract AnalyzeExpense response
// =============================================================

function extractTextractText(response) {
  const parts = [];

  for (
    const document
    of response.ExpenseDocuments || []
  ) {
    for (
      const field
      of document.SummaryFields || []
    ) {
      const label =
        field.Type?.Text || "";

      const value =
        field.ValueDetection?.Text || "";

      if (label && value) {
        parts.push(`${label}: ${value}`);
      } else if (value) {
        parts.push(value);
      }
    }

    for (
      const group
      of document.LineItemGroups || []
    ) {
      for (
        const lineItem
        of group.LineItems || []
      ) {
        for (
          const field
          of lineItem.LineItemExpenseFields || []
        ) {
          const label =
            field.Type?.Text || "";

          const value =
            field.ValueDetection?.Text || "";

          if (label && value) {
            parts.push(`${label}: ${value}`);
          } else if (value) {
            parts.push(value);
          }
        }
      }
    }
  }

  return parts.join("\n").trim();
}


// =============================================================
// Bedrock prompt
// =============================================================

function buildParsingPrompt(extractedText) {
  return `
You are parsing a small-business receipt or bill for an accounting application.

Convert the extracted receipt text into a JSON array of transactions.

Each transaction MUST follow this structure:

{
  "date": "ISO-8601 date",
  "type": "sale" | "expense" | "purchase",
  "item": "string",
  "quantity": number,
  "unit": "string",
  "pricePerUnit": number,
  "totalAmount": number,
  "currency": "INR",
  "counterparty": "string or null",
  "confidence": number
}

Rules:
- Return ONLY valid JSON.
- Return an array, even when there is only one transaction.
- Use INR unless the receipt clearly specifies another currency.
- For purchases of goods used by the business, use "purchase".
- For business costs such as electricity, transport or rent, use "expense".
- Use "sale" when the receipt represents goods or services sold by the business.
- If a field cannot be determined, make a reasonable best guess and reduce confidence.
- confidence must be between 0 and 1.
- Do not invent unnecessary transactions.
- totalAmount should represent the transaction total.
- pricePerUnit should represent the unit price when it can be determined.

Extracted receipt text:

${extractedText}
`;
}


// =============================================================
// Extract transactions from Bedrock response
// =============================================================

function extractTransactionsFromBedrock(response) {
  const text =
    response?.content
      ?.find(
        (item) => item.type === "text"
      )
      ?.text || "";

  if (!text) {
    throw new Error(
      "Bedrock returned no text"
    );
  }

  const cleaned = text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  let parsed;

  try {
    parsed = JSON.parse(cleaned);
  } catch (parseError) {
    console.error(
      "Bedrock returned invalid JSON:",
      cleaned
    );

    throw parseError;
  }

  if (
    !Array.isArray(parsed) ||
    parsed.length === 0
  ) {
    throw new Error(
      "Bedrock did not return a valid transaction array"
    );
  }

  return parsed;
}


// =============================================================
// Fallback when Bedrock fails
// =============================================================

function createFallbackTransaction(
  userId,
  rawText
) {
  return {
    transactionId:
      crypto.randomUUID(),

    userId,

    date:
      new Date().toISOString(),

    type: "expense",

    item: "Review receipt",

    quantity: 1,

    unit: "item",

    pricePerUnit: 0,

    totalAmount: 0,

    currency: "INR",

    counterparty: null,

    source: "photo",

    rawInput: rawText,

    confidence: 0
  };
}