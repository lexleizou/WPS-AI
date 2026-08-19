(function initAntdModalIslands(global) {
  "use strict";

  const Vue = global.Vue;
  const antd = global.antd;
  const h = Vue && Vue.h;
  const bridge = {
    ready: false,
    openDevLogViewer: null,
    refreshDevLogViewer: null,
    isDevLogViewerOpen: null,
    enhanceSettings: null
  };
  let rootEl = null;

  global.WpsAiAntdModals = bridge;

  if (!Vue || !antd || !h) {
    console.warn("[antd-modals] Vue or Ant Design Vue was not loaded; keeping legacy modals.");
    return;
  }

  function ensureRoot() {
    let root = rootEl || document.getElementById("antdModalRoot");
    if (!root) {
      if (!document.body) return null;
      root = document.createElement("div");
      root.id = "antdModalRoot";
      document.body.appendChild(root);
    }
    rootEl = root;
    return root;
  }

  function runWhenBodyReady(callback) {
    if (document.body) {
      callback();
      return;
    }
    document.addEventListener("DOMContentLoaded", callback, { once: true });
  }

  function notify(type, text) {
    const api = antd.message;
    try {
      if (api && typeof api[type] === "function") api[type](text);
    } catch (error) {
      console.warn("[antd-modals] message failed:", error);
    }
  }

  function emitNativeChange(node) {
    try {
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (error) {
      const inputEvent = document.createEvent("Event");
      inputEvent.initEvent("input", true, true);
      node.dispatchEvent(inputEvent);
      const changeEvent = document.createEvent("Event");
      changeEvent.initEvent("change", true, true);
      node.dispatchEvent(changeEvent);
    }
  }

  function findPropertyDescriptor(node, prop) {
    let proto = node;
    while (proto) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, prop);
      if (descriptor) return descriptor;
      proto = Object.getPrototypeOf(proto);
    }
    return null;
  }

  function patchNativeProperty(node, prop, onSet) {
    const descriptor = findPropertyDescriptor(node, prop);
    if (!descriptor?.get || !descriptor?.set) return null;
    const ownDescriptor = Object.getOwnPropertyDescriptor(node, prop);
    try {
      Object.defineProperty(node, prop, {
        configurable: true,
        enumerable: descriptor.enumerable,
        get() {
          return descriptor.get.call(node);
        },
        set(value) {
          descriptor.set.call(node, value);
          onSet(descriptor.get.call(node));
        }
      });
      return () => {
        try {
          if (ownDescriptor) Object.defineProperty(node, prop, ownDescriptor);
          else delete node[prop];
        } catch (error) {
          console.warn("[antd-modals] failed to restore native property:", prop, error);
        }
      };
    } catch (error) {
      console.warn("[antd-modals] failed to patch native property:", prop, error);
      return null;
    }
  }

  async function copyText(text) {
    if (!text) {
      notify("info", "没有可复制的内容。");
      return;
    }
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "readonly");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      notify("success", "已复制。");
    } catch (error) {
      notify("error", `复制失败：${error?.message || error}`);
    }
  }

  function safeReadLogs(store, key) {
    try {
      const raw = store?.getItem?.(key);
      return raw ? JSON.parse(raw) || [] : [];
    } catch (error) {
      console.warn("[antd-modals] failed to parse preview logs:", error);
      return [];
    }
  }

  function formatLogEntry(entry) {
    const date = new Date(entry.ts || Date.now());
    const time = Number.isFinite(date.getTime()) ? date.toISOString().slice(11, 23) : "--:--:--.---";
    return `${time} [${entry.level || "INFO"}][${entry.where || "-"}][${entry.tag || "-"}] ${entry.msg || ""}`;
  }

  function isSensitiveInput(input) {
    const text = [
      input.id,
      input.name,
      input.getAttribute("data-field"),
      input.placeholder,
      input.getAttribute("aria-label")
    ].filter(Boolean).join(" ");
    return input.type === "password" || /api\s*key|apikey|token|secret|password|authorization/i.test(text);
  }

  function isProviderCopyInput(input) {
    const field = input.getAttribute("data-field");
    return !!input.closest(".chat-provider-card-body") && (field === "baseUrl" || field === "apiKey");
  }

  function isEnhanceableTextInput(input) {
    if (!input || input.dataset.antdEnhanced === "true") return false;
    if (input.closest(".legacy-shim")) return false;
    if (input.closest(".antd-input-shell")) return false;
    if (input.closest(".antd-input-root, .ant-input-affix-wrapper")) return false;
    if (input.closest(".field-with-picker")) return false;
    const type = (input.getAttribute("type") || "text").toLowerCase();
    return ["", "text", "search", "url", "email", "number", "password", "tel"].includes(type);
  }

  function isEnhanceableCheckbox(input) {
    return !!input
      && input.type === "checkbox"
      && input.dataset.antdEnhanced !== "true"
      && !input.closest(".legacy-shim")
      && !input.hidden;
  }

  function mountAntdApp(root, component) {
    const app = Vue.createApp(component);
    app.use(antd);
    app.mount(root);
    return app;
  }

  function enhanceTextInput(input) {
    if (!isEnhanceableTextInput(input)) return;
    input.dataset.antdEnhanced = "true";
    const sensitive = isSensitiveInput(input);
    const canCopy = isProviderCopyInput(input);
    const originalType = (input.getAttribute("type") || "text").toLowerCase();
    const InputComponent = antd.Input;
    const shell = document.createElement("span");
    shell.className = "antd-input-shell";
    input.parentNode.insertBefore(shell, input);
    shell.appendChild(input);
    input.classList.add("antd-native-input-hidden");

    const root = document.createElement("span");
    root.className = "antd-input-root";
    root.addEventListener("click", (event) => event.stopPropagation());
    root.addEventListener("mousedown", (event) => event.stopPropagation());
    shell.appendChild(root);

    mountAntdApp(root, {
      data() {
        return {
          value: input.value || "",
          passwordVisible: false
        };
      },
      mounted() {
        this.handleNativeInput = () => { this.value = input.value || ""; };
        input.addEventListener("input", this.handleNativeInput);
        input.addEventListener("change", this.handleNativeInput);
        this.restoreNativeValue = patchNativeProperty(input, "value", (value) => {
          this.value = value == null ? "" : String(value);
        });
      },
      beforeUnmount() {
        input.removeEventListener("input", this.handleNativeInput);
        input.removeEventListener("change", this.handleNativeInput);
        this.restoreNativeValue?.();
      },
      methods: {
        updateValue(value) {
          this.value = value == null ? "" : String(value);
          input.value = this.value;
          emitNativeChange(input);
        },
        copyValue() {
          copyText(this.value || "");
        },
        togglePasswordVisible() {
          this.passwordVisible = !this.passwordVisible;
        }
      },
      render() {
        const slots = {};
        const inputProps = {
          value: this.value,
          allowClear: true,
          placeholder: input.placeholder || "",
          disabled: input.disabled,
          readonly: input.readOnly,
          size: "small",
          class: "antd-settings-input",
          "onUpdate:value": this.updateValue,
          onChange: (event) => this.updateValue(event?.target?.value ?? this.value),
          onInput: (event) => this.updateValue(event?.target?.value ?? this.value)
        };
        if (canCopy && !sensitive) {
          slots.suffix = () => h("button", {
            type: "button",
            class: "antd-copy-suffix-btn",
            title: "复制",
            "aria-label": "复制",
            onClick: (event) => {
              event.preventDefault();
              event.stopPropagation();
              this.copyValue();
            },
            onMousedown: (event) => {
              event.preventDefault();
              event.stopPropagation();
            }
          }, [h("span", { class: "antd-copy-icon", "aria-hidden": "true" })]);
        }
        if (sensitive) {
          inputProps.type = this.passwordVisible ? "text" : "password";
        } else if (originalType && originalType !== "password") {
          inputProps.type = originalType;
        }
        if (canCopy) {
          slots.suffix = () => h("button", {
            type: "button",
            class: "antd-copy-suffix-btn",
            title: "复制",
            "aria-label": "复制",
            onClick: (event) => {
              event.preventDefault();
              event.stopPropagation();
              this.copyValue();
            },
            onMousedown: (event) => {
              event.preventDefault();
              event.stopPropagation();
            }
          }, [h("span", { class: "antd-copy-icon", "aria-hidden": "true" })]);
        }
        if (sensitive) {
          slots.suffix = () => h("span", { class: "antd-input-suffix-actions" }, [
            h("button", {
              type: "button",
              class: "antd-suffix-icon-btn",
              title: this.passwordVisible ? "隐藏" : "显示",
              "aria-label": this.passwordVisible ? "隐藏" : "显示",
              onClick: (event) => {
                event.preventDefault();
                event.stopPropagation();
                this.togglePasswordVisible();
              },
              onMousedown: (event) => {
                event.preventDefault();
                event.stopPropagation();
              }
            }, [h("span", { class: this.passwordVisible ? "antd-eye-icon visible" : "antd-eye-icon", "aria-hidden": "true" })]),
            canCopy ? h("button", {
              type: "button",
              class: "antd-suffix-icon-btn",
              title: "复制",
              "aria-label": "复制",
              onClick: (event) => {
                event.preventDefault();
                event.stopPropagation();
                this.copyValue();
              },
              onMousedown: (event) => {
                event.preventDefault();
                event.stopPropagation();
              }
            }, [h("span", { class: "antd-copy-icon", "aria-hidden": "true" })]) : null
          ].filter(Boolean));
        }
        return h(InputComponent, inputProps, slots);
      }
    });
  }

  function enhanceCheckbox(input) {
    if (!isEnhanceableCheckbox(input)) return;
    input.dataset.antdEnhanced = "true";
    input.classList.add("antd-native-checkbox-hidden");

    const root = document.createElement("span");
    root.className = "antd-switch-root";
    root.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    input.parentNode.insertBefore(root, input.nextSibling);

    mountAntdApp(root, {
      data() {
        return { checked: !!input.checked };
      },
      mounted() {
        this.handleNativeChange = () => { this.checked = !!input.checked; };
        input.addEventListener("change", this.handleNativeChange);
        this.restoreNativeChecked = patchNativeProperty(input, "checked", (value) => {
          this.checked = !!value;
        });
      },
      beforeUnmount() {
        input.removeEventListener("change", this.handleNativeChange);
        this.restoreNativeChecked?.();
      },
      methods: {
        updateChecked(value) {
          this.checked = !!value;
          input.checked = this.checked;
          emitNativeChange(input);
        }
      },
      render() {
        return h(antd.Switch, {
          checked: this.checked,
          size: "small",
          "onUpdate:checked": this.updateChecked,
          onChange: this.updateChecked
        });
      }
    });
  }

  function enhanceSettingsControls(root) {
    const settingsRoot = root || document.getElementById("settingsModal");
    if (!settingsRoot) return;
    settingsRoot.querySelectorAll("input").forEach((input) => {
      if (isEnhanceableCheckbox(input)) enhanceCheckbox(input);
      else if (isEnhanceableTextInput(input)) enhanceTextInput(input);
    });
  }

  function observeSettingsControls() {
    const settingsRoot = document.getElementById("settingsModal");
    if (!settingsRoot || settingsRoot.dataset.antdSettingsObserved === "true") return;
    settingsRoot.dataset.antdSettingsObserved = "true";
    enhanceSettingsControls(settingsRoot);
    const observer = new MutationObserver((mutations) => {
      let shouldEnhance = false;
      for (const mutation of mutations) {
        if (mutation.type === "childList" && mutation.addedNodes.length) {
          shouldEnhance = true;
          break;
        }
      }
      if (shouldEnhance) enhanceSettingsControls(settingsRoot);
    });
    observer.observe(settingsRoot, { childList: true, subtree: true });
  }

  const DevLogViewer = {
    name: "WpsAiDevLogViewer",
    data() {
      return {
        open: false,
        filter: "",
        warnOnly: false,
        output: "(no matching logs)",
        statsLabel: "0",
        store: null,
        logKey: "",
        showMessage: null
      };
    },
    mounted() {
      bridge.ready = true;
      rootEl = ensureRoot();
      rootEl.dataset.antdModalsReady = "true";
      bridge.openDevLogViewer = this.openViewer;
      bridge.refreshDevLogViewer = this.renderLogs;
      bridge.isDevLogViewerOpen = () => this.open;
      this.handleOpenEvent = (event) => this.openViewer(event.detail || {});
      document.addEventListener("wps-ai:open-dev-log-viewer", this.handleOpenEvent);
    },
    beforeUnmount() {
      bridge.ready = false;
      if (rootEl) rootEl.dataset.antdModalsReady = "false";
      document.removeEventListener("wps-ai:open-dev-log-viewer", this.handleOpenEvent);
      bridge.openDevLogViewer = null;
      bridge.refreshDevLogViewer = null;
      bridge.isDevLogViewerOpen = null;
    },
    methods: {
      openViewer(options) {
        this.store = options?.store || this.store;
        this.logKey = options?.logKey || this.logKey;
        this.showMessage = options?.showMessage || this.showMessage;
        this.open = true;
        this.renderLogs(false);
        Vue.nextTick(() => this.scrollBottom());
      },
      handleAfterOpenChange(isOpen) {
        if (isOpen) Vue.nextTick(() => this.scrollBottom());
      },
      filteredLogs() {
        const logs = safeReadLogs(this.store, this.logKey);
        const total = logs.length;
        const keyword = String(this.filter || "").trim().toLowerCase();
        let filtered = this.warnOnly ? logs.filter((entry) => entry.level === "WARN") : logs;
        if (keyword) {
          filtered = filtered.filter((entry) => {
            const haystack = `[${entry.level || ""}][${entry.where || ""}][${entry.tag || ""}] ${entry.msg || ""}`.toLowerCase();
            return haystack.includes(keyword);
          });
        }
        return { total, filtered };
      },
      renderLogs(keepScroll) {
        const outputEl = this.$refs.outputRef;
        const prevScroll = keepScroll && outputEl ? outputEl.scrollTop : null;
        const { total, filtered } = this.filteredLogs();
        this.output = filtered.map(formatLogEntry).join("\n") || "(no matching logs)";
        this.statsLabel = filtered.length === total ? `${total} items` : `${filtered.length} / ${total} items`;
        if (prevScroll != null) {
          Vue.nextTick(() => {
            if (this.$refs.outputRef) this.$refs.outputRef.scrollTop = prevScroll;
          });
        }
      },
      updateFilter(event) {
        this.filter = event?.target?.value || "";
        this.renderLogs(true);
      },
      updateWarnOnly(event) {
        this.warnOnly = !!event?.target?.checked;
        this.renderLogs(true);
      },
      async copyLogs() {
        const text = this.output || "";
        if (!text || text === "(no matching logs)") {
          this.showMessage?.("没有可复制的日志内容。", "info");
          return;
        }
        try {
          if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
          } else {
            const outputEl = this.$refs.outputRef;
            const range = document.createRange();
            range.selectNodeContents(outputEl);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            document.execCommand("copy");
            sel.removeAllRanges();
          }
          this.showMessage?.(`已复制 ${text.length} 个字符。`, "success");
        } catch (error) {
          this.showMessage?.(`复制失败：${error?.message || error}`, "error");
        }
      },
      scrollBottom() {
        const outputEl = this.$refs.outputRef;
        if (outputEl) outputEl.scrollTop = outputEl.scrollHeight;
      }
    },
    render() {
      return h(antd.Modal, {
        open: this.open,
        title: "预览日志",
        width: "min(880px, calc(100vw - 32px))",
        footer: null,
        maskClosable: true,
        wrapClassName: "wps-ai-antd-modal-wrap",
        "onUpdate:open": (value) => { this.open = value; },
        onAfterOpenChange: this.handleAfterOpenChange
      }, {
        default: () => h("div", { class: "antd-dev-log-viewer" }, [
          h("div", { class: "antd-dev-log-toolbar" }, [
            h(antd.Input, {
              value: this.filter,
              allowClear: true,
              placeholder: "按标签、位置或关键词过滤",
              "onUpdate:value": (value) => {
                this.filter = value || "";
                this.renderLogs(true);
              },
              onInput: this.updateFilter
            }),
            h(antd.Checkbox, {
              checked: this.warnOnly,
              "onUpdate:checked": (value) => {
                this.warnOnly = !!value;
                this.renderLogs(true);
              },
              onChange: this.updateWarnOnly
            }, { default: () => "仅 WARN" }),
            h(antd.Badge, {
              count: this.statsLabel,
              numberStyle: { backgroundColor: "#64748b" }
            })
          ]),
          h("div", { class: "antd-dev-log-actions" }, [
            h(antd.Space, null, {
              default: () => [
                h(antd.Button, { size: "small", onClick: () => this.renderLogs(false) }, { default: () => "刷新" }),
                h(antd.Button, { size: "small", onClick: this.copyLogs }, { default: () => "复制" }),
                h(antd.Button, { size: "small", onClick: this.scrollBottom }, { default: () => "最新" })
              ]
            })
          ]),
          h("pre", { ref: "outputRef", class: "antd-dev-log-output" }, this.output)
        ])
      });
    }
  };

  bridge.enhanceSettings = enhanceSettingsControls;
  const app = Vue.createApp(DevLogViewer);
  app.use(antd);
  let mounted = false;

  runWhenBodyReady(() => {
    if (mounted) return;
    const root = ensureRoot();
    if (!root) return;
    mounted = true;
    app.mount(root);
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", observeSettingsControls, { once: true });
    } else {
      observeSettingsControls();
    }
  });
})(window);
