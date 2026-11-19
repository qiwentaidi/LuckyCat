/*
 * Lucky Cat - chrome API stub for the local UI harness.
 *
 * The harness opens popup.html as a plain file:// page to test the popup
 * without the extension runtime or network access. Page data comes from
 * window.__TEST_PAGE__, which tests/make-harness.js writes into harness.html.
 */
(function () {
    const page = window.__TEST_PAGE__ || {
        url: 'http://example.test/',
        title: 'Example',
        status: 200,
        headers: [],
        html: '<html></html>',
        metas: {},
        scripts: []
    };
    const store = {};

    function later(fn) {
        setTimeout(fn, 0);
    }

    function tabInfo() {
        return {
            id: 1,
            url: page.url,
            title: page.title,
            favIconUrl: '../assets/images/icon32.png',
            active: true,
            status: 'complete'
        };
    }

    window.chrome = {
        runtime: {
            lastError: undefined,
            sendMessage: function (message, callback) {
                later(function () {
                    let response = null;
                    if (message && message.type === 'luckycat:headers') {
                        response = {
                            tabId: 1,
                            url: page.url,
                            statusCode: page.status,
                            statusLine: 'HTTP/1.1 ' + page.status + ' OK',
                            headers: page.headers
                        };
                    } else if (message && message.type === 'luckycat:fetch') {
                        response = {
                            ok: true,
                            status: page.status,
                            statusText: 'OK',
                            url: page.url,
                            headers: page.headers,
                            text: message.url === page.url ? page.html : ''
                        };
                    } else if (message && message.type === 'luckycat:fetch-binary') {
                        // Return the extension icon so the screenshot shows a
                        // real favicon / icon_hash instead of a blank square.
                        fetch('../assets/images/icon32.png').then(function (res) {
                            return res.arrayBuffer();
                        }).then(function (buffer) {
                            const bytes = new Uint8Array(buffer);
                            let binary = '';
                            for (let i = 0; i < bytes.length; i++) {
                                binary += String.fromCharCode(bytes[i]);
                            }
                            callback({ ok: true, status: 200, base64: btoa(binary) });
                        }).catch(function () {
                            callback({ ok: false, error: 'stub' });
                        });
                        return;
                    }
                    if (callback) {
                        callback(response);
                    }
                });
            },
            getURL: function (path) {
                return path;
            }
        },
        tabs: {
            query: function (query, callback) {
                later(function () {
                    callback && callback([tabInfo()]);
                });
            },
            get: function (id, callback) {
                later(function () {
                    callback && callback(tabInfo());
                });
            }
        },
        scripting: {
            executeScript: function () {
                return Promise.resolve([{
                    result: {
                        url: page.url,
                        title: page.title,
                        html: page.html,
                        htmlTruncated: false,
                        scripts: page.scripts,
                        metas: page.metas,
                        contentType: 'text/html'
                    }
                }]);
            }
        },
        storage: {
            local: {
                get: function (key, callback) {
                    later(function () {
                        const keys = typeof key === 'string' ? [key] : Object.keys(key || {});
                        const out = {};
                        keys.forEach(function (name) {
                            if (name in store) {
                                out[name] = store[name];
                            }
                        });
                        callback && callback(out);
                    });
                },
                set: function (items, callback) {
                    Object.assign(store, items);
                    if (callback) {
                        later(callback);
                    }
                },
                remove: function (key, callback) {
                    delete store[key];
                    if (callback) {
                        later(callback);
                    }
                }
            }
        }
    };
})();
