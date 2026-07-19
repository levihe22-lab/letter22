/**
 * 微信聊天记录查看器 v3.0 - 纯静态 PWA
 * 搜索使用预构建倒排索引，日期跳转使用预计算页码
 */

// ═══════════════════════════════════════════
//  状态
// ═══════════════════════════════════════════

const state = {
    contacts: [],
    currentContact: null,
    messages: [],
    currentPage: 1,
    hasMore: false,
    totalMessages: 0,
    isLoading: false,

    // 搜索
    searchQuery: '',
    searchResults: [],
    searchIndexCache: null,  // 倒排索引缓存

    // 日期跳转
    availableDates: {},
    datePickerYear: new Date().getFullYear(),
    datePickerMonth: new Date().getMonth() + 1,
    datePickerMode: 'calendar',
    dateJumped: null,  // {date: string, startPage: number}
};

// ═══════════════════════════════════════════
//  DOM
// ═══════════════════════════════════════════

const $ = (sel) => document.querySelector(sel);

const dom = {
    btnMenu: $('#btn-menu'),
    btnBack: $('#btn-back'),
    menuDropdown: $('#menu-dropdown'),
    menuDate: $('#menu-date'),
    menuSearch: $('#menu-search'),
    searchPanelInput: document.getElementById('search-panel-input'),
    searchBar: $('#search-bar'),
    searchStatus: $('#search-status'),
    searchPanel: $('#search-panel'),
    searchList: $('#search-list'),
    searchResultTitle: $('#search-result-title'),
    searchCancel: document.getElementById('search-panel-cancel'),
    chatArea: $('#chat-area'),
    messagesList: $('#messages-list'),
    loadMore: $('#load-more'),
    btnLoadMore: $('#btn-load-more'),
    emptyHint: $('#empty-hint'),
    imageOverlay: $('#image-overlay'),
    imagePreview: $('#image-preview'),
    imageClose: $('#image-close'),
    videoOverlay: $('#video-overlay'),
    videoPreview: $('#video-preview'),
    videoClose: $('#video-close'),
    datePanel: $('#date-panel'),
    dateYearMonth: $('#date-year-month'),
    dateGrid: $('#date-grid'),
    datePrevMonth: $('#date-prev-month'),
    dateNextMonth: $('#date-next-month'),
    dateCloseBtn: $('#date-close-btn'),
    dateJumpLatest: $('#date-jump-latest'),
};

// ═══════════════════════════════════════════
//  工具函数
// ═══════════════════════════════════════════

function formatDate(ts) {
    const d = new Date(ts * 1000);
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日`;
    if (d.toDateString() === now.toDateString()) return '今天';
    if (d.toDateString() === yesterday.toDateString()) return '昨天 ' + dateStr;
    // Show year only for different years
    const thisYear = now.getFullYear();
    if (d.getFullYear() !== thisYear) return dateStr;
    return `${d.getMonth()+1}月${d.getDate()}日`;
}

function formatTime(ts) {
    const d = new Date(ts * 1000);
    return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function formatDateTime(ts) {
    const d = new Date(ts * 1000);
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const time = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    const dateStr = `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日`;
    if (d.toDateString() === now.toDateString()) return `今天 ${time}`;
    if (d.toDateString() === yesterday.toDateString()) return `昨天 ${time}`;
    if (d.getFullYear() !== now.getFullYear()) return `${dateStr} ${time}`;
    return `${d.getMonth()+1}月${d.getDate()}日 ${time}`;
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function highlightText(text, query) {
    if (!query) return escapeHtml(text);
    const escaped = escapeHtml(text);
    const q = escapeHtml(query);
    const re = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return escaped.replace(re, '<span class="highlight">$1</span>');
}

function formatFileSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return bytes + 'B';
    if (bytes < 1024*1024) return (bytes/1024).toFixed(1) + 'KB';
    if (bytes < 1024*1024*1024) return (bytes/(1024*1024)).toFixed(1) + 'MB';
    return (bytes/(1024*1024*1024)).toFixed(1) + 'GB';
}

function tokenize(text) {
    const cleaned = String(text).toLowerCase().replace(/[^一-鿿\w]/g, ' ');
    const tokens = new Set();
    // Single Chinese characters (for single-word search)
    for (let i = 0; i < cleaned.length; i++) {
        const ch = cleaned[i];
        if (ch >= '一' && ch <= '鿿') tokens.add(ch);
    }
    // Chinese bigrams (for better precision)
    for (let i = 0; i < cleaned.length - 1; i++) {
        const ch = cleaned[i], next = cleaned[i+1];
        if (ch >= '一' && ch <= '鿿' && next >= '一' && next <= '鿿') {
            tokens.add(ch + next);
        }
    }
    // English/word tokens (also single chars)
    cleaned.split(/\s+/).filter(w => w.length >= 1).forEach(w => tokens.add(w));
    return [...tokens];
}

// ═══════════════════════════════════════════
//  数据加载 API
// ═══════════════════════════════════════════

function toMsg(m) {
    return {
        timestamp: m.t || m.timestamp || 0,
        type: m.y || m.type || 1,
        isSender: m.s !== undefined ? m.s : m.isSender,
        content: m.c !== undefined ? m.c : (m.content || ''),
        extra: m.e !== undefined ? m.e : (m.extra || {}),
    };
}

async function api(url) {
    const u = new URL(url, location.origin);
    const path = u.pathname;
    const params = Object.fromEntries(u.searchParams);

    // Contacts
    if (path === '/api/contacts') {
        const res = await fetch('/data/contacts.json');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
    }

    // Messages — load a single page
    if (path.startsWith('/api/messages/')) {
        const reqPage = parseInt(params.page) || 1;
        const res = await fetch('/data/messages/page_' + reqPage + '.json');
        if (!res.ok) {
            if (res.status === 404) return { messages: [], hasMore: false, total: 0 };
            throw new Error('HTTP ' + res.status);
        }
        const data = await res.json();
        return {
            messages: data.messages.map(toMsg),
            hasMore: data.hasMore,
            total: data.total,
        };
    }

    // Dates
    if (path.startsWith('/api/dates/')) {
        const res = await fetch('/data/dates.json');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
    }

    // Contact detail (minimal — no stats)
    if (path.startsWith('/api/contact/')) {
        const res = await fetch('/data/contacts.json');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const contacts = await res.json();
        const contactId = path.split('/').pop();
        return contacts.find(c => c.id === contactId) || null;
    }

    throw new Error('Unknown API: ' + path);
}

async function loadContacts() {
    state.contacts = await api('/api/contacts');
    if (state.contacts.length > 0 && !state.currentContact) {
        state.currentContact = state.contacts[0];
    }
}

async function loadMessages(contactId, page = 1, append = false) {
    if (state.isLoading) return;
    state.isLoading = true;
    if (dom.btnLoadMore) dom.btnLoadMore.disabled = true;

    const anchor = append && state.messages.length > 0 ? state.messages[0].timestamp : null;

    try {
        const data = await api(`/api/messages/${contactId}?page=${page}&size=50`);
        state.currentPage = page;
        state.hasMore = data.hasMore;
        state.totalMessages = data.total;

        if (append) {
            state.messages = [...data.messages, ...state.messages];
        } else {
            state.messages = data.messages;
        }

        if (anchor) dom.chatArea.classList.add('no-smooth-scroll');
        renderMessages();
        updateLoadMore();

        if (anchor) {
            requestAnimationFrame(() => {
                const el = dom.messagesList.querySelector(`[data-ts="${anchor}"]`);
                if (el) el.scrollIntoView({ block: 'start' });
                requestAnimationFrame(() => dom.chatArea.classList.remove('no-smooth-scroll'));
            });
        }
    } finally {
        state.isLoading = false;
        if (dom.btnLoadMore) dom.btnLoadMore.disabled = false;
    }
}

// ═══════════════════════════════════════════
//  搜索 — 基于预构建倒排索引
// ═══════════════════════════════════════════

async function loadSearchIndex() {
    if (state.searchIndexCache) return state.searchIndexCache;
    const res = await fetch('/data/search_index.json');
    state.searchIndexCache = await res.json();
    return state.searchIndexCache;
}

async function searchMessages(contactId, query) {
    if (!query.trim()) {
        state.searchResults = [];
        hideSearchPanel();
        renderMessages();
        return;
    }
    state.searchQuery = query;

    try {
        const idx = await loadSearchIndex();
        const tokens = tokenize(query);

        // Find matching message IDs (intersection of token matches)
        let matchedIds = null;
        for (const token of tokens) {
            const ids = idx.index[token];
            if (!ids) { matchedIds = []; break; }
            if (matchedIds === null) {
                matchedIds = new Set(ids);
            } else {
                matchedIds = new Set([...matchedIds].filter(id => ids.includes(id)));
            }
        }

        // Convert to results with previews
        const results = [];
        for (const id of (matchedIds || [])) {
            const m = idx.messages[id];
            if (!m) continue;
            results.push({
                msgId: id,
                page: m.p,
                localIndex: m.i,
                msg: {
                    timestamp: m.ts,
                    type: m.y,
                    isSender: m.s,
                    content: m.c,
                    extra: {},
                },
            });
            if (results.length >= 999) break;
        }

        // Sort by timestamp descending
        results.sort((a, b) => b.msg.timestamp - a.msg.timestamp);

        state.searchResults = results;
        renderSearchPanel();
    } catch (e) {
        console.error('Search failed:', e);
        state.searchResults = [];
        renderSearchPanel();
    }
}

// ═══════════════════════════════════════════
//  渲染
// ═══════════════════════════════════════════

function renderMessages() {
    dom.messagesList.innerHTML = '';

    if (state.messages.length === 0 && !state.searchQuery) {
        dom.emptyHint.style.display = 'block';
        return;
    }
    dom.emptyHint.style.display = 'none';

    // Build set of timestamps matching search
    const searchMatchTs = new Set(
        state.searchResults.map(r => r.msg.timestamp)
    );

    let lastDate = null;
    let prevTs = null;

    state.messages.forEach((msg, i) => {
        const showTime = i === 0 || (prevTs !== null && msg.timestamp - prevTs > 180);
        if (showTime) {
            const timeDiv = document.createElement('div');
            timeDiv.className = 'time-divider';
            timeDiv.innerHTML = `<span>${formatDateTime(msg.timestamp)}</span>`;
            dom.messagesList.appendChild(timeDiv);
        }
        prevTs = msg.timestamp;

        const msgDate = formatDate(msg.timestamp);
        if (msgDate !== lastDate) {
            lastDate = msgDate;
            const divider = document.createElement('div');
            divider.className = 'date-divider';
            divider.innerHTML = `<span>${msgDate}</span>`;
            dom.messagesList.appendChild(divider);
        }

        const row = createMessageRow(msg, i, searchMatchTs.has(msg.timestamp));
        dom.messagesList.appendChild(row);
    });

    if (state.currentPage === 1 && !state.searchQuery) {
        setTimeout(() => { dom.chatArea.scrollTop = dom.chatArea.scrollHeight; }, 50);
    }
}

function createMessageRow(msg, index, isSearchMatch) {
    const row = document.createElement('div');

    if (msg.type === 10000) {
        row.className = 'msg-row system';
        row.innerHTML = `<div class="msg-bubble"><span class="text">${escapeHtml(msg.content || '')}</span></div>`;
        return row;
    }

    let showAsSent = !msg.isSender;
    row.className = `msg-row ${showAsSent ? 'sent' : 'received'}`;
    if (isSearchMatch) row.className += ' search-match';
    row.dataset.msgIndex = index;
    row.dataset.ts = msg.timestamp;

    const avatar = document.createElement('img');
    avatar.className = 'msg-avatar';
    avatar.alt = msg.isSender ? (state.myName || '我') : (state.currentContact?.name || state.currentContact?.remark || 'Ta');
    // Load via fetch so IndexedDB interceptor can serve it
    const avatarPath = msg.isSender ? 'avatar_me.jpg' : 'avatar_contact.jpg';
    fetch(avatarPath).then(r => { if (r.ok) return r.blob(); throw new Error('not found'); })
        .then(blob => { avatar.src = URL.createObjectURL(blob); })
        .catch(() => {
            const isMe = msg.isSender;
            avatar.src = 'data:image/svg+xml,' + encodeURIComponent(
                '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80">' +
                '<rect width="80" height="80" fill="' + (isMe ? '#07c160' : '#576b95') + '" rx="6"/>' +
                '<text x="40" y="48" text-anchor="middle" font-size="32" font-family="sans-serif" fill="white">' + (isMe ? '我' : 'Ta') + '</text></svg>'
            );
        });
    row.appendChild(avatar);

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';

    const content = msg.content || '';
    const extra = msg.extra || {};
    const query = state.searchQuery;

    switch (msg.type) {
        case 1: bubble.appendChild(buildText(content, query)); break;
        case 3: buildImageBubble(bubble, msg); break;
        case 34: buildVoiceBubble(bubble, msg, showAsSent); break;
        case 42: buildCardBubble(bubble, extra); break;
        case 43: buildVideoBubble(bubble, msg); break;
        case 47: buildEmojiBubble(bubble, content); break;
        case 48: buildPositionBubble(bubble, extra); break;
        case 49: buildAppMessageBubble(bubble, msg, extra, content, query); break;
        case 50: buildVoipBubble(bubble, content, extra); break;
        default: bubble.appendChild(buildText(content, query));
    }

    row.appendChild(bubble);
    return row;
}

// ── 各类型消息构建 ─────────────────────

function buildText(content, query) {
    const span = document.createElement('span');
    span.className = 'text';
    span.innerHTML = highlightText(content || '', query);
    return span;
}

function buildImageBubble(bubble, msg) {
    if (msg.mediaPath) {
        const img = document.createElement('img');
        img.className = 'msg-image';
        img.src = `/api/media/${msg.mediaPath}`;
        img.addEventListener('click', () => openImagePreview(img.src));
        img.addEventListener('error', () => { img.style.width = '32px'; img.style.height = '32px'; img.style.opacity = '0.4'; });
        bubble.appendChild(img);
    } else {
        const ph = document.createElement('div');
        ph.className = 'msg-image placeholder';
        ph.textContent = '🖼️';
        bubble.appendChild(ph);
    }
}

function buildVoiceBubble(bubble, msg, showAsSent) {
    const voice = document.createElement('div');
    voice.className = 'msg-voice ' + (showAsSent ? 'sent' : 'received');
    const dur = msg.extra?.duration || parseInt(msg.content) || 0;
    const audioText = msg.extra?.audioText || '';
    voice.innerHTML = `<span class="voice-icon">🔊</span><span class="voice-dur">${dur}"</span>`;
    if (audioText) {
        const textDiv = document.createElement('div');
        textDiv.className = 'voice-text';
        textDiv.textContent = audioText;
        voice.appendChild(textDiv);
    }
    voice.addEventListener('click', function() {
        this.classList.toggle('playing');
        setTimeout(() => this.classList.remove('playing'), 2000);
    });
    voice.title = audioText || '语音消息';
    bubble.appendChild(voice);
}

function buildCardBubble(bubble, extra) {
    const card = document.createElement('div');
    card.className = 'msg-card';
    const nickname = extra.cardNickname || '未知';
    const wxid = extra.cardWxid || '';
    card.innerHTML = `<div class="card-avatar">👤</div>
        <div class="card-info">
            <div class="card-name">${escapeHtml(nickname)}</div>
            <div class="card-desc">个人名片</div>
            ${wxid ? `<div class="card-wxid">微信号: ${escapeHtml(wxid)}</div>` : ''}
        </div>`;
    bubble.appendChild(card);
}

function buildVideoBubble(bubble, msg) {
    const video = document.createElement('div');
    video.className = 'msg-video';
    video.innerHTML = '<span class="video-play-icon">▶</span>';
    if (msg.extra?.duration) {
        const dur = msg.extra.duration;
        const durLabel = document.createElement('span');
        durLabel.className = 'video-duration';
        durLabel.textContent = `${Math.floor(dur/60)}:${String(dur%60).padStart(2,'0')}`;
        video.appendChild(durLabel);
    }
    video.addEventListener('click', () => {
        if (msg.mediaPath) openVideoPreview(`/api/media/${msg.mediaPath}`);
    });
    bubble.appendChild(video);
}

function buildEmojiBubble(bubble, content) {
    const emoji = document.createElement('span');
    emoji.className = 'msg-emoji';
    emoji.textContent = (content || '😊').substring(0, 4);
    bubble.appendChild(emoji);
}

function buildPositionBubble(bubble, extra) {
    const pos = document.createElement('div');
    pos.className = 'msg-position';
    pos.innerHTML = `<div class="position-header">
            <span class="position-icon">📍</span>
            <span class="position-name">${escapeHtml(extra.poiname || '未知位置')}</span>
        </div>
        ${extra.label ? `<div class="position-label">${escapeHtml(extra.label)}</div>` : ''}
        <div class="position-map-preview">🗺️ 查看地图</div>`;
    bubble.appendChild(pos);
}

function buildVoipBubble(bubble, content, extra) {
    const voip = document.createElement('div');
    voip.className = 'msg-voip';
    const icon = (extra.inviteType || 1) === 0 ? '📹' : '📞';
    voip.innerHTML = `<span class="voip-icon">${icon}</span> <span class="voip-text">${escapeHtml(content || '通话')}</span>`;
    bubble.appendChild(voip);
}

function buildAppMessageBubble(bubble, msg, extra, content, query) {
    const lower = (content || '').toLowerCase();

    if (extra.quoteText) {
        const quote = document.createElement('div');
        quote.className = 'msg-quote';
        quote.innerHTML = `<div class="quote-reference">${escapeHtml(extra.quoteText).substring(0, 120)}</div>
            <div class="quote-content">${highlightText(content, query)}</div>`;
        bubble.appendChild(quote);
        return;
    }

    if (extra.mergedTitle) {
        const merged = document.createElement('div');
        merged.className = 'msg-merged';
        merged.innerHTML = `<div class="merged-icon">📋</div>
            <div class="merged-title">${escapeHtml(extra.mergedTitle)}</div>
            <div class="merged-count">${extra.mergedCount || '?'} 条聊天记录</div>`;
        bubble.appendChild(merged);
        return;
    }

    if (extra.fileName) {
        const fileDiv = document.createElement('div');
        fileDiv.className = 'msg-file';
        const ext = extra.fileName.split('.').pop().toLowerCase();
        const iconMap = { pdf:'📄', doc:'📃', docx:'📃', xls:'📈', xlsx:'📈', ppt:'📅', pptx:'📅', zip:'📦', rar:'📦', jpg:'🖼', png:'🖼', mp4:'🎬', mp3:'🎵', txt:'📝', md:'📝' };
        const icon = iconMap[ext] || '📎';
        fileDiv.innerHTML = `<span class="file-icon">${icon}</span>
            <div class="file-info">
                <div class="file-name">${escapeHtml(extra.fileName)}</div>
                ${extra.fileSize ? `<div class="file-size">${formatFileSize(extra.fileSize)}</div>` : ''}
            </div>`;
        bubble.appendChild(fileDiv);
        return;
    }

    if (extra.url) {
        const linkCard = document.createElement('div');
        linkCard.className = 'msg-link-card';
        const title = extra.title || content.replace('[链接]', '').trim();
        linkCard.innerHTML = `${extra.coverUrl ? `<img class="link-cover" src="${escapeHtml(extra.coverUrl)}" onerror="this.style.display='none'">` : ''}
            <div class="link-body">
                <div class="link-title">🔗 ${escapeHtml(title)}</div>
                ${extra.description ? `<div class="link-desc">${escapeHtml(extra.description)}</div>` : '<div class="link-desc">点击查看链接内容</div>'}
            </div>`;
        linkCard.addEventListener('click', () => window.open(extra.url, '_blank'));
        bubble.appendChild(linkCard);
        return;
    }

    if (lower.includes('红包') || (content && content.includes('🧧'))) {
        const rp = document.createElement('div');
        rp.className = 'msg-redpacket';
        rp.textContent = content || '🧧 恭喜发财';
        bubble.appendChild(rp);
        return;
    }

    if (lower.includes('转账') || (content && content.includes('💰'))) {
        const tr = document.createElement('div');
        tr.className = 'msg-transfer';
        tr.innerHTML = `<span class="transfer-amount">${escapeHtml(extra.fee || content.replace('💰 ', ''))}</span>`;
        tr.title = extra.memo || '';
        bubble.appendChild(tr);
        return;
    }

    if (lower.includes('小程序') || extra.appName) {
        const mp = document.createElement('div');
        mp.className = 'msg-miniprogram';
        mp.innerHTML = `<span class="mp-icon">📱</span>
            <div class="mp-info">
                <div class="mp-title">${escapeHtml(extra.appName || extra.title || '小程序')}</div>
                <div class="mp-desc">小程序</div>
            </div>`;
        bubble.appendChild(mp);
        return;
    }

    if (lower.includes('视频号') || extra.publisherNickname) {
        const vv = document.createElement('div');
        vv.className = 'msg-wechat-video';
        vv.innerHTML = `<div class="wv-header"><span class="wv-icon">🎥</span><span class="wv-label">视频号</span></div>
            <div class="wv-desc">${escapeHtml(extra.description || content || '视频号内容')}</div>
            <div class="wv-publisher">@${escapeHtml(extra.publisherNickname || '发布者')}</div>`;
        bubble.appendChild(vv);
        return;
    }

    bubble.appendChild(buildText(content, query));
}

// ── 加载更多 ──────────────────────────

function updateLoadMore() {
    if (state.hasMore) {
        dom.loadMore.style.display = 'block';
        dom.btnLoadMore.textContent = '加载更多...';
        dom.btnLoadMore.disabled = false;
    } else if (state.totalMessages > state.messages.length) {
        dom.loadMore.style.display = 'block';
        dom.btnLoadMore.textContent = `已加载全部 (${state.totalMessages}条)`;
        dom.btnLoadMore.disabled = true;
    } else {
        dom.loadMore.style.display = 'none';
    }
}

// ── 搜索结果面板 ──────────────────────

function renderSearchPanel() {
    if (!state.searchQuery) { hideSearchPanel(); return; }
    dom.searchPanel.style.display = 'flex';
    dom.searchResultTitle.textContent = `"${state.searchQuery}" (${state.searchResults.length}条)`;

    if (state.searchResults.length === 0) {
        dom.searchList.innerHTML = '<div class="search-empty">未找到匹配的消息</div>';
        return;
    }

    const query = state.searchQuery;
    let html = '';
    state.searchResults.forEach((r, i) => {
        const m = r.msg;
        const time = formatDateTime(m.timestamp);
        const myName = state.myName || '我';
        const contactName = state.currentContact?.name || state.currentContact?.remark || 'Ta';
        const sender = m.isSender ? myName : contactName;
        const senderCls = m.isSender ? 'me' : 'contact';
        let content = (m.content || '').substring(0, 60);
        if ((m.content || '').length > 60) content += '...';
        if (!content) {
            if (m.type === 3) content = '[图片]';
            else if (m.type === 43) content = '[视频]';
            else if (m.type === 47) content = '[表情]';
            else if (m.type === 34) content = '[语音]';
            else content = '[消息]';
        }
        html += `<div class="search-result-item" data-si="${i}">
            <div class="sr-header">
                <span class="sr-time">${time}</span>
                <span class="sr-sender ${senderCls}">${sender}</span>
            </div>
            <div class="sr-content">${highlightText(content, query)}</div>
        </div>`;
    });
    dom.searchList.innerHTML = html;

    dom.searchList.querySelectorAll('.search-result-item').forEach(item => {
        item.addEventListener('click', () => jumpToSearchResult(parseInt(item.dataset.si)));
    });
}

function hideSearchPanel() { dom.searchPanel.style.display = 'none'; }

function showSearchPanel() {
    dom.searchPanel.style.display = 'flex';
    if (dom.searchPanelInput) dom.searchPanelInput.focus();
}

async function jumpToSearchResult(resultIndex) {
    const result = state.searchResults[resultIndex];
    if (!result) return;

    // Save search state for back navigation
    state._savedSearch = {
        query: state.searchQuery,
        results: state.searchResults,
    };

    hideSearchPanel();

    // Show back button in topbar
    dom.btnBack.style.display = '';
    dom.btnMenu.style.display = 'none';

    // Load the page containing this result
    const targetPage = result.page;
    const targetTs = result.msg.timestamp;

    state.messages = [];
    state.currentPage = targetPage;
    state.dateJumped = null;
    // Keep search query for highlights but don't re-search

    try {
        const data = await api(`/api/messages/${state.currentContact.id}?page=${targetPage}&size=50`);
        state.messages = data.messages;
        state.hasMore = data.hasMore;
        state.totalMessages = data.total;
        renderMessages();
        updateLoadMore();

        requestAnimationFrame(() => {
            const row = dom.messagesList.querySelector(`[data-ts="${targetTs}"]`);
            if (row) {
                row.scrollIntoView({ behavior: 'smooth', block: 'center' });
                row.classList.add('search-match');
                setTimeout(() => row.classList.remove('search-match'), 2000);
            }
        });
    } catch (e) { console.error('Jump to search result failed:', e); }
}

function backToSearch() {
    // Hide back button, show menu
    if (dom.btnBack) dom.btnBack.style.display = 'none';
    if (dom.btnMenu) dom.btnMenu.style.display = '';
    
    if (state._savedSearch) {
        state.searchQuery = state._savedSearch.query;
        state.searchResults = state._savedSearch.results;
        state._savedSearch = null;
        // Restore panel content
        if (dom.searchPanelInput) dom.searchPanelInput.value = state.searchQuery;
        dom.searchResultTitle.textContent = '"' + state.searchQuery + '" (' + state.searchResults.length + '条)';
        renderSearchResults();
    }
    // Show search panel
    dom.searchPanel.style.display = 'flex';
    if (dom.searchPanelInput) setTimeout(function() { dom.searchPanelInput.focus(); }, 100);
}

// Separate function to render just the search result list (for back navigation)
function renderSearchResults() {
    if (!state.searchQuery || state.searchResults.length === 0) {
        dom.searchList.innerHTML = '<div class="search-empty">未找到匹配的消息</div>';
        return;
    }
    const query = state.searchQuery;
    let html = '';
    state.searchResults.forEach((r, i) => {
        const m = r.msg;
        const time = formatDateTime(m.timestamp);
        const myName = state.myName || '我';
        const contactName = state.currentContact?.name || state.currentContact?.remark || 'Ta';
        const sender = m.isSender ? myName : contactName;
        const senderCls = m.isSender ? 'me' : 'contact';
        let content = (m.content || '').substring(0, 60);
        if ((m.content || '').length > 60) content += '...';
        if (!content) {
            if (m.type === 3) content = '[图片]';
            else if (m.type === 43) content = '[视频]';
            else if (m.type === 47) content = '[表情]';
            else if (m.type === 34) content = '[语音]';
            else content = '[消息]';
        }
        html += `<div class="search-result-item" data-si="${i}">
            <div class="sr-header">
                <span class="sr-time">${time}</span>
                <span class="sr-sender ${senderCls}">${sender}</span>
            </div>
            <div class="sr-content">${highlightText(content, query)}</div>
        </div>`;
    });
    dom.searchList.innerHTML = html;
    dom.searchList.querySelectorAll('.search-result-item').forEach(item => {
        item.addEventListener('click', () => jumpToSearchResult(parseInt(item.dataset.si)));
    });
}

// ═══════════════════════════════════════════
//  媒体预览
// ═══════════════════════════════════════════

function openImagePreview(src) {
    dom.imagePreview.src = src;
    dom.imageOverlay.style.display = 'flex';
    document.body.style.overflow = 'hidden';
}

function closeImagePreview() {
    dom.imageOverlay.style.display = 'none';
    dom.imagePreview.src = '';
    document.body.style.overflow = '';
}

function openVideoPreview(src) {
    dom.videoPreview.src = src;
    dom.videoOverlay.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    dom.videoPreview.play().catch(() => {});
}

function closeVideoPreview() {
    dom.videoOverlay.style.display = 'none';
    dom.videoPreview.pause();
    dom.videoPreview.src = '';
    document.body.style.overflow = '';
}

// ═══════════════════════════════════════════
//  搜索栏
// ═══════════════════════════════════════════

function clearSearch() {
    state.searchQuery = '';
    state.searchResults = [];
    dom.searchPanelInput.value = '';
    
    hideSearchPanel();
    renderMessages();
}

// ═══════════════════════════════════════════
//  日期跳转 — 使用 dates.json 中的 pageStart
// ═══════════════════════════════════════════

async function loadAvailableDates() {
    if (!state.currentContact) return;
    try {
        const data = await api(`/api/dates/${state.currentContact.id}`);
        state.availableDates = {};
        data.dates.forEach(d => { state.availableDates[d.date] = d; });
    } catch (e) {
        state.availableDates = {};
    }
}

function showDatePanel() {
    if (!state.currentContact) return;
    dom.datePanel.style.display = 'flex';
    const dateKeys = Object.keys(state.availableDates);
    if (dateKeys.length > 0) {
        const lastDate = dateKeys[dateKeys.length - 1];
        const parts = lastDate.split('-');
        state.datePickerYear = parseInt(parts[0]);
        state.datePickerMonth = parseInt(parts[1]);
    }
    renderDateGrid();
}

function hideDatePanel() { dom.datePanel.style.display = 'none'; }

function renderDateGrid() {
    const year = state.datePickerYear;
    const month = state.datePickerMonth;
    dom.dateYearMonth.textContent = `${year}年 ${month}月`;

    if (state.datePickerMode === 'year') {
        const today = new Date();
        const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-01`;
        let html = '';
        for (let m = 1; m <= 12; m++) {
            const mStr = `${year}-${String(m).padStart(2,'0')}-01`;
            let hasMsgs = false, monthCount = 0;
            for (const key in state.availableDates) {
                if (key.startsWith(`${year}-${String(m).padStart(2,'0')}`)) {
                    hasMsgs = true;
                    monthCount += state.availableDates[key].count;
                }
            }
            const isCurrentMonth = mStr === todayStr;
            let cls = 'date-cell month-cell';
            if (hasMsgs) cls += ' has-msgs';
            if (isCurrentMonth) cls += ' today';
            const countDisplay = monthCount > 0 ? `<span class="date-msg-count">${monthCount >= 1000 ? Math.floor(monthCount/1000)+'k' : monthCount}</span>` : '';
            html += `<div class="${cls}" data-month="${m}" ${hasMsgs ? '' : 'data-empty="1"'}>
                <span class="month-name">${m}月</span>${countDisplay}</div>`;
        }
        dom.dateGrid.innerHTML = html;
        dom.dateGrid.querySelectorAll('.month-cell.has-msgs').forEach(cell => {
            cell.addEventListener('click', () => {
                state.datePickerMonth = parseInt(cell.dataset.month);
                state.datePickerMode = 'calendar';
                renderDateGrid();
            });
        });
        return;
    }

    const firstDay = new Date(year, month - 1, 1).getDay();
    const daysInMonth = new Date(year, month, 0).getDate();
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;

    let html = '';
    for (let i = 0; i < firstDay; i++) html += '<div class="date-cell empty"></div>';
    for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        const info = state.availableDates[dateStr];
        let cls = 'date-cell';
        if (info) cls += ' has-msgs';
        if (dateStr === todayStr) cls += ' today';
        const count = info ? info.count : 0;
        const countDisplay = count > 0 ? `<span class="date-msg-count">${count >= 1000 ? Math.floor(count/1000)+'k' : count}</span>` : '';
        html += `<div class="${cls}" data-date="${dateStr}" ${info ? '' : 'data-empty="1"'}>
            <span class="date-num">${d}</span>${countDisplay}</div>`;
    }
    dom.dateGrid.innerHTML = html;

    dom.dateGrid.querySelectorAll('.date-cell.has-msgs').forEach(cell => {
        cell.addEventListener('click', () => jumpToDate(cell.dataset.date));
    });
}

async function jumpToDate(dateStr) {
    if (!state.currentContact) return;

    const info = state.availableDates[dateStr];
    if (!info) return;

    // Use pre-computed pageStart (highest page = oldest messages for that date)
    const startPage = info.pageStart || info.firstPage;
    if (!startPage) return;

    hideDatePanel();

    state.messages = [];
    state.currentPage = startPage;
    state.dateJumped = { date: dateStr, startPage: startPage };
    state.searchQuery = '';
    state.searchResults = [];
    dom.searchPanelInput.value = '';
    
    hideSearchPanel();

    try {
        state.isLoading = true;
        const data = await api(`/api/messages/${state.currentContact.id}?page=${startPage}&size=50`);

        // Filter to only show messages from this date
        const dayStart = new Date(dateStr + 'T00:00:00+08:00').getTime() / 1000;
        const dayEnd = dayStart + 86400;
        state.messages = data.messages.filter(m => m.timestamp >= dayStart && m.timestamp < dayEnd);
        state.hasMore = startPage > 1;
        state.totalMessages = data.total;
        renderMessages();
        updateLoadMore();
    } finally {
        state.isLoading = false;
    }

    dom.chatArea.scrollTop = 0;
    showDateJumpedHint(dateStr);
}

function showDateJumpedHint(dateStr) {
    const existing = document.querySelector('.date-jump-hint');
    if (existing) existing.remove();

    const hint = document.createElement('div');
    hint.className = 'date-jump-hint';
    hint.textContent = `📅 已跳转到 ${dateStr}`;
    dom.messagesList.insertBefore(hint, dom.messagesList.firstChild);

    setTimeout(() => {
        hint.style.opacity = '0';
        hint.style.transition = 'opacity 0.5s';
        setTimeout(() => hint.remove(), 600);
    }, 2000);
}

async function loadMoreDateJumpedUp() {
    if (state.isLoading || !state.dateJumped) return;
    state.isLoading = true;
    try {
        const nextPage = state.currentPage + 1;
        const data = await api(`/api/messages/${state.currentContact.id}?page=${nextPage}&size=50`);
        state.currentPage = nextPage;
        const dayStart = new Date(state.dateJumped.date + 'T00:00:00+08:00').getTime() / 1000;
        const dayEnd = dayStart + 86400;
        const filtered = data.messages.filter(m => m.timestamp >= dayStart && m.timestamp < dayEnd);
        if (filtered.length === 0) {
            state.messages = [...data.messages, ...state.messages];
            state.dateJumped = null;
        } else {
            state.messages = [...filtered, ...state.messages];
        }
        state.hasMore = true;
        renderMessages();
    } finally {
        state.isLoading = false;
    }
}

async function loadMoreDateJumped() {
    if (state.isLoading || !state.dateJumped) return;
    state.isLoading = true;
    if (dom.btnLoadMore) dom.btnLoadMore.disabled = true;

    try {
        // Load the next page (going backward in time = higher page numbers)
        const nextPage = state.currentPage - 1;
        if (nextPage < 1) { state.hasMore = false; updateLoadMore(); return; }

        const data = await api(`/api/messages/${state.currentContact.id}?page=${nextPage}&size=50`);
        state.currentPage = nextPage;

        // Filter to only show messages from the target date
        const dayStart = new Date(state.dateJumped.date + 'T00:00:00+08:00').getTime() / 1000;
        const dayEnd = dayStart + 86400;
        const filtered = data.messages.filter(m => m.timestamp >= dayStart && m.timestamp < dayEnd);

        if (filtered.length === 0) {
            // No more messages for this date — load full page and clear date jump
            state.messages = [...state.messages, ...data.messages];
            state.dateJumped = null;
            state.hasMore = nextPage > 1;
        } else {
            state.messages = [...state.messages, ...filtered];
            state.hasMore = nextPage > 1;
        }
        renderMessages();
        updateLoadMore();
    } finally {
        state.isLoading = false;
        if (dom.btnLoadMore) dom.btnLoadMore.disabled = false;
    }
}

function changeDateMonth(delta) {
    if (state.datePickerMode === 'year') {
        state.datePickerYear += delta;
    } else {
        let newMonth = state.datePickerMonth + delta;
        let newYear = state.datePickerYear;
        if (newMonth > 12) { newMonth = 1; newYear++; }
        else if (newMonth < 1) { newMonth = 12; newYear--; }
        state.datePickerYear = newYear;
        state.datePickerMonth = newMonth;
    }
    renderDateGrid();
}

// ═══════════════════════════════════════════
//  事件绑定
// ═══════════════════════════════════════════

// 菜单
dom.btnMenu.addEventListener('click', () => {
    const vis = dom.menuDropdown.style.display === 'block';
    dom.menuDropdown.style.display = vis ? 'none' : 'block';
});
if (dom.btnBack) dom.btnBack.addEventListener('click', backToSearch);
dom.menuDate.addEventListener('click', () => {
    dom.menuDropdown.style.display = 'none';
    showDatePanel();
});
dom.menuSearch.addEventListener('click', () => {
    dom.menuDropdown.style.display = 'none';
    state.searchQuery = '';
    state.searchResults = [];
    dom.searchPanel.style.display = 'flex';
    const inp = document.getElementById('search-panel-input');
    if (inp) { inp.value = ''; setTimeout(() => inp.focus(), 100); }
    document.getElementById('search-result-title').textContent = '';
    document.getElementById('search-list').innerHTML = '';
});
if (dom.searchCancel) dom.searchCancel.addEventListener('click', () => {
    hideSearchPanel();
});
document.addEventListener('click', (e) => {
    if (!dom.btnMenu.contains(e.target) && !dom.menuDropdown.contains(e.target)) {
        dom.menuDropdown.style.display = 'none';
    }
});

// 日期跳转
dom.dateCloseBtn.addEventListener('click', hideDatePanel);
dom.datePanel.addEventListener('click', (e) => {
    if (e.target === dom.datePanel) hideDatePanel();
});
dom.datePrevMonth.addEventListener('click', () => changeDateMonth(-1));
dom.dateNextMonth.addEventListener('click', () => changeDateMonth(1));
dom.dateJumpLatest.addEventListener('click', () => {
    if (!state.currentContact) return;
    hideDatePanel();
    state.dateJumped = null;
    state.messages = [];
    state.currentPage = 1;
    clearSearch();
    loadMessages(state.currentContact.id, 1, false);
});
dom.dateYearMonth.addEventListener('click', () => {
    state.datePickerMode = state.datePickerMode === 'calendar' ? 'year' : 'calendar';
    renderDateGrid();
});
dom.dateYearMonth.style.cursor = 'pointer';

// 加载更多
dom.btnLoadMore.addEventListener('click', () => {
    if (state.currentContact && state.hasMore) {
        if (state.dateJumped) {
            loadMoreDateJumped();
        } else {
            loadMessages(state.currentContact.id, state.currentPage + 1, true);
        }
    }
});

async function loadNewerMessages() {
    if (state.isLoading || state.currentPage <= 1) return;
    state.isLoading = true;
    try {
        const prevPage = state.currentPage - 1;
        const data = await api(`/api/messages/${state.currentContact.id}?page=${prevPage}&size=50`);
        state.currentPage = prevPage;
        state.messages = [...state.messages, ...data.messages];
        state.hasMore = prevPage > 1;
        renderMessages();
        updateLoadMore();
    } finally {
        state.isLoading = false;
    }
}

// 双向无限滚动
let scrollDebounce = false;
dom.chatArea.addEventListener('scroll', () => {
    if (state.dateJumped) {
        // Scroll up: load older messages (higher page = more of same day)
        if (dom.chatArea.scrollTop < 120 && state.hasMore && !state.isLoading && !scrollDebounce) {
            scrollDebounce = true;
            setTimeout(() => { scrollDebounce = false; }, 500);
            loadMoreDateJumpedUp();
        }
        // Scroll down: load newer messages (lower page)
        const nearBottom = dom.chatArea.scrollHeight - dom.chatArea.scrollTop - dom.chatArea.clientHeight < 120;
        if (nearBottom && state.hasMore && !state.isLoading && !scrollDebounce) {
            scrollDebounce = true;
            setTimeout(() => { scrollDebounce = false; }, 500);
            loadMoreDateJumped();
        }
    } else {
        // Scroll up: load older messages (higher page)
        if (dom.chatArea.scrollTop < 120 && state.hasMore && !state.isLoading && !scrollDebounce) {
            scrollDebounce = true;
            setTimeout(() => { scrollDebounce = false; }, 500);
            loadMessages(state.currentContact.id, state.currentPage + 1, true);
        }
        // Scroll down: load newer messages (lower page)
        const nb = dom.chatArea.scrollHeight - dom.chatArea.scrollTop - dom.chatArea.clientHeight < 120;
        if (nb && state.currentPage > 1 && !state.isLoading && !scrollDebounce) {
            scrollDebounce = true;
            setTimeout(() => { scrollDebounce = false; }, 500);
            loadNewerMessages();
        }
    }
});

// 搜索输入
let searchTimeout;
dom.searchPanelInput.addEventListener('input', () => {
    const query = dom.searchPanelInput.value.trim();
    
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
        state.searchQuery = query;
        if (!query) {
            state.searchResults = [];
            hideSearchPanel();
            renderMessages();
        } else if (state.currentContact) {
            searchMessages(state.currentContact.id, query);
        }
    }, 300);
});

// 键盘快捷键
document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        dom.searchPanelInput.focus();
        if (window.innerWidth <= 600) dom.searchBar.classList.add('visible');
    }
    if (e.key === 'Escape') {
        if (dom.imageOverlay.style.display === 'flex') closeImagePreview();
        if (dom.videoOverlay.style.display === 'flex') closeVideoPreview();
        if (dom.datePanel.style.display === 'flex') hideDatePanel();
        if (dom.searchPanel.style.display === 'flex') hideSearchPanel();
        if (state.searchQuery) clearSearch();
        dom.searchPanelInput.blur();
    }
});



// 搜索面板关闭

dom.searchPanel.addEventListener('click', (e) => {
    if (e.target === dom.searchPanel) hideSearchPanel();
});

// 图片预览
dom.imageClose.addEventListener('click', closeImagePreview);
dom.imageOverlay.addEventListener('click', (e) => {
    if (e.target === dom.imageOverlay) closeImagePreview();
});

// 视频预览
dom.videoClose.addEventListener('click', closeVideoPreview);
dom.videoOverlay.addEventListener('click', (e) => {
    if (e.target === dom.videoOverlay) closeVideoPreview();
});

// ═══════════════════════════════════════════
//  启动
// ═══════════════════════════════════════════

async function init() {
    // Load user config (myName)
    try {
        const res = await fetch('/data/config.json');
        if (res.ok) {
            const cfg = await res.json();
            state.myName = cfg.myName || '我';
        }
    } catch (e) { /* config optional */ }

    await loadContacts();
    if (state.contacts.length > 0) {
        state.currentContact = state.contacts[0];
        // Update topbar — WeChat style: show user's name centered
        const topName = state.myName || state.contacts[0]?.remark || state.contacts[0]?.name || '聊天记录';
        document.querySelector('#topbar-name').textContent = topName;
        clearSearch();
        await loadMessages(state.contacts[0].id, 1, false);
        await loadAvailableDates();
    }
}

init();
