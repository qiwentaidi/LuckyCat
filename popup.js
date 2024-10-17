const randomUA = new Headers({
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"
})

// 获取当前标签页的 favicon
function getFaviconUrl() {
    return new Promise((resolve, reject) => {
        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
            const tab = tabs[0];
            if (tab && tab.favIconUrl) {
                resolve(tab.favIconUrl);
            } else {
                resolve(""); // 返回空字符串表示未找到 favicon
            }
        });
    });
}

function getRootUrl() {
    return new Promise((resolve, reject) => {
        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
            const tab = tabs[0];
            if (tab) {
                var url = new URL(tab.url);
                resolve(url.protocol + "//" + url.hostname + ":" + url.port);
            } else {
                resolve("");
            }
        });
    });
}

function getUrl() {
    return new Promise((resolve, reject) => {
        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
            const tab = tabs[0];
            if (tab) {
                resolve(tab.url);
            } else {
                resolve("");
            }
        });
    });
}

function arrayBufferToBase64(buffer) {
    return new Promise((resolve, reject) => {
        const blob = new Blob([buffer], {
            type: 'application/octet-stream'
        });
        const reader = new FileReader();
        reader.onloadend = function () {
            let base64data = reader.result;
            base64data = base64data.replace(/^data:.*?;base64,/, ''); // Remove the data URL part

            // Adding newline characters after every 76th characters
            let base64_with_newlines = (base64data.match(/.{1,76}/g) || [])
                .join('\n');

            // Ensure there's only a single newline at the end
            if (!base64_with_newlines.endsWith('\n')) {
                base64_with_newlines += '\n';
            }

            resolve(base64_with_newlines);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}


// 获取 favicon 文件并计算哈希值
async function processFavicon() {
    try {
        const faviconUrl = await getFaviconUrl();
        document.getElementById('favicon').src = faviconUrl;
        const response = await fetch(faviconUrl, {
            method: 'GET',
            mode: 'cors',
            cache: 'default',
            credentials: 'include',
            headers: randomUA
        });
        const arrayBuffer = await response.arrayBuffer();
        const base64_string = await arrayBufferToBase64(arrayBuffer)
        let bytes = new Uint8Array(arrayBuffer);
        let str = '';
        for (let i = 0; i < bytes.byteLength; i++) {
            str += String.fromCharCode(bytes[i]);
        }

        // 使用 crypto-js 计算 MD5 值
        const md5Hash = CryptoJS.MD5(CryptoJS.enc.Latin1.parse(str)).toString();
        // 计算 MD5 和 Murmur3 哈希值
        const murmur3Hash = mmh3_32(base64_string);
        // 确保元素已加载后再更新它们的内容
        document.getElementById('md5Hash').textContent = md5Hash;
        document.getElementById('murmurHash').textContent = murmur3Hash;
    } catch (error) {
        console.error('Error processing favicon:', error);
        document.getElementById('md5Hash').textContent = 'Error';
        document.getElementById('murmurHash').textContent = 'Error';
    }
}

async function processResponse() {
    const rootURL = await getRootUrl()
    let url = new URL(rootURL)
    if (!url.protocol.startsWith("http")) {
        return
    }
    const response = await fetch(rootURL, {
        "headers": randomUA,
        "method": "GET",
        "mode": "cors",
        "credentials": "include"
      }).catch(err => {
        console.error("can't fetch " + rootURL)
    })
    if (!response) {
        return
    }
    let bodyResult = await response.text()

    let jslinks = extractJsLinks(bodyResult)
    document.getElementById('jslink').textContent = jslinks.join("\n");

    const comments = extractComments(bodyResult);
    const allComments = []
    allComments.push(...Array.from(new Set(comments.htmlComments)))
    allComments.push(...Array.from(new Set(comments.cssComments)))
    document.getElementById('comment').textContent = allComments.join("\n");

    document.getElementById('statusCode').textContent = response.status;
    const value = response.headers.get('Server');
    if (!value) {
        document.getElementById('server').textContent = 'null';
    } else {
        document.getElementById('server').textContent = value;
    }
    let headersText = '';
    if (!response.headers) {
        return
    }
    response.headers.forEach(function(value, key) {
        headersText += key + ': ' + value + '\n';
    });
    
    document.getElementById('response-headers').textContent = headersText;
}


function getTitle() {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        const tab = tabs[0];
        if (tab && tab.id) {
            document.getElementById('pageTitle').textContent = tab.title;
        } else {
            document.getElementById('pageTitle').textContent = '没有活动标签页';
        }
    });
}

function LocationFofa(type) {
    let query = ""
    switch (type) {
        case 'hash':
            let hash = document.getElementById('murmurHash').textContent;
            query = FOFABaseEncode(`icon_hash="${hash}"`);
            break
        case 'server':
            let server = document.getElementById('server').textContent;
            query = FOFABaseEncode(`server="${server}"`);
            break
        case 'title':
            let title = document.getElementById('pageTitle').textContent;
            query = FOFABaseEncode(`title="${title}"`);
            break
        default:
            return
    }
    window.open("https://fofa.info/result?qbase64=" + encodeURIComponent(query));
}

function FOFABaseEncode(str) {
    // 使用 btoa 对字符串进行 Base64 编码
    return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, function(match, p1) {
        return String.fromCharCode('0x' + p1);
    }));
}

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
    if (jsLinks.length === 0) return jsLinks
    const result = []
    for (const item of jsLinks) {
        if (!containsRandomCharactersBetweenDots(item)) {
            result.push(item);
        }
    }
    return result;
}

// Function to check if a JS link contains a sequence of 8 or 20 random characters between two dots
function containsRandomCharactersBetweenDots(jslink) {
    const randomCharPattern = /(\.|\-)\w{8,20}\.js/;
    return randomCharPattern.test(jslink);
}

function extractComments(content) {
    const htmlCommentPattern = /(<!--.*?-->)/g; // Regex for complete HTML comments
    const cssCommentPattern = /(\/\*.*?\*\/)/g; // Regex for complete CSS comments

    const htmlComments = [];
    const cssComments = [];

    // Extract HTML comments
    let htmlMatch;
    while ((htmlMatch = htmlCommentPattern.exec(content)) !== null) {
        htmlComments.push(htmlMatch[1].trim()); // Add trimmed comment content
    }

    // Extract CSS comments
    let cssMatch;
    while ((cssMatch = cssCommentPattern.exec(content)) !== null) {
        cssComments.push(cssMatch[1].trim()); // Add trimmed comment content
    }

    return {
        htmlComments,
        cssComments
    };
}




// 页面加载时运行
document.addEventListener('DOMContentLoaded', function () {
    getTitle()
    processResponse()
    processFavicon()
});

document.getElementById('fofa-hash').addEventListener('click', function() {
    LocationFofa("hash")
});
document.getElementById('fofa-server').addEventListener('click', function() {
    LocationFofa("server")
});
document.getElementById('fofa-title').addEventListener('click', function() {
    LocationFofa("title")
});

chrome.webRequest.onBeforeSendHeaders.addListener(
    function(details) {
        let headersText = '';
        details.requestHeaders.forEach(header => {
            headersText += `${header.name}: ${header.value}\n`;
        });
        
        // Display the formatted headers in the HTML element with the id 'request-headers'
        document.getElementById('request-headers').textContent = headersText;
    },
    { urls: ["<all_urls>"] }, // Capture requests to all URLs
    ["requestHeaders"]
);