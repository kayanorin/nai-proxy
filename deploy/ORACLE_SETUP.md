# Oracle Cloud 部署 nai-proxy（零 VM 经验版）

从零到跑起来，全程复制粘贴。预计 30–45 分钟。做完基本不用再管它。

配套文件（都在 `deploy/`）：
- [`nai-proxy.service`](nai-proxy.service) — systemd 单元（常驻 + 崩溃自启 + 开机自启）
- [`nai-proxy.env`](nai-proxy.env) — 环境变量模板（填 key 的地方）
- [`Caddyfile`](Caddyfile) — 自动 HTTPS 反向代理

---

## 0. 先决条件

- Oracle 账号（你已就绪）。
- **一个域名**（强烈建议）。没有的话用免费的 DuckDNS：注册 → 建一个 `你的名字.duckdns.org`。域名是为了 HTTPS——没它你的访问令牌会明文传输。

---

## 1. 建 VM（控制台里点，约 5 分钟）

1. 控制台 → **Compute → Instances → Create Instance**。
2. **Image**：Canonical **Ubuntu 22.04**（或 24.04）。
3. **Shape**：
   - 优先 **VM.Standard.A1.Flex**（Ampere ARM，always-free，给 1 OCPU / 6GB 足够）。
   - 若提示 **out of capacity**（ARM 常缺货），换 **VM.Standard.E2.1.Micro**（AMD，always-free，1GB）。这个 app 很小，micro 完全够。
4. **SSH keys**：选 **Generate a key pair for me**，把私钥下载好（后面登录要用）。或者上传你自己的公钥。
5. **Networking**：默认新建 VCN 即可，确保 **Assign a public IPv4 address = 是**。
6. Create。等状态变 **Running**，记下 **Public IP address**。

### 1b. 把公网 IP 变成「保留（静态）」—— 关键，保证 IP 永不变

风控就靠这个固定 IP。默认给的是临时 IP，停机可能变。

1. 实例详情 → **Attached VNICs** → 点那个 VNIC → **IPv4 Addresses**。
2. 找到那条 Public IP → 右边三个点 → **Edit** → Public IP 选 **Reserved public IP** → **Create a new reserved IP** → 保存。

现在这个 IP 永久归你。**把你的域名 A 记录指向这个 IP。**

---

## 2. 开端口（两层，都要做——这是新手最常卡的地方）

Oracle 有**两道墙**：云端的 Security List + VM 自己的 iptables。只开一道没用。

### 2a. 云端 Security List

VCN → 你的子网 → **Security List** → **Add Ingress Rules**，加两条：
| Source CIDR | Protocol | Dest Port |
|---|---|---|
| `0.0.0.0/0` | TCP | `80` |
| `0.0.0.0/0` | TCP | `443` |

（80 是 Caddy 申请证书用，443 是正式流量。不用开 3000——那个只在本机监听。）

### 2b. VM 自己的防火墙

先 SSH 进去（把 `~/key.pem` 换成你下载的私钥路径，`IP` 换成保留 IP）：

```bash
chmod 600 ~/key.pem
ssh -i ~/key.pem ubuntu@你的保留IP
```

登进去后，放行 80/443 并存盘：

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

> 若 `netfilter-persistent` 不存在：`sudo apt install -y iptables-persistent`（安装时问是否保存，选 Yes），再跑上面的 save。

---

## 3. 装 Node + 拉代码

仍在 VM 里：

```bash
# Node 24 LTS（内置 node:sqlite）
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs git

# 拉你的仓库到 /opt/nai-proxy
sudo git clone https://github.com/你的用户名/nai-proxy.git /opt/nai-proxy
sudo chown -R ubuntu:ubuntu /opt/nai-proxy
cd /opt/nai-proxy
npm install --omit=dev
```

> 私有仓库的话，clone 会要认证——用 gh CLI 或部署密钥；或者直接 `scp` 代码上去。

---

## 4. 配环境变量（填 key 的地方）

```bash
sudo cp /opt/nai-proxy/deploy/nai-proxy.env /etc/nai-proxy.env
sudo nano /etc/nai-proxy.env      # 填 NAI_KEY 和 ACCESS_TOKENS
sudo chmod 600 /etc/nai-proxy.env # 只有 root 能读

# 给活动热力图的 SQLite 建持久目录
sudo install -d -o ubuntu -g ubuntu -m 750 /var/lib/nai-proxy
```

nano 里改完：`Ctrl+O` 回车保存，`Ctrl+X` 退出。

---

## 5. 用 systemd 常驻

```bash
sudo cp /opt/nai-proxy/deploy/nai-proxy.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now nai-proxy

# 确认起来了
systemctl status nai-proxy --no-pager
curl -s localhost:3000/            # 应回 {"ok":true,...}
```

看到 `active (running)` 和健康检查 JSON 就成了。

---

## 6. HTTPS（Caddy 反向代理）

**前提：域名 A 记录已指向保留 IP**（DNS 生效可能要几分钟）。

```bash
# 装 Caddy
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy

# 放上你的 Caddyfile，改成你的真域名和邮箱
sudo cp /opt/nai-proxy/deploy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile     # 把 nai.example.com / you@example.com 换掉
sudo systemctl restart caddy

# 验（在你自己电脑上，或 VM 里都行）
curl -s https://你的域名/           # 应回 {"ok":true,...}，且是 https
```

Caddy 会自动申请证书、**每 ~60 天自动续期**，你不用管。

**朋友端配置**：把「分发服务地址」改成 `https://你的域名`，令牌不变。第三方插件（酒馆）的 API 地址也填这个。

---

## 7. 收尾：让它更省心（都是一次性）

### 7a. 自动安全更新（省掉每月手动打补丁）

```bash
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades   # 选 Yes
```

开了之后系统自己打安全补丁。偶尔（几个月一次）内核更新后需要重启一下：`sudo reboot`——重启后 app 会自动回来。

### 7b. 掉线邮件告警（免费）

VM 不像 Render 有面板。用 **UptimeRobot**（免费）盯着：
1. uptimerobot.com 注册。
2. Add Monitor → HTTP(s) → URL 填 `https://你的域名/`（就是那个健康检查 `GET /`）。
3. 填你的邮箱。掉线时它发邮件给你。

顺带这个定时探测也当**保活**用。

---

## 日常速查（你只会用到这几条）

SSH 进去后：

```bash
# 看实时日志（含每次生图的 usage 记账 + 报错）
journalctl -u nai-proxy -f

# 更新代码后重新部署
cd /opt/nai-proxy && git pull && sudo systemctl restart nai-proxy

# 换 NAI key / 改令牌
sudo nano /etc/nai-proxy.env && sudo systemctl restart nai-proxy

# 起 / 停 / 重启 / 看状态
sudo systemctl start   nai-proxy
sudo systemctl stop    nai-proxy
sudo systemctl restart nai-proxy
systemctl status nai-proxy --no-pager

# 确认出口 IP 就是那个固定 IP（验风控）
curl -s https://你的域名/egress-ip
```

---

## 出问题时的排查顺序

| 症状 | 先查 |
|---|---|
| 朋友连不上 | 端口两层都开了吗（§2a **和** §2b）；DNS 指对了吗 |
| `https` 报证书错 | 80 端口开了吗（Caddy 签证书要用）；域名 A 记录生效了吗 |
| 服务没起来 | `journalctl -u nai-proxy -n 50` 看报错；多半是 `/etc/nai-proxy.env` 没填或 node 路径不对 |
| `/submit` 回 NO_KEY | `NAI_KEY` 没填；`sudo nano /etc/nai-proxy.env` 补上再 restart |
| 改了代码没生效 | 忘了 `systemctl restart nai-proxy` |
