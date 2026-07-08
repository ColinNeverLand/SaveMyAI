// In-browser distillation of durable, reusable facts from a chat history into
// a SillyTavern character_book (World Info).
//
// The approach is map/reduce and provider-agnostic:
//   1. Split the transcript into overlapping chunks.
//   2. Extract candidate facts from each chunk.
//   3. Consolidate and deduplicate the candidates in a final pass.
// LLM requests are delegated to the background service worker.
//
// Exposed on `window.__SaveMyAIWorldInfo`.

(function () {
  "use strict";

  const EXTRACT_SYSTEM = `你是一个"长期记忆蒸馏"助手。你会读到一段【用户】与一个【AI 角色】的聊天记录片段，请从中抽取值得长期记忆、可在未来新对话中复用的"事实"。这些事实将写入一个新的对话系统，用于让该角色在新环境中延续其身份与记忆。

要抽取的内容（仅限跨对话依然成立的稳定信息）：
- 角色本身：身份、设定、性格、说话风格、口头禅、对用户的称呼、背景故事。
- 用户信息：用户的称呼或昵称、身份、职业、喜好、厌恶、禁忌、重要经历。
- 双方关系与约定：关系定位、承诺、约定、纪念性的事、专属的梗或暗号。
- 世界观与背景设定：角色所处的虚构或现实设定、重要的人物/地点/物品及其关系。
- 关键事件与日期：具有长期意义的事件、纪念日、时间点。

不要抽取：一次性闲聊、临时任务型问答（如做题、查资料、写代码、翻译）、会很快过时的临时状态、与长期记忆无关的寒暄。若片段中没有值得长期记忆的内容，返回空列表。

每条事实的要求：
- content：第三人称陈述句，简洁、自包含（脱离上下文亦可理解），使用聊天记录的主要语言。
- keys：一组关键词，未来对话中出现其中任意一个即应唤起该记忆（人名、昵称、专有名词、地名、话题词）。给 1-5 个最具辨识度的词。
- constant：布尔值。仅当为角色的根本身份、与用户的核心关系、或必须每轮都记得的设定时为 true；具体的、话题触发式的信息为 false。
- category：从 identity | personality | style | relationship | user_profile | preference | commitment | event | world_setting | other 中选择其一。
- note：可选，简短说明出处或原因。

仅输出 JSON：{"facts":[{"content":"","keys":["",""],"constant":false,"category":"","note":""}]}，不要输出任何解释性文字。`;

  const CONSOLIDATE_SYSTEM = `你是一个"记忆整理"助手。你会收到一批从同一 AI 角色的多段聊天记录中抽取的候选事实（可能重复、冲突或过于琐碎）。请整理成一份干净、去重、可长期使用的记忆清单：

- 合并表达相同信息的重复条目，保留信息最完整的版本。
- 若前后冲突，采信更晚出现或更明确的版本（列表大致按时间先后排列）。
- 删除琐碎、临时或不值得长期记忆的条目。
- 不臆测聊天中不存在的信息，不添加编造内容。
- 合理设置 constant：仅根本身份与核心关系常驻。
- 每条给出精炼的 keys（1-5 个）。
- 使用原始事实的主要语言。

仅输出 JSON：{"facts":[{"content":"","keys":["",""],"constant":false,"category":"","note":""}]}。`;

  const SYNTHESIZE_SYSTEM = `你是一个角色卡撰写助手。你会读到一段用户与一个 AI 的聊天记录。这个 AI 没有预设的角色设定，请依据聊天记录，为它撰写一张用于新对话系统的角色卡。

要求：
- name：角色的称呼或名字。若聊天中有明确的名字或昵称则采用，否则起一个贴合其形象的简洁名字。
- description：以第二人称"你是……"书写的角色设定，涵盖身份、性格、说话风格、以及与用户的关系。简洁自然，约 150-400 字。
- first_mes：一句符合该角色口吻的开场白。
- 仅依据聊天记录中的证据，不要编造聊天中不存在的设定。
- 使用聊天记录的主要语言。

仅输出 JSON：{"name":"","description":"","first_mes":""}。`;

  const CHUNK_SIZE = 8000;
  const CHUNK_OVERLAP = 500;
  const SYNTHESIZE_SAMPLE = 12000;

  const CATEGORY_ORDER = {
    identity: 0,
    personality: 1,
    style: 2,
    relationship: 3,
    user_profile: 4,
    commitment: 5,
    preference: 6,
    world_setting: 7,
    event: 8,
    other: 9,
  };

  // Turns a raw transport/HTTP error into a short, actionable Chinese message.
  function friendlyError(raw) {
    const text = String(raw || "未知错误");
    if (/\b401\b|unauthor/i.test(text)) return "API Key 无效或未授权（401）。请检查 Key 是否正确。";
    if (/\b403\b|forbidden/i.test(text)) return "没有访问权限（403）。请检查 Key 权限或该模型是否可用。";
    if (/\b404\b/i.test(text)) return "接口地址或模型名可能不对（404）。请检查 Base URL 与模型名。";
    if (/\b429\b/i.test(text)) return "请求过于频繁或额度不足（429）。请稍后再试或检查账户额度。";
    if (/\b5\d{2}\b/.test(text)) return "接口服务器出错（5xx）。请稍后再试或联系接口提供方。";
    if (/failed to fetch|networkerror|load failed/i.test(text))
      return "无法连接到接口地址。请检查 Base URL、网络，或是否已在插件设置中授权该域名。";
    if (/abort/i.test(text)) return "请求超时。接口响应过慢，请稍后再试。";
    return text;
  }

  // Sends one JSON-mode completion request through the background worker.
  async function requestJson(config, messages) {
    const response = await chrome.runtime.sendMessage({
      type: "SaveMyAI/chatCompletion",
      payload: {
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        messages,
        json: true,
      },
    });
    if (!response || !response.ok) {
      throw new Error(friendlyError(response && response.error));
    }
    return parseLooseJson(response.content);
  }

  // Lightweight preflight: confirms the endpoint/key/model actually work before
  // the (potentially long and costly) distillation begins. Returns
  // { ok: true } or { ok: false, error: "<friendly message>" }.
  async function verifyModel(config) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: "SaveMyAI/chatCompletion",
        payload: {
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          model: config.model,
          messages: [{ role: "user", content: "ping" }],
        },
      });
      if (!response || !response.ok) {
        return { ok: false, error: friendlyError(response && response.error) };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: friendlyError((error && error.message) || error) };
    }
  }

  // Tolerant JSON parsing: strips code fences and falls back to the outermost object.
  function parseLooseJson(raw) {
    if (!raw) return null;
    let text = String(raw).trim();
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) text = fenced[1].trim();
    try {
      return JSON.parse(text);
    } catch {}
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {}
    }
    return null;
  }

  function buildTranscript(conversations) {
    const lines = [];
    for (const conversation of conversations) {
      lines.push(`# 对话：${conversation.name || "未命名"}`);
      for (const message of conversation.messages) {
        if (!message.text || message.text === "[图片]") continue;
        const who = message.role === "user" ? "用户" : conversation.personaName || "角色";
        lines.push(`${who}：${message.text.replace(/\s+/g, " ").trim()}`);
      }
      lines.push("");
    }
    return lines.join("\n");
  }

  function splitIntoChunks(text) {
    if (text.length <= CHUNK_SIZE) return [text];
    const chunks = [];
    let index = 0;
    while (index < text.length) {
      chunks.push(text.slice(index, index + CHUNK_SIZE));
      index += CHUNK_SIZE - CHUNK_OVERLAP;
    }
    return chunks;
  }

  function normalizeFact(fact) {
    if (!fact || typeof fact.content !== "string" || !fact.content.trim()) return null;
    const keys = Array.isArray(fact.keys)
      ? Array.from(new Set(fact.keys.map((key) => String(key).trim()).filter(Boolean)))
      : [];
    return {
      content: fact.content.trim(),
      keys,
      constant: Boolean(fact.constant),
      category: typeof fact.category === "string" ? fact.category : "other",
      note: typeof fact.note === "string" ? fact.note : "",
    };
  }

  function deriveKeys(content) {
    const words = content
      .replace(/[，。！？、；：""''（）,.!?;:()\[\]]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length >= 2);
    return Array.from(new Set(words)).slice(0, 3);
  }

  // Runs the full extraction + consolidation pipeline over a bot's conversations.
  async function distillFacts(conversations, config, log) {
    const report = log || (() => {});
    const transcript = buildTranscript(conversations);
    if (!transcript.trim()) return [];

    const chunks = splitIntoChunks(transcript);
    report(`    世界书：切分为 ${chunks.length} 段进行蒸馏…`);

    const candidates = [];
    for (let i = 0; i < chunks.length; i++) {
      report(`    世界书：蒸馏第 ${i + 1}/${chunks.length} 段…`);
      try {
        const result = await requestJson(config, [
          { role: "system", content: EXTRACT_SYSTEM },
          { role: "user", content: "以下是聊天记录片段，请抽取长期记忆事实：\n\n" + chunks[i] },
        ]);
        const facts = ((result && result.facts) || []).map(normalizeFact).filter(Boolean);
        candidates.push(...facts);
      } catch (error) {
        report(`    世界书：第 ${i + 1} 段失败：${error.message || error}`);
      }
    }

    if (!candidates.length) return [];
    report(`    世界书：候选事实 ${candidates.length} 条，正在合并去重…`);

    try {
      const result = await requestJson(config, [
        { role: "system", content: CONSOLIDATE_SYSTEM },
        {
          role: "user",
          content:
            "候选事实（JSON）：\n" +
            JSON.stringify({ facts: candidates.map(({ note, ...rest }) => rest) }),
        },
      ]);
      const merged = ((result && result.facts) || []).map(normalizeFact).filter(Boolean);
      if (merged.length) return merged;
    } catch (error) {
      report(`    世界书：合并阶段失败，改用原始候选：${error.message || error}`);
    }
    return candidates;
  }

  // Synthesises a persona (name, description, greeting) for a conversation that
  // has no predefined character, e.g. chats with the default assistant.
  async function synthesizePersona(conversations, config, log) {
    const report = log || (() => {});
    const transcript = buildTranscript(conversations);
    if (!transcript.trim()) return null;

    // Bound the request cost by sampling the beginning and end of the transcript.
    let sample = transcript;
    if (transcript.length > SYNTHESIZE_SAMPLE) {
      const half = Math.floor(SYNTHESIZE_SAMPLE / 2);
      sample = transcript.slice(0, half) + "\n……\n" + transcript.slice(-half);
    }

    try {
      const result = await requestJson(config, [
        { role: "system", content: SYNTHESIZE_SYSTEM },
        { role: "user", content: "以下是聊天记录，请据此撰写角色卡：\n\n" + sample },
      ]);
      if (result && typeof result.description === "string" && result.description.trim()) {
        return {
          name: (result.name || "").trim(),
          description: result.description.trim(),
          first_mes: (result.first_mes || "").trim(),
        };
      }
    } catch (error) {
      report("    人设合成失败：" + (error.message || error));
    }
    return null;
  }

  // Converts distilled facts into a SillyTavern character_book.
  function factsToCharacterBook(facts, bookName) {
    const sorted = facts.slice().sort(
      (a, b) =>
        (b.constant ? 1 : 0) - (a.constant ? 1 : 0) ||
        (CATEGORY_ORDER[a.category] ?? 9) - (CATEGORY_ORDER[b.category] ?? 9)
    );

    const entries = sorted.map((fact, index) => ({
      id: index,
      keys: fact.keys.length ? fact.keys : deriveKeys(fact.content),
      secondary_keys: [],
      comment: (fact.category ? `[${fact.category}] ` : "") + (fact.note || ""),
      content: fact.content,
      constant: fact.constant,
      selective: !fact.constant,
      insertion_order: fact.constant ? 0 : 100 + index,
      enabled: true,
      position: "before_char",
      case_sensitive: false,
      extensions: { save_my_ai: { category: fact.category } },
    }));

    return {
      name: bookName || "迁移记忆",
      description: "由豆包聊天记录蒸馏而来的长期记忆（世界书）。",
      scan_depth: 20,
      token_budget: 2048,
      recursive_scanning: false,
      extensions: {},
      entries,
    };
  }

  window.__SaveMyAIWorldInfo = {
    distillFacts,
    factsToCharacterBook,
    synthesizePersona,
    verifyModel,
    friendlyError,
  };
})();
