/**
 * import.js — 聊天数据导入
 * 支持 ZIP 和文件夹导入，存入 IndexedDB，纯本地，零上传
 */
(function() {
    'use strict';

    var DB_NAME = 'chat-data';
    var STORE = 'files';
    var db = null;

    // ═══ IndexedDB ═══
    function openDB() {
        return new Promise(function(resolve, reject) {
            if (db) return resolve(db);
            var r = indexedDB.open(DB_NAME, 1);
            r.onupgradeneeded = function() {
                if (!r.result.objectStoreNames.contains(STORE)) {
                    r.result.createObjectStore(STORE, { keyPath: 'path' });
                }
            };
            r.onsuccess = function() { db = r.result; resolve(db); };
            r.onerror = function() { reject(r.error); };
        });
    }

    function storeFile(path, data, mime) {
        return openDB().then(function(d) {
            return new Promise(function(resolve, reject) {
                var tx = d.transaction(STORE, 'readwrite');
                tx.objectStore(STORE).put({ path: path, data: data, mime: mime });
                tx.oncomplete = resolve;
                tx.onerror = function() { reject(tx.error); };
            });
        });
    }

    function getFile(path) {
        return openDB().then(function(d) {
            return new Promise(function(resolve) {
                var tx = d.transaction(STORE, 'readonly');
                var req = tx.objectStore(STORE).get(path);
                req.onsuccess = function() { resolve(req.result || null); };
                req.onerror = function() { resolve(null); };
            });
        });
    }

    function hasData() {
        return openDB().then(function(d) {
            return new Promise(function(resolve) {
                var tx = d.transaction(STORE, 'readonly');
                var req = tx.objectStore(STORE).count();
                req.onsuccess = function() { resolve(req.result > 0); };
                req.onerror = function() { resolve(false); };
            });
        });
    }

    function clearData() {
        return openDB().then(function(d) {
            return new Promise(function(resolve) {
                var tx = d.transaction(STORE, 'readwrite');
                tx.objectStore(STORE).clear();
                tx.oncomplete = resolve;
            });
        });
    }

    // ═══ MIME ═══
    function mimeType(path) {
        var ext = (path || '').split('.').pop().toLowerCase();
        var map = { json:'application/json', jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', webp:'image/webp', gif:'image/gif', mp4:'video/mp4', mp3:'audio/mpeg', svg:'image/svg+xml' };
        return map[ext] || 'application/octet-stream';
    }

    // ═══ Fetch 拦截 ═══
    var networkFetch = window.fetch.bind(window);

    window.fetch = function(input, init) {
        var req = input instanceof Request ? input : null;
        var method = req ? req.method : (init && init.method ? init.method : 'GET');
        var rawUrl = req ? req.url : (typeof input === 'string' ? input : input.url);
        var url = new URL(rawUrl, location.href);

        if (method !== 'GET' || url.origin !== location.origin) {
            return networkFetch(input, init);
        }

        var path = decodeURIComponent(url.pathname.replace(/^\//, ''));

        // /data/* → IndexedDB
        if (path.startsWith('data/')) {
            return getFile(path).then(function(file) {
                if (file) {
                    return new Response(file.data, {
                        status: 200,
                        headers: { 'Content-Type': file.mime || mimeType(path) }
                    });
                }
                if (path.indexOf('messages/') !== -1) {
                    return new Response('{"messages":[],"hasMore":false,"total":0}', {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' }
                    });
                }
                return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
            });
        }

        // Avatar files → IndexedDB or placeholder
        if (path === 'avatar_me.jpg' || path === 'avatar_contact.jpg' || path === 'avatar_even.jpg') {
            return getFile(path).then(function(file) {
                if (!file && path === 'avatar_even.jpg') return getFile('avatar_contact.jpg');
                if (!file && path === 'avatar_contact.jpg') return getFile('avatar_even.jpg');
                if (file) {
                    return new Response(file.data, {
                        status: 200,
                        headers: { 'Content-Type': file.mime || 'image/jpeg' }
                    });
                }
                // Placeholder SVG
                var isMe = path === 'avatar_me.jpg';
                var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">' +
                    '<rect width="120" height="120" fill="' + (isMe ? '#07c160' : '#576b95') + '" rx="8"/>' +
                    '<text x="60" y="72" text-anchor="middle" font-size="48" font-family="sans-serif" fill="white">' + (isMe ? '我' : 'Ta') + '</text></svg>';
                return new Response(svg, { status: 200, headers: { 'Content-Type': 'image/svg+xml' } });
            });
        }

        // /api/media/* → IndexedDB
        if (path.startsWith('api/media/')) {
            var mediaPath = path.replace('api/media/', '');
            return getFile('data/media/' + mediaPath).then(function(file) {
                if (file) return new Response(file.data, { status: 200, headers: { 'Content-Type': file.mime || mimeType(mediaPath) } });
                return getFile(mediaPath).then(function(f2) {
                    if (f2) return new Response(f2.data, { status: 200, headers: { 'Content-Type': f2.mime || mimeType(mediaPath) } });
                    return new Response('', { status: 404 });
                });
            });
        }

        return networkFetch(input, init);
    };

    // ═══ UI ═══
    var $ = document.querySelector.bind(document);

    function el(id) { return document.getElementById(id); }

    function setStatus(msg, isErr) {
        var s = el('import-status');
        s.textContent = msg || '';
        s.className = isErr ? 'error' : '';
    }

    function setProgress(cur, total) {
        var pct = Math.round(cur / total * 100);
        var pb = el('import-progress');
        var pt = el('import-progress-text');
        pb.style.display = 'block';
        pb.value = pct;
        pt.style.display = 'block';
        pt.textContent = cur + ' / ' + total;
    }

    function hideImport() {
        el('import-overlay').style.display = 'none';
        el('app').style.display = 'flex';
    }

    // ═══ ZIP 导入 ═══
    function importZip(file) {
        if (typeof JSZip === 'undefined') {
            setStatus('JSZip 未加载，请检查网络后刷新页面', true);
            return Promise.reject(new Error('JSZip not loaded'));
        }
        setStatus('正在解析 ZIP...');
        return JSZip.loadAsync(file).then(function(zip) {
            var entries = [];
            zip.forEach(function(relativePath, zipEntry) {
                if (!zipEntry.dir) entries.push({ path: relativePath, entry: zipEntry });
            });
            if (entries.length === 0) throw new Error('ZIP 中没有文件');
            return clearData().then(function() {
                var total = entries.length;
                var done = 0;
                function processOne(i) {
                    if (i >= total) return Promise.resolve(total);
                    var e = entries[i];
                    return e.entry.async('arraybuffer').then(function(data) {
                        var p = e.path.replace(/\\/g, '/');
                        // Normalize: strip wrapper folder if needed
                        var idx = p.indexOf('/data/');
                        if (idx > 0) p = p.substring(idx + 1);
                        else if (p.indexOf('data/') !== 0 && p.indexOf('/') === -1) {
                            var name = p.split('/').pop();
                            if (name === 'contacts.json' || name === 'dates.json' || name === 'search_index.json') p = 'data/' + name;
                        }
                        return storeFile(p, data, mimeType(p));
                    }).then(function() {
                        done++;
                        if (done % 20 === 0 || done === total) setProgress(done, total);
                        return processOne(i + 1);
                    });
                }
                return processOne(0);
            });
        });
    }

    // ═══ 文件夹导入 ═══
    function importFolder(files) {
        return clearData().then(function() {
            var total = files.length;
            var done = 0;
            function processOne(i) {
                if (i >= total) return Promise.resolve(total);
                var file = files[i];
                var p = (file.webkitRelativePath || file.name).replace(/\\/g, '/');
                // Normalize
                if (p.indexOf('/') === -1) {
                    var n = p.toLowerCase();
                    if (n === 'contacts.json') p = 'data/' + p;
                    else if (n === 'dates.json') p = 'data/' + p;
                    else if (n === 'search_index.json') p = 'data/' + p;
                    else if (n.startsWith('page_') && n.endsWith('.json')) p = 'data/messages/' + p;
                }
                return file.arrayBuffer().then(function(data) {
                    return storeFile(p, data, mimeType(p));
                }).then(function() {
                    done++;
                    if (done % 10 === 0 || done === total) setProgress(done, total);
                    return processOne(i + 1);
                });
            }
            return processOne(0);
        });
    }

    // ═══ 事件绑定 ═══
    function setupUI() {
        var dz = el('import-dropzone');

        el('btn-select-zip').onclick = function() { el('file-zip').click(); };
        el('file-zip').onchange = function() {
            var f = this.files[0];
            if (!f) return;
            setProgress(0, 1);
            importZip(f).then(function(count) {
                setStatus('导入成功 ' + count + ' 个文件，正在加载...');
                setTimeout(function() { hideImport(); }, 800);
            }).catch(function(e) {
                setStatus('导入失败: ' + (e.message || '未知错误'), true);
            });
        };

        el('btn-select-folder').onclick = function() { el('file-folder').click(); };
        el('file-folder').onchange = function() {
            var files = this.files;
            if (!files.length) return;
            setProgress(0, files.length);
            importFolder(files).then(function(count) {
                setStatus('导入成功 ' + count + ' 个文件，正在加载...');
                setTimeout(function() { hideImport(); }, 800);
            }).catch(function(e) {
                setStatus('导入失败: ' + (e.message || '未知错误'), true);
            });
        };

        // Drag & drop
        dz.ondragover = function(e) { e.preventDefault(); dz.classList.add('drag-over'); };
        dz.ondragleave = function() { dz.classList.remove('drag-over'); };
        dz.ondrop = function(e) {
            e.preventDefault();
            dz.classList.remove('drag-over');
            var f = e.dataTransfer.files[0];
            if (!f) return;
            if (f.name.toLowerCase().endsWith('.zip') || f.type === 'application/zip') {
                setProgress(0, 1);
                importZip(f).then(function(count) {
                    setStatus('导入成功 ' + count + ' 个文件，正在加载...');
                    setTimeout(function() { hideImport(); }, 800);
                }).catch(function(e) {
                    setStatus('导入失败: ' + (e.message || '未知错误'), true);
                });
            } else {
                setStatus('请选择 .zip 格式的数据包', true);
            }
        };

        // Global drop on overlay
        var ov = el('import-overlay');
        ov.ondragover = function(e) { e.preventDefault(); };
        ov.ondrop = function(e) { e.preventDefault(); var f = e.dataTransfer.files[0]; if (f && f.name.toLowerCase().endsWith('.zip')) { el('file-zip').files = e.dataTransfer.files; el('file-zip').onchange(); } };
    }

    // ═══ 启动 ═══
    setupUI();

    // Check if data exists, if so skip import UI
    hasData().then(function(exists) {
        if (exists) {
            hideImport();
        }
        // Otherwise, import overlay stays visible by default
    }).catch(function() {
        // DB error, show import UI (already visible)
    });

})();
