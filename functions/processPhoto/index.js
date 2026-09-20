const {
  TextractClient,
  AnalyzeExpenseCommand
} = require("@aws-sdk/client-textract");

const {
  S3Client,
  GetObjectCommand
} = require("@aws-sdk/client-s3");

const {
  PutCommand
} = require("@aws-sdk/lib-dynamodb");

const {
  createWorker
} = require("tesseract.js");

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
  invokeBedrockWithImage
} = require("../../shared/bedrockParse");

const {
  success,
  error
} = require("../../shared/response");

const textract = new TextractClient({});
const s3 = new S3Client({});

const BUCKET_NAME =
  process.env.UPLOAD_BUCKET;

let ocrWorkerPromise = null;


// =============================================================
// Lambda handler
// =============================================================

exports.handler = async (event) => {
  try {
    // ---------------------------------------------------------
    // 1. Validate configuration
    // ---------------------------------------------------------

    if (!BUCKET_NAME) {
      console.error(
        "UPLOAD_BUCKET is not configured"
      );

      return error(
        "Upload storage is not configured",
        500
      );
    }

    if (!TABLE_NAME) {
      console.error(
        "TABLE_NAME is not configured"
      );

      return error(
        "Database is not configured",
        500
      );
    }

    // ---------------------------------------------------------
    // 2. Parse request body
    // ---------------------------------------------------------

    let body;

    try {
      let rawBody =
        event.body || "{}";

      if (event.isBase64Encoded) {
        rawBody =
          Buffer.from(
            rawBody,
            "base64"
          ).toString("utf-8");
      }

      body =
        typeof rawBody === "string"
          ? JSON.parse(rawBody)
          : rawBody;

    } catch (parseError) {
      console.error(
        "Invalid request JSON:",
        parseError
      );

      return error(
        "Request body must be valid JSON",
        400
      );
    }

    const userId =
      body.userId;

    const s3Key =
      body.s3Key;

    // ---------------------------------------------------------
    // 3. Validate request
    // ---------------------------------------------------------

    if (
      userId !== "demo-user"
    ) {
      return error(
        "Invalid userId",
        400
      );
    }

    if (!s3Key) {
      return error(
        "s3Key is required",
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

    // ---------------------------------------------------------
    // 4. PATH 1 - Amazon Textract
    // ---------------------------------------------------------

    let textractTransactions = [];
    let textractText = "";
    let textractSummary = {};

    try {
      console.log(
        "PATH 1: Starting Amazon Textract AnalyzeExpense"
      );

      const textractResponse =
        await textract.send(
          new AnalyzeExpenseCommand({
            Document: {
              S3Object: {
                Bucket:
                  BUCKET_NAME,
                Name:
                  s3Key
              }
            }
          })
        );

      console.log(
        "Raw Textract response:",
        JSON.stringify(
          textractResponse
        )
      );

      const extracted =
        extractTextractData(
          textractResponse
        );

      textractText =
        extracted.text;

      textractSummary =
        extracted.summary;

      textractTransactions =
        buildTransactionsFromTextract(
          extracted.documents,
          userId
        );

      console.log(
        "Textract produced transactions:",
        textractTransactions.length
      );

      // -------------------------------------------------------
      // Textract worked - save directly.
      // -------------------------------------------------------

      if (
        textractTransactions.length > 0
      ) {
        const saved =
          await validateAndSaveTransactions(
            textractTransactions
          );

        if (
          saved.length > 0
        ) {
          return success({
            transactions:
              saved
          });
        }
      }

      /*
       * Textract returned something but we could not
       * convert it into a valid transaction.
       *
       * Try local parsing of Textract text next.
       */
      if (textractText) {
        const localFromTextract =
          parseInvoiceTextLocally(
            textractText,
            userId
          );

        if (
          localFromTextract.length > 0
        ) {
          const saved =
            await validateAndSaveTransactions(
              localFromTextract
            );

          if (
            saved.length > 0
          ) {
            return success({
              transactions:
                saved
            });
          }
        }
      }

    } catch (textractError) {
      console.error(
        "PATH 1 - Textract unavailable/failed:",
        textractError
      );
    }

    // ---------------------------------------------------------
    // 5. Download image from S3
    // ---------------------------------------------------------

    let imageBuffer;

    try {
      console.log(
        "Downloading image from S3 for local OCR / Vision"
      );

      const imageObject =
        await s3.send(
          new GetObjectCommand({
            Bucket:
              BUCKET_NAME,
            Key:
              s3Key
          })
        );

      if (!imageObject.Body) {
        throw new Error(
          "S3 returned no image body"
        );
      }

      imageBuffer =
        await streamToBuffer(
          imageObject.Body
        );

      if (
        !imageBuffer ||
        imageBuffer.length === 0
      ) {
        throw new Error(
          "Downloaded image is empty"
        );
      }

      console.log(
        "Image downloaded successfully:",
        imageBuffer.length,
        "bytes"
      );

    } catch (s3Error) {
      console.error(
        "Unable to download image:",
        s3Error
      );

      return error(
        "Unable to read the uploaded receipt image",
        500
      );
    }

    // ---------------------------------------------------------
    // 6. PATH 2 - local Tesseract.js OCR
    // ---------------------------------------------------------

    try {
      console.log(
        "PATH 2: Starting local Tesseract.js OCR"
      );

      const ocrResult =
        await runLocalOCR(
          imageBuffer
        );

      const ocrText =
        String(
          ocrResult.text || ""
        ).trim();

      const ocrConfidence =
        Number(
          ocrResult.confidence || 0
        );

      console.log(
        "Tesseract OCR confidence:",
        ocrConfidence
      );

      console.log(
        "Tesseract OCR text:",
        ocrText
      );

      if (ocrText) {
        const localTransactions =
          parseInvoiceTextLocally(
            ocrText,
            userId,
            ocrConfidence
          );

        console.log(
          "Local OCR parser produced:",
          localTransactions.length,
          "transactions"
        );

        if (
          localTransactions.length > 0
        ) {
          const saved =
            await validateAndSaveTransactions(
              localTransactions
            );

          if (
            saved.length > 0
          ) {
            return success({
              transactions:
                saved
            });
          }
        }
      }

    } catch (ocrError) {
      console.error(
        "PATH 2 - Local OCR failed:",
        ocrError
      );
    }

    // ---------------------------------------------------------
    // 7. PATH 3 - Bedrock Vision
    // ---------------------------------------------------------

    try {
      console.log(
        "PATH 3: Trying Bedrock Vision"
      );

      const imageBase64 =
        imageBuffer.toString(
          "base64"
        );

      const mediaType =
        getImageMediaType(
          s3Key
        );

      const response =
        await invokeBedrockWithImage(
          buildVisionPrompt(),
          imageBase64,
          mediaType
        );

      console.log(
        "Raw Bedrock Vision response:",
        JSON.stringify(response)
      );

      const parsed =
        extractTransactionsFromBedrock(
          response
        );

      const transactions =
        parsed.map(
          (transaction) =>
            normalizeTransaction({
              ...transaction,

              transactionId:
                transaction.transactionId ||
                crypto.randomUUID(),

              userId,

              source:
                "photo",

              rawInput:
                "Receipt processed using Bedrock Vision"
            })
        );

      const saved =
        await validateAndSaveTransactions(
          transactions
        );

      if (
        saved.length > 0
      ) {
        return success({
          transactions:
            saved
        });
      }

    } catch (visionError) {
      console.error(
        "PATH 3 - Bedrock Vision failed:",
        visionError
      );
    }

    // ---------------------------------------------------------
    // 8. Nothing worked
    // ---------------------------------------------------------

    console.error(
      "All photo-processing paths failed"
    );

    return error(
      "Could not automatically read this receipt. Please enter the transaction manually.",
      422
    );

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
// Tesseract OCR
// =============================================================

async function runLocalOCR(
  imageBuffer
) {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise =
      createWorker(
        "eng",
        1,
        {
          cachePath:
            "/tmp/tesseract"
        }
      );
  }

  const worker =
    await ocrWorkerPromise;

  const result =
    await worker.recognize(
      imageBuffer
    );

  return {
    text:
      result?.data?.text || "",

    confidence:
      result?.data?.confidence || 0
  };
}


// =============================================================
// Extract useful Textract response data
// =============================================================

function extractTextractData(
  response
) {
  const documents =
    response.ExpenseDocuments || [];

  const summary = {};

  const textParts = [];

  for (
    const document
    of documents
  ) {
    // ---------------------------------------------------------
    // Summary fields
    // ---------------------------------------------------------

    for (
      const field
      of document.SummaryFields || []
    ) {
      const type =
        String(
          field.Type?.Text || ""
        )
          .trim()
          .toUpperCase();

      const value =
        String(
          field.ValueDetection
            ?.Text ||
          field.LabelDetection
            ?.Text ||
          ""
        ).trim();

      if (
        type &&
        value
      ) {
        summary[type] =
          value;

        textParts.push(
          `${type}: ${value}`
        );
      }
    }

    // ---------------------------------------------------------
    // Line items
    // ---------------------------------------------------------

    for (
      const group
      of document.LineItemGroups || []
    ) {
      for (
        const lineItem
        of group.LineItems || []
      ) {
        const parts = [];

        for (
          const field
          of lineItem
            .LineItemExpenseFields || []
        ) {
          const type =
            String(
              field.Type?.Text || ""
            )
              .trim()
              .toUpperCase();

          const value =
            String(
              field.ValueDetection
                ?.Text ||
              field.LabelDetection
                ?.Text ||
              ""
            ).trim();

          if (
            type &&
            value
          ) {
            parts.push(
              `${type}: ${value}`
            );
          }
        }

        if (
          parts.length > 0
        ) {
          textParts.push(
            parts.join(" | ")
          );
        }
      }
    }
  }

  return {
    documents,
    summary,
    text:
      textParts.join("\n").trim()
  };
}


// =============================================================
// Convert structured Textract line items
// =============================================================

function buildTransactionsFromTextract(
  documents,
  userId
) {
  const transactions = [];

  for (
    const document
    of documents
  ) {
    const summary =
      getSummaryObject(
        document
      );

    for (
      const group
      of document.LineItemGroups || []
    ) {
      for (
        const lineItem
        of group.LineItems || []
      ) {
        const fields =
          getLineItemFieldMap(
            lineItem
          );

        const item =
          firstValue(
            fields,
            [
              "ITEM",
              "DESCRIPTION",
              "EXPENSE_ROW_ITEM"
            ]
          );

        if (!item) {
          continue;
        }

        const quantityRaw =
          firstValue(
            fields,
            [
              "QUANTITY",
              "QTY"
            ]
          );

        const quantityInfo =
          parseQuantity(
            quantityRaw
          );

        const quantity =
          quantityInfo.quantity;

        const unit =
          quantityInfo.unit;

        const unitPrice =
          parseMoney(
            firstValue(
              fields,
              [
                "UNIT_PRICE",
                "RATE"
              ]
            )
          );

        const total =
          parseMoney(
            firstValue(
              fields,
              [
                "PRICE",
                "TOTAL",
                "AMOUNT"
              ]
            )
          );

        let finalTotal =
          total;

        let finalUnitPrice =
          unitPrice;

        if (
          finalTotal === null &&
          finalUnitPrice !== null
        ) {
          finalTotal =
            roundMoney(
              quantity *
              finalUnitPrice
            );
        }

        if (
          finalUnitPrice === null &&
          finalTotal !== null &&
          quantity > 0
        ) {
          finalUnitPrice =
            roundMoney(
              finalTotal /
              quantity
            );
        }

        if (
          finalTotal === null
        ) {
          continue;
        }

        if (
          finalUnitPrice === null
        ) {
          finalUnitPrice = 0;
        }

        const fieldConfidence =
          getAverageFieldConfidence(
            fields
          );

        transactions.push({
          transactionId:
            crypto.randomUUID(),

          userId,

          date:
            parseInvoiceDate(
              firstValue(
                summary,
                [
                  "INVOICE_RECEIPT_DATE",
                  "ORDER_DATE",
                  "DELIVERY_DATE"
                ]
              )
            ),

          type:
            detectTypeFromSummary(
              summary
            ),

          item:
            cleanItem(item),

          quantity,

          unit,

          pricePerUnit:
            finalUnitPrice,

          totalAmount:
            finalTotal,

          currency:
            "INR",

          counterparty:
            getCounterparty(
              summary
            ),

          source:
            "photo",

          rawInput:
            buildRawLineInput(
              fields
            ),

          confidence:
            fieldConfidence
        });
      }
    }
  }

  return transactions;
}


// =============================================================
// Local OCR invoice parser
// =============================================================

function parseInvoiceTextLocally(
  text,
  userId,
  ocrConfidence = 75
) {
  const lines =
    String(text || "")
      .split(/\r?\n/)
      .map(
        (line) =>
          line
            .replace(/\s+/g, " ")
            .trim()
      )
      .filter(Boolean);

  const invoiceDate =
    findInvoiceDate(
      lines
    );

  const counterparty =
    findLocalCounterparty(
      lines
    );

  const transactions = [];

  for (
    const line
    of lines
  ) {
    const parsed =
      parseStructuredInvoiceLine(
        line
      ) ||
      parseSimpleInvoiceLine(
        line
      );

    if (!parsed) {
      continue;
    }

    transactions.push({
      transactionId:
        crypto.randomUUID(),

      userId,

      date:
        invoiceDate ||
        new Date().toISOString(),

      type:
        "purchase",

      item:
        parsed.item,

      quantity:
        parsed.quantity,

      unit:
        parsed.unit,

      pricePerUnit:
        parsed.pricePerUnit,

      totalAmount:
        parsed.totalAmount,

      currency:
        "INR",

      counterparty,

      source:
        "photo",

      rawInput:
        line,

      confidence:
        calculateOCRConfidence(
          ocrConfidence,
          parsed
        )
    });
  }

  return removeDuplicateTransactions(
    transactions
  );
}


// =============================================================
// Structured invoice row parser
//
// Designed for rows such as:
//
// 1 Bosch All-in-One Metal Hand Tool Kit
// 8302 1 NOS 2,535.00 2,535.00
// 18.00 456.30 2,991.30
//
// =============================================================

function parseStructuredInvoiceLine(
  line
) {
  const match =
    line.match(
      /^(?:\d+\s+)?(.+?)\s+\d{4,8}\s+(\d+(?:[.,]\d+)?)\s+(NOS|NO|PCS|PC|PIECE|PIECES|KG|KGS|G|GM|GRAM|GRAMS|L|LTR|LITRE|LITRES|ML|BOX|BOXES|BAG|BAGS|PACK|PACKS|PACKET|PACKETS)\s+(.+)$/i
    );

  if (!match) {
    return null;
  }

  const item =
    cleanItem(
      match[1]
    );

  const quantity =
    Number(
      match[2].replace(",", ".")
    );

  const unit =
    normalizeUnit(
      match[3]
    );

  const numbers =
    extractMoneyValues(
      match[4]
    );

  /*
   * For a normal invoice row:
   *
   * [rate, taxable value, tax %, tax amount, final total]
   *
   * We use:
   * first monetary value = unit rate
   * last monetary value  = line total
   */

  if (
    !item ||
    !Number.isFinite(
      quantity
    ) ||
    quantity <= 0 ||
    numbers.length < 2
  ) {
    return null;
  }

  const pricePerUnit =
    numbers[0];

  const totalAmount =
    numbers[numbers.length - 1];

  if (
    !Number.isFinite(
      pricePerUnit
    ) ||
    !Number.isFinite(
      totalAmount
    )
  ) {
    return null;
  }

  /*
   * Avoid accidentally treating invoice summary rows
   * such as "Total 4,489.90" as line items.
   */
  if (
    /^(total|subtotal|tax|amount|grand total|taxable amount)$/i.test(
      item
    )
  ) {
    return null;
  }

  return {
    item,

    quantity,

    unit,

    pricePerUnit:
      roundMoney(
        pricePerUnit
      ),

    totalAmount:
      roundMoney(
        totalAmount
      )
  };
}


// =============================================================
// Simpler OCR row parser
// =============================================================

function parseSimpleInvoiceLine(
  line
) {
  const match =
    line.match(
      /^(?:\d+\s+)?(.+?)\s+(\d+(?:[.,]\d+)?)\s+(NOS|NO|PCS|PC|PIECE|PIECES|KG|KGS|G|GM|GRAM|GRAMS|L|LTR|LITRE|LITRES|ML|BOX|BOXES|BAG|BAGS|PACK|PACKS|PACKET|PACKETS)\s+(.+)$/i
    );

  if (!match) {
    return null;
  }

  const item =
    cleanItem(
      match[1]
    );

  const quantity =
    Number(
      match[2].replace(",", ".")
    );

  const unit =
    normalizeUnit(
      match[3]
    );

  const numbers =
    extractMoneyValues(
      match[4]
    );

  if (
    !item ||
    !Number.isFinite(
      quantity
    ) ||
    quantity <= 0 ||
    numbers.length < 2
  ) {
    return null;
  }

  if (
    /^(total|subtotal|tax|amount|grand total|taxable amount)$/i.test(
      item
    )
  ) {
    return null;
  }

  const pricePerUnit =
    numbers[0];

  const totalAmount =
    numbers[numbers.length - 1];

  return {
    item,

    quantity,

    unit,

    pricePerUnit:
      roundMoney(
        pricePerUnit
      ),

    totalAmount:
      roundMoney(
        totalAmount
      )
  };
}


// =============================================================
// Extract all money-like values from OCR text
// =============================================================

function extractMoneyValues(
  value
) {
  const matches =
    String(value || "").match(
      /\d[\d,]*(?:\.\d{1,2})?/g
    ) || [];

  return matches
    .map(
      (value) =>
        Number(
          value.replace(/,/g, "")
        )
    )
    .filter(
      (value) =>
        Number.isFinite(value)
    );
}


// =============================================================
// Find invoice date
// =============================================================

function findInvoiceDate(
  lines
) {
  const combined =
    lines.join(" ");

  const patterns = [
    /(?:invoice\s*(?:date)?|date)\s*[:\-]?\s*(\d{1,2}[-/]\w+[-/]\d{2,4})/i,

    /(?:invoice\s*(?:date)?|date)\s*[:\-]?\s*(\d{1,2}[-/]\d{1,2}[-/]\d{2,4})/i,

    /(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4})/i
  ];

  for (
    const pattern
    of patterns
  ) {
    const match =
      combined.match(
        pattern
      );

    if (match) {
      const parsed =
        parseInvoiceDate(
          match[1]
        );

      if (parsed) {
        return parsed;
      }
    }
  }

  return null;
}


// =============================================================
// Parse invoice date
// =============================================================

function parseInvoiceDate(
  value
) {
  if (!value) {
    return new Date().toISOString();
  }

  let parsed =
    new Date(
      String(value)
        .replace(
          /(\d{2})-(\d{2})-(\d{4})/,
          "$2/$1/$3"
        )
    );

  if (
    Number.isNaN(
      parsed.getTime()
    )
  ) {
    parsed =
      new Date(value);
  }

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
// Find local OCR counterparty
// =============================================================

function findLocalCounterparty(
  lines
) {
  for (
    let i = 0;
    i < lines.length;
    i++
  ) {
    const line =
      lines[i];

    const vendorMatch =
      line.match(
        /(?:vendor|seller|supplier)\s*(?:name)?\s*[:\-]\s*(.+)/i
      );

    if (
      vendorMatch
    ) {
      return cleanItem(
        vendorMatch[1]
      );
    }

    const msMatch =
      line.match(
        /^M\/S\.?\s+(.+)/i
      );

    if (
      msMatch
    ) {
      return cleanItem(
        msMatch[1]
      );
    }
  }

  return null;
}


// =============================================================
// Calculate OCR confidence
// =============================================================

function calculateOCRConfidence(
  ocrConfidence,
  parsed
) {
  let confidence =
    Number(
      ocrConfidence
    ) / 100;

  if (
    !Number.isFinite(
      confidence
    )
  ) {
    confidence =
      0.7;
  }

  if (
    parsed.item
  ) {
    confidence +=
      0.08;
  }

  if (
    parsed.quantity > 0
  ) {
    confidence +=
      0.04;
  }

  if (
    parsed.pricePerUnit >
    0
  ) {
    confidence +=
      0.04;
  }

  if (
    parsed.totalAmount >
    0
  ) {
    confidence +=
      0.04;
  }

  return Math.max(
    0.5,
    Math.min(
      0.95,
      roundConfidence(
        confidence
      )
    )
  );
}


// =============================================================
// Validate and save
// =============================================================

async function validateAndSaveTransactions(
  transactions
) {
  const saved = [];

  for (
    const transaction
    of transactions
  ) {
    const normalized =
      normalizeTransaction(
        transaction
      );

    const validation =
      validateTransaction(
        normalized
      );

    if (
      !validation.valid
    ) {
      console.warn(
        "Transaction failed validation:",
        validation.errors,
        normalized
      );

      continue;
    }

    await saveTransaction(
      normalized
    );

    saved.push(
      normalized
    );
  }

  return saved;
}


// =============================================================
// Save transaction
// =============================================================

async function saveTransaction(
  transaction
) {
  await dynamoClient.send(
    new PutCommand({
      TableName:
        TABLE_NAME,

      Item:
        transaction
    })
  );
}


// =============================================================
// Get line item fields
// =============================================================

function getLineItemFieldMap(
  lineItem
) {
  const fields = {};

  for (
    const field
    of lineItem
      .LineItemExpenseFields || []
  ) {
    const type =
      String(
        field.Type?.Text || ""
      )
        .trim()
        .toUpperCase();

    const value =
      String(
        field.ValueDetection
          ?.Text ||
        field.LabelDetection
          ?.Text ||
        ""
      ).trim();

    if (!type || !value) {
      continue;
    }

    fields[type] = {
      value,

      confidence:
        Number(
          field.ValueDetection
            ?.Confidence ||
          field.LabelDetection
            ?.Confidence ||
          0
        )
    };
  }

  return fields;
}


// =============================================================
// Get summary object
// =============================================================

function getSummaryObject(
  document
) {
  const summary = {};

  for (
    const field
    of document.SummaryFields || []
  ) {
    const type =
      String(
        field.Type?.Text || ""
      )
        .trim()
        .toUpperCase();

    const value =
      String(
        field.ValueDetection
          ?.Text ||
        field.LabelDetection
          ?.Text ||
        ""
      ).trim();

    if (
      type &&
      value
    ) {
      summary[type] =
        value;
    }
  }

  return summary;
}


// =============================================================
// Field helpers
// =============================================================

function firstValue(
  object,
  names
) {
  for (
    const name
    of names
  ) {
    if (
      object[name]?.value
    ) {
      return object[name].value;
    }

    if (
      typeof object[name] ===
        "string" &&
      object[name]
    ) {
      return object[name];
    }
  }

  return null;
}


function getAverageFieldConfidence(
  fields
) {
  const values =
    Object.values(fields)
      .map(
        (field) =>
          Number(
            field.confidence
          )
      )
      .filter(
        (value) =>
          Number.isFinite(
            value
          ) &&
          value > 0
      );

  if (
    values.length === 0
  ) {
    return 0.8;
  }

  return roundConfidence(
    average(values) / 100
  );
}


function average(
  values
) {
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


// =============================================================
// Quantity
// =============================================================

function parseQuantity(
  value
) {
  if (!value) {
    return {
      quantity:
        1,

      unit:
        "nos"
    };
  }

  const text =
    String(value)
      .trim();

  const match =
    text.match(
      /(\d+(?:[.,]\d+)?)\s*([A-Za-z]+)?/
    );

  if (!match) {
    return {
      quantity:
        1,

      unit:
        "nos"
    };
  }

  const quantity =
    Number(
      match[1].replace(
        ",",
        "."
      )
    );

  return {
    quantity:
      Number.isFinite(
        quantity
      ) &&
      quantity > 0
        ? quantity
        : 1,

    unit:
      normalizeUnit(
        match[2]
      )
  };
}


// =============================================================
// Unit
// =============================================================

function normalizeUnit(
  value
) {
  const unit =
    String(
      value || ""
    )
      .trim()
      .toLowerCase();

  const map = {
    no:
      "nos",

    nos:
      "nos",

    pc:
      "piece",

    pcs:
      "piece",

    piece:
      "piece",

    pieces:
      "piece",

    kg:
      "kg",

    kgs:
      "kg",

    g:
      "g",

    gm:
      "g",

    gram:
      "g",

    grams:
      "g",

    l:
      "litre",

    ltr:
      "litre",

    litre:
      "litre",

    litres:
      "litre",

    ml:
      "ml",

    box:
      "box",

    boxes:
      "box",

    bag:
      "bag",

    bags:
      "bag",

    pack:
      "pack",

    packs:
      "pack",

    packet:
      "packet",

    packets:
      "packet"
  };

  return (
    map[unit] ||
    unit ||
    "nos"
  );
}


// =============================================================
// Money
// =============================================================

function parseMoney(
  value
) {
  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  const cleaned =
    String(value)
      .replace(
        /₹/g,
        ""
      )
      .replace(
        /Rs\.?/gi,
        ""
      )
      .replace(
        /INR/gi,
        ""
      )
      .replace(
        /,/g,
        ""
      )
      .trim();

  const match =
    cleaned.match(
      /-?\d+(?:\.\d+)?/
    );

  if (!match) {
    return null;
  }

  const number =
    Number(
      match[0]
    );

  return Number.isFinite(
    number
  )
    ? roundMoney(
        number
      )
    : null;
}


// =============================================================
// Transaction type
// =============================================================

function detectTypeFromSummary(
  summary
) {
  if (
    summary.CUSTOMER_NAME ||
    summary.RECEIVER_NAME ||
    summary.RECEIVER_SHIP_TO ||
    summary.RECEIVER_SOLD_TO ||
    summary.RECEIVER_BILL_TO
  ) {
    return "sale";
  }

  return "purchase";
}


// =============================================================
// Counterparty
// =============================================================

function getCounterparty(
  summary
) {
  return (
    summary.VENDOR_NAME ||
    summary.RECEIVER_NAME ||
    null
  );
}


// =============================================================
// Clean item
// =============================================================

function cleanItem(
  value
) {
  return String(
    value ||
      "Unknown item"
  )
    .replace(
      /\s+/g,
      " "
    )
    .replace(
      /^\d+\s+/,
      ""
    )
    .trim();
}


// =============================================================
// Raw Textract line
// =============================================================

function buildRawLineInput(
  fields
) {
  return Object.entries(
    fields
  )
    .map(
      ([key, field]) =>
        `${key}: ${field.value}`
    )
    .join(" | ");
}


// =============================================================
// Remove duplicates
// =============================================================

function removeDuplicateTransactions(
  transactions
) {
  const seen =
    new Set();

  const result = [];

  for (
    const transaction
    of transactions
  ) {
    const key =
      [
        transaction.item
          .toLowerCase(),

        transaction.quantity,

        transaction.unit,

        transaction.totalAmount
      ].join("|");

    if (
      seen.has(key)
    ) {
      continue;
    }

    seen.add(key);

    result.push(
      transaction
    );
  }

  return result;
}


// =============================================================
// Bedrock Vision
// =============================================================

function buildVisionPrompt() {
  return `
You are extracting accounting transactions from an Indian business receipt or invoice image.

Return ONLY a valid JSON array.

Each object must have exactly:

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
- Extract every distinct purchased/sold line item.
- Use INR.
- For a supplier invoice, use "purchase".
- For an invoice representing goods sold by the business, use "sale".
- For rent, electricity, wages, transport, fuel and similar business costs, use "expense".
- Use the quantity shown on the invoice.
- Use the unit price when visible.
- Use the line total when visible.
- If unit price is missing but total and quantity are available, calculate unit price.
- If total is missing but unit price and quantity are available, calculate total.
- Do not invent line items.
- confidence must be between 0 and 1.
- Return JSON only.
`;
}


// =============================================================
// Extract Bedrock transactions
// =============================================================

function extractTransactionsFromBedrock(
  response
) {
  const text =
    response?.content
      ?.find(
        (item) =>
          item.type ===
          "text"
      )
      ?.text || "";

  if (!text) {
    throw new Error(
      "Bedrock returned no text"
    );
  }

  const cleaned =
    text
      .replace(
        /^```json\s*/i,
        ""
      )
      .replace(
        /^```\s*/i,
        ""
      )
      .replace(
        /\s*```$/i,
        ""
      )
      .trim();

  let parsed;

  try {
    parsed =
      JSON.parse(
        cleaned
      );
  } catch (_) {
    const start =
      cleaned.indexOf(
        "["
      );

    const end =
      cleaned.lastIndexOf(
        "]"
      );

    if (
      start === -1 ||
      end <= start
    ) {
      throw new Error(
        "Bedrock returned invalid JSON"
      );
    }

    parsed =
      JSON.parse(
        cleaned.slice(
          start,
          end + 1
        )
      );
  }

  if (
    Array.isArray(
      parsed
    )
  ) {
    return parsed;
  }

  if (
    parsed &&
    Array.isArray(
      parsed.transactions
    )
  ) {
    return parsed.transactions;
  }

  throw new Error(
    "Bedrock did not return a transaction array"
  );
}


// =============================================================
// Image media type
// =============================================================

function getImageMediaType(
  s3Key
) {
  const key =
    String(
      s3Key || ""
    ).toLowerCase();

  if (
    key.endsWith(
      ".png"
    )
  ) {
    return "image/png";
  }

  if (
    key.endsWith(
      ".webp"
    )
  ) {
    return "image/webp";
  }

  return "image/jpeg";
}


// =============================================================
// S3 stream
// =============================================================

async function streamToBuffer(
  stream
) {
  const chunks = [];

  for await (
    const chunk
    of stream
  ) {
    chunks.push(
      Buffer.from(
        chunk
      )
    );
  }

  return Buffer.concat(
    chunks
  );
}


// =============================================================
// Number helpers
// =============================================================

function roundMoney(
  value
) {
  return (
    Math.round(
      value * 100
    ) / 100
  );
}


function roundConfidence(
  value
) {
  return (
    Math.round(
      value * 100
    ) / 100
  );
}