/**
 * direct-import.js — 直接数据导入模块
 * 支持 ZIP 文件导入，存入 IndexedDB，拦截 fetch 从本地提供数据
 * 与 vault.js（WCV2 加密导入）互斥运行
 */
(() => {
    'use strict';

    const DB_NAME = 'wechat-direct-data';
    const DB_VERSION = 1;
    const STORE_NAME = 'files';

    let dbPromise = null;
    let importActive = false;

    // ═══════════════════════════════════════════
    //  IndexedDB
    // ═══════════════════════════════════════════

    function openDB() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                if (!req.result.objectStoreNames.contains(STORE_NAME)) {
                    req.result.createObjectStore(STORE_NAME, { keyPath: 'path' });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        return dbPromise;
    }

    async function storeFile(path, data, mime) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).put({ path, data, mime });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async function getFile(path) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const req = tx.objectStore(STORE_NAME).get(path);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    }

    async function hasData() {
        const db = await openDB();
        return new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const req = tx.objectStore(STORE_NAME).count();
            req.onsuccess = () => resolve(req.result > 0);
            req.onerror = () => resolve(false);
        });
    }

    async function clearAll() {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).clear();
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async function getAllPaths() {
        const db = await openDB();
        return new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const req = tx.objectStore(STORE_NAME).getAllKeys();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => resolve([]);
        });
    }

    // ═══════════════════════════════════════════
    //  MIME 类型推断
    // ═══════════════════════════════════════════

    function getMime(path) {
        const ext = (path || '').split('.').pop().toLowerCase();
        const map = {
            json: 'application/json; charset=utf-8',
            jpg: 'image/jpeg',
            jpeg: 'image/jpeg',
            png: 'image/png',
            webp: 'image/webp',
            gif: 'image/gif',
            mp4: 'video/mp4',
            mp3: 'audio/mpeg',
            svg: 'image/svg+xml',
            ico: 'image/x-icon',
        };
        return map[ext] || 'application/octet-stream';
    }

    // ═══════════════════════════════════════════
    //  Fetch 拦截 — 从 IndexedDB 提供数据
    // ═══════════════════════════════════════════

    function installFetchBridge() {
        const networkFetch = window.fetch.bind(window);
        window.fetch = async function directFetch(input, init) {
            const request = input instanceof Request ? input : null;
            const method = request ? request.method : (init && init.method ? init.method : 'GET');
            const rawUrl = request ? request.url : (typeof input === 'string' ? input : input.url);
            const url = new URL(rawUrl, location.href);

            // Only intercept same-origin GET requests
            if (method.toUpperCase() !== 'GET' || url.origin !== location.origin) {
                return networkFetch(input, init);
            }

            const pathname = url.pathname;

            // Handle /data/* paths
            if (pathname.startsWith('/data/')) {
                const path = pathname.replace(/^\//, '');
                const file = await getFile(path);
                if (file) {
                    return new Response(file.data, {
                        status: 200,
                        headers: { 'Content-Type': file.mime || getMime(path), 'Cache-Control': 'no-store' },
                    });
                }
                // For /data/messages/page_N.json, if not found, return empty
                if (pathname.startsWith('/data/messages/')) {
                    return new Response(JSON.stringify({ messages: [], hasMore: false, total: 0 }), {
                        status: 200,
                        headers: { 'Content-Type': 'application/json; charset=utf-8' },
                    });
                }
                return new Response(JSON.stringify({ error: 'Not found' }), {
                    status: 404,
                    headers: { 'Content-Type': 'application/json; charset=utf-8' },
                });
            }

            // Handle avatar files — serve from IndexedDB or return placeholder SVG
            if (pathname === '/avatar_me.jpg' || pathname === '/avatar_even.jpg') {
                const file = await getFile(pathname.replace(/^\//, ''));
                if (file) {
                    return new Response(file.data, {
                        status: 200,
                        headers: { 'Content-Type': file.mime || 'image/jpeg', 'Cache-Control': 'no-store' },
                    });
                }
                // Fallback: return placeholder SVG avatar
                const isMe = pathname === '/avatar_me.jpg';
                const color = isMe ? '#07c160' : '#576b95';
                const letter = isMe ? '我' : 'Ta';
                const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">
                    <rect width="120" height="120" fill="${color}" rx="8"/>
                    <text x="60" y="72" text-anchor="middle" font-size="48" font-family="sans-serif" fill="white">${letter}</text>
                </svg>`;
                return new Response(svg, {
                    status: 200,
                    headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' },
                });
            }

            // Handle /api/media/* paths (for media files in data package)
            if (pathname.startsWith('/api/media/')) {
                const mediaPath = pathname.replace(/^\/api\/media\//, '');
                // Try various path formats
                const candidates = [
                    `data/media/${mediaPath}`,
                    mediaPath,
                ];
                for (const candidate of candidates) {
                    const file = await getFile(candidate);
                    if (file) {
                        return new Response(file.data, {
                            status: 200,
                            headers: { 'Content-Type': file.mime || getMime(candidate), 'Cache-Control': 'no-store' },
                        });
                    }
                }
            }

            // Fall through to network
            return networkFetch(input, init);
        };
    }

    // ═══════════════════════════════════════════
    //  ZIP 导入
    // ═══════════════════════════════════════════

    async function importZip(file, onProgress) {
        if (typeof JSZip === 'undefined') {
            throw new Error('JSZip 库未加载，请刷新页面后重试');
        }
        if (!file || !file.name) {
            throw new Error('请选择有效的 ZIP 文件');
        }

        const zip = await JSZip.loadAsync(file);
        const entries = Object.entries(zip.files).filter(([, f]) => !f.dir);
        const total = entries.length;

        if (total === 0) {
            throw new Error('ZIP 文件中没有找到数据文件');
        }

        // Check for required files in the zip
        const paths = entries.map(([p]) => p);
        const hasContacts = paths.some(p => p.endsWith('contacts.json'));
        const hasMessages = paths.some(p => p.includes('messages/'));
        if (!hasContacts) {
            throw new Error('ZIP 中未找到 contacts.json。请确认数据文件夹结构正确。');
        }
        if (!hasMessages) {
            throw new Error('ZIP 中未找到消息文件 (messages/*.json)。请确认数据文件夹结构正确。');
        }

        // Clear existing data
        await clearAll();

        let processed = 0;
        for (const [zipPath, zipEntry] of entries) {
            // Normalize path: strip any top-level folder, ensure data/ prefix
            let normalizedPath = zipPath.replace(/\\/g, '/');

            // If the zip has a top-level folder (e.g., "data/contacts.json" or "letter22-data/..."),
            // keep paths that start with "data/" as-is; for others (like avatar_me.jpg at root
            // or inside a wrapper folder), normalize to root level
            if (!normalizedPath.startsWith('data/')) {
                // Check if it's an avatar or root file
                const filename = normalizedPath.split('/').pop();
                if (filename === 'avatar_me.jpg' || filename === 'avatar_even.jpg' ||
                    filename === 'icon-192.png' || filename === 'icon-512.png') {
                    normalizedPath = filename;
                } else if (normalizedPath.includes('/data/')) {
                    // Strip wrapper folder: "something/data/messages/..." → "data/messages/..."
                    const idx = normalizedPath.indexOf('/data/');
                    normalizedPath = normalizedPath.substring(idx + 1);
                }
                // else keep as-is for other files
            }

            const mime = getMime(normalizedPath);
            const data = await zipEntry.async('arraybuffer');
            await storeFile(normalizedPath, data, mime);

            processed++;
            if (onProgress && (processed % 10 === 0 || processed === total)) {
                onProgress(processed, total);
            }
        }

        if (onProgress) onProgress(total, total);
        return total;
    }

    // ═══════════════════════════════════════════
    //  文件选择导入（无需 ZIP）
    // ═══════════════════════════════════════════

    async function importFiles(fileList, onProgress) {
        const files = Array.from(fileList);
        if (files.length === 0) throw new Error('请选择文件');

        const total = files.length;
        let processed = 0;

        // Detect if this is a contacts.json at root → store as data/contacts.json
        for (const file of files) {
            let path = file.webkitRelativePath || file.name;
            path = path.replace(/\\/g, '/');

            // If no directory structure, infer from filename
            if (!path.includes('/')) {
                const name = path.toLowerCase();
                if (name === 'contacts.json' || name.startsWith('contact')) {
                    path = 'data/contacts.json';
                } else if (name === 'dates.json') {
                    path = 'data/dates.json';
                } else if (name === 'search_index.json') {
                    path = 'data/search_index.json';
                } else if (name.startsWith('page_') && name.endsWith('.json')) {
                    path = 'data/messages/' + path;
                } else if (name === 'avatar_me.jpg' || name === 'avatar_even.jpg') {
                    // keep as-is
                }
            }

            const mime = getMime(path);
            const data = await file.arrayBuffer();
            await storeFile(path, data, mime);

            processed++;
            if (onProgress && (processed % 5 === 0 || processed === total)) {
                onProgress(processed, total);
            }
        }

        if (onProgress) onProgress(total, total);
        return total;
    }

    // ═══════════════════════════════════════════
    //  UI
    // ═══════════════════════════════════════════

    let uiElements = {};

    function getUI() {
        if (uiElements.overlay) return uiElements;
        uiElements = {
            overlay: document.querySelector('#direct-import-overlay'),
            dropZone: document.querySelector('#direct-import-dropzone'),
            fileInput: document.querySelector('#direct-import-file'),
            folderInput: document.querySelector('#direct-import-folder'),
            progressBar: document.querySelector('#direct-import-progress'),
            progressText: document.querySelector('#direct-import-progress-text'),
            status: document.querySelector('#direct-import-status'),
            btnZip: document.querySelector('#btn-import-zip'),
            btnFolder: document.querySelector('#btn-import-folder'),
            btnWcv: document.querySelector('#btn-import-wcv'),
        };
        return uiElements;
    }

    function showOverlay() {
        const ui = getUI();
        ui.overlay.style.display = 'flex';
        ui.progressBar.style.display = 'none';
        ui.progressText.style.display = 'none';
        ui.status.textContent = '';
        ui.status.className = '';
    }

    function hideOverlay() {
        const ui = getUI();
        ui.overlay.style.display = 'none';
    }

    function setStatus(msg, isError) {
        const ui = getUI();
        ui.status.textContent = msg || '';
        ui.status.className = isError ? 'error' : '';
    }

    function setProgress(current, total) {
        const ui = getUI();
        const pct = Math.round(current / total * 100);
        ui.progressBar.style.display = 'block';
        ui.progressBar.value = pct;
        ui.progressText.style.display = 'block';
        ui.progressText.textContent = `${current} / ${total} (${pct}%)`;
    }

    function setBusy(busy) {
        const ui = getUI();
        ui.btnZip.disabled = busy;
        ui.btnFolder.disabled = busy;
        ui.btnWcv.disabled = busy;
        ui.fileInput.disabled = busy;
        if (ui.folderInput) ui.folderInput.disabled = busy;
    }

    async function handleZipImport(file) {
        setBusy(true);
        setStatus('正在解压数据包...');
        try {
            const count = await importZip(file, (cur, total) => {
                setProgress(cur, total);
                setStatus(`正在导入 ${cur}/${total} 个文件...`);
            });
            setStatus(`✅ 导入成功！共 ${count} 个文件。即将进入聊天记录...`);
            setTimeout(() => {
                hideOverlay();
                location.reload();
            }, 1200);
        } catch (err) {
            setStatus('❌ ' + (err.message || '导入失败'), true);
        } finally {
            setBusy(false);
        }
    }

    async function handleFolderImport(fileList) {
        setBusy(true);
        setStatus('正在读取文件...');
        try {
            const count = await importFiles(fileList, (cur, total) => {
                setProgress(cur, total);
                setStatus(`正在导入 ${cur}/${total} 个文件...`);
            });
            setStatus(`✅ 导入成功！共 ${count} 个文件。即将进入聊天记录...`);
            setTimeout(() => {
                hideOverlay();
                location.reload();
            }, 1200);
        } catch (err) {
            setStatus('❌ ' + (err.message || '导入失败'), true);
        } finally {
            setBusy(false);
        }
    }

    function switchToWcv() {
        // Let vault.js take over
        window.__directImportActive = false;
        hideOverlay();
        // We need vault.js to show its overlay. Easiest: reload the page.
        // Set a session flag so vault shows on reload
        sessionStorage.setItem('wcv-mode', '1');
        location.reload();
    }

    function installUI() {
        // Insert import overlay HTML
        document.body.insertAdjacentHTML('beforeend', `
            <div id="direct-import-overlay" aria-modal="true" role="dialog" style="display:none">
                <div id="direct-import-dialog">
                    <div class="import-icon">💬</div>
                    <h1 id="import-title">微信聊天记录查看器</h1>
                    <p id="import-description">
                        请导入你的聊天数据包（ZIP 格式）<br>
                        <small>数据仅保存在本机浏览器中，不会上传到任何服务器</small>
                    </p>

                    <div id="direct-import-dropzone">
                        <div class="dropzone-icon">📦</div>
                        <div class="dropzone-text">拖拽 ZIP 文件到此处<br>或点击下方按钮选择文件</div>
                    </div>

                    <div class="import-buttons">
                        <input type="file" id="direct-import-file" accept=".zip,application/zip" style="display:none">
                        <button id="btn-import-zip" type="button" class="import-btn primary">📦 选择 ZIP 数据包</button>
                        <input type="file" id="direct-import-folder" webkitdirectory multiple style="display:none">
                        <button id="btn-import-folder" type="button" class="import-btn">📁 选择数据文件夹</button>
                    </div>

                    <progress id="direct-import-progress" max="100" value="0" style="display:none"></progress>
                    <div id="direct-import-progress-text" style="display:none"></div>
                    <div id="direct-import-status" role="status"></div>

                    <div class="import-footer">
                        <span>已有加密离线包？</span>
                        <button id="btn-import-wcv" type="button" class="link-btn">使用 .wcv 加密导入</button>
                    </div>
                </div>
            </div>
        `);

        const ui = getUI();

        // Event: ZIP file select
        ui.btnZip.addEventListener('click', () => ui.fileInput.click());
        ui.fileInput.addEventListener('change', () => {
            const file = ui.fileInput.files[0];
            if (file) handleZipImport(file);
        });

        // Event: folder select
        ui.btnFolder.addEventListener('click', () => ui.folderInput.click());
        ui.folderInput.addEventListener('change', () => {
            if (ui.folderInput.files.length > 0) {
                handleFolderImport(ui.folderInput.files);
            }
        });

        // Event: switch to WCV2
        ui.btnWcv.addEventListener('click', switchToWcv);

        // Drag and drop
        const dz = ui.dropZone;
        dz.addEventListener('dragover', (e) => {
            e.preventDefault();
            dz.classList.add('drag-over');
        });
        dz.addEventListener('dragleave', () => {
            dz.classList.remove('drag-over');
        });
        dz.addEventListener('drop', (e) => {
            e.preventDefault();
            dz.classList.remove('drag-over');
            const file = e.dataTransfer.files[0];
            if (file) {
                if (file.name.endsWith('.zip') || file.type === 'application/zip') {
                    handleZipImport(file);
                } else {
                    setStatus('请选择 .zip 格式的数据包文件', true);
                }
            }
        });

        // Also allow drop anywhere on overlay
        ui.overlay.addEventListener('dragover', (e) => { e.preventDefault(); });
        ui.overlay.addEventListener('drop', (e) => {
            e.preventDefault();
            const file = e.dataTransfer.files[0];
            if (file && (file.name.endsWith('.zip') || file.type === 'application/zip')) {
                handleZipImport(file);
            }
        });
    }

    // ═══════════════════════════════════════════
    //  启动
    // ═══════════════════════════════════════════

    // Immediately prevent vault.js from initializing (it checks this flag).
    // Will be cleared later if WCV2 mode selected or direct data already loaded.
    window.__directImportShowing = true;

    // Always install the fetch bridge synchronously, before app.js runs.
    // The bridge checks IndexedDB on each request; if data isn't loaded yet,
    // it returns empty responses. This prevents stale network requests.
    installFetchBridge();

    async function boot() {
        // Check if WCV2 mode was requested via sessionStorage
        const wcvMode = sessionStorage.getItem('wcv-mode');
        if (wcvMode === '1') {
            sessionStorage.removeItem('wcv-mode');
            // Let vault.js handle initialization
            window.__directImportShowing = false;
            window.__directImportActive = false;
            return;
        }

        try {
            const dataExists = await hasData();

            if (dataExists) {
                // Data already imported → signal vault.js to skip, hide import overlay
                window.__directImportShowing = false;
                window.__directImportActive = true;
                installUI();
                return;
            }
        } catch (e) {
            console.warn('direct-import: IndexedDB check failed:', e);
        }

        // No data yet → show import UI (__directImportShowing already true)
        window.__directImportActive = false;
        installUI();
        showOverlay();
    }

    // Expose for menu access
    window.DirectImport = {
        show: showOverlay,
        hide: hideOverlay,
        hasData,
        clearAll,
        getAllPaths,
    };

    boot().catch((err) => {
        console.error('direct-import boot failed:', err);
    });
})();
