// 生图错误归因分类器：把 provider 抛出的原始报错分成 8 类，
// 每类带可读 label + tone（用于色徽章）+ 一句处置建议。
//
// 独立成文件的原因：纯函数，无 DOM 依赖，可以在 provider 层 / worker /
// tests 里被复用。未来 chat 侧也可能用类似 classifier，做成通用规则集。
(function attachImageErrorClassifier(global) {
  "use strict";

  const RULES = [
    { match: /aborted|abort/, label: "已取消", tone: "muted", hint: "" },
    { match: /余额不足|insufficient.*(credit|quota|fund|balance)|quota.*exceed|rate.*limit|429/,
      label: "余额 / 配额不足", tone: "quota", hint: "请到 sub2api / 供应商后台充值或换一条渠道。" },
    { match: /敏感|违规|content.?policy|safety|blocked.*policy|不符合.*规范|refus/,
      label: "内容策略拦截", tone: "policy", hint: "提示词或参考图触发了安全审核，改写具象描述再试。" },
    { match: /cloudflare|cf-ray|challenge|1015|1020|1010/,
      label: "被 Cloudflare 拦截", tone: "network", hint: "线路被上游 CDN 拦截，换代理节点或稍后重试。" },
    { match: /401|403|invalid.?api.?key|unauthor|forbidden|鉴权|无效.*key/,
      label: "鉴权失败", tone: "auth", hint: "API Key 无效或未开通图像渠道，去设置 → 图像供应商检查。" },
    { match: /failed to fetch|networkerror|net::|econnreset|etimedout|enotfound|超时|timeout|证书|tls|dns|连接被拒|网络不可达/,
      label: "网络 / 代理不可达", tone: "network", hint: "确认 npm run proxy 在跑，或换网络环境重试。" },
    { match: /model.*not.?support|unsupported.*model|no model|model not found|model="?[^"]*"?.*不被.*支持/,
      label: "模型不可用", tone: "model", hint: "当前渠道不支持该 model，切换到别的模型或渠道。" },
    { match: /服务器|server error|500|502|503|504|upstream/,
      label: "供应商服务异常", tone: "network", hint: "上游临时故障，稍后重试。" }
  ];

  function classify(raw) {
    const msg = String(raw || "").toLowerCase();
    for (const rule of RULES) {
      if (rule.match.test(msg)) {
        return { label: rule.label, tone: rule.tone, hint: rule.hint };
      }
    }
    return { label: "生成失败", tone: "unknown", hint: "" };
  }

  global.WpsAiImageErrorClassifier = { classify, RULES };
})(window);
