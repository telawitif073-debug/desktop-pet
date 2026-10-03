#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
宠物本体资源分类标准（`src/shared/petResource.ts` 的 Python 同口径移植）
===========================================================================
导入管线（Python）与运行时安装/上传链路（TypeScript）必须对「什么算宠物本体」给出一致结论，
否则会出现「脚本认为是本体、安装时被拒」的口径分裂。本模块与 TS 版逐条对应，覆盖同一批真实样本。

判定顺序（首个命中即定性）：
  1 declared  清单显式声明（最高信任）
  2 filename  硬性非本体文件名标记（cursor/notify/ic_launcher/logo/screenshot/pcb/…）
  3 dir       目录角色（非本体目录优先，再看本体目录的强/弱标记）
  4 ext       扩展名定类（模型 / 字体 / 音频）
  5 sequence  帧序列成员（同目录同前缀 ≥2 帧且尺寸一致）
  6 content   内容与几何（动画 / 带 alpha 的达标静帧 / 否则 fail-closed）
  7 fallback  → unknown（不入包）

两种证据策略（同一个标准，不同场景）：
  strict=False（用户显式选中的资源包 / 主动上传）：允许内容启发式。
  strict=True （批量抓取第三方仓库）：本体必须有**结构性证据**——清单、本体目录、模型，
    或「透明通道」证明的真精灵动画。实测理由：仅凭「带 alpha 的大图」会把键盘键帽精灵、
    Live2D 贴图集、Windows 磁贴图标、带透明的宣传截图/流程图统统认成本体
    （BongoCat / openpets / Theatre / Bjorn / TamaFi 均中招）。
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field

BODY_ROLES = ("body-animation", "body-still", "body-model")
DERIVED_ROLES = ("body-cover",)
PACK_ELIGIBLE_ROLES = BODY_ROLES + DERIVED_ROLES

ROLE_LABELS = {
    "body-animation": "本体动画（帧序列/动图/视频）",
    "body-still": "本体静帧（角色立绘）",
    "body-model": "本体模型（Live2D/3D）",
    "body-cover": "本体派生（封面/预览）",
    "ui": "界面件（光标/图标/按钮）",
    "meme": "表情包（对话配图）",
    "prop": "道具/物品（喂食物品、商品、背包图标）",
    "texture": "模型贴图/精灵表（非独立动画帧）",
    "branding": "品牌资源（logo/字体/宣传图）",
    "document": "文档图（截图/示意/PCB）",
    "audio": "音频（非美术本体）",
    "unknown": "无法判定（fail-closed）",
}

ANIM_EXTS = {".gif", ".webp", ".apng", ".webm", ".mp4", ".mov", ".mkv", ".avi"}
STILL_EXTS = {".png", ".jpg", ".jpeg", ".jfif", ".bmp", ".avif", ".tiff", ".tif", ".ico"}
AUDIO_EXTS = {".mp3", ".ogg", ".wav", ".m4a", ".aac", ".flac", ".opus", ".oga"}
FONT_EXTS = {".ttf", ".otf", ".woff", ".woff2", ".eot"}
MODEL_EXTS = {".moc3", ".cmo3", ".glb", ".gltf", ".vrm", ".fbx", ".obj"}
VIDEO_EXTS = {".webm", ".mp4", ".mov", ".mkv", ".avi"}
IMAGE_LIKE_EXTS = ANIM_EXTS | STILL_EXTS
NO_ALPHA_EXTS = {".jpg", ".jpeg", ".jfif", ".bmp"}  # 规范上无 alpha 通道，无需解码即可判定

MIN_BODY_STILL_EDGE = 128
MAX_BODY_ASPECT = 2.5

HARD_NAME_RULES: list[tuple[re.Pattern, str, str]] = [
    # 模型贴图/图集/精灵表：不是「一帧动画」，而是模型的贴图页或整张精灵表
    (re.compile(r"(^|[-_])(texture|textures|tex|atlas|atlases|sheet|sheets|spritesheet|sprite[-_]?sheet|tileset|tilesets)[-_]?\d*([-_]|$)", re.I),
     "texture", "模型贴图/精灵表（非独立动画帧）"),
    (re.compile(r"^(cursor|pointer)[-_]?", re.I), "ui", "光标资源（界面件）"),
    (re.compile(r"^(notify|notification|toast|alert)[-_]?", re.I), "ui", "通知/提示图标（界面件）"),
    (re.compile(r"^ic[_-]?(launcher|menu|toolbar|tab|action)", re.I), "ui", "应用/控件图标（界面件）"),
    (re.compile(r"^(app[-_]?icon|appicon|favicon|splash[-_]?icon)", re.I), "ui", "应用图标（界面件）"),
    (re.compile(r"^(logo|brand|brandmark|wordmark|watermark)", re.I), "branding", "品牌标识"),
    (re.compile(r"^(og[-_]?image|social[-_]?(preview|card)|twitter[-_]?card|banner|poster[-_]?social)", re.I), "branding", "社交/宣传图"),
    (re.compile(r"(screenshot|screen[_-]?shot|屏幕截图)", re.I), "document", "截图（文档/说明用）"),
    (re.compile(r"(^|[-_])(pcb|schematic|wiring|circuit|blueprint)([-_]|$)", re.I), "document", "硬件示意图（非角色美术）"),
    (re.compile(r"(^|[-_])(bom|dimension|dimensions|pinout|footprint)([-_]|$)", re.I), "document", "工程图（非角色美术）"),
    (re.compile(r"(diagram|flowchart|architecture|uml)", re.I), "document", "结构/流程示意图"),
    (re.compile(r"^(readme|changelog|license|licence|notice)([-_.]|$)", re.I), "document", "说明/许可文档"),
]

NON_BODY_DIR_GROUPS: list[tuple[frozenset, str, str]] = [
    (frozenset({"texture", "textures", "atlas", "atlases", "spritesheet", "spritesheets", "tileset", "tilesets",
                "贴图", "图集", "精灵表"}), "texture", "模型贴图/精灵表目录（非独立动画帧）"),
    (frozenset({"commodity", "commoditys", "item", "items", "prop", "props", "food", "foods", "goods",
                "inventory", "backpack", "shop", "store", "道具", "物品", "商品", "食物", "背包"}), "prop", "物品/道具目录（非宠物本体）"),
    (frozenset({"meme", "memes", "sticker", "stickers", "emoji", "emojis", "reaction", "reactions",
                "表情包", "表情", "贴纸", "梗图"}), "meme", "表情包目录（非本体）"),
    (frozenset({"ui", "icon", "icons", "chrome", "widget", "widgets", "button", "buttons", "scrollbar",
                "cursor", "cursors", "notify", "notification", "badge", "badges", "toolbar",
                "mipmap", "drawable", "res", "uigraphics", "uikit", "iconfont", "help",
                "图标", "光标", "界面", "控件", "帮助"}), "ui", "界面件目录"),
    (frozenset({"brand", "branding", "logo", "logos", "social", "marketing", "press", "font", "fonts",
                "品牌", "宣传", "字体"}), "branding", "品牌/字体目录"),
    (frozenset({"doc", "docs", "document", "documents", "screenshot", "screenshots", "schematic", "schematics",
                "pcb", "hardware", "wiring", "reference", "references", "sample", "samples", "example",
                "examples", "gallery", "diagram", "diagrams",
                "截图", "文档", "说明", "示意图", "原理图", "电路", "硬件"}), "document", "文档/示意目录（非本体）"),
    (frozenset({"preview", "previews", "thumb", "thumbs", "thumbnail", "thumbnails", "cover", "covers",
                "poster", "posters", "showcase", "预览", "封面", "缩略图"}), "body-cover", "预览/封面目录（本体派生）"),
]

# 目录名**子串**标记：真实语料里大量非本体素材放在复合目录名里（README.assets / Tutorial.assets /
# iconList / sysSeting / stateInfo / left-keys / img_res / medicine / arenas…），归一化后
# （去空格/下划线/连字符）不会与上面的精确词表相等 → 必须按子串命中。
# 证据来源：第 6 节反例清单 + 2026-10-03 对已入库宠物的逐条复核（见
# .trae/documents/pet-resource-system-refactor.md）。仅命中「目录段」，不参与文件名判定。
NON_BODY_DIR_SUBSTR: list[tuple[str, str, str]] = [
    ("readme", "document", "说明/文档素材目录（非本体）"),
    ("tutorial", "document", "教程素材目录（非本体）"),
    ("arenas", "document", "场景/竞技场背景图（非宠物本体）"),
    ("iconlist", "ui", "图标清单目录（界面件）"),
    ("loginpanel", "ui", "登录面板素材（界面件）"),
    ("onlinequitprompt", "ui", "退出确认按钮素材（界面件）"),
    ("sysseting", "ui", "系统设置界面素材（界面件）"),
    ("syssetting", "ui", "系统设置界面素材（界面件）"),
    ("stateinfo", "ui", "状态信息界面素材（界面件）"),
    ("leftkeys", "ui", "键盘按键精灵（输入层，非宠物本体）"),
    ("rightkeys", "ui", "键盘按键精灵（输入层，非宠物本体）"),
    ("medicine", "prop", "药品/道具图标（非宠物本体）"),
    ("imgres", "prop", "游戏资源图（物品/界面，非宠物本体）"),
]

# 本体目录分两级：强标记本身就是「宠物/角色素材」的声明；弱标记只是状态名，
# 只有在宠物目录树内才有意义，因此严格模式还要求「透明通道」补充证据
# （否则 Bjorn 的机器人状态帧 resources/images/status/IDLE/*.bmp 也会中招）。
STRONG_BODY_DIRS = frozenset({
    "pet", "pets", "body", "character", "characters", "sprite", "sprites", "spriteframe", "spriteframes",
    "frame", "frames", "action", "actions", "anim", "anims", "animation", "animations", "motion", "motions",
    "角色", "立绘", "宠物", "桌宠", "精灵", "形象",
})
WEAK_STATE_DIRS = frozenset({
    "state", "states", "idle", "walk", "walking", "run", "running", "drag", "dragging", "climb", "fall", "sit",
    "sleep", "eat", "play", "work", "working",
})

DERIVED_NAME_RE = re.compile(r"^(cover|preview|thumb|thumbnail|poster|avatar|portrait)", re.I)
SEQ_NAME_RE = re.compile(r"^(.*?)[-_ .]?(\d{1,4})$")


@dataclass
class Classified:
    path: str
    role: str
    decided_by: str
    evidence: list[str] = field(default_factory=list)

    @property
    def is_body(self) -> bool:
        return self.role in BODY_ROLES

    @property
    def is_pack_eligible(self) -> bool:
        return self.role in PACK_ELIGIBLE_ROLES


def norm_dir(name: str) -> str:
    """目录名归一化：小写并去掉空格/下划线/连字符，使 'Ui Graphics' 与 'ui-graphics' 同口径"""
    return re.sub(r"[\s_\-]+", "", str(name or "").lower())


def normalize(rel_path: str) -> str:
    return str(rel_path or "").replace("\\", "/").lstrip("./")


def segments(rel_path: str) -> list[str]:
    return [s for s in normalize(rel_path).split("/") if s and s != "."]


def ext_of(rel_path: str) -> str:
    base = normalize(rel_path).split("/")[-1].lower()
    if base.endswith(".model3.json") or re.search(r"\.live2d(-lite)?\.json$", base):
        return ".model3.json"
    i = base.rfind(".")
    return base[i:] if i > 0 else ""


def stem_of(rel_path: str) -> str:
    base = normalize(rel_path).split("/")[-1]
    low = base.lower()
    for suffix in (".model3.json", ".live2d-lite.json", ".live2d.json"):
        if low.endswith(suffix):
            return base[: len(base) - len(suffix)]
    i = base.rfind(".")
    return base[:i] if i > 0 else base


def has_alpha_capable_format(rel_path: str) -> bool:
    return ext_of(rel_path) not in NO_ALPHA_EXTS


def classify(rel_path: str, probe: dict | None = None, *, in_sequence: bool = False,
             declared_role: str | None = None, strict: bool = False) -> Classified:
    """按标准给单个资源定性。probe 可含 width/height/frames/animated/has_alpha。"""
    p = normalize(rel_path)
    ext = ext_of(p)
    stem = stem_of(p)
    dir_pairs = [(s, norm_dir(s)) for s in segments(p)[:-1]]
    probe = probe or {}
    w = int(probe.get("width") or 0)
    h = int(probe.get("height") or 0)
    aspect = (max(w, h) / max(1, min(w, h))) if (w and h) else 0.0
    frames = int(probe.get("frames") or 0)
    animated = bool(probe.get("animated")) or frames > 1
    transparent = probe.get("has_alpha") is True

    # 1) 清单声明
    if declared_role:
        return Classified(p, declared_role, "declared", [f"清单声明为 {declared_role}"])

    # 2) 硬性非本体文件名标记
    for rx, role, why in HARD_NAME_RULES:
        if rx.search(stem):
            return Classified(p, role, "filename", [f"文件名标记：{why}（{stem}）"])

    # 3) 目录角色：按「角色特异性」优先，而不是按路径深度
    #    （`res/atlases/char.png` 里 `atlases` 比 `res` 更具体 → texture）
    for names, role, why in NON_BODY_DIR_GROUPS:
        hit = next((raw for raw, seg in dir_pairs if seg in names), None)
        if hit:
            return Classified(p, role, "dir", [f"目录标记 {hit}/：{why}"])
    for token, role, why in NON_BODY_DIR_SUBSTR:
        hit = next((raw for raw, seg in dir_pairs if token in seg), None)
        if hit:
            return Classified(p, role, "dir", [f"目录标记 {hit}/：{why}"])
    strong_dir = next((raw for raw, seg in dir_pairs if seg in STRONG_BODY_DIRS), None)
    weak_dir = next((raw for raw, seg in dir_pairs if seg in WEAK_STATE_DIRS), None)
    body_dir_hit = strong_dir or weak_dir
    dir_ok = bool(strong_dir) or (bool(weak_dir) and (not strict or transparent))

    # 4) 扩展名定类
    if ext in MODEL_EXTS or ext == ".model3.json":
        return Classified(p, "body-model", "ext", [f"模型扩展名 {ext}（本体模型）"])
    if ext in FONT_EXTS:
        return Classified(p, "branding", "ext", [f"字体文件 {ext}"])
    if ext in AUDIO_EXTS:
        return Classified(p, "audio", "ext", [f"音频文件 {ext}（非美术本体）"])

    # 5) 帧序列成员
    #    严格模式下**不接受「透明通道」单独作证**：键盘键帽精灵、按钮三态（normal/hover/pressed）、
    #    贴图集都带 alpha，且天然就是「同目录同前缀、尺寸一致」的编号序列——若放行透明通道，
    #    这类界面件会稳定地伪装成「帧序列动画」。真正的主体序列必然处在本体目录里，
    #    或处在弱状态目录（idle/walk/play…）且带透明通道（dir_ok 已涵盖后者）。
    if in_sequence and ext in IMAGE_LIKE_EXTS:
        if not strict or dir_ok:
            return Classified(p, "body-animation", "content", ["帧序列成员（同目录同前缀 ≥2 帧且尺寸一致）→ 本体动画"])
        return Classified(p, "unknown", "fallback", [
            "严格模式：编号序列缺少本体目录声明（透明通道不足以证明是精灵动画——键帽/按钮态/贴图集同样带透明）→ 不作为本体",
        ])

    # 6) 内容与几何（本体目录内）
    if body_dir_hit and dir_ok and ext in IMAGE_LIKE_EXTS:
        strength = "强" if strong_dir else "弱"
        if animated or ext in VIDEO_EXTS:
            return Classified(p, "body-animation", "content",
                              [f"本体目录（{strength}）{body_dir_hit}/ 且为动画/序列（frames={frames or 'video'}）"])
        if "width" not in probe and "height" not in probe:
            return Classified(p, "body-still", "dir",
                              [f"本体目录（{strength}）{body_dir_hit}/（缺少内容探测：尺寸/alpha 待确认）"])
        if not w or not h:
            return Classified(p, "unknown", "fallback", ["本体目录内，但读不出图像尺寸（截断/格式不支持）：fail-closed"])
        if w >= MIN_BODY_STILL_EDGE and h >= MIN_BODY_STILL_EDGE and aspect <= MAX_BODY_ASPECT:
            return Classified(p, "body-still", "content",
                              [f"本体目录（{strength}）{body_dir_hit}/，静帧 {w}×{h}（长宽比 {aspect:.2f}）"])
        return Classified(p, "unknown", "fallback", [
            f"本体目录 {body_dir_hit}/，但静帧尺寸/比例不达标（{w}×{h}，需 ≥{MIN_BODY_STILL_EDGE}px 且长宽比 ≤{MAX_BODY_ASPECT}）",
            "fail-closed：不认作本体",
        ])

    # 7) 派生命名 / 通用图片
    if DERIVED_NAME_RE.search(stem):
        if strict:
            return Classified(p, "unknown", "fallback", [
                "严格模式：无派生目录（preview/cover/thumbs）声明的孤立封面/预览图，无法确认其所属本体 → 不作为本体",
            ])
        return Classified(p, "body-cover", "filename", [f"文件名标记：封面/预览（{stem}）"])

    if ext in IMAGE_LIKE_EXTS:
        has_alpha = probe.get("has_alpha")
        if animated or ext in VIDEO_EXTS:
            if not strict or transparent:
                return Classified(p, "body-animation", "content", [f"动画/视频（frames={frames or 'video'}，无目录声明）"])
            return Classified(p, "unknown", "fallback", [
                "严格模式：无本体目录声明且无透明通道的动画（疑似录屏/宣传图）→ 不作为本体",
            ])
        if not strict and has_alpha is True and w >= MIN_BODY_STILL_EDGE and h >= MIN_BODY_STILL_EDGE and aspect <= MAX_BODY_ASPECT:
            return Classified(p, "body-still", "content", [f"静帧带有效 alpha 且尺寸达标（{w}×{h}，长宽比 {aspect:.2f}）"])
        if strict:
            return Classified(p, "unknown", "fallback", [
                "严格模式：缺少本体目录/清单声明的孤立静帧不作为本体（避免键帽贴图/磁贴图标/宣传截图混入）",
            ])
        if not probe:
            return Classified(p, "unknown", "fallback", ["孤立静帧且缺少内容探测：无法确认是否本体（fail-closed）"])
        if not w or not h:
            return Classified(p, "unknown", "fallback", ["读不出图像尺寸（截断/格式不支持）：无法判定，fail-closed"])
        reasons = []
        if has_alpha is not True:
            reasons.append("无有效 alpha（疑似含背景的截图/照片）")
        if not (w >= MIN_BODY_STILL_EDGE and h >= MIN_BODY_STILL_EDGE):
            reasons.append(f"尺寸过小（{w}×{h}）")
        if aspect > MAX_BODY_ASPECT:
            reasons.append(f"长宽比 {aspect:.2f} 超过 {MAX_BODY_ASPECT}（横幅/文档图）")
        return Classified(p, "document", "content", [f"非本体图：{'；'.join(reasons)}", "fail-closed：不认作本体"])

    return Classified(p, "unknown", "fallback", [f"未知类型（ext={ext or '无'}）：不入包", "fail-closed"])


def is_qualified_body(c: Classified, probe: dict | None = None) -> bool:
    """是否「够格的本体」：模型 / 动画 恒真；静帧需尺寸达标且未明确无 alpha。"""
    if c.role in ("body-model", "body-animation"):
        return True
    if c.role != "body-still":
        return False
    p = probe or {}
    w, h = int(p.get("width") or 0), int(p.get("height") or 0)
    if not (w >= MIN_BODY_STILL_EDGE and h >= MIN_BODY_STILL_EDGE):
        return False
    if max(w, h) / max(1, min(w, h)) > MAX_BODY_ASPECT:
        return False
    return p.get("has_alpha") is not False


def needs_alpha_check(rel_path: str, probe: dict | None = None, *, in_sequence: bool = False,
                      strict: bool = False) -> bool:
    """是否需要为判定 alpha 而解码（严格模式：非强本体目录内的图片一律需要）。"""
    p = normalize(rel_path)
    ext = ext_of(p)
    if ext not in IMAGE_LIKE_EXTS or ext in VIDEO_EXTS or not has_alpha_capable_format(p):
        return False
    if any(rx.search(stem_of(p)) for rx, _, _ in HARD_NAME_RULES):
        return False
    dirs = [norm_dir(s) for s in segments(p)[:-1]]
    if any(seg in names for seg in dirs for names, _, _ in NON_BODY_DIR_GROUPS):
        return False
    if not strict and (in_sequence or ext in ANIM_EXTS):
        return False
    return not any(d in STRONG_BODY_DIRS for d in dirs)


def group_sequences(items: list[tuple[str, int, int]]) -> set[str]:
    """帧序列识别：同目录 + 同前缀 + 尺寸一致（且尺寸已知）的 ≥2 个文件。"""
    groups: dict[tuple[str, str], list[tuple[str, int, int]]] = {}
    for path, w, h in items:
        p = normalize(path)
        m = SEQ_NAME_RE.match(stem_of(p))
        if not m:
            continue
        d = p.rsplit("/", 1)[0] if "/" in p else ""
        groups.setdefault((d, m.group(1).lower()), []).append((p, w, h))
    out: set[str] = set()
    for members in groups.values():
        if len(members) < 2:
            continue
        dims = {(w, h) for _, w, h in members}
        if len(dims) != 1 or (0, 0) in dims:
            continue
        out.update(p for p, _, _ in members)
    return out


def probe_image(path: str) -> dict:
    """用 Pillow 读元数据（宽高/帧数/是否动画）；alpha 由 needs_alpha_check 决定是否另算。"""
    from PIL import Image  # 局部导入：纯规则部分在无 Pillow 环境下也能导入

    try:
        with Image.open(path) as im:
            frames = int(getattr(im, "n_frames", 1) or 1)
            return {
                "width": int(im.width),
                "height": int(im.height),
                "frames": frames,
                "animated": frames > 1 or bool(getattr(im, "is_animated", False)),
                "bytes": os.path.getsize(path),
            }
    except Exception:
        return {}


def alpha_of(path: str) -> bool:
    """是否存在有效 alpha（需要解码一次；只对需要判定的文件调用）"""
    from PIL import Image

    try:
        with Image.open(path) as im:
            if im.mode in ("RGBA", "LA"):
                return im.getchannel("A").getextrema()[0] < 250
            if im.mode == "P":
                return "transparency" in im.info
            return False
    except Exception:
        return False
