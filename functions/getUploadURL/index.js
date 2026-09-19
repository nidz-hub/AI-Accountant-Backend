const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const crypto = require("crypto");

const { success, error } = require("../../shared/response");

const s3 = new S3Client({});

const BUCKET_NAME = process.env.UPLOAD_BUCKET;

exports.handler = async (event) => {
  try {
    console.log("Incoming event:", JSON.stringify(event));

    if (!BUCKET_NAME) {
      console.error("UPLOAD_BUCKET is missing");
      return error("Upload storage is not configured", 500);
    }

    let rawBody = event.body || "{}";

    // API Gateway can send the body as base64
    if (event.isBase64Encoded) {
      rawBody = Buffer.from(rawBody, "base64").toString("utf-8");
    }

    let body;

    try {
      body = typeof rawBody === "string"
        ? JSON.parse(rawBody)
        : rawBody;
    } catch (parseError) {
      console.error("Invalid JSON body:", rawBody);
      console.error("JSON parse error:", parseError);

      return error("Request body must be valid JSON", 400);
    }

    const { userId, fileType } = body;

    if (userId !== "demo-user") {
      return error("Invalid userId", 400);
    }

    const allowedTypes = {
      "image/jpeg": ".jpg",
      "audio/webm": ".webm"
    };

    if (!allowedTypes[fileType]) {
      return error(
        "fileType must be image/jpeg or audio/webm",
        400
      );
    }

    const fileId = crypto.randomUUID();

    const s3Key =
      `uploads/${userId}/${fileId}${allowedTypes[fileType]}`;

    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: s3Key,
      ContentType: fileType
    });

    const uploadUrl = await getSignedUrl(s3, command, {
      expiresIn: 900
    });

    console.log("Upload URL generated successfully:", {
      userId,
      fileType,
      s3Key
    });

    return success({
      uploadUrl,
      s3Key
    });

  } catch (err) {
    console.error("getUploadURL error:", err);

    return error(
      "Unable to generate upload URL",
      500
    );
  }
};