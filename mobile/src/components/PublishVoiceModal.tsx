/**
 * 发布音色弹层：引擎表单（OpenAI 兼容 / GPT-SoVITS）或高级粘贴 JSON。
 * - 表单模式：按引擎填结构化字段，提交时自动组装配置并校验（天然不含 Key）
 * - JSON 模式：支持粘贴他人分享的配置文本导入，实时校验
 * 样本音频：热更不能加原生文件选择器，所以让发布者粘贴一个 http(s) 音频直链，
 * 端内 fetch 成 Blob（≤5MB）后随 multipart 上传；留空则不附样本，安装者现场合成试听。
 */
import React, { useState } from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as platform from '../api/platform';
import { validateVoiceConfig } from '../voiceEngine';
import type { VoiceConfig } from '../types';

type FormEngine = 'cloud' | 'gptsovits' | 'json';

const TEMPLATE_CLOUD = JSON.stringify(
  {
    engine: 'cloud',
    voiceId: 'nova',
    model: 'tts-1',
    instructions: '像一只黏人的小猫娘，语速稍快，语气活泼',
    sampleText: '你好呀，我是你的桌面小宠，今天也要开心哦！',
  } satisfies VoiceConfig,
  null,
  2,
);

const TEMPLATE_GPTSOVITS = JSON.stringify(
  {
    engine: 'gptsovits',
    voiceId: '',
    refAudioPath: 'D:/GPT-SoVITS/refs/demo.wav',
    promptText: '参考音频里说的这句话，一字不差地写在这里。',
    promptLang: 'zh',
    textLang: 'zh',
    sampleText: '你好呀，我是你的桌面小宠，今天也要开心哦！',
  } satisfies VoiceConfig,
  null,
  2,
);

export default function PublishVoiceModal({
  visible,
  onClose,
  onPublished,
}: {
  visible: boolean;
  onClose: () => void;
  onPublished: () => void;
}): React.JSX.Element {
  const [name, setName] = useState('');
  const [version, setVersion] = useState('1.0.0');
  const [desc, setDesc] = useState('');
  const [formEngine, setFormEngine] = useState<FormEngine>('cloud');
  const [configJson, setConfigJson] = useState('');
  const [sampleUrl, setSampleUrl] = useState('');
  const [busy, setBusy] = useState(false);

  // 表单字段（JSON 模式不用）
  const [voiceId, setVoiceId] = useState('');
  const [model, setModel] = useState('');
  const [instructions, setInstructions] = useState('');
  const [refAudioPath, setRefAudioPath] = useState('');
  const [promptText, setPromptText] = useState('');
  const [textLang, setTextLang] = useState('zh');
  const [sampleText, setSampleText] = useState('');

  /** 表单 → 配置对象（提交前仍走 validateVoiceConfig 统一校验） */
  const buildConfig = (): VoiceConfig | null => {
    if (formEngine === 'gptsovits') {
      return {
        engine: 'gptsovits',
        voiceId: '',
        refAudioPath: refAudioPath.trim(),
        promptText: promptText.trim(),
        promptLang: 'zh',
        textLang: textLang.trim() || 'zh',
        sampleText: sampleText.trim(),
      };
    }
    return {
      engine: 'cloud',
      voiceId: voiceId.trim(),
      baseUrl: '',
      model: model.trim(),
      instructions: instructions.trim(),
      sampleText: sampleText.trim(),
    };
  };

  const cfgCheck = (): { ok: boolean; error?: string } => {
    if (formEngine === 'json') {
      const t = configJson.trim();
      if (!t) return { ok: false, error: '' };
      try {
        const parsed = JSON.parse(t) as unknown;
        const r = validateVoiceConfig(parsed);
        return { ok: r.ok, error: r.error };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
    const cfg = buildConfig();
    if (!cfg) return { ok: false, error: '无法构造配置' };
    const r = validateVoiceConfig(cfg);
    return { ok: r.ok, error: r.error };
  };

  const check = cfgCheck();

  const reset = (): void => {
    setName('');
    setVersion('1.0.0');
    setDesc('');
    setFormEngine('cloud');
    setConfigJson('');
    setSampleUrl('');
    setVoiceId('');
    setModel('');
    setInstructions('');
    setRefAudioPath('');
    setPromptText('');
    setTextLang('zh');
    setSampleText('');
  };

  const submit = async (): Promise<void> => {
    if (!name.trim()) {
      Alert.alert('请填写名称', '给你的音色起个名字吧');
      return;
    }
    let config: VoiceConfig;
    if (formEngine === 'json') {
      if (!check.ok) {
        Alert.alert('配置有误', check.error || '请检查音色配置 JSON');
        return;
      }
      // 已通过校验，重新解析取干净配置
      const parsed = validateVoiceConfig(JSON.parse(configJson) as unknown);
      if (!parsed.ok || !parsed.config) {
        Alert.alert('配置有误', parsed.error || '请检查音色配置 JSON');
        return;
      }
      config = parsed.config;
    } else {
      const cfg = buildConfig();
      const r = cfg ? validateVoiceConfig(cfg) : { ok: false, error: '无法构造配置' };
      if (!r.ok || !r.config) {
        Alert.alert('配置有误', r.error || '请检查表单');
        return;
      }
      config = r.config;
    }
    // 安全兜底：发布配置禁止携带任何疑似 Key 字段
    const raw = JSON.stringify(config).toLowerCase();
    if (/"(apikey|api_key|key|secret|token)"\s*:/.test(raw)) {
      Alert.alert('安全拦截', '音色配置里不能包含 API Key / secret / token——配置会公开给所有安装者，请删除后再发布。');
      return;
    }
    setBusy(true);
    try {
      const url = sampleUrl.trim();
      if (url && !/^https?:\/\//i.test(url)) throw new Error('样本地址必须是 http(s) 直链');
      await platform.publishVoice({
        name: name.trim().slice(0, 100),
        description: desc.trim() || undefined,
        version: version.trim() || '1.0.0',
        config,
        sampleUrl: url || undefined,
      });
      Alert.alert('提交成功', '音色已提交，等待管理员审核通过后会出现在音色商店。');
      reset();
      onPublished();
    } catch (e) {
      Alert.alert('发布失败', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const engineTabs: Array<{ key: FormEngine; label: string }> = [
    { key: 'cloud', label: 'OpenAI 兼容' },
    { key: 'gptsovits', label: 'GPT-SoVITS' },
    { key: 'json', label: '粘贴 JSON' },
  ];

  return (
    <Modal transparent animationType="fade" visible={visible} onRequestClose={onClose}>
      <View style={s.mask}>
        <View style={s.panel}>
          <Text style={s.title}>发布我的音色</Text>
          <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            <Text style={s.label}>音色名称 *</Text>
            <TextInput style={s.input} value={name} onChangeText={setName} placeholder="例如：元气猫娘音" maxLength={100} />

            <Text style={s.label}>版本号</Text>
            <TextInput style={s.input} value={version} onChangeText={setVersion} placeholder="1.0.0" maxLength={20} />

            <Text style={s.label}>描述</Text>
            <TextInput
              style={[s.input, s.area]}
              value={desc}
              onChangeText={setDesc}
              placeholder="适合什么人设、声音特点、推荐用法…"
              multiline
              maxLength={1000}
            />

            <Text style={s.label}>音色引擎 *</Text>
            <View style={s.segRow}>
              {engineTabs.map((t) => (
                <Pressable
                  key={t.key}
                  style={[s.seg, formEngine === t.key && s.segActive]}
                  onPress={() => setFormEngine(t.key)}>
                  <Text style={[s.segText, formEngine === t.key && s.segTextActive]}>{t.label}</Text>
                </Pressable>
              ))}
            </View>

            {formEngine === 'cloud' && (
              <>
                <Text style={s.label}>音色 ID（voiceId）*</Text>
                <TextInput style={s.input} value={voiceId} onChangeText={setVoiceId} placeholder="alloy / nova / 服务商给的克隆音色 ID" autoCapitalize="none" autoCorrect={false} />
                <Text style={s.label}>模型名（选填）</Text>
                <TextInput style={s.input} value={model} onChangeText={setModel} placeholder="tts-1 / gpt-4o-mini-tts / cosyvoice-v2" autoCapitalize="none" autoCorrect={false} />
                <Text style={s.label}>风格指令（选填）</Text>
                <TextInput style={s.input} value={instructions} onChangeText={setInstructions} placeholder="温柔的大姐姐声线，语速稍慢，带笑意" maxLength={200} />
              </>
            )}

            {formEngine === 'gptsovits' && (
              <>
                <Text style={s.label}>参考音频路径（refAudioPath）*</Text>
                <TextInput style={s.input} value={refAudioPath} onChangeText={setRefAudioPath} placeholder="引擎电脑上的路径，如 D:/GPT-SoVITS/refs/demo.wav" autoCapitalize="none" autoCorrect={false} />
                <Text style={s.label}>参考音频说的话（promptText）</Text>
                <TextInput style={s.input} value={promptText} onChangeText={setPromptText} placeholder="与音频内容一字不差，决定克隆效果" maxLength={200} />
                <Text style={s.label}>待合成文本语言（textLang）</Text>
                <TextInput style={s.input} value={textLang} onChangeText={setTextLang} placeholder="zh / en / ja / ko / yue" autoCapitalize="none" autoCorrect={false} maxLength={8} />
                <Text style={s.hint}>零样本克隆：3~10 秒干净参考音频即可，无需训练、无需 API Key。安装者需自建 GPT-SoVITS 引擎并在设置里填地址。</Text>
              </>
            )}

            {formEngine === 'json' && (
              <>
                <View style={s.cfgHead}>
                  <Text style={s.label}>音色配置 JSON *</Text>
                  <View style={{ flexDirection: 'row', gap: 12 }}>
                    <Pressable hitSlop={8} onPress={() => setConfigJson(TEMPLATE_CLOUD)}>
                      <Text style={s.tpl}>OpenAI 示例</Text>
                    </Pressable>
                    <Pressable hitSlop={8} onPress={() => setConfigJson(TEMPLATE_GPTSOVITS)}>
                      <Text style={s.tpl}>SoVITS 示例</Text>
                    </Pressable>
                  </View>
                </View>
                <TextInput
                  style={[s.input, s.area, s.code]}
                  value={configJson}
                  onChangeText={setConfigJson}
                  placeholder='{"engine":"cloud","voiceId":"nova"}'
                  multiline
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                {configJson.trim() ? (
                  <Text style={check.ok ? s.ok : s.err}>
                    {check.ok ? '✓ 配置格式正确' : `✗ ${check.error}`}
                  </Text>
                ) : (
                  <Text style={s.hint}>可从他人分享的配置文本直接粘贴导入；配置中不要包含 API Key</Text>
                )}
              </>
            )}

            {formEngine !== 'json' && (
              <Text style={s.label}>
                推荐试听文案（选填）
              </Text>
            )}
            {formEngine !== 'json' && (
              <TextInput style={s.input} value={sampleText} onChangeText={setSampleText} placeholder="安装者点试听时优先念这句" maxLength={200} />
            )}

            <Text style={s.label}>试听样本直链（可选）</Text>
            <TextInput
              style={s.input}
              value={sampleUrl}
              onChangeText={setSampleUrl}
              placeholder="https://…/sample.mp3（≤5MB）"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text style={s.hint}>mp3 / m4a / aac / wav；没有样本可留空，安装者会用自己的服务现场合成试听</Text>
          </ScrollView>

          <View style={s.btnRow}>
            <Pressable style={[s.btn, s.btnGhost]} onPress={onClose} disabled={busy}>
              <Text style={s.btnGhostText}>取消</Text>
            </Pressable>
            <Pressable style={[s.btn, s.btnPrimary, busy && s.btnDisabled]} onPress={() => void submit()} disabled={busy}>
              {busy ? <ActivityIndicator color="#fff" size="small" /> : <Text style={s.btnPrimaryText}>提交审核</Text>}
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  mask: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'center', padding: 24 },
  panel: { backgroundColor: '#fff', borderRadius: 16, padding: 18, maxHeight: '86%' },
  title: { fontSize: 16, fontWeight: '700', color: '#1A1A1A' },
  label: { fontSize: 12, color: '#666', fontWeight: '600', marginTop: 12, marginBottom: 4 },
  input: { backgroundColor: '#F2F3F6', borderRadius: 8, paddingHorizontal: 10, fontSize: 13, color: '#222', paddingVertical: 8 },
  area: { height: 88, textAlignVertical: 'top' },
  code: { fontFamily: 'monospace', fontSize: 12 },
  cfgHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  tpl: { fontSize: 12, color: '#4D6BFE', fontWeight: '600' },
  segRow: { flexDirection: 'row', gap: 8 },
  seg: { flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: 'center', backgroundColor: '#F2F3F6' },
  segActive: { backgroundColor: '#4D6BFE' },
  segText: { fontSize: 12, color: '#555', fontWeight: '600' },
  segTextActive: { color: '#fff' },
  err: { color: '#E5484D', fontSize: 12, marginTop: 5, lineHeight: 16 },
  ok: { color: '#2BA44C', fontSize: 12, marginTop: 5 },
  hint: { color: '#8A8F99', fontSize: 11, marginTop: 4, lineHeight: 15 },
  btnRow: { flexDirection: 'row', gap: 10, marginTop: 14 },
  btn: { flex: 1, borderRadius: 22, paddingVertical: 11, alignItems: 'center', justifyContent: 'center' },
  btnGhost: { borderWidth: 1, borderColor: '#D5D8DE' },
  btnGhostText: { color: '#555', fontSize: 14 },
  btnPrimary: { backgroundColor: '#4D6BFE' },
  btnDisabled: { backgroundColor: '#A8B6FE' },
  btnPrimaryText: { color: '#fff', fontSize: 14, fontWeight: '600' },
});
