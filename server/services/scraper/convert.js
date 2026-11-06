// 繁体 -> 简体（台湾用字 -> 大陆简体）
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const opencc = require('opencc-js');

// opencc-js 同时提供 CJS/UMD，用 require 兼容性最好
const converter = opencc.Converter({ from: 'tw', to: 'cn' });

export function t2s(text) {
  if (!text) return '';
  try {
    return converter(String(text));
  } catch {
    return String(text);
  }
}

// 统一空白、去首尾
export function normalizeText(text) {
  return String(text || '')
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

// 去掉「作者：」「状态：」等前缀（必须带冒号，避免误伤以标签词开头的书名/人名）
export function stripLabel(text, labels = []) {
  let out = normalizeText(text);
  for (const label of labels) {
    out = out.replace(new RegExp(`^${label}\\s*[:：]\\s*`), '');
  }
  return out;
}
