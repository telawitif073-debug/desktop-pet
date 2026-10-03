import { describe, expect, it } from 'vitest';
import {
  classifyResource,
  evaluatePetPack,
  groupFrameSequences,
  isPetBodyRole,
  isQualifiedBody,
  summarizeRoles,
  MIN_BODY_STILL_EDGE,
  type ResourceEntry,
  type ResourceProbe,
} from './petResource';

/** 静帧探测：默认带 alpha（抠像立绘） */
const still = (width: number, height: number, hasAlpha = true): ResourceProbe => ({ width, height, hasAlpha, frames: 1 });
/** 动画探测：多帧 */
const anim = (width: number, height: number, frames = 8): ResourceProbe => ({ width, height, hasAlpha: true, frames, animated: true });

const cls = (path: string, probe?: ResourceProbe) => classifyResource({ path, probe });

describe('宠物本体资源分类 · 非本体必须被拒（真实失败样本）', () => {
  // 这些路径全部来自上一轮导入产物里被错误收进「宠物资源库」的真实文件
  const nonBody: Array<[string, ResourceProbe | undefined, string]> = [
    ['cifertech-tamafi/PCB/PCB Dimension.jpg', still(1200, 800, false), 'document'],
    ['cifertech-tamafi/Schematic/BOM.jpg', still(1000, 700, false), 'document'],
    ['cifertech-tamafi/Schematic/Schematic.jpg', still(1400, 900, false), 'document'],
    ['cifertech-tamafi/Ui Graphics/pic/UI.jpg', still(800, 600, false), 'ui'],
    ['andremion-theatre/presentation/src/main/res/mipmap-xxxhdpi/ic_launcher_foreground.png', still(432, 432, true), 'ui'],
    ['andremion-theatre/presentation/src/main/res/mipmap-mdpi/ic_launcher.png', still(48, 48, true), 'ui'],
    ['andremion-theatre/art/feature-graphic.png', still(1024, 500, false), 'document'],
    ['andremion-theatre/art/event_detail.png', still(1080, 1920, false), 'document'],
    ['akshitagupta15june-petme/screenshot.png', still(1920, 1080, false), 'document'],
    ['dsh-pet/assets/memes/吃白饭的大肥鱼.png', still(512, 512, false), 'meme'],
    ['dsh-pet/assets/memes/大的要来啦.png', still(512, 512, false), 'meme'],
    ['dsh-pet/assets/pic/cursor-grab.png', still(64, 64, true), 'ui'],
    ['dsh-pet/assets/pic/notify-done.png', still(64, 64, true), 'ui'],
    ['dsh-pet/assets/logo.png', still(512, 512, true), 'branding'],
    ['dsh-pet/assets/fonts/上首软糖体.ttf', undefined, 'branding'],
    ['dsh-pet/assets/pet/voice/eat.mp3', undefined, 'audio'],
    ['some-pack/docs/pet-intro.png', still(1200, 800, false), 'document'],
    ['some-pack/ui/button-hover.png', still(96, 32, true), 'ui'],
    ['some-pack/pet/icons/star.png', still(16, 16, true), 'ui'],
    ['some-pack/pet/memes/wave.png', still(300, 300, true), 'meme'],
    ['some-pack/pet/fonts/Title.otf', undefined, 'branding'],
    // 道具/物品目录：QQ 宠物的商品图标、VPet 的喂食物品都是「道具」而非宠物本体
    ['qqpet_automation/qq-pet-macos/src/assets/img_res/commodity/100020146.gif', anim(20, 20, 6), 'prop'],
    ['VPet-Simulator.Windows/mod/0000_core/image/food/rice.png', still(64, 64, true), 'prop'],
    ['some-pack/pet/items/ball.png', still(48, 48, true), 'prop'],
    // 模型贴图/精灵表：Live2D 贴图页与整张精灵表都不是「一帧动画」
    ['dsh-pet/resources/models/standard/demomodel.1024/texture_00.png', still(1024, 512, true), 'texture'],
    ['some-pack/assets/default-pet-spritesheet.webp', still(1280, 720, false), 'texture'],
    ['some-pack/res/atlases/char.atlas.png', still(1024, 1024, true), 'texture'],
    // 特异性优先于路径深度：atlases（贴图）比 res（泛资源目录）更具体
    ['some-pack/res/atlases/char.png', still(1024, 1024, true), 'texture'],
    ['some-pack/assets/food/rice.png', still(64, 64, true), 'prop'],
    // —— 2026-10-03 逐条复核：这些文件曾被错误装进 `resources/builtin-pets/` 当「宠物」——
    // 键盘输入层的键帽精灵（BongoCat）
    ['ayangweb-bongocat/resources/models/keyboard/resources/left-keys/Num0.png', still(612, 354, true), 'ui'],
    // QQ 宠物自动化：登录面板 / 退出按钮 / 系统设置 / 状态信息 / 帮助 都是界面件
    ['xuemian168-qqpet-automation/qq-pet-macos/src/assets/iconList/LoginPanel/l1.gif', anim(50, 50, 7), 'ui'],
    ['xuemian168-qqpet-automation/qq-pet-macos/src/assets/iconList/OnlineQuitPrompt/Button_exit_00.png', still(74, 20, true), 'ui'],
    ['xuemian168-qqpet-automation/qq-pet-macos/src/assets/sysSeting/VolumeBtn00.png', still(35, 33, true), 'ui'],
    ['xuemian168-qqpet-automation/qq-pet-macos/src/assets/sysSeting/guanbi00.png', still(26, 15, true), 'ui'],
    ['xuemian168-qqpet-automation/qq-pet-macos/src/assets/stateInfo/dengji1.png', still(12, 12, true), 'ui'],
    ['xuemian168-qqpet-automation/qq-pet-macos/src/assets/help/anniu00.png', still(74, 35, true), 'ui'],
    // 药品/道具图标（不是宠物本体）
    ['xuemian168-qqpet-automation/qq-pet-macos/src/assets/img_res/medicine/10001.gif', anim(50, 50, 5), 'prop'],
    // README / 教程截图（文档素材，非角色本体）
    ['LorisYounger-VPet/README.assets/ss4.gif', anim(328, 297, 375), 'document'],
    ['LorisYounger-VPet/VPet-Simulator.Windows/GameAssets/Tutorial.assets/CN/ss15.gif', anim(264, 249, 118), 'document'],
    // 前端场景/竞技场背景图（非宠物本体）
    ['MonsterEOS-monstereos/services/frontend/src/assets/images/arenas/1.png', still(1920, 1080, true), 'document'],
  ];

  it.each(nonBody)('%s → %s', (path, probe, role) => {
    const c = cls(path, probe);
    expect(c.role).toBe(role);
    expect(isPetBodyRole(c.role)).toBe(false);
    expect(c.evidence.length).toBeGreaterThan(0);
  });

  it('本体目录里的极端长宽比图仍然 fail-closed（不当本体）', () => {
    const c = cls('some-pack/pet/wide-strip.png', still(1024, 200, true));
    expect(c.role).toBe('unknown');
    expect(c.evidence.join(' ')).toContain('fail-closed');
  });

  it('硬性文件名标记优先于目录：pet/ 里的 banner/logo 仍不算本体', () => {
    expect(cls('some-pack/pet/banner-wide.png', still(1024, 200, true)).role).toBe('branding');
    expect(cls('some-pack/pet/logo-mark.png', still(512, 512, true)).role).toBe('branding');
    expect(cls('some-pack/characters/cur/cursor-arrow.png', still(64, 64, true)).role).toBe('ui');
  });

  it('本体目录里尺寸不达标的静帧不当本体', () => {
    const c = cls('some-pack/body/tiny.png', still(64, 64, true));
    expect(c.role).toBe('unknown');
    expect(c.evidence.join(' ')).toMatch(/尺寸|比例/);
  });
});

describe('宠物本体资源分类 · 本体必须被认（真实样本）', () => {
  it('本体目录下的静帧 → body-still', () => {
    const c = cls('dsh-dafeiyu/assets/pet/head_pat/head_pat_001.webp', still(412, 344, true));
    expect(c.role).toBe('body-still');
    expect(c.decidedBy).toBe('content');
  });

  it('无目录声明的动图 → body-animation', () => {
    const c = cls('vscode-pets/media/cat/black/black_idle_8fps.gif', anim(64, 64, 8));
    expect(c.role).toBe('body-animation');
  });

  it('webm 视频载荷 → body-animation', () => {
    const c = cls('dsh-pet/assets/webm/待机呼吸休闲.webm', { width: 462, height: 260, frames: 120, animated: true, hasAlpha: true });
    expect(c.role).toBe('body-animation');
  });

  it('Live2D / 3D 模型 → body-model', () => {
    expect(cls('model/gamepad-demomodel3-1024/gamepad.model3.json').role).toBe('body-model');
    expect(cls('live2d/hiyori/hiyori.moc3').role).toBe('body-model');
    expect(cls('model/pet.glb').role).toBe('body-model');
  });

  it('修复后仍必须保留的真实本体样本（防过度修剪）', () => {
    // 网页宠物目录（强本体目录 pets/）
    expect(cls('rainnoon-oc-claw/website/public/images/pets/furina_working.gif', anim(200, 200, 4)).role).toBe('body-animation');
    // 强本体目录 assets/pet/ 下的静帧
    expect(cls('QCYTSN-dsh-dafeiyu/assets/pet/dragging/dragging_001.webp', still(412, 344, true)).role).toBe('body-still');
    // VPet 真实模组：mod/.../pet/.../IDEL/Squat/C_Happy/
    expect(
      cls('LorisYounger-VPet/VPet-Simulator.Windows/mod/0000_core/pet/vup/IDEL/Squat/C_Happy/0001.png', still(300, 300, true)).role,
    ).toBe('body-still');
  });

  it('预览/封面目录 → body-cover（本体派生：可展示，不作独立动作）', () => {
    const c = classifyResource({ path: 'dsh-pet/assets/preview/待机呼吸休闲.gif', probe: anim(462, 260, 6) });
    expect(c.role).toBe('body-cover');
    expect(isPetBodyRole(c.role)).toBe(false);
  });
});

describe('宠物资源包级判定（修复「取第一张图」的根因）', () => {
  it('只有图标/界面件的包 → invalid，且原因显式', () => {
    const pack: ResourceEntry[] = [
      { path: 'pack/ui/cursor.png', probe: still(64, 64, true) },
      { path: 'pack/ui/notify-done.png', probe: still(48, 48, true) },
      { path: 'pack/logo.png', probe: still(256, 256, true) },
    ];
    const r = evaluatePetPack(pack);
    expect(r.valid).toBe(false);
    expect(r.entry).toBeNull();
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.rejected).toHaveLength(3);
  });

  it('只有封面/预览的包 → invalid（必须含本体）', () => {
    const r = evaluatePetPack([{ path: 'pack/preview/cover.gif', probe: anim(400, 300, 6) }]);
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toContain('封面');
  });

  it('只有过小静帧的包 → invalid', () => {
    const r = evaluatePetPack([{ path: 'pack/pet/icon.png', probe: still(96, 96, true) }]);
    expect(r.valid).toBe(false);
  });

  it('本体 + 干扰项混合包 → valid，只选本体为入口，干扰项进 rejected 并带原因', () => {
    const pack: ResourceEntry[] = [
      { path: 'pack/pet/idle/frame_000.png', probe: still(512, 512, true) },
      { path: 'pack/pet/idle/frame_001.png', probe: still(512, 512, true) },
      { path: 'pack/preview/idle.gif', probe: anim(512, 512, 8) },
      { path: 'pack/memes/wave.png', probe: still(400, 400, false) },
      { path: 'pack/logo.png', probe: still(512, 512, true) },
      { path: 'pack/docs/screenshot.png', probe: still(1920, 1080, false) },
      { path: 'pack/ui/cursor-grab.png', probe: still(64, 64, true) },
    ];
    const r = evaluatePetPack(pack);
    expect(r.valid).toBe(true);
    expect(r.entry?.path).toBe('pack/pet/idle/frame_000.png');
    expect(r.body.map((b) => b.path)).toEqual(['pack/pet/idle/frame_000.png', 'pack/pet/idle/frame_001.png']);
    expect(r.derived.map((d) => d.path)).toEqual(['pack/preview/idle.gif']);
    expect(r.rejected.map((x) => x.path).sort()).toEqual(['pack/docs/screenshot.png', 'pack/logo.png', 'pack/memes/wave.png', 'pack/ui/cursor-grab.png']);
    expect(r.rejected.every((x) => x.evidence.length > 0)).toBe(true);
  });

  it('入口优先级：模型 > 动画 > 静帧；同类按面积与路径稳定排序', () => {
    const pack: ResourceEntry[] = [
      { path: 'pack/pet/still.png', probe: still(512, 512, true) },
      { path: 'pack/pet/anim/idle.gif', probe: anim(256, 256, 6) },
      { path: 'pack/pet/model/char.model3.json', probe: undefined },
    ];
    const r = evaluatePetPack(pack);
    expect(r.entry?.path).toBe('pack/pet/model/char.model3.json');

    const noModel = evaluatePetPack(pack.filter((p) => !p.path.endsWith('.model3.json')));
    expect(noModel.entry?.path).toBe('pack/pet/anim/idle.gif');

    const stillsOnly = evaluatePetPack([
      { path: 'pack/pet/small.png', probe: still(200, 200, true) },
      { path: 'pack/pet/large.png', probe: still(512, 512, true) },
    ]);
    expect(stillsOnly.entry?.path).toBe('pack/pet/large.png');
  });

  it('未探测的本体目录静帧：登记为待探测，严格模式不予通过，宽松模式可用', () => {
    const pack: ResourceEntry[] = [{ path: 'pack/pet/body.png' }];
    const strict = evaluatePetPack(pack);
    expect(strict.needProbe).toEqual(['pack/pet/body.png']);
    expect(strict.valid).toBe(false);

    const lenient = evaluatePetPack(pack, { allowUnprobedBodyStill: true });
    expect(lenient.valid).toBe(true);
    expect(lenient.entry?.path).toBe('pack/pet/body.png');
  });

  it('清单显式声明优先于路径推断（自有资源包可自带角色表）', () => {
    const c = classifyResource({ path: 'pack/weird-dir/blob.png', declaredRole: 'body-animation' });
    expect(c.role).toBe('body-animation');
    expect(c.decidedBy).toBe('declared');
  });

  it('空包 → invalid 而不是抛错', () => {
    const r = evaluatePetPack([]);
    expect(r.valid).toBe(false);
    expect(r.entry).toBeNull();
  });

  it('路径归一化：反斜杠与 ./ 前缀不影响判定', () => {
    expect(cls('.\\pack\\pet\\idle\\frame_000.png', still(512, 512, true)).role).toBe('body-still');
    expect(cls('./pack/memes/a.png', still(400, 400, true)).role).toBe('meme');
  });
});

describe('帧序列识别（像素画序列不得被静帧门槛误杀）', () => {
  it('32×32 两帧序列 → body-animation，包判定有效', () => {
    const pack: ResourceEntry[] = [
      { path: 'pix/pet/idle/frame_000.png', probe: still(32, 32, true) },
      { path: 'pix/pet/idle/frame_001.png', probe: still(32, 32, true) },
    ];
    const r = evaluatePetPack(pack);
    expect(r.valid).toBe(true);
    expect(r.body.map((b) => b.role)).toEqual(['body-animation', 'body-animation']);
    expect(r.entry?.path).toBe('pix/pet/idle/frame_000.png');
  });

  it('单张 32×32 图标不会因序列规则被放行', () => {
    const r = evaluatePetPack([{ path: 'pix/pet/idle/frame_000.png', probe: still(32, 32, true) }]);
    expect(r.valid).toBe(false);
  });

  it('尺寸不一致的“序列”不提升为动画，且原因可读', () => {
    const pack: ResourceEntry[] = [
      { path: 'pix/a/frame_000.png', probe: still(32, 32, true) },
      { path: 'pix/a/frame_001.png', probe: still(64, 64, true) },
    ];
    const r = evaluatePetPack(pack);
    expect(r.valid).toBe(false);
    expect(r.rejected.map((x) => x.role)).toEqual(['document', 'document']);
    expect(r.rejected[0].evidence.join(' ')).toContain('尺寸过小');
  });

  it('groupFrameSequences 可直接复用（导入器 / 上传链路同一口径）', () => {
    const set = groupFrameSequences([
      { path: 'a/x/frame_000.png', probe: still(32, 32, true) },
      { path: 'a/x/frame_001.png', probe: still(32, 32, true) },
      { path: 'a/y/solo.png', probe: still(32, 32, true) },
      { path: 'a/z/other_000.png', probe: still(48, 48, true) },
      { path: 'a/z/other_001.png', probe: still(48, 48, true) },
    ]);
    expect([...set].sort()).toEqual(['a/x/frame_000.png', 'a/x/frame_001.png', 'a/z/other_000.png', 'a/z/other_001.png']);
  });
});

describe('辅助判定与统计', () => {
  it('isQualifiedBody：模型/动画恒真；静帧需尺寸达标且未明确无 alpha', () => {
    expect(isQualifiedBody(classifyResource({ path: 'a/pet/x.model3.json' }))).toBe(true);
    expect(isQualifiedBody(classifyResource({ path: 'a/pet/x.gif', probe: anim(32, 32, 4) }))).toBe(true);
    expect(isQualifiedBody(classifyResource({ path: 'a/pet/x.png', probe: still(MIN_BODY_STILL_EDGE, MIN_BODY_STILL_EDGE, true) }))).toBe(true);
    expect(isQualifiedBody(classifyResource({ path: 'a/pet/x.png', probe: still(512, 512, false) }))).toBe(false);
  });

  it('summarizeRoles 统计各角色数量', () => {
    const list = [
      classifyResource({ path: 'a/pet/a.png', probe: still(512, 512, true) }),
      classifyResource({ path: 'a/memes/b.png', probe: still(300, 300, false) }),
      classifyResource({ path: 'a/logo.png' }),
    ];
    const s = summarizeRoles(list);
    expect(s['body-still']).toBe(1);
    expect(s.meme).toBe(1);
    expect(s.branding).toBe(1);
    expect(s.ui).toBe(0);
  });
});
