# LLM API Key Checker

一个用于检测大模型 API Key 与兼容接口可用性的网页工具。

前端使用 `Vite + React`，后端使用 `Express` 提供同源代理接口 `/__proxy`，用来绕过浏览器直接请求第三方模型接口时的 CORS 限制。

## 功能说明

- 检测 OpenAI 兼容接口是否可用
- 检测 Claude 兼容请求头是否可用
- 展示模型列表，帮助判断 Key 和 Base URL 是否配置正确
- 通过后端代理转发请求，减少前端跨域问题

## 本地开发

安装依赖：

```bash
npm install
```

启动前端开发服务器：

```bash
npm run dev
```

构建生产产物：

```bash
npm run build
```

启动生产服务：

```bash
npm start
```

默认监听端口：

```bash
3000
```

可通过环境变量覆盖：

```bash
PORT=8080 npm start
```

## Docker 部署

项目已经提供多阶段构建的 `Dockerfile`，会同时构建前端静态资源与后端服务，并在容器内以生产模式启动。

构建镜像：

```bash
docker build -t llm-api-checker:latest .
```

运行容器：

```bash
docker run -d \
  --name llm-api-checker \
  -p 3000:3000 \
  -e NODE_ENV=production \
  -e PORT=3000 \
  llm-api-checker:latest
```

启动后访问：

```text
http://localhost:3000
```

健康检查接口：

```text
http://localhost:3000/healthz
```

## Docker Compose 部署

直接启动：

```bash
docker compose up -d --build
```

查看日志：

```bash
docker compose logs -f
```

停止服务：

```bash
docker compose down
```

## GHCR 镜像发布

项目已经增加 GitHub Actions 工作流：

- `.github/workflows/ci.yml`：在 `push` / `pull_request` 时执行 `npm run build`
- `.github/workflows/publish-ghcr.yml`：在推送到 `main` 或推送 `v*` 标签时，自动构建并发布 Docker 镜像到 `ghcr.io`

镜像地址格式：

```text
ghcr.io/<github-owner>/<github-repo>:latest
```

当前仓库会发布为：

```text
ghcr.io/liubaoyua/llm-api-key-checker:latest
```

首次使用前，你需要先把本项目推送到 GitHub，并确保 Actions 与 Packages 权限可用。

如果是公开镜像，服务器可直接拉取：

```bash
docker pull ghcr.io/<github-owner>/<github-repo>:latest
```

如果仓库或镜像是私有的，先登录：

```bash
echo <YOUR_GITHUB_TOKEN> | docker login ghcr.io -u <YOUR_GITHUB_USERNAME> --password-stdin
```

## 部署说明

- 容器内默认端口为 `3000`
- 前端默认通过同源路径 `/__proxy` 调用后端代理
- 如需反向代理到 Nginx 或其他网关，只需要把外部流量转发到本服务即可
- 如果你有自己的前置网关，也可以通过 `VITE_PROXY_URL` 在前端构建时改成其他代理地址
