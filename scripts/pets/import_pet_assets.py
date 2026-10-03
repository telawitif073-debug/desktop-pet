#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
阶段 5：上游美术资源 → 本项目内置宠物 / 资源库（归一化 + 清单 + 归属声明 + 利用率账本）
===========================================================================
输入（阶段 1~4 的产物，均在 .pet-research/ 下）
  ranking.json          综合排序（星标+下载量）、许可分层、相关性、入选标记
  assets-inventory.json 每个仓库的美术文件清单（真实格式/字节/sha256/可解码性）
  阶段 3 解包出来的上游原始文件（默认 E:\\pet-asset-scratch\\repos）

输出（本项目内的正式资产，随 forge extraResource 打包分发）
  resources/builtin-pets/<petId>/{manifest.json,cover.png,actions/<aid>/frame_NNN.png}
  resources/builtin-pets/index.json          内置宠物总索引（保留原 3 只自产宠物）
  resources/builtin-pets/ATTRIBUTION.md      第三方资源归属与许可声明（自动生成）
  resources/pet-asset-library/<repoSlug>/... 静态美术资源库 + index.json
  .pet-research/import-report.json           逐文件处置账本与利用率统计

关键约束（不可违反，否则运行期会看到问题）
  1) manifest.id 必须与目录名一致（主进程 readManifest 强校验）；
  2) 每只宠物必须有 cover 且至少 1 个 action，每个 action 至少 1 帧；
  3) 同一只宠物内所有帧必须同尺寸同锚点（渲染端逐帧不做对齐）——用「并集包围盒 + 统一缩放 +
     统一锚点」保证，这是导入素材不抖动的根因修复，而不是调参；
  4) 动作数 + 用户已有自定义动作数 ≤ PET_ACTIONS_MAX(15)，故单只宠物默认最多 8 个动作；
  5) 输出确定性：同输入同字节（PNG 固定压缩参数、无时间戳、遍历顺序确定）；
  6) **利用率可证**：每个「取得的素材文件」都有且只有一个处置（action / library / dedup /
     excluded:<原因>），账本必须覆盖全部 considered 文件，不允许出现 unaccounted。

用法：
  python scripts/pets/import_pet_assets.py --dry-run            # 只打印导入计划
  python scripts/pets/import_pet_assets.py --write --projects 20
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
from collections import defaultdict
from datetime import date

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import petart  # noqa: E402
import pet_roles  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
CACHE = os.path.join(ROOT, ".pet-research")
BUILTIN_DIR = os.path.join(ROOT, "resources", "builtin-pets")
LIBRARY_DIR = os.path.join(ROOT, "resources", "pet-asset-library")
GENERATOR = "scripts/pets/import_pet_assets.py"
GENERATOR_VERSION = "1.0.0"
KEEP_PET_IDS = {"sprout-cat", "cloud-rabbit", "charcoal-pup"}

# ---------------------------------------------------------------------------
# 资源分类：与运行时同一套标准（scripts/pets/pet_roles.py ⇄ src/shared/petResource.ts）
# ---------------------------------------------------------------------------
ENV_ROOT = os.path.join(ROOT, "Environment")
ENV_DOWNLOADS = os.path.join(ENV_ROOT, "downloads", "upstream")
# 仅用于「角色聚类」（把同一角色的多个动作归到一只宠物），**不参与分类判定**
GENERIC_DIRS = {"assets", "asset", "res", "resources", "images", "image", "img", "sprites", "sprite", "art", "arts",
                "pics", "pictures", "media", "gfx", "graphics", "static", "public", "anim", "anims", "animation",
                "animations", "frames", "gif", "png", "ui", "icons", "icon", "src", "data", "files", "unpacked"}

INTERACTION_KEYWORDS = [
    ("feed", re.compile(r"(eat|eating|feed|food|chew|bite|drink|treat|吃|喂|食)", re.I)),
    ("rest", re.compile(r"(sleep|sleeping|rest|resting|idle|idling|doze|nap|lie|lying|sit|sitdown|tired|yawn|睡|休息|躺|坐|打盹)", re.I)),
    ("play", re.compile(r"(play|playing|jump|jumping|dance|dancing|happy|excite|run|running|walk|walking|chase|ball|swipe|pounce|玩|跳|跑|走|开心)", re.I)),
]
ACTION_LABEL = {"feed": "吃饭", "rest": "休息", "play": "玩耍"}
INTERACTION_ORDER = ["feed", "rest", "play"]


def load_json(path: str):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def resolve_repo_dir(inv: dict) -> tuple[str, str]:
    """定位阶段 3 解包出来的上游仓库目录。

    兼容历史路径：上一轮抓取目录曾在**工作区之外**（E:\\pet-asset-scratch），现已按
    「所有下载必须落在 E:\\desktop-pet 内」的要求迁入 Environment/downloads/upstream/；
    这里做一次前缀重映射，保证账本与产物可复现（不依赖旧路径是否存在）。
    """
    raw = inv.get("cloneDir") or ""
    candidates = [raw]
    marker = "pet-asset-scratch"
    if marker in raw:
        tail = raw.split(marker, 1)[1].lstrip("\\/")
        candidates.append(os.path.join(ENV_DOWNLOADS, marker, tail))
    full_name = inv.get("fullName") or ""
    if full_name:
        candidates.append(os.path.join(ENV_DOWNLOADS, marker, "repos", full_name.replace("/", "__")))
    for candidate in candidates:
        if candidate and os.path.isdir(candidate):
            note = "" if candidate == raw else f"路径重映射：{raw} → {candidate}"
            return candidate, note
    return raw, "原始资源目录不存在"


def classify_repo_art(repo_dir: str, decodable: list[dict]) -> tuple[list[tuple[pet_roles.Classified, dict]], dict]:
    """按标准给仓库内全部可解码美术文件定性（含帧序列提升与按需 alpha 检测）。"""
    probes: dict[str, dict] = {}
    for item in decodable:
        rel = item["path"]
        full = os.path.join(repo_dir, rel.replace("/", os.sep))
        probes[rel] = pet_roles.probe_image(full) if os.path.isfile(full) else {}

    seq = pet_roles.group_sequences(
        [(rel, int(p.get("width") or 0), int(p.get("height") or 0)) for rel, p in probes.items()]
    )

    out: list[tuple[pet_roles.Classified, dict]] = []
    stats: dict[str, int] = defaultdict(int)
    for item in decodable:
        rel = item["path"]
        probe = dict(probes[rel])
        full = os.path.join(repo_dir, rel.replace("/", os.sep))
        # 批量抓取第三方仓库 → 严格模式：本体必须有结构性证据（目录声明/模型/透明通道）
        if probe and pet_roles.needs_alpha_check(rel, probe, in_sequence=rel in seq, strict=True) and os.path.isfile(full):
            probe["has_alpha"] = pet_roles.alpha_of(full)
        classified = pet_roles.classify(rel, probe, in_sequence=rel in seq, strict=True)
        stats[classified.role] += 1
        out.append((classified, probe))
    return out, dict(stats)


FRAME_NUM_RE = re.compile(r"^(?P<prefix>.*?)[-_ .]?(?P<num>\d{1,4})$")


def build_units(repo_dir: str, art_files: list[dict], stats: dict) -> tuple[list[dict], list[dict]]:
    """把美术文件归并成 unit（动图文件 / 序列帧目录 / 静态图）。

    stats["skipped"] 收集「魔数嗅探通过但 Pillow 打不开」的文件（截断/罕见格式）——
    这些必须在账本里显式记为 excluded:undecodable，否则会出现账本缺口。
    """
    frames_dir: dict[tuple[str, str], list[tuple[int, dict]]] = defaultdict(list)
    animated: list[dict] = []
    statics: list[dict] = []

    for f in art_files:
        rel = f["path"]
        full = os.path.join(repo_dir, rel.replace("/", os.sep))
        if not os.path.isfile(full):
            stats["skipped"].append({"path": rel, "reason": "文件缺失（阶段 3 未落盘）"})
            continue
        info = petart.image_info(full)
        if "error" in info:
            stats["skipped"].append({"path": rel, "reason": f"无法解码：{info['error']}"})
            continue
        if info.get("frames", 1) > 1:
            animated.append({"kind": "animated", "path": rel, "frames": info["frames"], "dir": os.path.dirname(rel)})
            continue
        base = os.path.splitext(os.path.basename(rel))[0]
        m = FRAME_NUM_RE.match(base)
        if m:
            frames_dir[(os.path.dirname(rel), m.group("prefix").strip("-_ .").lower())].append((int(m.group("num")), f))
        else:
            statics.append({"kind": "static", "path": rel, "dir": os.path.dirname(rel), "w": info["width"], "h": info["height"]})

    units: list[dict] = []
    for (d, prefix), items in frames_dir.items():
        if len(items) < 2:
            for _, f in items:
                info = petart.image_info(os.path.join(repo_dir, f["path"].replace("/", os.sep)))
                statics.append({"kind": "static", "path": f["path"], "dir": d, "w": info.get("width", 0), "h": info.get("height", 0)})
            continue
        items.sort(key=lambda t: t[0])
        paths = [f["path"] for _, f in items]
        units.append({"kind": "sequence", "path": paths[0], "paths": paths, "dir": d, "prefix": prefix, "frames": len(paths)})

    for a in animated:
        units.append({"kind": "animated", "path": a["path"], "paths": [a["path"]], "dir": a["dir"],
                      "prefix": os.path.splitext(os.path.basename(a["path"]))[0], "frames": a["frames"]})

    units.sort(key=lambda u: (u["dir"], u["path"]))
    statics.sort(key=lambda s: s["path"])
    return units, statics


def unit_label(unit: dict) -> str:
    name = unit["prefix"] or os.path.basename(unit["path"])
    name = re.sub(r"[_\-]+", " ", name)
    name = re.sub(r"\b\d+ ?fps\b", "", name, flags=re.I)
    name = re.sub(r"\b\d{2,}\b", "", name)
    return re.sub(r"\s+", " ", name).strip() or "action"


def unit_interaction(unit: dict) -> str | None:
    text = f"{unit['dir']} {unit['prefix']} {unit['path']}"
    for key, rx in INTERACTION_KEYWORDS:
        if rx.search(text):
            return key
    return None


def character_key(unit_dir: str) -> str:
    parts = [p for p in unit_dir.split("/") if p]
    tail = [p for p in parts if p.lower() not in GENERIC_DIRS]
    return "/".join(tail[-2:]) if tail else "main"


def load_unit_frames(repo_dir: str, unit: dict, stats: dict) -> tuple[list[Image.Image] | None, str]:
    imgs: list[Image.Image] = []
    for rel in unit["paths"]:
        full = os.path.join(repo_dir, rel.replace("/", os.sep))
        try:
            frames = petart.load_frames(full)
        except Exception as exc:
            stats["skipped"].append({"path": rel, "reason": f"帧解码失败：{exc}"})
            return None, f"帧解码失败：{exc}"
        imgs.extend(frames)
    if not imgs:
        return None, "空帧序列"
    sizes = {im.size for im in imgs}
    if len(sizes) > 1:
        return None, f"帧尺寸不一致（{sorted(sizes)}），会破坏「同尺寸同锚点」约束"
    return imgs, ""


def subsample(frames: list, cap: int) -> tuple[list, bool]:
    if cap <= 0 or len(frames) <= cap:
        return frames, False
    idx = np.linspace(0, len(frames) - 1, num=cap).round().astype(int)
    seen, out = set(), []
    for i in idx:
        if int(i) not in seen:
            seen.add(int(i))
            out.append(frames[int(i)])
    return out, True


def gif_frame_rate(path: str) -> float:
    try:
        with Image.open(path) as im:
            durations = []
            for i in range(getattr(im, "n_frames", 1)):
                im.seek(i)
                durations.append(im.info.get("duration", 0) or 0)
        durations = [d for d in durations if d > 0]
        if durations:
            avg = sum(durations) / len(durations)
            if avg > 0:
                return float(max(2.0, min(24.0, round(1000.0 / avg, 1))))
    except Exception:
        pass
    return 8.0


def short_hash(text: str, n: int = 6) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:n]


# 宽松许可白名单（用于把「资源目录级许可文件」的线索写成可读的许可标识）
PERMISSIVE_SPDX = {
    "MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD", "Unlicense", "CC0-1.0",
    "CC-BY-4.0", "CC-BY-3.0", "CC-BY-SA-4.0", "MPL-2.0", "OFL-1.1", "Zlib", "WTFPL",
}


def licence_display(row: dict, full_name: str) -> tuple[str, str]:
    """返回 (许可标识, 展示文本)。

    上游 GitHub 未识别出 SPDX 时（row['license'] 为空），但判定为 A 层是因为
    「资源目录/根目录许可文件」提供了宽松许可——此时许可标识必须写清楚，
    否则清单/索引里会出现空许可，既不可追溯也不合规。
    """
    spdx = (row.get("license") or "").strip()
    hints = [h for h in (row.get("licenceHints") or []) if h in PERMISSIVE_SPDX]
    if not spdx:
        spdx = "/".join(sorted(set(hints))) or "NOASSERTION"
    reason = row.get("licenceReason") or ""
    text = f"{spdx} — 上游 {full_name}" + (f"（{reason}）" if reason else "")
    return spdx, text


def main() -> int:
    # Windows 中文控制台是 GBK：把不可编码字符（如 ⚠）降级为 '?'，避免带诊断信息的运行直接崩掉
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except Exception:
            pass

    ap = argparse.ArgumentParser(description="把上游美术资源集成为本项目内置宠物与资源库")
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--projects", type=int, default=20)
    ap.add_argument("--only", default="")
    ap.add_argument("--max-actions-per-pet", type=int, default=8)
    ap.add_argument("--max-pets-per-repo", type=int, default=16)
    ap.add_argument("--max-frames-per-repo", type=int, default=900)
    ap.add_argument("--max-frames-per-action", type=int, default=16)
    ap.add_argument("--max-library-per-repo", type=int, default=200)
    ap.add_argument("--max-library-edge", type=int, default=384)
    ap.add_argument("--canvas", type=int, default=petart.SIZE)
    ap.add_argument("--clean", action="store_true")
    args = ap.parse_args()

    petart.SIZE = args.canvas
    write = args.write and not args.dry_run

    ranking = load_json(os.path.join(CACHE, "ranking.json"))
    inventory = load_json(os.path.join(CACHE, "assets-inventory.json"))
    inv_by = {r["fullName"]: r for r in inventory.get("repos", [])}

    only = {s.strip() for s in args.only.split(",") if s.strip()}
    candidates = [r for r in sorted(ranking["rows"], key=lambda r: r["rank"]) if r.get("eligible") and r["fullName"] in inv_by]
    if only:
        candidates = [r for r in candidates if r["fullName"] in only]

    print(f"综合排序候选（宠物相关 + 可解码美术 + A 层许可）：{len(candidates)} 个")
    print(f"本次导入目标：至多 {args.projects} 个项目（按名次下探，只有含「够格本体」的仓库才入选）\n")

    report = {
        "generatedAt": date.today().isoformat(),
        "generator": GENERATOR,
        "generatorVersion": GENERATOR_VERSION,
        "config": {
            "projects": args.projects,
            "maxActionsPerPet": args.max_actions_per_pet,
            "maxPetsPerRepo": args.max_pets_per_repo,
            "maxFramesPerRepo": args.max_frames_per_repo,
            "maxFramesPerAction": args.max_frames_per_action,
            "maxLibraryPerRepo": args.max_library_per_repo,
            "canvas": args.canvas,
        },
        "rankingMetric": ranking.get("metric"),
        "projects": [],
        "skipped": [],
        "totals": {},
    }

    if write:
        if args.clean:
            if os.path.isdir(BUILTIN_DIR):
                for name in os.listdir(BUILTIN_DIR):
                    full = os.path.join(BUILTIN_DIR, name)
                    if os.path.isdir(full) and name not in KEEP_PET_IDS:
                        shutil.rmtree(full)
            if os.path.isdir(LIBRARY_DIR):
                shutil.rmtree(LIBRARY_DIR)
        else:
            # 幂等：先清掉「上一次导入产生的宠物」。否则重跑时自己的产物会被当成 id 冲突，
            # 于是生成 -2/-3 后缀的重复宠物，旧文件（可能带着旧 bug 的封面尺寸）也会留在磁盘上。
            if os.path.isdir(BUILTIN_DIR):
                for name in os.listdir(BUILTIN_DIR):
                    full = os.path.join(BUILTIN_DIR, name)
                    mpath = os.path.join(full, "manifest.json")
                    if not os.path.isdir(full) or not os.path.isfile(mpath):
                        continue
                    try:
                        if (load_json(mpath).get("origin") or {}).get("provider") == "github":
                            shutil.rmtree(full)
                    except Exception:
                        pass
            # 资源库目录完全由本脚本生成 → 整体重建，避免上一轮的孤儿文件
            if os.path.isdir(LIBRARY_DIR):
                shutil.rmtree(LIBRARY_DIR)
        os.makedirs(BUILTIN_DIR, exist_ok=True)
        os.makedirs(LIBRARY_DIR, exist_ok=True)

    used_pet_ids: set[str] = {n for n in os.listdir(BUILTIN_DIR) if os.path.isdir(os.path.join(BUILTIN_DIR, n))} if os.path.isdir(BUILTIN_DIR) else set()
    global_source_hashes: dict[str, str] = {}
    imported_count = 0

    for row in candidates:
        if imported_count >= args.projects:
            break
        full_name = row["fullName"]
        inv = inv_by[full_name]
        repo_dir, repo_dir_note = resolve_repo_dir(inv)
        repo_slug = petart.slugify(full_name.replace("/", "-"), 40)
        licence_spdx, licence_text = licence_display(row, full_name)
        proj = {
            "fullName": full_name,
            "rank": row["rank"],
            "stars": row["stars"],
            "releaseDownloads": row.get("releaseDownloads"),
            "npmMonthly": row.get("npmMonthly"),
            "pypiMonthly": row.get("pypiMonthly"),
            "downloads": row.get("downloads", 0),
            "combined": row.get("combined"),
            "license": licence_spdx,
            "licenseText": licence_text,
            "licenceReason": row.get("licenceReason", ""),
            "url": f"https://github.com/{full_name}",
            "repoDir": repo_dir,
            "pets": [],
            "library": [],
            "dedup": [],
            "dispositions": {},
            "excluded": [],
        }
        if not repo_dir or not os.path.isdir(repo_dir):
            report["skipped"].append({"fullName": full_name, "rank": row["rank"], "reason": "原始资源目录不存在（阶段 3 未解包成功）"})
            continue
        if repo_dir_note:
            proj["repoDirNote"] = repo_dir_note

        decodable = [f for f in inv.get("artFiles", []) if f.get("decodable")]
        considered = [f["path"] for f in decodable]
        considered_set = set(considered)
        dispo: dict[str, str] = {}          # 源文件 → 唯一处置
        dispo_note: dict[str, str] = {}

        def mark(path: str, kind: str, note: str = "") -> None:
            if path not in dispo:
                dispo[path] = kind
                if note:
                    dispo_note[path] = note

        proj["artFilesTotal"] = len(inv.get("artFiles", []))
        proj["artFilesDecodable"] = len(decodable)

        classified, role_stats = classify_repo_art(repo_dir, decodable)
        proj["roleStats"] = role_stats

        # 包级门槛（两条）：
        #  ① 必须存在「够格的本体」；② 本体不能只有孤零零 1 个非模型素材——
        #     独立的一张图/一段动图无法构成「宠物本体」（实测：Theatre 的 91 帧透明录屏
        #     art/sample.gif 会被单条规则放行）。
        qualified_body = [(c, probe) for c, probe in classified if c.is_body and pet_roles.is_qualified_body(c, probe)]
        has_model = any(c.role == "body-model" for c, _ in qualified_body)
        if not qualified_body or (not has_model and len(qualified_body) < 2):
            reason = (
                "包内没有足够的宠物本体资源"
                + ("（0 个够格本体；" if not qualified_body else f"（仅 {len(qualified_body)} 个且无模型；")
                + "已判定角色：" + "、".join(f"{k}×{v}" for k, v in sorted(role_stats.items())) + "）"
            )
            report["skipped"].append({
                "fullName": full_name,
                "rank": row["rank"],
                "reason": reason,
                "roleStats": role_stats,
                "samples": [{"path": c.path, "role": c.role, "because": c.evidence[0]} for c, _ in classified[:8]],
            })
            print(f"  [rank {row['rank']:>3}] {full_name:<42} 跳过：没有够格本体（{role_stats}）")
            continue

        kept: list[dict] = []
        vector_kept: list[dict] = []
        for (c, _probe), f in zip(classified, decodable):
            if c.is_pack_eligible:
                if c.path.lower().endswith(".svg"):
                    # 矢量素材：Pillow 不能栅格化，但 Chromium 可直接渲染 → 资源库（矢量）通道
                    vector_kept.append(f)
                else:
                    kept.append(f)
            else:
                reason = f"非宠物本体（{pet_roles.ROLE_LABELS.get(c.role, c.role)}）：{c.evidence[0]}"
                mark(c.path, "excluded:non-body", reason)
                proj["excluded"].append({"path": c.path, "role": c.role, "reason": reason})

        unit_stats: dict = {"skipped": []}
        units, statics = build_units(repo_dir, kept, unit_stats)
        # 序列帧中的静态兜底、以及解码失败的单元，都源自 considered 文件
        for s in statics:
            s.setdefault("kind", "static")
        proj["units"] = len(units)
        proj["statics"] = len(statics)

        # 魔数通过但 Pillow 打不开的文件：显式记账（否则就是账本缺口）
        for s in unit_stats["skipped"]:
            mark(s["path"], "excluded:undecodable", s["reason"])
            proj["excluded"].append({"path": s["path"], "reason": s["reason"]})

        by_char: dict[str, list[dict]] = defaultdict(list)
        for u in units:
            by_char[character_key(u["dir"])].append(u)

        frame_budget = args.max_frames_per_repo
        pet_index = 0
        for char in sorted(by_char):
            group = by_char[char]
            packs = [group[i:i + args.max_actions_per_pet] for i in range(0, len(group), args.max_actions_per_pet)]
            for pack_no, pack in enumerate(packs, start=1):
                if pet_index >= args.max_pets_per_repo:
                    for u in pack:
                        for p in u["paths"]:
                            mark(p, "excluded:cap-pets", f"超过单仓库宠物数上限 {args.max_pets_per_repo}")
                            proj["excluded"].append({"path": p, "reason": f"超过单仓库宠物数上限 {args.max_pets_per_repo}"})
                    continue

                base_id = repo_slug if char == "main" and len(packs) == 1 else f"{repo_slug}-{petart.slugify(char.replace('/', '-'), 28)}"
                pet_id = petart.slugify(base_id if pack_no == 1 else f"{base_id}-{pack_no}", 60)
                n = 2
                while pet_id in used_pet_ids:
                    pet_id = petart.slugify(f"{base_id}-{n}", 60)
                    n += 1

                assigned: dict[str, dict] = {}
                used_units: set[int] = set()
                for i, u in enumerate(pack):
                    key = unit_interaction(u)
                    if key and key not in assigned:
                        assigned[key] = u
                        used_units.add(i)
                for key in INTERACTION_ORDER:
                    if key not in assigned:
                        for i, u in enumerate(pack):
                            if i not in used_units:
                                assigned[key] = u
                                used_units.add(i)
                                break

                action_plan = []
                for u in pack:
                    imgs, err = load_unit_frames(repo_dir, u, {"skipped": []})
                    if imgs is None:
                        for p in u["paths"]:
                            mark(p, "excluded:undecodable", err)
                            proj["excluded"].append({"path": p, "reason": err})
                        continue
                    imgs, capped = subsample(imgs, args.max_frames_per_action)
                    if len(imgs) > frame_budget:
                        for p in u["paths"]:
                            mark(p, "excluded:cap-frames", f"超过单仓库动作帧上限 {args.max_frames_per_repo}")
                            proj["excluded"].append({"path": p, "reason": f"超过单仓库动作帧上限 {args.max_frames_per_repo}"})
                        continue
                    frame_budget -= len(imgs)
                    interaction = next((k for k, v in assigned.items() if v is u), None)
                    label = ACTION_LABEL[interaction] if interaction else unit_label(u)
                    rate = gif_frame_rate(os.path.join(repo_dir, u["path"].replace("/", os.sep))) if u["kind"] == "animated" else 8.0
                    action_plan.append({"unit": u, "frames": imgs, "interaction": interaction or "none", "label": label,
                                        "rate": rate, "capped": capped, "originalFrames": u["frames"]})
                    for p in u["paths"]:
                        mark(p, "used:action", f"进入动作 {u['prefix'] or os.path.basename(u['path'])}")

                if not action_plan:
                    continue

                cover_img = None
                cover_path = None
                char_dir = pack[0]["dir"]
                best = None
                for s in statics:
                    if char_dir and not s["dir"].startswith(char_dir):
                        continue
                    area = (s.get("w") or 0) * (s.get("h") or 0)
                    if best is None or area > best[0]:
                        best = (area, s)
                if best is not None:
                    s = best[1]
                    try:
                        cover_imgs = petart.load_frames(os.path.join(repo_dir, s["path"].replace("/", os.sep)))
                        cover_img = petart.normalize_unit(cover_imgs[:1]).frames[0].image
                        cover_path = s["path"]
                    except Exception as exc:
                        proj["excluded"].append({"path": s["path"], "reason": f"封面归一化失败：{exc}"})
                if cover_img is None:
                    # 必须同样过一遍归一化：直接拿源帧当封面会让封面尺寸（如 412x344）与帧画布（512）不一致，
                    # 渲染端对 cover 与帧用同一缩放公式，尺寸混用会造成启用瞬间的尺寸跳变。
                    cover_img = petart.normalize_unit([action_plan[0]["frames"][0]]).frames[0].image

                pet_rec = {
                    "id": pet_id,
                    "character": char,
                    "name": f"{full_name.split('/')[1]} · {char}" if char != "main" else full_name.split("/")[1],
                    "actions": [],
                    "coverFrom": cover_path or f"{action_plan[0]['unit']['path']}#frame0",
                    "frameCount": 0,
                    "bytes": 0,
                }

                if write:
                    pet_dir = os.path.join(BUILTIN_DIR, pet_id)
                    os.makedirs(pet_dir, exist_ok=True)
                    text_base = {"Source": f"https://github.com/{full_name}", "License": row.get("license", ""), "Generator": GENERATOR}
                    cover_sha = petart.write_png(os.path.join(pet_dir, "cover.png"), cover_img, {**text_base, "Role": "cover"})
                    pet_rec["coverSha256"] = cover_sha
                    pet_rec["bytes"] += os.path.getsize(os.path.join(pet_dir, "cover.png"))

                    for ai, ap_ in enumerate(action_plan):
                        aid = petart.slugify(f"{ap_['interaction'] if ap_['interaction'] != 'none' else ''}-{unit_label(ap_['unit'])}", 40) or f"action-{ai}"
                        seen_aid = {a["id"] for a in pet_rec["actions"]}
                        base_aid = aid
                        n2 = 2
                        while aid in seen_aid:
                            aid = f"{base_aid}-{n2}"
                            n2 += 1
                        frames_meta = []
                        normalized = None
                        if write:
                            normalized = petart.normalize_unit(ap_["frames"])
                            for fi, nf in enumerate(normalized.frames):
                                rel = f"actions/{aid}/frame_{fi:03d}.png"
                                sha = petart.write_png(
                                    os.path.join(pet_dir, rel.replace("/", os.sep)),
                                    nf.image,
                                    {**text_base, "Role": "frame", "Action": aid, "OriginalPath": ap_["unit"]["path"]},
                                )
                                frames_meta.append({"file": rel, "sha256": sha})
                        else:
                            # dry-run 也要给出准确的帧数计划（写盘前先看体积/规模）
                            frames_meta = [{"file": f"actions/{aid}/frame_{i:03d}.png"} for i in range(len(ap_["frames"]))]
                        pet_rec["actions"].append({
                            "id": aid, "name": ap_["label"], "interaction": ap_["interaction"],
                            "frameRate": ap_["rate"], "frames": frames_meta,
                            "source": ap_["unit"]["path"], "sourceFiles": ap_["unit"]["paths"],
                            "sourceFrames": ap_["originalFrames"], "sampled": ap_["capped"],
                            "normalizeMode": normalized.mode if normalized else None,
                            "scale": normalized.scale if normalized else None,
                        })
                        pet_rec["frameCount"] += len(frames_meta)
                        if write:
                            pet_rec["bytes"] += sum(os.path.getsize(os.path.join(pet_dir, f["file"].replace("/", os.sep))) for f in frames_meta)

                    manifest = {
                        "schemaVersion": 1,
                        "id": pet_id,
                        "name": pet_rec["name"],
                        "description": f"来自 GitHub 开源项目 {full_name} 的美术资源（{pet_rec['character']}），"
                                       f"经并集包围盒归一化后导入；原素材 {len(action_plan)} 段动画、{pet_rec['frameCount']} 帧。",
                        "author": f"{full_name} 上游作者（GitHub）",
                        "license": licence_text,
                        "canvas": {"width": args.canvas, "height": args.canvas, "anchor": "center"},
                        "cover": {"file": "cover.png", "sha256": cover_sha},
                        "actions": [{k: a[k] for k in ("id", "name", "interaction", "frameRate", "frames")} for a in pet_rec["actions"]],
                        "provenance": {
                            "kind": "imported",
                            "generator": GENERATOR,
                            "version": GENERATOR_VERSION,
                            "generatedAt": date.today().isoformat(),
                        },
                        "origin": {
                            "provider": "github",
                            "repo": full_name,
                            "url": f"https://github.com/{full_name}",
                            "stars": row["stars"],
                            "releaseDownloads": row.get("releaseDownloads"),
                            "npmMonthly": row.get("npmMonthly"),
                            "pypiMonthly": row.get("pypiMonthly"),
                            "downloads": row.get("downloads", 0),
                            "combinedScore": row.get("combined"),
                            "rank": row["rank"],
                            "license": row.get("license", ""),
                            "licenseTier": row.get("licenceTier"),
                            "licenseReason": row.get("licenceReason"),
                            "modifications": "仅做等比缩放/补透明画布/并集包围盒对齐与统一锚点；未改绘制内容；PNG 内写入 tEXt 溯源信息",
                            "coverSource": pet_rec["coverFrom"],
                            "actionSources": [
                                {"action": a["id"], "interaction": a["interaction"], "sourcePath": a["source"],
                                 "sourceFiles": a["sourceFiles"], "sourceFrames": a["sourceFrames"],
                                 "importedFrames": len(a["frames"]), "frameRate": a["frameRate"],
                                 "normalizeMode": a["normalizeMode"], "scale": a["scale"], "sampled": a["sampled"]}
                                for a in pet_rec["actions"]
                            ],
                        },
                    }
                    with open(os.path.join(pet_dir, "manifest.json"), "w", encoding="utf-8") as fh:
                        json.dump(manifest, fh, ensure_ascii=False, indent=2)
                        fh.write("\n")
                    pet_rec["bytes"] += os.path.getsize(os.path.join(pet_dir, "manifest.json"))

                used_pet_ids.add(pet_id)
                pet_index += 1
                proj["pets"].append(pet_rec)

        # ---- 素材入库预算（矢量与栅格共用同一上限，保证单仓库总量可控）----
        lib_budget = args.max_library_per_repo

        # ---- 矢量素材（SVG）→ 资源库 ----
        # 不参与栅格帧管线（Pillow 不支持矢量），但登记进资源库：UI 可预览；
        # 需要当作宠物形象/动作时，用 scripts/pets/rasterize-svg.cjs（Electron/Chromium 栅格化）转换。
        for f in sorted(vector_kept, key=lambda x: x["path"]):
            path = f["path"]
            src_hash = f.get("sha256", "")
            if src_hash and src_hash in global_source_hashes:
                mark(path, "used:dedup", f"与已入库素材内容相同：{global_source_hashes[src_hash]}")
                proj["dedup"].append({"source": path, "dedup": global_source_hashes[src_hash]})
                continue
            if lib_budget <= 0:
                mark(path, "excluded:cap-library", f"超过单仓库资源库上限 {args.max_library_per_repo}")
                proj["excluded"].append({"path": path, "reason": f"超过单仓库资源库上限 {args.max_library_per_repo}"})
                continue
            rel_out = f"{repo_slug}/{petart.slugify(os.path.splitext(path)[0].replace('/', '-'), 44)}-{short_hash(path)}.svg"
            if write:
                try:
                    with open(os.path.join(repo_dir, path.replace("/", os.sep)), "rb") as fh:
                        data = fh.read()
                    target = os.path.join(LIBRARY_DIR, rel_out.replace("/", os.sep))
                    os.makedirs(os.path.dirname(target), exist_ok=True)
                    with open(target, "wb") as fh:
                        fh.write(data)
                    entry = {"file": rel_out, "source": path, "format": "svg", "sha256Source": src_hash,
                             "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
                    if src_hash:
                        global_source_hashes[src_hash] = rel_out
                    lib_budget -= 1
                    mark(path, "used:library-vector", "矢量素材进入资源库（可预览；栅格化后可作形象/动作）")
                    proj["library"].append(entry)
                except Exception as exc:
                    mark(path, "excluded:undecodable", f"矢量素材登记失败：{exc}")
                    proj["excluded"].append({"path": path, "reason": f"矢量素材登记失败：{exc}"})
            else:
                lib_budget -= 1
                mark(path, "used:library-vector", "矢量素材进入资源库（可预览；栅格化后可作形象/动作）")
                proj["library"].append({"file": rel_out, "source": path, "format": "svg", "sha256Source": src_hash})

        # ---- 静态角色美术 → 资源库 ----
        # 质量优先：先按面积（细节量）降序，再按路径，避免「按字母序砍掉最好的立绘」
        statics_ranked = sorted(statics, key=lambda s: (-((s.get("w") or 0) * (s.get("h") or 0)), s["path"]))
        for s in statics_ranked:
            path = s["path"]
            if dispo.get(path, "").startswith("used:action"):
                continue  # 已作为动作素材（序列帧里的单帧等）
            src_hash = next((f["sha256"] for f in decodable if f["path"] == path), "")
            if src_hash and src_hash in global_source_hashes:
                mark(path, "used:dedup", f"与已入库素材内容相同：{global_source_hashes[src_hash]}")
                proj["dedup"].append({"source": path, "dedup": global_source_hashes[src_hash]})
                continue
            if lib_budget <= 0:
                mark(path, "excluded:cap-library", f"超过单仓库资源库上限 {args.max_library_per_repo}")
                proj["excluded"].append({"path": path, "reason": f"超过单仓库资源库上限 {args.max_library_per_repo}"})
                continue
            base_name = petart.slugify(os.path.splitext(path)[0].replace("/", "-"), 44)
            rel_out = f"{repo_slug}/{base_name}-{short_hash(path)}.png"
            if write:
                try:
                    imgs = petart.load_frames(os.path.join(repo_dir, path.replace("/", os.sep)))
                    edge = min(args.canvas, args.max_library_edge)
                    img = petart.fit_contain(imgs[0], edge)
                    sha = petart.write_png(
                        os.path.join(LIBRARY_DIR, rel_out.replace("/", os.sep)), img,
                        {"Source": f"https://github.com/{full_name}", "License": row.get("license", ""),
                         "OriginalPath": path, "Role": "library"},
                    )
                    entry = {"file": rel_out, "source": path, "format": "png", "sha256Source": src_hash, "sha256": sha,
                             "bytes": os.path.getsize(os.path.join(LIBRARY_DIR, rel_out.replace("/", os.sep)))}
                    if src_hash:
                        global_source_hashes[src_hash] = rel_out
                    lib_budget -= 1
                    mark(path, "used:library", "进入上游资源库（可设为形象/加为动作）")
                    proj["library"].append(entry)
                except Exception as exc:
                    mark(path, "excluded:undecodable", f"资源库归一化失败：{exc}")
                    proj["excluded"].append({"path": path, "reason": f"资源库归一化失败：{exc}"})
                    continue
            else:
                lib_budget -= 1
                mark(path, "used:library", "进入上游资源库（可设为形象/加为动作）")
                proj["library"].append({"file": rel_out, "source": path, "format": "png", "sha256Source": src_hash})

        # ---- 利用率账本：每个 considered 文件必须恰好一个处置 ----
        unaccounted = sorted(considered_set - set(dispo.keys()))
        for p in unaccounted:
            mark(p, "unaccounted", "账本缺失（需排查导入器）")
        counts: dict[str, int] = defaultdict(int)
        for kind in dispo.values():
            counts[kind] += 1
        proj["dispositions"] = dict(sorted(counts.items()))
        proj["unaccounted"] = unaccounted
        used = (counts.get("used:action", 0) + counts.get("used:library", 0)
                + counts.get("used:library-vector", 0) + counts.get("used:dedup", 0))
        proj["ledger"] = {
            "considered": len(considered),
            "used": used,
            "excluded": len(considered) - used,
            "accounted": len(dispo) == len(considered_set),
        }
        report["projects"].append(proj)
        imported_count += 1
        print(
            f"  [{imported_count:>2}/{args.projects}] rank {row['rank']:>3} {full_name:<40} 宠物 {len(proj['pets']):>2} 只 / 动作 "
            f"{sum(len(p['actions']) for p in proj['pets']):>3} 个 / 库 {len(proj['library']):>3} 张 "
            f"｜取得 {len(considered):>4} 用 {used:>4} 排 {len(considered) - used:>4}"
            f"{'  ⚠ 账本未覆盖 ' + str(len(unaccounted)) if unaccounted else ''}"
        )

    # ---- 全局汇总 ----
    totals: dict[str, int] = defaultdict(int)
    for proj in report["projects"]:
        for k, v in proj.get("dispositions", {}).items():
            totals[k] += v
        totals["projects"] += 1
        totals["pets"] += len(proj["pets"])
        totals["actions"] += sum(len(p["actions"]) for p in proj["pets"])
        totals["frames"] += sum(p["frameCount"] for p in proj["pets"])
        totals["library"] += len(proj["library"])
        totals["bytes"] += sum(p["bytes"] for p in proj["pets"])
        totals["considered"] += proj.get("ledger", {}).get("considered", 0)
        totals["used"] += proj.get("ledger", {}).get("used", 0)
        totals["unaccounted"] += len(proj.get("unaccounted", []))
    totals["excluded"] = totals["considered"] - totals["used"]
    report["totals"] = dict(sorted(totals.items()))

    if write:
        pets = []
        for name in sorted(os.listdir(BUILTIN_DIR)):
            mpath = os.path.join(BUILTIN_DIR, name, "manifest.json")
            if os.path.isfile(mpath):
                try:
                    pets.append(load_json(mpath)["id"])
                except Exception:
                    pass
        with open(os.path.join(BUILTIN_DIR, "index.json"), "w", encoding="utf-8") as fh:
            json.dump({"schemaVersion": 1, "pets": pets}, fh, ensure_ascii=False, indent=2)
            fh.write("\n")

        lib_entries = []
        for proj in report["projects"]:
            for e in proj["library"]:
                if "sha256" not in e:
                    continue
                lib_entries.append({
                    "file": e["file"], "sha256": e["sha256"], "bytes": e.get("bytes", 0),
                    "format": e.get("format", "png"),
                    "source": {"repo": proj["fullName"], "url": proj["url"], "license": proj["license"],
                               "originalPath": e["source"]},
                })
        with open(os.path.join(LIBRARY_DIR, "index.json"), "w", encoding="utf-8") as fh:
            json.dump({"schemaVersion": 1, "generatedAt": date.today().isoformat(),
                       "note": "上游静态美术资源库：任何一张都可在宠工坊「宠物资源」页设为形象或加为动作",
                       "entries": lib_entries}, fh, ensure_ascii=False, indent=2)
            fh.write("\n")

        lines = ["# 第三方资源归属与许可声明（自动生成，勿手改）", "",
                 f"生成时间：{date.today().isoformat()}｜生成器：`{GENERATOR}` v{GENERATOR_VERSION}", "",
                 "本文件列出 `resources/builtin-pets/` 与 `resources/pet-asset-library/` 中来自上游开源项目的资源，",
                 "包含来源仓库、许可、原始路径与所作修改。上游代码/资源版权归原作者所有。", "",
                 "筛选口径：仅纳入「宠物领域相关 + 有可解码美术 + 仓库级/资源级宽松许可(A 层)」的项目；",
                 "未声明许可(B)、传染性许可(C)、受限(D) 的项目不复制资源。详见 `docs/upstream-pet-assets.md`。", ""]
        for proj in report["projects"]:
            if not proj["pets"] and not proj["library"]:
                continue
            lines.append(f"## {proj['fullName']}")
            lines.append("")
            lines.append(f"- 来源：{proj['url']}")
            lines.append(f"- 许可：{proj['licenseText']}")
            lines.append(f"- 综合排序：第 {proj['rank']} 名（★{proj['stars']}，下载量 {proj.get('downloads', 0)}，" f"综合分 {proj.get('combined')}）")
            for p in proj["pets"]:
                lines.append(f"- 宠物 `{p['id']}`：{len(p['actions'])} 个动作 / {p['frameCount']} 帧；封面来自 `{p['coverFrom']}`")
                for a in p["actions"]:
                    lines.append(f"  - 动作 `{a['id']}`（{a['name']}，{len(a['frames'])} 帧）：源 `{a['source']}`"
                                 f"（原 {a['sourceFrames']} 帧，归一化 {a['normalizeMode']}，缩放 {a['scale']}）")
            if proj["library"]:
                lines.append(f"- 资源库：{len(proj['library'])} 张静态美术（`resources/pet-asset-library/{petart.slugify(proj['fullName'].replace('/', '-'), 40)}/`）")
            lines.append("")
        with open(os.path.join(BUILTIN_DIR, "ATTRIBUTION.md"), "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")

        with open(os.path.join(CACHE, "import-report.json"), "w", encoding="utf-8") as fh:
            json.dump(report, fh, ensure_ascii=False, indent=2)
            fh.write("\n")

    print("\n=== 汇总 ===")
    for k in sorted(report["totals"]):
        print(f"  {k:<24} {report['totals'][k]}")
    if report["totals"].get("unaccounted"):
        print(f"  ⚠ 有 {report['totals']['unaccounted']} 个文件未被账本覆盖，需排查")
    if write:
        print(f"\n已写入：{os.path.relpath(BUILTIN_DIR, ROOT)}、{os.path.relpath(LIBRARY_DIR, ROOT)}、.pet-research/import-report.json")
    else:
        print("\n（dry-run：未写盘。加 --write 执行）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
