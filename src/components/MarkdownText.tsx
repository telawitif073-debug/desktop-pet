import { useEffect, useMemo, useRef } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

/**
 * Markdown → 安全 HTML：marked 解析 + DOMPurify 清洗。
 * 回复内容来自外部模型，必须当作不可信输入（XSS 防护）：
 * 禁内联样式/表单/框架等标签，保留代码块、标题、引用、列表、粗斜体、行内代码与链接。
 */
export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false, gfm: true, breaks: true }) as string;
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ['style', 'form', 'input', 'textarea', 'iframe', 'link', 'meta', 'button'],
    FORBID_ATTR: ['style'],
  });
}

/**
 * 助手消息的 Markdown 渲染：代码块由渲染后注入的「复制」按钮承担（不写进 HTML，避免属性注入面）；
 * 容器级点击拦截确保链接不会让对话窗口导航离开（面板内不打开外链）。
 */
const MarkdownText = ({ content, className }: { content: string; className?: string }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderMarkdown(content), [content]);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    root.querySelectorAll('pre').forEach((pre) => {
      if (pre.querySelector('button.md-copy')) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'md-copy';
      button.textContent = '复制';
      button.title = '复制代码';
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        const code = pre.querySelector('code')?.textContent ?? '';
        void navigator.clipboard?.writeText(code).then(
          () => {
            button.textContent = '已复制';
            setTimeout(() => {
              button.textContent = '复制';
            }, 1200);
          },
          () => {
            button.textContent = '复制失败';
          }
        );
      });
      pre.appendChild(button);
    });
  }, [html]);

  return (
    <div
      ref={containerRef}
      className={className ? `md-body ${className}` : 'md-body'}
      // 链接点击一律拦截：对话窗被导航离开会导致整个应用不可用
      onClick={(event) => {
        const anchor = (event.target as Element | null)?.closest?.('a');
        if (anchor) event.preventDefault();
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};

export default MarkdownText;