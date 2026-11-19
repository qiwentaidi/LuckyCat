/*
 * Builds tests/harness.html from popup.html plus the fixture page.
 *
 *   node tests/make-harness.js
 *
 * The harness lets the popup run as a plain file:// page (chrome API stubbed),
 * which keeps UI checks independent of Chrome networking.
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const popup = fs.readFileSync(path.join(root, 'popup.html'), 'utf8');
const fixtureHtml = fs.readFileSync(path.join(__dirname, 'fixtures', 'page.html'), 'utf8');

const testPage = {
    url: 'http://127.0.0.1:8899/page.html',
    title: '后台登录 - Monsta FTP',
    status: 200,
    headers: [
        ['Content-Type', 'text/html; charset=utf-8'],
        ['Server', 'nginx/1.24.0'],
        ['X-Powered-By', 'PHP/7.4.33'],
        ['Set-Cookie', 'safedog-flow-item=abc123; Path=/; HttpOnly']
    ],
    // A long path keeps the ellipsis / no-horizontal-overflow case covered.
    html: fixtureHtml + '<a href="/very-long-section-' + 'x'.repeat(90) + '/assets/app.js">long</a>',
    metas: { generator: 'WordPress 6.4.2' },
    scripts: [
        { src: 'http://127.0.0.1:8899/static/js/app.js', text: '' },
        { src: '', text: 'window.__APP_CONFIG__ = { env: "prod" };' }
    ]
};

let html = popup
    .replace(/href="\.\/css\//g, 'href="../css/')
    .replace(/src="\.\/libs\//g, 'src="../libs/')
    .replace(/src="popup\.js"/g, 'src="../popup.js"')
    .replace(/url\('\.\/assets\//g, "url('../assets/")
    .replace('<script src="../popup.js"></script>',
        '<script>window.__TEST_PAGE__ = ' + JSON.stringify(testPage).replace(/<\//g, '<\\/') + ';</script>\n' +
        '    <script src="./harness/stub.js"></script>\n' +
        '    <script src="../popup.js"></script>');

html = html.replace('<title>Lucky Cat</title>', '<title>Lucky Cat · UI harness</title>');

fs.writeFileSync(path.join(__dirname, 'harness.html'), html);
console.log('wrote tests/harness.html');
