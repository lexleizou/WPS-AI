(function attachEditShortcuts(global) {
  "use strict";

  function isEditableElement(el) {
    if (!el || !el.tagName) return false;
    const tag = String(el.tagName).toUpperCase();
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true;
  }

  function getEditableTarget(target, activeElement) {
    if (isEditableElement(target)) return target;
    if (isEditableElement(activeElement)) return activeElement;
    return null;
  }

  function shouldTrapPasteShortcut(ev, activeElement) {
    if (!ev || (!(ev.ctrlKey || ev.metaKey)) || ev.altKey) return false;
    if (String(ev.key || "").toLowerCase() !== "v") return false;
    return !!getEditableTarget(ev.target, activeElement);
  }

  function shouldTrapEditShortcut(ev, activeElement) {
    if (!ev || (!(ev.ctrlKey || ev.metaKey)) || ev.altKey) return false;
    const key = String(ev.key || "").toLowerCase();
    if (key !== "a" && key !== "c" && key !== "x" && key !== "v" && key !== "z" && key !== "y") return false;
    return !!getEditableTarget(ev.target, activeElement);
  }

  function getUndoRedoCommand(ev, activeElement) {
    if (!ev || (!(ev.ctrlKey || ev.metaKey)) || ev.altKey) return "";
    if (!getEditableTarget(ev.target, activeElement)) return "";
    const key = String(ev.key || "").toLowerCase();
    if (key === "z") return ev.shiftKey ? "redo" : "undo";
    if (key === "y") return "redo";
    return "";
  }

  function getTextValue(el) {
    if (!el || typeof el.value === "undefined") return null;
    return String(el.value || "");
  }

  function getSelectionRange(el) {
    const value = getTextValue(el);
    if (value == null) return null;
    let start = typeof el.selectionStart === "number" ? el.selectionStart : value.length;
    let end = typeof el.selectionEnd === "number" ? el.selectionEnd : start;
    start = Math.max(0, Math.min(value.length, start));
    end = Math.max(0, Math.min(value.length, end));
    if (end < start) {
      const tmp = start;
      start = end;
      end = tmp;
    }
    return { value, start, end };
  }

  function canModifyText(el) {
    return !!el && el.readOnly !== true && el.disabled !== true;
  }

  function dispatchInputEvent(el, EventCtor) {
    const Ctor = EventCtor || (global && global.Event);
    if (typeof el.dispatchEvent === "function" && typeof Ctor === "function") {
      el.dispatchEvent(new Ctor("input", { bubbles: true }));
    }
  }

  function insertTextAtCursor(el, text, EventCtor) {
    if (!el || text == null) return false;
    if (!canModifyText(el)) return false;
    const range = getSelectionRange(el);
    if (!range) return false;
    const { value, start, end } = range;
    el.value = value.slice(0, start) + String(text) + value.slice(end);
    const caret = start + String(text).length;
    try {
      el.selectionStart = caret;
      el.selectionEnd = caret;
    } catch (error) { /* readonly or unsupported element */ }
    dispatchInputEvent(el, EventCtor);
    return true;
  }

  function selectAllText(el) {
    const value = getTextValue(el);
    if (value == null) return false;
    try { if (typeof el.focus === "function") el.focus(); } catch (error) {}
    try {
      el.selectionStart = 0;
      el.selectionEnd = value.length;
      return true;
    } catch (error) {
      try {
        if (typeof el.select === "function") {
          el.select();
          return true;
        }
      } catch (innerError) {}
      return false;
    }
  }

  function getSelectedText(el) {
    const range = getSelectionRange(el);
    if (!range) return "";
    return range.value.slice(range.start, range.end);
  }

  async function copySelectionToClipboard(el, writeText) {
    const text = getSelectedText(el);
    if (!text || typeof writeText !== "function") return false;
    const ok = await writeText(text);
    return ok !== false;
  }

  async function cutSelectionToClipboard(el, writeText, EventCtor) {
    const range = getSelectionRange(el);
    if (!canModifyText(el)) return false;
    if (!range || range.start === range.end || typeof writeText !== "function") return false;
    const text = range.value.slice(range.start, range.end);
    const ok = await writeText(text);
    if (ok === false) return false;
    el.value = range.value.slice(0, range.start) + range.value.slice(range.end);
    try {
      el.selectionStart = range.start;
      el.selectionEnd = range.start;
    } catch (error) { /* readonly or unsupported element */ }
    dispatchInputEvent(el, EventCtor);
    return true;
  }

  function readTextFromClipboardEvent(ev) {
    try {
      const data = ev && ev.clipboardData;
      if (!data || typeof data.getData !== "function") return "";
      return data.getData("text/plain") || data.getData("text") || "";
    } catch (error) {
      return "";
    }
  }

  function shouldHandlePasteEvent(ev, pendingManualPaste, activeElement, maxAgeMs = 1200) {
    if (!pendingManualPaste || !pendingManualPaste.target) return false;
    if (Date.now() - Number(pendingManualPaste.ts || 0) > maxAgeMs) return false;
    const target = getEditableTarget(ev && ev.target, activeElement);
    return !!target && target === pendingManualPaste.target;
  }

  function shouldUseCustomEditableContextMenu(ev, activeElement) {
    if (!ev) return false;
    if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.shiftKey) return false;
    return !!getEditableTarget(ev.target, activeElement);
  }

  const api = {
    copySelectionToClipboard,
    cutSelectionToClipboard,
    getEditableTarget,
    getSelectedText,
    getUndoRedoCommand,
    insertTextAtCursor,
    isEditableElement,
    readTextFromClipboardEvent,
    selectAllText,
    shouldHandlePasteEvent,
    shouldUseCustomEditableContextMenu,
    shouldTrapEditShortcut,
    shouldTrapPasteShortcut
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (global) global.WpsAiEditShortcuts = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
