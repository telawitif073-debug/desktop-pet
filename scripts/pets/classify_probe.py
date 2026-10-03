#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""诊断：用当前标准复核「已入库但疑似非本体」的真实文件（含 in_sequence 真实路径）。"""
import os
import sys

ROOT = r"E:\desktop-pet\Environment\downloads\upstream\pet-asset-scratch\repos"
sys.path.insert(0, r"E:\desktop-pet\scripts\pets")
import pet_roles  # noqa: E402

# (repo, 相对路径, 期望：must_not_be_body / must_be_body)
SAMPLES = [
    ("xuemian168__qqpet_automation", "qq-pet-macos/src/assets/iconList/LoginPanel/l1.gif", False),
    ("xuemian168__qqpet_automation", "qq-pet-macos/src/assets/iconList/OnlineQuitPrompt/Button_exit_00.png", False),
    ("xuemian168__qqpet_automation", "qq-pet-macos/src/assets/sysSeting/VolumeBtn00.png", False),
    ("xuemian168__qqpet_automation", "qq-pet-macos/src/assets/sysSeting/guanbi00.png", False),
    ("xuemian168__qqpet_automation", "qq-pet-macos/src/assets/sysSeting/moren00.png", False),
    ("xuemian168__qqpet_automation", "qq-pet-macos/src/assets/help/anniu00.png", False),
    ("xuemian168__qqpet_automation", "qq-pet-macos/src/assets/help/guanbi00.png", False),
    ("xuemian168__qqpet_automation", "qq-pet-macos/src/assets/stateInfo/dengji1.png", False),
    ("xuemian168__qqpet_automation", "qq-pet-macos/src/assets/stateInfo/shuaxin00.png", False),
    ("xuemian168__qqpet_automation", "qq-pet-macos/src/assets/img_res/medicine/10001.gif", False),
    ("ayangweb__BongoCat", "resources/models/keyboard/resources/left-keys/Num0.png", False),
    ("ayangweb__BongoCat", "resources/models/standard/resources/left-keys/Num0.png", False),
    ("LorisYounger__VPet", "README.assets/ss4.gif", False),
    ("LorisYounger__VPet", "VPet-Simulator.Windows/GameAssets/Tutorial.assets/CN/ss15.gif", False),
    ("MonsterEOS__monstereos", "services/frontend/src/assets/images/arenas/1.png", False),
    # —— 修复后必须仍然被认作本体的真实样本 ——
    ("QCYTSN__dsh-dafeiyu", "assets/pet/dragging/dragging_001.webp", True),
    ("rainnoon__oc-claw", "website/public/images/pets/furina_working.gif", True),
    ("LorisYounger__VPet", "VPet-Simulator.Windows/mod/0000_core/pet/vup/IDEL/Squat/C_Happy/0001.png", True),
    ("xuemian168__qqpet_automation", "qq-pet-macos/src/assets/active/play/danrendoule00.gif", True),
    ("kk43994__kkclaw", "assets/idle/idle_00.png", True),
]

fails = 0
for repo, rel, expect_body in SAMPLES:
    full = os.path.join(ROOT, repo, rel.replace("/", os.sep))
    if not os.path.isfile(full):
        print(f"[MISS] {repo}/{rel}")
        continue
    probe = pet_roles.probe_image(full)
    for in_seq in (False, True):
        p = dict(probe)
        if p and pet_roles.needs_alpha_check(rel, p, in_sequence=in_seq, strict=True):
            p["has_alpha"] = pet_roles.alpha_of(full)
        c = pet_roles.classify(rel, p, in_sequence=in_seq, strict=True)
        ok = c.is_body if expect_body else (not c.is_body)
        if not ok:
            fails += 1
        print(f"[{'OK ' if ok else 'BAD'}] in_seq={str(in_seq):<5} {c.role:>15} | {repo}/{rel}")
        if not ok:
            print(f"        why: {c.evidence[0]}")

print()
print(f"==== 失败样本数：{fails} ====")
