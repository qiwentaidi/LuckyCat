/*
 * UI harness test: runs the popup as a file:// page with a stubbed chrome API
 * (tests/harness.html), checks the new information architecture and writes a
 * screenshot. No extension runtime or network access required.
 *
 *   node tests/ui-harness.js [chromePort]
 */
const fs = require('fs');
const path = require('path');

require('./make-harness.js');

const chromePort = process.argv[2] || '9333';
const base = 'http://127.0.0.1:' + chromePort;
const harnessUrl = 'file://' + path.join(__dirname, 'harness.html') + '?tabId=1';
const artifacts = path.join(__dirname, 'artifacts');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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
                (this.events.get(message.method) || []).forEach(handler => handler(message.params));
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

    const tab = await newTab('about:blank');
    const page = new CDP(tab.webSocketDebuggerUrl);
    await page.send('Page.enable');
    await page.send('Runtime.enable');

    const consoleErrors = [];
    page.on('Runtime.consoleAPICalled', params => {
        if (params.type === 'error') {
            consoleErrors.push(params.args.map(arg => arg.value || arg.description).join(' '));
        }
    });
    page.on('Runtime.exceptionThrown', params => {
        consoleErrors.push('exception: ' + (params.exceptionDetails.exception && params.exceptionDetails.exception.description));
    });

    await page.send('Page.navigate', { url: harnessUrl });
    await sleep(800);

    let count = '0';
    for (let i = 0; i < 40; i++) {
        count = await page.evaluate("(document.getElementById('candidateCount') || {}).textContent || '0'");
        if (count !== '0') {
            break;
        }
        await sleep(200);
    }

    const initial = await page.evaluate(`(() => {
        const text = id => ((document.getElementById(id) || {}).textContent || '').trim();
        return {
            count: text('candidateCount'),
            siteHost: text('siteHost'),
            status: text('statusText'),
            recommendVisible: !document.getElementById('recommendCard').hidden,
            recRule: text('recRule'),
            recScope: text('recScope'),
            recValidation: text('recValidation')
        };
    })()`);
    console.log('initial:', JSON.stringify(initial, null, 1));

    if (Number(initial.count) <= 0) {
        console.error('FAIL: no candidates extracted');
        process.exitCode = 1;
    }
    if (!initial.recommendVisible || initial.recRule.indexOf('&&') !== -1) {
        console.error('FAIL: recommendation should be a single condition');
        process.exitCode = 1;
    }
    if (initial.recScope.indexOf('产品级') === -1) {
        console.error('FAIL: recommendation is not product-level');
        process.exitCode = 1;
    }

    await page.evaluate(`document.getElementById('selectTop').click()`);
    await sleep(200);
    const single = await page.evaluate(`(() => {
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
    if (single.rule.indexOf('&&') !== -1 || single.hint.indexOf('产品级') === -1) {
        console.error('FAIL: single product recommendation state is wrong');
        process.exitCode = 1;
    }
    if (single.copyDisabled || single.fofaDisabled) {
        console.error('FAIL: footer actions should be enabled');
        process.exitCode = 1;
    }

    await page.evaluate(`(() => {
        const wanted = ['set-cookie: safedog-flow-item=', 'server: nginx/1.24.0'];
        document.querySelectorAll('.cand').forEach(item => {
            const clause = (item.querySelector('.cand-clause') || {}).textContent || '';
            if (wanted.some(text => clause.toLowerCase().indexOf(text) !== -1)) {
                const box = item.querySelector('input[type=checkbox]');
                if (box && !box.checked) { box.click(); }
            }
        });
    })()`);
    await sleep(200);
    const combined = await page.evaluate(`(() => ({
        rule: document.getElementById('selectionRule').textContent.trim(),
        hint: (document.getElementById('ruleHint') || {}).textContent || ''
    }))()`);
    console.log('combined:', JSON.stringify(combined, null, 1));
    if (combined.rule.indexOf('&&') === -1 || combined.hint.indexOf('收窄') === -1) {
        console.error('FAIL: multi-condition warning missing');
        process.exitCode = 1;
    }

    await page.evaluate(`document.querySelector('.seg[data-view="diagnostics"]').click()`);
    await sleep(150);
    const diagnostics = await page.evaluate(`(() => ({
        visible: !document.getElementById('view-diagnostics').hidden,
        server: (document.getElementById('diagServer') || {}).textContent || '',
        headers: (document.getElementById('diagHeadersCount') || {}).textContent || '',
        fofa: ['fofaDiagHash', 'fofaDiagServer', 'fofaDiagTitle'].every(id => !!document.getElementById(id))
    }))()`);
    console.log('diagnostics:', JSON.stringify(diagnostics));
    if (!diagnostics.visible || diagnostics.server.indexOf('nginx') === -1 || !diagnostics.fofa) {
        console.error('FAIL: diagnostics view is incomplete');
        process.exitCode = 1;
    }

    await page.evaluate(`document.querySelector('.seg[data-view="history"]').click()`);
    await sleep(150);
    const history = await page.evaluate(`(() => ({
        visible: !document.getElementById('view-history').hidden,
        empty: !document.getElementById('historyEmpty').hidden,
        clearVisible: !document.getElementById('clearHistory').hidden
    }))()`);
    console.log('history:', JSON.stringify(history));
    if (!history.visible || !history.clearVisible) {
        console.error('FAIL: history view is incomplete');
        process.exitCode = 1;
    }

    await page.evaluate(`document.querySelector('.seg[data-view="rules"]').click()`);
    await sleep(150);
    await page.evaluate(`document.getElementById('selectTop').click()`);
    await sleep(200);

    // Long candidate values must ellipsize inside the 600px popup instead of
    // widening the row (the flex min-width:auto trap).
    const layout = await page.evaluate(`(() => {
        const list = document.querySelector('.cand-list');
        const rows = Array.from(document.querySelectorAll('.cand'));
        return {
            listOverflow: list.scrollWidth - list.clientWidth,
            bodyWidth: document.body.scrollWidth,
            rowOverflow: rows.some(row => row.getBoundingClientRect().right > 600.5),
            longRow: rows.map(row => {
                const clause = row.querySelector('.cand-clause');
                return { scroll: clause.scrollWidth, client: clause.clientWidth };
            }).filter(item => item.scroll > item.client)
        };
    })()`);
    console.log('layout:', JSON.stringify(layout));
    if (layout.listOverflow > 1 || layout.bodyWidth > 600 || layout.rowOverflow) {
        console.error('FAIL: candidate rows overflow the popup');
        process.exitCode = 1;
    }
    if (!layout.longRow.length) {
        console.error('FAIL: harness fixture should include a long value to test ellipsis');
        process.exitCode = 1;
    }

    if (consoleErrors.length) {
        console.error('console errors:', consoleErrors);
        process.exitCode = 1;
    }

    await page.send('Emulation.setDeviceMetricsOverride', {
        width: 620,
        height: 620,
        deviceScaleFactor: 2,
        mobile: false
    });
    const shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(path.join(artifacts, 'popup.png'), Buffer.from(shot.data, 'base64'));
    console.log('screenshot:', path.join(artifacts, 'popup.png'));

    page.close();
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
