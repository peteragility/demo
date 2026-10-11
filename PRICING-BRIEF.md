# Demo Repo — LLM Pricing & Lakebase Pricing 工作簡報（Agent Context）

> 呢份係 Peter 喺 2026-10-11 整理嘅全史簡報，俾 Omnigent agent 做「demo-pricing」工作嘅 context。
> Repo：github.com/peteragility/demo（public，GitHub Pages）。Local clone：~/git/demo
> 涉及 99 個 commits（2026-09-23 → 2026-10-11），橫跨 llm-pricing、lakebase-*、pg-cost-calculator。

## 你係邊個

你係 Peter 嘅 demo repo pricing 助理。Peter 係 Databricks Head of FE（HK&TW）。呢個 repo 係佢整嘅客戶示範工具：LLM 定價比較頁 + Lakebase 競爭對比計算機。你嘅職責係幫佢維護、解釋、改進呢啲 pages。

## Repo 結構

```
llm-pricing/            — LLM token 定價比較頁（v2）
  v2.html / v2-app.js / v2.css / v2-data.json — 主頁（53 models × 多平台）
  v2-maintenance/
    build-data.py       — 由 seed + endpoints 建 v2-data.json
    seed-data.json      — 2026-09-28 reviewed offers（人手核實嘅底）
    endpoints.json      — 各平台 endpoint 變體（Data Zone/Flex/Priority tier）
    source-config.json  — 資料源定義（Azure/Alibaba/Google retail APIs 等）
    source-baseline.json— reviewed baseline（daily refresh 對比用）
    review-sources.py   — 每日檢查：自動套用確定變更、可疑變更開 GitHub issue
    prices-auto.json / endpoints-auto.json — 自動更新產物
    test-review-sources.py / test-ranking.py — 測試
  v2-ranking.json       — arena.ai Best WebDev 排名（top-50 依據）
lakebase-compete-calculator/ — Lakebase vs 競品（Snowflake/ClickHouse Postgres）計算機
pg-cost-calculator/     — Lakebase Postgres 成本計算機（stack promo/Always-On）
lakebase-objection-faq/ — 銷售 objection FAQ
lakebase-sales-play/    — 銷售 play
```

## Pages 對外定位（重要）

- LLM pricing 頁：**「Databricks Internal reference only — built by Peter Chan」** badge；customer-safe 措辭；唔係官方報價
- Lakebase calculator：**「Public list prices · not an official quote」** badge、Databricks internal reference

## LLM Pricing v2 — 架構同日常流程

1. **每日自動 refresh**（GitHub Actions「LLM pricing v2 daily refresh」ID 373140273）：
   - 拉 Azure Retail Prices API、Alibaba、Google 等源
   - `review-sources.py` 對比 `source-baseline.json`
   - **確定變更**（e.g. 真新價格）→ 自動套用更新 v2-data.json
   - **可疑變更** → 自動開 GitHub issue「LLM pricing: the daily check needs a review」（#1-#6 已全部處理關閉）
   - 支援 `record_baseline=true` workflow input 重錄 baseline（接受噪音用）
2. **排名**：arena.ai Best WebDev top-50 + 最新 OpenAI/Anthropic 模型；平台有賣就列出
3. **頁面功能**：search/sort/summary chips/delta badges、expand row 睇 detail card（272K context threshold 長上下文定價、cache 定價、Flex/Priority tier）、mobile 響應式

### Baseline/issue 處理慣例（Peter 確認過）
- 冇影響 tracked model 嘅變化（例如 Fun-ASR 語音、第三方代管 GLM、TTS 表頭）= 噪音 → record-baseline 收編，唔使改 page
- 真新 tier/價格（例如 Azure 加 Flex meter）→ 改 `endpoints.json` 加 variant → rebuild → commit → workflow record_baseline → issue 自動關
- 頁面規則：detail card 只顯示已驗證嘅 long-context 價；Batch/Flex tier 冇 long-context 價係正常（唔會由 Standard 推算）

### 近期重要修復/改動（2026-10）
- `edbdbc9` Azure Foundry GPT-6 Astra/Sol 加 Global Flex tier（$25/$1，Standard 5 折）
- `c3f501d` heading 後綴（TTS 等）唔再誤配 text model 行（review-sources fix + 測試）
- `aaf6bea` mobile：chevron 全寬度顯示、expand hint scroll 跟隨（sticky）
- `f2f58ef` header badge「Databricks' Internal reference only」、disclaimer 精簡
- `e436393` 排名改用 arena.ai Best WebDev；加 Opus 4.7/4.6、修 Haiku 5.5
- `733d1de` 新 top-50 模型出現喺平台頁 → 自動開 review issue
- `f248159`/`882057b` top-50 變化靜默更新；平台/region 變化更新卡片或 flag

## Lakebase Pricing（4 個 pages 演進）

1. **lakebase-compete-calculator**：Lakebase Postgres vs Snowflake + ClickHouse Postgres（byo-like-for-like load patterns、HA/replicas per scenario、US West region、Azure SQL rates、lakehouse synced tables 成本、mobile inputs 常開、list prices by default — promo/一次性折扣要用戶自己剔）
2. **pg-cost-calculator**：stack Lakebase 50% promo 落 Always-On baseline（至 2027-01-31）、slider + GB/TB box
3. **lakebase-objection-faq** / **lakebase-sales-play**：銷售用
- 設計原則：同 LLM pricing 頁格式一致、預設 public list price、公平比較（like-for-like）、有 badge 聲明非官方報價

## 部署

- GitHub Pages：peteragility.github.io/demo/（push 即部署，pages-build-deployment workflow）
- 本地 clone：~/git/demo（push 權限：peteragility account）

## 而家狀態（2026-10-11）

- All issues closed；daily refresh 綠；baseline 新鮮
- 頁面：llm-pricing v2（53 models / 206 offers）、4 個 Lakebase pages
- 待留意：Azure/Alibaba 源每日有噪音屬正常；新模型出現會自動開 issue
