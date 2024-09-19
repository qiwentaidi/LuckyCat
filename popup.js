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
                // if (url.protocol == "http" || url.protocol == "https") {
                    resolve(url.protocol + "//" + url.hostname);
                // } 
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
        const response = await fetch(faviconUrl, {mode: 'no-cors'});
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
    try {
        const bodyUrl = await getRootUrl()
        const response = await fetch(bodyUrl, {mode: 'no-cors'});
        document.getElementById('statusCode').textContent = response.status;
        const value = response.headers.get('Server');
        document.getElementById('server').textContent = value;
        let headersText = '';
        response.headers.forEach(function(value, key) {
            headersText += key + ': ' + value + '\n';
        });
        document.getElementById('headers').textContent = headersText;
    } catch (error) {
        console.error('Error processing body:', error);
    }
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


// 页面加载时运行
document.addEventListener('DOMContentLoaded', function () {
    getTitle()
    processResponse()
    processFavicon()
});
