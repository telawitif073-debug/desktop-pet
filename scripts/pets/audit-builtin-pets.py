#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""端到端自审：用分类标准复核 resources/builtin-pets 里**每一只已入库宠物**的溯源源文件。

与导入器**同口径**：帧序列集合由「该仓库全部可解码美术文件」重建（不是只看被引用到的文件），
并用 strict=True 重新分类。期望：所有 imported 宠物的 sourcePath / coverSource 都判为 body-*（0 违例）。
"""
import json
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "scripts", "pets"))
import pet_roles  # noqa: E402

REPOS = os.path.join(ROOT, "Environment", "downloads", "upstream", "pet-asset-scratch", "repos")
BUILTIN = os.path.join(ROOT, "resources", "builtin-pets")
INVENTORY = os.path.join(ROOT, ".pet-research", "assets-inventory.json")


def norm_source(src: str) -> str:
    return re.sub(r"#frame\d+$", "", str(src or "")).strip()


def main() -> int:
    inventory = json.load(open(INVENTORY, encoding="utf-8"))
    inv_by = {r["fullName"]: r for r in inventory.get("repos", [])}

    checked = 0
    violations = []
    missing = []
    seq_cache: dict[str, set] = {}

    for pid in sorted(os.listdir(BUILTIN)):
        mpath = os.path.join(BUILTIN, pid, "manifest.json")
        if not os.path.isfile(mpath):
            continue
        m = json.load(open(mpath, encoding="utf-8"))
        origin = m.get("origin") or {}
        repo = origin.get("repo")
        if origin.get("provider") != "github" or not repo:
            continue  # 自产演示宠物（procedural）不参与
        repo_dir = os.path.join(REPOS, repo.replace("/", "__"))

        # 与导入器一致：帧序列集合来自该仓库全部可解码美术
        if repo not in seq_cache:
            decodable = [f["path"] for f in (inv_by.get(repo, {}).get("artFiles") or []) if f.get("decodable")]
            probes = {rel: pet_roles.probe_image(os.path.join(repo_dir, rel.replace("/", os.sep))) for rel in decodable}
            seq_cache[repo] = pet_roles.group_sequences(
                [(rel, int(p.get("width") or 0), int(p.get("height") or 0)) for rel, p in probes.items()]
            )
        seq = seq_cache[repo]

        sources = [("cover", norm_source(origin.get("coverSource")))]
        for a in origin.get("actionSources") or []:
            sources.append((f"action:{a.get('action')}", norm_source(a.get("sourcePath"))))

        for kind, rel in sources:
            if not rel:
                continue
            full = os.path.join(repo_dir, rel.replace("/", os.sep))
            if not os.path.isfile(full):
                missing.append((pid, rel))
                continue
            probe = pet_roles.probe_image(full)
            in_seq = rel in seq
            if probe and pet_roles.needs_alpha_check(rel, probe, in_sequence=in_seq, strict=True):
                probe["has_alpha"] = pet_roles.alpha_of(full)
            c = pet_roles.classify(rel, probe, in_sequence=in_seq, strict=True)
            checked += 1
            if not c.is_body:
                violations.append((pid, kind, rel, c.role, c.evidence[0] if c.evidence else ""))

    print(f"复核 imported 宠物源文件：{checked} 个")
    if missing:
        print(f"源文件缺失：{len(missing)} 个（前 5：{missing[:5]}）")
    if violations:
        print(f"\n！！违例 {len(violations)} 个（应为 0）：")
        for v in violations:
            print(f"  {v[0]} | {v[1]} | {v[2]} -> {v[3]}：{v[4]}")
        return 1
    print("\n✅ 0 违例：所有已入库宠物的溯源源文件都被判为宠物本体。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
