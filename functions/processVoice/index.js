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

const {
  success,
  error
} = require("../../shared/response");

const transcribe = new TranscribeClient({});
const s3 = new S3Client({});
const dynamodb = new DynamoDBClient({});

const BUCKET_NAME = process.env.UPLOAD_BUCKET;
const TABLE_NAME = process.env.TABLE_NAME;


// ============================================================
// Utility
// ============================================================

function sleep(ms) {
  return new Promise((resolve) =>
    setTimeout(resolve, ms)
  );
}

async function streamToString(stream) {
  const chunks = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf-8");
}


// ============================================================
// ITEM NORMALIZATION
//
// This is intentionally deterministic.
// It runs regardless of whether the transaction came from:
//
// Bedrock
// Local parser
// AWS Transcribe
// Browser transcript
//
// Examples:
// potatoes -> potato
// tomatoes -> tomato
// onions -> onion
// apples -> apple
// bananas -> banana
// biscuits -> biscuit
// boxes -> box
// packets -> packet
//
// rawInput is NOT changed.
// ============================================================

function normalizeItemName(item) {
  if (
    item === null ||
    item === undefined
  ) {
    return item;
  }

  let value = String(item)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

  if (!value) {
    return value;
  }

  // Explicit irregular / important grocery forms.
  const irregular = {
    potatoes: "potato",
    tomatoes: "tomato",
    mangoes: "mango",
    mangoes: "mango",
    children: "child",
    people: "person",
    men: "man",
    women: "woman",
    leaves: "leaf",
    knives: "knife",
    loaves: "loaf",
    wives: "wife",
    lives: "life",
    shelves: "shelf",
    halves: "half",
    calves: "calf"
  };

  if (irregular[value]) {
    return irregular[value];
  }

  // Words that should not be singularized.
  const unchanged = new Set([
    "rice",
    "wheat",
    "milk",
    "water",
    "sugar",
    "salt",
    "flour",
    "oil",
    "gas",
    "glass",
    "grass",
    "bread",
    "fish",
    "dal",
    "tea",
    "coffee",
    "curd",
    "soap",
    "cash",
    "business",
    "address"
  ]);

  function singularizeWord(word) {
    if (!word) {
      return word;
    }

    if (unchanged.has(word)) {
      return word;
    }

    if (irregular[word]) {
      return irregular[word];
    }

    // berries -> berry
    if (
      word.endsWith("ies") &&
      word.length > 3
    ) {
      return word.slice(0, -3) + "y";
    }

    // stories -> story
    if (
      word.endsWith("ies") &&
      word.length > 3
    ) {
      return word.slice(0, -3) + "y";
    }

    // boxes -> box
    // dishes -> dish
    // buses -> bus
    // classes -> class
    if (
      word.endsWith("ches") ||
      word.endsWith("shes") ||
      word.endsWith("xes") ||
      word.endsWith("zes") ||
      word.endsWith("sses")
    ) {
      return word.slice(0, -2);
    }

    // potatoes and tomatoes were explicitly handled above.
    // General -oes handling:
    // heroes -> hero
    // mangoes -> mango
    if (
      word.endsWith("oes") &&
      word.length > 3
    ) {
      return word.slice(0, -2);
    }

    // Remove simple plural s.
    //
    // Do not change:
    // gas
    // glass
    // business
    //
    // because they are handled by `unchanged`.
    if (
      word.endsWith("s") &&
      !word.endsWith("ss") &&
      word.length > 2
    ) {
      return word.slice(0, -1);
    }

    return word;
  }

  /*
   * Normalize every word in the item, but perform
   * singularization primarily on the final noun.
   *
   * Examples:
   *
   * "cooking oils" -> "cooking oil"
   * "wheat flours" -> "wheat flour"
   * "red onions"  -> "red onion"
   * "potatoes"    -> "potato"
   */

  const words = value.split(" ");

  if (words.length === 1) {
    return singularizeWord(words[0]);
  }

  const lastWord = words.pop();

  words.push(
    singularizeWord(lastWord)
  );

  return words.join(" ");
}


// ============================================================
// BEDROCK PROMPT
// ============================================================

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

IMPORTANT ITEM RULE:
- Return item names in lowercase.
- Return the item in singular canonical form whenever possible.
- Do not use plural item names.
- Examples:
  potatoes -> potato
  tomatoes -> tomato
  onions -> onion
  apples -> apple
  bananas -> banana
  biscuits -> biscuit
  eggs -> egg
  boxes -> box
  packets -> packet
  mangoes -> mango
- Preserve the original user sentence only in rawInput.

Transcript:
${transcript}
`;
}


// ============================================================
// BEDROCK JSON HELPERS
// ============================================================

function cleanBedrockText(text) {
  let cleaned = String(text || "")
    .trim();

  cleaned = cleaned
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  return cleaned;
}

function extractJsonFromText(text) {
  const cleaned =
    cleanBedrockText(text);

  // Direct JSON
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    // Continue.
  }

  // JSON array embedded in text
  const arrayStart =
    cleaned.indexOf("[");

  const arrayEnd =
    cleaned.lastIndexOf("]");

  if (
    arrayStart !== -1 &&
    arrayEnd > arrayStart
  ) {
    try {
      return JSON.parse(
        cleaned.slice(
          arrayStart,
          arrayEnd + 1
        )
      );
    } catch (_) {
      // Continue.
    }
  }

  // JSON object embedded in text
  const objectStart =
    cleaned.indexOf("{");

  const objectEnd =
    cleaned.lastIndexOf("}");

  if (
    objectStart !== -1 &&
    objectEnd > objectStart
  ) {
    try {
      return JSON.parse(
        cleaned.slice(
          objectStart,
          objectEnd + 1
        )
      );
    } catch (_) {
      // Continue.
    }
  }

  throw new Error(
    "Unable to parse Bedrock JSON response"
  );
}


// ============================================================
// NORMALIZE PARSED BEDROCK TRANSACTION
// ============================================================

function normalizeParsedTransaction(
  parsed,
  transcript
) {
  const transaction = {
    ...parsed
  };

  // -------------------------
  // Normalize transaction type
  // -------------------------

  const typeText =
    String(
      transaction.type || ""
    )
      .trim()
      .toLowerCase();

  if (
    [
      "buy",
      "bought",
      "purchase",
      "purchased"
    ].includes(typeText)
  ) {
    transaction.type =
      "purchase";
  } else if (
    [
      "sell",
      "sold",
      "sale",
      "selling"
    ].includes(typeText)
  ) {
    transaction.type =
      "sale";
  } else if (
    [
      "expense",
      "spent",
      "paid"
    ].includes(typeText)
  ) {
    transaction.type =
      "expense";
  }

  // -------------------------
  // Normalize item
  // -------------------------

  transaction.item =
    normalizeItemName(
      transaction.item
    );

  // -------------------------
  // Currency
  // -------------------------

  transaction.currency =
    "INR";

  // -------------------------
  // Numbers
  // -------------------------

  transaction.quantity =
    Number(transaction.quantity);

  transaction.pricePerUnit =
    Number(
      transaction.pricePerUnit
    );

  transaction.totalAmount =
    Number(
      transaction.totalAmount
    );

  // -------------------------
  // Calculate price per unit
  // -------------------------

  if (
    Number.isFinite(
      transaction.quantity
    ) &&
    transaction.quantity > 0 &&
    Number.isFinite(
      transaction.totalAmount
    ) &&
    transaction.totalAmount >= 0 &&
    (
      !Number.isFinite(
        transaction.pricePerUnit
      ) ||
      transaction.pricePerUnit < 0
    )
  ) {
    transaction.pricePerUnit =
      transaction.totalAmount /
      transaction.quantity;
  }

  // -------------------------
  // Calculate total amount
  // -------------------------

  if (
    Number.isFinite(
      transaction.quantity
    ) &&
    transaction.quantity > 0 &&
    Number.isFinite(
      transaction.pricePerUnit
    ) &&
    transaction.pricePerUnit >= 0 &&
    (
      !Number.isFinite(
        transaction.totalAmount
      ) ||
      transaction.totalAmount < 0
    )
  ) {
    transaction.totalAmount =
      transaction.quantity *
      transaction.pricePerUnit;
  }

  // -------------------------
  // Round monetary values
  // -------------------------

  if (
    Number.isFinite(
      transaction.pricePerUnit
    )
  ) {
    transaction.pricePerUnit =
      Math.round(
        transaction.pricePerUnit * 100
      ) / 100;
  }

  if (
    Number.isFinite(
      transaction.totalAmount
    )
  ) {
    transaction.totalAmount =
      Math.round(
        transaction.totalAmount * 100
      ) / 100;
  }

  // -------------------------
  // Counterparty
  // -------------------------

  if (
    transaction.counterparty ===
      undefined ||
    transaction.counterparty ===
      "" ||
    String(
      transaction.counterparty
    ).toLowerCase() === "null"
  ) {
    transaction.counterparty =
      null;
  }

  // -------------------------
  // Confidence
  // -------------------------

  let confidence =
    Number(
      transaction.confidence
    );

  if (
    !Number.isFinite(
      confidence
    )
  ) {
    confidence = 0.5;
  }

  transaction.confidence =
    Math.max(
      0,
      Math.min(
        1,
        confidence
      )
    );

  // -------------------------
  // Date
  // -------------------------

  if (!transaction.date) {
    transaction.date =
      new Date().toISOString();
  }

  // -------------------------
  // Preserve exact transcript
  // -------------------------

  transaction.rawInput =
    transcript;

  return transaction;
}


// ============================================================
// MONEY PARSER
// ============================================================

function parseMoney(text) {
  const patterns = [
    /(?:₹|rs\.?|rs|rupees?|inr)\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i,

    /(?:for|cost|costs|amount|total)\s*(?:₹|rs\.?|rs|rupees?|inr)?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i,

    /\b([0-9][0-9,]*(?:\.[0-9]+)?)\s*(?:rupees?|rs)\b/i
  ];

  for (
    const pattern
    of patterns
  ) {
    const match =
      text.match(pattern);

    if (match) {
      const value =
        Number(
          String(match[1])
            .replace(/,/g, "")
        );

      if (
        Number.isFinite(value)
      ) {
        return value;
      }
    }
  }

  return null;
}


// ============================================================
// UNIT NORMALIZATION
// ============================================================

function normalizeUnit(unit) {
  const u =
    String(unit || "")
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
    milliliter: "ml",
    milliliters: "ml",

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

  return (
    units[u] ||
    u ||
    "unit"
  );
}


// ============================================================
// CLEAN ITEM NAME
// ============================================================

function cleanItemName(item) {
  if (!item) {
    return null;
  }

  const cleaned =
    String(item)
      .trim()
      .replace(
        /\b(for|from|to|at|by|with)\s*$/i,
        ""
      )
      .replace(
        /\s+/g,
        " "
      )
      .trim();

  if (!cleaned) {
    return null;
  }

  return normalizeItemName(
    cleaned
  );
}


// ============================================================
// QUANTITY + ITEM PARSER
// ============================================================

function parseQuantityAndItem(
  transcript
) {
  /*
   * Handles:
   *
   * 2 kg tomato
   * 2 kilograms tomato
   * 2 kg of tomato
   * 5 pieces onions
   * 10 packets biscuits
   * 3 boxes chocolates
   */

  const match =
    transcript.match(
      /(?:bought|buy|purchase|purchased|sold|sell|selling|got|procured|get)\s+(\d+(?:\.\d+)?)\s*(kg|kgs|kilogram|kilograms|g|gm|gms|gram|grams|l|litre|litres|liter|liters|ml|millilitre|millilitres|milliliter|milliliters|piece|pieces|pcs|bag|bags|box|boxes|packet|packets)\s+(?:of\s+)?(.+?)(?=\s+(?:from|to|for|at|by|with)\b|[,.]|$)/i
    );

  if (!match) {
    return {
      quantity: 1,
      unit: "unit",
      item: null
    };
  }

  return {
    quantity:
      Number(match[1]),

    unit:
      normalizeUnit(match[2]),

    item:
      cleanItemName(match[3])
  };
}


// ============================================================
// ITEM WITHOUT QUANTITY
// ============================================================

function parseItemWithoutQuantity(
  transcript
) {
  const patterns = [
    /(?:bought|purchased|buy|sold|sell)\s+(?:some\s+)?(.+?)(?=\s+(?:from|to|for|at)\b|[,.]|$)/i,

    /(?:expense|paid|spent)\s+(?:for\s+)?(.+?)(?=\s+(?:to|from|for|at)\b|[,.]|$)/i
  ];

  for (
    const pattern
    of patterns
  ) {
    const match =
      transcript.match(pattern);

    if (match) {
      const item =
        cleanItemName(
          match[1]
        );

      if (item) {
        return item;
      }
    }
  }

  return null;
}


// ============================================================
// COUNTERPARTY PARSER
// ============================================================

function parseCounterparty(
  transcript
) {
  const patterns = [
    /\bfrom\s+([A-Za-z][A-Za-z .'-]*?)(?=\s+(?:for|at|with|and)\b|[,.]|$)/i,

    /\bto\s+([A-Za-z][A-Za-z .'-]*?)(?=\s+(?:for|at|with|and)\b|[,.]|$)/i,

    /\bvendor\s+([A-Za-z][A-Za-z .'-]*?)(?=\s+(?:for|at)\b|[,.]|$)/i,

    /\bcustomer\s+([A-Za-z][A-Za-z .'-]*?)(?=\s+(?:for|at)\b|[,.]|$)/i
  ];

  for (
    const pattern
    of patterns
  ) {
    const match =
      transcript.match(pattern);

    if (match) {
      return match[1].trim();
    }
  }

  return null;
}


// ============================================================
// TRANSACTION TYPE
// ============================================================

function detectTransactionType(
  transcript
) {
  const text =
    transcript.toLowerCase();

  if (
    /\b(bought|buy|purchase|purchased|procured|get|got|received stock)\b/.test(
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


// ============================================================
// LOCAL VOICE PARSER
// ============================================================

function parseTranscriptLocally(
  transcript
) {
  console.log(
    "Using local voice transaction parser"
  );

  const type =
    detectTransactionType(
      transcript
    );

  const parsedQuantity =
    parseQuantityAndItem(
      transcript
    );

  const item =
    parsedQuantity.item ||
    parseItemWithoutQuantity(
      transcript
    );

  const normalizedItem =
    normalizeItemName(
      item
    );

  const quantity =
    parsedQuantity.quantity ||
    1;

  const unit =
    parsedQuantity.unit ||
    "unit";

  const totalAmount =
    parseMoney(
      transcript
    );

  let pricePerUnit = 0;

  if (
    totalAmount !== null &&
    quantity > 0
  ) {
    pricePerUnit =
      totalAmount / quantity;
  }

  /*
   * Confidence based on
   * extracted information.
   */

  let confidence = 0.35;

  if (normalizedItem) {
    confidence += 0.20;
  }

  if (
    quantity > 0 &&
    unit !== "unit"
  ) {
    confidence += 0.15;
  }

  if (
    totalAmount !== null
  ) {
    confidence += 0.15;
  }

  const counterparty =
    parseCounterparty(
      transcript
    );

  if (counterparty) {
    confidence += 0.10;
  }

  confidence =
    Math.min(
      0.95,
      confidence
    );

  return [
    {
      date:
        new Date()
          .toISOString(),

      type,

      item:
        normalizedItem ||
        "Unrecognized item",

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


// ============================================================
// BEDROCK FIRST,
// LOCAL PARSER SECOND
// ============================================================

async function parseTranscriptWithBedrock(
  transcript
) {
  const prompt =
    buildPrompt(
      transcript
    );

  console.log(
    "Sending transcript to Bedrock:",
    transcript
  );

  try {
    const response =
      await invokeBedrock(
        prompt
      );

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
      extractJsonFromText(
        text
      );

    let transactions;

    if (
      Array.isArray(parsed)
    ) {
      transactions =
        parsed;
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

    if (
      transactions.length === 0
    ) {
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
     * Do NOT create
     * "Review voice entry".
     *
     * Parse locally so the app
     * continues working when
     * Bedrock access/quota fails.
     */

    return parseTranscriptLocally(
      transcript
    );
  }
}


// ============================================================
// SAVE TRANSACTION
// ============================================================

async function saveTransaction(
  transaction
) {
  let normalized =
    normalizeTransaction(
      transaction
    );

  /*
   * FINAL ITEM NORMALIZATION BARRIER
   *
   * Even if some earlier path
   * missed normalization,
   * nothing plural reaches
   * DynamoDB for common forms.
   */
  normalized.item =
    normalizeItemName(
      normalized.item
    );

  const validation =
    validateTransaction(
      normalized
    );

  if (
    !validation.valid
  ) {
    throw new Error(
      `Invalid transaction: ${validation.errors.join(
        ", "
      )}`
    );
  }

  await dynamodb.send(
    new PutItemCommand({
      TableName:
        TABLE_NAME,

      Item: {
        userId: {
          S: normalized.userId
        },

        transactionId: {
          S:
            normalized.transactionId
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


// ============================================================
// AWS TRANSCRIBE PATH
// ============================================================

async function transcribeFromS3(
  s3Key
) {
  const jobName =
    `voice-${crypto.randomUUID()}`;

  console.log(
    "Starting transcription:",
    {
      bucket:
        BUCKET_NAME,
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

      MediaFormat:
        "webm",

      MediaSampleRateHertz:
        48000,

      LanguageCode:
        "en-IN",

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

  /*
   * AWS Transcribe returns a URL
   * to the transcript JSON.
   */

  const url =
    new URL(
      transcriptUri
    );

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
        Bucket:
          bucket,

        Key:
          key
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


// ============================================================
// LAMBDA HANDLER
// ============================================================

exports.handler =
  async (event) => {
    try {
      const body =
        JSON.parse(
          event.body ||
            "{}"
        );

      const userId =
        body.userId;

      const s3Key =
        body.s3Key;

      const suppliedTranscript =
        body.transcript;

      // -------------------------
      // Validate user
      // -------------------------

      if (
        userId !==
        "demo-user"
      ) {
        return error(
          "Invalid userId",
          400
        );
      }

      let transcript;

      // ========================================================
      // PATH 1:
      // Browser Web Speech API transcript
      // ========================================================

      if (
        typeof suppliedTranscript ===
          "string" &&
        suppliedTranscript.trim()
      ) {
        transcript =
          suppliedTranscript
            .trim();

        console.log(
          "Using supplied browser transcript:",
          transcript
        );

      } else {

        // ======================================================
        // PATH 2:
        // AWS Transcribe from S3
        // ======================================================

        if (!s3Key) {
          return error(
            "Either transcript or s3Key is required",
            400
          );
        }

        const expectedPrefix =
          `uploads/${userId}/`;

        if (
          !s3Key.startsWith(
            expectedPrefix
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

      // ========================================================
      // BEDROCK FIRST
      // LOCAL PARSER FALLBACK
      // ========================================================

      const parsedTransactions =
        await parseTranscriptWithBedrock(
          transcript
        );

      const transactions =
        [];

      // ========================================================
      // Normalize + validate + save
      // ========================================================

      for (
        const parsed
        of parsedTransactions
      ) {

        /*
         * Extra defensive normalization.
         */
        const normalizedItem =
          normalizeItemName(
            parsed.item
          );

        const transaction =
          normalizeTransaction({
            ...parsed,

            transactionId:
              crypto.randomUUID(),

            userId,

            source:
              "voice",

            rawInput:
              transcript,

            item:
              normalizedItem
          });

        /*
         * FINAL NORMALIZATION
         *
         * This is the last protection
         * against Bedrock/local-parser
         * variation.
         */
        transaction.item =
          normalizeItemName(
            transaction.item
          );

        const validation =
          validateTransaction(
            transaction
          );

        if (
          !validation.valid
        ) {
          console.error(
            "Invalid parsed transaction:",
            validation.errors,
            transaction
          );

          /*
           * Try local parsing once more.
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

              source:
                "voice",

              rawInput:
                transcript,

              item:
                normalizeItemName(
                  local.item
                )
            });

          /*
           * Final normalization barrier
           */
          fallbackTransaction.item =
            normalizeItemName(
              fallbackTransaction.item
            );

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

          transactions.push(
            saved
          );

          continue;
        }

        const saved =
          await saveTransaction(
            transaction
          );

        transactions.push(
          saved
        );
      }

      // ========================================================
      // RESPONSE
      // ========================================================

      return success({
        transactions,

        /*
         * Return exact original transcript
         * to frontend.
         */
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