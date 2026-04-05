# Flight MCP Bridge

讓 Claude AI agent 透過真實瀏覽器操作 **ITA Matrix** 與 **Google Flights**，查詢理論最低票價並驗證是否可訂購。

```
Claude (claude.ai / Claude Code)
    │  MCP (stdio or SSE)
    ▼
bridge.js  (Node.js)
    │  WebSocket  ws://127.0.0.1:9222
    ▼
Chrome Extension (background.js)
    │  chrome.tabs / content scripts
    ▼
ITA Matrix  /  Google Flights
```

---

## 目錄

- [架構](#架構)
- [需求](#需求)
- [安裝](#安裝)
  - [1. Bridge（Node.js）](#1-bridgenodejs)
  - [2. Chrome 擴充功能](#2-chrome-擴充功能)
  - [3. 設定 Claude Code（本地）](#3-設定-claude-code本地)
  - [4. 設定 Claude.ai（遠端 SSE）](#4-設定-claudeai遠端-sse)
- [使用方式](#使用方式)
- [工具參考](#工具參考)
- [常見問題](#常見問題)

---

## 架構

| 元件 | 說明 |
|------|------|
| `bridge.js` | Node.js 程式，同時提供 stdio MCP（給 Claude Code）和 SSE MCP（給 claude.ai 遠端），並在 `ws://127.0.0.1:9222` 等待 Chrome extension 連線 |
| `extension/` | Chrome MV3 擴充功能，與 bridge 保持 WebSocket 連線；收到指令後操作 ITA Matrix / Google Flights 頁面 |

---

## 需求

- Node.js 18+
- Chrome 或 Brave 瀏覽器
- Claude Code（本地用）或可連到此主機的網路（遠端 SSE 用）

---

## 安裝

### 1. Bridge（Node.js）

```bash
git clone https://github.com/samuel3132001/flight-mcp-bridge.git
cd flight-mcp-bridge
npm install
```

啟動 bridge：

```bash
node bridge.js
```

> bridge 會同時監聽：
> - `ws://127.0.0.1:9222` — Chrome Extension 連線
> - `http://0.0.0.0:3000` — SSE MCP（遠端 claude.ai 用）

---

### 2. Chrome 擴充功能

1. 打開 Chrome / Brave，網址列輸入 `chrome://extensions`
2. 右上角開啟 **開發人員模式**
3. 點擊 **載入未封裝項目**，選擇本專案的 `extension/` 資料夾
4. 確認擴充功能已啟用，badge 顯示 **ON**（綠色）表示已連上 bridge

> 若 badge 顯示 **OFF**：確認 `node bridge.js` 正在執行中。

---

### 3. 設定 Claude Code（本地）

在 `~/.claude/settings.json`（或專案的 `.claude/settings.json`）加入：

```json
{
  "mcpServers": {
    "flights": {
      "command": "node",
      "args": ["/path/to/flight-mcp-bridge/bridge.js"],
      "env": {}
    }
  }
}
```

重新啟動 Claude Code，執行 `/mcp` 確認 `flights` 狀態為 connected。

---

### 4. 設定 Claude.ai（遠端 SSE）

若 bridge 跑在遠端主機（或透過 Tailscale tailnet）：

1. 確認 port 3000 可從 Claude.ai 的伺服器連到（或使用 tailnet）
2. 在 Claude.ai 設定 → MCP Servers 新增：
   - **URL**: `http://<your-host>:3000/sse`
3. 連線後可在對話中直接呼叫工具

---

## 使用方式

### 推薦工作流程：ITA Matrix → Google Flights

**Step 1：用 ITA Matrix 查理論最低價**

```
搜尋 TPE → NRT 2026-04-06 的最低票價
```

Claude 會自動呼叫 `search_ita`，ITA Matrix 瀏覽器頁面會自動填表並搜尋（約 30–60 秒）。

**Step 2：用 Google Flights 驗證可否訂購**

```
再用 Google Flights 驗證能不能訂
```

Claude 會呼叫 `search_flights`，對比 ITA 的理論價與 Google Flights 的實際可訂價格。

---

### 範例對話

```
User: 幫我查 TPE → NRT 2026-04-06 的機票，先找最低價再確認能不能訂

Agent:
  1. search_ita(origin="TPE", destination="NRT", departure_date="2026-04-06")
     → ITA Matrix: 最低 NT$10,158（Jetstar, 01:10, nonstop）

  2. search_flights(origin="TPE", destination="NRT", departure_date="2026-04-06")
     → Google Flights: 最低 NT$12,175（酷航 Scoot, 06:45, nonstop）✓ 可訂

  → 推薦：酷航 06:45，NT$12,175，直飛 3h 30m
```

---

## 工具參考

| 工具 | 說明 | 參數 |
|------|------|------|
| `search_ita` | 在 ITA Matrix 搜尋（自動填表、送出） | `origin`, `destination`, `departure_date`, `return_date?`, `passengers?`, `cabin?` |
| `search_ita_multicity` | 在 ITA Matrix 搜尋多城市行程 | `legs`, `passengers?`, `cabin?` |
| `scrape_ita_results` | 重新抓取目前 ITA Matrix 結果頁 | 無 |
| `search_flights` | 在 Google Flights 搜尋 | `origin`, `destination`, `departure_date`, `return_date?`, `passengers?`, `cabin?` |
| `search_flights_multicity` | 在 Google Flights 搜尋多城市行程 | `legs`, `passengers?`, `cabin?` |
| `scrape_results` | 重新抓取目前 Google Flights 結果頁 | 無 |

所有工具 timeout 為 **90 秒**。ITA Matrix 搜尋通常需要 30–60 秒。

---

## 常見問題

**Badge 一直顯示 OFF？**
確認 `node bridge.js` 正在執行，且沒有其他程式佔用 port 9222。

**ITA Matrix 出現 CAPTCHA？**
在瀏覽器手動解完 CAPTCHA，然後再呼叫 `scrape_ita_results()`。

**搜尋結果 `status: "no_results"`？**
- 嘗試換日期（±1–3 天）
- 嘗試鄰近機場（TPE ↔ TSA、NRT ↔ HND）

**ITA 價格比 Google Flights 低很多？**
ITA 顯示所有艙等（含低艙等折扣票），部分艙等可能已售完；Google Flights 顯示目前實際可購買的價格。

**`search_ita` 回傳 timeout？**
ITA Matrix 頁面可能尚未完全載入，稍等後呼叫 `scrape_ita_results()` 重試。
