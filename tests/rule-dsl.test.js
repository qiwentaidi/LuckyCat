const assert = require('assert');
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

const web = {
    protocol: 'https',
    port: 443,
    path: '/admin',
    title: '后台登录 - Monsta FTP',
    status: 200,
    iconHash: '-394495807',
    iconMd5: 'abc123',
    body: 'hello <b>world</b> powered by nginx <!--status ok-->',
    jsBody: 'window.__app__ = 1',
    header: 'http/1.1 200 ok\nserver: nginx\nset-cookie: safedog-flow-item=',
    contentType: 'text/html; charset=utf-8',
    server: 'nginx',
    bodyLength: 52,
    banner: '',
    cert: ''
};

function test(expression) {
    return DSL.test(expression, web);
}

ok('contains is case insensitive', () => {
    assert.strictEqual(test('body="HELLO"').matched, true);
    assert.strictEqual(test('body="apache"').matched, false);
});
ok('not contains', () => {
    assert.strictEqual(test('body!="apache"').matched, true);
    assert.strictEqual(test('body!="world"').matched, false);
});
ok('exact equality', () => {
    assert.strictEqual(test('server=="nginx"').matched, true);
    assert.strictEqual(test('server=="nginx/1.2"').matched, false);
});
ok('numeric comparisons', () => {
    assert.strictEqual(test('status="200"').matched, true);
    assert.strictEqual(test('status>=200').matched, true);
    assert.strictEqual(test('status>=201').matched, false);
    assert.strictEqual(test('len(body) == 52').matched, true);
});
ok('icon hash', () => {
    assert.strictEqual(test('icon_hash="-394495807"').matched, true);
});
ok('regex with inline flag', () => {
    assert.strictEqual(test('body~="(?i)POWERED BY (NGINX|APACHE)"').matched, true);
});
ok('boolean precedence', () => {
    assert.strictEqual(test('body="hello" && body="world"').matched, true);
    assert.strictEqual(test('body="nope" || body="hello"').matched, true);
    assert.strictEqual(test('(body="nope" || body="hello") && server="nginx"').matched, true);
    assert.strictEqual(test('!(body="apache")').matched, true);
});
ok('header and title fields', () => {
    assert.strictEqual(test('header="safedog-flow-item="').matched, true);
    assert.strictEqual(test('title="monsta ftp"').matched, true);
    assert.strictEqual(test('content_type="text/html"').matched, true);
    assert.strictEqual(test('path="/admin"').matched, true);
});
ok('invalid expressions are rejected', () => {
    assert.strictEqual(test('body="x" &&').ok, false);
    assert.strictEqual(test('body=').ok, false);
    assert.strictEqual(test('just words').ok, false);
});
ok('condition text escapes quotes', () => {
    assert.strictEqual(DSL.conditionText('body', DSL.OP.CONTAINS, 'a"b'), 'body="a\\"b"');
    assert.strictEqual(DSL.conditionText('status', DSL.OP.EQUAL, '200'), 'status=="200"');
    assert.strictEqual(DSL.conditionText('body', DSL.OP.NOT_CONTAINS, 'x'), 'body!="x"');
});
ok('trailing backslash cannot be represented', () => {
    assert.strictEqual(DSL.conditionText('body', DSL.OP.CONTAINS, 'c:\\'), null);
});
ok('generated expression parses back', () => {
    const expression = [
        DSL.conditionText('icon_hash', DSL.OP.EQUAL, '-394495807'),
        DSL.conditionText('header', DSL.OP.CONTAINS, 'set-cookie: safedog'),
        DSL.conditionText('body', DSL.OP.CONTAINS, 'a"b')
    ].join(' && ');
    const parsed = DSL.compileExpression(expression);
    assert.strictEqual(parsed.error, null);
    assert.strictEqual(parsed.conditions.length, 3);
});

if (failures) {
    console.error(failures + ' test(s) failed');
    process.exit(1);
}
console.log('rule DSL: all checks passed');
