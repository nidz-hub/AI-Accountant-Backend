const {
  TranscribeClient,
  StartTranscriptionJobCommand,
  GetTranscriptionJobCommand
} = require("@aws-sdk/client-transcribe");

const {
  S3Client,
  GetObjectCommand
} = require("@aws-sdk/client-s3");

const {
  DynamoDBClient,
  PutItemCommand
} = require("@aws-sdk/client-dynamodb");

const crypto = require("crypto");

const { invokeBedrock } = require("../../shared/bedrockParse");
const {
  validateTransaction,
  normalizeTransaction
} = require("../../shared/transactionSchema");
const { success, error } = require("../../shared/response");

const transcribe = new TranscribeClient({});
const s3 = new S3Client({});
const dynamodb = new DynamoDBClient({});

const BUCKET_NAME = process.env.UPLOAD_BUCKET;
const TABLE_NAME = process.env.TABLE_NAME;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function streamToString(stream) {
  const chunks = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf-8");
}

/*
 * ============================================================
 * BEDROCK PROMPT
 * ============================================================
 */

function buildPrompt(transcript) {
  return `
You are a transaction extraction system for an informal Indian MSME.

Convert the spoken transcript into structured transaction data.

Return ONLY valid JSON.

Return a JSON ARRAY:

[
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
]

Rules:

- Currency must always be INR.
- bought/purchased/buying => purchase.
- sold/selling/sale => sale.
- paid/spent/bill/rent/wages/electricity/fuel/transport => expense.
- Extract quantity and unit.
- If total amount and quantity are known, calculate pricePerUnit.
- If quantity and pricePerUnit are known, calculate totalAmount.
- Extract counterparty from "from", "to", "customer", "vendor", etc.
- confidence must be between 0 and 1.
- Do not include Markdown.
- Do not include explanations.

Transcript:
${transcript}
`;
}

/*
 * ============================================================
 * BEDROCK JSON HELPERS
 * ============================================================
 */

function cleanBedrockText(text) {
  let cleaned = String(text || "").trim();

  cleaned = cleaned
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  return cleaned;
}

function extractJsonFromText(text) {
  const cleaned = cleanBedrockText(text);

  try {
    return JSON.parse(cleaned);
  } catch (_) {
    // Continue.
  }

  const arrayStart = cleaned.indexOf("[");
  const arrayEnd = cleaned.lastIndexOf("]");

  if (arrayStart !== -1 && arrayEnd > arrayStart) {
    try {
      return JSON.parse(
        cleaned.slice(arrayStart, arrayEnd + 1)
      );
    } catch (_) {
      // Continue.
    }
  }

  const objectStart = cleaned.indexOf("{");
  const objectEnd = cleaned.lastIndexOf("}");

  if (objectStart !== -1 && objectEnd > objectStart) {
    try {
      return JSON.parse(
        cleaned.slice(objectStart, objectEnd + 1)
      );
    } catch (_) {
      // Continue.
    }
  }

  throw new Error("Unable to parse Bedrock JSON response");
}

function normalizeParsedTransaction(parsed, transcript) {
  const transaction = {
    ...parsed
  };

  const typeText = String(transaction.type || "")
    .trim()
    .toLowerCase();

  if (
    ["buy", "bought", "purchase", "purchased"].includes(
      typeText
    )
  ) {
    transaction.type = "purchase";
  } else if (
    ["sell", "sold", "sale", "selling"].includes(
      typeText
    )
  ) {
    transaction.type = "sale";
  } else if (
    ["expense", "spent", "paid"].includes(typeText)
  ) {
    transaction.type = "expense";
  }

  transaction.currency = "INR";

  transaction.quantity = Number(transaction.quantity);
  transaction.pricePerUnit = Number(
    transaction.pricePerUnit
  );
  transaction.totalAmount = Number(
    transaction.totalAmount
  );

  if (
    Number.isFinite(transaction.quantity) &&
    transaction.quantity > 0 &&
    Number.isFinite(transaction.totalAmount) &&
    transaction.totalAmount >= 0 &&
    (!Number.isFinite(transaction.pricePerUnit) ||
      transaction.pricePerUnit < 0)
  ) {
    transaction.pricePerUnit =
      transaction.totalAmount / transaction.quantity;
  }

  if (
    Number.isFinite(transaction.quantity) &&
    transaction.quantity > 0 &&
    Number.isFinite(transaction.pricePerUnit) &&
    transaction.pricePerUnit >= 0 &&
    (!Number.isFinite(transaction.totalAmount) ||
      transaction.totalAmount < 0)
  ) {
    transaction.totalAmount =
      transaction.quantity *
      transaction.pricePerUnit;
  }

  if (Number.isFinite(transaction.pricePerUnit)) {
    transaction.pricePerUnit =
      Math.round(
        transaction.pricePerUnit * 100
      ) / 100;
  }

  if (Number.isFinite(transaction.totalAmount)) {
    transaction.totalAmount =
      Math.round(
        transaction.totalAmount * 100
      ) / 100;
  }

  if (
    transaction.counterparty === undefined ||
    transaction.counterparty === "" ||
    transaction.counterparty === "null"
  ) {
    transaction.counterparty = null;
  }

  let confidence = Number(
    transaction.confidence
  );

  if (!Number.isFinite(confidence)) {
    confidence = 0.5;
  }

  transaction.confidence = Math.max(
    0,
    Math.min(1, confidence)
  );

  if (!transaction.date) {
    transaction.date =
      new Date().toISOString();
  }

  transaction.rawInput = transcript;

  return transaction;
}

/*
 * ============================================================
 * LOCAL VOICE PARSER
 *
 * This is the emergency/demo-safe fallback.
 *
 * It does NOT depend on Bedrock.
 * ============================================================
 */

function parseMoney(text) {
  const patterns = [
    /(?:₹|rs\.?|rs|rupees?|inr)\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i,

    /(?:for|cost|costs|amount|total)\s*(?:₹|rs\.?|rs|rupees?|inr)?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i,

    /\b([0-9][0-9,]*(?:\.[0-9]+)?)\s*(?:rupees?|rs)\b/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);

    if (match) {
      const value = Number(
        String(match[1]).replace(/,/g, "")
      );

      if (Number.isFinite(value)) {
        return value;
      }
    }
  }

  return null;
}

function normalizeUnit(unit) {
  const u = String(unit || "")
    .trim()
    .toLowerCase();

  const units = {
    kg: "kg",
    kgs: "kg",
    kilogram: "kg",
    kilograms: "kg",

    g: "g",
    gm: "g",
    gms: "g",
    gram: "g",
    grams: "g",

    l: "litre",
    litre: "litre",
    litres: "litre",
    liter: "litre",
    liters: "litre",

    ml: "ml",
    millilitre: "ml",
    millilitres: "ml",

    piece: "piece",
    pieces: "piece",
    pcs: "piece",

    bag: "bag",
    bags: "bag",

    box: "box",
    boxes: "box",

    packet: "packet",
    packets: "packet"
  };

  return units[u] || u || "unit";
}

function parseQuantityAndItem(transcript) {
  /*
   * Handles:
   *
   * 2 kg tomato
   * 2 kilograms tomato
   * 2 kg of tomato
   * 5 pieces onions
   */

  const match = transcript.match(
    /(?:bought|buy|purchase|purchased|sold|sell|selling|got|procured)\s+(\d+(?:\.\d+)?)\s*(kg|kgs|kilogram|kilograms|g|gm|gms|gram|grams|l|litre|litres|liter|liters|ml|millilitre|millilitres|piece|pieces|pcs|bag|bags|box|boxes|packet|packets)\s+(?:of\s+)?(.+?)(?=\s+(?:from|to|for|at|by|with)\b|$)/i
  );

  if (!match) {
    return {
      quantity: 1,
      unit: "unit",
      item: null
    };
  }

  return {
    quantity: Number(match[1]),
    unit: normalizeUnit(match[2]),
    item: cleanItemName(match[3])
  };
}

function cleanItemName(item) {
  if (!item) {
    return null;
  }

  return String(item)
    .trim()
    .replace(
      /\b(for|from|to|at|by|with)\s*$/i,
      ""
    )
    .replace(/\s+/g, " ")
    .trim();
}

function parseItemWithoutQuantity(transcript) {
  const patterns = [
    /(?:bought|purchased|buy|sold|sell)\s+(?:some\s+)?(.+?)(?=\s+(?:from|to|for|at)\b|$)/i,

    /(?:expense|paid|spent)\s+(?:for\s+)?(.+?)(?=\s+(?:to|from|for|at)\b|$)/i
  ];

  for (const pattern of patterns) {
    const match = transcript.match(pattern);

    if (match) {
      const item = cleanItemName(match[1]);

      if (item) {
        return item;
      }
    }
  }

  return null;
}

function parseCounterparty(transcript) {
  const patterns = [
    /\bfrom\s+([A-Za-z][A-Za-z .'-]*?)(?=\s+(?:for|at|with|and)\b|[,.]|$)/i,

    /\bto\s+([A-Za-z][A-Za-z .'-]*?)(?=\s+(?:for|at|with|and)\b|[,.]|$)/i,

    /\bvendor\s+([A-Za-z][A-Za-z .'-]*?)(?=\s+(?:for|at)\b|[,.]|$)/i,

    /\bcustomer\s+([A-Za-z][A-Za-z .'-]*?)(?=\s+(?:for|at)\b|[,.]|$)/i
  ];

  for (const pattern of patterns) {
    const match = transcript.match(pattern);

    if (match) {
      return match[1].trim();
    }
  }

  return null;
}

function detectTransactionType(transcript) {
  const text = transcript.toLowerCase();

  if (
    /\b(bought|buy|purchase|purchased|procured|get|got)\b/.test(
      text
    )
  ) {
    return "purchase";
  }

  if (
    /\b(sold|sell|selling|sale|received from customer)\b/.test(
      text
    )
  ) {
    return "sale";
  }

  return "expense";
}

function parseTranscriptLocally(transcript) {
  console.log(
    "Using local voice transaction parser"
  );

  const type =
    detectTransactionType(transcript);

  const parsedQuantity =
    parseQuantityAndItem(transcript);

  const item =
    parsedQuantity.item ||
    parseItemWithoutQuantity(transcript);

  const quantity =
    parsedQuantity.quantity || 1;

  const unit =
    parsedQuantity.unit || "unit";

  const totalAmount =
    parseMoney(transcript);

  let pricePerUnit = 0;

  if (
    totalAmount !== null &&
    quantity > 0
  ) {
    pricePerUnit =
      totalAmount / quantity;
  }

  /*
   * Confidence is based on how much information
   * was successfully extracted.
   */
  let confidence = 0.35;

  if (item) {
    confidence += 0.20;
  }

  if (quantity > 0 && unit !== "unit") {
    confidence += 0.15;
  }

  if (totalAmount !== null) {
    confidence += 0.15;
  }

  const counterparty =
    parseCounterparty(transcript);

  if (counterparty) {
    confidence += 0.10;
  }

  confidence = Math.min(
    0.95,
    confidence
  );

  return [
    {
      date: new Date().toISOString(),
      type,
      item: item || "Unrecognized item",
      quantity,
      unit,
      pricePerUnit,
      totalAmount:
        totalAmount !== null
          ? totalAmount
          : 0,
      currency: "INR",
      counterparty,
      confidence
    }
  ];
}

/*
 * ============================================================
 * BEDROCK FIRST, LOCAL PARSER SECOND
 * ============================================================
 */

async function parseTranscriptWithBedrock(transcript) {
  const prompt = buildPrompt(transcript);

  console.log(
    "Sending transcript to Bedrock:",
    transcript
  );

  try {
    const response =
      await invokeBedrock(prompt);

    console.log(
      "Raw Bedrock response:",
      JSON.stringify(response)
    );

    const text =
      response?.content?.[0]?.text;

    if (!text) {
      throw new Error(
        "Bedrock returned no text"
      );
    }

    console.log(
      "Bedrock text response:",
      text
    );

    const parsed =
      extractJsonFromText(text);

    let transactions;

    if (Array.isArray(parsed)) {
      transactions = parsed;
    } else if (
      parsed &&
      Array.isArray(
        parsed.transactions
      )
    ) {
      transactions =
        parsed.transactions;
    } else {
      throw new Error(
        "Bedrock JSON does not contain transactions"
      );
    }

    if (transactions.length === 0) {
      throw new Error(
        "Bedrock returned no transactions"
      );
    }

    return transactions.map(
      (transaction) =>
        normalizeParsedTransaction(
          transaction,
          transcript
        )
    );
  } catch (bedrockError) {
    console.error(
      "Bedrock unavailable. Falling back to local parser:",
      bedrockError
    );

    /*
     * IMPORTANT:
     *
     * Do NOT create "Review voice entry".
     * Parse the transcript locally so the application
     * still works when Bedrock quota/access is unavailable.
     */
    return parseTranscriptLocally(
      transcript
    );
  }
}

/*
 * ============================================================
 * SAVE TRANSACTION
 * ============================================================
 */

async function saveTransaction(transaction) {
  const normalized =
    normalizeTransaction(
      transaction
    );

  const validation =
    validateTransaction(
      normalized
    );

  if (!validation.valid) {
    throw new Error(
      `Invalid transaction: ${validation.errors.join(
        ", "
      )}`
    );
  }

  await dynamodb.send(
    new PutItemCommand({
      TableName: TABLE_NAME,

      Item: {
        userId: {
          S: normalized.userId
        },

        transactionId: {
          S: normalized.transactionId
        },

        date: {
          S: normalized.date
        },

        type: {
          S: normalized.type
        },

        item: {
          S: normalized.item
        },

        quantity: {
          N: String(
            normalized.quantity
          )
        },

        unit: {
          S: normalized.unit
        },

        pricePerUnit: {
          N: String(
            normalized.pricePerUnit
          )
        },

        totalAmount: {
          N: String(
            normalized.totalAmount
          )
        },

        currency: {
          S: normalized.currency
        },

        counterparty: {
          S:
            normalized.counterparty ||
            ""
        },

        source: {
          S: normalized.source
        },

        rawInput: {
          S: normalized.rawInput
        },

        confidence: {
          N: String(
            normalized.confidence
          )
        }
      }
    })
  );

  return normalized;
}

/*
 * ============================================================
 * AWS TRANSCRIBE PATH
 * ============================================================
 */

async function transcribeFromS3(s3Key) {
  const jobName =
    `voice-${crypto.randomUUID()}`;

  console.log(
    "Starting transcription:",
    {
      bucket: BUCKET_NAME,
      s3Key
    }
  );

  await transcribe.send(
    new StartTranscriptionJobCommand({
      TranscriptionJobName:
        jobName,

      Media: {
        MediaFileUri:
          `s3://${BUCKET_NAME}/${s3Key}`
      },

      MediaFormat: "webm",

      MediaSampleRateHertz:
        48000,

      LanguageCode: "en-IN",

      OutputBucketName:
        BUCKET_NAME
    })
  );

  let transcriptUri;

  for (
    let attempt = 0;
    attempt < 30;
    attempt++
  ) {
    await sleep(2000);

    const result =
      await transcribe.send(
        new GetTranscriptionJobCommand({
          TranscriptionJobName:
            jobName
        })
      );

    const job =
      result.TranscriptionJob;

    console.log(
      "Transcription status:",
      job?.TranscriptionJobStatus
    );

    if (
      job?.TranscriptionJobStatus ===
      "COMPLETED"
    ) {
      transcriptUri =
        job.Transcript
          ?.TranscriptFileUri;

      break;
    }

    if (
      job?.TranscriptionJobStatus ===
      "FAILED"
    ) {
      throw new Error(
        job.FailureReason ||
          "Transcription job failed"
      );
    }
  }

  if (!transcriptUri) {
    throw new Error(
      "Transcription timed out"
    );
  }

  const url =
    new URL(transcriptUri);

  const bucket =
    url.hostname.split(".")[0];

  const key =
    decodeURIComponent(
      url.pathname.replace(
        /^\/+/,
        ""
      )
    );

  const transcriptObject =
    await s3.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key
      })
    );

  const transcriptJson =
    JSON.parse(
      await streamToString(
        transcriptObject.Body
      )
    );

  const transcript =
    transcriptJson
      ?.results
      ?.transcripts?.[0]
      ?.transcript;

  if (!transcript) {
    throw new Error(
      "Transcript text was empty"
    );
  }

  return transcript;
}

/*
 * ============================================================
 * LAMBDA HANDLER
 * ============================================================
 */

exports.handler = async (
  event
) => {
  try {
    const body =
      JSON.parse(
        event.body || "{}"
      );

    const userId =
      body.userId;

    const s3Key =
      body.s3Key;

    const suppliedTranscript =
      body.transcript;

    if (
      userId !== "demo-user"
    ) {
      return error(
        "Invalid userId",
        400
      );
    }

    let transcript;

    /*
     * Browser Web Speech API path.
     */
    if (
      typeof suppliedTranscript ===
        "string" &&
      suppliedTranscript.trim()
    ) {
      transcript =
        suppliedTranscript.trim();

      console.log(
        "Using supplied browser transcript"
      );
    } else {
      /*
       * AWS Transcribe path.
       */
      if (!s3Key) {
        return error(
          "Either transcript or s3Key is required",
          400
        );
      }

      if (
        !s3Key.startsWith(
          `uploads/${userId}/`
        )
      ) {
        return error(
          "Invalid s3Key",
          400
        );
      }

      transcript =
        await transcribeFromS3(
          s3Key
        );
    }

    console.log(
      "Final transcript:",
      transcript
    );

    /*
     * Bedrock first.
     * Local parser automatically takes over
     * if Bedrock is unavailable.
     */
    const parsedTransactions =
      await parseTranscriptWithBedrock(
        transcript
      );

    const transactions = [];

    for (
      const parsed of parsedTransactions
    ) {
      const transaction =
        normalizeTransaction({
          ...parsed,

          transactionId:
            crypto.randomUUID(),

          userId,

          source: "voice",

          rawInput:
            transcript
        });

      const validation =
        validateTransaction(
          transaction
        );

      if (!validation.valid) {
        console.error(
          "Invalid parsed transaction:",
          validation.errors,
          transaction
        );

        /*
         * Try local parsing once more
         * instead of returning Review voice entry.
         */
        const local =
          parseTranscriptLocally(
            transcript
          )[0];

        const fallbackTransaction =
          normalizeTransaction({
            ...local,

            transactionId:
              crypto.randomUUID(),

            userId,

            source: "voice",

            rawInput:
              transcript
          });

        const fallbackValidation =
          validateTransaction(
            fallbackTransaction
          );

        if (
          !fallbackValidation.valid
        ) {
          throw new Error(
            `Unable to parse voice transaction: ${fallbackValidation.errors.join(
              ", "
            )}`
          );
        }

        const saved =
          await saveTransaction(
            fallbackTransaction
          );

        transactions.push(saved);

        continue;
      }

      const saved =
        await saveTransaction(
          transaction
        );

      transactions.push(saved);
    }

    return success({
      transactions,
      transcript
    });
  } catch (err) {
    console.error(
      "processVoice error:",
      err
    );

    return error(
      "Unable to process the uploaded voice recording",
      500
    );
  }
};