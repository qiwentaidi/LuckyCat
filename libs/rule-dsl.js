/*
 * Lucky Cat - fingerprint rule DSL
 *
 * Parser / validator / evaluator for the rule syntax used by finger.yaml:
 *
 *   body="x"  body!="x"  body=="x"  body~="regex"
 *   header="..."  title="..."  server="..."  status="200"
 *   icon_hash="-394495807"  len(body) == 0
 *   &&  ||  !  ( )
 *
 * There is no rule database here: the extension only uses this module to
 * validate rules it generates and to test them against the current page.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    } else {
        root.RuleDsl = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const OP = {
        CONTAINS: 0,
        NOT_CONTAINS: 1,
        EQUAL: 2,
        GE: 3,
        LE: 4,
        REGEX: 5
    };

    const OP_LABEL = {
        0: '包含',
        1: '不包含',
        2: '等于',
        3: '>=',
        4: '<=',
        5: '正则'
    };

    const NUMERIC_KEYS = new Set(['port', 'status', 'icon_hash', 'body_length']);

    const STRING_KEYS = new Set([
        'header', 'body', 'js_body', 'js', 'server', 'title', 'cert', 'path',
        'content_type', 'banner', 'icon_md5', 'icon_mdhash'
    ]);

    // Go's regexp is RE2; JavaScript regexps are close enough for rule
    // validation, except for inline flags and Python style named groups.
    function compilePattern(pattern, global) {
        let source = String(pattern);
        let flags = global ? 'g' : '';
        if (source.indexOf('(?i)') !== -1) {
            flags += 'i';
            source = source.replace(/\(\?i\)/g, '');
        }
        if (source.indexOf('(?s)') !== -1) {
            flags += 's';
            source = source.replace(/\(\?s\)/g, '');
        }
        source = source.replace(/\(\?P</g, '(?<');
        try {
            return new RegExp(source, flags);
        } catch (err) {
            return null;
        }
    }

    const CONDITION_RE = /([a-z0-9_]+)\s*(~=|==|!=|>=|<=|=)\s*/y;
    const BODY_LEN_RE = /len\s*\(\s*body\s*\)\s*(==|!=|>=|<=|>|<)\s*(\d+)/iy;

    function mapOperator(text) {
        switch (text) {
            case '!=': return OP.NOT_CONTAINS;
            case '==': return OP.EQUAL;
            case '>=': return OP.GE;
            case '<=': return OP.LE;
            case '~=': return OP.REGEX;
            default: return OP.CONTAINS;
        }
    }

    function operatorSymbol(op) {
        switch (op) {
            case OP.NOT_CONTAINS: return '!=';
            case OP.EQUAL: return '==';
            case OP.GE: return '>=';
            case OP.LE: return '<=';
            case OP.REGEX: return '~=';
            default: return '=';
        }
    }

    function readQuotedValue(expr, start) {
        let i = start;
        while (i < expr.length) {
            if (expr[i] !== '\\' && expr[i + 1] === '"') {
                return { value: expr.slice(start, i + 1), end: i + 2 };
            }
            i++;
        }
        return null;
    }

    function makeCondition(key, op, value, raw) {
        const lower = String(value).replace(/\\"/g, '"').toLowerCase();
        return {
            key: key,
            op: op,
            value: lower,
            raw: raw,
            regex: op === OP.REGEX ? compilePattern(lower, false) : null,
            number: NUMERIC_KEYS.has(key) ? parseInt(lower, 10) : NaN
        };
    }

    function parseCondition(expr, pos) {
        BODY_LEN_RE.lastIndex = pos;
        let match = BODY_LEN_RE.exec(expr);
        if (match) {
            const op = match[1] === '!=' ? OP.NOT_CONTAINS
                : match[1] === '==' ? OP.EQUAL
                : match[1] === '>=' ? OP.GE
                : match[1] === '<=' ? OP.LE
                : null;
            if (op === null) {
                return null;
            }
            return {
                cond: makeCondition('body_length', op, match[2], match[0]),
                end: pos + match[0].length
            };
        }

        CONDITION_RE.lastIndex = pos;
        match = CONDITION_RE.exec(expr);
        if (!match) {
            return null;
        }
        const key = match[1];
        const valueStart = pos + match[0].length;
        if (expr[valueStart] === '"') {
            const quoted = readQuotedValue(expr, valueStart + 1);
            if (!quoted) {
                return null;
            }
            return {
                cond: makeCondition(key, mapOperator(match[2]), quoted.value, expr.slice(pos, quoted.end)),
                end: quoted.end
            };
        }
        if (NUMERIC_KEYS.has(key)) {
            const numeric = /^-?\d+/.exec(expr.slice(valueStart));
            if (!numeric) {
                return null;
            }
            const end = valueStart + numeric[0].length;
            return {
                cond: makeCondition(key, mapOperator(match[2]), numeric[0], expr.slice(pos, end)),
                end: end
            };
        }
        return null;
    }

    function compileExpression(text) {
        const expr = String(text);
        const conditions = [];
        let pos = 0;
        let failed = false;

        function skip() {
            while (pos < expr.length && /\s/.test(expr[pos])) {
                pos++;
            }
        }

        function parseOr() {
            let node = parseAnd();
            skip();
            while (expr.startsWith('||', pos)) {
                pos += 2;
                node = { type: 'or', a: node, b: parseAnd() };
                skip();
            }
            return node;
        }

        function parseAnd() {
            let node = parseUnary();
            skip();
            while (expr.startsWith('&&', pos)) {
                pos += 2;
                node = { type: 'and', a: node, b: parseUnary() };
                skip();
            }
            return node;
        }

        function parseUnary() {
            skip();
            if (expr[pos] === '!') {
                pos++;
                return { type: 'not', a: parseUnary() };
            }
            return parsePrimary();
        }

        function parsePrimary() {
            skip();
            if (expr[pos] === '(') {
                pos++;
                const node = parseOr();
                skip();
                if (expr[pos] === ')') {
                    pos++;
                } else {
                    failed = true;
                }
                return node;
            }
            const parsed = parseCondition(expr, pos);
            if (!parsed) {
                failed = true;
                pos = expr.length;
                return { type: 'literal', value: false };
            }
            pos = parsed.end;
            conditions.push(parsed.cond);
            return { type: 'condition', cond: parsed.cond };
        }

        let ast = null;
        try {
            ast = parseOr();
        } catch (err) {
            failed = true;
        }
        skip();
        if (pos !== expr.length) {
            failed = true;
        }

        return {
            text: expr,
            ast: failed ? null : ast,
            conditions: conditions,
            error: failed ? 'invalid expression' : null
        };
    }

    function stringMatches(cond, data) {
        if (!data) {
            // Mirrors the Go evaluator: empty fields never match, even for !=.
            return false;
        }
        switch (cond.op) {
            case OP.CONTAINS:
                return data.indexOf(cond.value) !== -1;
            case OP.NOT_CONTAINS:
                return data.indexOf(cond.value) === -1;
            case OP.EQUAL:
                return data === cond.value;
            case OP.REGEX:
                cond.regex.lastIndex = 0;
                return cond.regex.test(data);
            default:
                return false;
        }
    }

    function numericMatches(cond, value) {
        const number = typeof value === 'number' ? value : parseInt(value, 10);
        if (!isFinite(number) || !isFinite(cond.number)) {
            return false;
        }
        switch (cond.op) {
            case OP.CONTAINS:
            case OP.EQUAL:
                return number === cond.number;
            case OP.NOT_CONTAINS:
                return number !== cond.number;
            case OP.GE:
                return number >= cond.number;
            case OP.LE:
                return number <= cond.number;
            default:
                return false;
        }
    }

    function conditionMatches(cond, web) {
        if (cond.op === OP.REGEX && !cond.regex) {
            return false;
        }
        if (NUMERIC_KEYS.has(cond.key)) {
            if (cond.key === 'port') {
                return numericMatches(cond, web.port);
            }
            if (cond.key === 'status') {
                return numericMatches(cond, web.status);
            }
            if (cond.key === 'icon_hash') {
                return numericMatches(cond, web.iconHash);
            }
            return numericMatches(cond, web.bodyLength);
        }
        if (cond.key === 'protocol') {
            const value = web.protocol || '';
            if (cond.op === OP.CONTAINS || cond.op === OP.EQUAL) {
                return value === cond.value;
            }
            if (cond.op === OP.NOT_CONTAINS) {
                return value !== cond.value;
            }
            return false;
        }

        const source = {
            body: web.body,
            js_body: web.jsBody,
            js: web.jsBody,
            header: web.header,
            server: web.server,
            title: web.title,
            cert: web.cert,
            banner: web.banner,
            path: web.path,
            content_type: web.contentType,
            icon_md5: web.iconMd5,
            icon_mdhash: web.iconMd5
        }[cond.key];

        if (source === undefined) {
            return false;
        }
        return stringMatches(cond, source);
    }

    function evaluateNode(node, web) {
        if (!node) {
            return false;
        }
        switch (node.type) {
            case 'and':
                return evaluateNode(node.a, web) && evaluateNode(node.b, web);
            case 'or':
                return evaluateNode(node.a, web) || evaluateNode(node.b, web);
            case 'not':
                return !evaluateNode(node.a, web);
            case 'condition':
                return conditionMatches(node.cond, web);
            default:
                return false;
        }
    }

    function normalizeWeb(web) {
        const source = web || {};
        return {
            protocol: String(source.protocol || '').toLowerCase(),
            port: source.port,
            path: String(source.path || '').toLowerCase(),
            title: String(source.title || '').toLowerCase(),
            status: source.status,
            iconHash: source.iconHash === undefined || source.iconHash === null ? '' : String(source.iconHash),
            iconMd5: String(source.iconMd5 || '').toLowerCase(),
            body: String(source.body || '').toLowerCase(),
            jsBody: String(source.jsBody || '').toLowerCase(),
            header: String(source.header || '').toLowerCase(),
            contentType: String(source.contentType || '').toLowerCase(),
            server: String(source.server || '').toLowerCase(),
            bodyLength: source.bodyLength,
            banner: String(source.banner || '').toLowerCase(),
            cert: String(source.cert || '').toLowerCase()
        };
    }

    // Checks a generated expression against the page it was extracted from.
    function test(expression, web) {
        const compiled = compileExpression(expression);
        if (compiled.error) {
            return { ok: false, error: compiled.error, matched: false };
        }
        return { ok: true, error: null, matched: evaluateNode(compiled.ast, normalizeWeb(web)) };
    }

    function escapeValue(value) {
        return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    }

    // Builds one condition, e.g. body="wp-content" or status="200".
    function conditionText(source, op, value) {
        const text = String(value);
        if (!text) {
            return null;
        }
        // A trailing backslash would escape the closing quote.
        if (/\\$/.test(text)) {
            return null;
        }
        return source + operatorSymbol(op) + '"' + escapeValue(text) + '"';
    }

    function isKnownKey(key) {
        return STRING_KEYS.has(key) || NUMERIC_KEYS.has(key) || key === 'protocol' || key === 'path';
    }

    return {
        OP: OP,
        OP_LABEL: OP_LABEL,
        NUMERIC_KEYS: NUMERIC_KEYS,
        STRING_KEYS: STRING_KEYS,
        compileExpression: compileExpression,
        test: test,
        conditionText: conditionText,
        escapeValue: escapeValue,
        isKnownKey: isKnownKey,
        compilePattern: compilePattern
    };
});
