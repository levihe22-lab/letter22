# letter22 — 微信聊天记录查看器

## 项目概述

纯前端网页应用，部署在 GitHub Pages，用户通过导入本地 ZIP 数据包离线查看微信聊天记录。**所有数据仅存储在浏览器 IndexedDB 中，不上传到任何服务器。**

## 项目地址

- **仓库**：https://github.com/levihe22-lab/letter22
- **在线地址**：https://levihe22-lab.github.io/letter22/
- **本地路径**：`D:\claude code\letter22`

---

## 文件结构

```
letter22/
├── index.html          # 主页面（导入界面 + 聊天界面）
├── import.js           # 数据导入模块（ZIP/文件夹 → IndexedDB + Fetch 拦截）
├── app.js              # 聊天查看器（消息渲染、搜索、日期跳转）
├── style.css           # 全部样式（含导入界面、搜索面板、微信风格 UI）
├── packager.html       # 桌面端打包工具（选择文件夹 → 一键下载 ZIP）
├── icon-192.png        # 图标
├── icon-512.png        # 图标
├── .gitignore          # 排除数据文件、头像、加密包
└── wechat-data.zip     # 预打包的数据包（本地使用，不提交 Git）
```

---

## 工作流程

### 用户使用流程

```
桌面端                          手机端
───────                        ───────
packager.html                  打开网页
  │                              │
  ├─ 选 data 文件夹              ├─ 看到导入界面
  ├─ 选头像图片                  ├─ 选 ZIP 文件
  └─ 下载 ZIP ──→ 传到手机 ──→  ├─ 自动解压存入 IndexedDB
                                └─ 进入聊天界面
```

### 技术流程

```
import.js 加载
  ├─ 拦截 window.fetch（同步）
  ├─ 检查 IndexedDB 是否有数据
  │    ├─ 有 → 隐藏导入界面，显示聊天界面
  │    └─ 无 → 显示导入界面
  │
  └─ 用户选 ZIP
       ├─ JSZip 解压
       ├─ 逐文件存入 IndexedDB
       └─ location.reload() → app.js 初始化
```

---

## 核心功能

| 功能 | 说明 |
|------|------|
| 聊天浏览 | 双向无限滚动加载，上滑更早/下滑更新 |
| 日期跳转 | 日历选择日期，点击跳转到当天消息 |
| 全文搜索 | 支持单字/多字中文搜索，最多 999 条结果 |
| 搜索结果跳转 | 点击结果跳转到聊天位置，顶栏出现返回按钮 |
| 图片预览 | 点击放大查看，失败显示文字占位 |
| 头像显示 | 通过 fetch 从 IndexedDB 加载，失败显示 SVG 占位 |
| 导入界面 | 支持 ZIP 文件、文件夹选择、拖拽 |

---

## 数据包格式

ZIP 文件需包含以下结构：

```
wechat-data.zip
├── data/
│   ├── contacts.json          # 联系人列表 [{"id":"wxid_xxx","name":"昵称"}]
│   ├── dates.json             # 日期索引 {"dates":[{"date":"2023-08-04",...}]}
│   ├── search_index.json      # 搜索倒排索引
│   ├── config.json            # 用户配置 {"myName":"你的昵称"}
│   └── messages/
│       ├── page_1.json        # 消息分页（page_1=最新，数字越大越旧）
│       ├── page_2.json
│       └── ...
├── avatar_me.jpg              # 用户头像
└── avatar_contact.jpg         # 联系人头像
```

### 消息格式（page_N.json）

```json
{
  "page": 1,
  "messages": [
    {
      "t": 1691121800,      // timestamp（秒）
      "y": 1,               // 类型：1=文本 3=图片 34=语音 43=视频 47=表情 49=App消息
      "s": true,            // 是否发送者
      "c": "消息内容",
      "e": {},              // 额外信息
      "p": null             // mediaPath
    }
  ],
  "hasMore": true,
  "total": 471783
}
```

---

## 数据打包

### 方式一：packager.html（推荐）

1. 双击 `packager.html` 在桌面浏览器打开
2. 点击「选择数据文件夹」→ 选 `data/` 目录
3. 点击「打包下载」→ 获得 `wechat-data.zip`

### 方式二：手动 ZIP

将 `data/` 文件夹和头像图片直接压缩为 ZIP。

### 方式三：Python 脚本（原始项目）

```bash
cd D:/claude\ code/wechat-viewer
# 1. 从微信导出
python importer.py
# 2. 构建页面
python build.py
# 3. 加密打包（可选）
python pack_encrypted.py
```

---

## 部署

```bash
cd "D:/claude code/letter22"
git add -A
git commit -m "..."
git push origin main
```

GitHub Pages 设置：
- Settings → Pages → Source: Deploy from a branch
- Branch: main, / (root) → Save

---

## 关键技术点

### Fetch 拦截（import.js）
- 同步替换 `window.fetch`，拦截 `/data/*` 和头像请求
- 从 IndexedDB 返回数据，完全绕开网络
- 支持 GitHub Pages 子目录路径自动剥离

### 双向滚动（app.js）
- 上滑到顶 → `loadMessages(page+1)` → 加载更早消息 → 追加到消息列表前面
- 滑到底部 → `loadNewerMessages(page-1)` → 加载更新消息 → 追加到列表后面

### 搜索
- `tokenize()` 生成单字+双字中文 token + 英文单词
- 与预构建的 `search_index.json` 倒排索引匹配
- 结果按时间倒序排列，上限 999 条

### 日期跳转
- 使用 `dates.json` 中的 `firstPage`（当天最早消息所在页）
- 点击日期加载该页，过滤仅显示当天消息
- 滚动超出当天范围自动解除限制

---

## 隐私

- 仓库代码中**无任何个人数据**（昵称、头像、聊天记录均已清除）
- `.gitignore` 排除 `data/`、`*.jpg`、`*.wcv`、`*.zip`
- 所有数据仅在用户浏览器 IndexedDB 中，永不离开本地

---

## 注意事项

1. GitHub Pages 部署在子目录 `/letter22/` 下，所有资源引用使用相对路径
2. `import.js` 必须在 `app.js` 之前加载（fetch 拦截需先安装）
3. 头像通过 `fetch()` 加载（非 `<img src>`），以经过 IndexedDB 拦截器
4. 搜索索引文件较大（约 82MB），首次导入需等待解压写入 IndexedDB
