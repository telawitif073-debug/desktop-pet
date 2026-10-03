#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
宠物美术资源归一化核心库（纯 Pillow + numpy，无第三方图形依赖）
===========================================================================
把「任意来源的一帧一帧图片」变成本项目渲染端能直接消费的规范画布：

  512×512、RGBA、透明底、角色**同一位置同一尺寸**、脚底基线 anchorY=452、四周留白 30px

为什么必须这样做（与 scripts/build-builtin-pets.mjs 的设计约束一致）：
  渲染端对 cover 与动作帧使用同一缩放公式 min((W-60)/w, (H-60)/h)，
  且逐帧切换时不做对齐修正。若各帧画布尺寸/角色位置不一致，播放时会「跳变」。
  因此归一化的关键不是「把每帧裁紧再居中」，而是：
    1) 对同一段动画先求**所有帧的并集包围盒**（union bbox）；
    2) 用**同一个**缩放系数与**同一个**锚点把每一帧放进 512×512 画布。
  这样主体相对画布完全静止，抖动只可能来自素材本身的位移（那才是真动画）。

去背策略（三级，逐级降级，绝不静默丢弃素材）：
  A. 素材自带有效 alpha          → 直接用 alpha 裁边（最高保真）
  B. 四角颜色一致（纯色背景）    → 自边界 flood fill 抠底 + 1px 羽化
  C. 背景复杂/无法判定            → 不抠底，整图等比放入画布（rect 模式，仍可用作立绘/皮肤）

确定性：同输入同字节（PNG 固定 compress_level、无时间戳），便于「跑两遍无 diff」核验。
"""

from __future__ import annotations

import hashlib
import io
import os
from dataclasses import dataclass, field
from typing import Iterable, Sequence

import numpy as np
from PIL import Image, ImageDraw, ImageSequence

SIZE = 512
MARGIN = 30
ANCHOR_Y = 452  # 脚底基线，对齐 build-builtin-pets.mjs 的 pet.anchorY
ALPHA_FLOOR = 8  # alpha 低于此值视为全透明


# ---------------------------------------------------------------------------
# 基础工具
# ---------------------------------------------------------------------------
def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_frames(path: str, max_frames: int = 240) -> list[Image.Image]:
    """读取静态图或动图（GIF/APNG/WebP）的全部帧，统一 RGBA。"""
    frames: list[Image.Image] = []
    with Image.open(path) as im:
        n = getattr(im, "n_frames", 1)
        for idx, frame in enumerate(ImageSequence.Iterator(im)):
            if idx >= max_frames:
                break
            frames.append(frame.convert("RGBA").copy())
        if not frames:  # 极端情况（0 帧）时兜底
            frames = [im.convert("RGBA").copy()]
    _ = n
    return frames


def image_info(path: str) -> dict:
    """不完整解码即可得到宽高/帧数/格式（用于清单）。"""
    try:
        with Image.open(path) as im:
            return {
                "format": im.format or "",
                "width": im.width,
                "height": im.height,
                "mode": im.mode,
                "frames": getattr(im, "n_frames", 1),
                "animated": getattr(im, "is_animated", False),
            }
    except Exception as exc:  # pragma: no cover - 损坏文件
        return {"format": "", "error": str(exc)}


def has_effective_alpha(img: Image.Image) -> bool:
    alpha = np.asarray(img.getchannel("A"))
    return bool((alpha > ALPHA_FLOOR).any()) and bool((alpha <= ALPHA_FLOOR).any())


def uniform_corner_colour(img: Image.Image, tol: int = 26) -> tuple[int, int, int] | None:
    """四角取样；颜色一致（互相差值 < tol）时返回该颜色，否则 None。"""
    w, h = img.size
    px = img.convert("RGB").load()
    pts = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]
    cols = [px[x, y] for x, y in pts]
    base = cols[0]
    for c in cols[1:]:
        if max(abs(c[i] - base[i]) for i in range(3)) > tol:
            return None
    return base


def remove_background(img: Image.Image, tol: int = 34, feather: bool = True) -> Image.Image:
    """自边界 flood fill 抠底（与 Node 版 t2i 抠底思路一致），返回带 alpha 的图。"""
    work = img.convert("RGBA").copy()
    w, h = work.size
    # 用一块 RGB 掩膜记录「被 flood fill 到的背景」，避免直接改图造成边缘色污染
    mask = Image.new("L", (w, h), 0)
    # 逐边建种子（只取每条边的若干采样点，PIL floodfill 会自行扩散）
    seeds: list[tuple[int, int]] = []
    step = max(1, min(w, h) // 64)
    for x in range(0, w, step):
        seeds.append((x, 0))
        seeds.append((x, h - 1))
    for y in range(0, h, step):
        seeds.append((0, y))
        seeds.append((w - 1, y))
    for sx, sy in seeds:
        if mask.getpixel((sx, sy)) == 0:
            ImageDraw.floodfill(mask, (sx, sy), 255, thresh=tol)

    arr = np.asarray(work).astype(np.uint8).copy()
    m = np.asarray(mask) > 127
    if not m.any():
        return work
    # 背景置全透明
    arr[..., 3][m] = 0
    if feather:
        # 1px 羽化：背景相邻的不透明像素 alpha 降至 190，避免锯齿硬边
        m_up = np.zeros_like(m)
        m_up[1:, :] |= m[:-1, :]
        m_up[:-1, :] |= m[1:, :]
        m_up[:, 1:] |= m[:, :-1]
        m_up[:, :-1] |= m[:, 1:]
        edge = m_up & ~m
        arr[..., 3][edge] = np.minimum(arr[..., 3][edge], 190)
    return Image.fromarray(arr, "RGBA")


def alpha_bbox(img: Image.Image, thresh: int = ALPHA_FLOOR) -> tuple[int, int, int, int] | None:
    alpha = np.asarray(img.getchannel("A"))
    ys, xs = np.where(alpha > thresh)
    if xs.size == 0 or ys.size == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def union_bbox(images: Sequence[Image.Image]) -> tuple[int, int, int, int]:
    """并集包围盒；全透明帧被忽略；全空时退化为整图。"""
    boxes = [b for b in (alpha_bbox(im) for im in images) if b]
    if not boxes:
        w, h = images[0].size
        return 0, 0, w, h
    x0 = min(b[0] for b in boxes)
    y0 = min(b[1] for b in boxes)
    x1 = max(b[2] for b in boxes)
    y1 = max(b[3] for b in boxes)
    return x0, y0, x1, y1


# ---------------------------------------------------------------------------
# 归一化
# ---------------------------------------------------------------------------
@dataclass
class NormalizedFrame:
    image: Image.Image
    source_index: int


@dataclass
class NormalizedUnit:
    frames: list[NormalizedFrame]
    mode: str                      # alpha | floodfill | rect
    source_size: tuple[int, int]
    union_bbox: tuple[int, int, int, int]
    scale: float
    notes: list[str] = field(default_factory=list)


def normalize_unit(frames: Sequence[Image.Image], *, allow_floodfill: bool = True) -> NormalizedUnit:
    """把一段动画/单帧归一化到 512×512 规范画布（同一缩放、同一锚点）。"""
    if not frames:
        raise ValueError("normalize_unit: 空帧序列")
    notes: list[str] = []
    src_w, src_h = frames[0].size
    mode = "rect"

    # --- 选去背模式（以首帧判定，动图逐帧同策略）---
    if has_effective_alpha(frames[0]):
        mode = "alpha"
        prepared = [f.convert("RGBA") for f in frames]
    elif allow_floodfill and uniform_corner_colour(frames[0]) is not None:
        mode = "floodfill"
        prepared = [remove_background(f) for f in frames]
        # 抠底后若几乎全透明，说明判定失败 → 退回 rect
        if all((np.asarray(p.getchannel("A")) > ALPHA_FLOOR).sum() == 0 for p in prepared):
            notes.append("flood fill 后全透明，退回 rect 模式")
            mode = "rect"
            prepared = [f.convert("RGBA") for f in frames]
    else:
        mode = "rect"
        notes.append("无 alpha 且四角颜色不一致，保留整图（rect 模式）")
        prepared = [f.convert("RGBA") for f in frames]

    # --- 统一包围盒（动画主体静止的关键）---
    if mode == "rect":
        box = (0, 0, src_w, src_h)
    else:
        box = union_bbox(prepared)
    bw = max(1, box[2] - box[0])
    bh = max(1, box[3] - box[1])

    avail_w = SIZE - 2 * MARGIN
    avail_h = ANCHOR_Y - MARGIN
    scale = min(avail_w / bw, avail_h / bh)
    if scale > 1.0 and mode != "rect":
        # 允许小幅放大到填满画布（素材普遍偏小，放大 1~3 倍是常态）
        scale = min(scale, 3.0)
    if mode == "rect":
        # rect 模式整图放入画布，不受 anchorY 限制（可能很高）
        scale = min(avail_w / bw, (SIZE - 2 * MARGIN) / bh)

    dst_w = max(1, int(round(bw * scale)))
    dst_h = max(1, int(round(bh * scale)))
    off_x = int(round((SIZE - dst_w) / 2))
    off_y = int(round(ANCHOR_Y - dst_h))

    out: list[NormalizedFrame] = []
    for idx, img in enumerate(prepared):
        cropped = img.crop(box)
        resized = cropped.resize((dst_w, dst_h), Image.LANCZOS)
        canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
        canvas.alpha_composite(resized, (off_x, off_y))
        out.append(NormalizedFrame(image=canvas, source_index=idx))

    return NormalizedUnit(
        frames=out,
        mode=mode,
        source_size=(src_w, src_h),
        union_bbox=box,
        scale=round(scale, 6),
        notes=notes,
    )


# ---------------------------------------------------------------------------
# 确定性 PNG 输出（带 tEXt 溯源元数据）
# ---------------------------------------------------------------------------
def png_bytes(img: Image.Image, text: dict[str, str] | None = None) -> bytes:
    from PIL import PngImagePlugin

    info = PngImagePlugin.PngInfo()
    for k, v in (text or {}).items():
        if v is None:
            continue
        info.add_text(str(k)[:79], str(v)[:1000])
    buf = io.BytesIO()
    img.convert("RGBA").save(buf, format="PNG", optimize=False, compress_level=9, pnginfo=info)
    return buf.getvalue()


def write_png(path: str, img: Image.Image, text: dict[str, str] | None = None) -> str:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    data = png_bytes(img, text)
    with open(path, "wb") as fh:
        fh.write(data)
    return sha256_bytes(data)


def fit_contain(img: Image.Image, size: int = SIZE, background: tuple[int, int, int, int] = (0, 0, 0, 0)) -> Image.Image:
    """等比缩放整图以完整放入 size×size（用于资源库缩略图/立绘）。"""
    w, h = img.size
    if w == 0 or h == 0:
        return Image.new("RGBA", (size, size), background)
    s = min(size / w, size / h)
    nw, nh = max(1, int(round(w * s))), max(1, int(round(h * s)))
    resized = img.convert("RGBA").resize((nw, nh), Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), background)
    canvas.alpha_composite(resized, ((size - nw) // 2, (size - nh) // 2))
    return canvas


def slugify(text: str, max_len: int = 48) -> str:
    """目录/ID 安全化：小写字母数字与连字符。"""
    out = []
    prev_dash = False
    for ch in text.lower():
        if ch.isalnum() and ord(ch) < 128:
            out.append(ch)
            prev_dash = False
        else:
            if not prev_dash:
                out.append("-")
                prev_dash = True
    s = "".join(out).strip("-")
    return (s or "pet")[:max_len].strip("-")


def is_frames_dirname(name: str) -> bool:
    """形如 frame_001 / 0001 / eat_3 的序列帧命名。"""
    import re

    return bool(re.search(r"\d{1,4}$", name))
