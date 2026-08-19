(function attachAuth(global) {
  "use strict";

  // 非官方配置项：复用 Codex CLI 当前公开 OAuth 配置。
  const CODEX_OAUTH = Object.freeze({
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    authUrl: "https://auth.openai.com/oauth/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    redirectUri: "http://localhost:1455/auth/callback",
    scope: "openid profile email offline_access",
    extraParams: Object.freeze({
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true"
    })
  });

  const STORAGE_KEYS = Object.freeze({
    accessToken: "wps_ai_access_token",
    refreshToken: "wps_ai_refresh_token",
    expiresAt: "wps_ai_expires_at",
    codeVerifier: "wps_ai_code_verifier",
    oauthState: "wps_ai_oauth_state"
  });

  // 为满足“登录一次，除非手动退出否则保持登录”的需求，使用 WpsAiStore（SQLite 持久化）保存 Token。
  // 如部署环境要求关闭插件即清除登录态，可改回 sessionStorage。
  const tokenStorage = global.WpsAiStore;

  function base64UrlEncode(bytes) {
    const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function randomString(byteLength) {
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    return base64UrlEncode(bytes);
  }

  async function sha256Base64Url(value) {
    const data = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return base64UrlEncode(new Uint8Array(digest));
  }

  function setTokenPayload(payload) {
    const expiresIn = Number(payload.expires_in || 3600);
    const expiresAt = Date.now() + expiresIn * 1000;

    tokenStorage.setItem(STORAGE_KEYS.accessToken, payload.access_token);
    tokenStorage.setItem(STORAGE_KEYS.expiresAt, String(expiresAt));

    if (payload.refresh_token) {
      tokenStorage.setItem(STORAGE_KEYS.refreshToken, payload.refresh_token);
    }
  }

  function clearAuth() {
    Object.values(STORAGE_KEYS).forEach((key) => tokenStorage.removeItem(key));
  }

  function getAccessToken() {
    return tokenStorage.getItem(STORAGE_KEYS.accessToken) || "";
  }

  function getRefreshToken() {
    return tokenStorage.getItem(STORAGE_KEYS.refreshToken) || "";
  }

  function getExpiresAt() {
    return Number(tokenStorage.getItem(STORAGE_KEYS.expiresAt) || 0);
  }

  function isAuthenticated() {
    return Boolean(getAccessToken()) && Date.now() < getExpiresAt() - 30_000;
  }

  function getTokenInfo() {
    const expiresAt = getExpiresAt();
    return {
      authenticated: isAuthenticated(),
      expiresAt,
      expiresAtText: expiresAt ? new Date(expiresAt).toLocaleString() : ""
    };
  }

  function parseAuthorizationCallback(input) {
    const trimmed = input.trim();
    if (!trimmed) {
      return { code: "", state: "" };
    }

    try {
      const url = new URL(trimmed);
      const hashParams = new URLSearchParams(url.hash.replace(/^#/, ""));
      return {
        code: url.searchParams.get("code") || hashParams.get("code") || "",
        state: url.searchParams.get("state") || hashParams.get("state") || ""
      };
    } catch (error) {
      return { code: trimmed, state: "" };
    }
  }

  async function buildAuthorizationUrl() {
    const codeVerifier = randomString(64);
    const codeChallenge = await sha256Base64Url(codeVerifier);
    const state = randomString(24);

    tokenStorage.setItem(STORAGE_KEYS.codeVerifier, codeVerifier);
    tokenStorage.setItem(STORAGE_KEYS.oauthState, state);

    const url = new URL(CODEX_OAUTH.authUrl);
    url.searchParams.set("client_id", CODEX_OAUTH.clientId);
    url.searchParams.set("redirect_uri", CODEX_OAUTH.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", CODEX_OAUTH.scope);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);

    Object.entries(CODEX_OAUTH.extraParams).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });

    return url.toString();
  }

  async function startLogin() {
    const url = await buildAuthorizationUrl();
    openExternalUrl(url);
    return url;
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard?.writeText(text);
      return true;
    } catch (error) {
      const input = document.createElement("textarea");
      input.value = text;
      input.setAttribute("readonly", "readonly");
      input.style.cssText = "position:fixed;left:-9999px;top:-9999px;";
      document.body.appendChild(input);
      input.select();
      const copied = document.execCommand("copy");
      document.body.removeChild(input);
      return copied;
    }
  }

  async function openExternalUrl(url) {
    if (global.wps?.OAAssist?.ShellExecute) {
      global.wps.OAAssist.ShellExecute(url);
      return true;
    }

    const opened = global.open(url, "_blank");
    if (opened) {
      return true;
    }

    await copyToClipboard(url);
    throw new Error("当前 WPS WebView 阻止打开浏览器，授权链接已复制到剪贴板，请粘贴到系统浏览器打开。");
  }

  async function requestToken(body) {
    const response = await fetch(CODEX_OAUTH.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams(body).toString()
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error_description || payload.error || `Token request failed: ${response.status}`);
    }

    setTokenPayload(payload);
    return payload;
  }

  async function exchangeCode(input) {
    const { code, state } = parseAuthorizationCallback(input);
    const codeVerifier = tokenStorage.getItem(STORAGE_KEYS.codeVerifier);
    const expectedState = tokenStorage.getItem(STORAGE_KEYS.oauthState);

    if (!code) {
      throw new Error("请先粘贴 OAuth 回调 URL 或 authorization_code。");
    }
    if (!codeVerifier) {
      throw new Error("缺少 PKCE code_verifier，请重新点击登录按钮发起授权。");
    }
    if (state && expectedState && state !== expectedState) {
      throw new Error("OAuth state 校验失败，请重新点击登录按钮发起授权。");
    }

    const payload = await requestToken({
      grant_type: "authorization_code",
      client_id: CODEX_OAUTH.clientId,
      redirect_uri: CODEX_OAUTH.redirectUri,
      code,
      code_verifier: codeVerifier
    });

    tokenStorage.removeItem(STORAGE_KEYS.codeVerifier);
    tokenStorage.removeItem(STORAGE_KEYS.oauthState);

    return payload;
  }

  async function refreshTokenIfNeeded() {
    if (isAuthenticated()) {
      return getAccessToken();
    }

    const refreshToken = getRefreshToken();
    if (!refreshToken) {
      clearAuth();
      return "";
    }

    await requestToken({
      grant_type: "refresh_token",
      client_id: CODEX_OAUTH.clientId,
      refresh_token: refreshToken
    });

    return getAccessToken();
  }

  global.WpsAiAuth = {
    config: {
      authorizationEndpoint: CODEX_OAUTH.authUrl,
      tokenEndpoint: CODEX_OAUTH.tokenUrl,
      clientId: CODEX_OAUTH.clientId,
      redirectUri: CODEX_OAUTH.redirectUri,
      scope: CODEX_OAUTH.scope,
      extraParams: CODEX_OAUTH.extraParams
    },
    startLogin,
    buildAuthorizationUrl,
    openExternalUrl,
    copyToClipboard,
    exchangeCode,
    refreshTokenIfNeeded,
    getAccessToken,
    getTokenInfo,
    isAuthenticated,
    clearAuth
  };
})(window);
