/*
 * End-to-end check of the rule extraction popup against a real Chrome
 * instance with the unpacked extension loaded.
 *
 * Prerequisites (started separately):
 *   node tests/fixture-server.js 8899
 *   Google Chrome for Testing --load-extension=. --remote-debugging-port=9333 ...
 *
 *   node tests/e2e-popup.js [chromePort] [fixtureUrl]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const chromePort = process.argv[2] || '9333';
const fixtureUrl = process.argv[3] || 'http://127.0.0.1:8899/page.html';
const base = 'http://127.0.0.1:' + chromePort;
const artifacts = path.join(__dirname, 'artifacts');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function jsonList() {
    const response = await fetch(base + '/json/list');
    return response.json();
}

async function waitForChrome() {
    for (let i = 0; i < 60; i++) {
        try {
            const response = await fetch(base + '/json/version');
            if (response.ok) {
                return;
            }
        } catch (err) {
            // not up yet
        }
        await sleep(250);
    }
    throw new Error('Chrome debugging port did not open');
}

class CDP {
    constructor(url) {
        this.nextId = 1;
        this.pending = new Map();
        this.events = new Map();
        this.socket = new WebSocket(url);
        this.ready = new Promise((resolve, reject) => {
            this.socket.addEventListener('open', () => resolve());
            this.socket.addEventListener('error', () => reject(new Error('websocket error')));
        });
        this.socket.addEventListener('message', (event) => {
            let message;
            try {
                message = JSON.parse(event.data);
            } catch (err) {
                return;
            }
            if (message.id && this.pending.has(message.id)) {
                const entry = this.pending.get(message.id);
                this.pending.delete(message.id);
                if (message.error) {
                    entry.reject(new Error(message.error.message));
                } else {
                    entry.resolve(message.result);
                }
                return;
            }
            if (message.method) {
                const handlers = this.events.get(message.method) || [];
                handlers.forEach(handler => handler(message.params));
            }
        });
    }

    on(method, handler) {
        if (!this.events.has(method)) {
            this.events.set(method, []);
        }
        this.events.get(method).push(handler);
    }

    async send(method, params) {
        await this.ready;
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve: resolve, reject: reject });
            this.socket.send(JSON.stringify({ id: id, method: method, params: params || {} }));
        });
    }

    async evaluate(expression, awaitPromise) {
        const result = await this.send('Runtime.evaluate', {
            expression: expression,
            awaitPromise: !!awaitPromise,
            returnByValue: true,
            userGesture: true
        });
        if (result.exceptionDetails) {
            const detail = result.exceptionDetails;
            throw new Error('evaluate failed: ' + (detail.exception && detail.exception.description || detail.text));
        }
        return result.result ? result.result.value : undefined;
    }

    close() {
        this.socket.close();
    }
}

async function newTab(url) {
    let response = await fetch(base + '/json/new?' + encodeURIComponent(url), { method: 'PUT' });
    if (!response.ok) {
        response = await fetch(base + '/json/new?' + encodeURIComponent(url));
    }
    if (!response.ok) {
        throw new Error('cannot open tab: ' + response.status);
    }
    return response.json();
}

async function main() {
    fs.mkdirSync(artifacts, { recursive: true });
    await waitForChrome();

    // The MV3 service worker may already be dormant, so derive the unpacked
    // extension id from its absolute path (Chrome's sha256 -> a-p encoding).
    const extensionRoot = path.resolve(__dirname, '..');
    const digest = crypto.createHash('sha256').update(extensionRoot).digest('hex').slice(0, 32);
    const extensionId = digest.split('').map(ch => String.fromCharCode(97 + parseInt(ch, 16))).join('');
    console.log('extension id:', extensionId);

    // Create the tab blank and navigate with Page.navigate: opening a tab
    // directly with /json/new?url=... can stay in a pending state in headless
    // Chrome.
    console.log('creating fixture tab…');
    const fixture = await newTab('about:blank');
    const fixturePage = new CDP(fixture.webSocketDebuggerUrl);
    await fixturePage.send('Page.enable');
    await fixturePage.send('Page.navigate', { url: fixtureUrl });
    for (let i = 0; i < 40; i++) {
        const state = await fixturePage.evaluate('({ href: location.href, ready: document.readyState })');
        if (state && state.href === fixtureUrl && state.ready === 'complete') {
            break;
        }
        await sleep(250);
    }
    await sleep(500);

    console.log('opening popup tab…');
    const popup = await newTab('chrome-extension://' + extensionId + '/popup.html');
    const popupPage = new CDP(popup.webSocketDebuggerUrl);
    await popupPage.send('Runtime.enable');
    await popupPage.send('Page.enable');

    const consoleErrors = [];
    popupPage.on('Runtime.consoleAPICalled', params => {
        if (params.type === 'error') {
            consoleErrors.push(params.args.map(arg => arg.value || arg.description).join(' '));
        }
    });
    popupPage.on('Runtime.exceptionThrown', params => {
        consoleErrors.push('exception: ' + (params.exceptionDetails.exception && params.exceptionDetails.exception.description));
    });

    const fixtureHost = new URL(fixtureUrl).host;
    let target = null;
    let tabs = [];
    for (let i = 0; i < 40 && !target; i++) {
        tabs = await popupPage.evaluate(
            'new Promise(resolve => chrome.tabs.query({}, tabs => resolve(tabs.map(t => ({ id: t.id, url: t.url })))))',
            true
        );
        target = tabs.find(item => item.url && item.url.indexOf(fixtureHost) !== -1);
        if (!target) {
            await sleep(250);
        }
    }
    if (!target) {
        console.error('fixture tab not visible to the extension:', tabs);
        process.exit(1);
    }
    console.log('fixture tab id:', target.id);

    console.log('navigating popup to tab', target.id, '…');
    await popupPage.send('Page.navigate', {
        url: 'chrome-extension://' + extensionId + '/popup.html?tabId=' + target.id
    });
    await sleep(1000);
    console.log('waiting for extraction…');

    let count = '0';
    for (let i = 0; i < 80; i++) {
        count = await popupPage.evaluate("(document.getElementById('candidateCount') || {}).textContent || '0'");
        if (count !== '0') {
            break;
        }
        await sleep(250);
    }

    const initial = await popupPage.evaluate(`(() => {
        const text = id => ((document.getElementById(id) || {}).textContent || '').trim();
        const recommended = document.getElementById('recommendCard');
        return {
            count: text('candidateCount'),
            siteHost: text('siteHost'),
            pageTitle: text('pageTitle'),
            status: text('statusText'),
            statusVisible: !document.getElementById('statusPill').hidden,
            recommendVisible: !recommended.hidden,
            recRule: text('recRule'),
            recScope: text('recScope'),
            recReason: text('recReason'),
            recValidation: text('recValidation'),
            fofaDisabled: document.getElementById('recFofa').disabled
        };
    })()`);
    console.log('initial:', JSON.stringify(initial, null, 1));
    if (!initial.recommendVisible) {
        console.error('FAIL: recommendation card is hidden');
        process.exitCode = 1;
    }
    if (initial.recScope.indexOf('产品级') === -1) {
        console.error('FAIL: recommendation is not product-level:', initial.recScope);
        process.exitCode = 1;
    }
    if (initial.recRule.indexOf('&&') !== -1) {
        console.error('FAIL: recommendation must be a single condition:', initial.recRule);
        process.exitCode = 1;
    }
    if (initial.fofaDisabled) {
        console.error('FAIL: recommendation FOFA button disabled');
        process.exitCode = 1;
    }
    if (initial.siteHost.indexOf(fixtureHost) === -1) {
        console.error('FAIL: site bar host mismatch:', initial.siteHost);
        process.exitCode = 1;
    }

    await popupPage.evaluate(`document.getElementById('selectTop').click()`);
    await sleep(250);
    const single = await popupPage.evaluate(`(() => {
        const text = id => ((document.getElementById(id) || {}).textContent || '').trim();
        return {
            rule: document.getElementById('selectionRule').textContent.trim(),
            hint: text('ruleHint'),
            footer: text('footerSummary'),
            copyDisabled: document.getElementById('copyExpression').disabled,
            fofaDisabled: document.getElementById('fofaRule').disabled
        };
    })()`);
    console.log('single:', JSON.stringify(single, null, 1));
    if (single.rule.indexOf('&&') !== -1) {
        console.error('FAIL: "选推荐条件" should select one condition:', single.rule);
        process.exitCode = 1;
    }
    if (single.hint.indexOf('产品级') === -1) {
        console.error('FAIL: hint should explain product scope:', single.hint);
        process.exitCode = 1;
    }
    if (single.footer.indexOf('1') === -1) {
        console.error('FAIL: footer summary should show one selection:', single.footer);
        process.exitCode = 1;
    }
    if (single.copyDisabled || single.fofaDisabled) {
        console.error('FAIL: footer actions should be enabled');
        process.exitCode = 1;
    }

    // Add deployment-level conditions manually to trigger the narrowing warning.
    await popupPage.evaluate(`(() => {
        const wanted = ['set-cookie: safedog-flow-item=', 'server: nginx/1.24.0'];
        document.querySelectorAll('.cand').forEach(item => {
            const clause = (item.querySelector('.cand-clause') || {}).textContent || '';
            if (wanted.some(text => clause.toLowerCase().indexOf(text) !== -1)) {
                const box = item.querySelector('input[type=checkbox]');
                if (box && !box.checked) { box.click(); }
            }
        });
        return true;
    })()`);
    await sleep(250);
    const combined = await popupPage.evaluate(`(() => ({
        rule: document.getElementById('selectionRule').textContent.trim(),
        hint: (document.getElementById('ruleHint') || {}).textContent || ''
    }))()`);
    console.log('combined:', JSON.stringify(combined, null, 1));
    if (combined.rule.indexOf('&&') === -1) {
        console.error('FAIL: expected combined rule');
        process.exitCode = 1;
    }
    if (combined.hint.indexOf('收窄') === -1) {
        console.error('FAIL: combined selection should warn about narrowing:', combined.hint);
        process.exitCode = 1;
    }

    // Diagnostics tab
    await popupPage.evaluate(`document.querySelector('.seg[data-view="diagnostics"]').click()`);
    await sleep(200);
    const diagnostics = await popupPage.evaluate(`(() => ({
        visible: !document.getElementById('view-diagnostics').hidden,
        server: (document.getElementById('diagServer') || {}).textContent || '',
        hash: (document.getElementById('diagHash') || {}).textContent || '',
        headersCount: (document.getElementById('diagHeadersCount') || {}).textContent || '',
        fofaButtons: ['fofaDiagHash', 'fofaDiagServer', 'fofaDiagTitle'].every(id => !!document.getElementById(id))
    }))()`);
    console.log('diagnostics:', JSON.stringify(diagnostics));
    if (!diagnostics.visible || diagnostics.server.indexOf('nginx') === -1 || !diagnostics.fofaButtons) {
        console.error('FAIL: diagnostics view incomplete');
        process.exitCode = 1;
    }

    // History tab: copying is best-effort in headless, so accept either state.
    await popupPage.evaluate(`document.querySelector('.seg[data-view="history"]').click()`);
    await sleep(200);
    const history = await popupPage.evaluate(`(() => ({
        visible: !document.getElementById('view-history').hidden,
        emptyVisible: !document.getElementById('historyEmpty').hidden,
        rows: document.querySelectorAll('.hist-row').length,
        clearVisible: !document.getElementById('clearHistory').hidden
    }))()`);
    console.log('history:', JSON.stringify(history));
    if (!history.visible) {
        console.error('FAIL: history view not visible');
        process.exitCode = 1;
    }

    // Back to rules, leave the default single-condition state for the screenshot.
    await popupPage.evaluate(`document.querySelector('.seg[data-view="rules"]').click()`);
    await sleep(150);
    await popupPage.evaluate(`document.getElementById('selectTop').click()`);
    await sleep(200);

    if (consoleErrors.length) {
        console.log('console errors:', consoleErrors);
        process.exitCode = 1;
    }

    await popupPage.send('Emulation.setDeviceMetricsOverride', {
        width: 620,
        height: 620,
        deviceScaleFactor: 2,
        mobile: false
    });
    const shot = await popupPage.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(path.join(artifacts, 'popup.png'), Buffer.from(shot.data, 'base64'));
    console.log('screenshot:', path.join(artifacts, 'popup.png'));

    popupPage.close();
    fixturePage.close();
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
