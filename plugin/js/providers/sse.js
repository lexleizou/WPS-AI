(function attachSseUtil(global) {
  "use strict";

  async function readSse(response, handleEvent) {
    if (!response.body) {
      throw new Error("当前环境不支持 ReadableStream，无法使用流式输出。");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    // 单个事件块 → 解析并派发。修 B21：按 /\r?\n/ 切行，兼容 CRLF 结尾的 SSE。
    const processBlock = async (block) => {
      let currentEvent = "";
      const dataLines = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trim());
        }
      }
      if (dataLines.length === 0) return;
      const data = dataLines.join("\n");
      if (data === "[DONE]") return;
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch (error) {
        return;
      }
      // 跳过 null/非对象 payload，避免下游 handler 取 .choices/.delta 时崩溃
      if (parsed == null || typeof parsed !== "object") return;
      await handleEvent(currentEvent || parsed.type || "", parsed);
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        // 修 B21：flush 跨 chunk 截断的多字节 UTF-8 尾巴，并处理残留 buffer。
        // 不少网关在流末尾只发 `data: {...}\n` 就 EOF（没有收尾空行），
        // 旧代码 break 时把最后一个事件直接丢弃（Anthropic 的 message_delta /
        // codex 的 response.completed 因此收不到）。
        buffer += decoder.decode();
        if (buffer.trim()) {
          for (const block of buffer.split(/\r?\n\r?\n/)) {
            if (block.trim()) await processBlock(block);
          }
        }
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      // 修 B21：事件分隔兼容 \n\n 与 \r\n\r\n（部分 OpenAI 兼容网关用 CRLF）。
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() || "";

      for (const block of blocks) {
        await processBlock(block);
      }
    }
  }

  global.WpsAiSse = { readSse };
})(window);
