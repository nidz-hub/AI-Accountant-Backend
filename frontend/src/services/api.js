const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

if (!API_BASE_URL) {
  console.error("VITE_API_BASE_URL is not configured.");
}

async function handleResponse(response, errorMessage) {
  if (!response.ok) {
    let message = errorMessage;

    try {
      const data = await response.json();

      if (data.error) {
        message = data.error;
      }
    } catch {
      // Keep the default error message.
    }

    throw new Error(message);
  }

  return response.json();
}

// --------------------------------------------------
// Dashboard Summary
// --------------------------------------------------

export async function getSummary() {
  const response = await fetch(
    `${API_BASE_URL}/summary?userId=demo-user`
  );

  return handleResponse(
    response,
    "Failed to fetch business summary."
  );
}

// --------------------------------------------------
// Transactions
// --------------------------------------------------

export async function getTransactions() {
  const response = await fetch(
    `${API_BASE_URL}/transactions?userId=demo-user`
  );

  return handleResponse(
    response,
    "Failed to fetch transactions."
  );
}

export async function createTransaction(transaction) {
  const response = await fetch(
    `${API_BASE_URL}/transactions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...transaction,
        userId: "demo-user",
      }),
    }
  );

  return handleResponse(
    response,
    "Failed to create transaction."
  );
}

export async function updateTransaction(
  transactionId,
  updates
) {
  const response = await fetch(
    `${API_BASE_URL}/transactions/${transactionId}`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(updates),
    }
  );

  return handleResponse(
    response,
    "Failed to update transaction."
  );
}

// --------------------------------------------------
// File Upload
// --------------------------------------------------

export async function getUploadUrl(fileType) {
  const response = await fetch(
    `${API_BASE_URL}/upload-url`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        userId: "demo-user",
        fileType,
      }),
    }
  );

  return handleResponse(
    response,
    "Failed to get upload URL."
  );
}

export async function uploadFileToS3(
  uploadUrl,
  file
) {
  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": file.type,
    },
    body: file,
  });

  if (!response.ok) {
    throw new Error(
      "Failed to upload file to storage."
    );
  }

  return true;
}

// --------------------------------------------------
// Photo Processing
// --------------------------------------------------

export async function processPhoto(s3Key) {
  const response = await fetch(
    `${API_BASE_URL}/process-photo`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        userId: "demo-user",
        s3Key,
      }),
    }
  );

  return handleResponse(
    response,
    "Failed to process the bill."
  );
}

// --------------------------------------------------
// Voice Processing
// --------------------------------------------------
// Voice is converted to text in the browser using
// SpeechRecognition and the transcript is sent to
// the existing /process-voice backend endpoint.

export async function processVoice(transcript) {
  const response = await fetch(
    `${API_BASE_URL}/process-voice`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        userId: "demo-user",
        transcript,
      }),
    }
  );

  return handleResponse(
    response,
    "Failed to process the voice recording."
  );
}

// --------------------------------------------------
// Credit Readiness
// --------------------------------------------------

export async function getCreditReadiness() {
  const response = await fetch(
    `${API_BASE_URL}/credit-readiness?userId=demo-user`
  );

  return handleResponse(
    response,
    "Failed to fetch credit readiness."
  );
}