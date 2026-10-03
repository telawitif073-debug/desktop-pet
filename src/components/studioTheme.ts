import type React from 'react';

/**
 * 宠工坊新工作区（上传/发布、主体扣取）共用的深色主题常量。
 * 与 Studio / AgentEditor 内的同名常量保持同一套取值（那些文件保持各自私有副本，此处只为新增组件提供单一来源）。
 */
export const C = {
  bg: '#1e1f22',
  panel: '#252526',
  panelAlt: '#2a2a2c',
  border: '#3a3b3d',
  text: '#d6d7d9',
  sub: '#8b8f96',
  accent: '#4a9eff',
  warn: '#ffd479',
  danger: '#ff9f9f',
  dangerBg: '#3a2626',
  ok: '#7ddc8a',
};

export const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 8px',
  marginBottom: 8,
  border: `1px solid ${C.border}`,
  borderRadius: 4,
  background: C.panelAlt,
  color: C.text,
  fontSize: 12,
  outline: 'none',
  boxSizing: 'border-box',
};

export const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 11,
  color: C.sub,
  marginBottom: 4,
};

export function smallBtn(active = false): React.CSSProperties {
  return {
    padding: '3px 9px',
    border: `1px solid ${active ? C.accent : '#555'}`,
    borderRadius: 4,
    background: active ? 'rgba(74,158,255,.15)' : '#333',
    color: active ? C.accent : '#ccc',
    fontSize: 11,
    cursor: 'pointer',
  };
}

/** 字节数 → 可读体积（仅用于表单展示） */
export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(2)} MB`;
}