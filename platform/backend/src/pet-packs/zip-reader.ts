/**
 * 最小 ZIP 读取器（无第三方依赖）
 * ---------------------------------------------------------------------------
 * 为什么要手写：后端硬约束「不引入第三方依赖」（避免 `npm ci` 失败），
 * 而发布宠物包必须解包跑校验（设计文档 D3）。这里只做**够用**的事：
 *
 *   - 只读「中央目录」（EOCD + CDFH），逐个条目按需解压；
 *   - 支持 method 0（store）与 8（deflate，用 Node 内置 `zlib.inflateRawSync`）；
 *   - **加密**（通用位 flag bit0）与 **ZIP64**（哨兵值 0xFFFFFFFF / 条目数 0xFFFF）
 *     一律**显式报错**，绝不静默跳过或猜测；
 *   - 不校验每条的 crc32：包级完整性由 `pack_sha256` 保证（见设计文档 §3.1）。
 *
 * 安全边界：所有尺寸都过调用方给的 `maxEntryBytes`（配合 `inflateRawSync` 的
 * `maxOutputLength`）以防 zip 炸弹；不落地写盘，因此不存在 zip-slip 文件系统风险。
 */

import * as zlib from 'zlib';

/** 中央目录条目（只保留校验/解包必要的字段） */
export interface ZipEntry {
  name: string;
  /** 0=store，8=deflate（其余一律拒绝） */
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  /** 本地文件头在包内的偏移（用于定位数据区） */
  localHeaderOffset: number;
}

export interface ReadZipOptions {
  /** 中央目录条目数上限 */
  maxEntries?: number;
  /** 单条解压输出上限（防 zip 炸弹） */
  maxEntryBytes?: number;
}

/** ZIP 结构性问题（格式非法 / 加密 / ZIP64 / 越界）；调用方应据此回 400 而不是 500 */
export class ZipFormatException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipFormatException';
  }
}

const EOCD_SIG = 0x06054b50;
const CDFH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;
const MAX_COMMENT = 0xffff;
const EOCD_MIN_SIZE = 22;
const ZIP64_SENTINEL32 = 0xffffffff;
const ZIP64_SENTINEL16 = 0xffff;
const ENCRYPTED_FLAG = 1 << 0;
const UTF8_FLAG = 1 << 11;
const DEFAULT_MAX_ENTRIES = 5000;
const DEFAULT_MAX_ENTRY_BYTES = 32 * 1024 * 1024;

/** 从尾部向前找 EOCD 记录（注释最长 64KB） */
function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - (MAX_COMMENT + EOCD_MIN_SIZE));
  for (let i = buf.length - EOCD_MIN_SIZE; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/** 条目名解码：置了 UTF-8 位（bit11）按 UTF-8，否则按 latin1（ASCII 兼容） */
function decodeName(raw: Buffer, flags: number): string {
  return flags & UTF8_FLAG ? raw.toString('utf8') : raw.toString('latin1');
}

/**
 * 读取中央目录，返回全部条目（含目录项，名称以 `/` 结尾）。
 * 抛出 {@link ZipFormatException} 表示包本身不合法。
 */
export function readZipDirectory(buf: Buffer, opts: ReadZipOptions = {}): ZipEntry[] {
  if (buf.length < EOCD_MIN_SIZE) throw new ZipFormatException('不是有效的 ZIP：文件过短');
  const eocd = findEocd(buf);
  if (eocd < 0) throw new ZipFormatException('不是有效的 ZIP：找不到中央目录结尾记录（EOCD）');

  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === ZIP64_SENTINEL16 || cdSize === ZIP64_SENTINEL32 || cdOffset === ZIP64_SENTINEL32) {
    throw new ZipFormatException('不支持 ZIP64 格式：请用标准 zip 重新打包');
  }
  if (cdOffset + cdSize > buf.length) throw new ZipFormatException('ZIP 中央目录越界（文件被截断或损坏）');

  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  if (total > maxEntries) throw new ZipFormatException(`ZIP 条目过多（${total} > ${maxEntries}）`);

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CDFH_SIG) {
      throw new ZipFormatException('ZIP 中央目录条目损坏');
    }
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc32 = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localHeaderOffset = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLen > buf.length) throw new ZipFormatException('ZIP 中央目录条目越界');

    const name = decodeName(buf.subarray(p + 46, p + 46 + nameLen), flags);
    if (flags & ENCRYPTED_FLAG) throw new ZipFormatException(`不支持加密的 ZIP 条目：${name}`);
    if (compressedSize === ZIP64_SENTINEL32 || uncompressedSize === ZIP64_SENTINEL32 || localHeaderOffset === ZIP64_SENTINEL32) {
      throw new ZipFormatException(`不支持 ZIP64 条目（大小/偏移为 64 位）：${name}`);
    }

    entries.push({ name, method, compressedSize, uncompressedSize, crc32, localHeaderOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** 解压单个条目；`method` 不支持 / 超限 / 数据越界均抛 {@link ZipFormatException} */
export function readZipEntry(buf: Buffer, entry: ZipEntry, opts: ReadZipOptions = {}): Buffer {
  const maxEntryBytes = opts.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;
  if (entry.uncompressedSize > maxEntryBytes) {
    throw new ZipFormatException(`ZIP 条目过大：${entry.name}（${entry.uncompressedSize} > ${maxEntryBytes} 字节）`);
  }

  const off = entry.localHeaderOffset;
  if (off + 30 > buf.length || buf.readUInt32LE(off) !== LFH_SIG) {
    throw new ZipFormatException(`ZIP 本地文件头损坏：${entry.name}`);
  }
  const nameLen = buf.readUInt16LE(off + 26);
  const extraLen = buf.readUInt16LE(off + 28);
  const dataStart = off + 30 + nameLen + extraLen;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buf.length) throw new ZipFormatException(`ZIP 条目数据越界：${entry.name}`);
  const data = buf.subarray(dataStart, dataEnd);

  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) {
    try {
      return zlib.inflateRawSync(data, { maxOutputLength: maxEntryBytes });
    } catch (e) {
      throw new ZipFormatException(`ZIP 条目解压失败：${entry.name}（${(e as Error).message}）`);
    }
  }
  throw new ZipFormatException(`不支持的 ZIP 压缩方式 ${entry.method}：${entry.name}（仅支持 store/deflate）`);
}
