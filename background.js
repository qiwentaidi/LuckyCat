/*
 * Lucky Cat - background service worker
 *
 * Responsibilities:
 *   - remember the response headers of the active tab (webRequest sees headers
 *     that fetch() cannot, e.g. Set-Cookie)
 *   - fetch resources on behalf of the popup, so host permissions (instead of
 *     the page's CORS policy) decide what can be read
 */

const RESPONSE_KEY = 'luckycat.responses';
const MAX_REMEMBERED_TABS = 20;

const responseCache = new Map();

async function rememberResponse(tabId, info) {
    const entry = {
        tabId: tabId,
        url: info.url,
        statusCode: info.statusCode,
        statusLine: info.statusLine,
        headers: info.headers,
        time: Date.now()
    };
    responseCache.set(tabId, entry);

    try {
        const stored = await chrome.storage.session.get(RESPONSE_KEY);
        const map = stored[RESPONSE_KEY] || {};
        map[tabId] = entry;
        const keys = Object.keys(map);
        if (keys.length > MAX_REMEMBERED_TABS) {
            keys.sort((a, b) => (map[a].time || 0) - (map[b].time || 0));
            keys.slice(0, keys.length - MAX_REMEMBERED_TABS).forEach(key => delete map[key]);
        }
        await chrome.storage.session.set({ [RESPONSE_KEY]: map });
    } catch (err) {
        // Storage is a fallback; losing it only means the popup falls back to
        // fetch() headers.
        console.warn('LuckyCat: cannot persist response headers', err);
    }
}

chrome.webRequest.onHeadersReceived.addListener(
    function (details) {
        if (details.tabId < 0 || details.type !== 'main_frame') {
            return;
        }
        const headers = (details.responseHeaders || []).map(header => [header.name, header.value]);
        rememberResponse(details.tabId, {
            url: details.url,
            statusCode: details.statusCode,
            statusLine: details.statusLine,
            headers: headers
        });
    },
    { urls: ['<all_urls>'], types: ['main_frame'] },
    ['responseHeaders', 'extraHeaders']
);

chrome.tabs.onRemoved.addListener(function (tabId) {
    responseCache.delete(tabId);
    chrome.storage.session.get(RESPONSE_KEY).then(stored => {
        const map = stored[RESPONSE_KEY] || {};
        if (map[tabId]) {
            delete map[tabId];
            return chrome.storage.session.set({ [RESPONSE_KEY]: map });
        }
    }).catch(() => {});
});

async function getResponseInfo(tabId) {
    if (responseCache.has(tabId)) {
        return responseCache.get(tabId);
    }
    try {
        const stored = await chrome.storage.session.get(RESPONSE_KEY);
        const entry = (stored[RESPONSE_KEY] || {})[tabId] || null;
        if (entry) {
            responseCache.set(tabId, entry);
        }
        return entry;
    } catch (err) {
        return null;
    }
}

function bytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

async function fetchText(url, options) {
    const opts = options || {};
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs || 15000);
    try {
        const response = await fetch(url, {
            method: 'GET',
            credentials: opts.credentials === false ? 'omit' : 'include',
            redirect: 'follow',
            signal: controller.signal
        });
        const headers = [];
        response.headers.forEach(function (value, key) {
            headers.push([key, value]);
        });
        let text = await response.text();
        const maxBytes = opts.maxBytes || 4 * 1024 * 1024;
        let truncated = false;
        if (text.length > maxBytes) {
            text = text.slice(0, maxBytes);
            truncated = true;
        }
        return {
            ok: true,
            status: response.status,
            statusText: response.statusText,
            url: response.url,
            headers: headers,
            text: text,
            truncated: truncated
        };
    } catch (err) {
        return { ok: false, error: String(err && err.message ? err.message : err) };
    } finally {
        clearTimeout(timer);
    }
}

async function fetchBinary(url, options) {
    const opts = options || {};
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs || 15000);
    try {
        const response = await fetch(url, {
            method: 'GET',
            credentials: opts.credentials === false ? 'omit' : 'include',
            redirect: 'follow',
            signal: controller.signal
        });
        if (!response.ok) {
            return { ok: false, status: response.status, error: 'HTTP ' + response.status };
        }
        const buffer = await response.arrayBuffer();
        return {
            ok: true,
            status: response.status,
            base64: bytesToBase64(new Uint8Array(buffer)),
            bytes: buffer.byteLength
        };
    } catch (err) {
        return { ok: false, error: String(err && err.message ? err.message : err) };
    } finally {
        clearTimeout(timer);
    }
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || typeof message.type !== 'string') {
        return false;
    }

    if (message.type === 'luckycat:headers') {
        getResponseInfo(message.tabId).then(sendResponse);
        return true;
    }

    if (message.type === 'luckycat:fetch') {
        fetchText(message.url, message).then(sendResponse);
        return true;
    }

    if (message.type === 'luckycat:fetch-binary') {
        fetchBinary(message.url, message).then(sendResponse);
        return true;
    }

    return false;
});
