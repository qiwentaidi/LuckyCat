'use strict';

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

const HISTORY_KEY = 'luckycat.history';
const MAX_HISTORY = 20;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_JS_BYTES = 3 * 1024 * 1024;
const OP = RuleDsl.OP;

const state = {
    tab: null,
    input: null,
    web: null,
    snapshot: null,
    icon: null,
    headers: [],
    body: '',
    candidates: [],
    selected: new Set(),
    recommendations: [],
    recommendIndex: 0,
    filter: 'all',
    filterText: '',
    searchHits: [],
    view: 'rules',
    history: [],
    historyQuery: '',
    loading: false,
    jsLoaded: false
};

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function getActiveTab() {
    return new Promise((resolve) => {
        // Debug hook: opening popup.html as a normal tab can target a specific
        // tab with ?tabId=123, which also makes the popup testable end to end.
        const forced = new URLSearchParams(location.search).get('tabId');
        if (forced) {
            chrome.tabs.get(parseInt(forced, 10), (tab) => {
                resolve(chrome.runtime.lastError ? null : tab);
            });
            return;
        }
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const tab = tabs && tabs[0] ? tabs[0] : null;
            if (tab && /^chrome-extension:/i.test(tab.url || '')) {
                chrome.tabs.query({ currentWindow: true }, (all) => {
                    const page = (all || []).find(item => /^https?:/i.test(item.url || ''));
                    resolve(page || tab);
                });
                return;
            }
            resolve(tab);
        });
    });
}

function sendBackground(message, timeoutMs) {
    return new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (!settled) {
                settled = true;
                resolve(null);
            }
        }, timeoutMs || 25000);
        try {
            chrome.runtime.sendMessage(message, (response) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                if (chrome.runtime.lastError) {
                    resolve(null);
                    return;
                }
                resolve(response || null);
            });
        } catch (err) {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve(null);
            }
        }
    });
}

function bytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

function dataUrlToBytes(url) {
    const comma = url.indexOf(',');
    if (comma === -1) {
        return null;
    }
    const meta = url.slice(5, comma);
    const payload = url.slice(comma + 1);
    try {
        if (/;base64/i.test(meta)) {
            return base64ToBytes(payload);
        }
        return new TextEncoder().encode(decodeURIComponent(payload));
    } catch (err) {
        return null;
    }
}

function headerValue(headers, name) {
    if (!headers) {
        return '';
    }
    const lowered = String(name).toLowerCase();
    for (let i = 0; i < headers.length; i++) {
        if (String(headers[i][0]).toLowerCase() === lowered) {
            return String(headers[i][1] === undefined ? '' : headers[i][1]);
        }
    }
    return '';
}

function byteLength(text) {
    return text ? new TextEncoder().encode(text).length : 0;
}

async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (err) {
        const area = document.createElement('textarea');
        area.value = text;
        document.body.appendChild(area);
        area.select();
        let ok = false;
        try {
            ok = document.execCommand('copy');
        } catch (e) {
            ok = false;
        }
        document.body.removeChild(area);
        return ok;
    }
}

function openFofa(query) {
    if (!query) {
        return;
    }
    const encoded = btoa(unescape(encodeURIComponent(query)));
    window.open('https://fofa.info/result?qbase64=' + encodeURIComponent(encoded), '_blank');
}

let toastTimer = null;
function toast(message) {
    const el = document.getElementById('toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 1600);
}

function setStatus(text) {
    document.getElementById('extractStatus').textContent = text || '';
}

function currentHost() {
    try {
        return new URL(state.tab.url).host;
    } catch (err) {
        return '';
    }
}

/* ------------------------------------------------------------------ *
 * Page data collection
 * ------------------------------------------------------------------ */

// Injected into the page. Must not reference anything from popup.js.
function collectPageSnapshot() {
    const MAX_HTML = 4 * 1024 * 1024;
    const MAX_INLINE_SCRIPT = 512 * 1024;
    const html = document.documentElement ? document.documentElement.outerHTML : '';
    const scripts = [];
    let inlineBytes = 0;
    document.querySelectorAll('script').forEach((el) => {
        if (el.src) {
            scripts.push({ src: el.src, text: '' });
            return;
        }
        const text = el.textContent || '';
        if (text && inlineBytes < MAX_INLINE_SCRIPT) {
            scripts.push({ src: '', text: text });
            inlineBytes += text.length;
        }
    });
    const metas = {};
    document.querySelectorAll('meta').forEach((el) => {
        const key = el.getAttribute('name') || el.getAttribute('property') || el.getAttribute('http-equiv');
        if (key && !(key.toLowerCase() in metas)) {
            metas[key.toLowerCase()] = el.getAttribute('content') || '';
        }
    });
    return {
        url: location.href,
        title: document.title,
        html: html.slice(0, MAX_HTML),
        htmlTruncated: html.length > MAX_HTML,
        scripts: scripts,
        metas: metas,
        contentType: document.contentType || ''
    };
}

async function collectSnapshot(tabId) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: collectPageSnapshot
        });
        if (results && results[0] && results[0].result) {
            return results[0].result;
        }
        return null;
    } catch (err) {
        console.warn('LuckyCat: cannot read page DOM', err);
        return null;
    }
}

async function fetchIconBytes(url) {
    if (!url) {
        return null;
    }
    if (url.startsWith('data:')) {
        return dataUrlToBytes(url);
    }
    const response = await sendBackground({ type: 'luckycat:fetch-binary', url: url }, 15000);
    if (response && response.ok && response.base64) {
        return base64ToBytes(response.base64);
    }
    return null;
}

async function computeIconHashes(tab) {
    const result = { md5: '', mmh3: '', bytes: 0, error: '' };
    const candidates = [];
    if (tab.favIconUrl) {
        candidates.push(tab.favIconUrl);
    }
    try {
        const origin = new URL(tab.url).origin;
        if (origin && origin !== 'null') {
            candidates.push(origin + '/favicon.ico');
        }
    } catch (err) {
        // ignore malformed URLs
    }

    let bytes = null;
    for (const candidate of candidates) {
        bytes = await fetchIconBytes(candidate);
        if (bytes && bytes.length) {
            break;
        }
    }
    if (!bytes || bytes.length === 0) {
        result.error = 'favicon unavailable';
        return result;
    }
    result.bytes = bytes.length;

    let latin1 = '';
    for (let i = 0; i < bytes.length; i++) {
        latin1 += String.fromCharCode(bytes[i]);
    }
    result.md5 = CryptoJS.MD5(CryptoJS.enc.Latin1.parse(latin1)).toString();

    const base64 = bytesToBase64(bytes);
    let wrapped = (base64.match(/.{1,76}/g) || []).join('\n');
    if (!wrapped.endsWith('\n')) {
        wrapped += '\n';
    }
    result.mmh3 = String(mmh3_32(wrapped));
    return result;
}

function combineBody(domHtml, rawHtml) {
    const dom = typeof domHtml === 'string' ? domHtml : '';
    const raw = typeof rawHtml === 'string' ? rawHtml : '';
    let body;
    if (dom && raw) {
        if (dom.indexOf(raw.slice(0, 400)) !== -1) {
            body = dom;
        } else if (raw.indexOf(dom.slice(0, 400)) !== -1) {
            body = raw;
        } else {
            body = dom + '\n' + raw;
        }
    } else {
        body = dom || raw;
    }
    if (body.length > MAX_BODY_BYTES) {
        body = body.slice(0, MAX_BODY_BYTES);
    }
    return body;
}

async function collectAll(tab) {
    const [snapshot, responseInfo, fetchedPage] = await Promise.all([
        collectSnapshot(tab.id),
        sendBackground({ type: 'luckycat:headers', tabId: tab.id }, 8000),
        sendBackground({ type: 'luckycat:fetch', url: tab.url, maxBytes: MAX_BODY_BYTES }, 20000)
    ]);
    const fetched = fetchedPage && fetchedPage.ok ? fetchedPage : null;
    const icon = await computeIconHashes(tab);

    const domHtml = snapshot ? snapshot.html : '';
    const rawHtml = fetched ? fetched.text : '';
    const body = combineBody(domHtml, rawHtml);

    const capturedHeaders = responseInfo && responseInfo.headers ? responseInfo.headers : null;
    const fetchedHeaders = fetched && fetched.headers ? fetched.headers : [];
    const headers = capturedHeaders && capturedHeaders.length ? capturedHeaders : fetchedHeaders;

    const status = (responseInfo && responseInfo.statusCode)
        || (fetched && fetched.status)
        || 0;
    const statusLine = (responseInfo && responseInfo.statusLine)
        || (fetched && fetched.statusText)
        || '';
    const headerLines = [];
    if (status) {
        headerLines.push(statusLine && !/^http/i.test(statusLine)
            ? 'HTTP/1.1 ' + status + ' ' + statusLine
            : (statusLine || 'HTTP/1.1 ' + status));
    }
    headers.forEach(pair => headerLines.push(pair[0] + ': ' + pair[1]));

    const url = new URL(tab.url);
    let port = parseInt(url.port, 10);
    if (!port) {
        port = url.protocol === 'https:' ? 443 : 80;
    }

    const input = {
        url: tab.url,
        protocol: url.protocol.replace(':', ''),
        port: port,
        path: url.pathname || '/',
        title: (snapshot && snapshot.title) || tab.title || '',
        status: status,
        server: headerValue(headers, 'server'),
        contentType: headerValue(headers, 'content-type') || (snapshot && snapshot.contentType) || '',
        headers: headers,
        headerText: headerLines.join('\n'),
        rawHtml: rawHtml,
        domHtml: domHtml,
        body: body,
        jsBody: '',
        metas: (snapshot && snapshot.metas) || {},
        iconHash: icon.mmh3,
        iconMd5: icon.md5
    };

    const web = {
        protocol: input.protocol,
        port: input.port,
        path: input.path,
        title: input.title,
        status: input.status,
        iconHash: input.iconHash,
        iconMd5: input.iconMd5,
        body: input.body,
        jsBody: '',
        header: input.headerText,
        contentType: input.contentType,
        server: input.server,
        bodyLength: byteLength(rawHtml || body),
        banner: '',
        cert: ''
    };

    state.snapshot = snapshot;
    state.icon = icon;
    state.headers = headers;
    state.body = body;
    state.input = input;
    state.web = web;
    state.jsLoaded = false;
    return { input, icon, headers, body };
}

/* ------------------------------------------------------------------ *
 * Extraction
 * ------------------------------------------------------------------ */

async function runExtraction() {
    if (state.loading || !state.tab) {
        return;
    }
    state.loading = true;
    document.getElementById('refreshBtn').disabled = true;
    setStatus('采集页面…');
    showSkeleton();

    try {
        await collectAll(state.tab);
        setStatus('匹配中…');
        const result = RuleExtractor.extract(state.input);
        state.candidates = result.candidates;
        state.selected.clear();
        state.searchHits = [];
        state.filter = 'all';
        state.filterText = '';
        document.getElementById('featureSearch').value = '';
        document.querySelectorAll('.chip[data-filter]').forEach(chip => {
            chip.classList.toggle('active', chip.dataset.filter === 'all');
        });

        const rank = { broad: 3, medium: 2, versioned: 1, '': 0 };
        state.recommendations = state.candidates
            .filter(candidate => candidate.scope === 'product' && candidate.stability !== 'dynamic')
            .sort((a, b) => {
                const r = (rank[b.coverage] || 0) - (rank[a.coverage] || 0);
                if (r !== 0) {
                    return r;
                }
                if (b.score !== a.score) {
                    return b.score - a.score;
                }
                return a.value.length - b.value.length;
            });
        state.recommendIndex = 0;

        renderSite();
        renderRecommendation();
        renderCandidates();
        renderDiagnostics();
        updateSelection();

        const stable = state.candidates.filter(candidate => candidate.stability === 'stable').length;
        setStatus('提取 ' + state.candidates.length + ' 条 · 稳定 ' + stable);
    } catch (err) {
        console.error('LuckyCat: extraction failed', err);
        setStatus('提取失败');
        const list = document.getElementById('candidateList');
        list.textContent = '';
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = '提取失败：' + (err && err.message ? err.message : err);
        const retry = document.createElement('button');
        retry.className = 'btn ghost';
        retry.textContent = '重试';
        retry.style.marginTop = '8px';
        retry.addEventListener('click', runExtraction);
        empty.appendChild(document.createElement('br'));
        empty.appendChild(retry);
        list.appendChild(empty);
        document.getElementById('recommendCard').hidden = true;
        document.getElementById('noRecommend').hidden = true;
    } finally {
        state.loading = false;
        document.getElementById('refreshBtn').disabled = false;
    }
}

function showSkeleton() {
    const list = document.getElementById('candidateList');
    list.textContent = '';
    for (let i = 0; i < 3; i++) {
        const row = document.createElement('div');
        row.className = 'skeleton-row';
        list.appendChild(row);
    }
    document.getElementById('recommendCard').hidden = true;
    document.getElementById('noRecommend').hidden = true;
}

/* ------------------------------------------------------------------ *
 * Site + recommendation
 * ------------------------------------------------------------------ */

function renderSite() {
    const url = new URL(state.tab.url);
    document.getElementById('siteHost').textContent = url.host;
    document.getElementById('pageTitle').textContent = state.input.title || state.tab.title || '';
    if (state.tab.favIconUrl) {
        document.getElementById('favicon').src = state.tab.favIconUrl;
    }

    const status = state.input.status;
    const server = state.input.server;
    const pill = document.getElementById('statusPill');
    const text = document.getElementById('statusText');
    if (status) {
        text.textContent = status + (server ? ' · ' + server : '');
        pill.hidden = false;
    } else {
        pill.hidden = true;
    }
}

function coverageLabel(coverage) {
    if (coverage === 'broad') {
        return '跨站点通用';
    }
    if (coverage === 'medium') {
        return '产品路径';
    }
    if (coverage === 'versioned') {
        return '含版本号';
    }
    return '站点特征';
}

function recommendationConfidence(item) {
    return (item.coverage === 'broad' || item.score >= 75) ? '高' : '中';
}

function renderRecommendation() {
    const card = document.getElementById('recommendCard');
    const noRecommend = document.getElementById('noRecommend');
    if (!state.recommendations.length) {
        card.hidden = true;
        noRecommend.hidden = false;
        document.getElementById('selectTop').disabled = true;
        return;
    }
    noRecommend.hidden = true;
    card.hidden = false;

    const item = state.recommendations[state.recommendIndex % state.recommendations.length];
    const clause = RuleDsl.conditionText(item.source, item.op, item.value) || '';

    document.getElementById('recScope').textContent = RuleExtractor.SCOPE_LABEL[item.scope] || '产品级';
    const confidence = recommendationConfidence(item);
    const confidenceBadge = document.getElementById('recConfidence');
    confidenceBadge.textContent = '置信度' + confidence;
    confidenceBadge.className = 'badge ' + (confidence === '高' ? 'badge-green' : 'badge-amber');
    document.getElementById('recReason').textContent =
        (item.product || '产品标记') + ' · ' + coverageLabel(item.coverage);
    document.getElementById('recRule').textContent = clause;

    const result = RuleDsl.test(clause, state.web || {});
    const validation = document.getElementById('recValidation');
    if (result.ok && result.matched) {
        validation.textContent = '✓ 当前页命中';
        validation.style.color = 'var(--green)';
    } else if (result.ok) {
        validation.textContent = '语法合法 · 当前页未命中';
        validation.style.color = 'var(--amber)';
    } else {
        validation.textContent = '✗ 表达式不合法';
        validation.style.color = 'var(--red)';
    }

    document.getElementById('recNext').disabled = state.recommendations.length < 2;
    document.getElementById('recFofa').disabled = !RuleExtractor.buildFofaQuery([item]).query;
    document.getElementById('recCopy').disabled = !clause;
    document.getElementById('selectTop').disabled = false;
}

function copyRecommendation() {
    const item = state.recommendations[state.recommendIndex % Math.max(1, state.recommendations.length)];
    if (!item) {
        return;
    }
    const clause = RuleDsl.conditionText(item.source, item.op, item.value) || '';
    copyText(clause).then(ok => {
        toast(ok ? '规则已复制' : '复制失败');
        if (ok) {
            saveHistory(clause, [item]);
        }
    });
}

/* ------------------------------------------------------------------ *
 * Candidates
 * ------------------------------------------------------------------ */

function candidateClause(candidate) {
    return RuleDsl.conditionText(candidate.source, candidate.op, candidate.value) || '';
}

function candidateMatchesFilter(candidate) {
    if (state.filter === 'product' && candidate.scope !== 'product') {
        return false;
    }
    if (state.filter === 'stable' && candidate.stability !== 'stable') {
        return false;
    }
    if (state.filter === 'dynamic' && candidate.stability !== 'dynamic') {
        return false;
    }
    if (state.filterText) {
        const haystack = (candidateClause(candidate) + ' ' + candidate.label + ' ' + candidate.product).toLowerCase();
        if (haystack.indexOf(state.filterText.toLowerCase()) === -1) {
            return false;
        }
    }
    return true;
}

function candidateLevel(candidate) {
    if (candidate.recommended || candidate.score >= 75) {
        return 'high';
    }
    if (candidate.score >= 50) {
        return 'mid';
    }
    return 'low';
}

function renderCandidates() {
    const list = document.getElementById('candidateList');
    list.textContent = '';

    const all = state.candidates;
    const visible = all.filter(candidateMatchesFilter);
    document.getElementById('candidateCount').textContent = String(all.length);
    document.getElementById('chipAll').textContent = String(all.length);
    document.getElementById('chipProduct').textContent = String(all.filter(c => c.scope === 'product').length);
    document.getElementById('chipStable').textContent = String(all.filter(c => c.stability === 'stable').length);
    document.getElementById('chipDynamic').textContent = String(all.filter(c => c.stability === 'dynamic').length);

    if (!visible.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = all.length
            ? '没有符合筛选条件的候选'
            : '没有提取到候选特征，试试在页面中搜索关键词';
        list.appendChild(empty);
        return;
    }

    const groupOrder = ['body', 'icon', 'header', 'core', 'js', 'custom'];
    const groupNames = { body: '页面特征', icon: '图标', header: '响应头', core: '基础字段', js: '脚本', custom: '自定义' };

    groupOrder.forEach(group => {
        const items = visible.filter(candidate => candidate.group === group);
        if (!items.length) {
            return;
        }
        const head = document.createElement('div');
        head.className = 'group-head';
        head.appendChild(document.createTextNode(groupNames[group] || group));
        const count = document.createElement('em');
        count.textContent = String(items.length);
        head.appendChild(count);
        list.appendChild(head);
        items.forEach(candidate => list.appendChild(renderCandidate(candidate)));
    });
}

function renderCandidate(candidate) {
    const row = document.createElement('div');
    row.className = 'cand' + (state.selected.has(candidate.id) ? ' selected' : '')
        + (candidate.recommended ? ' recommended' : '');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.selected.has(candidate.id);
    checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
            state.selected.add(candidate.id);
        } else {
            state.selected.delete(candidate.id);
        }
        row.classList.toggle('selected', checkbox.checked);
        updateSelection();
    });
    row.appendChild(checkbox);

    const main = document.createElement('div');
    main.className = 'cand-main';

    const clause = document.createElement('div');
    clause.className = 'cand-clause';
    clause.textContent = candidateClause(candidate);
    main.appendChild(clause);

    const meta = document.createElement('div');
    meta.className = 'cand-meta';
    const label = document.createElement('span');
    label.textContent = candidate.label;
    meta.appendChild(label);
    meta.appendChild(document.createTextNode('·'));

    const scope = document.createElement('span');
    scope.className = 'scope ' + (candidate.scope || 'unknown');
    scope.textContent = RuleExtractor.SCOPE_LABEL[candidate.scope] || '未知';
    scope.title = candidate.scope === 'product'
        ? '产品/CMS 级特征，跨站点通用'
        : candidate.scope === 'deployment'
            ? '只描述当前部署：标题、ICP、Cookie、favicon 等'
            : candidate.scope === 'generic'
                ? '通用技术栈，覆盖面大但区分度低'
                : '自定义条件';
    meta.appendChild(scope);

    const stability = document.createElement('span');
    stability.className = 'stability ' + candidate.stability;
    stability.textContent = candidate.stability === 'stable' ? '稳定'
        : candidate.stability === 'dynamic' ? '易变' : '未知';
    stability.title = candidate.stability === 'stable'
        ? '在原始响应中存在，且不像随机值，重复访问通常不变'
        : candidate.stability === 'dynamic'
            ? '只在 JS 执行后出现，或包含随机串/时间戳，规则可能失效'
            : '无法判断稳定性';
    meta.appendChild(stability);

    if (candidate.count > 1) {
        const count = document.createElement('span');
        count.textContent = '×' + candidate.count;
        meta.appendChild(count);
    }
    if (candidate.version) {
        const version = document.createElement('span');
        version.className = 'version-tag';
        version.textContent = 'v' + candidate.version;
        meta.appendChild(version);
    }
    if (candidate.recommended) {
        const tag = document.createElement('span');
        tag.className = 'recommend-tag';
        tag.textContent = '推荐';
        meta.appendChild(tag);
    }
    main.appendChild(meta);
    row.appendChild(main);

    const conf = document.createElement('span');
    const level = candidateLevel(candidate);
    conf.className = 'conf ' + level;
    conf.textContent = level === 'high' ? '高' : level === 'mid' ? '中' : '低';
    conf.title = '推荐度：综合稳定性、来源类型与通用词判断';
    row.appendChild(conf);

    row.addEventListener('click', (event) => {
        if (event.target === checkbox) {
            return;
        }
        checkbox.checked = !checkbox.checked;
        checkbox.dispatchEvent(new Event('change'));
        row.classList.toggle('selected', checkbox.checked);
    });

    return row;
}

/* ------------------------------------------------------------------ *
 * Selection / footer
 * ------------------------------------------------------------------ */

function selectedCandidates() {
    return state.candidates.filter(candidate => state.selected.has(candidate.id));
}

function updateSelection() {
    const candidates = selectedCandidates();
    const expression = RuleExtractor.buildExpression(candidates);
    document.getElementById('selectionRule').textContent = expression || '未选择条件';
    document.getElementById('selectionRule').title = expression;

    const fofa = RuleExtractor.buildFofaQuery(candidates);
    const fofaButton = document.getElementById('fofaRule');
    fofaButton.disabled = !fofa.query;
    fofaButton.title = fofa.query
        ? (fofa.skipped.length ? '部分条件无法用 FOFA 语法表达，将被忽略' : '在 FOFA 中查看覆盖范围')
        : '没有可映射到 FOFA 的条件';

    document.getElementById('copyExpression').disabled = !expression;

    const hint = document.getElementById('ruleHint');
    hint.className = 'rule-hint';
    if (!candidates.length) {
        hint.classList.add('hint-muted');
        hint.textContent = '建议只选一条产品级条件；组合会收窄匹配范围，通常只命中当前部署。';
    } else if (candidates.length === 1) {
        const only = candidates[0];
        if (only.scope === 'product') {
            hint.classList.add('hint-good');
            hint.textContent = '单条产品级条件，适合识别该产品/CMS，可跨站点复用。';
        } else if (only.scope === 'deployment') {
            hint.classList.add('hint-warn');
            hint.textContent = '部署级条件，只适合标识当前站点；识别产品/CMS 请优先选产品级标记。';
        } else if (only.scope === 'generic') {
            hint.classList.add('hint-warn');
            hint.textContent = '通用技术栈条件，区分度低；建议再找一条产品级标记。';
        } else {
            hint.classList.add('hint-muted');
            hint.textContent = '自定义条件，请确认它是否能跨部署复用。';
        }
    } else {
        hint.classList.add('hint-warn');
        hint.textContent = '组合条件会收窄匹配范围，通常只命中当前部署；识别产品/CMS 建议只保留一条产品级条件。';
    }

    const footer = document.getElementById('footerSummary');
    footer.innerHTML = '';
    const strong = document.createElement('b');
    strong.textContent = candidates.length ? '已选 ' + candidates.length + ' 条' : '未选择条件';
    footer.appendChild(strong);
    if (candidates.length) {
        const dot = document.createElement('i');
        dot.className = 'dot green';
        footer.appendChild(dot);
        const scopeNames = Array.from(new Set(candidates.map(c => RuleExtractor.SCOPE_LABEL[c.scope] || '未知')));
        footer.appendChild(document.createTextNode(scopeNames.join(' + ')));
    }
}

/* ------------------------------------------------------------------ *
 * Search / custom conditions
 * ------------------------------------------------------------------ */

function renderSearchResults() {
    const box = document.getElementById('searchResults');
    box.textContent = '';
    if (!state.searchHits.length) {
        return;
    }
    state.searchHits.forEach(hit => {
        const row = document.createElement('div');
        row.className = 'search-hit';
        const src = document.createElement('span');
        src.className = 'src';
        src.textContent = hit.source;
        row.appendChild(src);
        const code = document.createElement('code');
        code.textContent = hit.value + (hit.count ? ' ×' + hit.count : '');
        code.title = hit.context || hit.value;
        row.appendChild(code);
        const add = document.createElement('button');
        add.textContent = '添加';
        add.addEventListener('click', () => addCandidate(hit));
        row.appendChild(add);
        box.appendChild(row);
    });
}

function addCandidate(candidate) {
    const existing = state.candidates.find(item => item.id === candidate.id);
    if (existing) {
        state.selected.add(existing.id);
    } else {
        state.candidates.unshift(candidate);
        state.selected.add(candidate.id);
    }
    state.filter = 'all';
    state.filterText = '';
    document.getElementById('featureSearch').value = '';
    document.querySelectorAll('.chip[data-filter]').forEach(chip => {
        chip.classList.toggle('active', chip.dataset.filter === 'all');
    });
    renderCandidates();
    updateSelection();
}

function runPageSearch() {
    if (!state.input) {
        return;
    }
    const keyword = document.getElementById('featureSearch').value.trim();
    if (keyword.length < 2) {
        state.searchHits = [];
        renderSearchResults();
        return;
    }
    state.searchHits = RuleExtractor.search(state.input, keyword);
    renderSearchResults();
    if (!state.searchHits.length) {
        toast('页面里没有找到匹配内容');
    }
}

/* ------------------------------------------------------------------ *
 * Diagnostics
 * ------------------------------------------------------------------ */

function renderDiagnostics() {
    const input = state.input;
    const icon = state.icon || {};
    document.getElementById('diagMd5').textContent = icon.md5 || '—';
    document.getElementById('diagHash').textContent = icon.mmh3 || '—';
    document.getElementById('diagStatus').textContent = input.status || '—';
    document.getElementById('diagServer').textContent = input.server || '—';
    document.getElementById('diagContentType').textContent = (input.contentType || '—').split(';')[0];
    document.getElementById('diagTitle').textContent = input.title || '—';
    document.getElementById('diagTitle').title = input.title || '';

    document.getElementById('diagHeaders').textContent =
        state.headers.map(pair => pair[0] + ': ' + pair[1]).join('\n');
    document.getElementById('diagHeadersCount').textContent = String(state.headers.length);

    const links = extractLinks(state.body);
    document.getElementById('diagLinks').textContent = links.join('\n');
    document.getElementById('diagLinksCount').textContent = String(links.length);

    const jsLinks = extractJsLinks(state.body);
    document.getElementById('diagJsLinks').textContent = jsLinks.join('\n');
    document.getElementById('diagJsCount').textContent = String(jsLinks.length);

    const comments = extractComments(state.body);
    const uniqueComments = Array.from(new Set(comments.htmlComments.concat(comments.cssComments)));
    document.getElementById('diagComments').textContent = uniqueComments.join('\n');
    document.getElementById('diagCommentsCount').textContent = String(uniqueComments.length);

    document.getElementById('fofaDiagHash').disabled = !icon.mmh3;
    document.getElementById('fofaDiagServer').disabled = !input.server;
    document.getElementById('fofaDiagTitle').disabled = !input.title;
}

/* ------------------------------------------------------------------ *
 * History
 * ------------------------------------------------------------------ */

function loadHistory() {
    return new Promise(resolve => {
        chrome.storage.local.get(HISTORY_KEY, stored => {
            const list = stored && Array.isArray(stored[HISTORY_KEY]) ? stored[HISTORY_KEY] : [];
            state.history = list;
            renderHistory();
            resolve(list);
        });
    });
}

function persistHistory() {
    chrome.storage.local.set({ [HISTORY_KEY]: state.history.slice(0, MAX_HISTORY) });
}

function saveHistory(expression, conditions) {
    if (!expression || !state.tab) {
        return;
    }
    const entry = {
        host: currentHost(),
        url: state.tab.url,
        title: state.input ? state.input.title : state.tab.title,
        expression: expression,
        conditions: conditions.map(candidate => ({
            source: candidate.source,
            op: candidate.op,
            value: candidate.value
        })),
        time: Date.now()
    };
    state.history = state.history.filter(item => !(item.host === entry.host && item.expression === entry.expression));
    state.history.unshift(entry);
    state.history = state.history.slice(0, MAX_HISTORY);
    persistHistory();
    if (state.view === 'history') {
        renderHistory();
    }
}

function relativeTime(timestamp) {
    const diff = Date.now() - timestamp;
    const minute = 60000;
    const hour = 3600000;
    const day = 86400000;
    if (diff < minute) {
        return '刚刚';
    }
    if (diff < hour) {
        return Math.floor(diff / minute) + ' 分钟前';
    }
    if (diff < day) {
        return Math.floor(diff / hour) + ' 小时前';
    }
    if (diff < day * 2) {
        return '昨天';
    }
    return Math.floor(diff / day) + ' 天前';
}

function renderHistory() {
    const list = document.getElementById('historyList');
    const empty = document.getElementById('historyEmpty');
    list.textContent = '';

    const query = state.historyQuery.toLowerCase();
    const items = state.history.filter(item =>
        !query || (item.host + ' ' + item.title).toLowerCase().indexOf(query) !== -1);

    if (!items.length) {
        empty.hidden = false;
        return;
    }
    empty.hidden = true;

    items.forEach(item => {
        const row = document.createElement('div');
        row.className = 'hist-row';

        const main = document.createElement('div');
        main.className = 'hist-main';
        const host = document.createElement('div');
        host.className = 'hist-host';
        host.textContent = item.host;
        main.appendChild(host);
        const title = document.createElement('div');
        title.className = 'hist-title';
        title.textContent = item.title || '';
        main.appendChild(title);
        const rule = document.createElement('div');
        rule.className = 'hist-rule';
        rule.textContent = item.expression;
        rule.title = item.expression;
        main.appendChild(rule);
        const meta = document.createElement('div');
        meta.className = 'hist-meta';
        meta.textContent = relativeTime(item.time) + ' · ' + item.conditions.length + ' 条条件';
        main.appendChild(meta);
        row.appendChild(main);

        const actions = document.createElement('div');
        actions.className = 'hist-actions';

        const copy = document.createElement('button');
        copy.textContent = '复制';
        copy.addEventListener('click', () => {
            copyText(item.expression).then(ok => toast(ok ? '规则已复制' : '复制失败'));
        });
        actions.appendChild(copy);

        const reuse = document.createElement('button');
        reuse.textContent = '复用';
        reuse.addEventListener('click', () => reuseHistory(item));
        actions.appendChild(reuse);

        row.appendChild(actions);
        list.appendChild(row);
    });
}

function reuseHistory(entry) {
    if (entry.host !== currentHost()) {
        toast('请先打开 ' + entry.host + ' 再复用');
        return;
    }
    state.selected.clear();
    let matched = 0;
    entry.conditions.forEach(condition => {
        const candidate = state.candidates.find(item =>
            item.source === condition.source && item.value === condition.value);
        if (candidate) {
            state.selected.add(candidate.id);
            matched++;
        }
    });
    state.filter = 'all';
    document.querySelectorAll('.chip[data-filter]').forEach(chip => {
        chip.classList.toggle('active', chip.dataset.filter === 'all');
    });
    setView('rules');
    renderCandidates();
    updateSelection();
    toast(matched ? '已恢复 ' + matched + ' 条条件' : '当前页面没有匹配的条件');
}

/* ------------------------------------------------------------------ *
 * Views
 * ------------------------------------------------------------------ */

function setView(view) {
    state.view = view;
    document.getElementById('view-rules').hidden = view !== 'rules';
    document.getElementById('view-diagnostics').hidden = view !== 'diagnostics';
    document.getElementById('view-history').hidden = view !== 'history';

    document.querySelectorAll('.seg').forEach(button => {
        button.classList.toggle('active', button.dataset.view === view);
    });

    const isRules = view === 'rules';
    document.getElementById('fofaRule').hidden = !isRules;
    document.getElementById('copyExpression').hidden = !isRules;
    document.getElementById('copyFields').hidden = view !== 'diagnostics';
    document.getElementById('clearHistory').hidden = view !== 'history';

    if (!isRules) {
        document.getElementById('footerSummary').textContent = view === 'diagnostics'
            ? '诊断信息不参与规则组合'
            : '共 ' + state.history.length + ' 条记录';
    } else {
        updateSelection();
    }

    if (view === 'history') {
        renderHistory();
    }
}

/* ------------------------------------------------------------------ *
 * Static extraction helpers
 * ------------------------------------------------------------------ */

const jsLinkPatterns = [
    /(https?:[-a-zA-Z0-9（）@:%_\+.~#?&//=]{2,250}[-a-zA-Z0-9（）@:%_\+.~#?&//=]{3}\.js)/g,
    /["'‘“`]\s{0,6}(\/?[-a-zA-Z0-9（）@:%_\+.~#?&//=]{2,250}[-a-zA-Z0-9（）@:%_\+.~#?&//=]{3}\.js)/g,
    /=\s{0,6}["'’”]?\s{0,6}(\/?[-a-zA-Z0-9（）@:%_\+.~#?&//=]{2,250}[-a-zA-Z0-9（）@:%_\+.~#?&//=]{3}\.js)/g
];

function extractJsLinks(htmlContent) {
    const jsLinks = [];
    jsLinkPatterns.forEach(pattern => {
        const matches = htmlContent.match(pattern);
        if (matches) {
            jsLinks.push(...matches);
        }
    });
    if (jsLinks.length === 0) return jsLinks;
    return jsLinks.filter(item => !/(\.|\-)\w{8,20}\.js/.test(item));
}

function extractComments(content) {
    const htmlCommentPattern = /(<!--.*?-->)/g;
    const cssCommentPattern = /(\/\*.*?\*\/)/g;
    const htmlComments = [];
    const cssComments = [];
    let match;
    while ((match = htmlCommentPattern.exec(content)) !== null) {
        htmlComments.push(match[1].trim());
    }
    while ((match = cssCommentPattern.exec(content)) !== null) {
        cssComments.push(match[1].trim());
    }
    return { htmlComments, cssComments };
}

const linkRegex = /(?:"|')(((?:[a-zA-Z]{1,10}:\/\/|\/\/)[^"'/]{1,}\.[a-zA-Z]{2,}[^"']*?)|((?:\/|\.\.\/|\.\.\/)[^"'><,;|*()$^/\\\[\]][^"'<>|()]{1,})|([a-zA-Z0-9_\-\/]{1,}\/[a-zA-Z0-9_\-\/]{1,}\.(?:[a-zA-Z]{1,4}|action)(?:[\?#][^"']*?)?)|([a-zA-Z0-9_\-\/]{1,}\/[a-zA-Z0-9_\-\/]{3,}(?:[\?#][^"']*?)?)|([a-zA-Z0-9_\-]{1,}\.\w+(?:[\?#][^"']*?)?))(?:"|')/g;

function extractLinks(htmlContent) {
    const matches = htmlContent.match(linkRegex);
    return matches ? Array.from(new Set(matches)) : [];
}

/* ------------------------------------------------------------------ *
 * JS body
 * ------------------------------------------------------------------ */

async function collectJsBody(scripts) {
    if (!scripts || !scripts.length) {
        return '';
    }
    const parts = [];
    let total = 0;
    scripts.filter(item => !item.src && item.text).forEach(item => {
        if (total < MAX_JS_BYTES) {
            parts.push(item.text);
            total += item.text.length;
        }
    });
    const urls = scripts.filter(item => item.src).map(item => item.src).slice(0, 12);
    for (let i = 0; i < urls.length; i++) {
        if (total >= MAX_JS_BYTES) {
            break;
        }
        const response = await sendBackground({
            type: 'luckycat:fetch',
            url: urls[i],
            maxBytes: Math.min(1536 * 1024, MAX_JS_BYTES - total)
        }, 15000);
        if (response && response.ok && response.text) {
            parts.push(response.text);
            total += response.text.length;
        }
    }
    return parts.join('\n');
}

async function toggleJs(load) {
    if (!load) {
        if (state.input) {
            state.input.jsBody = '';
        }
        if (state.web) {
            state.web.jsBody = '';
        }
        state.jsLoaded = false;
        toast('已关闭 JS 加载');
        return;
    }
    setStatus('加载 JS…');
    try {
        const body = await collectJsBody(state.snapshot ? state.snapshot.scripts : []);
        if (state.input) {
            state.input.jsBody = body;
        }
        if (state.web) {
            state.web.jsBody = body;
        }
        state.jsLoaded = !!body;
        toast(body ? '已加载 JS ' + Math.round(body.length / 1024) + 'KB' : '没有加载到 JS 内容');
    } finally {
        setStatus('');
    }
}

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

function bindEvents() {
    document.querySelectorAll('.seg').forEach(button => {
        button.addEventListener('click', () => setView(button.dataset.view));
    });

    document.getElementById('refreshBtn').addEventListener('click', runExtraction);

    document.getElementById('featureSearch').addEventListener('input', (event) => {
        state.filterText = event.target.value.trim();
        renderCandidates();
    });
    document.getElementById('featureSearch').addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            runPageSearch();
        }
    });

    document.querySelectorAll('.chip[data-filter]').forEach(chip => {
        chip.addEventListener('click', () => {
            state.filter = chip.dataset.filter;
            document.querySelectorAll('.chip[data-filter]').forEach(item => {
                item.classList.toggle('active', item === chip);
            });
            renderCandidates();
        });
    });

    document.getElementById('selectTop').addEventListener('click', () => {
        const item = state.recommendations[state.recommendIndex % Math.max(1, state.recommendations.length)];
        state.selected.clear();
        if (item) {
            state.selected.add(item.id);
        }
        state.filter = 'all';
        document.querySelectorAll('.chip[data-filter]').forEach(chip => {
            chip.classList.toggle('active', chip.dataset.filter === 'all');
        });
        renderCandidates();
        updateSelection();
    });

    document.getElementById('recCopy').addEventListener('click', copyRecommendation);
    document.getElementById('recNext').addEventListener('click', () => {
        if (state.recommendations.length < 2) {
            return;
        }
        state.recommendIndex = (state.recommendIndex + 1) % state.recommendations.length;
        renderRecommendation();
    });
    document.getElementById('recFofa').addEventListener('click', () => {
        const item = state.recommendations[state.recommendIndex % Math.max(1, state.recommendations.length)];
        if (!item) {
            return;
        }
        const query = RuleExtractor.buildFofaQuery([item]).query;
        if (query) {
            openFofa(query);
        }
    });

    document.getElementById('copyExpression').addEventListener('click', () => {
        const candidates = selectedCandidates();
        const expression = RuleExtractor.buildExpression(candidates);
        if (!expression) {
            return;
        }
        copyText(expression).then(ok => {
            toast(ok ? '规则已复制' : '复制失败');
            if (ok) {
                saveHistory(expression, candidates);
            }
        });
    });

    document.getElementById('fofaRule').addEventListener('click', () => {
        const query = RuleExtractor.buildFofaQuery(selectedCandidates()).query;
        if (query) {
            openFofa(query);
        }
    });

    document.getElementById('addCustom').addEventListener('click', () => {
        const source = document.getElementById('customSource').value;
        const op = parseInt(document.getElementById('customOp').value, 10);
        const raw = document.getElementById('customValue').value.trim();
        const message = document.getElementById('customMessage');
        if (!raw) {
            message.textContent = '请输入匹配值';
            return;
        }
        const clause = RuleDsl.conditionText(source, op, raw);
        if (!clause) {
            message.textContent = '无法生成条件：值不能以反斜杠结尾';
            return;
        }
        const value = RuleDsl.NUMERIC_KEYS.has(source) ? raw : raw.toLowerCase();
        addCandidate({
            id: 'custom|' + op + '|' + value,
            source: source,
            op: op,
            value: value,
            label: '自定义',
            group: 'custom',
            scope: 'unknown',
            product: '',
            coverage: '',
            recommended: false,
            score: 60,
            stability: 'unknown',
            count: 0,
            version: null,
            context: clause,
            note: '手动添加',
            rawValue: raw
        });
        message.textContent = '已添加：' + clause;
        document.getElementById('customValue').value = '';
    });

    const jumpFofa = (query) => {
        if (query) {
            openFofa(query);
        }
    };
    document.getElementById('fofaDiagHash').addEventListener('click', () => {
        jumpFofa('icon_hash="' + (state.icon ? state.icon.mmh3 : '') + '"');
    });
    document.getElementById('fofaDiagServer').addEventListener('click', () => {
        jumpFofa('server="' + (state.input ? state.input.server : '') + '"');
    });
    document.getElementById('fofaDiagTitle').addEventListener('click', () => {
        jumpFofa('title="' + (state.input ? state.input.title : '') + '"');
    });

    document.getElementById('loadJs').addEventListener('change', (event) => {
        toggleJs(event.target.checked);
    });

    document.getElementById('copyFields').addEventListener('click', () => {
        if (!state.input) {
            return;
        }
        const lines = [
            'host: ' + currentHost(),
            'title: ' + state.input.title,
            'status: ' + state.input.status,
            'server: ' + state.input.server,
            'content_type: ' + state.input.contentType,
            'icon_md5: ' + (state.icon ? state.icon.md5 : ''),
            'icon_hash: ' + (state.icon ? state.icon.mmh3 : '')
        ];
        copyText(lines.join('\n')).then(ok => toast(ok ? '字段已复制' : '复制失败'));
    });

    document.getElementById('historySearch').addEventListener('input', (event) => {
        state.historyQuery = event.target.value.trim();
        renderHistory();
    });

    document.getElementById('clearHistory').addEventListener('click', () => {
        state.history = [];
        chrome.storage.local.remove(HISTORY_KEY);
        renderHistory();
        document.getElementById('footerSummary').textContent = '共 0 条记录';
        toast('历史已清空');
    });
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

async function init() {
    state.tab = await getActiveTab();
    if (!state.tab) {
        document.getElementById('siteHost').textContent = '没有活动标签页';
        document.getElementById('candidateList').textContent = '';
        return;
    }

    bindEvents();
    await loadHistory();

    try {
        const url = new URL(state.tab.url);
        document.getElementById('siteHost').textContent = url.host;
    } catch (err) {
        document.getElementById('siteHost').textContent = '—';
    }
    document.getElementById('pageTitle').textContent = state.tab.title || '';

    if (!/^https?:/i.test(state.tab.url || '')) {
        setStatus('不支持');
        const list = document.getElementById('candidateList');
        list.textContent = '';
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = '当前页面不支持规则提取（仅支持 http/https）';
        list.appendChild(empty);
        document.getElementById('recommendCard').hidden = true;
        document.getElementById('noRecommend').hidden = true;
        return;
    }

    await runExtraction();
}

document.addEventListener('DOMContentLoaded', init);
