/*
 * Static fixture server for manual end-to-end testing of the extension.
 * It sets response headers that several fingerprint rules depend on.
 *
 *   node tests/fixture-server.js [port]
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const port = parseInt(process.argv[2] || '8899', 10);
const root = path.join(__dirname, '..');

const page = fs.readFileSync(path.join(__dirname, 'fixtures', 'page.html'));
const favicon = fs.readFileSync(path.join(root, 'assets', 'images', 'icon32.png'));
const appJs = 'window.LuckyCatFixture = { ready: true };';

const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1:' + port);
    if (url.pathname === '/favicon.ico') {
        res.writeHead(200, {
            'Content-Type': 'image/png',
            'Cache-Control': 'no-cache',
            'Server': 'nginx/1.24.0',
            'Set-Cookie': 'safedog-flow-item=abc123; Path=/; HttpOnly'
        });
        res.end(favicon);
        return;
    }
    if (url.pathname === '/static/js/app.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript', 'Server': 'nginx/1.24.0' });
        res.end(appJs);
        return;
    }
    res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Server': 'nginx/1.24.0',
        'X-Powered-By': 'PHP/7.4.33',
        'Set-Cookie': 'safedog-flow-item=abc123; Path=/; HttpOnly'
    });
    res.end(page);
});

server.listen(port, '127.0.0.1', () => {
    console.log('fixture server listening on http://127.0.0.1:' + port + '/page.html');
});
