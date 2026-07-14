// In-browser reconstruction of a character from its chat history: it produces
// both the persona (for the SillyTavern character card) and a character_book
// (World Info) in a single, shared map/reduce pipeline, so the two are derived
// from the same evidence and never disagree:
//   1. Split the transcript into overlapping chunks.
//   2. Extract candidate facts from each chunk.
//   3. In one final pass, consolidate the facts AND write the persona from them.
// LLM requests are delegated to the background service worker.
//
// Exposed on `window.__SaveMyAIWorldInfo`.

(function () {
  "use strict";

  const EXTRACT_SYSTEM = `你是一个"长期记忆蒸馏"助手。你会读到一段【用户】与一个【AI 角色】的聊天记录片段，请从中抽取值得长期记忆、可在未来新对话中复用的"事实"。这些事实将写入一个新的对话系统，用于让该角色在新环境中延续其身份与记忆。

聊天记录中会出现【时间：YYYY-MM-DD】这样的标记，表示其后消息发生的日期。请利用它为有时间意义的事实标注真实日期。

要抽取的内容（仅限跨对话依然成立的稳定信息）：
- 角色本身：身份、设定、性格、说话风格、口头禅、对用户的称呼、背景故事。
- 用户信息：用户的称呼或昵称、身份、职业、喜好、厌恶、禁忌、重要经历。
- 双方关系与约定：关系定位、承诺、约定、纪念性的事、专属的梗或暗号。
- 世界观与背景设定：角色所处的虚构或现实设定、重要的人物/地点/物品及其关系。
- 关键事件与日期：具有长期意义的事件、纪念日、时间点；请在 content 中带上其发生日期（如"2024-03-15，两人第一次通话"）。

不要抽取：一次性闲聊、临时任务型问答（如做题、查资料、写代码、翻译）、会很快过时的临时状态、与长期记忆无关的寒暄。若片段中没有值得长期记忆的内容，返回空列表。

每条事实的要求：
- content：第三人称陈述句，简洁、自包含（脱离上下文亦可理解），使用聊天记录的主要语言；涉及时间的事实请写入日期。
- keys：3-8 个触发关键词。未来对话中出现其中任意一个即应唤起该记忆，因此要尽量覆盖它可能被提到的多种说法——正式名称、昵称/别名、近义词与高度相关词都列上，以提升被唤起的概率。
- constant：布尔值。仅当为角色的根本身份、与用户的核心关系、或必须每轮都记得的设定时为 true；具体的、话题触发式的信息为 false。
- category：从 identity | personality | style | relationship | user_profile | preference | commitment | event | world_setting | other 中选择其一。
- note：可选，简短说明出处或原因。

仅输出 JSON：{"facts":[{"content":"","keys":["",""],"constant":false,"category":"","note":""}]}，不要输出任何解释性文字。`;

  const RECONSTRUCT_SYSTEM = `你是一个"角色重建"助手。你会收到一批从同一 AI 角色的多段聊天记录中抽取出来的候选事实（可能重复、冲突或琐碎），可能还会附带该角色已有的「作者设定」。请据此同时产出两样东西：一张角色卡人设，以及一份干净的长期记忆清单（世界书）。二者必须彼此一致。

【人设 persona】
- name：角色的称呼或名字。若作者设定或事实中有明确的名字/昵称则沿用，否则起一个贴合其形象的简洁名字。
- description：以第二人称"你是……"书写的角色设定，涵盖身份、性格、说话风格、口头禅或对用户的称呼习惯、以及与用户的关系。要具体、可直接驱动扮演，约 200-500 字。
- first_mes：一句符合该角色口吻的开场白。
- 若附带作者设定，请在其基础上完善扩写：保留其核心设定与世界观、不要与之矛盾，再用事实把它补充得更丰满。

【世界书 facts】
- 合并表达相同信息的重复条目，保留最完整的版本。
- 候选事实大致按时间先后排列；若前后信息冲突（如偏好、称呼、关系状态发生了变化），采信更近期（更靠后）的版本。
- 删除琐碎、临时或不值得长期记忆的条目。
- content：第三人称、自包含的陈述句（脱离上下文亦可理解）；纪念日与关键事件请保留其日期。
- keys：3-8 个触发关键词，覆盖该记忆可能被提到的多种说法（正式名称、昵称/别名、近义词、相关词），以提升被唤起的概率。
- constant：仅角色根本身份与核心关系为 true，其余为 false。
- category：从 identity | personality | style | relationship | user_profile | preference | commitment | event | world_setting | other 中选择其一。

共同要求：不臆测、不编造聊天中不存在的信息；使用聊天记录的主要语言。

仅输出 JSON：{"persona":{"name":"","description":"","first_mes":""},"facts":[{"content":"","keys":["",""],"constant":false,"category":""}]}，不要输出任何解释性文字。`;

  const CHUNK_SIZE = 8000;
  const CHUNK_OVERLAP = 500;

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

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Transient failures worth retrying (rate limits, server errors, network,
  // timeouts). Auth/config errors (401/403/404) are intentionally excluded so we
  // fail fast on a bad key or wrong URL rather than hammering the endpoint.
  const RETRYABLE = /429|5xx|频繁|额度|服务器出错|无法连接|网络|超时/;

  // requestJson with exponential backoff + jitter on transient errors. This is
  // what lets moderate concurrency stay safe against strict relay rate limits:
  // a throttled request simply waits and retries instead of failing the export.
  async function requestJsonWithRetry(config, messages, maxAttempts = 4) {
    let attempt = 0;
    while (true) {
      attempt++;
      try {
        return await requestJson(config, messages);
      } catch (error) {
        const message = String((error && error.message) || error);
        if (attempt >= maxAttempts || !RETRYABLE.test(message)) throw error;
        const delay = Math.min(8000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 300);
        await sleep(delay);
      }
    }
  }

  // Picks an initial concurrency from the data volume (number of chunks). Most
  // histories are short, where serial is simplest and safest (zero rate-limit
  // risk); concurrency only kicks in for genuinely large histories, and is
  // capped low to respect budget/rate limits on inexpensive relay endpoints. The
  // retry backoff above absorbs whatever the endpoint's real limit turns out to
  // be. (A chunk is ~8000 chars, so 100 chunks is roughly 800k characters.)
  function pickConcurrency(chunkCount) {
    if (chunkCount < 100) return 1;
    if (chunkCount < 300) return 2;
    if (chunkCount < 500) return 3;
    return 4;
  }

  // Order-preserving bounded worker pool. `worker` must handle its own errors;
  // results are written by index so the output order matches the input order
  // (important for the chronological consolidation pass). A rejection is never
  // expected — the extraction worker returns [] on failure — but if one occurs
  // it still surfaces via Promise.all rather than being silently swallowed.
  async function mapWithConcurrency(items, concurrency, worker) {
    const results = new Array(items.length);
    let cursor = 0;
    const runner = async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await worker(items[index], index);
      }
    };
    const size = Math.max(1, Math.min(concurrency, items.length));
    await Promise.all(Array.from({ length: size }, runner));
    return results;
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

  // Day-granularity date of a message (YYYY-MM-DD), or "" if unknown. Uses the
  // archive's Beijing-time time_iso; the fallback also converts to UTC+8 so date
  // markers stay in the timezone the user experienced.
  function dayOf(message) {
    if (message.time_iso) return message.time_iso.slice(0, 10);
    if (message.time) return new Date((Number(message.time) + 8 * 3600) * 1000).toISOString().slice(0, 10);
    return "";
  }

  // Builds a plain-text transcript. Timestamps are preserved as compact
  // 【时间：YYYY-MM-DD】markers emitted whenever the day changes, so the model
  // can anchor events/anniversaries to real dates and resolve conflicts by
  // recency — without the token cost of per-message timestamps.
  function buildTranscript(conversations) {
    const lines = [];
    for (const conversation of conversations) {
      lines.push(`# 对话：${conversation.name || "未命名"}`);
      let lastDate = "";
      for (const message of conversation.messages) {
        if (!message.text || message.text === "[图片]") continue;
        const date = dayOf(message);
        if (date && date !== lastDate) {
          lines.push(`【时间：${date}】`);
          lastDate = date;
        }
        const who = message.role === "user" ? "用户" : conversation.personaName || "角色";
        lines.push(`${who}：${message.text.replace(/\s+/g, " ").trim()}`);
      }
      lines.push("");
    }
    return lines.join("\n");
  }

  const DATE_MARKER = /【时间：[^】]*】/g;

  function splitIntoChunks(text) {
    if (text.length <= CHUNK_SIZE) return [text];
    const chunks = [];
    let index = 0;
    while (index < text.length) {
      let chunk = text.slice(index, index + CHUNK_SIZE);
      // Carry the active date into chunks that were cut after their marker, so
      // each chunk stays temporally self-contained.
      if (index > 0) {
        const preceding = text.slice(0, index).match(DATE_MARKER);
        const marker = preceding && preceding[preceding.length - 1];
        if (marker && !chunk.trimStart().startsWith(marker)) {
          chunk = marker + "\n" + chunk;
        }
      }
      chunks.push(chunk);
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

  // Runs the shared pipeline over a group's conversations and returns both the
  // synthesised persona and the consolidated world-info facts. `seed` is the
  // existing Doubao persona, used to anchor (not overwrite) the result.
  // Returns { persona: {name, description, first_mes} | null, facts: [...] }.
  async function reconstructCharacter(conversations, config, log, seed) {
    const report = log || (() => {});
    const transcript = buildTranscript(conversations);
    if (!transcript.trim()) return { persona: null, facts: [] };

    const chunks = splitIntoChunks(transcript);
    const concurrency = pickConcurrency(chunks.length);
    report(`    重建：切分为 ${chunks.length} 段进行抽取（并发 ${concurrency}）…`);

    let completed = 0;
    const perChunk = await mapWithConcurrency(chunks, concurrency, async (chunk, i) => {
      try {
        const result = await requestJsonWithRetry(config, [
          { role: "system", content: EXTRACT_SYSTEM },
          { role: "user", content: "以下是聊天记录片段，请抽取长期记忆事实：\n\n" + chunk },
        ]);
        report(`    重建：已完成 ${++completed}/${chunks.length} 段…`);
        return ((result && result.facts) || []).map(normalizeFact).filter(Boolean);
      } catch (error) {
        report(`    重建：第 ${i + 1} 段失败：${(error && error.message) || error}`);
        completed++;
        return [];
      }
    });

    const candidates = [];
    for (const facts of perChunk) candidates.push(...facts);

    const seedBlock = buildSeedBlock(seed);
    if (!candidates.length && !seedBlock) return { persona: null, facts: [] };

    report(`    重建：候选事实 ${candidates.length} 条，正在生成人设与世界书…`);
    try {
      const result = await requestJsonWithRetry(config, [
        { role: "system", content: RECONSTRUCT_SYSTEM },
        {
          role: "user",
          content:
            seedBlock +
            "候选事实（JSON）：\n" +
            JSON.stringify({ facts: candidates.map(({ note, ...rest }) => rest) }),
        },
      ]);
      const facts = ((result && result.facts) || []).map(normalizeFact).filter(Boolean);
      const p = result && result.persona;
      const persona =
        p && typeof p.description === "string" && p.description.trim()
          ? {
              name: (p.name || "").trim(),
              description: p.description.trim(),
              first_mes: (p.first_mes || "").trim(),
            }
          : null;
      return { persona, facts: facts.length ? facts : candidates };
    } catch (error) {
      report(`    重建：合并阶段失败：${error.message || error}`);
      return { persona: null, facts: candidates };
    }
  }

  // Renders an existing persona into a compact seed block for the reconstructor.
  function buildSeedBlock(seed) {
    if (!seed) return "";
    const parts = [];
    if (seed.name) parts.push("名称：" + seed.name);
    if (seed.description_for_human) parts.push("简介：" + seed.description_for_human);
    if (seed.description_for_model) parts.push("核心设定：" + seed.description_for_model);
    const greetings = Array.isArray(seed.onboarding) ? seed.onboarding.filter(Boolean) : [];
    if (greetings.length) parts.push("开场白：" + greetings.join(" / "));
    return parts.length ? "【作者已有设定】\n" + parts.join("\n") + "\n\n" : "";
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
    reconstructCharacter,
    factsToCharacterBook,
    verifyModel,
    friendlyError,
  };
})();
