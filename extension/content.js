// SaveMyAI content script.
//
// Runs on doubao.com. It reads the user's conversations through Doubao's own
// web APIs (using the session cookies already present in the page), assembles
// a structured archive, optionally converts each bot into SillyTavern assets,
// and downloads everything as a single ZIP. Nothing is uploaded.

(function () {
  "use strict";

  if (window.__saveMyAILoaded) return;
  window.__saveMyAILoaded = true;

  // Doubao's web APIs authenticate via cookies (sent automatically on
  // same-origin requests) and require this minimal query string and header set.
  const QUERY = "?device_platform=web&aid=497858&version_code=20800";
  const HEADERS = {
    "Content-Type": "application/json; encoding=utf-8",
    "Agw-Js-Conv": "str",
  };
  const MAX_ANCHOR = 9007199254740991;
  const SETTINGS_KEY = "saveMyAI.llm";

  const uuid = () =>
    (crypto.randomUUID && crypto.randomUUID()) ||
    "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // --- Doubao API ------------------------------------------------------------

  async function api(path, body) {
    const response = await fetch(path + QUERY, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify(body),
      credentials: "include",
    });
    return response.json();
  }

  // Fetches one page of a conversation's message chain.
  async function pullChain(conversationId, anchor, limit) {
    const json = await api("/im/chain/single", {
      cmd: 3100,
      uplink_body: {
        pull_singe_chain_uplink_body: {
          conversation_id: String(conversationId),
          anchor_index: anchor,
          conversation_type: 3,
          direction: 1,
          limit,
          ext: {},
          filter: { index_list: [] },
          evaluate_ab_params: "",
          evaluate_common_params: "",
        },
      },
      sequence_id: uuid(),
      channel: 2,
      version: "1",
    });
    const downlink = json && json.downlink_body && json.downlink_body.pull_singe_chain_downlink_body;
    if (!downlink || !downlink.messages) {
      throw new Error((json && json.status_desc) || "拉取消息失败");
    }
    return downlink;
  }

  async function getBotList(botIds) {
    const json = await api("/alice/bot/get_bot_list_v2", { bot_id_list: botIds, scene: "default" });
    return (json && json.data) || [];
  }

  // --- Message parsing -------------------------------------------------------

  function textFromMessage(message) {
    if (!message) return "";
    if (Array.isArray(message.content_block) && message.content_block.length) {
      const parts = [];
      for (const block of message.content_block) {
        const textBlock = block && block.content && block.content.text_block;
        if (textBlock && typeof textBlock.text === "string") parts.push(textBlock.text);
      }
      if (parts.length) return parts.join("\n").trim();
    }
    if (typeof message.content === "string" && message.content.trim().startsWith("{")) {
      try {
        const parsed = JSON.parse(message.content);
        if (typeof parsed.text === "string") return parsed.text.trim();
      } catch {}
    }
    if (typeof message.tts_content === "string" && message.tts_content) {
      return message.tts_content.trim();
    }
    if (typeof message.content === "string") return message.content.trim();
    return "";
  }

  // Extracts image attachments (content_type 20), preferring the original URL.
  function collectImages(message) {
    const images = [];
    const seen = new Set();
    const add = (url, width, height) => {
      if (!url || !/^https?:/.test(url) || seen.has(url)) return;
      seen.add(url);
      images.push({ url, width: width || null, height: height || null });
    };
    if (typeof message.content === "string" && message.content.trim().startsWith("{")) {
      try {
        const parsed = JSON.parse(message.content);
        const entities = parsed && parsed.entities;
        if (Array.isArray(entities)) {
          for (const entity of entities) {
            const image = entity && entity.entity_content && entity.entity_content.image;
            if (!image) continue;
            const original = image.image_ori || image.image_raw || image.image_thumb || image;
            if (original && original.url) add(original.url, original.width, original.height);
            else if (image.url) add(image.url, image.width, image.height);
          }
        }
      } catch {}
    }
    return images;
  }

  function buildPersona(bot) {
    if (!bot) return null;
    let onboarding = [];
    const messageList = bot.onboarding && bot.onboarding.message_list;
    if (Array.isArray(messageList)) {
      onboarding = messageList
        .map((item) => {
          try {
            return JSON.parse(item.content).text;
          } catch {
            return item.content || "";
          }
        })
        .filter(Boolean);
    }
    return {
      name: bot.name || "",
      description_for_human: bot.description_for_human || "",
      description_for_model: bot.description_for_model || "",
      model: (bot.model && (bot.model.model_name || bot.model.name)) || "",
      voice: (bot.voice_type && bot.voice_type.name) || "",
      onboarding,
      share_url: (bot.share_info && bot.share_info.share_url) || "",
      creator: (bot.creator_info && bot.creator_info.creator_handle) || "",
    };
  }

  // --- Full conversation retrieval -------------------------------------------

  // Pages backwards from the newest message to the start of the conversation,
  // collecting messages and the regenerated-branch map along the way.
  async function fetchAll(conversationId, log) {
    let anchor = MAX_ANCHOR;
    let previousMin = Infinity;
    const seen = new Set();
    const rawMessages = [];
    const regen = {};

    // Keep paging backwards as long as the server reports more messages. There is
    // no fixed cap: termination is guaranteed by the progress check below (each
    // page must reach a strictly smaller index, bounded by 0), so a conversation
    // of any length is exported in full.
    while (true) {
      const downlink = await pullChain(conversationId, anchor, 50);
      const messages = downlink.messages || [];
      Object.assign(regen, downlink.regen_messages || {});

      let minIndex = Infinity;
      for (const message of messages) {
        const index = Number(message.index_in_conv);
        if (index < minIndex) minIndex = index;
        if (!seen.has(message.message_id)) {
          seen.add(message.message_id);
          rawMessages.push(message);
        }
      }
      if (log) log("  已获取 " + rawMessages.length + " 条…");
      if (!downlink.has_more || messages.length === 0) break;
      if (minIndex >= previousMin) break;
      previousMin = minIndex;
      anchor = minIndex;
    }

    rawMessages.sort((a, b) => Number(a.index_in_conv) - Number(b.index_in_conv));
    return { rawMessages, regen };
  }

  // Formats a Unix timestamp (seconds) as an ISO 8601 string in Beijing time
  // (UTC+8), e.g. "2024-03-15T22:00:00+08:00". The same instant as UTC, just
  // displayed in the timezone Doubao users actually live in.
  function beijingIso(unixSeconds) {
    if (!unixSeconds) return null;
    const d = new Date((Number(unixSeconds) + 8 * 3600) * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    return (
      `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
      `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+08:00`
    );
  }

  // Builds the structured archive from raw messages, resolving the selected
  // regeneration branch and preserving the alternatives.
  function buildArchive(item, rawMessages, regen) {
    const messages = [];
    for (const raw of rawMessages) {
      const role = Number(raw.user_type) === 1 ? "user" : "assistant";
      const time = raw.create_time ? Number(raw.create_time) : null;
      let text;
      let alternates;

      if (Array.isArray(raw.regen_msg_list) && raw.regen_msg_list.length) {
        const visible =
          raw.regen_msg_list.find((entry) => entry.is_visible) ||
          raw.regen_msg_list[raw.regen_msg_list.length - 1];
        const visibleId = visible && visible.msg_id_list && visible.msg_id_list[0];
        const selected = (visibleId && regen[visibleId]) || raw;
        text = textFromMessage(selected);
        alternates = raw.regen_msg_list
          .filter((entry) => !entry.is_visible)
          .map((entry) => {
            const id = entry.msg_id_list && entry.msg_id_list[0];
            return { message_id: id, text: textFromMessage(regen[id]) };
          })
          .filter((alternate) => alternate.text);
      } else {
        text = textFromMessage(raw);
      }

      const images = collectImages(raw);
      if (!text && images.length) text = "[图片]";

      const entry = {
        index: Number(raw.index_in_conv),
        message_id: raw.message_id,
        role,
        time,
        time_iso: beijingIso(time),
        text,
      };
      if (raw.thinking_content) entry.thinking = raw.thinking_content;
      if (alternates && alternates.length) entry.alternates = alternates;
      if (images.length) entry.images = images;
      messages.push(entry);
    }

    return {
      schema: "save-my-ai/v1",
      exported_at: new Date().toISOString(),
      source: "doubao.com",
      conversation: {
        id: item.conversationId,
        name: item.name,
        type: item.type || 3,
        bot_id: item.botId || null,
      },
      persona: item.persona || null,
      messages,
    };
  }

  function buildMarkdown(archive) {
    return buildMarkdownLines(archive).join("\n");
  }

  // Builds the human-readable chat view as an array of small line strings. The
  // caller can either join it (for the exported API) or stream it into byte
  // chunks, so an arbitrarily long history never forces one giant string.
  function buildMarkdownLines(archive) {
    const lines = [];
    const conversation = archive.conversation;
    const persona = archive.persona;
    lines.push("# " + (conversation.name || "豆包对话"));
    lines.push("");
    lines.push("> 导出时间：" + archive.exported_at);
    lines.push("> 来源：豆包 doubao.com");
    lines.push("> 消息数：" + archive.messages.length);
    lines.push("");
    if (persona) {
      lines.push("## 智能体人设");
      lines.push("");
      if (persona.name) lines.push("- 名称：" + persona.name);
      if (persona.description_for_human) lines.push("- 简介：" + persona.description_for_human);
      if (persona.description_for_model) lines.push("- 设定：" + persona.description_for_model);
      if (persona.model) lines.push("- 模型：" + persona.model);
      if (persona.voice) lines.push("- 音色：" + persona.voice);
      if (persona.creator) lines.push("- 创建者：" + persona.creator);
      if (persona.onboarding && persona.onboarding.length) {
        lines.push("- 开场白：");
        persona.onboarding.forEach((text) => lines.push("  > " + String(text).replace(/\n+/g, " ")));
      }
      lines.push("");
    }
    lines.push("---");
    lines.push("");
    const speaker = (role) => (role === "user" ? "用户" : (persona && persona.name) || "智能体");
    for (const message of archive.messages) {
      const time = message.time_iso ? " · " + message.time_iso : "";
      lines.push("**" + speaker(message.role) + "**" + time);
      lines.push("");
      lines.push(message.text || "（空）");
      lines.push("");
      if (message.images && message.images.length) {
        message.images.forEach((image) => {
          lines.push("![图片](" + (image.file || image.url) + ")");
          lines.push("");
        });
      }
      if (message.alternates && message.alternates.length) {
        lines.push("<details><summary>该回复还有 " + message.alternates.length + " 个未选中的重新生成分支</summary>");
        lines.push("");
        message.alternates.forEach((alternate, i) => {
          lines.push("_备选 " + (i + 1) + "：_");
          lines.push("");
          lines.push(alternate.text);
          lines.push("");
        });
        lines.push("</details>");
        lines.push("");
      }
    }
    return lines;
  }

  // Streams the markdown chat view into byte chunks, encoding lines in ~1MB
  // batches. Like raw.json, this avoids ever holding one huge string, so
  // chat.md is produced reliably regardless of conversation length.
  function markdownChunks(archive) {
    const lines = buildMarkdownLines(archive);
    const encoder = new TextEncoder();
    const chunks = [];
    let batch = [];
    let batchChars = 0;
    const flush = () => {
      if (!batch.length) return;
      // A newline separator between batches keeps the join identical to a single
      // lines.join("\n") over the whole document.
      if (chunks.length) chunks.push(encoder.encode("\n"));
      chunks.push(encoder.encode(batch.join("\n")));
      batch = [];
      batchChars = 0;
    };
    for (const line of lines) {
      batch.push(line);
      batchChars += line.length + 1;
      if (batchChars >= 1_000_000) flush();
    }
    flush();
    return chunks;
  }

  // --- Sidebar enumeration ---------------------------------------------------

  function enumerateSidebar() {
    const map = new Map();
    document.querySelectorAll('a[href^="/chat/"]').forEach((anchor) => {
      const href = anchor.getAttribute("href") || "";
      const name = (anchor.textContent || "").trim() || "未命名对话";
      let match;
      if ((match = href.match(/^\/chat\/bot\/chat\/(\d+)/))) {
        const key = "b" + match[1];
        if (!map.has(key)) map.set(key, { name, botId: match[1], href });
      } else if ((match = href.match(/^\/chat\/(\d+)/))) {
        const key = "c" + match[1];
        if (!map.has(key)) map.set(key, { name, conversationId: match[1], href });
      }
    });
    return [...map.values()];
  }

  function findSidebarScroller() {
    const links = document.querySelectorAll('a[href^="/chat/"]');
    for (const link of links) {
      let element = link.parentElement;
      while (element && element !== document.body) {
        if (element.scrollHeight > element.clientHeight + 40 && element.clientHeight > 150) {
          return element;
        }
        element = element.parentElement;
      }
    }
    return null;
  }

  // Scrolls the (virtualised) sidebar to force every conversation to render,
  // accumulating entries across scroll steps.
  async function autoLoadSidebar(maxRounds) {
    const accumulated = new Map();
    const collect = () =>
      enumerateSidebar().forEach((item) => {
        const key = item.botId ? "b" + item.botId : "c" + item.conversationId;
        if (!accumulated.has(key)) accumulated.set(key, item);
      });

    collect();
    const scroller = findSidebarScroller();
    if (scroller) {
      let previousHeight = -1;
      let stable = 0;
      for (let i = 0; i < (maxRounds || 40); i++) {
        scroller.scrollTop = scroller.scrollHeight;
        await sleep(300);
        collect();
        const height = scroller.scrollHeight;
        if (height === previousHeight) {
          if (++stable >= 2) break;
        } else {
          stable = 0;
        }
        previousHeight = height;
      }
      scroller.scrollTop = 0;
    }
    return [...accumulated.values()];
  }

  // Resolves bot personas and conversation ids for the selected sidebar items.
  async function resolveItems(items, log) {
    const botIds = items.filter((item) => item.botId).map((item) => item.botId);
    const botsById = {};
    if (botIds.length) {
      try {
        const bots = await getBotList(botIds);
        bots.forEach((bot) => (botsById[bot.id] = bot));
      } catch (error) {
        if (log) log("读取智能体人设失败：" + (error.message || error));
      }
    }
    for (const item of items) {
      if (item.botId) {
        const bot = botsById[item.botId];
        if (bot) {
          item.conversationId = bot.conversation_id;
          item.persona = buildPersona(bot);
          if (!item.name && bot.name) item.name = bot.name;
        }
      }
      item.type = 3;
    }
    return items.filter((item) => item.conversationId);
  }

  // --- ZIP archive (store method, no compression) ----------------------------

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  // Incremental CRC-32 so a file can be checksummed across many byte chunks
  // without ever holding all of its bytes in one buffer. Start from ~0, feed
  // chunks with crc32Update, then finalise with crc32Finish.
  function crc32Update(c, bytes) {
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return c;
  }
  const crc32Finish = (c) => (~c) >>> 0;

  const uint16 = (n) => new Uint8Array([n & 255, (n >>> 8) & 255]);
  const uint32 = (n) => new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);

  function concatBytes(chunks) {
    let length = 0;
    for (const chunk of chunks) length += chunk.length;
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }

  // Normalises a file's data into an array of byte chunks. Accepts a string, a
  // single Uint8Array, or an array of Uint8Array chunks (used for streamed,
  // arbitrarily large files that can't fit in one JS string).
  function toChunks(data, encoder) {
    if (typeof data === "string") return [encoder.encode(data)];
    if (data instanceof Uint8Array) return [data];
    if (Array.isArray(data)) return data;
    return [encoder.encode(String(data))];
  }

  function zipStore(files) {
    const encoder = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;

    for (const file of files) {
      const nameBytes = encoder.encode(file.name);
      const chunks = toChunks(file.data, encoder);
      let crc = ~0;
      let dataLength = 0;
      for (const chunk of chunks) {
        crc = crc32Update(crc, chunk);
        dataLength += chunk.length;
      }
      crc = crc32Finish(crc);
      const localHeader = concatBytes([
        uint32(0x04034b50),
        uint16(20),
        uint16(0x0800),
        uint16(0),
        uint16(0),
        uint16(0),
        uint32(crc),
        uint32(dataLength),
        uint32(dataLength),
        uint16(nameBytes.length),
        uint16(0),
      ]);
      parts.push(localHeader, nameBytes, ...chunks);
      central.push(
        concatBytes([
          uint32(0x02014b50),
          uint16(20),
          uint16(20),
          uint16(0x0800),
          uint16(0),
          uint16(0),
          uint16(0),
          uint32(crc),
          uint32(dataLength),
          uint32(dataLength),
          uint16(nameBytes.length),
          uint16(0),
          uint16(0),
          uint16(0),
          uint16(0),
          uint32(0),
          uint32(offset),
        ]),
        nameBytes
      );
      offset += localHeader.length + nameBytes.length + dataLength;
    }

    let centralSize = 0;
    for (const entry of central) centralSize += entry.length;
    const end = concatBytes([
      uint32(0x06054b50),
      uint16(0),
      uint16(0),
      uint16(files.length),
      uint16(files.length),
      uint32(centralSize),
      uint32(offset),
      uint16(0),
    ]);
    return new Blob([...parts, ...central, end], { type: "application/zip" });
  }

  // --- Helpers ---------------------------------------------------------------

  function sanitize(name) {
    return (
      (name || "对话")
        .replace(/[\\/:*?"<>|\r\n\t]+/g, "_")
        .replace(/\s+/g, "_")
        .slice(0, 40) || "对话"
    );
  }

  const shortId = (id) => String(id).slice(-6);

  function stamp() {
    const date = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return (
      date.getFullYear() +
      pad(date.getMonth() + 1) +
      pad(date.getDate()) +
      "-" +
      pad(date.getHours()) +
      pad(date.getMinutes())
    );
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function getSettings() {
    try {
      const stored = await chrome.storage.local.get(SETTINGS_KEY);
      const config = stored[SETTINGS_KEY];
      // The API key is optional (local runtimes need none); only base URL and
      // model are required for the model-backed features.
      if (config && config.baseUrl && config.model) return config;
    } catch {}
    return null;
  }

  const README_TEXT =
    "这是由 SaveMyAI 导出的存档。\n\n" +
    "每个对话一个文件夹，内含：\n" +
    "  archive.json  结构化存档（推荐用于迁移到其他 AI 陪伴工具）\n" +
    "  chat.md       可直接阅读的聊天记录（含人设、重新生成的分支、图片）\n" +
    "  raw.json      豆包接口原始数据（最完整的兜底备份，请务必保留）\n" +
    "  images/       聊天里的图片（如果导出时勾选了「包含图片」）\n\n" +
    "若勾选了酒馆相关选项，压缩包中还会有 SillyTavern/ 文件夹，每个角色一个子文件夹：\n" +
    "    chats/*.jsonl              酒馆格式聊天记录（重新生成的分支已映射为 swipes）\n" +
    "    <角色名>.png / .card.json  角色卡（基于聊天记录提取，推荐直接导入 .png）\n" +
    "    world_book.json            核心记忆世界书（随角色卡一起提取）\n\n" +
    "archive.json 中，被重新生成过的 AI 回复，text 字段是你当时选中显示的那一条，\n" +
    "其余未选中的分支保存在 alternates 里，不会丢失。\n\n" +
    "所有数据仅保存在你自己的电脑上，SaveMyAI 不会上传任何内容。\n";

  // --- Image download --------------------------------------------------------

  function extensionFromUrl(url) {
    const match = String(url).split("?")[0].match(/\.(png|jpe?g|gif|webp|bmp)$/i);
    return match ? match[0].toLowerCase() : ".png";
  }

  async function fetchImageBytes(url) {
    const response = await fetch(url, { credentials: "omit" });
    if (!response.ok) throw new Error("http " + response.status);
    return new Uint8Array(await response.arrayBuffer());
  }

  async function downloadImages(archive, folder, files, log) {
    let count = 0;
    let failed = 0;
    for (const message of archive.messages) {
      if (!message.images || !message.images.length) continue;
      for (const image of message.images) {
        count++;
        const relativePath = "images/" + message.index + "_" + count + extensionFromUrl(image.url);
        try {
          const bytes = await fetchImageBytes(image.url);
          files.push({ name: folder + "/" + relativePath, data: bytes });
          image.file = relativePath;
        } catch {
          failed++;
        }
      }
    }
    if (count) log("  图片：已保存 " + (count - failed) + "/" + count + " 张");
  }

  // --- SillyTavern generation ------------------------------------------------

  // Produces SillyTavern files for a group of conversations belonging to one bot.
  // Two independent deliverables share the same folder and character name:
  //   - chat records (JSONL)          when options.tavernChat
  //   - character card + world book   when options.reconstruct
  async function generateTavernFiles(group, files, options, log) {
    const convert = window.__SaveMyAIConvert;
    const worldInfo = window.__SaveMyAIWorldInfo;
    const canUseModel = Boolean(
      options.reconstruct && options.settings && !options.modelUnavailable && worldInfo
    );

    let messageCount = 0;
    group.archives.forEach((archive) => (messageCount += (archive.messages || []).length));

    const conversations = group.archives.map((archive) => ({
      name: archive.conversation.name,
      personaName: group.persona && group.persona.name,
      messages: archive.messages || [],
    }));

    // Reconstruct the character from the chat history: one shared pipeline yields
    // both the persona (for the card) and the world book, so they stay
    // consistent. The author's original core setting is preserved in the card
    // notes, never discarded.
    let persona = group.persona;
    let facts = [];
    if (canUseModel) {
      log(persona ? "    正在基于聊天记录提取角色卡与世界书…" : "    正在为普通对话提取角色卡与世界书…");
      const result = await worldInfo.reconstructCharacter(conversations, options.settings, log, persona);
      facts = result.facts || [];
      if (result.persona) {
        const original = persona || {};
        const originalSetting = (original.description_for_model || "").trim();
        const greetings = Array.isArray(original.onboarding) ? original.onboarding.filter(Boolean) : [];
        if (result.persona.first_mes && !greetings.includes(result.persona.first_mes)) {
          greetings.push(result.persona.first_mes);
        }
        persona = {
          ...original,
          name: original.name || result.persona.name,
          description_for_model: result.persona.description || originalSetting,
          onboarding: greetings.length ? greetings : result.persona.first_mes ? [result.persona.first_mes] : [],
          original_setting:
            originalSetting && originalSetting !== result.persona.description ? originalSetting : "",
        };
        log("    人设已生成：" + (persona.name || "（未命名）"));
      }
    }

    const characterName = sanitize(
      (persona && persona.name) || group.name || (group.botId ? "智能体_" + shortId(group.botId) : "豆包伙伴")
    );
    const base = "SillyTavern/" + characterName + "/";

    // Character card + world book (only when extraction was requested).
    if (options.reconstruct) {
      let characterBook = null;
      if (facts.length) {
        characterBook = worldInfo.factsToCharacterBook(facts, characterName + " · 迁移记忆");
        log("    世界书：得到 " + facts.length + " 条长期记忆。");
      }

      const card = convert.buildCardV2(
        persona,
        {
          fallbackName: characterName,
          botId: group.botId,
          exportedAt: group.archives[0] && group.archives[0].exported_at,
          messageCount,
        },
        characterBook
      );
      files.push({ name: base + characterName + ".card.json", data: JSON.stringify(card, null, 2) });
      if (characterBook) {
        files.push({ name: base + "world_book.json", data: JSON.stringify(characterBook, null, 2) });
      }
      try {
        const png = await convert.buildCardPng(JSON.stringify(card), characterName);
        files.push({ name: base + characterName + ".png", data: png });
      } catch (error) {
        log("  （该角色 PNG 生成失败，仍有 .card.json 可用：" + (error.message || error) + "）");
      }
      log("  ✔ 角色卡：" + characterName + (characterBook ? "（含世界书）" : ""));
    }

    // Tavern-format chat records (only when requested).
    if (options.tavernChat) {
      group.archives.forEach((archive) => {
        const jsonl = convert.buildChatJsonl(archive, characterName);
        const fileName =
          sanitize(archive.conversation.name || "对话") + "_" + shortId(archive.conversation.id) + ".jsonl";
        files.push({ name: base + "chats/" + fileName, data: jsonl });
      });
      log("  ✔ 聊天记录：" + characterName + "（" + group.archives.length + " 段）");
    }
  }

  // --- Export orchestration --------------------------------------------------

  // Streams a top-level object into an array of small byte chunks, emitting any
  // array or nested-object value element-by-element. This never materialises a
  // single string, so it stays clear of the JS engine's ~512MB string limit no
  // matter how long the conversation is. Elements (one message / one field) are
  // assumed individually small. Output is compact (unindented) JSON.
  function objectToChunks(obj) {
    const encoder = new TextEncoder();
    const chunks = [];
    const put = (s) => chunks.push(encoder.encode(s));
    const keys = Object.keys(obj);
    put("{");
    keys.forEach((key, ki) => {
      put((ki ? "," : "") + JSON.stringify(key) + ":");
      const value = obj[key];
      if (Array.isArray(value)) {
        put("[");
        for (let i = 0; i < value.length; i++) put((i ? "," : "") + JSON.stringify(value[i]));
        put("]");
      } else if (value && typeof value === "object") {
        const subKeys = Object.keys(value);
        put("{");
        subKeys.forEach((sk, si) => put((si ? "," : "") + JSON.stringify(sk) + ":" + JSON.stringify(value[sk])));
        put("}");
      } else {
        put(JSON.stringify(value));
      }
    });
    put("}");
    return chunks;
  }

  // Serialises an object for a file, preferring human-readable pretty-printed
  // output, then compact, and finally a streamed byte form for histories so
  // large that even a compact string would exceed the engine's max string
  // length. Returns either a string or an array of byte chunks (both accepted
  // by zipStore).
  function jsonForFile(obj) {
    try {
      return JSON.stringify(obj, null, 2);
    } catch (prettyError) {
      try {
        return JSON.stringify(obj);
      } catch (compactError) {
        return objectToChunks(obj);
      }
    }
  }

  async function exportConversations(items, log, options) {
    const settings = options || {};
    const files = [];
    const index = [];
    const groups = new Map();

    for (const item of items) {
      log("导出：" + item.name);
      try {
        const { rawMessages, regen } = await fetchAll(item.conversationId, log);
        const archive = buildArchive(item, rawMessages, regen);
        const folder = sanitize(item.name) + "_" + shortId(item.conversationId);

        if (settings.includeImages !== false) {
          await downloadImages(archive, folder, files, log);
        }
        if (settings.tavernChat || settings.reconstruct) {
          // Bots are grouped per bot; non-bot conversations (e.g. chats with the
          // default assistant) are merged into a single character.
          const key = item.botId ? "b" + item.botId : "normal";
          if (!groups.has(key)) {
            groups.set(key, {
              botId: item.botId || null,
              persona: item.persona || archive.persona || null,
              name: item.botId ? item.name || archive.conversation.name : null,
              archives: [],
            });
          }
          groups.get(key).archives.push(archive);
        }

        // archive.json (falls back to a streamed byte form) and raw.json (always
        // streamed message-by-message) can handle histories of any length
        // without building one huge string, so they are written first.
        files.push({ name: folder + "/archive.json", data: jsonForFile(archive) });
        files.push({
          name: folder + "/raw.json",
          data: objectToChunks({
            conversation: { id: item.conversationId, name: item.name, bot_id: item.botId || null },
            persona: item.persona || null,
            messages: rawMessages,
            regen_messages: regen,
          }),
        });
        // chat.md is streamed in line batches (see markdownChunks), so the
        // human-readable view is produced reliably for histories of any length.
        files.push({ name: folder + "/chat.md", data: markdownChunks(archive) });
        index.push({
          name: item.name,
          conversationId: item.conversationId,
          botId: item.botId || null,
          messageCount: archive.messages.length,
        });
        log("  ✔ 完成，共 " + archive.messages.length + " 条消息");
      } catch (error) {
        log("  ✘ 失败：" + (error && error.message ? error.message : error));
        index.push({ name: item.name, error: String(error && error.message ? error.message : error) });
      }
    }

    if ((settings.tavernChat || settings.reconstruct) && groups.size && window.__SaveMyAIConvert) {
      log("");

      // Preflight the model once (rather than failing repeatedly per chunk) when
      // extraction was requested. On failure we keep going without the model, so
      // chat records are still produced and the card falls back to the basic
      // persona from the Doubao API.
      let genOptions = settings;
      if (settings.reconstruct && settings.settings && window.__SaveMyAIWorldInfo) {
        log("正在校验模型接口…");
        const check = await window.__SaveMyAIWorldInfo.verifyModel(settings.settings);
        if (check.ok) {
          log("模型接口正常（" + settings.settings.model + "）。");
        } else {
          log("⚠ 模型接口不可用：" + check.error);
          log("  将跳过智能提取，改用基础人设生成角色卡。");
          genOptions = { ...settings, modelUnavailable: true };
        }
      }

      log("正在生成 SillyTavern 可导入文件…");
      for (const group of groups.values()) {
        try {
          await generateTavernFiles(group, files, genOptions, log);
        } catch (error) {
          log("  ✘ 生成酒馆文件失败：" + (error && error.message ? error.message : error));
        }
      }
    }

    files.push({
      name: "index.json",
      data: JSON.stringify(
        { schema: "save-my-ai/v1", exported_at: new Date().toISOString(), conversations: index },
        null,
        2
      ),
    });
    files.push({ name: "README.txt", data: README_TEXT });

    downloadBlob(zipStore(files), "SaveMyAI-" + stamp() + ".zip");
    log("");
    log("全部完成，已开始下载 zip 压缩包。");
    return items.length;
  }

  window.__SaveMyAI = { enumerateSidebar, resolveItems, exportConversations, fetchAll, buildArchive, buildMarkdown };

  // --- User interface --------------------------------------------------------

  function el(tag, props, children) {
    const element = document.createElement(tag);
    if (props) Object.assign(element, props);
    if (children) {
      (Array.isArray(children) ? children : [children]).forEach((child) =>
        element.appendChild(typeof child === "string" ? document.createTextNode(child) : child)
      );
    }
    return element;
  }

  function buildUI() {
    const fab = el("button", { id: "smai-fab", title: "SaveMyAI · 导出", textContent: "SaveMyAI" });
    document.body.appendChild(fab);

    let panel = null;
    fab.addEventListener("click", () => {
      if (panel) {
        panel.remove();
        panel = null;
        return;
      }
      panel = buildPanel(() => {
        if (panel) panel.remove();
        panel = null;
      });
      document.body.appendChild(panel);
    });
  }

  function buildPanel(onClose) {
    const panel = el("div", { id: "smai-panel" });

    const header = el("div", { className: "smai-header" }, [
      el("span", { className: "smai-title", textContent: "SaveMyAI · 导出" }),
      el("button", { className: "smai-close", textContent: "×" }),
    ]);
    header.querySelector(".smai-close").addEventListener("click", onClose);

    const toolbar = el("div", { className: "smai-toolbar" });
    const selectAll = el("label", { className: "smai-selall" }, [
      Object.assign(document.createElement("input"), { type: "checkbox" }),
      el("span", { textContent: "全选" }),
    ]);
    const refreshButton = el("button", { className: "smai-btn smai-btn-ghost", textContent: "刷新列表" });
    toolbar.appendChild(selectAll);
    toolbar.appendChild(refreshButton);

    const listBox = el("div", { className: "smai-list" });
    const logBox = el("div", { className: "smai-log" });
    const log = (message) => {
      logBox.appendChild(el("div", { className: "smai-log-line", textContent: message }));
      logBox.scrollTop = logBox.scrollHeight;
    };

    const imageToggle = Object.assign(document.createElement("input"), { type: "checkbox", checked: true });
    const imageLabel = el("label", { className: "smai-toggle" }, [
      imageToggle,
      el("span", { textContent: "包含聊天里的图片（会慢一些）" }),
    ]);

    // Tavern-format chat records (JSONL). Independent of the card.
    const chatToggle = Object.assign(document.createElement("input"), { type: "checkbox", checked: true });
    const chatLabel = el("label", { className: "smai-toggle" }, [
      chatToggle,
      el("span", { textContent: "生成酒馆格式聊天记录" }),
    ]);

    // Model-backed extraction: the character card and world book, both derived
    // from the chat history in one shared pipeline. Opt-in, needs a model.
    const extractToggle = Object.assign(document.createElement("input"), {
      type: "checkbox",
      checked: false,
      disabled: true,
    });
    const extractLabel = el("label", { className: "smai-toggle smai-toggle-disabled" }, [
      extractToggle,
      el("span", { textContent: "基于聊天记录提取角色卡和世界书（需在插件图标处配置模型）" }),
    ]);

    const exportButton = el("button", { className: "smai-btn smai-btn-primary", textContent: "导出选中的对话" });

    const footer = el("div", { className: "smai-footer" }, [
      imageLabel,
      chatLabel,
      extractLabel,
      exportButton,
    ]);

    getSettings().then((config) => {
      if (config) {
        extractToggle.disabled = false;
        extractLabel.classList.remove("smai-toggle-disabled");
        extractLabel.lastChild.textContent =
          "基于聊天记录提取角色卡和世界书（模型：" + config.model + "）";
      }
    });

    async function renderList() {
      listBox.innerHTML = "";
      listBox.appendChild(el("div", { className: "smai-empty", textContent: "正在加载对话列表（会自动滚动侧边栏）…" }));
      const items = await autoLoadSidebar();
      listBox.innerHTML = "";
      if (!items.length) {
        listBox.appendChild(
          el("div", {
            className: "smai-empty",
            textContent: "未找到对话。请确认已登录豆包，并在左侧边栏能看到对话列表。",
          })
        );
        return;
      }
      items.forEach((item, i) => {
        const row = el("label", { className: "smai-row" });
        const checkbox = Object.assign(document.createElement("input"), { type: "checkbox" });
        checkbox.dataset.i = i;
        row.appendChild(checkbox);
        row.appendChild(el("span", { className: "smai-row-name", textContent: item.name }));
        row.appendChild(
          el("span", {
            className: "smai-badge" + (item.botId ? " smai-badge-bot" : ""),
            textContent: item.botId ? "智能体" : "对话",
          })
        );
        listBox.appendChild(row);
      });
      panel.__items = items;
    }

    selectAll.querySelector("input").addEventListener("change", (event) => {
      listBox.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
        checkbox.checked = event.target.checked;
      });
    });

    refreshButton.addEventListener("click", renderList);

    exportButton.addEventListener("click", async () => {
      const checked = [...listBox.querySelectorAll('input[type="checkbox"]:checked')];
      if (!checked.length) {
        log("请先勾选要导出的对话。");
        return;
      }
      const items = checked.map((checkbox) => panel.__items[Number(checkbox.dataset.i)]);
      exportButton.disabled = true;
      refreshButton.disabled = true;
      logBox.innerHTML = "";
      log("正在读取智能体人设并解析对话…");
      try {
        const settings = extractToggle.checked ? await getSettings() : null;
        const resolved = await resolveItems(items.map((item) => ({ ...item })), log);
        if (!resolved.length) {
          log("没有可导出的对话（可能无法解析会话 ID）。");
        } else {
          await exportConversations(resolved, log, {
            includeImages: imageToggle.checked,
            tavernChat: chatToggle.checked,
            reconstruct: extractToggle.checked,
            settings,
          });
        }
      } catch (error) {
        log("出错：" + (error && error.message ? error.message : error));
      } finally {
        exportButton.disabled = false;
        refreshButton.disabled = false;
      }
    });

    panel.appendChild(header);
    panel.appendChild(toolbar);
    panel.appendChild(listBox);
    panel.appendChild(el("div", { className: "smai-log-title", textContent: "进度" }));
    panel.appendChild(logBox);
    panel.appendChild(footer);

    renderList();
    return panel;
  }

  buildUI();
})();
