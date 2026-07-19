/* Encrypted offline vault. Plaintext is held only in memory after password unlock. */
(() => {
    'use strict';

    const DB_NAME = 'wcv-secure-vault';
    const DB_VERSION = 1;
    const PACKAGE_STORE = 'packages';
    const RESOURCE_STORE = 'resources';
    const MAGIC = 'WCV2';
    const MAX_HEADER_BYTES = 64 * 1024;
    const MAX_RECORDS = 200000;
    const MAX_RECORD_BYTES = 1024 * 1024 * 1024;
    const textEncoder = new TextEncoder();
    const textDecoder = new TextDecoder();

    let databasePromise;
    let activeSession = null;
    let unlockGate = createDeferred();
    let cachedPackage = null;

    function createDeferred() {
        let resolve;
        const promise = new Promise((done) => { resolve = done; });
        return { promise, resolve };
    }

    function requestResult(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('本地数据库操作失败'));
        });
    }

    function transactionDone(transaction) {
        return new Promise((resolve, reject) => {
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error || new Error('本地数据库操作失败'));
            transaction.onabort = () => reject(transaction.error || new Error('本地数据库操作已取消'));
        });
    }

    function openDatabase() {
        if (databasePromise) return databasePromise;
        databasePromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(PACKAGE_STORE)) {
                    db.createObjectStore(PACKAGE_STORE, { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains(RESOURCE_STORE)) {
                    const resources = db.createObjectStore(RESOURCE_STORE, { keyPath: 'key' });
                    resources.createIndex('packageId', 'packageId', { unique: false });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('无法打开加密数据仓库'));
        });
        return databasePromise;
    }

    async function put(storeName, value) {
        const db = await openDatabase();
        const transaction = db.transaction(storeName, 'readwrite');
        transaction.objectStore(storeName).put(value);
        await transactionDone(transaction);
    }

    async function get(storeName, key) {
        const db = await openDatabase();
        const transaction = db.transaction(storeName, 'readonly');
        const value = await requestResult(transaction.objectStore(storeName).get(key));
        await transactionDone(transaction);
        return value;
    }

    async function getReadyPackage() {
        const db = await openDatabase();
        const transaction = db.transaction(PACKAGE_STORE, 'readonly');
        const packages = await requestResult(transaction.objectStore(PACKAGE_STORE).getAll());
        await transactionDone(transaction);
        return packages
            .filter((item) => item.status === 'ready')
            .sort((a, b) => b.importedAt - a.importedAt)[0] || null;
    }

    async function deletePackage(packageId) {
        const db = await openDatabase();
        const transaction = db.transaction([PACKAGE_STORE, RESOURCE_STORE], 'readwrite');
        const packages = transaction.objectStore(PACKAGE_STORE);
        const resources = transaction.objectStore(RESOURCE_STORE);
        const index = resources.index('packageId');
        packages.delete(packageId);
        index.openCursor(IDBKeyRange.only(packageId)).onsuccess = (event) => {
            const cursor = event.target.result;
            if (!cursor) return;
            resources.delete(cursor.primaryKey);
            cursor.continue();
        };
        await transactionDone(transaction);
    }

    async function clearOtherPackages(keepId) {
        const db = await openDatabase();
        const transaction = db.transaction(PACKAGE_STORE, 'readonly');
        const packages = await requestResult(transaction.objectStore(PACKAGE_STORE).getAll());
        await transactionDone(transaction);
        for (const item of packages) {
            if (item.id !== keepId) await deletePackage(item.id);
        }
    }

    function bytesToBase64(bytes) {
        let binary = '';
        const data = new Uint8Array(bytes);
        for (let index = 0; index < data.length; index += 0x8000) {
            binary += String.fromCharCode(...data.subarray(index, index + 0x8000));
        }
        return btoa(binary);
    }

    function base64ToBytes(value) {
        if (typeof value !== 'string' || !value) throw new Error('离线包缺少加密盐值');
        const binary = atob(value);
        return Uint8Array.from(binary, (char) => char.charCodeAt(0));
    }

    function validateHeader(header) {
        if (!header || header.format !== 2 || header.kdf !== 'PBKDF2-SHA256') {
            throw new Error('不是受支持的加密离线包');
        }
        if (!/^[a-f0-9]{32}$/i.test(header.id || '')) throw new Error('离线包标识无效');
        if (!Number.isInteger(header.iterations) || header.iterations < 100000 || header.iterations > 5000000) {
            throw new Error('离线包密码参数无效');
        }
        if (!Number.isInteger(header.recordCount) || header.recordCount < 2 || header.recordCount > MAX_RECORDS) {
            throw new Error('离线包记录数量无效');
        }
        if (base64ToBytes(header.salt).length < 16) throw new Error('离线包盐值无效');
    }

    async function parsePackageHeader(file) {
        if (!(file instanceof File) || file.size < 24) throw new Error('请选择有效的 .wcv 加密离线包');
        const prefix = new Uint8Array(await file.slice(0, 8).arrayBuffer());
        if (textDecoder.decode(prefix.subarray(0, 4)) !== MAGIC) throw new Error('文件不是 WCV2 加密离线包');
        const headerLength = new DataView(prefix.buffer).getUint32(4, true);
        if (headerLength < 32 || headerLength > MAX_HEADER_BYTES || 8 + headerLength >= file.size) {
            throw new Error('离线包头信息损坏');
        }
        let header;
        try {
            header = JSON.parse(textDecoder.decode(await file.slice(8, 8 + headerLength).arrayBuffer()));
        } catch {
            throw new Error('无法读取离线包头信息');
        }
        validateHeader(header);
        return { header, offset: 8 + headerLength };
    }

    async function readFrame(file, offset) {
        if (offset + 16 > file.size) throw new Error('离线包数据不完整');
        const prefix = new Uint8Array(await file.slice(offset, offset + 16).arrayBuffer());
        const ciphertextLength = new DataView(prefix.buffer).getUint32(0, true);
        if (ciphertextLength < 16 || ciphertextLength > MAX_RECORD_BYTES || offset + 16 + ciphertextLength > file.size) {
            throw new Error('离线包记录长度无效');
        }
        const ciphertext = await file.slice(offset + 16, offset + 16 + ciphertextLength).arrayBuffer();
        return {
            iv: prefix.slice(4, 16),
            ciphertext,
            nextOffset: offset + 16 + ciphertextLength,
        };
    }

    async function deriveKey(password, header) {
        if (!password) throw new Error('请输入数据包密码');
        const passwordMaterial = await crypto.subtle.importKey(
            'raw', textEncoder.encode(password), 'PBKDF2', false, ['deriveKey']
        );
        return crypto.subtle.deriveKey(
            {
                name: 'PBKDF2',
                salt: base64ToBytes(header.salt),
                iterations: header.iterations,
                hash: 'SHA-256',
            },
            passwordMaterial,
            { name: 'AES-GCM', length: 256 },
            false,
            ['decrypt']
        );
    }

    function additionalData(packageId, recordIndex) {
        return textEncoder.encode(`WCV2:${packageId}:${recordIndex}`);
    }

    async function decryptFrame(frame, key, packageId, recordIndex) {
        try {
            return await crypto.subtle.decrypt(
                {
                    name: 'AES-GCM',
                    iv: frame.iv,
                    additionalData: additionalData(packageId, recordIndex),
                    tagLength: 128,
                },
                key,
                frame.ciphertext
            );
        } catch {
            throw new Error('密码错误，或离线包已损坏');
        }
    }

    function validateResourcePath(path) {
        return typeof path === 'string'
            && path.startsWith('data/')
            && !path.includes('..')
            && !path.includes('\\')
            && path.length <= 1024;
    }

    function parseManifest(buffer, header) {
        let manifest;
        try {
            manifest = JSON.parse(textDecoder.decode(buffer));
        } catch {
            throw new Error('离线包资源清单损坏');
        }
        if (!manifest || manifest.format !== 2 || !Array.isArray(manifest.entries)
            || manifest.entries.length !== header.recordCount - 1) {
            throw new Error('离线包资源清单无效');
        }
        const paths = new Set();
        for (const entry of manifest.entries) {
            if (!entry || !validateResourcePath(entry.path) || paths.has(entry.path)) {
                throw new Error('离线包包含无效资源');
            }
            paths.add(entry.path);
        }
        for (const required of ['data/contacts.json', 'data/dates.json', 'data/search_index.json']) {
            if (!paths.has(required)) throw new Error('离线包缺少必要聊天数据');
        }
        return manifest;
    }

    function createSession(metadata, key, manifest) {
        const resources = new Map();
        manifest.entries.forEach((entry, index) => resources.set(entry.path, index + 1));
        return { id: metadata.id, header: metadata.header, key, resources };
    }

    async function checkStorage(requiredBytes) {
        if (!navigator.storage || !navigator.storage.estimate) return;
        const estimate = await navigator.storage.estimate();
        if (estimate.quota && estimate.usage && requiredBytes > estimate.quota - estimate.usage) {
            throw new Error('设备可用空间不足，无法导入该离线包');
        }
    }

    async function importPackage(file, password, onProgress) {
        if (!window.isSecureContext || !crypto.subtle) {
            throw new Error('请使用 HTTPS 打开本页面后再导入加密数据');
        }
        await checkStorage(Math.ceil(file.size * 1.08));
        const parsed = await parsePackageHeader(file);
        const { header } = parsed;
        const key = await deriveKey(password, header);
        let offset = parsed.offset;
        const manifestFrame = await readFrame(file, offset);
        const manifestBuffer = await decryptFrame(manifestFrame, key, header.id, 0);
        const manifest = parseManifest(manifestBuffer, header);
        offset = manifestFrame.nextOffset;

        const metadata = {
            id: header.id,
            header,
            status: 'importing',
            importedAt: Date.now(),
            fileSize: file.size,
        };
        await put(PACKAGE_STORE, metadata);

        try {
            await put(RESOURCE_STORE, {
                key: `${header.id}:0`, packageId: header.id, recordIndex: 0,
                iv: manifestFrame.iv, ciphertext: manifestFrame.ciphertext,
            });
            if (onProgress) onProgress(1, header.recordCount);

            for (let recordIndex = 1; recordIndex < header.recordCount; recordIndex++) {
                const frame = await readFrame(file, offset);
                // Authenticate every record before persisting it; plaintext is discarded immediately.
                await decryptFrame(frame, key, header.id, recordIndex);
                await put(RESOURCE_STORE, {
                    key: `${header.id}:${recordIndex}`,
                    packageId: header.id,
                    recordIndex,
                    iv: frame.iv,
                    ciphertext: frame.ciphertext,
                });
                offset = frame.nextOffset;
                if (onProgress && (recordIndex % 8 === 0 || recordIndex === header.recordCount - 1)) {
                    onProgress(recordIndex + 1, header.recordCount);
                }
            }
            if (offset !== file.size) throw new Error('离线包包含未识别的数据');

            metadata.status = 'ready';
            metadata.importedAt = Date.now();
            await put(PACKAGE_STORE, metadata);
            await clearOtherPackages(header.id);
            if (navigator.storage && navigator.storage.persist) {
                try { await navigator.storage.persist(); } catch { /* Best effort only. */ }
            }
            cachedPackage = metadata;
            activeSession = createSession(metadata, key, manifest);
            unlockGate.resolve(activeSession);
            return activeSession;
        } catch (error) {
            await deletePackage(header.id);
            throw error;
        }
    }

    async function unlock(password) {
        const metadata = cachedPackage || await getReadyPackage();
        if (!metadata) throw new Error('请先导入加密离线包');
        const manifestRecord = await get(RESOURCE_STORE, `${metadata.id}:0`);
        if (!manifestRecord) throw new Error('本机离线包不完整，请重新导入');
        const key = await deriveKey(password, metadata.header);
        const manifestBuffer = await decryptFrame(
            { iv: new Uint8Array(manifestRecord.iv), ciphertext: manifestRecord.ciphertext },
            key,
            metadata.id,
            0
        );
        const manifest = parseManifest(manifestBuffer, metadata.header);
        cachedPackage = metadata;
        activeSession = createSession(metadata, key, manifest);
        unlockGate.resolve(activeSession);
        return activeSession;
    }

    async function readResource(path) {
        const session = activeSession || await unlockGate.promise;
        const resourceIndex = session.resources.get(path);
        if (!Number.isInteger(resourceIndex)) throw new Error('离线包中不存在该资源');
        const record = await get(RESOURCE_STORE, `${session.id}:${resourceIndex}`);
        if (!record) throw new Error('本机离线数据不完整，请重新导入');
        return decryptFrame(
            { iv: new Uint8Array(record.iv), ciphertext: record.ciphertext },
            session.key,
            session.id,
            resourceIndex
        );
    }

    function contentType(path) {
        if (path.endsWith('.json')) return 'application/json; charset=utf-8';
        if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
        if (path.endsWith('.png')) return 'image/png';
        if (path.endsWith('.webp')) return 'image/webp';
        if (path.endsWith('.mp4')) return 'video/mp4';
        if (path.endsWith('.mp3')) return 'audio/mpeg';
        return 'application/octet-stream';
    }

    async function encryptedResponse(path) {
        try {
            const body = await readResource(path);
            return new Response(body, {
                status: 200,
                headers: { 'Content-Type': contentType(path), 'Cache-Control': 'no-store' },
            });
        } catch (error) {
            return new Response(JSON.stringify({ error: error.message }), {
                status: error.message.includes('不存在') ? 404 : 422,
                headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
            });
        }
    }

    async function encryptedMediaResponse(rawPath) {
        const session = activeSession || await unlockGate.promise;
        const normalized = String(rawPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
        if (!normalized || normalized.includes('..')) throw new Error('媒体路径无效');
        const filename = normalized.split('/').pop();
        const candidates = [
            normalized,
            `data/${normalized}`,
            `data/media/${normalized}`,
        ];
        let resourcePath = candidates.find((path) => session.resources.has(path));
        if (!resourcePath && filename) {
            const matches = [...session.resources.keys()].filter((path) => path.startsWith('data/media/') && path.endsWith(`/${filename}`));
            if (matches.length === 1) resourcePath = matches[0];
        }
        if (!resourcePath) throw new Error('离线包中不存在该媒体文件');
        const body = await readResource(resourcePath);
        return new Response(body, { status: 200, headers: { 'Content-Type': contentType(resourcePath), 'Cache-Control': 'no-store' } });
    }

    async function mediaUrl(rawPath) {
        const response = await encryptedMediaResponse(rawPath);
        return URL.createObjectURL(await response.blob());
    }

    function installFetchBridge() {
        const networkFetch = window.fetch.bind(window);
        window.fetch = async function secureDataFetch(input, init) {
            const request = input instanceof Request ? input : null;
            const method = request ? request.method : (init && init.method ? init.method : 'GET');
            const rawUrl = request ? request.url : (typeof input === 'string' ? input : input.url);
            const url = new URL(rawUrl, location.href);
            if (method.toUpperCase() === 'GET' && url.origin === location.origin && url.pathname.startsWith('/data/')) {
                const path = decodeURIComponent(url.pathname.replace(/^\//, ''));
                return encryptedResponse(path);
            }
            return networkFetch(input, init);
        };
    }

    function vaultElements() {
        return {
            overlay: document.querySelector('#vault-overlay'),
            title: document.querySelector('#vault-title'),
            description: document.querySelector('#vault-description'),
            password: document.querySelector('#vault-password'),
            file: document.querySelector('#vault-file'),
            importButton: document.querySelector('#btn-vault-import'),
            unlockButton: document.querySelector('#btn-vault-unlock'),
            status: document.querySelector('#vault-status'),
            progress: document.querySelector('#vault-progress'),
            importMenu: document.querySelector('#vault-menu-import'),
            lockMenu: document.querySelector('#vault-menu-lock'),
        };
    }

    function setStatus(message, isError = false) {
        const { status } = vaultElements();
        status.textContent = message || '';
        status.classList.toggle('error', Boolean(isError));
    }

    function setBusy(busy) {
        const elements = vaultElements();
        elements.importButton.disabled = busy;
        elements.unlockButton.disabled = busy;
        elements.file.disabled = busy;
        elements.password.disabled = busy;
    }

    async function showVaultOverlay() {
        const elements = vaultElements();
        cachedPackage = await getReadyPackage();
        elements.overlay.style.display = 'flex';
        elements.password.value = '';
        elements.progress.value = 0;
        elements.progress.style.display = 'none';
        if (cachedPackage) {
            elements.title.textContent = '聊天记录已加密保存';
            elements.description.textContent = '输入数据包密码即可在本机离线查看。导入新文件会替换旧数据。';
            elements.unlockButton.style.display = 'inline-flex';
            elements.importButton.textContent = '替换离线数据包';
        } else {
            elements.title.textContent = '导入加密聊天记录';
            elements.description.textContent = '选择 .wcv 离线包并输入创建该文件时设置的密码。数据仅以密文保存在本机。';
            elements.unlockButton.style.display = 'none';
            elements.importButton.textContent = '导入并解锁';
        }
        setStatus(window.isSecureContext ? '' : '当前不是可信 HTTPS 页面，无法使用加密本地存储。', !window.isSecureContext);
        setBusy(false);
        setTimeout(() => elements.password.focus(), 0);
    }

    function hideVaultOverlay() {
        const { overlay, password, file } = vaultElements();
        password.value = '';
        file.value = '';
        overlay.style.display = 'none';
    }

    async function unlockFromUi() {
        const { password } = vaultElements();
        setBusy(true);
        setStatus('正在验证密码…');
        try {
            await unlock(password.value);
            hideVaultOverlay();
            setStatus('');
        } catch (error) {
            setStatus(error.message || '无法解锁离线数据', true);
        } finally {
            setBusy(false);
        }
    }

    async function importFromUi() {
        const elements = vaultElements();
        const file = elements.file.files && elements.file.files[0];
        if (!file) {
            setStatus('请先选择 .wcv 加密离线包', true);
            return;
        }
        const replacingUnlockedPackage = Boolean(activeSession);
        setBusy(true);
        elements.progress.style.display = 'block';
        setStatus('正在校验加密包…');
        try {
            await importPackage(file, elements.password.value, (current, total) => {
                const percent = Math.floor(current / total * 100);
                elements.progress.value = percent;
                setStatus(`正在安全导入：${current}/${total}（${percent}%）`);
            });
            if (replacingUnlockedPackage) {
                location.reload();
                return;
            }
            hideVaultOverlay();
        } catch (error) {
            setStatus(error.message || '导入失败，请确认文件和密码', true);
        } finally {
            setBusy(false);
        }
    }

    function lockAndReload() {
        activeSession = null;
        cachedPackage = null;
        location.reload();
    }

    function installUi() {
        const dropdown = document.querySelector('#menu-dropdown');
        dropdown.insertAdjacentHTML('beforeend', `
            <div class="menu-item" id="vault-menu-import">🔐 导入加密数据</div>
            <div class="menu-item" id="vault-menu-lock">🔒 锁定记录</div>
        `);
        document.body.insertAdjacentHTML('beforeend', `
            <div id="vault-overlay" aria-modal="true" role="dialog" style="display:none">
                <div id="vault-dialog">
                    <div class="vault-icon">🔐</div>
                    <h1 id="vault-title"></h1>
                    <p id="vault-description"></p>
                    <label class="vault-label" for="vault-password">数据包密码</label>
                    <input id="vault-password" type="password" autocomplete="current-password" placeholder="输入密码，不会保存到设备">
                    <label class="vault-file-label" for="vault-file">选择加密离线包（.wcv）</label>
                    <input id="vault-file" type="file" accept=".wcv,application/octet-stream">
                    <progress id="vault-progress" max="100" value="0" style="display:none"></progress>
                    <div id="vault-status" role="status"></div>
                    <div class="vault-actions">
                        <button id="btn-vault-unlock" type="button">解锁记录</button>
                        <button id="btn-vault-import" type="button">导入并解锁</button>
                    </div>
                </div>
            </div>
        `);
        const elements = vaultElements();
        elements.importButton.addEventListener('click', importFromUi);
        elements.unlockButton.addEventListener('click', unlockFromUi);
        elements.importMenu.addEventListener('click', showVaultOverlay);
        elements.lockMenu.addEventListener('click', lockAndReload);
        elements.password.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                if (cachedPackage) unlockFromUi();
                else importFromUi();
            }
        });
    }

    async function boot() {
        // Skip if direct-import.js is active (ZIP data already imported)
        if (window.__directImportActive) return;
        // Skip if direct-import.js is showing its own overlay
        if (window.__directImportShowing) return;
        // Install before app.js runs so no plaintext /data request reaches the network or Cache Storage.
        installFetchBridge();
        await openDatabase();
        installUi();
        await showVaultOverlay();
    }

    window.WCVault = {
        get readyPackage() { return cachedPackage; },
        lock: lockAndReload,
        mediaUrl,
        bytesToBase64,
    };

    window.addEventListener('pagehide', () => { activeSession = null; });
    boot().catch((error) => {
        console.error('加密离线仓库启动失败:', error);
        document.body.insertAdjacentHTML('beforeend', `<p class="vault-fatal">无法启动加密离线仓库：${error.message}</p>`);
    });
})();
