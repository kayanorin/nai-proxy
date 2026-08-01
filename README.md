# nai-proxy

NovelAI 拼车分发服务。把「每个朋友浏览器各自直连 NAI」改成「统一经由一台 Render 服务串行转发」：

- **单一出口 IP** —— 所有 NAI 请求从同一台服务器发出，收窄账号风控面。
- **key 只在服务端** —— `NAI_KEY` 只存在 Render 环境变量里，朋友端只用访问令牌（`X-Access-Token`），永远不接触 NAI key。
- **串行 + 集中限流** —— 单 worker 串行到 1，集中做 429 退避重试，是防 429/风控的主防线。

> 本仓库**可以公开**：代码里不含任何密钥，要用得有 `ACCESS_TOKENS` + 你的 Render URL，光看代码用不了。

## 工作方式（异步任务）

```
朋友浏览器                    本服务（Express）               NAI
POST /submit ──(NAI body)──>  校验令牌 → 入队 → {job_id}
                             ┌ 单 worker：一次取一个 ───────┐
GET /status/:id ─轮询──────>    queued → running → done      │
                             │  running 时 加 key 转发─────> 生图(zip)
GET /result/:id <──zip──────   done 后原样吐回 NAI 的 zip  <─┘
                             └──────────────────────────────┘
```

客户端把拼好的 NAI 请求体原样发上来，服务端只加 `Authorization` 再转发，**不重写 prompt / 尺寸 / vibe / seed**。结果是 NAI 原始 zip，客户端照旧 `JSZip.loadAsync` 解。

## 接口

| 接口 | 鉴权 | 作用 |
|---|---|---|
| `GET /` | 否 | 健康检查：`{ok, queueLen, working, jobs}`，兼作保活探测 |
| `GET /egress-ip` | 否 | 诊断：回显本服务出口 IP（验「单一 IP」用） |
| `POST /submit` | 是 | 收 NAI body → 建 job、入队 → `{job_id, status, position}` |
| `GET /status/:id` | 是 | `{status, position, error, code}`；status ∈ queued/running/done/failed/cancelled |
| `GET /result/:id` | 是 | done 时回 `application/zip` 原始字节；未完成 409 |
| `POST /cancel/:id` | 是 | 排队中直接移除；运行中 Abort 中断 |
| `POST /encode-vibe` | 是 | 收 `{image, information_extracted, model}` → 入**同一队列** → NAI `/ai/encode-vibe`；`/result` 回原始字节（不是 zip）。固定计 2 Anlas |
| `GET /balance` | 是 | 当前 Anlas 余额 `{balance, at}`；60 秒缓存（每跑完一单自动刷新），查不到回 `balance:null` |
| `GET /stats/me/activity?days=7` | 是 | 当前令牌自己的 7/30/90 天本地小时活动，不返回其他用户 |
| `GET /stats/activity?days=7&user=all` | 管理员 | 全体或单用户活动；`X-Access-Token` 使用 `ADMIN_TOKEN` |
| `GET /stats/ui` | 页面公开，数据需管理员 | 车主活动统计页面；管理员令牌只保存在浏览器本地 |
| `POST /ai/generate-image` | 是* | **NAI 原生兼容**：同步生图（入同一队列、阻塞等出图、原样回 zip/msgpack）。给只能填 NAI key 的第三方客户端用（如酒馆插件） |

鉴权：网页端用请求头 `X-Access-Token: <你的令牌>`。任务与提交它的令牌绑定，他人令牌查不到（403）。

> \* `/ai/generate-image` 例外：它从 `Authorization: Bearer <令牌>` 读令牌（也兼容 `X-Access-Token`），因为第三方客户端通常只有「NAI key」一个输入框——把**访问令牌**填进去即可。

## 第三方客户端直连（酒馆 st-chatu8 插件等）

有些客户端只能配「NAI 官方/第三方 API 地址 + 一个 key」，不支持本服务的异步 `submit→轮询→result` 协议。`POST /ai/generate-image` 就是给它们的：**长得和 NAI 官方接口一模一样**（同路径、`Authorization: Bearer`、同步返回原始响应），内部却走的是同一个队列（共用限速 / 单一真 key / 用量统计）。

插件侧配置（以 st-chatu8 为例）：

- **API 地址**：填本服务根地址，如 `https://your-app.onrender.com`（插件会自己拼 `/ai/generate-image`）。
- **NAI key 栏**：填你的**访问令牌**（`ACCESS_TOKENS` 里的某一个），不是真 NAI key。
- 其余照常。请求体里带 `stream:"msgpack"` 也没关系——服务端缓冲完整响应后原样回传，插件照常解。

> 同步语义：这条接口会**一直挂着连接直到出图**（前面有人排队就更久）。NAI 同时只跑一个，拼车人少时基本等于纯生图耗时。客户端中途断开会自动取消任务、不白烧点数。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `NAI_KEY` | （空） | 共享 NAI token。**换 key = 改这里**（这就是「填 key 的位置」） |
| `ACCESS_TOKENS` | （空） | 逗号分隔的访问令牌，一人一个 |
| `MIN_GAP_MS` | `8000` | 生图请求随机起点间隔的下限 |
| `MAX_GAP_MS` | `12000` | 生图请求随机起点间隔的上限（每单在上下限之间独立抽取） |
| `ENCODE_MIN_GAP_MS` | `3000` | vibe 编码任务的间隔（比生图轻，可以更密；仍走同一条串行队列） |
| `RESULT_TTL_MS` | `600000` | 结果保留时长（10 分钟），超时回收 |
| `MAX_SAMPLES` / `MAX_STEPS` | `0` | 参数上限，0=不限制 |
| `NAI_BASE_URL` | NAI 真地址 | 测试时指向本地 mock |
| `NAI_API_BASE_URL` | `https://api.novelai.net` | NAI 账号接口（查 Anlas 余额），与生图不同域名 |
| `MAX_JOBS` | `200` | 内存里最多保留多少 job |
| `PORT` | `3000` | Render 自动注入 |
| `STATS_DB_PATH` | `./data/stats.sqlite` | 活动小时聚合 SQLite 路径；Oracle 推荐 `/var/lib/nai-proxy/stats.sqlite` |
| `STATS_RETENTION_DAYS` | `90` | 活动历史保留天数 |
| `USER_PROFILES_JSON` | `{}` | 访问令牌到显示名与 IANA 时区的 JSON 映射 |

完整清单见 [.env.example](.env.example)。

## 用量统计口径

**记账以实测为准**：每个任务开跑前后各查一次 NAI 余额，差值就是这一单的真实扣点（队列串行，同一 key 上没有并发任务，归因是准的）。这样局部重绘、precise 参考、vibe 编码等一切计费项都自动算进去，也不会因 NAI 改价而失真。

`anlas.js` 的估算公式只用于两处：提交时给出预估显示、余额查不到时的记账回落。它已对齐官网前端的算法（img2img/局部重绘按 `strength` 折算且单张最低 2 点；precise 参考每张 5 点 × 张数且 Opus 免费档不豁免；vibe 引用第 5 个起每个 +2）。

> 注意：Opus 免费档内（≤1024×1024、≤28 步、单张）的生图与局部重绘本来就是 0 点，统计记 0 是对的，不是漏记。车主自己在 NAI 网页上与代理同时出图会污染差值——罕见，接受。

## 本地运行

```bash
npm install

# 真 key 冒烟：本机起服务（需要能连 NAI；墙内连不上就直接在 Render 上验）
NAI_KEY=你的key ACCESS_TOKENS=tok1 node server.js
# 然后把网页的「分发服务地址」指向 http://localhost:3000、令牌填 tok1，生一张

# 逻辑验证（不需要真 key）：一条命令跑完所有逻辑断言
npm run smoke   # 若 npm 脚本找不到 node，直接：node test/smoke.js
```

`npm test` 会先跑 19 项 mock 冒烟，再跑 SQLite 活动测试。覆盖令牌隔离、生成与 Vibe 编码、实际 Anlas 与估算回退、活动 API、重试/失败/取消不重复计数，以及持久化、时区/DST、清零和数据库隐私。

## 部署到 Render

最简单走后台（也可用 [render.yaml](render.yaml) 蓝图）：

1. 把本目录推到一个**公开 git 仓库**。
2. Render → New → Web Service → 连该仓库：
   - Runtime: **Node**，Plan: **Free**
   - Build Command: `npm install`
   - Start Command: `node server.js`
   - Health Check Path: `/`
3. Environment 里配 `NAI_KEY`、`ACCESS_TOKENS`（其余用默认即可）。
4. 部署完成后按 [验证清单.md](验证清单.md) 验。

> 免费档会在闲置后休眠（冷启动几十秒），且休眠会清空内存里排队/已完成的 job——丢了客户端重提交即可。这是已接受的取舍。

## curl 速验（部署后）

```bash
BASE=https://your-app.onrender.com
TOK=friendA-xxxx

curl $BASE/                          # 健康检查
curl $BASE/egress-ip                 # 出口 IP

# body.json = 一份真实 NAI 请求体（从网页生图时抓一份）
JOB=$(curl -s -X POST $BASE/submit -H "Content-Type: application/json" \
  -H "X-Access-Token: $TOK" --data @body.json | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).job_id))")

curl -s $BASE/status/$JOB -H "X-Access-Token: $TOK"      # 轮到 done
curl -s $BASE/result/$JOB -H "X-Access-Token: $TOK" -o out.zip   # 取图
```

## 注意

- **二进制**：NAI 回的是 zip，全程按 Buffer 处理，不当文本解析。
- **CORS**：已允许任意源 + `X-Access-Token` / `Authorization` 头，并处理预检 OPTIONS（覆盖 `file://` 的 null 源）。浏览器禁止脚本设 `Origin/Referer`，所以这两个头的伪装只在服务端转发那一跳生效。
- **key 失效**：NAI 401 会映射成「车主请更新 NAI_KEY」（错误 code `KEY_INVALID`），而非裸 500。
- **不要在网页里做热改 key 的输入框**：免费档休眠清内存，热填的 key 活不过冷启动；统一以 `NAI_KEY` 环境变量为准。
- **信任边界**：拼车是熟人，body 透传即可；要防误操作再开 `MAX_STEPS/MAX_SAMPLES`。
