/**
 * 轻量 Markdown 渲染（参考 Trae 风格）：代码块卡片（可一键复制）、行内代码、链接（长按复制）、
 * 加粗/斜体/删除线、标题、引用、列表，与普通正文视觉区分。RN 内核无内置解析，自写正则渲染，无原生依赖。
 */
import React, { useCallback, useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { StyleProp, TextStyle } from 'react-native';

type InlineSeg =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'bold'; v: string }
  | { t: 'italic'; v: string }
  | { t: 'strike'; v: string }
  | { t: 'link'; text: string; url: string };

type Block = { type: 'code'; lang: string; text: string } | { type: 'text'; text: string };

/** 解析行内特殊格式：`代码`、**加粗**、__加粗__、*斜体*、_斜体_、~~删除~~、[文字](链接) */
function parseInline(input: string): InlineSeg[] {
  const segs: InlineSeg[] = [];
  const RE = /`([^`\n]+)`|(\*\*|__)([\s\S]+?)\2|(\*|_)([^*_\n]+)\4|~~([^~]+)~~|\[([^\]]+)\]\(([a-z][a-z0-9+.-]*:[^)\s"']+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = RE.exec(input))) {
    if (m.index > last) segs.push({ t: 'text', v: input.slice(last, m.index) });
    if (m[1] != null) segs.push({ t: 'code', v: m[1] });
    else if (m[2] != null) segs.push({ t: 'bold', v: m[3] });
    else if (m[4] != null) segs.push({ t: 'italic', v: m[5] });
    else if (m[6] != null) segs.push({ t: 'strike', v: m[6] });
    else if (m[7] != null) segs.push({ t: 'link', text: m[7], url: m[8] });
    last = RE.lastIndex;
  }
  if (last < input.length) segs.push({ t: 'text', v: input.slice(last) });
  return segs;
}

/** 常见代码语言标记（用于区分「 ``` 后紧跟的代码行」与「语言标签」） */
const LANG_IDS = new Set([
  'js', 'javascript', 'jsx', 'ts', 'tsx', 'json', 'py', 'python', 'yaml', 'yml', 'xml', 'html', 'css', 'scss', 'less',
  'sh', 'bash', 'shell', 'zsh', 'pwsh', 'powershell', 'sql', 'go', 'rust', 'rs', 'java', 'kt', 'kotlin', 'swift', 'c',
  'cpp', 'c++', 'h', 'cs', 'csharp', 'dart', 'php', 'rb', 'ruby', 'conf', 'ini', 'toml', 'txt', 'text', 'plaintext',
  'md', 'markdown', 'diff', 'makefile', 'dockerfile', 'graphql', 'gql', 'http', 'latex', 'lua', 'matlab', 'm', 'r',
]);
const isLangToken = (w: string): boolean => /^[a-z][a-z0-9_+-]*$/i.test(w) && LANG_IDS.has(w.toLowerCase());

/** 按 ``` 切块：奇数段为代码块（首行为语言标识，无换行的单行代码不误吞），其余为普通文本段 */
function splitBlocks(content: string): Block[] {
  const blocks: Block[] = [];
  const parts = content.split('```');
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      const p = parts[i];
      const nl = p.indexOf('\n');
      const first = nl === -1 ? p : p.slice(0, nl);
      const rest = nl === -1 ? '' : p.slice(nl + 1);
      let lang = first.trim();
      let body = rest;
      if (nl === -1 && first.trim() && !isLangToken(first.trim())) {
        // ``` 后直接是代码且无换行：不把整行当语言标签，避免代码内容丢失
        lang = '';
        body = first;
      }
      const text = body.replace(/\n$/, '');
      if (text.trim()) blocks.push({ type: 'code', lang, text });
    } else if (parts[i]) {
      blocks.push({ type: 'text', text: parts[i] });
    }
  }
  return blocks;
}

interface Props {
  content: string;
  baseStyle?: StyleProp<TextStyle>;
  /** 复制文本（由宿主提供剪贴板写入能力） */
  onCopy: (text: string) => void;
}

export default function MarkdownText({ content, baseStyle, onCopy }: Props): React.JSX.Element {
  const blocks = useMemo(() => splitBlocks(content), [content]);

  const renderInline = useCallback((text: string): React.ReactNode => {
    const segs = parseInline(text);
    return segs.map((s, i) => {
      switch (s.t) {
        case 'code':
          return (
            <Text key={i} selectable style={styles.inlineCode}>
              {s.v}
            </Text>
          );
        case 'bold':
          return (
            <Text key={i} selectable style={styles.boldText}>
              {renderInline(s.v)}
            </Text>
          );
        case 'italic':
          return (
            <Text key={i} selectable style={styles.italicText}>
              {renderInline(s.v)}
            </Text>
          );
        case 'strike':
          return (
            <Text key={i} selectable style={styles.strikeText}>
              {s.v}
            </Text>
          );
        case 'link':
          return (
            <Pressable key={i} onLongPress={() => onCopy(s.url)} hitSlop={6}>
              <Text selectable style={styles.linkText}>
                {s.text} ↗
              </Text>
            </Pressable>
          );
        default:
          return (
            <Text key={i} selectable style={baseStyle}>
              {s.v}
            </Text>
          );
      }
    });
  }, [baseStyle, onCopy]);

  /** 普通文本段按行渲染：标题 / 引用 / 列表 / 正文 */
  const renderTextBlock = useCallback(
    (text: string): React.ReactNode => {
      const lines = text.split('\n');
      const out: React.ReactNode[] = [];
      lines.forEach((raw, idx) => {
        const heading = /^(#{1,3})\s+(.*)$/.exec(raw);
        if (heading) {
          const lvl = heading[1].length;
          out.push(
            <Text key={idx} selectable style={[styles.heading, lvl >= 3 && styles.headingSm]}>
              {renderInline(heading[2])}
            </Text>,
          );
          return;
        }
        const quote = /^>\s?(.*)$/.exec(raw);
        if (quote) {
          out.push(
            <Text key={idx} selectable style={styles.quoteText}>
              {renderInline(quote[1])}
            </Text>,
          );
          return;
        }
        const ul = /^[-*+]\s+(.*)$/.exec(raw);
        if (ul) {
          out.push(
            <Text key={idx} selectable style={styles.listText}>
              {'• '}
              {renderInline(ul[1])}
            </Text>,
          );
          return;
        }
        const ol = /^(\d+)[.、)]\s+(.*)$/.exec(raw);
        if (ol) {
          out.push(
            <Text key={idx} selectable style={styles.listText}>
              {`${ol[1]}. `}
              {renderInline(ol[2])}
            </Text>,
          );
          return;
        }
        // 行内片段必须包在同一个 <Text> 里流式排列：直接作为兄弟节点会各占一行
        // （此前「要点：`greet` 返回字符串，详见 [链接]。」会被拆成 5 行）
        if (raw.trim()) {
          out.push(
            <Text key={idx} selectable style={baseStyle}>
              {renderInline(raw)}
            </Text>,
          );
        } else out.push(<Text key={idx}>{'\n'}</Text>);
      });
      return out;
    },
    [renderInline],
  );

  return (
    <>
      {blocks.map((b, bi) =>
        b.type === 'code' ? (
          <View key={bi} style={styles.codeCard}>
            <View style={styles.codeHead}>
              <Text style={styles.codeLang}>{b.lang || 'code'}</Text>
              <Pressable onPress={() => onCopy(b.text)} hitSlop={8} style={styles.codeCopyBtn}>
                <Text style={styles.codeCopyText}>复制</Text>
              </Pressable>
            </View>
            <Text selectable style={styles.codeBody}>
              {b.text}
            </Text>
          </View>
        ) : (
          <View key={bi}>{renderTextBlock(b.text)}</View>
        ),
      )}
    </>
  );
}

const styles = StyleSheet.create({
  inlineCode: {
    backgroundColor: 'rgba(120,128,146,0.14)',
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
    fontFamily: 'monospace',
    fontSize: 13,
    color: '#c7254e',
  },
  boldText: {
    fontWeight: '700',
  },
  italicText: {
    fontStyle: 'italic',
  },
  strikeText: {
    textDecorationLine: 'line-through',
  },
  linkText: {
    color: '#3b6cf6',
    textDecorationLine: 'underline',
  },
  heading: {
    fontWeight: '800',
    fontSize: 17,
    marginTop: 6,
    marginBottom: 2,
  },
  headingSm: {
    fontSize: 15,
  },
  quoteText: {
    borderLeftWidth: 3,
    borderLeftColor: '#c6cbd4',
    paddingLeft: 8,
    backgroundColor: 'rgba(120,128,146,0.08)',
    borderRadius: 2,
  },
  listText: {
    marginVertical: 1,
  },
  codeCard: {
    marginVertical: 4,
    borderRadius: 10,
    // 透明度 0.05 的深灰：在浅色气泡上几乎只留一层极淡的灰，完全不突兀；
    // 底色很浅，靠描边维持代码块边界可辨识
    backgroundColor: 'rgba(45,45,45,0.05)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(0,0,0,0.12)',
    alignSelf: 'stretch',
    width: '100%',
  },
  codeHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 4,
  },
  codeLang: {
    color: 'rgba(45,45,45,0.65)',
    fontSize: 12,
    fontFamily: 'monospace',
  },
  codeCopyBtn: {
    backgroundColor: 'rgba(45,45,45,0.08)',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  codeCopyText: {
    color: '#4B5563',
    fontSize: 12,
  },
  codeBody: {
    color: '#2E3138',
    fontFamily: 'monospace',
    fontSize: 13,
    lineHeight: 19,
    paddingHorizontal: 12,
    paddingBottom: 10,
  },
});