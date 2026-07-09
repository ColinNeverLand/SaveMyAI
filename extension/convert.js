// Conversion of a SaveMyAI archive into SillyTavern assets, performed entirely
// in the page (no server, no build step):
//   - Character Card V2, emitted as JSON and as a PNG with the card embedded
//     in `chara`/`ccv3` tEXt chunks (the format SillyTavern reads).
//   - Chat log, emitted as JSONL. Regenerated Doubao replies become swipes.
//
// Exposed on `window.__SaveMyAIConvert`.

(function () {
  "use strict";

  const textEncoder = new TextEncoder();

  const uuid = () =>
    (crypto.randomUUID && crypto.randomUUID()) ||
    "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });

  // --- Character Card V2 -----------------------------------------------------

  // Builds a Character Card V2 object from a Doubao persona. `characterBook`,
  // when provided, is embedded as SillyTavern World Info.
  function buildCardV2(persona, meta, characterBook) {
    const p = persona || {};
    const info = meta || {};
    const name = p.name || info.fallbackName || "豆包角色";
    const description = (p.description_for_model || p.description_for_human || "").trim();
    const greetings = Array.isArray(p.onboarding) ? p.onboarding.filter(Boolean) : [];

    const notes = ["由 SaveMyAI 从豆包智能体迁移。"];
    if (p.description_for_human) notes.push("简介：" + p.description_for_human);
    if (p.original_setting) notes.push("作者原始设定：" + p.original_setting);
    if (p.model) notes.push("原模型：" + p.model);
    if (p.voice) notes.push("原音色：" + p.voice);
    if (p.creator) notes.push("原创建者：" + p.creator);
    if (p.share_url) notes.push("原分享链接：" + p.share_url);
    if (info.exportedAt) notes.push("导出时间：" + info.exportedAt);
    if (info.messageCount != null) notes.push("迁移消息数：" + info.messageCount);

    const card = {
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: {
        name,
        description,
        personality: (p.description_for_human || "").trim(),
        scenario: "",
        first_mes: greetings[0] || "",
        mes_example: "",
        creator_notes: notes.join("\n"),
        system_prompt: "",
        post_history_instructions: "",
        alternate_greetings: greetings.slice(1),
        tags: ["SaveMyAI", "doubao"],
        creator: p.creator || "SaveMyAI",
        character_version: "doubao-migrated",
        extensions: {
          save_my_ai: { bot_id: info.botId || null, source: "doubao.com" },
        },
      },
    };

    if (characterBook && characterBook.entries && characterBook.entries.length) {
      card.data.character_book = characterBook;
    }
    return card;
  }

  // --- Chat log (JSONL) ------------------------------------------------------

  function messageTimestamp(message) {
    if (message.time_iso) return message.time_iso;
    if (message.time) return new Date(message.time * 1000).toISOString();
    return new Date().toISOString();
  }

  // Serialises an archive into a SillyTavern chat file. The first line is the
  // metadata header; each subsequent line is one message.
  function buildChatJsonl(archive, characterName, userName) {
    const speaker = userName || "You";
    const lines = [
      JSON.stringify({
        user_name: "unused",
        character_name: "unused",
        chat_metadata: { integrity: uuid() },
      }),
    ];

    for (const message of archive.messages || []) {
      const isUser = message.role === "user";
      const timestamp = messageTimestamp(message);
      const extra = {};
      if (message.thinking) extra.reasoning = message.thinking;
      if (message.images && message.images.length) {
        const paths = message.images.map((image) => image.file || image.url).filter(Boolean);
        if (paths.length) {
          extra.image = paths[0];
          if (paths.length > 1) extra.image_swipes = paths;
        }
      }

      const entry = {
        name: isUser ? speaker : characterName,
        is_user: isUser,
        is_system: false,
        send_date: timestamp,
        mes: message.text || "",
        extra,
      };

      // Doubao regenerations map onto swipes: the selected reply is swipe 0.
      if (!isUser && Array.isArray(message.alternates) && message.alternates.length) {
        const swipes = [message.text || ""].concat(
          message.alternates.map((alternate) => alternate.text || "")
        );
        entry.swipes = swipes;
        entry.swipe_id = 0;
        entry.swipe_info = swipes.map(() => ({
          send_date: timestamp,
          gen_started: timestamp,
          gen_finished: timestamp,
          extra: {},
        }));
      }

      lines.push(JSON.stringify(entry));
    }

    return lines.join("\n") + "\n";
  }

  // --- PNG generation --------------------------------------------------------
  //
  // A minimal solid-colour PNG is generated from scratch and the character card
  // is stored in tEXt chunks. IDAT is compressed with CompressionStream, whose
  // "deflate" format is the zlib stream PNG requires.

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = ~0;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (~c) >>> 0;
  }

  function uint32BE(value) {
    return new Uint8Array([
      (value >>> 24) & 255,
      (value >>> 16) & 255,
      (value >>> 8) & 255,
      value & 255,
    ]);
  }

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

  function pngChunk(type, data) {
    const typeAndData = concatBytes([textEncoder.encode(type), data]);
    return concatBytes([uint32BE(data.length), typeAndData, uint32BE(crc32(typeAndData))]);
  }

  function textChunk(keyword, text) {
    return pngChunk(
      "tEXt",
      concatBytes([textEncoder.encode(keyword), new Uint8Array([0]), textEncoder.encode(text)])
    );
  }

  async function deflate(bytes) {
    const stream = new CompressionStream("deflate");
    const writer = stream.writable.getWriter();
    writer.write(bytes);
    writer.close();
    const buffer = await new Response(stream.readable).arrayBuffer();
    return new Uint8Array(buffer);
  }

  function hslToRgb(h, s, l) {
    const hue = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return [
      Math.round(hue(p, q, h + 1 / 3) * 255),
      Math.round(hue(p, q, h) * 255),
      Math.round(hue(p, q, h - 1 / 3) * 255),
    ];
  }

  function colorFromString(value) {
    let hash = 0;
    for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
    return hslToRgb((hash % 360) / 360, 0.45, 0.72);
  }

  function base64(utf8String) {
    return btoa(unescape(encodeURIComponent(utf8String)));
  }

  const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // Returns a PNG (as Uint8Array) that carries the character card in metadata.
  async function buildCardPng(cardJson, name) {
    const width = 400;
    const height = 600;
    const [r, g, b] = colorFromString(name || "SaveMyAI");

    const header = new Uint8Array(13);
    header.set(uint32BE(width), 0);
    header.set(uint32BE(height), 4);
    header[8] = 8; // bit depth
    header[9] = 2; // colour type: truecolour (RGB)

    const stride = width * 3;
    const raw = new Uint8Array((stride + 1) * height);
    for (let y = 0; y < height; y++) {
      const rowStart = y * (stride + 1);
      raw[rowStart] = 0; // filter type: none
      for (let x = 0; x < width; x++) {
        const pixel = rowStart + 1 + x * 3;
        raw[pixel] = r;
        raw[pixel + 1] = g;
        raw[pixel + 2] = b;
      }
    }

    const chunks = [
      PNG_SIGNATURE,
      pngChunk("IHDR", header),
      pngChunk("IDAT", await deflate(raw)),
      textChunk("chara", base64(cardJson)),
    ];

    try {
      const v3 = JSON.parse(cardJson);
      v3.spec = "chara_card_v3";
      v3.spec_version = "3.0";
      chunks.push(textChunk("ccv3", base64(JSON.stringify(v3))));
    } catch {
      // If the card cannot be re-serialised as V3, the V2 chunk alone suffices.
    }

    chunks.push(pngChunk("IEND", new Uint8Array(0)));
    return concatBytes(chunks);
  }

  window.__SaveMyAIConvert = { buildCardV2, buildChatJsonl, buildCardPng };
})();
