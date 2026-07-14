// Background service worker.
//
// Content scripts run on the doubao.com origin and cannot call a third-party
// LLM endpoint directly (blocked by CORS). The service worker performs these
// requests on their behalf for any origin the user has granted access to
// (granted from the popup via optional host permissions).

const REQUEST_TIMEOUT_MS = 120_000;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === "SaveMyAI/chatCompletion") {
    chatCompletion(message.payload)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: toMessage(error) }));
    return true; // Keep the channel open for the asynchronous response.
  }
  return false;
});

// Calls an OpenAI-compatible /chat/completions endpoint.
async function chatCompletion({ baseUrl, apiKey, model, messages, json }) {
  const endpoint = String(baseUrl).replace(/\/+$/, "") + "/chat/completions";
  const requestBody = { model, messages, temperature: 0.2 };
  if (json) requestBody.response_format = { type: "json_object" };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  // Local runtimes typically need no key, so only send Authorization when one
  // is actually provided.
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = "Bearer " + apiKey;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}: ${text.slice(0, 300)}` };
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return { ok: false, error: "接口返回的不是有效 JSON" };
    }
    const content =
      data && data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content || ""
        : "";
    return { ok: true, content };
  } finally {
    clearTimeout(timeout);
  }
}

function toMessage(error) {
  return String((error && error.message) || error);
}
