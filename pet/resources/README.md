# 宠物资源目录

## `upstream/`（第三方素材 · 不入库）

来自上游开源项目 **PC2005-cloud/dsh-pet** 的素材副本：

| 项 | 内容 |
|---|---|
| 来源 | <https://github.com/PC2005-cloud/dsh-pet> |
| 许可 | **代码 MIT**；**素材（动画 / 提示词 / 源视频）允许开源使用、禁止商用** |
| 二创约定 | 基于本项目的衍生 / 改版 / 换皮作品，在**任何介绍、展示、分发该作品的地方**，须署名原作者 GitHub 地址：<https://github.com/PC2005-cloud/dsh-pet> |
| 内容 | `dsh-pet/assets/webm/`（106 段透明 webm 动作）、`assets/memes/`（26 张表情包）、`assets/fonts/上首软糖体.ttf`、`prompts/`、`README.md`、`LICENSE` |

**本目录不入 git**（见根 `.gitignore`）——体积约 60 MiB，且属第三方非商用素材；
仓库只保留索引 `upstream-manifest.json`（path / bytes / sha256，138 个条目）用于可追溯与署名留档。

重建索引：

```bash
node pet/tools/build-resource-manifest.mjs
```

分发约束：上游素材**不随安装包内置**，一律走平台商店「按需下载」；下载/安装链路需保留上游 `LICENSE` 原文与上述署名。

## `builtin/`（自产内置演示宠物 · 入库）

本项目**自行产出**的演示宠物（SVG/PNG + JSON，不含 webm），随仓库入库，用于首次启动即有形象，
不依赖商店、不涉及第三方许可。清单见 [`builtin/manifest.json`](./builtin/manifest.json)。
