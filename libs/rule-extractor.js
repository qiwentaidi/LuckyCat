/*
 * Lucky Cat - fingerprint rule extractor
 *
 * Turns the raw data of the current page into candidate rule conditions for
 * finger.yaml. It deliberately ships no fingerprint database: everything here
 * is derived from the page the user is looking at.
 *
 * Candidate shape:
 *   {
 *     id, source, op, value, label, group,
 *     score, stability, count, version, context, note
 *   }
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    } else {
        root.RuleExtractor = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const OP = { CONTAINS: 0, NOT_CONTAINS: 1, EQUAL: 2 };

    const GROUP_OF = {
        title: 'core',
        server: 'core',
        status: 'core',
        content_type: 'core',
        path: 'core',
        icon_hash: 'icon',
        icon_md5: 'icon',
        header: 'header',
        body: 'body',
        js_body: 'js'
    };

    const GROUP_LABEL = {
        core: '基础字段',
        header: '响应头',
        body: '页面特征',
        icon: '图标',
        js: '脚本',
        custom: '自定义'
    };

    // Headers that change on every request or response and are useless as
    // fingerprint conditions.
    const VOLATILE_HEADERS = new Set([
        'date', 'expires', 'last-modified', 'etag', 'age', 'content-length',
        'connection', 'keep-alive', 'transfer-encoding', 'vary',
        'content-encoding', 'trailer', 'alt-svc', 'report-to', 'nel',
        'expect-ct', 'server-timing', 'x-request-id', 'x-correlation-id',
        'x-trace-id', 'traceparent', 'x-b3-traceid', 'x-amzn-trace-id',
        'cf-ray', 'x-runtime', 'x-response-time', 'x-timer'
    ]);

    const GENERIC_COOKIES = new Set([
        'session', 'sessionid', 'jsessionid', 'phpsessid', 'aspsessionid',
        'csrftoken', 'xsrf-token', 'csrf_token', 'x-xsrf-token', 'token',
        '_ga', '_gid', '_gat', 'sid', 'auth', 'remember_me', 'lang',
        'locale', 'theme', 'timezone'
    ]);

    const GENERIC_VALUES = new Set([
        'text/html', 'application/json', 'text/plain', 'application/xml',
        'utf-8', 'gzip', 'br', 'deflate', 'identity', 'chunked',
        'index', 'home', 'main', 'app', 'login', 'admin', 'api', 'static',
        'assets', 'images', 'img', 'css', 'js', 'font', 'fonts', 'public',
        'dist', 'build', 'common', 'default', 'web', 'www', 'html', 'body',
        'content', 'page', 'site', 'user', 'system', 'manage', 'portal',
        'test', 'demo', 'en', 'zh', 'cn', 'en-us', 'zh-cn', 'v1', 'v2',
        'upload', 'uploads', 'files', 'media', 'vendor', 'libs', 'plugins',
        'themes', 'js/', 'css/', 'img/', 'images/'
    ]);

    const GENERIC_SEGMENTS = new Set([
        'static', 'assets', 'images', 'img', 'css', 'js', 'fonts', 'font',
        'public', 'dist', 'build', 'common', 'vendor', 'libs', 'lib',
        'plugins', 'themes', 'upload', 'uploads', 'files', 'media', 'web',
        'www', 'content', 'page', 'pages', 'index', 'home', 'main', 'app',
        'favicon', 'robots', 'sitemap', 'manifest', 'logo', 'banner'
    ]);

    // What a candidate is good for:
    //   product    - identifies a product/CMS/framework across sites
    //   deployment - describes this deployment (title, ICP, cookie, favicon)
    //   generic    - broad tech stack, low discrimination
    const SCOPE_LABEL = {
        product: '产品级',
        deployment: '部署级',
        generic: '通用',
        unknown: '未知'
    };

    const DEFAULT_SCOPE = {
        title: 'deployment',
        server: 'generic',
        content_type: 'generic',
        status: 'generic',
        path: 'deployment',
        icon_hash: 'deployment',
        icon_md5: 'deployment',
        header: 'deployment',
        body: 'deployment',
        js_body: 'deployment'
    };

    const COVERAGE_RANK = { broad: 3, medium: 2, versioned: 1, '': 0 };

    // Path segments that usually identify a product rather than one deployment.
    const PRODUCT_PATH_SEGMENTS = new Set([
        'wp-content', 'wp-includes', 'wp-admin', 'wp-json',
        'nacos', 'druid', 'swagger-ui', 'swagger', 'ueditor', 'kindeditor',
        'fckeditor', 'phpmyadmin', 'pma', 'jenkins', 'zabbix', 'grafana',
        'kibana', 'minio', 'harbor', 'nexus', 'sonarqube', 'confluence',
        'jira', 'weblogic', 'solr', 'actuator', 'eureka', 'hystrix',
        'rocketmq', 'rabbitmq', 'elasticsearch', 'hadoop', 'hue', 'oozie',
        'zeppelin', 'airflow', 'superset', 'metabase', 'prometheus',
        'alertmanager', 'portainer', 'rancher', 'gitlab', 'gitea', 'gogs',
        'jumpserver', 'websphere', 'jboss', 'tomcat', 'adminer', 'seata',
        'sentinel', 'skywalking', 'zipkin', 'jaeger', 'kafka', 'zookeeper'
    ]);

    const PRODUCT_SEGMENT_LABEL = {
        'wp-content': 'WordPress', 'wp-includes': 'WordPress',
        'wp-admin': 'WordPress', 'wp-json': 'WordPress',
        'nacos': 'Nacos', 'druid': 'Druid', 'swagger-ui': 'Swagger UI',
        'swagger': 'Swagger', 'ueditor': 'UEditor', 'kindeditor': 'KindEditor',
        'fckeditor': 'FCKeditor', 'phpmyadmin': 'phpMyAdmin', 'pma': 'phpMyAdmin',
        'jenkins': 'Jenkins', 'zabbix': 'Zabbix', 'grafana': 'Grafana',
        'kibana': 'Kibana', 'minio': 'MinIO', 'harbor': 'Harbor',
        'nexus': 'Nexus', 'sonarqube': 'SonarQube', 'confluence': 'Confluence',
        'jira': 'Jira', 'weblogic': 'WebLogic', 'solr': 'Solr',
        'actuator': 'Spring Boot Actuator', 'eureka': 'Eureka',
        'hystrix': 'Hystrix', 'rocketmq': 'RocketMQ', 'rabbitmq': 'RabbitMQ',
        'elasticsearch': 'Elasticsearch', 'hadoop': 'Hadoop', 'hue': 'Hue',
        'oozie': 'Oozie', 'zeppelin': 'Zeppelin', 'airflow': 'Airflow',
        'superset': 'Superset', 'metabase': 'Metabase', 'prometheus': 'Prometheus',
        'alertmanager': 'Alertmanager', 'portainer': 'Portainer',
        'rancher': 'Rancher', 'gitlab': 'GitLab', 'gitea': 'Gitea',
        'gogs': 'Gogs', 'jumpserver': 'JumpServer', 'websphere': 'WebSphere',
        'jboss': 'JBoss', 'tomcat': 'Tomcat', 'adminer': 'Adminer',
        'seata': 'Seata', 'sentinel': 'Sentinel', 'skywalking': 'SkyWalking',
        'zipkin': 'Zipkin', 'jaeger': 'Jaeger', 'kafka': 'Kafka',
        'zookeeper': 'Zookeeper'
    };

    function pathScope(path) {
        const segments = String(path).split('/').filter(Boolean);
        for (let i = 0; i < segments.length; i++) {
            const key = segments[i].toLowerCase().replace(/\.[a-z0-9]{1,6}$/i, '');
            if (PRODUCT_PATH_SEGMENTS.has(key)) {
                return {
                    scope: 'product',
                    product: PRODUCT_SEGMENT_LABEL[key] || key,
                    coverage: 'medium'
                };
            }
        }
        return { scope: 'deployment', product: '', coverage: '' };
    }

    // Meta tags that describe rendering/browser behaviour, not the product.
    const SKIP_META_KEYS = new Set([
        'renderer', 'x-ua-compatible', 'viewport', 'format-detection',
        'theme-color', 'msapplication-tilecolor', 'msapplication-config',
        'msapplication-tileimage', 'apple-mobile-web-app-capable',
        'apple-mobile-web-app-status-bar-style', 'mobile-web-app-capable',
        'referrer', 'robots', 'googlebot', 'bingbot'
    ]);

    const FRAMEWORK_MARKERS = [
        ['__next_data__', 'Next.js 数据', 55],
        ['__nuxt__', 'Nuxt 数据', 55],
        ['__initial_state__', 'SSR 初始状态', 50],
        ['wp-content', 'WordPress', 55],
        ['wp-includes', 'WordPress', 55],
        ['/sites/default/files', 'Drupal', 60],
        ['com_content', 'Joomla', 55],
        ['thinkphp', 'ThinkPHP', 55],
        ['laravel', 'Laravel', 50],
        ['struts', 'Struts', 50],
        ['shiro', 'Shiro', 45],
        ['swagger-ui', 'Swagger UI', 55],
        ['druid', 'Druid', 40],
        ['nacos', 'Nacos', 55],
        ['ueditor', 'UEditor', 55],
        ['kindeditor', 'KindEditor', 55],
        ['layui', 'layui', 40],
        ['element-ui', 'Element UI', 40],
        ['ant-design', 'Ant Design', 40],
        ['vuetify', 'Vuetify', 35],
        ['bootstrap', 'Bootstrap', 25],
        ['jquery', 'jQuery', 25],
        ['webpack', 'webpack', 25],
        ['vite', 'Vite', 25]
    ];

    /* ------------------------------------------------------------------ *
     * Helpers
     * ------------------------------------------------------------------ */

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function isDynamicValue(value) {
        const text = String(value);
        const patterns = [
            /[0-9a-f]{12,}/i,
            /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
            /\b1\d{9}\b/,
            /\b\d{13}\b/,
            /[A-Za-z0-9+]{32,}={1,2}/,
            /^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)[A-Za-z0-9+/_-]{24,}$/
        ];
        if (patterns.some(pattern => pattern.test(text))) {
            return true;
        }
        return /(token|nonce|csrf|sessionid|signature|timestamp|expires|_t=|t=)/i.test(text);
    }

    function isGenericValue(value) {
        const text = String(value).toLowerCase().replace(/^[./]+|[./]+$/g, '');
        if (!text) {
            return true;
        }
        if (GENERIC_VALUES.has(text)) {
            return true;
        }
        if (/^[\d\s.,:;_\-]+$/.test(text)) {
            return true;
        }
        return text.length < 3;
    }

    function countOccurrences(haystack, needle) {
        if (!haystack || !needle) {
            return 0;
        }
        let index = 0;
        let count = 0;
        while (count < 50) {
            const found = haystack.indexOf(needle, index);
            if (found === -1) {
                break;
            }
            count++;
            index = found + needle.length;
        }
        return count;
    }

    function contextAround(haystack, needle, radius) {
        if (!haystack || !needle) {
            return '';
        }
        const index = haystack.indexOf(needle);
        if (index === -1) {
            return '';
        }
        const start = Math.max(0, index - (radius || 30));
        const end = Math.min(haystack.length, index + needle.length + (radius || 30));
        return haystack.slice(start, end).replace(/\s+/g, ' ');
    }

    function normalizeValue(source, value) {
        let text = String(value).replace(/\s+/g, ' ').trim();
        if (source === 'icon_hash' || source === 'status' || source === 'port') {
            return text;
        }
        if (source === 'body' || source === 'js_body' || source === 'header' ||
            source === 'title' || source === 'server' || source === 'path' ||
            source === 'content_type') {
            return text.toLowerCase();
        }
        return text;
    }

    function stabilityOf(source, value, input) {
        if (source === 'body' || source === 'title') {
            if (isDynamicValue(value)) {
                return 'dynamic';
            }
            const raw = (input.rawHtml || '').toLowerCase();
            const dom = (input.domHtml || '').toLowerCase();
            const inRaw = raw ? raw.indexOf(value.toLowerCase()) !== -1 : false;
            const inDom = dom ? dom.indexOf(value.toLowerCase()) !== -1 : false;
            if (inRaw) {
                return 'stable';
            }
            if (inDom) {
                // Present only after scripts ran: the value may be generated on
                // the client and change between visits.
                return 'dynamic';
            }
            return 'unknown';
        }
        if (source === 'header' || source === 'js_body') {
            return isDynamicValue(value) ? 'dynamic' : 'stable';
        }
        return 'stable';
    }

    function makeCandidate(source, op, value, options) {
        const opts = options || {};
        const normalized = normalizeValue(source, value);
        if (!normalized) {
            return null;
        }
        const candidate = {
            id: source + '|' + op + '|' + normalized,
            source: source,
            op: op,
            value: normalized,
            label: opts.label || source,
            group: opts.group || GROUP_OF[source] || 'body',
            score: opts.score || 40,
            stability: opts.stability || 'stable',
            scope: opts.scope || DEFAULT_SCOPE[source] || 'unknown',
            product: opts.product || '',
            coverage: opts.coverage || '',
            recommended: false,
            count: opts.count || 0,
            version: opts.version || null,
            context: opts.context || '',
            note: opts.note || '',
            rawValue: opts.rawValue || value
        };
        return candidate;
    }

    /* ------------------------------------------------------------------ *
     * Version extraction
     * ------------------------------------------------------------------ */

    // Suggests an extract regex when a version number sits inside or right
    // after the candidate value (e.g. "wordpress 6.4.2").
    function detectVersion(input, candidate) {
        if (candidate.source !== 'body' && candidate.source !== 'header') {
            return null;
        }
        const haystack = candidate.source === 'header'
            ? (input.headerText || '')
            : ((input.rawHtml || input.body || '').toLowerCase());
        const needle = candidate.value.toLowerCase();
        const index = haystack.indexOf(needle);
        if (index === -1) {
            return null;
        }

        const inside = /(\d+\.\d+(?:\.\d+)?)/.exec(needle);
        if (inside) {
            return inside[1];
        }

        const after = haystack.slice(index + needle.length, index + needle.length + 40);
        const match = /^[^0-9]{0,12}v?(\d+\.\d+(?:\.\d+)?)/.exec(after);
        return match ? match[1] : null;
    }

    /* ------------------------------------------------------------------ *
     * Candidate collectors
     * ------------------------------------------------------------------ */

    function addCore(candidates, input) {
        const title = String(input.title || '').trim();
        if (title && title.length >= 2 && title.length <= 120 && !isGenericValue(title)) {
            let score = 52;
            if (/登录|后台|管理|系统|控制台|admin|login|dashboard/i.test(title)) {
                score += 5;
            }
            if (title.length >= 6) {
                score += 5;
            }
            candidates.push(makeCandidate('title', OP.CONTAINS, title, {
                label: '页面标题',
                score: score,
                stability: stabilityOf('title', title, input)
            }));
        }

        const server = String(input.server || '').trim();
        if (server) {
            candidates.push(makeCandidate('server', OP.CONTAINS, server, {
                label: 'Server 响应头',
                score: 62,
                stability: isDynamicValue(server) ? 'dynamic' : 'stable'
            }));
        }

        const contentType = String(input.contentType || '').split(';')[0].trim();
        if (contentType) {
            candidates.push(makeCandidate('content_type', OP.CONTAINS, contentType, {
                label: 'Content-Type',
                score: isGenericValue(contentType) ? 18 : 26,
                stability: 'stable'
            }));
        }

        if (input.status) {
            candidates.push(makeCandidate('status', OP.CONTAINS, String(input.status), {
                label: 'HTTP 状态码',
                score: 15,
                stability: 'stable'
            }));
        }

        const path = String(input.path || '');
        if (path && path !== '/' && path.length <= 120) {
            const pathInfo = pathScope(path);
            candidates.push(makeCandidate('path', OP.CONTAINS, path, {
                label: '当前路径',
                score: pathInfo.scope === 'product' ? 48 : 36,
                stability: 'stable',
                scope: pathInfo.scope,
                product: pathInfo.product,
                coverage: pathInfo.coverage
            }));
        }
    }

    function addIcon(candidates, input) {
        if (input.iconHash) {
            candidates.push(makeCandidate('icon_hash', OP.CONTAINS, String(input.iconHash), {
                label: 'favicon mmh3',
                score: 95,
                stability: 'stable',
                note: 'FOFA icon_hash 同款算法'
            }));
        }
        if (input.iconMd5) {
            candidates.push(makeCandidate('icon_md5', OP.CONTAINS, String(input.iconMd5), {
                label: 'favicon MD5',
                score: 90,
                stability: 'stable'
            }));
        }
    }

    function headerScore(name) {
        const fixed = {
            'x-powered-by': 74,
            'x-aspnet-version': 78,
            'x-aspnetmvc-version': 78,
            'x-generator': 78,
            'x-drupal-cache': 68,
            'x-shopify-stage': 74,
            'x-served-by': 60,
            'x-varnish': 58,
            'x-backend-server': 64,
            'server': 58,
            'via': 52,
            'x-cache': 40,
            'x-debug-token': 30,
            'x-frame-options': 12,
            'x-content-type-options': 10,
            'strict-transport-security': 8
        };
        if (fixed[name] !== undefined) {
            return fixed[name];
        }
        if (name.indexOf('x-') === 0) {
            return 48;
        }
        return 30;
    }

    function addHeaders(candidates, input) {
        const headers = input.headers || [];
        headers.forEach(pair => {
            const name = String(pair[0] || '').toLowerCase().trim();
            const value = String(pair[1] || '').trim();
            if (!name || name === 'set-cookie' || VOLATILE_HEADERS.has(name)) {
                return;
            }
            if (!value || value.length > 160) {
                return;
            }
            const text = name + ': ' + value;
            let scope = 'deployment';
            let product = '';
            let coverage = '';
            if (name === 'server' || name === 'x-powered-by' || name === 'content-type') {
                scope = 'generic';
            } else if (name === 'x-generator') {
                scope = 'product';
                coverage = /\d+\.\d+/.test(value) ? 'versioned' : 'broad';
                product = value.replace(/[\s/]?v?\d+(\.\d+)+.*$/, '').trim() || value;
            }
            candidates.push(makeCandidate('header', OP.CONTAINS, text, {
                label: name,
                score: headerScore(name),
                stability: isDynamicValue(text) ? 'dynamic' : 'stable',
                scope: scope,
                product: product,
                coverage: coverage,
                note: '响应头中的完整 name: value'
            }));
        });

        // Cookies: the value changes constantly, the name rarely does.
        const seenCookies = new Set();
        headers.forEach(pair => {
            const name = String(pair[0] || '').toLowerCase().trim();
            if (name !== 'set-cookie') {
                return;
            }
            const value = String(pair[1] || '');
            const match = /^\s*([^=;,\s]+)=/.exec(value);
            if (!match) {
                return;
            }
            const cookie = match[1].toLowerCase();
            if (seenCookies.has(cookie)) {
                return;
            }
            seenCookies.add(cookie);
            const generic = GENERIC_COOKIES.has(cookie);
            candidates.push(makeCandidate('header', OP.CONTAINS, 'set-cookie: ' + cookie + '=', {
                label: generic ? 'Cookie 名（通用）' : 'Cookie 名',
                score: generic ? 42 : 78,
                stability: 'stable',
                scope: generic ? 'generic' : 'deployment'
            }));
        });
    }

    const RELATIVE_PATH_RE = /(?:^|[\s"'(=>])((?:wp-content|wp-includes|sites\/default|static|assets|uploads?|api|admin|console|portal|manage|system|modules|themes|template|includes)\/[A-Za-z0-9_\-.~%]+(?:\/[A-Za-z0-9_\-.~%]+){0,5})/gi;

    function collectPaths(raw, dom) {
        const paths = new Map();
        const text = (raw || '') + '\n' + (dom || '');
        const regex = /["'](\/[A-Za-z0-9_\-./~%]{3,160})["']/g;
        let match;
        while ((match = regex.exec(text)) !== null) {
            let path = match[1];
            const queryIndex = path.search(/[?#]/);
            if (queryIndex !== -1) {
                path = path.slice(0, queryIndex);
            }
            path = path.replace(/\/+$/, '');
            if (!path || path === '/' || path.indexOf('//') === 0) {
                continue;
            }
            if (path.indexOf('/') === path.lastIndexOf('/') && !/\.[a-z0-9]{2,5}$/i.test(path)) {
                continue;
            }
            if (isDynamicValue(path) || isGenericValue(path)) {
                continue;
            }
            const segments = path.split('/').filter(Boolean);
            if (segments.length < 2) {
                continue;
            }
            // Drop paths made only of layout words (static/js/app.js).
            const meaningful = segments
                .map(segment => segment.replace(/\.[a-z0-9]{1,6}$/i, ''))
                .filter(segment => segment.length >= 3 && !GENERIC_SEGMENTS.has(segment.toLowerCase()));
            if (!meaningful.length) {
                continue;
            }
            if (!paths.has(path)) {
                paths.set(path, segments);
            }
        }

        // Paths are often written in visible text or inline scripts without
        // quotes (wp-content/plugins/x, api/user/info), so collect those too.
        let relative;
        while ((relative = RELATIVE_PATH_RE.exec(text)) !== null) {
            let path = relative[1].replace(/[.,;:)\]]+$/, '');
            if (path.indexOf('/') === path.lastIndexOf('/') && !/\.[a-z0-9]{2,5}$/i.test(path)) {
                continue;
            }
            if (isDynamicValue(path) || isGenericValue(path)) {
                continue;
            }
            const segments = path.split('/').filter(Boolean);
            if (segments.length < 2) {
                continue;
            }
            const meaningful = segments
                .map(segment => segment.replace(/\.[a-z0-9]{1,6}$/i, ''))
                .filter(segment => segment.length >= 3 && !GENERIC_SEGMENTS.has(segment.toLowerCase()));
            if (!meaningful.length) {
                continue;
            }
            if (!paths.has(path)) {
                paths.set(path, segments);
            }
        }
        return paths;
    }

    function pathScore(path) {
        const segments = path.split('/').filter(Boolean);
        let score = 42 + Math.min(20, segments.length * 4);
        if (/\.(js|css|png|jpe?g|gif|svg|ico|woff2?|ttf|eot|map)$/i.test(path)) {
            score += 6;
        }
        const distinctive = segments.filter(segment => !GENERIC_SEGMENTS.has(segment.toLowerCase()));
        if (distinctive.length) {
            score += 8;
        }
        if (segments.some(segment => /^[a-z][a-z0-9_-]{4,}$/i.test(segment) && !GENERIC_SEGMENTS.has(segment.toLowerCase()))) {
            score += 4;
        }
        return score;
    }

    function addBody(candidates, input) {
        const raw = input.rawHtml || '';
        const dom = input.domHtml || '';
        const body = (input.body || '').toLowerCase();
        const metas = input.metas || {};

        // meta tags
        Object.keys(metas).forEach(key => {
            if (SKIP_META_KEYS.has(key)) {
                return;
            }
            const value = String(metas[key] || '').trim();
            if (!value || value.length < 3 || value.length > 90) {
                return;
            }
            const scores = {
                generator: 82,
                'application-name': 72,
                'og:site_name': 70,
                'apple-mobile-web-app-title': 70,
                copyright: 45,
                author: 34,
                description: 24,
                keywords: 20
            };
            const score = scores[key] !== undefined ? scores[key] : 22;
            if (isGenericValue(value)) {
                return;
            }
            const isGenerator = key === 'generator';
            const versioned = isGenerator && /\d+\.\d+/.test(value);
            candidates.push(makeCandidate('body', OP.CONTAINS, value, {
                label: 'meta ' + key,
                score: score,
                stability: stabilityOf('body', value, input),
                scope: isGenerator ? 'product' : 'deployment',
                product: isGenerator ? value.replace(/[\s/]?v?\d+(\.\d+)+.*$/, '').trim() || value : '',
                coverage: isGenerator ? (versioned ? 'versioned' : 'broad') : '',
                context: 'meta ' + key + ' content="' + value + '"'
            }));
        });

        // ICP licence number: very stable and site specific.
        const icp = /([\u4e00-\u9fa5]{1,8}?ICP[备证]\d{4,}号(?:-\d+)?)/.exec(raw + '\n' + dom);
        if (icp) {
            candidates.push(makeCandidate('body', OP.CONTAINS, icp[1], {
                label: 'ICP 备案号',
                score: 92,
                stability: 'stable'
            }));
        }

        // copyright line
        const copyright = /((?:©|&copy;|copyright|版权所有)[^\n<>{}]{2,60})/i.exec(raw + '\n' + dom);
        if (copyright) {
            candidates.push(makeCandidate('body', OP.CONTAINS, copyright[1], {
                label: '版权信息',
                score: 56,
                stability: stabilityOf('body', copyright[1], input)
            }));
        }

        // HTML comments
        const commentRegex = /<!--([\s\S]{2,100}?)-->/g;
        const seenComments = new Set();
        let comment;
        const haystack = raw + '\n' + dom;
        while ((comment = commentRegex.exec(haystack)) !== null) {
            const inner = comment[1].trim();
            if (!inner || seenComments.has(inner)) {
                continue;
            }
            seenComments.add(inner);
            if (/^\[if|^<!\[endif|webpack|sourcemappingurl|generated by|built at|vite/i.test(inner)) {
                continue;
            }
            // Comments that leak DOM/JS snippets make poor, unstable rules.
            if (/<\/?[a-z]|class\s*=|style\s*=|data-v-|src=\s*["']/i.test(inner)) {
                continue;
            }
            candidates.push(makeCandidate('body', OP.CONTAINS, '<!--' + inner + '-->', {
                label: 'HTML 注释',
                score: 58,
                stability: stabilityOf('body', '<!--' + inner + '-->', input)
            }));
        }

        // asset / API paths
        const paths = collectPaths(raw, dom);
        paths.forEach((segments, path) => {
            const pathInfo = pathScope(path);
            candidates.push(makeCandidate('body', OP.CONTAINS, path, {
                label: '路径 / 资源',
                score: pathScore(path) + (pathInfo.scope === 'product' ? 4 : 0),
                stability: 'stable',
                scope: pathInfo.scope,
                product: pathInfo.product,
                coverage: pathInfo.coverage,
                count: countOccurrences(body, path.toLowerCase()),
                context: path
            }));
        });

        // framework markers
        FRAMEWORK_MARKERS.forEach(entry => {
            const marker = entry[0];
            if (body.indexOf(marker) === -1) {
                return;
            }
            candidates.push(makeCandidate('body', OP.CONTAINS, marker, {
                label: entry[1] + ' 标记',
                score: entry[2] + (marker.length >= 8 ? 4 : 0),
                stability: 'stable',
                scope: 'product',
                product: entry[1],
                coverage: 'broad',
                count: countOccurrences(body, marker),
                note: '产品/框架级标记，跨站点通用'
            }));
        });

        // inline script globals
        const globalRegex = /window\.([A-Za-z_$][\w$]{2,40})\s*=/g;
        const seenGlobals = new Set();
        let globalMatch;
        while ((globalMatch = globalRegex.exec(raw || dom)) !== null) {
            const name = globalMatch[1];
            if (seenGlobals.has(name)) {
                continue;
            }
            seenGlobals.add(name);
            if (/^(location|document|onload|open|close|name|status|length|top|parent|self|frames|history|settimeout|setinterval)$/i.test(name)) {
                continue;
            }
            if (!/[a-z]/i.test(name) || name.length < 4) {
                continue;
            }
            const text = 'window.' + name;
            candidates.push(makeCandidate('body', OP.CONTAINS, text, {
                label: 'JS 全局变量',
                score: 60,
                stability: 'stable'
            }));
        }
    }

    /* ------------------------------------------------------------------ *
     * Public API
     * ------------------------------------------------------------------ */

    // Product-level markers are the ones worth copying on their own: a
    // conjunction with a page path/cookie would only match this deployment.
    function recommendCandidate(list) {
        const pool = list.filter(candidate =>
            candidate.scope === 'product'
            && candidate.stability !== 'dynamic'
            && candidate.value
            && candidate.value.length >= 3);
        if (!pool.length) {
            return null;
        }
        pool.sort((a, b) => {
            const rank = (COVERAGE_RANK[b.coverage] || 0) - (COVERAGE_RANK[a.coverage] || 0);
            if (rank !== 0) {
                return rank;
            }
            if (b.score !== a.score) {
                return b.score - a.score;
            }
            return a.value.length - b.value.length;
        });
        return pool[0];
    }

    function fofaValue(value) {
        return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    }

    // FOFA query for the currently selected conditions, used by the
    // "FOFA 验证" button. Conditions FOFA cannot express are reported back.
    function buildFofaQuery(candidates) {
        const clauses = [];
        const skipped = [];
        (candidates || []).forEach(candidate => {
            if (!candidate) {
                return;
            }
            let clause = null;
            if (candidate.source === 'body' || candidate.source === 'header'
                || candidate.source === 'title' || candidate.source === 'server'
                || candidate.source === 'cert' || candidate.source === 'banner') {
                if (candidate.op === OP.CONTAINS) {
                    clause = candidate.source + '="' + fofaValue(candidate.value) + '"';
                } else if (candidate.op === OP.NOT_CONTAINS) {
                    clause = candidate.source + '!="' + fofaValue(candidate.value) + '"';
                } else if (candidate.op === OP.EQUAL) {
                    clause = candidate.source + '=="' + fofaValue(candidate.value) + '"';
                }
            } else if (candidate.source === 'icon_hash' || candidate.source === 'status') {
                if (candidate.op === OP.CONTAINS || candidate.op === OP.EQUAL) {
                    clause = candidate.source + '="' + candidate.value + '"';
                }
            }
            if (clause) {
                if (clauses.indexOf(clause) === -1) {
                    clauses.push(clause);
                }
            } else {
                skipped.push(candidate.source + ' ' + candidate.value);
            }
        });
        return { query: clauses.join(' && '), clauses: clauses, skipped: skipped };
    }

    function finalize(candidates, input) {
        const deduped = new Map();
        candidates.forEach(candidate => {
            if (!candidate) {
                return;
            }
            const existing = deduped.get(candidate.id);
            if (!existing || existing.score < candidate.score) {
                deduped.set(candidate.id, candidate);
            }
        });

        const list = Array.from(deduped.values());
        list.forEach(candidate => {
            if (candidate.group !== 'icon' && candidate.stability !== 'dynamic' &&
                candidate.stability !== 'stable') {
                candidate.stability = stabilityOf(candidate.source, candidate.value, input);
            }
            let score = candidate.score;
            if (candidate.stability === 'dynamic') {
                score -= 34;
            } else if (candidate.stability === 'stable') {
                score += 4;
            }
            const stringSource = candidate.source !== 'icon_hash'
                && candidate.source !== 'status'
                && candidate.source !== 'port';
            if (stringSource && isGenericValue(candidate.value)) {
                score -= 35;
            }
            candidate.score = clamp(Math.round(score), 0, 100);
        });

        list.sort((a, b) => {
            if (b.score !== a.score) {
                return b.score - a.score;
            }
            if (a.stability !== b.stability) {
                return a.stability === 'stable' ? -1 : 1;
            }
            return a.value.length - b.value.length;
        });

        // Attach version extraction suggestions to body candidates.
        list.forEach(candidate => {
            if (candidate.version || candidate.source !== 'body') {
                return;
            }
            const version = detectVersion(input, candidate);
            if (version) {
                candidate.version = version;
            }
        });

        // A single product-level condition is the safe default: combining it
        // with a path/cookie would narrow the rule to this deployment only.
        const recommended = recommendCandidate(list);
        if (recommended) {
            recommended.recommended = true;
            const index = list.indexOf(recommended);
            if (index > 0) {
                list.splice(index, 1);
                list.unshift(recommended);
            }
        }

        return list.slice(0, 120);
    }

    function extract(input) {
        const data = input || {};
        const candidates = [];
        addCore(candidates, data);
        addIcon(candidates, data);
        addHeaders(candidates, data);
        addBody(candidates, data);
        return {
            candidates: finalize(candidates, data),
            groups: GROUP_LABEL
        };
    }

    function search(input, keyword) {
        const data = input || {};
        const needle = String(keyword || '').trim().toLowerCase();
        if (needle.length < 2) {
            return [];
        }
        const results = [];
        const sources = [
            ['body', data.rawHtml || data.body || '', 74],
            ['header', data.headerText || '', 72],
            ['title', data.title || '', 55],
            ['js_body', data.jsBody || '', 65]
        ];
        sources.forEach(entry => {
            const source = entry[0];
            const haystack = String(entry[1] || '');
            if (!haystack) {
                return;
            }
            const lowered = haystack.toLowerCase();
            const count = countOccurrences(lowered, needle);
            if (!count) {
                return;
            }
            results.push(makeCandidate(source, OP.CONTAINS, needle, {
                label: '搜索命中',
                score: entry[2],
                stability: stabilityOf(source, needle, data),
                count: count,
                context: contextAround(haystack, keyword, 40),
                note: '关键词搜索'
            }));
        });
        return results;
    }

    function buildExpression(candidates) {
        const parts = [];
        (candidates || []).forEach(candidate => {
            if (!candidate) {
                return;
            }
            const symbol = candidate.op === OP.NOT_CONTAINS ? '!='
                : candidate.op === OP.EQUAL ? '==' : '=';
            parts.push(candidate.source + symbol + '"' + String(candidate.value).replace(/"/g, '\\"') + '"');
        });
        return parts.join(' && ');
    }

    return {
        OP: OP,
        GROUP_LABEL: GROUP_LABEL,
        extract: extract,
        search: search,
        buildExpression: buildExpression,
        buildFofaQuery: buildFofaQuery,
        recommendCandidate: recommendCandidate,
        SCOPE_LABEL: SCOPE_LABEL,
        isDynamicValue: isDynamicValue,
        isGenericValue: isGenericValue,
        detectVersion: detectVersion,
        countOccurrences: countOccurrences
    };
});
