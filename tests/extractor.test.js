const assert = require('assert');
const Extractor = require('../libs/rule-extractor.js');
const DSL = require('../libs/rule-dsl.js');

let failures = 0;
function ok(name, fn) {
    try {
        fn();
        console.log('  ok  ', name);
    } catch (err) {
        failures++;
        console.error('  FAIL', name, '-', err.message);
    }
}

const rawHtml = `<!DOCTYPE html>
<html>
<head>
<title>后台登录 - 测试系统</title>
<meta name="generator" content="WordPress 6.4.2">
<link rel="stylesheet" href="/static/js/app.css">
</head>
<body>
<!--STATUS OK-->
<p>安全狗</p>
<a href="/wp-content/plugins/optinmonster/app.js">x</a>
<a href="/static/js/app.js">y</a>
<a href="/api/user/info">z</a>
<span>京ICP备12345678号-1</span>
<p>© 2024 某某科技有限公司</p>
<script>window.__APP_CONFIG__ = { env: "prod" };</script>
</body>
</html>`;

const headers = [
    ['Server', 'nginx/1.24.0'],
    ['X-Powered-By', 'PHP/7.4.33'],
    ['Set-Cookie', 'safedog-flow-item=abc123; Path=/; HttpOnly'],
    ['Date', 'Thu, 22 Oct 2026 08:31:00 GMT'],
    ['ETag', '"9b2f-abcdef123456"'],
    ['Content-Type', 'text/html; charset=utf-8']
];

const input = {
    url: 'http://127.0.0.1:8899/page.html',
    protocol: 'http',
    port: 8899,
    path: '/page.html',
    title: '后台登录 - 测试系统',
    status: 200,
    server: 'nginx/1.24.0',
    contentType: 'text/html; charset=utf-8',
    headers: headers,
    headerText: headers.map(pair => pair[0] + ': ' + pair[1]).join('\n'),
    rawHtml: rawHtml,
    domHtml: rawHtml,
    body: rawHtml,
    jsBody: '',
    metas: { generator: 'WordPress 6.4.2', renderer: 'webkit', 'x-ua-compatible': 'ie=edge' },
    iconHash: '-312450918',
    iconMd5: '29c4ea79f74a183267b8064a7d61f821'
};

const result = Extractor.extract(input);
const candidates = result.candidates;
const find = (source, valuePart) => candidates.find(candidate =>
    candidate.source === source && candidate.value.indexOf(valuePart) !== -1);

console.log('  ..  extracted', candidates.length, 'candidates');

ok('icon hash and md5 are suggested', () => {
    assert.ok(find('icon_hash', '-312450918'));
    assert.ok(find('icon_md5', '29c4ea79'));
});
ok('server header candidate', () => {
    const candidate = find('header', 'server: nginx/1.24.0');
    assert.ok(candidate);
    assert.strictEqual(candidate.stability, 'stable');
});
ok('set-cookie keeps the name only', () => {
    const candidate = find('header', 'set-cookie: safedog-flow-item=');
    assert.ok(candidate);
    assert.ok(candidate.value.indexOf('abc123') === -1);
});
ok('volatile headers are dropped', () => {
    assert.ok(!candidates.some(candidate => candidate.value.indexOf('date: ') === 0));
    assert.ok(!candidates.some(candidate => candidate.value.indexOf('etag: ') === 0));
});
ok('meta generator reports the adjacent version', () => {
    const candidate = find('body', 'wordpress 6.4.2');
    assert.ok(candidate);
    assert.strictEqual(candidate.version, '6.4.2');
});
ok('ICP number is suggested', () => {
    assert.ok(find('body', '京icp备12345678号-1'));
});
ok('browser rendering meta tags are skipped', () => {
    assert.ok(!candidates.some(candidate => candidate.label === 'meta renderer'));
    assert.ok(!candidates.some(candidate => candidate.label === 'meta x-ua-compatible'));
});
ok('distinctive path is kept, generic path is dropped', () => {
    assert.ok(find('body', '/wp-content/plugins/optinmonster/app.js'));
    assert.ok(!find('body', '/static/js/app.js'));
});
ok('HTML comment is suggested', () => {
    assert.ok(find('body', '<!--status ok-->'));
});
ok('inline global is suggested', () => {
    assert.ok(find('body', 'window.__app_config__'));
});
ok('copyright is suggested', () => {
    assert.ok(candidates.some(candidate => /© 2024/.test(candidate.value)));
});
ok('dynamic values are detected', () => {
    assert.strictEqual(Extractor.isDynamicValue('abcdef1234567890'), true);
    assert.strictEqual(Extractor.isDynamicValue('2026-10-22T08:31:00Z'), false);
    assert.strictEqual(Extractor.isDynamicValue('nginx/1.24.0'), false);
    assert.strictEqual(Extractor.isDynamicValue('csrf_token=abc'), true);
});
ok('search finds a page feature', () => {
    const hits = Extractor.search(input, '安全狗');
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].source, 'body');
    assert.strictEqual(hits[0].count, 1);
});
ok('expression is built from selected candidates', () => {
    const selected = [
        find('body', '/wp-content/plugins/optinmonster/app.js'),
        find('header', 'server: nginx/1.24.0')
    ];
    const expression = Extractor.buildExpression(selected);
    assert.deepStrictEqual(expression,
        'body="/wp-content/plugins/optinmonster/app.js" && header="server: nginx/1.24.0"');
    const parsed = DSL.compileExpression(expression);
    assert.strictEqual(parsed.error, null);
});
ok('product markers are scoped as product', () => {
    const marker = candidates.find(candidate => candidate.source === 'body' && candidate.value === 'wp-content');
    assert.ok(marker);
    assert.strictEqual(marker.scope, 'product');
    assert.strictEqual(marker.coverage, 'broad');
});
ok('deployment values are scoped as deployment', () => {
    const icp = candidates.find(candidate => candidate.value.indexOf('京icp') !== -1);
    assert.strictEqual(icp.scope, 'deployment');
    const icon = candidates.find(candidate => candidate.source === 'icon_hash');
    assert.strictEqual(icon.scope, 'deployment');
});
ok('tech stack headers are generic', () => {
    const server = candidates.find(candidate => candidate.value === 'server: nginx/1.24.0');
    assert.strictEqual(server.scope, 'generic');
});
ok('only one product-level condition is recommended', () => {
    const recommended = candidates.filter(candidate => candidate.recommended);
    assert.strictEqual(recommended.length, 1);
    assert.strictEqual(recommended[0].scope, 'product');
    assert.strictEqual(recommended[0].coverage, 'broad');
    assert.strictEqual(candidates[0], recommended[0]);
});
ok('FOFA query maps supported conditions and skips others', () => {
    const body = candidates.find(candidate => candidate.value === 'wp-content');
    const icon = candidates.find(candidate => candidate.source === 'icon_hash');
    const contentType = candidates.find(candidate => candidate.source === 'content_type');
    const query = Extractor.buildFofaQuery([body, icon, contentType]);
    assert.strictEqual(query.query, 'body="wp-content" && icon_hash="-312450918"');
    assert.strictEqual(query.skipped.length, 1);
});
ok('FOFA query escapes quotes', () => {
    const query = Extractor.buildFofaQuery([{ source: 'body', op: 0, value: 'a"b' }]);
    assert.strictEqual(query.query, 'body="a\\"b"');
});
ok('dynamic candidates are ranked lower', () => {
    const dynamic = candidates.find(candidate => candidate.stability === 'dynamic');
    const stable = candidates.find(candidate => candidate.stability === 'stable' && candidate.score >= 60);
    assert.ok(stable);
    if (dynamic) {
        assert.ok(dynamic.score < stable.score);
    }
});

if (failures) {
    console.error(failures + ' test(s) failed');
    process.exit(1);
}
console.log('rule extractor: all checks passed');
