# Environment — desktop-pet 开发环境的统一收拢目录

本目录把「运行/构建/抓取所需的一切外部资源」收进工作区内，满足两条要求：

1. **所有下载与改动都落在 `E:\desktop-pet` 内**（此前上游仓库抓取曾落在工作区外的
   `E:\pet-asset-scratch`，已迁入本目录）；
2. **环境相关组件尽量集中在 `E:\desktop-pet\Environment`**（工具链、缓存、构建产物、日志、下载）。

---

## 目录结构

```
Environment/
├─ toolchains/            运行与构建所需的工具链（体积最大）
│  ├─ node_modules/       npm 依赖（Electron/Vite/vitest 等）
│  ├─ pyenv/              资源导入管线的隔离 Python 环境（numpy + Pillow）
│  ├─ android-sdk/        Android SDK（mobile 端构建）
│  └─ jdk17/              JDK 17（Android/Gradle 构建）
├─ build/                 构建与发布产物（可重新生成）
│  ├─ out/                electron-forge 打包输出（out/）
│  └─ dist-share/         历史发布包与 APK（dist-share/）
├─ caches/                可重跑的中间缓存
│  └─ .pet-research/      上游「pet」资源检索/清点/排序/导入账本缓存
├─ downloads/             所有下载内容（源码与归档）
│  ├─ upstream/           批量抓取的候选仓库（阶段 3 解包结果，含上游原始美术）
│  │  └─ pet-asset-scratch/
│  └─ github/             指定参考项目等按 commit 固定的快照
│     └─ dsh-pet/         参考项目 PC2005-cloud/dsh-pet（含 .fetch.json 记录 commit/sha256）
├─ logs/                  诊断与修复报告
│  └─ acl-recovery-report/ 早期工作区权限诊断输出（未做任何权限改动）
└─ tmp/                   临时目录
```

> **本目录不入库**：`Environment/` 合计 4GB+（工具链 / 3.2GB 上游抓取 / electron-forge 产物 / pyenv venv），
> 且全部与具体机器绑定。`.gitignore` 里只放行本文件（`Environment/*` + `!Environment/README.md`），
> 目的是让「环境如何重建」可追溯、而重建所需的东西按需现场生成。

## 关键约定：用 junction 保持「逻辑路径不变」

`node_modules`、`android-sdk`、`jdk17`、`out`、`dist-share`、`.pet-research` 这些组件被**物理移动**
到本目录后，**在原来的位置保留了 Windows 目录联接（junction）**：

```
E:\desktop-pet\node_modules      → Environment\toolchains\node_modules
E:\desktop-pet\android-sdk       → Environment\toolchains\android-sdk
E:\desktop-pet\jdk17             → Environment\toolchains\jdk17
E:\desktop-pet\out               → Environment\build\out
E:\desktop-pet\dist-share        → Environment\build\dist-share
E:\desktop-pet\.pet-research     → Environment\caches\.pet-research
```

这样做的原因：`npm`/`electron-forge`/`gradle`/`java` 以及项目里写死的绝对路径（如
`mobile/android/local.properties` 的 sdk.dir、脚本里的缓存路径）**在移动后仍然全部有效**，
不需要逐个改配置，也就不会因为"整理目录"而把构建环境搞坏。删除原位置的联接即可回退
（数据仍在本目录内）。

> 未纳入的目录及原因：
> - `platform/.pg/`（PostgreSQL 数据目录）：属于运行中的数据文件而不是可搬运工具链，
>   用联接重定位可能触发数据库的权限与路径校验，风险大于收益，故保持原位。
> - `mobile/`、`platform/`、`src/`、`deploy/` 等：属于**项目源码与部署脚本**，不是环境组件。

## 常用验证命令

```powershell
# 目录是否完好（经原路径访问）
Test-Path E:\desktop-pet\node_modules\electron\dist\electron.exe
Test-Path E:\desktop-pet\.pet-research\ranking.json

# 构建链是否仍然可用
npm test                 # 273 个用例
npm run package          # 写入 out → Environment\build\out
node scripts/pets/verify-package.mjs   # 打包产物与源资源逐文件 sha256 一致
```

## 上游资源抓取（也落在这里）

```powershell
# 批量候选仓库（阶段 3）：解包到 Environment\downloads\upstream\pet-asset-scratch\repos
node scripts/research/github-pet-assets.mjs --pool=relevant --top=120

# 指定参考项目（按 commit 固定，记录 sha256 与抓取范围）
node scripts/env/fetch-github-repo.mjs PC2005-cloud/dsh-pet --ref=main --subdir=dsh-pet
```

## 资源导入管线（Python）

阶段 5 的导入器需要 `numpy + Pillow`。系统里的 Python 未必两个都有，因此**在 `toolchains/pyenv/`
里放了一份隔离环境**（不污染系统 Python，随本目录一起搬运/删除）。所有导入命令都用它执行：

```powershell
# 复核某个文件的角色判定（诊断脚本，与 scripts/ 一起入库）
Environment\toolchains\pyenv\Scripts\python.exe scripts\pets\classify_probe.py

# 端到端自审：回读每只已入库宠物的 manifest 溯源，按标准重新分类（必须 0 违例）
Environment\toolchains\pyenv\Scripts\python.exe scripts\pets\audit-builtin-pets.py

# 重建内置宠物与资源库（--clean 会先清掉上一轮导入产物，保留 3 只自产宠物）
Environment\toolchains\pyenv\Scripts\python.exe scripts/pets/import_pet_assets.py --dry-run --projects 20
Environment\toolchains\pyenv\Scripts\python.exe scripts/pets/import_pet_assets.py --clean --write --projects 20

# 重新生成报告（读 .pet-research/import-report.json）
node scripts/pets/write-report.mjs
```

重建环境（需要联网，走清华 PyPI 镜像）：

```powershell
python -m venv Environment\toolchains\pyenv
Environment\toolchains\pyenv\Scripts\python.exe -m pip install --index-url https://pypi.tuna.tsinghua.edu.cn/simple numpy pillow
```

抓取产物一律留在本目录内、**不进入 `resources/`**：只有通过 `scripts/pets/import_pet_assets.py`
按《宠物本体资源分类标准》（`src/pet/resource.ts` ⇄ `scripts/pets/pet_roles.py`）判定为
**宠物本体**且许可为 A 层的素材，才会被归一化后写入 `resources/`。
