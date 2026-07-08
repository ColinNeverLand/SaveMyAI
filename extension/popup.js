// Settings popup logic: reads and writes the LLM configuration and requests
// host access for the endpoint the user provides, so the background worker can
// call it later. The popup is used because host-permission requests must run
// in an extension page during a user gesture.

const STORAGE_KEY = "saveMyAI.llm";

const els = {
  baseUrl: document.getElementById("baseUrl"),
  apiKey: document.getElementById("apiKey"),
  model: document.getElementById("model"),
  save: document.getElementById("save"),
  test: document.getElementById("test"),
  clear: document.getElementById("clear"),
  status: document.getElementById("status"),
};

function setStatus(text, kind) {
  els.status.textContent = text;
  els.status.dataset.kind = kind || "";
}

function originPattern(url) {
  return new URL(url).origin + "/*";
}

// Turns a raw transport/HTTP error into a short, actionable message.
function friendlyError(raw) {
  const text = String(raw || "未知错误");
  if (/\b401\b|unauthor/i.test(text)) return "API Key 无效或未授权（401）。请检查 Key 是否正确。";
  if (/\b403\b|forbidden/i.test(text)) return "没有访问权限（403）。请检查 Key 权限或该模型是否可用。";
  if (/\b404\b/i.test(text)) return "接口地址或模型名可能不对（404）。请检查 Base URL 与模型名。";
  if (/\b429\b/i.test(text)) return "请求过于频繁或额度不足（429）。请稍后再试。";
  if (/\b5\d{2}\b/.test(text)) return "接口服务器出错（5xx）。请稍后再试。";
  if (/failed to fetch|networkerror|load failed/i.test(text))
    return "无法连接到接口地址。请检查 Base URL 与网络。";
  if (/abort/i.test(text)) return "请求超时，接口响应过慢。";
  return text;
}

// Reads the current form values, validating that all are present and the URL is
// well-formed. Returns null (and sets an error status) when invalid.
function readConfig() {
  const baseUrl = els.baseUrl.value.trim();
  const apiKey = els.apiKey.value.trim();
  const model = els.model.value.trim();
  if (!baseUrl || !apiKey || !model) {
    setStatus("请填写接口地址、API Key 和模型名。", "error");
    return null;
  }
  try {
    originPattern(baseUrl);
  } catch {
    setStatus("接口地址格式不正确，应形如 https://xxx.com/v1", "error");
    return null;
  }
  return { baseUrl, apiKey, model };
}

async function load() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const config = stored[STORAGE_KEY];
  if (config) {
    els.baseUrl.value = config.baseUrl || "";
    els.apiKey.value = config.apiKey || "";
    els.model.value = config.model || "";
    setStatus("已配置：" + (config.model || "未命名模型"), "ok");
  }
}

async function save() {
  const config = readConfig();
  if (!config) return;

  const granted = await chrome.permissions.request({ origins: [originPattern(config.baseUrl)] });
  if (!granted) {
    setStatus("未授予该接口的访问权限，无法调用模型。", "error");
    return;
  }

  await chrome.storage.local.set({ [STORAGE_KEY]: config });
  setStatus("已保存，可在导出时生成世界书。", "ok");
}

// Sends a tiny request to confirm the endpoint, key and model actually work,
// so the user finds out about a wrong key here rather than mid-export.
async function test() {
  const config = readConfig();
  if (!config) return;

  const granted = await chrome.permissions.request({ origins: [originPattern(config.baseUrl)] });
  if (!granted) {
    setStatus("未授予该接口的访问权限，无法测试。", "error");
    return;
  }

  setStatus("正在测试连接…", "");
  els.test.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({
      type: "SaveMyAI/chatCompletion",
      payload: { ...config, messages: [{ role: "user", content: "ping" }] },
    });
    if (response && response.ok) {
      setStatus("连接成功，模型可用。", "ok");
    } else {
      setStatus("连接失败：" + friendlyError(response && response.error), "error");
    }
  } catch (error) {
    setStatus("连接失败：" + friendlyError((error && error.message) || error), "error");
  } finally {
    els.test.disabled = false;
  }
}

async function clear() {
  await chrome.storage.local.remove(STORAGE_KEY);
  els.baseUrl.value = "";
  els.apiKey.value = "";
  els.model.value = "";
  setStatus("已清除模型设置。", "");
}

els.save.addEventListener("click", save);
els.test.addEventListener("click", test);
els.clear.addEventListener("click", clear);
load();
